import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled = await build({entryPoints: ['electron/services/reminders.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent'});
const {Reminders, MAX_BURST, MAX_TIMER_MS} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const BASE = Date.parse('2026-10-16T10:00:00Z');
const task = (id, minutes) => ({id, title: id, due: new Date(BASE + minutes * 60_000).toISOString(), done: false});
function harness(tasks, extra = {}) {
  const state = {now: BASE, tasks, timers: new Set(), sent: []};
  const scheduler = new Reminders({tasks: () => state.tasks, now: () => state.now,
    notify: (title) => state.sent.push(title),
    setTimer: (fn, ms) => {const handle = {fn, ms, unref() {}}; state.timers.add(handle); return handle;},
    clearTimer: (handle) => state.timers.delete(handle), ...extra});
  return {...state, state, scheduler};
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('resume cancels the stalled OS timer and announces overdue reminders once', async () => {
  const {state: s, scheduler: r} = harness([task('missed', 5), task('future', 120)]);
  r.start();
  const stale = [...s.timers][0];
  s.now += 30 * 60_000;
  r.resync(); await settle();
  assert.deepEqual(s.sent, ['missed']);
  assert.equal(s.timers.size, 1);
  assert.equal([...s.timers][0].ms, 90 * 60_000);
  const fresh = [...s.timers][0];
  stale.fn(); await settle();
  assert.equal([...s.timers][0], fresh, 'already queued canceled callback must do nothing');
  r.resync(); await settle();
  assert.deepEqual(s.sent, ['missed']);
  assert.equal(s.timers.size, 1);
  r.dispose(); assert.equal(s.timers.size, 0);
});

test('resume backlog stays burst-limited, excludes done tasks, and honors disabled notifications', async () => {
  let enabled = false;
  const tasks = Array.from({length: 12}, (_, i) => task(`due${i}`, i + 1));
  tasks.push({...task('done', 2), done: true});
  const {state: s, scheduler: r} = harness(tasks, {enabled: () => enabled});
  r.start(); s.now += 60 * 60_000;
  r.resync(); await settle(); assert.equal(s.sent.length, 0);
  enabled = true; r.resync(); await settle(); assert.equal(s.sent.length, 0);
  s.tasks.push(task('new', 65)); r.rearm();
  s.now += 10 * 60_000; r.resync(); await settle();
  assert.deepEqual(s.sent, ['new']); r.dispose();
  const h = harness(tasks); h.state.now += 60 * 60_000;
  await h.scheduler.fire();
  assert.equal(h.state.sent.length, MAX_BURST);
  assert.equal(h.state.sent.at(-1), '9 more tasks are due');
  h.scheduler.dispose();
});

test('slow audit, overlapping resume, and disposal never duplicate or leave timers', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const {state: s, scheduler: r} = harness([task('first', 1), task('second', 2), task('future', 60)], {record: () => gate});
  r.start(); s.now += 10 * 60_000;
  const first = r.fire();
  assert.deepEqual(s.sent, ['first']);
  r.resync(); await settle();
  assert.equal(s.timers.size, 1);
  r.dispose(); release(); await first;
  assert.deepEqual(s.sent, ['first'], 'disposal cancels remaining delivery');
  assert.equal(s.timers.size, 0);
});

test('clock rollback and long sleeps preserve deduplication and capped timeout delays', async () => {
  const {state: s, scheduler: r} = harness([task('one', 5), task('later', 60 * 24 * 60)]);
  r.start(); s.now += 10 * 60_000; await r.fire();
  assert.deepEqual(s.sent, ['one']);
  assert.equal([...s.timers][0].ms, MAX_TIMER_MS);
  s.now = BASE; r.resync(); await settle();
  s.now = BASE + 10 * 60_000; r.resync(); await settle();
  assert.deepEqual(s.sent, ['one']);
  s.now = BASE + 61 * 24 * 60 * 60_000; r.resync(); await settle();
  assert.deepEqual(s.sent, ['one', 'later']);
  assert.equal(s.timers.size, 0); r.dispose();
});
