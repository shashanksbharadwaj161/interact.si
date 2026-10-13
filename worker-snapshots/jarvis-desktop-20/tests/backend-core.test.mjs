// Backend core tests: paths, policy, validation, store, chat, netGuard, secrets.
// Bundles the real TypeScript services in memory; every external dependency (filesystem, fetch, DPAPI) is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backend-core-entry.ts',
    loader: 'ts',
    contents: `
      export * as paths from './electron/services/paths.ts';
      export * as policy from './electron/services/policy.ts';
      export * as validation from './electron/services/validation.ts';
      export * as store from './electron/services/store.ts';
      export * as chat from './electron/services/chat.ts';
      export * as netGuard from './electron/services/netGuard.ts';
      export * as secrets from './electron/services/secrets.ts';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { paths, policy, validation, store: storeMod, chat, netGuard, secrets } = mod;

// ---------- helpers ----------

/** Fake fs for path scoping: records every call so tests can prove nothing was touched. */
function fakeFs(tree = {}, links = {}) {
  const calls = [];
  const norm = (p) => p.toLowerCase();
  return {
    calls,
    realpath: async (p) => { calls.push(['realpath', p]); const k = Object.keys(links).find((l) => norm(l) === norm(p)); if (k) return links[k]; if (norm(p) in tree) return p; throw new Error('ENOENT'); },
    stat: async (p) => { calls.push(['stat', p]); const t = tree[norm(p)]; if (!t) throw new Error('ENOENT'); return { isDirectory: () => t === 'dir', isFile: () => t === 'file' }; },
  };
}

/** In-memory StoreFs with failure injection. */
function memFs() {
  const files = new Map();
  const fs = {
    files, failWrite: null, failRename: null,
    mkdir: async () => {},
    readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(p); },
    writeFile: async (p, d) => { if (fs.failWrite?.(p)) throw new Error('disk full'); files.set(p, d); },
    rename: async (a, b) => { const e = fs.failRename?.(a, b); if (e) throw e; files.set(b, files.get(a)); files.delete(a); },
    readdir: async (p) => [...files.keys()].filter((k) => path.dirname(k) === p).map((k) => path.basename(k)),
    unlink: async (p) => { files.delete(p); },
  };
  return fs;
}

const DIR = path.join('C:\\', 'appdata', 'dc');
const statePath = path.join(DIR, 'state.json');
function newStore(fs = memFs()) {
  let n = 0;
  const s = new storeMod.Store({ dir: DIR, fs, now: () => new Date('2026-10-14T10:00:00Z'), newId: () => `id${++n}` });
  return { s, fs };
}
const exportJson = (state, extra = {}) => JSON.stringify({ format: 'jarvis-export', schemaVersion: 1, state, ...extra });
const baseState = () => validation.defaultState();

function win(over = {}) {
  return { hwnd: 10, pid: 500, process: 'notepad.exe', title: 'Untitled - Notepad', x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, foreground: true, elevated: 0, ...over };
}

// ---------- paths: UNC / device / slash normalization (NSR-03, NSR-04) ----------

const HOSTILE = [
  '//./pipe/demo', '\\\\.\\pipe\\demo', '\\/.\\x', '/\\?\\C:\\x', '\\\\?\\C:\\Docs\\a.txt',
  '\\\\attacker.example\\share\\payload.exe', '\\\\attacker.example@SSL\\DavWWWRoot\\x.exe', '//server/share/x.txt',
  'C:\\Docs\\NUL', 'C:\\Docs\\com1.txt', 'C:\\Docs\\a.txt:stream', 'C:\\Docs\\..\\x.txt', 'C:relative.txt', '\\rooted.txt', 'relative\\a.txt',
  'C:\\Docs\\trailing.', 'C:\\Docs\\space ', 'C:\\Docs\\a?.txt', 'C:\\Docs\\a\u0001.txt',
];

test('normalizeAbsolutePath rejects UNC, WebDAV, device, forward-slash variants, ADS, reserved names', () => {
  for (const p of HOSTILE) assert.ok('error' in paths.normalizeAbsolutePath(p), `should reject ${JSON.stringify(p)}`);
  assert.deepEqual(paths.normalizeAbsolutePath('C:/Docs/sub//a.txt'), { path: 'C:\\Docs\\sub\\a.txt' });
  assert.deepEqual(paths.normalizeAbsolutePath('c:\\Docs\\'), { path: 'c:\\Docs' });
});

test('normalizeAbsolutePath rejects ambiguous whitespace/dot segments instead of trimming them away', () => {
  for (const p of ['C:\\Docs\\space ', ' C:\\Docs\\a.txt', 'C:\\Docs\\a.txt\t', 'C:\\Docs\\sub \\a.txt', 'C:\\Docs\\dir.\\a.txt', 'C:\\Docs\\a.txt.', '   ', '']) {
    assert.ok('error' in paths.normalizeAbsolutePath(p), `should reject ${JSON.stringify(p)}`);
  }
  assert.deepEqual(paths.normalizeAbsolutePath('C:\\Docs\\My Files\\a b.txt'), { path: 'C:\\Docs\\My Files\\a b.txt' });
});

test('resolveInsideRoots makes no filesystem call for hostile or out-of-scope targets', async () => {
  const fs = fakeFs({ 'c:\\docs': 'dir', 'c:\\docs\\a.pdf': 'file' });
  for (const p of [...HOSTILE, 'D:\\Other\\a.pdf', 'C:\\Documents\\a.pdf']) {
    const r = await paths.resolveInsideRoots(p, ['C:\\Docs'], fs);
    assert.equal(r.ok, false, p);
  }
  assert.deepEqual(fs.calls, [], 'no realpath/stat before the lexical checks pass');
});

test('resolveInsideRoots accepts documents inside a root, including forward slashes and folders', async () => {
  const fs = fakeFs({ 'c:\\docs': 'dir', 'c:\\docs\\a.pdf': 'file', 'c:\\docs\\sub': 'dir' });
  assert.deepEqual(await paths.resolveInsideRoots('C:/Docs/a.pdf', ['C:\\Docs'], fs), { ok: true, path: 'C:/Docs/a.pdf'.replace(/\//g, '\\'), isDirectory: false });
  const dir = await paths.resolveInsideRoots('C:\\Docs\\sub', ['C:\\Docs'], fs);
  assert.equal(dir.ok && dir.isDirectory, true);
});

test('resolveInsideRoots blocks symlink escapes and network-resolving paths', async () => {
  const fs = fakeFs({ 'c:\\docs': 'dir', 'd:\\secret\\a.pdf': 'file', '\\\\evil\\s\\a.pdf': 'file' }, {
    'C:\\Docs\\link.pdf': 'D:\\secret\\a.pdf',
    'C:\\Docs\\net.pdf': '\\\\evil\\s\\a.pdf',
  });
  const escape = await paths.resolveInsideRoots('C:\\Docs\\link.pdf', ['C:\\Docs'], fs);
  assert.equal(escape.ok, false);
  assert.match(escape.reason, /outside/);
  const net = await paths.resolveInsideRoots('C:\\Docs\\net.pdf', ['C:\\Docs'], fs);
  assert.equal(net.ok, false);
  assert.match(net.reason, /network or device/);
});

test('only allowlisted document types open as files (NSR-05)', async () => {
  const bad = ['x.chm', 'x.iso', 'x.settingcontent-ms', 'x.msix', 'x.library-ms', 'x.search-ms', 'x.exe', 'x.lnk', 'x.vhdx', 'x.scf', 'x.theme', 'x.docm', 'x.ps1', 'x.hta', 'x.appinstaller', 'x.diagcab', 'noext'];
  const good = ['x.pdf', 'x.TXT', 'x.docx', 'x.png', 'x.mp3', 'x.zip'];
  const tree = { 'c:\\docs': 'dir' };
  for (const n of [...bad, ...good]) tree[`c:\\docs\\${n}`.toLowerCase()] = 'file';
  const fs = fakeFs(tree);
  for (const n of bad) {
    const r = await paths.resolveInsideRoots(`C:\\Docs\\${n}`, ['C:\\Docs'], fs);
    assert.equal(r.ok, false, n);
    assert.match(r.reason, /file type/);
  }
  for (const n of good) assert.equal((await paths.resolveInsideRoots(`C:\\Docs\\${n}`, ['C:\\Docs'], fs)).ok, true, n);
  assert.equal((await paths.resolveInsideRoots('C:\\Docs\\x.exe', ['C:\\Docs'], fs, { allowDangerousFiles: true })).ok, true);
});

test('authorizeTarget refuses UNC launch targets before touching the filesystem', async () => {
  const fs = fakeFs();
  const settings = { allowedRoots: ['C:\\Docs'], approvedApps: ['notepad.exe'] };
  for (const t of ['\\\\attacker.example\\s\\x.exe', '//attacker.example/s/x.exe', '//./pipe/x']) {
    for (const kind of ['any', 'file', 'folder', 'app']) assert.equal((await policy.authorizeTarget(kind, t, settings, fs)).ok, false, `${kind} ${t}`);
  }
  assert.deepEqual(fs.calls, []);
  assert.equal((await policy.authorizeTarget('app', 'notepad', settings, fs)).ok, true);
});

// ---------- validation ----------

test('approved apps and allowed folders reject network and device locations', () => {
  assert.throws(() => validation.validateApprovedApp('\\\\attacker.example\\s\\tool.exe'), /not allowed/);
  assert.throws(() => validation.validateApprovedApp('//./pipe/x.exe'), /not allowed/);
  assert.equal(validation.validateApprovedApp('C:/Tools/tool.exe'), 'C:\\Tools\\tool.exe');
  assert.equal(validation.validateApprovedApp('notepad.exe'), 'notepad.exe');
  const s = baseState().settings;
  assert.throws(() => validation.mergeSettings(s, { allowedRoots: ['\\\\host\\share\\folder'] }), /allowed folder/);
  assert.throws(() => validation.mergeSettings(s, { allowedRoots: ['C:\\'] }), /whole drive/);
  assert.throws(() => validation.mergeSettings(s, { localEndpoint: 'http://192.168.1.5:11434' }), /loopback/);
  assert.throws(() => validation.mergeSettings(s, { localEndpoint: 'https://127.0.0.1' }), /http/);
  assert.equal(validation.mergeSettings(s, { localEndpoint: 'http://localhost:11434/x' }).localEndpoint, 'http://localhost:11434');
});

test('parseState is strict by default, lenient drops invalid permission entries, duplicate ids are rejected', () => {
  const st = baseState();
  st.settings.approvedApps = ['notepad.exe'];
  const raw = JSON.parse(JSON.stringify(st));
  raw.settings.approvedApps = ['\\\\evil\\s\\x.exe', 'notepad.exe'];
  raw.settings.allowedRoots = ['\\\\evil\\s\\f', 'C:\\Docs'];
  assert.throws(() => validation.parseState(raw), /UNC|Network|allowed/i);
  const dropped = [];
  const ok = validation.parseState(raw, { lenient: true, dropped });
  assert.deepEqual(ok.settings.approvedApps, ['notepad.exe']);
  assert.deepEqual(ok.settings.allowedRoots, ['C:\\Docs']);
  assert.equal(dropped.length, 2);
  const note = { id: 'n1', title: 't', body: '', tags: [], updatedAt: '2026-10-01T00:00:00Z' };
  assert.throws(() => validation.parseState({ ...st, notes: [note, note] }), /duplicate id/);
  assert.throws(() => validation.parseState({ ...st, settings: { ...st.settings, bogus: 1 } }), /Unknown setting/);
});

// ---------- policy: mailto (NSR-06), window policy (NSR-07, foreground) ----------

test('mailto links are rebuilt from safe parts; attachments and unknown parameters are rejected', () => {
  const u = (t) => policy.validateOpenUrl(t);
  assert.deepEqual(u('mailto:a@example.com?subject=Hi%20there&body=Hello'), { ok: true, url: 'mailto:a@example.com?subject=Hi%20there&body=Hello' });
  assert.deepEqual(u('mailto:a@example.com,b@example.com?cc=c@example.com&bcc=d@example.com'), { ok: true, url: 'mailto:a@example.com,b@example.com?cc=c@example.com&bcc=d@example.com' });
  assert.equal(u('mailto:a@example.com').url, 'mailto:a@example.com');
  for (const bad of [
    'mailto:a@example.com?attach=C:\\Users\\u\\Documents\\secret.docx', 'mailto:a@example.com?Attachment=C:/x', 'mailto:a@example.com?subject=a&subject=b',
    'mailto:a@example.com?to=b@example.com', 'mailto:not-an-address', 'mailto:?subject=x', 'mailto:a@example.com?cc=nope',
  ]) assert.equal(u(bad).ok, false, bad);
  assert.equal(u('file:///C:/x').ok, false);
  assert.equal(u('https://user:pw@example.com/').ok, false);
  assert.equal(u('https://example.com/a?b=1').url, 'https://example.com/a?b=1');
});

test('checkWindowPolicy: identity, elevation, minimized, foreground', () => {
  const t = 'type-text';
  assert.equal(policy.checkWindowPolicy(win(), t, [1]), null);
  assert.match(policy.checkWindowPolicy(win({ pid: 1 }), t, [1]), /Desktop Companion/);
  assert.match(policy.checkWindowPolicy(win({ elevated: 1 }), t, []), /elevated/);
  assert.match(policy.checkWindowPolicy(win({ elevated: -1 }), t, []), /elevated/);
  assert.match(policy.checkWindowPolicy(win({ process: '' }), t, []), /identified/);
  assert.match(policy.checkWindowPolicy(win({ minimized: true }), 'click', []), /minimized/);
  assert.match(policy.checkWindowPolicy(win({ foreground: false }), t, []), /foreground/);
  assert.equal(policy.checkWindowPolicy(win({ foreground: false }), 'focus', []), null, 'focus does not need foreground');
  // root's preview evaluation: a temporary foreground flag still hits identity/elevation/minimized checks
  assert.equal(policy.checkWindowPolicy({ ...win({ foreground: false }), foreground: true }, t, []), null);
  assert.match(policy.checkWindowPolicy({ ...win({ foreground: false, elevated: 1 }), foreground: true }, t, []), /elevated/);
});

test('line breaks are refused for terminals and the Run dialog, allowed elsewhere', () => {
  for (const proc of ['powershell.exe', 'CMD.EXE', 'WindowsTerminal.exe', 'pwsh.exe', 'conhost.exe', 'wsl.exe', 'mintty.exe']) {
    assert.match(policy.checkWindowPolicy(win({ process: proc }), 'type-text', [], 'Start-Process calc\n'), /line break/, proc);
  }
  assert.match(policy.checkWindowPolicy(win({ process: 'explorer.exe', title: 'Run' }), 'type-text', [], 'calc\r'), /line break/);
  assert.equal(policy.checkWindowPolicy(win({ process: 'powershell.exe' }), 'type-text', [], 'no newline'), null);
  assert.equal(policy.checkWindowPolicy(win(), 'type-text', [], 'line1\nline2'), null);
  assert.equal(policy.describeTypedText('a\nb\tc'), 'a⏎b⇥c');
  assert.equal(policy.describeTypedText('x'.repeat(300)).length, 200);
});

// ---------- netGuard: offline egress and redirects ----------

const CLOUD = 'https://api.anthropic.com';
const EXTERNAL = [
  'https://example.com/x', 'http://example.com:11434/api/chat', 'https://evil.test/v1/messages', 'http://192.168.1.5:11434/api/chat',
  'http://127.0.0.1.evil.test:11434/api/chat', 'http://localhost.evil.test/api/chat', 'ftp://127.0.0.1/x', 'file:///C:/Docs/a.txt', 'not a url',
];

test('offline guard denies every external endpoint, lookalike host and cloud origin', () => {
  for (const url of EXTERNAL) {
    for (const purpose of ['ollama', 'cloud-chat']) assert.ok(netGuard.evaluateEgress(url, purpose, 'offline', true), `offline ${purpose} ${url}`);
  }
  assert.match(netGuard.evaluateEgress(`${CLOUD}/v1/messages`, 'cloud-chat', 'offline', true), /Offline/);
  assert.equal(netGuard.evaluateEgress('http://127.0.0.1:11434/api/chat', 'ollama', 'offline', false), null);
  assert.equal(netGuard.evaluateEgress('http://[::1]:11434/api/tags', 'ollama', 'offline', false), null);
  assert.ok(netGuard.evaluateEgress('http://127.0.0.1:11434/x', 'cloud-chat', 'offline', true), 'loopback is only for the local model');
});

test('online mode still allows only the cloud origin, with a key and for chat', () => {
  assert.equal(netGuard.evaluateEgress(`${CLOUD}/v1/messages`, 'cloud-chat', 'online', true), null);
  assert.match(netGuard.evaluateEgress(`${CLOUD}/v1/messages`, 'cloud-chat', 'online', false), /No cloud API key/);
  assert.ok(netGuard.evaluateEgress(`${CLOUD}/v1/messages`, 'ollama', 'online', true));
  for (const url of ['https://api.anthropic.com.evil.test/v1/messages', 'http://api.anthropic.com/v1/messages', 'https://api.anthropic.com@evil.test/v1/messages', 'https://user:pw@api.anthropic.com/v1/messages', ...EXTERNAL]) {
    assert.ok(netGuard.evaluateEgress(url, 'cloud-chat', 'online', true), url);
  }
});

test('guarded fetch never follows redirects (an allowed host cannot bounce traffic elsewhere) and audits origins only', async () => {
  const seen = [];
  const audit = [];
  const gf = netGuard.createGuardedFetch({
    mode: () => 'offline', hasCloudKey: () => false, audit: (...a) => audit.push(a),
    fetchImpl: async (url, init) => { seen.push({ url, redirect: init.redirect }); return new Response('{}'); },
  });
  await gf('http://127.0.0.1:11434/api/tags', { redirect: 'follow' }, 'ollama');
  assert.deepEqual(seen, [{ url: 'http://127.0.0.1:11434/api/tags', redirect: 'error' }]);
  await assert.rejects(gf('https://example.com/secret?token=abc', {}, 'ollama'), netGuard.NetworkDenied);
  assert.equal(seen.length, 1, 'denied request never reaches fetch');
  assert.deepEqual(audit.map((a) => [a[0], a[1]]), [['allowed', 'http://127.0.0.1:11434'], ['denied', 'https://example.com']]);
  assert.ok(!JSON.stringify(audit).includes('token=abc'), 'audit holds origin only');
});

// ---------- chat: routing, no fallback, honest failures ----------

async function chatFixture({ mode = 'offline', key = null, fetchImpl, revealKey } = {}) {
  const { s, fs } = newStore();
  await s.load();
  if (mode !== 'offline') await s.mutate((d) => { d.settings.mode = mode; });
  const calls = [];
  let revealed = 0;
  const gf = netGuard.createGuardedFetch({
    mode: () => s.snapshot().settings.mode, hasCloudKey: () => key !== null,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
  });
  const secretsMock = { configured: async () => key !== null, reveal: async () => { revealed++; return revealKey === undefined ? key : revealKey; } };
  return { s, fs, calls, deps: { store: s, secrets: secretsMock, fetch: gf }, revealed: () => revealed };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const mustNotFetch = async () => { throw new Error('must not be called'); };

test('online without a key answers with a system message and makes zero local or cloud requests', async () => {
  const f = await chatFixture({ mode: 'online', key: null, fetchImpl: mustNotFetch });
  const reply = await chat.sendChat(f.deps, 'hello');
  assert.equal(reply.source, 'system');
  assert.equal(reply.role, 'assistant');
  assert.match(reply.text, /No cloud API key is configured/);
  assert.match(reply.text, /not sent/);
  assert.doesNotMatch(reply.text, /may have reached/);
  assert.equal(f.calls.length, 0, 'no cloud request and no silent fallback to the local model');
  assert.equal(f.revealed(), 0);
  const saved = f.s.snapshot().chat;
  assert.deepEqual(saved.map((m) => [m.role, m.source]), [['user', 'cloud'], ['assistant', 'system']]);
});

test('an undecryptable stored key fails honestly without any request', async () => {
  const f = await chatFixture({ mode: 'online', key: 'k'.repeat(30), revealKey: null, fetchImpl: mustNotFetch });
  const reply = await chat.sendChat(f.deps, 'hello');
  assert.equal(reply.source, 'system');
  assert.match(reply.text, /could not be decrypted/);
  assert.match(reply.text, /not sent/);
  assert.equal(f.calls.length, 0);
});

test('cloud failures never claim nothing was sent, never fall back to local, and the key stays in the header', async () => {
  const key = 'sk-test-' + 'k'.repeat(30);
  for (const impl of [
    async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); },
    async () => json({ error: { message: 'overloaded' } }, 529),
    async () => json({ content: [] }),
  ]) {
    const f = await chatFixture({ mode: 'online', key, fetchImpl: impl });
    const reply = await chat.sendChat(f.deps, 'private question');
    assert.equal(reply.source, 'system');
    assert.match(reply.text, /^Cloud model unavailable/);
    assert.match(reply.text, /may have reached the cloud provider/);
    assert.doesNotMatch(reply.text, /nothing was sent|not sent/i);
    assert.doesNotMatch(reply.text, new RegExp(key));
    assert.deepEqual(f.calls.map((c) => c.url), [`${CLOUD}/v1/messages`], 'exactly one cloud attempt, no local fallback');
    assert.equal(f.calls[0].init.headers['x-api-key'], key);
    assert.doesNotMatch(f.calls[0].init.body, new RegExp(key));
  }
});

test('a request the guard blocks is reported as not sent', async () => {
  const f = await chatFixture({ mode: 'online', key: 'k'.repeat(30), fetchImpl: mustNotFetch });
  f.deps.cloudOrigin = 'https://elsewhere.example';
  const reply = await chat.sendChat(f.deps, 'hello');
  assert.match(reply.text, /^Cloud model unavailable: Blocked: /);
  assert.match(reply.text, /not sent/);
  assert.equal(f.calls.length, 0);
});

test('offline chat talks only to the loopback model and never touches the cloud, even with a stored key', async () => {
  const f = await chatFixture({ key: 'k'.repeat(30), fetchImpl: async () => json({ message: { content: 'local answer' } }) });
  const reply = await chat.sendChat(f.deps, 'hi');
  assert.deepEqual([reply.source, reply.text], ['local', 'local answer']);
  assert.deepEqual(f.calls.map((c) => c.url), ['http://127.0.0.1:11434/api/chat']);
  assert.equal(f.revealed(), 0, 'key is not even read offline');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.keep_alive, chat.LOCAL_KEEP_ALIVE);
  assert.equal(body.stream, false);
});

test('offline failures give actionable guidance and do not fall back to the cloud', async () => {
  const refused = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const down = await chatFixture({ key: 'k'.repeat(30), fetchImpl: refused });
  const r1 = await chat.sendChat(down.deps, 'hi');
  assert.equal(r1.source, 'system');
  assert.match(r1.text, /Ollama is not running at http:\/\/127\.0\.0\.1:11434/);
  assert.match(r1.text, /not sent to any cloud provider/);
  assert.equal(down.calls.length, 1);
  const missing = await chatFixture({ fetchImpl: async () => json({ error: 'model not found' }, 404) });
  const r2 = await chat.sendChat(missing.deps, 'hi');
  assert.match(r2.text, /ollama pull /);
  assert.match(r2.text, /never downloads models/);
  assert.equal(r2.source, 'system');
});

test('a tampered non-loopback local endpoint is denied before any request', async () => {
  const f = await chatFixture({ fetchImpl: mustNotFetch });
  const settings = { ...f.s.snapshot().settings, localEndpoint: 'https://evil.example' };
  await assert.rejects(chat.ollamaChat(f.deps.fetch, settings, [{ role: 'user', content: 'hi' }]), netGuard.NetworkDenied);
  const cap = await chat.probeLocalModel(f.deps.fetch, settings);
  assert.equal(cap.available, false);
  assert.match(cap.reason, /blocked/i);
  assert.equal(f.calls.length, 0);
});

// ---------- store: atomic writes and import validation ----------

const noTmp = (fs) => ![...fs.files.keys()].some((k) => k.endsWith('.tmp'));

test('a failed write or rename keeps the previous in-memory state and state.json, and leaves no temp file', async () => {
  const { s, fs } = newStore();
  await s.load();
  const note = { id: 'n1', title: 'kept', body: '', tags: [], updatedAt: '2026-10-01T00:00:00Z' };
  await s.mutate((d) => { d.notes.push(note); });
  const before = s.snapshot();
  const fileBefore = fs.files.get(statePath);
  assert.ok(fileBefore.includes('"kept"'));

  fs.failWrite = (p) => p.endsWith('state.json.tmp');
  await assert.rejects(s.mutate((d) => { d.notes.push({ ...note, id: 'n2', title: 'lost' }); }), /Could not save/);
  fs.failWrite = null;
  assert.deepEqual(s.snapshot(), before);
  assert.equal(fs.files.get(statePath), fileBefore);
  assert.ok(noTmp(fs));

  fs.failRename = () => Object.assign(new Error('io'), { code: 'EIO' });
  await assert.rejects(s.mutate((d) => { d.notes.length = 0; }), /Could not save/);
  fs.failRename = null;
  assert.deepEqual(s.snapshot(), before);
  assert.equal(fs.files.get(statePath), fileBefore);
  assert.ok(noTmp(fs), 'temp file cleaned up after a failed rename');

  await s.mutate((d) => { d.notes.push({ ...note, id: 'n3' }); });
  assert.deepEqual(s.snapshot().notes.map((n) => n.id), ['n1', 'n3'], 'queue keeps working after failures');
});

test('a mutation callback that throws changes nothing in memory or on disk', async () => {
  const { s, fs } = newStore();
  await s.load();
  const before = s.snapshot();
  const fileBefore = fs.files.get(statePath);
  await assert.rejects(s.mutate((d) => { d.settings.localModel = 'half-applied'; throw new Error('boom'); }), /boom/);
  assert.deepEqual(s.snapshot(), before);
  assert.equal(fs.files.get(statePath), fileBefore);
});

test('malformed imports and duplicate ids are rejected with no state change, no backup and no write', async () => {
  const { s, fs } = newStore();
  await s.load();
  const note = { id: 'n1', title: 't', body: '', tags: [], updatedAt: '2026-10-01T00:00:00Z' };
  await s.mutate((d) => { d.notes.push(note); });
  const msg = { id: 'm1', role: 'user', text: 'hi', createdAt: '2026-10-01T00:00:00Z', source: 'local' };
  const act = { id: 'a1', at: '2026-10-01T00:00:00Z', kind: 'k', summary: 's' };
  const st = (over) => ({ ...baseState(), ...over });
  const bad = [
    ['not json', '{nope'],
    ['array', '[]'],
    ['null', 'null'],
    ['wrong format', JSON.stringify({ format: 'something-else', schemaVersion: 1, state: baseState() })],
    ['no format', JSON.stringify({ schemaVersion: 1, state: baseState() })],
    ['no schemaVersion', JSON.stringify({ format: 'jarvis-export', state: baseState() })],
    ['zero schemaVersion', exportJson(baseState(), { schemaVersion: 0 })],
    ['newer schemaVersion', exportJson(baseState(), { schemaVersion: 99 })],
    ['missing state', JSON.stringify({ format: 'jarvis-export', schemaVersion: 1 })],
    ['state is a list', exportJson([])],
    ['duplicate note ids', exportJson(st({ notes: [note, { ...note, title: 'other' }] }))],
    ['duplicate chat ids', exportJson(st({ chat: [msg, { ...msg, text: 'again' }] }))],
    ['duplicate activity ids', exportJson(st({ activity: [act, { ...act, summary: 'again' }] }))],
    ['invalid id', exportJson(st({ notes: [{ ...note, id: 'bad id!' }] }))],
    ['unknown setting', exportJson(st({ settings: { ...baseState().settings, bogus: 1 } }))],
    ['bad chat source', exportJson(st({ chat: [{ ...msg, source: 'martian' }] }))],
    ['non-string input', 42],
  ];
  const before = s.snapshot();
  const filesBefore = new Map(fs.files);
  for (const [name, raw] of bad) {
    await assert.rejects(s.importDocument(raw), validation.ValidationError, name);
    assert.deepEqual(s.snapshot(), before, `${name}: memory unchanged`);
    assert.deepEqual([...fs.files], [...filesBefore], `${name}: disk unchanged (no pre-import backup, no state write)`);
  }
});

test('a valid import replaces content but keeps current permissions; a failed save during import rolls back', async () => {
  const { s, fs } = newStore();
  await s.load();
  const noteDoc = (id, title) => ({ id, title, body: '', tags: [], updatedAt: '2026-10-01T00:00:00Z' });
  const incoming = baseState();
  incoming.notes = [noteDoc('imp1', 'imported')];
  incoming.settings.mode = 'online';
  incoming.settings.approvedApps = ['evil.exe'];
  const done = await s.importDocument(exportJson(incoming));
  assert.deepEqual(done.notes.map((n) => n.id), ['imp1']);
  assert.equal(done.settings.mode, 'offline');
  assert.deepEqual(done.settings.approvedApps, []);
  assert.ok([...fs.files.keys()].some((k) => path.basename(k).startsWith('pre-import-')), 'pre-import backup taken');
  assert.match(done.activity.at(-1).details, /Ignored imported permissions/);

  const before = s.snapshot();
  const fileBefore = fs.files.get(statePath);
  fs.failWrite = (p) => p.endsWith('state.json.tmp');
  const other = baseState();
  other.notes = [noteDoc('imp2', 'second')];
  await assert.rejects(s.importDocument(exportJson(other)), /Could not save/);
  fs.failWrite = null;
  assert.deepEqual(s.snapshot(), before);
  assert.equal(fs.files.get(statePath), fileBefore);
});
