// Model version/digest pins (goal 17) and pin verification (goal 19, verification half): pure pin helpers, the streaming
// cancellable SHA-256 digest, persisted pins, verify/mismatch, the blocked model switch, re-pin, the bridge and the Models
// screen wiring. Real TypeScript bundled in memory. Temp fixture files only; no network, no Ollama, no user files.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {promises as fs, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (f) => readFileSync(path.join(root, f), 'utf8');

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'slice-model-pins-entry.ts',
    loader: 'ts',
    contents: `
      export * as pins from './src/ui/model-pins.ts';
      export * as models from './electron/services/models.ts';
      export { modelPinsBridge, createModelPinsApi, MODEL_PIN_API_KEYS } from './src/ui/bridges.ts';
      export { MODEL_PIN_METHODS, MODEL_PIN_ARITY, MODEL_PINS_GLOBAL, METHODS, channel } from './electron/channels.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const {pins: P, models: M, modelPinsBridge, createModelPinsApi, MODEL_PIN_API_KEYS, MODEL_PIN_METHODS, MODEL_PIN_ARITY, MODEL_PINS_GLOBAL, METHODS, channel} = mod;

// Known SHA-256 test vectors.
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64);
const AT = '2026-01-02T03:04:05.000Z';
const pin = (over = {}) => ({modelId: 'tiny:1b', label: 'Tiny', digest: D1, sizeBytes: 3, pinnedAt: AT, source: 'local-file', ...over});

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-model-pins-'));
test.after(async () => { await fs.rm(scratch, {recursive: true, force: true}); });

/** Cross-platform scope check for tests (production uses resolveInsideRoots on local drive paths). */
const resolveFile = async (f, roots) => {
  const real = path.resolve(f);
  const inside = roots.some((r) => real === path.resolve(r) || real.startsWith(path.resolve(r) + path.sep));
  if (!inside) return {ok: false, reason: 'Target is outside the allowed folders'};
  try { await fs.stat(real); } catch { return {ok: false, reason: 'Target does not exist'}; }
  return {ok: true, path: real, isDirectory: false};
};

async function fixtureModel(name, bytes) {
  const dir = path.join(scratch, name);
  await fs.mkdir(dir, {recursive: true});
  const file = path.join(dir, 'model.gguf');
  await fs.writeFile(file, bytes);
  return {dir, file};
}

function service({registry = new M.PackPathRegistry(), storage = M.memoryPinStorage(), digest} = {}) {
  return {registry, storage, svc: new M.ModelPinService({storage, packPaths: registry, resolveFile, modelRoots: () => [], now: () => Date.parse(AT), ...(digest ? {digest} : {})})};
}

// ---------- pure helpers ----------

test('PIN_LIMITS is frozen with the documented bounds', () => {
  assert.ok(Object.isFrozen(P.PIN_LIMITS));
  assert.equal(P.PIN_LIMITS.maxPins, 64);
  assert.equal(P.PIN_LIMITS.digestHexLength, 64);
  assert.equal(P.PIN_LIMITS.labelMin, 1);
  assert.equal(P.PIN_LIMITS.labelMax, 80);
});

test('normalizePins drops malformed entries, dedupes model ids, lowercases digests and caps the list', () => {
  const raw = [
    pin({digest: D1.toUpperCase()}),
    pin({label: 'dupe'}),
    pin({modelId: 'x:1', digest: 'abc'}),
    pin({modelId: 'x:2', label: ''}),
    pin({modelId: 'x:3', sizeBytes: -1}),
    pin({modelId: 'x:4', pinnedAt: 'yesterday'}),
    pin({modelId: 'x:5', source: 'internet'}),
    null, 'pin', 42,
    pin({modelId: 'ok:2', source: 'manifest'}),
  ];
  const n = P.normalizePins(raw);
  assert.deepEqual(n.map((p) => p.modelId), ['tiny:1b', 'ok:2']);
  assert.equal(n[0].digest, D1);
  assert.equal(n[0].label, 'Tiny');
  assert.deepEqual(P.normalizePins('nope'), []);
  const many = Array.from({length: 70}, (_, i) => pin({modelId: `m${i}:1`}));
  assert.equal(P.normalizePins(many).length, 64);
});

test('upsertPin and removePin return new arrays and never mutate their input', () => {
  const a = Object.freeze([Object.freeze(pin())]);
  const b = P.upsertPin(a, pin({modelId: 'other:2', digest: D2}));
  assert.notEqual(b, a);
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  const c = P.upsertPin(b, pin({digest: D2, label: 'Tiny v2'}));
  assert.equal(c.length, 2);
  assert.equal(c[0].digest, D2);
  assert.equal(b[0].digest, D1, 'replacing returns a copy');
  const d = P.removePin(c, 'TINY:1B');
  assert.deepEqual(d.map((p) => p.modelId), ['other:2']);
  assert.equal(c.length, 2);
  const full = Array.from({length: 64}, (_, i) => pin({modelId: `m${i}:1`}));
  assert.throws(() => P.upsertPin(full, pin({modelId: 'one-more:1'})), /At most 64 model pins/);
  assert.equal(P.upsertPin(full, pin({modelId: 'm3:1', digest: D2})).length, 64, 'replacing still works when full');
});

test('invalid digest format and empty label are rejected with descriptive errors', () => {
  assert.throws(() => P.createPin(pin({digest: 'xyz'})), /64-character SHA-256 hex/);
  assert.throws(() => P.createPin(pin({digest: D1 + 'a'})), /64-character SHA-256 hex/);
  assert.throws(() => P.upsertPin([], pin({digest: 'g'.repeat(64)})), /64-character SHA-256 hex/);
  assert.throws(() => P.createPin(pin({label: '   '})), /label must be 1-80/);
  assert.throws(() => P.createPin(pin({label: 'x'.repeat(81)})), /label must be 1-80/);
  assert.throws(() => P.comparePin(pin(), {digest: 'nope', sizeBytes: 3}), /64-character SHA-256 hex/);
});

test('comparePin reports match, size-mismatch, digest-mismatch and unpinned; describePinStatus has text for each', () => {
  assert.equal(P.comparePin(pin(), {digest: D1, sizeBytes: 3}).status, 'match');
  const size = P.comparePin(pin(), {digest: D2, sizeBytes: 4});
  assert.equal(size.status, 'size-mismatch');
  assert.match(size.detail, /pinned 3 bytes, now 4 bytes/);
  const dig = P.comparePin(pin(), {digest: D2, sizeBytes: 3});
  assert.equal(dig.status, 'digest-mismatch');
  assert.match(dig.detail, /aaaaaaaaaaaa.*bbbbbbbbbbbb/);
  assert.equal(P.comparePin(null, {digest: D1, sizeBytes: 3}).status, 'unpinned');
  for (const s of ['match', 'size-mismatch', 'digest-mismatch', 'unpinned']) assert.ok(P.describePinStatus(s).length > 3, s);
  assert.equal(P.isPinMismatch('match'), false);
  assert.equal(P.isPinMismatch('digest-mismatch'), true);
});

// ---------- streaming digest ----------

test('digestFile streams SHA-256 of a fixture file (known vectors)', async () => {
  const {file} = await fixtureModel('vec', Buffer.from('abc'));
  assert.deepEqual(await M.digestFile(file, {maxBytes: 1024}), {digest: SHA_ABC, sizeBytes: 3});
  const empty = path.join(scratch, 'vec', 'empty.gguf');
  await fs.writeFile(empty, '');
  assert.deepEqual(await M.digestFile(empty, {maxBytes: 1024}), {digest: SHA_EMPTY, sizeBytes: 0});
});

test('digestFile: AbortSignal cancels, a missing file is "not found", an oversize file is refused', async () => {
  const {file} = await fixtureModel('cancel', Buffer.alloc(4 * 1024 * 1024, 7));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(M.digestFile(file, {signal: pre.signal, maxBytes: 1 << 30}), (e) => e.code === 'cancelled' && /cancelled/.test(e.message));
  const ac = new AbortController();
  const running = M.digestFile(file, {signal: ac.signal, maxBytes: 1 << 30});
  ac.abort();
  await assert.rejects(running, (e) => e.code === 'cancelled' && /cancelled/.test(e.message));
  await assert.rejects(M.digestFile(path.join(scratch, 'nope', 'missing.gguf'), {maxBytes: 1024}), (e) => e.code === 'not-found' && /not found/.test(e.message));
  await assert.rejects(M.digestFile(file, {maxBytes: 1024}), (e) => e.code === 'too-large' && /larger than the digest limit/.test(e.message));
  await assert.rejects(M.digestFile(file, {maxBytes: 0}), (e) => e.code === 'too-large');
});

// ---------- pin service: persist, verify, mismatch, re-pin ----------

test('pinCurrent hashes the known pack file, persists the pin, and verify detects a changed file', async () => {
  const {dir, file} = await fixtureModel('tiny', Buffer.from('abc'));
  const {registry, storage, svc} = service();
  registry.record('tiny:1b', dir, file);
  const r = await svc.pinCurrent('tiny:1b');
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.pin.digest, SHA_ABC);
  assert.equal(r.pin.sizeBytes, 3);
  assert.equal(r.pin.source, 'local-file');
  assert.equal(r.pin.pinnedAt, AT);
  assert.match(storage.text, /desktop-companion-model-pins/);

  // A fresh service (restart) reads the persisted pin and the stored file reference, even without the registry entry.
  const again = new M.ModelPinService({storage, packPaths: new M.PackPathRegistry(), resolveFile, now: () => Date.parse(AT)});
  assert.deepEqual((await again.list()).map((p) => p.digest), [SHA_ABC]);
  const ok = await again.verify('tiny:1b');
  assert.equal(ok.status, 'match');
  assert.deepEqual(ok.observed, {digest: SHA_ABC, sizeBytes: 3});

  await fs.writeFile(file, 'abd');
  const changed = await again.verify('tiny:1b');
  assert.equal(changed.status, 'digest-mismatch');
  assert.match(changed.detail, /contents changed/);
  await fs.writeFile(file, 'abcd');
  assert.equal((await again.verify('tiny:1b')).status, 'size-mismatch');

  const unpinned = await again.verify('other:1');
  assert.equal(unpinned.status, 'unpinned');
  assert.equal(unpinned.observed, null);
});

test('a pinned model whose file changed is blocked from switching; re-pin after review unblocks it; unpin removes the check', async () => {
  const {dir, file} = await fixtureModel('switch', Buffer.from('abc'));
  const {registry, svc} = service();
  registry.record('tiny:1b', dir, file);
  assert.equal((await svc.pinCurrent('tiny:1b', 'Tiny reviewed')).ok, true);
  const calls = [];
  const runtime = new M.ModelRuntime({
    newId: () => 'job', settings: () => ({mode: 'offline', localEndpoint: 'http://127.0.0.1:11434', localModel: 'other:1'}),
    packPaths: registry, pinGate: (name) => svc.gate(name),
    fetch: async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({models: [{name: 'tiny:1b', size: 3}]}), {status: 200});
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify({models: []}), {status: 200});
      return new Response('{}', {status: 200});
    },
  });
  assert.equal((await runtime.select('tiny:1b', {unloadOthers: true})).ok, true, 'matching pin does not block');

  await fs.writeFile(file, 'xyz');
  calls.length = 0;
  const blocked = await runtime.select('tiny:1b', {warm: true, unloadOthers: true});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.status, 'digest-mismatch');
  assert.match(blocked.reason, /Blocked by version pin/);
  assert.equal('patch' in blocked, false, 'no settings patch is returned');
  assert.deepEqual(calls, ['GET /api/tags'], 'nothing is warmed or unloaded when blocked');

  const re = await svc.acknowledgeRepin('tiny:1b');
  assert.equal(re.ok, true, re.reason);
  assert.notEqual(re.pin.digest, SHA_ABC);
  assert.equal(re.pin.label, 'Tiny reviewed', 're-pin keeps the label');
  assert.equal(await svc.gate('tiny:1b'), null);
  assert.equal((await runtime.select('tiny:1b')).ok, true);

  await fs.rm(file);
  const missing = await svc.gate('tiny:1b');
  assert.equal(missing.blocked, true, 'a pinned file that cannot be verified fails closed');
  assert.equal(missing.status, 'unverified');
  assert.match(missing.detail, /not found/);

  assert.deepEqual((await svc.unpin('tiny:1b')).pins, []);
  assert.equal(await svc.gate('tiny:1b'), null);
  assert.equal((await svc.acknowledgeRepin('tiny:1b')).ok, false);
});

test('pins only hash known files inside known folders; unknown models and bad input are refused', async () => {
  const {svc, registry} = service();
  const r = await svc.pinCurrent('unknown:1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /No local model file is known/);
  const {file} = await fixtureModel('outside', Buffer.from('abc'));
  registry.record('stray:1', path.join(scratch, 'somewhere-else'), file);
  const stray = await svc.pinCurrent('stray:1');
  assert.equal(stray.ok, false);
  assert.match(stray.reason, /not inside a known model folder/);
  const txt = path.join(scratch, 'outside', 'notes.txt');
  await fs.writeFile(txt, 'x');
  registry.record('txt:1', path.join(scratch, 'outside'), txt);
  assert.match((await svc.pinCurrent('txt:1')).reason, /Only \.gguf/);
  await assert.rejects(svc.verify('../etc/passwd'), /Model name is invalid/);
  await assert.rejects(svc.pinCurrent('tiny:1b', ''.padEnd(81, 'x')), /label must be 1-80/);
});

test('cancelVerify aborts a running verification with a cancelled error', async () => {
  const {dir, file} = await fixtureModel('slow', Buffer.from('abc'));
  let started;
  const begun = new Promise((r) => { started = r; });
  const digest = (p, {signal}) => new Promise((_, reject) => {
    started();
    signal.addEventListener('abort', () => reject(new M.DigestError('cancelled', 'Digest cancelled: the check was stopped before it finished')));
  });
  const storage = M.memoryPinStorage(JSON.stringify({format: M.PIN_STORE_FORMAT, version: 1, pins: [pin({digest: SHA_ABC})], files: {'tiny:1b': {dir, file}}}));
  const {svc} = service({storage, digest});
  assert.equal(svc.cancelVerify('tiny:1b'), false, 'nothing running yet');
  const running = svc.verify('tiny:1b');
  await begun;
  assert.equal(svc.cancelVerify('tiny:1b'), true);
  await assert.rejects(running, /cancelled/);
  assert.equal(svc.cancelVerify(), false);
});

test('a corrupt or foreign pin file loads as empty instead of failing', async () => {
  for (const text of ['{not json', JSON.stringify({format: 'other', version: 1, pins: [pin()]}), JSON.stringify({format: M.PIN_STORE_FORMAT, version: 2, pins: [pin()]})]) {
    const {svc} = service({storage: M.memoryPinStorage(text)});
    assert.deepEqual(await svc.list(), []);
  }
});

test('Models.tsx still bundles in memory without a CSS loader (pin stylesheet is linked, not imported)', async () => {
  const ICONS = ['ArrowClockwise', 'Cube', 'DownloadSimple', 'Eject', 'FolderOpen', 'ShieldCheck', 'Stop', 'CircleNotch', 'Info', 'Warning', 'WarningCircle'];
  try {
    await build({stdin: {resolveDir: root, sourcefile: 'probe.ts', loader: 'tsx', contents: `export { ModelsView } from './src/components/Models.tsx';`}, bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
      plugins: [{name: 'icon-stub', setup(b) { b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'})); b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n')})); }}]});
  } catch (e) { assert.fail(String(e.message).slice(0, 600)); }
});

// ---------- channels, bridge, UI wiring ----------

test('pin channels are separate from METHODS and the bridge forwards only given arguments', async () => {
  assert.deepEqual([...MODEL_PIN_METHODS], ['modelPinsList', 'modelPinsPinCurrent', 'modelPinsUnpin', 'modelPinsVerify', 'modelPinsCancelVerify', 'modelPinsAcknowledgeRepin']);
  for (const m of MODEL_PIN_METHODS) {
    assert.ok(!METHODS.includes(m), m);
    assert.equal(typeof MODEL_PIN_ARITY[m], 'number');
    assert.match(channel(m), /^jarvis:modelPins/);
  }
  assert.equal(MODEL_PINS_GLOBAL, 'jarvisModelPins');
  const sent = [];
  const api = createModelPinsApi(async (m, ...a) => { sent.push([m, ...a]); return m === 'modelPinsList' ? [] : {ok: true}; });
  await api.list(); await api.pinCurrent('tiny:1b'); await api.pinCurrent('tiny:1b', 'L'); await api.cancelVerify(); await api.cancelVerify('tiny:1b'); await api.verify('tiny:1b'); await api.unpin('tiny:1b'); await api.acknowledgeRepin('tiny:1b');
  assert.deepEqual(sent, [['modelPinsList'], ['modelPinsPinCurrent', 'tiny:1b'], ['modelPinsPinCurrent', 'tiny:1b', 'L'], ['modelPinsCancelVerify'], ['modelPinsCancelVerify', 'tiny:1b'], ['modelPinsVerify', 'tiny:1b'], ['modelPinsUnpin', 'tiny:1b'], ['modelPinsAcknowledgeRepin', 'tiny:1b']]);
  assert.equal(modelPinsBridge(null), null);
  assert.equal(modelPinsBridge({list: async () => []}), null);
  assert.ok(modelPinsBridge(api));
  assert.deepEqual([...MODEL_PIN_API_KEYS].sort(), Object.keys(api).sort());
});

test('IPC, preload and contracts wiring keep the guard and add only new surface', () => {
  const ipc = read('electron/ipc.ts');
  assert.match(ipc, /isTrustedUrl\(senderUrl, opts\.appFileUrl, opts\.devOrigin\)/);
  assert.match(ipc, /pinArgProblem\(m, args\)/);
  assert.match(ipc, /withPinGate\(handlers, pins\)/);
  assert.match(ipc, /pins\.gate\(name\)/);
  assert.match(ipc, /pins: ModelPinService \| null = null\): \(\) => void/, 'pins are opt-in: the default handler table stays one handler per METHODS entry');
  assert.match(ipc, /export function createDefaultPinService\(\)/);
  const preload = read('electron/preload.ts');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('jarvisHost', jarvisHost\)/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(MODEL_PINS_GLOBAL, createModelPinsApi\(/);
  const contracts = read('src/shared/contracts.ts');
  assert.match(contracts, /export type PinVerifyResult=/);
  assert.match(contracts, /export interface ModelPinsAPI\{/);
  assert.match(contracts, /jarvisModelPins\?:Partial<ModelPinsAPI>/);
});

test('Models.tsx renders the Version pin section with honest status text', async () => {
  const src = read('src/components/Models.tsx');
  for (const s of ["new URL('../styles/model-pins.css', import.meta.url)", 'useModelPinStyles();', 'modelPinsBridge(', 'Version pin', 'Pin current file', 'Unpin', 'Re-pin after review', 'Cancel', 'Switch refused', 'client.cancelVerify(modelId)', 'client.acknowledgeRepin(modelId)', 'unverified']) {
    assert.ok(src.includes(s), s);
  }
  assert.ok(read('src/styles/model-pins.css').includes('.model-pin'));

  const iconNames = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) m[1].split(',').map((n) => n.trim()).filter(Boolean).forEach((n) => iconNames.add(n));
  for (const m of read('src/ui/primitives.tsx').matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) m[1].split(',').map((n) => n.trim().replace(/^type\s+.*/, '').replace(/\s+as\s+.*/, '')).filter(Boolean).forEach((n) => iconNames.add(n));
  const ui = await build({
    stdin: {resolveDir: root, loader: 'tsx', contents: `export { ModelPinSection, PIN_SIZING_NOTE } from './src/components/Models.tsx';`},
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react-dom'], loader: {'.css': 'empty'},
    plugins: [{name: 'icons', setup(b) {
      b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icons'}));
      b.onLoad({filter: /.*/, namespace: 'icons'}, () => ({contents: [...iconNames].map((n) => `export const ${n}=()=>null;`).join('\n')}));
    }}],
  });
  const cm = {exports: {}};
  new Function('require', 'module', 'exports', ui.outputFiles[0].text)(require, cm, cm.exports);
  const {createElement} = require('react');
  const {renderToStaticMarkup} = require('react-dom/server');
  const client = {list: async () => [], pinCurrent: async () => ({ok: false, reason: 'x'}), unpin: async () => ({ok: true, pins: []}), verify: async () => ({}), cancelVerify: async () => false, acknowledgeRepin: async () => ({ok: false, reason: 'x'})};
  const unpinned = renderToStaticMarkup(createElement(cm.exports.ModelPinSection, {modelId: 'tiny:1b', client, pin: null, disabled: false, onChanged: () => {}}));
  assert.match(unpinned, /Version pin/);
  assert.match(unpinned, /Not pinned/);
  assert.match(unpinned, /Pin current file/);
  assert.match(unpinned, /sizing gate: unverified/);
  const pinned = renderToStaticMarkup(createElement(cm.exports.ModelPinSection, {modelId: 'tiny:1b', client, pin: pin({digest: SHA_ABC}), disabled: false, blocked: 'Blocked by version pin: changed', onChanged: () => {}}));
  assert.match(pinned, /Pinned sha256/);
  assert.match(pinned, /ba7816bf8f01/);
  assert.match(pinned, /Unpin/);
  assert.match(pinned, /Verify/);
  assert.match(pinned, /Switch refused: Blocked by version pin/);
});
