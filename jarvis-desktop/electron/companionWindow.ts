// The desktop companion: a small always-on-top island window, its screen-region overlay and its own narrow IPC.
//
// Security model
// - The companion page (companion.html) gets its own preload (window.companion) and may call only COMPANION_METHODS.
//   Each call is checked for: main frame, the exact trusted companion URL, the right window (overlay methods only from the
//   overlay, everything else only from the island), and argument shapes. The hub's router and method table are untouched.
// - Screen capture happens here, in the main process, only when the person starts a region selection. The whole-display
//   image lives only until they finish or cancel; only the selected crop is kept, behind a random single-use token that
//   expires after five minutes. The renderer receives a small preview, never a path.
// - Changing saved data goes through a trusted native confirmation owned by the island window (Cancel is the default);
//   it fails closed when the island is not visible and focused.
import {BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, powerMonitor, screen, type IpcMainInvokeEvent, type NativeImage} from 'electron';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Backend, CompanionReadiness, CompanionTarget} from './backend';
import type {AgentEvent, AgentImage, UndoHandle} from './services/agent';
import {ScreenContext, SelectionGate} from './services/screen-context';
import {ForegroundCapture} from './services/foreground-capture';
import {COMPANION_ARG_SPECS, COMPANION_EVENT_CHANNEL, COMPANION_METHODS, OVERLAY_METHODS, PET_SIZE, clampPetPoint, clampSize, companionChannel, cropForSelection, dockPoint, encodeRegion, gazeBucket, isTrustedCompanionUrl, parseBubbleLayout, parseSelection, petBox, placePet, resizePet, sendSize, snapDock, type CompanionMethod, type Dock, type DockTarget, type PetPlacement, type Point, type ResizeOp} from './companionCore';
import {createTrustedConfirm, safeErrorMessage, validateArgsAgainst} from './ipcCore';

export type CompanionDeps = {
  backend: Backend;
  distDir: string;
  preloadPath: string;
  userData: string;
  devOrigin?: string;
  openHub: (view: string, item?: string) => void;
  record: (summary: string) => void;
};

export type MaterialState = {requested: 'none' | 'acrylic'; applied: boolean; note: string};
export type Appearance = 'pet' | 'legacy-orb';
export type CompanionStatus = {readiness: CompanionReadiness; shortcut: string | null; material: MaterialState; platform: string; appearance: Appearance; size: number; dock: Dock; target: {process: string; title: string} | null; reduceMotion: boolean};

const SHORTCUTS = ['Control+Shift+Space', 'Control+Alt+Space'] as const;
const REGION_TTL_MS = 5 * 60 * 1000;
const DRAG_TICK_MS = 16;
const DRAG_VELOCITY_MS = 66;
const DRAG_MAX_MS = 20_000;
/** A press that moves less than this is a click (opens the companion), not a drag. */
const DRAG_CLICK_PX = 4;
const GAZE_TICK_MS = 100;
const GAZE_STALE_MS = 8000;
/** Click-through with forwarded mouse moves exists only on Windows and macOS. */
const CLICK_THROUGH = process.platform === 'win32' || process.platform === 'darwin';
/** Non-activating windows (setFocusable) exist only on Windows and macOS. */
const NO_ACTIVATE = process.platform === 'win32' || process.platform === 'darwin';

type Region = {data: string; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number};
type Pending = {full: NativeImage; display: Electron.Display};
type Prefs = {point: Point | null; displayId: number | null; dock: Dock; size: number; appearance: Appearance; material: 'none' | 'acrylic'};

/** Windows 11 22H2 (build 22621) and later document background materials; earlier builds get the solid look. */
function materialSupported(): boolean {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) && build >= 22621;
}

export function createCompanion(deps: CompanionDeps) {
  const fileUrl = pathToFileURL(path.join(deps.distDir, 'companion.html')).href;
  const trusted = (url: string) => isTrustedCompanionUrl(url, fileUrl, deps.devOrigin);
  const prefsFile = path.join(deps.userData, 'companion.json');
  const prefs: Prefs = (() => {
    const base: Prefs = {point: null, displayId: null, dock: 'bottom', size: PET_SIZE.default, appearance: 'pet', material: 'none'};
    try {
      const raw = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as Record<string, unknown>;
      const pt = raw.point as Record<string, unknown> | null | undefined;
      const point = pt && typeof pt.x === 'number' && typeof pt.y === 'number' && Number.isFinite(pt.x) && Number.isFinite(pt.y) ? {x: pt.x, y: pt.y} : null;
      const docks: Dock[] = ['free', 'bottom', 'top', 'left', 'right'];
      return {
        point,
        displayId: typeof raw.displayId === 'number' ? raw.displayId : null,
        dock: docks.includes(raw.dock as Dock) ? (raw.dock as Dock) : 'bottom',
        size: typeof raw.size === 'number' && Number.isFinite(raw.size) ? clampSize(raw.size) : PET_SIZE.default,
        appearance: raw.appearance === 'legacy-orb' ? 'legacy-orb' : 'pet',
        material: raw.material === 'acrylic' ? 'acrylic' : 'none',
      };
    } catch {
      return base;
    }
  })();
  const savePrefs = () => fs.promises.writeFile(prefsFile, JSON.stringify(prefs), 'utf8').catch(() => undefined);

  let island: BrowserWindow | null = null;
  let overlay: BrowserWindow | null = null;
  let pending: Pending | null = null;
  let run: AbortController | null = null;
  let bubble: {width: number; height: number} | null = null;
  let placement: PetPlacement | null = null;
  let point: Point | null = null;
  let shortcut: string | null = null;
  let material: MaterialState = {requested: prefs.material, applied: false, note: 'Solid smoked surface.'};
  let drag: {offset: Point; start: Point; moved: boolean; timer: ReturnType<typeof setInterval>; since: number; vAt: number; vFrom: Point; lastVx: number | null} | null = null;
  let gazeWanted = false;
  let gazeLocked = false;
  let gazeTimer: ReturnType<typeof setInterval> | null = null;
  let gaze: {bucket: number | null; last: Point | null; movedAt: number} = {bucket: null, last: null, movedAt: 0};
  let interactive = !CLICK_THROUGH;
  /** The window the person was using when they opened the companion; typing may go only there. Cleared on close. */
  let target: CompanionTarget | null = null;
  const foregroundCapture = new ForegroundCapture<CompanionTarget>();
  const regions = new ScreenContext<Region>(REGION_TTL_MS, undefined, undefined, undefined, token => send({type: 'region-expired', token}));
  const selectionGate = new SelectionGate();
  /** Undo handles offered by receipts in this window, by the opaque id the page sends back. Used at most once. */
  const undoable = new Map<string, UndoHandle>();

  const confirm = createTrustedConfirm<BrowserWindow>({
    getWindow: () => island,
    isTrusted: (w) => !w.webContents.isLoading() && trusted(w.webContents.getURL()),
    showMessageBox: (w, options) => dialog.showMessageBox(w, options),
  });

  const send = (e: unknown) => {
    if (island && !island.isDestroyed()) island.webContents.send(COMPANION_EVENT_CHANNEL, e);
  };

  const alive = () => !!island && !island.isDestroyed();
  const displayFor = (p: Point) => screen.getDisplayNearestPoint({x: Math.round(p.x), y: Math.round(p.y)});
  /** The pet's ground point: saved, restored onto the nearest display, or docked bottom-right of the primary display. */
  function currentPoint(): Point {
    if (point) return point;
    const saved = prefs.point;
    if (saved) {
      const d = screen.getAllDisplays().find((x) => x.id === prefs.displayId) ?? displayFor(saved);
      point = clampPetPoint(saved, prefs.size, d.workArea);
    } else {
      point = dockPoint('bottom-right', prefs.size, screen.getPrimaryDisplay().workArea).point;
    }
    return point;
  }
  function remember(dock: Dock) {
    const p = currentPoint();
    prefs.point = p;
    prefs.displayId = displayFor(p).id;
    prefs.dock = dock;
    void savePrefs();
  }
  /** Lays the window out around the pet and tells the page where the pet and the bubble are inside it. */
  const place = () => {
    if (!alive()) return;
    const p = currentPoint();
    const work = displayFor(p).workArea;
    point = clampPetPoint(p, prefs.size, work);
    const planned = placePet(point, prefs.size, bubble, work);
    const before = island!.getBounds();
    const wanted = planned.window;
    if (before.x !== wanted.x || before.y !== wanted.y || before.width !== wanted.width || before.height !== wanted.height) island!.setBounds(wanted, false);
    // At fractional Windows display scales setBounds can round the physical extent up by one DIP.
    // Keep the ACTUAL window inside the work area and rebase the content, preserving the pet's global feet.
    let actual = island!.getBounds();
    for (let attempt = 0; attempt < 3; attempt++) {
      const overflowX = actual.x + actual.width - (work.x + work.width);
      const overflowY = actual.y + actual.height - (work.y + work.height);
      const x = actual.x < work.x ? work.x + attempt : overflowX > 0 ? actual.x - overflowX - attempt : actual.x;
      const y = actual.y < work.y ? work.y + attempt : overflowY > 0 ? actual.y - overflowY - attempt : actual.y;
      if (x === actual.x && y === actual.y) break;
      island!.setPosition(x, y, false);
      actual = island!.getBounds();
    }
    const rebase = (box: {x: number; y: number; width: number; height: number}) => ({...box, x: box.x + wanted.x - actual.x, y: box.y + wanted.y - actual.y});
    placement = {window: actual, pet: rebase(planned.pet), bubble: planned.bubble ? rebase(planned.bubble) : null, side: planned.side};
    send({type: 'placement', ...placement, size: prefs.size, dock: prefs.dock});
  };
  function setInteractive(on: boolean) {
    if (!CLICK_THROUGH || !alive() || interactive === on) return;
    interactive = on;
    island!.setIgnoreMouseEvents(!on, {forward: true});
  }
  /** At rest the window never takes the keyboard: hovering or dragging the pet leaves focus where it was. */
  function setRestFocus(rest: boolean) {
    if (!NO_ACTIVATE || !alive()) return;
    island!.setFocusable(!rest);
  }
  const shownTarget = () => (target ? {process: target.process, title: target.title.slice(0, 120)} : null);
  /**
   * Opens the bubble. When it was closed, the window in the foreground is remembered first (the companion has not taken
   * the keyboard yet), so a later "type this there" goes to exactly the app the person was using.
   */
  async function invoke() {
    if (!alive() || foregroundCapture.busy) return;
    const opening = !bubble;
    if (!island!.isVisible()) island!.showInactive();
    send({type: 'invoke'});
    if (opening) {
      // Keep the non-activating island from taking focus until Windows has identified the source app.
      // The former 700 ms deadline expired during PowerShell cold start on ordinary laptops.
      const captured = await foregroundCapture.capture(() => deps.backend.companion.foregroundTarget());
      if (!captured || !alive()) return;
      target = captured.target;
      send({type: 'target', target: shownTarget()});
    }
    if (!alive()) return;
    setRestFocus(false);
    island!.show();
    island!.focus();
  }

  function dragStart() {
    if (!alive() || drag || overlay) return false;
    // While carried the pet does not look at where the pointer was before the grab.
    if (gaze.bucket !== null) { gaze.bucket = null; send({type: 'gaze', index: null}); }
    const c = screen.getCursorScreenPoint();
    const p = currentPoint();
    const timer = setInterval(dragTick, DRAG_TICK_MS);
    drag = {offset: {x: c.x - p.x, y: c.y - p.y}, start: c, moved: false, timer, since: Date.now(), vAt: Date.now(), vFrom: p, lastVx: null};
    setInteractive(true);
    return true;
  }
  function dragTick() {
    if (!drag || !alive()) return;
    if (Date.now() - drag.since > DRAG_MAX_MS) { dragEnd(); return; }
    const c = screen.getCursorScreenPoint();
    if (!drag.moved && Math.hypot(c.x - drag.start.x, c.y - drag.start.y) < DRAG_CLICK_PX) return;
    drag.moved = true;
    const target = {x: c.x - drag.offset.x, y: c.y - drag.offset.y};
    point = clampPetPoint(target, prefs.size, displayFor(c).workArea);
    place();
    const now = Date.now();
    if (now - drag.vAt >= DRAG_VELOCITY_MS) {
      const vx = Math.round(((point.x - drag.vFrom.x) * 1000) / (now - drag.vAt));
      drag.vAt = now;
      drag.vFrom = point;
      if (vx !== drag.lastVx) { drag.lastVx = vx; send({type: 'drag', vx}); }
    }
  }
  function dragEnd(): {moved: boolean} {
    if (!drag) return {moved: false};
    clearInterval(drag.timer);
    const moved = drag.moved;
    drag = null;
    send({type: 'drag', vx: null});
    if (moved) {
      const p = currentPoint();
      const snapped = snapDock(p, prefs.size, displayFor(p).workArea);
      point = snapped.point;
      remember(snapped.dock);
      place();
    }
    return {moved};
  }

  /* Local gaze: the cursor is read here and reduced to one of 16 look directions; positions never leave this process. */
  function gazeTick() {
    if (!alive() || !placement || drag) return;
    const c = screen.getCursorScreenPoint();
    const now = Date.now();
    if (!gaze.last || gaze.last.x !== c.x || gaze.last.y !== c.y) { gaze.last = c; gaze.movedAt = now; }
    const w = placement.window;
    const pet = {x: w.x + placement.pet.x, y: w.y + placement.pet.y, width: placement.pet.width, height: placement.pet.height};
    const bucket = now - gaze.movedAt > GAZE_STALE_MS ? null : gazeBucket(c, pet);
    if (bucket !== gaze.bucket) { gaze.bucket = bucket; send({type: 'gaze', index: bucket}); }
  }
  function updateGaze() {
    const on = gazeWanted && !gazeLocked && alive() && island!.isVisible();
    if (on && !gazeTimer) gazeTimer = setInterval(gazeTick, GAZE_TICK_MS);
    if (!on && gazeTimer) {
      clearInterval(gazeTimer);
      gazeTimer = null;
      if (gaze.bucket !== null) { gaze.bucket = null; send({type: 'gaze', index: null}); }
    }
  }
  // A policy change from any window (hub settings, the island, an import) reaches the island page at once.
  const offVoicePolicy = deps.backend.companion.voice.onPolicy((allowed) => send({type: 'voice-policy', allowed}));
  const onLock = () => {
    foregroundCapture.cancel();
    run?.abort(); closeOverlay(); regions.clear(); target = null; stopVoice();
    send({type: 'target', target: null}); send({type: 'collapse'});
    gazeLocked = true; updateGaze();
  };
  const onUnlock = () => { gazeLocked = false; updateGaze(); };
  /** Backstop for the page's own release: closing the bubble or the island ends the island's speech and transcription. */
  const stopVoice = () => { deps.backend.companion.voice.stop(); deps.backend.companion.voice.cancelTranscribe(); };

  function applyMaterial(want: 'none' | 'acrylic') {
    prefs.material = want;
    void savePrefs();
    if (!island || island.isDestroyed()) return;
    if (want === 'none') {
      try { if (materialSupported()) island.setBackgroundMaterial('none'); } catch { /* nothing to undo */ }
      material = {requested: 'none', applied: false, note: 'Solid smoked surface.'};
      return;
    }
    if (!materialSupported()) {
      material = {requested: 'acrylic', applied: false, note: 'Desktop blur needs Windows 11 22H2 or later. The solid smoked surface is used instead.'};
      return;
    }
    try {
      island.setBackgroundMaterial('acrylic');
      material = {requested: 'acrylic', applied: true, note: 'Windows acrylic was requested. Whether it shows through the transparent island depends on this Windows build; check it on this computer.'};
    } catch (e) {
      material = {requested: 'acrylic', applied: false, note: `Windows refused the material (${safeErrorMessage(e)}). The solid smoked surface is used instead.`};
    }
  }

  function createIsland() {
    const win = new BrowserWindow({
      width: 160, height: 160, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: true, focusable: !NO_ACTIVATE, title: 'Desktop Companion',
      webPreferences: {
        preload: deps.preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false, spellcheck: false,
        // A visible transparent/non-activating Windows window may be treated as occluded by Chromium. Keep its
        // pose clock running while shown; restore normal throttling on hide so the renderer's visibility pause works.
        backgroundThrottling: false, devTools: !!deps.devOrigin,
      },
    });
    island = win;
    // Above normal windows, below full-screen apps and system UI.
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('will-navigate', (e, url) => { if (!trusted(url)) e.preventDefault(); });
    win.on('closed', () => {
      foregroundCapture.cancel();
      if (island === win) island = null;
      run?.abort();
      closeOverlay();
      regions.clear();
      if (drag) dragEnd();
      // A new window starts closed and forgets the remembered app window.
      bubble = null;
      target = null;
      stopVoice();
      updateGaze();
    });
    win.on('show', () => {win.webContents.setBackgroundThrottling(false); updateGaze();});
    win.on('hide', () => {win.webContents.setBackgroundThrottling(true); updateGaze();});
    // Rest: shown without taking focus, so the app the person is using keeps the keyboard; transparent parts let clicks
    // through to the desktop until the pointer is over the pet or the bubble.
    win.once('ready-to-show', () => {
      interactive = !CLICK_THROUGH;
      if (CLICK_THROUGH) win.setIgnoreMouseEvents(true, {forward: true});
      place();
      win.showInactive();
      applyMaterial(prefs.material);
    });
    if (deps.devOrigin) void win.loadURL(`${deps.devOrigin}/companion.html`);
    else void win.loadFile(path.join(deps.distDir, 'companion.html'));
  }

  /** After the region picker closes, the open command surface gets the keyboard back (the person was typing in it). */
  function refocus() {
    if (!alive()) return;
    if (bubble) { setRestFocus(false); island!.show(); island!.focus(); } else island!.showInactive();
  }

  /** Brings the island back without taking focus after a selection that never opened. */
  function stepBack() { if (alive() && !overlay && !island!.isVisible()) island!.showInactive(); }

  function closeOverlay() {
    selectionGate.cancel();
    const old = overlay;
    overlay = null;
    pending = null;
    if (old && !old.isDestroyed()) old.destroy();
  }

  async function regionBegin(): Promise<{ok: true} | {ok: false; reason: string}> {
    if (overlay) return {ok: false, reason: 'A selection is already open.'};
    const ticket = selectionGate.begin();
    if (ticket === null) return {ok: false, reason: 'A selection is already starting.'};
    regions.clear();
    try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // The island steps aside so it is not part of the picture.
    island?.hide();
    await new Promise((r) => setTimeout(r, 160));
    // Cancelled (Stop, bubble closed, screen locked) while the island was stepped aside: the pet comes back at rest, and
    // no picker opens late.
    if (!selectionGate.current(ticket)) { stepBack(); return {ok: false, reason: 'Selection cancelled.'}; }
    let full: NativeImage | null = null;
    try {
      const size = {width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor)};
      const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: size, fetchWindowIcons: false});
      const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
      full = src && !src.thumbnail.isEmpty() ? src.thumbnail : null;
    } catch (e) {
      if (selectionGate.current(ticket)) refocus();
      return {ok: false, reason: `The screen could not be captured (${safeErrorMessage(e)}).`};
    }
    if (!selectionGate.current(ticket) || !alive()) { full = null; stepBack(); return {ok: false, reason: 'Selection cancelled.'}; }
    if (!full) {
      island?.showInactive();
      return {ok: false, reason: 'The screen could not be captured on this display.'};
    }
    pending = {full, display};
    const ov = new BrowserWindow({
      ...display.bounds, show: false, frame: false, transparent: false, backgroundColor: '#000000', resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, title: 'Select a region',
      webPreferences: {preload: deps.preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, devTools: !!deps.devOrigin},
    });
    overlay = ov;
    ov.setAlwaysOnTop(true, 'screen-saver');
    ov.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    ov.webContents.on('will-navigate', (e) => e.preventDefault());
    ov.on('closed', () => {
      if (overlay === ov) {
        overlay = null;
        pending = null;
        refocus();
        send({type: 'region-cancelled'});
      }
    });
    ov.once('ready-to-show', () => { ov.setBounds(display.bounds); ov.show(); ov.focus(); });
    if (deps.devOrigin) void ov.loadURL(`${deps.devOrigin}/companion.html#overlay`);
    else void ov.loadFile(path.join(deps.distDir, 'companion.html'), {hash: 'overlay'});
    return {ok: true};
    } finally {selectionGate.finish(ticket);}
  }

  function overlayImage() {
    if (!pending) return null;
    const {full, display} = pending;
    // The overlay shows the frozen screen at display size (DIP); JPEG keeps the transfer small.
    const shown = full.resize({width: display.size.width, height: display.size.height, quality: 'good'});
    return {dataUrl: `data:image/jpeg;base64,${shown.toJPEG(82).toString('base64')}`, width: display.size.width, height: display.size.height};
  }

  function overlaySubmit(raw: unknown) {
    if (!pending) return {ok: false as const, reason: 'No selection is open.'};
    const {full, display} = pending;
    const sel = parseSelection(raw, display.size);
    if (!sel) return {ok: false as const, reason: 'Select a larger area.'};
    const crop = cropForSelection(sel, display.size, full.getSize());
    let img = full.crop(crop);
    const out = sendSize(crop);
    if (out.width !== crop.width) img = img.resize({width: out.width, height: out.height, quality: 'best'});
    const encoded = encodeRegion(() => img.toPNG(), (q) => img.toJPEG(q));
    if (!encoded) return {ok: false as const, reason: 'That area is too detailed to send as one image. Select a smaller area.'};
    // The preview is made from the same crop, in memory only; nothing about the area is written to disk.
    const preview = img.resize({width: Math.min(240, out.width)}).toDataURL();
    const token = randomUUID();
    regions.put(token, {data: Buffer.from(encoded.data).toString('base64'), mediaType: encoded.mediaType, width: out.width, height: out.height});
    const ov = overlay;
    overlay = null;
    pending = null;
    ov?.destroy();
    if (alive()) { setRestFocus(false); island!.show(); island!.focus(); }
    // bytes and mediaType are additive: exactly what an ask with this area would attach.
    send({type: 'region', token, preview, width: out.width, height: out.height, sourceScale: display.scaleFactor, bytes: encoded.data.byteLength, mediaType: encoded.mediaType});
    deps.record(`Screen region selected for the companion (${out.width}×${out.height} px; kept in memory for up to 5 minutes, sent only if you ask)`);
    return {ok: true as const};
  }

  async function ask(text: string, token?: string, withTarget?: boolean, streamText?: boolean) {
    run?.abort();
    const ctl = new AbortController();
    run = ctl;
    const runId = randomUUID();
    let image: AgentImage | undefined;
    if (token) {
      const r = regions.take(token);
      // Single use: a region is never silently reused for a later request.
      if (!r) {
        send({runId, event: {type: 'error', reason: 'setup', message: 'The selected region expired. Select it again.'} satisfies AgentEvent});
        return {runId};
      }
      image = {base64: r.data, width: r.width, height: r.height, mediaType: r.mediaType};
    }
    const emit = (event: AgentEvent) => {
      if (event.type === 'tool' && event.undo) undoable.set(event.undo.id, event.undo);
      send({runId, event});
    };
    // The remembered window goes with this request only when the page showed it and the person kept it attached; a page
    // that never displays it (or an older one) never sends it.
    const sendTarget = withTarget === true && target ? target : undefined;
    // An in-flight request may type only while the person still has that same window attached.
    const targetCurrent = () => !!sendTarget && !!target && target.hwnd === sendTarget.hwnd && target.pid === sendTarget.pid;
    // A later confirmation in the same request (after typing moved focus to the other app) brings the bubble back to the
    // front first, but only while the bubble is still open; otherwise the trusted confirmation fails closed as before.
    const runConfirm = async (summary: string, detail: string) => {
      if (alive() && bubble && island!.isVisible() && !island!.isFocused()) {
        setRestFocus(false);
        island!.show();
        island!.focus();
        await new Promise((r) => setTimeout(r, 60));
      }
      // Stop in the island closes this dialog as Cancel: the request it belongs to is over.
      return confirm(summary, detail, ctl.signal);
    };
    // Streamed reply text goes out as its own push (no runId key, so pages that do not know it ignore it).
    // Only for a page that asked for it (streamText), so pages written before streaming never see these pushes.
    const onText = streamText === true ? (step: number, chunk: string) => { if (run === ctl) send({type: 'run-text', run: runId, step, text: chunk}); } : undefined;
    void deps.backend.companion.run({text, image, ...(sendTarget ? {target: sendTarget, targetCurrent} : {})}, {emit, confirm: runConfirm, signal: ctl.signal, ...(onText ? {onText} : {})}).catch((e) => {
      emit({type: 'error', reason: 'provider', message: safeErrorMessage(e)});
    }).finally(() => { if (run === ctl) run = null; });
    return {runId};
  }

  /**
   * Types the reviewed text into the window remembered when the bubble opened, without a model call. It runs as a
   * request of its own (Stop cancels it and closes an open confirmation as Cancel) and may type only while the person
   * still has that same window attached and the bubble open.
   */
  function insertText(text: string) {
    run?.abort();
    const ctl = new AbortController();
    run = ctl;
    const runId = randomUUID();
    const sendTarget = target;
    const targetCurrent = () => !!sendTarget && !!target && !!bubble && target.hwnd === sendTarget.hwnd && target.pid === sendTarget.pid;
    const emit = (event: AgentEvent) => send({runId, event});
    void deps.backend.companion.insertText({text, target: sendTarget, targetCurrent}, {emit, confirm: (summary, detail) => confirm(summary, detail, ctl.signal), signal: ctl.signal}).catch((e) => {
      emit({type: 'error', reason: 'provider', message: safeErrorMessage(e)});
    }).finally(() => { if (run === ctl) run = null; });
    return {runId};
  }

  const handlers: Record<CompanionMethod, (...args: never[]) => Promise<unknown> | unknown> = {
    companionState: async (): Promise<CompanionStatus> => ({readiness: await deps.backend.companion.readiness(), shortcut, material, platform: process.platform, appearance: prefs.appearance, size: prefs.size, dock: prefs.dock, target: shownTarget(), reduceMotion: (await deps.backend.getState()).settings.reduceMotion}),
    companionClearTarget: () => { foregroundCapture.cancel(); target = null; send({type: 'target', target: null}); return true; },
    companionAsk: (text: string, token?: string, withTarget?: boolean, streamText?: boolean) => ask(text, token, withTarget, streamText),
    companionCancel: () => { foregroundCapture.cancel(); run?.abort(); closeOverlay(); regions.clear(); return true; },
    companionUndo: async (id: string) => {
      const handle = undoable.get(id);
      if (!handle) return false;
      undoable.delete(id);
      return deps.backend.companion.undo(handle);
    },
    companionLayout: (raw: unknown) => {
      const l = parseBubbleLayout(raw);
      if (!l) throw new Error('Invalid layout');
      bubble = l.bubble;
      place();
      // Closing the bubble gives the keyboard back: Windows activates the window the person was using before.
      if (!bubble && alive()) {
        foregroundCapture.cancel();
        run?.abort();
        closeOverlay();
        regions.clear();
        stopVoice();
        if (target) { target = null; send({type: 'target', target: null}); }
        if (island!.isFocused()) island!.blur();
        setRestFocus(true);
      }
      return true;
    },
    companionDrag: (phase: 'start' | 'end') => {
      if (phase === 'start') return {started: dragStart()};
      const r = dragEnd();
      // A press without movement is a click on the pet: open the companion (the person chose to give it the keyboard).
      if (!r.moved) void invoke();
      return r;
    },
    companionHit: (over: boolean) => { if (!drag) setInteractive(over); return true; },
    companionResize: (op: ResizeOp) => {
      prefs.size = resizePet(prefs.size, op);
      remember(prefs.dock);
      place();
      return prefs.size;
    },
    companionDock: (target: DockTarget) => {
      const work = displayFor(currentPoint()).workArea;
      const d = dockPoint(target, prefs.size, work);
      point = d.point;
      remember(d.dock);
      place();
      return d.dock;
    },
    companionGaze: (on: boolean) => { gazeWanted = on; updateGaze(); return true; },
    companionSetAppearance: (a: Appearance) => { prefs.appearance = a; void savePrefs(); return a; },
    companionOpenHub: (view: string, item?: string) => {
      if (item !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(item)) throw new Error('Invalid item');
      deps.openHub(view, item);
      return true;
    },
    companionSetMaterial: (m: 'none' | 'acrylic') => { applyMaterial(m); return material; },
    companionVoiceStatus: () => deps.backend.companion.voice.status(),
    companionTranscribe: (audio: number[]) => deps.backend.companion.voice.transcribe(audio),
    companionTranscribeCancel: () => deps.backend.companion.voice.cancelTranscribe(),
    companionSpeak: (text: string) => deps.backend.companion.voice.speak(text),
    companionSpeechStop: () => deps.backend.companion.voice.stop(),
    // Turning the microphone on shows the island's own trusted confirmation (Cancel is the default); off needs none.
    companionSetVoiceInput: (on: boolean) => deps.backend.companion.voice.setInput(on, (summary, detail) => confirm(summary, detail)),
    companionInsertText: (text: string) => insertText(text),
    companionOutbound: (text: string, token?: string, withTarget?: boolean) => {
      let image: AgentImage | undefined;
      if (token) {
        const r = regions.peek(token);
        if (!r) return {ready: false, reason: 'The selected region expired. Select it again.'};
        image = {base64: r.data, width: r.width, height: r.height, mediaType: r.mediaType};
      }
      return deps.backend.companion.outbound({text, image, ...(withTarget === true && target ? {target} : {})});
    },
    regionBegin: () => regionBegin(),
    regionDiscard: (token: string) => regions.discard(token),
    overlayImage: () => overlayImage(),
    overlaySubmit: (raw: unknown) => overlaySubmit(raw),
    overlayCancel: () => { closeOverlay(); refocus(); send({type: 'region-cancelled'}); return true; },
  };

  for (const method of COMPANION_METHODS) {
    ipcMain.handle(companionChannel(method), async (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      const frame = e.senderFrame;
      if (!frame || frame !== e.sender.mainFrame || !trusted(frame.url)) throw new Error('Request rejected: untrusted sender');
      const fromOverlay = !!overlay && !overlay.isDestroyed() && e.sender.id === overlay.webContents.id;
      const fromIsland = !!island && !island.isDestroyed() && e.sender.id === island.webContents.id;
      if (OVERLAY_METHODS.includes(method) ? !fromOverlay : !fromIsland) throw new Error('Request rejected: wrong window');
      const problem = validateArgsAgainst(method, COMPANION_ARG_SPECS[method], args);
      if (problem) throw new Error(problem);
      try {
        return await (handlers[method] as (...a: unknown[]) => unknown)(...args);
      } catch (err) {
        throw new Error(safeErrorMessage(err));
      }
    });
  }

  function toggle() {
    if (!alive()) { createIsland(); return; }
    if (foregroundCapture.busy) { foregroundCapture.cancel(); send({type: 'collapse'}); return; }
    if (island!.isFocused()) send({type: 'collapse'});
    else void invoke();
  }

  function registerShortcut(): string | null {
    for (const s of SHORTCUTS) {
      try { if (globalShortcut.register(s, toggle)) return s; } catch { /* try the next one */ }
    }
    return null;
  }

  function dispose() {
    foregroundCapture.cancel();
    run?.abort();
    stopVoice();
    offVoicePolicy();
    bubble = null;
    target = null;
    if (drag) { clearInterval(drag.timer); drag = null; }
    gazeWanted = false;
    if (gazeTimer) { clearInterval(gazeTimer); gazeTimer = null; }
    powerMonitor.removeListener('lock-screen', onLock);
    powerMonitor.removeListener('unlock-screen', onUnlock);
    closeOverlay();
    regions.clear();
    if (shortcut) globalShortcut.unregister(shortcut);
    shortcut = null;
    screen.removeListener('display-metrics-changed', place);
    screen.removeListener('display-removed', place);
    for (const m of COMPANION_METHODS) ipcMain.removeHandler(companionChannel(m));
    if (island && !island.isDestroyed()) island.destroy();
    island = null;
  }

  // A failure part way through leaves nothing behind: no handlers, shortcut or window.
  try {
    createIsland();
    shortcut = registerShortcut();
    if (!shortcut) deps.record(`The companion shortcut could not be registered (${SHORTCUTS.join(', ')} are in use). Use the tray menu instead.`);
    screen.on('display-metrics-changed', place);
    screen.on('display-removed', place);
    powerMonitor.on('lock-screen', onLock);
    powerMonitor.on('unlock-screen', onUnlock);
  } catch (e) {
    try { dispose(); } catch { /* best effort */ }
    throw e;
  }

  return {
    toggle,
    show: () => { if (!alive()) createIsland(); else island!.showInactive(); },
    hide: () => island?.hide(),
    isVisible: () => !!island && !island.isDestroyed() && island.isVisible(),
    /** True only for the island page itself (trusted URL, the island's own webContents), never the selection overlay. */
    isIsland: (wc: Electron.WebContents | null | undefined, url: string) => !!wc && !!island && !island.isDestroyed() && wc.id === island.webContents.id && trusted(url),
    dispose,
  };
}

