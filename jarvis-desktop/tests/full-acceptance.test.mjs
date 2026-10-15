// Full-handoff acceptance (independent role). Cross-module behaviour driven through the real bundled sources:
// whole-backend offline egress, assistant route truthfulness (UI statement vs. what the backend really does), hostile
// portable-memory imports into the real ProductivityStore, guidance capability claims vs. the backend API, and GPU resource
// balance. Only injected fakes: recorded fetch, in-memory native adapter, own temp folders. No network, Electron, microphone,
// desktop input, account or personal file.
//
// ACCEPTANCE_SOURCE_ROOT may point at another checkout (read only) so the same checks run against a teammate's finished
// worktree before integration. A module that does not exist in the source root is reported as SKIPPED with the reason,
// never as a pass. Open findings are `todo` tests asserting the safe behaviour (see docs/full-security-findings.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.ACCEPTANCE_SOURCE_ROOT || root);
const require = createRequire(import.meta.url);

const iconStub = {name: 'icon-stub', setup(b) {
  b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
  b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: 'module.exports = new Proxy({}, {get: (_t, k) => k === "__esModule" ? false : () => null});', loader: 'js'}));
}};

/** Bundles `contents` against SRC. Returns the exports, or {missing} naming the first absent file the entry needs. */
async function load(files, contents) {
  const absent = files.filter((f) => !existsSync(path.join(SRC, f)));
  if (absent.length) return {missing: `not present in ${SRC}: ${absent.join(', ')}`};
  const out = await build({stdin: {contents, resolveDir: SRC, loader: 'tsx', sourcefile: 'full-acceptance-entry.tsx'}, bundle: true, write: false, platform: 'node', format: 'cjs',
    jsx: 'automatic', loader: {'.css': 'empty'}, logLevel: 'silent', nodePaths: [path.join(root, 'node_modules')], plugins: [iconStub]});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const B = await load(['electron/backend.ts'], `export {createBackend} from './electron/backend'; export {resolveChatRoute} from './electron/services/chat';`);
const PT = await load(['src/ui/prompt-tools.ts'], `export * from './src/ui/prompt-tools';`);
const ST = await load(['electron/services/store.ts'], `export * as store from './electron/services/store';`);
const GD = await load(['src/ui/guidance.ts'], `export * as guidance from './src/ui/guidance';`);
const S3 = await load(['src/ui/scene3d.ts'], `export * from './src/ui/scene3d';`);
const needs = (t, ...mods) => { const m = mods.find((x) => x.missing); if (m) { t.skip(m.missing); return false; } return true; };
const needExport = (t, mod, name) => { if (typeof mod[name] !== 'function') { t.skip(`export ${name} is absent in ${SRC}`); return false; } return true; };

// ---------------------------------------------------------------------------------------------------------------
// Backend fixture: real createBackend, own temp profile, recorded fetch, in-memory native adapter (no PowerShell).
// ---------------------------------------------------------------------------------------------------------------

const CLOUD = 'https://cloud.acceptance.invalid';
const enc = new TextEncoder();
const body = (chunks) => new ReadableStream({start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); }});
const ndjson = (o) => JSON.stringify(o) + '\n';
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const CLOUD_REPLY = [
  {type: 'message_start', message: {usage: {input_tokens: 3, output_tokens: 1}}},
  {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'cloud says hi'}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_stop'},
].map(sse);

async function backend({confirm = async () => true, ollama = true} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-acceptance-'));
  const fetched = [];
  const b = await B.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [process.pid],
    native: {
      listWindows: async () => [], focusWindow: async () => ({focused: false}), moveWindow: async () => { throw new Error('no desktop in acceptance'); },
      typeText: async () => { throw new Error('no desktop input in acceptance'); }, click: async () => { throw new Error('no desktop input in acceptance'); },
      probeSpeech: async () => ({voices: [], recognizers: []}), speak: async () => ({ok: false, reason: 'no audio in acceptance'}), transcribe: async () => ({text: '', reason: 'no microphone in acceptance'}),
      dpapi: async (op, data) => op === 'protect' ? {ok: true, data: Buffer.from(String(data)).toString('base64')} : op === 'unprotect' ? {ok: true, data: Buffer.from(String(data), 'base64').toString()} : {ok: true},
    },
    shell: {spawnApp: async () => { throw new Error('no launch in acceptance'); }, openPath: async () => 'blocked', openExternal: async () => { throw new Error('no browser in acceptance'); }},
    confirm,
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    cloudOriginOverride: CLOUD,
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      fetched.push({url: u, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers ?? {}).entries())});
      if (!ollama && isLoopback(u)) throw new TypeError('fetch failed', {cause: {code: 'ECONNREFUSED'}});
      if (u.startsWith(CLOUD + '/v1/messages')) return new Response(body(CLOUD_REPLY), {status: 200, headers: {'content-type': 'text/event-stream'}});
      if (u.endsWith('/api/chat')) return new Response(body([ndjson({message: {content: 'local says hi'}, done: false}), ndjson({done: true, prompt_eval_count: 2, eval_count: 3})]), {status: 200});
      if (u.endsWith('/api/tags')) return Response.json({models: [{name: 'llama3.2:3b', model: 'llama3.2:3b', size: 2019393189, digest: 'a'.repeat(64), modified_at: '2026-10-01T00:00:00Z', details: {family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M'}}]});
      if (u.endsWith('/api/version')) return Response.json({version: '0.0.0-fixture'});
      if (u.endsWith('/api/ps')) return Response.json({models: []});
      throw new TypeError('fetch failed');
    },
  });
  return {b, fetched, async close() { await b.dispose(); await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }};
}
const isLoopback = (u) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(u).hostname);
const settle = async (b, start) => {
  const events = [];
  for (let cursor = 0, i = 0; i < 400; i++) {
    const r = await b.chatStreamRead(start.streamId, cursor);
    events.push(...r.events);
    cursor = r.cursor ?? (cursor + r.events.length);
    if (r.events.some((e) => e.type === 'done') || r.done) break;
  }
  return events;
};

// ---------------------------------------------------------------------------------------------------------------
// Strict offline egress across every network-capable backend method
// ---------------------------------------------------------------------------------------------------------------

test('offline mode with a stored cloud key: no backend method reaches anything but the configured loopback model', async (t) => {
  if (!needs(t, B)) return;
  const f = await backend();
  try {
    await f.b.setCloudKey('sk-acceptance-' + 'k'.repeat(40));
    assert.equal((await f.b.getState()).settings.mode, 'offline');
    const tried = [];
    const attempt = async (name, fn) => { tried.push(name); try { await fn(); } catch { /* refusals are fine: only egress matters */ } };
    await attempt('chat', () => f.b.chat('hello offline'));
    await attempt('chatStream', async () => settle(f.b, await f.b.chatStreamStart('hello stream')));
    await attempt('listLocalModels', () => f.b.listLocalModels());
    await attempt('modelsOverview', () => f.b.modelsOverview());
    await attempt('getApiInfo', () => f.b.getApiInfo());
    await attempt('getSystemInfo', () => f.b.getSystemInfo());
    await attempt('planIntent', () => f.b.planIntent('open notepad'));
    await attempt('search', () => f.b.search('hello'));
    await attempt('routinesPlanModel', () => f.b.routinesPlanModel('every morning remind me to stretch'));
    const list = await f.b.integrationsList().catch(() => []);
    const ids = (Array.isArray(list) ? list : list.integrations ?? []).map((i) => i.id).filter(Boolean);
    for (const id of ids) await attempt(`integrationsCheck:${id}`, () => f.b.integrationsCheck(id));
    assert.ok(ids.length > 0, 'integrations are listed so their checks were exercised');
    const remote = f.fetched.filter((r) => !isLoopback(r.url));
    assert.deepEqual(remote, [], `offline egress left the machine via ${remote.map((r) => r.url).join(', ')}`);
    assert.ok(f.fetched.every((r) => !('x-api-key' in r.headers) && !('authorization' in r.headers)), 'no credential header on any loopback request');
    assert.ok(f.fetched.some((r) => r.url.endsWith('/api/chat')), 'the local model was actually used, so the sweep is not vacuous');
  } finally { await f.close(); }
});

test('a LAN or public local-model endpoint is refused; online mode needs the trusted confirmation', async (t) => {
  if (!needs(t, B)) return;
  const f = await backend({confirm: async () => false});
  try {
    for (const endpoint of ['http://192.168.1.20:11434', 'http://example.com:11434', 'https://127.0.0.1:11434', 'http://user:pw@127.0.0.1:11434']) {
      await assert.rejects(f.b.saveSettings({localEndpoint: endpoint}), undefined, endpoint);
    }
    await assert.rejects(f.b.saveSettings({mode: 'online'}), /confirmation/i);
    assert.equal((await f.b.getState()).settings.mode, 'offline');
    assert.deepEqual(f.fetched, []);
  } finally { await f.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Assistant route truthfulness: PromptTools' route statement vs. what the real backend does with the same Send.
// ---------------------------------------------------------------------------------------------------------------

/** Runs one streamed Send through the real backend and reports where it actually went. */
async function actualRoute({mode, key}) {
  const f = await backend();
  try {
    if (key) await f.b.setCloudKey('sk-acceptance-' + 'r'.repeat(40));
    if (mode === 'online') await f.b.saveSettings({mode: 'online'});
    const events = await settle(f.b, await f.b.chatStreamStart('route probe'));
    const done = events.find((e) => e.type === 'done');
    return {
      cloud: f.fetched.some((r) => r.url.startsWith(CLOUD)),
      local: f.fetched.some((r) => isLoopback(r.url) && r.url.endsWith('/api/chat')),
      answered: !!done && (done.outcome === 'complete' || done.outcome === 'truncated'),
    };
  } finally { await f.close(); }
}

const ROUTE_CASES = [
  {mode: 'offline', key: false, seen: false},
  {mode: 'offline', key: true, seen: true},
  {mode: 'online', key: true, seen: true},
  {mode: 'online', key: false, seen: false},
  {mode: 'online', key: true, seen: null}, // key status not (yet) known to the window: Send is still enabled
];

for (const c of ROUTE_CASES) {
  const label = `${c.mode}, key ${c.key ? 'stored' : 'absent'}, window sees cloudConfigured=${c.seen}`;
  test(`route statement matches the backend: ${label}`, async (t) => {
    if (!needs(t, B, PT) || !needExport(t, PT, 'describeRoute')) return;
    const said = PT.describeRoute({mode: c.mode}, c.seen);
    const did = await actualRoute(c);
    const claimsLocalOnly = /nothing leaves the computer/i.test(said.text);
    if (did.cloud) assert.ok(!claimsLocalOnly && (said.route === 'cloud' || (c.seen === null && said.route === 'unknown' && /cloud/i.test(said.text))), `the prompt went to the cloud but the window said: "${said.text}"`);
    if (said.route === 'local' && /local model answers/i.test(said.text)) assert.ok(did.local && did.answered, `the window promised a local answer; backend: ${JSON.stringify(did)}`);
    if (said.route === 'cloud') assert.ok(did.cloud, 'the window said cloud but nothing was sent there');
  });
}

test('the backend never falls back from cloud to local or local to cloud on its own', async (t) => {
  if (!needs(t, B)) return;
  assert.deepEqual(B.resolveChatRoute({mode: 'online'}, false), {route: 'cloud', denied: B.resolveChatRoute({mode: 'online'}, false).denied});
  assert.ok(B.resolveChatRoute({mode: 'online'}, false).denied);
  const offline = await actualRoute({mode: 'offline', key: true});
  assert.deepEqual([offline.cloud, offline.local], [false, true]);
  const noKey = await actualRoute({mode: 'online', key: false});
  assert.deepEqual([noKey.cloud, noKey.local, noKey.answered], [false, false, false], 'online without a key is refused, not silently answered locally');
});

// ---------------------------------------------------------------------------------------------------------------
// Workspace portable memory: hostile imports into the real ProductivityStore
// ---------------------------------------------------------------------------------------------------------------

function memFs() {
  const files = new Map();
  return {files, api: {
    mkdir: async () => {}, readFile: async (p) => { if (!files.has(p)) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); return files.get(p); },
    writeFile: async (p, d) => { files.set(p, d); }, rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    readdir: async (dir) => [...files.keys()].filter((k) => path.win32.dirname(k) === dir).map((k) => path.win32.basename(k)), unlink: async (p) => { files.delete(p); },
  }};
}
const NOW = new Date('2026-10-15T10:00:00.000Z');
async function productivityStore() {
  let n = 0;
  const ps = new ST.store.ProductivityStore({dir: 'D:\\acceptance', fs: memFs().api, now: () => NOW, newId: () => `acc${++n}`});
  await ps.load();
  return ps;
}
const CAPS = [{id: 'cap1', name: 'Installer'}];
const portable = (patch) => JSON.stringify({format: 'desktop-companion-memory', version: 1, exportedAt: NOW.toISOString(), capsules: [], checkpoints: [], shelf: [], ...patch});

/** Applies every planned op like the workbench does (one by one) and reports what really landed. */
async function applyAll(ps, ops) {
  const failed = [];
  for (const op of ops) { try { await ps.apply(op); } catch (e) { failed.push(`${op.op}: ${e.message}`); } }
  return failed;
}

test('portable import: prototype keys, wrong types and oversized text never reach the store or Object.prototype', async (t) => {
  if (!needs(t, ST) || !needExport(t, ST.store, 'parsePortable')) return;
  const ps = await productivityStore();
  const ctx = {prod: ps.snapshot(), capsules: CAPS, noteIds: [], taskIds: []};
  const hostile = '{"format":"desktop-companion-memory","version":1,"__proto__":{"polluted":true},"capsules":[{"id":"__proto__","name":"constructor","goals":[{"text":"x"}]}],"checkpoints":[{"title":"t","createdAt":"2026-10-14T00:00:00Z","constructor":{"prototype":{"polluted":true}}}],"shelf":{"length":5}}';
  const r = ST.store.parsePortable(hostile, ctx, NOW);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(await applyAll(ps, r.ops).then((f) => f.length), 0);
  assert.equal({}.polluted, undefined);
  assert.equal(ST.store.parsePortable('x'.repeat(1_000_001), ctx, NOW).ok, false);
  assert.equal(ST.store.parsePortable(portable({version: 2}), ctx, NOW).ok, false);
  assert.equal(ST.store.parsePortable(portable({version: '1'}), ctx, NOW).ok, false);
  const future = ST.store.parsePortable(portable({checkpoints: [{title: 'from the future', createdAt: '2999-01-01T00:00:00Z'}]}), ctx, NOW);
  assert.ok(future.ops.every((o) => o.op !== 'checkpoint.add' || o.createdAt <= NOW.toISOString()));
});

test('SEC-06: a preview only counts records the store will accept; one hostile reference does not sink valid goals', async (t) => {
  if (!needs(t, ST) || !needExport(t, ST.store, 'parsePortable')) return;
  const ps = await productivityStore();
  const raw = portable({
    capsules: [{id: 'cap1', name: 'Installer', goals: [{text: 'Ship 0.1'}], references: [
      {kind: 'file', target: '\\\\attacker.example\\share\\payload.lnk', label: 'UNC (NTLM leak on open)'},
      {kind: 'url', target: 'javascript:alert(1)', label: 'script URL'},
      {kind: 'url', target: 'https://example.com/spec', label: 'valid'},
    ]}],
    shelf: [{kind: 'folder', target: 'relative\\folder', label: 'relative'}, {kind: 'url', target: 'file:///C:/Windows/System32/cmd.exe', label: 'file url'}],
  });
  const r = ST.store.parsePortable(raw, {prod: ps.snapshot(), capsules: CAPS, noteIds: [], taskIds: []}, NOW);
  const failed = await applyAll(ps, r.ops);
  const s = ps.snapshot();
  // Safety first (holds today): the store refuses every hostile target.
  assert.ok(!JSON.stringify(s).includes('attacker.example') && !JSON.stringify(s).includes('javascript:') && !JSON.stringify(s).includes('cmd.exe'));
  // Truthfulness (open): the preview's counts equal what landed, and the valid goal and URL still import.
  assert.deepEqual(failed, [], `ops failed at apply after the preview counted them: ${failed.join(' | ')}`);
  assert.deepEqual(s.capsuleMeta.cap1?.goals.map((g) => g.text), ['Ship 0.1']);
  assert.equal(r.counts.references, s.capsuleMeta.cap1?.references.length ?? 0);
  assert.equal(r.counts.shelf, s.shelf.length);
});

// ---------------------------------------------------------------------------------------------------------------
// Guidance: the checklist fed with the real backend's own reports must use the ids the backend emits and never call
// something ready that the backend cannot do (and vice versa).
// ---------------------------------------------------------------------------------------------------------------

async function guidanceFrom(f, g, prefs) {
  const [info, sys, key, state] = [await f.b.getApiInfo(), await f.b.getSystemInfo(), await f.b.cloudKeyStatus(), await f.b.getState()];
  const now = Date.now();
  const input = {capabilities: sys.capabilities, capabilitiesError: null, apiFeatures: info.features, settings: state.settings, cloudKeyConfigured: key.configured,
    counts: {notes: state.notes.length, tasks: state.tasks.length, capsules: state.capsules.length}, systemReducedMotion: false, webgl2: null, checkedAt: now};
  const items = g.buildGuideItems(input, prefs ?? g.DEFAULT_GUIDANCE_PREFS, now);
  return {items, by: Object.fromEntries(items.map((i) => [i.id, i])), sys, info};
}
const capOf = (sys, id) => sys.capabilities.find((c) => c.id === id);

test('guidance reads the capability and feature ids the real backend reports (fresh real data is never "not reported")', async (t) => {
  if (!needs(t, B, GD) || !needExport(t, GD.guidance, 'buildGuideItems')) return;
  const g = GD.guidance;
  const f = await backend();
  try {
    const {by, sys, info} = await guidanceFrom(f, g);
    for (const id of ['dictation', 'streaming', 'local-models']) {
      assert.notEqual(by[id].status, 'unknown', `${id}: ${by[id].reason}`);
      assert.ok(!/not reported/i.test(by[id].reason), `${id} looks for an id the backend does not emit: ${by[id].reason}`);
    }
    assert.ok(capOf(sys, 'local-llm') && capOf(sys, 'stt'), 'backend emits the capabilities guidance depends on');
    const unavailable = new Set(info.features.filter((x) => !x.available).map((x) => x.id));
    if (unavailable.has('chat-streaming')) assert.ok(!['todo', 'done'].includes(by.streaming.status));
    if (unavailable.has('local-models')) assert.equal(by['local-models'].status, 'unavailable');
  } finally { await f.close(); }
});

test('guidance "ready" claims hold against the real backend: local model up, local model down, online without key, online with key', async (t) => {
  if (!needs(t, B, GD) || !needExport(t, GD.guidance, 'buildGuideItems')) return;
  const g = GD.guidance;
  for (const c of [{name: 'offline, Ollama up', ollama: true}, {name: 'offline, Ollama down', ollama: false}, {name: 'online, no key', online: true}, {name: 'online, key', online: true, key: true}]) {
    const f = await backend({ollama: c.ollama ?? true});
    try {
      if (c.key) await f.b.setCloudKey('sk-acceptance-' + 'g'.repeat(40));
      if (c.online) await f.b.saveSettings({mode: 'online'});
      const {by, sys} = await guidanceFrom(f, g);
      const events = await settle(f.b, await f.b.chatStreamStart('guidance probe'));
      const done = events.find((e) => e.type === 'done');
      const answered = !!done && done.outcome === 'complete';
      const llm = capOf(sys, 'local-llm')?.available === true;
      // Streaming is offered as ready (todo/done) only when a Send really produces a reply.
      if (['todo', 'done'].includes(by.streaming.status)) assert.equal(answered, true, `${c.name}: guidance says streaming is ready (${by.streaming.reason}) but the backend produced ${done?.outcome}`);
      else assert.equal(answered, false, `${c.name}: guidance says ${by.streaming.status} (${by.streaming.reason}) but a Send was answered`);
      if (!c.online) assert.equal(by['local-models'].status === 'done', llm, `${c.name}: local-models ${by['local-models'].status} vs backend local-llm ${llm}`);
    } finally { await f.close(); }
  }
});

test('a manual "done" mark never passes a topic the backend reports unusable; hostile preference imports are refused whole', async (t) => {
  if (!needs(t, B, GD) || !needExport(t, GD.guidance, 'buildGuideItems')) return;
  const g = GD.guidance;
  const f = await backend({ollama: false});
  try {
    const prefs = {...g.DEFAULT_GUIDANCE_PREFS, marked: Object.fromEntries(g.GUIDE_TOPIC_IDS.map((id) => [id, 'done']))};
    const {by, sys, items} = await guidanceFrom(f, g, prefs);
    assert.equal(capOf(sys, 'stt').available, false, 'fixture: no recognizers');
    assert.equal(capOf(sys, 'local-llm').available, false, 'fixture: Ollama unreachable');
    for (const id of ['dictation', 'streaming', 'local-models']) {
      assert.notEqual(by[id].status, 'done', `${id} counted done from a manual mark while unusable`);
      assert.equal(by[id].canMarkDone, false, id);
    }
    assert.ok(g.summarizeGuide(items).done <= items.filter((i) => !['dictation', 'streaming', 'local-models'].includes(i.id)).length);
  } finally { await f.close(); }
  assert.equal(g.parseGuidanceImport('{"v":1,"marked":{"__proto__":"done","notes":"done"}}').ok, false);
  assert.equal(g.parseGuidanceImport(' '.repeat(g.MAX_IMPORT_CHARS + 1)).ok, false);
  assert.equal({}.done, undefined);
  const n = g.normalizeGuidancePrefs(JSON.parse('{"v":1,"marked":{"constructor":"done","dictation":"done"},"lastTopic":"__proto__"}'));
  assert.deepEqual(Object.keys(n.prefs.marked), ['dictation']);
  assert.equal(n.prefs.lastTopic, null);
});

// ---------------------------------------------------------------------------------------------------------------
// Renderer bundle is browser-only: the sandboxed page (no Node integration) must not pull node:* or main-process code.
// Mirrors what vite build resolves for src/main.tsx, without writing anything into the source checkout.
// ---------------------------------------------------------------------------------------------------------------

test('the renderer entry bundles for the browser: no Node built-ins, no Electron, no backend/main/native module', async (t) => {
  if (!existsSync(path.join(SRC, 'src', 'main.tsx'))) { t.skip(`src/main.tsx not present in ${SRC}`); return; }
  const nodeImports = new Set(), mainProcess = new Set();
  let result;
  try {
    result = await build({entryPoints: [path.join(SRC, 'src', 'main.tsx')], bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent',
      loader: {'.css': 'empty', '.png': 'empty', '.svg': 'empty', '.woff2': 'empty'}, nodePaths: [path.join(root, 'node_modules')], metafile: true,
      plugins: [{name: 'node-free', setup(b) {
        b.onResolve({filter: /^(node:|(fs|path|os|crypto|child_process|stream|util|events|url|net|http|https|zlib|worker_threads)(\/.*)?$)/}, (a) => { nodeImports.add(`${a.path} <- ${path.relative(SRC, a.importer)}`); return {path: a.path, external: true}; });
        b.onResolve({filter: /^electron$/}, (a) => { nodeImports.add(`electron <- ${path.relative(SRC, a.importer)}`); return {path: a.path, external: true}; });
      }}]});
  } catch (e) {
    assert.fail(`renderer bundle failed: ${(e.errors ?? []).slice(0, 5).map((x) => `${x.text} (${x.location?.file}:${x.location?.line})`).join('; ') || e.message}`);
  }
  for (const input of Object.keys(result.metafile.inputs)) {
    const rel = input.replace(/\\/g, '/');
    // Pure shared services (search, calendar, reminders) are legitimately reused by the renderer; the backend, main,
    // preload, IPC registration and native runner are main-process only. Node use anywhere is caught by the resolver above.
    if (/(^|\/)electron\/(native\/|backend\.ts|main\.ts|preload\.ts|ipc\.ts)/.test(rel)) mainProcess.add(rel);
  }
  assert.deepEqual([...nodeImports], [], 'renderer code imports Node or Electron modules');
  assert.deepEqual([...mainProcess], [], 'renderer bundle includes main-process modules');
});

// ---------------------------------------------------------------------------------------------------------------
// 3D renderer: steady-state GPU allocation and complete release
// ---------------------------------------------------------------------------------------------------------------

function countingGL() {
  const live = new Set();
  let created = 0, uploads = 0, lost = false;
  const mk = (kind) => () => { const o = {kind, n: ++created}; live.add(o); return o; };
  const del = (o) => { if (o) live.delete(o); };
  const constants = new Map();
  const api = {
    createShader: mk('shader'), createProgram: mk('program'), createBuffer: mk('buffer'), createVertexArray: mk('vao'), createTexture: mk('texture'), createFramebuffer: mk('fb'), createRenderbuffer: mk('rb'),
    deleteShader: del, deleteProgram: del, deleteBuffer: del, deleteVertexArray: del, deleteTexture: del, deleteFramebuffer: del, deleteRenderbuffer: del,
    getShaderParameter: () => true, getProgramParameter: () => true, getShaderInfoLog: () => '', getProgramInfoLog: () => '', getUniformLocation: () => ({}),
    isContextLost: () => lost, bufferData: () => { uploads++; }, getExtension: () => null,
  };
  const gl = new Proxy(api, {get(tg, k) { if (k in tg) return tg[k]; if (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)) { if (!constants.has(k)) constants.set(k, constants.size + 1); return constants.get(k); } return () => {}; }});
  return {gl, live, get created() { return created; }, get uploads() { return uploads; }, lose() { lost = true; }};
}

test('3D renderer: no per-frame GPU allocation across quality/object changes, and dispose releases every object even after context loss', async (t) => {
  if (!needs(t, S3)) return;
  const g = countingGL();
  const r = S3.createSceneRenderer(g.gl);
  r.renderAt(S3.normalizeScene({}), 0, 640, 360);
  const afterFirst = g.created;
  for (let i = 0; i < 120; i++) {
    const scene = S3.normalizeScene({quality: S3.QUALITY_IDS[i % 3], objects: {orbs: i % 40, planes: i % 5, particles: (i * 97) % 5000}, motion: {seed: i}});
    assert.equal(r.renderAt(scene, i / 7, 320 + i, 200 + i).ok, true);
  }
  assert.equal(g.created, afterFirst, `renderAt allocated ${g.created - afterFirst} GPU objects over 120 frames`);
  g.lose();
  assert.equal(r.renderAt(S3.normalizeScene({}), 0, 64, 64).ok, false);
  r.dispose();
  assert.equal(g.live.size, 0, `still live after dispose: ${[...g.live].map((o) => o.kind).join(', ')}`);
  r.dispose();
  assert.equal(r.renderAt(S3.normalizeScene({}), 0, 64, 64).ok, false);
});

test('3D scene import: a hostile but valid-size scene is clamped to the published limits; no field outside the schema survives', async (t) => {
  if (!needs(t, S3)) return;
  const hostile = JSON.stringify({version: 1, quality: 'ultra', camera: {fov: 1e9, distance: -5, autoOrbit: 'yes', __proto__: {x: 1}}, objects: {orbs: 1e6, particles: '99999', planes: NaN},
    limits: {fps: 1000, dpr: 64}, motion: {speed: Infinity, seed: -1}, script: '<img src=x onerror=alert(1)>', material: {hue: '1e400'}});
  const p = S3.parseSceneJson(hostile);
  assert.equal(p.ok, true);
  const s = p.scene;
  assert.equal(s.quality, S3.DEFAULT_SCENE.quality);
  assert.equal(s.camera.fov, S3.LIMITS.camera.fov.max);
  assert.equal(s.camera.distance, S3.LIMITS.camera.distance.min);
  assert.equal(typeof s.camera.autoOrbit, 'boolean');
  assert.ok(s.objects.orbs <= S3.GL_LIMITS.maxOrbs && s.objects.particles <= S3.GL_LIMITS.maxParticles);
  assert.ok(s.limits.fps <= 60 && s.limits.dpr <= S3.GL_LIMITS.maxDpr);
  assert.deepEqual(Object.keys(s).sort(), ['camera', 'lighting', 'limits', 'material', 'motion', 'objects', 'quality', 'version']);
  assert.ok(!S3.serializeScene(s).includes('onerror'));
  assert.ok(!S3.fallbackSvg(s, 1e308).includes('NaN') && !S3.fallbackSvg(s, NaN).includes('Infinity'));
  assert.equal(S3.parseSceneJson(' '.repeat(S3.MAX_SCENE_BYTES) + '{}').ok, false, 'padding counts toward the byte limit');
});
