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
