// Approved TXT/Markdown documents for the writing workspace. The dialog and filesystem are injected fakes: no real
// user file is read, nothing touches the network. Covers path refusal before I/O, strict UTF-8/size/extension bounds,
// explicit PDF/Word refusal, plain-text preview without paths, review-before-save, token expiry and the IPC boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const out = await build({stdin: {contents: `
  export * as docs from './electron/services/approvedDocuments';
  export {createBackend} from './electron/backend';
  export * as ipcCore from './electron/ipcCore';
  export {METHODS, ARITY} from './electron/channels';
  export {documentsBridge, DOCUMENT_METHODS} from './src/ui/bridges';
`, resolveDir: root, loader: 'ts', sourcefile: 'approved-documents-entry.ts'}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'});
const mod = {exports: {}};
new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
const {docs, createBackend, ipcCore, METHODS, ARITY, documentsBridge, DOCUMENT_METHODS} = mod.exports;

const enc = new TextEncoder();
const DIR = 'C:\\Users\\fixture\\Writing';
const st = (kind, size = 0) => ({isSymbolicLink: () => kind === 'link', isFile: () => kind === 'file', isDirectory: () => kind === 'dir', size});

/** In-memory filesystem: real folders C:\, C:\Users, C:\Users\fixture, DIR; files given as path -> bytes|'link'. */
function fakeFs(files = {}, {grow = false} = {}) {
  const log = {lstat: [], read: []};
  const dirs = new Set(['C:\\', 'C:\\Users', 'C:\\Users\\fixture', DIR]);
  return {log, fs: {
    async lstat(p) {
      log.lstat.push(p);
      if (dirs.has(p)) return st('dir');
      const f = files[p];
      if (f === 'link' || f === 'dirlink') return st('link');
      if (f === 'folder') return st('dir');
      if (f) return st('file', f.length);
      throw Object.assign(new Error('missing'), {code: 'ENOENT'});
    },
    async readBytes(p, max) { log.read.push(p); const b = files[p]; return grow ? new Uint8Array(max + 1) : b.subarray(0, max + 1); },
  }};
}
let n = 0;
const token = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
function service(picked, files, extra = {}) {
  const saved = [];
  const {fs, log} = fakeFs(files, extra);
  let clock = 1000;
  const s = new docs.ApprovedDocuments({dialog: async () => picked, newToken: token, fs, now: () => clock, saveNote: async (note) => { if (extra.rejectTitle && note.title === extra.rejectTitle) throw new Error('title too long'); saved.push(note); }, ...(extra.limits ? {limits: extra.limits} : {})});
  return {s, saved, log, advance: (ms) => { clock += ms; }};
}

test('cancel and unsupported PDF/Word formats read nothing and say so explicitly', async () => {
  const c = service(null, {});
  assert.deepEqual(await c.s.choose(), {status: 'cancelled'});
  assert.equal(c.log.lstat.length + c.log.read.length, 0);
  for (const [file, format] of [['report.pdf', 'PDF'], ['letter.DOCX', 'Word'], ['old.doc', 'Word'], ['notes.rtf', 'Rich Text']]) {
    const u = service(`${DIR}\\${file}`, {});
    const r = await u.s.choose();
    assert.equal(r.status, 'unsupported');
    assert.equal(r.format, format);
    assert.match(r.reason, /not supported yet.*\.txt or \.md/);
    assert.equal(r.name, file, 'only the file name, never the folder');
    assert.equal(u.log.lstat.length + u.log.read.length, 0, `${file} was not touched`);
  }
  const other = service(`${DIR}\\image.png`, {});
  await assert.rejects(other.s.choose(), /Choose a \.txt or \.md document/);
  assert.equal(other.log.lstat.length, 0);
});

test('UNC, device, stream (ADS), relative and dot-dot paths are refused before any filesystem call', async () => {
  for (const p of ['\\\\server\\share\\a.txt', '\\\\?\\C:\\a.txt', '\\\\.\\COM1', `${DIR}\\a.txt:hidden`, `${DIR}\\a.txt::$DATA`, 'a.txt', 'C:a.txt', `${DIR}\\..\\..\\a.txt`, '//server/share/a.md']) {
    const c = service(p, {});
    await assert.rejects(c.s.choose(), /location is not valid/, p);
    assert.equal(c.log.lstat.length + c.log.read.length, 0, `no I/O for ${p}`);
  }
});

test('links or junctions in the folder chain or at the file, folders, missing and oversize files are refused before reading', async () => {
  const junction = service('C:\\Users\\fixture\\Linked\\a.txt', {'C:\\Users\\fixture\\Linked': 'dirlink'});
  await assert.rejects(junction.s.choose(), /does not exist|shortcut link or junction/);
  const linked = service(`${DIR}\\a.txt`, {[`${DIR}\\a.txt`]: 'link'});
  await assert.rejects(linked.s.choose(), /shortcut link or junction/);
  const folder = service(`${DIR}\\notes.md`, {[`${DIR}\\notes.md`]: 'folder'});
  await assert.rejects(folder.s.choose(), /not a file/);
  const missing = service(`${DIR}\\gone.txt`, {});
  await assert.rejects(missing.s.choose(), /does not exist/);
  const big = service(`${DIR}\\big.txt`, {[`${DIR}\\big.txt`]: new Uint8Array(docs.DOCUMENT_LIMITS.maxBytes + 1)});
  await assert.rejects(big.s.choose(), /larger than 100 KB/);
  for (const c of [junction, linked, folder, missing, big]) assert.equal(c.log.read.length, 0, 'nothing was read');
  const grew = service(`${DIR}\\a.txt`, {[`${DIR}\\a.txt`]: enc.encode('small')}, {grow: true});
  await assert.rejects(grew.s.choose(), /changed while it was being read/);
});

test('strict UTF-8: invalid bytes and binary data are refused; BOM, CRLF, control and bidi characters are cleaned', async () => {
  const bad = service(`${DIR}\\a.txt`, {[`${DIR}\\a.txt`]: Uint8Array.from([0x68, 0xff, 0xfe, 0x69])});
  await assert.rejects(bad.s.choose(), /not valid UTF-8/);
  const bin = service(`${DIR}\\a.txt`, {[`${DIR}\\a.txt`]: enc.encode('ab\u0000cd')});
  await assert.rejects(bin.s.choose(), /binary data/);
  const empty = service(`${DIR}\\a.txt`, {[`${DIR}\\a.txt`]: enc.encode('\ufeff  \r\n ')});
  await assert.rejects(empty.s.choose(), /empty/);
  const raw = '\ufeff# Plan \u202eevil\u202c\r\nline\u0007 two\r\n\ttabbed <script>alert(1)</script>';
  const ok = service(`${DIR}\\Plan.MD`, {[`${DIR}\\Plan.MD`]: enc.encode(raw)});
  const r = await ok.s.choose();
  assert.equal(r.status, 'ready');
  assert.equal(r.text, '# Plan evil\nline two\n\ttabbed <script>alert(1)</script>', 'markup stays literal text for a plain-text preview');
  assert.equal(r.format, 'markdown');
  assert.equal(r.suggestedTitle, 'Plan evil');
  assert.equal(r.lines, 3);
  assert.equal(r.bytes, enc.encode(raw).length);
});

test('the preview carries a token and the file name only; nothing is stored until the reviewed preview is saved', async () => {
  const c = service(`${DIR}\\Draft.txt`, {[`${DIR}\\Draft.txt`]: enc.encode('First line\nSecond')}, {rejectTitle: 'x'.repeat(300)});
  const r = await c.s.choose();
  assert.match(r.token, /^[0-9a-f-]{36}$/);
  assert.equal(r.name, 'Draft.txt');
  assert.equal(r.format, 'text');
  assert.ok(!JSON.stringify(r).includes('fixture') && !JSON.stringify(r).includes('Writing'), 'no folder path in the preview');
  assert.equal(c.saved.length, 0, 'choosing stores nothing');
  await assert.rejects(c.s.save(r.token, {title: 'x'.repeat(300)}), /title too long/);
  assert.equal(c.s.pendingCount, 1, 'a rejected save keeps the preview for correction');
  await assert.rejects(c.s.save(r.token, {title: 'ok', path: 'C:\\x'}), /Unknown save option/);
  assert.deepEqual(await c.s.save(r.token, {title: '  Reviewed  '}), {saved: true, title: 'Reviewed'});
  assert.deepEqual(c.saved, [{title: 'Reviewed', body: 'First line\nSecond', tags: ['imported']}]);
  await assert.rejects(c.s.save(r.token), /expired or was already saved/, 'a token is spent once');
  await assert.rejects(c.s.save('not-a-token'), /Invalid preview token/);
});

test('previews expire, are discardable and bounded in number', async () => {
  const file = `${DIR}\\a.md`;
  const c = service(file, {[file]: enc.encode('# A')}, {limits: {maxPending: 2, ttlMs: 1000}});
  const a = await c.s.choose(); const b = await c.s.choose(); const d = await c.s.choose();
  assert.equal(c.s.pendingCount, 2);
  await assert.rejects(c.s.save(a.token), /expired/, 'oldest preview dropped');
  assert.equal(c.s.discard(b.token), true);
  assert.equal(c.s.discard(b.token), false);
  c.advance(1001);
  await assert.rejects(c.s.save(d.token), /expired/);
  assert.equal(c.saved.length, 0);
});

test('IPC: methods are mounted with exact arity; tokens must be 36 characters and options an object from the app', async () => {
  for (const m of DOCUMENT_METHODS) assert.ok(METHODS.includes(m), m);
  assert.deepEqual([ARITY.documentsChoose, ARITY.documentsSave, ARITY.documentsDiscard], [0, 2, 1]);
  const calls = [];
  const handlers = new Proxy({}, {get: (_t, m) => async (...a) => { calls.push([m, a]); return 'ok'; }});
  const APP = 'file:///C:/app/dist/index.html';
  const t = token();
  assert.equal(await ipcCore.dispatch(handlers, 'documentsSave', [t, {title: 'x'}], APP, {appFileUrl: APP}), 'ok');
  assert.equal(await ipcCore.dispatch(handlers, 'documentsChoose', [], APP, {appFileUrl: APP}), 'ok');
  for (const [m, args] of [['documentsChoose', ['C:\\Users\\a.txt']], ['documentsSave', ['short']], ['documentsSave', [t, 'C:\\a.txt']], ['documentsDiscard', [42]]]) {
    await assert.rejects(ipcCore.dispatch(handlers, m, args, APP, {appFileUrl: APP}), /Invalid argument|Wrong number/, `${m} ${JSON.stringify(args)}`);
  }
  await assert.rejects(ipcCore.dispatch(handlers, 'documentsChoose', [], 'https://evil.example/', {appFileUrl: APP}), /untrusted sender/);
  assert.equal(calls.length, 2);
  assert.equal(documentsBridge({}), null, 'missing provider is reported as not connected');
});

test('backend end to end: dialog-chosen Markdown becomes a note only after documentsSave; API info lists the capability', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-docs-'));
  const file = `${DIR}\\Meeting.md`;
  const {fs, log} = fakeFs({[file]: enc.encode('# Meeting\n- decide scope')});
  const dialogCalls = [];
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {listWindows: async () => [], focusWindow: async () => ({focused: true}), typeText: async () => ({typed: 0}), moveWindow: async () => ({}), dpapi: async () => ({ok: true, data: ''})},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    confirm: async () => false,
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null, openFile: async (o) => { dialogCalls.push(o); return file; }},
    documentFs: fs,
    fetchImpl: async () => { throw new Error('no network in tests'); },
  });
  try {
    const bridge = documentsBridge(b);
    assert.ok(bridge);
    const before = (await b.getState()).notes.length;
    const r = await bridge.choose();
    assert.equal(r.status, 'ready');
    assert.deepEqual(dialogCalls[0].filters, [{name: 'Text or Markdown', extensions: ['txt', 'md', 'markdown']}]);
    assert.equal((await b.getState()).notes.length, before, 'no note before review');
    await bridge.saveAsNote(r.token, {title: 'Meeting notes', tags: ['work']});
    const notes = (await b.getState()).notes;
    assert.equal(notes.length, before + 1);
    assert.deepEqual({title: notes.at(-1).title, body: notes.at(-1).body, tags: notes.at(-1).tags}, {title: 'Meeting notes', body: '# Meeting\n- decide scope', tags: ['work']});
    assert.ok(log.read.every((p) => p === file));
    const info = await b.getApiInfo();
    assert.ok(info.features.some((f) => f.id === 'approved-documents' && f.available && /PDF and Word files are not supported/.test(f.reason)));
  } finally {
    await b.dispose();
    await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  }
});
