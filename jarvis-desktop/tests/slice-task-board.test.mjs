import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/task-board.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const tb = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {createTask, transitionTask, deriveWorkerStatus, summarizeBoard, parseBoard, TRANSITIONS, TASK_BOARD_PREF_KEY, TASK_STATUSES} = tb;

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const mk = (over = {}, i = 0) => createTask({title:'Write tests', role:'worker', model:'claude-sonnet-5-5', ...over}, T0 + i, {next:i});
const reasonFor = (s) => s === 'done' ? 'completed' : s === 'cancelled' ? 'user-cancelled' : s === 'failed' ? 'error' : s === 'stopped' ? 'timeout' : undefined;
function inStatus(status) {
  let t = mk();
  if (status === 'queued') return t;
  t = transitionTask(t, 'running', {now:T0 + 1000});
  if (status === 'running') return t;
  if (status === 'paused') return transitionTask(t, 'paused', {now:T0 + 2000});
  return transitionTask(t, status, {now:T0 + 3000, stopReason:reasonFor(status)});
}
function assertNoProgress(value) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /progress|percent|%|eta|estimate/i);
}

test('task board: createTask validates input and builds deterministic ids', () => {
  const counter = {next:0};
  const a = createTask({title:'  First  ', role:'planner'}, T0, counter);
  const b = createTask({title:'Second', role:'worker', model:'claude-opus-5-5', files:['a.ts', 'a.ts', '']}, T0, counter);
  assert.equal(a.id, `t-${T0.toString(36)}-0`);
  assert.equal(b.id, `t-${T0.toString(36)}-1`);
  assert.equal(counter.next, 2);
  assert.equal(a.title, 'First');
  assert.equal(a.status, 'queued');
  assert.equal(a.createdAt, new Date(T0).toISOString());
  assert.equal(a.model, undefined);
  assert.equal(b.model, 'claude-opus-5-5');
  assert.deepEqual(b.files, ['a.ts']);
  assert.equal(createTask({title:'x', role:'r'}, T0, () => 7).id, `t-${T0.toString(36)}-7`);
  assert.throws(() => createTask({title:'  ', role:'worker'}, T0), /title is required/);
  assert.throws(() => createTask({title:'ok', role:''}, T0), /role is required/);
  assert.throws(() => createTask({title:'x'.repeat(121), role:'worker'}, T0), /at most 120/);
  assert.equal(createTask({title:'x'.repeat(120), role:'worker'}, T0).title.length, 120);
  assert.throws(() => createTask({title:'ok', role:'w'}, Number.NaN), /Invalid timestamp/);
  assert.equal(TASK_BOARD_PREF_KEY, 'developer.taskBoard');
});

test('task board: every legal transition succeeds and sets timestamps', () => {
  const legal = [];
  for (const [from, tos] of Object.entries(TRANSITIONS)) for (const to of tos) legal.push([from, to]);
  assert.deepEqual(legal.sort(), [
    ['paused','cancelled'], ['paused','running'],
    ['queued','cancelled'], ['queued','running'],
    ['running','cancelled'], ['running','done'], ['running','failed'], ['running','paused'], ['running','stopped'],
  ]);
  for (const [from, to] of legal) {
    const t = inStatus(from);
    const r = reasonFor(to);
    const next = transitionTask(t, to, {now:T0 + 5000, stopReason:r, note:'ok'});
    assert.equal(next.status, to);
    assert.notEqual(next, t);
    assert.equal(t.status, from, 'input not mutated');
    if (['done','failed','cancelled','stopped'].includes(to)) {
      assert.equal(next.endedAt, new Date(T0 + 5000).toISOString());
      assert.equal(next.stopReason, r);
    } else {
      assert.equal(next.endedAt, undefined);
    }
    if (to === 'running') assert.ok(next.startedAt);
    assertNoProgress(next);
  }
  const resumed = transitionTask(inStatus('paused'), 'running', {now:T0 + 9000});
  assert.equal(resumed.startedAt, new Date(T0 + 1000).toISOString(), 'resume keeps the original start time');
});

test('task board: illegal transitions and missing/invalid stop reasons throw descriptive errors', () => {
  assert.throws(() => transitionTask(inStatus('queued'), 'done', {now:T0, stopReason:'completed'}), /Illegal transition.*queued -> done/);
  assert.throws(() => transitionTask(inStatus('queued'), 'paused', {now:T0}), /Illegal transition.*queued -> paused/);
  assert.throws(() => transitionTask(inStatus('paused'), 'done', {now:T0, stopReason:'completed'}), /Illegal transition.*paused -> done/);
  assert.throws(() => transitionTask(inStatus('paused'), 'failed', {now:T0, stopReason:'error'}), /Illegal transition/);
  assert.throws(() => transitionTask(inStatus('queued'), 'stopped', {now:T0, stopReason:'timeout'}), /Illegal transition/);
  assert.throws(() => transitionTask(inStatus('running'), 'queued', {now:T0}), /Illegal transition/);
  assert.throws(() => transitionTask(inStatus('running'), 'bogus', {now:T0}), /Unknown task status/);
  for (const s of ['failed','stopped','cancelled','done']) {
    assert.throws(() => transitionTask(inStatus('running'), s, {now:T0}), /stop reason is required/);
  }
  assert.throws(() => transitionTask(inStatus('running'), 'done', {now:T0, stopReason:'error'}), /only be marked done with stop reason "completed"/);
  assert.throws(() => transitionTask(inStatus('running'), 'failed', {now:T0, stopReason:'completed'}), /only allowed for done/);
  assert.throws(() => transitionTask(inStatus('running'), 'cancelled', {now:T0, stopReason:'nope'}), /Unknown stop reason/);
  assert.throws(() => transitionTask(inStatus('running'), 'paused', {now:T0, stopReason:'error'}), /not accepted/);
});

test('task board: terminal states are immutable', () => {
  for (const s of ['done','failed','cancelled','stopped']) {
    const t = inStatus(s);
    assert.deepEqual(TRANSITIONS[s], []);
    for (const to of TASK_STATUSES) {
      assert.throws(() => transitionTask(t, to, {now:T0 + 9999, stopReason:reasonFor(to)}), /terminal tasks cannot change/);
    }
  }
});

test('task board: deriveWorkerStatus reports idle/busy/paused and counts from tasks only', () => {
  const now = {now:T0 + 100};
  const a1 = transitionTask(mk({role:'worker', model:'m1'}, 1), 'running', now);
  const a2 = transitionTask(transitionTask(mk({role:'worker', model:'m1'}, 2), 'running', now), 'done', {...now, stopReason:'completed'});
  const b1 = transitionTask(transitionTask(mk({role:'reviewer', model:'m2'}, 3), 'running', now), 'paused', now);
  const b2 = transitionTask(transitionTask(mk({role:'reviewer', model:'m2'}, 4), 'running', now), 'failed', {...now, stopReason:'checks-failed'});
  const c1 = mk({role:'planner', model:'m3'}, 5);
  const c2 = transitionTask(transitionTask(mk({role:'planner', model:'m3'}, 6), 'running', now), 'done', {...now, stopReason:'completed'});
  const d1 = transitionTask(mk({role:'worker', model:'m2'}, 7), 'cancelled', {...now, stopReason:'user-cancelled'});
  const ws = deriveWorkerStatus([a1, a2, b1, b2, c1, c2, d1]);
  const by = Object.fromEntries(ws.map((w) => [w.id, w]));
  assert.deepEqual(Object.keys(by).sort(), ['planner+m3', 'reviewer+m2', 'worker+m1', 'worker+m2']);
  assert.deepEqual(by['worker+m1'], {id:'worker+m1', role:'worker', model:'m1', state:'busy', currentTaskId:a1.id, completed:1, failed:0});
  assert.deepEqual(by['reviewer+m2'], {id:'reviewer+m2', role:'reviewer', model:'m2', state:'paused', currentTaskId:b1.id, completed:0, failed:1});
  assert.deepEqual(by['planner+m3'], {id:'planner+m3', role:'planner', model:'m3', state:'idle', completed:1, failed:0});
  assert.deepEqual(by['worker+m2'], {id:'worker+m2', role:'worker', model:'m2', state:'idle', completed:0, failed:0});
  // running beats paused for the same worker regardless of order
  const p = transitionTask(transitionTask(mk({role:'x', model:'y'}, 8), 'running', now), 'paused', now);
  const r = transitionTask(mk({role:'x', model:'y'}, 9), 'running', now);
  assert.equal(deriveWorkerStatus([p, r])[0].state, 'busy');
  assert.equal(deriveWorkerStatus([p, r])[0].currentTaskId, r.id);
  assert.deepEqual(deriveWorkerStatus([]), []);
  assertNoProgress(ws);
});

test('task board: summarizeBoard counts statuses and stop reasons', () => {
  const tasks = ['queued','running','paused','done','failed','cancelled','stopped','done'].map((s) => inStatus(s));
  const sum = summarizeBoard(tasks);
  assert.equal(sum.total, 8);
  assert.deepEqual(sum.byStatus, {queued:1, running:1, paused:1, done:2, failed:1, cancelled:1, stopped:1});
  assert.deepEqual(sum.byStopReason, {'completed':2, 'user-cancelled':1, 'error':1, 'timeout':1, 'budget-exhausted':0, 'checks-failed':0, 'blocked':0});
  assert.equal(summarizeBoard([]).total, 0);
  assertNoProgress(sum);
});

test('task board: parseBoard drops malformed and duplicate entries and caps at 200', () => {
  const good = inStatus('done');
  const queued = mk({}, 3);
  const raw = [
    good,
    {...good, title:'duplicate id'},
    null, 42, 'x', [],
    {...queued, id:''},
    {...queued, id:'t-a', title:''},
    {...queued, id:'t-b', role:''},
    {...queued, id:'t-c', status:'exploded'},
    {...queued, id:'t-d', createdAt:'not a date'},
    {...queued, id:'t-e', title:'x'.repeat(121)},
    {...queued, id:'t-f', status:'failed'},
    {...queued, id:'t-g', status:'done', stopReason:'error', endedAt:good.endedAt},
    {...queued, id:'t-h', stopReason:'mystery'},
    {...queued, id:'t-i', progress:50, percent:'50%'},
    queued,
  ];
  const parsed = parseBoard(raw);
  assert.deepEqual(parsed.map((t) => t.id), [good.id, 't-i', queued.id]);
  assert.equal(parsed[0].title, good.title);
  assert.equal(parsed[0].stopReason, 'completed');
  assert.equal('progress' in parsed[1], false);
  assert.equal('percent' in parsed[1], false);
  assert.deepEqual(parseBoard(undefined), []);
  assert.deepEqual(parseBoard({}), []);
  const many = Array.from({length:250}, (_, i) => mk({title:`t${i}`}, i));
  const capped = parseBoard(many);
  assert.equal(capped.length, 200);
  assert.equal(capped[199].title, 't199');
  assertNoProgress(parsed);
});

test('task board: Developer page wires the board through prefs without progress UI', () => {
  const src = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) assert.ok(src.includes(`'${m}'`), m);
  for (const label of ['Start', 'Pause', 'Resume', 'Mark done', 'Mark failed', 'Cancel', 'Task board']) assert.ok(src.includes(label), label);
  assert.match(src, /usePref<unknown>\(TASK_BOARD_PREF_KEY/);
  assert.match(src, /'done', 'completed'/);
  const board = src.slice(src.indexOf('function TaskRow'), src.indexOf('export function Developer'));
  assert.doesNotMatch(board, /Spinner|progress|percent|%|estimate|busy=/i);
  const mod = readFileSync(path.join(root, 'src/ui/task-board.ts'), 'utf8');
  assert.doesNotMatch(mod, /fetch\(|XMLHttpRequest|WebSocket|document\.|window\./);
});
