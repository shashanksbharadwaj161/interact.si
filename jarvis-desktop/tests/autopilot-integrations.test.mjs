// Integrations module tests: catalog honesty, guarded connection checks, key handling, DPAPI vault, renderer panel.
// Bundles the real TypeScript in memory. Network, DPAPI, filesystem and confirmation are all injected mocks;
// no request leaves this machine and no account is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'integrations-test-entry.ts',
    loader: 'tsx',
    contents: `
      export * as catalog from './src/ui/integration-catalog.ts';
      export * as svc from './electron/services/integrations.ts';
      export * as netGuard from './electron/services/netGuard.ts';
      export * as validation from './electron/services/validation.ts';
      export * as sidecar from './electron/services/sidecar.ts';
      export * as ui from './src/components/Integrations.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  logLevel: 'silent',
  // react-dom/server requires Node built-ins dynamically; give the in-memory ESM bundle a real require.
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { catalog, svc, netGuard, validation, sidecar, ui, createElement, renderToStaticMarkup } = mod;

const ANTHROPIC_KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
const OPENAI_KEY = 'sk-test-ZZZZZZZZZZZZZZZZZZZZZZZZ';

// ---------- helpers ----------

function memKeys(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    m,
    has: async (s) => m.has(s),
    store: async (s, k) => void m.set(s, k),
    remove: async (s) => void m.delete(s),
    use: async (s, fn) => (m.has(s) ? fn(m.get(s)) : null),
  };
}

function harness(opts = {}) {
  const calls = [];
  const confirms = [];
  const audits = [];
  let mode = opts.mode ?? 'online';
  let t = 1_700_000_000_000;
  const respond = opts.respond ?? (() => new Response('{"data":[]}', { status: 200 }));
  const keys = opts.keys ?? memKeys(opts.storedKeys ?? {});
  const saved = [];
  // Default: every provider item turned on, so tests below exercise the later gates. Opt-in has its own tests.
  const allOn = { version: 1, enabled: Object.fromEntries(catalog.INTEGRATIONS.filter(catalog.needsOptIn).map((d) => [d.id, true])) };
  const prefsData = 'prefsData' in opts ? opts.prefsData : allOn;
  const keyChanges = [];
  const s = svc.createIntegrationService({
    fetch: opts.fetch ?? (async (url, init, purpose) => { calls.push({ url, init, purpose }); return respond(url, init, purpose); }),
    mode: () => mode,
    keys,
    confirm: 'confirm' in opts ? opts.confirm : async (summary, detail) => { confirms.push({ summary, detail }); return opts.approve ?? true; },
    localEndpoint: opts.localEndpoint,
    audit: (line) => audits.push(line),
    now: () => t,
    prefs: 'prefs' in opts ? opts.prefs : { load: async () => prefsData, save: async (p) => { if (opts.failSave) throw new Error('disk full'); saved.push(p); } },
    onKeyChange: (slot) => keyChanges.push(slot),
    cooldownMs: opts.cooldownMs ?? 0,
  });
  return { s, calls, confirms, audits, keys, saved, keyChanges, setMode: (m) => { mode = m; }, tick: (ms) => { t += ms; } };
}

const assertNoKey = (value, ...keys) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const k of keys) assert.ok(!text.includes(k), `secret leaked into: ${text.slice(0, 200)}`);
};

// ---------- catalog ----------

test('catalog covers roadmap 101–110 and the requested Spotify, browser, ChatGPT and Claude items', () => {
  const ids = catalog.INTEGRATIONS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (let n = 101; n <= 110; n++) assert.ok(catalog.INTEGRATIONS.some((d) => d.scope === n), `scope ${n} has a definition`);
  for (const id of ['spotify-web', 'spotify-api', 'browser', 'chatgpt-web', 'openai', 'claude-web', 'anthropic']) assert.ok(catalog.findIntegration(id), id);
});

test('catalog never presents a website handoff or an unbuilt item as an API integration', () => {
  for (const d of catalog.INTEGRATIONS) {
    if (d.availability === 'handoff') {
      assert.equal(d.check, undefined, `${d.id} handoff has no API check`);
      assert.equal(d.key, undefined, `${d.id} handoff takes no key`);
      assert.match(d.notThis ?? d.summary, /not an integration|not read|after (you )?approv/i, `${d.id} says what it is not`);
      if (d.handoff) assert.ok(d.handoff.url.startsWith('https://'));
    }
    if (['gated', 'setup-required', 'not-built'].includes(d.availability)) {
      assert.ok(d.blockers.length > 0, `${d.id} lists blockers`);
      assert.equal(catalog.isCheckable(d), false, `${d.id} cannot run a check`);
    }
    if (d.availability === 'byok') {
      assert.ok(d.key && d.check, `${d.id} has key and check`);
      assert.ok(d.check.origin.startsWith('https://') && d.check.online, `${d.id} is https and online-only`);
      assert.ok(d.dataLeaves.some((x) => /key|token/i.test(x)), `${d.id} discloses that the key leaves`);
    }
  }
  assert.equal(catalog.findIntegration('spotify-api').availability, 'setup-required');
  assert.equal(catalog.findIntegration('sync').availability, 'gated');
  assert.equal(catalog.findIntegration('marketplace').availability, 'gated');
  assert.match(catalog.findIntegration('openai').notThis, /subscription is not an API key/);
});

test('egressRequirements lists exactly the origins the API owner must allow, excluding gated items', () => {
  const req = catalog.egressRequirements();
  const byId = Object.fromEntries(req.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(byId).sort(), ['anthropic', 'issue-post', 'ollama', 'openai', 'weather']);
  assert.equal(byId.openai.origin, 'https://api.openai.com');
  assert.equal(byId.openai.purpose, 'provider-check');
  assert.equal(byId.ollama.purpose, 'ollama');
  assert.equal(byId.ollama.online, false);
  assert.equal(byId.weather.key, false);
});

test('handoffAction builds an approved open-url request and rejects unsafe links', () => {
  assert.deepEqual(catalog.handoffAction(catalog.findIntegration('claude-web')), { ok: true, action: { type: 'open-url', target: 'https://claude.ai/' } });
  assert.deepEqual(catalog.handoffAction(catalog.findIntegration('spotify-web')).action.target, 'https://open.spotify.com/');
  const browser = catalog.findIntegration('browser');
  assert.equal(catalog.handoffAction(browser, 'http://example.com/a b').ok, false);
  for (const bad of ['javascript:alert(1)', 'file:///C:/Windows', 'https://user:pw@example.com/', '', 'ftp://x.test/', 'https://ex\u0000ample.com']) {
    assert.equal(catalog.handoffAction(browser, bad).ok, false, bad);
  }
  assert.equal(catalog.handoffAction(browser, 'https://example.com/path?q=1').action.target, 'https://example.com/path?q=1');
  assert.equal(catalog.handoffAction(catalog.findIntegration('openai')).ok, false, 'API item is not a handoff');
});

test('formatIssueDraft formats locally and requires a title', () => {
  const md = catalog.formatIssueDraft({ title: 'Crash\non start', body: 'It crashes.', steps: ['Open app', ' ', 'Click X'], labels: ['bug', 'bug', 'ui'] });
  assert.match(md, /^# Crash on start\n/);
  assert.match(md, /## Steps to reproduce\n\n1\. Open app\n2\. Click X/);
  assert.match(md, /Labels: bug, ui\n$/);
  assert.throws(() => catalog.formatIssueDraft({ title: '  ' }), /needs a title/);
});

// ---------- service: mode, keys, confirmation ----------

test('offline mode blocks provider checks before confirmation or fetch', async () => {
  const h = harness({ mode: 'offline', storedKeys: { anthropic: ANTHROPIC_KEY } });
  const r = await h.s.check('anthropic');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Offline mode/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0);
  assert.equal((await h.s.view('anthropic')).state, 'offline');
});

test('local model check works offline over loopback, needs no confirmation, and reports the model count', async () => {
  const h = harness({ mode: 'offline', localEndpoint: () => 'http://127.0.0.1:11435', respond: () => new Response(JSON.stringify({ models: [{ name: 'a' }, { name: 'b' }] }), { status: 200 }) });
  const r = await h.s.check('ollama');
  assert.equal(r.ok, true);
  assert.equal(r.detail, 'Ollama answered with 2 installed models');
  assert.deepEqual(h.calls.map((c) => [c.url, c.purpose]), [['http://127.0.0.1:11435/api/tags', 'ollama']]);
  assert.equal(h.confirms.length, 0);
  assert.equal((await h.s.view('ollama')).state, 'connected');
});

test('local model check refuses a non-loopback endpoint without any request', async () => {
  for (const ep of ['http://192.168.1.5:11434', 'https://127.0.0.1:11434', 'http://evil.test', 'not a url']) {
    const h = harness({ localEndpoint: () => ep });
    const r = await h.s.check('ollama');
    assert.equal(r.ok, false, ep);
    assert.equal(h.calls.length, 0, ep);
  }
});

test('online check without a key reports needs-key and sends nothing', async () => {
  const h = harness();
  assert.equal((await h.s.view('openai')).state, 'needs-key');
  const r = await h.s.check('openai');
  assert.match(r.reason, /Add your OpenAI API key/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0);
});

test('declined or missing trusted confirmation sends nothing', async () => {
  const declined = harness({ storedKeys: { anthropic: ANTHROPIC_KEY }, approve: false });
  assert.match((await declined.s.check('anthropic')).reason, /confirmation declined/);
  assert.equal(declined.calls.length, 0);
  assert.equal(declined.confirms.length, 1);

  const missing = harness({ storedKeys: { anthropic: ANTHROPIC_KEY }, confirm: undefined });
  assert.match((await missing.s.check('anthropic')).reason, /confirmation declined or unavailable/);
  assert.equal(missing.calls.length, 0);

  const throwing = harness({ storedKeys: { anthropic: ANTHROPIC_KEY }, confirm: async () => { throw new Error('dialog failed'); } });
  assert.equal((await throwing.s.check('anthropic')).ok, false);
  assert.equal(throwing.calls.length, 0);
});

test('approved Anthropic check sends one request with the key header and never exposes the key', async () => {
  const h = harness({ storedKeys: { anthropic: ANTHROPIC_KEY } });
  const r = await h.s.check('anthropic');
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(h.calls.length, 1);
  const [c] = h.calls;
  assert.equal(c.url, 'https://api.anthropic.com/v1/models');
  assert.equal(c.purpose, 'provider-check');
  assert.equal(c.init.method, 'GET');
  assert.equal(c.init.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.init.body, undefined, 'no content is sent');
  assert.match(h.confirms[0].summary, /Send a connection check to Anthropic\?/);
  assert.match(h.confirms[0].detail, /Destination: https:\/\/api\.anthropic\.com\/v1\/models/);
  assert.match(h.confirms[0].detail, /x-api-key/);
  assertNoKey(h.confirms, ANTHROPIC_KEY);
  assertNoKey(r, ANTHROPIC_KEY);
  assertNoKey(await h.s.list(), ANTHROPIC_KEY);
  assertNoKey(await h.s.usage(), ANTHROPIC_KEY);
  assertNoKey(await h.s.preview('anthropic'), ANTHROPIC_KEY);
  assertNoKey(h.audits, ANTHROPIC_KEY);
  assert.equal((await h.s.view('anthropic')).state, 'connected');
});

test('OpenAI check uses a bearer header and maps a rejected key honestly', async () => {
  const h = harness({ storedKeys: { openai: OPENAI_KEY }, respond: () => new Response('{"error":{"message":"bad key ' + OPENAI_KEY + '"}}', { status: 401 }) });
  const r = await h.s.check('openai');
  assert.equal(h.calls[0].init.headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.reason, 'OpenAI rejected the key');
  assertNoKey(r, OPENAI_KEY);
  assertNoKey(await h.s.usage(), OPENAI_KEY);
  assert.equal((await h.s.view('openai')).state, 'check-failed');
});

test('status mapping covers rate limits, server errors and unknown codes', () => {
  const d = catalog.findIntegration('openai');
  assert.equal(svc.describeStatus(d, 204).ok, true);
  assert.match(svc.describeStatus(d, 429).reason, /rate limiting/);
  assert.match(svc.describeStatus(d, 503).reason, /server error/);
  assert.match(svc.describeStatus(d, 418).reason, /HTTP 418/);
  assert.match(svc.describeStatus(catalog.findIntegration('weather'), 403).reason, /refused the request/);
});

/**
 * Self-contained model of a guard: online mode only, GET only, exact origin+path allow-list for 'provider-check',
 * loopback for 'ollama'. It does not import the real netGuard policy, so these tests do not depend on its version.
 * Denials throw netGuard's NetworkDenied class, which is the error type the service recognises.
 */
function fakeGuard({ mode = () => 'online', allow = ['https://api.anthropic.com/v1/models', 'https://api.openai.com/v1/models', 'https://api.github.com/user', 'https://api.open-meteo.com/v1/forecast'] } = {}) {
  const attempts = [];
  const sent = [];
  const guard = async (url, init, purpose) => {
    const u = new URL(url);
    attempts.push({ url, purpose, method: init.method });
    const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    let reason = null;
    if (purpose === 'ollama') reason = loopback ? null : 'Loopback is only for the local model';
    else if (purpose !== 'provider-check') reason = 'Unknown purpose';
    else if (mode() !== 'online') reason = 'Offline mode: cloud requests are blocked';
    else if (init.method !== 'GET') reason = 'Provider checks are GET only';
    else if (!allow.includes(u.origin + u.pathname)) reason = 'Destination is not on the allow list';
    if (reason) throw new netGuard.NetworkDenied(reason);
    sent.push({ url, origin: u.origin, path: u.pathname, init, purpose });
    return new Response('{}', { status: 200 });
  };
  return { guard, attempts, sent };
}

test('offline mode or a missing key never reaches the fetch, even through a guard model', async () => {
  const g = fakeGuard({ mode: () => 'offline' });
  const off = harness({ mode: 'offline', fetch: g.guard, storedKeys: { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY, github: 'github_pat_0123456789abcdefghij' } });
  for (const id of ['anthropic', 'openai', 'issue-post', 'weather']) assert.equal((await off.s.check(id)).ok, false, id);
  assert.equal(g.attempts.length, 0, 'offline: fetch never called');
  assert.equal(off.confirms.length, 0, 'offline: no dialog');

  const g2 = fakeGuard();
  const noKey = harness({ fetch: g2.guard });
  for (const id of ['anthropic', 'openai', 'issue-post']) assert.match((await noKey.s.check(id)).reason, /^Add your /, id);
  assert.equal(g2.attempts.length, 0, 'no key: fetch never called');
  assert.equal(noKey.confirms.length, 0, 'no key: no dialog');
});

test('with trusted confirmation in online mode, each provider check goes to its exact origin and path', async () => {
  const g = fakeGuard();
  const GH = 'github_pat_0123456789abcdefghij';
  const h = harness({ fetch: g.guard, storedKeys: { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY, github: GH } });
  const expected = {
    anthropic: ['https://api.anthropic.com', '/v1/models', 'x-api-key', ANTHROPIC_KEY],
    openai: ['https://api.openai.com', '/v1/models', 'authorization', `Bearer ${OPENAI_KEY}`],
    'issue-post': ['https://api.github.com', '/user', 'authorization', `Bearer ${GH}`],
    weather: ['https://api.open-meteo.com', '/v1/forecast', null, null],
  };
  for (const [id, [origin, p, header, value]] of Object.entries(expected)) {
    const before = h.confirms.length;
    const r = await h.s.check(id);
    assert.equal(r.ok, true, `${id}: ${r.reason}`);
    assert.equal(h.confirms.length, before + 1, `${id} asked the trusted dialog once`);
    const s = g.sent.at(-1);
    assert.deepEqual([s.origin, s.path, s.purpose, s.init.method, s.init.body], [origin, p, 'provider-check', 'GET', undefined], id);
    if (header) assert.equal(s.init.headers[header], value, `${id} key header`);
    else assert.ok(!('authorization' in s.init.headers) && !('x-api-key' in s.init.headers), `${id} sends no credential header`);
  }
  assert.equal(g.sent.length, 4);
  assertNoKey([await h.s.usage(), h.audits, h.confirms], ANTHROPIC_KEY, OPENAI_KEY, GH);
});

test('a guard denial is reported as blocked and nothing is sent', async () => {
  const g = fakeGuard({ allow: [] });
  const h = harness({ fetch: g.guard, storedKeys: { openai: OPENAI_KEY } });
  const r = await h.s.check('openai');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Blocked by the network guard: Destination is not on the allow list');
  assert.equal(g.attempts.length, 1);
  assert.equal(g.sent.length, 0);
  assertNoKey([r, await h.s.usage()], OPENAI_KEY);
});

test('transport errors become fixed reasons, never the raw error text', async () => {
  const h = harness({ storedKeys: { openai: OPENAI_KEY }, fetch: async () => { throw new TypeError(`fetch failed for header ${OPENAI_KEY}`); } });
  const r = await h.s.check('openai');
  assert.equal(r.reason, 'Could not reach OpenAI');
  assertNoKey([r, await h.s.usage(), h.audits], OPENAI_KEY);
  const t = harness({ storedKeys: { openai: OPENAI_KEY }, fetch: async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); } });
  assert.equal((await t.s.check('openai')).reason, 'OpenAI did not answer in time');
});

test('handoff, gated, setup-required and not-built items never fetch', async () => {
  const h = harness();
  for (const id of ['claude-web', 'chatgpt-web', 'spotify-web', 'browser', 'spotify-api', 'calendar', 'web-research', 'sync', 'marketplace', 'downloads', 'issue-draft']) {
    const r = await h.s.check(id);
    assert.equal(r.ok, false, id);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0);
  const states = Object.fromEntries((await h.s.list()).map((v) => [v.id, v.state]));
  assert.equal(states['claude-web'], 'handoff');
  assert.equal(states['spotify-api'], 'setup-required');
  assert.equal(states.sync, 'gated');
  assert.equal(states['web-research'], 'not-built');
  assert.equal(states['data-preview'], 'local-ready');
  assert.ok(!Object.values(states).includes('connected'), 'nothing is connected before a check');
});

test('preview describes what leaves without sending anything', async () => {
  const h = harness({ storedKeys: { openai: OPENAI_KEY } });
  const p = await h.s.preview('openai');
  assert.equal(p.allowed, true);
  assert.equal(p.destination, 'https://api.openai.com');
  assert.equal(p.path, '/v1/models');
  assert.deepEqual(p.headerNames, ['authorization']);
  assert.equal(p.keySent, true);
  assert.match(p.response, /body is discarded/);
  assert.equal(h.calls.length, 0);
  h.setMode('offline');
  const off = await h.s.preview('openai');
  assert.equal(off.allowed, false);
  assert.match(off.reason, /Offline/);
  const w = await h.s.preview('weather');
  assert.equal(w.path, '/v1/forecast', 'query string is not mistaken for a secret but kept out of the summary');
  assert.equal((await h.s.preview('claude-web')).destination, 'https://claude.ai');
  assert.equal((await h.s.preview('sync')).allowed, false);
});

test('cooldown and in-flight guard prevent repeated requests', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ cooldownMs: 2000, mode: 'offline', respond: async () => { await gate; return new Response('{"models":[]}', { status: 200 }); } });
  const first = h.s.check('ollama');
  await new Promise((r) => setImmediate(r));
  assert.match((await h.s.check('ollama')).reason, /already running/);
  release();
  assert.equal((await first).detail, 'Ollama answered, but no models are installed');
  assert.match((await h.s.check('ollama')).reason, /Wait a moment/);
  h.tick(2001);
  assert.equal((await h.s.check('ollama')).ok, true);
  assert.equal(h.calls.length, 2);
});

test('invalid ids are rejected as validation errors', async () => {
  const h = harness();
  for (const bad of ['', 'NOPE', '../x', 42, null, 'unknown-thing']) {
    await assert.rejects(h.s.check(bad), validation.ValidationError, String(bad));
  }
});

// ---------- keys ----------

test('setKey needs trusted confirmation, validates, warns on unusual format, and never echoes the key', async () => {
  const declined = harness({ approve: false });
  await assert.rejects(declined.s.setKey('openai', OPENAI_KEY), /confirmation declined/);
  assert.equal(declined.keys.m.size, 0);

  const h = harness();
  await assert.rejects(h.s.setKey('openai', 'short'), validation.ValidationError);
  await assert.rejects(h.s.setKey('claude-web', OPENAI_KEY), /does not take a key/);
  await assert.rejects(h.s.setKey('sync', OPENAI_KEY), /does not take a key/);
  assert.equal(h.confirms.length, 0, 'invalid input never reaches the dialog');

  const r = await h.s.setKey('openai', `  ${OPENAI_KEY}  `);
  assert.deepEqual(r, { configured: true });
  assert.equal(h.keys.m.get('openai'), OPENAI_KEY);
  assertNoKey([h.confirms, h.audits, r], OPENAI_KEY);
  assert.match(h.confirms[0].detail, /sent only to https:\/\/api\.openai\.com/);

  const odd = await h.s.setKey('anthropic', 'zzzz-not-anthropic-format-1234567890');
  assert.match(odd.warning, /usually start with sk-ant-/);

  assert.deepEqual(await h.s.removeKey('openai'), { configured: false });
  assert.equal(h.keys.m.has('openai'), false);
  assert.equal((await h.s.view('openai')).state, 'needs-key');
});

// ---------- prefs ----------

test('enable preferences persist, refuse items that never contact a provider, and survive a failed save', async () => {
  const h = harness({ prefsData: { enabled: { anthropic: true, sync: true, marketplace: true, ollama: true, 'claude-web': true, bogus: true } } });
  const list = Object.fromEntries((await h.s.list()).map((v) => [v.id, v.enabled]));
  assert.equal(list.anthropic, true);
  assert.equal(list.sync, false, 'gated item loaded as enabled is dropped');
  assert.equal(list.ollama, false, 'local item has no opt-in');
  assert.equal(list['claude-web'], false, 'handoff uses action approval, not an opt-in');
  await assert.rejects(h.s.setEnabled('sync', true), /cannot be turned on/);
  await assert.rejects(h.s.setEnabled('ollama', true), /cannot be turned on/);
  await assert.rejects(h.s.setEnabled('chatgpt-web', true), /cannot be turned on/);
  await assert.rejects(h.s.setEnabled('anthropic', 'yes'), validation.ValidationError);
  const v = await h.s.setEnabled('openai', true);
  assert.equal(v.enabled, true);
  assert.equal(v.choiceStorage, 'saved');
  assert.deepEqual(h.saved.at(-1), { version: 1, enabled: { anthropic: true, openai: true } });

  const f = harness({ failSave: true, prefsData: null });
  await assert.rejects(f.s.setEnabled('openai', true), /disk full/);
  assert.equal((await f.s.view('openai')).enabled, false);
  assert.equal((await f.s.view('openai')).state, 'turned-off');
  assert.deepEqual(svc.sanitizePrefs('garbage'), { version: 1, enabled: {} });
});

test('a provider item that is turned off sends nothing and asks nothing, even online with a key', async () => {
  const h = harness({ prefsData: null, storedKeys: { openai: OPENAI_KEY } });
  const v = await h.s.view('openai');
  assert.deepEqual([v.state, v.enabled], ['turned-off', false]);
  const p = await h.s.preview('openai');
  assert.equal(p.allowed, false);
  assert.match(p.reason, /^Turn on OpenAI API/);
  for (const id of ['openai', 'weather']) assert.match((await h.s.check(id)).reason, /^Turn on /, id);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirms.length, 0);
  // The local model check needs no opt-in.
  assert.equal((await harness({ prefsData: null, mode: 'offline', respond: () => new Response('{"models":[]}') }).s.check('ollama')).ok, true);

  await h.s.setEnabled('openai', true);
  assert.equal((await h.s.check('openai')).ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.s.view('openai')).state, 'connected');
  await h.s.setEnabled('openai', false);
  const off = await h.s.view('openai');
  assert.deepEqual([off.state, off.lastCheck], ['turned-off', undefined], 'turning off forgets the last result');
  assert.deepEqual(h.saved.at(-1), { version: 1, enabled: {} });
  assert.ok(h.audits.includes('Turned on: OpenAI API (ChatGPT models)') && h.audits.some((a) => a.startsWith('Turned off: ')));
});

test('without a durable store nothing can be turned on and nothing is kept only in memory', async () => {
  const h = harness({ prefs: undefined, storedKeys: { openai: OPENAI_KEY } });
  const v = await h.s.view('openai');
  assert.deepEqual([v.choiceStorage, v.enabled, v.state], ['not-connected', false, 'turned-off']);
  await assert.rejects(h.s.setEnabled('openai', true), /cannot be saved in this build/);
  assert.equal((await h.s.view('openai')).enabled, false);
  assert.match((await h.s.check('openai')).reason, /^Turn on /);
  assert.equal(h.calls.length, 0);
});

test('an unreadable store keeps everything off and is never overwritten', async () => {
  let fail = true;
  let loads = 0;
  const saves = [];
  const store = { load: async () => { loads++; if (fail) throw new Error('EACCES'); return { version: 1, enabled: { weather: true } }; }, save: async (p) => void saves.push(p) };
  const h = harness({ prefs: store });
  await h.s.list();
  assert.equal(loads, 1, 'one shared read for the whole list');
  const v = await h.s.view('weather');
  assert.deepEqual([v.choiceStorage, v.enabled, v.state], ['unreadable', false, 'turned-off']);
  await assert.rejects(h.s.setEnabled('openai', true), /could not be read; nothing was changed/);
  assert.equal(saves.length, 0, 'saved choices were not clobbered');
  fail = false;
  const ok = await h.s.setEnabled('openai', true);
  assert.equal(ok.choiceStorage, 'saved');
  assert.deepEqual(saves, [{ version: 1, enabled: { weather: true, openai: true } }], 'recovered choices are kept');
});

test('quick toggles are saved in order and none is lost', async () => {
  const saves = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const store = { load: async () => null, save: async (p) => { if (!saves.length) await gate; saves.push(p); } };
  const h = harness({ prefs: store });
  const a = h.s.setEnabled('openai', true);
  const b = h.s.setEnabled('weather', true);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(saves.at(-1), { version: 1, enabled: { openai: true, weather: true } });
});

test('the real JSON sidecar is a working preference store across restarts', async () => {
  const files = new Map();
  const fs = { readFile: async (f) => files.get(f) ?? null, writeFile: async (f, d) => void files.set(f, d) };
  const dir = path.join('C:', 'fake-userdata');
  const first = harness({ prefs: sidecar.createJsonSidecar(dir, 'integrations', fs) });
  await first.s.setEnabled('anthropic', true);
  await first.s.setEnabled('weather', true);
  await first.s.setEnabled('weather', false);
  assert.deepEqual(JSON.parse([...files.values()][0]), { version: 1, enabled: { anthropic: true } });
  const restarted = harness({ prefs: sidecar.createJsonSidecar(dir, 'integrations', fs) });
  const views = Object.fromEntries((await restarted.s.list()).map((v) => [v.id, v.enabled]));
  assert.deepEqual([views.anthropic, views.weather, views.openai], [true, false, false]);
});

test('a mode switch while the trusted dialog is open cancels the request', async () => {
  const box = {};
  box.h = harness({ storedKeys: { openai: OPENAI_KEY }, confirm: async () => { box.h.setMode('offline'); return true; } });
  const r = await box.h.s.check('openai');
  assert.equal(r.ok, false);
  assert.match(r.reason, /^Not sent: Offline mode/);
  assert.equal(box.h.calls.length, 0);
});

test('storing or removing a key notifies the slot owner (so the chat key gate can refresh)', async () => {
  const h = harness();
  await h.s.setKey('anthropic', ANTHROPIC_KEY);
  await h.s.removeKey('anthropic');
  assert.deepEqual(h.keyChanges, ['anthropic', 'anthropic']);
});

// ---------- real netGuard: offline, SSRF and redirects ----------

function realGuard(mode = 'online', respond = () => new Response('{"data":[]}', { status: 200 })) {
  const sent = [];
  const denied = [];
  const guard = netGuard.createGuardedFetch({
    mode: () => mode,
    hasCloudKey: () => false,
    audit: (decision, origin, purpose, reason) => { if (decision === 'denied') denied.push({ origin, purpose, reason }); },
    fetchImpl: async (url, init) => { sent.push({ url, init }); return respond(url, init); },
  });
  return { guard, sent, denied };
}

test('catalog provider checks and the netGuard PROVIDER_CHECKS table match exactly', () => {
  const key = (x) => `${x.origin}${x.path}${x.query ?? ''}|${x.credentialHeader ?? ''}`;
  const online = catalog.egressRequirements().filter((r) => r.online);
  assert.deepEqual(online.map(key).sort(), netGuard.PROVIDER_CHECKS.map(key).sort());
  for (const r of online) assert.equal(r.purpose, 'provider-check', r.id);
});

test('through the real guard: online checks reach only exact URLs, with redirects refused', async () => {
  const g = realGuard('online');
  const GH = 'github_pat_0123456789abcdefghij';
  const h = harness({ fetch: g.guard, storedKeys: { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY, github: GH } });
  for (const id of ['anthropic', 'openai', 'issue-post', 'weather']) assert.equal((await h.s.check(id)).ok, true, id);
  assert.deepEqual(g.sent.map((x) => x.url), [
    'https://api.anthropic.com/v1/models', 'https://api.openai.com/v1/models', 'https://api.github.com/user',
    'https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m',
  ]);
  for (const x of g.sent) {
    assert.equal(x.init.redirect, 'error', `${x.url} must not follow redirects`);
    assert.equal(x.init.method, 'GET');
    assert.ok(x.init.signal, 'timeout signal attached');
  }
  assert.equal(g.denied.length, 0);
});

test('through the real guard: offline mode refuses every provider URL before any request', async () => {
  const g = realGuard('offline');
  const online = catalog.egressRequirements().filter((x) => x.online);
  for (const r of online) {
    const headers = r.credentialHeader ? { [r.credentialHeader]: 'placeholder' } : {};
    await assert.rejects(g.guard(r.origin + r.path + r.query, { method: 'GET', headers }, 'provider-check'), (e) => e instanceof netGuard.NetworkDenied && /Offline mode/.test(e.message), r.id);
  }
  assert.equal(g.sent.length, 0);
  // The service never even reaches the guard or the dialog while offline.
  const h = harness({ mode: 'offline', fetch: g.guard, storedKeys: { openai: OPENAI_KEY } });
  assert.equal((await h.s.check('openai')).ok, false);
  assert.equal(h.confirms.length, 0);
  assert.equal(g.denied.length, online.length, 'only the direct probes above reached the guard');
});

test('the guard rejects SSRF and exfiltration variants of provider-check URLs', () => {
  const ev = (url, opts = {}) => netGuard.evaluateEgress(url, 'provider-check', 'online', false, undefined, { method: 'GET', ...opts });
  assert.equal(ev('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer x' } }), null, 'baseline allowed');
  for (const url of [
    'http://api.openai.com/v1/models', // downgraded scheme
    'https://api.openai.com:8443/v1/models', // other port
    'https://api.openai.com.attacker.test/v1/models', // suffix host
    'https://attacker.test/v1/models',
    'https://user:pw@api.openai.com/v1/models', // embedded credentials
    'https://api.openai.com/v1/models/../../admin', // traversal normalises off the list
    'https://api.openai.com/v1/models?leak=chat-text', // data smuggled in the query
    'https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m', // a real location
    'https://api.open-meteo.com/v1/forecast', // query must match exactly
    'http://127.0.0.1:11434/api/tags', // loopback under the provider purpose
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'file:///C:/Windows/win.ini',
    'not a url',
  ]) assert.notEqual(ev(url), null, url);
  assert.match(ev('https://api.openai.com/v1/models', { method: 'POST' }), /GET/);
  for (const headers of [{ 'x-api-key': 'k' }, { cookie: 'a=b' }, { 'proxy-authorization': 'x' }]) {
    assert.match(ev('https://api.openai.com/v1/models', { headers }), /Credential header/, JSON.stringify(headers));
  }
  assert.match(ev('https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0&current=temperature_2m', { headers: { authorization: 'Bearer x' } }), /Credential header/);
  // Provider origins are not reachable under any other purpose either.
  assert.notEqual(netGuard.evaluateEgress('https://api.openai.com/v1/models', 'ollama', 'online', true, undefined, { method: 'GET' }), null);
  assert.notEqual(netGuard.evaluateEgress('https://api.anthropic.com/v1/models', 'cloud-chat', 'online', true, undefined, { method: 'GET' }), null);
});

test('a redirect status is reported as a failed check and never followed', async () => {
  const g = realGuard('online', () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
  const h = harness({ fetch: g.guard, storedKeys: { openai: OPENAI_KEY } });
  const r = await h.s.check('openai');
  assert.deepEqual([r.ok, r.status], [false, 302]);
  assert.equal(g.sent.length, 1, 'no second request to the redirect target');
  assert.equal(g.sent[0].init.redirect, 'error');
});

// ---------- usage history (108) ----------

test('usage history records requests without content, newest first, bounded, and clearable', async () => {
  const h = harness({ mode: 'offline', respond: () => new Response('{"models":[]}', { status: 200 }) });
  for (let i = 0; i < 205; i++) { await h.s.check('ollama'); h.tick(1); }
  const u = await h.s.usage();
  assert.equal(u.length, 200);
  assert.ok(u[0].at > u[199].at, 'newest first');
  assert.deepEqual(Object.keys(u[0]).sort(), ['at', 'id', 'ok', 'op', 'origin', 'status']);
  await h.s.clearUsage();
  assert.deepEqual(await h.s.usage(), []);
});

// ---------- DPAPI vault ----------

function vaultHarness({ dpapiFails = false } = {}) {
  const files = new Map();
  const fs = { read: async (p) => files.get(p) ?? null, write: async (p, d) => void files.set(p, d), remove: async (p) => void files.delete(p) };
  const native = {
    dpapi: async (op, data) => {
      if (dpapiFails) throw new Error('powershell missing');
      if (op === 'protect') return { ok: true, data: Buffer.from(`enc:${data}`).toString('base64') };
      if (op === 'unprotect') return { ok: true, data: Buffer.from(data, 'base64').toString().replace(/^enc:/, '') };
      return { ok: true };
    },
  };
  return { files, fs, native };
}

test('DPAPI vault stores only ciphertext and lends the key only inside use()', async () => {
  const v = vaultHarness();
  const vault = svc.createDpapiKeyVault({ native: v.native, dir: 'C:\\data', fs: v.fs });
  assert.equal(await vault.has('openai'), false);
  await vault.store('openai', OPENAI_KEY);
  const [[file, blob]] = [...v.files];
  assert.ok(file.endsWith(path.join('secrets', 'integrations', 'openai.bin')));
  assert.ok(!blob.includes(OPENAI_KEY), 'plaintext never written');
  assert.equal(await vault.has('openai'), true);
  assert.equal(await vault.use('openai', async (k) => k.length), OPENAI_KEY.length);
  assert.equal(await vault.use('github', async () => 'unreachable'), null);
  await assert.rejects(vault.store('../escape', OPENAI_KEY), validation.ValidationError);
  await vault.remove('openai');
  assert.equal(v.files.size, 0);

  const broken = vaultHarness({ dpapiFails: true });
  const bv = svc.createDpapiKeyVault({ native: broken.native, dir: 'C:\\data', fs: broken.fs });
  await assert.rejects(bv.store('openai', OPENAI_KEY), /DPAPI is unavailable; the key was not stored/);
  assert.equal(broken.files.size, 0);
});

test('DPAPI vault aliases the Anthropic slot to the existing cloud-key backend', async () => {
  const v = vaultHarness();
  let stored = null;
  const legacy = { configured: async () => stored !== null, set: async (k) => { stored = k; }, reveal: async () => stored, delete: async () => { stored = null; } };
  const vault = svc.createDpapiKeyVault({ native: v.native, dir: 'C:\\data', fs: v.fs, aliases: { anthropic: legacy } });
  await vault.store('anthropic', ANTHROPIC_KEY);
  assert.equal(stored, ANTHROPIC_KEY);
  assert.equal(v.files.size, 0, 'no second copy of the Anthropic key');
  assert.equal(await vault.use('anthropic', async (k) => k === ANTHROPIC_KEY), true);
  await vault.remove('anthropic');
  assert.equal(await vault.has('anthropic'), false);
  assert.equal(await vault.has('constructor'), false, 'prototype keys are not aliases');
});

// ---------- IPC surface ----------

test('integrationHandlers exposes every declared method with matching arity', async () => {
  const h = harness({ mode: 'offline' });
  const handlers = svc.integrationHandlers(h.s);
  assert.deepEqual(Object.keys(handlers).sort(), [...svc.INTEGRATION_METHODS].sort());
  assert.deepEqual(Object.keys(svc.INTEGRATION_ARITY).sort(), [...svc.INTEGRATION_METHODS].sort());
  assert.ok(Array.isArray(await handlers.integrationsList()));
  await assert.rejects(handlers.integrationsCheck({ id: 'openai' }), validation.ValidationError);
});

// ---------- static safety ----------

test('service has no direct network, Electron or child-process access', () => {
  const src = readFileSync(path.join(root, 'electron/services/integrations.ts'), 'utf8');
  assert.doesNotMatch(src, /from 'electron'|node:https?|node:net|child_process|undici|net\.request/);
  assert.doesNotMatch(src.replace(/deps\.fetch\(/g, ''), /\bfetch\(/, 'only the injected guarded fetch is called');
  const comp = readFileSync(path.join(root, 'src/components/Integrations.tsx'), 'utf8');
  assert.doesNotMatch(comp, /localStorage|sessionStorage|console\./, 'renderer never persists or logs key input');
});

// ---------- renderer ----------

const noop = async () => { throw new Error('not called during render'); };
const render = (props) => renderToStaticMarkup(createElement(ui.IntegrationsPanel, { mode: 'offline', previewAction: noop, executeAction: noop, notify: () => {}, ...props }));

test('panel without a bridge states that checks are not wired and makes no connection claims', () => {
  const html = render({});
  assert.match(html, /Websites are not integrations/);
  assert.match(html, /Connection checks are not wired in this build/);
  assert.match(html, /Offline mode/);
  assert.match(html, /Open claude\.ai/);
  assert.match(html, /Experimental, off/);
  assert.doesNotMatch(html, /Connection check passed/);
  assert.doesNotMatch(html, /type="password"/, 'no key field without a backend');
});

test('panel with a bridge offers key fields as password inputs and preview before check', () => {
  const bridge = { list: async () => [], preview: noop, check: noop, setKey: noop, removeKey: noop, setEnabled: noop, usage: async () => [], clearUsage: async () => {} };
  const html = render({ bridge, mode: 'online' });
  assert.match(html, /type="password"[^>]*autoComplete="off"|autoComplete="off"[^>]*type="password"/i);
  assert.match(html, /Preview what is sent/);
  assert.match(html, /Check connection/);
  assert.doesNotMatch(html, /Connection checks are not wired/);
  // Provider items start off: a Turn on control, and the check button is disabled until then.
  assert.match(html, /aria-pressed="false"[^>]*>(?:<[^>]+>)*[^<]*Turn on/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:<[^>]+>)*[^<]*Check connection/);
  assert.match(html, /no OAuth or account sign-in/);
});

test('stateText and filters keep handoffs, API items and unavailable items apart', () => {
  const f = (id) => catalog.findIntegration(id);
  assert.match(ui.stateText(f('spotify-web'), { id: 'spotify-web', state: 'connected', keyConfigured: false, enabled: false }, 'online').text, /Not an API or account connection/);
  assert.match(ui.stateText(f('openai'), { id: 'openai', state: 'turned-off', keyConfigured: true, enabled: false, choiceStorage: 'saved' }, 'online').text, /Nothing is sent until you turn it on/);
  assert.match(ui.stateText(f('openai'), undefined, 'online').text, /unknown/);
  assert.match(ui.stateText(f('openai'), { id: 'openai', state: 'check-failed', keyConfigured: true, enabled: false, lastCheck: { id: 'openai', ok: false, at: new Date(0).toISOString(), reason: 'OpenAI rejected the key' } }, 'online').text, /rejected the key/);
  const ids = (k) => ui.filterIntegrations(k).map((d) => d.id);
  assert.ok(ids('websites').includes('chatgpt-web') && !ids('websites').includes('openai'));
  assert.ok(ids('api').includes('openai') && !ids('api').includes('chatgpt-web'));
  assert.ok(ids('unavailable').includes('spotify-api') && ids('unavailable').includes('sync'));
  assert.equal(ui.filterIntegrations('all').length, catalog.INTEGRATIONS.length);
});
