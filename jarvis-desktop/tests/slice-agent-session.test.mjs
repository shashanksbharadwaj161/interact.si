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
const al = await load('src/ui/agent-log.ts');
const as = await load('src/ui/agent-session.ts');
const {createTask, transitionTask} = tb;
const {appendEntry} = al;
const {AGENT_SESSION_FORMAT, AGENT_SESSION_VERSION, SESSION_LIMITS, RESUME_PAUSE_NOTE, buildSession, serializeSession, parseSession, planResume, diffSessions, normalizeSavedSessions, upsertSession} = as;

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const mk = (i) => createTask({title:`Task ${i}`, role:'worker', model:'claude-sonnet-5-5'}, T0 + i, {next:i});
const run = (t) => transitionTask(t, 'running', {now:T0 + 100});
function board() {
  const q = mk(0);
  const r = run(mk(1));
  const p = transitionTask(run(mk(2)), 'paused', {now:T0 + 200});
  const d = transitionTask(run(mk(3)), 'done', {now:T0 + 300, stopReason:'completed'});
  const r2 = run(mk(4));
  return [q, r, p, d, r2];
}
const SECRET = 'sk-abcdefghijklmnop1234';
function sampleLog() {
  let log = appendEntry([], {taskId:'t-1', level:'info', message:`key ${SECRET}`, data:'password=hunter2 Bearer abc.def.ghi'}, T0);
  log = appendEntry(log, {taskId:'t-1', level:'result', message:'ok'}, T0 + 1);
  return log;
}
const sample = (over = {}) => buildSession({name:'Morning', tasks:board(), log:sampleLog(), budget:{maxConcurrentRunning:3}, spend:[{taskId:'manual', usd:1.5, at:new Date(T0).toISOString()}, {bad:true}], now:T0 + 1000, ...over});

test('agent session: envelope shape and counts', () => {
  assert.equal(AGENT_SESSION_FORMAT, 'desktop-companion-agent-session');
  assert.equal(AGENT_SESSION_VERSION, 1);
  assert.deepEqual({...SESSION_LIMITS}, {jsonChars:400000, name:80});
  const s = sample({name:'  Morning  '});
  assert.deepEqual(Object.keys(s).sort(), ['budget', 'counts', 'format', 'log', 'name', 'savedAt', 'spend', 'tasks', 'version']);
  assert.equal(s.format, AGENT_SESSION_FORMAT);
  assert.equal(s.name, 'Morning');
  assert.equal(s.savedAt, new Date(T0 + 1000).toISOString());
  assert.deepEqual(s.counts, {tasks:5, log:2, running:2, paused:1, queued:1});
  assert.equal(s.budget.maxConcurrentRunning, 3);
  assert.equal(s.budget.maxTasksPerDay, 20);
  assert.equal(s.spend.length, 1, 'malformed spend dropped');
  assert.throws(() => sample({name:'   '}), /Session name is required/);
  assert.throws(() => sample({name:'x'.repeat(81)}), /at most 80 characters/);
  assert.equal(sample({name:'x'.repeat(80)}).name.length, 80);
  assert.throws(() => sample({now:Number.NaN}), /Invalid session timestamp/);
  assert.throws(() => sample({now:'not a date'}), /Invalid session timestamp/);
});

test('agent session: saved log data has secrets redacted', () => {
  const s = sample();
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /hunter2|sk-abcdefghijklmnop1234|abc\.def\.ghi/);
  assert.match(s.log[0].message, /\[redacted\]/);
  assert.match(s.log[0].data, /password=\[redacted\]/);
  assert.equal(s.log[1].message, 'ok');
  const parsed = parseSession(JSON.stringify({...s, log:[{...s.log[0], id:'l-x', message:`again ${SECRET}`}]}));
  assert.doesNotMatch(JSON.stringify(parsed.session.log), /sk-abcdefghijklmnop1234/, 'pasted logs are redacted too');
});

test('agent session: serialize/parse round trip', () => {
  const s = sample();
  const text = serializeSession(s);
  const back = parseSession(text);
  assert.deepEqual(back.session, s);
  assert.deepEqual(back.dropped, {tasks:0, log:0, spend:0});
  const withJunk = parseSession(JSON.stringify({...s, tasks:[...s.tasks, {id:''}, null], log:[...s.log, {level:'nope'}], spend:[...s.spend, 5], counts:{tasks:999}}));
  assert.deepEqual(withJunk.dropped, {tasks:2, log:1, spend:1});
  assert.deepEqual(withJunk.session.counts, s.counts, 'counts are recomputed');
});

test('agent session: parse rejections use exact $-paths', () => {
  const s = sample();
  const j = (over) => JSON.stringify({...s, ...over});
  const cases = [
    ['{nope', /^Error: \$: invalid JSON\.$/],
    ['[]', /^Error: \$: expected an object\.$/],
    ['null', /^Error: \$: expected an object\.$/],
    [j({format:'other'}), /^Error: \$\.format: expected "desktop-companion-agent-session"\.$/],
    [j({version:2}), /^Error: \$\.version: expected 1\.$/],
    [j({name:''}), /^Error: \$\.name: expected a non-empty string of at most 80 characters\.$/],
    [j({name:'x'.repeat(81)}), /^Error: \$\.name: /],
    [j({savedAt:'yesterday'}), /^Error: \$\.savedAt: expected an ISO timestamp\.$/],
    [j({tasks:{}}), /^Error: \$\.tasks: expected an array\.$/],
    [j({log:'x'}), /^Error: \$\.log: expected an array\.$/],
    [j({budget:[]}), /^Error: \$\.budget: expected an object\.$/],
    [j({spend:null}), /^Error: \$\.spend: expected an array\.$/],
  ];
  for (const [text, re] of cases) assert.throws(() => parseSession(text), re, text.slice(0, 60));
  assert.throws(() => parseSession(42), /^Error: \$: expected JSON text\.$/);
});

test('agent session: oversize input is rejected', () => {
  const big = ' '.repeat(400001);
  assert.throws(() => parseSession(big), /^Error: \$: session JSON exceeds 400000 characters/);
  const s = sample();
  const huge = {...s, log:Array.from({length:200}, (_, i) => ({id:`l-${i}`, taskId:`t${i}`, at:s.savedAt, level:'info', message:'m', data:'word '.repeat(790)}))};
  assert.throws(() => serializeSession(huge), /^Error: \$: session JSON exceeds 400000 characters/);
});

test('agent session: planResume pauses running tasks with the exact note and keeps others verbatim', () => {
  const s = sample();
  const plan = planResume(s, T0 + 2000);
  assert.equal(RESUME_PAUSE_NOTE, 'Paused on resume: no worker was executing after restart');
  const runningIds = s.tasks.filter((t) => t.status === 'running').map((t) => t.id);
  assert.deepEqual(plan.actions, runningIds.map((taskId) => ({taskId, from:'running', to:'paused', reason:'Paused on resume: no worker was executing after restart'})));
  assert.ok(plan.tasks.every((t) => t.status !== 'running'), 'never produces running');
  for (const [i, t] of s.tasks.entries()) {
    if (t.status === 'running') {
      assert.equal(plan.tasks[i].status, 'paused');
      assert.equal(plan.tasks[i].note, 'Paused on resume: no worker was executing after restart');
      assert.equal(plan.tasks[i].startedAt, t.startedAt);
      assert.equal(plan.tasks[i].endedAt, undefined);
    } else {
      assert.equal(plan.tasks[i], t, 'kept verbatim');
    }
  }
  assert.deepEqual(plan.warnings, []);
  assert.equal(s.tasks[1].status, 'running', 'input not mutated');
  assert.doesNotMatch(JSON.stringify(plan), /progress|percent/i);
});

test('agent session: future and stale savedAt produce warnings', () => {
  const s = sample();
  const future = planResume(s, T0);
  assert.equal(future.warnings.length, 1);
  assert.match(future.warnings[0], /in the future/);
  assert.ok(future.warnings[0].includes(s.savedAt));
  const stale = planResume(s, T0 + 1000 + 31 * DAY);
  assert.equal(stale.warnings.length, 1);
  assert.match(stale.warnings[0], /older than 30 days/);
  assert.deepEqual(planResume(s, T0 + 1000 + 29 * DAY).warnings, []);
  assert.throws(() => planResume(s, 'bad'), /Invalid session timestamp/);
});

test('agent session: diffSessions lists only-in-current, only-in-incoming and status changes', () => {
  const [q, r, p] = board();
  const extra = mk(9);
  const current = {tasks:[q, r, p]};
  const incoming = {tasks:[transitionTask(q, 'running', {now:T0}), r, extra]};
  assert.deepEqual(diffSessions(current, incoming), {
    onlyInCurrent:[p.id],
    onlyInIncoming:[extra.id],
    statusChanged:[{taskId:q.id, from:'queued', to:'running'}],
  });
  assert.deepEqual(diffSessions({tasks:[]}, {tasks:[]}), {onlyInCurrent:[], onlyInIncoming:[], statusChanged:[]});
});

test('agent session: saved list caps at 10, newest first, replaces same name', () => {
  let list = [];
  for (let i = 0; i < 12; i++) list = upsertSession(list, sample({name:`s${i}`, now:T0 + i}));
  assert.equal(list.length, 10);
  assert.equal(list[0].name, 's11');
  list = upsertSession(list, sample({name:'s5', now:T0 + 99}));
  assert.equal(list[0].name, 's5');
  assert.equal(list.filter((x) => x.name === 's5').length, 1);
  assert.deepEqual(normalizeSavedSessions([...list, {junk:true}, 'x']).map((x) => x.name), list.map((x) => x.name));
  assert.deepEqual(normalizeSavedSessions('nope'), []);
});

test('agent session: module is offline and Developer page wires a Sessions group', () => {
  const mod = readFileSync(path.join(root, 'src/ui/agent-session.ts'), 'utf8');
  assert.doesNotMatch(mod, /setTimeout|setInterval|fetch|XMLHttpRequest|WebSocket|document\.|window\./);
  assert.match(mod, /from '\.\/task-board'/);
  assert.match(mod, /from '\.\/agent-log'/);
  assert.match(mod, /from '\.\/task-budget'/);
  const src = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  assert.match(src, /usePref<unknown>\(AGENT_SESSION_PREF_KEY, \[\]\)/);
  assert.equal(as.AGENT_SESSION_PREF_KEY, 'developer.agentSessions');
  for (const label of ['Sessions', 'Save session', 'Export JSON', 'Validate', 'Confirm resume', 'Resuming never starts a worker']) assert.ok(src.includes(label), label);
  assert.match(src, /navigator\.clipboard\.writeText\(serializeSession\(/);
  assert.match(src, /<SessionsGroup tasks=\{tasks\}/);
});
