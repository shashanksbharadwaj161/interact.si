// Goals 64/60/67/44: App-level motion policy from host battery state, and one persistent SceneBackdrop whose scene
// (including an active capsule's project scene) changes through the interruptible anim-state machine. Fakes only:
// no real power state, no Electron, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'slice-app-battery-motion-entry.ts',
    loader: 'ts',
    contents: `
      export * as policy from './src/ui/resource-policy.ts';
      export { resolveActiveScene, DEFAULT_SCENE, SCENES } from './src/ui/scenes.ts';
      export { createAnimMachine, transition } from './src/ui/anim-state.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const code = out.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const {policy: p, resolveActiveScene, DEFAULT_SCENE, createAnimMachine, transition} = mod;
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const HOST_ON = {source: 'host', onBattery: true};
const HOST_AC = {source: 'host', onBattery: false};
const UNMEASURED = {source: 'unmeasured', onBattery: null};

test('motion policy: the user setting wins over everything', () => {
  const r = p.resolveMotionPolicy({reduceMotionPref: true, batteryPref: false, hostBattery: HOST_AC, navigatorBattery: {charging: true}});
  assert.deepEqual(r, {reducedMotion: true, reason: 'user', batterySource: 'host'});
  assert.equal(p.resolveMotionPolicy({reduceMotionPref: true, hostBattery: HOST_ON, fullscreenSuppressed: true}).reason, 'user');
});

test('motion policy: host on battery reduces motion when the battery preference is on', () => {
  assert.deepEqual(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: HOST_ON}), {reducedMotion: true, reason: 'host-battery', batterySource: 'host'});
  assert.deepEqual(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: false, hostBattery: HOST_ON}), {reducedMotion: false, reason: 'none', batterySource: 'host'});
  // Omitted preference uses the documented default (true).
  assert.equal(p.DEFAULT_BATTERY_MOTION_PREF, true);
  assert.equal(p.resolveMotionPolicy({reduceMotionPref: false, hostBattery: HOST_ON}).reason, 'host-battery');
});

test('motion policy: a measured host wins over the Battery Status API, even on AC', () => {
  const r = p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: HOST_AC, navigatorBattery: {charging: false}});
  assert.deepEqual(r, {reducedMotion: false, reason: 'none', batterySource: 'host'});
});

test('motion policy: host unmeasured falls through to the Battery Status API', () => {
  const r = p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: UNMEASURED, navigatorBattery: {charging: false}});
  assert.deepEqual(r, {reducedMotion: true, reason: 'navigator-battery', batterySource: 'navigator'});
  const charging = p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: UNMEASURED, navigatorBattery: {charging: true}});
  assert.deepEqual(charging, {reducedMotion: false, reason: 'none', batterySource: 'navigator'});
});

test('motion policy: unmeasured host and no browser reading never guesses a battery reduction', () => {
  for (const nav of [null, undefined, {}, {charging: 'maybe'}]) {
    assert.deepEqual(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: UNMEASURED, navigatorBattery: nav}), {reducedMotion: false, reason: 'none', batterySource: 'unmeasured'});
  }
  // Malformed host input is treated as unmeasured, never as on battery.
  assert.equal(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: {source: 'host', onBattery: 'yes'}}).reason, 'none');
  assert.equal(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: {source: 'unmeasured', onBattery: true}}).reason, 'none');
  assert.equal(p.resolveMotionPolicy(undefined).reason, 'none');
});

test('motion policy: fullscreen suppression reduces motion after battery reasons', () => {
  assert.deepEqual(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: HOST_AC, fullscreenSuppressed: true}), {reducedMotion: true, reason: 'fullscreen', batterySource: 'host'});
  assert.equal(p.resolveMotionPolicy({reduceMotionPref: false, batteryPref: true, hostBattery: HOST_ON, fullscreenSuppressed: true}).reason, 'host-battery');
});

test('hostMotionBattery: bridge statuses map to host/unmeasured, malformed input is unmeasured', () => {
  assert.deepEqual(p.hostMotionBattery({source: 'host', onBattery: true, measuredAt: '2025-01-02T03:04:05.000Z'}), HOST_ON);
  assert.deepEqual(p.hostMotionBattery({source: 'host', onBattery: false}), HOST_AC);
  for (const v of [null, undefined, 'x', {source: 'unmeasured', onBattery: null}, {source: 'navigator', onBattery: true}, {source: 'host', onBattery: 1}]) {
    assert.deepEqual(p.hostMotionBattery(v), UNMEASURED);
  }
});

test('resource-policy stays pure and keeps its existing exports', () => {
  assert.ok(!/\bdocument\b|\bwindow\b|\bnavigator\b|localStorage/.test(code));
  for (const name of ['refreshDelayMs', 'createResourcePolicy', 'resolveBatteryStatus', 'applyHostBatteryEvent', 'batteryTelemetry', 'batterySaverMotionActive', 'batteryLabel', 'normalizeHostBattery', 'unmeasuredBattery']) {
    assert.equal(typeof p[name], 'function', name);
  }
});

test('resolveActiveScene: capsule project scene wins, otherwise the app-wide pick, unknown ids never pass', () => {
  assert.equal(resolveActiveScene({scene: 'aurora'}, 'orbit'), 'aurora');
  assert.equal(resolveActiveScene(null, 'orbit'), 'orbit');
  assert.equal(resolveActiveScene(undefined, 'dusk'), 'dusk');
  assert.equal(resolveActiveScene({scene: ''}, 'orbit'), 'orbit');
  assert.equal(resolveActiveScene({scene: 'not-a-scene'}, 'horizon'), 'horizon');
  assert.equal(resolveActiveScene({}, 'unknown'), DEFAULT_SCENE);
  assert.equal(resolveActiveScene({scene: 42}, null), DEFAULT_SCENE);
});

test('App wiring: host bridge subscribed once with guarded calls, policy feeds reducedMotion, one stable backdrop', () => {
  const app = read('src/components/App.tsx');
  assert.match(app, /import \{[^}]*\bresolveMotionPolicy\b[^}]*\} from '\.\.\/ui\/resource-policy'/);
  assert.match(app, /import \{[^}]*\bhostBatteryBridge\b[^}]*\} from '\.\.\/ui\/bridges'/);
  assert.match(app, /import \{[^}]*\bresolveActiveScene\b[^}]*\} from '\.\.\/ui\/scenes'/);
  assert.match(app, /import '\.\.\/styles\/app-motion\.css'/);
  assert.match(app, /hostBatteryBridge\(typeof window !== 'undefined' \? window\.jarvisHost : null\)/);
  assert.match(app, /b\.read\(\)\.then\(apply, \(\) => apply\(null\)\)/);
  assert.match(app, /b\.subscribe\(apply\)/);
  assert.match(app, /window\.clearInterval\(timer\)/);
  assert.match(app, /Math\.max\(30_000, HOST_BATTERY_POLL_MS\)/);
  assert.match(app, /const policy = resolveMotionPolicy\(\{ reduceMotionPref: pref \|\| os, batteryPref: onBattery, hostBattery, navigatorBattery: battery \}\)/);
  assert.match(app, /if \(policy\.reducedMotion\) return \{ reduced: true, source: 'battery'/);
  const backdrops = app.match(/<SceneBackdrop\b[^>]*\/>/g) ?? [];
  assert.equal(backdrops.length, 1, 'SceneBackdrop is rendered exactly once in App');
  assert.match(backdrops[0], /key="app-scene-backdrop"/);
  assert.match(backdrops[0], /scene=\{backdropScene\}/);
  assert.match(backdrops[0], /reducedMotion=\{motion\.reduced\}/);
  assert.doesNotMatch(app, /key=\{scene\}/, 'no scene-keyed wrapper forces a remount');
  assert.match(app, /<div key="app-scene-layer" className="scene-layer"/);
  assert.match(app, /const backdropScene = resolveActiveScene\(activeCapsule, scene\)/);
});

test('SceneBackdrop: scene prop changes route through the anim-state transition, not a remount', () => {
  const s = read('src/components/SceneBackdrop.tsx');
  assert.match(s, /reducedMotion\?: boolean/);
  assert.match(s, /useAmbient\(reducedMotion\)/);
  assert.match(s, /useAnimMachine\(requested, \{ reducedMotion: ambient === 'off' \}\)/);
  assert.doesNotMatch(s, /key=\{[^}]*(scene|requested)[^}]*\}/);
  // The same machine path the hook drives: a second change mid-transition retargets the running leg.
  let m = createAnimMachine({reducedMotion: false, now: 0, initial: 'deep-space'});
  m = transition(m, {type: 'show', target: 'aurora'}, 0);
  assert.equal(m.phase, 'exiting');
  const m2 = transition(m, {type: 'show', target: 'dusk'}, 50);
  assert.equal(m2.startedAt, m.startedAt, 'same fade leg, not restarted');
  assert.equal(m2.target, 'dusk');
  assert.equal(m2.shown, 'deep-space');
  const settled = transition(m2, {type: 'tick'}, 10_000);
  assert.equal(settled.phase, 'active');
  assert.equal(settled.shown, 'dusk');
});

test('app-motion.css is a new small stylesheet keyed on the resolved reason', () => {
  const css = read('src/styles/app-motion.css');
  assert.match(css, /\.scene-layer:not\(\[data-motion-reason="none"\]\)/);
  assert.ok(css.length < 2000);
});
