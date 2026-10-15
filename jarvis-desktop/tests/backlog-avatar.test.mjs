// Avatar backlog: motion principles (anticipation, follow-through, spring), seeded idle life, voice envelope,
// loop review, contact sheet, pack merge/undo robustness and honest gates. Bundles the real modules in memory.
// No window, storage, microphone, Electron or desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

async function load(rel, extra = {}) {
  const out = await build({ entryPoints: [path.join(root, rel)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', ...extra });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const av = await load('src/ui/avatar-editor.ts');

const N = av.NEUTRAL_EXPRESSION;
const SURPRISED = av.BUILT_IN_EXPRESSIONS.find((e) => e.id === 'builtin:surprised').expression;
const timeline = (keyframes, extra = {}) => ({ id: 't1', name: 'T', duration: 1000, loop: false, keyframes, ...extra });
const kf = (at, expressionId, ease = 'ease') => ({ at, expressionId, ease });
const pack = (over = {}) => ({ version: 1, name: 'Base', geometry: av.DEFAULT_GEOMETRY, expressions: [], timelines: [], ...over });
const expr = (id, name, over = {}) => ({ id, name, expression: { ...N, ...over } });

/* ------------------------------ easing: anticipation and follow-through ------------------------------ */

test('every ease starts at 0 and lands exactly on 1 (hold never moves)', () => {
  for (const z of av.EASE_OPTIONS.map((e) => e.id).filter((id) => id !== 'hold')) {
    assert.ok(Math.abs(av.applyEase(z, 0)) < 1e-9, `${z} at 0`);
    assert.ok(Math.abs(av.applyEase(z, 1) - 1) < 1e-9, `${z} at 1`);
  }
  assert.equal(av.applyEase('hold', 0.7), 0);
  assert.equal(av.applyEase('ease', Number.NaN), 0, 'non-finite input is safe');
});

test('anticipate dips below the start, overshoot and spring pass the target, plain eases stay inside', () => {
  const samples = Array.from({ length: 101 }, (_, i) => i / 100);
  assert.ok(Math.min(...samples.map((f) => av.applyEase('anticipate', f))) < -0.05, 'anticipation pulls back');
  assert.ok(Math.max(...samples.map((f) => av.applyEase('overshoot', f))) > 1.05, 'overshoot follows through');
  assert.ok(Math.max(...samples.map((f) => av.applyEase('spring', f))) > 1.05, 'spring overshoots');
  const spring = samples.map((f) => av.applyEase('spring', f));
  assert.ok(Math.abs(spring.at(-1) - 1) < 1e-9 && Math.abs(spring.at(-2) - 1) < 0.02, 'spring has settled by the end');
  for (const z of ['linear', 'ease', 'in', 'out']) {
    const v = samples.map((f) => av.applyEase(z, f));
    assert.ok(v.every((x, i) => i === 0 || x >= v[i - 1] - 1e-12), `${z} is monotonic`);
    assert.ok(v.every((x) => x >= 0 && x <= 1), `${z} stays inside 0..1`);
  }
});

test('timeline sampling follows the keyframe ease and stays inside every pose limit', () => {
  const saved = [];
  const tl = timeline([kf(0, 'builtin:neutral', 'anticipate'), kf(1000, 'builtin:surprised', 'ease')]);
  const early = av.sampleTimeline(tl, saved, 150);
  assert.ok(early.mouthOpen === 0 && early.browTilt < 0, 'anticipation moves the brow away from the surprised target first');
  const over = timeline([kf(0, 'builtin:neutral', 'overshoot'), kf(1000, 'builtin:happy', 'ease')]);
  const happy = av.BUILT_IN_EXPRESSIONS.find((e) => e.id === 'builtin:happy').expression;
  let peak = 0;
  for (let t = 0; t <= 1000; t += 10) {
    const e = av.sampleTimeline(over, saved, t);
    peak = Math.max(peak, e.glow);
    for (const [k, r] of Object.entries(av.EXPRESSION_LIMITS)) assert.ok(e[k] >= r.min && e[k] <= r.max && Number.isFinite(e[k]), `${k} at ${t}`);
  }
  assert.ok(peak > happy.glow, 'glow goes past the target pose and eases back');
  assert.deepEqual(av.sampleTimeline(over, saved, 1000), happy, 'it lands exactly on the target');
  assert.deepEqual(av.sampleTimeline(tl, saved, 0), N);
});

test('the same time always draws the same frame, and reduced motion steps instead of tweening', () => {
  const tl = av.BUILT_IN_TIMELINES.find((t) => t.id === 'builtin:startle');
  for (const t of [0, 123, 349, 350, 777, 2199, 5000]) assert.deepEqual(av.sampleTimeline(tl, [], t), av.sampleTimeline(tl, [], t));
  const seen = new Set();
  for (let t = 0; t <= tl.duration; t += 20) seen.add(JSON.stringify(av.sampleTimeline(tl, [], t, true)));
  const keyPoses = new Set(tl.keyframes.map((k) => JSON.stringify(av.findExpression(k.expressionId, []).expression)));
  assert.deepEqual(seen, keyPoses, 'only the keyframe poses appear, no in-between frames');
  const tweened = new Set();
  for (let t = 0; t <= tl.duration; t += 20) tweened.add(JSON.stringify(av.sampleTimeline(tl, [], t)));
  assert.ok(tweened.size > 20, 'normal playback does produce in-between frames');
});

test('ease names round trip through a pack, and unknown names fall back to the default ease', () => {
  const p = pack({ timelines: [timeline(av.EASE_OPTIONS.map((z, i) => kf(i * 100, 'builtin:neutral', z.id)), { duration: 1000 })] });
  const r = av.parseAvatarPack(av.serializeAvatarPack(p));
  assert.equal(r.ok, true);
  assert.deepEqual(r.pack.timelines[0].keyframes.map((k) => k.ease), av.EASE_OPTIONS.map((z) => z.id));
  const hostile = av.normalizeTimeline({ id: 'x', keyframes: [{ at: 0, expressionId: 'builtin:neutral', ease: 'bounce<script>' }, { at: 10, expressionId: 'builtin:neutral', ease: '__proto__' }] }, [], 'fb');
  assert.deepEqual(hostile.keyframes.map((k) => k.ease), ['ease', 'ease']);
});

test('built-in poses and timelines are valid, bounded and loops close their seam', () => {
  assert.ok(av.BUILT_IN_EXPRESSIONS.length >= 12);
  const ids = av.BUILT_IN_EXPRESSIONS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const e of av.BUILT_IN_EXPRESSIONS) assert.deepEqual(av.normalizeExpression(e.expression), e.expression, `${e.id} already inside limits`);
  const tlIds = av.BUILT_IN_TIMELINES.map((t) => t.id);
  assert.equal(new Set(tlIds).size, tlIds.length);
  const used = new Set();
  for (const t of av.BUILT_IN_TIMELINES) {
    assert.ok(av.isBuiltInId(t.id) && t.keyframes.length <= av.AVATAR_LIMITS.keyframes && t.duration <= av.AVATAR_LIMITS.maxDurationMs);
    for (const k of t.keyframes) {
      used.add(k.ease);
      assert.ok(av.EASE_OPTIONS.some((z) => z.id === k.ease), `${t.id} ease ${k.ease}`);
      assert.ok(av.findExpression(k.expressionId, []));
    }
    const rep = av.analyzeTimeline(t, []);
    if (t.loop) assert.ok(rep.seam <= av.SEAM_WARN, `${t.id} loop seam ${rep.seam}`);
    assert.deepEqual(rep.warnings, [], `${t.id} ships without review notes`);
  }
  for (const z of ['anticipate', 'overshoot', 'spring']) assert.ok(used.has(z), `a built-in timeline demonstrates ${z}`);
});

/* ------------------------------ timeline review and contact sheet ------------------------------ */

test('timeline review flags a loop seam jump, gaps, duplicates and flicker; clean loops report none', () => {
  const jumpy = timeline([kf(0, 'builtin:neutral'), kf(1000, 'builtin:surprised')], { loop: true });
  const r = av.analyzeTimeline(jumpy, []);
  assert.ok(r.seam > av.SEAM_WARN && r.warnings.some((w) => /Loop seam/.test(w)));
  const clean = av.analyzeTimeline(timeline([kf(0, 'builtin:neutral'), kf(500, 'builtin:happy'), kf(1000, 'builtin:neutral')], { loop: true }), []);
  assert.equal(clean.seam, 0);
  assert.deepEqual(clean.warnings, []);
  const messy = av.analyzeTimeline(timeline([kf(200, 'builtin:neutral'), kf(200, 'builtin:happy'), kf(250, 'builtin:neutral', 'spring')], { duration: 1000 }), []);
  assert.ok(messy.warnings.some((w) => /starts at 200 ms/.test(w)));
  assert.ok(messy.warnings.some((w) => /share 200 ms/.test(w)));
  assert.ok(messy.warnings.some((w) => /under 80 ms/.test(w)));
  assert.ok(messy.warnings.some((w) => /last keyframe is 750 ms before the end/.test(w)));
  assert.ok(messy.warnings.some((w) => /"spring" but has no next pose/.test(w)));
  assert.equal(av.analyzeTimeline(timeline([]), []).warnings[0], 'No keyframes yet.');
  assert.equal(av.analyzeTimeline(timeline([kf(0, 'builtin:neutral')]), []).seam, null);
});

test('frame times are evenly spaced, include both ends and are bounded', () => {
  assert.deepEqual(av.timelineFrameTimes(1000, 5), [0, 250, 500, 750, 1000]);
  assert.equal(av.timelineFrameTimes(1000, 999).length, 24);
  assert.equal(av.timelineFrameTimes(1000, 0).length, 2);
  assert.deepEqual(av.timelineFrameTimes(Number.NaN, Number.NaN).length, 8);
  assert.deepEqual(av.timelineFrameTimes(-5, 3), [0, 0, 0]);
});

test('contact sheet is deterministic, labelled, marks the loop wrap and is self-contained markup', () => {
  const tl = av.BUILT_IN_TIMELINES.find((t) => t.id === 'builtin:cadence');
  const a = av.renderContactSheetSvg(av.DEFAULT_GEOMETRY, tl, [], { frames: 8, columns: 4 });
  const b = av.renderContactSheetSvg(av.DEFAULT_GEOMETRY, tl, [], { frames: 8, columns: 4 });
  assert.equal(a, b, 'byte identical for identical input');
  assert.equal((a.match(/ ms/g) ?? []).length, 8);
  assert.match(a, /2400 ms \(wraps to 0\)/);
  assert.doesNotMatch(av.renderContactSheetSvg(av.DEFAULT_GEOMETRY, av.BUILT_IN_TIMELINES[0], []), /wraps/);
  assert.match(a, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal(/<script|javascript:|href=|<image|onload|onerror|url\(/i.test(a), false);
  assert.equal(/NaN|Infinity|undefined/.test(a), false);
  const hostile = { ...tl, name: '"><script>alert(1)</script>' };
  const h = av.renderContactSheetSvg(av.DEFAULT_GEOMETRY, hostile, []);
  assert.equal(/<script/i.test(h), false);
  assert.match(h, /&lt;script&gt;/);
  const different = av.renderContactSheetSvg({ ...av.DEFAULT_GEOMETRY, headShape: 'hex' }, tl, []);
  assert.notEqual(a, different);
});

test('contact sheet clamps hostile layout options', () => {
  const tl = av.BUILT_IN_TIMELINES[0];
  const s = av.renderContactSheetSvg(av.DEFAULT_GEOMETRY, tl, [], { frames: 1e9, columns: -4, cell: 1e9 });
  const m = /viewBox="0 0 (\d+) (\d+)"/.exec(s);
  assert.ok(Number(m[1]) <= 8 * 248 + 8 && Number(m[2]) < 24 * 280);
  assert.equal((s.match(/ ms/g) ?? []).length, 24);
});

/* ------------------------------ idle life (seeded) ------------------------------ */

test('idle layer is a pure, bounded function of time and seed', () => {
  assert.deepEqual(av.idleLayer(1234, 42), av.idleLayer(1234, 42));
  let blinked = false;
  let minEyes = 1;
  for (let t = 0; t < 60_000; t += 20) {
    const l = av.idleLayer(t, 42);
    assert.ok(l.eyes >= 0.05 && l.eyes <= 1 && Math.abs(l.dy) <= av.IDLE.breathPx + 1e-9 && Math.abs(l.tilt) <= av.IDLE.swayDeg + 1e-9, `t=${t}`);
    if (l.eyes < 1) blinked = true;
    minEyes = Math.min(minEyes, l.eyes);
  }
  assert.ok(blinked && minEyes < 0.1, 'blinks happen and nearly close the eyes');
  assert.notDeepEqual(
    Array.from({ length: 50 }, (_, i) => av.idleLayer(i * 400, 1).eyes),
    Array.from({ length: 50 }, (_, i) => av.idleLayer(i * 400, 99999).eyes),
    'a different seed gives a different rhythm',
  );
  for (const bad of [NaN, -5, Infinity]) assert.ok(Number.isFinite(av.idleLayer(bad, 1).dy));
});

test('idle blinks do not repeat on a metronome and no blink is longer than its window', () => {
  const seed = av.seedFromText('Companion');
  const starts = [];
  let prev = 1;
  for (let t = 0; t < 120_000; t += 10) {
    const e = av.idleLayer(t, seed).eyes;
    if (prev === 1 && e < 1) starts.push(t);
    prev = e;
  }
  assert.ok(starts.length >= 18 && starts.length <= 29, `blink count ${starts.length}`);
  const gaps = new Set(starts.slice(1).map((s, i) => s - starts[i]));
  assert.ok(gaps.size > 5, 'irregular gaps');
  assert.equal(av.seedFromText('Companion'), av.seedFromText('Companion'));
  assert.notEqual(av.seedFromText('Companion'), av.seedFromText('Companions'));
});

test('applyIdle only closes the eyes and rolls the head within the pose limits', () => {
  const e = av.applyIdle({ ...N, headTilt: 15 }, { eyes: 0.05, dy: 1, tilt: 1.2 });
  assert.ok(e.eyeOpen <= 0.05 && e.headTilt <= 15);
  assert.equal(av.applyIdle(N, av.NO_IDLE), N, 'no idle returns the same pose object');
});

test('the model source has no hidden randomness, clock, audio or navigator access', async () => {
  const src = await read('src/ui/avatar-editor.ts');
  assert.equal(/Math\.random|Date\.now|performance\.now|getUserMedia|AudioContext|MediaRecorder|navigator\.|fetch\(|localStorage/.test(src), false);
});

/* ------------------------------ voice envelope ------------------------------ */

test('voice smoothing attacks faster than it releases and always stays bounded', () => {
  const up = av.smoothVoiceLevel(0, 1, 30);
  const down = 1 - av.smoothVoiceLevel(1, 0, 30);
  assert.ok(up > down * 2, `attack ${up} vs release ${down}`);
  let v = 0;
  for (let i = 0; i < 40; i++) v = av.smoothVoiceLevel(v, 1, 16);
  assert.ok(v > 0.98 && v <= 1);
  for (let i = 0; i < 200 && v > 0; i++) v = av.smoothVoiceLevel(v, 0, 16);
  assert.equal(v, 0, 'releases all the way to silence so the frame loop can stop');
  for (const bad of [NaN, Infinity, -Infinity, 99, -3]) {
    const r = av.smoothVoiceLevel(bad, bad, bad);
    assert.ok(Number.isFinite(r) && r >= 0 && r <= 1, String(bad));
  }
  assert.equal(av.smoothVoiceLevel(0.4, 0.4, 0), 0.4, 'zero elapsed time changes nothing');
  assert.equal(av.smoothVoiceLevel(0.2, 0.9, 16), av.smoothVoiceLevel(0.2, 0.9, 16));
});

test('voice bands describe the injected level and clamp junk', () => {
  assert.deepEqual([0, 0.1, 0.5, 0.9, NaN, 7].map(av.voiceBand), ['silent', 'soft', 'speaking', 'loud', 'silent', 'loud']);
  assert.equal(av.applyVoiceLevel(N, 0), N, 'no level leaves the pose untouched');
});

/* ------------------------------ packs: BOM, summary, merge, file names ------------------------------ */

test('import accepts a UTF-8 byte order mark and CRLF text from Windows editors', () => {
  const text = `﻿${av.serializeAvatarPack(pack({ name: 'Win' })).replace(/\n/g, '\r\n')}`;
  const r = av.parseAvatarPack(text);
  assert.equal(r.ok, true);
  assert.equal(r.pack.name, 'Win');
  assert.equal(av.parseAvatarPack('﻿').ok, false);
});

test('pack summary counts what is in the pack', () => {
  const p = pack({ expressions: [expr('a', 'A')], timelines: [timeline([kf(0, 'a'), kf(500, 'builtin:neutral')], { loop: true }), timeline([kf(0, 'a')], { id: 't2' })] });
  const s = av.summarizePack(p);
  assert.deepEqual({ ...s, bytes: 0 }, { name: 'Base', expressions: 1, timelines: 2, keyframes: 3, loops: 1, bytes: 0 });
  assert.ok(s.bytes > 100 && s.bytes < av.AVATAR_LIMITS.packBytes);
});

test('merge adds imported poses and timelines, keeps geometry and name, and never mutates its inputs', () => {
  const base = pack({ name: 'Mine', geometry: { ...av.DEFAULT_GEOMETRY, bodyHue: 10 }, expressions: [expr('glad', 'Glad', { mouthCurve: 1 })] });
  const incoming = pack({
    name: 'Theirs',
    geometry: { ...av.DEFAULT_GEOMETRY, bodyHue: 300 },
    expressions: [expr('glad', 'Glad', { mouthCurve: 1 }), expr('sly', 'Sly', { browTilt: -1 })],
    timelines: [timeline([kf(0, 'glad'), kf(500, 'sly')], { id: 'wave', name: 'Wave' })],
  });
  const before = JSON.stringify([base, incoming]);
  const m = av.mergeAvatarPacks(base, incoming);
  assert.equal(JSON.stringify([base, incoming]), before, 'inputs untouched');
  assert.equal(m.pack.name, 'Mine');
  assert.equal(m.pack.geometry.bodyHue, 10);
  assert.deepEqual(m.pack.expressions.map((e) => e.id), ['glad', 'sly'], 'identical pose is not duplicated');
  assert.equal(m.addedExpressions, 1);
  assert.equal(m.addedTimelines, 1);
  assert.deepEqual(m.pack.timelines[0].keyframes.map((k) => k.expressionId), ['glad', 'sly']);
  assert.equal(av.parseAvatarPack(av.serializeAvatarPack(m.pack)).ok, true, 'result is a valid pack');
});

test('merge renames clashing ids, re-points keyframes and drops what does not fit with a warning', () => {
  const base = pack({ expressions: [expr('x', 'Mine', { mouthCurve: -1 })], timelines: [timeline([kf(0, 'x')], { id: 'wave' })] });
  const incoming = pack({ expressions: [expr('x', 'Theirs', { mouthCurve: 1 })], timelines: [timeline([kf(0, 'x'), kf(200, 'builtin:neutral')], { id: 'wave', name: 'Wave 2' })] });
  const m = av.mergeAvatarPacks(base, incoming);
  assert.equal(m.pack.expressions.length, 2);
  const newId = m.pack.expressions[1].id;
  assert.notEqual(newId, 'x');
  assert.match(newId, /^[a-z0-9:_-]{1,48}$/i);
  assert.equal(m.pack.expressions[0].expression.mouthCurve, -1, 'existing pose kept');
  assert.deepEqual(m.pack.timelines.map((t) => t.id), ['wave', 'wave-2']);
  assert.equal(m.pack.timelines[1].keyframes[0].expressionId, newId, 'incoming keyframe follows the renamed pose');
  assert.equal(m.pack.timelines[0].keyframes[0].expressionId, 'x', 'existing timeline still uses its own pose');

  const full = pack({ expressions: Array.from({ length: av.AVATAR_LIMITS.expressions }, (_, i) => expr(`e${i}`, `E${i}`, { glow: (i % 20) / 20 })), timelines: Array.from({ length: av.AVATAR_LIMITS.timelines }, (_, i) => timeline([kf(0, 'e0')], { id: `t${i}` })) });
  const over = av.mergeAvatarPacks(full, incoming);
  assert.equal(over.pack.expressions.length, av.AVATAR_LIMITS.expressions);
  assert.equal(over.pack.timelines.length, av.AVATAR_LIMITS.timelines);
  assert.ok(over.warnings.some((w) => /not added/.test(w)));
  const longId = 'a'.repeat(48);
  const crowded = av.mergeAvatarPacks(pack({ expressions: [expr(longId, 'L', { glow: 0.1 })] }), pack({ expressions: [expr(longId, 'L2', { glow: 0.9 })] }));
  assert.ok(crowded.pack.expressions[1].id.length <= 48 && crowded.pack.expressions[1].id !== longId);
});

test('merge is repeatable: importing the same pack twice adds nothing the second time', () => {
  const incoming = pack({ expressions: [expr('sly', 'Sly', { browTilt: -1 })], timelines: [timeline([kf(0, 'sly')], { id: 'a' })] });
  const once = av.mergeAvatarPacks(pack(), incoming).pack;
  const twice = av.mergeAvatarPacks(once, incoming);
  assert.equal(twice.addedExpressions, 0, 'identical pose is recognised');
  assert.equal(twice.pack.expressions.length, 1);
  assert.equal(twice.pack.timelines.length, 2, 'timelines are additive, with a fresh id');
});

test('file names are Windows safe: no separators, reserved device names, empties or long names', () => {
  assert.equal(av.safeFileStem('My Pal!'), 'my-pal');
  assert.equal(av.safeFileStem('..\\..\\evil/name'), 'evil-name');
  assert.equal(av.safeFileStem('CON'), 'con-pack');
  assert.equal(av.safeFileStem('lpt1'), 'lpt1-pack');
  assert.equal(av.safeFileStem('   '), 'avatar');
  assert.equal(av.safeFileStem('日本語'), 'avatar');
  assert.equal(av.safeFileStem('Ünïcode Pål'), 'unicode-pal');
  assert.ok(av.safeFileStem('x'.repeat(500)).length <= 40);
  assert.equal(av.safeFileStem(undefined), 'avatar');
  assert.equal(av.safeFileStem('', 'timeline'), 'timeline');
});

/* ------------------------------ rendering offsets ------------------------------ */

test('breathing offset translates the painter and the svg, and is absent when zero', () => {
  const calls = [];
  const rec = new Proxy({}, { get: (_t, k) => (k === 'fillStyle' || k === 'strokeStyle' || k === 'lineWidth' || k === 'lineCap' ? undefined : (...a) => calls.push([k, a])), set: () => true });
  av.drawAvatar(rec, 200, 200, av.DEFAULT_GEOMETRY, N, undefined, { dy: 1.2 });
  assert.ok(calls.some(([k, a]) => k === 'translate' && a[0] === 0 && a[1] === 1.2));
  const withFx = calls.filter(([k]) => k === 'translate').length;
  calls.length = 0;
  av.drawAvatar(rec, 200, 200, av.DEFAULT_GEOMETRY, N);
  assert.equal(calls.filter(([k]) => k === 'translate').length, withFx - 1, 'no offset means no extra translate');
  const svg = av.renderAvatarSvg(av.DEFAULT_GEOMETRY, N, 'x', { dy: 1.2 });
  assert.match(svg, /<g transform="translate\(0 1\.2\)">/);
  assert.equal(/<g transform="translate/.test(av.renderAvatarSvg(av.DEFAULT_GEOMETRY, N)), false);
  assert.equal(/NaN/.test(av.renderAvatarSvg(av.DEFAULT_GEOMETRY, N, 'x', { dy: NaN, dx: Infinity })), false);
});

test('new built-in poses draw finite shapes for every geometry style', () => {
  for (const id of ['builtin:curious', 'builtin:proud', 'builtin:confused', 'builtin:blink']) {
    const e = av.findExpression(id, []).expression;
    for (const shape of ['round', 'oval', 'square', 'hex']) assert.equal(/NaN|Infinity|undefined/.test(JSON.stringify(av.avatarShapes({ ...av.DEFAULT_GEOMETRY, headShape: shape }, e))), false, `${id}/${shape}`);
  }
});

/* ------------------------------ honest capability lists ------------------------------ */

test('exports and gates say plainly what is real and what is not', () => {
  const byId = Object.fromEntries(av.AVATAR_EXPORTS.map((x) => [x.id, x]));
  assert.equal(byId.json.status, 'available');
  assert.equal(byId['svg-sheet'].status, 'available');
  assert.equal(byId.video.status, 'unavailable');
  assert.match(byId.video.reason, /No encoder is bundled/);
  for (const x of av.AVATAR_EXPORTS) assert.ok(x.reason.length > 20);
  const gates = Object.fromEntries(av.AVATAR_GATES.map((g) => [g.id, g]));
  assert.equal(gates[133].status, 'unavailable');
  assert.equal(gates[135].status, 'unavailable');
  assert.equal(gates[134].status, 'injected');
  assert.match(gates[134].reason, /simulation/);
});

/* ------------------------------ the real component, rendered on the server ------------------------------ */

// One self-contained bundle (component, React and the static server renderer) so no bare imports remain.
const studio = await (async () => {
  try {
    const out = await build({
      stdin: {
        contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { AvatarStudio } from './src/components/AvatarStudio.tsx'; export const render = (props) => renderToStaticMarkup(createElement(AvatarStudio, props));`,
        resolveDir: root,
        loader: 'js',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(root + '/')});` },
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
    return await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  } catch (error) {
    return { error };
  }
})();

test('component bundles and renders with injected voice, simulated voice and reduced motion', { skip: studio.error ? String(studio.error).slice(0, 80) : false }, () => {
  const html = (props) => studio.render(props);
  const host = html({ reducedMotion: false, voiceLevel: 0.5 });
  assert.match(host, /Host voice/);
  assert.match(host, /Host amplitude/);
  assert.match(host, /Disabled while a host amplitude is attached/);
  assert.doesNotMatch(host, /Simulated voice/);
  const sim = html({ reducedMotion: false, voiceLevel: null });
  assert.match(sim, /No audio source is attached/);
  assert.match(sim, /not a microphone reading/);
  assert.doesNotMatch(sim, /Host amplitude/);
  assert.doesNotMatch(sim, /Host voice/);
  const reduced = html({ reducedMotion: true });
  assert.match(reduced, /Reduced motion is on/);
  assert.match(reduced, /Still/);
  assert.match(reduced, /Preview idle life/);
  for (const out of [host, sim, reduced]) {
    assert.match(out, /Not in this build/);
    assert.match(out, /No encoder is bundled/);
    assert.match(out, /3D avatar\/model customization/);
    assert.doesNotMatch(out, /undefined|NaN/);
  }
});

test('component source keeps imports reviewable, the voice honest and keyframe editing stable', async () => {
  const src = await read('src/components/AvatarStudio.tsx');
  const stage = src.slice(src.indexOf('const stageImport'), src.indexOf('const finishImport'));
  assert.ok(stage.includes('parseAvatarPack(') && stage.includes('setPending') && !stage.includes('savePack('), 'staging an import saves nothing');
  assert.match(src, /finishImport\('replace'\)/);
  assert.match(src, /finishImport\('merge'\)/);
  assert.match(src, /Undo \{undo\.label\}/);
  assert.match(src, /setUndo\(\{ label: 'reset'/, 'reset can be undone');
  assert.match(src, /disabled=\{hostVoice\}/, 'simulation slider is disabled while a host amplitude is attached');
  assert.match(src, /Simulated voice/);
  assert.match(src, /CommitNumber/);
  assert.equal(/key=\{`\$\{i\}-\$\{k\.at\}`\}/.test(src), false, 'keyframe rows must not remount while their time is edited');
  assert.match(src, /disabled=\{reducedMotion\}/, 'idle preview is off under reduced motion');
  assert.match(src, /const idleOn = rawIdle === true && !reducedMotion/);
  assert.ok(src.indexOf('file.size > AVATAR_LIMITS.packBytes') < src.indexOf('.text()'));
  assert.match(src, /exportSvg = \(\) => downloadText\(`\$\{stem\}\.svg`, renderAvatarSvg\(pack\.geometry, basePose\(scrub\)/, 'exports use the clean pose, not idle or voice layers');
  assert.equal(/getUserMedia|AudioContext|MediaRecorder|desktopCapturer|ipcRenderer|window\.(api|desktop)|\bfetch\(/.test(src), false);
});

test('the avatar stylesheet stays cheap and honors reduced motion', async () => {
  const css = await read('src/styles/avatar-studio.css');
  assert.equal(/@keyframes|animation\s*:|!important|100vh/.test(css), false);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:root\[data-motion="reduced"\]/);
  assert.match(css, /\.avs-sheet/);
  assert.match(css, /\.avs-meter/);
});
