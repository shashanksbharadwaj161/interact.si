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
import {BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, screen, type IpcMainInvokeEvent, type NativeImage} from 'electron';
import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Backend, CompanionReadiness} from './backend';
import type {AgentEvent} from './services/agent';
import {COMPANION_ARG_SPECS, COMPANION_EVENT_CHANNEL, COMPANION_METHODS, OVERLAY_METHODS, companionChannel, cropForSelection, isTrustedCompanionUrl, parseLayout, parseSelection, placeIsland, sendSize, type Anchor, type CompanionMethod, type Layout} from './companionCore';
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
export type CompanionStatus = {readiness: CompanionReadiness; anchor: Anchor; shortcut: string | null; material: MaterialState; platform: string};

const SHORTCUTS = ['Control+Shift+Space', 'Control+Alt+Space'] as const;
const REGION_TTL_MS = 5 * 60 * 1000;
const REST: Layout = {width: 196, height: 52, anchor: 'corner'};

type Region = {png: string; width: number; height: number; at: number};
type Pending = {full: NativeImage; display: Electron.Display};
type Prefs = {anchor: Anchor; material: 'none' | 'acrylic'};

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
    try {
      const raw = JSON.parse(fs.readFileSync(prefsFile, 'utf8')) as Partial<Prefs>;
      return {anchor: raw.anchor === 'top' || raw.anchor === 'right' ? raw.anchor : 'corner', material: raw.material === 'acrylic' ? 'acrylic' : 'none'};
    } catch {
      return {anchor: 'corner', material: 'none'};
    }
  })();
  const savePrefs = () => fs.promises.writeFile(prefsFile, JSON.stringify(prefs), 'utf8').catch(() => undefined);

  let island: BrowserWindow | null = null;
  let overlay: BrowserWindow | null = null;
  let pending: Pending | null = null;
  let run: AbortController | null = null;
  let layout: Layout = {...REST, anchor: prefs.anchor};
  let shortcut: string | null = null;
  let material: MaterialState = {requested: prefs.material, applied: false, note: 'Solid smoked surface.'};
  const regions = new Map<string, Region>();
  const undoable = new Set<string>();

  const confirm = createTrustedConfirm<BrowserWindow>({
    getWindow: () => island,
    isTrusted: (w) => !w.webContents.isLoading() && trusted(w.webContents.getURL()),
    showMessageBox: (w, options) => dialog.showMessageBox(w, options),
  });

  const send = (e: unknown) => {
    if (island && !island.isDestroyed()) island.webContents.send(COMPANION_EVENT_CHANNEL, e);
  };

  const workArea = () => {
    const at = island && !island.isDestroyed() ? island.getBounds() : null;
    const d = at ? screen.getDisplayMatching(at) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    return d.workArea;
  };
  const place = () => {
    if (!island || island.isDestroyed()) return;
    island.setBounds(placeIsland(workArea(), layout), false);
  };

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
      width: REST.width, height: REST.height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
      alwaysOnTop: true, title: 'Desktop Companion',
      webPreferences: {
        preload: deps.preloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false, spellcheck: false,
        backgroundThrottling: true, devTools: !!deps.devOrigin,
      },
    });
    island = win;
    // Above normal windows, below full-screen apps and system UI.
    win.setAlwaysOnTop(true, 'floating');
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('will-navigate', (e, url) => { if (!trusted(url)) e.preventDefault(); });
    win.on('closed', () => { if (island === win) island = null; run?.abort(); });
    // Rest: shown without taking focus, so the app the person is using keeps the keyboard.
    win.once('ready-to-show', () => { place(); win.showInactive(); applyMaterial(prefs.material); });
    if (deps.devOrigin) void win.loadURL(`${deps.devOrigin}/companion.html`);
    else void win.loadFile(path.join(deps.distDir, 'companion.html'));
  }

  function closeOverlay() {
    pending = null;
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null;
  }

  function sweepRegions() {
    const now = Date.now();
    for (const [k, r] of regions) if (now - r.at > REGION_TTL_MS) regions.delete(k);
  }

  async function regionBegin(): Promise<{ok: true} | {ok: false; reason: string}> {
    if (overlay) return {ok: false, reason: 'A selection is already open.'};
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    // The island steps aside so it is not part of the picture.
    island?.hide();
    await new Promise((r) => setTimeout(r, 160));
    let full: NativeImage | null = null;
    try {
      const size = {width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor)};
      const sources = await desktopCapturer.getSources({types: ['screen'], thumbnailSize: size, fetchWindowIcons: false});
      const src = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined);
      full = src && !src.thumbnail.isEmpty() ? src.thumbnail : null;
    } catch (e) {
      island?.showInactive();
      return {ok: false, reason: `The screen could not be captured (${safeErrorMessage(e)}).`};
    }
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
        island?.showInactive();
        send({type: 'region-cancelled'});
      }
    });
    ov.once('ready-to-show', () => { ov.setBounds(display.bounds); ov.show(); ov.focus(); });
    if (deps.devOrigin) void ov.loadURL(`${deps.devOrigin}/companion.html#overlay`);
    else void ov.loadFile(path.join(deps.distDir, 'companion.html'), {hash: 'overlay'});
    return {ok: true};
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
    const png = img.toPNG().toString('base64');
    const preview = img.resize({width: Math.min(240, out.width)}).toDataURL();
    sweepRegions();
    const token = randomUUID();
    regions.set(token, {png, width: out.width, height: out.height, at: Date.now()});
    const ov = overlay;
    overlay = null;
    pending = null;
    ov?.destroy();
    if (island && !island.isDestroyed()) { island.show(); island.focus(); }
    send({type: 'region', token, preview, width: out.width, height: out.height, sourceScale: display.scaleFactor});
    deps.record(`Screen region selected for the companion (${out.width}×${out.height} px; kept in memory for up to 5 minutes, sent only if you ask)`);
    return {ok: true as const};
  }

  async function ask(text: string, token?: string) {
    run?.abort();
    const ctl = new AbortController();
    run = ctl;
    const runId = randomUUID();
    let image: {base64: string; width: number; height: number} | undefined;
    if (token) {
      sweepRegions();
      const r = regions.get(token);
      // Single use: a region is never silently reused for a later request.
      regions.delete(token);
      if (!r) {
        send({runId, event: {type: 'error', reason: 'setup', message: 'The selected region expired. Select it again.'} satisfies AgentEvent});
        return {runId};
      }
      image = {base64: r.png, width: r.width, height: r.height};
    }
    const emit = (event: AgentEvent) => {
      if (event.type === 'tool' && event.undo) undoable.add(event.undo.id);
      send({runId, event});
    };
    void deps.backend.companion.run({text, image}, {emit, confirm, signal: ctl.signal}).catch((e) => {
      emit({type: 'error', reason: 'provider', message: safeErrorMessage(e)});
    }).finally(() => { if (run === ctl) run = null; });
    return {runId};
  }

  const handlers: Record<CompanionMethod, (...args: never[]) => Promise<unknown> | unknown> = {
    companionState: async (): Promise<CompanionStatus> => ({readiness: await deps.backend.companion.readiness(), anchor: layout.anchor, shortcut, material, platform: process.platform}),
    companionAsk: (text: string, token?: string) => ask(text, token),
    companionCancel: () => { run?.abort(); return true; },
    companionUndo: async (id: string) => {
      if (!undoable.has(id)) return false;
      undoable.delete(id);
      return deps.backend.companion.undo({kind: 'task', id, label: ''});
    },
    companionLayout: (raw: unknown) => {
      const l = parseLayout(raw);
      if (!l) throw new Error('Invalid layout');
      const release = (raw as {release?: unknown}).release === true;
      if (l.anchor !== prefs.anchor) { prefs.anchor = l.anchor; void savePrefs(); }
      layout = l;
      place();
      // Collapsing gives the keyboard back: Windows activates the window the person was using before.
      if (release && island && !island.isDestroyed() && island.isFocused()) island.blur();
      return true;
    },
    companionOpenHub: (view: string, item?: string) => {
      if (item !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(item)) throw new Error('Invalid item');
      deps.openHub(view, item);
      return true;
    },
    companionSetMaterial: (m: 'none' | 'acrylic') => { applyMaterial(m); return material; },
    regionBegin: () => regionBegin(),
    regionDiscard: (token: string) => regions.delete(token),
    overlayImage: () => overlayImage(),
    overlaySubmit: (raw: unknown) => overlaySubmit(raw),
    overlayCancel: () => { closeOverlay(); island?.showInactive(); send({type: 'region-cancelled'}); return true; },
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
    if (!island || island.isDestroyed()) { createIsland(); return; }
    if (!island.isVisible()) island.showInactive();
    if (island.isFocused()) send({type: 'collapse'});
    else { island.show(); island.focus(); send({type: 'invoke'}); }
  }

  function registerShortcut(): string | null {
    for (const s of SHORTCUTS) {
      try { if (globalShortcut.register(s, toggle)) return s; } catch { /* try the next one */ }
    }
    return null;
  }

  function dispose() {
    run?.abort();
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
  } catch (e) {
    try { dispose(); } catch { /* best effort */ }
    throw e;
  }

  return {
    toggle,
    show: () => { if (!island || island.isDestroyed()) createIsland(); else island.showInactive(); },
    hide: () => island?.hide(),
    isVisible: () => !!island && !island.isDestroyed() && island.isVisible(),
    dispose,
  };
}

