// Streaming chat and cancellation, end to end against the real TypeScript sources bundled in memory:
// bounded framing (fragmented UTF-8/JSON, caps), the Anthropic event-order validator, the main-process stream hub
// (cursor, generations, abandonment, dispose), backend persistence semantics (exactly once, no late writes, offline stop,
// honest usage), the preload subscription and the Assistant reducer. Only injected mock fetch: no network, no Electron,
// no microphone, desktop or account actions.
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

async function bundle(contents, extra = {}) {
  const out = await build({stdin: {contents, resolveDir: root, loader: 'ts', sourcefile: 'substantial-streaming-entry.ts'}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', ...extra});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles.find((f) => !f.path.endsWith('.css')).text)(require, mod, mod.exports);
  return mod.exports;
}

const M = await bundle(`
  export {createBackend} from './electron/backend';
  export * as ipcCore from './electron/ipcCore';
  export * as ollama from './electron/services/ollama';
  export * as cloud from './electron/services/cloud';
  export {subscribeChatStream, streamEventProblem} from './src/ui/bridges';
`);
const UI = await bundle(`export {applyStreamEvent, classifyReply, incompleteReplyIds, streamFinalNotice} from './src/components/Assistant';`, {
  jsx: 'automatic',
  loader: {'.css': 'empty'},
  plugins: [{name: 'icon-stub', setup(b) {
    b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
    b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: 'module.exports = {};', loader: 'js'}));
  }}],
});
const {createBackend, ipcCore, ollama, cloud, subscribeChatStream, streamEventProblem} = M;
const enc = new TextEncoder();
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timed out'); await tick(); } }

/** A response body the test pushes into by hand. Records whether the consumer cancelled it and how many bytes were pulled. */
function controlledBody() {
  let ctrl;
  const st = {cancelled: false, pulled: 0};
  st.body = new ReadableStream({start(c) { ctrl = c; }, cancel() { st.cancelled = true; }});
  st.push = (s) => { try { const b = typeof s === 'string' ? enc.encode(s) : s; st.pulled += b.byteLength; ctrl.enqueue(b); } catch { /* cancelled */ } };
  st.close = () => { try { ctrl.close(); } catch { /* cancelled */ } };
  return st;
}
const ndjson = (o) => JSON.stringify(o) + '\n';
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const CLOUD_OK = [
  {type: 'message_start', message: {id: 'm', usage: {input_tokens: 12, output_tokens: 1}}},
  {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
  {type: 'ping'},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Hello '}},
  {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'cloud'}},
  {type: 'content_block_stop', index: 0},
  {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 7}},
  {type: 'message_stop'},
];
const fakeFetch = (respond) => async (url, init) => respond(String(url), init);

// ---------- framing ----------

test('error body reads release stalled readers at an idle bound or caller cancellation', async () => {
  const idleBody = controlledBody();
  assert.equal(await ollama.readBoundedText(new Response(idleBody.body), 100, undefined, 15), '');
  assert.equal(idleBody.cancelled, true);
  const abortBody = controlledBody(), ac = new AbortController();
  const pending = ollama.readBoundedText(new Response(abortBody.body), 100, ac.signal);
  ac.abort();
  assert.equal(await pending, '');
  assert.equal(abortBody.cancelled, true);
});

test('SSE protocol errors do not echo unknown attacker controlled event types', () => {
  const v = new cloud.AnthropicStreamValidator();
  const secret = 'confidential-test-token';
  assert.throws(() => v.accept({event:secret,data:JSON.stringify({type:secret})}), (error) => !error.message.includes(secret) && /out of order/.test(error.message));
});

test('LineSplitter reassembles UTF-8 split across chunks, strips CRLF and enforces line/body/UTF-8 limits', () => {
  const s = new ollama.LineSplitter({lineChars: 32, bodyBytes: 64});
  const bytes = enc.encode('héllo €\r\nnext');
  const lines = [];
  for (let i = 0; i < bytes.length; i++) lines.push(...s.push(bytes.subarray(i, i + 1)));
  lines.push(...s.end());
  assert.deepEqual(lines, ['héllo €', 'next']);
  assert.throws(() => new ollama.LineSplitter({lineChars: 8, bodyBytes: 1000}).push(enc.encode('x'.repeat(9))), /oversized/);
  assert.throws(() => new ollama.LineSplitter({lineChars: 1000, bodyBytes: 10}).push(enc.encode('x\n'.repeat(6))), /more data than allowed/);
  assert.throws(() => new ollama.LineSplitter().push(new Uint8Array([0x61, 0xff, 0x0a])), /invalid UTF-8/);
  const trunc = new ollama.LineSplitter();
  trunc.push(enc.encode('€').subarray(0, 2));
  assert.throws(() => trunc.end(), /invalid UTF-8/, 'a truncated final character is not silently replaced');
});

test('SSE parser and Anthropic validator accept the documented order and reject out-of-order, post-stop and inconsistent events', () => {
  const run = (events) => {
    const p = new cloud.SseParser(), v = new cloud.AnthropicStreamValidator();
    let text = '';
    for (const line of events.map(sse).join('').split('\n')) { const ev = p.line(line); if (ev) text += v.accept(ev); }
    return {text, v};
  };
  const ok = run(CLOUD_OK);
  assert.equal(ok.text, 'Hello cloud');
  assert.equal(ok.v.stopped, true);
  assert.deepEqual([ok.v.inputTokens, ok.v.outputTokens], [12, 7]);
  assert.throws(() => run([CLOUD_OK[0], CLOUD_OK[3]]), /out of order/, 'delta before its block');
  assert.throws(() => run([CLOUD_OK[1]]), /out of order/, 'block before message_start');
  assert.throws(() => run([...CLOUD_OK, CLOUD_OK[3]]), /after the end/);
  assert.throws(() => run([CLOUD_OK[0], {type: 'content_block_start', index: 1, content_block: {type: 'text'}}]), /out of order/, 'block indexes are sequential');
  const p = new cloud.SseParser(), v = new cloud.AnthropicStreamValidator();
  assert.throws(() => v.accept(p.line('event: ping') ?? p.line('data: {"type":"message_start","message":{}}') ?? p.line('')), /inconsistent/);
  assert.throws(() => new cloud.AnthropicStreamValidator().accept({event: '', data: '{not json'}), /malformed/);
  assert.throws(() => { const q = new cloud.SseParser(10); q.line('data: ' + 'x'.repeat(20)); }, /oversized/);
});

test('a provider error event surfaces only its type, never provider free text (which could echo the key)', () => {
  const v = new cloud.AnthropicStreamValidator();
  v.accept({event: 'message_start', data: JSON.stringify(CLOUD_OK[0])});
  assert.throws(() => v.accept({event: 'error', data: JSON.stringify({type: 'error', error: {type: 'overloaded_error', message: 'key sk-ant-SECRET was rejected'}})}), (e) => {
    assert.match(e.message, /overloaded_error/);
    assert.doesNotMatch(e.message, /SECRET|sk-ant/);
    return true;
  });
});

// ---------- providers through an injected guarded fetch ----------

test('streamOllamaChat: fragmented NDJSON frames, end marker, reported metrics; missing end marker is incomplete', async () => {
  const body = controlledBody();
  const deltas = [];
  const calls = [];
  const p = ollama.streamOllamaChat(fakeFetch((url, init) => { calls.push({url, init}); return new Response(body.body, {status: 200}); }), {
    endpoint: 'http://127.0.0.1:11434', model: 'llama-test', messages: [{role: 'user', content: 'hi'}], keepAlive: '2m', numCtx: null,
    signal: new AbortController().signal, onDelta: (t) => deltas.push(t),
  });
  const wire = ndjson({message: {content: 'Grüße '}}) + ndjson({message: {content: 'aus 🌍'}}) + ndjson({done: true, prompt_eval_count: 5, eval_count: 9, eval_duration: 2e9});
  const bytes = enc.encode(wire);
  for (let i = 0; i < bytes.length; i += 3) { body.push(bytes.subarray(i, i + 3)); await tick(0); }
  const r = await p;
  assert.equal(r.text, 'Grüße aus 🌍');
  assert.deepEqual(deltas, ['Grüße ', 'aus 🌍']);
  assert.equal(r.complete, true);
  assert.equal(r.truncated, false);
  assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.generationMs], [5, 9, 2000]);
  assert.equal(JSON.parse(calls[0].init.body).stream, true);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');

  const b2 = controlledBody();
  const p2 = ollama.streamOllamaChat(fakeFetch(() => new Response(b2.body)), {endpoint: 'http://127.0.0.1:1', model: 'm', messages: [], keepAlive: '2m', numCtx: null, signal: new AbortController().signal, onDelta: () => {}});
  b2.push(ndjson({message: {content: 'part'}}));
  b2.close();
  await assert.rejects(p2, (e) => e instanceof ollama.StreamIncomplete && e.partial === 'part');
});

test('the reply cap is reported as truncated, distinct from a real end, and drops provider metrics', async () => {
  const body = controlledBody();
  body.push(ndjson({message: {content: 'abcdef'}}) + ndjson({message: {content: 'ghij'}}));
  const r = await ollama.streamOllamaChat(fakeFetch(() => new Response(body.body)), {endpoint: 'http://127.0.0.1:1', model: 'm', messages: [], keepAlive: '2m', numCtx: null, signal: new AbortController().signal, onDelta: () => {}, limits: {replyChars: 8}});
  assert.equal(r.text, 'abcdefgh');
  assert.equal(r.truncated, true);
  assert.equal(r.usage, null);
  assert.equal(body.cancelled, true, 'the rest of the body is cancelled');
});

test('HTTP error bodies are read with a bound and released; cloud errors are status-only and never echo the key', async () => {
  const big = controlledBody();
  for (let i = 0; i < 64; i++) big.push('x'.repeat(16 * 1024));
  await assert.rejects(ollama.streamOllamaChat(fakeFetch(() => new Response(big.body, {status: 500})), {endpoint: 'http://127.0.0.1:1', model: 'm', messages: [], keepAlive: '2m', numCtx: null, signal: new AbortController().signal, onDelta: () => {}}), /Ollama returned HTTP 500/);
  assert.equal(big.cancelled, true, 'error body released');
  assert.equal(await ollama.readBoundedText(new Response('y'.repeat(10_000)), 100).then((t) => t.length), 100);

  const leaky = controlledBody();
  leaky.push(JSON.stringify({error: {message: 'invalid x-api-key sk-ant-TESTKEY'}}));
  leaky.close();
  const req = {key: 'sk-ant-TESTKEY', model: 'c', messages: [], signal: new AbortController().signal, onDelta: () => {}};
  await assert.rejects(cloud.streamCloudChat(fakeFetch(() => new Response(leaky.body, {status: 400})), req), (e) => { assert.equal(e.message, 'Cloud provider returned HTTP 400'); return true; });
  await assert.rejects(cloud.streamCloudChat(fakeFetch(() => new Response('{}', {status: 401})), req), /rejected the API key/);
});

test('abort cancels the upstream body; a body that idles out is incomplete with its partial text', async () => {
  const body = controlledBody();
  const ac = new AbortController();
  const p = ollama.streamOllamaChat(fakeFetch(() => new Response(body.body)), {endpoint: 'http://127.0.0.1:1', model: 'm', messages: [], keepAlive: '2m', numCtx: null, signal: ac.signal, onDelta: () => {}});
  body.push(ndjson({message: {content: 'so far'}}));
  await tick(10);
  ac.abort();
  await assert.rejects(p, (e) => e instanceof ollama.StreamAborted && e.partial === 'so far');
  assert.equal(body.cancelled, true);

  const quiet = controlledBody();
  const p2 = ollama.streamOllamaChat(fakeFetch(() => new Response(quiet.body)), {endpoint: 'http://127.0.0.1:1', model: 'm', messages: [], keepAlive: '2m', numCtx: null, signal: new AbortController().signal, onDelta: () => {}, limits: {idleMs: 30}});
  quiet.push(ndjson({message: {content: 'a'}}));
  await assert.rejects(p2, (e) => e instanceof ollama.StreamIncomplete && e.idle && e.partial === 'a');
});

// ---------- hub ----------

let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;
const MSG = (text, source = 'local') => ({id: 'x', role: 'assistant', text, createdAt: '2026-01-01T00:00:00.000Z', source});

test('ChatStreamHub: ordered cursor reads, long-poll wake, one generation at a time, exactly-once finish, no late events', async () => {
  const hub = new ipcCore.ChatStreamHub({newId: uuid, limits: {pollMs: 50}});
  const {start, sink} = hub.open('local');
  assert.throws(() => hub.open('local'), /already being generated/);
  const pending = hub.read(start.streamId, 0);
  sink.status('connecting');
  let b = await pending;
  assert.deepEqual(b.events.map((e) => [e.type, e.seq, e.generation]), [['status', 0, start.generation]]);
  sink.delta('a'); sink.delta('b');
  b = await hub.read(start.streamId, b.next);
  assert.deepEqual(b.events.map((e) => [e.type, e.text]), [['delta', 'ab']], 'undelivered deltas merge');
  await assert.rejects(hub.read(start.streamId, b.next + 5), /Stale stream cursor/);
  await assert.rejects(hub.read(start.streamId, 0), /Stale stream cursor/, 'acknowledged events cannot be re-read');
  await assert.rejects(hub.read('not-a-uuid', 0), /Invalid stream id/);
  await assert.rejects(hub.read(uuid(), 0), /Unknown/);
  const empty = await hub.read(start.streamId, b.next);
  assert.deepEqual([empty.events.length, empty.ended], [0, false], 'poll timeout returns an empty batch');
  assert.equal(hub.cancel(start.streamId), true);
  assert.equal(sink.signal.aborted, true);
  assert.equal(sink.stopReason(), 'user');
  assert.equal(sink.delta('late'), false, 'deltas after a stop are dropped');
  assert.equal(sink.status('streaming'), false);
  assert.equal(sink.finish('cancelled', MSG('Stopped by you.'), []), true);
  assert.equal(sink.finish('complete', MSG('again'), []), false, 'finish happens once');
  b = await hub.read(start.streamId, empty.next);
  assert.deepEqual(b.events.map((e) => e.type), ['done']);
  assert.equal(b.ended, true);
  const second = hub.open('cloud');
  assert.equal(second.start.generation, start.generation + 1);
  hub.dispose();
});

test('ChatStreamHub: unread streams are abandoned upstream, route aborts are scoped, dispose wakes reads and forbids persistence', async () => {
  const hub = new ipcCore.ChatStreamHub({newId: uuid, limits: {abandonMs: 30, pollMs: 1000}});
  const a = hub.open('local');
  await until(() => a.sink.signal.aborted);
  assert.equal(a.sink.stopReason(), 'abandoned');
  a.sink.finish('cancelled', MSG('x'), []);
  const c = hub.open('cloud');
  assert.equal(hub.abortRoute('local', 'offline'), 0);
  const waiting = hub.read(c.start.streamId, 0);
  assert.equal(hub.abortRoute('cloud', 'offline'), 1);
  assert.equal(c.sink.stopReason(), 'offline');
  assert.equal(c.sink.mayPersist(), true, 'an offline stop still saves what arrived');
  hub.dispose();
  const b = await waiting;
  assert.equal(b.ended, true);
  assert.equal(c.sink.mayPersist(), false);
  assert.throws(() => hub.open('local'), /shutting down/);

  const slow = new ipcCore.ChatStreamHub({newId: uuid, limits: {maxEvents: 3}});
  const s = slow.open('local');
  for (let i = 0; i < 5; i++) s.sink.status('streaming');
  assert.equal(s.sink.stopReason(), 'abandoned', 'a reader that does not keep up ends the stream');
  slow.dispose();
});

test('IPC boundary: stream methods need a trusted sender, a 36-char id and a whole-number cursor', async () => {
  const calls = [];
  const handlers = new Proxy({}, {get: (_t, m) => async (...a) => { calls.push([m, a]); return 'ok'; }});
  const APP = 'file:///C:/app/dist/index.html';
  const id = uuid();
  assert.equal(await ipcCore.dispatch(handlers, 'chatStreamRead', [id, 3], APP, {appFileUrl: APP}), 'ok');
  for (const args of [[id, 1.5], [id, -1], [id, '3'], ['short', 0], [id], [id, 0, 1]]) {
    await assert.rejects(ipcCore.dispatch(handlers, 'chatStreamRead', args, APP, {appFileUrl: APP}), /Invalid argument|Wrong number/);
  }
  await assert.rejects(ipcCore.dispatch(handlers, 'chatStreamCancel', [id], 'https://evil.example/', {appFileUrl: APP}), /untrusted sender/);
  await assert.rejects(ipcCore.dispatch(handlers, 'chatStreamStart', ['x'.repeat(16 * 1024 + 1)], APP, {appFileUrl: APP}), /too long/);
  assert.equal(calls.length, 1);
});

// ---------- backend end to end ----------

async function fixture({respond, env = {}} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-stream-'));
  const log = {fetched: []};
  let decision = false;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {
      listWindows: async () => [], focusWindow: async () => ({focused: true}), typeText: async () => ({typed: 0}), moveWindow: async () => ({}),
      dpapi: async (op, data) => op === 'protect' ? {ok: true, data: Buffer.from(String(data)).toString('base64')} : op === 'unprotect' ? {ok: true, data: Buffer.from(String(data), 'base64').toString()} : {ok: true},
    },
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    confirm: async () => decision,
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    cloudOriginOverride: 'https://cloud.test.invalid',
    fetchImpl: async (url, init) => {
      log.fetched.push({url: String(url), init});
      if (!respond) throw new Error('no network in tests');
      return respond(String(url), init);
    },
    ...env,
  });
  return {b, log, setDecision: (v) => { decision = v; }, async close() { await b.dispose(); await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }};
}

/** Collects one stream through the real preload subscription logic over the backend's read method. */
function collect(b, start) {
  const events = [];
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  subscribeChatStream((id, c) => b.chatStreamRead(id, c), start, (ev) => { events.push(ev); if (ev.type === 'done' || ev.type === 'lost') resolve(ev); });
  return {events, done, text: () => events.filter((e) => e.type === 'delta').map((e) => e.text).join('')};
}

test('local streaming end to end: live deltas, one stored user + assistant message, honest usage, legacy chat unchanged', async () => {
  let body;
  const f = await fixture({respond: (url, init) => {
    if (JSON.parse(init.body).stream === false) return new Response(JSON.stringify({message: {content: 'one-shot'}}));
    body = controlledBody();
    return new Response(body.body);
  }});
  try {
    const start = await f.b.chatStreamStart('hello');
    assert.equal(start.route, 'local');
    const c = collect(f.b, start);
    await until(() => body);
    body.push(ndjson({message: {content: 'Hi '}}));
    await until(() => c.text() === 'Hi ');
    body.push(ndjson({message: {content: 'there'}}) + ndjson({done: true, prompt_eval_count: 4, eval_count: 6, eval_duration: 1e9}));
    const done = await c.done;
    assert.equal(done.outcome, 'complete');
    assert.equal(done.reply.text, 'Hi there');
    assert.deepEqual(c.events.filter((e) => e.type === 'status').map((e) => e.status), ['connecting', 'streaming']);
    const chat = (await f.b.getState()).chat;
    assert.deepEqual(chat.map((m) => [m.role, m.source, m.text]), [['user', 'local', 'hello'], ['assistant', 'local', 'Hi there']]);
    const report = (await f.b.usageReport()).report;
    assert.deepEqual([report.totals.events, report.totals.inputTokens, report.totals.outputTokens], [1, 4, 6]);
    assert.ok(f.log.fetched.every((r) => r.url.startsWith('http://127.0.0.1:')), 'offline default: loopback only');
    const legacy = await f.b.chat('again');
    assert.equal(legacy.text, 'one-shot');
    assert.equal((await f.b.getState()).chat.length, 4);
  } finally { await f.close(); }
});

test('Stop aborts upstream; late provider data is ignored; only text received before the stop is stored, once', async () => {
  let body, upstreamSignal;
  const f = await fixture({respond: (_u, init) => { upstreamSignal = init.signal; body = controlledBody(); return new Response(body.body); }});
  try {
    const start = await f.b.chatStreamStart('tell me');
    const c = collect(f.b, start);
    await until(() => body);
    body.push(ndjson({message: {content: 'Partial'}}));
    await until(() => c.text() === 'Partial');
    assert.equal(await f.b.chatStreamCancel(start.streamId), true);
    body.push(ndjson({message: {content: ' LATE'}}) + ndjson({done: true, prompt_eval_count: 1, eval_count: 1}));
    const done = await c.done;
    assert.equal(done.outcome, 'cancelled');
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(body.cancelled, true);
    assert.doesNotMatch(c.text(), /LATE/);
    const chat = (await f.b.getState()).chat;
    assert.deepEqual(chat.map((m) => m.text.slice(0, 15)), ['tell me', 'Partial', 'Stopped by you.']);
    assert.equal(UI.classifyReply(chat[2]), 'stopped');
    assert.ok(UI.incompleteReplyIds(chat).has(chat[1].id));
    assert.equal(await f.b.chatStreamCancel(start.streamId), false, 'cancel after the end is a no-op');
    assert.equal((await f.b.usageReport()).report.totals.events, 0, 'no usage invented for a cancelled reply');
    await tick(20);
    assert.equal((await f.b.getState()).chat.length, 3, 'no late writes');
  } finally { await f.close(); }
});

test('a provider that ignores the abort and settles late after cancel cannot become a complete reply', async () => {
  let release;
  const f = await fixture({respond: () => new Promise((r) => { release = () => r(new Response(ndjson({message: {content: 'too late'}}) + ndjson({done: true, prompt_eval_count: 1, eval_count: 2}))); })});
  try {
    const start = await f.b.chatStreamStart('q');
    const c = collect(f.b, start);
    await until(() => release);
    await f.b.chatStreamCancel(start.streamId);
    release();
    const done = await c.done;
    assert.equal(done.outcome, 'cancelled');
    assert.equal(c.text(), '');
    const chat = (await f.b.getState()).chat;
    assert.deepEqual(chat.map((m) => m.source), ['local', 'system']);
    assert.match(chat[1].text, /^Stopped by you\. No reply was generated\./);
  } finally { await f.close(); }
});

test('cloud streaming needs online mode + key; switching offline stops it and keeps only what arrived; the key stays in one header', async () => {
  let body, req;
  const KEY = 'sk-ant-TEST-1234567890';
  const f = await fixture({respond: (url, init) => { req = {url, init}; body = controlledBody(); return new Response(body.body, {headers: {'content-type': 'text/event-stream'}}); }});
  try {
    f.setDecision(true);
    await f.b.saveSettings({mode: 'online'});
    await f.b.setCloudKey(KEY);
    const start = await f.b.chatStreamStart('cloud please');
    assert.equal(start.route, 'cloud');
    const c = collect(f.b, start);
    await until(() => body);
    assert.equal(req.url, 'https://cloud.test.invalid/v1/messages');
    assert.equal(new Headers(req.init.headers).get('x-api-key'), KEY);
    assert.doesNotMatch(req.init.body, new RegExp(KEY));
    body.push(CLOUD_OK.slice(0, 4).map(sse).join(''));
    await until(() => c.text() === 'Hello ');
    await f.b.saveSettings({mode: 'offline'});
    body.push(sse(CLOUD_OK[4]));
    const done = await c.done;
    assert.equal(done.outcome, 'cancelled');
    const state = await f.b.getState();
    assert.deepEqual(state.chat.map((m) => [m.source, m.text.slice(0, 45)]), [['cloud', 'cloud please'], ['cloud', 'Hello '], ['system', 'Stopped because online mode was switched off.']]);
    assert.match(state.chat[2].text, /may have reached the cloud provider/);
    assert.doesNotMatch(JSON.stringify(state), new RegExp(KEY), 'the key never reaches stored state or activity');
    // Back offline, a new stream goes to the local endpoint only.
    const cloudBody = body;
    const local = await f.b.chatStreamStart('offline now');
    assert.equal(local.route, 'local');
    const lc = collect(f.b, local);
    await until(() => body !== cloudBody);
    body.push(ndjson({message: {content: 'local'}}) + ndjson({done: true}));
    assert.equal((await lc.done).outcome, 'complete');
    assert.match(f.log.fetched.at(-1).url, /^http:\/\/127\.0\.0\.1:/);
  } finally { await f.close(); }
});

test('arbitrary cloud transport errors cannot enter stored messages or activity', async () => {
  const secret = 'transport-secret-fixture';
  const f = await fixture({respond: () => {throw new Error(`Authorization ${secret}`);}});
  try {
    f.setDecision(true);
    await f.b.saveSettings({mode:'online'});
    await f.b.setCloudKey('sk-ant-TEST-abcdefghijklmnop');
    const done = await collect(f.b,await f.b.chatStreamStart('hello')).done;
    assert.equal(done.outcome,'failed');
    assert.match(done.reply.text,/The cloud request failed/);
    assert.equal(JSON.stringify(await f.b.getState()).includes(secret),false);
    assert.equal(JSON.stringify(done).includes(secret),false);
  } finally {await f.close();}
});

test('complete cloud stream records the reported token counts; an online start without a key is refused without sending', async () => {
  const f = await fixture({respond: () => new Response(CLOUD_OK.map(sse).join(''))});
  try {
    f.setDecision(true);
    await f.b.saveSettings({mode: 'online'});
    const refused = await collect(f.b, await f.b.chatStreamStart('no key')).done;
    assert.equal(refused.outcome, 'failed');
    assert.match(refused.reply.text, /^Cloud model unavailable: No cloud API key.*Your message was not sent\./);
    assert.equal(f.log.fetched.length, 0);
    await f.b.setCloudKey('sk-ant-TEST-abcdefghijklmnop');
    const ok = await collect(f.b, await f.b.chatStreamStart('go')).done;
    assert.equal(ok.outcome, 'complete');
    assert.equal(ok.reply.text, 'Hello cloud');
    const r = (await f.b.usageReport()).report;
    assert.deepEqual([r.totals.inputTokens, r.totals.outputTokens, r.byModel[0].runtime], [12, 7, 'cloud']);
  } finally { await f.close(); }
});

test('truncated, incomplete and malformed streams are stored honestly', async () => {
  let wire = '';
  const f = await fixture({respond: () => new Response(wire), env: {streamLimits: {replyChars: 5}}});
  try {
    wire = ndjson({message: {content: 'abcdefgh'}});
    const t = await collect(f.b, await f.b.chatStreamStart('long')).done;
    assert.equal(t.outcome, 'truncated');
    assert.equal(t.reply.text, 'abcde');
    assert.match(t.stored[1].text, /^The reply above was cut at the 5-character limit/);
    assert.equal(UI.classifyReply(t.stored[1]), 'incomplete');
    assert.deepEqual(UI.streamFinalNotice(t).tone, 'warn');

    wire = ndjson({message: {content: 'ab'}});
    const i = await collect(f.b, await f.b.chatStreamStart('cut')).done;
    assert.equal(i.outcome, 'incomplete');
    assert.equal(UI.classifyReply(i.stored[1]), 'incomplete');

    wire = '{"message": nope}\n';
    const m = await collect(f.b, await f.b.chatStreamStart('bad')).done;
    assert.equal(m.outcome, 'failed');
    assert.match(m.reply.text, /malformed stream line/);
    assert.equal((await f.b.usageReport()).report.totals.events, 0);
  } finally { await f.close(); }
});

test('clear, unread abandonment and dispose abort upstream and never write late; a busy start is refused', async () => {
  let body, signal;
  // Keep polling shorter than abandonment, as in production. A 40ms abandonment with the
  // default 15s long poll spuriously cancels an active listener under a loaded full-suite run.
  const f = await fixture({respond: (_u, init) => { signal = init.signal; body = controlledBody(); return new Response(body.body); }, env: {chatStreamLimits: {pollMs: 20, abandonMs: 1000}}});
  try {
    const s1 = await f.b.chatStreamStart('first');
    await assert.rejects(f.b.chatStreamStart('second'), /already being generated/);
    const c1 = collect(f.b, s1);
    await until(() => body);
    body.push(ndjson({message: {content: 'x'}}));
    await f.b.clearChat();
    assert.equal((await c1.done).outcome, 'cancelled');
    assert.equal(signal.aborted, true);
    await tick(20);
    assert.deepEqual((await f.b.getState()).chat, [], 'nothing lands in the cleared conversation');

    body = null;
    await f.b.chatStreamStart('nobody listens');
    await until(() => body);
    await until(() => signal.aborted, 3000);
    await until(async () => (await f.b.getState()).chat.length === 2);
    assert.match((await f.b.getState()).chat[1].text, /^Stopped because no window was receiving the reply\./);

    body = null;
    // The note is stored just before the hub frees the slot, so retry until the previous stream has fully ended.
    await until(async () => f.b.chatStreamStart('shutdown').then(() => true, () => false));
    await until(() => body);
    const before = f.b.store.snapshot().chat.length;
    await f.b.dispose();
    assert.equal(signal.aborted, true);
    await tick(20);
    assert.equal(f.b.store.snapshot().chat.length, before, 'no write after dispose');
  } finally { await f.close().catch(() => undefined); }
});

// ---------- preload subscription and renderer reducer ----------

test('subscribeChatStream delivers in order exactly once and reports foreign, out-of-order or failing streams as lost', async () => {
  const start = {streamId: uuid(), generation: 3, route: 'local'};
  const tag = (seq, extra) => ({streamId: start.streamId, generation: 3, seq, ...extra});
  const run = (batches) => new Promise((resolve) => {
    const got = [];
    let i = 0;
    subscribeChatStream(async () => { const b = batches[Math.min(i++, batches.length - 1)]; if (b instanceof Error) throw b; return b; }, start, (ev) => { got.push(ev); if (ev.type === 'done' || ev.type === 'lost') resolve(got); }, async () => {});
  });
  const done = tag(2, {type: 'done', outcome: 'complete', reply: MSG('ab'), stored: [MSG('ab')]});
  let got = await run([{events: [tag(0, {type: 'delta', text: 'a'})], next: 1, ended: false}, {events: [tag(0, {type: 'delta', text: 'a'}), tag(1, {type: 'delta', text: 'b'}), done], next: 3, ended: true}]);
  assert.deepEqual(got.map((e) => e.type + e.seq), ['delta0', 'delta1', 'done2'], 'a retried duplicate is skipped');
  got = await run([{events: [{...tag(0, {type: 'delta', text: 'x'}), generation: 2}], next: 1, ended: false}]);
  assert.equal(got.at(-1).type, 'lost');
  assert.match(got.at(-1).reason, /another stream/);
  got = await run([{events: [tag(1, {type: 'delta', text: 'x'})], next: 2, ended: false}]);
  assert.match(got.at(-1).reason, /out of order/);
  got = await run([new Error('gone'), new Error('gone'), new Error('gone')]);
  assert.deepEqual(got.map((e) => e.type), ['lost']);
  assert.equal(streamEventProblem(tag(0, {type: 'delta', text: 'x'.repeat(16_385)}), start), 'malformed delta');
  assert.equal(streamEventProblem(tag(0, {type: 'done', outcome: 'complete', reply: {id: 1}, stored: []}), start), 'malformed final event');

  let calls = 0, handled = 0;
  const unsub = subscribeChatStream(async () => { calls++; await tick(5); return {events: [tag(calls - 1, {type: 'status', status: 'streaming'})], next: calls, ended: false}; }, start, () => { handled++; });
  await tick(12);
  unsub();
  const seen = handled;
  await tick(20);
  assert.equal(handled, seen, 'no events after unsubscribe');
});

test('Assistant reducer ignores stale generations and other streams, and ends on done/lost', () => {
  const live = {streamId: 'a', generation: 2, route: 'local', status: 'connecting', text: ''};
  const ev = (o) => ({streamId: 'a', generation: 2, seq: 0, ...o});
  let r = UI.applyStreamEvent(live, ev({type: 'delta', text: 'Hi'}));
  assert.deepEqual([r.live.text, r.live.status], ['Hi', 'streaming']);
  assert.equal(UI.applyStreamEvent(r.live, {...ev({type: 'delta', text: 'old'}), generation: 1}).live, r.live);
  assert.equal(UI.applyStreamEvent(r.live, {...ev({type: 'delta', text: 'x'}), streamId: 'b'}).live, r.live);
  const stopping = {...r.live, status: 'stopping'};
  assert.equal(UI.applyStreamEvent(stopping, ev({type: 'status', status: 'streaming'})).live.status, 'stopping');
  r = UI.applyStreamEvent(r.live, ev({type: 'lost', reason: 'gone'}));
  assert.equal(r.live, null);
  assert.equal(UI.streamFinalNotice(r.final).tone, 'danger');
  assert.equal(UI.applyStreamEvent(null, ev({type: 'delta', text: 'late'})).live, null);
  assert.equal(UI.classifyReply(MSG('Stopped because online mode was switched off. No reply was generated.', 'system')), 'stopped');
});
