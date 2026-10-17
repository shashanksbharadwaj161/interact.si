// Parallel-team independent security/acceptance review (role: security, jarvis-desktop-104). Behaviour regressions that drive
// the real bundled sources with injected fixtures only: own temp profile per backend, recorded fetch (nothing leaves the
// process), in-memory native adapter (no PowerShell, desktop input, microphone or audio), no Electron binary.
// Open findings are `todo` tests asserting the SAFE behaviour: they print `not ok # TODO` without failing the suite and
// flip to `ok` once fixed (then drop the todo). Finding ids (PS-xx) match docs/parallel-security-findings.md.
// PARALLEL_SECURITY_SOURCE_ROOT may point at another checkout (read only) to review a peer or the integrated tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {existsSync, readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.env.PARALLEL_SECURITY_SOURCE_ROOT || root);
const require = createRequire(import.meta.url);

const iconStub = {name: 'icon-stub', setup(b) {
  b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
  b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: 'module.exports = new Proxy({}, {get: (_t, k) => k === "__esModule" ? false : () => null});', loader: 'js'}));
}};

/** Bundles `contents` against SRC for Node. Core modules must exist: a missing one is a failure, not a skip. */
async function load(contents) {
  const out = await build({stdin: {contents, resolveDir: SRC, loader: 'tsx', sourcefile: 'parallel-security-entry.tsx'}, bundle: true, write: false, platform: 'node', format: 'cjs',
    jsx: 'automatic', loader: {'.css': 'empty'}, logLevel: 'silent', nodePaths: [path.join(root, 'node_modules')], plugins: [iconStub]});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const B = await load(`export {createBackend} from './electron/backend'; export {safeErrorMessage} from './electron/ipcCore';`);
const AUDIO = await load(`export * from './src/ui/audio';`);

// ---------------------------------------------------------------------------------------------------------------
// Backend fixture: real createBackend, own temp profile, recorded fetch, in-memory native adapter.
// ---------------------------------------------------------------------------------------------------------------

const CLOUD = 'https://cloud.parallel-security.invalid';
const KEY = 'sk-ant-api03-PARALLELSECURITYFIXTURE' + 'q'.repeat(24);
const enc = new TextEncoder();
const body = (chunks) => new ReadableStream({start(c) { for (const s of chunks) c.enqueue(enc.encode(s)); c.close(); }});
const ndjson = (o) => JSON.stringify(o) + '\n';

async function backend({confirm, cloud} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-parallel-security-'));
  const fetched = [];
  const confirms = [];
  const b = await B.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [process.pid],
    native: {
      listWindows: async () => [], focusWindow: async () => ({focused: false}), moveWindow: async () => { throw new Error('no desktop in review'); },
      typeText: async () => { throw new Error('no desktop input in review'); }, click: async () => { throw new Error('no desktop input in review'); },
      probeSpeech: async () => ({voices: [], recognizers: []}), speak: async () => ({ok: false, reason: 'no audio in review'}), transcribe: async () => ({text: '', reason: 'no microphone in review'}),
      dpapi: async (op, data) => op === 'protect' ? {ok: true, data: Buffer.from(String(data)).toString('base64')} : op === 'unprotect' ? {ok: true, data: Buffer.from(String(data), 'base64').toString()} : {ok: true},
    },
    shell: {spawnApp: async () => { throw new Error('no launch in review'); }, openPath: async () => 'blocked', openExternal: async () => { throw new Error('no browser in review'); }},
    confirm: confirm && (async (summary, detail) => { confirms.push({summary, detail}); return confirm(summary, detail); }),
    clipboard: {readText: async () => 'fixture clipboard text'},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    cloudOriginOverride: CLOUD,
    fetchImpl: async (url, init = {}) => {
      const u = String(url);
      fetched.push({url: u, method: init.method ?? 'GET'});
      if (u.startsWith(CLOUD)) { if (cloud) return cloud(u, init); throw new TypeError('fetch failed'); }
      if (u.endsWith('/api/chat')) return new Response(body([ndjson({message: {content: 'local says hi'}, done: false}), ndjson({done: true})]), {status: 200});
      if (u.endsWith('/api/tags')) return Response.json({models: []});
      throw new TypeError('fetch failed');
    },
  });
  return {b, fetched, confirms, async close() { await b.dispose(); await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100}); }};
}

async function onlineWithKey(cloud) {
  const f = await backend({confirm: async () => true, cloud});
  await f.b.saveSettings({mode: 'online'});
  await f.b.setCloudKey(KEY);
  assert.equal((await f.b.getState()).settings.mode, 'online');
  return f;
}

// ---------------------------------------------------------------------------------------------------------------
// Approvals: without a trusted "Continue" nothing sensitive changes (absent, declined and failing dialogs)
// ---------------------------------------------------------------------------------------------------------------

const SENSITIVE = [
  ['online mode', (b) => b.saveSettings({mode: 'online'}), async (b) => (await b.getState()).settings.mode === 'offline'],
  ['local model endpoint', (b) => b.saveSettings({localEndpoint: 'http://127.0.0.1:11999'}), async (b) => !(await b.getState()).settings.localEndpoint.includes('11999')],
  ['clipboard history', (b) => b.clipboardSetEnabled(true), async (b) => (await b.clipboardStatus()).enabled !== true],
  ['application timeline', (b) => b.productivityApply({op: 'policy.set', timelineEnabled: true}), async (b) => b.productivity.snapshot().policy.timelineEnabled === false],
  ['forget all project memory', (b) => b.productivityApply({op: 'forget', scope: 'all'}), null],
  ['forget chat history', (b) => b.productivityForgetHistory({chat: true}), async (b) => (await b.getState()).chat.length > 0],
];

for (const [label, confirm] of [['absent', undefined], ['declined', async () => false], ['failing', async () => { throw new Error('dialog failed'); }]]) {
  test(`approvals: with the trusted dialog ${label}, every sensitive change is refused and leaves state unchanged`, async () => {
    const f = await backend({confirm});
    try {
      await f.b.chat('keep this message');
      assert.ok((await f.b.getState()).chat.length > 0, 'fixture chat exists');
      for (const [name, act, unchanged] of SENSITIVE) {
        await assert.rejects(act(f.b), (e) => e instanceof Error, `${name} must be refused`);
        if (unchanged) assert.equal(await unchanged(f.b), true, `${name} changed state without approval`);
      }
      assert.ok(f.fetched.every((r) => !r.url.startsWith(CLOUD)), 'nothing reached the cloud');
      if (label !== 'absent') assert.ok(f.confirms.length >= SENSITIVE.length, 'each sensitive change asked the trusted dialog');
    } finally { await f.close(); }
  });
}

test('approvals: the online-mode dialog names the egress, and a granted dialog is required per widening, not remembered', async () => {
  let answer = true;
  const f = await backend({confirm: async () => answer});
  try {
    await f.b.saveSettings({mode: 'online'});
    assert.match(f.confirms.at(-1).detail, /online mode/i);
    assert.match(f.confirms.at(-1).detail, /cloud/i);
    await f.b.saveSettings({mode: 'offline'});
    answer = false;
    await assert.rejects(f.b.saveSettings({mode: 'online'}));
    assert.equal((await f.b.getState()).settings.mode, 'offline', 'an earlier approval must not carry over');
  } finally { await f.close(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Secret redaction: the one-shot (non-streaming) chat path. Streaming is status-only (substantial-streaming tests);
// Assistant with streaming off and Prompt tools still call api.chat().
// ---------------------------------------------------------------------------------------------------------------

test('cloud one-shot chat: a 401 says the key was rejected and the key is never stored or returned', async () => {
  const f = await onlineWithKey(async () => Response.json({error: {message: `invalid x-api-key ${KEY}`}}, {status: 401}));
  try {
    const reply = await f.b.chat('hello');
    assert.match(reply.text, /rejected the API key/);
    assert.equal(JSON.stringify(reply).includes(KEY), false);
    assert.equal(JSON.stringify(await f.b.getState()).includes(KEY), false);
  } finally { await f.close(); }
});

const echoCases = [
  ['HTTP 400 body', async (_u, init) => Response.json({error: {message: `bad header x-api-key: ${new Headers(init.headers).get('x-api-key')}`}}, {status: 400})],
  ['HTTP 502 proxy body', async () => Response.json({error: `upstream said Authorization: Bearer ${KEY}`}, {status: 502})],
  ['transport error', async () => { throw new Error(`socket hang up; request x-api-key=${KEY}`); }],
];
for (const [name, cloud] of echoCases) {
  test(`PS-01 cloud one-shot chat: provider/transport text (${name}) cannot carry the key into the reply or stored chat`, async () => {
    const f = await onlineWithKey(cloud);
    try {
      const reply = await f.b.chat('hello');
      assert.equal(reply.source, 'system');
      assert.equal(JSON.stringify(reply).includes(KEY), false, 'key in the returned reply');
      assert.equal(JSON.stringify(await f.b.getState()).includes(KEY), false, 'key in stored state');
    } finally { await f.close(); }
  });
}

test('PS-03 IPC error redaction also removes credential-shaped tokens, not only profile paths', () => {
  for (const msg of [`failed: x-api-key ${KEY}`, `Authorization: Bearer ${'A'.repeat(40)}`, 'token=ghp_' + 'b'.repeat(36)]) {
    const out = B.safeErrorMessage(new Error(msg));
    assert.equal(/sk-ant-[\w-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}|ghp_[A-Za-z0-9]{20,}/.test(out), false, out);
  }
});

test('IPC error redaction keeps profile-path redaction and the length bound', () => {
  const out = B.safeErrorMessage(new Error(`open C:\\Users\\Someone\\secret.txt ${'x'.repeat(2000)}`));
  assert.equal(out.includes('Someone'), false);
  assert.ok(out.length <= 400);
});

// ---------------------------------------------------------------------------------------------------------------
// Microphone consent (renderer audio.ts): the app's own consent gate must precede any device request.
// ---------------------------------------------------------------------------------------------------------------

function withNavigator(mediaDevices, fn) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {value: {mediaDevices}, configurable: true, writable: true});
  const hadRec = 'MediaRecorder' in globalThis;
  if (!hadRec) globalThis.MediaRecorder = class {};
  return Promise.resolve().then(fn).finally(() => {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
    if (!hadRec) delete globalThis.MediaRecorder;
  });
}

test('microphone: without in-app consent the recorder refuses before any getUserMedia call; consent is never implicit', async () => {
  const consent = AUDIO.createMicConsent(null);
  assert.equal(consent.granted(), false, 'fresh consent is not granted');
  let requests = 0;
  await withNavigator({getUserMedia: async () => { requests++; throw new Error('no device in review'); }}, async () => {
    const r = new AUDIO.ClipRecorder({consent});
    await assert.rejects(r.start(), AUDIO.MicConsentError);
    assert.equal(requests, 0, 'getUserMedia was called without consent');
    assert.equal(r.state, 'idle');
    consent.grant();
    await assert.rejects(r.start(), /no device in review/);
    assert.equal(requests, 1);
    assert.equal(r.state, 'idle', 'a failed device open returns to idle');
    consent.revoke();
    await assert.rejects(r.start(), AUDIO.MicConsentError);
    assert.equal(requests, 1);
  });
});

test('microphone: stored consent from another value or a broken store is not consent', () => {
  for (const v of ['true', 'yes', '0', '', null]) {
    const c = AUDIO.createMicConsent({getItem: () => v, setItem() {}, removeItem() {}});
    assert.equal(c.granted(), false, `stored ${JSON.stringify(v)} must not grant`);
  }
  const broken = AUDIO.createMicConsent({getItem: () => { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {}});
  assert.equal(broken.granted(), false);
});

test('PS-02 microphone: revoke() fails closed even when the consent store cannot remove the record', () => {
  const m = new Map();
  const c = AUDIO.createMicConsent({getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: () => { throw new Error('storage locked'); }});
  c.grant();
  assert.equal(c.granted(), true);
  c.revoke();
  assert.equal(c.granted(), false, 'consent is still reported as granted after revoke');
});

// ---------------------------------------------------------------------------------------------------------------
// Imports: every user-pasted/file/localStorage parser survives hostile input with bounded, finite, unpolluted output.
// Peer modules that are not present yet are listed by name in the skip reason (not counted as passing).
// ---------------------------------------------------------------------------------------------------------------

const P = await load(`
export * as avatar from './src/ui/avatar-editor';
export * as scene3d from './src/ui/scene3d';
export * as motion from './src/ui/motion-presets';
export * as timing from './src/ui/motion-timing';
export * as guidance from './src/ui/guidance';
export * as mods from './src/ui/mod-catalog';
export * as a11y from './src/ui/accessibility';
export * as portable from './electron/services/portable';
export {emptyProductivity} from './electron/services/store';
`);
const EMPTY_PROD = P.emptyProductivity();

const PARSERS = [
  ['avatar.parseAvatarPack', (x) => P.avatar.parseAvatarPack(x), 'both'],
  ['avatar.normalizeGeometry', (x) => P.avatar.normalizeGeometry(x), 'value'],
  ['avatar.normalizeExpression', (x) => P.avatar.normalizeExpression(x), 'value'],
  ['scene3d.parseSceneJson', (x) => P.scene3d.parseSceneJson(x), 'both'],
  ['scene3d.normalizeScene', (x) => P.scene3d.normalizeScene(x), 'value'],
  ['motion.parseScene', (x) => P.motion.parseScene(x), 'value'],
  ['motion.sceneFromText', (x) => P.motion.sceneFromText(x), 'text'],
  ['motion.parseLab', (x) => P.motion.parseLab(x), 'both'],
  ['motion.parseSavedPresets', (x) => P.motion.parseSavedPresets(x), 'value'],
  ['motion.parseSavedScenes', (x) => P.motion.parseSavedScenes(x), 'value'],
  ['motion.normalizeSettings', (x) => P.motion.normalizeSettings(x), 'value'],
  ['timing.normalizeTimeline', (x) => P.timing.normalizeTimeline(x), 'value'],
  ['guidance.parseGuidanceImport', (x) => P.guidance.parseGuidanceImport(x), 'text'],
  ['guidance.normalizeGuidancePrefs', (x) => P.guidance.normalizeGuidancePrefs(x), 'value'],
  ['mods.parseExport', (x) => P.mods.parseExport(x), 'both'],
  ['mods.normalizePrefs', (x) => P.mods.normalizePrefs(x), 'value'],
  ['a11y.normalizeAccessibilityPrefs', (x) => P.a11y.normalizeAccessibilityPrefs(x), 'value'],
  ['portable.parsePortable', (x) => P.portable.parsePortable(x, {prod: EMPTY_PROD, capsules: [{id: 'c_1', name: 'Fixture'}], noteIds: [], taskIds: []}), 'text'],
];

const POLLUTE = '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"version":1,"name":{"__proto__":{"polluted":"yes"}},"layers":[{"__proto__":{"polluted":"yes"}}],"widgets":[{"__proto__":{"polluted":"yes"}}]}';
const HOSTILE_TEXT = [
  ['prototype keys', POLLUTE],
  ['deep nesting', '['.repeat(50_000) + ']'.repeat(50_000)],
  ['8 MB string', '"' + 'a'.repeat(8 * 1024 * 1024) + '"'],
  ['200k-element array', '[' + Array(200_000).fill('{"name":"x","kind":"orb","value":1e308}').join(',') + ']'],
  ['non-finite numbers', '{"version":1,"name":"n","scale":1e400,"speed":-1e400,"layers":[{"kind":"orb","size":1e999}],"geometry":{"headWidth":1e999}}'],
  ['bidi/control text', JSON.stringify({version: 1, name: '\u202Eexe.txt\u0000\u001b[31m', title: '\u2066x\u2069'})],
  ['not JSON', 'javascript:alert(1)//<script>'],
];
const HOSTILE_VALUE = [
  ['prototype keys', JSON.parse(POLLUTE)],
  ['huge array', Array(200_000).fill({name: 'x', kind: 'orb', size: Number.NaN})],
  ['non-finite numbers', {version: 1, name: 'n', headWidth: Infinity, eyeSize: -Infinity, bodyHue: Number.NaN, fps: Infinity, layers: [{kind: 'orb', size: Number.NaN}], timeline: {frames: Infinity}}],
  ['wrong types', {version: '1', name: 42, layers: 'x', widgets: {length: 1e9}, marked: [1, 2], prefs: null}],
  ['long strings', {version: 1, name: 'n'.repeat(1_000_000), title: 't'.repeat(1_000_000)}],
  ['null', null],
  ['array root', [1, 2, 3]],
];

function inspect(value) {
  const stats = {bytes: 0, nonFinite: [], longest: 0, protoKeys: [], unsafeLinks: []};
  const seen = new Set();
  const walk = (v, at, depth) => {
    if (depth > 64) return;
    if (typeof v === 'number' && !Number.isFinite(v)) stats.nonFinite.push(at);
    else if (typeof v === 'string') stats.longest = Math.max(stats.longest, v.length);
    else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      if (![Object.prototype, Array.prototype, Map.prototype, Set.prototype, Date.prototype, null].includes(Object.getPrototypeOf(v)) && !(v instanceof Error)) stats.protoKeys.push(`${at} (prototype replaced)`);
      if (v instanceof Map || v instanceof Set) { let i = 0; for (const e of v) walk(e, `${at}[${i++}]`, depth + 1); }
      for (const k of Object.keys(v)) {
        if (/^(url|href|link|attach|location)$/i.test(k) && typeof v[k] === 'string' && /^\s*(javascript|file|vbscript|data):/i.test(v[k])) stats.unsafeLinks.push(`${at}.${k}`); if (k === '__proto__') stats.protoKeys.push(`${at}.__proto__`); walk(v[k], `${at}.${k}`, depth + 1); }
    }
  };
  walk(value, '$', 0);
  try { stats.bytes = JSON.stringify(value ?? null)?.length ?? 0; } catch { stats.bytes = Infinity; }
  return stats;
}

function sweep(parsers) {
  const failures = [];
  for (const [name, fn, kind] of parsers) {
    const inputs = [...(kind !== 'value' ? HOSTILE_TEXT.map(([l, v]) => [`text:${l}`, v]) : []), ...(kind !== 'text' ? HOSTILE_VALUE.map(([l, v]) => [`value:${l}`, v]) : [])];
    for (const [label, input] of inputs) {
      const t0 = performance.now();
      let out;
      try { out = fn(input); } catch (e) {
        // A deliberate validation error is acceptable; a stack overflow or a crash on a property access is not.
        if (e instanceof RangeError || e instanceof TypeError || !(e instanceof Error) || String(e.message).length > 500) failures.push(`${name} ${label}: threw ${e?.name}: ${String(e?.message).slice(0, 120)}`);
        continue;
      }
      const ms = performance.now() - t0;
      const s = inspect(out);
      if (ms > 1500) failures.push(`${name} ${label}: took ${Math.round(ms)} ms`);
      if (s.bytes > 1_000_000) failures.push(`${name} ${label}: ${s.bytes} bytes of output`);
      if (s.longest > 100_000) failures.push(`${name} ${label}: string of ${s.longest} chars kept`);
      if (s.nonFinite.length) failures.push(`${name} ${label}: non-finite numbers at ${s.nonFinite.slice(0, 3).join(', ')}`);
      if (s.protoKeys.length) failures.push(`${name} ${label}: ${s.protoKeys.slice(0, 3).join(', ')}`);
    }
  }
  return failures;
}

test('imports: every parser returns bounded, finite, prototype-safe results for hostile text and values', () => {
  // Canary: the sweep must catch a parser that keeps huge text, non-finite numbers, a replaced prototype or a stack overflow.
  const canary = sweep([['canary', (x) => (typeof x === 'string' && x.length > 1e6 ? {t: x} : Array.isArray(x) ? (() => { const f = () => f(); return f(); })() : Object.assign(Object.create({evil: 1}), {n: Infinity})), 'both']]);
  for (const re of [/string of \d+ chars kept/, /non-finite/, /prototype replaced/, /RangeError/]) assert.ok(canary.some((f) => re.test(f)), `sweep misses ${re}`);
  const failures = sweep(PARSERS);
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype was polluted');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(failures, []);
});

test('imports: the renderer-side portable memory parser refuses hostile reference targets in its preview', () => {
  const pasted = JSON.stringify({format: 'desktop-companion-memory', version: 1, exportedAt: '2026-10-01T00:00:00.000Z', capsules: [{name: 'Fixture', goals: [{text: 'valid goal'}],
    references: [{kind: 'url', label: 'js', target: 'javascript:alert(1)'}, {kind: 'file', label: 'unc', target: '\\\\host\\share\\x.lnk'}, {kind: 'url', label: 'ok', target: 'https://example.invalid/doc'}]}]});
  const r = P.portable.parsePortable(pasted, {prod: EMPTY_PROD, capsules: [{id: 'c_1', name: 'Fixture'}], noteIds: [], taskIds: []});
  assert.equal(r.ok, true, r.problems?.join('; '));
  const planned = JSON.stringify(r.ops ?? []);
  assert.ok(planned.includes('valid goal') && planned.includes('https://example.invalid/doc'), 'valid records still import beside hostile ones');
  assert.equal(r.counts.references, 1);
  assert.ok(r.problems.length >= 2, 'each refused reference is reported');
  assert.equal(planned.includes('javascript:'), false, 'javascript: reference planned');
  assert.equal(planned.includes('\\\\host'), false, 'UNC reference planned');
});

const CAL = existsSync(path.join(SRC, 'src/ui/calendar-import.ts')) ? await load(`export * from './src/ui/calendar-import';`) : null;
test('imports: the calendar ICS import preview (peer calendar-import) survives hostile ICS text', {skip: CAL ? false : `src/ui/calendar-import.ts not present in ${SRC} (peer jarvis-desktop-105 not integrated)`}, () => {
  assert.equal(typeof CAL.parseIcsForImport, 'function', 'calendar-import must export parseIcsForImport(text, {now})');
  const now = Date.UTC(2026, 9, 15, 12);
  const ics = (lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n');
  const ev = (i, extra = []) => ['BEGIN:VEVENT', `UID:${i}@review.invalid`, 'DTSTAMP:20261015T000000Z', 'DTSTART:20261015T090000Z', 'DTEND:20261015T100000Z', 'SUMMARY:x', ...extra, 'END:VEVENT'];
  const inputs = [
    ['50k events', ics(Array.from({length: 50_000}, (_, i) => ev(i)).flat())],
    ['secondly RRULE, huge COUNT', ics(ev(1, ['RRULE:FREQ=SECONDLY;COUNT=100000000']))],
    ['minutely RRULE, no end', ics(ev(2, ['RRULE:FREQ=MINUTELY;INTERVAL=1']))],
    ['4 MB summary', ics(ev(3, ['SUMMARY:' + 'a'.repeat(4_000_000)]))],
    ['hostile names and links', ics(ev(4, ['X-__proto__:1', '__proto__;constructor=x:1', 'DTSTART:99999999T999999Z', 'ATTACH;VALUE=URI:file:///C:/Users/x/a.lnk', 'URL:javascript:alert(1)']))],
    ['100k nested alarms', ics(['BEGIN:VEVENT', ...Array(100_000).fill('BEGIN:VALARM')])],
    ['deep folding', ics(ev(5, ['DESCRIPTION:a', ...Array(200_000).fill(' b')]))],
    ['NUL text', '\u0000'.repeat(1000)], ['empty', ''],
  ];
  // Not vacuous: a well-formed event still becomes exactly one reviewable candidate.
  const ok = CAL.parseIcsForImport(ics(ev('ok', ['SUMMARY:Review fixture'])), {now});
  assert.equal(ok.candidates?.length, 1, JSON.stringify(ok).slice(0, 300));
  const failures = [];
  for (const [label, input] of inputs) {
    const t0 = performance.now();
    let out;
    try { out = CAL.parseIcsForImport(input, {now}); } catch (e) { if (e instanceof RangeError || e instanceof TypeError || !(e instanceof Error)) failures.push(`${label}: ${e?.name}: ${String(e?.message).slice(0, 100)}`); continue; }
    const ms = performance.now() - t0, st = inspect(out);
    if (ms > 3000) failures.push(`${label}: took ${Math.round(ms)} ms`);
    if (st.bytes > 5_000_000) failures.push(`${label}: ${st.bytes} bytes of preview`);
    if (st.longest > 100_000) failures.push(`${label}: string of ${st.longest} chars kept`);
    if (st.nonFinite.length || st.protoKeys.length || st.unsafeLinks.length) failures.push(`${label}: ${[...st.nonFinite, ...st.protoKeys, ...st.unsafeLinks].slice(0, 3)}`);
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------------------------------------------
// Route truth: guidance links open real views and real Settings panels; hash parsing is closed over known views.
// ---------------------------------------------------------------------------------------------------------------

const R = await load(`export * as nav from './src/ui/nav'; export * as guidance from './src/ui/guidance'; export {searchSettings} from './src/components/Settings';`);

test('route truth: every guidance link targets a real view; every Settings query lands on at least one panel', () => {
  const bad = [];
  for (const id of R.guidance.GUIDE_TOPIC_IDS) {
    const def = R.guidance.topicDef(id);
    for (const link of def.links ?? []) {
      if (!R.nav.VIEW_IDS.includes(link.target.view)) bad.push(`${id}: unknown view ${link.target.view}`);
      if (link.target.view === 'settings' && link.target.params?.q && R.searchSettings(link.target.params.q).length === 0) bad.push(`${id}: Settings query "${link.target.params.q}" matches no panel`);
    }
  }
  assert.deepEqual(bad, []);
});

test('route truth: every view round-trips through the hash, and hostile hashes resolve to a known view with bounded params', () => {
  for (const v of R.nav.VIEW_IDS) assert.equal(R.nav.parseHash(R.nav.hashFor(v, {item: 'n_1'})).view, v);
  for (const h of ['#/__proto__', '#/constructor?__proto__=x', '#/../../etc', '#/settings?q=' + 'x'.repeat(100_000), 'javascript:alert(1)', '#//evil.invalid/notes']) {
    const loc = R.nav.parseHash(h);
    assert.ok(R.nav.VIEW_IDS.includes(loc.view), h.slice(0, 40));
    assert.equal(Object.getPrototypeOf(loc.params), Object.prototype);
    assert.ok(Object.values(loc.params).every((v) => v.length <= 200));
  }
  assert.equal({}.x, undefined);
});

test('route truth: App renders a screen for every navigable view', () => {
  const app = readFileSync(path.join(SRC, 'src/components/App.tsx'), 'utf8');
  const handled = new Set([...app.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  const missing = R.nav.VIEW_IDS.filter((v) => v !== 'home' && !handled.has(v));
  assert.deepEqual(missing, [], 'views without a case in App.tsx fall through to the default screen');
});

// ---------------------------------------------------------------------------------------------------------------
// Strict offline from the renderer: the bundled page makes no network calls of its own and the CSP keeps it local.
// ---------------------------------------------------------------------------------------------------------------

test('renderer: the bundled page has no Node built-ins, no network primitives, and the CSP allows only the app origin', async () => {
  const nodeImports = [];
  const out = await build({entryPoints: [path.join(SRC, 'src', 'main.tsx')], bundle: true, write: false, platform: 'browser', format: 'esm', jsx: 'automatic', logLevel: 'silent', minify: false,
    loader: {'.css': 'empty', '.png': 'empty', '.svg': 'empty', '.woff2': 'empty'}, nodePaths: [path.join(root, 'node_modules')], define: {'process.env.NODE_ENV': '"production"'},
    plugins: [{name: 'node-free', setup(b) {
      b.onResolve({filter: /^(node:|electron$|(fs|path|os|crypto|child_process|net|http|https|tls|dgram|dns|zlib|worker_threads)(\/.*)?$)/}, (a) => { nodeImports.push(`${a.path} <- ${path.relative(SRC, a.importer)}`); return {path: a.path, external: true}; });
    }}]});
  assert.deepEqual(nodeImports, [], 'renderer imports Node/Electron modules');
  const text = out.outputFiles[0].text;
  const hits = [];
  for (const [label, re] of [['fetch()', /(?<![\w.$])fetch\s*\(/g], ['WebSocket', /new\s+WebSocket\s*\(/g], ['EventSource', /new\s+EventSource\s*\(/g], ['sendBeacon', /\.sendBeacon\s*\(/g],
    ['XMLHttpRequest', /new\s+XMLHttpRequest\s*\(/g], ['remote import()', /import\(\s*["'`]https?:/g], ['RTCPeerConnection', /new\s+RTCPeerConnection\s*\(/g]]) {
    const n = (text.match(re) ?? []).length;
    if (n) hits.push(`${label} x${n}`);
  }
  assert.deepEqual(hits, [], 'renderer contains network primitives; all egress must go through the main-process guard');
  const csp = /Content-Security-Policy"\s+content="([^"]+)"/.exec(readFileSync(path.join(SRC, 'index.html'), 'utf8'))?.[1] ?? '';
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dir['default-src'], ["'self'"]);
  assert.deepEqual(dir['connect-src'], ["'self'"]);
  assert.ok(dir['script-src']?.every((s) => s === "'self'"), `script-src ${dir['script-src']}`);
  for (const [k, v] of Object.entries(dir)) assert.ok(!v.some((s) => s === '*' || /^https?:/.test(s) || s === "'unsafe-eval'"), `${k} allows ${v.join(' ')}`);
});
