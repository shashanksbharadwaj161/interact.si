import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/scene-spec.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {SCENE_SPEC_FORMAT, SCENE_SPEC_VERSION, MAX_SCENE_SPEC_CHARS, validateSceneSpec, composeSceneFromText, sceneSpecToPreset, serializeSceneSpec, COMPOSE_VALUES} = mod;

const base = () => ({format:'desktop-companion-scene', version:1, name:'Night tide', kind:'aurora', intensity:40, speed:30, hue:180});
const paths = (r) => { assert.equal(r.ok, false); return r.errors.map((e) => e.path); };

test('scene spec: constants and valid round-trip through JSON text and object', () => {
  assert.equal(SCENE_SPEC_FORMAT, 'desktop-companion-scene');
  assert.equal(SCENE_SPEC_VERSION, 1);
  const r = validateSceneSpec(base());
  assert.equal(r.ok, true);
  assert.deepEqual(r.spec, base());
  assert.deepEqual(r.warnings, []);
  const again = validateSceneSpec(serializeSceneSpec(r.spec));
  assert.equal(again.ok, true);
  assert.deepEqual(again.spec, r.spec);
  const fromString = validateSceneSpec(JSON.stringify(base()));
  assert.deepEqual(fromString.spec, base());
});

test('scene spec: each rejection path reports the exact field', () => {
  assert.deepEqual(paths(validateSceneSpec({...base(), format:'other'})), ['format']);
  assert.deepEqual(paths(validateSceneSpec({...base(), version:2})), ['version']);
  assert.deepEqual(paths(validateSceneSpec({...base(), kind:'tornado'})), ['kind']);
  assert.deepEqual(paths(validateSceneSpec({...base(), intensity:101})), ['intensity']);
  assert.deepEqual(paths(validateSceneSpec({...base(), speed:-1})), ['speed']);
  assert.deepEqual(paths(validateSceneSpec({...base(), hue:361})), ['hue']);
  assert.deepEqual(paths(validateSceneSpec({...base(), hue:'120'})), ['hue']);
  assert.deepEqual(paths(validateSceneSpec({...base(), intensity:Infinity})), ['intensity']);
  assert.deepEqual(paths(validateSceneSpec({...base(), speed:NaN})), ['speed']);
  assert.deepEqual(paths(validateSceneSpec('{"format":"desktop-companion-scene","version":1,"kind":"wave","intensity":1e999,"speed":5,"hue":5}')), ['intensity']);
  const {hue, ...noHue} = base();
  assert.equal(hue, 180);
  assert.deepEqual(paths(validateSceneSpec(noHue)), ['hue']);
  assert.deepEqual(paths(validateSceneSpec({...base(), name:'x'.repeat(41)})), ['name']);
  assert.deepEqual(paths(validateSceneSpec({...base(), name:42})), ['name']);
  assert.deepEqual(paths(validateSceneSpec({...base(), format:'x', kind:'y', speed:500})), ['format', 'kind', 'speed']);
  assert.deepEqual(paths(validateSceneSpec('not json')), ['']);
  assert.deepEqual(paths(validateSceneSpec('[1,2]')), ['']);
  assert.deepEqual(paths(validateSceneSpec(null)), ['']);
  assert.deepEqual(paths(validateSceneSpec(42)), ['']);
});

test('scene spec: oversize input is rejected for strings and objects', () => {
  const big = JSON.stringify({...base(), pad:'x'.repeat(MAX_SCENE_SPEC_CHARS)});
  assert.ok(big.length > 20000);
  const r = validateSceneSpec(big);
  assert.deepEqual(paths(r), ['']);
  assert.match(r.errors[0].message, /larger than 20000/);
  assert.deepEqual(paths(validateSceneSpec({...base(), pad:'x'.repeat(20001)})), ['']);
});

test('scene spec: unknown top-level keys are dropped with a warning, never kept in the spec', () => {
  const r = validateSceneSpec({...base(), script:'alert(1)', layers:[1], __proto__x:1});
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.spec).sort(), ['format', 'hue', 'intensity', 'kind', 'name', 'speed', 'version']);
  assert.ok(r.warnings.some((w) => /unknown key "script"/.test(w)));
  assert.ok(r.warnings.some((w) => /unknown key "layers"/.test(w)));
  assert.equal('script' in r.spec, false);
  const rounded = validateSceneSpec({...base(), intensity:40.6});
  assert.equal(rounded.spec.intensity, 41);
  assert.ok(rounded.warnings.some((w) => /rounded/.test(w)));
  const {name, ...noName} = base();
  assert.equal(name, 'Night tide');
  const unnamed = validateSceneSpec(noName);
  assert.equal(unnamed.ok, true);
  assert.equal(unnamed.spec.name, 'Untitled scene');
  assert.equal(unnamed.warnings.length, 1);
});

test('scene compose: kind, speed, intensity and hue keyword rules', () => {
  for (const k of ['wave', 'particles', 'orbit', 'aurora', 'bloom', 'lattice']) {
    assert.equal(composeSceneFromText(`a ${k} please`).spec.kind, k);
  }
  const calm = composeSceneFromText('calm slow blue waves');
  assert.equal(calm.spec.kind, 'wave');
  assert.equal(calm.spec.speed, COMPOSE_VALUES.slowSpeed);
  assert.ok(calm.spec.speed < 45);
  assert.equal(calm.spec.hue, 220);
  assert.ok(calm.rationale.some((r) => /calm/.test(r) && /speed/.test(r)));
  const busy = composeSceneFromText('Busy dense red particles');
  assert.equal(busy.spec.kind, 'particles');
  assert.equal(busy.spec.intensity, COMPOSE_VALUES.denseIntensity);
  assert.ok(busy.spec.intensity > 55);
  assert.equal(busy.spec.hue, 0);
  const energetic = composeSceneFromText('energetic green orbit');
  assert.ok(energetic.spec.intensity > 55);
  assert.equal(energetic.spec.hue, 120);
  const purple = composeSceneFromText('a purple lattice');
  assert.equal(purple.spec.hue, 275);
  const plain = composeSceneFromText('something nice');
  assert.deepEqual({kind:plain.spec.kind, intensity:plain.spec.intensity, speed:plain.spec.speed, hue:plain.spec.hue}, {kind:'wave', intensity:55, speed:45, hue:210});
  assert.deepEqual(composeSceneFromText('calm blue waves', 1), composeSceneFromText('calm blue waves', 99999));
});

test('scene compose: output always validates and converts to a preset', () => {
  const samples = ['calm blue waves', 'busy energetic magenta bloom with fast sparks', 'x', 'a'.repeat(5000), 'slow fast dense sparse', '\u0000\u0007 orbit teal', '日本語 aurora'];
  for (const s of samples) {
    const {spec, rationale} = composeSceneFromText(s);
    const r = validateSceneSpec(spec);
    assert.equal(r.ok, true, s.slice(0, 20));
    assert.deepEqual(r.spec, spec);
    assert.ok(Array.isArray(rationale) && rationale.length > 0);
    const r2 = validateSceneSpec(JSON.stringify(spec));
    assert.equal(r2.ok, true);
  }
  const preset = sceneSpecToPreset(composeSceneFromText('violet orbit').spec, 'p-abc');
  assert.deepEqual(preset, {id:'p-abc', name:'violet orbit', kind:'orbit', intensity:55, speed:45, hue:270});
});

test('scene compose: empty or whitespace text throws a descriptive error', () => {
  assert.throws(() => composeSceneFromText(''), /Describe the scene/);
  assert.throws(() => composeSceneFromText('   \n\t'), /Describe the scene/);
  assert.throws(() => composeSceneFromText(undefined), Error);
});
