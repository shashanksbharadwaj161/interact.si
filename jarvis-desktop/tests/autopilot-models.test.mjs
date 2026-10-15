// Local AI / speech runtime tests: chat streaming and cancellation, model runtime (health, list, switch, unload, profiles),
// model-pack validation and import, guarded downloads, speech capability handling, audio helpers and the Models screen markup.
// Bundles the real TypeScript in memory. No network, no microphone, no real Ollama, no files outside the test's own temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = ['ArrowClockwise', 'Cube', 'DownloadSimple', 'Eject', 'FolderOpen', 'ShieldCheck', 'Stop', 'CircleNotch', 'Info', 'Warning', 'WarningCircle'];
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'autopilot-models-entry.ts',
    loader: 'tsx',
    contents: `
      export * as chat from './electron/services/chat.ts';
      export * as models from './electron/services/models.ts';
      export * as speech from './electron/services/speech.ts';
      export * as netGuard from './electron/services/netGuard.ts';
      export * as audio from './src/ui/audio.ts';
      export { ModelsView } from './src/components/Models.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'icon-stub',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n') }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { chat, models, speech, netGuard, audio, ModelsView, createElement, renderToStaticMarkup } = mod;

// ---------- shared fakes ----------

const ENDPOINT = 'http://127.0.0.1:11434';
const CLOUD = 'https://cloud.test';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const settingsOf = (over = {}) => ({ onboarded: true, mode: 'offline', theme: 'graphite', reduceMotion: false, startInTray: false, localModel: 'tiny:1b', localEndpoint: ENDPOINT, cloudModel: 'c-model', voice: '', allowedRoots: [], approvedApps: [], retainDays: 90, ...over });

/** Guarded fetch over a route table; every call is recorded. Handlers receive (url, init). */
function guarded({ mode = 'offline', key = false, routes }) {
  const calls = [];
  const gf = netGuard.createGuardedFetch({
    mode: () => mode, hasCloudKey: () => key, cloudOriginOverride: CLOUD,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const handler = routes[`${init?.method ?? 'GET'} ${new URL(url).pathname}`] ?? routes[new URL(url).pathname] ?? routes['*'];
      if (!handler) return json({ error: 'no route' }, 404);
      return handler(url, init);
    },
  });
  return { gf, calls };
}

function fakeStore(settings, chatLog = []) {
  const state = { settings, chat: [...chatLog] };
  let n = 0;
  return { state, snapshot: () => state, mutate: async (fn) => { fn(state); }, id: () => `id${++n}`, nowIso: () => '2026-10-14T00:00:00.000Z' };
}

/** A ReadableStream whose chunks are pushed by the test, so cancellation can happen mid-stream. */
function controlledStream(signalOwner) {
  let ctrl;
  const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  signalOwner?.addEventListener?.('abort', () => { try { ctrl.error(signalOwner.reason ?? new DOMException('Aborted', 'AbortError')); } catch { /* already closed */ } });
  return { body, push: (s) => ctrl.enqueue(enc.encode(s)), end: () => ctrl.close() };
}
const nd = (...objs) => objs.map((o) => JSON.stringify(o) + '\n').join('');
const streamOf = (text, chunk = 7) => new ReadableStream({ start(c) { const e = new TextEncoder().encode(text); for (let i = 0; i < e.length; i += chunk) c.enqueue(e.subarray(i, i + chunk)); c.close(); } });
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------- chat: streaming, cancellation, routing ----------

test('streaming local chat joins fragments split across chunks and reports each delta', async () => {
  const body = nd({ message: { content: 'Hel' } }, { message: { content: 'lo, ' } }, { message: { content: 'wörld' } }, { done: true });
  const { gf, calls } = guarded({ routes: { 'POST /api/chat': () => new Response(streamOf(body, 5)) } });
  const deltas = [];
  const text = await chat.ollamaChat(gf, settingsOf(), [{ role: 'user', content: 'hi' }], { onDelta: (d) => deltas.push(d) });
  assert.equal(text, 'Hello, wörld');
  assert.equal(deltas.join(''), text);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.stream, true);
  assert.equal(sent.keep_alive, chat.LOCAL_KEEP_ALIVE);
  assert.equal(sent.options, undefined, 'no profile means no options, as before');
});

test('resource profile reaches the request: keep_alive and num_ctx', async () => {
  const { gf, calls } = guarded({ routes: { 'POST /api/chat': () => json({ message: { content: 'ok' } }) } });
  await chat.ollamaChat(gf, settingsOf(), [{ role: 'user', content: 'hi' }], { profile: { keepAlive: '30s', numCtx: 2048 } });
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.keep_alive, '30s');
  assert.deepEqual(sent.options, { num_ctx: 2048 });
  assert.equal(sent.stream, false);
});

test('a stream error line or a malformed line fails honestly instead of inventing text', async () => {
  const bad = guarded({ routes: { 'POST /api/chat': () => new Response(streamOf(nd({ message: { content: 'par' } }, { error: 'out of memory' }))) } });
  await assert.rejects(chat.ollamaChat(bad.gf, settingsOf(), [], { onDelta() {} }), /Ollama reported: out of memory/);
  const junk = guarded({ routes: { 'POST /api/chat': () => new Response(streamOf('not json\n')) } });
  await assert.rejects(chat.ollamaChat(junk.gf, settingsOf(), [], { onDelta() {} }), /malformed stream line/);
  const empty = guarded({ routes: { 'POST /api/chat': () => new Response(streamOf(nd({ done: true }))) } });
  await assert.rejects(chat.ollamaChat(empty.gf, settingsOf(), [], { onDelta() {} }), /empty reply/);
});

test('cancelling mid-stream keeps the partial reply, adds a system note, and stops reading', async () => {
  let cs;
  const { gf } = guarded({ routes: { 'POST /api/chat': (_u, init) => { cs = controlledStream(init.signal); return new Response(cs.body); } } });
  const store = fakeStore(settingsOf());
  const svc = new chat.ChatService({ store, secrets: { configured: async () => false, reveal: async () => null }, fetch: gf });
  const seen = [];
  const h = svc.start('tell me a story', { onDelta: (d) => seen.push(d) });
  assert.equal(svc.busy, true);
  await tick();
  cs.push(nd({ message: { content: 'Once ' } }));
  await tick();
  cs.push(nd({ message: { content: 'upon' } }));
  await tick();
  assert.equal(svc.cancel(h.id), true);
  const final = await h.done;
  assert.equal(final.source, 'system');
  assert.match(final.text, /Stopped by you\. The reply above is incomplete\./);
  assert.match(final.text, /not sent to any cloud provider/);
  assert.deepEqual(seen, ['Once ', 'upon']);
  assert.deepEqual(store.state.chat.map((m) => [m.role, m.source, m.text.startsWith('Stopped') ? 'note' : m.text]), [['user', 'local', 'tell me a story'], ['assistant', 'local', 'Once upon'], ['assistant', 'system', 'note']]);
  assert.equal(svc.busy, false, 'the slot is free again');
});

test('cancelling before any text arrives stores only the note', async () => {
  const { gf } = guarded({ routes: { 'POST /api/chat': (_u, init) => new Response(controlledStream(init.signal).body) } });
  const store = fakeStore(settingsOf());
  const svc = new chat.ChatService({ store, secrets: { configured: async () => false, reveal: async () => null }, fetch: gf });
  const h = svc.start('hello', { onDelta() {} });
  await tick();
  h.cancel();
  const final = await h.done;
  assert.match(final.text, /No reply was generated/);
  assert.deepEqual(store.state.chat.map((m) => m.source), ['local', 'system']);
});

test('only one generation at a time; cancel with a wrong id does nothing; a throwing sink does not stop the reply', async () => {
  const { gf } = guarded({ routes: { 'POST /api/chat': () => new Response(streamOf(nd({ message: { content: 'fine' } }, { done: true }))) } });
  const store = fakeStore(settingsOf());
  const svc = new chat.ChatService({ store, secrets: { configured: async () => false, reveal: async () => null }, fetch: gf });
  const first = svc.start('one', { onDelta() { throw new Error('sink broke'); } });
  const second = svc.start('two');
  await assert.rejects(second.done, /already being generated/);
  assert.equal(second.id, '');
  assert.equal(svc.cancel('someone-else'), false);
  const reply = await first.done;
  assert.deepEqual([reply.source, reply.text], ['local', 'fine']);
  assert.equal(store.state.chat.filter((m) => m.role === 'user').length, 1, 'the refused start stored nothing');
  await assert.rejects(svc.start('   ').done, /empty/i);
});

test('the chat profile hook is applied to local chats and never to cloud chats', async () => {
  const profile = () => ({ keepAlive: '5m', numCtx: 4096 });
  const local = guarded({ routes: { 'POST /api/chat': () => json({ message: { content: 'ok' } }) } });
  await chat.sendChat({ store: fakeStore(settingsOf()), secrets: { configured: async () => false, reveal: async () => null }, fetch: local.gf, profile }, 'hi');
  assert.equal(JSON.parse(local.calls[0].init.body).keep_alive, '5m');
  const cloud = guarded({ mode: 'online', key: true, routes: { 'POST /v1/messages': () => json({ content: [{ type: 'text', text: 'cloud ok' }] }) } });
  const reply = await chat.sendChat({ store: fakeStore(settingsOf({ mode: 'online' })), secrets: { configured: async () => true, reveal: async () => 'k'.repeat(30) }, fetch: cloud.gf, cloudOrigin: CLOUD, profile }, 'hi');
  assert.equal(reply.source, 'cloud');
  const body = JSON.parse(cloud.calls[0].init.body);
  assert.equal(body.keep_alive, undefined);
  assert.equal(body.options, undefined);
});

test('explicit online with no key is denied: no request of any kind, no fallback to the local model', () => {
  assert.deepEqual(chat.resolveChatRoute({ mode: 'online' }, false), { route: 'cloud', denied: 'No cloud API key is configured. Add a key in Settings or switch to offline mode' });
  assert.deepEqual(chat.resolveChatRoute({ mode: 'online' }, true), { route: 'cloud', denied: null });
  assert.deepEqual(chat.resolveChatRoute({ mode: 'offline' }, true), { route: 'local', denied: null });
});

test('online streaming without a key through the service makes zero requests', async () => {
  const { gf, calls } = guarded({ mode: 'online', routes: {} });
  const store = fakeStore(settingsOf({ mode: 'online' }));
  const svc = new chat.ChatService({ store, secrets: { configured: async () => false, reveal: async () => { throw new Error('must not reveal'); } }, fetch: gf, cloudOrigin: CLOUD });
  const final = await svc.start('hello', { onDelta() {} }).done;
  assert.equal(final.source, 'system');
  assert.match(final.text, /No cloud API key is configured/);
  assert.equal(calls.length, 0);
});

test('cloud streaming parses SSE text deltas, and cancelling says the provider may have the message', async () => {
  const sse = (...evs) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const ok = guarded({ mode: 'online', key: true, routes: { 'POST /v1/messages': () => new Response(streamOf(sse(
    { type: 'message_start' }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi ' } },
    { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'there' } }, { type: 'message_stop' }), 9)) } });
  const got = [];
  const text = await chat.cloudChat(ok.gf, settingsOf({ mode: 'online' }), 'k'.repeat(30), [{ role: 'user', content: 'x' }], CLOUD, { onDelta: (d) => got.push(d) });
  assert.equal(text, 'Hi there');
  assert.deepEqual(got, ['Hi ', 'there']);
  assert.equal(JSON.parse(ok.calls[0].init.body).stream, true);
  assert.equal(ok.calls[0].init.headers['x-api-key'], 'k'.repeat(30));

  let cs;
  const live = guarded({ mode: 'online', key: true, routes: { 'POST /v1/messages': (_u, init) => { cs = controlledStream(init.signal); return new Response(cs.body); } } });
  const store = fakeStore(settingsOf({ mode: 'online' }));
  const svc = new chat.ChatService({ store, secrets: { configured: async () => true, reveal: async () => 'k'.repeat(30) }, fetch: live.gf, cloudOrigin: CLOUD });
  const h = svc.start('secret', { onDelta() {} });
  await tick();
  cs.push(sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'part' } }));
  await tick();
  h.cancel();
  const final = await h.done;
  assert.match(final.text, /may have reached the cloud provider/);
  assert.equal(store.state.chat[1].text, 'part');
});

test('a stream that goes quiet is abandoned as a timeout, not reported as a user cancel', async () => {
  await assert.rejects(
    chat.withIdleSignal(undefined, 20, (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)))),
    (e) => e.name === 'TimeoutError',
  );
  await assert.rejects(
    chat.withIdleSignal(AbortSignal.abort(), 1000, async () => 'never'),
    chat.ChatCancelled,
  );
});

test('a reader abort is an error, never a normal end of stream', async () => {
  const ac = new AbortController();
  const cs = controlledStreamQuiet();
  const it = chat.readNdjson(cs.body, ac.signal);
  cs.push(nd({ a: 1 }));
  assert.deepEqual((await it.next()).value, { a: 1 });
  const next = it.next();
  ac.abort();
  await assert.rejects(next, (e) => e.name === 'AbortError');
});
/** Like controlledStream but cancelling the reader just closes it, as real fetch bodies do. */
function controlledStreamQuiet() {
  let ctrl;
  const enc = new TextEncoder();
  const body = new ReadableStream({ start(c) { ctrl = c; }, cancel() { /* reader.cancel resolves pending reads as done */ } });
  return { body, push: (s) => ctrl.enqueue(enc.encode(s)) };
}

test('a stream that ends without its end marker keeps the partial text and says it is incomplete', async () => {
  const cut = guarded({ routes: { 'POST /api/chat': () => new Response(streamOf(nd({ message: { content: 'half an ans' } }))) } });
  await assert.rejects(chat.ollamaChat(cut.gf, settingsOf(), [], { onDelta() {} }), (e) => e instanceof chat.ChatIncomplete && e.partial === 'half an ans');
  const store = fakeStore(settingsOf());
  const svc = new chat.ChatService({ store, secrets: { configured: async () => false, reveal: async () => null }, fetch: cut.gf });
  const final = await svc.start('question', { onDelta() {} }).done;
  assert.equal(final.source, 'system');
  assert.match(final.text, /ended before the reply was finished/);
  assert.match(final.text, /not sent to any cloud provider/);
  assert.deepEqual(store.state.chat.map((m) => [m.role, m.source, m.text.slice(0, 12)]), [['user', 'local', 'question'], ['assistant', 'local', 'half an ans'], ['assistant', 'system', 'The connecti']]);
  assert.equal(svc.busy, false);
  const sse = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'cut' } })}\n\n`;
  const cloud = guarded({ mode: 'online', key: true, routes: { 'POST /v1/messages': () => new Response(streamOf(sse)) } });
  await assert.rejects(chat.cloudChat(cloud.gf, settingsOf({ mode: 'online' }), 'k'.repeat(30), [{ role: 'user', content: 'x' }], CLOUD, { onDelta() {} }), chat.ChatIncomplete);
});

// ---------- model runtime: health, list, switch, unload, profiles ----------

const TAGS = { models: [
  { name: 'tiny:1b', size: 1_300_000_000, modified_at: '2026-10-01T00:00:00Z', details: { family: 'llama', parameter_size: '1B', quantization_level: 'Q4_K_M' } },
  { name: 'other:latest', size: 4_000_000_000, details: {} },
] };

function runtimeFixture({ settings = settingsOf(), routes = {}, mode, guard, io, adapters, ramGB = 16 } = {}) {
  const g = guarded({ mode: mode ?? settings.mode, routes: {
    'GET /api/tags': () => json(TAGS), 'GET /api/version': () => json({ version: '0.9.2' }),
    'GET /api/ps': () => json({ models: [{ name: 'tiny:1b', size: 2_000_000_000, size_vram: 0, expires_at: '2026-10-14T01:00:00Z' }] }),
    'POST /api/generate': () => json({ done: true }), 'POST /api/show': () => json({ capabilities: ['completion', 'vision'] }),
    ...routes,
  } });
  let n = 0;
  const jobEvents = [];
  const rt = new models.ModelRuntime({ fetch: g.gf, settings: () => settings, ramGB: () => ramGB, guard, io, adapters, newId: () => `job${++n}`, onJob: (j) => jobEvents.push(j.state) });
  return { rt, calls: g.calls, jobEvents, settings };
}
const waitJob = async (rt, id) => { for (let i = 0; i < 200; i++) { const j = rt.jobs().find((x) => x.id === id); if (j && j.state !== 'running') return j; await tick(); } throw new Error('job did not finish'); };

test('health reports ready with version, latency and loaded models', async () => {
  const { rt } = runtimeFixture();
  const h = await rt.health();
  assert.equal(h.state, 'ready');
  assert.equal(h.version, '0.9.2');
  assert.equal(h.configuredModelInstalled, true);
  assert.equal(h.installedCount, 2);
  assert.equal(h.loaded[0].name, 'tiny:1b');
  assert.equal(typeof h.latencyMs, 'number');
});

test('health distinguishes missing model, stopped server and a blocked endpoint', async () => {
  const missing = await runtimeFixture({ settings: settingsOf({ localModel: 'nope' }) }).rt.health();
  assert.equal(missing.state, 'model-missing');
  assert.match(missing.reason, /not installed/);
  const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const down = await runtimeFixture({ routes: { 'GET /api/tags': refused, 'GET /api/version': refused, 'GET /api/ps': refused } }).rt.health();
  assert.equal(down.state, 'server-down');
  assert.match(down.reason, /not running at http:\/\/127\.0\.0\.1:11434/);
  const blocked = runtimeFixture({ settings: settingsOf({ localEndpoint: 'https://evil.example' }) });
  const bh = await blocked.rt.health();
  assert.equal(bh.state, 'blocked');
  assert.equal(blocked.calls.length, 0, 'a non-loopback endpoint never reaches the network');
});

test('an older server without /api/ps or /api/version still reports ready, with notes', async () => {
  const { rt } = runtimeFixture({ routes: { 'GET /api/version': () => json({}, 404), 'GET /api/ps': () => json({}, 404) } });
  const h = await rt.health();
  assert.equal(h.state, 'ready');
  assert.equal(h.version, null);
  assert.equal(h.notes.length, 2);
});

test('list maps Ollama fields and tolerates odd entries', async () => {
  const { rt } = runtimeFixture({ routes: { 'GET /api/tags': () => json({ models: [{ name: 'a:1', size: 5, details: { family: 'x' } }, { size: 3 }, { model: 'b:2', size: -4 }] }) } });
  const r = await rt.list();
  assert.equal(r.ok, true);
  assert.deepEqual(r.models.map((m) => [m.name, m.sizeBytes, m.family]), [['a:1', 5, 'x'], ['b:2', 0, '']]);
});

test('select verifies the model is installed and only returns a settings patch', async () => {
  const f = runtimeFixture();
  const ok = await f.rt.select('other');
  assert.deepEqual(ok, { ok: true, patch: { localModel: 'other:latest' }, warmed: false });
  const bad = await f.rt.select('ghost:7b');
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not installed/);
  const invalid = await f.rt.select('../../etc');
  assert.equal(invalid.ok, false);
  assert.ok(f.calls.every((c) => !c.url.includes('/api/generate')), 'no load request unless asked');
});

test('select can warm the model with the profile keep-alive and free the others', async () => {
  const f = runtimeFixture();
  f.rt.setProfile('low-memory');
  const r = await f.rt.select('other:latest', { warm: true, unloadOthers: true });
  assert.equal(r.ok && r.warmed, true);
  const gens = f.calls.filter((c) => c.url.endsWith('/api/generate')).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(gens, [{ model: 'tiny:1b', keep_alive: 0 }, { model: 'other:latest', keep_alive: '30s' }]);
});

test('unload sends keep_alive 0, and with no name frees everything that is loaded', async () => {
  const f = runtimeFixture();
  assert.deepEqual(await f.rt.unload('tiny:1b'), { ok: true, unloaded: ['tiny:1b'] });
  assert.deepEqual(await f.rt.unload(), { ok: true, unloaded: ['tiny:1b'] });
  assert.deepEqual(JSON.parse(f.calls.at(-1).init.body), { model: 'tiny:1b', keep_alive: 0 });
  const gone = runtimeFixture({ routes: { 'POST /api/generate': () => json({ error: 'x' }, 404) } });
  assert.match((await gone.rt.unload('tiny:1b')).reason, /not installed/);
  assert.equal((await f.rt.unload('bad name!')).ok, false);
});

test('resource profiles: default keeps legacy values, profile feeds chat, recommendations follow memory', () => {
  const rt = runtimeFixture().rt;
  assert.deepEqual(rt.chatProfile(), { keepAlive: chat.LOCAL_KEEP_ALIVE, numCtx: null });
  assert.equal(rt.setProfile('performance'), 'performance');
  assert.deepEqual(rt.chatProfile(), { keepAlive: '15m', numCtx: 8192 });
  assert.throws(() => rt.setProfile('turbo'), /Unknown/);
  assert.equal(models.recommendProfile(4).id, 'low-memory');
  assert.equal(models.recommendProfile(12).id, 'balanced');
  assert.equal(models.recommendProfile(32).id, 'performance');
  assert.equal(models.recommendProfile(16, 12 * 1024 ** 3).id, 'low-memory');
  assert.equal(models.recommendProfile(0).id, 'default');
});

test('version parsing and model-name validation', () => {
  assert.deepEqual(models.parseVersion('v0.12.3-rc1'), [0, 12, 3]);
  assert.equal(models.parseVersion('banana'), null);
  assert.equal(models.compareVersions([0, 5, 5], [0, 6, 0]), -1);
  for (const good of ['llama3.2:3b', 'qwen3.5:2b', 'hf.co/user/repo:Q4_K_M', 'my-model']) assert.equal(models.validateModelName(good), good);
  for (const bad of ['', ' ', 'a b', '../x', 'http://x/y', '-flag', 'a:b:c', 'x'.repeat(300), 'a/b/c/d', 'a;rm']) assert.throws(() => models.validateModelName(bad), /invalid/, bad);
});

test('capabilities: vision, embeddings and fine-tuning are unsupported without an adapter, even if the model reports vision', async () => {
  const caps = await runtimeFixture().rt.capabilities();
  assert.deepEqual(caps.map((c) => [c.id, c.available]), [['local-vision', false], ['local-embeddings', false], ['local-finetune', false]]);
  assert.match(caps[0].reason, /reports "vision", but this app has no vision pipeline/);
  const withAdapter = await runtimeFixture({ adapters: { vision: { describeImage: async () => 'x' } } }).rt.capabilities();
  assert.equal(withAdapter[0].available, true);
  assert.match(withAdapter[0].reason, /not been verified/);
  assert.equal(withAdapter[1].available, false);
});

// ---------- model pack: validation and offline import ----------

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const PACK_ROOT = path.join(os.tmpdir(), `desktop-companion-autopilot-models-${process.pid}`);
test.after(async () => { await fsp.rm(PACK_ROOT, { recursive: true, force: true }); });

async function makePack(name, { files = { 'tiny.gguf': Buffer.from('GGUF-fake-model-bytes-0123456789') }, manifest = {}, mutate } = {}) {
  const dir = path.join(PACK_ROOT, name);
  await fsp.mkdir(dir, { recursive: true });
  for (const [f, data] of Object.entries(files)) await fsp.writeFile(path.join(dir, f), data);
  const m = { format: 'desktop-companion-modelpack', version: 1, name: 'packed:1b', files: Object.entries(files).map(([f, d]) => ({ path: f, sha256: sha(d), bytes: d.length })), template: '{{ .Prompt }}', parameters: { temperature: 0.2, stop: ['<end>'] }, ...manifest };
  if (mutate) mutate(m);
  await fsp.writeFile(path.join(dir, 'modelpack.json'), JSON.stringify(m));
  return dir;
}

test('a good pack validates with exact sizes and checksums', async () => {
  const io = models.createNodeModelPackIO();
  const dir = await makePack('good');
  const v = await models.validateModelPack(io, dir);
  assert.deepEqual([v.ok, v.errors, v.manifest.name, v.totalBytes], [true, [], 'packed:1b', 32]);
  assert.equal(v.manifest.parameters.temperature, 0.2);
});

test('pack validation rejects bad checksums, wrong sizes, missing files and non-local folders', async () => {
  const io = models.createNodeModelPackIO();
  const tampered = await makePack('tampered', { mutate: (m) => { m.files[0].sha256 = 'a'.repeat(64); } });
  assert.match((await models.validateModelPack(io, tampered)).errors.join(), /does not match its checksum/);
  const size = await makePack('size', { mutate: (m) => { m.files[0].bytes = 999; } });
  assert.match((await models.validateModelPack(io, size)).errors.join(), /is 32 bytes but the manifest says 999/);
  const missing = await makePack('missing', { mutate: (m) => { m.files.push({ path: 'ghost.gguf', sha256: 'b'.repeat(64), bytes: 5 }); } });
  assert.match((await models.validateModelPack(io, missing)).errors.join(), /"ghost.gguf" is missing/);
  for (const bad of ['relative\\dir', '\\\\server\\share\\pack', 'C:\\a\\..\\b', 'http://x/y', 42]) {
    const r = await models.validateModelPack(io, bad);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /local drive path/);
  }
  const none = await models.validateModelPack(io, path.join(PACK_ROOT, 'does-not-exist'));
  assert.match(none.errors[0], /modelpack.json was not found/);
});

test('pack paths cannot traverse, name drives or streams, use device names, or be non-GGUF', () => {
  for (const bad of ['../evil.gguf', '..\\evil.gguf', 'a/../b.gguf', '/abs.gguf', 'C:/x.gguf', 'x.gguf:stream', 'NUL.gguf', 'con', 'dir/COM1.gguf', 'a//b.gguf', 'weights.bin', 'trail. /x.gguf', '', 'x'.repeat(250) + '.gguf', 7]) {
    assert.notEqual(models.validatePackPath(bad), null, String(bad));
  }
  for (const good of ['m.gguf', 'sub/dir/Model-7b.Q4_K_M.gguf']) assert.equal(models.validatePackPath(good), null, good);
});

test('manifest problems are all reported: format, name, duplicate files, bad parameters', async () => {
  const io = models.createNodeModelPackIO();
  const dir = await makePack('badmanifest', { mutate: (m) => { m.format = 'x'; m.name = '../x'; m.files.push({ ...m.files[0] }); m.parameters = { 'BAD KEY': 1 }; m.system = 5; } });
  const v = await models.validateModelPack(io, dir);
  assert.equal(v.ok, false);
  const text = v.errors.join('\n');
  for (const part of [/format/, /name:/, /listed twice/, /parameter "BAD KEY"/, /system must be text/]) assert.match(text, part);
  const big = path.join(PACK_ROOT, 'big');
  await fsp.mkdir(big, { recursive: true });
  await fsp.writeFile(path.join(big, 'modelpack.json'), ' '.repeat(70 * 1024));
  assert.match((await models.validateModelPack(io, big)).errors[0], /could not be read/);
});

test('symlinked model files are refused, not followed', async (t) => {
  const io = models.createNodeModelPackIO();
  const dir = await makePack('linked');
  const outside = path.join(PACK_ROOT, 'outside.gguf');
  await fsp.writeFile(outside, Buffer.from('GGUF-fake-model-bytes-0123456789'));
  await fsp.rm(path.join(dir, 'tiny.gguf'));
  try { await fsp.symlink(outside, path.join(dir, 'tiny.gguf')); } catch { t.skip('this account cannot create symlinks'); return; }
  assert.match((await models.validateModelPack(io, dir)).errors.join(), /is a link/);
});

function importRoutes({ blobExists = false, createLines, uploaded = {} } = {}) {
  return {
    '*': async (url, init) => {
      const p = new URL(url).pathname;
      if (p.startsWith('/api/blobs/')) {
        if (init.method === 'HEAD') return new Response(null, { status: blobExists ? 200 : 404 });
        const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
        uploaded[p.slice('/api/blobs/'.length)] = bytes;
        return new Response(null, { status: 201 });
      }
      return json({ error: 'no route' }, 404);
    },
    'POST /api/create': () => new Response(streamOf(createLines ?? nd({ status: 'parsing GGUF' }, { status: 'writing manifest' }, { status: 'success' }))),
  };
}

test('offline import uploads verified bytes, then creates the model from blob digests; the app never leaves loopback', async () => {
  const dir = await makePack('import-ok');
  const uploaded = {};
  const f = runtimeFixture({ routes: importRoutes({ uploaded }) });
  const start = await f.rt.startImport(dir);
  assert.equal(start.ok, true);
  const job = await waitJob(f.rt, start.jobId);
  assert.deepEqual([job.state, job.kind, job.model, job.progress], ['done', 'import', 'packed:1b', 1]);
  const data = Buffer.from('GGUF-fake-model-bytes-0123456789');
  assert.deepEqual(Object.keys(uploaded), [`sha256:${sha(data)}`]);
  assert.deepEqual(uploaded[`sha256:${sha(data)}`], data);
  const create = JSON.parse(f.calls.find((c) => c.url.endsWith('/api/create')).init.body);
  assert.deepEqual(create, { model: 'packed:1b', files: { 'tiny.gguf': `sha256:${sha(data)}` }, stream: true, template: '{{ .Prompt }}', parameters: { temperature: 0.2, stop: ['<end>'] } });
  assert.ok(f.calls.every((c) => c.url.startsWith(ENDPOINT)), 'only loopback URLs');
  assert.ok(f.jobEvents.includes('running') && f.jobEvents.at(-1) === 'done');
});

test('import skips blobs Ollama already has, honours a custom name, and fails visibly on a server error line', async () => {
  const dir = await makePack('import-skip');
  const f = runtimeFixture({ routes: importRoutes({ blobExists: true }) });
  const s = await f.rt.startImport(dir, 'custom-name:q4');
  assert.equal((await waitJob(f.rt, s.jobId)).state, 'done');
  assert.equal(f.calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/api/blobs/')).length, 0);
  assert.equal(JSON.parse(f.calls.find((c) => c.url.endsWith('/api/create')).init.body).model, 'custom-name:q4');
  const failing = runtimeFixture({ routes: importRoutes({ createLines: nd({ error: 'unsupported architecture' }) }) });
  const s2 = await failing.rt.startImport(dir);
  const j2 = await waitJob(failing.rt, s2.jobId);
  assert.deepEqual([j2.state, j2.error], ['failed', 'Ollama reported: unsupported architecture']);
  const truncated = runtimeFixture({ routes: importRoutes({ createLines: nd({ status: 'parsing' }) }) });
  assert.match((await waitJob(truncated.rt, (await truncated.rt.startImport(dir)).jobId)).error, /before reporting success/);
});

test('import never starts for a rejected pack, a declined guard, or a second concurrent job', async () => {
  const dir = await makePack('import-guard');
  const bad = await makePack('import-bad', { mutate: (m) => { m.files[0].sha256 = 'c'.repeat(64); } });
  const f = runtimeFixture({ routes: importRoutes() });
  const rej = await f.rt.startImport(bad);
  assert.equal(rej.ok, false);
  assert.match(rej.reason, /Model pack rejected: .*checksum/);
  const asked = [];
  const declined = runtimeFixture({ routes: importRoutes(), guard: async (r) => { asked.push(r); return { allowed: false, reason: 'You declined' }; } });
  assert.deepEqual(await declined.rt.startImport(dir), { ok: false, reason: 'You declined' });
  assert.equal(asked[0].kind, 'import');
  assert.match(asked[0].detail, /No download happens/);
  assert.equal(declined.calls.length, 0, 'nothing reached Ollama');
  const throwing = runtimeFixture({ routes: importRoutes(), guard: async () => { throw new Error('dialog failed'); } });
  assert.match((await throwing.rt.startImport(dir)).reason, /nothing was started/);
  const slow = runtimeFixture({ routes: { ...importRoutes(), 'POST /api/create': (_u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) } });
  const first = await slow.rt.startImport(dir);
  assert.equal(first.ok, true);
  assert.match((await slow.rt.startImport(dir)).reason, /still running/);
  assert.equal(slow.rt.cancelJob(first.jobId), true);
  assert.equal((await waitJob(slow.rt, first.jobId)).state, 'cancelled');
});

// ---------- online download: explicit mode, explicit start, trusted guard ----------

test('downloads are refused offline and without a trusted guard, with zero requests', async () => {
  const offline = runtimeFixture({ guard: async () => ({ allowed: true }) });
  const r1 = await offline.rt.startPull('tiny:1b');
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /Offline mode never downloads/);
  assert.equal(offline.rt.downloadsStatus().allowed, false);
  const noGuard = runtimeFixture({ settings: settingsOf({ mode: 'online' }) });
  const r2 = await noGuard.rt.startPull('tiny:1b');
  assert.match(r2.reason, /No trusted confirmation/);
  for (const f of [offline, noGuard]) assert.equal(f.calls.length, 0);
  assert.equal((await runtimeFixture({ settings: settingsOf({ mode: 'online' }), guard: async () => ({ allowed: true }) }).rt.startPull('bad name')).ok, false);
});

test('a guard that declines stops the download before any request', async () => {
  const seen = [];
  const f = runtimeFixture({ settings: settingsOf({ mode: 'online' }), guard: async (r) => { seen.push(r); return { allowed: false }; } });
  assert.deepEqual(await f.rt.startPull('qwen3.5:2b'), { ok: false, reason: 'The request was declined' });
  assert.deepEqual([seen[0].kind, seen[0].model, seen[0].endpoint], ['pull', 'qwen3.5:2b', ENDPOINT]);
  assert.equal(f.calls.length, 0);
});

test('an approved download streams progress, and can be cancelled', async () => {
  const lines = nd({ status: 'pulling manifest' }, { status: 'pulling abc', total: 100, completed: 40 }, { status: 'pulling abc', total: 100, completed: 100 }, { status: 'success' });
  const f = runtimeFixture({ settings: settingsOf({ mode: 'online' }), guard: async () => ({ allowed: true }), routes: { 'POST /api/pull': () => new Response(streamOf(lines)) } });
  const s = await f.rt.startPull('qwen3.5:2b');
  assert.equal(s.ok, true);
  const job = await waitJob(f.rt, s.jobId);
  assert.deepEqual([job.state, job.progress, job.kind], ['done', 1, 'pull']);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { model: 'qwen3.5:2b', stream: true });

  let cs;
  const live = runtimeFixture({ settings: settingsOf({ mode: 'online' }), guard: async () => ({ allowed: true }), routes: { 'POST /api/pull': (_u, init) => { cs = controlledStream(init.signal); return new Response(cs.body); } } });
  const s2 = await live.rt.startPull('qwen3.5:2b');
  await tick();
  cs.push(nd({ status: 'pulling abc', total: 200, completed: 50 }));
  await tick();
  assert.equal(live.rt.jobs()[0].progress, 0.25);
  assert.equal(live.rt.cancelJob(s2.jobId), true);
  assert.equal((await waitJob(live.rt, s2.jobId)).state, 'cancelled');
  assert.equal(live.rt.cancelJob(s2.jobId), false, 'already finished');
});

test('a throwing job or profile observer neither strands a job nor undoes a change', async () => {
  const g = guarded({ routes: { 'POST /api/pull': () => new Response(streamOf(nd({ status: 'success' }))) } });
  const rt = new models.ModelRuntime({
    fetch: g.gf, settings: () => settingsOf({ mode: 'online' }), guard: async () => ({ allowed: true }), newId: () => 'job1',
    onJob: () => { throw new Error('observer broke'); }, onProfile: () => { throw new Error('observer broke'); },
  });
  const s = await rt.startPull('qwen3.5:2b');
  assert.equal(s.ok, true);
  assert.equal((await waitJob(rt, s.jobId)).state, 'done');
  assert.equal(rt.setProfile('low-memory'), 'low-memory');
  assert.equal(rt.profile().id, 'low-memory');
});

test('overview combines health, list, profiles, capabilities and the download gate for the UI', async () => {
  const f = runtimeFixture({ ramGB: 8 });
  const o = await f.rt.overview();
  assert.equal(o.health.state, 'ready');
  assert.equal(o.installed.length, 2);
  assert.equal(o.recommendedProfile.id, 'balanced');
  assert.equal(o.downloads.allowed, false);
  assert.equal(o.capabilities.length, 3);
  assert.deepEqual(o.profiles.map((p) => p.id), ['default', 'low-memory', 'balanced', 'performance']);
});

// ---------- speech: local TTS/STT capability handling ----------

function speechFixture({ probe = { voices: ['Anna', 'Ben'], recognizers: ['en-US'] }, voice = '', engines, speakImpl, transcribeImpl } = {}) {
  const log = { speak: [], transcribe: [], written: [], removed: [], probes: 0 };
  const native = {
    probeSpeech: async () => { log.probes++; if (probe instanceof Error) throw probe; return probe; },
    speak: async (text, v, signal) => { log.speak.push([text, v]); return speakImpl ? speakImpl(signal) : { ok: true }; },
    transcribe: async (file) => { log.transcribe.push(file); return transcribeImpl ? transcribeImpl() : { text: 'hello world' }; },
  };
  let n = 0;
  const sp = new speech.Speech({ native, settings: () => settingsOf({ voice }), tmpDir: 'C:\\tmp', newId: () => `t${++n}`, engines, writeFile: async (f, b) => { log.written.push([f, b.length]); }, removeFile: async (f) => { log.removed.push(f); } });
  return { sp, log };
}
const WAV = Array.from({ length: 800 }, (_, i) => (i % 50) - 25); // raw 16-bit samples, accepted by validateAudio

test('speech status reports installed voices and recognizers, and is never cloud', async () => {
  const { sp } = speechFixture();
  const s = await sp.status();
  assert.deepEqual([s.tts.available, s.tts.voices, s.stt.available, s.stt.recognizers, s.stt.quality, s.cloud], [true, ['Anna', 'Ben'], true, ['en-US'], 'basic', false]);
  const caps = await sp.capabilities();
  assert.deepEqual(caps.map((c) => [c.id, c.available]), [['tts', true], ['stt', true]]);
});

test('a selected voice that is not installed makes TTS unavailable with a clear reason, and speak refuses without calling the engine', async () => {
  const { sp, log } = speechFixture({ voice: 'Zed' });
  const s = await sp.status();
  assert.equal(s.tts.available, false);
  assert.equal(s.tts.selectedVoiceInstalled, false);
  assert.match(s.tts.reason, /Selected voice "Zed" is not installed/);
  assert.equal((await sp.capabilities())[0].available, false);
  const r = await sp.speak('hello');
  assert.equal(r.ok, false);
  assert.match(r.reason, /not installed/);
  assert.equal(log.speak.length, 0);
});

test('no voices, no recognizer, or a failed probe each report unavailable without faking anything', async () => {
  const none = speechFixture({ probe: { voices: [], recognizers: [] } });
  assert.match((await none.sp.status()).tts.reason, /No Windows voices/);
  assert.deepEqual(await none.sp.speak('hi'), { ok: false, reason: 'No Windows voices are installed' });
  const t = await none.sp.transcribe(WAV);
  assert.deepEqual(t, { text: '', reason: 'No Windows speech recognizer is installed' });
  assert.equal(none.log.written.length, 0, 'audio is not even written to disk');
  const broken = speechFixture({ probe: new Error('powershell missing') });
  const s = await broken.sp.status();
  assert.deepEqual([s.tts.available, s.stt.available], [false, false]);
  assert.match(s.stt.reason, /powershell missing/);
});

test('speaking a new text cancels the previous one, and cancel() stops the current speech', async () => {
  const slow = (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ ok: true }), { once: true }));
  const { sp } = speechFixture({ speakImpl: slow });
  const first = sp.speak('first');
  await tick();
  assert.equal((await sp.status()).speaking, true);
  const second = sp.speak('second');
  assert.deepEqual(await first, { ok: false, reason: 'Speech was stopped' });
  await tick();
  assert.equal(sp.cancel(), true);
  assert.deepEqual(await second, { ok: false, reason: 'Speech was stopped' });
  assert.equal(sp.cancel(), false, 'nothing left to stop');
  await assert.rejects(sp.speak('  '), /text is required/);
  await assert.rejects(sp.speak('x'.repeat(5000)), /too long/);
});

test('transcription writes a temp file, always removes it, and can be cancelled', async () => {
  const ok = speechFixture();
  assert.deepEqual(await ok.sp.transcribe(WAV), { text: 'hello world' });
  assert.equal(ok.log.written.length, 1);
  assert.deepEqual(ok.log.removed, [ok.log.transcribe[0]]);
  assert.match(ok.log.transcribe[0], /^C:\\tmp\\jarvis-t1\.wav$/);
  const failing = speechFixture({ transcribeImpl: async () => { throw new Error('recognizer crashed'); } });
  assert.deepEqual(await failing.sp.transcribe(WAV), { text: '', reason: 'recognizer crashed' });
  assert.equal(failing.log.removed.length, 1);
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = speechFixture({ transcribeImpl: async () => { await gate; return { text: 'late words' }; } });
  const pending = slow.sp.transcribe(WAV);
  await tick();
  assert.equal((await slow.sp.status()).transcribing, true);
  assert.deepEqual(await slow.sp.transcribe(WAV), { text: '', reason: 'Another transcription is already running' });
  assert.equal(slow.sp.cancelTranscribe(), true);
  release();
  assert.deepEqual(await pending, { text: '', cancelled: true, reason: 'Transcription was cancelled' });
  assert.equal(slow.log.removed.length, 1);
  await assert.rejects(ok.sp.transcribe('nope'), /array/);
});

test('extra local engines are reported only when injected and available; choosing a missing one never falls back', async () => {
  const spoken = [];
  const piper = { id: 'piper', name: 'Local neural voice', probe: async () => ({ available: true }), speak: async (t, o) => { spoken.push([t, o.voice]); return { ok: true }; } };
  const whisper = { id: 'whisper', name: 'Local Whisper', probe: async () => ({ available: false, reason: 'model file not found' }), transcribe: async () => ({ text: 'x' }) };
  const { sp, log } = speechFixture({ engines: { tts: [piper], stt: [whisper] }, voice: '' });
  const s = await sp.status();
  assert.deepEqual(s.extraEngines.map((e) => [e.id, e.kind, e.available, e.reason]), [['piper', 'tts', true, undefined], ['whisper', 'stt', false, 'model file not found']]);
  assert.deepEqual(await sp.speak('hi', { engine: 'piper' }), { ok: true });
  assert.deepEqual(spoken, [['hi', '']]);
  assert.equal(log.speak.length, 0, 'the Windows engine was not used');
  const unavailable = await sp.transcribe(WAV, { engine: 'whisper' });
  assert.match(unavailable.reason, /Local Whisper is unavailable: model file not found/);
  assert.equal(log.transcribe.length, 0, 'no silent fallback to the Windows recognizer');
  assert.match((await sp.speak('hi', { engine: 'ghost' })).reason, /not available/);
  const { sp: plain } = speechFixture();
  assert.deepEqual((await plain.status()).extraEngines, []);
});

// ---------- audio helpers (no microphone is opened) ----------

test('micSupport, micPermission and listMicrophones never capture and degrade cleanly', async () => {
  assert.equal(audio.micSupport({}).supported, false);
  assert.equal(audio.micSupport({ mediaDevices: { getUserMedia() {} } }).supported, false, 'needs MediaRecorder too');
  assert.deepEqual(audio.micSupport({ mediaDevices: { getUserMedia() {} }, hasMediaRecorder: true }), { supported: true });
  assert.equal(await audio.micPermission({ permissions: { query: async () => ({ state: 'denied' }) } }), 'denied');
  assert.equal(await audio.micPermission({ permissions: { query: async () => { throw new Error('nope'); } } }), 'unknown');
  assert.equal(await audio.micPermission({}), 'unknown');
  let captured = 0;
  const env = { mediaDevices: { getUserMedia() { captured++; }, enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'a', label: '' }, { kind: 'videoinput', deviceId: 'v', label: 'cam' }, { kind: 'audioinput', deviceId: 'b', label: 'USB mic' }] } };
  assert.deepEqual(await audio.listMicrophones(env), [{ id: 'a', label: 'Microphone 1' }, { id: 'b', label: 'USB mic' }]);
  assert.equal(captured, 0);
  assert.deepEqual(await audio.listMicrophones({ mediaDevices: { enumerateDevices: async () => { throw new Error('x'); } } }), []);
});

test('clipQuality and trimSilence judge and shorten recordings', () => {
  assert.equal(audio.clipQuality(0.5, 100).usable, false);
  assert.deepEqual(['silent', false], [audio.clipQuality(0.001, 2000).level, audio.clipQuality(0.001, 2000).usable]);
  assert.deepEqual([audio.clipQuality(0.03, 2000).level, audio.clipQuality(0.03, 2000).usable], ['quiet', true]);
  assert.equal(audio.clipQuality(1, 2000).level, 'clipped');
  assert.deepEqual([audio.clipQuality(0.4, 2000).level, audio.clipQuality(0.4, 2000).message], ['good', '']);
  const s = new Float32Array(16000 * 3);
  for (let i = 16000; i < 16200; i++) s[i] = 0.5;
  const t = audio.trimSilence(s, 16000);
  assert.equal(t.length, 200 + 2 * 2400, 'speech plus a 150 ms pad each side');
  const quiet = new Float32Array(100);
  assert.equal(audio.trimSilence(quiet, 16000), quiet, 'all-silent input is returned untouched');
});

test('encodeWav writes a valid 16 kHz mono PCM header that the backend validator format expects', () => {
  const wav = audio.encodeWav(Float32Array.from([0, 1, -1, 0.5]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.deepEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true), v.getUint32(40, true)], [1, 1, 16000, 16, 8]);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32768);
});

// ---------- Models screen markup ----------

function viewProps(over = {}) {
  const overview = {
    health: { state: 'ready', endpoint: ENDPOINT, version: '0.9.2', configuredModel: 'tiny:1b', configuredModelInstalled: true, installedCount: 2, loaded: [{ name: 'tiny:1b', sizeBytes: 2e9, vramBytes: 0, expiresAt: 'x' }], latencyMs: 12, notes: [] },
    installed: [{ name: 'tiny:1b', sizeBytes: 1.3e9, family: 'llama', parameterSize: '1B', quantization: 'Q4_K_M', modifiedAt: '' }, { name: 'other:latest', sizeBytes: 4e9, family: '', parameterSize: '', quantization: '', modifiedAt: '' }],
    installedError: null, profiles: [...models.RESOURCE_PROFILES], activeProfile: 'default', recommendedProfile: { id: 'balanced', reason: '16 GB suits it.' },
    jobs: [{ id: 'j1', kind: 'pull', model: 'big:7b', state: 'running', status: 'pulling', progress: 0.4, startedAt: 0 }],
    capabilities: [{ id: 'local-vision', name: 'Local image understanding', available: false, reason: 'Not supported: no image input path exists.' }],
    downloads: { allowed: false, reason: 'Offline mode never downloads models. Switch to online mode to download, or import a model pack.' },
  };
  const noop = () => {};
  return { overview, error: null, loading: false, currentModel: 'tiny:1b', busy: null, notice: null, packDir: '', packCheck: null, pullName: '', canBrowse: true, preview: false,
    onPackDir: noop, onPullName: noop, onRefresh: noop, onSelect: noop, onUnload: noop, onProfile: noop, onBrowse: noop, onValidate: noop, onImport: noop, onPull: noop, onCancel: noop, ...over };
}
const html = (props) => renderToStaticMarkup(createElement(ModelsView, props));

test('Models view shows runtime health, installed models, jobs and honest capability status', () => {
  const out = html(viewProps());
  for (const part of ['Ready', 'Ollama 0.9.2', 'Answered in 12 ms', 'Loaded in memory', 'In use', 'Use this model', 'other:latest', 'Low memory', 'Suggestion for this computer: Balanced', 'Download: big:7b', 'Cancel', 'Unavailable', 'no image input path exists']) {
    assert.ok(out.includes(part), `missing: ${part}`);
  }
  assert.match(out, /<progress[^>]*value="40"/);
});

test('Models view disables downloads offline and explains why; online shows the start control', () => {
  const offline = html(viewProps());
  assert.match(offline, /Downloads are off/);
  assert.match(offline, /Offline mode never downloads models/);
  assert.doesNotMatch(offline, /Start download/);
  const base = viewProps();
  const online = html(viewProps({ overview: { ...base.overview, downloads: { allowed: true, reason: null } }, pullName: 'qwen3.5:2b' }));
  assert.match(online, /Start download/);
  assert.match(online, /after you confirm/);
});

test('Models view: server down, pack errors, preview mode and busy states', () => {
  const base = viewProps();
  const down = html(viewProps({ overview: { ...base.overview, health: { ...base.overview.health, state: 'server-down', reason: 'Ollama is not running at x', loaded: [] }, installed: [], installedError: 'Ollama is not running at x' } }));
  assert.match(down, /Ollama not running/);
  assert.match(down, /List unavailable/);
  assert.match(down, /No model is loaded right now/);
  const rejected = html(viewProps({ packDir: 'C:\\p', packCheck: { ok: false, errors: ['file "a.gguf" does not match its checksum'], totalBytes: 0 } }));
  assert.match(rejected, /Pack rejected/);
  assert.match(rejected, /does not match its checksum/);
  assert.match(rejected, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Import into Ollama/s);
  const verified = html(viewProps({ packDir: 'C:\\p', packCheck: { ok: true, errors: [], totalBytes: 3e9, manifest: { name: 'p:1b', files: [{ path: 'a.gguf', sha256: 'a', bytes: 1 }] } } }));
  assert.match(verified, /Pack verified/);
  assert.match(verified, /Importing asks for your confirmation/);
  const preview = html(viewProps({ overview: null, preview: true }));
  assert.match(preview, /Browser preview/);
  assert.doesNotMatch(preview, /Use this model/);
  assert.match(html(viewProps({ overview: null })), /Checking Ollama/);
  assert.match(html(viewProps({ overview: null, error: 'boom' })), /Could not read model status/);
  const busy = html(viewProps({ busy: 'select:other:latest' }));
  assert.match(busy, /aria-busy="true"/);
});

test('formatting helpers', async () => {
  const { formatBytes } = await import('data:text/javascript;base64,' + Buffer.from((await build({ stdin: { resolveDir: root, loader: 'tsx', contents: "export { formatBytes } from './src/components/Models.tsx';" }, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', plugins: [{ name: 's', setup(b) { b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'i', namespace: 'i' })); b.onLoad({ filter: /.*/, namespace: 'i' }, () => ({ contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n') })); } }], banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});` }, logLevel: 'silent' })).outputFiles[0].text).toString('base64'));
  assert.deepEqual([formatBytes(0), formatBytes(512), formatBytes(1536), formatBytes(1.3e9), formatBytes(NaN)], ['0 B', '512 B', '1.5 KB', '1.2 GB', '0 B']);
});
