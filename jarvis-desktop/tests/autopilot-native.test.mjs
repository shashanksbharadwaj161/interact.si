// Native/main-process autopilot tests: helper integrity, startup/hotkey helpers, lifecycle hardening, idle behaviour, reminders.
// Bundles the real TypeScript in memory. Electron, PowerShell and the desktop are never touched: every external is a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync} from 'node:fs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'autopilot-native-entry.ts',
    loader: 'ts',
    contents: `
      export * as integrity from './electron/native/integrity.ts';
      export * as runner from './electron/native/runner.ts';
      export * as startup from './electron/native/startup.ts';
      export * as lifecycle from './electron/services/lifecycle.ts';
      export * as reminders from './electron/services/reminders.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {integrity, runner, startup, lifecycle, reminders} = mod;

const read = (...p) => readFileSync(path.join(root, ...p), 'utf8');
const bytes = (s) => new TextEncoder().encode(s);

// ---------- helper integrity (NSR-13) ----------

const FILES = {'common.ps1': 'function Shared {}', 'click.ps1': '. common; click', 'dpapi.ps1': '. common; dpapi'};

function diskOf(files) {
  return async (file) => {
    const name = file.split('\\').pop();
    if (!(name in files)) throw new Error('ENOENT');
    return bytes(files[name]);
  };
}

test('manifest: sha256 of raw bytes, sorted, validated strictly', () => {
  const m = integrity.buildManifest(FILES);
  assert.equal(m.version, 1);
  assert.equal(m.algorithm, 'sha256');
  assert.deepEqual(Object.keys(m.files), ['click.ps1', 'common.ps1', 'dpapi.ps1']);
  assert.equal(m.files['common.ps1'], integrity.sha256Hex('function Shared {}'));
  assert.equal(integrity.isNativeManifest(m), true);
  for (const bad of [null, {}, {version: 2, algorithm: 'sha256', files: {'a.ps1': 'a'.repeat(64)}}, {version: 1, algorithm: 'md5', files: {'a.ps1': 'a'.repeat(64)}},
    {version: 1, algorithm: 'sha256', files: {}}, {version: 1, algorithm: 'sha256', files: {'../a.ps1': 'a'.repeat(64)}}, {version: 1, algorithm: 'sha256', files: {'a.ps1': 'XYZ'}}]) {
    assert.equal(integrity.isNativeManifest(bad), false, JSON.stringify(bad));
  }
});

test('verifyFiles: passes untouched files; flags a changed byte, a missing file and an unlisted name', async () => {
  const m = integrity.buildManifest(FILES);
  const join = (n) => `C:\\n\\${n}`;
  await integrity.verifyFiles(m, ['click.ps1', 'common.ps1'], join, diskOf(FILES));
  await assert.rejects(integrity.verifyFiles(m, ['click.ps1'], join, diskOf({...FILES, 'click.ps1': '. common; click '})), /failed its integrity check/);
  await assert.rejects(integrity.verifyFiles(m, ['click.ps1'], join, diskOf({'common.ps1': FILES['common.ps1']})), /could not be read/);
  await assert.rejects(integrity.verifyFiles(m, ['extra.ps1'], join, diskOf(FILES)), /not in the integrity manifest/);
  // Prototype keys are not manifest entries.
  await assert.rejects(integrity.verifyFiles(m, ['constructor'], join, diskOf(FILES)), /not in the integrity manifest/);
  await assert.rejects(integrity.verifyFiles(m, ['__proto__'], join, diskOf(FILES)), /not in the integrity manifest/);
});

function fakeExec(stdout = '{"ok":true}\n') {
  const spawned = [];
  const exec = (file, args, opts, cb) => {
    const child = {kill() { return true; }, stdin: {on() {}, end() { setImmediate(() => cb(null, stdout, '')); }}};
    spawned.push({file, args});
    return child;
  };
  return {exec, spawned};
}

const mkRunner = (files, cfg, f = fakeExec()) => ({
  f,
  r: new runner.NativeRunner({nativeDir: 'C:\\n', powershellPath: 'C:\\ps.exe', execFileImpl: f.exec, integrity: cfg, readFileImpl: diskOf(files)}),
});

test('runner: a tampered helper is never spawned; the shared module is covered too', async () => {
  const m = integrity.buildManifest({...FILES, 'click.ps1': 'click'});
  const ok = mkRunner({...FILES, 'click.ps1': 'click'}, {manifest: m, required: true});
  assert.deepEqual(await ok.r.run('click', {}), {ok: true});
  assert.equal(ok.f.spawned.length, 1);

  for (const tampered of [{...FILES, 'click.ps1': 'click; Start-Process calc'}, {...FILES, 'click.ps1': 'click', 'common.ps1': 'function Shared { evil }'}]) {
    const t = mkRunner(tampered, {manifest: m, required: true});
    await assert.rejects(t.r.run('click', {}), (e) => e.name === 'Error' && e.kind === 'integrity' && /integrity check/.test(e.message));
    assert.equal(t.f.spawned.length, 0, 'PowerShell must not start for a failed check');
  }
});

test('runner: packaged builds fail closed without a manifest; development skips the check', async () => {
  const closed = mkRunner(FILES, {manifest: null, required: true});
  await assert.rejects(closed.r.run('dpapi', {}), (e) => e.kind === 'integrity' && /manifest is missing/.test(e.message));
  assert.equal(closed.f.spawned.length, 0);
  const dev = mkRunner(FILES, {manifest: null, required: false});
  assert.deepEqual(await dev.r.run('dpapi', {}), {ok: true});
});

test('runner: a script absent from the manifest is refused; the check runs per call, not once', async () => {
  const m = integrity.buildManifest({'common.ps1': FILES['common.ps1']});
  const t = mkRunner(FILES, {manifest: m, required: true});
  await assert.rejects(t.r.run('click', {}), /not in the integrity manifest/);

  const full = integrity.buildManifest(FILES);
  let disk = {...FILES};
  const f = fakeExec();
  const r = new runner.NativeRunner({nativeDir: 'C:\\n', powershellPath: 'C:\\ps.exe', execFileImpl: f.exec, integrity: {manifest: full, required: true}, readFileImpl: (p) => diskOf(disk)(p)});
  await r.run('dpapi', {});
  disk = {...disk, 'dpapi.ps1': 'swapped after first run'};
  await assert.rejects(r.run('dpapi', {}), /integrity check/);
  assert.equal(f.spawned.length, 1);
});

test('runner: process-wide configuration is used when no explicit option is given', async () => {
  const m = integrity.buildManifest(FILES);
  integrity.configureNativeIntegrity({manifest: m, required: true});
  try {
    const f = fakeExec();
    const r = new runner.NativeRunner({nativeDir: 'C:\\n', powershellPath: 'C:\\ps.exe', execFileImpl: f.exec, readFileImpl: diskOf({...FILES, 'click.ps1': 'x'})});
    await assert.rejects(r.run('click', {}), /integrity check/);
    assert.equal(f.spawned.length, 0);
  } finally {
    integrity.configureNativeIntegrity({manifest: null, required: false});
  }
  assert.deepEqual(integrity.getNativeIntegrity(), {manifest: null, required: false});
});

test('build pipeline: build-main.mjs writes a manifest that matches every native/*.ps1 and embeds it in the bundle', async () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-main.mjs')], {cwd: root, stdio: 'pipe'});
  const manifest = JSON.parse(read('dist-electron', 'native-manifest.json'));
  assert.equal(integrity.isNativeManifest(manifest), true);
  const ps1 = readdirSync(path.join(root, 'native')).filter((f) => f.endsWith('.ps1')).sort();
  assert.deepEqual(Object.keys(manifest.files).sort(), ps1);
  // The runtime verifier accepts the real files with the real manifest...
  const real = (file) => Promise.resolve(readFileSync(file));
  await integrity.verifyFiles(manifest, ps1, (n) => path.join(root, 'native', n), real);
  // ...every script the runner can start is covered, plus the shared module they dot-source...
  for (const s of runner.SCRIPTS) assert.ok(manifest.files[`${s}.ps1`], `${s}.ps1 is in the manifest`);
  for (const s of integrity.SHARED_HELPERS) assert.ok(manifest.files[s]);
  // ...and the bundle carries the same digests, not just the side file.
  const bundle = read('dist-electron', 'main.cjs');
  for (const [name, digest] of Object.entries(manifest.files)) assert.ok(bundle.includes(digest), `bundle embeds ${name}`);
});

// ---------- startup, shortcuts (roadmap 9) ----------

function loginApi(opts = {}) {
  const calls = [];
  let enabled = false;
  return {
    calls,
    getLoginItemSettings: (o) => { calls.push(['get', o]); return {openAtLogin: opts.stuck ? false : enabled}; },
    setLoginItemSettings: (s) => { if (opts.throws) throw new Error('registry denied'); calls.push(['set', s]); enabled = s.openAtLogin; },
  };
}

test('login item: only the packaged Windows app registers, always with --hidden', () => {
  const a = loginApi();
  assert.deepEqual(startup.applyLoginItem(a, {enabled: true, packaged: true, platform: 'win32', execPath: 'C:\\Apps\\DC\\Desktop Companion.exe'}), {ok: true, enabled: true});
  assert.deepEqual(a.calls[0], ['set', {openAtLogin: true, path: 'C:\\Apps\\DC\\Desktop Companion.exe', args: ['--hidden']}]);

  const dev = loginApi();
  const r = startup.applyLoginItem(dev, {enabled: true, packaged: false, platform: 'win32', execPath: 'C:\\electron.exe'});
  assert.equal(r.ok, false);
  assert.equal(dev.calls.length, 0, 'an unpackaged electron.exe is never registered for startup');
  assert.equal(startup.applyLoginItem(loginApi(), {enabled: true, packaged: true, platform: 'linux', execPath: 'x'}).ok, false);
});

test('login item: reports a setting Windows did not apply and registry errors honestly', () => {
  const stuck = startup.applyLoginItem(loginApi({stuck: true}), {enabled: true, packaged: true, platform: 'win32', execPath: 'C:\\a.exe'});
  assert.equal(stuck.ok, false);
  assert.equal(stuck.enabled, false);
  assert.match(stuck.reason, /policy/);
  const err = startup.applyLoginItem(loginApi({throws: true}), {enabled: false, packaged: true, platform: 'win32', execPath: 'C:\\a.exe'});
  assert.equal(err.ok, false);
  assert.match(err.reason, /registry denied/);
});

test('accelerators: modifier + key only; bare keys, Shift-only, unknown modifiers and junk are refused', () => {
  for (const good of ['CommandOrControl+Alt+J', 'Ctrl+Shift+F12', 'Alt+Space', 'Super+1']) assert.equal(startup.validateAccelerator(good).ok, true, good);
  for (const bad of ['J', 'Shift+J', 'Ctrl+', '+J', 'Ctrl+Foo+J', 'Ctrl+Alt+Escape', 'Ctrl+Alt+F25', '', 'Ctrl+Alt+J'.repeat(10), 'Ctrl+Alt+<script>']) assert.equal(startup.validateAccelerator(bad).ok, false, bad);
  assert.equal(startup.validateAccelerator(undefined).ok, false);
});

test('hotkey: first free accelerator wins, a conflict is reported, nothing throws', () => {
  const taken = new Set(['CommandOrControl+Alt+J']);
  const api = {registered: [], register(a, cb) { if (taken.has(a)) return false; this.registered.push([a, cb]); return true; }, unregister() {}, isRegistered: () => false};
  const press = () => {};
  const r = startup.registerHotkey(api, ['CommandOrControl+Alt+J', 'CommandOrControl+Alt+Shift+J'], press);
  assert.equal(r.registered, 'CommandOrControl+Alt+Shift+J');
  assert.match(r.reason, /already in use/);
  assert.equal(api.registered[0][1], press);

  const none = startup.registerHotkey({register: () => false, unregister() {}, isRegistered: () => false}, ['CommandOrControl+Alt+J'], press);
  assert.equal(none.registered, null);
  assert.match(none.reason, /No global shortcut/);
  const thrower = startup.registerHotkey({register: () => { throw new Error('boom'); }, unregister() {}, isRegistered: () => false}, ['Ctrl+Alt+K'], press);
  assert.equal(thrower.registered, null);
  assert.match(thrower.reason, /boom/);
  const free = startup.registerHotkey(api, ['Ctrl+Alt+K'], press);
  assert.equal(free.registered, 'Ctrl+Alt+K');
  assert.equal(free.reason, undefined);
});

test('debounced toggle ignores key auto-repeat inside the window', () => {
  let t = 1000, n = 0;
  const f = startup.debounced(() => { n++; }, 300, () => t);
  f(); t += 50; f(); t += 100; f();
  assert.equal(n, 1);
  t += 300; f();
  assert.equal(n, 2);
});

// ---------- lifecycle ----------

function memFs(init = {}, failWrites = false) {
  const files = new Map(Object.entries(init));
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, d) => { if (failWrites) throw new Error('EROFS: read-only profile'); files.set(p, d); },
    remove: async (p) => { if (failWrites) throw new Error('EROFS'); files.delete(p); },
    exists: async (p) => files.has(p),
  };
}

test('launch guard: tolerates garbage counters and a profile it cannot write; end() never throws', async () => {
  for (const junk of ['abc', '-5', '1e9', '', '2.5', 'NaN']) {
    const fs = memFs({'C:\\d\\.unclean': junk, 'C:\\d\\.running': '1'});
    const r = await new lifecycle.LaunchGuard('C:\\d', fs).begin();
    assert.equal(r.safe, false, `counter ${JSON.stringify(junk)} counts as one unclean start, not safe launch`);
    assert.equal(r.uncleanStarts, 1);
  }
  const ro = new lifecycle.LaunchGuard('C:\\d', memFs({}, true));
  const r = await ro.begin();
  assert.deepEqual(r, {safe: false, uncleanStarts: 0});
  assert.match(ro.trackingError, /read-only/);
  await ro.end();
});

test('launch guard: two unclean starts enter safe launch, a clean exit clears it, the sync end clears markers', async () => {
  const fs = memFs();
  const mk = () => new lifecycle.LaunchGuard('C:\\d', fs);
  assert.equal((await mk().begin()).safe, false);
  assert.equal((await mk().begin()).uncleanStarts, 1);
  const third = mk();
  assert.deepEqual(await third.begin(), {safe: true, uncleanStarts: 2});
  await third.end();
  assert.equal((await mk().begin()).uncleanStarts, 0);

  // endSync works on the real file system in a unique temp folder.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'desktop-companion-test-lifecycle-'));
  try {
    const g = new lifecycle.LaunchGuard(dir);
    await g.begin();
    g.endSync();
    const again = await new lifecycle.LaunchGuard(dir).begin();
    assert.equal(again.uncleanStarts, 0, 'a session-end write counts as a clean exit');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('user-data folder: the legacy folder is adopted only over Electron default, never over a folder chosen earlier', () => {
  const base = {appData: 'C:\\Users\\u\\AppData\\Roaming', appName: 'Desktop Companion'};
  const dflt = 'C:\\Users\\u\\AppData\\Roaming\\Desktop Companion';
  assert.equal(lifecycle.resolveUserDataDir({...base, current: dflt, legacyExists: true}), 'C:\\Users\\u\\AppData\\Roaming\\Jarvis Desktop');
  assert.equal(lifecycle.resolveUserDataDir({...base, current: dflt.toUpperCase(), legacyExists: true}), 'C:\\Users\\u\\AppData\\Roaming\\Jarvis Desktop', 'case-insensitive on Windows');
  assert.equal(lifecycle.resolveUserDataDir({...base, current: dflt, legacyExists: false}), null);
  assert.equal(lifecycle.resolveUserDataDir({...base, current: path.join(os.tmpdir(), 'companion-local-ai-x'), legacyExists: true}), null, 'a test/smoke temp folder is never redirected to real data');
  assert.equal(lifecycle.resolveUserDataDir({...base, current: 'C:\\Users\\u\\AppData\\Roaming\\Jarvis Desktop', legacyExists: true}), null);
  assert.equal(lifecycle.resolveUserDataDir({...base, appName: 'Jarvis Desktop', current: 'C:\\Users\\u\\AppData\\Roaming\\Jarvis Desktop', legacyExists: true}), null);
});

// ---------- idle behaviour ----------

function fakeTimers() {
  const t = {pending: new Map(), next: 1, unref: 0};
  t.set = (fn, ms) => { const id = t.next++; t.pending.set(id, {fn, ms}); return {id, unref() { t.unref++; }}; };
  t.clear = (h) => { t.pending.delete(h.id); };
  t.runAll = () => { for (const [id, p] of [...t.pending]) { t.pending.delete(id); p.fn(); } };
  return t;
}

test('idle governor: one unref\'d timer while hidden, fires once, cancelled on show, no polling', () => {
  const t = fakeTimers();
  const log = [];
  const g = new lifecycle.IdleGovernor({onIdle: () => log.push('idle'), onActive: () => log.push('active'), hiddenMs: 120_000, setTimer: t.set, clearTimer: t.clear});
  g.hidden(); g.hidden(); g.hidden();
  assert.equal(t.pending.size, 1, 'repeated hide events arm one timer');
  assert.equal([...t.pending.values()][0].ms, 120_000);
  assert.equal(t.unref, 1, 'timer never keeps the process alive');
  g.shown();
  assert.equal(t.pending.size, 0);
  assert.deepEqual(log, [], 'shown before the threshold: nothing released, no active callback');
  g.hidden();
  t.runAll();
  assert.deepEqual(log, ['idle']);
  assert.equal(g.isIdle, true);
  g.hidden();
  assert.equal(t.pending.size, 0, 'already idle: no second timer');
  g.shown();
  assert.deepEqual(log, ['idle', 'active']);
  g.hidden();
  g.dispose();
  assert.equal(t.pending.size, 0);
  g.hidden();
  assert.equal(t.pending.size, 0, 'disposed governor stays quiet');
});

test('idle governor: a throwing release callback does not break later cycles', () => {
  const t = fakeTimers();
  let n = 0;
  const g = new lifecycle.IdleGovernor({onIdle: () => { n++; throw new Error('cache busy'); }, setTimer: t.set, clearTimer: t.clear});
  g.hidden(); t.runAll(); g.shown(); g.hidden(); t.runAll();
  assert.equal(n, 2);
});

test('metrics summary: working set in KB to MB, CPU summed, missing fields tolerated', () => {
  assert.deepEqual(lifecycle.summarizeMetrics([]), {processes: 0, workingSetMb: 0, cpuPercent: 0});
  const s = lifecycle.summarizeMetrics([
    {pid: 1, memory: {workingSetSize: 102_400}, cpu: {percentCPUUsage: 0.125}},
    {pid: 2, memory: {workingSetSize: 51_200}, cpu: {percentCPUUsage: 0.2}},
    {pid: 3},
  ]);
  assert.deepEqual(s, {processes: 3, workingSetMb: 150, cpuPercent: 0.33});
});

// ---------- reminders ----------

const task = (id, due, extra = {}) => ({id, title: `Task ${id}`, due, done: false, ...extra});

function harness(tasks, now = Date.parse('2026-10-14T10:00:00'), extra = {}) {
  const st = {now, tasks, sent: [], recorded: [], timers: []};
  const r = new reminders.Reminders({
    tasks: () => st.tasks, now: () => st.now,
    notify: (title, body) => st.sent.push({title, body}),
    record: (s) => { st.recorded.push(s); },
    setTimer: (fn, ms) => { const h = {fn, ms, unref() {}}; st.timers.push(h); return h; },
    clearTimer: () => {},
    ...extra,
  });
  st.r = r;
  return st;
}

test('reminders: a backlog is folded into a summary after MAX_BURST notifications', async () => {
  const now = Date.parse('2026-10-14T10:00:00');
  const due = Array.from({length: 9}, (_, i) => task(`t${i}`, new Date(now - (9 - i) * 30_000).toISOString()));
  const h = harness(due, now);
  assert.equal(await h.r.fire(), 9);
  assert.equal(h.sent.length, reminders.MAX_BURST, 'three single notifications plus one summary');
  assert.deepEqual(h.sent.slice(0, 3).map((s) => s.title), ['Task t0', 'Task t1', 'Task t2'], 'oldest due first');
  assert.equal(h.sent[3].title, '6 more tasks are due');
  assert.match(h.sent[3].body, /Task t3, Task t4, Task t5/);
  assert.equal(await h.r.fire(), 0, 'nothing is announced twice');
  assert.equal(h.sent.length, reminders.MAX_BURST);
});

test('reminders: exactly MAX_BURST due tasks are sent individually', async () => {
  const now = Date.parse('2026-10-14T10:00:00');
  const h = harness(Array.from({length: reminders.MAX_BURST}, (_, i) => task(`t${i}`, new Date(now - 1000).toISOString())), now);
  await h.r.fire();
  assert.equal(h.sent.length, reminders.MAX_BURST);
  assert.ok(h.sent.every((s) => s.body === 'Due now'));
});

test('reminders: notifications off marks tasks announced without showing or recording anything', async () => {
  const now = Date.parse('2026-10-14T10:00:00');
  let on = false;
  const h = harness([task('a', new Date(now - 1000).toISOString())], now, {enabled: () => on});
  assert.equal(await h.r.fire(), 1);
  assert.equal(h.sent.length, 0);
  assert.equal(h.recorded.length, 0);
  on = true;
  assert.equal(await h.r.fire(), 0, 're-enabling does not replay what was skipped');
  assert.equal(h.sent.length, 0);
});

test('reminders: resync after sleep announces what came due while the timer was stalled, then re-aims', async () => {
  const t0 = Date.parse('2026-10-14T10:00:00');
  const h = harness([task('a', new Date(t0 + 30 * 60_000).toISOString()), task('b', new Date(t0 + 4 * 3_600_000).toISOString())], t0);
  h.r.start();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 30 * 60_000);
  // Laptop sleeps 45 minutes; the OS timer never fired.
  h.now = t0 + 45 * 60_000;
  h.r.resync();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.sent.map((s) => s.title), ['Task a']);
  assert.equal(h.timers.at(-1).ms, 4 * 3_600_000 - 45 * 60_000, 'next timer aims at task b');
  h.r.dispose();
  h.r.resync();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sent.length, 1, 'disposed reminders never fire');
});

test('reminders: concurrent resync and timer fire do not announce the same task twice', async () => {
  const now = Date.parse('2026-10-14T10:00:00');
  const h = harness([task('a', new Date(now - 1000).toISOString())], now);
  await Promise.all([h.r.fire(), h.r.fire()]);
  assert.equal(h.sent.length, 1);
});

// ---------- main-process wiring (static) ----------

test('main wiring: integrity configured before the backend, trusted confirm never fed by the renderer, hotkey via the helper', () => {
  const src = read('electron', 'main.ts');
  assert.ok(src.indexOf('configureNativeIntegrity(') < src.indexOf('createBackend({'), 'helpers are verified from the first spawn');
  assert.match(src, /required:\s*app\.isPackaged/);
  assert.match(src, /confirm,\s*\n/, 'trusted confirm injected into the backend');
  assert.match(src, /TEST_MODE\s*\?\s*async \(\) => true\s*:\s*trustedConfirm/);
  assert.match(src, /isTestFixtureDir\(app\.getPath\('userData'\)/);
  assert.match(src, /registerHotkey\(globalShortcut, HOTKEYS/);
  assert.doesNotMatch(src, /globalShortcut\.register\(/, 'registration goes through the helper that reports conflicts');
  assert.doesNotMatch(src, /setLoginItemSettings/, 'the app never registers itself for startup without an explicit setting');
  assert.match(src, /ses\.on\('will-download'/);
  assert.match(src, /web-contents-created/);
  assert.match(src, /powerMonitor\.on\('resume'/);
  assert.match(src, /session-end/);
});

test('smoke scripts: always use an isolated fixture folder in the temp directory with test mode, and clean up', () => {
  const ai = read('scripts', 'local-ai-smoke.cjs');
  const smoke = read('scripts', 'smoke.cjs');
  assert.match(ai, /desktop-companion-test-/);
  assert.match(ai, /JARVIS_TEST_MODE='1'/);
  assert.match(smoke, /jarvis-smoke-/);
  assert.match(smoke, /JARVIS_TEST_MODE='1'/);
  for (const s of [ai, smoke]) {
    assert.match(s, /rmSync\(data/, 'fixture folder removed afterwards');
    assert.doesNotMatch(s, /SendInput|type-text|\bclick\b|executeAction|previewAction/, 'no desktop input from smoke tests');
  }
  assert.match(smoke, /getLastWebPreferences/);
  assert.match(smoke, /native-manifest\.json/);
});
