// Final integration security regressions: window-title capture needs its own native consent, and dialog-chosen
// files are never reached through links/junctions (checked with lstat before any dereference or content I/O).
// Real TypeScript bundled in memory. Injected filesystems model UNC-pointing links without touching a network;
// the one real junction test links two namespaced local temp folders. No SMB, no user files, no desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdir, mkdtemp, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function bundle(contents) {
  const out = await build({stdin: {contents, resolveDir: root, loader: 'ts', sourcefile: 'final-integration-security-entry.ts'}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const {createBackend, readChosenFile, writeChosenFile, chosenLocalPath} = await bundle(`
  export {createBackend} from './electron/backend';
  export {readChosenFile, writeChosenFile, chosenLocalPath} from './electron/services/localFile';
`);

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261014T010000Z', 'SUMMARY:Stand-up', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

async function fixture({decision = false, dialogs = {}, env = {}} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-final-sec-'));
  const log = {confirms: [], fetched: []};
  let answer = decision;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {listWindows: async () => [], focusWindow: async () => ({focused: false}), typeText: async () => { throw new Error('no input in tests'); }, moveWindow: async () => { throw new Error('no input in tests'); }, dpapi: async () => ({ok: true})},
    shell: {spawnApp: async () => { throw new Error('no spawn in tests'); }, openPath: async () => '', openExternal: async () => { throw new Error('no browser in tests'); }},
    confirm: async (summary, detail) => { log.confirms.push({summary, detail}); return answer; },
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null, ...dialogs},
    fetchImpl: async (url) => { log.fetched.push(String(url)); throw new Error('no network in tests'); },
    now: () => new Date('2026-10-14T00:30:00Z'),
    ...env,
  });
  return {b, dir, log, setDecision: (v) => { answer = v; }, async close() { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}

// ---------- timeline window titles ----------

test('keeping window titles needs fresh native consent even when the timeline is already on', async () => {
  const f = await fixture({decision: true});
  try {
    await f.b.productivityApply({op: 'policy.set', timelineEnabled: true});
    assert.equal(f.log.confirms.length, 1);
    assert.doesNotMatch(f.log.confirms[0].detail, /window titles/, 'plain opt-in does not mention titles');

    f.setDecision(false);
    await assert.rejects(f.b.productivityApply({op: 'policy.set', timelineTitles: true}), /Native confirmation declined/);
    assert.equal(f.log.confirms.length, 2, 'false -> true asks again although the timeline is on');
    assert.match(f.log.confirms[1].summary, /window titles/);
    assert.match(f.log.confirms[1].detail, /document names/);
    assert.equal((await f.b.productivityGet()).policy.timelineTitles, false, 'declined consent changes nothing');
    await assert.rejects(f.b.productivityApply({op: 'policy.set', timelineEnabled: true, timelineTitles: true}), /Native confirmation declined/, 'restating enabled does not bypass the titles consent');

    f.setDecision(true);
    await f.b.productivityApply({op: 'policy.set', timelineTitles: true});
    assert.equal((await f.b.productivityGet()).policy.timelineTitles, true);
    const n = f.log.confirms.length;
    await f.b.productivityApply({op: 'policy.set', timelineTitles: true});
    await f.b.productivityApply({op: 'policy.set', timelineTitles: false});
    assert.equal(f.log.confirms.length, n, 'keeping or narrowing needs no dialog');

    f.setDecision(false);
    await assert.rejects(f.b.productivityApply({op: 'policy.set', timelineTitles: true}), /Native confirmation declined/, 'each later false -> true asks again');
    assert.equal((await f.b.productivityGet()).policy.timelineTitles, false);
  } finally { await f.close(); }
});

test('titles while the timeline stays off are not captured and need no dialog; enabling both is one titled consent', async () => {
  const f = await fixture({decision: false});
  try {
    await f.b.productivityApply({op: 'policy.set', timelineTitles: true});
    assert.equal(f.log.confirms.length, 0);
    assert.deepEqual([(await f.b.productivityGet()).policy.timelineEnabled, (await f.b.productivityGet()).policy.timelineTitles], [false, false]);
    await assert.rejects(f.b.productivityApply({op: 'policy.set', timelineEnabled: true, timelineTitles: true}), /Native confirmation declined/);
    assert.equal(f.log.confirms.length, 1);
    assert.match(f.log.confirms[0].detail, /including window titles/);
    f.setDecision(true);
    await f.b.productivityApply({op: 'policy.set', timelineEnabled: true, timelineTitles: true});
    assert.equal(f.log.confirms.length, 2, 'a single consent covers enabling with titles');
    assert.equal((await f.b.productivityGet()).policy.timelineTitles, true);
    await assert.rejects(f.b.productivityApply({op: 'policy.set', timelineTitles: 'yes'}), /true or false/);
  } finally { await f.close(); }
});

// ---------- link-safe chosen files (injected filesystem) ----------

const fileStat = (size = 10) => ({isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size});
const dirStat = () => ({isSymbolicLink: () => false, isFile: () => false, isDirectory: () => true, size: 0});
const linkStat = () => ({isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false, size: 0});
const enoent = () => Object.assign(new Error('ENOENT'), {code: 'ENOENT'});

/** In-memory tree. A link entry stands for a junction to \\server\share; any non-lstat call through it would be a dereference. */
function fakeFs(entries) {
  const calls = [];
  const fs = {
    calls,
    async lstat(p) { calls.push(['lstat', p]); const e = entries[p.toLowerCase()]; if (!e) throw enoent(); return e(); },
    async readFile(p) { calls.push(['readFile', p]); return '\uFEFFhello'; },
    async createFile(p, d) { calls.push(['createFile', p, d.length]); },
    async rename(a, b) { calls.push(['rename', a, b]); },
    async unlink(p) { calls.push(['unlink', p]); },
  };
  return fs;
}
const contentIo = (fs) => fs.calls.filter(([op]) => op !== 'lstat');

test('a junction anywhere in the chosen path is refused with lstat before any content I/O', async () => {
  const fs = fakeFs({'c:\\data': dirStat, 'c:\\data\\share': linkStat, 'c:\\data\\share\\cal.ics': fileStat});
  await assert.rejects(readChosenFile('C:\\data\\share\\cal.ics', {ext: '.ics', maxBytes: 100, what: 'calendar file'}, fs), /link or junction/);
  assert.deepEqual(contentIo(fs), [], 'nothing was read through the link');
  assert.equal(fs.calls.some(([, p]) => p === 'C:\\data\\share\\cal.ics'), false, 'the walk stops at the link and never touches what lies beyond it');

  const leaf = fakeFs({'c:\\data': dirStat, 'c:\\data\\cal.ics': linkStat});
  await assert.rejects(readChosenFile('C:\\data\\cal.ics', {ext: '.ics', maxBytes: 100, what: 'calendar file'}, leaf), /link or junction/);
  assert.deepEqual(contentIo(leaf), []);

  const ok = fakeFs({'c:\\data': dirStat, 'c:\\data\\cal.ics': fileStat});
  assert.equal(await readChosenFile('C:\\data\\CAL.ICS', {ext: '.ics', maxBytes: 100, what: 'calendar file'}, ok), 'hello', 'a real local file is read and its BOM removed');
  await assert.rejects(readChosenFile('C:\\data\\cal.ics', {ext: '.ics', maxBytes: 5, what: 'calendar file'}, ok), /larger than/);
  await assert.rejects(readChosenFile('C:\\data\\missing.ics', {ext: '.ics', maxBytes: 100, what: 'calendar file'}, ok), /does not exist/);
  await assert.rejects(readChosenFile('C:\\data', {maxBytes: 100, what: 'import file'}, ok), /not a file/);
});

test('UNC, WebDAV, device, relative, stream and traversal paths fail before the filesystem is touched', async () => {
  for (const p of ['\\\\server\\share\\cal.ics', '\\\\server@SSL\\DavWWWRoot\\cal.ics', '\\\\?\\C:\\data\\cal.ics', '\\\\.\\PhysicalDrive0', 'cal.ics', 'C:cal.ics', 'C:\\data\\cal.ics:secret', 'C:\\x\\..\\cal.ics', '', 42]) {
    const fs = fakeFs({});
    await assert.rejects(readChosenFile(p, {maxBytes: 100, what: 'calendar file'}, fs), /location is not valid/, String(p));
    await assert.rejects(writeChosenFile(p, 'x', 'export', fs), /location is not valid/, String(p));
    assert.deepEqual(fs.calls, [], `${String(p)} made no filesystem call`);
  }
  assert.equal(chosenLocalPath('c:/data/./cal.ics', 'calendar'), 'c:\\data\\cal.ics', 'a plain drive path is normalized, not resolved');
});

test('exports refuse link parents, link destinations and link temporaries before writing', async () => {
  const parent = fakeFs({'c:\\out': linkStat});
  await assert.rejects(writeChosenFile('C:\\out\\cal.ics', 'data', 'calendar', parent), /link or junction/);
  assert.deepEqual(contentIo(parent), []);

  const dest = fakeFs({'c:\\out': dirStat, 'c:\\out\\cal.ics': linkStat});
  await assert.rejects(writeChosenFile('C:\\out\\cal.ics', 'data', 'calendar', dest), /link or junction/);
  assert.deepEqual(contentIo(dest), []);

  const tmp = fakeFs({'c:\\out': dirStat, 'c:\\out\\cal.ics.tmp': linkStat});
  await assert.rejects(writeChosenFile('C:\\out\\cal.ics', 'data', 'calendar', tmp), /link or junction/);
  assert.deepEqual(contentIo(tmp), [], 'a planted temporary link is not written through');

  const missing = fakeFs({'c:\\out': dirStat});
  await assert.rejects(writeChosenFile('C:\\out\\nested\\cal.ics', 'data', 'calendar', missing), /folder does not exist/);

  const good = fakeFs({'c:\\out': dirStat, 'c:\\out\\cal.ics': fileStat, 'c:\\out\\cal.ics.tmp': fileStat});
  await writeChosenFile('C:\\out\\cal.ics', 'data', 'calendar', good);
  assert.deepEqual(contentIo(good), [['unlink', 'C:\\out\\cal.ics.tmp'], ['createFile', 'C:\\out\\cal.ics.tmp', 4], ['rename', 'C:\\out\\cal.ics.tmp', 'C:\\out\\cal.ics']]);
});

test('backend imports and exports route every chosen path through the link-safe resolver', async () => {
  const fs = fakeFs({'c:\\data': dirStat, 'c:\\data\\share': linkStat});
  let open = 'C:\\data\\share\\cal.ics', save = 'C:\\data\\share\\out';
  const f = await fixture({dialogs: {openFile: async () => open, saveFile: async () => save, openImport: async () => 'C:\\data\\share\\backup.json', saveExport: async () => save, saveUsageExport: async () => save}, env: {localFs: fs}});
  try {
    await assert.rejects(f.b.calendarImportFile(), /link or junction/);
    await assert.rejects(f.b.capsuleReadPack(), /Choose a \.json file/);
    open = 'C:\\data\\share\\pack.json';
    await assert.rejects(f.b.capsuleReadPack(), /link or junction/);
    await assert.rejects(f.b.calendarExport(), /link or junction/);
    await assert.rejects(f.b.exportData(), /link or junction/);
    await assert.rejects(f.b.usageExport('csv'), /link or junction/);
    f.setDecision(true);
    await assert.rejects(f.b.importData(), /link or junction/);
    assert.deepEqual(contentIo(fs), [], 'no read or write reached the filesystem');
    assert.deepEqual(f.log.fetched, []);
  } finally { await f.close(); }
});

// ---------- one real local junction (two namespaced temp folders, never a network target) ----------

test('a real local junction is refused for calendar import and export while the plain path works', async (t) => {
  const f = await fixture();
  const real = path.join(f.dir, 'real');
  const jn = path.join(f.dir, 'jn');
  await mkdir(real);
  try {
    await symlink(real, jn, 'junction');
  } catch (e) {
    await f.close();
    t.skip(`junctions unavailable here: ${e.code}`);
    return;
  }
  try {
    await writeFile(path.join(real, 'cal.ics'), '\uFEFF' + ICS);
    let open = path.join(jn, 'cal.ics'), save = path.join(jn, 'out');
    const g = await createBackendFor(f, () => open, () => save);
    try {
      await assert.rejects(g.calendarImportFile(), /link or junction/);
      await assert.rejects(g.calendarExport(), /link or junction/);
      assert.deepEqual((await readdir(real)).sort(), ['cal.ics'], 'nothing was written through the junction');
      open = path.join(real, 'cal.ics');
      save = path.join(real, 'out');
      assert.equal((await g.calendarImportFile()).imported, true);
      assert.deepEqual(await g.calendarExport(), {saved: true, events: 1});
      assert.deepEqual((await readdir(real)).sort(), ['cal.ics', 'out.ics']);
    } finally { await g.dispose(); }
  } finally { await f.close(); }
});

async function createBackendFor(f, open, save) {
  const dir = path.join(f.dir, 'data');
  await mkdir(dir);
  return createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {listWindows: async () => [], focusWindow: async () => ({focused: false}), typeText: async () => { throw new Error('no input'); }, moveWindow: async () => { throw new Error('no input'); }, dpapi: async () => ({ok: true})},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    confirm: async () => false,
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null, openFile: async () => open(), saveFile: async () => save()},
    fetchImpl: async () => { throw new Error('no network in tests'); },
    now: () => new Date('2026-10-14T00:30:00Z'),
  });
}
