// Main-process plumbing tests: IPC trust/dispatch, trusted confirmation, request allow-list, native runner, lifecycle, speech, reminders.
// Bundles the real TypeScript in memory. Electron, PowerShell and the desktop are never touched: everything external is a mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backend-native-entry.ts',
    loader: 'ts',
    contents: `
      export * as ipcCore from './electron/ipcCore.ts';
      export * as channels from './electron/channels.ts';
      export * as runner from './electron/native/runner.ts';
      export * as lifecycle from './electron/services/lifecycle.ts';
      export * as speech from './electron/services/speech.ts';
      export * as reminders from './electron/services/reminders.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {ipcCore, channels, runner, lifecycle, speech, reminders} = mod;

const APP = 'file:///C:/Program%20Files/Desktop%20Companion/resources/app.asar/dist/index.html';
const DIST = 'C:\\Program Files\\Desktop Companion\\resources\\app.asar\\dist';

// ---------- IPC trust (NSR-10 / NSR-11) ----------

test('isTrustedUrl: exact app file with empty host only; UNC-style hosts and other files rejected', () => {
  assert.equal(ipcCore.isTrustedUrl(APP, APP), true);
  assert.equal(ipcCore.isTrustedUrl(APP + '#/notes', APP), true);
  assert.equal(ipcCore.isTrustedUrl('file://evil-host/C:/Program%20Files/Desktop%20Companion/resources/app.asar/dist/index.html', APP), false);
  assert.equal(ipcCore.isTrustedUrl('file:///C:/Program%20Files/Desktop%20Companion/resources/app.asar/dist/other.html', APP), false);
  assert.equal(ipcCore.isTrustedUrl('https://example.com/', APP), false);
  assert.equal(ipcCore.isTrustedUrl(undefined, APP), false);
  assert.equal(ipcCore.isTrustedUrl('not a url', APP), false);
  assert.equal(ipcCore.isTrustedUrl('http://localhost:5173/', APP), false, 'dev origin is off unless configured');
  assert.equal(ipcCore.isTrustedUrl('http://localhost:5173/x', APP, 'http://localhost:5173'), true);
  assert.equal(ipcCore.isTrustedUrl('http://localhost:5174/', APP, 'http://localhost:5173'), false);
});

test('parseDevOrigin accepts only plain http loopback origins', () => {
  assert.equal(ipcCore.parseDevOrigin('http://localhost:5173/'), 'http://localhost:5173');
  assert.equal(ipcCore.parseDevOrigin('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(ipcCore.parseDevOrigin('http://[::1]:5173'), 'http://[::1]:5173');
  for (const bad of ['http://evil.example:5173', 'https://localhost:5173', 'http://127.0.0.1.evil.com:5173', 'http://user:pw@localhost:5173', 'http://192.168.1.4:5173', 'ftp://localhost', '', undefined, 'nonsense']) {
    assert.equal(ipcCore.parseDevOrigin(bad), null, String(bad));
  }
});

test('request allow-list: dist files, dev loopback and non-network schemes only', () => {
  const ok = (u, dev) => ipcCore.isAllowedRequestUrl(u, DIST, dev);
  assert.equal(ok(APP), true);
  assert.equal(ok('file:///C:/Program%20Files/Desktop%20Companion/resources/app.asar/dist/assets/index-abc.js'), true);
  assert.equal(ok('file:///C:/Users/me/Documents/secret.html'), false);
  assert.equal(ok('file:///C:/Program%20Files/Desktop%20Companion/resources/app.asar/dist/../../secret'), false);
  assert.equal(ok('file://attacker/share/index.html'), false, 'SMB egress');
  assert.equal(ok('https://example.com/x'), false);
  assert.equal(ok('http://localhost:5173/'), false, 'no dev server unless configured');
  assert.equal(ok('http://localhost:5173/@vite/client', 'http://localhost:5173'), true);
  assert.equal(ok('ws://localhost:5173/', 'http://localhost:5173'), true);
  assert.equal(ok('http://localhost:9999/', 'http://localhost:5173'), false);
  assert.equal(ok('http://evil.example:5173/', 'http://localhost:5173'), false);
  assert.equal(ok('http://localhost:5173/', 'http://evil.example:5173'), false, 'non-loopback dev origin is never honoured');
  assert.equal(ok('data:text/html,hi'), true);
  assert.equal(ok('blob:null/1'), true);
  assert.equal(ok('ftp://x/y'), false);
  assert.equal(ok('garbage'), false);
});

test('test mode is limited to temp fixture directories', () => {
  const tmp = os.tmpdir();
  assert.equal(ipcCore.isTestFixtureDir(path.join(tmp, 'jarvis-smoke-abc123'), tmp), true);
  assert.equal(ipcCore.isTestFixtureDir(path.join(tmp, 'desktop-companion-test-1'), tmp), true);
  assert.equal(ipcCore.isTestFixtureDir(path.join(tmp, 'jarvis-smoke-'), tmp), false, 'prefix alone is not a fixture');
  assert.equal(ipcCore.isTestFixtureDir(path.join(tmp, 'other'), tmp), false);
  assert.equal(ipcCore.isTestFixtureDir(path.join(tmp, 'jarvis-test-1', 'nested'), tmp), false, 'must be a direct child');
  assert.equal(ipcCore.isTestFixtureDir(tmp, tmp), false);
  assert.equal(ipcCore.isTestFixtureDir('C:\\Users\\someone\\AppData\\Roaming\\Jarvis Desktop', tmp), false);
  assert.equal(ipcCore.isTestFixtureDir(path.join(tmp, 'jarvis-smoke-x', '..', 'real'), tmp), false);
});

// ---------- trusted confirmation ----------

function fakeWin(over = {}) {
  return {isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true, ...over};
}

test('trusted confirm: Cancel is the default, full detail shown, only the Continue button approves', async () => {
  const win = fakeWin();
  let seen;
  const mk = (response) => ipcCore.createTrustedConfirm({getWindow: () => win, isTrusted: () => true, showMessageBox: async (w, o) => { seen = {w, o}; return {response}; }});
  assert.equal(await mk(1)('Run it?', 'full detail: C:\\Windows\\notepad.exe'), true);
  assert.equal(seen.w, win);
  assert.equal(seen.o.defaultId, 0);
  assert.equal(seen.o.cancelId, 0);
  assert.equal(seen.o.buttons[0], 'Cancel');
  assert.equal(seen.o.detail, 'full detail: C:\\Windows\\notepad.exe');
  assert.equal(seen.o.title, 'Desktop Companion');
  assert.equal(await mk(0)('x', 'y'), false);
  assert.equal(await mk(5)('x', 'y'), false);
  assert.equal(await mk(-1)('x', 'y'), false);
});

test('trusted confirm fails closed: no/hidden/minimized/unfocused/untrusted/destroyed window, dialog error, non-string input', async () => {
  const shown = [];
  const mk = (win, trusted = true, show) => ipcCore.createTrustedConfirm({getWindow: () => win, isTrusted: () => trusted, showMessageBox: show ?? (async () => { shown.push(1); return {response: 1}; })});
  assert.equal(await mk(null)('a', 'b'), false);
  for (const over of [{isVisible: () => false}, {isMinimized: () => true}, {isFocused: () => false}, {isDestroyed: () => true}]) {
    assert.equal(await mk(fakeWin(over))('a', 'b'), false);
  }
  assert.equal(await mk(fakeWin(), false)('a', 'b'), false);
  assert.equal(await mk(fakeWin(), true, async () => { throw new Error('dialog failed'); })('a', 'b'), false);
  assert.equal(await mk(fakeWin())(undefined, 'b'), false);
  assert.equal(await mk(fakeWin())('a', {}), false);
  assert.equal(shown.length, 0, 'the dialog is never opened for a rejected request');
});

test('trusted confirm allows one dialog at a time', async () => {
  let release; let opened = 0;
  const confirm = ipcCore.createTrustedConfirm({getWindow: () => fakeWin(), isTrusted: () => true, showMessageBox: () => { opened++; return new Promise((r) => { release = () => r({response: 1}); }); }});
  const first = confirm('a', 'b');
  assert.equal(await confirm('c', 'd'), false);
  assert.equal(opened, 1);
  release();
  assert.equal(await first, true);
  const again = confirm('e', 'f'); release();
  assert.equal(await again, true);
});

// ---------- dispatch / channels / preload ----------

test('dispatch rejects untrusted senders, subframes, unknown methods, extra arguments; redacts profile paths', async () => {
  const calls = [];
  const handlers = Object.fromEntries(channels.METHODS.map((m) => [m, async (...a) => { calls.push([m, a]); return 'ok'; }]));
  const opts = {appFileUrl: APP};
  assert.equal(await ipcCore.dispatch(handlers, 'getState', [], APP, opts), 'ok');
  await assert.rejects(ipcCore.dispatch(handlers, 'getState', [], 'https://evil.example/', opts), /untrusted sender/);
  await assert.rejects(ipcCore.dispatch(handlers, 'getState', [], undefined, opts), /untrusted sender/);
  await assert.rejects(ipcCore.dispatch(handlers, 'getState', [], APP, opts, false), /untrusted sender/);
  await assert.rejects(ipcCore.dispatch(handlers, 'constructor', [], APP, opts), /Unknown method/);
  await assert.rejects(ipcCore.dispatch(handlers, 'getState', ['x'], APP, opts), /Wrong number/);
  await assert.rejects(ipcCore.dispatch(handlers, 'executeAction', 'x', APP, opts), /Wrong number/);
  assert.equal(calls.length, 1);
  handlers.chat = async () => { throw new Error('failed at C:\\Users\\alice\\Documents\\secret.txt'); };
  await assert.rejects(ipcCore.dispatch(handlers, 'chat', ['hi'], APP, opts), (e) => /%USERPROFILE%/.test(e.message) && !/alice/.test(e.message));
});

test('channel table is complete and the preload exposes exactly those methods', () => {
  assert.deepEqual(Object.keys(channels.ARITY).sort(), [...channels.METHODS].sort());
  const src = readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
  for (const m of channels.METHODS) assert.match(src, new RegExp(`\\b${m}:\\s*\\(`), `preload exposes ${m}`);
  assert.match(src, /exposeInMainWorld\('jarvis'/);
  assert.doesNotMatch(src, /require\(|from 'node:/, 'no Node APIs in the preload');
  // ipcRenderer is used only through invoke/on/removeListener inside closures; the raw object is never placed on the bridge.
  assert.doesNotMatch(src, /ipcRenderer\.send(Sync)?\(|:\s*ipcRenderer\b/);
});

test('main process keeps window isolation and uses the trusted confirm, never a renderer value', () => {
  const src = readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
  for (const re of [/contextIsolation:\s*true/, /sandbox:\s*true/, /nodeIntegration:\s*false/, /webSecurity:\s*true/, /setWindowOpenHandler/, /setSpellCheckerEnabled\(false\)/, /createTrustedConfirm/, /isAllowedRequestUrl/, /parseDevOrigin/, /isTestFixtureDir/]) assert.match(src, re);
  assert.match(src, /TEST_MODE\s*\?\s*async \(\) => true\s*:\s*trustedConfirm/, 'auto-approve exists only for the validated fixture sandbox');
  assert.doesNotMatch(src, /process\.env\.VITE_DEV_SERVER_URL\)\.origin/);
});

// ---------- native runner ----------

const tick = async () => { for (let i = 0; i < 3; i++) await new Promise((res) => setImmediate(res)); };

function fakeExec(behaviour = {}) {
  const spawned = [];
  const exec = (file, args, opts, cb) => {
    const child = {killed: false, stdinData: null, kill() { this.killed = true; behaviour.onKill?.(cb); return true; }, stdin: {on() {}, end(d) { child.stdinData = d; setImmediate(() => behaviour.respond?.(cb, child)); }}};
    spawned.push({file, args, opts, child});
    return child;
  };
  return {exec, spawned};
}

test('runner: fixed argv, user data only on stdin, packaged asar path mapped to unpacked, no shell', async () => {
  const f = fakeExec({respond: (cb) => cb(null, '{"ok":true,"n":1}\r\n', '')});
  const r = new runner.NativeRunner({nativeDir: 'C:\\App\\resources\\app.asar\\native', powershellPath: 'C:\\ps.exe', execFileImpl: f.exec});
  const secret = 'sk-secret"; Start-Process calc; $(evil)';
  assert.deepEqual(await r.run('dpapi', {op: 'protect', data: secret}), {ok: true, n: 1});
  const s = f.spawned[0];
  assert.equal(s.file, 'C:\\ps.exe');
  assert.deepEqual(s.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\App\\resources\\app.asar.unpacked\\native\\dpapi.ps1']);
  assert.ok(!s.args.join(' ').includes('sk-secret'));
  assert.equal(s.opts.shell, false);
  assert.equal(s.opts.windowsHide, true);
  assert.equal(JSON.parse(s.child.stdinData).data, secret);
});

test('runner: unknown script, oversized input, bad output, timeout, exit and missing PowerShell are typed errors', async () => {
  const mk = (respond) => new runner.NativeRunner({nativeDir: 'C:\\n', powershellPath: 'C:\\ps.exe', execFileImpl: fakeExec({respond}).exec});
  await assert.rejects(mk(() => {}).run('format-disk', {}), /Unknown native script/);
  await assert.rejects(mk(() => {}).run('speak', {text: 'x'.repeat(300 * 1024)}), /too large/);
  await assert.rejects(mk((cb) => cb(null, 'not json', '')).run('list-windows', {}), (e) => e.kind === 'bad-output');
  await assert.rejects(mk((cb) => cb(null, '', '')).run('list-windows', {}), (e) => e.kind === 'bad-output');
  await assert.rejects(mk((cb) => cb(Object.assign(new Error('t'), {killed: true}), '', '')).run('list-windows', {}), (e) => e.kind === 'timeout');
  await assert.rejects(mk((cb) => cb(Object.assign(new Error('x'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}), '', '')).run('list-windows', {}), (e) => e.kind === 'output-too-large');
  await assert.rejects(mk((cb) => cb(Object.assign(new Error('x'), {code: 'ENOENT'}), '', '')).run('list-windows', {}), (e) => e.kind === 'unavailable');
  await assert.rejects(mk((cb) => cb(Object.assign(new Error('x'), {code: 1}), '', 'boom line\nsecond')).run('list-windows', {}), /exit 1\): boom line$/);
});

test('runner: stderr is never surfaced for helpers that receive secrets or typed text', async () => {
  const mk = () => new runner.NativeRunner({nativeDir: 'C:\\n', powershellPath: 'C:\\ps.exe', execFileImpl: fakeExec({respond: (cb) => cb(Object.assign(new Error('x'), {code: 1}), '', "Cannot convert value 'sk-live-123'")}).exec});
  for (const name of ['dpapi', 'type-text', 'speak']) {
    await assert.rejects(mk().run(name, {}), (e) => /exit 1/.test(e.message) && !/sk-live/.test(e.message), name);
  }
});

test('runner: cancellation before start and while queued never spawns; abort kills a running helper; concurrency is capped', async () => {
  const held = [];
  const f = fakeExec({respond: (cb) => held.push(() => cb(null, '{"ok":true}', ''))});
  const r = new runner.NativeRunner({nativeDir: 'C:\\n', powershellPath: 'C:\\ps.exe', execFileImpl: f.exec, concurrency: 1});
  const pre = new AbortController(); pre.abort();
  await assert.rejects(r.run('speak', {}, {signal: pre.signal}), (e) => e.kind === 'cancelled');
  assert.equal(f.spawned.length, 0);
  const first = r.run('list-windows', {});
  await tick();
  const queuedAc = new AbortController();
  const queued = r.run('list-windows', {}, {signal: queuedAc.signal});
  const third = r.run('list-windows', {});
  await tick();
  assert.equal(f.spawned.length, 1, 'second helper waits for a free slot');
  queuedAc.abort();
  held.shift()();
  await first;
  await assert.rejects(queued, (e) => e.kind === 'cancelled');
  await tick();
  assert.equal(f.spawned.length, 2, 'the cancelled queued helper never started');
  held.shift()();
  await third;
  const ac = new AbortController();
  const running = r.run('speak', {}, {signal: ac.signal});
  await tick();
  const child = f.spawned[2].child;
  ac.abort();
  assert.equal(child.killed, true);
  held.shift()();
  await assert.rejects(running, (e) => e.kind === 'cancelled');
});

test('native scripts: stdin-only input, no command-line data, no SendKeys, Windows PowerShell 5.1 safe', () => {
  const dir = path.join(root, 'native');
  for (const name of runner.SCRIPTS) {
    const text = readFileSync(path.join(dir, `${name}.ps1`), 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(text, /\$args\b|\[Environment\]::GetCommandLineArgs|SendKeys|Invoke-Expression|\biex\b/i, name);
    assert.doesNotMatch(text, /\?\?|\?\.|&&|\|\|/, `${name}: no PowerShell 7-only operators`);
    assert.match(text, /common\.ps1/, name);
  }
  const common = readFileSync(path.join(dir, 'common.ps1'), 'utf8');
  assert.match(common, /OpenStandardInput/);
  // The embedded C# here-string legitimately uses && and ||; only the PowerShell around it is checked.
  assert.doesNotMatch(common.replace(/@'[\s\S]*?\n'@/, ''), /\?\?|\?\.|&&|\|\|/);
});

// ---------- lifecycle ----------

function memLaunchFs() {
  const files = new Map();
  return {files, read: async (p) => files.get(p) ?? null, write: async (p, d) => { files.set(p, d); }, remove: async (p) => { files.delete(p); }, exists: async (p) => files.has(p)};
}

test('launch guard: two unclean starts enter safe launch; clean quit resets', async () => {
  const fs = memLaunchFs();
  const start = async () => { const g = new lifecycle.LaunchGuard('C:\\data', fs); return {g, r: await g.begin()}; };
  let s = await start();
  assert.deepEqual(s.r, {safe: false, uncleanStarts: 0});
  s = await start();
  assert.deepEqual(s.r, {safe: false, uncleanStarts: 1});
  s = await start();
  assert.equal(s.r.safe, true);
  assert.equal(s.g.safe, true);
  await s.g.end();
  assert.equal(fs.files.has('C:\\data\\.running'), false);
  s = await start();
  assert.deepEqual(s.r, {safe: false, uncleanStarts: 0});
  await s.g.end();
  s = await start();
  assert.equal(s.r.uncleanStarts, 0);
});

// ---------- speech ----------

function speechFixture(over = {}) {
  const calls = {speak: [], transcribe: [], written: [], removed: []};
  const native = {
    probeSpeech: async () => ({voices: ['Voice A'], recognizers: ['en-US']}),
    speak: async (text, voice, signal) => { calls.speak.push({text, voice, signal}); if (over.speak) return over.speak(text, voice, signal); return {ok: true}; },
    transcribe: async (p) => { calls.transcribe.push(p); if (over.transcribe) return over.transcribe(p); return {text: 'hello'}; },
    ...(over.native ?? {}),
  };
  let n = 0;
  const s = new speech.Speech({native, settings: () => ({voice: 'Voice A'}), tmpDir: 'C:\\T', newId: () => `0a${++n}`, writeFile: async (p, d) => { calls.written.push([p, d.length]); }, removeFile: async (p) => { calls.removed.push(p); }, now: over.now});
  return {s, calls};
}
const wav = () => [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20, 16, 0, 0, 0, 1, 0, ...new Array(22).fill(0)];

test('speak validates before any native call and passes text as a value', async () => {
  const {s, calls} = speechFixture();
  await assert.rejects(s.speak(''), /text is required/);
  await assert.rejects(s.speak(42), /text is required/);
  await assert.rejects(s.speak('x'.repeat(100000)), /too long/);
  assert.equal(calls.speak.length, 0);
  assert.deepEqual(await s.speak('hello "world" $(x)'), {ok: true});
  assert.equal(calls.speak[0].text, 'hello "world" $(x)');
  assert.equal(calls.speak[0].voice, 'Voice A');
});

test('a newer speak aborts the previous one, reporting it as superseded', async () => {
  const {NativeError} = runner;
  const {s, calls} = speechFixture({speak: (text, voice, signal) => text === 'first' ? new Promise((_, rej) => signal.addEventListener('abort', () => rej(new NativeError('cancelled', 'cancelled')))) : {ok: true}});
  const first = s.speak('first');
  await new Promise((r) => setImmediate(r));
  const second = await s.speak('second');
  assert.equal(calls.speak[0].signal.aborted, true);
  assert.deepEqual(await first, {ok: false, reason: 'Superseded by newer speech'});
  assert.deepEqual(second, {ok: true});
});

test('transcribe writes jarvis-<id>.wav in tmpDir, passes the path, and deletes it even when the helper throws', async () => {
  const ok = speechFixture();
  assert.deepEqual(await ok.s.transcribe(wav()), {text: 'hello'});
  assert.match(ok.calls.transcribe[0], /^C:\\T\\jarvis-[0-9a-f-]+\.wav$/);
  assert.deepEqual(ok.calls.removed, ok.calls.transcribe);
  const bad = speechFixture({transcribe: () => { throw new Error('helper crashed'); }});
  assert.deepEqual(await bad.s.transcribe(wav()), {text: '', reason: 'helper crashed'});
  assert.equal(bad.calls.removed.length, 1);
});

test('transcribe without a recognizer or with probe failure writes no file', async () => {
  const none = speechFixture({native: {probeSpeech: async () => ({voices: [], recognizers: []})}});
  assert.deepEqual(await none.s.transcribe(wav()), {text: '', reason: 'No Windows speech recognizer is installed'});
  assert.equal(none.calls.written.length, 0);
  const down = speechFixture({native: {probeSpeech: async () => { throw new Error('no powershell'); }}});
  const r = await down.s.transcribe(wav());
  assert.equal(r.text, ''); assert.match(r.reason, /no powershell/);
  assert.equal(down.calls.written.length, 0);
  await assert.rejects(down.s.transcribe('not audio'), /audio/);
});

test('speech capabilities are honest: missing voices/recognizers/helper are reported unavailable with a reason', async () => {
  const caps = await speechFixture({native: {probeSpeech: async () => ({voices: [], recognizers: ['en-US']})}}).s.capabilities();
  assert.equal(caps.find((c) => c.id === 'tts').available, false);
  assert.match(caps.find((c) => c.id === 'tts').reason, /No Windows voices/);
  assert.equal(caps.find((c) => c.id === 'stt').available, true);
  const down = await speechFixture({native: {probeSpeech: async () => { throw new Error('x'); }}}).s.capabilities();
  assert.ok(down.every((c) => !c.available && c.reason));
});

// ---------- reminders (mocked notifier and timer) ----------

function remFixture(tasks, startNow = Date.parse('2026-10-14T10:00:00Z')) {
  const st = {now: startNow, tasks, notes: [], records: [], timers: [], cleared: []};
  const rem = new reminders.Reminders({
    tasks: () => st.tasks,
    now: () => st.now,
    notify: (title, body, task) => { if (st.failNotify) throw new Error('no notifier'); st.notes.push({title, body, id: task.id}); },
    record: (s) => { st.records.push(s); },
    setTimer: (fn, ms) => { const h = {fn, ms, unrefd: false, unref() { this.unrefd = true; }}; st.timers.push(h); return h; },
    clearTimer: (h) => st.cleared.push(h),
  });
  return {st, rem};
}
const task = (id, due, extra = {}) => ({id, title: `Task ${id}`, done: false, due, ...extra});
const iso = (ms) => new Date(ms).toISOString();

test('dueAt: date-only means 09:00 local, invalid or empty is null', () => {
  assert.equal(reminders.dueAt({due: '2026-10-14'}), new Date(2026, 9, 14, 9, 0, 0, 0).getTime());
  assert.equal(reminders.dueAt({due: '2026-10-14T08:30:00Z'}), Date.parse('2026-10-14T08:30:00Z'));
  for (const due of [undefined, '', '   ', 'soon', '2026-13-45x']) assert.equal(reminders.dueAt({due}), null, String(due));
});

test('reminders: announces a due task once, with one unref\'d timer aimed at the next due time', async () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const {st, rem} = remFixture([task('a', iso(now + 60_000)), task('b', iso(now + 3_600_000)), task('done', iso(now + 30_000), {done: true}), task('none', undefined)], now);
  rem.start();
  assert.equal(st.notes.length, 0);
  assert.equal(st.timers.length, 1);
  assert.equal(st.timers[0].ms, 60_000);
  assert.equal(st.timers[0].unrefd, true);
  st.now += 60_000;
  assert.equal(await rem.fire(), 1);
  assert.deepEqual(st.notes, [{title: 'Task a', body: 'Due now', id: 'a'}]);
  assert.deepEqual(st.records, ['Reminder: Task a']);
  assert.equal(st.timers.at(-1).ms, 3_600_000 - 60_000, 'next timer targets task b');
  st.now += 5_000;
  assert.equal(await rem.fire(), 0, 'a is not announced twice');
  assert.equal(st.notes.length, 1);
});

test('reminders: recently overdue tasks announce once at start; old ones stay silent', async () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const {st, rem} = remFixture([task('recent', iso(now - 5 * 60_000)), task('stale', iso(now - 3 * 3_600_000))], now);
  rem.start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(st.notes.map((n) => n.id), ['recent']);
});

test('reminders: rearm after an edit never announces; moving a due date makes the new time fire', async () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const {st, rem} = remFixture([task('a', iso(now + 60_000))], now);
  rem.start();
  st.tasks = [task('a', iso(now - 1_000))];
  rem.rearm();
  assert.equal(st.notes.length, 0, 'moved into the past: silent');
  assert.ok(st.cleared.length >= 1, 'previous timer cleared');
  st.tasks = [task('a', iso(now + 120_000))];
  rem.rearm();
  assert.equal(st.timers.at(-1).ms, 120_000);
  st.now += 120_000;
  await rem.fire();
  assert.deepEqual(st.notes.map((n) => n.id), ['a']);
  st.tasks = [task('a', iso(st.now + 60_000))];
  rem.rearm();
  st.now += 60_000;
  await rem.fire();
  assert.equal(st.notes.length, 2, 'a changed due value is a new reminder');
});

test('reminders: failing notifier does not stop later reminders; delays are capped; dispose stops everything', async () => {
  const now = Date.parse('2026-10-14T10:00:00Z');
  const a = remFixture([task('x', iso(now + 1_000)), task('y', iso(now + 1_000))], now);
  a.st.failNotify = true;
  a.rem.start(); a.st.now += 1_000;
  assert.equal(await a.rem.fire(), 2);
  const far = remFixture([task('far', iso(now + 400 * 86_400_000))], now);
  far.rem.start();
  assert.equal(far.st.timers[0].ms, reminders.MAX_TIMER_MS);
  assert.equal(far.rem.armed, true);
  far.rem.dispose();
  assert.equal(far.rem.armed, false);
  far.st.now += 400 * 86_400_000;
  assert.equal(await far.rem.fire(), 0);
  far.rem.rearm();
  far.rem.start();
  assert.equal(far.st.timers.length, 1, 'a disposed scheduler arms nothing');
  assert.equal(far.st.notes.length, 0);
});
