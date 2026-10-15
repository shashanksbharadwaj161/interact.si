// Central API/IPC tests: strict IPC argument shapes, the v2 backend adapters (intent planner, search, local models,
// API info), the assistant intent → preview → native approval → outcome flow, and the renderer flow helpers.
// Everything runs against the real TypeScript sources bundled in memory, with injected native/shell/fetch/confirm mocks:
// no real desktop input, no network, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function bundle(contents, extra = {}) {
  const out = await build({stdin: {contents, resolveDir: root, loader: 'ts', sourcefile: 'autopilot-api-entry.ts'}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', ...extra});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles.find((f) => !f.path.endsWith('.css')).text)(require, mod, mod.exports);
  return mod.exports;
}

const backendMod = await bundle(`
  export {createBackend, API_FEATURES, API_VERSION, parseModelTags} from './electron/backend';
  export * as ipcCore from './electron/ipcCore';
  export {METHODS, ARITY} from './electron/channels';
`);
// Renderer helpers: icons are inert (never rendered here) and stylesheets are ignored.
const uiMod = await bundle(`
  export {planCommand, previewCommand, decideCommand, planChoices, PLANNER_UNAVAILABLE, MAX_COMMAND_CHARS as UI_MAX_COMMAND_CHARS} from './src/components/Assistant';
  export {formFromRequest, SCREEN_FEATURES} from './src/components/Computer';
  export {buildAction} from './src/ui/action-result';
  export {MAX_COMMAND_CHARS} from './electron/services/intent';
`, {
  jsx: 'automatic',
  loader: {'.css': 'empty'},
  plugins: [{name: 'icon-stub', setup(b) {
    b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
    b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: 'module.exports = {};', loader: 'js'}));
  }}],
});

const {createBackend, API_FEATURES, API_VERSION, parseModelTags, ipcCore, METHODS, ARITY} = backendMod;
const APP = 'file:///C:/app/dist/index.html';
const opts = {appFileUrl: APP};

// ---------- IPC boundary ----------

function spyHandlers() {
  const calls = [];
  const handlers = Object.fromEntries(METHODS.map((m) => [m, async (...a) => { calls.push([m, a]); return 'ok'; }]));
  return {handlers, calls};
}

test('every IPC method has an argument spec matching its arity and a preload binding', async () => {
  const preload = await readFile(path.join(root, 'electron', 'preload.ts'), 'utf8');
  for (const m of METHODS) {
    assert.ok(Array.isArray(ipcCore.ARG_SPECS[m]), `${m} has no argument spec`);
    assert.equal(ipcCore.ARG_SPECS[m].length, ARITY[m], `${m} arity`);
    assert.match(preload, new RegExp(`call\\('${m}'`), `${m} is not exposed by preload`);
  }
  for (const m of ['getApiInfo', 'planIntent', 'search', 'listLocalModels']) assert.ok(METHODS.includes(m));
  // Secrets stay write-only across the bridge: no method returns or reveals the key.
  assert.ok(!METHODS.some((m) => /getCloudKey|revealKey|readKey/i.test(m)));
});

test('IPC rejects wrongly typed, missing or oversized arguments before any handler runs', async () => {
  const {handlers, calls} = spyHandlers();
  const bad = [
    ['executeAction', ['p1', 'true']], ['executeAction', ['p1', 1]], ['executeAction', ['p1']], ['executeAction', [5, true]], ['executeAction', ['', true]],
    ['chat', []], ['chat', [123]], ['chat', ['x'.repeat(16 * 1024 + 1)]],
    ['deleteNote', [{}]], ['deleteNote', ['x'.repeat(65)]], ['restoreCapsule', [null]],
    ['pickPath', ['drive']], ['pickPath', []],
    ['saveSettings', [[]]], ['saveSettings', [null]], ['saveSettings', ['mode=online']], ['previewAction', [new Date()]], ['previewAction', [['launch']]],
    ['transcribe', ['abc']], ['transcribe', [[1, 'a']]], ['transcribe', [[1, Number.NaN]]],
    ['setCloudKey', ['']], ['setCloudKey', [{key: 'x'}]], ['speak', ['x'.repeat(4001)]],
    ['planIntent', [5]], ['planIntent', ['list windows', 'model']], ['planIntent', ['list windows', []]], ['planIntent', ['x'.repeat(2201)]],
    ['search', ['q', null]], ['search', [{q: 1}]], ['getApiInfo', ['x']], ['listLocalModels', [{}]],
    // v2.1 adapters
    ['routinesSave', [[]]], ['routinesSave', ['{}']], ['routinesStart', ['']], ['routinesUndo', [7]], ['routinesPlanText', [{}]], ['routinesList', [1]],
    ['modelsSetProfile', ['turbo']], ['modelsUnload', [5]], ['modelsSelect', ['m', 'warm']], ['modelsStartPull', ['']], ['modelsValidatePack', ['x'.repeat(4097)]],
    ['integrationsSetKey', ['anthropic']], ['integrationsSetEnabled', ['anthropic', 1]], ['integrationsCheck', [null]],
    ['usageExport', ['xml']], ['usageSetPrices', [[]]], ['usageSetBudget', [null]],
    ['clipboardSetEnabled', ['yes']], ['clipboardGet', [{}]], ['systemResources', ['now']],
  ];
  for (const [m, args] of bad) await assert.rejects(ipcCore.dispatch(handlers, m, args, APP, opts), /Invalid argument|Wrong number/, `${m}(${JSON.stringify(args).slice(0, 60)})`);
  assert.equal(calls.length, 0);
});

test('IPC accepts valid shapes, treats undefined optional arguments as absent, and still checks the sender first', async () => {
  const {handlers, calls} = spyHandlers();
  await ipcCore.dispatch(handlers, 'planIntent', ['list windows'], APP, opts);
  await ipcCore.dispatch(handlers, 'planIntent', ['list windows', undefined], APP, opts);
  await ipcCore.dispatch(handlers, 'planIntent', ['x', {useLocalModel: true}], APP, opts);
  await ipcCore.dispatch(handlers, 'search', ['notes', {limit: 3}], APP, opts);
  await ipcCore.dispatch(handlers, 'executeAction', ['p1', false], APP, opts);
  await ipcCore.dispatch(handlers, 'transcribe', [[82, 73, 70, 70]], APP, opts);
  await ipcCore.dispatch(handlers, 'pickPath', ['folder'], APP, opts);
  assert.deepEqual(calls.map(([m]) => m), ['planIntent', 'planIntent', 'planIntent', 'search', 'executeAction', 'transcribe', 'pickPath']);
  await assert.rejects(ipcCore.dispatch(handlers, 'planIntent', ['list windows'], 'https://evil.example/', opts), /untrusted sender/);
  await assert.rejects(ipcCore.dispatch(handlers, 'planIntent', ['list windows'], APP, opts, false), /untrusted sender/);
  assert.equal(calls.length, 7);
  assert.equal(ipcCore.validateArgs('search', ['q', undefined]), null);
  assert.match(ipcCore.validateArgs('executeAction', ['id', 'yes']), /argument 2 for executeAction: expected true or false/);
});

// ---------- Backend fixture ----------

const WIN = {hwnd: 12, pid: 23, process: 'notepad.exe', title: 'Note', x: 0, y: 0, width: 500, height: 500, foreground: true, minimized: false, maximized: false, elevated: 0};

async function fixture({windows = [WIN], fetchImpl, confirm, dir: reuseDir, dialogs, env = {}, nativeExtra = {}} = {}) {
  const dir = reuseDir ?? await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-api-'));
  const log = {typed: [], focused: [], moved: [], spawned: [], fetched: [], confirms: []};
  const native = {
    listWindows: async () => windows,
    focusWindow: async (t) => { log.focused.push(t); return {focused: true}; },
    typeText: async (...a) => { log.typed.push(a); return {typed: 1}; },
    moveWindow: async (...a) => { log.moved.push(a); return {}; },
    dpapi: async () => ({ok: true}),
    ...nativeExtra,
  };
  const shell = {spawnApp: async (...a) => { log.spawned.push(a); }, openPath: async () => '', openExternal: async (...a) => { log.spawned.push(a); }};
  let decision = false;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, native, shell, selfPids: () => [999],
    confirm: confirm ?? (async (summary, detail) => { log.confirms.push({summary, detail}); return decision; }),
    dialogs: dialogs ?? {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    fetchImpl: async (url, init) => {
      log.fetched.push({url: String(url), body: init?.body});
      if (!fetchImpl) throw new Error('no network in tests');
      return fetchImpl(String(url), init);
    },
    ...env,
  });
  return {b, dir, log, native, setDecision: (v) => { decision = v; }, async close({keep = false} = {}) { await b.dispose(); if (!keep) await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }};
}

const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

// ---------- v2 adapters ----------

test('getApiInfo reports implemented features (including streaming and cancel) and marks screen reading, automatic input and unconnected clipboard unavailable', async () => {
  const f = await fixture();
  try {
    const info = await f.b.getApiInfo();
    assert.equal(info.apiVersion, API_VERSION);
    const byId = Object.fromEntries(info.features.map((x) => [x.id, x]));
    for (const id of ['ocr', 'intent-planner', 'search', 'local-models', 'intent-model-assist', 'routines', 'integrations', 'model-runtime', 'usage-ledger', 'resource-monitor', 'chat-streaming', 'chat-cancel']) assert.equal(byId[id].available, true, id);
    assert.match(byId['chat-cancel'].reason, /upstream/);
    for (const id of ['region-capture', 'vision', 'automatic-input', 'clipboard-history']) {
      assert.equal(byId[id].available, false, id);
      assert.ok(byId[id].reason.length > 10, `${id} explains why`);
    }
    info.features[0].available = false;
    assert.equal((await f.b.getApiInfo()).features[0].available, true, 'callers get a copy');
    assert.equal(API_FEATURES.length, info.features.length);
  } finally { await f.close(); }
});

test('planIntent: rule plans, window snapshot pinning and ambiguity, no network and no actions', async () => {
  const windows = [WIN, {...WIN, hwnd: 13, title: 'notes.txt - Notepad'}, {...WIN, hwnd: 14, pid: 999, title: 'Desktop Companion', process: 'electron.exe'}];
  const f = await fixture({windows});
  try {
    assert.deepEqual(await f.b.planIntent('list windows'), {status: 'ready', source: 'rules', request: {type: 'list-windows'}, summary: 'List visible windows (titles, process names and positions only)', previewOnly: true});
    const amb = await f.b.planIntent('focus note');
    assert.equal(amb.status, 'clarify');
    assert.deepEqual(amb.candidates.map((c) => c.request.target), ['hwnd:12', 'hwnd:13']);
    const pinned = await f.b.planIntent('focus "notes.txt - Notepad"');
    assert.deepEqual(pinned.request, {type: 'focus', target: 'hwnd:13'});
    // The app's own window is excluded from the planning snapshot.
    assert.equal((await f.b.planIntent('focus "Desktop Companion"')).status, 'clarify');
    assert.equal((await f.b.planIntent('please delete everything')).status, 'blocked');
    assert.equal(f.log.fetched.length, 0);
    assert.deepEqual([f.log.typed, f.log.focused, f.log.moved, f.log.spawned, f.log.confirms], [[], [], [], [], []]);
    await assert.rejects(f.b.planIntent('list windows', {useLocalModel: 'yes'}), /true or false/);
    await assert.rejects(f.b.planIntent('list windows', {execute: true}), /unknown option/);
    await assert.rejects(f.b.planIntent(42), /command must be text/);
  } finally { await f.close(); }
});

test('planIntent model assist: loopback local model only, strictly parsed, and only for unrecognized commands', async () => {
  let reply = '{"type":"open-url","target":"https://example.com/docs"}';
  const f = await fixture({fetchImpl: async () => json({message: {content: reply}})});
  try {
    const p = await f.b.planIntent('show me the docs site', {useLocalModel: true});
    assert.equal(p.status, 'ready');
    assert.equal(p.source, 'model');
    assert.deepEqual(p.request, {type: 'open-url', target: 'https://example.com/docs'});
    assert.equal(f.log.fetched.length, 1);
    const call = f.log.fetched[0];
    assert.match(call.url, /^http:\/\/(127\.0\.0\.1|localhost):\d+\/api\/chat$/);
    const body = JSON.parse(call.body);
    assert.equal(body.stream, false);
    assert.match(body.messages[0].content, /Command: "show me the docs site"/);

    reply = '{"type":"launch","target":"cmd.exe","args":"/c del"}';
    const bad = await f.b.planIntent('do the cleanup thing', {useLocalModel: true});
    assert.equal(bad.status, 'blocked');
    assert.equal(bad.source, 'model');

    reply = '{"type":"click","x":1,"y":2}';
    assert.equal((await f.b.planIntent('press the button', {useLocalModel: true})).status, 'blocked');

    // Commands the rules block for safety (chains) never reach the model; recognized commands do not either.
    const before = f.log.fetched.length;
    assert.equal((await f.b.planIntent('list windows then launch "x.exe"', {useLocalModel: true})).status, 'blocked');
    assert.equal((await f.b.planIntent('list windows', {useLocalModel: true})).source, 'rules');
    assert.equal((await f.b.planIntent('show me the docs site')).status, 'blocked', 'no model unless asked');
    assert.equal(f.log.fetched.length, before);
    assert.ok(f.log.fetched.every((c) => !/anthropic|https:/.test(c.url)));
    assert.deepEqual([f.log.spawned, f.log.confirms], [[], []]);
  } finally { await f.close(); }
});

test('planIntent model assist reports an unreachable local model honestly', async () => {
  const f = await fixture();
  try {
    const p = await f.b.planIntent('show me the docs site', {useLocalModel: true});
    assert.equal(p.status, 'blocked');
    assert.equal(p.summary, 'Local model unavailable');
    assert.match(p.reason, /Nothing will run/);
  } finally { await f.close(); }
});

test('search ranks stored notes and tasks, excludes chat by default and validates options', async () => {
  const f = await fixture();
  try {
    await f.b.saveNote({title: 'Quarterly budget', body: 'Draft numbers for the budget review', tags: ['finance']});
    await f.b.saveTask({title: 'Send budget to Sam'});
    await f.b.saveNote({title: 'Groceries', body: 'eggs', tags: []});
    const r = await f.b.search('budget');
    assert.deepEqual(r.map((x) => x.category).sort(), ['note', 'task']);
    assert.ok(r.every((x) => x.relevance > 0 && x.relevance <= 1));
    assert.equal((await f.b.search('budget', {limit: 1})).length, 1);
    assert.deepEqual(await f.b.search('   '), []);
    for (const bad of [{limit: 0}, {limit: 51}, {limit: 1.5}, {includeChat: 'yes'}, {sort: 'date'}]) await assert.rejects(f.b.search('budget', bad), /Search options/);
    await assert.rejects(f.b.search(['budget']), /query must be text/);
  } finally { await f.close(); }
});

test('listLocalModels parses the local tag list and fails honestly; only the loopback endpoint is contacted', async () => {
  let respond = () => json({models: [
    {name: 'qwen3.5:2b', size: 1_500_000_000, modified_at: '2026-10-01T10:00:00Z', details: {family: 'qwen', parameter_size: '2B', quantization_level: 'Q4_K_M'}},
    {name: '', size: 5}, null, 'junk', {model: 'llama3.2:3b', size: -1, modified_at: 'not a date'},
  ]});
  const f = await fixture({fetchImpl: async () => respond()});
  try {
    const ok = await f.b.listLocalModels();
    assert.equal(ok.available, true);
    assert.deepEqual(ok.models, [
      {name: 'qwen3.5:2b', sizeBytes: 1_500_000_000, modifiedAt: '2026-10-01T10:00:00Z', family: 'qwen', parameterSize: '2B', quantization: 'Q4_K_M'},
      {name: 'llama3.2:3b'},
    ]);
    assert.match(f.log.fetched[0].url, /^http:\/\/(127\.0\.0\.1|localhost):\d+\/api\/tags$/);
    respond = () => json({error: 'boom'}, 500);
    assert.deepEqual(await f.b.listLocalModels(), {available: false, endpoint: ok.endpoint, models: [], reason: 'The local model endpoint returned HTTP 500'});
    respond = () => json('{not json');
    assert.match((await f.b.listLocalModels()).reason, /invalid JSON/);
    respond = () => { throw new Error('connect ECONNREFUSED'); };
    const down = await f.b.listLocalModels();
    assert.equal(down.available, false);
    assert.match(down.reason, /not reachable/);
    assert.throws(() => parseModelTags({}), /model list/);
  } finally { await f.close(); }
});

// ---------- Assistant flow end to end (backend side) ----------

test('intent → preview → native approval → outcome: declined dialog runs nothing; approval runs only the exact target', async () => {
  const f = await fixture();
  try {
    const plan = await f.b.planIntent('type "hello there" into "Note"');
    assert.equal(plan.status, 'ready');
    assert.deepEqual(plan.request, {type: 'type-text', text: 'hello there', target: 'hwnd:12'});
    const preview = await f.b.previewAction(plan.request);
    assert.equal(preview.allowed, true);
    assert.equal(preview.requiresApproval, true);
    assert.deepEqual([f.log.typed, f.log.focused], [[], []], 'planning and preview send no input');

    // Renderer says "approved" but the trusted native dialog is declined: nothing runs.
    f.setDecision(false);
    const declined = await f.b.executeAction(preview.id, true);
    assert.equal(declined.executed, false);
    assert.equal(f.log.typed.length, 0);
    assert.match(f.log.confirms[0].detail, /hello there/, 'native dialog shows the full text');

    // Rejection never opens the dialog and never runs.
    const p2 = await f.b.previewAction(plan.request);
    const confirmsBefore = f.log.confirms.length;
    const rejected = await f.b.executeAction(p2.id, false);
    assert.notEqual(rejected?.executed, true);
    assert.equal(f.log.confirms.length, confirmsBefore);
    assert.equal(f.log.typed.length, 0);

    // Approved in the native dialog: focuses the exact approved window, then types once.
    f.setDecision(true);
    const p3 = await f.b.previewAction(plan.request);
    const ran = await f.b.executeAction(p3.id, true);
    assert.equal(ran.executed, true);
    assert.deepEqual(f.log.focused, [{hwnd: 12, pid: 23}]);
    assert.equal(f.log.typed.length, 1);
    await assert.rejects(f.b.executeAction(p3.id, true), /already used|unknown|expired/i, 'previews are single use');
  } finally { await f.close(); }
});

test('without a trusted confirmation callback, approved actions never run', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-api-'));
  let typed = 0;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [],
    native: {listWindows: async () => [WIN], focusWindow: async () => ({focused: true}), typeText: async () => { typed++; return {typed: 1}; }, moveWindow: async () => ({}), dpapi: async () => ({ok: true})},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
  });
  try {
    const plan = await b.planIntent('type "x" into "Note"');
    const p = await b.previewAction(plan.request);
    assert.equal((await b.executeAction(p.id, true)).executed, false);
    assert.equal(typed, 0);
  } finally { await b.dispose(); await rm(dir, {recursive: true, force: true}); }
});

// ---------- Renderer flow helpers ----------

function fakeApi(over = {}) {
  const calls = [];
  const api = {
    planIntent: async (...a) => { calls.push(['planIntent', ...a]); return {status: 'ready', source: 'rules', request: {type: 'focus', target: 'hwnd:12'}, summary: 'Bring Note to the foreground', previewOnly: true}; },
    previewAction: async (...a) => { calls.push(['previewAction', ...a]); return {id: 'p1', summary: 'Focus Note (notepad.exe)', requiresApproval: true, allowed: true}; },
    executeAction: async (...a) => { calls.push(['executeAction', ...a]); return {executed: true}; },
    ...over,
  };
  return {api, calls};
}

test('planCommand only plans; model assist is requested only when enabled; missing planner is reported', async () => {
  const {planCommand, PLANNER_UNAVAILABLE} = uiMod;
  const {api, calls} = fakeApi();
  const s = await planCommand(api, '  focus Note  ', false);
  assert.equal(s.command, 'focus Note');
  assert.equal(s.plan.status, 'ready');
  await planCommand(api, 'focus Note', true);
  assert.deepEqual(calls, [['planIntent', 'focus Note', undefined], ['planIntent', 'focus Note', {useLocalModel: true}]]);
  const noPlanner = fakeApi({planIntent: undefined});
  assert.deepEqual(await planCommand(noPlanner.api, 'list windows', false), {command: 'list windows', error: PLANNER_UNAVAILABLE});
  assert.equal(noPlanner.calls.length, 0);
  const failing = fakeApi({planIntent: async () => { throw new Error("Error invoking remote method 'jarvis:planIntent': Error: Invalid argument 1"); }});
  assert.equal((await planCommand(failing.api, 'x', false)).error, 'Invalid argument 1');
});

test('planChoices offers the ready request or clarification candidates, never a blocked plan', () => {
  const {planChoices} = uiMod;
  assert.deepEqual(planChoices({status: 'ready', source: 'rules', request: {type: 'list-windows'}, summary: 'List', previewOnly: true}), [{label: 'List', request: {type: 'list-windows'}}]);
  const c = [{label: 'Focus A', request: {type: 'focus', target: 'hwnd:1'}}];
  assert.deepEqual(planChoices({status: 'clarify', source: 'rules', summary: 's', question: 'q', missing: ['target'], candidates: c}), c);
  assert.deepEqual(planChoices({status: 'clarify', source: 'rules', summary: 's', question: 'q', missing: ['target']}), []);
  assert.deepEqual(planChoices({status: 'blocked', source: 'rules', summary: 's', reason: 'r'}), []);
  assert.deepEqual(planChoices(undefined), []);
});

test('previewCommand and decideCommand make exactly one call each and map outcomes honestly', async () => {
  const {previewCommand, decideCommand} = uiMod;
  const {api, calls} = fakeApi();
  const req = {type: 'focus', target: 'hwnd:12'};
  const previewed = await previewCommand(api, {command: 'focus Note'}, req);
  assert.deepEqual(calls.map((c) => c[0]), ['previewAction']);
  assert.equal(previewed.preview.id, 'p1');

  assert.equal((await decideCommand(api, previewed, true)).outcome.kind, 'ran');
  assert.deepEqual(calls.at(-1), ['executeAction', 'p1', true]);

  const refused = fakeApi({executeAction: async () => ({executed: false, reason: 'Native confirmation declined or unavailable'})});
  const r = await decideCommand(refused.api, previewed, true);
  assert.deepEqual([r.outcome.kind, r.outcome.message], ['not-run', 'Native confirmation declined or unavailable']);

  const rejected = await decideCommand(api, previewed, false);
  assert.equal(rejected.outcome.kind, 'rejected');
  assert.deepEqual(calls.at(-1), ['executeAction', 'p1', false]);

  const thrown = fakeApi({executeAction: async () => { throw new Error('Preview already used'); }});
  const t = await decideCommand(thrown.api, previewed, true);
  assert.equal(t.outcome.kind, 'unconfirmed');
  assert.match(t.outcome.message, /Preview already used/);

  const blocked = fakeApi();
  const b = await decideCommand(blocked.api, {...previewed, preview: {...previewed.preview, allowed: false, reason: 'Not an approved app'}}, true);
  assert.equal(b.error, 'Not an approved app');
  assert.equal(blocked.calls.length, 0, 'a blocked preview is never sent for execution');

  const unconfirmed = fakeApi({executeAction: async () => 'ok'});
  assert.equal((await decideCommand(unconfirmed.api, previewed, true)).outcome.kind, 'unconfirmed', 'a resolved promise alone is not success');

  const failingPreview = fakeApi({previewAction: async () => { throw new Error('Too many actions'); }});
  const fp = await previewCommand(failingPreview.api, {command: 'x'}, req);
  assert.equal(fp.preview, undefined);
  assert.equal(fp.error, 'Too many actions');
});

test('Computer form filling round-trips planned requests; screen reading is listed as not implemented', () => {
  const {formFromRequest, buildAction, SCREEN_FEATURES, UI_MAX_COMMAND_CHARS, MAX_COMMAND_CHARS} = uiMod;
  for (const req of [
    {type: 'move-window', target: 'hwnd:13', x: 0, y: -20, width: 800, height: 600},
    {type: 'type-text', target: 'hwnd:12', text: 'hello'},
    {type: 'focus', target: 'hwnd:12'},
    {type: 'open-url', target: 'https://example.com/'},
    {type: 'list-windows'},
  ]) assert.deepEqual(buildAction(formFromRequest(req)).action, req);
  assert.deepEqual(SCREEN_FEATURES.map((f) => f.id), ['region-capture', 'vision']);
  const ids = new Set(API_FEATURES.filter((f) => !f.available).map((f) => f.id));
  assert.ok(SCREEN_FEATURES.every((f) => ids.has(f.id)));
  assert.equal(API_FEATURES.find(f => f.id === 'ocr').available, true, 'dialog-selected image OCR is connected separately from screen capture');
  assert.match(API_FEATURES.find(f => f.id === 'ocr').reason, /One image selected/);
  assert.equal(UI_MAX_COMMAND_CHARS, MAX_COMMAND_CHARS, 'renderer command limit mirrors the planner');
});

// ---------- v2.1 adapters (routines, models, integrations, usage, clipboard, resources) ----------

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('the backend implements every IPC method as a function', async () => {
  const f = await fixture();
  try {
    for (const m of METHODS) assert.equal(typeof f.b[m], 'function', m);
  } finally { await f.close(); }
});

test('routines: drafts persist, runs go through preview + native confirmation, declined runs type nothing', async () => {
  const f = await fixture();
  try {
    const view = await f.b.routinesSave({name: 'Say hi', steps: [{kind: 'action', request: {type: 'type-text', target: 'hwnd:12', text: 'hi there'}}]});
    assert.equal(view.routines.length, 1);
    const id = view.routines[0].id;
    const stored = JSON.parse(await readFile(path.join(f.dir, 'routines.json'), 'utf8'));
    assert.equal(stored.routines[0].name, 'Say hi', 'routines are saved in their sidecar');
    await assert.rejects(f.b.routinesSave({name: 'Bad', steps: [{kind: 'record'}]}), /not available/);
    await assert.rejects(f.b.routinesStart('missing'), /not found/i);

    const finished = (runId) => waitFor(async () => { const v = await f.b.routinesList(); return v.activeRunId === null && v.runs.find((r) => r.id === runId); });
    f.setDecision(false);
    const run1 = await finished((await f.b.routinesStart(id)).runId);
    assert.equal(run1.status, 'declined');
    assert.equal(f.log.typed.length, 0, 'declined native confirmation types nothing');
    assert.match(f.log.confirms.at(-1).detail, /hi there/, 'the trusted dialog shows the full text');

    f.setDecision(true);
    const run2 = await finished((await f.b.routinesStart(id)).runId);
    assert.equal(run2.status, 'succeeded');
    assert.deepEqual(f.log.focused, [{hwnd: 12, pid: 23}], 'execution focuses the exact approved window');
    assert.equal(f.log.typed.length, 1);

    const paused = await f.b.routinesPauseAll();
    assert.equal(paused.paused, true);
    await assert.rejects(f.b.routinesStart(id), /paused/i);
    assert.equal((await f.b.routinesResumeAll()).paused, false);
    assert.equal((await f.b.routinesRemove(id)).routines.length, 0);

    const plan = await f.b.routinesPlanText('list windows');
    assert.equal(plan.status, 'ready');
    assert.equal(plan.previewOnly, true);
    assert.equal(f.log.typed.length, 1, 'planning runs nothing');
    assert.deepEqual(f.log.fetched, [], 'routines never touch the network');
  } finally { await f.close(); }
});

test('model runtime: offline mode never downloads, profile persists, options are strict, pack folder is normalized', async () => {
  const picked = [];
  const f = await fixture({dialogs: {openImport: async () => null, saveExport: async () => null, pick: async (kind) => { picked.push(kind); return 'C:\\Packs\\tiny'; }}});
  try {
    const pull = await f.b.modelsStartPull('llama3.2');
    assert.equal(pull.ok, false);
    assert.match(pull.reason, /Offline mode never downloads/);
    assert.ok(!f.log.fetched.some((x) => /\/api\/pull/.test(x.url)), 'no pull request was sent');
    assert.equal(f.log.confirms.length, 0, 'no dialog when the request is refused up front');

    const overview = await f.b.modelsOverview();
    assert.equal(overview.downloads.allowed, false);
    assert.notEqual(overview.health.state, 'ready', 'an unreachable Ollama is never reported ready');
    const endpoint = f.b.store.snapshot().settings.localEndpoint;
    assert.ok(f.log.fetched.every((x) => x.url.startsWith(`${endpoint}/`)), 'only the configured loopback endpoint is contacted');

    assert.equal(await f.b.modelsSetProfile('low-memory'), 'low-memory');
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'model-profile.json'), 'utf8')), {profile: 'low-memory'});
    await assert.rejects(f.b.modelsSetProfile('turbo'), /Unknown resource profile/);
    await assert.rejects(f.b.modelsSelect('llama3.2', {warm: 'yes'}), /warm must be true or false/);
    await assert.rejects(f.b.modelsSelect('llama3.2', {force: true}), /unknown option/);
    assert.equal((await f.b.modelsSelect('llama3.2')).ok, false, 'select reports an unreachable runtime instead of pretending');
    assert.equal(await f.b.modelsCancelJob('nojob'), false);
    await assert.rejects(f.b.modelsCancelJob('../x'), /invalid/);
    assert.equal(await f.b.modelsPickPackFolder(), 'C:\\Packs\\tiny');
    assert.deepEqual(picked, ['folder']);
  } finally { await f.close({keep: true}); }
  const again = await fixture({dir: f.dir});
  try {
    assert.equal((await again.b.modelsOverview()).activeProfile, 'low-memory', 'the profile is restored on restart');
  } finally { await again.close(); }
});

test('integrations: storing a key needs the native confirmation; the Anthropic slot is the chat key; offline checks send nothing', async () => {
  // Reversible stand-in for DPAPI so the vault's verification round trip works without Windows.
  const dpapi = async (op, data) => (op === 'probe' ? {ok: true} : {ok: true, data: op === 'protect' ? Buffer.from(String(data)).toString('base64') : Buffer.from(String(data), 'base64').toString()});
  const f = await fixture({nativeExtra: {dpapi}});
  const key = `sk-ant-api03-${'a'.repeat(40)}`;
  try {
    assert.ok((await f.b.integrationsList()).some((x) => x.id === 'anthropic'));
    f.setDecision(false);
    await assert.rejects(f.b.integrationsSetKey('anthropic', key), /declined or unavailable/);
    assert.equal((await f.b.cloudKeyStatus()).configured, false);
    f.setDecision(true);
    const set = await f.b.integrationsSetKey('anthropic', key);
    assert.equal(set.configured, true);
    assert.ok(!JSON.stringify(set).includes(key), 'the key is never returned');
    assert.equal((await f.b.cloudKeyStatus()).configured, true, 'chat sees the key stored through integrations');
    const check = await f.b.integrationsCheck('anthropic');
    assert.notEqual(check.ok, true, 'offline mode cannot pass an online check');
    assert.deepEqual(f.log.fetched, [], 'offline: nothing was sent');
    assert.equal((await f.b.integrationsRemoveKey('anthropic')).configured, false);
    assert.equal((await f.b.cloudKeyStatus()).configured, false);
    await assert.rejects(f.b.integrationsSetEnabled('nope-provider', true), /Unknown integration/);
    const logged = f.b.store.snapshot().activity.map((a) => `${a.summary} ${a.details ?? ''}`).join('\n');
    assert.ok(!logged.includes(key), 'the activity log never contains the key');
  } finally { await f.close(); }
});

test('usage ledger: strict setters, persisted prices and budget, report and file export', async () => {
  const out = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-api-out-'));
  const target = path.join(out, 'my-usage');
  const formats = [];
  const f = await fixture({dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null, saveUsageExport: async (name, format) => { formats.push([name, format]); return target; }}});
  try {
    await assert.rejects(f.b.usageSetPrices([{provider: 'anthropic'}]), /expected an object/);
    await assert.rejects(f.b.usageSetPrices({prices: [], extra: 1}), /expected exactly \{prices\}/);
    await assert.rejects(f.b.usageSetPrices({prices: [{provider: 'anthropic', model: 'm', inputPerMillion: -1, outputPerMillion: 1}]}), /inputPerMillion/);
    const prices = await f.b.usageSetPrices({prices: [{provider: 'anthropic', model: 'claude-test', inputPerMillion: 3, outputPerMillion: 15}]});
    assert.equal(prices.length, 1);
    const budget = await f.b.usageSetBudget({budget: {amount: 10, period: 'month'}});
    assert.equal(budget.amount, 10);
    const saved = JSON.parse(await readFile(path.join(f.dir, 'usage-ledger.json'), 'utf8'));
    assert.equal(saved.prices.length, 1);
    assert.equal(saved.budget.amount, 10);

    const summary = await f.b.usageReport();
    assert.equal(summary.report.totals.events, 0, 'no usage is invented');
    assert.equal(summary.report.budget.amount, 10);
    assert.ok(Array.isArray(summary.performance));

    const exported = await f.b.usageExport('csv');
    assert.equal(exported.path, `${target}.csv`);
    assert.deepEqual(formats.map(([, fmt]) => fmt), ['csv']);
    assert.match(await readFile(exported.path, 'utf8'), /^at,runtime,provider,model/);
  } finally { await f.close({keep: true}); await rm(out, {recursive: true, force: true}); }
  const again = await fixture({dir: f.dir});
  try {
    assert.equal((await again.b.usageReport()).report.budget.amount, 10, 'budget survives a restart');
  } finally { await again.close(); }
});

test('clipboard history: not connected without a reader; turning on needs the native dialog; memory only; off clears', async () => {
  const plain = await fixture();
  try {
    const st = await plain.b.clipboardStatus();
    assert.equal(st.enabled, false);
    assert.match(st.warning, /not connected/);
    await assert.rejects(plain.b.clipboardSetEnabled(true), /not connected/);
    assert.equal(plain.log.confirms.length, 0);
  } finally { await plain.close(); }

  let current = '';
  let reads = 0;
  const f = await fixture({env: {clipboard: {readText: async () => { reads++; return current; }}, clipboardPollMs: 5}});
  try {
    assert.equal((await f.b.getApiInfo()).features.find((x) => x.id === 'clipboard-history').available, true);
    f.setDecision(false);
    await assert.rejects(f.b.clipboardSetEnabled(true), /declined or unavailable/);
    assert.equal((await f.b.clipboardStatus()).enabled, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reads, 0, 'nothing is read before the user turns history on');

    f.setDecision(true);
    const on = await f.b.clipboardSetEnabled(true);
    assert.equal(on.enabled, true);
    assert.equal(on.persisted, false, 'memory only');
    current = 'hello world';
    const [entry] = await waitFor(async () => { const l = await f.b.clipboardList(); return l.length ? l : null; });
    assert.equal(entry.preview, 'hello world');
    assert.equal(await f.b.clipboardGet(entry.id), 'hello world');
    current = 'password: hunter2';
    const seen = reads;
    await waitFor(async () => reads > seen + 3);
    assert.equal((await f.b.clipboardList()).length, 1, 'credential-like text is skipped');
    assert.equal(await f.b.clipboardRemove(entry.id), true);
    current = 'second';
    await waitFor(async () => (await f.b.clipboardList()).length === 1);
    assert.equal((await f.b.clipboardPurge()).count, 0);
    const off = await f.b.clipboardSetEnabled(false);
    assert.equal(off.enabled, false);
    const before = reads;
    current = 'after off';
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reads, before, 'polling stops when history is turned off');
    assert.deepEqual(await f.b.clipboardList(), []);
  } finally { await f.close(); }
});

test('systemResources returns measured figures and lists what it cannot measure', async () => {
  const f = await fixture();
  try {
    const r = await f.b.systemResources();
    assert.ok(r.memory.totalBytes > 0);
    assert.ok(r.logicalCores > 0);
    const ids = r.unavailable.map((u) => u.id);
    for (const id of ['gpu', 'app-processes']) assert.ok(ids.includes(id), id);
    assert.deepEqual(r.appProcesses, []);
  } finally { await f.close(); }
});
