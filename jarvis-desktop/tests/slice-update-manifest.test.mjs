import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/update-manifest.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const um = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {UPDATE_MANIFEST_FORMAT, UPDATE_MANIFEST_VERSION, UPDATE_LIMITS, NO_DOWNLOAD_NOTE, parseUpdateManifest, canonicalizePayload, verifyManifestSignature, compareVersions, planUpdate, normalizeInstallLedger, recordInstall, planRollback, verifyDigestHex, normalizeTrustedKeys} = um;

const subtle = globalThis.crypto.subtle;
const SHA = 'a'.repeat(64);
const rel = (version, over = {}) => ({version, publishedAt:'2026-01-02T03:04:05Z', installer:{fileName:`Setup-${version}.exe`, sizeBytes:1234, sha256:SHA}, notes:`Notes for ${version}\n<b>not html</b>`, ...over});
const payload = (over = {}) => ({format:UPDATE_MANIFEST_FORMAT, version:UPDATE_MANIFEST_VERSION, product:'Desktop Companion', channel:'stable', releases:[rel('1.0.0'), rel('1.2.0')], ...over});

const pair = await subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign', 'verify']);
const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey);
const trusted = [{keyId:'release-2026', publicKeyJwk}];

async function signed(p = payload(), keyId = 'release-2026') {
  const sig = await subtle.sign({name:'ECDSA', hash:'SHA-256'}, pair.privateKey, new TextEncoder().encode(canonicalizePayload(p)));
  return {...p, signature:{alg:'ECDSA-P256-SHA256', keyId, value:Buffer.from(sig).toString('base64')}};
}
const parse = (obj) => parseUpdateManifest(JSON.stringify(obj));

test('update: constants and canonical payload are deterministic and key-sorted', () => {
  assert.equal(UPDATE_MANIFEST_FORMAT, 'desktop-companion-update');
  assert.equal(UPDATE_MANIFEST_VERSION, 1);
  assert.deepEqual({...UPDATE_LIMITS}, {jsonChars:200000, releases:50, notesChars:4000, ledgerEntries:20});
  assert.equal(canonicalizePayload({b:1, a:{d:[2, {z:1, y:2}], c:'x'}}), '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalizePayload({b:1, a:2, signature:{value:'x'}}), '{"a":2,"b":1}');
  assert.equal(canonicalizePayload(payload()), canonicalizePayload(JSON.parse(JSON.stringify(payload()))));
});

test('update: genuinely signed manifest verifies ok after parse', async () => {
  const parsed = parse(await signed());
  assert.equal(parsed.ok, true, parsed.errors.join('; '));
  const res = await verifyManifestSignature(parsed.manifest, trusted);
  assert.deepEqual(res, {ok:true, reason:'ok', keyId:'release-2026'});
});

test('update: tampered release -> bad-signature; unknown key -> untrusted-key; bad key -> bad-key', async () => {
  const m = await signed();
  const tampered = JSON.parse(JSON.stringify(m));
  tampered.releases[1].installer.sha256 = 'b'.repeat(64);
  const t = parse(tampered);
  assert.equal(t.ok, true);
  assert.equal((await verifyManifestSignature(t.manifest, trusted)).reason, 'bad-signature');
  const u = parse(await signed(payload(), 'someone-else'));
  assert.equal((await verifyManifestSignature(u.manifest, trusted)).reason, 'untrusted-key');
  assert.equal((await verifyManifestSignature(parse(m).manifest, [])).reason, 'untrusted-key');
  const badKey = [{keyId:'release-2026', publicKeyJwk:{kty:'EC', crv:'P-256', x:'AAAA', y:'BBBB'}}];
  assert.equal((await verifyManifestSignature(parse(m).manifest, badKey)).reason, 'bad-key');
  // unknown keys are dropped with warnings, and since they are not part of the parsed payload the signature still holds
  const extra = parse({...m, extra:1});
  assert.deepEqual(extra.warnings, ['$.extra: unknown key dropped']);
  assert.equal((await verifyManifestSignature(extra.manifest, trusted)).ok, true);
});

test('update: malformed base64 never throws and yields bad-signature', async () => {
  const m = parse(await signed()).manifest;
  for (const value of ['!!!not-base64!!!', 'abc', '', '====', 'AAAA'.repeat(2000)]) {
    const res = await verifyManifestSignature({...m, signature:{...m.signature, value}}, trusted);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad-signature');
  }
  assert.equal(parse({...payload(), signature:{alg:'ECDSA-P256-SHA256', keyId:'k', value:'%%%'}}).errors[0], '$.signature.value: must be base64');
});

test('update: parse error paths are exact', () => {
  const sig = {alg:'ECDSA-P256-SHA256', keyId:'k', value:'AAAA'};
  const errs = (obj) => parse(obj).errors;
  assert.deepEqual(parseUpdateManifest('{').errors, ['$: invalid JSON']);
  assert.deepEqual(parseUpdateManifest('[]').errors, ['$: must be an object']);
  assert.deepEqual(parseUpdateManifest('x'.repeat(200001)).errors, ['$: exceeds 200000 characters']);
  assert.deepEqual(errs({...payload({format:'x', version:2, product:'', channel:'nightly'}), signature:sig}), [
    '$.format: must be "desktop-companion-update"', '$.version: must be 1', '$.product: must be a non-empty string', '$.channel: must be "stable" or "beta"']);
  assert.deepEqual(errs({...payload({releases:[]}), signature:sig}), ['$.releases: must be an array of 1 to 50 releases']);
  assert.deepEqual(errs({...payload({releases:Array.from({length:51}, (_, i) => rel(`1.0.${i}`))}), signature:sig}), ['$.releases: must be an array of 1 to 50 releases']);
  assert.deepEqual(errs({...payload({releases:[rel('1.0'), rel('1.0.0', {publishedAt:'yesterday', installer:{fileName:'../x.exe', sizeBytes:0, sha256:'zz'}, notes:'n'.repeat(4001), minPreviousVersion:'v1'})]}), signature:sig}), [
    '$.releases[0].version: must be strict semver',
    '$.releases[1].publishedAt: must be an ISO 8601 timestamp',
    '$.releases[1].installer.fileName: must be a non-empty file name without path separators',
    '$.releases[1].installer.sizeBytes: must be a positive integer',
    '$.releases[1].installer.sha256: must be 64 hex characters',
    '$.releases[1].notes: must be a string of at most 4000 characters',
    '$.releases[1].minPreviousVersion: must be strict semver',
  ]);
  assert.deepEqual(errs({...payload({releases:[rel('1.0.0'), 7, rel('1.0.0', {installer:null})]}), signature:sig}), [
    '$.releases[1]: must be an object', '$.releases[2].version: duplicate release version 1.0.0', '$.releases[2].installer: must be an object']);
  assert.deepEqual(errs(payload()), ['$.signature: must be an object']);
  assert.deepEqual(errs({...payload(), signature:{alg:'RSA', keyId:'', value:'AAAA', x:1}}), ['$.signature.alg: must be "ECDSA-P256-SHA256"', '$.signature.keyId: must be a non-empty string']);
  const warn = parse({...payload({releases:[{...rel('1.0.0'), extra:1, installer:{...rel('1.0.0').installer, url:'https://x'}}]}), signature:sig});
  assert.equal(warn.ok, true);
  assert.deepEqual(warn.warnings, ['$.releases[0].extra: unknown key dropped', '$.releases[0].installer.url: unknown key dropped']);
  assert.equal('url' in warn.manifest.releases[0].installer, false);
});

test('update: compareVersions is strict semver with prerelease ordering', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.10.0', '2.0.0'];
  for (let i = 0; i < order.length - 1; i++) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1);
  }
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3'), 0);
  for (const bad of ['1.2', '01.2.3', 'v1.2.3', '1.2.3-', '', '1.2.3-01']) assert.equal(compareVersions(bad, '1.0.0'), null, bad);
});

test('update: planUpdate statuses including downgrade and minPreviousVersion', async () => {
  const ok = {ok:true, reason:'ok', keyId:'k'};
  const m = parse(await signed(payload({releases:[rel('1.0.0'), rel('1.2.0', {minPreviousVersion:'1.0.0'}), rel('2.0.0-beta.1')]}))).manifest;
  const bad = planUpdate(m, '1.0.0', {ok:false, reason:'bad-signature', keyId:'k'});
  assert.equal(bad.status, 'signature-invalid');
  assert.equal(bad.release, null);
  const up = planUpdate(m, '1.1.0', ok);
  assert.equal(up.status, 'update-available');
  assert.equal(up.release.version, '1.2.0', 'stable channel skips prerelease');
  assert.equal(up.installerSha256, SHA);
  assert.equal(up.note, NO_DOWNLOAD_NOTE);
  assert.match(up.note, /No download is started/);
  assert.equal(planUpdate(m, '1.2.0', ok).status, 'up-to-date');
  assert.equal(planUpdate(m, '1.3.0', ok).status, 'downgrade-blocked');
  assert.equal(planUpdate(m, '0.9.0', ok).status, 'min-version-unmet');
  assert.equal(planUpdate(m, 'garbage', ok).status, 'min-version-unmet');
  assert.equal(planUpdate({...m, channel:'beta'}, '1.2.0', ok).release.version, '2.0.0-beta.1');
});

test('update: ledger validates, caps at newest 20 and plans rollback without applying', () => {
  let ledger = [];
  const bad = recordInstall(ledger, {version:'1.0', installedAt:'now', installerSha256:'x', source:'auto'});
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['version: must be strict semver', 'installedAt: must be an ISO 8601 timestamp', 'installerSha256: must be 64 hex characters', 'source: must be "manual"']);
  for (let i = 0; i < 25; i++) {
    const r = recordInstall(ledger, {version:`1.${i}.0`, installedAt:new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), installerSha256:SHA.toUpperCase(), source:'manual'});
    assert.equal(r.ok, true);
    ledger = r.ledger;
  }
  assert.equal(ledger.length, 20);
  assert.equal(ledger[0].version, '1.24.0');
  assert.equal(ledger[19].version, '1.5.0');
  assert.equal(ledger[0].installerSha256, SHA);
  assert.deepEqual(normalizeInstallLedger([...ledger, {junk:1}, null, 'x']), ledger);
  assert.deepEqual(normalizeInstallLedger('nope'), []);
  const plan = planRollback(ledger, '1.24.0');
  assert.equal(plan.possible, true);
  assert.equal(plan.applied, false);
  assert.equal(plan.target.version, '1.23.0');
  assert.ok(plan.steps.length >= 3);
  assert.ok(plan.steps.every((s) => s.requiresConfirmation === true));
  assert.match(plan.steps[0].text, /from 1\.24\.0 to 1\.23\.0/);
  assert.match(plan.reason, /Nothing has been rolled back/);
  const none = planRollback(ledger, '1.0.0');
  assert.deepEqual({possible:none.possible, target:none.target, steps:none.steps, applied:none.applied}, {possible:false, target:null, steps:[], applied:false});
  assert.equal(planRollback(ledger, 'bad').possible, false);
});

test('update: verifyDigestHex and trusted key normalization', async () => {
  const bytes = new TextEncoder().encode('abc');
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.deepEqual(await verifyDigestHex(abc.toUpperCase(), bytes), {ok:true, actualHex:abc, reason:'ok'});
  assert.equal((await verifyDigestHex(SHA, bytes)).reason, 'mismatch');
  assert.equal((await verifyDigestHex('nothex', bytes)).reason, 'bad-expected');
  assert.deepEqual(normalizeTrustedKeys('x').errors, ['$: must be an array of {keyId, publicKeyJwk}']);
  const n = normalizeTrustedKeys([{keyId:'a', publicKeyJwk:{kty:'EC'}}, {keyId:'', publicKeyJwk:{}}, {keyId:'p', publicKeyJwk:{d:'secret'}}]);
  assert.equal(n.keys.length, 1);
  assert.deepEqual(n.errors, ['$[1].keyId: must be a non-empty string', '$[2].publicKeyJwk: must be a public key (private "d" present)']);
});

test('update: source is offline-only and Status wires the panel', () => {
  const src = readFileSync(path.join(root, 'src/ui/update-manifest.ts'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\b/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.doesNotMatch(src, /child_process/);
  assert.doesNotMatch(src, /from\s+['"](node:)?fs['"]|require\(\s*['"](node:)?fs['"]\s*\)/);
  assert.doesNotMatch(src, /electron/i);
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /\b(document|window)\./);
  const status = readFileSync(path.join(root, 'src/components/Status.tsx'), 'utf8');
  assert.match(status, /Update manifest verification \(offline\)/);
  assert.match(status, /This build verifies signatures and plans only\. It does not download, install or roll back anything\./);
  assert.match(status, /usePref<string>\('updates\.installedVersion', ''\)/);
  assert.match(status, /usePref<unknown\[\]>\('updates\.trustedKeys', \[\]\)/);
  assert.match(status, /usePref<unknown\[\]>\('updates\.installLedger', \[\]\)/);
  assert.match(status, /Record installed version/);
  assert.match(status, /Plan rollback/);
  assert.match(status, /Installed versions/);
  assert.ok(status.indexOf('<CompatTierPanel') < status.indexOf('<UpdateManifestPanel'));
  assert.doesNotMatch(status, /dangerouslySetInnerHTML/);
});
