// Data API milestone: productivity sidecar, capsule restore preview/packs, history forgetting and the local .ics calendar,
// wired end to end (IPC specs → preload/bridge shapes → backend → services). Real TypeScript bundled in memory; native,
// shell, dialogs, confirm and fetch are injected. Files live only in namespaced temp folders. No network, no desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm, writeFile, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function bundle(contents) {
  const out = await build({stdin: {contents, resolveDir: root, loader: 'ts', sourcefile: 'milestone-data-api-entry.ts'}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const M = await bundle(`
  export {createBackend, API_FEATURES, parseStoredCalendar, calendarSignals, parsePackRoots, parsePackMappings} from './electron/backend';
  export * as ipcCore from './electron/ipcCore';
  export {METHODS, ARITY} from './electron/channels';
  export {productivityBridge, calendarBridge, PRODUCTIVITY_METHODS, CALENDAR_METHODS} from './src/ui/bridges';
  export {parseIcs} from './electron/services/calendar';
`);
const {createBackend, API_FEATURES, parseStoredCalendar, calendarSignals, parsePackRoots, parsePackMappings, ipcCore, METHODS, ARITY, productivityBridge, calendarBridge, PRODUCTIVITY_METHODS, CALENDAR_METHODS, parseIcs} = M;

const APP = 'file:///C:/app/dist/index.html';
const WIN = {hwnd: 12, pid: 23, process: 'notepad.exe', title: 'Note', x: 10, y: 20, width: 500, height: 400, foreground: true, minimized: false, maximized: false, elevated: 0};
const OWN = {...WIN, hwnd: 99, pid: 999, process: 'desktop-companion.exe', title: 'Desktop Companion'};
const NEW_METHODS = [...PRODUCTIVITY_METHODS, 'calendarList', 'calendarImportText', 'calendarImportFile', 'calendarExport', 'calendarClear'];
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:standup-1', 'DTSTART:20261014T010000Z', 'DTEND:20261014T013000Z', 'SUMMARY:Stand-up', 'LOCATION:Room 4', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:offsite', 'DTSTART;VALUE=DATE:20261020', 'SUMMARY:Offsite', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:weekly', 'DTSTART:20261015T090000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Repeats', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

async function fixture({windows = [WIN, OWN], decision = false, dialogs = {}, env = {}, dir: reuseDir} = {}) {
  const dir = reuseDir ?? await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-data-api-'));
  const log = {confirms: [], fetched: [], spawned: [], dialogs: []};
  let answer = decision;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {listWindows: async () => windows, focusWindow: async () => ({focused: true}), typeText: async () => { throw new Error('no input in tests'); }, moveWindow: async () => { throw new Error('no input in tests'); }, dpapi: async () => ({ok: true})},
    shell: {spawnApp: async (...a) => { log.spawned.push(a); }, openPath: async (...a) => { log.spawned.push(a); return ''; }, openExternal: async (...a) => { log.spawned.push(a); }},
    confirm: async (summary, detail) => { log.confirms.push({summary, detail}); return answer; },
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null, ...dialogs},
    fetchImpl: async (url) => { log.fetched.push(String(url)); throw new Error('no network in tests'); },
    now: () => new Date('2026-10-14T00:30:00Z'),
    ...env,
  });
  return {b, dir, log, setDecision: (v) => { answer = v; }, async close({keep = false} = {}) { await b.dispose(); if (!keep) await rm(dir, {recursive: true, force: true}); }};
}

async function withCapsule(f, extra = {}) {
  const s = await f.b.saveCapsule({name: 'Thesis', description: '', scene: 'graphite', items: [{kind: 'url', target: 'https://example.org/paper', label: 'Paper'}], ...extra});
  return s.capsules.at(-1).id;
}

// ---------- IPC boundary and bridge shapes ----------

test('every new method has an IPC spec, arity, preload binding and a bridge entry', async () => {
  const preload = await readFile(path.join(root, 'electron', 'preload.ts'), 'utf8');
  for (const m of NEW_METHODS) {
    assert.ok(METHODS.includes(m), `${m} is not an IPC method`);
    assert.equal(ipcCore.ARG_SPECS[m].length, ARITY[m], `${m} arity`);
    assert.match(preload, new RegExp(`call\\('${m}'`), `${m} is not exposed by preload`);
  }
  assert.match(preload, /productivityBridge\(flat\)/, 'preload builds window.jarvis.productivity from the flat calls');
  // Paths are chosen in main-process dialogs: no new method takes a file path from the renderer.
  for (const m of ['capsuleReadPack', 'capsuleExportPack', 'calendarImportFile', 'calendarExport']) assert.ok(!ipcCore.ARG_SPECS[m].some((s) => s.kind === 'string' && s.max === 4096), m);
});

test('IPC rejects malformed data API arguments before any handler runs', async () => {
  const calls = [];
  const handlers = Object.fromEntries(METHODS.map((m) => [m, async (...a) => { calls.push([m, a]); return 'ok'; }]));
  const bad = [
    ['productivityApply', [[]]], ['productivityApply', ['forget']], ['productivityApply', []], ['productivityForgetHistory', [null]],
    ['capsulePreviewRestore', ['']], ['capsuleCaptureGeometry', ['c1', ['12']]], ['capsuleCaptureGeometry', ['c1', Array(51).fill(1)]], ['capsuleCaptureGeometry', ['c1']],
    ['capsuleExportPack', ['c1', {name: 'p', path: 'C:\\x'}]], ['capsuleExportPack', ['c1', ['C:\\x']]], ['capsuleExportPack', ['c1', Array(11).fill({})]],
    ['capsuleParsePack', ['', []]], ['capsuleParsePack', ['{}', [1]]], ['capsuleParsePack', ['x'.repeat(1_000_001), []]], ['capsuleReadPack', ['C:\\pack.json']],
    ['calendarImportText', ['']], ['calendarImportText', ['x'.repeat(1_000_001)]], ['calendarImportFile', ['C:\\cal.ics']], ['calendarExport', ['C:\\out.ics']], ['calendarList', [{}]],
  ];
  for (const [m, args] of bad) await assert.rejects(ipcCore.dispatch(handlers, m, args, APP, {appFileUrl: APP}), /Invalid argument|Wrong number/, `${m} ${JSON.stringify(args).slice(0, 60)}`);
  assert.equal(calls.length, 0);
  await ipcCore.dispatch(handlers, 'capsuleCaptureGeometry', ['c1', [12, 13]], APP, {appFileUrl: APP});
  await ipcCore.dispatch(handlers, 'capsuleParsePack', ['{}', [{from: '{ROOT:project}', to: 'D:\\Work'}]], APP, {appFileUrl: APP});
  await assert.rejects(ipcCore.dispatch(handlers, 'productivityGet', [], 'https://evil.example/', {appFileUrl: APP}), /untrusted sender/);
  assert.equal(calls.length, 2);
});

test('productivityBridge matches the store.tsx ProductivityAPI shape and calendarBridge matches the Calendar view client', async () => {
  const seen = [];
  const flat = Object.fromEntries([...PRODUCTIVITY_METHODS, ...CALENDAR_METHODS, 'calendarImportFile', 'calendarExport'].map((m) => [m, async (...a) => { seen.push([m, ...a]); return m === 'calendarList' ? [] : {ok: m}; }]));
  const p = productivityBridge(flat);
  assert.deepEqual(Object.keys(p).sort(), ['apply', 'capsule', 'forgetHistory', 'get', 'signals']);
  assert.deepEqual(Object.keys(p.capsule).sort(), ['captureGeometry', 'exportPack', 'listWindows', 'parsePack', 'previewRestore', 'readPack']);
  await p.apply({op: 'checkpoint.delete', id: 'x'});
  await p.capsule.captureGeometry('c1', [12]);
  await p.capsule.parsePack('{}', []);
  assert.deepEqual(seen.slice(0, 3), [['productivityApply', {op: 'checkpoint.delete', id: 'x'}], ['capsuleCaptureGeometry', 'c1', [12]], ['capsuleParsePack', '{}', []]]);
  const c = calendarBridge(flat);
  assert.deepEqual(await c.list(), []);
  assert.equal(await c.clear(), undefined, 'clear resolves void like CalendarClient.clear');
  await c.importIcs('BEGIN:VCALENDAR');
  assert.equal(typeof c.importFile, 'function');
  assert.equal(typeof c.exportIcs, 'function');
  // Missing backend: both report "not connected" instead of pretending.
  assert.equal(productivityBridge({...flat, capsuleReadPack: undefined}), null);
  assert.equal(calendarBridge({}), null);
  const ids = API_FEATURES.map((f) => f.id);
  for (const id of ['productivity', 'capsule-packs', 'calendar']) assert.ok(ids.includes(id), id);
});

// ---------- Productivity sidecar ----------

test('productivity ops persist across restarts; setMeta needs an existing capsule; deleting a capsule reconciles its meta', async () => {
  const f = await fixture();
  const id = await withCapsule(f);
  await f.b.productivityApply({op: 'capsule.setMeta', capsuleId: id, goals: [{text: 'Draft chapter 2'}]});
  await f.b.productivityApply({op: 'checkpoint.add', title: 'Outline done', capsuleId: id});
  await assert.rejects(f.b.productivityApply({op: 'capsule.setMeta', capsuleId: 'missing', goals: []}), /Capsule not found/);
  await assert.rejects(f.b.productivityApply({op: 'nope'}), /unknown operation/);
  await f.close({keep: true});
  const g = await fixture({dir: f.dir});
  try {
    const s = await g.b.productivityGet();
    assert.equal(s.capsuleMeta[id].goals[0].text, 'Draft chapter 2');
    assert.equal(s.checkpoints[0].title, 'Outline done');
    await g.b.deleteCapsule(id);
    const after = await g.b.productivityGet();
    assert.equal(after.capsuleMeta[id], undefined, 'meta of a deleted capsule is dropped');
    assert.equal(after.checkpoints[0].capsuleId, undefined, 'checkpoint survives but loses the dangling link');
    assert.deepEqual(g.log.fetched, []);
  } finally { await g.close(); }
});

test('forgetting project memory and turning on the timeline need the trusted confirmation', async () => {
  const f = await fixture({decision: false});
  try {
    await f.b.productivityApply({op: 'checkpoint.add', title: 'Keep me'});
    await assert.rejects(f.b.productivityApply({op: 'forget', scope: 'checkpoints'}), /Native confirmation declined/);
    assert.equal((await f.b.productivityGet()).checkpoints.length, 1, 'declined forget changes nothing');
    assert.match(f.log.confirms[0].summary, /Forget saved checkpoints/);
    assert.match(f.log.confirms[0].detail, /cannot be undone/);
    await assert.rejects(f.b.productivityApply({op: 'forget', scope: 'everything'}), /scope is invalid/);
    assert.equal(f.log.confirms.length, 1, 'an invalid scope is refused before any dialog');
    await assert.rejects(f.b.productivityApply({op: 'policy.set', timelineEnabled: true}), /Native confirmation declined/);
    assert.equal((await f.b.productivityGet()).policy.timelineEnabled, false);
    f.setDecision(true);
    await f.b.productivityApply({op: 'policy.set', timelineEnabled: true});
    assert.equal((await f.b.productivityGet()).policy.timelineEnabled, true);
    const n = f.log.confirms.length;
    await f.b.productivityApply({op: 'policy.set', timelineEnabled: false});
    assert.equal(f.log.confirms.length, n, 'turning it off needs no dialog');
    await f.b.productivityApply({op: 'forget', scope: 'checkpoints'});
    assert.equal((await f.b.productivityGet()).checkpoints.length, 0);
  } finally { await f.close(); }
});

test('forgetHistory is validated, confirmed natively and reports counts', async () => {
  const f = await fixture({decision: false});
  try {
    await f.b.store.mutate((d) => { d.chat.push({id: 'm1', role: 'user', text: 'hello', createdAt: '2026-10-13T00:00:00.000Z', source: 'local'}); });
    await assert.rejects(f.b.productivityForgetHistory({}), /at least one|chat|activity/i);
    await assert.rejects(f.b.productivityForgetHistory({chat: true}), /Native confirmation declined/);
    assert.equal((await f.b.getState()).chat.length, 1);
    assert.match(f.log.confirms.at(-1).summary, /Forget chat messages/);
    f.setDecision(true);
    const r = await f.b.productivityForgetHistory({chat: true});
    assert.deepEqual(r, {removed: {chat: 1, activity: 0}});
    assert.equal((await f.b.getState()).chat.length, 0);
  } finally { await f.close(); }
});

test('reminderTasks applies a snooze from the sidecar; deleting the task drops its reminder state', async () => {
  const f = await fixture();
  try {
    const t = (await f.b.saveTask({title: 'Send draft', due: '2026-10-14T01:00:00.000Z'})).tasks.at(-1);
    await f.b.productivityApply({op: 'reminder.snooze', taskId: t.id, due: t.due, until: '2026-10-14T02:00:00.000Z'});
    assert.equal(f.b.reminderTasks().find((x) => x.id === t.id).due, '2026-10-14T02:00:00.000Z');
    await f.b.deleteTask(t.id);
    assert.equal((await f.b.productivityGet()).reminders.length, 0);
  } finally { await f.close(); }
});

// ---------- Capsule tools ----------

test('restore preview is a dry run; window list excludes our own windows; safe launch reads no windows', async () => {
  const f = await fixture();
  try {
    const id = await withCapsule(f, {windows: [{title: 'Note', process: 'notepad.exe', x: 0, y: 0, width: 300, height: 200}]});
    const p = await f.b.capsulePreviewRestore(id);
    assert.equal(p.capsule, 'Thesis');
    assert.equal(p.items.length, 1);
    assert.equal(p.windows.length, 1);
    assert.deepEqual(f.log.spawned, [], 'preview opens nothing');
    assert.equal(f.log.confirms.length, 0, 'preview asks nothing');
    assert.deepEqual(await f.b.capsuleListWindows(), [{hwnd: 12, title: 'Note', process: 'notepad.exe'}]);
    await assert.rejects(f.b.capsulePreviewRestore('missing'), /not found/);
  } finally { await f.close(); }
  const s = await fixture({env: {safeLaunch: () => true}});
  try {
    const id = await withCapsule(s, {windows: [{title: 'Note', process: 'notepad.exe', x: 0, y: 0, width: 300, height: 200}]});
    await assert.rejects(s.b.capsuleListWindows(), /Safe launch/);
    await assert.rejects(s.b.capsuleCaptureGeometry(id, [12]), /Safe launch/);
    const p = await s.b.capsulePreviewRestore(id);
    assert.match(p.windowsError, /Safe launch/);
  } finally { await s.close(); }
});

test('captureGeometry saves only chosen, restorable windows through the validated capsule save', async () => {
  const minimized = {...WIN, hwnd: 13, minimized: true};
  const f = await fixture({windows: [WIN, minimized, OWN]});
  try {
    const id = await withCapsule(f);
    await assert.rejects(f.b.capsuleCaptureGeometry(id, [1.5]), /positive whole numbers/);
    await assert.rejects(f.b.capsuleCaptureGeometry('missing', [12]), /not found/);
    const r = await f.b.capsuleCaptureGeometry(id, [12, 13, 99, 404]);
    assert.equal(r.saved, 1);
    assert.equal(r.skipped.length, 3);
    assert.ok(r.skipped.every((x) => typeof x.reason === 'string' && !('hwnd' in x)));
    const cap = (await f.b.getState()).capsules.find((c) => c.id === id);
    assert.deepEqual(cap.windows, [{title: 'Note', process: 'notepad.exe', x: 10, y: 20, width: 500, height: 400}]);
    assert.equal(cap.items.length, 1, 'other capsule fields are kept');
    const none = await f.b.capsuleCaptureGeometry(id, [404]);
    assert.equal(none.saved, 0);
    assert.equal((await f.b.getState()).capsules.find((c) => c.id === id).windows.length, 1, 'an empty capture does not wipe saved windows');
  } finally { await f.close(); }
});

test('capsule packs: export through the save dialog with root tokens; read is bounded, typed and path-checked; parse saves nothing', async () => {
  let saveTo = null, openFrom = null;
  const f = await fixture({dialogs: {saveFile: async (name, o) => { f.log.dialogs.push(['save', name, o.filters[0].extensions]); return saveTo; }, openFile: async (o) => { f.log.dialogs.push(['open', o.filters[0].extensions]); return openFrom; }}});
  try {
    const id = await withCapsule(f, {items: [{kind: 'folder', target: 'D:\\Work\\Thesis\\figures', label: 'Figures'}, {kind: 'file', target: 'C:\\Elsewhere\\notes.txt', label: 'Notes'}]});
    await f.b.productivityApply({op: 'capsule.setMeta', capsuleId: id, goals: [{text: 'Submit'}]});
    assert.deepEqual(await f.b.capsuleExportPack(id, []), {saved: false, unmapped: ['D:\\Work\\Thesis\\figures', 'C:\\Elsewhere\\notes.txt']}, 'cancel saves nothing');
    await assert.rejects(f.b.capsuleExportPack(id, [{name: 'bad name', path: 'D:\\Work'}]), /name may use/);
    await assert.rejects(f.b.capsuleExportPack(id, [{name: 'p', path: '\\\\server\\share'}]), /Network|UNC/);
    await assert.rejects(f.b.capsuleExportPack(id, [{name: 'p', path: 'D:\\Work', extra: 'x'}]), /unknown field/);
    saveTo = '\\\\server\\share\\pack.json';
    await assert.rejects(f.b.capsuleExportPack(id, []), /location is not valid/);
    saveTo = path.join(f.dir, 'thesis-pack');
    const r = await f.b.capsuleExportPack(id, [{name: 'project', path: 'D:\\Work\\Thesis'}]);
    assert.deepEqual(r, {saved: true, unmapped: ['C:\\Elsewhere\\notes.txt']});
    const text = await readFile(`${saveTo}.json`, 'utf8');
    const doc = JSON.parse(text);
    assert.equal(doc.capsules[0].items[0].target, '{ROOT:project}\\figures');
    assert.deepEqual(doc.capsules[0].goals, ['Submit']);
    assert.deepEqual(f.log.dialogs[0], ['save', 'capsule-thesis.json', ['json']]);

    assert.equal(await f.b.capsuleReadPack(), null, 'cancelled open returns null');
    openFrom = path.join(f.dir, 'pack.txt');
    await writeFile(openFrom, text);
    await assert.rejects(f.b.capsuleReadPack(), /Choose a \.json file/);
    openFrom = path.join(f.dir, 'huge.json');
    await writeFile(openFrom, 'x'.repeat(1_000_001));
    await assert.rejects(f.b.capsuleReadPack(), /larger than/);
    openFrom = `${saveTo}.json`;
    const raw = await f.b.capsuleReadPack();
    assert.equal(raw, text);

    const before = (await f.b.getState()).capsules.length;
    const unmapped = await f.b.capsuleParsePack(raw, []);
    assert.deepEqual(unmapped.roots, ['project']);
    const mapped = await f.b.capsuleParsePack(raw, [{from: '{ROOT:project}', to: 'E:\\Restored'}]);
    assert.equal(mapped.capsules[0].items.find((i) => i.kind === 'folder').target, 'E:\\Restored\\figures');
    const unsafe = await f.b.capsuleParsePack(raw, [{from: '{ROOT:project}', to: '\\\\server\\share'}]);
    assert.ok(unsafe.skipped.length >= 1 && !unsafe.capsules[0].items.some((i) => i.target.startsWith('\\\\')), 'a UNC mapping target is never accepted');
    await assert.rejects(f.b.capsuleParsePack(raw, [{from: 'a'}]), /to is required/);
    await assert.rejects(f.b.capsuleParsePack('not json', []), /not valid JSON/);
    assert.equal((await f.b.getState()).capsules.length, before, 'parsing never saves a capsule');
    assert.deepEqual(f.log.fetched, []);
  } finally { await f.close(); }
});

// ---------- Calendar ----------

test('calendar import re-parses in main, merges, persists, shares signals and never fetches', async () => {
  const f = await fixture();
  try {
    const r = await f.b.calendarImportText(ICS);
    assert.deepEqual({added: r.added, dropped: r.dropped, total: r.total}, {added: 2, dropped: 0, total: 2});
    assert.deepEqual(r.skipped, [{code: 'unsupported-recurrence', count: 1}]);
    const again = await f.b.calendarImportText(ICS);
    assert.equal(again.added, 0, 'reimport updates instead of duplicating');
    const bad = await f.b.calendarImportText('hello');
    assert.equal(bad.error, 'not-calendar');
    assert.equal(bad.total, 2, 'a rejected file leaves the store unchanged');
    const list = await f.b.calendarList();
    list[0].title = 'mutated';
    assert.notEqual((await f.b.calendarList())[0].title, 'mutated', 'list returns copies');
    const sig = await f.b.productivitySignals();
    assert.deepEqual(sig.map((s) => [s.source, s.title, s.at]), [['calendar', 'Stand-up', '2026-10-14T01:00:00.000Z'], ['calendar', 'Offsite', '2026-10-20T00:00:00']]);
    assert.equal(sig[0].text, 'Room 4');
    assert.deepEqual(f.log.fetched, []);
  } finally { await f.close({keep: true}); }
  const g = await fixture({dir: f.dir});
  try {
    assert.equal((await g.b.calendarList()).length, 2, 'events persist across restarts');
    assert.deepEqual(await g.b.calendarClear(), {removed: 2});
    assert.deepEqual(await g.b.calendarList(), []);
  } finally { await g.close(); }
});

test('calendar file import/export use main dialogs, check type, size and path, and round-trip', async () => {
  let openFrom = null, saveTo = null;
  const f = await fixture({dialogs: {openFile: async () => openFrom, saveFile: async () => saveTo}});
  try {
    assert.deepEqual(await f.b.calendarImportFile(), {imported: false, added: 0, dropped: 0, total: 0, skipped: []});
    openFrom = path.join(f.dir, 'cal.txt');
    await writeFile(openFrom, ICS);
    await assert.rejects(f.b.calendarImportFile(), /Choose a \.ics file/);
    openFrom = path.join(f.dir, 'big.ics');
    await writeFile(openFrom, 'x'.repeat(1_000_001));
    await assert.rejects(f.b.calendarImportFile(), /larger than/);
    openFrom = 'C:\\x\\..\\cal.ics';
    await assert.rejects(f.b.calendarImportFile(), /location is not valid/);
    openFrom = path.join(f.dir, 'cal.ics');
    await writeFile(openFrom, '\uFEFF' + ICS);
    const r = await f.b.calendarImportFile();
    assert.equal(r.imported, true);
    assert.equal(r.total, 2);
    assert.equal(JSON.stringify(r).includes(f.dir), false, 'no path is returned to the renderer');
    assert.deepEqual(await f.b.calendarExport(), {saved: false, events: 2});
    saveTo = path.join(f.dir, 'out');
    assert.deepEqual(await f.b.calendarExport(), {saved: true, events: 2});
    const exported = await readFile(`${saveTo}.ics`, 'utf8');
    const back = parseIcs(exported);
    assert.deepEqual(back.events.map((e) => e.title), ['Stand-up', 'Offsite']);
    await assert.rejects(stat(`${saveTo}.ics.tmp`), /ENOENT/);
  } finally { await f.close(); }
});

test('stored calendar data is validated on load and damaged entries are dropped and counted', async () => {
  const good = parseIcs(ICS).events[0];
  const r = parseStoredCalendar({version: 1, events: [good, {...good, start: 'tomorrow'}, {...good, url: 'javascript:alert(1)'}, {...good, title: 'x'.repeat(1001)}, 'junk']});
  assert.equal(r.events.length, 1);
  assert.equal(r.rejected, 4);
  assert.deepEqual(parseStoredCalendar(null), {events: [], rejected: 0});
  assert.deepEqual(parseStoredCalendar({version: 2, events: [good]}), {events: [], rejected: 1});
  assert.deepEqual(calendarSignals([good], Date.parse('2027-06-01T00:00:00Z')), [], 'signals are limited to a window around now');
  assert.deepEqual(parsePackRoots([{name: 'p', path: 'D:/Work/'}]), [{name: 'p', path: 'D:\\Work'}]);
  assert.throws(() => parsePackMappings([{from: 'a', to: 'b', extra: '1'}]), /unknown field/);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-data-api-'));
  await writeFile(path.join(dir, 'calendar.json'), JSON.stringify({version: 1, events: [good, {...good, allDay: 'yes'}]}));
  const f = await fixture({dir});
  try {
    assert.equal((await f.b.calendarList()).length, 1);
    assert.ok((await f.b.getState()).activity.some((a) => a.kind === 'calendar' && /1 stored calendar event/.test(a.summary)));
  } finally { await f.close(); }
});
