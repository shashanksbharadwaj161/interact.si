// Pet renderer plumbing (src/pet/registry.ts, loader.ts): bundled packs pair manifests with atlases by folder, the
// product companion uses only approved packs and says why when none is usable, the atlas bytes are checked against the
// manifest's SHA-256, and the in-app load check passes on a real decoded atlas. The atlas used here is the labelled
// engineering test pattern (flat rectangles saying TEST PATTERN), never character art. Installed character packs must
// carry matching validation evidence; the First Light animation remains explicitly in review until owner approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'pet-renderer-entry.ts',
    loader: 'ts',
    contents: `
      export { packsFrom } from './src/pet/registry.ts';
      export { choosePack, decodeDataUrl, sha256Hex, NO_ART_REASON } from './src/pet/loader.ts';
      export { checkAtlasPixels } from './src/pet/atlas-check.ts';
      export { parsePetManifest } from './src/pet/manifest.ts';
      export { REQUIRED_CELLS, cellKey } from './src/pet/contract.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const fixtureDir = path.join(root, 'tests', 'fixtures', 'pet-test-pattern');
const fixtureManifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'pet.json'), 'utf8'));
const fixturePng = fs.readFileSync(path.join(fixtureDir, 'spritesheet.png'));

const approved = (over = {}) => ({...fixtureManifest, id: 'direction-a', review: {status: 'approved', approvedBy: 'owner', approvedOn: '2026-10-20'}, qa: {tool: 'create-pet scripts', atlasValidation: 'qa/validation-extended.json', petQuality: 'qa/pet-quality.json'}, ...over});
const atlasLoader = () => async () => 'data:image/png;base64,AAAA';

test('registry pairs each manifest with its atlas by folder and reports what is wrong', () => {
  const packs = m.packsFrom(
    {
      '../../assets/pets/direction-a/pet.json': approved(),
      '../../assets/pets/wrong-folder/pet.json': approved({id: 'something-else'}),
      '../../assets/pets/no-atlas/pet.json': approved({id: 'no-atlas'}),
      '../../assets/pets/broken/pet.json': {format: 'nope'},
    },
    {
      '../../assets/pets/direction-a/spritesheet.png': atlasLoader(),
      '../../assets/pets/wrong-folder/spritesheet.png': atlasLoader(),
    },
  );
  const by = Object.fromEntries(packs.map((p) => [p.folder, p]));
  assert.deepEqual(by['direction-a'].errors, []);
  assert.equal(typeof by['direction-a'].loadAtlas, 'function');
  assert.match(by['wrong-folder'].errors.join(' '), /must be named after the pack id/);
  assert.equal(by['wrong-folder'].loadAtlas, null);
  assert.match(by['no-atlas'].errors.join(' '), /atlas file "spritesheet.png" is missing/);
  assert.equal(by.broken.manifest, null);
  assert.ok(by.broken.errors.length > 0);
});

test('the product uses only approved packs and always says why nothing is shown', () => {
  assert.deepEqual(m.choosePack([], 'product'), {missing: m.NO_ART_REASON});
  const concept = m.packsFrom({'../../assets/pets/test-pattern/pet.json': fixtureManifest}, {'../../assets/pets/test-pattern/spritesheet.png': atlasLoader()});
  const product = m.choosePack(concept, 'product');
  assert.ok('missing' in product);
  assert.match(product.missing, /installed but not approved yet \(concept\)/);
  const review = m.choosePack(concept, 'review');
  assert.equal(review.entry.folder, 'test-pattern', 'the review board may show a concept pack (it labels its status)');
  const ok = m.packsFrom({'../../assets/pets/direction-a/pet.json': approved()}, {'../../assets/pets/direction-a/spritesheet.png': atlasLoader()});
  assert.equal(m.choosePack(ok, 'product').entry.folder, 'direction-a');
  const broken = m.packsFrom({'../../assets/pets/direction-a/pet.json': approved()}, {});
  assert.ok('invalid' in m.choosePack(broken, 'product'));
  assert.match(m.choosePack(ok, 'product', 'other').missing, /"other" is not installed/);
});

test('atlas bytes come from an inline data URL and are checked against atlasSha256', async () => {
  const url = `data:image/png;base64,${fixturePng.toString('base64')}`;
  const {mime, bytes} = m.decodeDataUrl(url);
  assert.equal(mime, 'image/png');
  assert.equal(bytes.length, fixturePng.length);
  assert.equal(await m.sha256Hex(bytes), fixtureManifest.atlasSha256);
  assert.equal(createHash('sha256').update(fixturePng).digest('hex'), fixtureManifest.atlasSha256);
  assert.throws(() => m.decodeDataUrl('file:///C:/x.png'), /inline base64/);
  assert.throws(() => m.decodeDataUrl('data:image/png,notbase64'), /inline base64/);
});

test('the in-app load check passes on the decoded test pattern, with a real lift in the jump row', () => {
  assert.equal(m.parsePetManifest(fixtureManifest).ok, true);
  const raw = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pet-rgba-')), 'atlas.rgba');
  execFileSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-I', '-c', 'import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert("RGBA"); open(sys.argv[2], "wb").write(im.tobytes()); print(im.size)', path.join(fixtureDir, 'spritesheet.png'), raw]);
  const rgba = new Uint8Array(fs.readFileSync(raw));
  const check = m.checkAtlasPixels(rgba, 1536, 2288);
  assert.equal(check.ok, true, JSON.stringify(check.errors.slice(0, 3)));
  assert.equal(check.warnings.length, 0);
  for (const c of m.REQUIRED_CELLS) assert.ok(check.frames.get(m.cellKey(c.row, c.col))?.bounds, `frame ${c.row}:${c.col}`);
  const bottom = (col) => {
    const b = check.frames.get(m.cellKey(4, col)).bounds;
    return b.y + b.h;
  };
  assert.ok(bottom(2) < bottom(0) - 20, 'jump frame 2 leaves the baseline');
  assert.equal(bottom(4), bottom(0), 'and lands back on it');
});

test('installed character packs verify their actual atlas and retain truthful review status', () => {
  const dir = path.join(root, 'assets', 'pets');
  const packs = fs.readdirSync(dir, {withFileTypes: true}).filter((d) => d.isDirectory());
  for (const d of packs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'pet.json'), 'utf8'));
    const parsed = m.parsePetManifest(manifest);
    assert.equal(parsed.ok, true, `${d.name}: ${parsed.errors?.join(' ')}`);
    assert.equal(manifest.id, d.name);
    const bytes = fs.readFileSync(path.join(dir, d.name, manifest.atlas));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.atlasSha256, `${d.name}: atlasSha256`);
    assert.notEqual(manifest.id, 'test-pattern', 'the test pattern must never be installed as a pet');
    assert.ok(manifest.qa, `${d.name}: generation QA is required`);
    for (const key of ['atlasValidation', 'petQuality']) {
      const report = JSON.parse(fs.readFileSync(path.join(dir, d.name, manifest.qa[key]), 'utf8'));
      assert.equal(report.ok, true, `${d.name}: ${key} must pass`);
      assert.equal(report.sha256, manifest.atlasSha256, `${d.name}: ${key} must describe these exact bytes`);
    }
    if (d.name === 'first-light') assert.equal(manifest.review.status, 'in-review', 'QA does not imply owner approval');
  }
  assert.ok(packs.some(d => d.name === 'first-light'), 'the reviewed First Light animation is bundled');
  const registry = fs.readFileSync(path.join(root, 'src', 'pet', 'registry.ts'), 'utf8');
  assert.match(registry, /'\.\.\/\.\.\/assets\/pets\/\*\/pet\.json'/);
});

test('the missing-art state and the slot draw no stand-in character', () => {
  for (const f of ['MissingArt.tsx', 'PetSlot.tsx']) {
    const src = fs.readFileSync(path.join(root, 'src', 'pet', f), 'utf8');
    assert.ok(!/<svg|<canvas|<path|getContext|drawImage|arc\(/.test(src), `${f} must not draw anything`);
  }
  const css = fs.readFileSync(path.join(root, 'src', 'styles', 'pet.css'), 'utf8');
  assert.ok(!/radial-gradient|clip-path:\s*(circle|ellipse|polygon)|border-radius:\s*50%/.test(css.replace(/clip-path: inset\(50%\)/g, '')), 'no faces or blobs in the missing-art styling');
});
