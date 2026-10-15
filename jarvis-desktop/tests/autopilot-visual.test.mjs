// Avatar and Motion studios: pure models, hostile imports, resource bounds, reduced motion, honest gates.
// Bundles the real TypeScript modules in memory with esbuild. No window, storage, Electron or desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(rel) {
  const out = await build({ entryPoints: [path.join(root, rel)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const av = await load('src/ui/avatar-editor.ts');
const mo = await load('src/ui/motion-presets.ts');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

const goodPack = () => ({
  version: 1,
  name: 'Orbit pal',
  geometry: { ...av.DEFAULT_GEOMETRY, headShape: 'hex', bodyHue: 120 },
  expressions: [{ id: 'glad', name: 'Glad', expression: { ...av.NEUTRAL_EXPRESSION, mouthCurve: 1 } }],
  timelines: [{ id: 'wave', name: 'Wave', duration: 1000, loop: false, keyframes: [{ at: 0, expressionId: 'builtin:neutral', ease: 'linear' }, { at: 1000, expressionId: 'glad', ease: 'linear' }] }],
});

/* ------------------------------ avatar: export and import ------------------------------ */

test('avatar pack survives an export then import round trip unchanged', () => {
  const first = av.parseAvatarPack(goodPack());
  assert.equal(first.ok, true);
  const text = av.serializeAvatarPack(first.pack);
  const second = av.parseAvatarPack(text);
  assert.equal(second.ok, true);
  assert.deepEqual(second.pack, first.pack);
  assert.equal(second.pack.geometry.headShape, 'hex');
  assert.equal(second.pack.timelines[0].keyframes.length, 2);
});

test('avatar import rejects non-JSON, arrays, scalars, wrong versions and missing geometry', () => {
  for (const bad of ['{nope', '[]', '42', 'null', '"text"', JSON.stringify({ version: 2, geometry: {} }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, geometry: {}, expressions: 'x' }), JSON.stringify({ version: 1, geometry: {}, timelines: {} })]) {
    const r = av.parseAvatarPack(bad);
    assert.equal(r.ok, false, `should reject ${bad}`);
    assert.ok(r.error.length > 0);
  }
});

test('avatar import enforces the byte limit on UTF-8 size, not character count', () => {
  const justUnder = JSON.stringify({ version: 1, geometry: {}, name: 'x'.repeat(100) });
  assert.equal(av.parseAvatarPack(justUnder).ok, true);
  // 30k three-byte characters is 30k "characters" but about 90 KB of bytes.
  const wide = JSON.stringify({ version: 1, geometry: {}, pad: '€'.repeat(30_000) });
  assert.ok(wide.length < av.AVATAR_LIMITS.packBytes);
  const r = av.parseAvatarPack(wide);
  assert.equal(r.ok, false);
  assert.match(r.error, /larger than/);
  assert.equal(av.parseAvatarPack('a'.repeat(av.AVATAR_LIMITS.packBytes + 1)).ok, false);
});

test('avatar import caps expressions, timelines and keyframes and says so', () => {
  const pack = goodPack();
  pack.expressions = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, name: `E${i}`, expression: {} }));
  pack.timelines = Array.from({ length: 200 }, (_, i) => ({
    id: `t${i}`,
    name: `T${i}`,
    duration: 5000,
    keyframes: Array.from({ length: 400 }, (_, k) => ({ at: k * 10, expressionId: 'e0', ease: 'linear' })),
  }));
  // Keep the document under the byte cap so the count limits are what is exercised.
  const r = av.parseAvatarPack(pack);
  if (r.ok) {
    assert.ok(r.pack.expressions.length <= av.AVATAR_LIMITS.expressions);
    assert.ok(r.pack.timelines.length <= av.AVATAR_LIMITS.timelines);
    for (const t of r.pack.timelines) assert.ok(t.keyframes.length <= av.AVATAR_LIMITS.keyframes);
  } else {
    assert.match(r.error, /larger than/);
  }
  const small = goodPack();
  small.expressions = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, name: `E${i}`, expression: {} }));
  small.timelines = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: 'T', duration: 1000, keyframes: [{ at: 0, expressionId: 'e0' }] }));
  const rs = av.parseAvatarPack(small);
  assert.equal(rs.ok, true);
  assert.equal(rs.pack.expressions.length, av.AVATAR_LIMITS.expressions);
  assert.equal(rs.pack.timelines.length, av.AVATAR_LIMITS.timelines);
  assert.ok(rs.warnings.some((w) => /first 32 expressions/.test(w)));
  assert.ok(rs.warnings.some((w) => /first 16 timelines/.test(w)));
});

test('avatar import clamps hostile numbers and reports it', () => {
  const pack = goodPack();
  pack.geometry = { ...pack.geometry, headWidth: 1e9, eyeSize: -50, bodyHue: 'abc', accentHue: Infinity, glowHue: null, eyeSpacing: '33' };
  pack.expressions[0].expression = { eyeOpen: 99, headTilt: -1000, glow: NaN, mouthCurve: '0.5' };
  const r = av.parseAvatarPack(JSON.stringify(pack).replace('null', 'null'));
  assert.equal(r.ok, true);
  const g = r.pack.geometry;
  assert.equal(g.headWidth, av.GEOMETRY_LIMITS.headWidth.max);
  assert.equal(g.eyeSize, av.GEOMETRY_LIMITS.eyeSize.min);
  assert.equal(g.bodyHue, av.DEFAULT_GEOMETRY.bodyHue, 'non-numeric falls back to the default');
  assert.equal(g.glowHue, av.DEFAULT_GEOMETRY.glowHue);
  assert.equal(g.eyeSpacing, 33, 'numeric strings are accepted as numbers');
  const e = r.pack.expressions[0].expression;
  assert.equal(e.eyeOpen, 1);
  assert.equal(e.headTilt, -15);
  assert.equal(e.mouthCurve, 0.5);
  for (const v of Object.values(e)) assert.ok(Number.isFinite(v));
  assert.ok(r.warnings.some((w) => /clamped/.test(w) && /headWidth/.test(w)), 'clamping is reported');
  // Real Infinity cannot be expressed in JSON; passing an object directly still must not leak it.
  const direct = av.parseAvatarPack({ version: 1, geometry: { headWidth: Infinity, eyeSize: NaN } });
  assert.equal(direct.ok, true);
  assert.ok(Number.isFinite(direct.pack.geometry.headWidth) && Number.isFinite(direct.pack.geometry.eyeSize));
});

test('avatar import drops reserved, duplicate and malformed ids and unknown keyframe targets', () => {
  const pack = goodPack();
  pack.expressions = [
    { id: 'builtin:happy', name: 'Hijack', expression: {} },
    { id: 'ok', name: 'Ok', expression: {} },
    { id: 'ok', name: 'Dupe', expression: {} },
    { id: '../../etc/passwd', name: 'Path', expression: {} },
    { id: '<img src=x onerror=alert(1)>', name: 'Markup', expression: {} },
    { id: 'noname', name: '   ', expression: {} },
    'string', null, 7,
  ];
  pack.timelines = [
    { id: 'builtin:greet', name: 'Hijack', duration: 1000, keyframes: [] },
    { id: 'tl', name: 'Tl', duration: 1000, keyframes: [{ at: 0, expressionId: 'ok' }, { at: 10, expressionId: 'missing' }, { at: 20, expressionId: 'builtin:happy' }, { at: 'x', expressionId: 'ok' }, null] },
    { id: 'tl', name: 'Second with same id', duration: 1000, keyframes: [] },
  ];
  const r = av.parseAvatarPack(pack);
  assert.equal(r.ok, true);
  assert.deepEqual(r.pack.expressions.map((x) => x.id), ['ok']);
  assert.equal(r.pack.expressions[0].name, 'Ok', 'first duplicate wins');
  assert.deepEqual(r.pack.timelines.map((t) => t.id), ['tl']);
  assert.deepEqual(r.pack.timelines[0].keyframes.map((k) => k.expressionId), ['ok', 'builtin:happy']);
  assert.ok(r.warnings.length >= 3);
});

test('avatar import does not pollute prototypes and ignores unknown keys', () => {
  const text = '{"version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"geometry":{"__proto__":{"polluted3":true},"headShape":"oval","extra":"<script>"},"evil":"x"}';
  const r = av.parseAvatarPack(text);
  assert.equal(r.ok, true);
  assert.equal({}.polluted, undefined);
  assert.equal({}.polluted2, undefined);
  assert.equal({}.polluted3, undefined);
  assert.equal(r.pack.geometry.headShape, 'oval');
  assert.deepEqual(Object.keys(r.pack).sort(), ['expressions', 'geometry', 'name', 'timelines', 'version']);
  assert.equal('extra' in r.pack.geometry, false);
  assert.equal(JSON.stringify(r.pack).includes('<script>'), false);
});

test('avatar import survives deeply nested JSON inside the byte budget', () => {
  const deep = '['.repeat(20_000) + ']'.repeat(20_000);
  const r = av.parseAvatarPack(deep);
  assert.equal(r.ok, false, 'an array is not a pack, and the parser did not hang or crash');
  const nestedGeometry = `{"version":1,"geometry":${'{"a":'.repeat(3000)}1${'}'.repeat(3000)}}`;
  assert.ok(nestedGeometry.length < av.AVATAR_LIMITS.packBytes);
  const r2 = av.parseAvatarPack(nestedGeometry);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.pack.geometry, av.DEFAULT_GEOMETRY);
});

test('avatar names lose control characters and are length bounded', () => {
  const name = av.normalizeName(`  a\u0000b\u001b[31m\n\t${'z'.repeat(200)}  `);
  assert.ok(name.length <= av.AVATAR_LIMITS.nameLength);
  assert.equal(/[\u0000-\u001f\u007f]/.test(name), false);
  assert.equal(av.normalizeName(42, 'fallback'), 'fallback');
  assert.equal(av.normalizeName('   ', 'fallback'), 'fallback');
});

test('hostile text can never become markup, script or an external reference in the SVG export', () => {
  const hostile = '"><script>alert(1)</script><img src=x onerror=alert(1)>&\'';
  const svg = av.renderAvatarSvg(av.DEFAULT_GEOMETRY, av.NEUTRAL_EXPRESSION, hostile);
  const tags = [...svg.matchAll(/<\/?([a-zA-Z][\w-]*)([^<>]*)>/g)];
  const allowed = new Set(['svg', 'title', 'ellipse', 'rect', 'polygon', 'path']);
  for (const [, name, attrs] of tags) {
    assert.ok(allowed.has(name), `unexpected element <${name}>`);
    assert.equal(/on\w+\s*=/i.test(attrs), false, 'no event handler attributes');
    assert.equal(/href|xlink|url\(|data:|javascript:/i.test(attrs), false, 'no references');
  }
  assert.equal(svg.replace(/<[^<>]*>/g, '').includes('<'), false, 'no stray markup in text nodes');
  assert.equal((svg.match(/https?:/g) ?? []).length, 1, 'only the SVG namespace URL appears');
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /&lt;script&gt;/);
  // Geometry from an import was clamped, so every number in the SVG is finite.
  const pack = av.parseAvatarPack({ version: 1, geometry: { headWidth: 1e12, eyeSpacing: -1e12, antennaHeight: NaN } });
  const s2 = av.renderAvatarSvg(pack.pack.geometry, av.NEUTRAL_EXPRESSION);
  assert.equal(/NaN|Infinity|undefined/.test(s2), false);
});

/* ------------------------------ avatar: timelines, voice, reduced motion ------------------------------ */

test('timeline tweens between poses and loops', () => {
  const p = av.parseAvatarPack(goodPack()).pack;
  const tl = p.timelines[0];
  const mid = av.sampleTimeline(tl, p.expressions, 500);
  assert.ok(Math.abs(mid.mouthCurve - (av.NEUTRAL_EXPRESSION.mouthCurve + 1) / 2) < 0.01, 'linear midpoint');
  assert.equal(av.sampleTimeline(tl, p.expressions, 0).mouthCurve, av.NEUTRAL_EXPRESSION.mouthCurve);
  assert.equal(av.sampleTimeline(tl, p.expressions, 9999).mouthCurve, 1, 'a non-looping timeline holds its last pose');
  const looping = { ...tl, loop: true };
  assert.equal(av.sampleTimeline(looping, p.expressions, 1500).mouthCurve, av.sampleTimeline(looping, p.expressions, 500).mouthCurve);
});

test('reduced motion removes tweening: the pose steps and never blends', () => {
  const p = av.parseAvatarPack(goodPack()).pack;
  const tl = p.timelines[0];
  const neutral = av.NEUTRAL_EXPRESSION;
  for (const t of [0, 100, 500, 999]) assert.deepEqual(av.sampleTimeline(tl, p.expressions, t, true), neutral, `holds the outgoing pose at ${t} ms`);
  assert.equal(av.sampleTimeline(tl, p.expressions, 1000, true).mouthCurve, 1);
  // Never produces an in-between value: only keyframe poses appear.
  const seen = new Set();
  for (let t = 0; t <= 1000; t += 25) seen.add(av.sampleTimeline(tl, p.expressions, t, true).mouthCurve);
  assert.deepEqual([...seen].sort(), [av.NEUTRAL_EXPRESSION.mouthCurve, 1].sort());
});

test('timeline sampling tolerates empty, unsorted and non-finite input', () => {
  const empty = { id: 't', name: 'T', duration: 1000, loop: true, keyframes: [] };
  assert.deepEqual(av.sampleTimeline(empty, [], 123), av.NEUTRAL_EXPRESSION);
  const tl = av.normalizeTimeline({ id: 'x', name: 'X', duration: 1000, keyframes: [{ at: 900, expressionId: 'builtin:happy' }, { at: 100, expressionId: 'builtin:sleepy' }] }, [], 'fb');
  assert.deepEqual(tl.keyframes.map((k) => k.at), [100, 900]);
  for (const t of [NaN, Infinity, -Infinity, -5]) {
    const e = av.sampleTimeline(tl, [], t);
    for (const v of Object.values(e)) assert.ok(Number.isFinite(v));
  }
  assert.equal(av.normalizeTimeline('not an object', [], 'fb'), null);
  assert.equal(av.normalizeTimeline({ duration: 1e12 }, [], 'fb').duration, av.AVATAR_LIMITS.maxDurationMs);
  assert.equal(av.normalizeTimeline({ duration: 1 }, [], 'fb').duration, av.AVATAR_LIMITS.minDurationMs);
});

test('built-in timelines only reference built-in expressions that exist', () => {
  for (const tl of av.BUILT_IN_TIMELINES) for (const k of tl.keyframes) assert.ok(av.findExpression(k.expressionId, []), `${tl.id} -> ${k.expressionId}`);
  assert.ok(av.BUILT_IN_EXPRESSIONS.length >= 8);
  assert.equal(new Set(av.BUILT_IN_EXPRESSIONS.map((e) => e.id)).size, av.BUILT_IN_EXPRESSIONS.length);
});

test('saved expressions and timelines respect id, name and count rules', () => {
  assert.equal(av.upsertExpression([], { id: 'builtin:x', name: 'X', expression: {} }).ok, false);
  assert.equal(av.upsertExpression([], { id: 'ok', name: '  ', expression: {} }).ok, false);
  assert.equal(av.upsertExpression([], { id: 'bad id!', name: 'X', expression: {} }).ok, false);
  let list = [];
  for (let i = 0; i < av.AVATAR_LIMITS.expressions; i++) list = av.upsertExpression(list, { id: `e${i}`, name: `E${i}`, expression: av.NEUTRAL_EXPRESSION }).list;
  const full = av.upsertExpression(list, { id: 'extra', name: 'Extra', expression: av.NEUTRAL_EXPRESSION });
  assert.equal(full.ok, false);
  assert.equal(full.list.length, av.AVATAR_LIMITS.expressions);
  assert.equal(av.upsertExpression(list, { id: 'e0', name: 'Renamed', expression: av.NEUTRAL_EXPRESSION }).ok, true, 'editing an existing one still works when full');
  assert.equal(av.upsertTimeline([], { id: 'builtin:greet', name: 'x', duration: 1000, loop: false, keyframes: [] }).ok, false);
});

test('voice level is injected and bounded, and never reads a microphone', async () => {
  const neutral = av.NEUTRAL_EXPRESSION;
  assert.equal(av.applyVoiceLevel(neutral, 0), neutral);
  assert.ok(av.applyVoiceLevel(neutral, 1).mouthOpen > neutral.mouthOpen);
  for (const bad of [NaN, -3, Infinity]) {
    const e = av.applyVoiceLevel(neutral, bad);
    assert.ok(e.mouthOpen >= 0 && e.mouthOpen <= 1 && Number.isFinite(e.glow));
  }
  assert.ok(av.applyVoiceLevel(neutral, 99).mouthOpen <= 1);
  const src = await read('src/ui/avatar-editor.ts');
  assert.equal(/getUserMedia|AudioContext|MediaRecorder|navigator\./.test(src), false);
});

test('gates state honestly what is not implemented', () => {
  const byId = Object.fromEntries(av.AVATAR_GATES.map((g) => [g.id, g]));
  assert.equal(byId[133].status, 'unavailable');
  assert.equal(byId[135].status, 'unavailable');
  assert.equal(byId[134].status, 'injected');
  assert.equal(byId[136].status, 'manual');
  assert.match(byId[135].reason, /Nothing here animates photographs/);
  for (const g of av.AVATAR_GATES) assert.ok(g.reason.length > 20);
});

test('quality profiles bound frame rate and pixel ratio and unknown ids fall back', () => {
  for (const q of av.QUALITY_PROFILES) assert.ok(q.fps <= 60 && q.maxDpr <= 2);
  assert.equal(av.qualityProfile('nonsense').id, av.DEFAULT_QUALITY);
  assert.equal(av.qualityProfile('battery').fps, 24);
});

test('avatar shapes are finite and the painter only issues canvas calls', () => {
  for (const shape of ['round', 'oval', 'square', 'hex']) {
    for (const mouth of ['line', 'arc', 'bar']) {
      for (const eye of ['dot', 'ring', 'bar']) {
        const g = { ...av.DEFAULT_GEOMETRY, headShape: shape, mouthStyle: mouth, eyeStyle: eye };
        for (const expr of av.BUILT_IN_EXPRESSIONS) {
          const shapes = av.avatarShapes(g, expr.expression);
          assert.ok(shapes.length >= 6);
          assert.equal(/NaN|Infinity|undefined/.test(JSON.stringify(shapes)), false, `${shape}/${mouth}/${eye}/${expr.id}`);
        }
      }
    }
  }
  const calls = [];
  const rec = new Proxy({}, { get: (_t, k) => (k === 'fillStyle' || k === 'strokeStyle' || k === 'lineWidth' || k === 'lineCap' ? undefined : (...a) => calls.push([k, a])), set: () => true });
  av.drawAvatar(rec, 300, 300, av.DEFAULT_GEOMETRY, av.NEUTRAL_EXPRESSION, class { constructor(d) { this.d = d; } });
  assert.ok(calls.some(([k]) => k === 'ellipse') && calls.some(([k]) => k === 'fill'));
  assert.equal(calls.filter(([k]) => k === 'save').length, calls.filter(([k]) => k === 'restore').length, 'balanced save/restore');
});

test('stored pack falls back to the default when storage is corrupt', () => {
  for (const bad of [undefined, null, 'garbage', 12, [], { version: 9 }]) assert.deepEqual(av.packFromStorage(bad), av.DEFAULT_PACK);
  assert.equal(av.packFromStorage(goodPack()).name, 'Orbit pal');
});

/* ------------------------------ motion: scenes, imports, bounds ------------------------------ */

const goodScene = () => ({
  version: 1,
  name: 'Night tide',
  background: 210,
  layers: [
    { kind: 'wave', intensity: 60, speed: 30, hue: 200, opacity: 90, seed: 7 },
    { kind: 'particles', intensity: 20, speed: 20, hue: 180, opacity: 50, seed: 11 },
  ],
});

test('scene survives export then import with identical content', () => {
  const a = mo.parseScene(goodScene());
  assert.equal(a.ok, true);
  const b = mo.parseScene(mo.serializeScene(a.scene));
  assert.equal(b.ok, true);
  assert.deepEqual(b.scene, a.scene);
  assert.equal(b.issues.length, 0);
  for (const t of mo.SCENE_TEMPLATES) assert.equal(mo.parseScene(mo.serializeScene(t)).ok, true, t.id);
});

test('scene import rejects structural problems with a reason', () => {
  const cases = [
    '{bad', '[]', '7', 'null',
    JSON.stringify({ version: 2, layers: [{ kind: 'wave' }] }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, layers: [] }),
    JSON.stringify({ version: 1, layers: 'wave' }),
    JSON.stringify({ version: 1, layers: [{ kind: 'script' }] }),
    JSON.stringify({ version: 1, layers: [{ kind: '<img src=x onerror=1>' }] }),
    JSON.stringify({ version: 1, layers: ['wave'] }),
  ];
  for (const c of cases) {
    const r = mo.parseScene(c);
    assert.equal(r.ok, false, `should reject ${c}`);
    assert.ok(r.error.length > 0);
  }
});

test('scene import bounds bytes, layers, numbers and names', () => {
  const pad = JSON.stringify({ ...goodScene(), pad: '€'.repeat(8000) });
  assert.ok(pad.length < mo.MAX_SCENE_BYTES);
  assert.equal(mo.parseScene(pad).ok, false, 'multi-byte padding is measured in bytes');
  assert.equal(mo.parseScene('x'.repeat(mo.MAX_SCENE_BYTES + 1)).ok, false);

  const many = { ...goodScene(), layers: Array.from({ length: 50 }, (_, i) => ({ kind: 'orbit', intensity: i })) };
  const r = mo.parseScene(many);
  assert.equal(r.ok, true);
  assert.equal(r.scene.layers.length, mo.MAX_LAYERS);
  assert.ok(r.issues.some((i) => /first 4 layers/.test(i)));

  const wild = mo.parseScene({ version: 1, name: `${'N'.repeat(500)}\u0000\u001b`, background: 9999, layers: [{ kind: 'wave', intensity: 1e9, speed: -5, hue: 'x', opacity: 500, seed: 0 }] });
  assert.equal(wild.ok, true);
  const l = wild.scene.layers[0];
  assert.equal(l.intensity, 100);
  assert.equal(l.speed, 0);
  assert.equal(l.opacity, 100);
  assert.equal(l.seed, 1);
  assert.equal(wild.scene.background, 360);
  assert.ok(wild.scene.name.length <= mo.MAX_PRESET_NAME && !/[\u0000-\u001f]/.test(wild.scene.name));
  assert.ok(wild.issues.some((i) => /clamped/.test(i)));
});

test('scene import fixes duplicate layer ids and drops unknown keys without polluting prototypes', () => {
  const text = '{"version":1,"__proto__":{"p1":1},"layers":[{"id":"a","kind":"wave","__proto__":{"p2":1},"extra":"<script>"},{"id":"a","kind":"orbit"}]}';
  const r = mo.parseScene(text);
  assert.equal(r.ok, true);
  assert.equal(new Set(r.scene.layers.map((l) => l.id)).size, 2);
  assert.equal({}.p1, undefined);
  assert.equal({}.p2, undefined);
  assert.equal(JSON.stringify(r.scene).includes('script'), false);
  assert.equal(mo.parseScene({ version: 1, layers: [{ kind: 'wave', id: '../x y' }] }).scene.layers[0].id.includes('/'), false);
});

test('model-style replies are parsed only after validation, never trusted', () => {
  const reply = 'Sure! Here is a scene:\n```json\n' + JSON.stringify(goodScene()) + '\n```\nEnjoy.';
  const ok = mo.sceneFromText(reply);
  assert.equal(ok.ok, true);
  assert.equal(ok.scene.layers.length, 2);
  assert.equal(mo.sceneFromText('no braces here').ok, false);
  const bad = mo.sceneFromText('{"version":1,"layers":[{"kind":"exec","cmd":"calc.exe"}]}');
  assert.equal(bad.ok, false);
  assert.match(mo.SCENE_SCHEMA_HINT, /wave\|particles\|orbit/);
});

test('saved presets and scenes are capped, deduplicated and cannot claim built-in ids', () => {
  const presets = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, kind: 'wave', intensity: 1 }));
  presets.unshift({ id: 'builtin:wave', name: 'Hijack', kind: 'wave' }, { id: 'p0', name: 'Dupe', kind: 'orbit' }, null, 'x', { id: 'noName', name: '', kind: 'wave' }, { id: 'bad', name: 'N', kind: 'nope' });
  const out = mo.parseSavedPresets(presets);
  assert.equal(out.length, mo.MAX_SAVED_PRESETS);
  assert.equal(out.some((p) => p.id.startsWith('builtin:')), false);
  assert.equal(out.filter((p) => p.id === 'p0').length, 1);
  assert.deepEqual(mo.parseSavedPresets('not an array'), []);

  const scenes = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, ...goodScene() }));
  scenes.unshift({ id: 'builtin:tide', ...goodScene() }, { id: 'bad', version: 9, layers: [] });
  const sc = mo.parseSavedScenes(scenes);
  assert.equal(sc.length, mo.MAX_SAVED_SCENES);
  assert.equal(sc.some((s) => s.id.startsWith('builtin:')), false);
  let list = [];
  for (let i = 0; i < mo.MAX_SAVED_SCENES; i++) list = mo.upsertScene(list, { id: `s${i}`, ...mo.parseScene(goodScene()).scene }).list;
  assert.equal(mo.upsertScene(list, { id: 'overflow', ...mo.parseScene(goodScene()).scene }).ok, false);
  assert.equal(mo.upsertScene(list, { id: 'builtin:x', ...mo.parseScene(goodScene()).scene }).ok, false);
});

test('resource bounds: particle, orbit, layer and clip counts have hard ceilings', () => {
  assert.equal(mo.particleCount(1e9), 160);
  assert.equal(mo.particleCount(-5), 24);
  assert.equal(mo.orbitCount(1e9), 8);
  assert.equal(mo.waveLayerCount(1e9), 5);
  const plan = mo.normalizeClipPlan({ fps: 999, seconds: 1e9, width: 1e9, height: 1e9 });
  assert.equal(plan.fps, 24);
  assert.equal(plan.seconds, mo.CLIP_LIMITS.maxSeconds);
  assert.equal(plan.width, mo.CLIP_LIMITS.maxWidth);
  assert.ok(mo.clipFrameCount({ fps: 30, seconds: 10, width: 1280, height: 720 }) <= mo.CLIP_LIMITS.maxFrames);
  assert.equal(mo.clipFrameCount({ fps: 30, seconds: 10000, width: 1, height: 1 }), mo.CLIP_LIMITS.maxFrames);
  assert.equal(mo.normalizeClipPlan({}).fps, 24);
});

test('reduced motion: speed 0 freezes time and a zero step leaves particles untouched', () => {
  assert.equal(mo.timeScale(0), 0);
  assert.ok(mo.timeScale(1) > 0);
  assert.ok(mo.timeScale(100) <= 2.5);
  assert.equal(mo.timeScale(-50), 0);
  const ps = mo.seedParticles(40, 5);
  const before = JSON.stringify(ps);
  mo.stepParticles(ps, 0, 80, 3);
  mo.stepParticles(ps, -1, 80, 3);
  mo.stepParticles(ps, NaN, 80, 3);
  assert.equal(JSON.stringify(ps), before);
  mo.stepParticles(ps, 0.5, 80, 3);
  assert.notEqual(JSON.stringify(ps), before);
  for (let i = 0; i < 400; i++) mo.stepParticles(ps, 0.25, 100, i);
  for (const p of ps) assert.ok(p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1, 'particles stay on the canvas');
});

test('simulations are deterministic for a seed and time', () => {
  assert.deepEqual(mo.seedParticles(30, 9), mo.seedParticles(30, 9));
  assert.notDeepEqual(mo.seedParticles(30, 9), mo.seedParticles(30, 10));
  assert.deepEqual(mo.seedOrbits(5, 4), mo.seedOrbits(5, 4));
  assert.equal(mo.wavePoint(1, 0.3, 2, 50), mo.wavePoint(1, 0.3, 2, 50));
  const b = mo.seedOrbits(1, 1)[0];
  const p = mo.orbitPosition(b, 12.5);
  assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1);
});

test('built-in preset and template ids are reserved and cannot be overwritten', () => {
  for (const p of mo.BUILT_IN_PRESETS) assert.equal(mo.upsertPreset([], { ...p }).ok, false, p.id);
  assert.equal(mo.upsertPreset([], { id: 'p-1', name: '  ', kind: 'wave', intensity: 1, speed: 1, hue: 1 }).ok, false);
  const r = mo.upsertPreset([], { id: 'p-1', name: 'Mine', kind: 'orbit', intensity: 500, speed: -1, hue: 9999 });
  assert.equal(r.ok, true);
  assert.deepEqual([r.list[0].intensity, r.list[0].speed, r.list[0].hue], [100, 0, 360]);
});

/* ------------------------------ components and styles (source-level contract) ------------------------------ */

const cssFiles = ['src/styles/avatar-studio.css', 'src/styles/motion-studio.css'];
const tsxFiles = ['src/components/AvatarStudio.tsx', 'src/components/MotionStudio.tsx'];
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('studio stylesheets honor reduced motion and animate only cheap properties', async () => {
  for (const f of cssFiles) {
    const css = await read(f);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, `${f} OS query`);
    assert.match(css, /:root\[data-motion="reduced"\]/, `${f} in-app setting`);
    assert.equal(/@keyframes|animation\s*:/.test(css), false, `${f} has no keyframe animation`);
    assert.equal(/!important/.test(css), false, `${f} avoids !important`);
    assert.equal(/100vh/.test(css), false, `${f} avoids 100vh`);
    for (const m of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
      if (m[1].trim() === 'none') continue;
      for (const prop of m[1].split(',').map((x) => x.trim().split(/\s+/)[0])) assert.match(prop, /^(transform|opacity|border-color|background|color)$/, `${f} transitions ${prop}`);
    }
  }
});

test('studio components render data as text only and call no network or native bridge', async () => {
  for (const f of tsxFiles) {
    const code = stripComments(await read(f));
    assert.equal(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/.test(code), false, `${f} no HTML or code injection sinks`);
    assert.equal(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|https?:\/\//.test(code), false, `${f} makes no network calls`);
    assert.equal(/getUserMedia|desktopCapturer|ipcRenderer|window\.(api|desktop)/.test(code), false, `${f} does not reach microphone, screen or native bridges`);
    assert.match(code, /usePref/, `${f} persists through the non-sensitive pref helper`);
  }
});

test('visible copy has no em or en dashes and does not promise 3D or realistic portraits', async () => {
  for (const f of tsxFiles) {
    const code = stripComments(await read(f));
    assert.equal(/[–—]/.test(code), false, `${f} dash characters in code or copy`);
  }
  const avatar = await read('src/components/AvatarStudio.tsx');
  assert.match(avatar, /AVATAR_GATES/, 'unavailable scopes are shown from the honest gate list');
  assert.equal(/photorealistic|lifelike|hyper-?realistic|deepfake/i.test(avatar), false);
});

test('avatar studio checks file size before reading and shows import warnings', async () => {
  const src = await read('src/components/AvatarStudio.tsx');
  const sizeAt = src.indexOf('file.size > AVATAR_LIMITS.packBytes');
  const readAt = src.indexOf('.text()');
  assert.ok(sizeAt > 0 && readAt > sizeAt, 'size check precedes file.text()');
  assert.match(src, /parseAvatarPack\(/);
  assert.match(src, /warnings/);
  assert.match(src, /reducedMotion/);
});

test('motion studio reports an unsupported recorder and cancels its animation frame', async () => {
  const src = await read('src/components/MotionStudio.tsx');
  assert.match(src, /typeof MediaRecorder === 'undefined'/);
  assert.match(src, /reducedMotion/);
  assert.match(src, /cancelAnimationFrame/);
  assert.match(src, /parseScene\(/);
});
