// Motion Studio and Scene 3D authoring workflow. Pure helpers are exercised directly; components are
// rendered server-side with stubbed icons. GPU/recorder cleanup contracts live in substantial-scene3d.test.mjs
// and are additionally guarded here as source-level invariants so a refactor cannot silently drop them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (file) => readFile(path.join(root, file), 'utf8');
const [motionSrc, sceneSrc, primitivesSrc] = await Promise.all([read('src/components/MotionStudio.tsx'), read('src/components/Scene3D.tsx'), read('src/ui/primitives.tsx')]);

const iconNames = new Set();
for (const source of [motionSrc, sceneSrc, primitivesSrc]) {
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
    match[1].split(',').map((n) => n.trim().replace(/^type\s+.*/, '').replace(/\s+as\s+.*/, '')).filter(Boolean).forEach((n) => iconNames.add(n));
  }
}

async function bundle(contents) {
  const out = await build({
    stdin: { resolveDir: root, loader: 'tsx', contents },
    bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    external: ['react', 'react-dom'], loader: { '.css': 'empty' },
    plugins: [{ name: 'icons', setup(b) {
      b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icons' }));
      b.onLoad({ filter: /.*/, namespace: 'icons' }, () => ({ contents: [...iconNames].map((n) => `export const ${n}=()=>null;`).join('\n') }));
    } }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const motion = await bundle(`export * from './src/components/MotionStudio'; export {normalizeTimeline, playbackFrame, DEFAULT_TIMELINE} from './src/ui/motion-timing';`);
const scene = await bundle(`export * from './src/components/Scene3D'; export {normalizeScene, DEFAULT_SCENE, serializeScene} from './src/ui/scene3d';`);
const { createElement } = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const track = (layer, param, frames) => ({ layer, param, keys: frames.map((frame) => ({ frame, value: 50, ease: { type: 'preset', name: 'linear' } })) });

/* ---------------------------- Motion Studio: timeline ---------------------------- */

test('keyframeFrames merges tracks, de-duplicates, sorts and filters by layer', () => {
  const tracks = [track('a', 'opacity', [40, 0, 10]), track('a', 'scale', [10, 90]), track('b', 'opacity', [5])];
  assert.deepEqual(motion.keyframeFrames(tracks, 'a'), [0, 10, 40, 90]);
  assert.deepEqual(motion.keyframeFrames(tracks, 'b'), [5]);
  assert.deepEqual(motion.keyframeFrames(tracks), [0, 5, 10, 40, 90]);
  assert.deepEqual(motion.keyframeFrames(tracks, 'missing'), []);
  assert.deepEqual(motion.keyframeFrames([]), []);
});

test('adjacentKeyFrame is strict in both directions and null at the ends', () => {
  const frames = [0, 10, 40, 90];
  assert.equal(motion.adjacentKeyFrame(frames, 10, 1), 40);
  assert.equal(motion.adjacentKeyFrame(frames, 10, -1), 0);
  assert.equal(motion.adjacentKeyFrame(frames, 11, -1), 10);
  assert.equal(motion.adjacentKeyFrame(frames, 90, 1), null);
  assert.equal(motion.adjacentKeyFrame(frames, 0, -1), null);
  assert.equal(motion.adjacentKeyFrame([], 5, 1), null);
});

test('Play on a finished non-looping timeline restarts instead of stopping at once; looping timelines keep their frame', () => {
  const once = motion.normalizeTimeline({ ...motion.DEFAULT_TIMELINE, loop: false, frames: 60, fps: 30 });
  assert.equal(motion.restartFrame(59, once), 0);
  assert.equal(motion.restartFrame(30, once), 30);
  // Without the restart the playback engine would report ended immediately; after it, time advances.
  assert.equal(motion.playbackFrame(59, 0.1, once).ended, true);
  const restarted = motion.playbackFrame(motion.restartFrame(59, once), 0.1, once);
  assert.equal(restarted.ended, false);
  assert.equal(restarted.frame, 3);
  const looping = motion.normalizeTimeline({ ...once, loop: true });
  assert.equal(motion.restartFrame(59, looping), 59);
});

test('a recording stops as soon as playback stops, and only then', () => {
  assert.equal(motion.shouldStopRecording(true, false), true);
  assert.equal(motion.shouldStopRecording(true, true), false);
  assert.equal(motion.shouldStopRecording(false, false), false);
  assert.equal(motion.shouldStopRecording(false, true), false);
});

/* ---------------------------- Motion Studio: rendering ---------------------------- */

test('reduced-motion Motion Studio shows a still, disables Play and keeps accessible timeline controls', () => {
  const html = renderToStaticMarkup(createElement(motion.MotionStudio, { reducedMotion: true }));
  assert.match(html, /Reduced motion is on/);
  assert.match(html, /<button[^>]*disabled[^>]*>[\s\S]*?<span>Play<\/span>/);
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Frame stepping"/);
  assert.match(html, /<button[^>]*disabled[^>]*>[\s\S]*?<span>Previous keyframe<\/span>/);
  assert.match(html, /<button[^>]*disabled[^>]*>[\s\S]*?<span>Next keyframe<\/span>/);
  assert.match(html, /has no keyframes yet/);
  assert.match(html, /aria-valuetext="Frame 0, 0:00"/);
  assert.match(html, /Set keyframe at current frame/);
});

test('exports are bounded and truthful: no MP4/GIF buttons, no remote URLs, ready-not-saved wording', () => {
  const html = renderToStaticMarkup(createElement(motion.MotionStudio, { reducedMotion: false }));
  assert.doesNotMatch(html, /Export MP4|Export GIF|Record MP4|realistic|https?:\/\//i);
  assert.match(html, /GIF, MP4 and APNG export: Unavailable/);
  assert.match(html, /maxLength="65536"|maxlength="65536"/);
  for (const source of [motionSrc, sceneSrc]) {
    assert.doesNotMatch(source, /https?:\/\//);
    assert.doesNotMatch(source, /\b(?:was|been) saved to|Saved to disk|File saved/i);
    assert.match(source, /ready: choose where to save it/);
  }
});

test('Motion Studio releases recorder resources on unmount and on failure, and guards late file reads', () => {
  assert.match(motionSrc, /r\.rec\.onstop = null;[\s\S]*?r\.rec\.ondataavailable = null;[\s\S]*?r\.rec\.onerror = null;/);
  assert.match(motionSrc, /finally \{ r\.stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\); \}/);
  assert.match(motionSrc, /rec\.onerror = \(\) => \{[\s\S]*?stream\.getTracks\(\)\.forEach/);
  assert.match(motionSrc, /sequence === labImportSeq\.current/);
  assert.match(motionSrc, /file\.size > MAX_LAB_BYTES/);
  assert.match(motionSrc, /shouldStopRecording\(recording, canRun\)/);
  assert.match(motionSrc, /cancelAnimationFrame/);
});

/* ---------------------------- Scene 3D: presets ---------------------------- */

test('preset names are printable, markup-free and bounded', () => {
  assert.equal(scene.normalizePresetName('  Night\u0000 <b>garden</b>\n\tone  '), 'Night b garden /b one');
  assert.equal(scene.normalizePresetName('x'.repeat(500)).length, scene.MAX_PRESET_NAME);
  for (const bad of [undefined, null, 42, {}, [], '   ', '\u0000\u0001']) assert.equal(scene.normalizePresetName(bad), '');
});

test('stored presets are re-validated: junk dropped, scenes clamped, names de-duplicated, count capped', () => {
  const raw = [
    null, 'text', 7, { name: '' }, { name: 'Wild', scene: { objects: { orbs: 9999, particles: 9e9 }, camera: { distance: -5 }, remoteUrl: 'https://example.invalid' } },
    { name: 'wild', scene: {} }, { name: 'Calm' },
    ...Array.from({ length: 30 }, (_, i) => ({ name: `Extra ${i}`, scene: {} })),
  ];
  const list = scene.parseUserPresets(raw);
  assert.equal(list.length, scene.MAX_USER_PRESETS);
  assert.deepEqual(list.slice(0, 2).map((p) => p.name), ['Wild', 'Calm']);
  assert.equal(list[0].scene.objects.orbs, 24);
  assert.equal(list[0].scene.objects.particles, 4000);
  assert.equal(list[0].scene.camera.distance, 2);
  assert.equal('remoteUrl' in list[0].scene, false);
  assert.deepEqual(scene.parseUserPresets('not an array'), []);
  assert.deepEqual(scene.parseUserPresets({ length: 3 }), []);
});

test('saving replaces by case-insensitive name, refuses nameless and over-cap saves, and never mutates the input', () => {
  const base = scene.normalizeScene({});
  let list = [];
  const first = scene.upsertUserPreset(list, '  Dusk ', base);
  assert.equal(first.ok, true);
  assert.equal(first.replaced, false);
  assert.equal(list.length, 0);
  list = first.list;
  const edited = scene.normalizeScene({ camera: { fov: 80 } });
  const second = scene.upsertUserPreset(list, 'DUSK', edited);
  assert.equal(second.replaced, true);
  assert.equal(second.list.length, 1);
  assert.equal(second.list[0].name, 'DUSK');
  assert.equal(second.list[0].scene.camera.fov, edited.camera.fov);
  assert.equal(scene.upsertUserPreset(list, '   ', base).ok, false);
  let full = [];
  for (let i = 0; i < scene.MAX_USER_PRESETS; i++) full = scene.upsertUserPreset(full, `P${i}`, base).list;
  const over = scene.upsertUserPreset(full, 'One more', base);
  assert.equal(over.ok, false);
  assert.equal(over.list.length, scene.MAX_USER_PRESETS);
  assert.equal(scene.upsertUserPreset(full, 'p0', base).ok, true, 'replacing at the cap is still allowed');
});

test('frame step is one thirtieth of a second', () => {
  assert.equal(scene.STEP_SECONDS, 1 / 30);
});

/* ---------------------------- Scene 3D: rendering and lifecycle ---------------------------- */

test('Scene 3D shows stepping, presets and still-named exports with no video claims', () => {
  const html = renderToStaticMarkup(createElement(scene.Scene3D, { reducedMotion: true }));
  assert.match(html, /aria-label="Step back one frame \(1\/30 second\)"/);
  assert.match(html, /aria-label="Step forward one frame \(1\/30 second\)"/);
  assert.match(html, /Your presets/);
  assert.match(html, /No saved presets yet/);
  assert.match(html, /Save current scene as/);
  assert.match(html, /Playback is off/);
  assert.doesNotMatch(html, /Export MP4|Export GIF|https?:\/\//i);
});

test('Scene 3D keeps its GPU lifecycle: dispose on unmount, context-loss handlers and bounded imports', () => {
  assert.match(sceneSrc, /addEventListener\('webglcontextlost', onLost\)/);
  assert.match(sceneSrc, /removeEventListener\('webglcontextrestored', onRestored\)/);
  assert.match(sceneSrc, /rendererRef\.current\?\.dispose\(\);\s*rendererRef\.current = null;\s*glRef\.current = null;/);
  assert.match(sceneSrc, /file\.size > MAX_SCENE_BYTES/);
  assert.match(sceneSrc, /sequence === importSeqRef\.current/);
  assert.match(sceneSrc, /parseUserPresets\(rawUserPresets\)/);
});
