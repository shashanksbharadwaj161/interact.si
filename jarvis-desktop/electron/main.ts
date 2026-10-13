// Electron main process: lifecycle, window factory, security hooks, tray, hotkey, single instance, crash recovery.
import {BrowserWindow, Menu, Tray, app, dialog, globalShortcut, nativeImage, session, shell} from 'electron';
import {spawn} from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createBackend, type Backend, type Dialogs} from './backend';
import type {ShellAdapter} from './services/actions';
import {LaunchGuard} from './services/lifecycle';
import {isTrustedUrl} from './ipcCore';
import {registerIpc} from './ipc';
import {METHODS, ACTIVITY_CHANNEL} from './channels';

const TEST_MODE = process.env.JARVIS_TEST_MODE === '1';
const DEV_URL = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
const HOTKEY = 'CommandOrControl+Alt+J';
// 32x32 generated tray glyph (original artwork, no external asset).
const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA/UlEQVR4nM2Xuw3EIAyGU7ACLeXJk1jKLgxwDUtlhhQ3QWbIFjkhueB4H4SYwg0C/g8/wCwKcOG0lkVSAa4KUCtAQ6ZpTI4CECSyvz/XlTM7h+aKuwDsZmdJOAJy0tpmAOvO7V/hCMiWC01K/KUAj15xB+KgPasAZElcAUatAiLwRAwg6faUcC0IhSMLoHuEa0D8xPRLLcj2VvEUBFWHiAHcevpaL7gAwSXTK57xwu4DyBGnL3hBugDrKPGMF1YXIIj/AwDaBTAMAGYqAPYQsCchexmyX0RTXMXsjxH7czxFQzJFS8belE7Rlv8kJtfHxC9Rtq9ZLDSPf06H2RcCn7+vr2EvhgAAAABJRU5ErkJggg==';

let backend: Backend | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let guard: LaunchGuard | null = null;
let reloadedOnce = false;

const appFileUrl = () => pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
const startHidden = () => process.argv.includes('--hidden') || process.argv.includes('--start-in-tray');

function appUrlOk(url: string): boolean {
  return isTrustedUrl(url, appFileUrl(), DEV_URL ? new URL(DEV_URL).origin : undefined);
}

function createDialogs(): Dialogs {
  return {
    async saveExport(defaultName) {
      if (TEST_MODE) return null;
      const opts = {defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{name: 'Jarvis export (JSON)', extensions: ['json']}]};
      const r = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    async openImport() {
      if (TEST_MODE) return null;
      const opts = {properties: ['openFile' as const], filters: [{name: 'Jarvis export (JSON)', extensions: ['json']}]};
      const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    async pick(kind) {
      if (TEST_MODE) return null;
      const opts = {properties: [kind === 'folder' ? ('openDirectory' as const) : ('openFile' as const)]};
      const r = mainWindow ? await dialog.showOpenDialog(mainWindow, opts) : await dialog.showOpenDialog(opts);
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
  };
}

const shellAdapter: ShellAdapter = {
  // Only ever called with validated http(s)/mailto URLs from an approved action.
  openExternal: (url) => shell.openExternal(url),
  openPath: (p) => shell.openPath(p),
  spawnApp: (exe) => new Promise<void>((resolve, reject) => {
    const child = spawn(exe, [], {detached: true, stdio: 'ignore', shell: false});
    child.once('error', (e) => reject(new Error(`Could not start the app: ${e.message}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  }),
};

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else showWindow();
}

function safePage(message: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body style="font:16px Segoe UI,sans-serif;background:#16181d;color:#e8e8ea;padding:40px"><h2>Jarvis Desktop</h2><p>${message}</p><p>Your data is stored locally and was not changed. Restart the app to try again.</p>`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#16181d', title: 'Jarvis Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      allowRunningInsecureContent: false, spellcheck: false, backgroundThrottling: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;

  win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  win.webContents.on('will-navigate', (e, url) => { if (!appUrlOk(url)) e.preventDefault(); });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => {
    if (win.isDestroyed()) return;
    if (!reloadedOnce) { reloadedOnce = true; win.webContents.reload(); }
    else void win.loadURL(safePage('The interface stopped unexpectedly twice.'));
  });
  win.on('close', (e) => {
    if (!quitting && tray && !TEST_MODE) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => {
    const hide = startHidden() || (backend?.store.snapshot().settings.startInTray ?? false);
    if (!(hide && tray) && !TEST_MODE) win.show();
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(false);
  const devOrigin = DEV_URL ? new URL(DEV_URL).origin : null;
  ses.webRequest.onBeforeRequest((details, cb) => {
    let allow = false;
    try {
      const u = new URL(details.url);
      allow = u.protocol === 'file:' || u.protocol === 'devtools:' || u.protocol === 'data:' || u.protocol === 'blob:' || (devOrigin !== null && (u.origin === devOrigin || u.origin.replace('http', 'ws') === devOrigin.replace('http', 'ws')));
    } catch { allow = false; }
    cb({cancel: !allow});
  });
  // Microphone audio for the app's own page only; everything else is denied.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    const d = details as {mediaTypes?: string[]; requestingUrl?: string};
    const audioOnly = permission === 'media' && !!d.mediaTypes?.length && d.mediaTypes.every((t) => t === 'audio');
    cb(audioOnly && appUrlOk(d.requestingUrl ?? wc.getURL()));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => permission === 'media' && !!wc && appUrlOk(wc.getURL() || origin));
}

function createTray() {
  try {
    const t = new Tray(nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_PNG}`));
    t.setToolTip('Jarvis Desktop');
    t.setContextMenu(Menu.buildFromTemplate([
      {label: 'Show / hide Jarvis', click: toggleWindow},
      {type: 'separator'},
      {label: 'Quit', click: () => { quitting = true; app.quit(); }},
    ]));
    t.on('click', toggleWindow);
    tray = t;
  } catch { tray = null; }
}

function scheduleRetention() {
  const t = setTimeout(async () => {
    try { await backend?.runRetention(); } catch { /* ignore */ }
    scheduleRetention();
  }, 24 * 60 * 60 * 1000);
  t.unref();
}

async function boot() {
  app.setAppUserModelId('in.local.jarvis.desktop');
  if (app.isPackaged) Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  guard = new LaunchGuard(userData);
  const launch = await guard.begin();
  hardenSession();

  backend = await createBackend({
    userData,
    nativeDir: path.join(__dirname, '..', 'native'),
    tmpDir: os.tmpdir(),
    dialogs: createDialogs(),
    shell: shellAdapter,
    selfPids: () => [process.pid, ...app.getAppMetrics().map((m) => m.pid)],
    safeLaunch: () => guard?.safe ?? false,
  });
  if (launch.safe) await backend.store.addActivity('recovery', 'Safe launch: the previous two sessions did not exit cleanly. Desktop actions are disabled until a normal restart.');
  if (backend.load.warning) await backend.store.addActivity('recovery', backend.load.warning);

  registerIpc(backend as Pick<Backend, (typeof METHODS)[number]>, {appFileUrl: appFileUrl(), devOrigin: DEV_URL ? new URL(DEV_URL).origin : undefined});
  backend.onActivity((a) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ACTIVITY_CHANNEL, a); });

  if (!TEST_MODE && !launch.safe) {
    createTray();
    if (!globalShortcut.register(HOTKEY, toggleWindow)) void backend.store.addActivity('system', `Global hotkey ${HOTKEY} is unavailable (already in use)`);
  }
  createWindow();
  scheduleRetention();
}

if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { if (!tray || TEST_MODE) app.quit(); });
  app.on('activate', showWindow);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', (e) => {
    quitting = true;
    if (!backend) return;
    e.preventDefault();
    const b = backend;
    backend = null;
    void b.dispose().finally(async () => { await guard?.end().catch(() => undefined); app.exit(0); });
  });
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('Jarvis Desktop could not start', String(err instanceof Error ? err.message : err).slice(0, 300));
    app.exit(1);
  });
}
