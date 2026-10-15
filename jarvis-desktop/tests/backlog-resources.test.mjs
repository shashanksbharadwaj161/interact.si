// Resource policy tests: bounded refresh and idle backoff, sustained low-memory, battery and motion-quality suggestions,
// and the battery reader on System.resources(). Bundles the real TypeScript in memory with fake injected telemetry.
// No real sensors, no real power state, no settings are changed, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backlog-resources-entry.ts',
    loader: 'ts',
    contents: `
      export * as policy from './src/ui/resource-policy.ts';
      export { System } from './electron/services/system.ts';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const code = out.outputFiles[0].text;
const { policy: p, System } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const sampleOf = (over = {}) => ({
  memory: { usedPercent: 40 },
  cpuBusyPercent: 10,
  battery: { charging: true, level: 0.9 },
  ...over,
});

test('policy module is pure: no DOM, React, Electron or storage references', () => {
  assert.ok(!/\bdocument\b|\bwindow\b|\bnavigator\b|localStorage|from ['"]react['"]|from ['"]electron['"]/.test(code));
});

test('refresh delay is the active interval with no state and bounded by the minimum and maximum', () => {
  assert.equal(p.refreshDelayMs(), p.REFRESH_MS.active);
  assert.equal(p.refreshDelayMs({ idleSeconds: 0, failures: 0 }), 5000);
  for (const s of [{ idleSeconds: -5, failures: -1 }, { idleSeconds: NaN, failures: Infinity }, { idleSeconds: 1e12, failures: 1e12 }]) {
    const d = p.refreshDelayMs(s);
    assert.ok(d >= p.REFRESH_MS.min && d <= p.REFRESH_MS.max, JSON.stringify(s));
  }
});

test('idle backoff doubles once per full idle minute and stops at the cap', () => {
  assert.equal(p.refreshDelayMs({ idleSeconds: 59 }), 5000);
  assert.equal(p.refreshDelayMs({ idleSeconds: 60 }), 10000);
  assert.equal(p.refreshDelayMs({ idleSeconds: 120 }), 20000);
  assert.equal(p.refreshDelayMs({ idleSeconds: 60 * 6 }), 300000);
  assert.equal(p.refreshDelayMs({ idleSeconds: 60 * 60 * 24 }), 300000);
});

test('failures add backoff the same way and never reduce the delay', () => {
  assert.equal(p.refreshDelayMs({ failures: 1 }), 10000);
  assert.equal(p.refreshDelayMs({ failures: 2 }), 20000);
  let prev = 0;
  for (let i = 0; i <= 20; i++) {
    const d = p.refreshDelayMs({ idleSeconds: i * 30, failures: i });
    assert.ok(d >= prev, `delay shrank at step ${i}`);
    prev = d;
  }
});

test('unknown telemetry never produces a suggestion, however long it lasts', () => {
  const pol = p.createResourcePolicy();
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(pol.observe({ memory: null, cpuBusyPercent: null, battery: null }), []);
    assert.deepEqual(pol.observe({}), []);
  }
});

test('a single spike does not change advice; the condition must hold for consecutive samples', () => {
  const pol = p.createResourcePolicy();
  assert.deepEqual(pol.observe({ cpuBusyPercent: 95 }), []);
  assert.deepEqual(pol.observe({ cpuBusyPercent: 95 }), []);
  assert.deepEqual(pol.observe({ cpuBusyPercent: 20 }), []);
  assert.deepEqual(pol.observe({ cpuBusyPercent: 95 }), []);
  assert.deepEqual(pol.observe({ cpuBusyPercent: 95 }), []);
});

test('an unknown sample resets the streak instead of counting as a high reading', () => {
  const pol = p.createResourcePolicy();
  pol.observe({ cpuBusyPercent: 95 });
  pol.observe({ cpuBusyPercent: 95 });
  assert.deepEqual(pol.observe({ cpuBusyPercent: null }), []);
  assert.deepEqual(pol.observe({ cpuBusyPercent: 95 }), []);
});

test('sustained high memory suggests the Low memory model profile as a proposal, not a change', () => {
  const pol = p.createResourcePolicy();
  const input = { memory: { usedPercent: 92 } };
  const frozen = JSON.stringify(input);
  assert.deepEqual(pol.observe(input), []);
  assert.deepEqual(pol.observe(input), []);
  const [s] = pol.observe(input);
  assert.equal(s.id, 'low-memory');
  assert.deepEqual(s.proposal, { kind: 'model-profile', value: 'low-memory' });
  assert.equal(s.requiresConfirmation, true);
  assert.match(s.message, /92%/);
  assert.equal(JSON.stringify(input), frozen, 'telemetry input is not mutated');
});

test('memory below the threshold, or already on the Low memory profile, gives no suggestion', () => {
  const pol = p.createResourcePolicy();
  for (let i = 0; i < 5; i++) assert.deepEqual(pol.observe({ memory: { usedPercent: 89.9 } }), []);
  const pol2 = p.createResourcePolicy();
  for (let i = 0; i < 5; i++) assert.deepEqual(pol2.observe({ memory: { usedPercent: 99 } }, { modelProfile: 'low-memory' }), []);
});

test('unplugged and low battery suggests battery-aware motion, and only when it is off', () => {
  const low = { charging: false, level: 0.15 };
  const pol = p.createResourcePolicy();
  for (let i = 0; i < 2; i++) pol.observe({ battery: low });
  const [s] = pol.observe({ battery: low });
  assert.equal(s.id, 'battery-motion');
  assert.deepEqual(s.proposal, { kind: 'shell-pref', key: 'motion.onBattery', value: true });
  assert.match(s.message, /15%/);

  const already = p.createResourcePolicy();
  for (let i = 0; i < 5; i++) assert.deepEqual(already.observe({ battery: low }, { batteryMotionOn: true }), []);
});

test('charging, or a level above the threshold, gives no battery suggestion', () => {
  const pol = p.createResourcePolicy();
  for (let i = 0; i < 4; i++) assert.deepEqual(pol.observe({ battery: { charging: true, level: 0.05 } }), []);
  const pol2 = p.createResourcePolicy();
  for (let i = 0; i < 4; i++) assert.deepEqual(pol2.observe({ battery: { charging: false, level: 0.21 } }), []);
});

test('sustained busy CPU suggests Battery avatar quality, and not when it is already set', () => {
  const pol = p.createResourcePolicy();
  for (let i = 0; i < 2; i++) pol.observe({ cpuBusyPercent: 88 });
  const [s] = pol.observe({ cpuBusyPercent: 88 });
  assert.equal(s.id, 'motion-quality');
  assert.deepEqual(s.proposal, { kind: 'avatar-quality', key: 'avatar.quality', value: 'battery' });

  const already = p.createResourcePolicy();
  for (let i = 0; i < 5; i++) assert.deepEqual(already.observe({ cpuBusyPercent: 99 }, { avatarQuality: 'battery' }), []);
});

test('several conditions at once produce one suggestion each, in a fixed order, and reset clears streaks', () => {
  const pol = p.createResourcePolicy();
  const busy = { memory: { usedPercent: 95 }, cpuBusyPercent: 95, battery: { charging: false, level: 0.1 } };
  pol.observe(busy);
  pol.observe(busy);
  const ids = pol.observe(busy).map((s) => s.id);
  assert.deepEqual(ids, ['low-memory', 'battery-motion', 'motion-quality']);
  pol.reset();
  assert.deepEqual(pol.observe(busy), []);
});

test('suggestion objects are fresh copies, so callers cannot change the shared proposal table', () => {
  const pol = p.createResourcePolicy();
  for (let i = 0; i < 2; i++) pol.observe({ cpuBusyPercent: 90 });
  const [a] = pol.observe({ cpuBusyPercent: 90 });
  a.proposal.value = 'high';
  const [b] = pol.observe({ cpuBusyPercent: 90 });
  assert.equal(b.proposal.value, 'battery');
});

test('System.resources reports a battery reading only from an injected valid reader', () => {
  const osStub = {
    platform: () => 'win32', arch: () => 'x64', totalmem: () => 8e9, freemem: () => 4e9, uptime: () => 100,
    cpus: () => [{ model: 'Test CPU', speed: 1, times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }],
  };
  const procStub = { memoryUsage: () => ({ rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }), cpuUsage: () => ({ user: 0, system: 0 }), uptime: () => 5 };
  const make = (battery) => new System({
    settings: () => ({}), fetch: async () => ({}), speech: { capabilities: async () => [] },
    secrets: { available: async () => ({ available: true }), configured: async () => false },
    native: { listWindows: async () => [] }, safeLaunch: () => false, os: osStub, proc: procStub, now: () => 1000,
    ...(battery ? { battery } : {}),
  });
  const ids = (r) => r.unavailable.map((u) => u.id);
  const reason = (r, id) => r.unavailable.find((u) => u.id === id)?.reason;

  const none = make(null).resources();
  assert.equal(none.battery, null);
  assert.ok(ids(none).includes('battery'));
  assert.equal(reason(none, 'battery'), 'Battery state is not read by this app');

  const good = make(() => ({ charging: false, level: 0.5 })).resources();
  assert.deepEqual(good.battery, { charging: false, level: 0.5 });
  assert.ok(!ids(good).includes('battery'));

  const bad = [
    () => ({ charging: false, level: NaN }),
    () => ({ charging: false, level: 1.5 }),
    () => ({ charging: 'yes', level: 0.5 }),
    () => null,
    () => { throw new Error('sensor offline'); },
  ];
  for (const reader of bad) {
    const r = make(reader).resources();
    assert.equal(r.battery, null);
    assert.equal(reason(r, 'battery'), 'Battery reader returned no valid reading');
  }
});

test('System.resources cpu and memory figures are unchanged by the battery reader', () => {
  const osStub = {
    platform: () => 'win32', arch: () => 'x64', totalmem: () => 8e9, freemem: () => 2e9, uptime: () => 100,
    cpus: () => [{ model: 'Test CPU', speed: 1, times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } }],
  };
  const sys = new System({
    settings: () => ({}), fetch: async () => ({}), speech: { capabilities: async () => [] },
    secrets: { available: async () => ({ available: true }), configured: async () => false },
    native: { listWindows: async () => [] }, safeLaunch: () => false, os: osStub,
    proc: { memoryUsage: () => ({ rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 }), cpuUsage: () => ({ user: 0, system: 0 }), uptime: () => 5 },
    now: () => 1000, battery: () => ({ charging: true, level: 1 }),
  });
  const r = sys.resources();
  assert.equal(r.memory.usedPercent, 75);
  assert.equal(r.cpuBusyPercent, null);
  assert.deepEqual(r.battery, { charging: true, level: 1 });
});
