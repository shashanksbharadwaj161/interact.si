// Screen-aware Claude journey, backend half: the streamed Messages transport (blocks rebuilt exactly, text as it arrives,
// cancellation, incomplete or malformed streams), one bounded retry of temporary failures, the region encoding bound,
// the non-consuming preview of a selected area, image capability from the provider's own model list, and the outbound
// preview being built by the same code as the request. Fake transport only: no network, no Electron, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root, sourcefile: 'companion-screen-entry.ts', loader: 'ts',
    contents: `
      export { createBackend } from './electron/backend.ts';
      export { runAgent, firstUserContent, retryable } from './electron/services/agent.ts';
      export { streamAnthropicMessage, parseImageSupport } from './electron/services/cloud.ts';
      export { ScreenContext } from './electron/services/screen-context.ts';
      export { encodeRegion, REGION_MAX_IMAGE_BYTES, COMPANION_METHODS, COMPANION_ARG_SPECS } from './electron/companionCore.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const KEY = 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz';
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
  decryptString: (buf) => { const s = buf.toString('utf8'); if (!s.startsWith('enc:')) throw new Error('bad'); return [...s.slice(4)].reverse().join(''); },
};
const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
const start = ev('message_start', {message: {id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: {input_tokens: 12, output_tokens: 0}}});
const end = (stop = 'end_turn', out = 7) => ev('message_delta', {delta: {stop_reason: stop}, usage: {output_tokens: out}}) + ev('message_stop');
const textBlock = (index, ...parts) => ev('content_block_start', {index, content_block: {type: 'text', text: ''}}) + parts.map((t) => ev('content_block_delta', {index, delta: {type: 'text_delta', text: t}})).join('') + ev('content_block_stop', {index});
const sse = (body, status = 200) => new Response(body, {status, headers: {'content-type': 'text/event-stream'}});
/** Delivers the body in small chunks so events cross chunk boundaries. */
const chunked = (body, size = 7) => new Response(new ReadableStream({start(c) { const b = new TextEncoder().encode(body); for (let i = 0; i < b.length; i += size) c.enqueue(b.slice(i, i + size)); c.close(); }}), {status: 200});
const BODY = {model: 'claude-haiku-4-5', max_tokens: 100, system: 's', tools: [], messages: [{role: 'user', content: [{type: 'text', text: 'hi'}]}]};

/* ---------- Streamed transport ---------- */

test('streamed reply: text, tool_use input and thinking with its signature are rebuilt exactly; text arrives as it streams', async () => {
  const body = start
    + ev('content_block_start', {index: 0, content_block: {type: 'thinking', thinking: ''}})
    + ev('content_block_delta', {index: 0, delta: {type: 'thinking_delta', thinking: 'Look at '}})
    + ev('content_block_delta', {index: 0, delta: {type: 'thinking_delta', thinking: 'the image.'}})
    + ev('content_block_delta', {index: 0, delta: {type: 'signature_delta', signature: 'sig=='}})
    + ev('content_block_stop', {index: 0})
    + textBlock(1, 'I will ', 'add it.')
    + ev('ping')
    + ev('content_block_start', {index: 2, content_block: {type: 'tool_use', id: 'toolu_1', name: 'create_task', input: {}}})
    + ev('content_block_delta', {index: 2, delta: {type: 'input_json_delta', partial_json: '{"title":"Pay '}})
    + ev('content_block_delta', {index: 2, delta: {type: 'input_json_delta', partial_json: 'rent"}'}})
    + ev('content_block_stop', {index: 2})
    + end('tool_use', 31);
  const seen = [];
  let sent;
  const r = await m.streamAnthropicMessage(async (url, init, purpose) => { sent = {url, init, purpose}; return chunked(body); }, {key: KEY, body: BODY, signal: new AbortController().signal, onText: (t) => seen.push(t)});
  assert.deepEqual(r.content, [
    {type: 'thinking', thinking: 'Look at the image.', signature: 'sig=='},
    {type: 'text', text: 'I will add it.'},
    {type: 'tool_use', id: 'toolu_1', name: 'create_task', input: {title: 'Pay rent'}},
  ]);
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.inputTokens, 12);
  assert.equal(r.outputTokens, 31);
  assert.deepEqual(seen, ['I will ', 'add it.']);
  assert.equal(sent.purpose, 'cloud-chat');
  assert.match(sent.url, /\/v1\/messages$/);
  assert.equal(JSON.parse(sent.init.body).stream, true);
  assert.equal(sent.init.headers['x-api-key'], KEY);
  assert.equal(Object.keys(sent.init.headers).filter((h) => /key|auth/i.test(h)).length, 1, 'one credential header');
});

test('a tool input that is not complete JSON is a protocol error, never a guessed input', async () => {
  const body = start + ev('content_block_start', {index: 0, content_block: {type: 'tool_use', id: 'toolu_1', name: 'create_task', input: {}}})
    + ev('content_block_delta', {index: 0, delta: {type: 'input_json_delta', partial_json: '{"title":"Pay'}}) + ev('content_block_stop', {index: 0}) + end('tool_use');
  await assert.rejects(m.streamAnthropicMessage(async () => sse(body), {key: KEY, body: BODY, signal: new AbortController().signal}), /malformed/);
});

test('a stream that ends early is incomplete; an in-stream error is surfaced by type only; HTTP errors are status-only', async () => {
  await assert.rejects(m.streamAnthropicMessage(async () => sse(start + textBlock(0, 'half')), {key: KEY, body: BODY, signal: new AbortController().signal}), (e) => e.name === 'StreamIncomplete' && e.partial === '');
  const errBody = start + ev('error', {error: {type: 'overloaded_error', message: `echo ${KEY}`}});
  await assert.rejects(m.streamAnthropicMessage(async () => sse(errBody), {key: KEY, body: BODY, signal: new AbortController().signal}), (e) => /overloaded_error/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(m.streamAnthropicMessage(async () => new Response(`{"error":"${KEY}"}`, {status: 401}), {key: KEY, body: BODY, signal: new AbortController().signal}), (e) => /rejected the API key/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(m.streamAnthropicMessage(async () => new Response('x', {status: 529}), {key: KEY, body: BODY, signal: new AbortController().signal}), /overloaded/);
});

test('Stop during a stream ends it with the text received so far, and never reads further', async () => {
  const ctl = new AbortController();
  let pulls = 0;
  const stream = new ReadableStream({
    pull(c) {
      pulls++;
      if (pulls === 1) c.enqueue(new TextEncoder().encode(start + ev('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + ev('content_block_delta', {index: 0, delta: {type: 'text_delta', text: 'Part'}})));
      else return new Promise(() => {});
    },
  });
  const p = m.streamAnthropicMessage(async () => new Response(stream, {status: 200}), {key: KEY, body: BODY, signal: ctl.signal, onText: () => ctl.abort()});
  await assert.rejects(p, (e) => e.name === 'StreamAborted' && e.partial === 'Part');
  const before = new AbortController(); before.abort();
  let fetched = 0;
  await assert.rejects(m.streamAnthropicMessage(async () => { fetched++; return sse(''); }, {key: KEY, body: BODY, signal: before.signal}), (e) => e.name === 'StreamAborted');
  assert.equal(fetched, 0, 'nothing is sent after Stop');
});

/* ---------- Bounded retry in the loop ---------- */

const answer = (t) => ({content: [{type: 'text', text: t}], stopReason: 'end_turn', inputTokens: 1, outputTokens: 1});
async function loop(call, extra = {}) {
  const events = []; const ctl = extra.ctl ?? new AbortController();
  await m.runAgent({text: 'hi', model: 'claude-haiku-4-5', system: 's', tools: [], maxTokens: 100, signal: ctl.signal, emit: (e) => events.push(e), call, retry: {delayMs: 0, wait: extra.wait ?? (async () => {})}, ...(extra.onText ? {onText: extra.onText} : {})});
  return events;
}

test('one automatic retry for overload, rate limit or no connection, shown as a retry; then the real error', async () => {
  let n = 0;
  const ok = await loop(async () => { if (++n === 1) throw new Error('The cloud provider is overloaded right now (HTTP 529). Try again in a moment'); return answer('Fine.'); });
  assert.equal(n, 2);
  assert.deepEqual(ok.map((e) => e.type + (e.retry ? `:${e.retry}` : '')), ['status', 'status:1', 'answer']);
  n = 0;
  const twice = await loop(async () => { n++; throw new Error('fetch failed'); });
  assert.equal(n, 2, 'never more than one retry');
  assert.equal(twice.at(-1).reason, 'network');
  n = 0;
  const key = await loop(async () => { n++; throw new Error('The cloud provider rejected the API key'); });
  assert.equal(n, 1, 'a rejected key is not retried');
  assert.equal(key.at(-1).kind, 'key');
});

test('no retry once text has streamed for that step, and Stop during the wait sends nothing more', async () => {
  let n = 0;
  const events = await loop(async (body, signal, onText) => { n++; onText?.('Half an answ'); throw new Error('fetch failed'); }, {onText: () => {}});
  assert.equal(n, 1);
  assert.equal(events.at(-1).reason, 'network');
  const ctl = new AbortController(); n = 0;
  const stopped = await loop(async () => { n++; throw new Error('HTTP 429'); }, {ctl, wait: async () => ctl.abort()});
  assert.equal(n, 1);
  assert.equal(stopped.at(-1).reason, 'cancelled');
  assert.equal(m.retryable('Cloud provider returned HTTP 400'), false);
  assert.equal(m.retryable('x', 'TimeoutError'), true);
});

/* ---------- Region encoding and preview ---------- */

test('a selected area is sent as PNG when it fits, otherwise JPEG at falling quality, otherwise refused; encoders run lazily', () => {
  const big = new Uint8Array(m.REGION_MAX_IMAGE_BYTES + 1);
  let jpegs = 0;
  assert.equal(m.encodeRegion(() => new Uint8Array(10), () => { jpegs++; return new Uint8Array(1); }).mediaType, 'image/png');
  assert.equal(jpegs, 0);
  const qs = [];
  const r = m.encodeRegion(() => big, (q) => { qs.push(q); return q < 80 ? new Uint8Array(5) : big; });
  assert.equal(r.mediaType, 'image/jpeg');
  assert.deepEqual(qs, [88, 75]);
  assert.equal(m.encodeRegion(() => big, () => big), null);
  assert.ok(m.REGION_MAX_IMAGE_BYTES * 4 / 3 < 5 * 1024 * 1024, 'base64 of the bound stays under the provider limit');
});

test('the first message is image, context, request, in that order; the JPEG media type is carried', () => {
  const c = m.firstUserContent({text: '  what is this?  ', context: 'Today is 2026-10-21.', image: {base64: 'AAAA', width: 2, height: 2, mediaType: 'image/jpeg'}});
  assert.deepEqual(c, [
    {type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: 'AAAA'}},
    {type: 'text', text: 'Today is 2026-10-21.'},
    {type: 'text', text: 'what is this?'},
  ]);
  assert.equal(m.firstUserContent({text: 'x', image: {base64: 'A', width: 1, height: 1}})[0].source.media_type, 'image/png');
});

test('peeking at a selected area does not use it up; expiry still wins; take stays single use', () => {
  let now = 0;
  const timers = [];
  const ctx = new m.ScreenContext(1000, () => now, (f, ms) => { const t = {f, ms, unref() {}}; timers.push(t); return t; }, () => {});
  ctx.put('t1', {data: 'x'});
  assert.deepEqual(ctx.peek('t1'), {data: 'x'});
  assert.equal(ctx.peek('other'), null);
  assert.deepEqual(ctx.take('t1'), {data: 'x'});
  assert.equal(ctx.peek('t1'), null);
  assert.equal(ctx.take('t1'), null);
  ctx.put('t2', {data: 'y'});
  now = 1000;
  assert.equal(ctx.peek('t2'), null, 'an expired area is never previewed');
  ctx.put('t3', {data: 'z'});
  assert.equal(ctx.peek('t2'), null, 'a new selection replaces the old one');
});

test('image support comes only from the provider capability tree; missing fields stay unknown', () => {
  const caps = m.parseImageSupport({data: [
    {id: 'claude-a', capabilities: {image_input: {supported: true}}},
    {id: 'claude-b', capabilities: {image_input: {supported: false}}},
    {id: 'claude-c'},
    {id: 'bad id!', capabilities: {image_input: {supported: true}}},
  ]});
  assert.deepEqual([...caps], [['claude-a', true], ['claude-b', false]]);
  assert.equal(m.parseImageSupport(null).size, 0);
});

test('companion IPC: companionOutbound takes the ask arguments; streamed text is an optional fourth ask argument', () => {
  assert.ok(m.COMPANION_METHODS.includes('companionOutbound'));
  assert.deepEqual(m.COMPANION_ARG_SPECS.companionOutbound, m.COMPANION_ARG_SPECS.companionAsk.slice(0, 3));
  assert.deepEqual(m.COMPANION_ARG_SPECS.companionAsk[3], {kind: 'boolean', optional: true});
});

/* ---------- Backend: preview equals what is sent ---------- */

async function backend(respond) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-screen-'));
  const calls = [];
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [], safeStorage: fakeSafeStorage, companionRetryMs: 0,
    native: {listWindows: async () => [], dpapi: async () => ({ok: true}), speechVoices: async () => []},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async () => true,
    fetchImpl: async (url, init) => { calls.push({url: String(url), init}); return respond(String(url), init, calls.length); },
  });
  return {b, calls, close: async () => { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}
const IMAGE = {base64: Buffer.from('fake-png-bytes').toString('base64'), width: 640, height: 360};

test('outbound preview: offline or without a key it says why and sends nothing', async () => {
  const f = await backend(() => { throw new Error('no network expected'); });
  try {
    const o = await f.b.companion.outbound({text: 'what is this?', image: IMAGE});
    assert.equal(o.ready, false);
    assert.match(o.reason, /AI requests are off/);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('outbound preview lists exactly the text blocks, image size and tools the request then sends; the key is never in it', async () => {
  const f = await backend((url) => {
    if (url.endsWith('/v1/messages')) return sse(start + textBlock(0, 'A chart of sales.') + end());
    throw new Error(`unexpected ${url}`);
  });
  try {
    await f.b.setProviderKey('anthropic', KEY);
    await f.b.saveSettings({mode: 'online'});
    const o = await f.b.companion.outbound({text: '  what is this?  ', image: IMAGE});
    assert.equal(f.calls.length, 0, 'the preview makes no request');
    assert.equal(o.ready, true);
    assert.equal(o.provider, 'anthropic');
    assert.equal(o.host, 'api.anthropic.com');
    assert.deepEqual(o.image, {width: 640, height: 360, bytes: 'fake-png-bytes'.length, mediaType: 'image/png'});
    assert.equal(o.imageSupport, 'unknown');
    assert.ok(o.tools.includes('search_saved'));
    assert.ok(!JSON.stringify(o).includes(KEY));
    const texts = [];
    const events = [];
    await f.b.companion.run({text: '  what is this?  ', image: IMAGE}, {emit: (e) => events.push(e), confirm: async () => true, signal: new AbortController().signal, onText: (step, t) => texts.push([step, t])});
    assert.equal(f.calls.length, 1);
    const sent = JSON.parse(f.calls[0].init.body);
    assert.equal(sent.stream, true);
    assert.equal(sent.model, o.model);
    const first = sent.messages[0].content;
    assert.deepEqual(first.filter((b) => b.type === 'text').map((b) => b.text), o.blocks.map((b) => b.text));
    assert.equal(first[0].type, 'image');
    assert.deepEqual(sent.tools.map((t) => t.name), o.tools);
    assert.deepEqual(texts, [[1, 'A chart of sales.']]);
    assert.equal(events.at(-1).type, 'answer');
  } finally { await f.close(); }
});

test('a model whose own listing says it reads no images is never sent one; the preview says so', async () => {
  const f = await backend((url) => {
    if (url.endsWith('/v1/models')) return new Response(JSON.stringify({data: [{id: 'claude-haiku-4-5', display_name: 'Haiku', capabilities: {image_input: {supported: false}}}]}), {status: 200});
    throw new Error(`unexpected ${url}`);
  });
  try {
    await f.b.setProviderKey('anthropic', KEY);
    await f.b.saveSettings({mode: 'online'});
    const list = await f.b.cloudModels('anthropic');
    assert.equal(list.available, true);
    const before = f.calls.length;
    assert.equal((await f.b.companion.outbound({text: 'x', image: IMAGE})).imageSupport, 'unsupported');
    const events = [];
    await f.b.companion.run({text: 'x', image: IMAGE}, {emit: (e) => events.push(e), confirm: async () => true, signal: new AbortController().signal});
    assert.equal(f.calls.length, before, 'no request with the image');
    assert.equal(events.at(-1).reason, 'setup');
    assert.match(events.at(-1).message, /does not accept images/);
  } finally { await f.close(); }
});

test('a temporary overload is retried once through the guarded transport and the activity log says so', async () => {
  const f = await backend((url, init, n) => (n === 1 ? new Response('busy', {status: 529}) : sse(start + textBlock(0, 'Done.') + end())));
  try {
    await f.b.setProviderKey('anthropic', KEY);
    await f.b.saveSettings({mode: 'online'});
    const events = [];
    await f.b.companion.run({text: 'hello'}, {emit: (e) => events.push(e), confirm: async () => true, signal: new AbortController().signal});
    assert.equal(f.calls.length, 2);
    assert.ok(events.some((e) => e.type === 'status' && e.retry === 1));
    assert.equal(events.at(-1).type, 'answer');
    const log = (await f.b.getState()).activity.map((a) => a.summary).join('\n');
    assert.match(log, /Companion request sent to Anthropic \(1 step, 1 retried\)/);
  } finally { await f.close(); }
});
