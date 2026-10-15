// Backlog connectors tests: consumer-app handoffs vs developer APIs, secure key setup, persisted check history, disconnect,
// and the pure OAuth/PKCE helpers. Bundles the real TypeScript in memory. Network, DPAPI, filesystem and confirmation are
// injected mocks: no request leaves this machine, no account is contacted, nothing is opened.
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
    sourcefile: 'backlog-connectors-entry.ts',
    loader: 'tsx',
    contents: `
      export * as catalog from './src/ui/integration-catalog.ts';
      export * as svc from './electron/services/integrations.ts';
      export * as netGuard from './electron/services/netGuard.ts';
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
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { catalog, svc, netGuard, ui, createElement, renderToStaticMarkup } = mod;

const read = (p) => readFileSync(path.join(root, p), 'utf8');
const ANTHROPIC_KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
const OPENAI_KEY = 'sk-test-ZZZZZZZZZZZZZZZZZZZZZZZZ';
const def = (id) => catalog.findIntegration(id);

function memKeys(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, has: async (s) => m.has(s), store: async (s, k) => void m.set(s, k), remove: async (s) => void m.delete(s), use: async (s, fn) => (m.has(s) ? fn(m.get(s)) : null) };
}

/** One shared in-memory prefs file, so a second service over the same store simulates an app restart. */
function memStore(initial, opts = {}) {
  let data = initial;
  const saves = [];
  return {
    saves,
    get data() { return data; },
    load: async () => { if (opts.failLoad) throw new Error('EACCES'); return data; },
    save: async (p) => { if (opts.failSave) throw new Error('disk full'); saves.push(structuredClone(p)); data = structuredClone(p); },
  };
}

function harness(opts = {}) {
  const calls = [];
  const audits = [];
  let t = 1_700_000_000_000;
  const respond = opts.respond ?? (() => new Response('{"data":[{"secret":"body-must-not-be-kept"}]}', { status: 200 }));
  const allOn = { version: 1, enabled: Object.fromEntries(catalog.INTEGRATIONS.filter(catalog.needsOptIn).map((d) => [d.id, true])) };
  const store = opts.store ?? memStore(allOn, opts);
  const keys = opts.keys ?? memKeys(opts.storedKeys ?? { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY });
  const s = svc.createIntegrationService({
    fetch: async (url, init, purpose) => { calls.push({ url, init, purpose }); if (opts.throws) throw opts.throws; return respond(url, init, purpose); },
    mode: () => opts.mode ?? 'online',
    keys,
    confirm: async () => true,
    audit: (line) => audits.push(line),
    now: () => t,
    prefs: store,
    cooldownMs: 0,
  });
  return { s, calls, audits, keys, store, tick: (ms) => { t += ms; } };
}

// ---------- catalog: consumer app handoff stays distinct from OAuth/API ----------

test('Claude, ChatGPT and Spotify website items are handoffs that point to their API counterparts and never claim to connect', () => {
  for (const id of ['claude-web', 'chatgpt-web', 'spotify-web', 'browser']) {
    const d = def(id);
    assert.equal(d.availability, 'handoff');
    assert.ok(!d.check && !d.key, `${id} has no API check or key`);
    assert.match(d.notThis, /not an integration|no extension|not read/i, `${id} says what it is not`);
  }
  const link = (from, to) => assert.ok(def(from).related?.some((r) => r.id === to), `${from} is distinguished from ${to}`);
  link('anthropic', 'claude-web'); link('claude-web', 'anthropic');
  link('openai', 'chatgpt-web'); link('chatgpt-web', 'openai');
  link('spotify-web', 'spotify-api'); link('spotify-api', 'spotify-web');
  for (const d of catalog.INTEGRATIONS) for (const r of d.related ?? []) assert.ok(def(r.id), `${d.id} related id ${r.id} exists`);
  assert.match(def('anthropic').related[0].why, /subscription/i);
  assert.match(def('openai').related[0].why, /subscription/i);
});

test('Spotify playback and calendar stay setup-required: no sign-in, no token storage and no new network allowance', () => {
  for (const id of ['spotify-api', 'calendar']) {
    const d = def(id);
    assert.equal(d.availability, 'setup-required');
    assert.equal(catalog.isCheckable(d), false);
    assert.ok(!d.check && !d.key && !d.handoff);
    assert.ok(d.blockers.length > 0);
  }
  assert.match(def('spotify-api').blockers.join(' '), /no sign-in flow/i);
  // Nothing Spotify- or OAuth-related may be added to the egress surface or to the guard.
  assert.deepEqual(catalog.egressRequirements().map((r) => r.id).sort(), ['anthropic', 'issue-post', 'ollama', 'openai', 'weather']);
  assert.ok(!netGuard.PROVIDER_CHECKS.some((c) => /spotify|accounts\./i.test(c.origin)), 'netGuard has no Spotify/OAuth origin');
});

test('browser handoff is manual: free-form link, copy route, and no extension or automation claim', () => {
  const b = def('browser');
  assert.match(b.notThis, /no browser extension and no automation/i);
  assert.match(b.setup.join(' '), /Copy link/);
  assert.equal(catalog.handoffAction(b, 'http://example.com/page').action.target, 'http://example.com/page');
  assert.equal(catalog.handoffAction(b, 'https://example.com/a?b=1').ok, true);
  for (const bad of ['', 'javascript:alert(1)', 'file:///C:/x', 'https://u:p@example.com', 'mailto:a@b.test']) assert.equal(catalog.handoffAction(b, bad).ok, false, bad);
  const text = read('src/components/Integrations.tsx');
  assert.doesNotMatch(text, /chrome\.|webextension|puppeteer|playwright|executeScript/i);
});

test('a pasted Spotify link is limited to open.spotify.com; other handoffs ignore pasted links entirely', () => {
  const sp = def('spotify-web');
  assert.equal(catalog.handoffAction(sp).action.target, 'https://open.spotify.com/');
  assert.equal(catalog.handoffAction(sp, '  ').action.target, 'https://open.spotify.com/');
  const ok = catalog.handoffAction(sp, 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc');
  assert.equal(ok.ok, true);
  assert.equal(ok.action.type, 'open-url');
  for (const bad of [
    'https://evil.example/track/1', 'https://open.spotify.com.evil.example/', 'https://evilopen.spotify.com/', 'http://open.spotify.com/track/1',
    'https://user:pw@open.spotify.com/', 'spotify:track:4uLU6hMCjMI75M1A2tKUQC', 'https://open.spotify.com/a b', 'javascript:alert(1)',
  ]) assert.equal(catalog.handoffAction(sp, bad).ok, false, bad);
  assert.match(catalog.handoffAction(sp, 'https://evil.example/').reason, /open\.spotify\.com/);
  // A fixed handoff cannot be redirected by a pasted value.
  assert.equal(catalog.handoffAction(def('claude-web'), 'https://evil.example/').action.target, 'https://claude.ai/');
  assert.equal(catalog.handoffAction(def('chatgpt-web'), 'https://evil.example/').action.target, 'https://chatgpt.com/');
});

test('key pages open only through the approved open-url action and are fixed https provider pages', () => {
  const hosts = { anthropic: 'console.anthropic.com', openai: 'platform.openai.com', 'issue-post': 'github.com' };
  for (const d of catalog.INTEGRATIONS.filter((x) => x.key)) {
    const r = catalog.keyPageAction(d);
    assert.equal(r.ok, true, d.id);
    assert.equal(r.action.type, 'open-url');
    assert.equal(new URL(r.action.target).hostname, hosts[d.id], d.id);
    assert.ok(r.action.target.startsWith('https://'));
  }
  assert.equal(catalog.keyPageAction(def('claude-web')).ok, false);
  assert.equal(catalog.keyPageAction(def('weather')).ok, false);
});

test('inspectLink flags http, punycode lookalikes, bare IPs, ports and query data without fetching anything', () => {
  assert.deepEqual(catalog.inspectLink('https://claude.ai/'), { host: 'claude.ai', notes: [] });
  const http = catalog.inspectLink('http://example.com/');
  assert.match(http.notes.join(' '), /not encrypted/);
  const puny = catalog.inspectLink('https://xn--pple-43d.com/');
  assert.match(puny.notes.join(' '), /punycode/);
  assert.match(puny.notes.join(' '), /xn--pple-43d\.com/);
  assert.match(catalog.inspectLink('https://192.168.0.1/').notes.join(' '), /number, not a site name/);
  assert.match(catalog.inspectLink('https://example.com:8443/').notes.join(' '), /port \(8443\)/);
  assert.match(catalog.inspectLink('https://example.com/?q=secret').notes.join(' '), /query or fragment/);
  assert.match(catalog.inspectLink('nonsense').notes[0], /could not be read/);
});

// ---------- secure key setup ----------

test('keyWarnings catches pasted "Bearer", NAME=value, quotes, whitespace and keys pasted into the wrong provider', () => {
  const an = def('anthropic'), oa = def('openai'), gh = def('issue-post');
  assert.deepEqual(catalog.keyWarnings(an, ANTHROPIC_KEY), []);
  assert.deepEqual(catalog.keyWarnings(oa, OPENAI_KEY), []);
  assert.deepEqual(catalog.keyWarnings(an, ''), []);
  assert.deepEqual(catalog.keyWarnings(def('weather'), 'anything'), [], 'no key slot, no warnings');
  assert.match(catalog.keyWarnings(oa, `Bearer ${OPENAI_KEY}`).join(' '), /without the word "Bearer"/);
  assert.match(catalog.keyWarnings(an, `ANTHROPIC_API_KEY=${ANTHROPIC_KEY}`).join(' '), /NAME=value/);
  assert.match(catalog.keyWarnings(an, `"${ANTHROPIC_KEY}"`).join(' '), /quotes/);
  assert.match(catalog.keyWarnings(an, 'sk-ant-abc def\nghi').join(' '), /spaces or line breaks/);
  assert.match(catalog.keyWarnings(oa, ANTHROPIC_KEY).join(' '), /looks like an Anthropic key, not a OpenAI API key/);
  assert.match(catalog.keyWarnings(an, 'ghp_' + 'a'.repeat(30)).join(' '), /GitHub token/);
  assert.match(catalog.keyWarnings(oa, 'github_pat_' + 'a'.repeat(30)).join(' '), /GitHub token/);
  assert.match(catalog.keyWarnings(an, OPENAI_KEY).join(' '), /usually start with sk-ant-/);
  assert.deepEqual(catalog.keyWarnings(gh, 'github_pat_' + 'a'.repeat(30)), []);
  // A warning never repeats the key.
  assert.ok(!catalog.keyWarnings(an, `Bearer ${OPENAI_KEY}`).join(' ').includes(OPENAI_KEY));
});

test('storing a key warns about a wrong-provider key but keeps the user in control, and the key never leaks', async () => {
  const h = harness({ storedKeys: {} });
  const r = await h.s.setKey('openai', ANTHROPIC_KEY);
  assert.equal(r.configured, true);
  assert.match(r.warning, /looks like an Anthropic key/);
  assert.equal(h.keys.m.get('openai'), ANTHROPIC_KEY, 'warn, do not decide for the user');
  assert.ok(!JSON.stringify([r, h.audits, h.store.data]).includes(ANTHROPIC_KEY));
  await assert.rejects(h.s.setKey('openai', `Bearer ${OPENAI_KEY}`), /invalid characters/, 'a pasted header is refused outright');
  const clean = await h.s.setKey('anthropic', ANTHROPIC_KEY);
  assert.equal(clean.warning, undefined);
});

test('setupChecklist reflects real state: turn on, online, key, check, with no steps for handoffs or unavailable items', () => {
  const oa = def('openai');
  const ids = (steps) => steps.map((x) => `${x.id}:${x.done}`).join(',');
  assert.equal(ids(catalog.setupChecklist(oa, undefined, 'offline')), 'turn-on:false,online:false,key:false,check:false');
  const half = { id: 'openai', state: 'needs-key', keyConfigured: false, enabled: true, choiceStorage: 'saved' };
  assert.equal(ids(catalog.setupChecklist(oa, half, 'online')), 'turn-on:true,online:true,key:false,check:false');
  assert.equal(ids(catalog.setupChecklist(oa, half, 'offline')), 'turn-on:true,online:false,key:false,check:false');
  const done = { ...half, state: 'connected', keyConfigured: true };
  assert.equal(ids(catalog.setupChecklist(oa, done, 'online')), 'turn-on:true,online:true,key:true,check:true');
  assert.equal(ids(catalog.setupChecklist(def('weather'), done, 'online')), 'turn-on:true,online:true,check:true', 'keyless: no key step');
  assert.equal(ids(catalog.setupChecklist(def('ollama'), undefined, 'offline')), 'check:false', 'local: only the check');
  for (const id of ['claude-web', 'browser', 'spotify-api', 'sync', 'news', 'issue-draft']) assert.deepEqual(catalog.setupChecklist(def(id), undefined, 'online'), [], id);
});

// ---------- errors with a next step ----------

test('failed checks carry a plain next step and never include the key or the response body', async () => {
  const cases = [
    [401, /Create a new key/], [403, /Create a new key/], [404, /changed this endpoint/], [429, /Wait a few minutes/], [503, /provider side/], [302, /Redirects are never followed/],
  ];
  for (const [status, hint] of cases) {
    const h = harness({ respond: () => new Response(`leak ${OPENAI_KEY}`, { status }) });
    const r = await h.s.check('openai');
    assert.equal(r.ok, false, String(status));
    assert.match(r.hint, hint, String(status));
    assertNoKey([r, h.audits, h.store.data], OPENAI_KEY);
  }
  const net = await harness({ throws: new TypeError('fetch failed') }).s.check('openai');
  assert.match(net.hint, /internet connection, VPN, proxy or firewall/);
  const slow = await harness({ throws: Object.assign(new Error('t'), { name: 'TimeoutError' }) }).s.check('openai');
  assert.match(slow.hint, /slow/);
  const ok = await harness().s.check('openai');
  assert.equal(ok.ok, true);
  assert.equal(ok.hint, undefined);
  // Keyless endpoints do not suggest replacing a key that does not exist.
  assert.equal((await harness({ respond: () => new Response('', { status: 401 }) }).s.check('weather')).hint, undefined);
});

function assertNoKey(value, ...keys) {
  const text = JSON.stringify(value);
  for (const k of keys) assert.ok(!text.includes(k), `secret leaked into: ${text.slice(0, 160)}`);
}

// ---------- persistence: last outcome survives a restart, but never counts as "connected" ----------

test('a check outcome is saved (status and reason only) and shown after restart as history, not as a live connection', async () => {
  const h = harness();
  const r = await h.s.check('openai');
  assert.equal(r.ok, true);
  const saved = h.store.data.lastChecks.openai;
  assert.deepEqual(Object.keys(saved).sort(), ['at', 'ok', 'status']);
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 200);
  assertNoKey(h.store.data, OPENAI_KEY, 'body-must-not-be-kept');
  assert.deepEqual(h.store.data.enabled, Object.fromEntries(catalog.INTEGRATIONS.filter(catalog.needsOptIn).map((d) => [d.id, true])), 'opt-in choices are preserved');

  // Simulated restart: a fresh service over the same saved file.
  const again = harness({ store: h.store, keys: h.keys });
  const v = await again.s.view('openai');
  assert.equal(v.lastCheck, undefined);
  assert.equal(v.state, 'ready-to-check', 'not "connected" until this session checks again');
  assert.equal(v.previousCheck.ok, true);
  assert.equal(v.previousCheck.status, 200);
  assert.equal((await again.s.view('anthropic')).previousCheck, undefined);

  // After a new check in this session, the live result wins and no duplicate history is shown.
  await again.s.check('openai');
  const live = await again.s.view('openai');
  assert.equal(live.state, 'connected');
  assert.equal(live.previousCheck, undefined);
});

test('a failed check is also remembered with its reason, so the next session explains what went wrong', async () => {
  const h = harness({ respond: () => new Response('', { status: 401 }) });
  await h.s.check('anthropic');
  const again = harness({ store: h.store, keys: h.keys });
  const v = await again.s.view('anthropic');
  assert.equal(v.previousCheck.ok, false);
  assert.match(v.previousCheck.reason, /rejected the key/);
});

test('removing the key, changing the key, or turning an item off forgets its saved outcome (disconnect leaves no stale "passed")', async () => {
  const h = harness();
  await h.s.check('openai');
  await h.s.check('anthropic');
  await h.s.check('weather');
  assert.deepEqual(Object.keys(h.store.data.lastChecks).sort(), ['anthropic', 'openai', 'weather']);
  await h.s.removeKey('openai');
  assert.equal(h.store.data.lastChecks.openai, undefined, 'key removal forgets');
  await h.s.setKey('anthropic', ANTHROPIC_KEY);
  assert.equal(h.store.data.lastChecks.anthropic, undefined, 'a new key must be re-checked');
  await h.s.setEnabled('weather', false);
  assert.equal(h.store.data.lastChecks?.weather, undefined, 'turning off forgets');
  assert.equal(h.store.data.lastChecks, undefined, 'empty history is not written at all');
  assert.equal(h.store.data.enabled.weather, undefined);
  assert.equal(h.store.data.enabled.openai, true, 'other choices untouched');
});

test('full disconnect sequence used by the page (remove key, then turn off) leaves nothing connected', async () => {
  const h = harness();
  await h.s.check('openai');
  await h.s.removeKey('openai');
  const mid = await h.s.setEnabled('openai', false);
  assert.equal(mid.keyConfigured, false);
  assert.equal(mid.enabled, false);
  assert.equal(mid.state, 'turned-off');
  assert.equal(mid.lastCheck, undefined);
  assert.equal(mid.previousCheck, undefined);
  const refused = await h.s.check('openai');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /Turn on/);
  assert.equal(h.calls.filter((c) => c.url.includes('openai')).length, 1, 'only the first check ever reached the guard');
});

test('history persistence is best effort and never overwrites choices that could not be read', async () => {
  const failing = harness({ failSave: true });
  const r = await failing.s.check('openai');
  assert.equal(r.ok, true, 'a failed save does not fail the check');
  const unreadable = harness({ failLoad: true });
  const r2 = await unreadable.s.check('openai');
  assert.equal(r2.ok, false, 'unreadable choices keep everything off');
  assert.equal(unreadable.store.saves.length, 0, 'nothing was written over the unreadable file');
  const noStore = svc.createIntegrationService({ fetch: async () => new Response('', { status: 200 }), mode: () => 'online', keys: memKeys({ openai: OPENAI_KEY }), confirm: async () => true, cooldownMs: 0 });
  assert.equal((await noStore.check('openai')).ok, false, 'without a store nothing can be on, so nothing is sent or kept');
});

test('sanitizePrefs keeps only well-formed outcomes for known checkable items', () => {
  const at = '2026-10-14T10:00:00.000Z';
  const raw = {
    version: 1, enabled: { openai: true },
    lastChecks: {
      openai: { ok: false, at, status: 401, reason: 'OpenAI rejected the key\u0000\nX' + 'y'.repeat(400), extra: 'dropped', body: 'dropped' },
      anthropic: { ok: true, at: 'not a date' },
      weather: { ok: 'yes', at },
      'spotify-web': { ok: true, at }, // handoff: nothing to check
      unknown: { ok: true, at },
      ollama: { ok: true, at, status: 99999 },
      'issue-post': 'nope',
    },
  };
  const p = svc.sanitizePrefs(raw);
  assert.deepEqual(Object.keys(p.lastChecks).sort(), ['ollama', 'openai']);
  assert.deepEqual(Object.keys(p.lastChecks.openai).sort(), ['at', 'ok', 'reason', 'status']);
  assert.ok(p.lastChecks.openai.reason.length <= 200);
  assert.ok(!/[\u0000-\u001f]/.test(p.lastChecks.openai.reason));
  assert.equal(p.lastChecks.ollama.status, undefined, 'out-of-range status dropped, outcome kept');
  assert.deepEqual(svc.sanitizePrefs({ version: 1, enabled: {}, lastChecks: 'garbage' }), { version: 1, enabled: {} });
  assert.deepEqual(svc.sanitizePrefs(null), { version: 1, enabled: {} });
});

// ---------- OAuth / PKCE groundwork (pure; no sign-in) ----------

const RFC7636_BYTES = Uint8Array.from([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
const OAUTH = { authorizeUrl: 'https://accounts.example.test/authorize', clientId: 'owner-registered-client-id', redirectUri: 'http://127.0.0.1:8123/callback', scopes: ['user-read-playback-state', 'user-modify-playback-state'] };

test('createPkce matches the RFC 7636 appendix B vector and is random by default', () => {
  const p = svc.createPkce(() => RFC7636_BYTES);
  assert.equal(p.verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(p.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(p.method, 'S256');
  const a = svc.createPkce(), b = svc.createPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(svc.createOAuthState(), svc.createOAuthState());
  assert.match(svc.createOAuthState(), /^[A-Za-z0-9_-]{22}$/);
});

test('validateOAuthConfig accepts a PKCE public client and refuses unsafe endpoints, redirects, ids and scopes', () => {
  const ok = svc.validateOAuthConfig(OAUTH);
  assert.equal(ok.ok, true);
  assert.equal(svc.validateOAuthConfig({ ...OAUTH, redirectUri: 'https://app.example.test/cb' }).ok, true);
  assert.equal(svc.validateOAuthConfig({ ...OAUTH, redirectUri: 'http://[::1]:9000/cb' }).ok, true);
  const bad = {
    'http authorize': { authorizeUrl: 'http://accounts.example.test/authorize' },
    'authorize query': { authorizeUrl: 'https://accounts.example.test/authorize?client_secret=x' },
    'authorize creds': { authorizeUrl: 'https://u:p@accounts.example.test/authorize' },
    'authorize garbage': { authorizeUrl: 'nope' },
    'localhost redirect': { redirectUri: 'http://localhost:8123/callback' },
    'loopback without port': { redirectUri: 'http://127.0.0.1/callback' },
    'http non-loopback redirect': { redirectUri: 'http://app.example.test/cb' },
    'redirect fragment': { redirectUri: 'https://app.example.test/cb#x' },
    'custom scheme': { redirectUri: 'javascript:alert(1)' },
    'short client id': { clientId: 'abc' },
    'client id with secret chars': { clientId: 'id with spaces and "quotes"' },
    'no scopes': { scopes: [] },
    'duplicate scopes': { scopes: ['a-scope', 'a-scope'] },
    'scope with space': { scopes: ['two words'] },
    'scope with quote': { scopes: ['bad"scope'] },
    'too many scopes': { scopes: Array.from({ length: 21 }, (_, i) => `scope-${i}`) },
  };
  for (const [name, patch] of Object.entries(bad)) assert.equal(svc.validateOAuthConfig({ ...OAUTH, ...patch }).ok, false, name);
});

test('buildAuthorizeUrl builds an S256 link with state, validates inputs, and never opens or fetches anything', () => {
  const pkce = svc.createPkce(() => RFC7636_BYTES);
  const state = svc.createOAuthState(() => RFC7636_BYTES.slice(0, 16));
  const u = new URL(svc.buildAuthorizeUrl(OAUTH, pkce.challenge, state));
  assert.equal(u.origin + u.pathname, 'https://accounts.example.test/authorize');
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual(q, {
    response_type: 'code', client_id: OAUTH.clientId, redirect_uri: OAUTH.redirectUri, scope: 'user-read-playback-state user-modify-playback-state',
    code_challenge_method: 'S256', code_challenge: pkce.challenge, state,
  });
  assert.ok(!u.href.includes(pkce.verifier), 'the verifier never appears in the link');
  assert.throws(() => svc.buildAuthorizeUrl({ ...OAUTH, redirectUri: 'http://localhost:1/x' }, pkce.challenge, state), /Redirect must be/);
  assert.throws(() => svc.buildAuthorizeUrl(OAUTH, 'short', state), /challenge/);
  assert.throws(() => svc.buildAuthorizeUrl(OAUTH, pkce.challenge, 'bad state!'), /State/);
  // Source-level guard: the helper section has no network, browser, console or storage access.
  const src = read('electron/services/integrations.ts');
  const section = src.slice(src.indexOf('// ---------- OAuth authorization-code'), src.indexOf('// ---------- DPAPI key vault'));
  assert.ok(section.length > 500);
  assert.doesNotMatch(section, /\bfetch\b|openExternal|console\.|localStorage|writeFile|http\.request|https\.request|net\.connect/);
});

test('stateMatches is exact and constant-time-safe for mismatched lengths and types', () => {
  const s = svc.createOAuthState();
  assert.equal(svc.stateMatches(s, s), true);
  assert.equal(svc.stateMatches(s, s + 'x'), false);
  assert.equal(svc.stateMatches(s, s.slice(0, -1)), false);
  assert.equal(svc.stateMatches(s, undefined), false);
  assert.equal(svc.stateMatches(s, [s]), false);
  assert.equal(svc.stateMatches('', ''), false, 'an empty expected state never matches');
});

test('redactOAuthText removes codes, verifiers, tokens, secrets and Bearer values from any log text', () => {
  const secrets = ['AUTHCODE123', 'VERIFIER456', 'ACCESS789', 'REFRESH012', 'SECRET345', 'STATE678', 'BEARERTOK901', 'IDTOK234'];
  const text = [
    'GET /callback?code=AUTHCODE123&state=STATE678 failed',
    'code_verifier=VERIFIER456&client_secret=SECRET345',
    '{"access_token":"ACCESS789","refresh_token": "REFRESH012","id_token":"IDTOK234","expires_in":3600}',
    'Authorization: Bearer BEARERTOK901',
    'code=AUTHCODE123',
  ].join('\n');
  const red = svc.redactOAuthText(text);
  for (const s of secrets) assert.ok(!red.includes(s), `${s} still present: ${red}`);
  assert.match(red, /expires_in/, 'non-secret fields survive');
  assert.match(red, /\/callback\?code=\[redacted\]/);
  assert.equal(svc.redactOAuthText('nothing secret here'), 'nothing secret here');
});

// ---------- renderer ----------

const noop = async () => { throw new Error('not called during render'); };
const bridge = { list: async () => [], preview: noop, check: noop, setKey: noop, removeKey: noop, setEnabled: noop, usage: async () => [], clearUsage: async () => {} };
const card = (id, props = {}) => renderToStaticMarkup(createElement(ui.IntegrationCard, { d: def(id), mode: 'online', previewAction: noop, executeAction: noop, notify: () => {}, onChanged: async () => {}, ...props }));
const view = (id, patch = {}) => ({ id, state: 'ready-to-check', keyConfigured: false, enabled: false, choiceStorage: 'saved', ...patch });

test('API card shows live setup progress, key-page handoff and "not the same as" the consumer subscription', () => {
  const html = card('openai', { bridge, view: view('openai', { enabled: true, state: 'needs-key' }) });
  assert.match(html, /Setup progress/);
  assert.match(html, /Done: Turn on OpenAI API/);
  assert.match(html, /Done: Switch to online mode/);
  assert.match(html, /Next: Store your OpenAI API key/);
  assert.match(html, /To do: Run the connection check/);
  assert.match(html, /Not the same as ChatGPT website/);
  assert.match(html, /Open the OpenAI API key page/);
  assert.match(html, /Copy link/);
  assert.doesNotMatch(html, /Disconnect/, 'nothing to disconnect without a key');
  const noBridge = card('openai', {});
  assert.doesNotMatch(noBridge, /Setup progress/, 'without a backend the static setup text is shown');
  assert.match(noBridge, /Paste your OpenAI API key/);
});

test('a stored key hides the key-page link and offers a two-step disconnect', () => {
  const html = card('anthropic', { bridge, view: view('anthropic', { enabled: true, keyConfigured: true, state: 'connected', lastCheck: { id: 'anthropic', ok: true, at: new Date().toISOString(), status: 200 } }) });
  assert.match(html, /Disconnect/);
  assert.doesNotMatch(html, /Remove the stored key and turn off/, 'the confirmation appears only after the first click');
  assert.doesNotMatch(html, /Open the Anthropic API key page/);
  assert.match(html, /Done: Store your Anthropic API key/);
  assert.match(html, /Done: Run the connection check/);
  const off = card('weather', { bridge, view: view('weather', { enabled: true }) });
  assert.doesNotMatch(off, /Disconnect/, 'keyless items have no key to remove');
});

test('failure hint and earlier-session history are shown with honest wording', () => {
  const failed = card('openai', { bridge, view: view('openai', { enabled: true, keyConfigured: true, state: 'check-failed', lastCheck: { id: 'openai', ok: false, at: new Date().toISOString(), status: 401, reason: 'OpenAI rejected the key', hint: 'Create a new key (revoked or expired keys are rejected), store it again, then re-run the check.' } }) });
  assert.match(failed, /OpenAI rejected the key/);
  assert.match(failed, /Next step: Create a new key/);
  const prev = card('openai', { bridge, view: view('openai', { enabled: true, keyConfigured: true, previousCheck: { id: 'openai', ok: true, at: '2026-10-13T09:00:00.000Z', status: 200 } }) });
  assert.match(prev, /Earlier session: the check passed/);
  assert.match(prev, /Check again to confirm/);
  assert.doesNotMatch(prev, /Connection check passed at/, 'history is never presented as a live connection');
  const prevFail = card('openai', { bridge, view: view('openai', { previousCheck: { id: 'openai', ok: false, at: '2026-10-13T09:00:00.000Z', reason: 'OpenAI rejected the key' } }) });
  assert.match(prevFail, /check failed \(OpenAI rejected the key\)/);
});

test('handoff cards: Spotify takes a restricted pasted link, browser takes any http(s) link, Claude and ChatGPT only open their site', () => {
  const sp = card('spotify-web', {});
  assert.match(sp, /Only open\.spotify\.com links are accepted/);
  assert.match(sp, /Open Spotify/);
  assert.match(sp, /Not the same as Spotify playback control/);
  assert.match(sp, /Copy link/);
  assert.doesNotMatch(sp, /type="password"/);
  const br = card('browser', {});
  assert.match(br, /http or https only/);
  assert.match(br, /Preview link/);
  assert.match(br, /no browser extension and no automation/i);
  for (const id of ['claude-web', 'chatgpt-web']) {
    const html = card(id, { bridge });
    assert.doesNotMatch(html, /<input/, `${id} takes no input`);
    assert.doesNotMatch(html, /Check connection|Store key|Setup progress/);
    assert.match(html, /Sign in there yourself/);
  }
  assert.match(card('claude-web', {}), /Not the same as Claude API/);
});

test('OAuth secrets in URL fragments are redacted before logging', () => {
  const text = svc.redactOAuthText('https://app.example/cb#access_token=FRAGMENTSECRET&state=STATESECRET');
  assert.doesNotMatch(text, /FRAGMENTSECRET|STATESECRET/);
  assert.match(text, /#access_token=\[redacted\]/);
});

test('renderer source stays free of storage, logging, extension automation and OAuth sign-in code', () => {
  const comp = read('src/components/Integrations.tsx');
  assert.doesNotMatch(comp, /localStorage|sessionStorage|console\.|indexedDB/);
  assert.doesNotMatch(comp, /openExternal|window\.open|location\.href|accounts\.spotify|code_challenge|authorize\?/i);
  const cat = read('src/ui/integration-catalog.ts');
  assert.doesNotMatch(cat, /client_secret|access_token|refresh_token/);
});
