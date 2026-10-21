// Bounded live-provider testing and the explicit connection test. The budget is enforced in the main process on every
// provider request (island, hub chat, connection test): output cap written into the body, body size, request count and
// an estimated dollar ceiling reserved and saved before sending, no automatic retry, fewer companion steps. A config that
// is set but invalid blocks every provider request. Fake transport only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm, readFile} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root, sourcefile: 'live-budget-entry.ts', loader: 'ts',
    contents: `
      export { createBackend, PROVIDER_TEST_MAX_TOKENS } from './electron/backend.ts';
      export { parseLiveTestConfig, LiveBudget, withLiveBudget, estimateInputTokens, IMAGE_TOKEN_ALLOWANCE } from './electron/services/liveBudget.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const CONFIG = {budgetId: 'review-1', maxOutputTokens: 256, maxSteps: 3, maxBodyChars: 400_000, maxRequests: 20, maxReservedUsd: 2, inputPerMillionUsd: 3, outputPerMillionUsd: 15};
const memStore = (init = null) => { const s = {value: init, saves: 0, fail: false}; return {s, load: async () => s.value, save: async (l) => { if (s.fail) throw new Error('disk full'); s.saves++; s.value = l; }}; };
const post = (body) => JSON.stringify(body);

test('config: strict JSON object with every limit and both prices; anything else is an error', () => {
  assert.deepEqual(m.parseLiveTestConfig(JSON.stringify(CONFIG)), CONFIG);
  for (const bad of ['not json', '[]', JSON.stringify({...CONFIG, extra: 1}), JSON.stringify({...CONFIG, maxOutputTokens: 4096}), JSON.stringify({...CONFIG, maxSteps: 6}), JSON.stringify({...CONFIG, maxReservedUsd: 0}), JSON.stringify({...CONFIG, outputPerMillionUsd: undefined}), JSON.stringify({...CONFIG, budgetId: 'a b'}), JSON.stringify({...CONFIG, maxRequests: 1.5})]) {
    assert.throws(() => m.parseLiveTestConfig(bad), (e) => e.name === 'LiveBudgetError', bad);
  }
});

test('the output cap is written into every provider body; thinking is removed; a lower cap asked by the caller is kept', async () => {
  const b = await m.LiveBudget.open(CONFIG, memStore());
  const sent = JSON.parse(await b.admit('https://api.anthropic.com/v1/messages', 'POST', post({model: 'x', max_tokens: 16000, thinking: {type: 'adaptive'}, messages: []})));
  assert.equal(sent.max_tokens, 256);
  assert.equal(sent.thinking, undefined);
  assert.equal(JSON.parse(await b.admit('u', 'POST', post({max_tokens: 8, messages: []}))).max_tokens, 8);
  assert.equal(JSON.parse(await b.admit('u', 'POST', post({max_completion_tokens: 9000, messages: []}))).max_completion_tokens, 256);
  assert.equal(JSON.parse(await b.admit('u', 'POST', post({messages: []}))).max_tokens, 256, 'a missing cap is added');
  assert.equal(await b.admit('https://api.anthropic.com/v1/models', 'GET', undefined), undefined, 'model listing is not charged');
  assert.equal(b.spent.requests, 4);
});

test('the dollar ceiling is reserved worst-case before sending and saved first; over the ceiling nothing is sent', async () => {
  const store = memStore();
  const tight = {...CONFIG, maxReservedUsd: 0.01};
  const b = await m.LiveBudget.open(tight, store);
  // 300 chars ≈ 100 input tokens + 256 output tokens: (100*3 + 256*15) / 1e6 ≈ $0.0041 per request.
  const body = post({max_tokens: 256, messages: [{role: 'user', content: 'x'.repeat(240)}]});
  await b.admit('u', 'POST', body);
  await b.admit('u', 'POST', body);
  assert.equal(store.s.saves, 2);
  await assert.rejects(b.admit('u', 'POST', body), /could cost up to \$0\.00\d+ \(estimate\).*Nothing was sent/);
  assert.equal(b.spent.requests, 2, 'a refused request reserves nothing');
  assert.ok(b.spent.reservedUsd <= 0.01);
  const again = await m.LiveBudget.open(tight, store);
  assert.equal(again.spent.requests, 2, 'restarting does not reset the ceiling');
  await assert.rejects(again.admit('u', 'POST', body), /ceiling/);
  const fresh = await m.LiveBudget.open({...tight, budgetId: 'review-2'}, store);
  assert.equal(fresh.spent.requests, 0, 'a new budget id starts a new ledger');
});

test('request count, body size, unreadable bodies and a ledger that cannot be saved all refuse before sending', async () => {
  const b = await m.LiveBudget.open({...CONFIG, maxRequests: 1}, memStore());
  await b.admit('u', 'POST', post({messages: []}));
  await assert.rejects(b.admit('u', 'POST', post({messages: []})), /request limit \(1\)/);
  const small = await m.LiveBudget.open({...CONFIG, maxBodyChars: 200}, memStore());
  await assert.rejects(small.admit('u', 'POST', post({messages: [{content: 'x'.repeat(300)}]})), /300|characters of text; the limit is 200/);
  const pic = {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'A'.repeat(500_000)}};
  const roomy = await m.LiveBudget.open({...CONFIG, maxBodyChars: 2000}, memStore());
  await roomy.admit('u', 'POST', post({messages: [{role: 'user', content: [pic, {type: 'text', text: 'what is this'}]}]}));
  await assert.rejects(roomy.admit('u', 'POST', post({messages: [{role: 'user', content: [pic, pic]}]})), /at most 1 image/);
  await assert.rejects(small.admit('u', 'POST', 'not json'), /could not be read/);
  await assert.rejects(small.admit('u', 'POST', new Uint8Array(3)), /only JSON/);
  const st = memStore(); st.s.fail = true;
  const failing = await m.LiveBudget.open(CONFIG, st);
  await assert.rejects(failing.admit('u', 'POST', post({messages: []})), /ledger could not be saved/);
  assert.equal(failing.spent.requests, 0);
});

test('images are charged a fixed allowance, not by their base64 length', () => {
  const img = (t) => ({type: 'image', source: {type: 'base64', media_type: t, data: 'A'.repeat(90_000)}});
  const e = m.estimateInputTokens(JSON.stringify({messages: [{role: 'user', content: [img('image/png'), img('image/jpeg'), {type: 'text', text: 'hi'}]}]}));
  assert.equal(e.images, 2);
  assert.ok(e.tokens >= 2 * m.IMAGE_TOKEN_ALLOWANCE && e.tokens < 2 * m.IMAGE_TOKEN_ALLOWANCE + 100);
});

test('a misconfigured budget blocks every provider request; loopback model traffic is untouched', async () => {
  let calls = 0;
  const f = m.withLiveBudget(async () => { calls++; return new Response('{}'); }, null, 'maxSteps must be a whole number from 1 to 5');
  await assert.rejects(f('https://api.anthropic.com/v1/messages', {method: 'POST', body: '{}'}, 'cloud-chat'), /misconfigured/);
  await f('http://127.0.0.1:11434/api/chat', {method: 'POST', body: '{}'}, 'ollama');
  assert.equal(calls, 1);
  const plain = async () => new Response('');
  assert.equal(m.withLiveBudget(plain, null, null), plain, 'no budget: the original fetch, unchanged');
});

/* ---------- Backend: caps apply to the island, hub chat and the connection test ---------- */

const KEY = 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz';
const fakeSafeStorage = {isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(`enc:${p}`), decryptString: (b) => b.toString().slice(4)};
const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
const sseText = (t) => new Response(ev('message_start', {message: {id: 'm', type: 'message', role: 'assistant', content: [], usage: {input_tokens: 9, output_tokens: 0}}}) + ev('content_block_start', {index: 0, content_block: {type: 'text', text: ''}}) + ev('content_block_delta', {index: 0, delta: {type: 'text_delta', text: t}}) + ev('content_block_stop', {index: 0}) + ev('message_delta', {delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 2}}) + ev('message_stop'), {status: 200});
const sseTool = (n) => new Response(ev('message_start', {message: {id: 'm', type: 'message', role: 'assistant', content: [], usage: {input_tokens: 9, output_tokens: 0}}}) + ev('content_block_start', {index: 0, content_block: {type: 'tool_use', id: `toolu_${n}`, name: 'search_saved', input: {}}}) + ev('content_block_delta', {index: 0, delta: {type: 'input_json_delta', partial_json: '{"query":"x"}'}}) + ev('content_block_stop', {index: 0}) + ev('message_delta', {delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 5}}) + ev('message_stop'), {status: 200});

async function backend(liveTest, respond) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-live-'));
  const bodies = [];
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [], safeStorage: fakeSafeStorage, companionRetryMs: 0,
    ...(liveTest ? {liveTest} : {}),
    native: {listWindows: async () => [], dpapi: async () => ({ok: true}), speechVoices: async () => []},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async () => true,
    fetchImpl: async (url, init) => { if (init?.body) bodies.push(JSON.parse(init.body)); return respond(bodies.length, url, init); },
  });
  await b.setProviderKey('anthropic', KEY);
  await b.saveSettings({mode: 'online'});
  return {b, dir, bodies, close: async () => { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}

test('island: at most maxSteps model calls, each capped at maxOutputTokens, and no automatic retry', async () => {
  const f = await backend({config: CONFIG}, (n) => sseTool(n));
  try {
    const events = [];
    await f.b.companion.run({text: 'loop forever'}, {emit: (e) => events.push(e), confirm: async () => true, signal: new AbortController().signal});
    assert.equal(f.bodies.length, 3);
    assert.ok(f.bodies.every((x) => x.max_tokens === 256));
    assert.equal(events.at(-1).reason, 'steps');
    assert.match(events.at(-1).message, /after 3 steps/);
    const ledger = JSON.parse(await readFile(path.join(f.dir, 'live-test-budget.json'), 'utf8'));
    assert.equal(ledger.requests, 3);
    assert.ok(ledger.reservedUsd > 0 && ledger.reservedUsd < 2);
  } finally { await f.close(); }
  const g = await backend({config: CONFIG}, () => new Response('busy', {status: 529}));
  try {
    const events = [];
    await g.b.companion.run({text: 'hi'}, {emit: (e) => events.push(e), confirm: async () => true, signal: new AbortController().signal});
    assert.equal(g.bodies.length, 1, 'no retry while a live-test budget is active');
    assert.ok(!events.some((e) => e.retry));
  } finally { await g.close(); }
});

test('hub chat and the connection test pass through the same cap; an exhausted ceiling sends nothing', async () => {
  const f = await backend({config: {...CONFIG, maxOutputTokens: 64}}, () => new Response(JSON.stringify({type: 'message', content: [{type: 'text', text: 'Hi'}], stop_reason: 'end_turn', usage: {input_tokens: 3, output_tokens: 1}}), {status: 200, headers: {'content-type': 'application/json'}}));
  try {
    await f.b.chat('hello');
    assert.equal(f.bodies[0].max_tokens, 64, 'hub chat asked for 1024 and was capped');
  } finally { await f.close(); }
  const g = await backend({config: {...CONFIG, maxRequests: 1}}, () => sseText('OK'));
  try {
    const first = await g.b.providerConnectionTest('anthropic');
    assert.equal(first.ok, true);
    assert.equal(g.bodies[0].max_tokens, m.PROVIDER_TEST_MAX_TOKENS);
    const second = await g.b.providerConnectionTest('anthropic');
    assert.equal(second.ok, false);
    assert.match(second.reason, /request limit/);
    assert.equal(g.bodies.length, 1);
  } finally { await g.close(); }
  const h = await backend({error: 'maxSteps must be a whole number from 1 to 5'}, () => sseText('OK'));
  try {
    const events = [];
    await h.b.companion.run({text: 'hi'}, {emit: (e) => events.push(e), confirm: async () => true, signal: new AbortController().signal});
    assert.equal(h.bodies.length, 0);
    assert.match(events.at(-1).message, /misconfigured/);
  } finally { await h.close(); }
});

/* ---------- Connection test ---------- */

test('connection test: offline or keyless sends nothing; success reports actual usage and an estimated cost label', async () => {
  const f = await backend(null, () => sseText('OK'));
  try {
    await f.b.saveSettings({mode: 'offline'});
    const off = await f.b.providerConnectionTest('anthropic');
    assert.equal(off.ok, false);
    assert.match(off.reason, /Online mode is off/);
    assert.equal(f.bodies.length, 0);
    assert.match((await f.b.providerConnectionTest('openai')).reason, /Online mode is off|No OpenAI API key/);
    await f.b.saveSettings({mode: 'online'});
    assert.match((await f.b.providerConnectionTest('openai')).reason, /No OpenAI API key/);
    assert.equal(f.bodies.length, 0);
    const ok = await f.b.providerConnectionTest('anthropic');
    assert.equal(ok.ok, true);
    assert.equal(ok.reply, 'OK');
    assert.deepEqual(ok.usage, {inputTokens: 9, outputTokens: 2});
    assert.equal(ok.estimatedCostUsd, null, 'no price entered: no cost is invented');
    assert.match(ok.costNote, /Estimated.*Not a provider invoice/);
    assert.equal(f.bodies[0].max_tokens, m.PROVIDER_TEST_MAX_TOKENS);
    assert.equal(f.bodies[0].messages.length, 1);
    assert.equal((await f.b.getState()).chat.length, 0, 'the test is not written into the conversation');
    assert.ok(!JSON.stringify(ok).includes(KEY));
  } finally { await f.close(); }
});

test('connection test: a rejected key is status-only, and Cancel stops a pending test', async () => {
  const f = await backend(null, () => new Response(`{"error":"bad key ${KEY}"}`, {status: 401}));
  try {
    const r = await f.b.providerConnectionTest('anthropic');
    assert.equal(r.ok, false);
    assert.match(r.reason, /rejected the API key/);
    assert.ok(!r.reason.includes(KEY));
  } finally { await f.close(); }
  let release;
  const g = await backend(null, (n, url, init) => new Promise((resolve, reject) => { release = resolve; init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), {name: 'AbortError'}))); }));
  try {
    const p = g.b.providerConnectionTest('anthropic');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(g.b.providerConnectionTestCancel(), true);
    const r = await p;
    assert.equal(r.cancelled, true);
    assert.equal(g.b.providerConnectionTestCancel(), false);
    void release;
  } finally { await g.close(); }
});
