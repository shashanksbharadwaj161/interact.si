// Goal 102 (optional cloud providers) with goal 101 status honesty: the OpenAI-compatible stream adapter shared by OpenAI and
// OpenRouter, the network guard for their two origins, per-provider protected key storage with legacy single-key
// compatibility, the cloudProvider setting, the chat route that never borrows another provider's key, the provider key
// IPC argument check and the renderer bridge fallback. Fakes only: fake fetch/Response bodies, fake safeStorage, in-memory
// files. No network, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'slice-cloud-providers-entry.ts',
    loader: 'ts',
    contents: `
      export { createBackend } from './electron/backend.ts';
      export { dispatch } from './electron/ipcCore.ts';
      export { OpenAiStreamValidator, streamOpenAiCompatibleChat, streamProviderChat, CloudProviderError } from './electron/services/cloud.ts';
      export { StreamAborted, StreamIncomplete, StreamProtocolError } from './electron/services/ollama.ts';
      export { evaluateEgress, createGuardedFetch, NetworkDenied, OPENAI_ORIGIN, OPENROUTER_ORIGIN, ANTHROPIC_ORIGIN, originForProvider } from './electron/services/netGuard.ts';
      export { Secrets, PROVIDER_KEY_FILES } from './electron/services/secrets.ts';
      export { parseState, mergeSettings, DEFAULT_SETTINGS, ValidationError, describePermissionChanges } from './electron/services/validation.ts';
      export { sendChat, ChatService, selectedCloudProvider } from './electron/services/chat.ts';
      export { providerKeyArgsProblem, PROVIDER_KEY_METHODS, METHODS } from './electron/channels.ts';
      export { cloudProvidersBridge, PROVIDER_KEYS_NOT_CONNECTED } from './src/ui/bridges.ts';
      export { CLOUD_PROVIDERS, effectiveCloudModel } from './src/shared/contracts.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const KEY = 'sk-test-0123456789abcdefghijklmnopqrstuvwxyz';
const enc = new TextEncoder();
/** SSE body from chunks. hang keeps the stream open (no end) after the last chunk. */
function body(chunks, {hang = false} = {}) {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < chunks.length) { c.enqueue(enc.encode(chunks[i++])); return undefined; }
      if (!hang) { c.close(); return undefined; }
      return new Promise(() => {});
    },
  });
}
const ev = (obj) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
const delta = (content) => ev({choices: [{index: 0, delta: {content}}]});

/** A GuardedFetch backed by the real guard with a fake transport, online, keys present only for `keys`. */
function guarded(respond, {mode = 'online', keys = ['openai', 'openrouter'], anthropic = false} = {}) {
  const calls = [];
  const audit = [];
  const fetch = m.createGuardedFetch({
    mode: () => mode,
    hasCloudKey: () => anthropic,
    hasProviderKey: (p) => keys.includes(p),
    audit: (decision, origin, purpose, reason) => audit.push({decision, origin, purpose, reason}),
    fetchImpl: async (url, init) => { calls.push({url, init}); return respond(url, init); },
  });
  return {fetch, calls, audit};
}
const req = (over = {}) => ({key: KEY, model: 'gpt-4o-mini', messages: [{role: 'user', content: 'hi'}], signal: new AbortController().signal, onDelta: () => {}, ...over});

test('OpenAI-compatible stream: several delta chunks then [DONE] give the text, deltas, usage and an exact request', async () => {
  const chunks = [
    ev({choices: [{index: 0, delta: {role: 'assistant'}}]}),
    delta('Hel'),
    'data: {"choices":[{"index":0,"delta":{"content":"lo, "}}]}\n', '\n', // one event split across chunks
    delta('world'),
    ev({choices: [{index: 0, delta: {}, finish_reason: 'stop'}]}),
    ': keep-alive comment\n\n',
    ev({choices: [], usage: {prompt_tokens: 7, completion_tokens: 3}}),
    ev('[DONE]'),
  ];
  const g = guarded(() => new Response(body(chunks), {status: 200}));
  const deltas = [];
  const r = await m.streamOpenAiCompatibleChat(g.fetch, {...req({onDelta: (t) => deltas.push(t)}), provider: 'openai'});
  assert.equal(r.text, 'Hello, world');
  assert.deepEqual(deltas, ['Hel', 'lo, ', 'world']);
  assert.deepEqual(r.usage, {inputTokens: 7, outputTokens: 3, generationMs: null, promptMs: null});
  assert.equal(r.complete, true);
  assert.equal(r.truncated, false);
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].url, `${m.OPENAI_ORIGIN}/v1/chat/completions`);
  assert.equal(g.calls[0].init.method, 'POST');
  assert.equal(g.calls[0].init.redirect, 'error');
  assert.equal(g.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!('x-api-key' in g.calls[0].init.headers));
  const sent = JSON.parse(g.calls[0].init.body);
  assert.equal(sent.model, 'gpt-4o-mini');
  assert.equal(sent.stream, true);
  assert.equal(sent.max_tokens, 1024);
  assert.deepEqual(sent.messages, [{role: 'user', content: 'hi'}]);
  assert.ok(!JSON.stringify(g.audit).includes(KEY), 'the audit trail never carries the key');

  const g2 = guarded(() => new Response(body([delta('ok'), ev('[DONE]')]), {status: 200}));
  const r2 = await m.streamProviderChat('openrouter', g2.fetch, req({model: 'openai/gpt-4o-mini'}));
  assert.equal(r2.text, 'ok');
  assert.equal(r2.usage, null, 'usage is never guessed when the provider did not report it');
  assert.equal(g2.calls[0].url, `${m.OPENROUTER_ORIGIN}/api/v1/chat/completions`);
  assert.equal(m.originForProvider('openai'), 'https://api.openai.com');
  assert.equal(m.originForProvider('openrouter'), 'https://openrouter.ai');
  assert.equal(m.originForProvider('anthropic'), m.ANTHROPIC_ORIGIN);
});

test('validator: data after [DONE], malformed JSON and malformed chunks are protocol errors; error chunks keep only a code', () => {
  const v = new m.OpenAiStreamValidator();
  assert.equal(v.accept({event: '', data: JSON.stringify({choices: [{delta: {content: 'a'}}]})}), 'a');
  assert.equal(v.accept({event: '', data: '[DONE]'}), '');
  assert.equal(v.done, true);
  assert.throws(() => v.accept({event: '', data: JSON.stringify({choices: [{delta: {content: 'late'}}]})}), (e) => e instanceof m.StreamProtocolError && /after the end/.test(e.message));
  assert.throws(() => v.accept({event: '', data: '[DONE]'}), m.StreamProtocolError);

  for (const data of ['{not json', '[1,2]', '"text"', JSON.stringify({choices: 'x'}), JSON.stringify({choices: [5]}), JSON.stringify({choices: [{delta: 'x'}]}), JSON.stringify({choices: [{delta: {content: 42}}]})]) {
    assert.throws(() => new m.OpenAiStreamValidator().accept({event: '', data}), m.StreamProtocolError, data);
  }
  const leaked = JSON.stringify({error: {message: `Incorrect API key provided: ${KEY} please see docs`, type: 'invalid_request_error', code: 'invalid_api_key'}});
  assert.throws(() => new m.OpenAiStreamValidator().accept({event: '', data: leaked}), (e) => e instanceof m.StreamProtocolError && /\(invalid_api_key\)/.test(e.message) && !e.message.includes(KEY) && !/Incorrect/.test(e.message));
  assert.throws(() => new m.OpenAiStreamValidator().accept({event: '', data: JSON.stringify({error: {message: 'free text', code: 'has spaces <b>'}})}), (e) => /\(error\)/.test(e.message) && !/free text|<b>/.test(e.message));
});

test('stream: a malformed chunk rejects the reply even after good text', async () => {
  const g = guarded(() => new Response(body([delta('fine'), 'data: {"choices":[{"delta":\n\n', ev('[DONE]')]), {status: 200}));
  await assert.rejects(m.streamOpenAiCompatibleChat(g.fetch, {...req(), provider: 'openai'}), m.StreamProtocolError);
});

test('stream: aborting mid-reply yields StreamAborted with the partial text and aborts the in-flight request', async () => {
  const ac = new AbortController();
  let seenSignal = null;
  const g = guarded((url, init) => { seenSignal = init.signal; return new Response(body([delta('Hello '), delta('wor')], {hang: true}), {status: 200}); });
  let n = 0;
  const p = m.streamOpenAiCompatibleChat(g.fetch, {...req({signal: ac.signal, onDelta: () => { if (++n === 2) ac.abort(); }}), provider: 'openai'});
  await assert.rejects(p, (e) => e instanceof m.StreamAborted && e.partial === 'Hello wor');
  assert.equal(seenSignal.aborted, true, 'the guarded fetch signal follows the caller abort');

  const pre = new AbortController();
  pre.abort();
  const g2 = guarded(() => assert.fail('no request after an abort'));
  await assert.rejects(m.streamOpenAiCompatibleChat(g2.fetch, {...req({signal: pre.signal}), provider: 'openrouter'}), m.StreamAborted);
  assert.equal(g2.calls.length, 0);
});

test('stream: a body that ends without [DONE] is StreamIncomplete with the partial text; an empty reply is an error', async () => {
  const g = guarded(() => new Response(body([delta('half a '), delta('reply')]), {status: 200}));
  await assert.rejects(m.streamOpenAiCompatibleChat(g.fetch, {...req(), provider: 'openai'}), (e) => e instanceof m.StreamIncomplete && e.partial === 'half a reply');
  const g2 = guarded(() => new Response(body([ev({choices: [{delta: {role: 'assistant'}}]}), ev('[DONE]')]), {status: 200}));
  await assert.rejects(m.streamOpenAiCompatibleChat(g2.fetch, {...req(), provider: 'openai'}), (e) => e instanceof m.CloudProviderError && /empty reply/.test(e.message));
});

test('HTTP errors are status-only: no key, no body text', async () => {
  const echo = `{"error":{"message":"Incorrect API key provided: ${KEY}. Header Authorization: Bearer ${KEY}"}}`;
  const cases = [[401, 'The cloud provider rejected the API key'], [403, 'The cloud provider rejected the API key'], [429, 'The cloud provider is rate limiting requests (HTTP 429). Try again later'], [500, 'Cloud provider returned HTTP 500']];
  for (const [status, msg] of cases) {
    for (const provider of ['openai', 'openrouter']) {
      const g = guarded(() => new Response(echo, {status}));
      await assert.rejects(m.streamProviderChat(provider, g.fetch, req()), (e) => {
        assert.ok(e instanceof m.CloudProviderError);
        assert.equal(e.message, msg);
        assert.ok(!e.message.includes(KEY) && !/Incorrect|Bearer/.test(e.message));
        assert.ok(!JSON.stringify({...e, stack: undefined}).includes(KEY));
        return true;
      });
    }
  }
});

test('guard: OpenAI and OpenRouter origins are refused offline, for every purpose but cloud-chat, without their own key, and off the chat route', async () => {
  const url = {openai: `${m.OPENAI_ORIGIN}/v1/chat/completions`, openrouter: `${m.OPENROUTER_ORIGIN}/api/v1/chat/completions`};
  const auth = {authorization: 'Bearer x'};
  for (const p of ['openai', 'openrouter']) {
    const keys = {[p]: true};
    assert.equal(m.evaluateEgress(url[p], 'cloud-chat', 'online', false, undefined, {method: 'POST', headers: auth, providerKeys: keys}), null);
    assert.match(m.evaluateEgress(url[p], 'cloud-chat', 'offline', true, undefined, {method: 'POST', headers: auth, providerKeys: keys}), /Offline mode/);
    for (const purpose of ['ollama', 'provider-check', 'integration', 'model-download', '']) {
      assert.ok(m.evaluateEgress(url[p], purpose, 'online', true, undefined, {method: 'POST', headers: auth, providerKeys: keys}), `${p} ${purpose} must be refused`);
      assert.ok(m.evaluateEgress(url[p], purpose, 'offline', true, undefined, {method: 'POST', headers: auth, providerKeys: keys}));
    }
    assert.match(m.evaluateEgress(url[p], 'cloud-chat', 'online', true, undefined, {method: 'POST', headers: auth}), /No cloud API key/, 'the Anthropic key never unlocks another provider');
    assert.match(m.evaluateEgress(url[p], 'cloud-chat', 'online', true, undefined, {method: 'POST', headers: auth, providerKeys: {[p === 'openai' ? 'openrouter' : 'openai']: true}}), /No cloud API key/);
    assert.ok(m.evaluateEgress(url[p].replace('chat/completions', 'models'), 'cloud-chat', 'online', false, undefined, {method: 'POST', providerKeys: keys}));
    assert.ok(m.evaluateEgress(`${url[p]}?x=1`, 'cloud-chat', 'online', false, undefined, {method: 'POST', providerKeys: keys}));
    assert.ok(m.evaluateEgress(url[p], 'cloud-chat', 'online', false, undefined, {method: 'GET', providerKeys: keys}));
    assert.ok(m.evaluateEgress(url[p], 'cloud-chat', 'online', false, undefined, {method: 'POST', headers: {'x-api-key': 'k'}, providerKeys: keys}));
    assert.ok(m.evaluateEgress(url[p], 'cloud-chat', 'online', false, undefined, {method: 'POST', headers: {cookie: 'a=b'}, providerKeys: keys}));
  }
  // Look-alike hosts are not the provider.
  assert.ok(m.evaluateEgress('https://api.openai.com.evil.example/v1/chat/completions', 'cloud-chat', 'online', true, undefined, {method: 'POST', providerKeys: {openai: true}}));
  assert.ok(m.evaluateEgress('http://api.openai.com/v1/chat/completions', 'cloud-chat', 'online', true, undefined, {method: 'POST', providerKeys: {openai: true}}));

  // Through createGuardedFetch: offline, wrong purpose and a missing provider key never reach the transport.
  for (const [opts, purpose] of [[{mode: 'offline'}, 'cloud-chat'], [{}, 'ollama'], [{keys: [], anthropic: true}, 'cloud-chat']]) {
    const g = guarded(() => assert.fail('transport must not be reached'), opts);
    await assert.rejects(g.fetch(url.openai, {method: 'POST', headers: auth}, purpose), m.NetworkDenied);
    await assert.rejects(g.fetch(url.openrouter, {method: 'POST', headers: auth}, purpose), m.NetworkDenied);
    assert.equal(g.calls.length, 0);
    assert.ok(g.audit.every((a) => a.decision === 'denied'));
  }
});

function memFs() {
  const files = new Map();
  return {files, read: async (p) => (files.has(p) ? files.get(p) : null), write: async (p, d) => { files.set(p, d); }, remove: async (p) => { files.delete(p); }};
}
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
  decryptString: (buf) => { const s = buf.toString('utf8'); if (!s.startsWith('enc:')) throw new Error('bad'); return [...s.slice(4)].reverse().join(''); },
};
const noDpapi = {dpapi: async () => { throw new Error('DPAPI must not be used when safeStorage is available'); }};

test('secrets: one protected key per provider; a legacy single key keeps working as the Anthropic key', async () => {
  const dir = path.join(root, '.never-written-fixture');
  const fs = memFs();
  const legacyFile = path.join(dir, 'secrets', 'cloud-key.bin');
  const LEGACY = 'sk-ant-legacy-0123456789abcdefghij';
  fs.files.set(legacyFile, `ss1:${fakeSafeStorage.encryptString(LEGACY).toString('base64')}`);
  const s = new m.Secrets(noDpapi, dir, fs, fakeSafeStorage);

  assert.equal(await s.hasKey('anthropic'), true);
  assert.equal(await s.revealKey('anthropic'), LEGACY);
  assert.equal(await s.reveal(), LEGACY, 'the original single-key API still reads the same key');
  assert.equal(await s.configured(), true);
  assert.equal(await s.hasKey('openai'), false);
  assert.equal(await s.hasKey('openrouter'), false);
  assert.equal(await s.revealKey('openai'), null);

  assert.deepEqual(await s.setKey('openai', KEY), {configured: true});
  const openaiFile = path.join(dir, 'secrets', m.PROVIDER_KEY_FILES.openai);
  assert.ok(fs.files.get(openaiFile).startsWith('ss1:'));
  assert.ok(![...fs.files.values()].some((v) => v.includes(KEY)), 'only ciphertext is written');
  assert.equal(await s.revealKey('openai'), KEY);
  assert.equal(await s.revealKey('anthropic'), LEGACY, 'storing another provider key leaves the Anthropic key alone');
  assert.equal(await s.hasKey('openrouter'), false);

  await s.setKey('anthropic', 'sk-ant-new-0123456789abcdefghijk');
  assert.equal(await s.reveal(), 'sk-ant-new-0123456789abcdefghijk', 'the Anthropic slot and the legacy slot are the same key');
  assert.equal(await s.revealKey('openai'), KEY);

  assert.deepEqual(await s.clearKey('openai'), {configured: false});
  assert.equal(await s.hasKey('openai'), false);
  assert.equal(await s.hasKey('anthropic'), true);

  const before = new Map(fs.files);
  for (const bad of ['gemini', '', 'ANTHROPIC', '../cloud-key', null, 1]) {
    await assert.rejects(s.setKey(bad, KEY), m.ValidationError);
    await assert.rejects(s.hasKey(bad), m.ValidationError);
    await assert.rejects(s.clearKey(bad), m.ValidationError);
  }
  assert.deepEqual(fs.files, before, 'an invalid provider id never touches a key file');
  await assert.rejects(s.setKey('openrouter', 'short'), m.ValidationError);
  assert.deepEqual(JSON.parse(JSON.stringify(s)), {secrets: 'redacted'});
});

test('settings: cloudProvider defaults to anthropic, parseState falls back leniently, explicit updates reject unknown ids', () => {
  assert.equal(m.DEFAULT_SETTINGS.cloudProvider, 'anthropic');
  const base = {capsules: [], notes: [], tasks: []};
  assert.equal(m.parseState({...base, settings: {}}).settings.cloudProvider, 'anthropic');
  const dropped = [];
  assert.equal(m.parseState({...base, settings: {cloudProvider: 'gemini'}}, {lenient: true, dropped}).settings.cloudProvider, 'anthropic');
  assert.ok(dropped.some((d) => d.startsWith('cloudProvider')));
  assert.equal(m.parseState({...base, settings: {cloudProvider: 42}}).settings.cloudProvider, 'anthropic');
  assert.equal(m.parseState({...base, settings: {cloudProvider: 'openrouter'}}).settings.cloudProvider, 'openrouter');

  const current = m.parseState({...base, settings: {}}).settings;
  assert.equal(m.mergeSettings(current, {cloudProvider: 'openai'}).cloudProvider, 'openai');
  for (const bad of ['gemini', 'OpenAI', '', 7, null]) {
    assert.throws(() => m.mergeSettings(current, {cloudProvider: bad}), (e) => e instanceof m.ValidationError && /cloudProvider/.test(e.message) && /anthropic, openai, openrouter/.test(e.message));
  }
  const online = {...current, mode: 'online'};
  assert.ok(m.describePermissionChanges(online, {...online, cloudProvider: 'openai'}).some((c) => /Cloud provider: anthropic -> openai/.test(c)));
  assert.deepEqual(m.describePermissionChanges(current, {...current, cloudProvider: 'openai'}), [], 'offline the choice changes nothing that is sent');
});

test('model ids default to the provider default when empty or from another provider family', () => {
  assert.deepEqual(m.CLOUD_PROVIDERS.map((p) => p.id), ['anthropic', 'openai', 'openrouter']);
  assert.equal(m.effectiveCloudModel('anthropic', 'claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.equal(m.effectiveCloudModel('openai', 'claude-haiku-4-5'), 'gpt-4o-mini');
  assert.equal(m.effectiveCloudModel('openai', 'gpt-4.1'), 'gpt-4.1');
  assert.equal(m.effectiveCloudModel('openrouter', 'gpt-4.1'), 'openai/gpt-4o-mini');
  assert.equal(m.effectiveCloudModel('openrouter', 'anthropic/claude-3.5-sonnet'), 'anthropic/claude-3.5-sonnet');
  assert.equal(m.effectiveCloudModel('anthropic', 'openai/gpt-4o'), 'claude-haiku-4-5');
  assert.equal(m.effectiveCloudModel('anthropic', ''), 'claude-haiku-4-5');
  assert.equal(m.selectedCloudProvider({}), 'anthropic');
  assert.equal(m.selectedCloudProvider({cloudProvider: 'bogus'}), 'anthropic');
});

function fakeStore(settings) {
  const state = {settings: {...m.DEFAULT_SETTINGS, ...settings}, chat: [], capsules: [], notes: [], tasks: [], activity: []};
  let n = 0;
  return {state, snapshot: () => structuredClone(state), nowIso: () => '2025-01-01T00:00:00.000Z', id: () => `m${++n}`, mutate: async (fn) => { fn(state); return state; }};
}

test('chat: the selected provider without a key fails clearly and never touches another provider key or the network', async () => {
  for (const provider of ['openai', 'openrouter']) {
    const touched = [];
    const store = fakeStore({mode: 'online', cloudProvider: provider});
    const secrets = {
      configured: async () => { touched.push('configured'); return true; },
      reveal: async () => { touched.push('reveal'); return 'sk-ant-should-never-be-read-0123456789'; },
      hasKey: async (p) => { touched.push(`has:${p}`); return p === 'anthropic'; },
      revealKey: async (p) => { touched.push(`reveal:${p}`); return null; },
    };
    const fetch = async () => assert.fail('no request without the provider key');
    const reply = await m.sendChat({store, secrets, fetch}, 'hello');
    const name = provider === 'openai' ? 'OpenAI' : 'OpenRouter';
    assert.equal(reply.source, 'system');
    assert.match(reply.text, new RegExp(`No API key stored for ${name}`));
    assert.match(reply.text, /Your message was not sent\./);
    assert.match(reply.text, /no other model was tried/);
    assert.deepEqual(touched, [`has:${provider}`], 'only the selected provider slot is checked');
  }
});

test('chat: the selected provider with its key streams through the guard, records usage, and cancel aborts the request', async () => {
  const revealed = [];
  const usage = [];
  const store = fakeStore({mode: 'online', cloudProvider: 'openrouter', cloudModel: 'claude-haiku-4-5'});
  const secrets = {configured: async () => false, reveal: async () => assert.fail('Anthropic key not used'), hasKey: async (p) => p === 'openrouter', revealKey: async (p) => { revealed.push(p); return KEY; }};
  const g = guarded(() => new Response(body([delta('Hi '), delta('there'), ev({choices: [], usage: {prompt_tokens: 4, completion_tokens: 2}}), ev('[DONE]')]), {status: 200}), {keys: ['openrouter']});
  const reply = await m.sendChat({store, secrets, fetch: g.fetch, recordUsage: (u) => usage.push(u)}, 'hello');
  assert.equal(reply.text, 'Hi there');
  assert.equal(reply.source, 'cloud');
  assert.deepEqual(revealed, ['openrouter']);
  assert.equal(g.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(JSON.parse(g.calls[0].init.body).model, 'openai/gpt-4o-mini', 'a Claude model name is not sent to OpenRouter');
  assert.deepEqual(usage, [{provider: 'openrouter', model: 'openai/gpt-4o-mini', inputTokens: 4, outputTokens: 2}]);

  // A rejected key surfaces the status-only text unchanged in the stored note.
  const g401 = guarded(() => new Response(`{"error":"${KEY}"}`, {status: 401}), {keys: ['openrouter']});
  const r401 = await m.sendChat({store, secrets, fetch: g401.fetch}, 'again');
  assert.match(r401.text, /^Cloud model unavailable: The cloud provider rejected the API key\./);
  assert.ok(!r401.text.includes(KEY));

  // Cancellation aborts the in-flight guarded fetch and keeps the partial text once.
  let signal = null;
  const gHang = guarded((url, init) => { signal = init.signal; return new Response(body([delta('par'), delta('tial')], {hang: true}), {status: 200}); }, {keys: ['openrouter']});
  const svc = new m.ChatService({store, secrets, fetch: gHang.fetch});
  let n = 0;
  let handle;
  handle = svc.start('long one', {onDelta: () => { if (++n === 2) handle.cancel(); }});
  const stopped = await handle.done;
  assert.equal(signal.aborted, true);
  assert.match(stopped.text, /^Stopped by you\. The reply above is incomplete\./);
  const partial = store.state.chat[store.state.chat.length - 2];
  assert.equal(partial.text, 'partial');
  assert.equal(partial.source, 'cloud');
});

test('IPC: provider key channels validate the provider id and arity before any handler; existing channels are unchanged', () => {
  for (const name of ['setCloudKey', 'cloudKeyStatus', 'deleteCloudKey']) assert.ok(m.METHODS.includes(name));
  for (const name of m.PROVIDER_KEY_METHODS) assert.ok(m.METHODS.includes(name), 'registered through the authoritative method table');
  assert.equal(m.providerKeyArgsProblem('cloudProviderStatus', []), null);
  assert.equal(m.providerKeyArgsProblem('setProviderKey', ['openai', KEY]), null);
  assert.equal(m.providerKeyArgsProblem('clearProviderKey', ['openrouter']), null);
  assert.match(m.providerKeyArgsProblem('setProviderKey', ['gemini', KEY]), /expected one of anthropic, openai, openrouter/);
  assert.match(m.providerKeyArgsProblem('clearProviderKey', [{}]), /expected one of/);
  assert.match(m.providerKeyArgsProblem('setProviderKey', ['openai']), /Wrong number/);
  assert.match(m.providerKeyArgsProblem('setProviderKey', ['openai', 'x'.repeat(5000)]), /1 to 4096/);
  assert.match(m.providerKeyArgsProblem('revealProviderKey', ['openai']), /Unknown method/);
  assert.ok(!(m.providerKeyArgsProblem('setProviderKey', ['gemini', KEY]) ?? '').includes(KEY));
});

test('IPC dispatcher: provider methods use shared trust, arity and argument validation before touching handlers', async () => {
  const seen = [];
  const handlers = Object.fromEntries(m.PROVIDER_KEY_METHODS.map((method) => [method, async (...args) => { seen.push({method, args}); return 'ok'; }]));
  const appUrl = 'file:///C:/app/dist/index.html';
  const opts = {appFileUrl: appUrl};
  const cases = [['cloudProviderStatus', []], ['setProviderKey', ['openai', KEY]], ['clearProviderKey', ['openrouter']]];
  for (const [method, args] of cases) {
    await assert.rejects(m.dispatch(handlers, method, args, 'https://untrusted.example/', opts), /untrusted sender/);
    await assert.rejects(m.dispatch(handlers, method, args, appUrl, opts, false), /untrusted sender/);
    await assert.rejects(m.dispatch(handlers, method, [...args, true], appUrl, opts), /Wrong number/);
  }
  for (const args of [[], ['openai'], ['gemini', KEY], ['openai', {}], ['openai', ''], ['openai', 'x'.repeat(4097)]]) {
    await assert.rejects(m.dispatch(handlers, 'setProviderKey', args, appUrl, opts), (e) => !e.message.includes(KEY) && /Invalid argument|Wrong number/.test(e.message));
  }
  await assert.rejects(m.dispatch(handlers, 'clearProviderKey', ['gemini'], appUrl, opts), /Invalid argument/);
  assert.deepEqual(seen, [], 'every malformed or untrusted call stops before any vault handler');
  for (const [method, args] of cases) assert.equal(await m.dispatch(handlers, method, args, appUrl, opts), 'ok');
  assert.deepEqual(seen, cases.map(([method, args]) => ({method, args})));
});

test('renderer bridge: without per-provider channels the status is honest and other providers never fall back to the Anthropic key', async () => {
  const calls = [];
  const legacyApi = {cloudKeyStatus: async () => ({configured: true}), setCloudKey: async (k) => { calls.push(['setCloudKey', k]); return {configured: true}; }, deleteCloudKey: async () => { calls.push(['deleteCloudKey']); }};
  const b = m.cloudProvidersBridge(legacyApi);
  const st = await b.status();
  assert.deepEqual(st.map((s) => [s.provider, s.hasKey, s.keyChannel]), [['anthropic', true, 'legacy'], ['openai', false, 'unavailable'], ['openrouter', false, 'unavailable']]);
  assert.deepEqual(st.map((s) => s.origin), ['api.anthropic.com', 'api.openai.com', 'openrouter.ai']);
  await assert.rejects(b.setKey('openai', KEY), (e) => e.message === m.PROVIDER_KEYS_NOT_CONNECTED);
  await assert.rejects(b.clearKey('openrouter'), (e) => e.message === m.PROVIDER_KEYS_NOT_CONNECTED);
  assert.deepEqual(calls, [], 'an OpenAI key is never stored in the Anthropic slot');
  assert.deepEqual(await b.setKey('anthropic', KEY), {provider: 'anthropic', configured: true});
  await assert.rejects(b.setKey('gemini', KEY));

  const fullApi = {
    cloudProviderStatus: async () => [{provider: 'anthropic', hasKey: false, key: 'leak'}, {provider: 'openai', hasKey: true}, {provider: 'openrouter', hasKey: false}],
    setProviderKey: async (p, k) => ({provider: p, configured: !!k}),
    clearProviderKey: async (p) => ({provider: p, configured: false}),
  };
  const full = await m.cloudProvidersBridge(fullApi).status();
  assert.deepEqual(full.map((s) => [s.provider, s.hasKey, s.keyChannel]), [['anthropic', false, 'per-provider'], ['openai', true, 'per-provider'], ['openrouter', false, 'per-provider']]);
  assert.ok(!JSON.stringify(full).includes('leak'), 'unexpected fields from main are dropped');
  const broken = await m.cloudProvidersBridge({...fullApi, cloudProviderStatus: async () => { throw new Error('Per-provider cloud keys are not connected in this build'); }, cloudKeyStatus: async () => ({configured: false})}).status();
  assert.deepEqual(broken.map((s) => s.keyChannel), ['legacy', 'unavailable', 'unavailable']);
});

async function backendFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-provider-test-'));
  const calls = [], confirmations = [];
  let allowed = true;
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [], safeStorage: fakeSafeStorage,
    native: {listWindows: async () => [], dpapi: async () => ({ok: true}), speechVoices: async () => []},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async (title, detail) => { confirmations.push({title, detail}); return allowed; },
    fetchImpl: async (url, init) => {
      calls.push({url: String(url), init});
      assert.ok(String(url).includes('chat/completions'), 'no other network endpoint is needed');
      return new Response(body([delta('Actual adapter reply'), ev({choices: [], usage: {prompt_tokens: 3, completion_tokens: 4}}), ev('[DONE]')]));
    },
  });
  return {b, calls, confirmations, deny: () => { allowed = false; }, close: async () => { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}
async function backendStream(b) {
  const start = await b.chatStreamStart('Explain this');
  for (let i = 0; i < 100; i++) {
    const batch = await b.chatStreamRead(start.streamId, 0);
    const done = batch.events.find((e) => e.type === 'done');
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('backend stream did not finish');
}
test('real backend: per-provider keys, selected provider routing, guarded stream, usage and online-change confirmation', async () => {
  for (const provider of ['openai', 'openrouter']) {
    const f = await backendFixture();
    try {
      assert.equal((await f.b.getState()).settings.mode, 'offline');
      await f.b.setCloudKey('sk-ant-unrelated-01234567890123456789');
      await f.b.saveSettings({cloudProvider: provider});
      assert.equal(f.confirmations.length, 0, 'offline provider selection sends nothing');
      await f.b.saveSettings({mode: 'online'});
      const denied = await backendStream(f.b);
      assert.equal(denied.outcome, 'failed');
      assert.match(denied.reply.text, /No API key stored for/);
      assert.equal(f.calls.length, 0, 'an Anthropic key never unlocks a selected different provider');
      await f.b.setProviderKey(provider, KEY);
      const status = await f.b.cloudProviderStatus();
      assert.equal(status.find((s) => s.provider === provider).hasKey, true);
      assert.ok(!JSON.stringify(status).includes(KEY));
      const complete = await backendStream(f.b);
      assert.equal(complete.outcome, 'complete');
      assert.equal(complete.reply.text, 'Actual adapter reply');
      assert.equal(f.calls[0].url, provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), `Bearer ${KEY}`);
      assert.equal(new Headers(f.calls[0].init.headers).get('x-api-key'), null);
      const report = (await f.b.usageReport()).report;
      assert.equal(report.totals.events, 1);
      assert.equal(report.totals.inputTokens, 3);
      assert.equal(report.totals.outputTokens, 4);
      assert.ok(!JSON.stringify(await f.b.getState()).includes(KEY));
      assert.equal((await f.b.chat('One shot too')).text, 'Actual adapter reply');
      assert.equal((await f.b.usageReport()).report.totals.events, 2, 'legacy API records actual compatible-provider usage too');
      f.deny();
      await assert.rejects(f.b.saveSettings({cloudProvider: 'anthropic'}), /confirmation/);
      assert.equal((await f.b.getState()).settings.cloudProvider, provider);
      assert.ok(f.confirmations.at(-1).detail.includes('Cloud provider:'));
      await f.b.clearProviderKey(provider);
      assert.equal((await f.b.cloudProviderStatus()).find((s) => s.provider === provider).hasKey, false);
      assert.equal((await backendStream(f.b)).outcome, 'failed');
      assert.equal(f.calls.length, 2, 'clearing the selected key blocks another request');
    } finally { await f.close(); }
  }
});
