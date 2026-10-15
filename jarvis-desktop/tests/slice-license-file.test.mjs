import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'src/ui/license-file.ts');
const bundle = await build({entryPoints:[srcPath], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const lf = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {LICENSE_FORMAT, LICENSE_VERSION, LICENSE_LIMITS, LICENSE_PREF_KEY, parseLicense, canonicalizePayload, normalizeTrustedKeys, verifyLicenseSignature, evaluateLicense, featureEnabled, describeLicense} = lf;

const subtle = webcrypto.subtle;
const pair = await subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign', 'verify']);
const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey);
const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
const trusted = [{keyId:'lic-2026', publicKeyJwk}];

const payload = (over = {}) => ({format:LICENSE_FORMAT, version:LICENSE_VERSION, licenseId:'L-0001', licensee:{name:'Ada Lovelace'}, product:'Desktop Companion', edition:'pro', issuedAt:'2026-01-01T00:00:00Z', expiresAt:'2027-01-01T00:00:00Z', features:['themes.extra', 'export.pdf'], keyId:'lic-2026', ...over});
async function signed(p = payload()) {
  const sig = await subtle.sign({name:'ECDSA', hash:'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonicalizePayload(p)));
  return {...p, signature:Buffer.from(sig).toString('base64')};
}
const parse = (obj) => parseLicense(JSON.stringify(obj));
const OK = {ok:true, reason:'ok', keyId:'lic-2026'};
const DAY = 86400000;

test('license: constants, round-trip parse and canonical payload excludes signature', async () => {
  assert.equal(LICENSE_FORMAT, 'desktop-companion-license');
  assert.equal(LICENSE_VERSION, 1);
  assert.deepEqual({...LICENSE_LIMITS}, {jsonChars:20000, name:120, features:50});
  assert.equal(LICENSE_PREF_KEY, 'license.file');
  const lic = await signed();
  const r = parse(lic);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.license, lic);
  assert.deepEqual(r.warnings, []);
  assert.equal(canonicalizePayload({b:1, a:{d:2, c:1}, signature:'x'}), '{"a":{"c":1,"d":2},"b":1}');
  const perp = parse(await signed(payload({expiresAt:null})));
  assert.equal(perp.ok, true);
  assert.equal(perp.license.expiresAt, null);
});

test('license: rejection paths report exact $-paths', async () => {
  const base = await signed();
  const errs = (over) => parse({...base, ...over}).errors;
  assert.deepEqual(parseLicense(42).errors, ['$: must be a JSON string']);
  assert.deepEqual(parseLicense('{').errors, ['$: invalid JSON']);
  assert.deepEqual(parseLicense('[]').errors, ['$: must be an object']);
  assert.deepEqual(parseLicense(' '.repeat(20001)).errors, ['$: exceeds 20000 characters']);
  assert.deepEqual(errs({format:'other'}), ['$.format: must be "desktop-companion-license"']);
  assert.deepEqual(errs({version:2}), ['$.version: must be 1']);
  assert.match(errs({licenseId:''})[0], /^\$\.licenseId: /);
  assert.match(errs({licensee:{name:'x'.repeat(121)}})[0], /^\$\.licensee\.name: /);
  assert.deepEqual(errs({licensee:'Ada'}), ['$.licensee: must be an object']);
  assert.match(errs({product:7})[0], /^\$\.product: /);
  assert.deepEqual(errs({edition:'enterprise'}), ['$.edition: must be "personal" or "pro"']);
  assert.deepEqual(errs({issuedAt:'yesterday'}), ['$.issuedAt: must be an ISO 8601 timestamp']);
  assert.match(errs({expiresAt:'2027'})[0], /^\$\.expiresAt: must be an ISO 8601 timestamp or null/);
  assert.deepEqual(errs({expiresAt:'2025-01-01T00:00:00Z'}), ['$.expiresAt: must be later than issuedAt']);
  assert.match(errs({features:'all'})[0], /^\$\.features: /);
  assert.match(errs({features:Array.from({length:51}, (_, i) => `f${i}`)})[0], /^\$\.features: /);
  assert.match(errs({features:['ok', 3]})[0], /^\$\.features\[1\]: /);
  assert.match(errs({features:['a', 'a']})[0], /^\$\.features\[1\]: duplicate/);
  assert.match(errs({keyId:''})[0], /^\$\.keyId: /);
  assert.deepEqual(errs({signature:'not base64!'}), ['$.signature: must be base64']);
  const {signature: _s, ...noSig} = base;
  assert.deepEqual(parse(noSig).errors, ['$.signature: must be base64']);
});

test('license: unknown keys warn and are dropped; signature still verifies', async () => {
  const lic = await signed();
  const r = parse({...lic, seat:'x', licensee:{name:'Ada Lovelace', email:'a@example.invalid'}});
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['$.seat: unknown key dropped', '$.licensee.email: unknown key dropped']);
  assert.equal('seat' in r.license, false);
  assert.deepEqual(await verifyLicenseSignature(r.license, trusted, subtle), OK);
});

test('license: genuine signature verifies ok (explicit subtle and globalThis.crypto)', async () => {
  const r = parse(await signed());
  assert.deepEqual(await verifyLicenseSignature(r.license, trusted, subtle), OK);
  assert.deepEqual(await verifyLicenseSignature(r.license, trusted), OK);
  assert.deepEqual(await verifyLicenseSignature(r.license, JSON.stringify(trusted), subtle), OK);
});

test('license: tampered payload -> bad-signature, unknown keyId -> untrusted-key, broken key -> bad-key, no crypto', async () => {
  const lic = await signed();
  const tampered = parse({...lic, edition:'personal'});
  assert.equal(tampered.ok, true);
  assert.equal((await verifyLicenseSignature(tampered.license, trusted, subtle)).reason, 'bad-signature');
  const longer = parse({...lic, expiresAt:'2099-01-01T00:00:00Z'});
  assert.equal((await verifyLicenseSignature(longer.license, trusted, subtle)).reason, 'bad-signature');
  const other = parse(await signed(payload({keyId:'someone-else'})));
  assert.deepEqual(await verifyLicenseSignature(other.license, trusted, subtle), {ok:false, reason:'untrusted-key', keyId:'someone-else'});
  assert.equal((await verifyLicenseSignature(parse(lic).license, [], subtle)).reason, 'untrusted-key');
  const badKey = [{keyId:'lic-2026', publicKeyJwk:{kty:'EC', crv:'P-256', x:'AAAA', y:'BBBB'}}];
  assert.equal((await verifyLicenseSignature(parse(lic).license, badKey, subtle)).reason, 'bad-key');
  const noCrypto = {importKey:null, verify:null};
  assert.equal((await verifyLicenseSignature(parse(lic).license, trusted, noCrypto)).reason, 'crypto-unavailable');
  const throwing = {importKey: async () => ({}), verify: async () => { throw new Error('boom'); }};
  assert.equal((await verifyLicenseSignature(parse(lic).license, trusted, throwing)).reason, 'bad-signature');
});

test('license: trusted keys accept only EC P-256 public JWKs and reject private keys', async () => {
  const priv = normalizeTrustedKeys([{keyId:'lic-2026', publicKeyJwk:privateKeyJwk}]);
  assert.deepEqual(priv.keys, []);
  assert.deepEqual(priv.errors, ['$[0].publicKeyJwk: must be a public key (private "d" present)']);
  assert.deepEqual(normalizeTrustedKeys([{keyId:'k', publicKeyJwk:{kty:'RSA', n:'x', e:'AQAB'}}]).errors, ['$[0].publicKeyJwk: must be an EC P-256 key']);
  assert.deepEqual(normalizeTrustedKeys([{keyId:'k', publicKeyJwk:{kty:'EC', crv:'P-384', x:'a', y:'b'}}]).errors, ['$[0].publicKeyJwk: must be an EC P-256 key']);
  assert.deepEqual(normalizeTrustedKeys('nope').errors, ['$: invalid JSON']);
  assert.deepEqual(normalizeTrustedKeys({}).errors, ['$: must be an array of {keyId, publicKeyJwk}']);
  const good = normalizeTrustedKeys(trusted);
  assert.equal(good.keys.length, 1);
  assert.equal('d' in good.keys[0].publicKeyJwk, false);
  // A private key in the trusted list never verifies anything.
  const r = parse(await signed());
  assert.equal((await verifyLicenseSignature(r.license, [{keyId:'lic-2026', publicKeyJwk:privateKeyJwk}], subtle)).reason, 'untrusted-key');
});

test('license: evaluation branches valid / expiring-soon / in-grace / expired / perpetual / not-yet-valid / invalid', async () => {
  const lic = parse(await signed()).license;
  const exp = Date.parse(lic.expiresAt);
  const valid = evaluateLicense(lic, OK, new Date('2026-03-01T00:00:00Z'));
  assert.equal(valid.status, 'valid');
  assert.equal(valid.daysRemaining, 306);
  assert.match(valid.explanation, /valid until 2027-01-01T00:00:00Z/);
  const soon = evaluateLicense(lic, OK, exp - 10 * DAY);
  assert.equal(soon.status, 'expiring-soon');
  assert.equal(soon.daysRemaining, 10);
  const grace = evaluateLicense(lic, OK, exp + 3 * DAY);
  assert.equal(grace.status, 'in-grace');
  assert.equal(grace.daysRemaining, -3);
  assert.match(grace.explanation, /14-day grace period \(11 days left\)/);
  const expired = evaluateLicense(lic, OK, exp + 15 * DAY);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.daysRemaining, -15);
  assert.equal(evaluateLicense(lic, OK, exp + 3 * DAY, 0).status, 'expired');
  const perpetual = evaluateLicense(parse(await signed(payload({expiresAt:null}))).license, OK, '2040-01-01T00:00:00Z');
  assert.equal(perpetual.status, 'valid');
  assert.equal(perpetual.daysRemaining, null);
  assert.match(perpetual.explanation, /perpetual/);
  assert.equal(evaluateLicense(lic, OK, '2025-12-31T00:00:00Z').status, 'not-yet-valid');
  const bad = evaluateLicense(lic, {ok:false, reason:'bad-signature', keyId:'lic-2026'}, '2026-03-01T00:00:00Z');
  assert.equal(bad.status, 'invalid');
  assert.equal(bad.daysRemaining, null);
  assert.match(bad.explanation, /bad-signature/);
  assert.equal(evaluateLicense(lic, null, '2026-03-01T00:00:00Z').status, 'invalid');
});

test('license: invalid now and grace throw descriptive errors', async () => {
  const lic = parse(await signed()).license;
  assert.throws(() => evaluateLicense(lic, OK, 'not a date'), /now must be a valid Date/);
  assert.throws(() => evaluateLicense(lic, OK, new Date('x')), /now must be a valid Date/);
  assert.throws(() => evaluateLicense(lic, OK, NaN), /now must be a valid Date/);
  assert.throws(() => evaluateLicense(lic, OK, undefined), /now must be a valid Date/);
  assert.throws(() => evaluateLicense(lic, OK, Date.now(), -1), /graceDays/);
});

test('license: featureEnabled only for valid/expiring-soon/in-grace and listed features; describeLicense verbatim', async () => {
  const lic = parse(await signed()).license;
  const exp = Date.parse(lic.expiresAt);
  for (const [now, want] of [[exp - 100 * DAY, true], [exp - DAY, true], [exp + DAY, true], [exp + 30 * DAY, false], [Date.parse(lic.issuedAt) - DAY, false]]) {
    assert.equal(featureEnabled(evaluateLicense(lic, OK, now), 'export.pdf'), want);
  }
  assert.equal(featureEnabled(evaluateLicense(lic, OK, exp - 100 * DAY), 'not.listed'), false);
  assert.equal(featureEnabled(evaluateLicense(lic, {ok:false, reason:'untrusted-key', keyId:null}, exp - 100 * DAY), 'export.pdf'), false);
  assert.equal(featureEnabled(null, 'export.pdf'), false);
  const rows = describeLicense(lic);
  assert.deepEqual(rows.find((r) => r.label === 'Expires'), {label:'Expires', value:'2027-01-01T00:00:00Z'});
  assert.deepEqual(rows.find((r) => r.label === 'Licensee'), {label:'Licensee', value:'Ada Lovelace'});
  assert.equal(describeLicense({...lic, expiresAt:null}).find((r) => r.label === 'Expires').value, 'Never (perpetual)');
});

test('license: source is offline-only with no imports, network or machine binding', () => {
  const src = readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.doesNotMatch(src, /\brequire\s*\(/);
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /electron|node:fs|WebSocket|navigator\./i);
  assert.match(src, /No network call is ever made/);
  assert.match(src, /No machine binding exists/);
});

test('license: Settings wires an offline license section, searchable index entry and two-step removal', () => {
  const s = readFileSync(path.join(root, 'src/components/Settings.tsx'), 'utf8');
  assert.match(s, /id: 'license', tab: 'data', title: 'License \(offline verification\)'/);
  assert.match(s, /usePref<string>\(LICENSE_PREF_KEY, ''\)/);
  assert.match(s, /usePref<string>\(LICENSE_TRUSTED_KEYS_PREF_KEY, ''\)/);
  assert.match(s, /verifyLicenseSignature\(parsed\.license, keys, subtle\)/);
  assert.match(s, /Confirm remove license/);
  const lfSrc = readFileSync(srcPath, 'utf8');
  assert.match(lfSrc, /This build verifies a pasted license offline only\. No activation server, no telemetry and no purchase flow exist yet\./);
  assert.match(lfSrc, /LICENSE_TRUSTED_KEYS_PREF_KEY = 'license\.trustedKeys'/);
});
