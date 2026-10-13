import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the pure presets module in memory; it must not need the DOM or React.
const out = await build({
  entryPoints: [path.join(root, 'src/ui/motion-presets.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const code = out.outputFiles[0].text;
const m = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('module is pure: no DOM, React or storage references', () => {
  assert.ok(!/\bdocument\b|\bwindow\b|localStorage|from ['"]react['"]/.test(code));
});

test('built-in presets are valid, distinct, cover every kind and use the reserved id prefix', () => {
  const kinds = m.MOTION_KINDS.map((k) => k.id);
  assert.deepEqual(kinds, ['wave', 'particles', 'orbit']);
  assert.equal(new Set(m.BUILT_IN_PRESETS.map((p) => p.id)).size, m.BUILT_IN_PRESETS.length);
  assert.deepEqual(new Set(m.BUILT_IN_PRESETS.map((p) => p.kind)), new Set(kinds));
  for (const p of m.BUILT_IN_PRESETS) {
    assert.ok(m.isBuiltInId(p.id), p.id);
    assert.deepEqual(m.normalizeSettings(p), { kind: p.kind, intensity: p.intensity, speed: p.speed, hue: p.hue }, `${p.id} already normalized`);
    assert.ok(p.name.length > 0 && p.name.length <= m.MAX_PRESET_NAME);
  }
  assert.deepEqual(m.normalizeSettings(m.DEFAULT_SETTINGS), m.DEFAULT_SETTINGS);
});

test('normalizeSettings clamps, rounds, coerces numeric strings and falls back per field', () => {
  assert.deepEqual(m.normalizeSettings({ kind: 'orbit', intensity: 250, speed: -4, hue: '361' }), { kind: 'orbit', intensity: 100, speed: 0, hue: 360 });
  assert.deepEqual(m.normalizeSettings({ kind: 'nope', intensity: 'abc', speed: NaN, hue: Infinity }), m.DEFAULT_SETTINGS);
  assert.deepEqual(m.normalizeSettings(null), m.DEFAULT_SETTINGS);
  assert.deepEqual(m.normalizeSettings('wave'), m.DEFAULT_SETTINGS);
  assert.equal(m.normalizeSettings({ intensity: 12.6 }).intensity, 13);
  const fb = { kind: 'particles', intensity: 1, speed: 2, hue: 3 };
  assert.deepEqual(m.normalizeSettings({ hue: 9, extra: 'dropped' }, fb), { kind: 'particles', intensity: 1, speed: 2, hue: 9 });
});

test('preset names are trimmed, collapsed, stripped of control characters and bounded', () => {
  assert.equal(m.normalizePresetName('  Night\t\n  drift \u0007 '), 'Night drift');
  assert.equal(m.normalizePresetName('x'.repeat(100)).length, m.MAX_PRESET_NAME);
  assert.equal(m.normalizePresetName(42), '');
  assert.equal(m.normalizePresetName('   '), '');
});

test('parseSavedPresets drops malformed, built-in and duplicate entries and caps the count', () => {
  assert.deepEqual(m.parseSavedPresets(undefined), []);
  assert.deepEqual(m.parseSavedPresets('[]'), []);
  assert.deepEqual(m.parseSavedPresets({ length: 1 }), []);
  const good = { id: 'p-abc', name: 'Mine', kind: 'wave', intensity: 70, speed: 30, hue: 120 };
  const list = m.parseSavedPresets([
    good,
    null,
    'junk',
    { id: 'p-abc', name: 'Dup', kind: 'orbit' },
    { id: 'builtin:wave', name: 'Spoof', kind: 'wave' },
    { id: 'bad id!', name: 'x', kind: 'wave' },
    { id: 'p-noname', name: '   ', kind: 'wave' },
    { id: 'p-badkind', name: 'x', kind: 'cube' },
    { id: 'p-fix', name: 'Clamp me', kind: 'particles', intensity: 999, speed: 'fast', hue: -20, secret: 'nope' },
  ]);
  assert.deepEqual(list, [good, { id: 'p-fix', name: 'Clamp me', kind: 'particles', intensity: 100, speed: m.DEFAULT_SETTINGS.speed, hue: 0 }]);
  assert.ok(!('secret' in list[1]));

  const many = Array.from({ length: m.MAX_SAVED_PRESETS + 5 }, (_, i) => ({ id: `p-${i}`, name: `n${i}`, kind: 'wave' }));
  assert.equal(m.parseSavedPresets(many).length, m.MAX_SAVED_PRESETS);
});

test('upsert replaces by id, appends otherwise, refuses built-in ids, empty names and a full list', () => {
  const base = [{ id: 'p-1', name: 'One', kind: 'wave', intensity: 10, speed: 10, hue: 10 }];
  const added = m.upsertPreset(base, { id: 'p-2', name: ' Two ', kind: 'orbit', intensity: 500, speed: 5, hue: 5 });
  assert.equal(added.ok, true);
  assert.equal(added.list.length, 2);
  assert.deepEqual(added.list[1], { id: 'p-2', name: 'Two', kind: 'orbit', intensity: 100, speed: 5, hue: 5 });
  assert.equal(base.length, 1, 'input list is not mutated');

  const replaced = m.upsertPreset(added.list, { id: 'p-1', name: 'One again', kind: 'particles', intensity: 1, speed: 2, hue: 3 });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.list.length, 2);
  assert.equal(replaced.list[0].name, 'One again');

  assert.equal(m.upsertPreset(base, { id: 'builtin:wave', name: 'x', kind: 'wave', intensity: 1, speed: 1, hue: 1 }).ok, false);
  assert.equal(m.upsertPreset(base, { id: 'p-9', name: '  ', kind: 'wave', intensity: 1, speed: 1, hue: 1 }).ok, false);

  const full = Array.from({ length: m.MAX_SAVED_PRESETS }, (_, i) => ({ id: `p-${i}`, name: `n${i}`, kind: 'wave', intensity: 0, speed: 0, hue: 0 }));
  const over = m.upsertPreset(full, { id: 'p-new', name: 'new', kind: 'wave', intensity: 0, speed: 0, hue: 0 });
  assert.equal(over.ok, false);
  assert.equal(over.list, full);
  assert.equal(m.upsertPreset(full, { id: 'p-3', name: 'edit', kind: 'wave', intensity: 0, speed: 0, hue: 0 }).ok, true, 'editing an existing slot of a full list is allowed');

  assert.equal(m.removePreset(full, 'p-3').length, m.MAX_SAVED_PRESETS - 1);
  assert.ok(/^p-[0-9a-z]+$/.test(m.makePresetId(1760400000000)));
  assert.equal(m.makePresetId(-5), m.makePresetId(5));
});

test('round trip through JSON keeps only non-sensitive preset fields', () => {
  const stored = JSON.parse(JSON.stringify(m.upsertPreset([], { id: 'p-rt', name: 'Round', kind: 'orbit', intensity: 33, speed: 44, hue: 55, apiKey: 'should-not-survive' }).list));
  assert.deepEqual(Object.keys(stored[0]).sort(), ['hue', 'id', 'intensity', 'kind', 'name', 'speed']);
  assert.deepEqual(m.parseSavedPresets(stored), stored);
  assert.equal(m.PRESET_PREF_KEY, 'motion.presets');
});

test('colour and time helpers produce bounded, well-formed values', () => {
  assert.equal(m.hueColor(210, 80, 60, 0.5), 'hsla(210, 80%, 60%, 0.5)');
  assert.equal(m.hueColor(-30, 150, -5, 7), 'hsla(330, 100%, 0%, 1)');
  assert.equal(m.hueColor(725, 50, 50), 'hsla(5, 50%, 50%, 1)');
  assert.equal(m.timeScale(0), 0);
  assert.ok(Math.abs(m.timeScale(50) - 0.7375) < 1e-6);
  assert.equal(m.timeScale(100), 2.5);
  assert.equal(m.timeScale(-10), 0);
  assert.equal(m.timeScale(400), 2.5);
  assert.ok(m.timeScale(20) < m.timeScale(80), 'monotonic');
  assert.match(m.describeSettings(m.DEFAULT_SETTINGS), /^Wave, intensity 55%, speed 45%, hue 210°$/);
});

test('wave layers scale with intensity and stay inside the canvas', () => {
  assert.equal(m.waveLayerCount(0), 2);
  assert.equal(m.waveLayerCount(100), 5);
  assert.equal(m.wavePoint(1, 0.25, 3.5, 60), m.wavePoint(1, 0.25, 3.5, 60), 'deterministic');
  assert.notEqual(m.wavePoint(1, 0.25, 3.5, 60), m.wavePoint(1, 0.25, 3.6, 60), 'moves over time');
  for (let layer = 0; layer < 5; layer++) {
    for (let t = 0; t < 40; t += 0.37) {
      for (let x = 0; x <= 1; x += 0.05) {
        const y = m.wavePoint(layer, x, t, 100);
        assert.ok(y >= 0 && y <= 1, `layer ${layer} x ${x} t ${t} -> ${y}`);
      }
    }
  }
  const quiet = Math.abs(m.wavePoint(0, 0.3, 1, 0) - m.wavePoint(0, 0.3, 2.5, 0));
  const loud = Math.abs(m.wavePoint(0, 0.3, 1, 100) - m.wavePoint(0, 0.3, 2.5, 100));
  assert.ok(loud > quiet, 'higher intensity swings more');
});

test('particle fields are deterministic per seed, bounded, and step without leaving the unit square', () => {
  assert.equal(m.particleCount(0), 24);
  assert.equal(m.particleCount(100), 160);
  assert.ok(m.particleCount(50) > 24 && m.particleCount(50) < 160);
  const a = m.seedParticles(40, 7);
  const b = m.seedParticles(40, 7);
  const c = m.seedParticles(40, 8);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 40);
  for (const p of a) {
    assert.ok(p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1);
    assert.ok(p.r >= 1 && p.r <= 3.5);
    assert.ok(Number.isFinite(p.vx) && Number.isFinite(p.vy));
  }
  const before = JSON.stringify(a);
  const same = m.stepParticles(a, 0, 50, 0);
  assert.equal(same, a, 'returns the same array');
  assert.equal(JSON.stringify(a), before, 'zero dt is a no-op');
  m.stepParticles(a, -1, 50, 0);
  assert.equal(JSON.stringify(a), before, 'negative dt is ignored');

  let t = 0;
  for (let i = 0; i < 600; i++) {
    t += 0.05;
    m.stepParticles(a, 0.05, 100, t);
  }
  for (const p of a) assert.ok(p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1, 'wrapped');
  assert.notEqual(JSON.stringify(a), before, 'particles moved');

  const x = m.seedParticles(10, 3);
  const y = m.seedParticles(10, 3);
  for (let i = 0; i < 50; i++) {
    m.stepParticles(x, 0.02, 40, i * 0.02);
    m.stepParticles(y, 0.02, 40, i * 0.02);
  }
  assert.deepEqual(x, y, 'identical steps give identical fields');
});

test('orbit rings are deterministic, ordered outward and bodies stay on their rings', () => {
  assert.equal(m.orbitCount(0), 2);
  assert.equal(m.orbitCount(100), 8);
  const a = m.seedOrbits(6, 11);
  assert.deepEqual(a, m.seedOrbits(6, 11));
  assert.notDeepEqual(a, m.seedOrbits(6, 12));
  for (let i = 0; i < a.length; i++) {
    const b = a[i];
    assert.ok(b.radius > 0.1 && b.radius <= 0.95);
    assert.ok(b.tilt >= 0.3 && b.tilt <= 1);
    assert.ok(b.period > 0);
    assert.ok(b.direction === 1 || b.direction === -1);
    if (i > 0) assert.ok(b.radius > a[i - 1].radius - 0.05, 'roughly increasing radius');
    for (let t = 0; t < 30; t += 1.3) {
      const p = m.orbitPosition(b, t);
      assert.ok(Math.abs(p.x) <= b.radius + 1e-9 && Math.abs(p.y) <= b.radius * b.tilt + 1e-9);
      const ellipse = (p.x / b.radius) ** 2 + (p.y / (b.radius * b.tilt)) ** 2;
      assert.ok(Math.abs(ellipse - 1) < 1e-9, 'point lies on the ring');
    }
    const p0 = m.orbitPosition(b, 0);
    const p1 = m.orbitPosition(b, b.period);
    assert.ok(Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9, 'one period returns to start');
  }
});
