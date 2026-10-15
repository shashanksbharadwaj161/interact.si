// Security module tests (NSR regression suite): paths, policy, validation, netGuard, secrets, system, actions.
// Every external dependency is injected: no real desktop input, no network, no private key reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, rm, readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'autopilot-security-entry.ts',
    loader: 'ts',
    contents: `
      export * as paths from './electron/services/paths.ts';
      export * as policy from './electron/services/policy.ts';
      export * as validation from './electron/services/validation.ts';
      export * as netGuard from './electron/services/netGuard.ts';
      export * as secrets from './electron/services/secrets.ts';
      export * as system from './electron/services/system.ts';
      export * as actions from './electron/services/actions.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {paths, policy, validation, netGuard, secrets, system, actions} = mod;

const ch = (...codes) => String.fromCharCode(...codes);
const RLO = ch(0x202e), ZWSP = ch(0x200b), LSEP = ch(0x2028), NEL = ch(0x85);
const RET = ch(0x23ce), TAB = ch(0x21e5);

// ---------- paths (NSR-03, NSR-04, NSR-05) ----------

function throwingFs() {
  const calls = [];
  const boom = async (p) => { calls.push(p); throw new Error('filesystem must not be touched'); };
  return {calls, realpath: boom, stat: boom};
}

test('hostile path forms are rejected lexically with zero filesystem calls', async () => {
  const fs = throwingFs();
  const hostile = [
    '//./pipe/demo', '\\\\.\\pipe\\demo', '\\/.\\x', '/\\?\\C:\\x', '//?/C:/x', '//server/share/x.txt', '\\\\host@SSL\\DavWWWRoot\\x.exe',
    'C:\\Docs\\..\\Windows\\x.txt', 'C:\\Docs\\a.txt:stream', 'C:\\Docs\\CON', 'C:\\Docs\\nul.txt', 'C:Docs\\a.txt', 'Docs\\a.txt',
    'C:\\Docs\\a.txt ', ' C:\\Docs\\a.txt', 'C:\\Docs\\a.txt.', `C:\\Docs\\report${RLO}fdp.exe`, `C:\\Docs\\a${ZWSP}.txt`,
  ];
  for (const h of hostile) {
    const r = await paths.resolveInsideRoots(h, ['C:\\Docs'], fs);
    assert.equal(r.ok, false, JSON.stringify(h));
  }
  assert.deepEqual(fs.calls, []);
});

test('lexical containment runs before any filesystem call', async () => {
  const fs = throwingFs();
  const r = await paths.resolveInsideRoots('C:\\Other\\a.txt', ['C:\\Docs'], fs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /outside/);
  assert.deepEqual(fs.calls, []);
});

test('only allowlisted document types open as files; code-running types are refused', async () => {
  const tree = (p) => ({
    realpath: async (x) => x,
    stat: async () => ({isDirectory: () => false, isFile: () => true}),
  });
  const refused = ['a.chm', 'a.iso', 'a.img', 'a.vhd', 'a.vhdx', 'a.settingcontent-ms', 'a.msix', 'a.appx', 'a.appinstaller', 'a.library-ms',
    'a.search-ms', 'a.scf', 'a.theme', 'a.themepack', 'a.wsc', 'a.sct', 'a.xll', 'a.inf', 'a.diagcab', 'a.cab', 'a.website', 'a.ps1xml',
    'a.psd1', 'a.mht', 'a.xbap', 'a.ocx', 'a.sys', 'a.mde', 'a.exe', 'a.bat', 'a.lnk', 'a.url', 'a.js', 'a.hta', 'a.docm', 'noextension'];
  for (const f of refused) {
    const r = await paths.resolveInsideRoots(`C:\\Docs\\${f}`, ['C:\\Docs'], tree());
    assert.equal(r.ok, false, f);
  }
  for (const f of ['a.txt', 'a.PDF', 'b.docx', 'c.png', 'd.mp3', 'e.zip']) {
    assert.equal((await paths.resolveInsideRoots(`C:\\Docs\\${f}`, ['C:\\Docs'], tree())).ok, true, f);
  }
});

test('a path that resolves to a network location is refused after resolution', async () => {
  const fs = {realpath: async () => '\\\\attacker.example\\share\\a.txt', stat: async () => ({isDirectory: () => false, isFile: () => true})};
  const r = await paths.resolveInsideRoots('C:\\Docs\\link.txt', ['C:\\Docs'], fs);
  assert.equal(r.ok, false);
  assert.match(r.reason, /network|device/);
});

test('bare executable names are strict', () => {
  for (const ok of ['notepad.exe', 'Code.exe', 'my tool-2.exe']) assert.equal(paths.isBareExeName(ok), true, ok);
  for (const bad of ['..exe', '.exe', 'a..b.exe', 'a .exe', 'a..exe', 'con.exe', 'nul.exe', 'x.exe.exe ', 'C:\\x.exe', 'dir/x.exe', 'x.bat', '-x.exe']) {
    assert.equal(paths.isBareExeName(bad), false, bad);
  }
  assert.throws(() => validation.validateApprovedApp('con.exe'), /approved app/);
  assert.throws(() => validation.validateApprovedApp('..exe'), /approved app/);
  assert.equal(validation.validateApprovedApp('notepad.exe'), 'notepad.exe');
  assert.throws(() => validation.validateApprovedApp('\\\\server\\share\\tool.exe'), /Network/);
});

test('visibleText makes hidden and direction-changing characters visible', () => {
  const shown = paths.visibleText(`a${RLO}b${ZWSP}c`);
  assert.equal(shown, 'a[U+202E]b[U+200B]c');
  assert.equal(paths.visibleText('plain text\nline2\t'), 'plain text\nline2\t');
  assert.equal(paths.visibleText(ch(0x07)), '[U+0007]');
});

// ---------- policy (NSR-06, NSR-07) ----------

const win = (over = {}) => ({hwnd: 10, pid: 500, process: 'notepad.exe', title: 'Untitled - Notepad', x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, foreground: true, elevated: 0, ...over});

test('mailto keeps only safe parameters; attachments, repeated and invisible content are rejected', () => {
  assert.equal(policy.validateOpenUrl('mailto:a@example.com?subject=Hi&body=Yo').ok, true);
  for (const bad of ['mailto:a@example.com?attach=C:\\Users\\u\\secret.docx', 'mailto:a@example.com?attachment=x', 'mailto:a@example.com?subject=1&subject=2',
    'mailto:?subject=x', `mailto:a@example.com?subject=a${ZWSP}b`, 'javascript:alert(1)', 'file:///C:/x', 'http://u:p@example.com/', 'https://exa' + ZWSP + 'mple.com/']) {
    assert.equal(policy.validateOpenUrl(bad).ok, false, bad);
  }
  const rebuilt = policy.validateOpenUrl('mailto:a@example.com?subject=Hello%20there');
  assert.ok(rebuilt.url.startsWith('mailto:a@example.com?subject='));
});

test('line breaks into terminals, Explorer and Start search are refused, including Unicode separators', () => {
  const procs = ['cmd.exe', 'powershell.exe', 'powershell_ise.exe', 'pwsh.exe', 'WindowsTerminal.exe', 'conhost.exe', 'wsl.exe', 'mintty.exe', 'alacritty.exe',
    'python.exe', 'explorer.exe', 'SearchHost.exe', 'StartMenuExperienceHost.exe', 'cmd'];
  for (const proc of procs) {
    for (const text of ['calc\n', 'calc\r', `calc${LSEP}`, `calc${NEL}`]) {
      assert.match(policy.checkWindowPolicy(win({process: proc}), 'type-text', [], text) ?? '', /line break/, `${proc} ${text.length}`);
    }
  }
  assert.equal(policy.checkWindowPolicy(win({process: 'cmd.exe'}), 'type-text', [], 'no break'), null);
  assert.equal(policy.checkWindowPolicy(win(), 'type-text', [], 'line1\nline2'), null);
});

test('typed text preview marks line breaks, tabs and hidden characters', () => {
  assert.equal(policy.describeTypedText(`a\nb\tc${RLO}`), `a${RET}b${TAB}c[U+202E]`);
  assert.equal(policy.describeTypedText(`x${LSEP}y`), `x${RET}y`);
  assert.equal(policy.describeTypedText('x'.repeat(300)).length, 200);
});

test('window selection: exact handle, ambiguity refused, oversized handle refused', () => {
  const ws = [win({hwnd: 1, title: 'Notes A'}), win({hwnd: 2, title: 'Notes B'})];
  assert.equal(policy.selectWindow('hwnd:2', ws, false).window.hwnd, 2);
  assert.match(policy.selectWindow('Notes', ws, false).reason, /2 windows match/);
  assert.equal(policy.selectWindow('hwnd:9999999999999999999', ws, false).ok, false);
  assert.equal(policy.selectWindow('', ws, false).ok, false);
});

test('authorizeTarget: scripts, shell verbs, URLs and arguments are never launchable', async () => {
  const fs = throwingFs();
  const s = {allowedRoots: ['C:\\Docs'], approvedApps: ['notepad.exe']};
  for (const t of ['javascript:alert(1)', 'cmd /c calc', 'notepad.exe C:\\x', 'shell:startup', 'ms-settings:', 'https://example.com/', '\\\\host\\s\\x.exe', 'powershell.exe']) {
    const a = await policy.authorizeTarget('any', t, s, fs);
    assert.equal(a.ok, false, t);
  }
  assert.deepEqual(fs.calls, []);
  assert.equal((await policy.authorizeTarget('any', 'notepad', s, fs)).ok, true);
});

// ---------- validation (NSR-01, NSR-02 helper) ----------

test('describePermissionChanges lists every widening change and nothing for removals', () => {
  const a = {...validation.DEFAULT_SETTINGS, approvedApps: ['C:\\A\\a.exe'], allowedRoots: ['C:\\Docs']};
  const b = {...a, approvedApps: ['C:\\A\\a.exe', 'C:\\B\\b.exe'], allowedRoots: ['C:\\Docs', 'D:\\More'], mode: 'online', localEndpoint: 'http://127.0.0.1:9999'};
  const lines = validation.describePermissionChanges(a, b);
  assert.equal(lines.length, 4);
  assert.ok(lines.some((l) => /Approve executable: C:\\B\\b\.exe/.test(l)));
  assert.ok(lines.some((l) => /Allow folder: D:\\More/.test(l)));
  assert.ok(lines.some((l) => /online mode/i.test(l)));
  assert.ok(lines.some((l) => /endpoint/i.test(l)));
  assert.deepEqual(validation.describePermissionChanges(b, a).filter((l) => /Approve|Allow|online/.test(l)), []);
  assert.deepEqual(validation.describePermissionChanges(a, {...a, approvedApps: ['c:\\a\\A.EXE']}), [], 'case-insensitive');
});

test('imports drop network permission entries instead of trusting them', () => {
  const doc = {settings: {...validation.DEFAULT_SETTINGS, allowedRoots: ['\\\\evil\\share\\f', 'C:\\Docs'], approvedApps: ['\\\\evil\\s\\t.exe', 'notepad.exe']}, capsules: [], notes: [], tasks: []};
  assert.throws(() => validation.parseState(doc), /Network|allowed folder/);
  const dropped = [];
  const st = validation.parseState(doc, {lenient: true, dropped});
  assert.deepEqual(st.settings.allowedRoots, ['C:\\Docs']);
  assert.deepEqual(st.settings.approvedApps, ['notepad.exe']);
  assert.equal(dropped.length, 2);
});

// ---------- netGuard (NSR-12, offline egress) ----------

const CLOUD = 'https://api.anthropic.com';
const EP = 'http://127.0.0.1:11434';

test('loopback is pinned to the configured endpoint, fixed paths and known purposes', () => {
  const ev = (url, purpose = 'ollama', opts = {}) => netGuard.evaluateEgress(url, purpose, 'offline', false, undefined, {localEndpoint: EP, ...opts});
  assert.equal(ev(`${EP}/api/chat`, 'ollama', {method: 'POST'}), null);
  assert.equal(ev(`${EP}/api/tags`), null);
  assert.equal(ev(`${EP}/api/version`), null);
  assert.match(ev('http://127.0.0.1:9999/api/chat'), /configured local model endpoint/);
  assert.match(ev('http://localhost:11434/api/chat'), /configured local model endpoint/);
  assert.match(ev(`${EP}/api/delete`), /limited to the model API paths/);
  assert.match(ev(`${EP}/api/chat`, 'ollama', {method: 'DELETE'}), /may not use DELETE/);
  assert.match(ev(`${EP}/api/chat`, 'something-else'), /only for the local model/);
  assert.match(ev(`${EP}/api/chat`, 'cloud-chat'), /only for the local model/);
  assert.deepEqual(Object.keys(netGuard.LOOPBACK_PURPOSES), ['ollama']);
});

test('credential headers never leave the cloud origin, in any header container shape', () => {
  const ev = (headers) => netGuard.evaluateEgress(`${EP}/api/chat`, 'ollama', 'offline', false, undefined, {headers, method: 'POST'});
  assert.match(ev({'X-API-Key': 'k'}), /Credential headers/);
  assert.match(ev([['Authorization', 'Bearer x']]), /Credential headers/);
  assert.match(ev(new Headers({cookie: 'a=b'})), /Credential headers/);
  assert.equal(ev({'content-type': 'application/json'}), null);
  assert.equal(netGuard.evaluateEgress(`${CLOUD}/v1/messages`, 'cloud-chat', 'online', true, undefined, {headers: {'x-api-key': 'k'}, method: 'POST'}), null);
});

test('cloud: one origin, one path, POST only, online with a key', () => {
  const ev = (url, method = 'POST', mode = 'online', key = true) => netGuard.evaluateEgress(url, 'cloud-chat', mode, key, undefined, {method});
  assert.equal(ev(`${CLOUD}/v1/messages`), null);
  assert.match(ev(`${CLOUD}/v1/files`), /chat endpoint/);
  assert.match(ev(`${CLOUD}/v1/messages`, 'GET'), /POST/);
  assert.match(ev(`${CLOUD}/v1/messages`, 'POST', 'offline'), /Offline/);
  assert.match(ev(`${CLOUD}/v1/messages`, 'POST', 'online', false), /No cloud API key/);
  assert.ok(ev('https://api.anthropic.com.evil.test/v1/messages'));
});

test('guarded fetch: cloud rate cap, redirect error, and caller cancellation plus timeout both apply', async () => {
  let t = 0;
  const seen = [];
  const gf = netGuard.createGuardedFetch({
    mode: () => 'online', hasCloudKey: () => true, now: () => t, maxCloudPerMinute: 2, localEndpoint: () => EP,
    fetchImpl: async (url, init) => { seen.push({url, init}); return new Response('{}'); },
  });
  const post = () => gf(`${CLOUD}/v1/messages`, {method: 'POST', headers: {'x-api-key': 'k'}}, 'cloud-chat');
  await post(); await post();
  await assert.rejects(post(), /limit reached/);
  assert.equal(seen.length, 2);
  t = 61_000;
  await post();
  assert.equal(seen.length, 3);
  assert.equal(seen[0].init.redirect, 'error');

  const ctl = new AbortController();
  await gf(`${EP}/api/tags`, {signal: ctl.signal}, 'ollama');
  const sig = seen.at(-1).init.signal;
  assert.equal(sig.aborted, false);
  ctl.abort();
  assert.equal(sig.aborted, true, 'caller cancellation propagates');

  const ctl2 = new AbortController();
  await gf(`${EP}/api/tags`, {signal: ctl2.signal, timeoutMs: 20}, 'ollama');
  const sig2 = seen.at(-1).init.signal;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sig2.aborted, true, 'timeout applies even with a caller signal');
  await assert.rejects(gf('http://127.0.0.1:9/api/tags', {}, 'ollama'), netGuard.NetworkDenied);
});

test('security services contain no network, electron or child-process access of their own', () => {
  for (const f of ['actions', 'policy', 'paths', 'validation', 'secrets', 'system']) {
    const src = readFileSync(path.join(root, 'electron', 'services', `${f}.ts`), 'utf8');
    assert.ok(!/from 'node:(http|https|net|dns|tls|child_process)'|from 'electron'/.test(src), `${f}.ts imports`);
    assert.ok(!/(^|[^.\w])fetch\(/.test(src), `${f}.ts calls fetch directly`);
  }
});

// ---------- secrets (NSR-13) ----------

function vaultFs() {
  const files = new Map();
  return {files, read: async (p) => files.get(p) ?? null, write: async (p, d) => { files.set(p, d); }, remove: async (p) => { files.delete(p); }};
}
const KEY = 'sk-test-0123456789abcdefghij-NOT-A-REAL-KEY';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const fromB64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const fakeDpapi = (log = []) => ({dpapi: async (op, data) => {
  log.push(op);
  if (op === 'probe') return {ok: true};
  if (op === 'protect') return {ok: true, data: b64(`dpapi:${data}`)};
  return {ok: true, data: fromB64(data).replace(/^dpapi:/, '')};
}});
const rev = (s) => s.split('').reverse().join('');
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from(rev(`ss:${s}`)),
  decryptString: (b) => rev(b.toString()).replace(/^ss:/, ''),
});

test('key is stored only as ciphertext, never in the vault object, JSON or errors', async () => {
  const fs = vaultFs();
  const v = new secrets.Secrets(fakeDpapi(), 'C:\\data', fs);
  await v.set(KEY);
  const blob = [...fs.files.values()][0];
  assert.ok(blob && !blob.includes(KEY), 'stored value is not the key');
  assert.ok(!JSON.stringify(v).includes(KEY));
  assert.deepEqual(JSON.parse(JSON.stringify(v)), {secrets: 'redacted'});
  assert.equal(await v.reveal(), KEY);
  assert.equal(await v.configured(), true);
  for (const bad of ['short', 'bad key with spaces inside but long enough']) {
    try { await v.set(bad); assert.fail('accepted'); } catch (e) { assert.ok(!String(e.message).includes(bad), 'error does not echo the key'); }
  }
  await v.delete();
  assert.equal(await v.configured(), false);
});

test('safeStorage is preferred, legacy DPAPI blobs stay readable, and DPAPI is the fallback', async () => {
  const fs = vaultFs();
  const log = [];
  const v = new secrets.Secrets(fakeDpapi(log), 'C:\\data', fs, fakeSafeStorage());
  await v.set(KEY);
  assert.ok([...fs.files.values()][0].startsWith('ss1:'));
  assert.ok(!log.includes('protect') && !log.includes('unprotect'), 'no child process when safeStorage works');
  assert.equal(await v.reveal(), KEY);
  assert.deepEqual(await v.available(), {available: true});

  const legacy = vaultFs();
  await new secrets.Secrets(fakeDpapi(), 'C:\\data', legacy).set(KEY);
  assert.equal(await new secrets.Secrets(fakeDpapi(), 'C:\\data', legacy, fakeSafeStorage()).reveal(), KEY);

  const fb = vaultFs();
  await new secrets.Secrets(fakeDpapi(), 'C:\\data', fb, fakeSafeStorage(false)).set(KEY);
  assert.ok(![...fb.files.values()][0].startsWith('ss1:'));
  const noSafe = new secrets.Secrets(fakeDpapi(log), 'C:\\data', fs, fakeSafeStorage(false));
  const before = log.length;
  assert.equal(await noSafe.reveal(), null, 'a safeStorage blob is never sent to DPAPI');
  assert.equal(log.length, before);
});

test('a protector that returns garbage never replaces a working key', async () => {
  const fs = vaultFs();
  await new secrets.Secrets(fakeDpapi(), 'C:\\data', fs).set(KEY);
  const before = [...fs.files.values()][0];
  const broken = new secrets.Secrets({dpapi: async (op) => (op === 'probe' ? {ok: true} : op === 'protect' ? {ok: true, data: b64('x'.repeat(40))} : {ok: true, data: 'different'})}, 'C:\\data', fs);
  await assert.rejects(broken.set('sk-another-0123456789abcdefghij'), /could not be verified/);
  assert.equal([...fs.files.values()][0], before);
  const down = new secrets.Secrets({dpapi: async () => { throw new Error('no powershell'); }}, 'C:\\data', fs);
  await assert.rejects(down.set('sk-another-0123456789abcdefghij'), /unavailable/);
  assert.equal((await down.available()).available, false);
  assert.equal(await down.reveal(), null);
  assert.equal([...fs.files.values()][0], before);
});

test('atomic file write: unique temp, no leftovers, failed write keeps the old file, concurrent writers do not corrupt', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ao-security-secrets-'));
  try {
    const file = path.join(dir, 'secrets', 'cloud-key.bin');
    await secrets.nodeSecretsFs.write(file, 'first-blob-0123456789');
    await secrets.nodeSecretsFs.write(file, 'second-blob-0123456789');
    assert.equal(await readFile(file, 'utf8'), 'second-blob-0123456789');
    assert.deepEqual(await readdir(path.dirname(file)), ['cloud-key.bin']);
    const blocked = path.join(dir, 'secrets', 'dirtarget');
    await mkdir(blocked);
    await writeFile(path.join(blocked, 'keep.txt'), 'x');
    await assert.rejects(secrets.nodeSecretsFs.write(blocked, 'blob-0123456789abcdef'));
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ['cloud-key.bin', 'dirtarget']);
    await Promise.all([1, 2, 3, 4, 5].map((i) => secrets.nodeSecretsFs.write(file, `concurrent-${i}-0123456789`)));
    assert.match(await readFile(file, 'utf8'), /^concurrent-\d-0123456789$/);
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ['cloud-key.bin', 'dirtarget']);
    await secrets.nodeSecretsFs.remove(file);
    assert.equal(await secrets.nodeSecretsFs.read(file), null);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---------- system: measured resources and honest capabilities ----------

function sys(over = {}) {
  return new system.System({
    settings: () => ({...validation.DEFAULT_SETTINGS}), fetch: async () => { throw new Error('offline'); }, speech: {capabilities: async () => []},
    secrets: {available: async () => ({available: true}), configured: async () => false}, native: {listWindows: async () => []},
    safeLaunch: () => false, platform: 'win32', ...over,
  });
}

test('resources report injected measurements exactly and deltas only after two samples', () => {
  let t = 1_000, idle = 100, busy = 100, cpuMicros = 0;
  const cpu = () => ({model: 'Test CPU', speed: 1, times: {user: busy, nice: 0, sys: 0, idle, irq: 0}});
  const fakeOs = {platform: () => 'win32', arch: () => 'x64', totalmem: () => 16 * 1024 ** 3, freemem: () => 4 * 1024 ** 3, uptime: () => 7200.4, cpus: () => [cpu(), cpu()]};
  const proc = {memoryUsage: () => ({rss: 100, heapTotal: 50, heapUsed: 40, external: 5, arrayBuffers: 1}), cpuUsage: () => ({user: cpuMicros, system: 0}), uptime: () => 12.6};
  const s = sys({now: () => t, os: fakeOs, proc, appMetrics: () => [{pid: 1, type: 'Browser', cpuPercent: 2.5, workingSetKB: 1000}]});
  const a = s.resources();
  assert.equal(a.cpuBusyPercent, null);
  assert.equal(a.processCpuPercent, null);
  assert.deepEqual(a.memory, {totalBytes: 16 * 1024 ** 3, freeBytes: 4 * 1024 ** 3, usedBytes: 12 * 1024 ** 3, usedPercent: 75});
  assert.deepEqual(a.processMemory, {rssBytes: 100, heapUsedBytes: 40, heapTotalBytes: 50, externalBytes: 5});
  assert.equal(a.logicalCores, 2);
  assert.equal(a.osUptimeSeconds, 7200);
  assert.equal(a.processUptimeSeconds, 13);
  assert.equal(a.appProcesses.length, 1);
  assert.ok(a.unavailable.some((u) => u.id === 'gpu'));
  t += 1000; idle += 75; busy += 25; cpuMicros += 100_000;
  const b = s.resources();
  assert.equal(b.cpuBusyPercent, 25);
  assert.equal(b.processCpuPercent, 10);
});

test('real measurements come from the OS and process; unconnected sources are reported unavailable', () => {
  const r = sys().resources();
  assert.equal(r.memory.totalBytes, os.totalmem());
  assert.equal(r.logicalCores, os.cpus().length);
  assert.ok(r.processMemory.rssBytes > 0);
  assert.ok(r.memory.freeBytes <= r.memory.totalBytes);
  assert.deepEqual(r.appProcesses, []);
  assert.ok(r.unavailable.some((u) => u.id === 'app-processes'));
  assert.ok(!JSON.stringify(r).includes('NaN'));
  assert.deepEqual(sys({appMetrics: () => { throw new Error('x'); }}).resources().appProcesses, []);
});

test('capabilities are honest: offline cloud, no key, safe launch, shared probes and cache invalidation', async () => {
  let listCalls = 0, mode = 'offline', safe = false, t = 0;
  const s = sys({now: () => t, settings: () => ({...validation.DEFAULT_SETTINGS, mode}), safeLaunch: () => safe, native: {listWindows: async () => { listCalls++; return []; }}});
  const [a, b] = await Promise.all([s.capabilities(), s.capabilities()]);
  assert.equal(a, b, 'concurrent callers share one probe');
  assert.equal(listCalls, 1);
  const get = (c, id) => c.find((x) => x.id === id);
  assert.equal(get(a, 'cloud').available, false);
  assert.match(get(a, 'cloud').reason, /Offline/);
  assert.equal(get(a, 'ocr').available, false);
  assert.equal(get(a, 'vision').available, false);
  assert.equal(get(a, 'local-llm').available, false);
  assert.equal(get(a, 'ui-automation').available, true);
  await s.capabilities();
  assert.equal(listCalls, 1, 'cached');
  mode = 'online';
  assert.match(get(await s.capabilities(), 'cloud').reason, /No API key/);
  safe = true;
  assert.match(get(await s.capabilities(), 'ui-automation').reason, /Safe launch/);
  t = 31_000; safe = false;
  await s.capabilities();
  assert.equal(get(await sys({platform: 'linux'}).capabilities(), 'ui-automation').available, false);
});

test('info reports real platform values', async () => {
  const i = await sys().info();
  assert.equal(i.platform, os.platform());
  assert.equal(i.arch, os.arch());
  assert.equal(i.ramGB, Math.round((os.totalmem() / 1024 ** 3) * 10) / 10);
});

// ---------- actions: approval flow (NSR-02, NSR-07, NSR-08, NSR-09) ----------

const TOOL = 'C:\\Tools\\tool.exe';
function fx(opts = {}) {
  const clock = {t: 1_000_000};
  const log = {spawned: [], opened: [], urls: [], typed: [], clicks: [], focused: [], moves: [], activity: [], confirms: []};
  const state = {wins: [win({hwnd: 12, pid: 23})], files: new Map([[TOOL.toLowerCase(), {size: 100, mtimeMs: 5}], ['c:\\docs\\a.txt', {size: 10, mtimeMs: 7}]]), focusOk: true};
  const fs = {
    realpath: async (p) => p,
    stat: async (p) => {
      const f = state.files.get(p.toLowerCase());
      if (f) return {isDirectory: () => false, isFile: () => true, ...f};
      if (p.toLowerCase() === 'c:\\docs') return {isDirectory: () => true, isFile: () => false};
      throw new Error('ENOENT');
    },
  };
  const native = {
    listWindows: async () => state.wins.map((w) => ({...w})),
    focusWindow: async (t) => { log.focused.push(t); return {focused: state.focusOk}; },
    typeText: async (t, text) => { log.typed.push(text); return {typed: text.length}; },
    moveWindow: async () => { log.moves.push(1); return {x: 0, y: 0, width: 1, height: 1, clamped: false}; },
    click: async () => { log.clicks.push(1); },
  };
  const shell = {spawnApp: async (p) => { log.spawned.push(p); }, openPath: async (p) => { log.opened.push(p); return ''; }, openExternal: async (u) => { log.urls.push(u); }};
  let id = 0;
  const confirm = 'confirm' in opts ? opts.confirm : async (summary, detail) => { log.confirms.push({summary, detail}); return true; };
  const svc = new actions.ActionService({
    settings: () => ({...validation.DEFAULT_SETTINGS, approvedApps: [TOOL], allowedRoots: ['C:\\Docs']}),
    activity: async (kind, summary, details) => { log.activity.push({kind, summary, details}); },
    native, shell, fs, selfPids: () => [], safeLaunch: () => state.safe === true, now: () => clock.t, newId: () => `p${++id}`,
    resolveExecutable: async (e) => e, confirm, minPreviewAgeMs: opts.minPreviewAgeMs,
  });
  return {svc, log, state, clock};
}
const run = async (f, req, approved = true) => { const p = await f.svc.preview(req); return {p, r: await f.svc.execute(p.id, approved)}; };

test('a renderer approval alone never runs anything: no, declining, throwing or returning-a-string confirmation', async () => {
  for (const confirm of [undefined, async () => false, async () => { throw new Error('dialog failed'); }, async () => 'yes']) {
    const f = fx({confirm});
    const {r} = await run(f, {type: 'launch', target: TOOL});
    assert.equal(r.executed, false);
    assert.deepEqual(f.log.spawned, []);
    assert.equal(f.svc.pendingPreviews, 0, 'preview is consumed');
  }
});

test('previews are single use; declining or denial consumes them and nothing is sent at preview time', async () => {
  const f = fx();
  const p = await f.svc.preview({type: 'type-text', target: 'hwnd:12', text: 'hello'});
  assert.equal(p.allowed, true);
  assert.deepEqual(f.log.typed, [], 'no input at preview');
  assert.deepEqual(f.log.focused, [], 'no focus change at preview');
  assert.equal((await f.svc.execute(p.id, false)).executed, false);
  await assert.rejects(f.svc.execute(p.id, true), /already used/);
  await assert.rejects(f.svc.execute(p.id, 'true'), /true or false/);
});

test('launch binds the exact executable; a binary replaced during the dialog is refused', async () => {
  const f = fx({confirm: async () => true});
  const p = await f.svc.preview({type: 'launch', target: TOOL});
  assert.match(p.summary, /C:\\Tools\\tool\.exe/);
  assert.equal((await f.svc.execute(p.id, true)).executed, true);
  assert.deepEqual(f.log.spawned, [TOOL]);

  const g = fx({confirm: async () => { g.state.files.set(TOOL.toLowerCase(), {size: 999, mtimeMs: 6}); return true; }});
  const r = (await run(g, {type: 'launch', target: TOOL})).r;
  assert.equal(r.executed, false);
  assert.match(r.reason, /changed since the preview/);
  assert.deepEqual(g.log.spawned, []);
});

test('a document replaced between preview and execute is refused; unchanged documents open', async () => {
  const f = fx();
  assert.equal((await run(f, {type: 'launch', target: 'C:\\Docs\\a.txt'})).r.executed, true);
  assert.deepEqual(f.log.opened, ['C:\\Docs\\a.txt']);
  const g = fx({confirm: async () => { g.state.files.set('c:\\docs\\a.txt', {size: 11, mtimeMs: 8}); return true; }});
  const r = (await run(g, {type: 'launch', target: 'C:\\Docs\\a.txt'})).r;
  assert.equal(r.executed, false);
  assert.deepEqual(g.log.opened, []);
});

test('the dialog shows the resolved path and the full text; the summary is abbreviated with visible markers', async () => {
  const f = fx();
  const long = 'x'.repeat(500) + '\nend';
  const {p, r} = await run(f, {type: 'type-text', target: 'hwnd:12', text: long});
  assert.equal(r.executed, true);
  assert.ok(p.summary.length < 400);
  assert.ok(f.log.confirms[0].detail.includes('x'.repeat(500)), 'full text in the dialog');
  assert.ok(f.log.confirms[0].detail.includes(RET + '\nend'));
  assert.equal(f.log.typed[0], long, 'exact text is typed');
});

test('hidden direction-changing characters in window titles and text are visible in previews and dialogs', async () => {
  const f = fx();
  f.state.wins = [win({hwnd: 12, pid: 23, title: `Invoice${RLO}fdp.exe`})];
  const {p} = await run(f, {type: 'type-text', target: 'hwnd:12', text: `a${ZWSP}b`});
  assert.ok(p.summary.includes('[U+202E]') && p.summary.includes('[U+200B]'));
  assert.ok(!p.summary.includes(RLO) && !p.summary.includes(ZWSP));
  assert.ok(f.log.confirms[0].detail.includes('[U+202E]') && !f.log.confirms[0].detail.includes(RLO));
});

test('line breaks into terminals, Explorer and Start search are denied at preview; never confirmed or typed', async () => {
  for (const proc of ['pwsh.exe', 'cmd.exe', 'explorer.exe', 'SearchHost.exe']) {
    const f = fx();
    f.state.wins = [win({hwnd: 12, pid: 23, process: proc})];
    for (const text of ['calc\n', `calc${LSEP}`]) {
      const p = await f.svc.preview({type: 'type-text', target: 'hwnd:12', text});
      assert.equal(p.allowed, false, proc);
      assert.match(p.reason, /line break/);
      assert.equal((await f.svc.execute(p.id, true)).executed, false);
    }
    assert.deepEqual(f.log.confirms, []);
    assert.deepEqual(f.log.typed, []);
  }
});

test('a window that becomes a terminal during the dialog is refused after focus, before any input', async () => {
  const f = fx({confirm: async () => { f.state.wins = [win({hwnd: 12, pid: 23, process: 'cmd.exe'})]; return true; }});
  const {r} = await run(f, {type: 'type-text', target: 'hwnd:12', text: 'a\nb'});
  assert.equal(r.executed, false);
  assert.deepEqual(f.log.typed, []);
});

test('focus failure and an unfocused, elevated or replaced target stop input', async () => {
  const f = fx(); f.state.focusOk = false;
  assert.equal((await run(f, {type: 'type-text', target: 'hwnd:12', text: 'hi'})).r.executed, false);
  const g = fx({confirm: async () => { g.state.wins = [win({hwnd: 12, pid: 99})]; return true; }});
  assert.equal((await run(g, {type: 'click', target: 'hwnd:12', x: 5, y: 5})).r.executed, false);
  assert.deepEqual([...f.log.typed, ...g.log.clicks], []);
  const h = fx({confirm: async () => { h.state.wins = [win({hwnd: 12, pid: 23, elevated: 1})]; return true; }});
  assert.equal((await run(h, {type: 'type-text', target: 'hwnd:12', text: 'hi'})).r.executed, false);
  assert.deepEqual(h.log.typed, []);
});

test('minimum preview age is enforced when configured', async () => {
  const f = fx({minPreviewAgeMs: actions.RECOMMENDED_MIN_PREVIEW_AGE_MS});
  const p = await f.svc.preview({type: 'launch', target: TOOL});
  const early = await f.svc.execute(p.id, true);
  assert.equal(early.executed, false);
  assert.match(early.reason, /too quickly/);
  assert.deepEqual(f.log.confirms, []);
  const q = await f.svc.preview({type: 'launch', target: TOOL});
  f.clock.t += 600;
  assert.equal((await f.svc.execute(q.id, true)).executed, true);
});

test('repeated declines pause confirmations, then resume after the cooldown', async () => {
  let shown = 0;
  const f = fx({confirm: async () => { shown++; return false; }});
  for (let i = 0; i < actions.DECLINE_LIMIT; i++) await run(f, {type: 'launch', target: TOOL});
  assert.equal(shown, actions.DECLINE_LIMIT);
  assert.equal(f.svc.confirmationsPaused, true);
  const paused = (await run(f, {type: 'launch', target: TOOL})).r;
  assert.match(paused.reason, /paused/);
  assert.equal(shown, actions.DECLINE_LIMIT, 'no further dialog while paused');
  f.clock.t += actions.DECLINE_COOLDOWN_MS + 1;
  assert.equal(f.svc.confirmationsPaused, false);
  await run(f, {type: 'launch', target: TOOL});
  assert.equal(shown, actions.DECLINE_LIMIT + 1);
  const g = fx({confirm: async () => true});
  await run(g, {type: 'launch', target: TOOL});
  assert.equal(g.svc.confirmationsPaused, false, 'approvals never pause');
});

test('cancelPending drops unused previews and aborts an execution waiting in the dialog', async () => {
  const f = fx();
  const p = await f.svc.preview({type: 'launch', target: TOOL});
  f.svc.cancelPending();
  await assert.rejects(f.svc.execute(p.id, true), /unknown, expired or was already used/);

  const g = fx({confirm: async () => { g.svc.cancelPending(); return true; }});
  const r = (await run(g, {type: 'launch', target: TOOL})).r;
  assert.equal(r.executed, false);
  assert.match(r.reason, /Cancelled/);
  assert.deepEqual(g.log.spawned, []);
});

test('execution and preview rate limits hold', async () => {
  const f = fx();
  const results = [];
  for (let i = 0; i < actions.MAX_ACTIONS_PER_MINUTE + 1; i++) results.push((await run(f, {type: 'open-url', target: 'https://example.com/'})).r);
  assert.equal(results.filter((r) => r.executed).length, actions.MAX_ACTIONS_PER_MINUTE);
  assert.match(results.at(-1).reason, /Rate limit/);
  const g = fx();
  for (let i = 0; i < actions.MAX_PREVIEWS_PER_MINUTE; i++) await g.svc.preview({type: 'list-windows'});
  await assert.rejects(g.svc.preview({type: 'list-windows'}), /Too many action previews/);
  g.clock.t += 61_000;
  await g.svc.preview({type: 'list-windows'});
});

test('safe launch blocks everything with the product name in the message', async () => {
  const f = fx();
  f.state.safe = true;
  const p = await f.svc.preview({type: 'launch', target: TOOL});
  assert.equal(p.allowed, false);
  assert.match(p.reason, /Desktop Companion/);
  assert.ok(!/jarvis/i.test(p.reason));
  assert.deepEqual(f.log.confirms, []);
});

test('only approved executables launch: unlisted names, paths and network executables are denied', async () => {
  const f = fx();
  for (const target of ['cmd.exe', 'C:\\Windows\\System32\\cmd.exe', '\\\\host\\share\\tool.exe', 'tool', 'tool.exe /c calc']) {
    const p = await f.svc.preview({type: 'launch', target});
    if (target === 'tool') assert.equal(p.allowed, true, 'basename of an approved full path resolves to that exact path');
    else assert.equal(p.allowed, false, target);
  }
  assert.deepEqual(f.log.spawned, []);
});

test('resolveExecutable: bare names come only from fixed system folders and must be valid', async () => {
  const touched = [];
  const stat = async (p) => { touched.push(p); return {isFile: () => p === 'C:\\Windows\\System32\\ok.exe'}; };
  assert.equal(await actions.resolveExecutable('ok.exe', {SystemRoot: 'C:\\Windows', PATH: 'C:\\Writable'}, {stat}), 'C:\\Windows\\System32\\ok.exe');
  assert.equal(await actions.resolveExecutable('missing.exe', {SystemRoot: 'C:\\Windows', PATH: 'C:\\Writable'}, {stat}), null);
  assert.ok(touched.every((p) => !p.includes('Writable')));
  touched.length = 0;
  for (const bad of ['..exe', 'con.exe', '\\\\host\\s\\x.exe', 'C:\\x.bat']) assert.equal(await actions.resolveExecutable(bad, {SystemRoot: 'C:\\Windows'}, {stat}), null, bad);
  assert.deepEqual(touched, []);
});

test('capsule items share the confirmation lockout and are fingerprint-bound', async () => {
  let shown = 0;
  const f = fx({confirm: async () => { shown++; return false; }});
  for (let i = 0; i < actions.DECLINE_LIMIT; i++) assert.equal((await f.svc.openItem('app', TOOL)).ok, false);
  assert.equal((await f.svc.openItem('app', TOOL)).reason, 'Confirmations are paused after repeated declines');
  assert.equal(shown, actions.DECLINE_LIMIT);
  const g = fx();
  const item = await g.svc.prepareItem('app', TOOL);
  assert.ok(item.ok && !/sig/.test(item.detail), 'fingerprint is not shown to the user');
  g.state.files.set(TOOL.toLowerCase(), {size: 1, mtimeMs: 1});
  assert.equal((await item.run()).ok, false);
  assert.deepEqual(g.log.spawned, []);
});
