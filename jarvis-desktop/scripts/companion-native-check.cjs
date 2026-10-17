// Native placement check for the desktop companion window, independent of the island page's markup: launches the real
// main process in a throwaway profile, then drives the window through its own preload API (window.companion) and reads
// the real window bounds Electron reports. Checks: rest window = pet + margin; a bubble opens beside the pet on the side
// facing the middle and the window grows to hold it; docking to every target lands inside the work area; resize presets;
// placement events match the bounds; arguments outside the specs are refused.
//
// Voice: the island's voice methods answer honestly (no Windows engines here) and refuse bad arguments; the app's real
// session permission handler grants microphone audio to the island and the hub and refuses the camera (Chromium's
// generated test devices, so hardware is not the deciding factor).
//
// Not covered (needs a person or a desktop automation tool): dragging (main reads the real OS cursor), click-through
// (Windows/macOS only), focus behaviour, acrylic. Linux/Xvfb results say nothing about Windows composition or DPI.
//
// Run: VITE_DEV_SERVER_URL=http://127.0.0.1:5173 npx electron scripts/companion-native-check.cjs [--no-sandbox]
const {app, BrowserWindow, screen} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
// Test-only: Chromium's generated media devices, so the microphone permission is decided by the app's handler rather than
// failing early for lack of hardware. No fake-UI switch: the app's own permission handler still answers every request.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-companion-native-'));
app.setPath('userData', data);
delete process.env.JARVIS_TEST_MODE;
const results = [];
const fail = [];
const check = (name, ok, detail) => { results.push({name, ok, ...detail}); if (!ok) fail.push(name); console.log(ok ? 'PASS' : 'FAIL', name, JSON.stringify(detail)); };
const timeout = setTimeout(() => { fail.push('timeout'); finish(); }, 90_000);
function finish() {
  clearTimeout(timeout);
  const out = path.join(root, '..', 'planning', 'ui-revamp', 'native-companion', 'native-placement-check.json');
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, `${JSON.stringify({platform: process.platform, display: screen.getPrimaryDisplay().workArea, results, failed: fail}, null, 2)}\n`);
  try { fs.rmSync(data, {recursive: true, force: true}); } catch { /* temp */ }
  app.exit(fail.length ? 1 : 0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(60);
  }
}
const inside = (r, w) => r.x >= w.x && r.y >= w.y && r.x + r.width <= w.x + w.width && r.y + r.height <= w.y + w.height;

require(path.join(root, 'dist-electron', 'main.cjs'));

app.whenReady().then(async () => {
  try {
    const island = await until(() => BrowserWindow.getAllWindows().find((w) => /companion\.html$/.test(w.webContents.getURL())), 15000, 'island window');
    await until(() => !island.webContents.isLoading(), 15000, 'island loaded');
    await sleep(600);
    const js = (code) => island.webContents.executeJavaScript(code, true);
    // Collect placement pushes in the page.
    await js(`window.__placements = []; window.companion.onEvent((e) => { if (e && e.type === 'placement') window.__placements.push(e); }); true`);
    const work = screen.getDisplayMatching(island.getBounds()).workArea;
    const last = async () => (await js('window.__placements.at(-1) ?? null'));
    const settle = async () => { await sleep(150); return {bounds: island.getBounds(), placement: await last()}; };

    const state = await js('window.companion.state()');
    check('state reports appearance, size and dock', state.appearance === 'pet' && state.size === 96 && typeof state.dock === 'string', {appearance: state.appearance, size: state.size, dock: state.dock});

    await js(`window.companion.layout({bubble: null})`);
    let s = await settle();
    // Pet plus an 18 px margin, trimmed where the margin would cross the work-area edge (docked 12 px from the corner).
    const petW = Math.round((96 * 192) / 208);
    const restPet = s.placement?.pet;
    check('rest window is the pet plus margin (trimmed at screen edges), inside the work area', !!restPet && restPet.width === petW && restPet.height === 96 && s.bounds.width >= petW + 18 && s.bounds.width <= petW + 36 && s.bounds.height >= 96 + 18 && s.bounds.height <= 96 + 36 && inside(s.bounds, work), {bounds: s.bounds, pet: restPet, work});
    check('rest placement event matches the window', !!s.placement && s.placement.bubble === null && JSON.stringify(s.placement.window) === JSON.stringify(s.bounds), {placement: s.placement});

    await js(`window.companion.layout({bubble: {width: 420, height: 320}})`);
    s = await settle();
    check('bubble opens on the side facing the middle (pet docked bottom-right)', s.placement?.side === 'left', {side: s.placement?.side});
    check('window grows to hold pet and bubble, still inside the work area', s.bounds.width >= 420 + 89 && inside(s.bounds, work) && JSON.stringify(s.placement.window) === JSON.stringify(s.bounds), {bounds: s.bounds});
    const pet = s.placement.pet;
    const bubble = s.placement.bubble;
    check('bubble does not cover the pet', bubble.x + bubble.width <= pet.x, {pet, bubble});

    for (const target of ['bottom-left', 'left', 'top', 'right', 'bottom-right']) {
      const dock = await js(`window.companion.dock(${JSON.stringify(target)})`);
      s = await settle();
      const petGlobal = {x: s.bounds.x + s.placement.pet.x, y: s.bounds.y + s.placement.pet.y, width: s.placement.pet.width, height: s.placement.pet.height};
      check(`dock ${target}: pet and window inside the work area`, inside(s.bounds, work) && inside(petGlobal, work), {dock, pet: petGlobal, side: s.placement.side});
    }
    const top = await js(`window.companion.dock('top')`);
    s = await settle();
    check('docked top: bubble opens beside or below, never off screen', ['left', 'right', 'below'].includes(s.placement.side) && inside(s.bounds, work), {dock: top, side: s.placement.side});

    for (const [op, px] of [['L', 128], ['S', 64], ['M', 96]]) {
      const size = await js(`window.companion.resize(${JSON.stringify(op)})`);
      s = await settle();
      check(`resize ${op} -> ${px}px tall`, size === px && s.placement.pet.height === px && s.placement.size === px, {size, pet: s.placement.pet});
    }
    const grow = await js(`window.companion.resize('grow')`);
    check('grow steps by 8 px', grow === 104, {size: grow});
    await js(`window.companion.resize('M')`);

    for (const [call, why] of [[`window.companion.layout({bubble: {width: 300, height: 200, x: 0}})`, 'a position from the page'], [`window.companion.dock('center')`, 'an unknown dock'], [`window.companion.resize(200)`, 'a raw size'], [`window.companion.drag('move')`, 'a drag step from the page'], [`window.companion.hit('yes')`, 'a non-boolean hit']]) {
      const refused = await js(`${call}.then(() => false, () => true)`);
      check(`refuses ${why}`, refused, {});
    }
    const gaze = await js(`window.companion.gaze(true)`);
    await sleep(400);
    await js(`window.companion.gaze(false)`);
    check('gaze subscription toggles without error', gaze === true, {});
    // Voice: the island's own methods over the same local speech as the hub. On Linux the Windows engines are absent, so
    // every answer must be an honest "unavailable", never text or a fake success.
    const vs = await js(`window.companion.voiceStatus()`);
    check('voice status: local only, engines honestly unavailable off Windows', vs.cloud === false && (process.platform === 'win32' || (vs.stt.available === false && vs.tts.available === false && /Windows speech/.test(vs.stt.reason))), {status: vs});
    const said = await js(`window.companion.speak('hello from the island')`);
    check('speak answers with a reason, not a fake success, when no voice exists', process.platform === 'win32' || (said.ok === false && typeof said.reason === 'string'), {said});
    check('stop and cancel answer false when nothing runs', (await js(`window.companion.speechStop()`)) === false && (await js(`window.companion.transcribeCancel()`)) === false, {});
    for (const [call, why] of [[`window.companion.transcribe('not audio')`, 'transcribe with non-audio'], [`window.companion.speak('')`, 'speak with empty text'], [`window.companion.transcribe([1, 'x'])`, 'transcribe with a non-number sample']]) {
      check(`refuses ${why}`, await js(`${call}.then(() => false, () => true)`), {});
    }
    // Microphone permission, decided by the app's real session handler: audio for the island, never the camera.
    const media = (c) => js(`navigator.mediaDevices.getUserMedia(${c}).then((s) => { const k = s.getTracks().map((t) => t.kind).join(','); s.getTracks().forEach((t) => t.stop()); return 'granted:' + k; }, (e) => 'denied:' + e.name)`);
    const audio = await media('{audio: true}');
    const video = await media('{video: true}');
    check('island page: microphone audio is permitted', audio === 'granted:audio', {audio});
    check('island page: camera is refused', video === 'denied:NotAllowedError', {video});
    const hub = BrowserWindow.getAllWindows().find((w) => w !== island && !/companion\.html/.test(w.webContents.getURL()));
    if (hub) {
      await until(() => !hub.webContents.isLoading(), 15000, 'hub loaded');
      const hubAudio = await hub.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia({audio: true}).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => 'denied:' + e.name)`, true);
      check('hub page: microphone audio is still permitted', hubAudio === 'granted', {hubAudio});
    }
    await js(`window.companion.layout({bubble: null})`);
    finish();
  } catch (e) {
    fail.push(String(e && e.stack));
    console.error(e);
    finish();
  }
});
