import test from 'node:test';
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
const {code: clipCode, m: clipMod} = await load('src/ui/clip-export.ts');
const {m: presets} = await load('src/ui/motion-presets.ts');
const {sampleClip, parseClip, clipToBlobParts} = clipMod;

// Scene built from an existing exported preset, plus a second layer so element arrays are non-trivial.
const base = presets.BUILT_IN_PRESETS.find((p) => p.id === 'builtin:orbit');
const scene0 = presets.sceneFromSettings(base, 'Clip test');
const scene = {...scene0, layers:[...scene0.layers, {...scene0.layers[0], id:'l-2', kind:'wave', speed:70, opacity:40, seed:11}]};

test('clip module is pure and offline: no DOM, clock, randomness or network', () => {
  assert.equal(/\bdocument\b|\bwindow\b|localStorage|requestAnimationFrame|Date\.now|performance\.now|Math\.random|\bfetch\(|XMLHttpRequest|https:\/\//.test(clipCode), false);
});

test('frameCount equals round(fps*durationMs/1000) and frame times increase monotonically', () => {
  for (const [fps, durationMs] of [[12, 1000], [24, 2500], [30, 1234], [60, 30000], [1, 30000]]) {
    const clip = sampleClip(scene, {fps, durationMs});
    assert.equal(clip.frameCount, Math.round(fps * durationMs / 1000));
    assert.equal(clip.frames.length, clip.frameCount);
    for (let i = 1; i < clip.frames.length; i++) assert.ok(clip.frames[i].t > clip.frames[i - 1].t, `frame ${i} time increases`);
    assert.equal(clip.frames[0].t, 0);
    assert.ok(clip.frames.at(-1).t < durationMs);
  }
});

test('envelope shape, per-element values and motion over time', () => {
  const clip = sampleClip(scene, {fps:24, durationMs:2000});
  assert.equal(clip.format, 'desktop-companion-clip');
  assert.equal(clip.version, 1);
  assert.equal(clip.license, 'original');
  assert.equal(clip.reducedMotion, false);
  assert.equal(clip.sceneId, 'clip-test');
  assert.equal(clip.fps, 24);
  assert.equal(clip.durationMs, 2000);
  for (const f of clip.frames) {
    assert.equal(f.elements.length, 2);
    for (const e of f.elements) for (const k of ['x', 'y', 'opacity', 'scale', 'phase', 'hue']) assert.ok(Number.isFinite(e[k]), k);
  }
  assert.deepEqual(clip.frames[0].elements.map((e) => [e.id, e.kind]), [['l-1', 'orbit'], ['l-2', 'wave']]);
  assert.equal(clip.frames[0].elements[1].opacity, 0.4);
  assert.notEqual(clip.frames[0].elements[0].phase, clip.frames[10].elements[0].phase, 'phase advances');
});

test('identical input gives identical output; reduced motion yields still frames', () => {
  const a = sampleClip(scene, {fps:30, durationMs:1500});
  const b = sampleClip(structuredClone(scene), {fps:30, durationMs:1500});
  assert.equal(clipToBlobParts(a)[0], clipToBlobParts(b)[0]);
  const still = sampleClip(scene, {fps:30, durationMs:1500, reducedMotion:true});
  assert.equal(still.reducedMotion, true);
  assert.equal(still.frameCount, a.frameCount);
  const first = JSON.stringify(still.frames[0].elements);
  assert.ok(still.frames.every((f) => JSON.stringify(f.elements) === first));
});

test('out-of-range fps and duration are rejected with descriptive errors', () => {
  for (const fps of [0, 61, 12.5, NaN, '24']) assert.throws(() => sampleClip(scene, {fps, durationMs:1000}), /fps must be an integer from 1 to 60/);
  for (const durationMs of [99, 30001, Infinity, undefined]) assert.throws(() => sampleClip(scene, {fps:24, durationMs}), /durationMs must be from 100 to 30000/);
  assert.doesNotThrow(() => sampleClip(scene, {fps:1, durationMs:100}));
  assert.doesNotThrow(() => sampleClip(scene, {fps:60, durationMs:30000}));
});

test('parseClip round-trips and blob parts are local JSON', () => {
  const clip = sampleClip(scene, {fps:12, durationMs:3000});
  const [text, opts] = clipToBlobParts(clip);
  assert.deepEqual(opts, {type:'application/json'});
  assert.deepEqual(parseClip(text), clip);
  const extra = JSON.parse(text); extra.script = 'alert(1)';
  assert.equal('script' in parseClip(JSON.stringify(extra)), false, 'unknown keys dropped');
});

test('parseClip rejects tampered frameCount, wrong format and other corruption', () => {
  const clip = sampleClip(scene, {fps:12, durationMs:1000});
  const json = (o) => JSON.stringify(o);
  assert.throws(() => parseClip(json({...clip, frameCount: clip.frameCount + 1})), /frameCount/);
  assert.throws(() => parseClip(json({...clip, frames: clip.frames.slice(1)})), /frames/);
  assert.throws(() => parseClip(json({...clip, format:'other-clip'})), /format/);
  assert.throws(() => parseClip(json({...clip, version:2})), /version/);
  assert.throws(() => parseClip(json({...clip, license:'cc-by'})), /license/);
  assert.throws(() => parseClip(json({...clip, fps:120})), /fps/);
  assert.throws(() => parseClip('not json'), /valid JSON/);
  assert.throws(() => parseClip('[]'), /JSON object/);
  const reversed = structuredClone(clip); reversed.frames[2].t = 0;
  assert.throws(() => parseClip(json(reversed)), /not increasing/);
  const badKind = structuredClone(clip); badKind.frames[0].elements[0].kind = 'script';
  assert.throws(() => parseClip(json(badKind)), /unknown kind/);
});

test('Motion Studio wires the Export clip control to sampleClip with reduced motion and a revoked object URL', async () => {
  const src = await readFile(path.join(root, 'src/components/MotionStudio.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/ui\/clip-export'/);
  assert.match(src, /sampleClip\(lab, \{ fps: jsonClipFps, durationMs: jsonClipMs, reducedMotion \}\)/);
  assert.match(src, />Export clip</);
  assert.match(src, /CLIP_EXPORT_FPS\.map/);
  assert.match(src, /clipToBlobParts\(/);
  assert.match(src, /URL\.revokeObjectURL/);
});
