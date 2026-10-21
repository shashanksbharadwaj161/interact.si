// Claude-first AI setup (UI revamp, 16 Oct 2026): the model availability check. A real backend with fake transport,
// fake safeStorage and a temp profile. Verifies the check contacts only GET /v1/models through the network guard, only in
// online mode, only with the selected provider's own saved key, never returns or logs the key, parses defensively and
// reports every failure as a reason instead of inventing models. No network, no Electron.
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
    resolveDir: root,
    sourcefile: 'revamp-claude-models-entry.ts',
    loader: 'ts',
    contents: `
      export { createBackend } from './electron/backend.ts';
      export { parseModelList, modelListFailure, MAX_LISTED_MODELS } from './electron/services/cloud.ts';
      export { evaluateEgress, ANTHROPIC_ORIGIN } from './electron/services/netGuard.ts';
      export { METHODS, ARITY } from './electron/channels.ts';
      export { ARG_SPECS } from './electron/ipcCore.ts';
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
const ANTHROPIC_LIST = {
  data: [
    {type: 'model', id: 'claude-older-model', display_name: 'Older model', created_at: '2025-01-01T00:00:00Z'},
    {type: 'model', id: 'claude-newer-model', display_name: 'Newer model', created_at: '2026-02-01T00:00:00Z'},
    {type: 'model', id: 'bad id with spaces', display_name: 'Dropped'},
    {type: 'model', id: 'claude-newer-model', display_name: 'Duplicate'},
  ],
  has_more: false,
};

async function fixture(respond) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-models-'));
  const calls = [];
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [], safeStorage: fakeSafeStorage,
    native: {listWindows: async () => [], dpapi: async () => ({ok: true}), speechVoices: async () => []},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async () => true,
    fetchImpl: async (url, init) => { calls.push({url: String(url), init}); return respond(String(url), init); },
  });
  return {b, calls, close: async () => { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}

test('the model list method is in the authoritative IPC tables with one enum provider argument', () => {
  assert.ok(m.METHODS.includes('cloudModels'));
  assert.equal(m.ARITY.cloudModels, 1);
  assert.deepEqual(m.ARG_SPECS.cloudModels.map((s) => s.kind), ['enum']);
  assert.deepEqual([...m.ARG_SPECS.cloudModels[0].values].sort(), ['anthropic', 'openai', 'openrouter']);
});

test('parseModelList keeps valid unique ids, prefers display names, sorts newest first and rejects unreadable bodies', () => {
  const list = m.parseModelList('anthropic', ANTHROPIC_LIST);
  assert.deepEqual(list.map((x) => x.id), ['claude-newer-model', 'claude-older-model']);
  assert.equal(list[0].name, 'Newer model');
  const openai = m.parseModelList('openai', {data: [{id: 'gpt-x', created: 1700000000}, {id: 'text-embedding-3-small', created: 1}, {id: 'whisper-1', created: 2}, {id: 'o3-mini', created: 1710000000}]});
  assert.deepEqual(openai.map((x) => x.id), ['o3-mini', 'gpt-x'], 'only chat families are offered for the chat route');
  assert.throws(() => m.parseModelList('anthropic', {models: []}), /could not read/);
  assert.throws(() => m.parseModelList('anthropic', null), /could not read/);
  const many = m.parseModelList('anthropic', {data: Array.from({length: 200}, (_, i) => ({id: `claude-m${i}`}))});
  assert.equal(many.length, m.MAX_LISTED_MODELS);
  assert.match(m.modelListFailure(401), /rejected the saved key/);
  assert.match(m.modelListFailure(429), /rate limiting/);
});

test('the guard allows only GET /v1/models with x-api-key for this check, and only online', () => {
  const url = `${m.ANTHROPIC_ORIGIN}/v1/models`;
  assert.equal(m.evaluateEgress(url, 'provider-check', 'online', true, undefined, {method: 'GET', headers: {'x-api-key': 'k', 'anthropic-version': '2023-06-01'}}), null);
  assert.match(m.evaluateEgress(url, 'provider-check', 'offline', true, undefined, {method: 'GET', headers: {'x-api-key': 'k'}}), /Offline/);
  assert.match(m.evaluateEgress(url, 'provider-check', 'online', true, undefined, {method: 'POST', headers: {'x-api-key': 'k'}}), /GET/);
  assert.match(m.evaluateEgress(`${url}?limit=1000`, 'provider-check', 'online', true, undefined, {method: 'GET'}), /limited/);
});

test('offline, no key and OpenRouter return reasons without any request', async () => {
  const f = await fixture(() => { throw new Error('no request may be made'); });
  try {
    const offline = await f.b.cloudModels('anthropic');
    assert.equal(offline.available, false);
    assert.match(offline.reason, /Online mode is off/);
    await f.b.saveSettings({mode: 'online'});
    const noKey = await f.b.cloudModels('anthropic');
    assert.match(noKey.reason, /No Anthropic API key/);
    const router = await f.b.cloudModels('openrouter');
    assert.match(router.reason, /Type the model id/);
    await assert.rejects(() => f.b.cloudModels('gemini'), /provider/i, 'unknown providers are refused before anything runs');
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

test('online with a saved key: one GET to /v1/models with that key, real ids returned, key never in the result or log', async () => {
  const f = await fixture(() => new Response(JSON.stringify(ANTHROPIC_LIST), {status: 200, headers: {'content-type': 'application/json'}}));
  try {
    await f.b.setProviderKey('anthropic', KEY);
    await f.b.saveSettings({mode: 'online'});
    const r = await f.b.cloudModels('anthropic');
    assert.equal(r.available, true);
    assert.deepEqual(r.models.map((x) => x.id), ['claude-newer-model', 'claude-older-model']);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.anthropic.com/v1/models');
    assert.equal((f.calls[0].init.method ?? 'GET').toUpperCase(), 'GET');
    assert.equal(new Headers(f.calls[0].init.headers).get('x-api-key'), KEY);
    assert.equal(f.calls[0].init.body, undefined, 'nothing from the user is sent');
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.ok(!JSON.stringify(await f.b.getState()).includes(KEY), 'the activity log never carries the key');
  } finally {
    await f.close();
  }
});

test('a rejected key and an unreadable body are reported as reasons, never as models', async () => {
  for (const [res, pattern] of [[() => new Response('{}', {status: 401}), /rejected the saved key/], [() => new Response('not json', {status: 200}), /could not read/], [() => new Response(JSON.stringify({data: []}), {status: 200}), /no chat models/]]) {
    const f = await fixture(res);
    try {
      await f.b.setProviderKey('anthropic', KEY);
      await f.b.saveSettings({mode: 'online'});
      const r = await f.b.cloudModels('anthropic');
      assert.equal(r.available, false);
      assert.deepEqual(r.models, []);
      assert.match(r.reason, pattern);
    } finally {
      await f.close();
    }
  }
});
