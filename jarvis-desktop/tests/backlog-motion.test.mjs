import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFile(path.join(root, f), 'utf8');

async function load(file) {
  const out = await build({ entryPoints: [path.join(root, file)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  const code = out.outputFiles[0].text;
  return { code, m: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`) };
}

const { code: timingCode, m: t } = await load('src/ui/motion-timing.ts');
const { code: presetCode, m: mo } = await load('src/ui/motion-presets.ts');

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ------------------------------ purity ------------------------------ */

test('timing and preset modules are pure: no DOM, clock, storage, network or React', () => {
  for (const code of [timingCode, presetCode]) {
    assert.equal(/\bdocument\b|\bwindow\b|localStorage|from ['"]react['"]|Date\.now|performance\.now|Math\.random|\bfetch\(|XMLHttpRequest/.test(code), false);
  }
});

/* ------------------------------ easing ------------------------------ */

test('every named easing starts at 0 and lands on 1; anticipation dips below 0 and overshoot passes 1', () => {
  for (const e of t.EASING_LIST) {
    const fn = t.EASINGS[e.id];
    assert.ok(near(fn(0), 0, 1e-9), `${e.id}(0)`);
    assert.ok(near(fn(1), 1, 1e-9), `${e.id}(1)`);
  }
  assert.ok(t.EASINGS.anticipate(0.2) < 0, 'anticipate pulls back');
  assert.ok(t.EASINGS.overshoot(0.7) > 1, 'overshoot passes the target');
  assert.equal(t.EASINGS.hold(0.99), 0);
  assert.ok(t.EASINGS['in-out-cubic'](0.5) === 0.5);
});

test('cubic-bezier matches its CSS definition at known points and keeps x monotonic', () => {
  const lin = t.cubicBezier(0, 0, 1, 1);
  for (const u of [0.1, 0.33, 0.5, 0.9]) assert.ok(near(lin(u), u, 1e-5));
  const ease = t.cubicBezier(0.25, 0.1, 0.25, 1); // CSS "ease"
  assert.ok(near(ease(0.5), 0.8024033877399112, 1e-4));
  const wild = t.cubicBezier(-3, 0, 9, 1); // x handles clamped
  assert.ok(Number.isFinite(wild(0.5)));
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
});

/* ------------------------------ springs ------------------------------ */

test('closed-form spring: rest at 0, converges to 1, overshoots only when underdamped', () => {
  const under = { stiffness: 170, damping: 10, mass: 1 };
  const crit = { stiffness: 100, damping: 20, mass: 1 };
  const over = { stiffness: 100, damping: 60, mass: 1 };
  assert.equal(t.springValue(under, 0), 0);
  assert.ok(t.dampingRatio(under) < 1 && near(t.dampingRatio(crit), 1) && t.dampingRatio(over) > 1);
  for (const p of [under, crit, over]) assert.ok(near(t.springValue(p, 9.5), 1, 1e-3), JSON.stringify(p));
  assert.ok(t.springOvershoot(under) > 0.1);
  assert.equal(t.springOvershoot(crit), 0);
  assert.equal(t.springOvershoot(over), 0);
  // Exact solution check: underdamped velocity starts at 0 (numerical derivative near 0 is tiny).
  assert.ok(Math.abs(t.springValue(under, 1e-4) / 1e-4) < 0.05);
  // Settle time is consistent with the curve.
  const ts = t.springSettleTime(under);
  for (let s = ts; s < ts + 1; s += 0.05) assert.ok(Math.abs(1 - t.springValue(under, s)) <= 0.0011);
});

test('spring as a segment ease always lands exactly on 1 and reports when the segment is too short', () => {
  const p = { stiffness: 80, damping: 4, mass: 1 };
  const fn = t.springEase(p, 0.3);
  assert.equal(fn(1), 1);
  assert.ok(near(fn(0.999), 1, 0.01));
  assert.equal(t.springFitsSegment(p, 0.3), false);
  assert.equal(t.springFitsSegment({ stiffness: 300, damping: 40, mass: 1 }, 2), true);
  assert.deepEqual(t.normalizeSpring({ stiffness: 1e9, damping: -5, mass: 'x' }), { stiffness: 600, damping: 1, mass: 1 });
});

test('ease specs normalize, export to CSS and describe themselves', () => {
  assert.deepEqual(t.normalizeEase({ type: 'preset', name: 'nope' }), t.DEFAULT_EASE);
  assert.deepEqual(t.normalizeEase({ type: 'bezier', x1: 5, y1: 9, x2: -1, y2: -9 }), { type: 'bezier', x1: 1, y1: 2, x2: 0, y2: -1 });
  assert.equal(t.easeToCss({ type: 'preset', name: 'overshoot' }), 'cubic-bezier(0.34, 1.56, 0.64, 1)');
  const springCss = t.easeToCss({ type: 'spring', stiffness: 170, damping: 10, mass: 1 }, 1);
  assert.match(springCss, /^linear\(0, [\d., -]+, 1\)$/);
  assert.match(t.easeToCss({ type: 'preset', name: 'out-elastic' }), /^linear\(/);
  const r = t.easeRange({ type: 'preset', name: 'anticipate-overshoot' });
  assert.ok(r.min < 0 && r.max > 1);
});

/* ------------------------------ timeline and keys ------------------------------ */

test('frames are the unit of truth: time is derived and stepping wraps or clamps', () => {
  const loop = t.normalizeTimeline({ fps: 30, frames: 90, loop: true });
  const once = { ...loop, loop: false };
  assert.equal(t.frameToTime(45, 30), 1.5);
  assert.equal(t.timeToFrame(0.1, 30), 3, 'epsilon keeps 2.9999 on frame 3');
  assert.equal(t.stepFrame(89, 1, loop), 0);
  assert.equal(t.stepFrame(0, -1, loop), 89);
  assert.equal(t.stepFrame(89, 5, once), 89);
  assert.equal(t.stepFrame(0, -5, once), 0);
  assert.deepEqual(t.playbackFrame(80, 1, loop), { frame: 20, ended: false });
  assert.deepEqual(t.playbackFrame(80, 1, once), { frame: 89, ended: true });
  assert.equal(t.formatTimecode(67, 30), '2:07');
  const big = t.normalizeTimeline({ fps: 60, frames: 1e9, poster: 1e9 });
  assert.equal(big.frames, 1200);
  assert.equal(big.poster, 1199);
  assert.equal(t.normalizeTimeline({ fps: 7 }).fps, 30);
});

test('loop cycles are whole numbers so periodic motion closes exactly', () => {
  assert.equal(t.loopCycles(0, 4), 0);
  assert.equal(t.loopCycles(0.01, 4), 1, 'positive rate always gets one cycle');
  assert.equal(t.loopCycles(0.3, 10), 3);
  const tl = { fps: 24, frames: 96, loop: true, poster: 0 };
  const a = t.framePhase(0, tl, 0.37);
  const b = t.framePhase(96, tl, 0.37);
  assert.ok(near(Math.sin(a), Math.sin(b), 1e-9) && near(Math.cos(a), Math.cos(b), 1e-9));
});

test('keyframes interpolate with their ease, hold at ends one-shot and wrap back to the first key in a loop', () => {
  const tl = { fps: 30, frames: 100, loop: false, poster: 0 };
  const keys = t.normalizeKeys([{ frame: 50, value: 10, ease: { type: 'preset', name: 'linear' } }, { frame: 10, value: 0, ease: { type: 'preset', name: 'linear' } }, { frame: 10, value: 4 }], 100, 0, 100);
  assert.deepEqual(keys.map((k) => [k.frame, k.value]), [[10, 4], [50, 10]], 'sorted; later duplicate wins');
  const lin = t.normalizeKeys([{ frame: 10, value: 0, ease: { type: 'preset', name: 'linear' } }, { frame: 50, value: 10 }], 100, 0, 100);
  assert.equal(t.evaluateKeys(lin, 0, tl), 0);
  assert.equal(t.evaluateKeys(lin, 30, tl), 5);
  assert.equal(t.evaluateKeys(lin, 99, tl), 10);
  const loop = { ...tl, loop: true };
  assert.equal(t.evaluateKeys(lin, 50, loop), 10);
  assert.ok(near(t.evaluateKeys(lin, 110, loop), 0), 'frame frames+first.frame lands on the first key');
  assert.ok(near(t.evaluateKeys(lin, 0, loop), t.evaluateKeys(lin, 100, loop)), 'seam is continuous');
  const v = t.evaluateKeys(lin, 80, loop);
  assert.ok(v > 0 && v < 10, 'eases back towards the first key');
  assert.equal(t.evaluateKeys([], 3, tl), null);
  let list = [];
  for (let i = 0; i < 20; i++) list = t.upsertKey(list, { frame: i, value: i, ease: t.DEFAULT_EASE }).keys;
  assert.equal(list.length, t.MAX_KEYS);
  assert.equal(t.upsertKey(list, { frame: 99, value: 1, ease: t.DEFAULT_EASE }).ok, false);
  assert.equal(t.upsertKey(list, { frame: 3, value: 42, ease: t.DEFAULT_EASE }).keys[3].value, 42);
});

/* ------------------------------ seeded noise and quality ------------------------------ */

test('seeded randomness is repeatable, seed-sensitive and loop noise repeats every turn', () => {
  const a = t.seededRandom(42);
  const b = t.seededRandom(42);
  const xs = Array.from({ length: 50 }, () => a());
  assert.deepEqual(xs, Array.from({ length: 50 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notDeepEqual(xs.slice(0, 5), Array.from({ length: 5 }, t.seededRandom(43)));
  assert.equal(t.hash01(7, 3), t.hash01(7, 3));
  assert.notEqual(t.hash01(7, 3), t.hash01(7, 4));
  for (const ph of [0, 0.7, 2.2]) assert.ok(near(t.loopNoise(5, 1, ph), t.loopNoise(5, 1, ph + t.TAU), 1e-9));
});

test('quality profiles are ordered by cost and paint tracking flags sustained overruns', () => {
  const [eco, bal, studio] = ['eco', 'balanced', 'studio'].map((id) => t.QUALITY_PROFILES[id]);
  assert.ok(eco.maxDpr < bal.maxDpr && bal.maxDpr <= studio.maxDpr);
  assert.ok(eco.elementCap < bal.elementCap && bal.elementCap < studio.elementCap);
  assert.equal(eco.glow, false);
  let s = t.EMPTY_PAINT_STATS;
  for (let i = 0; i < 25; i++) s = t.trackPaint(s, 20, eco.budgetMs);
  assert.equal(t.overBudget(s), true);
  for (let i = 0; i < 30; i++) s = t.trackPaint(s, 1, eco.budgetMs);
  assert.equal(t.overBudget(s), false);
  assert.equal(s.samples.length, 30);
  assert.equal(t.previewIntervalMs({ fps: 60 }, eco), 1000 / 30);
});

test('contact sheets include the first and last frame and stay bounded', () => {
  const f = t.contactFrames({ fps: 30, frames: 120, loop: true, poster: 0 }, 12);
  assert.equal(f[0], 0);
  assert.equal(f[f.length - 1], 119);
  assert.equal(f.length, 12);
  assert.equal(t.contactFrames({ fps: 30, frames: 1200, loop: true, poster: 0 }, 500).length, 36);
  assert.equal(t.contactFrames({ fps: 30, frames: 3, loop: true, poster: 0 }, 12).length, 3);
});

/* ------------------------------ scene compatibility ------------------------------ */

test('lab kinds join the scene schema without changing the classic three', () => {
  assert.deepEqual(mo.MOTION_KINDS.map((k) => k.id), ['wave', 'particles', 'orbit']);
  assert.deepEqual(mo.ALL_MOTION_KINDS.map((k) => k.id), ['wave', 'particles', 'orbit', 'aurora', 'bloom', 'lattice']);
  for (const k of ['aurora', 'bloom', 'lattice']) assert.equal(mo.parseScene({ version: 1, name: 'x', background: 1, layers: [{ kind: k, intensity: 1, speed: 1, hue: 1, opacity: 1, seed: 1 }] }).ok, true, k);
  assert.equal(mo.parseScene({ version: 1, layers: [{ kind: 'cube' }] }).ok, false);
  assert.match(mo.SCENE_SCHEMA_HINT, /wave\|particles\|orbit\|aurora\|bloom\|lattice/);
});

/* ------------------------------ deterministic rendering ------------------------------ */

const allKindsLab = () => {
  const scene = { version: 1, name: 'All kinds', background: 220, layers: ['wave', 'particles', 'orbit', 'aurora'].map((kind, i) => ({ id: `l-${i + 1}`, kind, intensity: 60, speed: 45, hue: 200 + i * 30, opacity: 80, seed: 3 + i })) };
  return mo.labFromScene(scene, { fps: 24, frames: 72, loop: true });
};

test('the same frame renders identically, and jumping to a frame equals stepping to it', () => {
  const lab = allKindsLab();
  const a = mo.renderFrame(lab, 37, 320, 180);
  const b = mo.renderFrame(lab, 37, 320, 180);
  assert.deepEqual(a, b);
  for (let f = 0; f < 37; f++) mo.renderFrame(lab, f, 320, 180); // no hidden state advances
  assert.deepEqual(mo.renderFrame(lab, 37, 320, 180), a);
  assert.notDeepEqual(mo.renderFrame(lab, 38, 320, 180), a, 'motion actually changes between frames');
  assert.equal(a.time, 37 / 24);
  assert.equal(a.layers.length, 4);
  for (const l of a.layers) assert.ok(l.prims.length > 0, l.kind);
});

test('every kind, template and Lab preset closes its loop exactly', () => {
  for (const kind of mo.ALL_MOTION_KINDS.map((k) => k.id)) {
    for (const speed of [0, 10, 45, 100]) {
      const lab = mo.labFromScene({ version: 1, name: kind, background: 10, layers: [{ id: 'l-1', kind, intensity: 70, speed, hue: 40, opacity: 100, seed: 5 }] }, { fps: 30, frames: 97, loop: true });
      const r = mo.loopSeamReport(lab);
      assert.equal(r.exact, true, `${kind} speed ${speed} drift ${r.drift}`);
    }
  }
  for (const p of mo.LAB_PRESETS) {
    const r = mo.loopSeamReport(p.lab);
    assert.equal(r.exact, true, `${p.id} drift ${r.drift}`);
    assert.ok(r.cycles.every((c) => Number.isInteger(c) && c >= 1), `${p.id} cycles ${r.cycles}`);
  }
  for (const s of mo.SCENE_TEMPLATES) assert.equal(mo.loopSeamReport(mo.labFromScene(s)).exact, true, s.id);
  const once = { ...allKindsLab(), timeline: { ...allKindsLab().timeline, loop: false } };
  assert.equal(mo.loopSeamReport(once).loop, false);
});

test('seeds change the composition and quality bounds the element count', () => {
  const lab = (seed, kind = 'particles') => mo.labFromScene({ version: 1, name: 's', background: 1, layers: [{ id: 'l-1', kind, intensity: 100, speed: 50, hue: 1, opacity: 100, seed }] });
  assert.notDeepEqual(mo.renderFrame(lab(1), 10, 200, 100), mo.renderFrame(lab(2), 10, 200, 100));
  const eco = mo.renderFrame(lab(1), 10, 200, 100, t.QUALITY_PROFILES.eco);
  const studio = mo.renderFrame(lab(1), 10, 200, 100, t.QUALITY_PROFILES.studio);
  const circles = (f) => f.layers[0].prims.filter((p) => p.p === 'circle').length;
  assert.equal(circles(eco), 60);
  assert.equal(circles(studio), 160);
  assert.equal(eco.layers[0].prims.some((p) => p.p === 'glow'), false, 'eco draws no glows');
  const lat = mo.renderFrame(lab(1, 'lattice'), 0, 1600, 200, t.QUALITY_PROFILES.eco);
  assert.ok(lat.layers[0].prims.filter((p) => p.p === 'circle').length <= 60);
});

test('keyframe tracks drive resolved layer values and transforms', () => {
  const p = mo.LAB_PRESETS.find((x) => x.id === 'builtin:lab-halo').lab;
  const bloom = p.scene.layers[1];
  const at0 = mo.resolveLayer(p, bloom, 0);
  const at60 = mo.resolveLayer(p, bloom, 60);
  assert.ok(near(at0.scale, 0.96) && near(at60.scale, 1.08));
  assert.ok(near(at60.hue, 300));
  const f = mo.renderFrame(p, 60, 400, 225);
  assert.equal(f.layers[1].scale, 1.08);
  assert.equal(mo.resolveLayer(p, p.scene.layers[0], 30).scale, 1, 'untracked layer rests at 100%');
});

test('bloom core anticipates, bursts and settles back to rest', () => {
  assert.equal(mo.bloomCoreScale(0), 1);
  assert.ok(mo.bloomCoreScale(0.17) < 0.9, 'gathers first');
  assert.ok(mo.bloomCoreScale(0.3) > 1.25, 'bursts past rest');
  assert.ok(near(mo.bloomCoreScale(0.999), 1, 0.01), 'settles');
});

/* ------------------------------ lab documents ------------------------------ */

test('lab documents round-trip and the validator drops bad tracks with reasons', () => {
  for (const p of mo.LAB_PRESETS) {
    const r = mo.parseLab(mo.serializeLab(p.lab));
    assert.equal(r.ok, true, p.id);
    assert.deepEqual(r.lab, p.lab, p.id);
    assert.equal(r.issues.length, 0, `${p.id}: ${r.issues}`);
    assert.ok(mo.isBuiltInId(p.id));
  }
  assert.equal(new Set(mo.LAB_PRESETS.map((p) => p.id)).size, mo.LAB_PRESETS.length);
  const doc = JSON.parse(mo.serializeLab(mo.LAB_PRESETS[0].lab));
  doc.tracks.push({ layer: 'ghost', param: 'scale', keys: [{ frame: 0, value: 1 }] }, { layer: 'l-1', param: 'exec', keys: [] }, { layer: 'l-2', param: 'scale', keys: [] });
  doc.timeline.frames = 1e9;
  const r = mo.parseLab(doc);
  assert.equal(r.ok, true);
  assert.equal(r.lab.tracks.length, 2);
  assert.ok(r.issues.some((i) => /does not exist/.test(i)) && r.issues.some((i) => /unknown parameter/.test(i)) && r.issues.some((i) => /repeats/.test(i)));
  assert.equal(r.lab.timeline.frames, 600, '30 fps capped at 20 s');
  const plain = mo.parseLab(mo.serializeScene(mo.SCENE_TEMPLATES[0]));
  assert.equal(plain.ok, true);
  assert.ok(plain.issues.some((i) => /default timeline/.test(i)));
  for (const bad of ['{bad', '[]', JSON.stringify({ type: 'motion-lab', version: 2 }), JSON.stringify({ type: 'motion-lab', version: 1, scene: { version: 1, layers: [{ kind: 'script' }] } }), 'x'.repeat(mo.MAX_LAB_BYTES + 1)]) {
    const x = mo.parseLab(bad);
    assert.equal(x.ok, false, bad.slice(0, 40));
    assert.ok(x.error.length > 0);
  }
});

/* ------------------------------ exports ------------------------------ */

test('SVG frame export is well formed, escaped and contains no script or remote references', () => {
  const lab = { ...allKindsLab(), scene: { ...allKindsLab().scene, name: '<script>alert(1)</script>' } };
  const svg = mo.frameToSvg(mo.renderFrame(lab, 5, 320, 180), lab.scene.name);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="320" height="180"/);
  assert.ok(svg.endsWith('</svg>'));
  assert.equal(/<script|javascript:|href=|https:/.test(svg), false);
  assert.match(svg, /&lt;script&gt;/);
  assert.equal((svg.match(/<g /g) ?? []).length, 4);
  const sheet = mo.contactSheetSvg(mo.LAB_PRESETS[0].lab, 12, 160);
  assert.equal(sheet.frames[0], 0);
  assert.equal(sheet.frames.at(-1), mo.LAB_PRESETS[0].lab.timeline.frames - 1);
  assert.equal((sheet.svg.match(/>frame \d+/g) ?? []).length, sheet.frames.length);
});

test('CSS export maps tracks to properties with per-segment timing and respects reduced motion', () => {
  const css = mo.tracksToCss(mo.LAB_PRESETS.find((p) => p.id === 'builtin:lab-orrery').lab);
  assert.match(css, /@keyframes lab-l-2-scale \{/);
  assert.match(css, /scale: 0\.94; animation-timing-function: cubic-bezier\(0\.36, 0, 0\.66, -0\.56\)/);
  assert.match(css, /animation-timing-function: linear\(0, /, 'spring segment becomes linear()');
  assert.match(css, /100% \{ scale: 0\.94; \}/, 'loop closes on the first value');
  assert.match(css, /translate: -3% 0/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(mo.tracksToCss(mo.LAB_PRESETS[0].lab), /hue drives canvas drawing only/);
});

test('honest gates list unavailable encoders and features', () => {
  const text = mo.LAB_GATES.map((g) => `${g.feature} ${g.status}`).join(' ');
  assert.match(text, /GIF/);
  assert.match(text, /MP4/);
  assert.match(text, /Unavailable/);
  assert.match(text, /3D/);
});

