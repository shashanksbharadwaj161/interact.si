// Parallel integrations slice: provider families (Claude / ChatGPT / Spotify / browser / local model), honest method
// labels, stale and endpoint-changed check states, local Ollama error guidance, selected-model detection and strict
// loopback endpoint validation. Network, keys, prefs and confirmation are injected mocks; nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'parallel-integrations-entry.ts',
    loader: 'tsx',
    contents: `
      export * as catalog from './src/ui/integration-catalog.ts';
      export * as svc from './electron/services/integrations.ts';
      export * as ui from './src/components/Integrations.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
});
const { catalog, svc, ui, createElement, renderToStaticMarkup } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const OPENAI_KEY = 'sk-test-PARALLELPARALLELPARALLEL';
const tags = (...names) => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });

function harness(opts = {}) {
  const calls = [];
  const confirms = [];
  let mode = opts.mode ?? 'online';
  let t = opts.t0 ?? Date.parse('2026-10-15T10:00:00Z');
  let endpoint = opts.endpoint ?? 'http://127.0.0.1:11434';
  let model = opts.model;
  const keys = new Map(Object.entries(opts.keys ?? { openai: OPENAI_KEY }));
  const store = { data: { version: 1, enabled: { openai: true, anthropic: true } }, async load() { return this.data; }, async save(p) { this.data = p; } };
  const s = svc.createIntegrationService({
    fetch: async (url, init, purpose) => {
      calls.push({ url, purpose, headers: { ...(init.headers ?? {}) } });
      if (opts.throws) throw opts.throws;
      return opts.respond ? opts.respond(url) : tags('a:latest');
    },
    mode: () => mode,
    keys: { has: async (k) => keys.has(k), store: async (k, v) => void keys.set(k, v), remove: async (k) => void keys.delete(k), use: async (k, fn) => (keys.has(k) ? fn(keys.get(k)) : null) },
    confirm: async (summary, detail) => { confirms.push({ summary, detail }); return opts.confirm ?? true; },
    localEndpoint: () => endpoint,
    ...(opts.withModel ? { localModel: () => model } : {}),
    prefs: store,
    now: () => t,
    cooldownMs: 0,
    ...(opts.maxAge ? { checkMaxAgeMs: opts.maxAge } : {}),
  });
  return {
    s, calls, confirms, store,
    setMode: (m) => { mode = m; }, advance: (ms) => { t += ms; }, setEndpoint: (e) => { endpoint = e; }, setModel: (m) => { model = m; },
  };
}

// ---------- strict loopback endpoint validation ----------

test('checkLocalEndpoint accepts only plain http loopback addresses and returns the origin', () => {
  const ok = {
    'http://127.0.0.1:11434': 'http://127.0.0.1:11434',
    'http://127.0.0.1:11434/': 'http://127.0.0.1:11434',
    ' http://localhost:11500 ': 'http://localhost:11500',
    'http://[::1]:11434': 'http://[::1]:11434',
    'http://127.8.9.10:8080': 'http://127.8.9.10:8080',
  };
  for (const [raw, origin] of Object.entries(ok)) assert.deepEqual(svc.checkLocalEndpoint(raw), { ok: true, origin }, raw);

  const bad = [
    ['https://127.0.0.1:11434', /must use http/],
    ['http://192.168.1.20:11434', /loopback/],
    ['http://0.0.0.0:11434', /loopback/],
    ['http://127.0.0.1.evil.example:11434', /loopback/],
    ['http://localhost.evil.example', /loopback/],
    ['http://user:pw@127.0.0.1:11434', /user name or password/],
    ['http://127.0.0.1:11434/api/tags', /without a path/],
    ['http://127.0.0.1:11434?x=1', /without a path, query/],
    ['http://127.0.0.1:11434/#frag', /fragment/],
    ['http://127.0.0.1:11434\\@evil.example', /not a valid address/],
    ['http://127.0.0.1 :11434', /not a valid address/],
    ['file:///C:/x', /must use http/],
    ['javascript:alert(1)', /must use http/],
    ['', /empty/],
    [42, /empty/],
    ['http://' + 'a'.repeat(250), /not a valid address/],
  ];
  for (const [raw, re] of bad) {
    const v = svc.checkLocalEndpoint(raw);
    assert.equal(v.ok, false, String(raw));
    assert.match(v.reason, re, String(raw));
  }
});

test('an unsafe local endpoint blocks the local check before any request is made', async () => {
  for (const ep of ['http://10.0.0.5:11434', 'http://127.0.0.1:11434/api/chat', 'https://localhost:11434']) {
    const h = harness({ endpoint: ep });
    const p = await h.s.preview('ollama');
    assert.equal(p.allowed, false, ep);
    assert.equal(p.destination, 'None');
    const r = await h.s.check('ollama');
    assert.equal(r.ok, false);
    assert.equal(h.calls.length, 0, `nothing sent for ${ep}`);
  }
  const throwing = svc.createIntegrationService({ fetch: async () => { throw new Error('must not run'); }, mode: () => 'offline', keys: { has: async () => false, store: async () => {}, remove: async () => {}, use: async () => null }, localEndpoint: () => { throw new Error('settings broken'); } });
  assert.match((await throwing.preview('ollama')).reason, /could not be read from Settings/);
});

// ---------- local model check: error guidance and selected-model detection ----------

test('a refused local connection says Ollama is not running, not that the internet is down', async () => {
  const h = harness({ mode: 'offline', throws: Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }) });
  const r = await h.s.check('ollama');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Ollama is not answering at http://127.0.0.1:11434');
  assert.match(r.hint, /ollama serve/);
  assert.doesNotMatch(r.hint, /internet|VPN/);
  assert.equal(h.confirms.length, 0, 'loopback check needs no cloud confirmation');
  assert.equal((await h.s.view('ollama')).state, 'check-failed');

  const slow = await harness({ mode: 'offline', throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) }).s.check('ollama');
  assert.match(slow.hint, /starting or loading a model/);

  const cloud = await harness({ throws: new TypeError('fetch failed') }).s.check('openai');
  assert.match(cloud.hint, /internet connection/, 'provider APIs keep the network hint');
});

test('the local check reports whether the model selected in Settings is installed', async () => {
  const h = harness({ mode: 'offline', withModel: true, model: 'qwen3.5:2b', respond: () => tags('qwen3.5:2b', 'llama3:latest') });
  assert.equal((await h.s.check('ollama')).detail, 'Ollama answered with 2 installed models; your selected model "qwen3.5:2b" is installed');

  h.setModel('llama3');
  h.advance(10);
  assert.match((await h.s.check('ollama')).detail, /selected model "llama3" is installed/, 'bare name matches :latest');

  h.setModel('mistral:7b');
  h.advance(10);
  const missing = await h.s.check('ollama');
  assert.equal(missing.ok, true, 'Ollama itself answered');
  assert.match(missing.detail, /"mistral:7b" is not installed\. Pull it with Ollama or choose an installed model in Settings/);

  const none = await harness({ mode: 'offline', withModel: true, model: 'x', respond: () => tags() }).s.check('ollama');
  assert.equal(none.detail, 'Ollama answered, but no models are installed');
});

test('the local model list is parsed defensively', async () => {
  assert.deepEqual(svc.parseLocalModels({ models: [{ name: 'a:1' }, { model: 'b' }, { name: 'bad\u0007name' }, { name: 5 }, null, { name: 'x'.repeat(201) }] }), ['a:1', 'b']);
  assert.equal(svc.parseLocalModels({ nope: [] }), null);
  assert.equal(svc.parseLocalModels(null), null);
  assert.equal(svc.localModelInstalled(['Llama3:Latest'], 'llama3'), true);
  assert.equal(svc.localModelInstalled(['llama3:8b'], 'llama3'), false, 'a different tag is not the default tag');
  assert.equal(svc.localModelInstalled(['a'], '  '), false);

  const huge = harness({ mode: 'offline', respond: () => new Response(JSON.stringify({ models: [{ name: 'a' }], pad: 'x'.repeat(1_100_000) })) });
  assert.equal((await huge.s.check('ollama')).detail, 'Ollama answered, but the model list could not be read');
  const junk = harness({ mode: 'offline', respond: () => new Response('<html>not ollama</html>') });
  assert.equal((await junk.s.check('ollama')).detail, 'Ollama answered, but the model list could not be read');
});

// ---------- stale states ----------

test('a passed check goes stale after the maximum age and never stays "connected" forever', async () => {
  const h = harness({ maxAge: 60_000 });
  assert.equal((await h.s.check('openai')).ok, true);
  assert.equal((await h.s.view('openai')).state, 'connected');
  h.advance(59_000);
  assert.equal((await h.s.view('openai')).state, 'connected');
  h.advance(2_000);
  const stale = await h.s.view('openai');
  assert.equal(stale.state, 'ready-to-check');
  assert.equal(stale.lastCheck.ok, true, 'the old result stays visible as history');
  assert.match(ui.stateText(catalog.findIntegration('openai'), stale, 'online').text, /out of date/);
  await h.s.check('openai');
  assert.equal((await h.s.view('openai')).state, 'connected');

  const def = harness();
  await def.s.check('openai');
  def.advance(30 * 60_000 + 1);
  assert.equal((await def.s.view('openai')).state, 'ready-to-check', 'default maximum age is 30 minutes');
});

test('changing the local endpoint makes the earlier result stale and the next check uses the new address', async () => {
  const h = harness({ mode: 'offline' });
  await h.s.check('ollama');
  assert.equal((await h.s.view('ollama')).state, 'connected');
  h.setEndpoint('http://127.0.0.1:11435');
  assert.equal((await h.s.view('ollama')).state, 'ready-to-check');
  h.setEndpoint('http://127.0.0.1:11434');
  assert.equal((await h.s.view('ollama')).state, 'connected', 'same address again is current');
  h.setEndpoint('http://127.0.0.1:11435');
  await h.s.check('ollama');
  assert.equal(h.calls.at(-1).url, 'http://127.0.0.1:11435/api/tags');
  assert.equal((await h.s.view('ollama')).state, 'connected');
});

// ---------- offline default, consent and no automatic cloud calls ----------

test('listing, viewing and previewing never send a request or ask for confirmation', async () => {
  for (const mode of ['offline', 'online']) {
    const h = harness({ mode });
    await h.s.list();
    for (const d of catalog.INTEGRATIONS) { await h.s.view(d.id); await h.s.preview(d.id); }
    assert.equal(h.calls.length, 0, mode);
    assert.equal(h.confirms.length, 0, mode);
  }
});

test('offline mode blocks provider APIs without asking, while the loopback check still works', async () => {
  const h = harness({ mode: 'offline' });
  for (const id of ['openai', 'anthropic']) {
    assert.equal((await h.s.view(id)).state, 'offline');
    assert.match((await h.s.check(id)).reason, /Offline mode/);
  }
  assert.equal(h.confirms.length, 0);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.s.check('ollama')).ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].purpose, 'ollama');
});

test('a declined trusted confirmation sends nothing and does not mark the provider connected', async () => {
  const h = harness({ confirm: false });
  const r = await h.s.check('openai');
  assert.equal(r.ok, false);
  assert.match(r.reason, /confirmation declined/);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.s.view('openai')).state, 'ready-to-check');
  assert.match(h.confirms[0].detail, /Destination: https:\/\/api\.openai\.com\/v1\/models/);
  assert.doesNotMatch(h.confirms[0].detail, new RegExp(OPENAI_KEY));
});

test('website handoffs and setup-required connectors can never be checked or reach "connected"', async () => {
  const h = harness();
  for (const id of ['claude-web', 'chatgpt-web', 'spotify-web', 'browser', 'spotify-api']) {
    const r = await h.s.check(id);
    assert.equal(r.ok, false, id);
    assert.notEqual((await h.s.view(id)).state, 'connected', id);
  }
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.s.setEnabled('spotify-api', true), /cannot be turned on/);
  await assert.rejects(h.s.setKey('spotify-web', 'sk-whatever-0000000000000000'), /does not take a key/);
});

// ---------- renderer: families and honest method labels ----------

test('every requested provider family is present and each method is labelled separately', () => {
  const by = (id) => catalog.findIntegration(id);
  assert.equal(ui.familyOf(by('anthropic')), 'claude');
  assert.equal(ui.familyOf(by('claude-web')), 'claude');
  assert.equal(ui.familyOf(by('openai')), 'chatgpt');
  assert.equal(ui.familyOf(by('chatgpt-web')), 'chatgpt');
  assert.equal(ui.familyOf(by('spotify-web')), 'spotify');
  assert.equal(ui.familyOf(by('spotify-api')), 'spotify');
  assert.equal(ui.familyOf(by('browser')), 'browser');
  assert.equal(ui.familyOf(by('ollama')), 'local');
  assert.equal(ui.familyOf(by('weather')), 'other');

  assert.equal(ui.methodOf(by('anthropic')), 'provider-api');
  assert.equal(ui.methodOf(by('claude-web')), 'website');
  assert.equal(ui.methodOf(by('spotify-api')), 'unavailable');
  assert.equal(ui.methodOf(by('ollama')), 'on-device');

  const spotify = ui.familyRows('spotify', {}, 'online');
  assert.deepEqual(spotify.map((r) => r.method).sort(), ['app-launch', 'unavailable', 'website']);
  assert.match(spotify.find((r) => r.method === 'app-launch').text, /Approved apps.*Not an account connection/);
  assert.match(spotify.find((r) => r.method === 'website').text, /Not an API or account connection/);

  assert.deepEqual(ui.familyRows('claude', {}, 'online').map((r) => r.method).sort(), ['provider-api', 'website']);
  assert.deepEqual(ui.familyRows('chatgpt', {}, 'online').map((r) => r.method).sort(), ['provider-api', 'website']);
  for (const f of ui.FAMILY_ORDER.filter((x) => x !== 'other')) for (const r of ui.familyRows(f, {}, 'offline')) assert.notEqual(r.tone, 'ok', `${r.id} is not "ready" without a backend view`);
});

test('a website row never reads as connected, even if a bad view claims it', () => {
  const lying = { 'claude-web': { id: 'claude-web', state: 'connected', keyConfigured: true, enabled: true, choiceStorage: 'saved', lastCheck: { id: 'claude-web', ok: true, at: new Date().toISOString() } } };
  const row = ui.familyRows('claude', lying, 'online').find((r) => r.id === 'claude-web');
  assert.equal(row.tone, 'info');
  assert.doesNotMatch(row.text, /\bconnected\b|passed/i);
  assert.match(row.text, /Not an API or account connection/);
});

test('offline and stale states read honestly in the overview', () => {
  const views = {
    openai: { id: 'openai', state: 'offline', keyConfigured: true, enabled: true, choiceStorage: 'saved' },
    anthropic: { id: 'anthropic', state: 'ready-to-check', keyConfigured: true, enabled: true, choiceStorage: 'saved', lastCheck: { id: 'anthropic', ok: true, at: '2026-10-15T09:00:00Z' } },
  };
  assert.match(ui.familyRows('chatgpt', views, 'offline').find((r) => r.id === 'openai').text, /Needs online mode\. Nothing is sent/);
  const claude = ui.familyRows('claude', views, 'online').find((r) => r.id === 'anthropic');
  assert.equal(claude.tone, 'warn');
  assert.match(claude.text, /out of date/);
});

test('the family filter narrows cards and combines with the method filter', () => {
  assert.deepEqual(ui.filterIntegrations('all', catalog.INTEGRATIONS, 'spotify').map((d) => d.id).sort(), ['spotify-api', 'spotify-web']);
  assert.deepEqual(ui.filterIntegrations('websites', catalog.INTEGRATIONS, 'spotify').map((d) => d.id), ['spotify-web']);
  assert.deepEqual(ui.filterIntegrations('api', catalog.INTEGRATIONS, 'claude').map((d) => d.id), ['anthropic']);
  assert.equal(ui.filterIntegrations('all').length, catalog.INTEGRATIONS.length, 'default stays unfiltered');
});

test('the panel renders the provider overview, family filter and a Spotify app-launch route without claiming a connection', () => {
  const html = renderToStaticMarkup(createElement(ui.IntegrationsPanel, { mode: 'offline', previewAction: async () => { throw new Error('not called'); }, executeAction: async () => ({}), notify: () => {} }));
  assert.match(html, /Providers at a glance/);
  for (const label of ['Claude', 'ChatGPT', 'Spotify', 'Browser', 'Legacy local model']) assert.match(html, new RegExp(`aria-label="${label} connection methods"`));
  assert.match(html, /Start the Spotify app/);
  assert.match(html, /does not sign in or connect an account/);
  assert.match(html, /App launch/);
  assert.match(html, /Provider API/);
  assert.doesNotMatch(html, /Connection check passed/);
  assert.doesNotMatch(html, /Refresh status/, 'no refresh control when no backend is wired');
});
