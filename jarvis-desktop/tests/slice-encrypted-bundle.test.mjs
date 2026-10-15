import test, {before} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(entry) {
  const bundle = await build({entryPoints:[path.join(root, entry)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  const code = bundle.outputFiles[0].text;
  return {code, m: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)};
}
let m = {};
try {
  ({m} = await load('src/ui/encrypted-bundle.ts'));
} catch (e) {
  test('encrypted-bundle module loads', () => assert.fail(`load failed: ${e && (e.stack || e.message || e)}`));
}
const {BUNDLE_FORMAT, BUNDLE_VERSION, BUNDLE_LIMITS, encryptBundle, parseBundle, decryptBundle, serializeBundle, summarizePlaintext, decodeBase64, encodeBase64} = m;

const PASS = 'correct horse battery staple';
const NOW = '2026-03-04T05:06:07.000Z';
const PLAIN = JSON.stringify({notes:[{id:1, text:'café 東京 🚀 naïve'}, {id:2, text:'ok'}], tasks:[{id:'t'}], capsules:[], checkpoints:[1, 2, 3], meta:{v:1}});
let base, baseJson;
before(async () => {
  base = await encryptBundle(PLAIN, PASS, {now:NOW, label:'Laptop'});
  baseJson = serializeBundle(base);
});
const mutate = (fn) => { const o = structuredClone(base); fn(o); return JSON.stringify(o); };
const flip = (b64, at) => { const bytes = decodeBase64(b64); bytes[at] ^= 0x01; return encodeBase64(bytes); };

test('envelope shape: format, version, PBKDF2/AES-GCM parameters and byte lengths', async () => {
  assert.equal(BUNDLE_FORMAT, 'desktop-companion-encrypted-bundle');
  assert.equal(BUNDLE_VERSION, 1);
  assert.deepEqual({...BUNDLE_LIMITS}, {plaintextChars:4_000_000, passphraseMin:12, pbkdf2Iterations:310000});
  assert.equal(base.format, BUNDLE_FORMAT);
  assert.equal(base.version, 1);
  assert.equal(base.createdAt, NOW);
  assert.equal(base.label, 'Laptop');
  assert.equal(base.kdf.name, 'PBKDF2');
  assert.equal(base.kdf.hash, 'SHA-256');
  assert.equal(base.kdf.iterations, 310000);
  assert.equal(decodeBase64(base.kdf.salt).length, 16);
  assert.equal(base.cipher.name, 'AES-GCM');
  assert.equal(decodeBase64(base.cipher.iv).length, 12);
  assert.ok(!baseJson.includes('café') && !baseJson.includes('notes'), 'plaintext is not visible in the bundle');
  const other = await encryptBundle(PLAIN, PASS, {now:NOW});
  assert.notEqual(other.kdf.salt, base.kdf.salt, 'fresh salt each time');
  assert.notEqual(other.ciphertext, base.ciphertext);
  assert.equal(other.label, null);
});

test('encrypt -> serialize -> parse -> decrypt round trip preserves unicode exactly', async () => {
  const p = parseBundle(baseJson);
  assert.equal(p.ok, true);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.envelope, base);
  const r = await decryptBundle(p.envelope, PASS);
  assert.deepEqual(r, {ok:true, plaintext:PLAIN});
  const fromText = await decryptBundle(baseJson, PASS);
  assert.equal(fromText.ok, true);
  const plain = 'just text, not JSON: ü ß 🙂';
  const r2 = await decryptBundle(await encryptBundle(plain, 'another long passphrase'), 'another long passphrase');
  assert.deepEqual(r2, {ok:true, plaintext:plain});
});

test('wrong passphrase returns bad-passphrase without throwing', async () => {
  assert.deepEqual(await decryptBundle(base, 'wrong passphrase entirely'), {ok:false, reason:'bad-passphrase'});
  assert.deepEqual(await decryptBundle(base, ''), {ok:false, reason:'bad-passphrase'});
  assert.deepEqual(await decryptBundle(base, PASS + ' '), {ok:false, reason:'bad-passphrase'});
});

test('tampered ciphertext or authenticated header gives corrupt; malformed envelopes give corrupt', async () => {
  const ct = structuredClone(base); ct.ciphertext = flip(base.ciphertext, 3);
  assert.deepEqual(await decryptBundle(ct, PASS), {ok:false, reason:'corrupt'});
  const tag = structuredClone(base); tag.ciphertext = flip(base.ciphertext, decodeBase64(base.ciphertext).length - 1);
  assert.deepEqual(await decryptBundle(tag, PASS), {ok:false, reason:'corrupt'});
  const label = structuredClone(base); label.label = 'Desktop';
  assert.deepEqual(await decryptBundle(label, PASS), {ok:false, reason:'corrupt'}, 'label is bound as additional data');
  const created = structuredClone(base); created.createdAt = '2027-01-01T00:00:00.000Z';
  assert.deepEqual(await decryptBundle(created, PASS), {ok:false, reason:'corrupt'});
  const iv = structuredClone(base); iv.cipher.iv = flip(base.cipher.iv, 0);
  assert.deepEqual(await decryptBundle(iv, PASS), {ok:false, reason:'corrupt'});
  assert.deepEqual(await decryptBundle({format:'nope'}, PASS), {ok:false, reason:'corrupt'});
  assert.deepEqual(await decryptBundle('not json', PASS), {ok:false, reason:'corrupt'});
  assert.deepEqual(await decryptBundle(null, PASS), {ok:false, reason:'corrupt'});
});

test('parseBundle rejects every malformed field with an exact $-path', () => {
  const errs = (json) => { const r = parseBundle(json); assert.equal(r.ok, false); assert.equal(r.envelope, null); return r.errors; };
  assert.deepEqual(errs(42), ['$: expected JSON text']);
  assert.deepEqual(errs('{oops'), ['$: not valid JSON']);
  assert.deepEqual(errs('[]'), ['$: expected a JSON object']);
  assert.deepEqual(errs(mutate((o) => { o.format = 'other'; })), ['$.format: expected "desktop-companion-encrypted-bundle"']);
  assert.deepEqual(errs(mutate((o) => { o.version = 2; })), ['$.version: expected 1']);
  assert.deepEqual(errs(mutate((o) => { o.createdAt = 'yesterday'; })), ['$.createdAt: expected an ISO timestamp']);
  assert.deepEqual(errs(mutate((o) => { o.label = 5; })), ['$.label: expected null or a string of at most 120 characters']);
  assert.deepEqual(errs(mutate((o) => { o.kdf = 'x'; })), ['$.kdf: expected an object']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.name = 'scrypt'; })), ['$.kdf.name: expected "PBKDF2"']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.hash = 'SHA-1'; })), ['$.kdf.hash: expected "SHA-256"']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.iterations = '310000'; })), ['$.kdf.iterations: expected an integer']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.iterations = 1.5; })), ['$.kdf.iterations: expected an integer']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.salt = encodeBase64(new Uint8Array(8)); })), ['$.kdf.salt: expected 16 bytes, got 8']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.salt = 'not base64!!'; })), ['$.kdf.salt: not strict base64']);
  assert.deepEqual(errs(mutate((o) => { o.kdf.salt = 7; })), ['$.kdf.salt: expected a base64 string']);
  assert.deepEqual(errs(mutate((o) => { o.cipher = null; })), ['$.cipher: expected an object']);
  assert.deepEqual(errs(mutate((o) => { o.cipher.name = 'AES-CBC'; })), ['$.cipher.name: expected "AES-GCM"']);
  assert.deepEqual(errs(mutate((o) => { o.cipher.iv = encodeBase64(new Uint8Array(16)); })), ['$.cipher.iv: expected 12 bytes, got 16']);
  assert.deepEqual(errs(mutate((o) => { o.ciphertext = 42; })), ['$.ciphertext: expected a base64 string']);
  assert.deepEqual(errs(mutate((o) => { o.ciphertext = o.ciphertext.slice(0, -4) + ' ' + o.ciphertext.slice(-3); })), ['$.ciphertext: not strict base64']);
  assert.deepEqual(errs(mutate((o) => { o.ciphertext = 'QUJD'; })), ['$.ciphertext: too short (3 bytes) to hold data and the 16-byte tag']);
  // Strict base64: unpadded and non-canonical trailing bits are rejected.
  assert.equal(decodeBase64('QQ'), null);
  assert.equal(decodeBase64('QR=='), null);
  assert.deepEqual([...decodeBase64('QQ==')], [65]);
  // Several problems are all reported.
  assert.deepEqual(errs(mutate((o) => { o.format = 'x'; o.version = 9; })), ['$.format: expected "desktop-companion-encrypted-bundle"', '$.version: expected 1']);
});

test('iterations below the 310000 minimum (or absurdly high) are rejected', () => {
  const low = parseBundle(mutate((o) => { o.kdf.iterations = 1000; }));
  assert.equal(low.ok, false);
  assert.deepEqual(low.errors, ['$.kdf.iterations: 1000 is below the minimum of 310000']);
  const edge = parseBundle(mutate((o) => { o.kdf.iterations = 309999; }));
  assert.match(edge.errors[0], /below the minimum/);
  const high = parseBundle(mutate((o) => { o.kdf.iterations = 1e9; }));
  assert.match(high.errors[0], /^\$\.kdf\.iterations: .*above the maximum/);
});

test('oversize bundle text and ciphertext are rejected before decoding', () => {
  const huge = parseBundle(' '.repeat(m.BUNDLE_JSON_MAX + 1));
  assert.equal(huge.ok, false);
  assert.match(huge.errors[0], /^\$: bundle is \d+ characters; the limit is \d+$/);
  const big = parseBundle(mutate((o) => { o.ciphertext = 'A'.repeat(m.BUNDLE_CIPHERTEXT_B64_MAX + 4); }));
  assert.match(big.errors[0], /^\$\.ciphertext: longer than \d+ characters$/);
});

test('unknown keys produce path warnings but do not block decryption', async () => {
  const r = parseBundle(mutate((o) => { o.extra = 1; o.kdf.pepper = 'x'; o.cipher.mode = 'y'; }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['$.extra: unknown key ignored', '$.kdf.pepper: unknown key ignored', '$.cipher.mode: unknown key ignored']);
  assert.equal('extra' in r.envelope, false);
  assert.deepEqual(await decryptBundle(r.envelope, PASS), {ok:true, plaintext:PLAIN});
});

test('short passphrase, empty or oversize plaintext, invalid now and bad label throw descriptive errors', async () => {
  await assert.rejects(encryptBundle('data', 'short'), /passphrase must be at least 12 characters/);
  await assert.rejects(encryptBundle('data', 'x'.repeat(11)), /at least 12/);
  await assert.rejects(encryptBundle('', PASS), /plaintext is empty/);
  await assert.rejects(encryptBundle('x'.repeat(4_000_001), PASS), /limit is 4000000/);
  await assert.rejects(encryptBundle('data', PASS, {now:'not a date'}), /now must be a valid/);
  await assert.rejects(encryptBundle('data', PASS, {now:NaN}), /now must be a valid/);
  await assert.rejects(encryptBundle('data', PASS, {now:new Date('bad')}), /now must be a valid/);
  await assert.rejects(encryptBundle('data', PASS, {label:'x'.repeat(121)}), /label must be at most 120/);
  const ok = await encryptBundle('data', 'x'.repeat(12), {now:Date.UTC(2026, 0, 2), label:'  '});
  assert.equal(ok.createdAt, '2026-01-02T00:00:00.000Z');
  assert.equal(ok.label, null);
});

test('summarizePlaintext counts top-level arrays of JSON objects and returns null otherwise', () => {
  assert.deepEqual(summarizePlaintext(PLAIN), {capsules:0, checkpoints:3, notes:2, tasks:1});
  assert.deepEqual(summarizePlaintext('{"a":{"b":[1]}}'), {});
  assert.equal(summarizePlaintext('not json'), null);
  assert.equal(summarizePlaintext('[1,2]'), null);
  assert.equal(summarizePlaintext('42'), null);
  assert.equal(summarizePlaintext(undefined), null);
});

test('encrypted-bundle.ts is pure: no imports, network, filesystem or DOM', async () => {
  const src = await readFile(path.join(root, 'src/ui/encrypted-bundle.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /^\s*import\s/m);
  assert.doesNotMatch(code, /\bfetch\b|XMLHttpRequest|WebSocket|require\(\s*['"](node:)?fs['"]\s*\)|\bdocument\b|\bwindow\b|electron|localStorage/i);
  assert.match(code, /globalThis as \{ crypto\?: Crypto \}/);
});

test('Settings wires the panel to the local bridge with download, FileReader and verbatim notes, and no network', async () => {
  const src = await readFile(path.join(root, 'src/components/Settings.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/ui\/encrypted-bundle'/);
  assert.match(src, /productivityBridge\(api\)/);
  assert.match(src, /Encrypted transfer bundle \(manual, no sync service\)/);
  assert.match(src, /Bundles are encrypted locally with your passphrase and moved by you\. This build has no sync account or server\./);
  assert.match(src, /Restore into this app uses the existing import flow; this build does not merge automatically\./);
  assert.match(src, /URL\.createObjectURL\(new Blob\(/);
  assert.match(src, /URL\.revokeObjectURL/);
  assert.match(src, /download=\{bundleName\}/);
  assert.match(src, /desktop-companion-bundle-\$\{envelope\.createdAt\.slice\(0, 10\)\}\.json/);
  assert.match(src, /new FileReader\(\)/);
  assert.match(src, /type="file"/);
  assert.match(src, />Create encrypted bundle</);
  assert.match(src, />Decrypt and verify</);
  assert.match(src, />Copy decrypted JSON</);
  assert.match(src, />Copy JSON</);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
});
