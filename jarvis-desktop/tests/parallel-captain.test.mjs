// Parallel twenty-team integration (captain): the central glue stays consistent while peer screens land. The IPC method
// table, arity, argument specs and dispatcher agree; every renderer bridge only names real channels and degrades to null
// when the preload lacks them; every navigation entry has a routed screen. Modules are bundled in memory with esbuild and
// imported from a data: URL; icon and React imports are stubbed. No Electron, network, dialogs or user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFile(path.join(root, p), 'utf8');

// Any named import from a stubbed package resolves to a placeholder component.
const stubPackages = {
  name: 'stub-packages',
  setup(b) {
    b.onResolve({filter: /^(@phosphor-icons\/react|react|react\/jsx-runtime)$/}, (a) => ({path: a.path, namespace: 'stub'}));
    b.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'electron-stub'}));
    b.onLoad({filter: /.*/, namespace: 'stub'}, () => ({contents: 'module.exports = new Proxy({}, {get: (_t, k) => k === "__esModule" ? false : () => null});', loader: 'js'}));
    // The preload's Electron surface, recorded on globalThis so the test can read what was exposed and invoked.
    b.onLoad({filter: /.*/, namespace: 'electron-stub'}, () => ({loader: 'js', contents: `const rec = globalThis.__preloadRecord;
      module.exports = {contextBridge: {exposeInMainWorld: (k, v) => { rec.exposed[k] = v; }},
        ipcRenderer: {invoke: async (ch, ...args) => { rec.invoked.push([ch, args]); return null; }, on: () => {}, removeListener: () => {}}};`}));
  },
};

async function load(entry) {
  const r = await build({entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent', plugins: [stubPackages]});
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
}

const APP_URL = 'file:///C:/app/dist/index.html';

test('IPC method table, arity, argument specs and preload agree', async () => {
  const {METHODS, ARITY, channel} = await load('electron/channels.ts');
  const {ARG_SPECS} = await load('electron/ipcCore.ts');
  assert.equal(new Set(METHODS).size, METHODS.length, 'method names are unique');
  assert.deepEqual(Object.keys(ARITY).sort(), [...METHODS].sort(), 'every method has an arity and no stale arity remains');
  assert.deepEqual(Object.keys(ARG_SPECS).sort(), [...METHODS].sort(), 'every method has argument specs');
  for (const m of METHODS) assert.ok(ARG_SPECS[m].length <= ARITY[m], `${m}: specs never accept more than the arity`);
  assert.equal(channel('getState'), 'jarvis:getState');
  // The preload's hand-written table must expose every channel and forward each call to its own channel only.
  const rec = globalThis.__preloadRecord = {exposed: {}, invoked: []};
  await load('electron/preload.ts');
  const api = rec.exposed.jarvis;
  assert.ok(api, 'preload exposes window.jarvis');
  for (const m of METHODS) {
    assert.equal(typeof api[m], 'function', `preload exposes ${m}`);
    rec.invoked.length = 0;
    const args = Array.from({length: ARITY[m]}, (_v, i) => `a${i}`);
    await api[m](...args);
    assert.equal(rec.invoked.length, 1, `${m} makes exactly one IPC call`);
    assert.equal(rec.invoked[0][0], channel(m), `${m} uses its own channel`);
    assert.deepEqual(rec.invoked[0][1], args, `${m} forwards its arguments unchanged`);
  }
  for (const k of Object.keys(api)) assert.ok(METHODS.includes(k) || ['onChatStream', 'onActivity', 'productivity'].includes(k), `no unlisted preload member ${k}`);
});

test('dispatcher rejects untrusted senders, unknown methods and extra arguments before any handler runs', async () => {
  const {dispatch} = await load('electron/ipcCore.ts');
  const calls = [];
  const handlers = {getState: async () => { calls.push('getState'); return {ok: true}; }, deleteNote: async (id) => { calls.push(id); return true; }};
  const opts = {appFileUrl: APP_URL};
  assert.deepEqual(await dispatch(handlers, 'getState', [], APP_URL, opts), {ok: true});
  await assert.rejects(dispatch(handlers, 'getState', [], 'https://example.com/', opts), /untrusted sender/);
  await assert.rejects(dispatch(handlers, 'getState', [], APP_URL, opts, false), /untrusted sender/, 'subframes are rejected');
  await assert.rejects(dispatch(handlers, 'readAnyFile', [], APP_URL, opts), /Unknown method/);
  await assert.rejects(dispatch(handlers, 'getState', [1], APP_URL, opts), /Wrong number of arguments/);
  await assert.rejects(dispatch(handlers, 'deleteNote', [42], APP_URL, opts), /Invalid argument 1/);
  assert.equal(await dispatch(handlers, 'deleteNote', ['n1'], APP_URL, opts), true);
  assert.deepEqual(calls, ['getState', 'n1'], 'only the accepted requests reached a handler');
  const leaked = {getState: async () => { throw new Error('open C:\\Users\\someone\\secret.txt failed'); }};
  await assert.rejects(dispatch(leaked, 'getState', [], APP_URL, opts), (e) => !/someone/.test(e.message) && /%USERPROFILE%/.test(e.message));
});

test('renderer bridges only name real channels and degrade to null without them', async () => {
  const {METHODS} = await load('electron/channels.ts');
  const bridges = await load('src/ui/bridges.ts');
  const lists = Object.entries(bridges).filter(([k, v]) => /_METHODS$/.test(k) && Array.isArray(v));
  assert.ok(lists.length >= 6, 'method lists are exported');
  for (const [name, list] of lists) for (const m of list) assert.ok(METHODS.includes(m), `${name}.${m} is a real IPC channel`);
  const fullApi = Object.fromEntries(METHODS.map((m) => [m, async (...a) => ({m, a})]));
  for (const factory of ['routinesBridge', 'modelsBridge', 'integrationsBridge', 'usageBridge', 'clipboardBridge', 'productivityBridge', 'calendarBridge', 'documentsBridge']) {
    assert.equal(bridges[factory]({}), null, `${factory} is null when the preload lacks its methods`);
    assert.ok(bridges[factory](fullApi), `${factory} binds with the full preload`);
  }
  // Optional calendar file dialog/export are attached only when the preload provides them.
  const {calendarImportFile, calendarExport, ...minimal} = fullApi;
  const cal = bridges.calendarBridge(minimal);
  assert.equal(cal.importFile, undefined);
  assert.equal(cal.exportIcs, undefined);
  assert.deepEqual(await bridges.calendarBridge(fullApi).importIcs('BEGIN:VCALENDAR'), {m: 'calendarImportText', a: ['BEGIN:VCALENDAR']});
});

test('every navigation entry is unique, described and routed to a screen', async () => {
  const {VIEWS} = await load('src/ui/nav.tsx');
  const app = await src('src/components/App.tsx');
  const ids = VIEWS.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length, 'view ids are unique');
  for (const v of VIEWS) {
    assert.ok(v.label && v.group && v.blurb.length > 10, `${v.id} has label, group and blurb`);
    if (v.id !== 'home') assert.match(app, new RegExp(`case '${v.id}':`), `${v.id} has a route in App`);
  }
});

test('IPC errors redact credential-shaped tokens without mangling ordinary messages', async () => {
  const {safeErrorMessage, redactSecrets} = await load('electron/ipcCore.ts');
  const key = 'sk-ant-api03-' + 'Z'.repeat(40);
  for (const [input, secret] of [[`HTTP 401: x-api-key ${key} invalid`, key], ['Authorization: Bearer ' + 'A'.repeat(40), 'A'.repeat(40)], ['token ghp_' + 'b'.repeat(36), 'b'.repeat(36)], ['x-api-key: shortsecret1', 'shortsecret1'], ['api_key=abcdefgh12345678', 'abcdefgh12345678']]) {
    const out = safeErrorMessage(new Error(input));
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.match(out, /\[redacted\]/);
  }
  for (const benign of ['Authorization failed for this provider', 'API key missing', 'Cloud provider returned HTTP 429']) assert.equal(redactSecrets(benign), benign);
  assert.equal(safeErrorMessage('not an error'), 'Request failed');
});

test('backend gives the integrations service the selected local model (read-only installed check)', async () => {
  const backend = await src('electron/backend.ts');
  const call = backend.slice(backend.indexOf('createIntegrationService({'), backend.indexOf('});', backend.indexOf('createIntegrationService({')));
  assert.match(call, /localModel: \(\) => settings\(\)\.localModel,/);
  assert.match(call, /confirm: env\.confirm,/, 'key changes keep the trusted native confirmation');
});

test('calendar: a chosen file goes through the detailed review, and only the normalized selection reaches the import route', async () => {
  const cal = await load('src/components/Calendar.tsx');
  assert.equal(typeof cal.Calendar, 'function');
  const source = await src('src/components/Calendar.tsx');
  assert.match(source, /<Review existing=\{events \?\? \[\]\} source=\{review\} allowPaste=\{false\} onImport=\{runReviewedImport\}/);
  assert.match(source, /const detailed = Review && !p\.error;/, 'read/size errors, or no review from the host, keep the basic preview');
  const app = await src('src/components/App.tsx');
  assert.match(app, /const CalendarImport = lazy\(\(\) => import\('\.\/CalendarImport'\)/, 'the review is its own lazy chunk');
  assert.match(app, /<Calendar api=\{client\} Review=\{CalendarImport\} \/>/);
  assert.match(source, /api\.importIcs\(request\.ics\)/, 'the review sends request.ics, not the raw file text');
  // End to end without Electron: peer review -> renderer bridge -> main-process store parser.
  const imp = await load('src/ui/calendar-import.ts');
  const store = await load('electron/services/calendar.ts');
  const {calendarBridge} = await load('src/ui/bridges.ts');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:weekly@test', 'SUMMARY:Standup', 'DTSTART:20261019T090000Z', 'DTEND:20261019T091500Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const preview = imp.parseIcsForImport(ics, {now: new Date('2026-10-15T00:00:00Z')});
  const built = imp.buildImportRequest(preview, imp.defaultSelection(preview, []), 'weekly.ics', new Date('2026-10-15T00:00:00Z'));
  assert.equal(built.ok, true);
  const sent = [];
  const bridge = calendarBridge({calendarList: async () => [], calendarClear: async () => ({removed: 0}),
    calendarImportText: async (text) => { sent.push(text); const r = store.parseIcs(text); return {added: r.events.length, dropped: 0, total: r.events.length, skipped: r.skipped}; }});
  const r = await bridge.importIcs(built.request.ics);
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /RRULE/, 'recurrence is expanded before it reaches main');
  assert.equal(r.added, 3, 'all three weekly occurrences are stored by the main-process parser');
  assert.equal(store.parseIcs(ics).events.length < 3, true, 'the basic parser alone would not have expanded them');
});
