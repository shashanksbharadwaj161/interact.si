import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(entry) {
  const bundle = await build({entryPoints:[path.join(root, entry)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const mod = await load('src/ui/capsule-scene.ts');
const scenes = await load('src/ui/scenes.ts');
const anim = await load('src/ui/anim-state.ts');
const {CAPSULE_SCENE_PREF_KEY, CAPSULE_SCENE_LIMITS, normalizeCapsuleScenes, setCapsuleScene, clearCapsuleScene, resolveSceneForCapsule, planSceneTransition, isValidCapsuleId} = mod;
const src = (p) => readFileSync(path.join(root, p), 'utf8');

test('capsule scene: key, frozen limits and scene id export', () => {
  assert.equal(CAPSULE_SCENE_PREF_KEY, 'capsuleScenes.v1');
  assert.ok(Object.isFrozen(CAPSULE_SCENE_LIMITS));
  assert.equal(CAPSULE_SCENE_LIMITS.maxMappings, 200);
  assert.deepEqual([...scenes.SCENE_IDS], scenes.SCENES.map((s) => s.id));
  assert.ok(Object.isFrozen(scenes.SCENE_IDS));
});

test('normalize drops unknown scenes and bad ids, caps at the limit, never throws', () => {
  const n = normalizeCapsuleScenes({a1: 'aurora', b2: 'not-a-scene', 'bad id': 'dusk', c3: 42, d4: 'dusk'});
  assert.deepEqual({...n}, {a1: 'aurora', d4: 'dusk'});
  assert.ok(Object.isFrozen(n));
  for (const raw of [null, undefined, 'x', 5, [], ['aurora']]) assert.deepEqual({...normalizeCapsuleScenes(raw)}, {});
  const many = {};
  for (let i = 0; i < 260; i++) many[`cap-${i}`] = 'orbit';
  const capped = normalizeCapsuleScenes(many);
  assert.equal(Object.keys(capped).length, CAPSULE_SCENE_LIMITS.maxMappings);
  assert.equal(capped['cap-0'], 'orbit');
  assert.equal(capped['cap-200'], undefined);
});

test('set/clear are pure, frozen and deterministic', () => {
  const m0 = normalizeCapsuleScenes({});
  const m1 = setCapsuleScene(m0, 'cap-1', 'aurora');
  const m1b = setCapsuleScene(m0, 'cap-1', 'aurora');
  assert.deepEqual(m1, m1b);
  assert.deepEqual({...m0}, {});
  assert.ok(Object.isFrozen(m1));
  const m2 = setCapsuleScene(m1, 'cap-1', 'dusk');
  assert.equal(m1['cap-1'], 'aurora');
  assert.equal(m2['cap-1'], 'dusk');
  const m3 = clearCapsuleScene(m2, 'cap-1');
  assert.deepEqual({...m3}, {});
  assert.equal(m2['cap-1'], 'dusk');
  assert.ok(Object.isFrozen(m3));
  assert.deepEqual({...clearCapsuleScene(m1, 'missing')}, {...m1});
  // A full map refuses a new capsule but still allows replacing an existing one.
  const full = {};
  for (let i = 0; i < 200; i++) full[`c${i}`] = 'orbit';
  const fm = normalizeCapsuleScenes(full);
  assert.throws(() => setCapsuleScene(fm, 'new-one', 'dusk'), /At most 200/);
  assert.equal(setCapsuleScene(fm, 'c5', 'dusk').c5, 'dusk');
});

test('invalid capsule ids and unknown scene ids are rejected with descriptive errors', () => {
  const m = normalizeCapsuleScenes({});
  for (const bad of ['', ' lead', 'has space', '../x', 'a'.repeat(129), null, 7]) {
    assert.equal(isValidCapsuleId(bad), false);
    assert.throws(() => setCapsuleScene(m, bad, 'aurora'), /Invalid capsule id/);
    assert.throws(() => clearCapsuleScene(m, bad), /Invalid capsule id/);
    assert.throws(() => resolveSceneForCapsule({capsuleId: bad, mappings: m, fallbackSceneId: 'orbit', reducedMotion: false}), /Invalid capsule id/);
  }
  assert.ok(isValidCapsuleId('4f1c2a9e-1b2c-4d5e-8f90-123456789abc'));
  assert.throws(() => setCapsuleScene(m, 'cap-1', 'neon'), /Unknown scene id "neon"/);
  assert.throws(() => resolveSceneForCapsule({capsuleId: 'cap-1', mappings: m, fallbackSceneId: 'neon', reducedMotion: false}), /Unknown scene id/);
  assert.throws(() => planSceneTransition('aurora', 'neon', {reducedMotion: false, now: 0}), /Unknown scene id/);
  assert.throws(() => planSceneTransition('', 'aurora', {reducedMotion: false, now: 0}), /Unknown scene id/);
});

test('resolve: capsule mapping vs fallback, reduced motion forces none', () => {
  const m = setCapsuleScene(normalizeCapsuleScenes({}), 'cap-1', 'horizon');
  const a = resolveSceneForCapsule({capsuleId: 'cap-1', mappings: m, fallbackSceneId: 'orbit', reducedMotion: false});
  assert.deepEqual({...a}, {sceneId: 'horizon', source: 'capsule', transition: 'crossfade'});
  assert.ok(Object.isFrozen(a));
  const b = resolveSceneForCapsule({capsuleId: 'cap-2', mappings: m, fallbackSceneId: 'orbit', reducedMotion: false});
  assert.deepEqual({...b}, {sceneId: 'orbit', source: 'fallback', transition: 'crossfade'});
  const c = resolveSceneForCapsule({capsuleId: 'cap-1', mappings: m, fallbackSceneId: 'orbit', reducedMotion: true});
  assert.deepEqual({...c}, {sceneId: 'horizon', source: 'capsule', transition: 'none'});
  // Untrusted stored data with an unknown scene falls back.
  const d = resolveSceneForCapsule({capsuleId: 'cap-9', mappings: {'cap-9': 'neon'}, fallbackSceneId: 'dusk', reducedMotion: false});
  assert.equal(d.source, 'fallback');
  assert.equal(d.sceneId, 'dusk');
});

test('planSceneTransition: crossfade timing matches the anim machine; same scene and reduced motion are none', () => {
  const p = planSceneTransition('deep-space', 'aurora', {reducedMotion: false, now: 1000});
  assert.equal(p.kind, 'crossfade');
  assert.equal(p.interruptible, true);
  assert.equal(p.exitMs, anim.ANIM_LIMITS.exitMs);
  assert.equal(p.enterMs, anim.ANIM_LIMITS.enterMs);
  assert.equal(p.durationMs, anim.ANIM_LIMITS.exitMs + anim.ANIM_LIMITS.enterMs);
  assert.equal(p.endsAt, 1000 + p.durationMs);
  assert.ok(Object.isFrozen(p));
  assert.deepEqual(planSceneTransition('deep-space', 'aurora', {reducedMotion: false, now: 1000}), p);
  const same = planSceneTransition('aurora', 'aurora', {reducedMotion: false, now: 5});
  assert.equal(same.kind, 'none');
  assert.equal(same.durationMs, 0);
  assert.equal(same.interruptible, true);
  const reduced = planSceneTransition('deep-space', 'dusk', {reducedMotion: true, now: 5});
  assert.equal(reduced.kind, 'none');
  assert.equal(reduced.durationMs, 0);
  assert.equal(reduced.endsAt, 5);
  // The machine finishes a crossfade from a settled scene within the planned duration, and a second change interrupts it.
  let m = anim.createAnimMachine({reducedMotion: false, now: 0, initial: 'deep-space'});
  m = anim.transition(m, {type: 'show', target: 'aurora'}, 0);
  const mid = anim.transition(m, {type: 'show', target: 'dusk'}, 50);
  assert.equal(mid.target, 'dusk');
  const done = anim.transition(anim.transition(m, {type: 'tick'}, p.durationMs), {type: 'tick'}, p.durationMs);
  assert.equal(done.phase, 'active');
  assert.equal(done.shown, 'aurora');
  assert.equal(anim.finish(mid, 60).shown, 'dusk');
});

test('pure module: no DOM, storage or timers', () => {
  const pure = src('src/ui/capsule-scene.ts');
  assert.doesNotMatch(pure, /document\.|window\.|localStorage|requestAnimationFrame|setTimeout/);
  assert.match(pure, /from '\.\/scenes'/);
  assert.match(pure, /from '\.\/anim-state'/);
});

test('wiring: store reads the pref key and runs the switch through anim-state; Capsules wires select, Preview and Resume', () => {
  const store = src('src/ui/store.tsx');
  assert.match(store, /CAPSULE_SCENE_PREF_KEY/);
  assert.match(store, /readPref<unknown>\(CAPSULE_SCENE_PREF_KEY/);
  assert.match(store, /writePref\(CAPSULE_SCENE_PREF_KEY/);
  assert.match(store, /console\.warn\(/);
  assert.match(store, /from '\.\/anim-state'/);
  assert.match(store, /transition\(m, \{ type: 'show', target: resolved\.sceneId \}/);
  assert.match(store, /stopSceneFrames\(\);/);
  assert.match(store, /applyCapsuleScene,/);
  assert.match(store, /cancelSceneTransition,/);
  const caps = src('src/components/Capsules.tsx');
  // The stylesheet exists but is not imported (existing esbuild bundles of Capsules.tsx have no CSS loader).
  assert.doesNotMatch(caps, /^import '\.\.\/styles\/capsule-scene\.css'/m);
  assert.match(src('src/styles/capsule-scene.css'), /\.capsule-scene-control/);
  assert.match(caps, /export function ProjectSceneControl/);
  assert.match(caps, /Use default/);
  assert.match(caps, /onChange=\{\(e\) => choose\(e\.target\.value\)\}/);
  assert.match(caps, /clearCapsuleScene\(capsule\.id\)/);
  assert.match(caps, /setCapsuleScene\(capsule\.id, value\)/);
  assert.match(caps, /onClick=\{\(\) => applyCapsuleScene\(capsule\.id\)\}>\s*Preview/);
  assert.match(caps, /Reduced motion: instant switch/);
  const restore = caps.slice(caps.indexOf('const doRestore'), caps.indexOf('const savedItems'));
  assert.match(restore, /applyCapsuleScene\(draft\.id\)/);
  assert.match(caps, /<ProjectSceneControl capsule=\{current\} \/>/);
  // Keyboard paths are untouched: the project map keyboard handler is still wired.
  assert.match(caps, /mapKeyboardTarget/);
});
