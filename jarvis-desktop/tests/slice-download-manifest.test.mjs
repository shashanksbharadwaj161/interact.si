import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/download-manifest.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const dm = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {DOWNLOAD_MANIFEST_FORMAT, DOWNLOAD_MANIFEST_VERSION, parseDownloadManifest, verifyDigest, planDownload, formatBytes, parseHostsInput} = dm;

const HEX = 'a'.repeat(64);
const HOSTS = ['models.example.org'];
const item = (over = {}) => ({id:'tiny-1b', kind:'model', name:'Tiny', version:'1.0', url:'https://models.example.org/tiny.gguf', sha256:HEX, sizeBytes:1024, license:'Apache-2.0', ...over});
const man = (over = {}) => ({format:DOWNLOAD_MANIFEST_FORMAT, version:DOWNLOAD_MANIFEST_VERSION, items:[item()], ...over});
const paths = (r) => { assert.equal(r.ok, false); return r.errors.map((e) => e.path); };
const errAt = (r, p) => r.errors.find((e) => e.path === p);

test('download manifest: constants and valid round-trip with unknown keys dropped as warnings', () => {
  assert.equal(DOWNLOAD_MANIFEST_FORMAT, 'desktop-companion-download-manifest');
  assert.equal(DOWNLOAD_MANIFEST_VERSION, 1);
  const input = man({extra:true, items:[item({minAppVersion:'1.2.3', note:'x'}), item({id:'upd', kind:'update', url:'https://models.example.org/u.zip'})]});
  const r = parseDownloadManifest(JSON.stringify(input), HOSTS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, ['unknown key "extra" dropped at $', 'unknown key "note" dropped at items[0]']);
  assert.equal('extra' in r.manifest, false);
  assert.equal('note' in r.manifest.items[0], false);
  assert.equal(r.manifest.items[0].minAppVersion, '1.2.3');
  const again = parseDownloadManifest(JSON.stringify(r.manifest), HOSTS);
  assert.equal(again.ok, true);
  assert.deepEqual(again.manifest, r.manifest);
  assert.deepEqual(again.warnings, []);
  assert.equal(parseDownloadManifest(man(), HOSTS).ok, true, 'parsed objects are accepted too');
});

test('download manifest: root rejection paths', () => {
  assert.deepEqual(paths(parseDownloadManifest('{nope', HOSTS)), ['$']);
  assert.deepEqual(paths(parseDownloadManifest('[]', HOSTS)), ['$']);
  assert.deepEqual(paths(parseDownloadManifest(man({format:'other'}), HOSTS)), ['format']);
  assert.deepEqual(paths(parseDownloadManifest(man({version:2}), HOSTS)), ['version']);
  assert.deepEqual(paths(parseDownloadManifest(man({version:'1'}), HOSTS)), ['version']);
  assert.deepEqual(paths(parseDownloadManifest(man({items:{}}), HOSTS)), ['items']);
  assert.deepEqual(paths(parseDownloadManifest(man({items:[]}), HOSTS)), ['items']);
  const many = Array.from({length:101}, (_, i) => item({id:`m${i}`}));
  assert.match(errAt(parseDownloadManifest(man({items:many}), HOSTS), 'items').message, /at most 100/);
  assert.equal(parseDownloadManifest(man({items:many.slice(0, 100)}), HOSTS).ok, true);
  assert.deepEqual(paths(parseDownloadManifest(man({items:[null]}), HOSTS)), ['items[0]']);
});

test('download manifest: each item field rejection has an exact path', () => {
  const cases = [
    [{id:''}, 'items[0].id'], [{id:'has space'}, 'items[0].id'], [{id:5}, 'items[0].id'],
    [{kind:'plugin'}, 'items[0].kind'],
    [{name:'  '}, 'items[0].name'],
    [{version:''}, 'items[0].version'],
    [{url:''}, 'items[0].url'], [{url:'not a url'}, 'items[0].url'],
    [{sha256:'A'.repeat(64)}, 'items[0].sha256'], [{sha256:'a'.repeat(63)}, 'items[0].sha256'], [{sha256:'g'.repeat(64)}, 'items[0].sha256'],
    [{sizeBytes:0}, 'items[0].sizeBytes'], [{sizeBytes:-1}, 'items[0].sizeBytes'], [{sizeBytes:1.5}, 'items[0].sizeBytes'], [{sizeBytes:'10'}, 'items[0].sizeBytes'],
    [{sizeBytes:50 * 1024 ** 3 + 1}, 'items[0].sizeBytes'],
    [{license:''}, 'items[0].license'], [{license:undefined}, 'items[0].license'],
    [{minAppVersion:'1.2'}, 'items[0].minAppVersion'], [{minAppVersion:'v1.2.3'}, 'items[0].minAppVersion'],
  ];
  for (const [over, p] of cases) assert.deepEqual(paths(parseDownloadManifest(man({items:[item(over)]}), HOSTS)), [p], JSON.stringify(over));
  assert.equal(parseDownloadManifest(man({items:[item({sizeBytes:50 * 1024 ** 3})]}), HOSTS).ok, true, '50 GiB exactly is allowed');
  assert.deepEqual(paths(parseDownloadManifest(man({items:[item(), item({id:'b', kind:'x'})]}), HOSTS)), ['items[1].kind']);
});

test('download manifest: duplicate ids are rejected at the later index', () => {
  const r = parseDownloadManifest(man({items:[item(), item({id:'other'}), item()]}), HOSTS);
  assert.deepEqual(paths(r), ['items[2].id']);
  assert.match(errAt(r, 'items[2].id').message, /duplicate id "tiny-1b" \(first at items\[0\]\)/);
});

test('download manifest: https and explicit host allow-list are enforced', () => {
  const http = parseDownloadManifest(man({items:[item({url:'http://models.example.org/a'})]}), HOSTS);
  assert.deepEqual(paths(http), ['items[0].url']);
  assert.match(http.errors[0].message, /^non-https/);
  assert.match(parseDownloadManifest(man({items:[item({url:'file:///C:/x'})]}), HOSTS).errors[0].message, /^non-https/);
  assert.match(parseDownloadManifest(man({items:[item({url:'https://u:p@models.example.org/a'})]}), HOSTS).errors[0].message, /^credentials-in-url/);
  const def = parseDownloadManifest(man({items:[item(), item({id:'b'})]}));
  assert.deepEqual(paths(def), ['items[0].url', 'items[1].url']);
  for (const e of def.errors) assert.match(e.message, /^host-not-allowed/);
  const other = parseDownloadManifest(man({items:[item({url:'https://evil.example.org/a'})]}), HOSTS);
  assert.deepEqual(paths(other), ['items[0].url']);
  assert.match(other.errors[0].message, /^host-not-allowed/);
  assert.match(parseDownloadManifest(man({items:[item({url:'https://sub.models.example.org/a'})]}), HOSTS).errors[0].message, /^host-not-allowed/, 'no implicit subdomains');
  assert.equal(parseDownloadManifest(man({items:[item({url:'https://MODELS.example.org/a'})]}), [' Models.Example.org ']).ok, true, 'host match is case-insensitive');
  assert.deepEqual(parseHostsInput(' a.example.org, ,B.example.org,a.example.org, bad host '), ['a.example.org', 'b.example.org']);
});

test('download manifest: oversize input is rejected before parsing', () => {
  const big = '{"format":"' + 'x'.repeat(200001) + '"}';
  const r = parseDownloadManifest(big, HOSTS);
  assert.deepEqual(paths(r), ['$']);
  assert.match(r.errors[0].message, /^oversize/);
  assert.match(parseDownloadManifest(man({pad:'y'.repeat(200001)}), HOSTS).errors[0].message, /^oversize/);
});

test('download manifest: verifyDigest is a strict lowercase hex comparison', () => {
  assert.deepEqual(verifyDigest(HEX, HEX), {match:true, reason:'match'});
  assert.deepEqual(verifyDigest(HEX, 'b'.repeat(64)), {match:false, reason:'mismatch'});
  assert.deepEqual(verifyDigest(HEX, 'A'.repeat(64)), {match:false, reason:'invalid-actual'});
  assert.deepEqual(verifyDigest('A'.repeat(64), HEX), {match:false, reason:'invalid-expected'});
  assert.deepEqual(verifyDigest(HEX, 'a'.repeat(63)), {match:false, reason:'invalid-actual'});
  assert.deepEqual(verifyDigest(undefined, HEX), {match:false, reason:'invalid-expected'});
});

test('download manifest: planDownload reports offline, blocked host, ready and invalid without fetching', () => {
  const r = parseDownloadManifest(man({items:[item(), item({id:'b', url:'https://models.example.org/b'})]}), HOSTS);
  assert.equal(r.ok, true);
  const offline = planDownload(r.manifest, {onlineEnabled:false, allowedHosts:HOSTS});
  assert.deepEqual(offline.map((e) => [e.id, e.status]), [['tiny-1b', 'blocked-offline'], ['b', 'blocked-offline']]);
  const blocked = planDownload(r.manifest, {onlineEnabled:true, allowedHosts:['other.example.org']});
  assert.deepEqual(blocked.map((e) => e.status), ['blocked-host', 'blocked-host']);
  const ready = planDownload(r.manifest, {onlineEnabled:true, allowedHosts:HOSTS});
  assert.deepEqual(ready.map((e) => e.status), ['ready-to-request', 'ready-to-request']);
  assert.match(ready[0].reason, /does not start downloads/);
  for (const e of [...offline, ...blocked, ...ready]) assert.equal(typeof e.reason, 'string');
  const tampered = {...r.manifest, items:[{...r.manifest.items[0], sha256:'XYZ'}]};
  assert.deepEqual(planDownload(tampered, {onlineEnabled:true, allowedHosts:HOSTS}).map((e) => e.status), ['invalid']);
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('download manifest: module and Models panel never fetch and state the honest note', () => {
  const mod = readFileSync(path.join(root, 'src/ui/download-manifest.ts'), 'utf8');
  assert.equal(mod.includes('fetch('), false);
  assert.equal(mod.includes('XMLHttpRequest'), false);
  assert.doesNotMatch(mod, /WebSocket|document\.|window\.|clip-export/);
  const view = readFileSync(path.join(root, 'src/components/Models.tsx'), 'utf8');
  const panel = view.slice(view.indexOf('export function ManifestVerifyPanel'), view.indexOf('/** Presentation only'));
  assert.ok(panel.includes('Verify download manifest (offline)'));
  assert.ok(panel.includes('This build verifies manifests only; no download is started.'));
  assert.ok(panel.includes("usePref<unknown>('models.downloadHosts', [])"));
  assert.ok(panel.includes('planDownload('));
  assert.doesNotMatch(panel, /fetch\(|XMLHttpRequest|startPull|client/);
  assert.match(view, /<ManifestVerifyPanel onlineEnabled=\{o\?\.downloads\.allowed === true\} \/>/);
});
