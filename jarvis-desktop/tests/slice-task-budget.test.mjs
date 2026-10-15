import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(rel) {
  const bundle = await build({entryPoints:[path.join(root, rel)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const tb = await load('src/ui/task-board.ts');
const bg = await load('src/ui/task-budget.ts');
const {createTask, transitionTask} = tb;
const {DEFAULT_TASK_BUDGET, TASK_BUDGET_PREF_KEY, normalizeTaskBudget, evaluateStart, findOverdue, recordSpend, sumSpendForDay, parseSpendLedger, TASK_SPEND_LEDGER_CAP} = bg;

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const MIN = 60_000;
const mk = (i = 0) => createTask({title:`Task ${i}`, role:'worker', model:'claude-sonnet-5-5'}, T0 + i, {next:i});
const running = (i, startAt = T0) => transitionTask(mk(i), 'running', {now:startAt});
function assertNoProgress(value) {
  assert.doesNotMatch(JSON.stringify(value), /progress|percent|%|eta|estimate/i);
}
const evalValues = (r) => [r.allowed, r.reason, r.detail];

test('task budget: defaults are conservative and pref key is fixed', () => {
  assert.equal(TASK_BUDGET_PREF_KEY, 'developer.taskBudget');
  assert.deepEqual({...DEFAULT_TASK_BUDGET}, {maxConcurrentRunning:1, maxTasksPerDay:20, maxWallClockMinutesPerTask:60, maxEstimatedCostUsdPerDay:0});
  assert.deepEqual(normalizeTaskBudget(undefined), {...DEFAULT_TASK_BUDGET});
  assert.equal(TASK_SPEND_LEDGER_CAP, 500);
});

test('task budget: normalization coerces, clamps and rounds bad or legacy input', () => {
  for (const bad of [null, 42, 'x', [], {maxConcurrentRunning:'abc', maxTasksPerDay:NaN, maxWallClockMinutesPerTask:Infinity, maxEstimatedCostUsdPerDay:{}}]) {
    assert.deepEqual(normalizeTaskBudget(bad), {...DEFAULT_TASK_BUDGET});
  }
  assert.deepEqual(normalizeTaskBudget({maxConcurrentRunning:99, maxTasksPerDay:0, maxWallClockMinutesPerTask:99999, maxEstimatedCostUsdPerDay:-5}),
    {maxConcurrentRunning:10, maxTasksPerDay:1, maxWallClockMinutesPerTask:1440, maxEstimatedCostUsdPerDay:0});
  assert.deepEqual(normalizeTaskBudget({maxConcurrentRunning:2.6, maxTasksPerDay:'7.4', maxWallClockMinutesPerTask:' 30 ', maxEstimatedCostUsdPerDay:'2.345', legacyField:true}),
    {maxConcurrentRunning:3, maxTasksPerDay:7, maxWallClockMinutesPerTask:30, maxEstimatedCostUsdPerDay:2.35});
  assert.equal(normalizeTaskBudget({maxEstimatedCostUsdPerDay:5000}).maxEstimatedCostUsdPerDay, 1000);
  assert.equal(normalizeTaskBudget({maxConcurrentRunning:''}).maxConcurrentRunning, 1);
});

test('task budget: evaluateStart reasons in fixed order with exact detail strings', () => {
  const budget = {maxConcurrentRunning:2, maxTasksPerDay:3, maxWallClockMinutesPerTask:60, maxEstimatedCostUsdPerDay:5};
  const now = T0 + 10 * MIN;
  const ok = evaluateStart([mk(1)], budget, {now});
  assert.deepEqual(ok, {allowed:true, reason:'ok', detail:'Within budget: 0 of 2 running, 0 of 3 started today, 0.00 USD of 5.00 USD recorded today.'});

  const two = [running(1), running(2)];
  const conc = evaluateStart(two, budget, {now, ledger:[{taskId:'x', usd:9, at:new Date(T0).toISOString()}]});
  assert.deepEqual(conc, {allowed:false, reason:'concurrency-limit', detail:'Concurrency limit reached: 2 running, limit 2.'}, 'concurrency wins over spend');

  const done = (i) => transitionTask(running(i), 'done', {now:T0 + MIN, stopReason:'completed'});
  const three = [done(1), done(2), running(3)];
  const daily = evaluateStart(three, budget, {now, ledger:[{taskId:'x', usd:9, at:new Date(T0).toISOString()}]});
  assert.deepEqual(daily, {allowed:false, reason:'daily-task-limit', detail:'Daily task limit reached: 3 started today, limit 3.'}, 'daily wins over spend');
  // tasks started before the day window do not count
  const yesterday = [running(1, T0 - 24 * 60 * MIN)];
  assert.equal(evaluateStart([done(2), done(3), ...yesterday], {...budget, maxConcurrentRunning:5}, {now}).reason, 'ok');
  // custom day start
  assert.equal(evaluateStart(three, {...budget, maxConcurrentRunning:5}, {now, dayStartIso:new Date(T0 + 5 * MIN).toISOString()}).reason, 'ok');

  const ledger = recordSpend([], {taskId:'t1', usd:5, at:T0});
  const spend = evaluateStart([mk(1)], budget, {now, ledger});
  assert.deepEqual(spend, {allowed:false, reason:'spend-limit', detail:'Spend limit reached: 5.00 USD recorded today, limit 5.00 USD.'});
  const zero = evaluateStart([mk(1)], DEFAULT_TASK_BUDGET, {now, ledger:recordSpend([], {taskId:'t1', usd:0.01, at:T0})});
  assert.deepEqual(zero, {allowed:false, reason:'spend-limit', detail:'Spend limit reached: 0.01 USD recorded today, limit 0.00 USD.'});
  assert.equal(evaluateStart([mk(1)], DEFAULT_TASK_BUDGET, {now}).allowed, true, 'nothing recorded yet');

  assert.throws(() => evaluateStart([], budget, {now:'not a time'}), /Invalid now timestamp/);
  assert.throws(() => evaluateStart([], budget, {now:NaN}), /Invalid now timestamp/);
  assert.throws(() => evaluateStart([], budget, {now, dayStartIso:'nope'}), /Invalid dayStartIso timestamp/);
  for (const r of [ok, conc, daily, spend, zero]) assertNoProgress(evalValues(r));
});

test('task budget: findOverdue reports floor elapsed minutes for running tasks only', () => {
  const budget = {...DEFAULT_TASK_BUDGET, maxWallClockMinutesPerTask:30};
  const a = running(1, T0);
  const b = running(2, T0 + 10 * MIN);
  const paused = transitionTask(running(3, T0), 'paused', {now:T0 + MIN});
  const stopped = transitionTask(running(4, T0), 'stopped', {now:T0 + MIN, stopReason:'timeout'});
  const queued = mk(5);
  const now = T0 + 30 * MIN + 59_000;
  const out = findOverdue([a, b, paused, stopped, queued], budget, now);
  assert.deepEqual(out.map((o) => [o.task.id, o.elapsedMinutes, o.limitMinutes]), [[a.id, 30, 30]]);
  assert.deepEqual(findOverdue([a], budget, T0 + 30 * MIN), [], 'exactly at the limit is not overdue');
  const later = findOverdue([a, b], budget, T0 + 125 * MIN + 30_000);
  assert.deepEqual(later.map((o) => o.elapsedMinutes), [125, 115]);
  const stoppedNow = later.map((o) => transitionTask(o.task, 'stopped', {now:T0 + 126 * MIN, stopReason:'timeout'}));
  assert.ok(stoppedNow.every((t) => t.status === 'stopped' && t.stopReason === 'timeout'));
  assert.throws(() => findOverdue([a], budget, 'bad'), /Invalid now timestamp/);
  assertNoProgress(later);
});

test('task budget: spend ledger validation, cap and daily sum', () => {
  assert.throws(() => recordSpend([], {taskId:'', usd:1, at:T0}), /task id/);
  assert.throws(() => recordSpend([], {taskId:'t', usd:-1, at:T0}), /0 or more/);
  assert.throws(() => recordSpend([], {taskId:'t', usd:NaN, at:T0}), /finite/);
  assert.throws(() => recordSpend([], {taskId:'t', usd:Infinity, at:T0}), /finite/);
  assert.throws(() => recordSpend([], {taskId:'t', usd:'1', at:T0}), /finite/);
  assert.throws(() => recordSpend([], {taskId:'t', usd:1, at:'garbage'}), /Invalid spend timestamp/);
  const one = recordSpend([], {taskId:'t1', usd:0.1, at:T0});
  assert.deepEqual(one, [{taskId:'t1', usd:0.1, at:new Date(T0).toISOString()}]);
  const input = [...one];
  const two = recordSpend(input, {taskId:'t2', usd:0.2, at:T0 + MIN});
  assert.equal(input.length, 1, 'input not mutated');
  const three = recordSpend(two, {taskId:'t3', usd:4, at:T0 - 24 * 60 * MIN});
  assert.equal(sumSpendForDay(three, T0 + 5 * MIN), 0.3);
  assert.equal(sumSpendForDay(three, T0 - 23 * 60 * MIN), 4);
  assert.equal(sumSpendForDay(three, T0 + 5 * MIN, new Date(T0 - 24 * 60 * MIN).toISOString()), 4);
  assert.throws(() => sumSpendForDay(three, 'nope'), /Invalid now timestamp/);
  let big = [];
  for (let i = 0; i < 505; i++) big = recordSpend(big, {taskId:`t${i}`, usd:1, at:T0 + i});
  assert.equal(big.length, 500);
  assert.equal(big[0].taskId, 't5');
  assert.equal(big[499].taskId, 't504');
  assert.deepEqual(parseSpendLedger([null, {taskId:'a', usd:-1, at:'x'}, {taskId:'b', usd:2, at:new Date(T0).toISOString()}, {taskId:'c', usd:1, at:'bad'}]),
    [{taskId:'b', usd:2, at:new Date(T0).toISOString()}]);
  assert.deepEqual(parseSpendLedger('x'), []);
  assertNoProgress(big.slice(0, 3));
});

test('task budget: Developer page wires budget prefs, start gating and manual stop', () => {
  const src = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  for (const label of ['Task budget', 'Stop overdue', 'Record spend', 'Save budget']) assert.ok(src.includes(label), label);
  assert.match(src, /usePref<unknown>\(TASK_BUDGET_PREF_KEY, DEFAULT_TASK_BUDGET\)/);
  assert.match(src, /usePref<unknown>\('developer\.taskSpend'/);
  assert.match(src, /transitionTask\(t, 'stopped', \{ now: at, stopReason: 'timeout' \}\)/);
  assert.match(src, /disabled=\{!!startBlocked\} onClick=\{\(\) => onMove\(task, 'running'\)\}>Start/);
  assert.match(src, /disabled=\{!!startBlocked\} onClick=\{\(\) => onMove\(task, 'running'\)\}>Resume/);
  assert.doesNotMatch(src, /setInterval|setTimeout|fetch\(/);
  const mod = readFileSync(path.join(root, 'src/ui/task-budget.ts'), 'utf8');
  assert.doesNotMatch(mod, /fetch\(|XMLHttpRequest|WebSocket|document\.|window\.|setInterval|setTimeout/);
});
