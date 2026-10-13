// Electron main process: lifecycle, window factory, security hooks, tray, hotkey, single instance, crash recovery.
import {BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, nativeImage, session, shell} from 'electron';
import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {pathToFileURL} from 'node:url';
import {createBackend, type Backend, type Dialogs} from './backend';
import type {ShellAdapter} from './services/actions';
import {LaunchGuard} from './services/lifecycle';
import {Reminders} from './services/reminders';
import {createTrustedConfirm, isAllowedRequestUrl, isTestFixtureDir, isTrustedUrl, parseDevOrigin} from './ipcCore';
import {registerIpc} from './ipc';
import {METHODS, ACTIVITY_CHANNEL} from './channels';

// Test mode (no dialogs, no tray, auto-approved confirmations) is honoured only for an isolated temp userData with a fixture
// prefix. Anywhere else a stray JARVIS_TEST_MODE=1 must never reach real user data, so the app refuses to start.
const TEST_REQUESTED = process.env.JARVIS_TEST_MODE === '1';
// productName is now "Desktop Companion", which would move Electron's default userData folder. Keep using the existing
// "Jarvis Desktop" data folder when it exists so a rename never orphans notes, tasks, capsules or the protected key.
if (!TEST_REQUESTED) {
  const legacy = path.join(app.getPath('appData'), 'Jarvis Desktop');
  if (fs.existsSync(legacy) && legacy.toLowerCase() !== app.getPath('userData').toLowerCase()) app.setPath('userData', legacy);
}
const TEST_MODE = TEST_REQUESTED && isTestFixtureDir(app.getPath('userData'), os.tmpdir());
// Development server: honoured only for an unpackaged build and a plain http loopback origin (NSR-11).
const RAW_DEV_URL = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined;
const DEV_ORIGIN = parseDevOrigin(RAW_DEV_URL);
const DEV_URL = DEV_ORIGIN ? RAW_DEV_URL : undefined;
if (RAW_DEV_URL && !DEV_ORIGIN) console.warn('Ignoring VITE_DEV_SERVER_URL: only http loopback origins are accepted.');
const HOTKEY = 'CommandOrControl+Alt+J';
// 32x32 generated tray glyph (original artwork, no external asset).
const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA/UlEQVR4nM2Xuw3EIAyGU7ACLeXJk1jKLgxwDUtlhhQ3QWbIFjkhueB4H4SYwg0C/g8/wCwKcOG0lkVSAa4KUCtAQ6ZpTI4CECSyvz/XlTM7h+aKuwDsZmdJOAJy0tpmAOvO7V/hCMiWC01K/KUAj15xB+KgPasAZElcAUatAiLwRAwg6faUcC0IhSMLoHuEa0D8xPRLLcj2VvEUBFWHiAHcevpaL7gAwSXTK57xwu4DyBGnL3hBugDrKPGMF1YXIIj/AwDaBTAMAGYqAPYQsCchexmyX0RTXMXsjxH7czxFQzJFS8belE7Rlv8kJtfHxC9Rtq9ZLDSPf06H2RcCn7+vr2EvhgAAAABJRU5ErkJggg==';

let backend: Backend | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let guard: LaunchGuard | null = null;
let reloadedOnce = false;
let reminders: Reminders | null = null;
let shuttingDown = false;
const liveNotifications = new Set<Notification>();

const distDir = () => path.join(__dirname, '..', 'dist');
const appFileUrl = () => pathToFileURL(path.join(distDir(), 'index.html')).href;
const startHidden = () => process.argv.includes('--hidden') || process.argv.includes('--start-in-tray');

function appUrlOk(url: string): boolean {
  return isTrustedUrl(url, appFileUrl(), DEV_ORIGIN ?? undefined);
}

// Trusted confirmation for BackendEnv.confirm: a native dialog owned by the visible, focused app window, Cancel is the default and
// the full detail is shown. The renderer never supplies the answer. Tests auto-approve only inside the validated fixture sandbox.
const trustedConfirm = createTrustedConfirm<BrowserWindow>({
  getWindow: () => mainWindow,
  isTrusted: (w) => !w.webContents.isLoading() && appUrlOk(w.webContents.getURL()),
  showMessageBox: (w, options) => dialog.showMessageBox(w, options),
});
const confirm: (summary: string, detail: string) => Promise<boolean> = TEST_MODE ? async () => true : trustedConfirm;

function createDialogs(): Dialogs {
  return {
    async saveExport(defaultName) {
      if (TEST_MODE) return null;
      const opts = {defaultPath: path.join(app.getPath('documents'), defaultName), filters: [{name: 'Desktop Companion export (JSON)', extensions: ['json']}]};
      const r = mainWindow ? await dialog.showSaveDialog(mainWindow, opts) : await dialog.showSaveDialog(opts);
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    async openImport() {
      if (TEST_MODE) return null;
      const opts = {properties: ['openFile' as const], filters: [{name: 'Desktop Companion export (JSON)', extensions: ['json']}]};
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
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><body style="font:16px Segoe UI,sans-serif;background:#16181d;color:#e8e8ea;padding:40px"><h2>Desktop Companion</h2><p>${message}</p><p>Your data is stored locally and was not changed. Restart the app to try again.</p>`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 720, minHeight: 520,
    show: false, backgroundColor: '#16181d', title: 'Desktop Companion',
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
  win.webContents.on('will-redirect', (e, url) => { if (!appUrlOk(url)) e.preventDefault(); });
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
  // Only the packaged dist files (empty file host), the loopback dev server in development, and non-network schemes (NSR-10/11).
  ses.webRequest.onBeforeRequest((details, cb) => {
    cb({cancel: !isAllowedRequestUrl(details.url, distDir(), DEV_ORIGIN ?? undefined)});
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
    t.setToolTip('Desktop Companion');
    t.setContextMenu(Menu.buildFromTemplate([
      {label: 'Show / hide Desktop Companion', click: toggleWindow},
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

/** Due-time notifications for tasks. Off in test mode and in safe launch (no automatic features there). */
function startReminders(b: Backend, safe: boolean) {
  if (TEST_MODE || safe || !Notification.isSupported()) return;
  reminders = new Reminders({
    tasks: () => b.store.snapshot().tasks,
    now: () => Date.now(),
    notify: (title, body) => {
      const n = new Notification({title: title.slice(0, 120), body, silent: false});
      liveNotifications.add(n);
      n.on('click', showWindow);
      n.on('close', () => liveNotifications.delete(n));
      n.show();
    },
    record: async (summary) => { await b.store.addActivity('reminder', summary); },
  });
  reminders.start();
}

// Task changes (save, delete, import) move due times, so the reminder timer is re-aimed after those calls.
const REARM_AFTER = new Set<string>(['saveTask', 'deleteTask', 'importData']);

function withReminderRearm(b: Backend): Pick<Backend, (typeof METHODS)[number]> {
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const m of METHODS) {
    const fn = b[m] as (...args: unknown[]) => Promise<unknown>;
    handlers[m] = REARM_AFTER.has(m) ? async (...args) => { try { return await fn(...args); } finally { reminders?.rearm(); } } : fn;
  }
  return handlers as unknown as Pick<Backend, (typeof METHODS)[number]>;
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
    confirm,
  });
  if (launch.safe) await backend.store.addActivity('recovery', 'Safe launch: the previous two sessions did not exit cleanly. Desktop actions are disabled until a normal restart.');
  if (backend.load.warning) await backend.store.addActivity('recovery', backend.load.warning);

  startReminders(backend, launch.safe);
  registerIpc(withReminderRearm(backend), {appFileUrl: appFileUrl(), devOrigin: DEV_ORIGIN ?? undefined});
  backend.onActivity((a) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ACTIVITY_CHANNEL, a); });

  if (!TEST_MODE && !launch.safe) {
    createTray();
    if (!globalShortcut.register(HOTKEY, toggleWindow)) void backend.store.addActivity('system', `Global hotkey ${HOTKEY} is unavailable (already in use)`);
  }
  createWindow();
  scheduleRetention();
}

if (TEST_REQUESTED && !TEST_MODE) {
  // Fail closed: test mode would auto-approve confirmations, so it is never allowed against a real profile.
  console.error('JARVIS_TEST_MODE needs a userData folder directly inside the OS temp directory whose name starts with jarvis-smoke-, jarvis-test- or desktop-companion-test-.');
  app.exit(1);
} else if (!TEST_MODE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => { if (!tray || TEST_MODE) app.quit(); });
  app.on('activate', showWindow);
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', (e) => {
    quitting = true;
    reminders?.dispose();
    e.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    const b = backend;
    backend = null;
    // Backup/cleanup gets at most 5 s; the clean-exit marker is written even when the backend never started.
    const cleanup = b ? Promise.race([b.dispose().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 5000))]) : Promise.resolve();
    void cleanup.then(() => guard?.end()).catch(() => undefined).finally(() => app.exit(0));
  });
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox('Desktop Companion could not start', String(err instanceof Error ? err.message : err).slice(0, 300));
    app.exit(1);
  });
}
