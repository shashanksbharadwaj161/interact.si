import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/anim-state.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {ANIM_LIMITS, ANIM_PHASES, createAnimMachine, transition, progressAt, cancel, isSettled, finish, setReducedMotion, viewAt} = mod;
const src = (p) => readFileSync(path.join(root, p), 'utf8');
const E = ANIM_LIMITS.enterMs;
const X = ANIM_LIMITS.exitMs;
const show = (target) => ({type:'show', target});
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('anim: limits and explicit phases', () => {
  assert.ok(Object.isFrozen(ANIM_LIMITS));
  assert.ok(E > 0 && X > 0 && ANIM_LIMITS.maxMs >= E);
  assert.deepEqual([...ANIM_PHASES], ['idle', 'entering', 'active', 'exiting', 'interrupted']);
  const m = createAnimMachine({reducedMotion:false, now:5});
  assert.equal(m.phase, 'idle');
  assert.equal(m.shown, null);
  assert.equal(progressAt(m, 1000), 0);
  assert.ok(isSettled(m));
  const pre = createAnimMachine({reducedMotion:false, now:0, initial:'aurora'});
  assert.equal(pre.phase, 'active');
  assert.equal(progressAt(pre, 0), 1);
});

test('anim: normal enter → active → exit → idle timing', () => {
  let m = createAnimMachine({reducedMotion:false, now:0});
  m = transition(m, show('listening'), 100);
  assert.equal(m.phase, 'entering');
  assert.equal(m.shown, 'listening');
  assert.equal(m.durationMs, E);
  close(progressAt(m, 100), 0);
  close(progressAt(m, 100 + E / 2), 0.5);
  close(progressAt(m, 100 + E), 1);
  const mid = transition(m, {type:'tick'}, 100 + E / 2);
  assert.equal(mid.phase, 'entering');
  m = transition(m, {type:'tick'}, 100 + E + 1);
  assert.equal(m.phase, 'active');
  assert.ok(isSettled(m));
  m = transition(m, {type:'hide'}, 1000);
  assert.equal(m.phase, 'exiting');
  assert.equal(m.durationMs, X);
  close(progressAt(m, 1000 + X / 2), 0.5);
  m = transition(m, {type:'tick'}, 1000 + X);
  assert.equal(m.phase, 'idle');
  assert.equal(m.shown, null);
});

test('anim: interruption mid-transition keeps progress continuity (no snap to 0, single leg)', () => {
  let m = transition(createAnimMachine({reducedMotion:false, now:0}), show('thinking'), 0);
  const t = E * 0.6;
  const before = progressAt(m, t);
  close(before, 0.6);
  // Hide mid-enter: reverses from 0.6, not from 1 and not from 0.
  const h = transition(m, {type:'hide'}, t);
  assert.equal(h.phase, 'interrupted');
  close(progressAt(h, t), before);
  assert.equal(h.durationMs, Math.round(X * 0.6));
  assert.ok(progressAt(h, t + 10) < before);
  // Re-show the same content mid-exit: reverses again from the current value.
  const t2 = t + h.durationMs / 2;
  const p2 = progressAt(h, t2);
  const r = transition(h, show('thinking'), t2);
  assert.equal(r.phase, 'interrupted');
  close(progressAt(r, t2), p2);
  assert.ok(progressAt(r, t2 + 10) > p2);
  // A different target mid-enter fades the current content out from where it is, then swaps.
  const d = transition(m, show('speaking'), t);
  assert.equal(d.phase, 'interrupted');
  assert.equal(d.shown, 'thinking');
  assert.equal(d.target, 'speaking');
  close(progressAt(d, t), before);
  const end = t + d.durationMs;
  const swapped = transition(d, {type:'tick'}, end);
  assert.equal(swapped.phase, 'entering');
  assert.equal(swapped.shown, 'speaking');
  close(progressAt(swapped, end), 0);
  assert.equal(swapped.startedAt, end);
  const done = transition(d, {type:'tick'}, end + E + 5);
  assert.equal(done.phase, 'active');
  assert.equal(done.shown, 'speaking');
  assert.equal(d.interruptions, 1);
});

test('anim: rapid double interruption (scene switched twice quickly) retargets without restarting', () => {
  let m = createAnimMachine({reducedMotion:false, now:0, initial:'deep-space'});
  m = transition(m, show('aurora'), 0);
  assert.equal(m.phase, 'exiting');
  assert.equal(m.shown, 'deep-space');
  const t = X / 3;
  const p = progressAt(m, t);
  const m2 = transition(m, show('dusk'), t);
  // Still the same single fade-out leg, only the destination changed.
  assert.equal(m2.startedAt, m.startedAt);
  assert.equal(m2.durationMs, m.durationMs);
  assert.equal(m2.target, 'dusk');
  close(progressAt(m2, t), p);
  // Third change after the swap, mid fade-in of dusk.
  const tIn = X + E / 2;
  const m3 = transition(m2, show('orbit'), tIn);
  assert.equal(m3.phase, 'interrupted');
  assert.equal(m3.shown, 'dusk');
  assert.equal(m3.target, 'orbit');
  close(progressAt(m3, tIn), 0.5);
  const fin = transition(m3, {type:'tick'}, tIn + 5000);
  assert.equal(fin.phase, 'active');
  assert.equal(fin.shown, 'orbit');
  // Sampled progress is continuous across every interruption.
  let prev = progressAt(m, 0);
  const steps = [[m, 0, t], [m2, t, X], [transition(m2, {type:'tick'}, X), X, tIn], [m3, tIn, tIn + m3.durationMs]];
  for (const [mm, a, b] of steps) {
    close(progressAt(mm, a), prev, 1e-6);
    prev = progressAt(mm, b);
  }
});

test('anim: cancel returns to idle immediately', () => {
  const m = transition(createAnimMachine({reducedMotion:false, now:0}), show('speaking'), 0);
  const c = cancel(m, 50);
  assert.equal(c.phase, 'idle');
  assert.equal(c.shown, null);
  assert.equal(progressAt(c, 50), 0);
  assert.ok(isSettled(c));
  const c2 = transition(m, {type:'cancel'}, 60);
  assert.equal(c2.phase, 'idle');
  assert.equal(m.phase, 'entering');
});

test('anim: reduced motion collapses every transition to one instantaneous step', () => {
  let m = createAnimMachine({reducedMotion:true, now:0});
  m = transition(m, show('listening'), 10);
  assert.equal(m.phase, 'active');
  assert.equal(m.durationMs, 0);
  assert.equal(progressAt(m, 10), 1);
  m = transition(m, show('alert'), 11);
  assert.equal(m.phase, 'active');
  assert.equal(m.shown, 'alert');
  m = transition(m, {type:'hide'}, 12);
  assert.equal(m.phase, 'idle');
  assert.equal(progressAt(m, 12), 0);
  // Turning reduced motion on mid-leg finishes it at once.
  const running = transition(createAnimMachine({reducedMotion:false, now:0}), show('thinking'), 0);
  const r = setReducedMotion(running, true, 20);
  assert.equal(r.phase, 'active');
  assert.equal(progressAt(r, 20), 1);
  assert.equal(finish(transition(running, {type:'hide'}, 30), 30).phase, 'idle');
});

test('anim: progress is clamped and deterministic, time never runs backwards', () => {
  const m = transition(createAnimMachine({reducedMotion:false, now:0}), show('x'), 100);
  assert.equal(progressAt(m, -1e9), 0);
  assert.equal(progressAt(m, 1e12), 1);
  assert.equal(progressAt(m, NaN), 0);
  assert.equal(progressAt(m, Infinity), 0);
  for (const t of [100, 150, 200, 320, 999]) {
    const a = progressAt(m, t);
    assert.ok(a >= 0 && a <= 1);
    assert.equal(progressAt(m, t), a);
  }
  const back = transition(m, {type:'hide'}, 50);
  assert.equal(back.startedAt, 100);
  close(progressAt(back, 100), 0);
  const custom = createAnimMachine({reducedMotion:false, now:0, enterMs:1e9, exitMs:-5});
  assert.equal(custom.enterMs, ANIM_LIMITS.maxMs);
  assert.equal(custom.exitMs, ANIM_LIMITS.minMs);
  const v = viewAt(m, 100 + E / 4);
  assert.ok(Object.isFrozen(v));
  assert.equal(v.progress, 0.25);
});

test('anim: machines are frozen and never mutated', () => {
  const m0 = createAnimMachine({reducedMotion:false, now:0});
  const snap = JSON.stringify(m0);
  const m1 = transition(m0, show('a'), 10);
  const m2 = transition(m1, show('b'), 50);
  const m3 = transition(m2, {type:'hide'}, 60);
  const m4 = cancel(m3, 70);
  for (const m of [m0, m1, m2, m3, m4]) assert.ok(Object.isFrozen(m));
  assert.equal(JSON.stringify(m0), snap);
  assert.notEqual(m1, m0);
  assert.equal(m1.shown, 'a');
  assert.equal(m1.phase, 'entering');
  assert.throws(() => { 'use strict'; m1.phase = 'idle'; });
});

test('anim wiring: companion hook, Companion status slot, SceneBackdrop crossfade and CSS', () => {
  const comp = src('src/ui/companion.tsx');
  assert.match(comp, /from '\.\/anim-state'/);
  assert.match(comp, /export function useAnimMachine/);
  assert.match(comp, /requestAnimationFrame\(step\)/);
  assert.match(comp, /cancelAnimationFrame\(raf\)/);
  assert.match(comp, /\[target, reduced\]/);
  assert.match(comp, /export function CompanionProvider/);
  assert.match(comp, /export function quantizeLevel/);
  assert.match(comp, /export function hostVoiceLevel/);
  const page = src('src/components/Companion.tsx');
  assert.match(page, /useAnimMachine\(shown === 'idle' \? null : shown/);
  assert.match(page, /data-anim-phase=\{status\.phase\}/);
  assert.match(page, /'--anim-progress'/);
  assert.match(page, /settings\.reduceMotion/);
  const scene = src('src/components/SceneBackdrop.tsx');
  assert.match(scene, /useAnimMachine\(requested, \{ reducedMotion: ambient === 'off' \}\)/);
  assert.match(scene, /data-anim-phase=\{fading \? fade\.phase : undefined\}/);
  assert.match(scene, /export function ambientMode/);
  const css = src('src/styles/views.css');
  assert.match(css, /--anim-progress/);
  assert.match(css, /\.scene\[data-anim-phase="interrupted"\]/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.anim-slot/);
  // Pure module: no DOM or timers.
  const pure = src('src/ui/anim-state.ts');
  assert.doesNotMatch(pure, /document\.|window\.|requestAnimationFrame|setTimeout/);
});
