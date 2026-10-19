// Independent security regressions (acceptance role, full handoff). Every test drives the real exported or bundled
// source: electron/main.ts is bundled with a recording Electron stub and run in a child Node process (no Electron binary,
// no window, no network: node:child_process is stubbed so nothing can spawn). SEC-01..04 were fixed by the captain and are
// hard regressions here (they fail against sources from before that fix, e.g. base 3f63718). Finding ids match
// docs/full-security-findings.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// Same convention as full-acceptance: ACCEPTANCE_SOURCE_ROOT may point at another checkout (read only).
const SRC = path.resolve(process.env.ACCEPTANCE_SOURCE_ROOT || root);

// ---------------------------------------------------------------------------------------------------------------
// Harness: real electron/main.ts against a recording Electron stub, in a child process with its own temp userData.
// ---------------------------------------------------------------------------------------------------------------

const ELECTRON_STUB = String.raw`
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const cfg = globalThis.__HARNESS_CFG;
const rec = globalThis.__HARNESS_REC = {windows: [], ipc: new Map(), appHandlers: {}, sessionHandlers: {}, menu: 'unset', safeStorageCalls: 0, dialogs: []};
class Emitter {
  constructor() { this.h = {}; }
  on(ev, fn) { (this.h[ev] ??= []).push(fn); return this; }
  once(ev, fn) { return this.on(ev, fn); }
  emit(ev, ...a) { for (const f of this.h[ev] ?? []) f(...a); }
  removeListener() { return this; }
}
class WebContents extends Emitter {
  constructor() { super(); this.url = ''; this.mainFrame = {}; }
  setWindowOpenHandler(fn) { this.openHandler = fn; }
  getURL() { return this.url; }
  isLoading() { return false; }
  send() {}
  reload() {}
}
class BrowserWindow extends Emitter {
  constructor(options) { super(); this.options = options; this.webContents = new WebContents(); rec.windows.push(this); }
  loadFile(p) { this.webContents.url = pathToFileURL(p).href; return Promise.resolve(); }
  loadURL(u) { this.webContents.url = u; return Promise.resolve(); }
  show() {} hide() {} focus() {} restore() {} showInactive() {} blur() {} destroy() {} setAlwaysOnTop() {} setBackgroundMaterial() {}
  setBounds(b) { this.bounds = b; } getBounds() { return this.bounds ?? {x: 0, y: 0, width: 1, height: 1}; }
  isDestroyed() { return false; } isVisible() { return true; } isMinimized() { return false; } isFocused() { return true; }
  static getAllWindows() { return rec.windows; }
}
const ses = new Emitter();
ses.webRequest = {onBeforeRequest(fn) { rec.beforeRequest = fn; }};
ses.setPermissionRequestHandler = (fn) => { rec.permissionRequest = fn; };
ses.setPermissionCheckHandler = (fn) => { rec.permissionCheck = fn; };
ses.setSpellCheckerEnabled = () => {};
ses.clearCache = async () => {};
rec.session = ses;
let ready;
const readyPromise = new Promise((r) => { ready = r; });
rec.ready = () => ready();
const app = new Emitter();
Object.assign(app, {
  isPackaged: cfg.packaged,
  getPath: (n) => (n === 'userData' ? cfg.userData : path.join(cfg.base, 'paths', n)),
  setPath: (n, p) => { if (n === 'userData') cfg.userData = p; },
  getName: () => 'Desktop Companion',
  setAppUserModelId() {},
  requestSingleInstanceLock: () => true,
  whenReady: () => readyPromise,
  quit() { rec.quit = true; },
  exit(code) { rec.exitCode = code; },
  getAppMetrics: () => [],
});
app.on = function (ev, fn) { (rec.appHandlers[ev] ??= []).push(fn); return this; };
module.exports = {
  app, BrowserWindow,
  session: {defaultSession: ses},
  Menu: {setApplicationMenu(m) { rec.menu = m; }, buildFromTemplate: (t) => t},
  Tray: class { constructor() { rec.tray = true; } setToolTip() {} setContextMenu() {} on() {} destroy() {} },
  Notification: Object.assign(class { on() {} show() {} close() {} }, {isSupported: () => false}),
  nativeImage: {createFromDataURL: () => ({})},
  globalShortcut: {register: () => true, isRegistered: () => false, unregister() {}, unregisterAll() {}},
  screen: Object.assign(new Emitter(), (() => { const d = {id: 1, scaleFactor: 1.5, bounds: {x: 0, y: 0, width: 1280, height: 720}, size: {width: 1280, height: 720}, workArea: {x: 0, y: 0, width: 1280, height: 680}}; return {getCursorScreenPoint: () => ({x: 10, y: 10}), getDisplayNearestPoint: () => d, getDisplayMatching: () => d, getPrimaryDisplay: () => d}; })()),
  desktopCapturer: {getSources: async () => { rec.captured = (rec.captured ?? 0) + 1; return []; }},
  powerMonitor: new Emitter(),
  clipboard: {readText: () => '', has: () => false},
  shell: {openExternal: async () => { rec.external = true; }, openPath: async () => ''},
  safeStorage: {
    isEncryptionAvailable: () => { rec.safeStorageCalls++; return true; },
    encryptString: (s) => { rec.safeStorageCalls++; return Buffer.from('enc:' + s, 'utf8'); },
    decryptString: (b) => { rec.safeStorageCalls++; return b.toString('utf8').slice(4); },
  },
  dialog: {
    showMessageBox: async (_w, o) => { rec.dialogs.push(o); return {response: 0}; },
    showSaveDialog: async () => ({canceled: true}),
    showOpenDialog: async () => ({canceled: true, filePaths: []}),
    showErrorBox: (t, m) => { rec.errorBox = String(t) + ': ' + String(m); },
  },
  ipcMain: {handle(ch, fn) { rec.ipc.set(ch, fn); }, removeHandler(ch) { rec.ipc.delete(ch); }},
};
`;

const CHILD_PROCESS_STUB = String.raw`
const rec = () => globalThis.__HARNESS_REC;
function blocked(file, args) {
  rec().spawned = (rec().spawned ?? 0) + 1;
  rec().spawnedFiles = [...(rec().spawnedFiles ?? []), String(file).split(/[\\/]/).pop() + ' ' + (Array.isArray(args) ? args.filter((a) => /\.ps1$/i.test(a)).map((a) => a.split(/[\\/]/).pop()).join(' ') : '')];
  const err = new Error('child processes are blocked in the acceptance harness');
  err.code = 'ENOENT';
  throw err;
}
module.exports = {spawn: blocked, execFile: blocked, exec: blocked, fork: blocked, spawnSync: blocked, execFileSync: blocked, execSync: blocked};
`;

let bundlePromise = null;
let workDir = null;
async function harnessBundle() {
  bundlePromise ??= (async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-acceptance-'));
    const out = path.join(workDir, 'bundle', 'main.cjs');
    await build({
      entryPoints: [path.join(SRC, 'electron', 'main.ts')], nodePaths: [path.join(root, 'node_modules')], bundle: true, platform: 'node', format: 'cjs', outfile: out, target: 'node22', logLevel: 'silent',
      define: {__NATIVE_MANIFEST__: 'undefined'},
      plugins: [{name: 'harness-stubs', setup(b) {
        b.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'harness'}));
        b.onResolve({filter: /^(node:)?child_process$/}, () => ({path: 'child_process', namespace: 'harness'}));
        b.onLoad({filter: /.*/, namespace: 'harness'}, (a) => ({contents: a.path === 'electron' ? ELECTRON_STUB : CHILD_PROCESS_STUB, loader: 'js', resolveDir: SRC}));
      }}],
    });
    // The packaged page main.ts loads (dist is a sibling of the bundle folder, as in the real layout).
    await mkdir(path.join(workDir, 'dist'), {recursive: true});
    await writeFile(path.join(workDir, 'dist', 'index.html'), '<!doctype html><title>fixture</title>');
    return out;
  })();
  return bundlePromise;
}

const fixtureDirs = [];
test.after(async () => {
  if (workDir) await rm(workDir, {recursive: true, force: true});
  for (const d of fixtureDirs) await rm(d, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
});

// The driver boots main.ts, then answers `probes` (JS source run with the recorder in scope) and prints one JSON line.
const DRIVER = String.raw`
const cfg = JSON.parse(process.argv[2]);
globalThis.__HARNESS_CFG = cfg;
require(cfg.bundle);
const rec = globalThis.__HARNESS_REC;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  rec.ready();
  for (let i = 0; i < 200 && !rec.windows.length && rec.exitCode === undefined; i++) await settle(25);
  const win = rec.windows[0];
  const appUrl = win ? win.webContents.url : null;
  const fire = (emitter, ev, ...a) => { let prevented = false; const e = {preventDefault() { prevented = true; }}; emitter.emit(ev, e, ...a); return prevented; };
  const invoke = async (method, args, url = appUrl) => {
    const h = rec.ipc.get('jarvis:' + method);
    const frame = {url};
    try { return {ok: true, value: await h({senderFrame: frame, sender: {mainFrame: frame}}, ...args)}; } catch (e) { return {ok: false, error: String(e && e.message)}; }
  };
  const result = {booted: !!win, exitCode: rec.exitCode ?? null, errorBox: rec.errorBox ?? null};
  try { Object.assign(result, await (async () => { ${'$'}{PROBES} })()); } catch (e) { result.probeError = String(e && e.stack); }
  result.spawned = rec.spawned ?? 0;
  result.spawnedFiles = rec.spawnedFiles ?? [];
  result.safeStorageCalls = rec.safeStorageCalls;
  process.stdout.write('\n@@RESULT@@' + JSON.stringify(result) + '\n');
  process.exit(0);
})();
`;

async function runMain(probes, {packaged = true, env = {}, testMode = false} = {}) {
  const bundle = await harnessBundle();
  const base = await mkdtemp(path.join(workDir, 'run-'));
  // Test mode is honoured only for a fixture-prefixed folder directly inside the OS temp dir (main.ts isTestFixtureDir).
  const userData = testMode ? await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-acceptance-')) : path.join(base, 'userData');
  if (testMode) fixtureDirs.push(userData);
  await mkdir(userData, {recursive: true});
  const driver = path.join(base, 'driver.cjs');
  await writeFile(driver, DRIVER.replace('${PROBES}', probes));
  const childEnv = {...process.env, ...env};
  delete childEnv.JARVIS_TEST_MODE;
  if (testMode) childEnv.JARVIS_TEST_MODE = '1';
  if (!('VITE_DEV_SERVER_URL' in env)) delete childEnv.VITE_DEV_SERVER_URL;
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, [driver, JSON.stringify({bundle, base, userData, packaged})], {env: childEnv, cwd: base, timeout: 60_000, maxBuffer: 4 << 20}, (err, out, errOut) => {
      if (err && !String(out).includes('@@RESULT@@')) reject(new Error(`harness failed: ${err.message}\n${String(errOut).slice(-2000)}`));
      else resolve(String(out));
    });
  });
  const line = stdout.split('\n').find((l) => l.startsWith('@@RESULT@@'));
  const result = JSON.parse(line.slice('@@RESULT@@'.length));
  if (result.probeError) throw new Error(`probe failed: ${result.probeError}`);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// App privilege and navigation (packaged build)
// ---------------------------------------------------------------------------------------------------------------

test('packaged boot: sandboxed window, no menu or devtools, no child process at startup, packaged page is the only trusted origin', async () => {
  const r = await runMain(String.raw`
    const wp = win.options.webPreferences;
    const secure = (w) => { const p = w.options.webPreferences; return {contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, devTools: p.devTools, nodeInSub: p.nodeIntegrationInSubFrames, nodeInWorker: p.nodeIntegrationInWorker, insecure: p.allowRunningInsecureContent}; };
    const island = rec.windows.find((w) => /companion\.html$/.test(w.webContents.url));
    return {wp: {contextIsolation: wp.contextIsolation, sandbox: wp.sandbox, nodeIntegration: wp.nodeIntegration, webSecurity: wp.webSecurity, devTools: wp.devTools, nodeInSub: wp.nodeIntegrationInSubFrames, nodeInWorker: wp.nodeIntegrationInWorker, insecure: wp.allowRunningInsecureContent},
      menu: rec.menu, appUrl, ipcCount: rec.ipc.size, channels: [...rec.ipc.keys()],
      island: island ? {wp: secure(island), preload: island.options.webPreferences.preload.split(/[\\/]/).pop(), transparent: island.options.transparent, frame: island.options.frame, skipTaskbar: island.options.skipTaskbar,
        open: island.webContents.openHandler({url: 'https://example.com'}), navRemote: fire(island.webContents, 'will-navigate', 'https://example.com/'), navHub: fire(island.webContents, 'will-navigate', appUrl)} : null,
      windowCount: rec.windows.length, captured: rec.captured ?? 0,
      open: win.webContents.openHandler({url: 'https://example.com'}),
      navSelf: fire(win.webContents, 'will-navigate', appUrl),
      navRemote: fire(win.webContents, 'will-navigate', 'https://example.com/'),
      navOtherFile: fire(win.webContents, 'will-navigate', 'file:///C:/Windows/win.ini'),
      navUnc: fire(win.webContents, 'will-navigate', 'file://attacker/share/index.html'),
      redirectRemote: fire(win.webContents, 'will-redirect', 'https://example.com/'),
      webview: fire(win.webContents, 'will-attach-webview', {}, {}),
    };`);
  assert.equal(r.booted, true, `main.ts did not create a window (exit ${r.exitCode}, ${r.errorBox})`);
  assert.deepEqual(r.wp, {contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, nodeInSub: false, nodeInWorker: false, insecure: false});
  assert.equal(r.menu, null, 'packaged builds remove the application menu (no View > Toggle DevTools / Reload)');
  assert.match(r.appUrl, /^file:\/\/\/.*\/dist\/index\.html$/);
  // The hub's table, and separately the companion island's own small table (electron/companionCore.ts), nothing else.
  const hubChannels = r.channels.filter((c) => c.startsWith('jarvis:')).map((c) => c.slice('jarvis:'.length));
  const companionChannels = r.channels.filter((c) => c.startsWith('companion:')).map((c) => c.slice('companion:'.length));
  assert.deepEqual(hubChannels.sort(), [...channels.METHODS].sort(), 'exactly one handler per channel-table method');
  assert.deepEqual(companionChannels.sort(), [...channels.COMPANION_METHODS].sort(), 'the companion registers only its own methods');
  assert.equal(r.ipcCount, channels.METHODS.length + channels.COMPANION_METHODS.length, 'no other channels');
  // The island is a second sandboxed window with its own preload; it denies popups and leaves for nowhere. Nothing is
  // captured at startup: the screen is read only when the person starts a region selection.
  assert.equal(r.windowCount, 2);
  assert.deepEqual(r.island?.wp, {contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false, nodeInSub: false, nodeInWorker: false, insecure: false});
  assert.deepEqual([r.island.preload, r.island.transparent, r.island.frame, r.island.skipTaskbar], ['companionPreload.cjs', true, false, true]);
  assert.deepEqual(r.island.open, {action: 'deny'});
  assert.deepEqual([r.island.navRemote, r.island.navHub], [true, true], 'the island cannot navigate to a site or to the hub page');
  assert.equal(r.captured, 0, 'no screen capture at startup');
  assert.deepEqual(r.open, {action: 'deny'});
  assert.equal(r.navSelf, false, 'the app page itself may load');
  assert.deepEqual([r.navRemote, r.navOtherFile, r.navUnc, r.redirectRemote, r.webview], [true, true, true, true, true]);
  assert.equal(r.spawned, 0, `startup spawned ${r.spawnedFiles.join(', ')}`);
});

test('session request filter: renderer cannot reach the network or outside files; microphone is off until native permission', async () => {
  const r = await runMain(String.raw`
    const decide = (url) => new Promise((res) => rec.beforeRequest({url}, (d) => res(d.cancel)));
    const urls = ['https://api.anthropic.com/v1/messages', 'http://127.0.0.1:11434/api/chat', 'http://localhost:5173/', 'ws://127.0.0.1:11434/',
      'file:///C:/Windows/win.ini', 'file://attacker/share/x.js', appUrl.replace('index.html', '..%2F..%2Fsecret.txt'), appUrl, appUrl.replace('index.html', 'assets/app.js'), 'data:text/plain,hi', 'blob:file:///0b6f'];
    const cancel = {};
    for (const u of urls) cancel[u] = await decide(u);
    const perm = (permission, details, url = appUrl) => new Promise((res) => rec.permissionRequest({getURL: () => url}, permission, res, {requestingUrl: url, ...details}));
    return {cancel, appUrl,
      audio: await perm('media', {mediaTypes: ['audio']}),
      video: await perm('media', {mediaTypes: ['video']}),
      audioVideo: await perm('media', {mediaTypes: ['audio', 'video']}),
      audioRemote: await perm('media', {mediaTypes: ['audio']}, 'https://example.com/'),
      notifications: await perm('notifications', {}),
      clipboard: await perm('clipboard-read', {}),
      geo: await perm('geolocation', {}),
      checkMediaRemote: rec.permissionCheck({getURL: () => 'https://example.com/'}, 'media', 'https://example.com'),
      checkGeo: rec.permissionCheck({getURL: () => appUrl}, 'geolocation', 'file://'),
    };`);
  const c = r.cancel;
  for (const u of ['https://api.anthropic.com/v1/messages', 'http://127.0.0.1:11434/api/chat', 'http://localhost:5173/', 'ws://127.0.0.1:11434/', 'file:///C:/Windows/win.ini', 'file://attacker/share/x.js']) {
    assert.equal(c[u], true, `${u} must be cancelled for the packaged renderer`);
  }
  assert.equal(c[r.appUrl.replace('index.html', '..%2F..%2Fsecret.txt')], true, 'encoded traversal out of dist is cancelled');
  assert.equal(c[r.appUrl], false);
  assert.equal(c[r.appUrl.replace('index.html', 'assets/app.js')], false);
  assert.equal(c['data:text/plain,hi'], false);
  assert.deepEqual([r.audio, r.video, r.audioVideo, r.audioRemote, r.notifications, r.clipboard, r.geo, r.checkMediaRemote, r.checkGeo], [false, false, false, false, false, false, false, false, false]);
});

test('development: a non-loopback VITE_DEV_SERVER_URL is ignored; packaged builds ignore any dev URL', async () => {
  const remote = await runMain('return {appUrl};', {packaged: false, env: {VITE_DEV_SERVER_URL: 'http://192.168.1.20:5173/'}});
  assert.match(remote.appUrl, /^file:/, 'a LAN dev server is never loaded');
  const packaged = await runMain('return {appUrl};', {packaged: true, env: {VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/'}});
  assert.match(packaged.appUrl, /^file:/);
  const dev = await runMain(String.raw`
    const decide = (url) => new Promise((res) => rec.beforeRequest({url}, (d) => res(d.cancel)));
    return {appUrl, devTools: win.options.webPreferences.devTools, hmr: await decide('ws://127.0.0.1:5173/'), otherPort: await decide('http://127.0.0.1:11434/api/tags')};`,
  {packaged: false, env: {VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173/'}});
  assert.equal(dev.appUrl, 'http://127.0.0.1:5173/');
  assert.equal(dev.devTools, true);
  assert.equal(dev.hmr, false, 'the dev server websocket (HMR) is allowed');
  assert.equal(dev.otherPort, true, 'another loopback port (the Ollama API) stays blocked for the renderer');
});

test('IPC: an untrusted or sub-frame sender is refused before any handler; the trusted page reads state without spawning', async () => {
  const r = await runMain(String.raw`
    const h = rec.ipc.get('jarvis:getState');
    const sub = await h({senderFrame: {url: appUrl}, sender: {mainFrame: {url: appUrl}}}).then(() => 'ok', (e) => e.message);
    return {remote: await invoke('getState', [], 'https://example.com/'), otherFile: await invoke('getState', [], 'file:///C:/Users/Public/index.html'),
      sub, own: await invoke('getState', []), arity: await invoke('getState', [1, 2, 3, 4, 5, 6, 7, 8])};`);
  assert.deepEqual([r.remote.ok, r.otherFile.ok], [false, false]);
  assert.match(r.remote.error, /untrusted sender/);
  assert.match(r.sub, /untrusted sender/, 'a sub-frame on the app page is not the main frame');
  assert.equal(r.own.ok, true, r.own.error);
  assert.equal(typeof r.own.value.settings.mode, 'string');
  assert.equal(r.own.value.settings.mode, 'offline', 'a fresh profile starts offline');
  assert.equal(r.arity.ok, false);
  assert.equal(r.spawned, 0);
});

test('every web contents created later gets the same navigation, redirect, window-open and webview guards', async () => {
  const r = await runMain(String.raw`
    const {EventEmitter} = require('node:events');
    const wc = new EventEmitter();
    wc.setWindowOpenHandler = (fn) => { wc.openHandler = fn; };
    const prevent = (ev, ...a) => { let p = false; wc.emit(ev, {preventDefault() { p = true; }}, ...a); return p; };
    for (const fn of rec.appHandlers['web-contents-created'] ?? []) fn({}, wc);
    return {open: wc.openHandler?.({url: 'https://example.com'}), nav: prevent('will-navigate', 'https://example.com/'),
      redirect: prevent('will-redirect', 'https://example.com/'), frameNav: prevent('will-frame-navigate', {url: 'https://example.com/', isMainFrame: false}),
      webview: prevent('will-attach-webview', {}, {})};`);
  assert.deepEqual(r.open, {action: 'deny'});
  assert.equal(r.nav, true);
  assert.equal(r.webview, true);
});

test('SEC-02 (fixed): secondary web contents also cancel server redirects away from the app', async () => {
  const r = await runMain(String.raw`
    const {EventEmitter} = require('node:events');
    const wc = new EventEmitter(); wc.setWindowOpenHandler = () => {};
    let p = false;
    for (const fn of rec.appHandlers['web-contents-created'] ?? []) fn({}, wc);
    wc.emit('will-redirect', {preventDefault() { p = true; }}, 'https://example.com/');
    return {redirect: p};`);
  assert.equal(r.redirect, true);
});

// ---------------------------------------------------------------------------------------------------------------
// SEC-01: exports in the 3D and Motion studios report success, but the session cancels every download.
// ---------------------------------------------------------------------------------------------------------------

// Emits will-download for each [label, url, contents] case against the real handler; reports cancel / save-dialog per case.
const DOWNLOAD_PROBE = String.raw`
  const run = (url, wc) => {
    let prevented = false;
    const it = {getURL: () => url, getFilename: () => 'scene3d-frame-0.00s.png', setSavePath() { this.saved = true; }, setSaveDialogOptions(o) { this.dialog = o; }, on() {}, once() {}};
    rec.session.emit('will-download', {preventDefault() { prevented = true; }}, it, wc);
    return {prevented, dialog: !!it.dialog, defaultPath: it.dialog?.defaultPath ?? null, silent: !!it.saved};
  };
  const foreign = {getURL: () => 'https://example.com/'};
  return {handlers: (rec.session.h['will-download'] ?? []).length,
    appBlob: run('blob:file:///6c1d', win.webContents), appData: run('data:image/png;base64,iVBORw0KGgo=', win.webContents),
    remote: run('https://example.com/payload.exe', win.webContents), file: run('file:///C:/Windows/System32/cmd.exe', win.webContents),
    foreignBlob: run('blob:https://example.com/6c1d', foreign), noContents: run('blob:file:///6c1d', null)};`;

test('downloads: remote and file URLs, and blob downloads from anything but the trusted app page, are always cancelled', async () => {
  const r = await runMain(DOWNLOAD_PROBE);
  assert.equal(r.handlers, 1);
  for (const k of ['remote', 'file', 'foreignBlob', 'noContents']) {
    assert.equal(r[k].prevented, true, `${k} download must be cancelled`);
    assert.equal(r[k].dialog, false, `${k} must not even reach a save dialog`);
  }
});

test('downloads: test mode cancels every download, including app-page studio exports (tests never write files)', async () => {
  const r = await runMain(DOWNLOAD_PROBE, {testMode: true});
  assert.equal(r.booted, true, `test-mode boot failed (exit ${r.exitCode})`);
  for (const k of ['appBlob', 'appData', 'remote', 'file', 'foreignBlob', 'noContents']) assert.equal(r[k].prevented, true, `${k} must be cancelled in test mode`);
});

test('SEC-01 (fixed): a studio export from the app page goes through the native save dialog, never silently or cancelled', async () => {
  const r = await runMain(DOWNLOAD_PROBE);
  for (const k of ['appBlob', 'appData']) {
    assert.equal(r[k].prevented, false, `${k}: the export was cancelled while the studio reports it as exported`);
    assert.equal(r[k].dialog, true, `${k}: the user chooses the destination in the native save dialog`);
    assert.equal(r[k].silent, false, `${k}: no silent save path`);
    assert.match(r[k].defaultPath, /scene3d-frame-0\.00s\.png$/);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// SEC-03: Electron safeStorage is the documented preferred key protector but is never wired in production.
// ---------------------------------------------------------------------------------------------------------------

test('cloud key through the real IPC path: never echoed, refused while the protector is unavailable, nothing written in plaintext', async () => {
  const key = 'sk-acceptance-' + 'x'.repeat(40);
  const r = await runMain(String.raw`
    const fs = require('node:fs'), path = require('node:path');
    const set = await invoke('setCloudKey', [${JSON.stringify(key)}]);
    const status = await invoke('cloudKeyStatus', []);
    const state = await invoke('getState', []);
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(fs.readFileSync(p, 'latin1')); } };
    walk(globalThis.__HARNESS_CFG.userData);
    return {set, status, stateText: JSON.stringify(state), plaintextOnDisk: files.some((t) => t.includes(${JSON.stringify(key)}))};`);
  assert.equal(r.plaintextOnDisk, false, 'the key never reaches disk in plaintext');
  assert.ok(!r.stateText.includes(key), 'state never carries the key');
  if (r.set.ok) {
    assert.equal(r.status.value.configured, true);
  } else {
    // The DPAPI helper could not run (child processes are blocked here): the vault must fail closed, without the key in the error.
    assert.ok(!r.set.error.includes(key));
    assert.match(r.set.error, /not stored|unavailable/i);
    assert.equal(r.status.value.configured, false);
  }
});

test('SEC-03 (fixed): the main process wires Electron safeStorage so storing the key needs no PowerShell child', async () => {
  const r = await runMain(String.raw`return {set: await invoke('setCloudKey', ['sk-acceptance-' + 'y'.repeat(40)])};`);
  assert.equal(r.set.ok, true, r.set.error);
  assert.ok(r.safeStorageCalls > 0, 'safeStorage was never consulted');
  assert.equal(r.spawned, 0, `spawned ${r.spawnedFiles.join(', ')}`);
});

// ---------------------------------------------------------------------------------------------------------------
// Pure policies from the IPC core (error redaction)
// ---------------------------------------------------------------------------------------------------------------

async function bundleTs(contents) {
  const out = await build({stdin: {contents, resolveDir: SRC, loader: 'ts', sourcefile: 'full-security-entry.ts'}, nodePaths: [path.join(root, 'node_modules')], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}
const core = await bundleTs(`export {safeErrorMessage, isAllowedFileRequest, isTrustedUrl} from './electron/ipcCore';`);
const channels = await bundleTs(`export {METHODS} from './electron/channels'; export {COMPANION_METHODS} from './electron/companionCore';`);

test('error redaction removes the Windows profile path in the forms Node actually produces', () => {
  const m = core.safeErrorMessage(new Error("ENOENT: no such file or directory, open 'C:\\Users\\alice\\Documents\\notes.json'"));
  assert.ok(!m.includes('alice'));
  assert.equal(core.safeErrorMessage('not an error'), 'Request failed');
  assert.ok(core.safeErrorMessage(new Error('x'.repeat(5000))).length <= 400);
});

test('SEC-04 (fixed): profile paths in URL, forward-slash and JSON-escaped form are redacted too', () => {
  for (const msg of ["Failed to load file:///C:/Users/alice/AppData/x.json", "open 'C:/Users/alice/x'", 'bad path "C:\\\\Users\\\\alice\\\\x"', 'at \\\\?\\C:\\Users\\alice\\x']) {
    assert.ok(!core.safeErrorMessage(new Error(msg)).includes('alice'), msg);
  }
});

test('file requests: Windows 8.3, alternate data stream and mixed-case forms of dist stay inside dist only', () => {
  const dist = 'C:\\App\\resources\\app.asar\\dist';
  const ok = (u) => core.isAllowedFileRequest(u, dist);
  assert.equal(ok('file:///C:/App/resources/app.asar/dist/index.html'), true);
  assert.equal(ok('file:///c:/app/RESOURCES/app.asar/dist/assets/a.js'), true);
  assert.equal(ok('file:///C:/App/resources/app.asar/dist-evil/a.js'), false, 'a sibling folder sharing the prefix is not dist');
  assert.equal(ok('file:///C:/App/resources/app.asar/dist/%2e%2e/%2e%2e/secret'), false);
  assert.equal(ok('file:///C:/App/resources/app.asar/dist/..%5C..%5Csecret'), false);
  assert.equal(ok('file:///C:/App/resources/app.asar/dist/a%00.js'), false);
  assert.equal(ok('file://server/C$/App/resources/app.asar/dist/index.html'), false);
  assert.equal(core.isTrustedUrl('file:///C:/App/resources/app.asar/dist/index.html?x#y', 'file:///C:/App/resources/app.asar/dist/index.html'), true);
  assert.equal(core.isTrustedUrl('file:///C:/App/resources/app.asar/dist/other.html', 'file:///C:/App/resources/app.asar/dist/index.html'), false);
});
