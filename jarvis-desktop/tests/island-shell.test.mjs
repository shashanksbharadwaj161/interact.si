// Island production shell (src/companion/island): motion tokens, the easing solver, the interruptible rectangle animator
// (including the stalled-requestAnimationFrame watchdog seen in the transparent Windows companion window), content
// placement, and the island state model driven only by real events. Plus the agent's failure classification and the
// trusted confirmation closing on Stop. Fake clocks and fakes only; no DOM, no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'island-entry.ts',
    loader: 'ts',
    contents: `
      export * from './src/companion/island/motion.ts';
      export * from './src/companion/island/state.ts';
      export { contentRect } from './src/companion/island/IslandShell.tsx';
      export { islandPetSignals } from './src/companion/island/useIslandRun.ts';
      export { classifyFailure } from './electron/services/agent.ts';
      export { createTrustedConfirm } from './electron/ipcCore.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', jsx: 'automatic', external: ['electron'],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

/** A clock whose frames and timers run only when the test says so. `stall` drops frame requests (the Windows bug). */
function fakeClock() {
  let t = 0, id = 0;
  const frames = new Map(), timers = new Map();
  const c = {
    stall: false, isHidden: false,
    now: () => t,
    raf: (cb) => { const i = ++id; if (!c.stall) frames.set(i, cb); return i; },
    cancel: (i) => frames.delete(i),
    setTimer: (cb, ms) => { const i = ++id; timers.set(i, { cb, at: t + ms }); return i; },
    clearTimer: (i) => timers.delete(i),
    hidden: () => c.isHidden,
    /** Advances time by `ms` in 16 ms steps, delivering frames and due timers. */
    run(ms) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + 16);
        const fs = [...frames.entries()];
        frames.clear();
        for (const [, cb] of fs) cb(t);
        for (const [i, tm] of [...timers.entries()]) if (tm.at <= t) { timers.delete(i); tm.cb(); }
      }
    },
    pending: () => frames.size + timers.size,
  };
  return c;
}
const R = (x, y, width, height) => ({ x, y, width, height });

/* ---------------------------------------------------------------- tokens and easing */

test('motion tokens in TS and CSS are the same numbers', () => {
  const css = readFileSync(path.join(root, 'src/styles/companion-bubble.css'), 'utf8');
  const v = (name) => css.match(new RegExp(`--isl-${name}:\\s*([^;]+);`))[1].trim();
  for (const k of ['press', 'hover', 'fade', 'expand', 'collapse', 'morph']) assert.equal(v(k), `${m.MOTION[k]}ms`, k);
  assert.equal(v('ease-out'), m.easeCss(m.EASE.out));
  assert.equal(v('ease-in-out'), m.easeCss(m.EASE.inOut));
  assert.equal(v('ease-in'), m.easeCss(m.EASE.in));
  assert.ok(m.MOTION.expand >= 320 && m.MOTION.expand <= 420 && m.MOTION.collapse >= 220 && m.MOTION.collapse <= 280, 'within the assignment ranges');
  for (const [, , , y2] of Object.values(m.EASE).map((e) => e)) assert.ok(y2 <= 1, 'no curve overshoots (text must not wobble)');
});

test('cubic-bezier solver matches CSS endpoints and is monotonic for the island curves', () => {
  for (const e of Object.values(m.EASE)) {
    const f = m.cubicBezier(...e);
    assert.equal(f(0), 0);
    assert.equal(f(1), 1);
    let prev = 0;
    for (let i = 1; i <= 100; i++) { const y = f(i / 100); assert.ok(y >= prev - 1e-9 && y <= 1 + 1e-9); prev = y; }
  }
  const linear = m.cubicBezier(0, 0, 1, 1);
  assert.ok(Math.abs(linear(0.3) - 0.3) < 1e-4);
  assert.ok(m.cubicBezier(...m.EASE.out)(0.25) > 0.6, 'ease-out covers most of the way early');
});

/* ---------------------------------------------------------------- animator */

test('a move animates on frames, reports frames, and resolves exactly once at the target', async () => {
  const c = fakeClock();
  const applied = [], frames = [];
  const a = m.createRectAnimator({ initial: R(0, 0, 36, 36), clock: c, apply: (r) => applied.push(r), onFrame: (f) => frames.push(f) });
  let resolved = 0;
  const p = a.to(R(0, 0, 420, 300), 380, m.EASE.out).then(() => resolved++);
  assert.equal(a.moving, true);
  c.run(200);
  assert.ok(a.rect.width > 36 && a.rect.width < 420, 'mid-way');
  c.run(400);
  await p;
  assert.equal(resolved, 1);
  assert.deepEqual(a.rect, R(0, 0, 420, 300));
  assert.equal(a.moving, false);
  assert.equal(c.pending(), 0, 'no frame or timer left behind');
  assert.ok(frames.length >= 20 && frames.every((f) => f.via === 'raf' && f.dt > 0));
});

test('reversal mid-way continues from the shape as drawn, never from the old start', async () => {
  const c = fakeClock();
  const a = m.createRectAnimator({ initial: R(400, 300, 36, 36), clock: c, apply: () => {} });
  const opening = a.to(R(0, 0, 436, 336), 380, m.EASE.out);
  c.run(120);
  const mid = a.rect;
  assert.ok(mid.width > 100 && mid.width < 436);
  const closing = a.to(R(400, 300, 36, 36), 240, m.EASE.in);
  await opening; // the replaced move resolves at once
  const firstClose = [];
  const b = a.rect;
  assert.deepEqual(b, mid, 'the close starts exactly where the open was');
  c.run(16);
  firstClose.push(a.rect.width);
  assert.ok(firstClose[0] <= mid.width + 0.5 && firstClose[0] > 36, 'no jump to either end');
  c.run(300);
  await closing;
  assert.deepEqual(a.rect, R(400, 300, 36, 36));
});

test('stalled animation frames: the watchdog keeps drawing from timers and finishes exactly once', async () => {
  const c = fakeClock();
  const frames = [];
  const a = m.createRectAnimator({ initial: R(0, 0, 36, 36), clock: c, apply: () => {}, onFrame: (f) => frames.push(f) });
  let resolved = 0;
  c.run(16);
  c.stall = true; // requestAnimationFrame stops delivering after the first callback, timers keep running
  const p = a.to(R(0, 0, 420, 300), 380, m.EASE.out).then(() => resolved++);
  c.run(700);
  await p;
  assert.equal(resolved, 1);
  assert.deepEqual(a.rect, R(0, 0, 420, 300), 'still arrives');
  assert.ok(frames.some((f) => f.via === 'timer'), 'steps were drawn by the watchdog');
  assert.equal(a.moving, false);
  c.stall = false;
  c.run(200);
  assert.equal(resolved, 1, 'a late frame or timer cannot complete it twice');
  assert.equal(c.pending(), 0);
});

test('hidden document: a move finishes at once instead of waiting for frames nobody sees', async () => {
  const c = fakeClock();
  c.isHidden = true;
  const a = m.createRectAnimator({ initial: R(0, 0, 36, 36), clock: c, apply: () => {} });
  await a.to(R(0, 0, 400, 300), 380, m.EASE.out);
  assert.deepEqual(a.rect, R(0, 0, 400, 300));
  assert.equal(c.pending(), 0);
});

test('jump and zero duration apply at once and settle pending moves', async () => {
  const c = fakeClock();
  const a = m.createRectAnimator({ initial: R(0, 0, 10, 10), clock: c, apply: () => {} });
  const p = a.to(R(0, 0, 100, 100), 300, m.EASE.out);
  c.run(32);
  a.jump(R(5, 5, 50, 50));
  await p;
  assert.deepEqual(a.rect, R(5, 5, 50, 50));
  await a.to(R(1, 1, 2, 2), 0, m.EASE.out);
  assert.deepEqual(a.rect, R(1, 1, 2, 2));
  assert.equal(c.pending(), 0);
});

/* ---------------------------------------------------------------- geometry */

test('seed capsule and content stay inside the box, pinned to the side facing the character', () => {
  const box = R(18, 18, 440, 320);
  for (const side of ['left', 'right', 'above', 'below', 'none']) {
    const s = m.seedRect(box, side);
    assert.ok(s.x >= box.x && s.y >= box.y && s.x + s.width <= box.x + box.width && s.y + s.height <= box.y + box.height, `seed inside for ${side}`);
  }
  assert.ok(m.seedRect(box, 'left').x > m.seedRect(box, 'right').x, 'a bubble left of the pet grows from its right edge');
  const c = m.contentRect(box, { width: 400, height: 200 }, 'left');
  assert.deepEqual(c, R(58, 138, 400, 200), 'right-bottom aligned next to the pet');
  assert.deepEqual(m.contentRect(box, { width: 400, height: 200 }, 'right'), R(18, 138, 400, 200));
  assert.deepEqual(m.contentRect(box, { width: 600, height: 900 }, 'left'), box, 'never larger than the window gave');
  assert.equal(m.insetClip({ width: 100, height: 100 }, R(10, 10, 50, 20), 22), 'inset(10.00px 40.00px 70.00px 10.00px round 10.00px)', 'radius never exceeds half the short side');
  assert.deepEqual(m.unionRect(R(0, 0, 10, 10), R(5, 5, 10, 10)), R(0, 0, 15, 15));
});

/* ---------------------------------------------------------------- state model */

const tool = (callId, phase, extra = {}) => ({ type: 'tool', callId, tool: 'x', label: 'Searching saved items', phase, summary: 's', ...extra });
const step = (s, runId, event) => m.islandReducer(s, { type: 'agent', runId, event });

test('the state follows the real run: sending, tool, confirmation, checking, answer', () => {
  let s = m.initialIsland();
  s = m.islandReducer(s, { type: 'invoke' });
  assert.equal(s.open, true);
  assert.equal(s.view, 'command');
  s = m.islandReducer(s, { type: 'ask', runId: 'r1', draft: { text: 'add milk', withRegion: false, withTarget: false } });
  assert.deepEqual([s.view, s.stage], ['working', 'sending']);
  assert.match(m.workLine(s).title, /Sending your request to Claude/);
  assert.equal(m.islandEdge(s).edge, 'working');
  s = step(s, 'r1', tool('t1', 'running', { label: 'Adding a task', summary: 'Adding a task' }));
  assert.deepEqual([s.view, s.stage], ['working', 'tool']);
  assert.equal(m.workLine(s).title, 'Adding a task');
  s = step(s, 'r1', tool('t1', 'awaiting-confirm', { label: 'Adding a task', summary: 'Waiting for your answer in the Windows confirmation' }));
  assert.deepEqual([s.view, s.stage], ['confirm', 'confirm']);
  assert.equal(m.islandEdge(s).edge, 'waiting');
  assert.deepEqual(m.islandPetSignals(s), { surface: 'working', requestInFlight: false, awaitingPerson: true, failure: null });
  s = step(s, 'r1', tool('t1', 'running', { label: 'Adding a task', summary: 'Checking the task is in your list', stage: 'verifying' }));
  assert.deepEqual([s.view, s.stage], ['working', 'verifying']);
  assert.equal(m.workLine(s).title, 'Checking the result');
  s = step(s, 'r1', tool('t1', 'done', { verified: true, undo: { kind: 'task', id: 'k1', label: 'Remove' } }));
  assert.equal(s.stage, 'model');
  assert.match(m.workLine(s).detail, /1 step finished/);
  s = step(s, 'r1', { type: 'answer', text: 'Added.', citations: [], steps: 2 });
  assert.deepEqual([s.view, s.stage, s.runId], ['answer', null, null]);
  assert.deepEqual(m.islandEdge(s), { edge: 'done', key: 't1' }, 'a verified change settles the light once');
});

test('no celebration without a verified change; Stop and errors end the light; late events are ignored', () => {
  let s = m.islandReducer(m.initialIsland(), { type: 'ask', runId: 'r1', draft: { text: 'type it', withRegion: false, withTarget: true } });
  s = step(s, 'r1', tool('t1', 'done', { verified: false, summary: 'Typed 12 characters into notepad. Not read back' }));
  s = step(s, 'r1', { type: 'answer', text: 'Typed.', citations: [], steps: 2 });
  assert.equal(m.islandEdge(s).edge, 'idle', 'typing is not verified, so no done trace');
  const before = s;
  assert.equal(step(s, 'r1', { type: 'error', reason: 'provider', message: 'late' }), before, 'a finished run cannot be overwritten');
  assert.equal(step(s, 'old', { type: 'answer', text: 'x', citations: [], steps: 1 }), before);
  let e = m.islandReducer(s, { type: 'ask', runId: 'r2', draft: { text: 'again', withRegion: false, withTarget: false } });
  e = step(e, 'r2', { type: 'error', reason: 'cancelled', message: 'Stopped.' });
  assert.equal(m.islandEdge(e).edge, 'idle', 'Stop is not an error');
  e = m.islandReducer(e, { type: 'ask', runId: 'r3', draft: { text: 'again', withRegion: false, withTarget: false } });
  e = step(e, 'r3', { type: 'error', reason: 'network', kind: 'offline', message: 'Offline mode: cloud requests are blocked' });
  assert.equal(e.view, 'error');
  assert.equal(m.islandEdge(e).edge, 'error');
  assert.equal(e.draft.text, 'again', 'the request is kept for Try again');
  assert.equal(m.islandPetSignals(e).failure, 'network');
});

test('tray opens over any view and returns to it; a run advancing meanwhile updates where it returns', () => {
  let s = m.islandReducer(m.initialIsland(), { type: 'ask', runId: 'r1', draft: { text: 'q', withRegion: false, withTarget: false } });
  s = m.islandReducer(s, { type: 'tray', open: true });
  assert.deepEqual([s.view, s.before], ['tray', 'working']);
  s = step(s, 'r1', { type: 'answer', text: 'A', citations: [], steps: 1 });
  assert.deepEqual([s.view, s.before], ['tray', 'answer'], 'the tray stays; the answer waits behind it');
  s = m.islandReducer(s, { type: 'tray', open: false });
  assert.equal(s.view, 'answer');
  s = m.islandReducer(s, { type: 'collapse' });
  assert.deepEqual([s.open, s.view], [false, 'answer'], 'the content stays as it was while the island closes');
  s = m.islandReducer(s, { type: 'invoke' });
  assert.deepEqual([s.view, s.answer], ['command', null], 'an answer already seen is not shown again on the next opening');
});

test('collapse during a run keeps the run (only Stop cancels it) and the pet keeps showing work', () => {
  let s = m.islandReducer(m.initialIsland(), { type: 'ask', runId: 'r1', draft: { text: 'q', withRegion: false, withTarget: false } });
  s = m.islandReducer(s, { type: 'collapse' });
  assert.equal(s.open, false);
  assert.equal(s.runId, 'r1');
  assert.deepEqual(m.islandPetSignals(s), { surface: 'rest', requestInFlight: true, awaitingPerson: false, failure: null });
  s = step(s, 'r1', { type: 'answer', text: 'A', citations: [], steps: 1 });
  assert.equal(s.open, false, 'an answer never pops the island open by itself');
  s = m.islandReducer(s, { type: 'invoke' });
  assert.equal(s.view, 'answer', 'reopening shows the result that arrived while it was closed');
});

/* ---------------------------------------------------------------- failures and confirmation */

test('failure classification: offline, limits, a rejected key and the network differ; reasons stay compatible', () => {
  assert.deepEqual(m.classifyFailure('Offline mode: cloud requests are blocked'), { reason: 'network', kind: 'offline' });
  assert.deepEqual(m.classifyFailure('Cloud request limit reached (20 per minute)'), { reason: 'network', kind: 'limit' });
  assert.deepEqual(m.classifyFailure('The cloud provider is rate limiting requests (HTTP 429). Try again later'), { reason: 'provider', kind: 'limit' });
  assert.deepEqual(m.classifyFailure('The cloud provider is overloaded right now (HTTP 529). Try again in a moment'), { reason: 'provider', kind: 'limit' });
  assert.deepEqual(m.classifyFailure('The cloud provider rejected the API key'), { reason: 'setup', kind: 'key' });
  assert.deepEqual(m.classifyFailure('Destination is not on the allow list'), { reason: 'network' });
  assert.deepEqual(m.classifyFailure('Cloud provider returned HTTP 500'), { reason: 'provider' });
});

test('Stop closes an open trusted confirmation as Cancel; an answer racing the stop does not count', async () => {
  const win = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true };
  let seen;
  const confirm = m.createTrustedConfirm({
    getWindow: () => win, isTrusted: () => true,
    showMessageBox: (_w, o) => { seen = o; return new Promise((resolve) => o.signal.addEventListener('abort', () => resolve({ response: 0 }))); },
  });
  const ctl = new AbortController();
  const pending = confirm('Type into notepad?', 'detail', ctl.signal);
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.signal, ctl.signal, 'the dialog is bound to the request');
  assert.equal(seen.defaultId, 0);
  ctl.abort();
  assert.equal(await pending, false);
  const late = createLate(m, win);
  assert.equal(await late, false, 'Continue that arrives after Stop is not approval');
  assert.equal(await confirm('again', 'd', AbortSignal.abort()), false, 'a stopped request never shows a dialog');
});

function createLate(mod, win) {
  const ctl = new AbortController();
  const confirm = mod.createTrustedConfirm({ getWindow: () => win, isTrusted: () => true, showMessageBox: async () => { ctl.abort(); return { response: 1 }; } });
  return confirm('x', 'y', ctl.signal);
}
