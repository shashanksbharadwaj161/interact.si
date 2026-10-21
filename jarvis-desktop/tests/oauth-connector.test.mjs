// Per-user account connections: no registration means blocked (never a fake login); a registered public client goes
// through the trusted confirmation, PKCE, an exact loopback callback with state, a five-minute expiry and Cancel; the
// refresh token goes to the protected vault; disconnect revokes where the provider offers it and says so otherwise.
// Gmail and calendar operations exist only as exact previews. A real 127.0.0.1 listener; fake provider; no internet.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root, sourcefile: 'oauth-entry.ts', loader: 'ts',
    contents: `
      export { OAuthConnector, parseRegistrations, previewGmailSend, previewCalendarChange, OAUTH_PROVIDERS, redirectUri } from './electron/services/oauth.ts';
      export { listenLoopback } from './electron/services/loopback.ts';
      export { evaluateEgress, OAUTH_ENDPOINTS } from './electron/services/netGuard.ts';
      export { createBackend } from './electron/backend.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const vault = () => { const m2 = new Map(); return {m2, has: async (k) => m2.has(k), store: async (k, v) => { m2.set(k, v); }, remove: async (k) => { m2.delete(k); }, use: async (k, f) => (m2.has(k) ? f(m2.get(k)) : null)}; };

async function connector(o = {}) {
  const port = o.port ?? await freePort();
  const log = {opened: [], posts: [], confirms: [], activity: []};
  const v = vault();
  const reg = {clientId: 'owner-public-client-123', redirectPort: port, redirectPath: '/oauth/callback'};
  const c = new m.OAuthConnector({
    registrations: o.registrations ?? {'google-calendar': reg, spotify: reg},
    vault: v,
    confirm: async (s, d) => { log.confirms.push([s, d]); return o.confirm ?? true; },
    openExternal: async (url) => { log.opened.push(url); await o.browser?.(new URL(url)); },
    listen: o.listen ?? ((p, pth) => m.listenLoopback(p, pth)),
    post: async (url, form) => { log.posts.push([url, Object.fromEntries(form)]); return o.post ? o.post(url, form) : {status: 200, json: {access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events'}}; },
    online: () => o.online ?? true,
    activity: (s) => { log.activity.push(s); },
  });
  return {c, v, log, port, reg};
}
/** Plays the browser: follows the authorization link back to the loopback redirect. */
const browser = (tweak = (q) => q, redirectPath) => async (u) => {
  const back = new URL(u.searchParams.get('redirect_uri'));
  if (redirectPath) back.pathname = redirectPath;
  const q = tweak(new URLSearchParams({code: 'AUTH-CODE', state: u.searchParams.get('state')}));
  setTimeout(() => { void fetch(`${back.href}?${q}`).then((r) => r.text()).catch(() => undefined); }, 10);
};

test('registrations: public client only; a secret, an unknown provider or a bad port is refused', () => {
  const r = m.parseRegistrations({spotify: {clientId: 'abcdefgh12', redirectPort: 43821, redirectPath: '/cb'}, 'google-gmail': {clientId: 'abcdefgh12', clientSecret: 'x', redirectPort: 43821, redirectPath: '/cb'}, dropbox: {}, 'google-calendar': {clientId: 'abcdefgh12', redirectPort: 80, redirectPath: '/cb'}});
  assert.deepEqual(Object.keys(r.ok), ['spotify']);
  assert.ok(r.problems.some((p) => /client secret must never be configured/.test(p)));
  assert.ok(r.problems.some((p) => /Unknown provider/.test(p)));
  assert.ok(r.problems.some((p) => /redirectPort/.test(p)));
  assert.deepEqual(m.parseRegistrations(undefined), {ok: {}, problems: []});
});

test('without a registration the provider is blocked with the exact missing step; nothing opens or listens', async () => {
  let listened = 0;
  const {c, log} = await connector({registrations: {}, listen: async () => { listened++; throw new Error('no'); }});
  const st = await c.status('google-gmail');
  assert.equal(st.state, 'blocked');
  assert.match(st.reason, /no Gmail client is registered.*Google Cloud console/);
  const r = await c.connect('google-gmail');
  assert.equal(r.ok, false);
  assert.deepEqual([log.confirms.length, log.opened.length, listened], [0, 0, 0]);
});

test('offline or Cancel: no listener, no browser', async () => {
  for (const o of [{online: false}, {confirm: false}]) {
    let listened = 0;
    const {c, log} = await connector({...o, listen: async () => { listened++; throw new Error('no'); }});
    const r = await c.connect('google-calendar');
    assert.equal(r.ok, false);
    assert.deepEqual([listened, log.opened.length], [0, 0]);
  }
});

test('connect: scope review, PKCE S256, exact loopback redirect and state; refresh token protected; granted scopes reported', async () => {
  const {c, v, log, port} = await connector({browser: browser()});
  const r = await c.connect('google-calendar');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(log.confirms[0][0], 'Connect your Google Calendar account?');
  assert.match(log.confirms[0][1], /See, add and change events/);
  assert.match(log.confirms[0][1], new RegExp(`127\\.0\\.0\\.1:${port}/oauth/callback`));
  const auth = new URL(log.opened[0]);
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/oauth/callback`);
  assert.equal(auth.searchParams.get('client_secret'), null);
  const [tokenUrl, form] = log.posts[0];
  assert.equal(tokenUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(createHash('sha256').update(form.code_verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(form.code, 'AUTH-CODE');
  assert.equal(form.client_secret, undefined, 'no secret is sent');
  assert.equal(v.m2.get('oauth-google-calendar'), 'RT-1');
  assert.deepEqual(r.status.grantedScopes, ['https://www.googleapis.com/auth/calendar.events']);
  assert.ok(!JSON.stringify(log.activity).includes('RT-1') && !JSON.stringify(log.activity).includes('AUTH-CODE'));
  assert.equal((await c.status('google-calendar')).state, 'connected');
});

test('a wrong state, a denied consent or a response to another path never saves anything', async () => {
  for (const [tweak, re] of [[(q) => { q.set('state', 'forged-state-value'); return q; }, /did not match/], [(q) => { q.delete('code'); q.set('error', 'access_denied'); return q; }, /did not allow access/]]) {
    const {c, v, log} = await connector({browser: browser(tweak)});
    const r = await c.connect('google-calendar');
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
    assert.equal(log.posts.length, 0);
    assert.equal(v.m2.size, 0);
  }
  // A request to another path gets 404 and is ignored; the right one still completes.
  const port = await freePort();
  const {c} = await connector({port, browser: async (u) => {
    const s = u.searchParams.get('state');
    assert.equal((await fetch(`http://127.0.0.1:${port}/other?code=x&state=${s}`)).status, 404);
    await browser()(u);
  }});
  assert.equal((await c.connect('google-calendar')).ok, true);
});

test('Cancel during the browser step closes the listener and saves nothing', async () => {
  const {c, v, port} = await connector({browser: async () => {}});
  const p = c.connect('google-calendar');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await c.status('google-calendar')).state, 'connecting');
  assert.equal(c.cancel(), true);
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.equal(v.m2.size, 0);
  const free = await new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
  assert.equal(free, true, 'the loopback port is released');
});

test('disconnect revokes where offered and says when it could not; the protected token is removed either way', async () => {
  const {c, v, log} = await connector({browser: browser()});
  await c.connect('google-calendar');
  const d = await c.disconnect('google-calendar');
  assert.deepEqual([d.removedLocally, d.revokedAtProvider], [true, true]);
  assert.deepEqual(log.posts.at(-1), ['https://oauth2.googleapis.com/revoke', {token: 'RT-1'}]);
  assert.equal(v.m2.size, 0);
  const s = await connector();
  await s.v.store('oauth-spotify', 'RT-S');
  const sd = await s.c.disconnect('spotify');
  assert.equal(sd.revokedAtProvider, 'not-offered');
  assert.match(sd.reason, /offers no revocation/);
  assert.equal(s.v.m2.size, 0);
  const f = await connector({post: async () => ({status: 503, json: null})});
  await f.v.store('oauth-google-calendar', 'RT-2');
  const fd = await f.c.disconnect('google-calendar');
  assert.equal(fd.revokedAtProvider, false);
  assert.match(fd.reason, /did not confirm the revocation/);
});

test('egress: account sign-in may only POST to the listed token and revoke endpoints, online, without credential headers', () => {
  const listed = new Set(m.OAUTH_PROVIDERS.flatMap((p) => [p.tokenUrl, p.revokeUrl].filter(Boolean)));
  assert.deepEqual([...listed].sort(), [...m.OAUTH_ENDPOINTS].sort());
  const ok = (url, o = {}) => m.evaluateEgress(url, 'oauth', o.mode ?? 'online', false, undefined, {method: o.method ?? 'POST', headers: o.headers});
  assert.equal(ok('https://oauth2.googleapis.com/token'), null);
  assert.match(ok('https://oauth2.googleapis.com/token', {mode: 'offline'}), /Offline/);
  assert.match(ok('https://oauth2.googleapis.com/token', {method: 'GET'}), /POST/);
  assert.match(ok('https://oauth2.googleapis.com/token?x=1'), /limited/);
  assert.match(ok('https://evil.example/token'), /limited/);
  assert.match(ok('https://accounts.spotify.com/api/token', {headers: {authorization: 'Basic abc'}}), /No credential header/);
});

test('Gmail and calendar changes exist only as exact previews; header injection and bad addresses are refused', () => {
  const g = m.previewGmailSend({to: ['ana@example.com'], subject: 'Lunch?', body: 'Are you free\nat noon?'});
  assert.equal(g.ok, true);
  assert.equal(g.detail, 'To: ana@example.com\nSubject: Lunch?\n\nAre you free\nat noon?');
  const raw = Buffer.from(g.raw, 'base64url').toString('utf8');
  assert.match(raw, /^To: ana@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(raw, /Are you free\r\nat noon\?$/);
  for (const bad of [{to: ['x'], subject: 's', body: ''}, {to: ['a@b.co'], subject: 'hi\r\nBcc: z@z.zz', body: ''}, {to: ['a@b.co\r\nBcc: z@z.zz'], subject: 's', body: ''}, {to: [], subject: 's', body: ''}]) {
    assert.equal(m.previewGmailSend(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(m.previewCalendarChange({action: 'create', calendarId: 'primary', title: 'Dentist', start: '2026-10-22T09:00:00+09:00', end: '2026-10-22T10:00:00+09:00'}).ok, true);
  assert.equal(m.previewCalendarChange({action: 'create', calendarId: 'primary', title: 'x', start: '2026-10-22T10:00:00Z', end: '2026-10-22T09:00:00Z'}).ok, false);
  assert.equal(m.previewCalendarChange({action: 'delete', calendarId: 'primary'}).ok, false, 'a delete needs the exact event');
});

test('backend: providers are blocked until the owner adds a registration file; problems are reported, not ignored', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-oauth-'));
  const mk = () => m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [],
    native: {listWindows: async () => [], dpapi: async () => ({ok: true}), speechVoices: async () => []},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    fetchImpl: async () => { throw new Error('no network'); },
  });
  try {
    let b = await mk();
    assert.equal((await b.accounts.status('google-gmail')).state, 'blocked');
    await b.dispose();
    await writeFile(path.join(dir, 'account-registrations.json'), JSON.stringify({spotify: {clientId: 'owner-public-client-123', redirectPort: 43821, redirectPath: '/oauth/callback'}, 'google-gmail': {clientId: 'abcdefgh12', client_secret: 'no', redirectPort: 43821, redirectPath: '/cb'}}));
    b = await mk();
    assert.equal((await b.accounts.status('spotify')).state, 'not-connected');
    assert.equal((await b.accounts.status('google-gmail')).state, 'blocked');
    assert.ok(b.accountRegistrationProblems.some((p) => /secret/.test(p)));
    const r = await b.accounts.connect('spotify');
    assert.equal(r.ok, false, 'offline by default: nothing is attempted');
    await b.dispose();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('refresh: a current token is reused; an expiring one is refreshed without a secret; a rotated refresh token is stored; callers share one refresh', async () => {
  let now = 1_000_000;
  const port = await freePort();
  const v = vault();
  const posts = [];
  let reply = {status: 200, json: {access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, scope: 's'}};
  const c = new m.OAuthConnector({
    registrations: {spotify: {clientId: 'owner-public-client-123', redirectPort: port, redirectPath: '/oauth/callback'}},
    vault: v, confirm: async () => true, openExternal: async (u) => browser()(new URL(u)), listen: (p, pth) => m.listenLoopback(p, pth),
    post: async (url, form) => { posts.push(Object.fromEntries(form)); await new Promise((r) => setTimeout(r, 5)); return reply; },
    online: () => true, now: () => now,
  });
  assert.equal((await c.connect('spotify')).ok, true);
  assert.deepEqual(await c.accessToken('spotify'), {ok: true, token: 'AT-1'});
  assert.equal(posts.length, 1, 'no refresh while the token is current');
  now += 3600_000 - 30_000;
  reply = {status: 200, json: {access_token: 'AT-2', refresh_token: 'RT-2', expires_in: 3600}};
  const [a, b] = await Promise.all([c.accessToken('spotify'), c.accessToken('spotify')]);
  assert.deepEqual([a, b], [{ok: true, token: 'AT-2'}, {ok: true, token: 'AT-2'}]);
  assert.equal(posts.length, 2, 'concurrent callers share one refresh');
  assert.deepEqual(posts[1], {grant_type: 'refresh_token', refresh_token: 'RT-1', client_id: 'owner-public-client-123'});
  assert.equal(v.m2.get('oauth-spotify'), 'RT-2', 'rotated refresh token replaces the old one');
});

test('refresh: a rejected sign-in is removed and asks to reconnect; a network failure keeps it; offline sends nothing', async () => {
  const v = vault();
  await v.store('oauth-spotify', 'RT-old');
  let reply = {status: 503, json: null};
  let online = true;
  const posts = [];
  const c = new m.OAuthConnector({
    registrations: {spotify: {clientId: 'owner-public-client-123', redirectPort: 43821, redirectPath: '/cb'}},
    vault: v, confirm: async () => true, openExternal: async () => {}, listen: async () => { throw new Error('no'); },
    post: async (url, form) => { posts.push(url); if (reply === 'throw') throw new Error('fetch failed code=SECRET'); return reply; }, online: () => online,
  });
  const down = await c.accessToken('spotify');
  assert.deepEqual([down.ok, down.reconnect], [false, false]);
  assert.equal(v.m2.get('oauth-spotify'), 'RT-old');
  reply = 'throw';
  const net = await c.accessToken('spotify');
  assert.ok(!net.reason.includes('SECRET'), 'error text is redacted');
  online = false;
  const n = posts.length;
  assert.match((await c.accessToken('spotify')).reason, /Online mode is off/);
  assert.equal(posts.length, n);
  online = true;
  reply = {status: 400, json: {error: 'invalid_grant'}};
  const gone = await c.accessToken('spotify');
  assert.deepEqual([gone.ok, gone.reconnect], [false, true]);
  assert.equal(v.m2.has('oauth-spotify'), false);
  assert.equal((await c.status('spotify')).state, 'not-connected');
});

test('IPC: the account methods are declared with provider-enum arguments matching the connector', async () => {
  const built = await build({stdin: {resolveDir: root, sourcefile: 'ipc-entry.ts', loader: 'ts', contents: `export { METHODS, ARITY, ACCOUNT_PROVIDER_IDS } from './electron/channels.ts'; export { ARG_SPECS } from './electron/ipcCore.ts';`}, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent'});
  const c = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  assert.deepEqual([...c.ACCOUNT_PROVIDER_IDS].sort(), m.OAUTH_PROVIDERS.map((p) => p.id).sort());
  for (const [name, n] of [['accountsStatus', 1], ['accountsConnect', 1], ['accountsCancel', 0], ['accountsDisconnect', 1], ['providerConnectionTest', 1], ['providerConnectionTestCancel', 0]]) {
    assert.ok(c.METHODS.includes(name), name);
    assert.equal(c.ARITY[name], n, name);
    assert.equal(c.ARG_SPECS[name].length, n, name);
  }
  assert.deepEqual(c.ARG_SPECS.accountsConnect[0].values, c.ACCOUNT_PROVIDER_IDS);
});
