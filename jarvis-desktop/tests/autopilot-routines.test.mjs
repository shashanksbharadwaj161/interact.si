// Routine engine tests: validation, schedules, retries, duplicate prevention, pause/cancel, partial results, undo,
// restart recovery, and the editor helpers. Actions run through the REAL ActionService with a mock native adapter and
// a stub trusted confirmation, so no desktop input happens and every sensitive step is shown to the confirmation.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'autopilot-routines-entry.ts',
    loader: 'ts',
    contents: `export * from './electron/services/routines.ts'; export {ActionService} from './electron/services/actions.ts'; export {DEFAULT_SETTINGS} from './electron/services/validation.ts';`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {RoutineEngine, ActionService, DEFAULT_SETTINGS, ROUTINE_GATES, validateRoutine, nextSlot, latestSlot, inTimeWindow, createRoutinesApi, SCHEDULE_GRACE_MS, MAX_RUN_HISTORY} = mod;

const T0 = new Date(2026, 9, 14, 8, 0, 0, 0).getTime(); // Wednesday 14 Oct 2026, 08:00 local

function harness({confirm = async () => true, startConfirm, windows, focusResults, stored, sleep, safe = () => false} = {}) {
  let now = T0;
  let id = 0;
  const calls = {confirm: [], start: [], moves: [], focus: 0, urls: [], spawned: [], saves: 0, activity: []};
  const wins = windows ?? [
    {hwnd: 101, title: 'Untitled - Notepad', pid: 11, process: 'notepad.exe', x: 10, y: 20, width: 300, height: 200, minimized: false, maximized: false, foreground: false, elevated: 0},
    {hwnd: 201, title: 'Inbox - Mail', pid: 21, process: 'olk.exe', x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, foreground: false, elevated: 0},
  ];
  const focus = [...(focusResults ?? [])];
  const native = {
    listWindows: async () => wins.map((w) => ({...w})),
    focusWindow: async () => { calls.focus++; return {focused: focus.length ? focus.shift() : true}; },
    moveWindow: async (ref, rect) => { calls.moves.push({hwnd: ref.hwnd, ...rect}); const w = wins.find((x) => x.hwnd === ref.hwnd); Object.assign(w, rect); return {...rect, clamped: false}; },
    typeText: async () => { throw new Error('typeText must not be used in routine tests'); },
    click: async () => { throw new Error('click must never be used'); },
  };
  const actions = new ActionService({
    settings: () => ({...DEFAULT_SETTINGS}),
    activity: async () => {},
    native,
    shell: {openExternal: async (u) => { calls.urls.push(u); }, openPath: async () => '', spawnApp: async (p) => { calls.spawned.push(p); }},
    selfPids: () => [1],
    safeLaunch: safe,
    now: () => now,
    newId: () => `p${++id}`,
    confirm: async (summary, detail) => { calls.confirm.push({summary, detail}); return confirm(summary, detail); },
  });
  const storage = {data: stored ?? null, async load() { return this.data === null ? null : structuredClone(this.data); }, async save(d) { calls.saves++; this.data = structuredClone(d); }};
  const timers = [];
  const engine = new RoutineEngine({
    storage, actions, now: () => now, newId: () => `r${++id}`,
    windows: async () => native.listWindows(),
    confirm: startConfirm === null ? undefined : async (s, d) => { calls.start.push({s, d}); return (startConfirm ?? (async () => true))(s, d); },
    activity: async (k, s) => { calls.activity.push(s); },
    safeLaunch: safe,
    setTimer: (fn, ms) => { const t = {fn, ms, at: now + ms, unref() {}}; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    sleep: sleep ?? (async () => {}),
  });
  return {engine, storage, calls, wins, timers, actions, setNow: (t) => { now = t; }, get now() { return now; }};
}

const moveStep = (extra = {}) => ({kind: 'action', request: {type: 'move-window', target: 'notepad', x: 100, y: 100, width: 640, height: 480}, ...extra});
const urlStep = (extra = {}) => ({kind: 'action', request: {type: 'open-url', target: 'https://example.com/docs'}, ...extra});
const focusStep = (extra = {}) => ({kind: 'action', request: {type: 'focus', target: 'hwnd:201'}, ...extra});

test('validation stores only safe, planned steps and refuses gated or ambiguous ones', () => {
  let n = 0;
  const nid = () => `s${++n}`;
  const r = validateRoutine({name: '  Morning  ', steps: [urlStep(), {kind: 'wait', seconds: 5}, moveStep({undoable: true, retries: 2})]}, nid, T0);
  assert.equal(r.name, 'Morning');
  assert.deepEqual(r.schedule, {kind: 'manual'});
  assert.equal(r.steps[0].request.target, 'https://example.com/docs');
  assert.equal(r.steps[0].onFailure, 'stop');
  assert.equal(r.steps[2].retries, 2);
  assert.equal(r.steps[2].undoable, true);
  const bad = [
    [{name: 'x', steps: [{kind: 'action', request: {type: 'click', x: 1, y: 1}}]}, /Clicking is not available/],
    [{name: 'x', steps: [{kind: 'action', request: {type: 'launch', target: 'cmd.exe /c del *'}}]}, /Shell operators|arguments/],
    [{name: 'x', steps: [{kind: 'action', request: {type: 'launch', target: 'setup.ps1'}}]}, /Scripts/],
    [{name: 'x', steps: [{kind: 'action', request: {type: 'focus', target: 'it'}}]}, /ambiguous/],
    [{name: 'x', steps: [{kind: 'action', request: {type: 'move-window', target: 'notepad'}}]}, /position and size/],
    [{name: 'x', steps: [{kind: 'record'}]}, /recording steps are not available/],
    [{name: 'x', steps: [{kind: 'drag'}]}, /semantic drag/],
    [{name: 'x', steps: [urlStep({shell: 'calc'})]}, /field "shell"/],
    [{name: 'x', steps: [urlStep({undoable: true})]}, /only window moves can be undone/],
    [{name: 'x', steps: [urlStep({retries: 9})]}, /retries must be a whole number from 0 to 3/],
    [{name: 'x', steps: [urlStep({id: 'a'}), urlStep({id: 'a'})]}, /Duplicate step id/],
    [{name: 'x', steps: Array.from({length: 21}, () => urlStep())}, /at most 20 steps/],
    [{name: 'x', steps: []}, /at least one step/],
    [{name: '', steps: [urlStep()]}, /Name is required/],
    [{name: 'x', steps: [urlStep({condition: {kind: 'previous', is: 'succeeded'}})]}, /Step 1 cannot depend/],
    [{name: 'x', schedule: {kind: 'interval', minutes: 1}, steps: [urlStep()]}, /from 5 to 1440/],
    [{name: 'x', schedule: {kind: 'daily', time: '25:00'}, steps: [urlStep()]}, /24-hour time/],
    [{name: 'x', schedule: {kind: 'cron', expr: '* * * * *'}, steps: [urlStep()]}, /schedule.kind/],
    [{name: 'x', steps: [{kind: 'wait', seconds: 301}]}, /from 1 to 300/],
  ];
  for (const [raw, re] of bad) assert.throws(() => validateRoutine(raw, nid, T0), re, JSON.stringify(raw));
});

test('schedule math: daily weekdays, interval anchoring, once, and wrap-around time windows', () => {
  const daily = {kind: 'daily', time: '09:30', days: [1, 2, 3, 4, 5]};
  assert.equal(nextSlot(daily, T0, T0), new Date(2026, 9, 14, 9, 30).getTime());
  const fri = new Date(2026, 9, 16, 10, 0).getTime();
  assert.equal(nextSlot(daily, fri, T0), new Date(2026, 9, 19, 9, 30).getTime(), 'skips the weekend to Monday');
  assert.equal(latestSlot(daily, fri, T0, T0), new Date(2026, 9, 16, 9, 30).getTime());
  assert.equal(latestSlot(daily, fri, new Date(2026, 9, 16, 9, 30).getTime(), T0), null, 'a consumed slot is never returned again');
  const every = {kind: 'interval', minutes: 15};
  assert.equal(nextSlot(every, T0 + 1, T0), T0 + 15 * 60_000);
  assert.equal(latestSlot(every, T0 + 47 * 60_000, T0, T0), T0 + 45 * 60_000);
  assert.equal(latestSlot(every, T0 + 10 * 60_000, T0, T0), null);
  const once = {kind: 'once', at: new Date(T0 + 60_000).toISOString()};
  assert.equal(nextSlot(once, T0, T0), T0 + 60_000);
  assert.equal(nextSlot(once, T0 + 60_000, T0), null);
  assert.equal(nextSlot({kind: 'manual'}, T0, T0), null);
  assert.equal(inTimeWindow({kind: 'time', start: '22:00', end: '06:00'}, new Date(2026, 9, 14, 23, 0).getTime()), true);
  assert.equal(inTimeWindow({kind: 'time', start: '22:00', end: '06:00'}, new Date(2026, 9, 14, 12, 0).getTime()), false);
});

test('every sensitive step goes through the ActionService native confirmation, and a decline stops the run', async () => {
  const h = harness();
  await h.engine.init();
  const v = await h.engine.save({name: 'Desk', steps: [moveStep(), urlStep()]});
  const run = await h.engine.run(v.routines[0].id);
  assert.equal(run.status, 'succeeded', JSON.stringify(run));
  assert.equal(h.calls.confirm.length, 2, 'one trusted confirmation per sensitive step');
  assert.match(h.calls.confirm[0].summary, /Move "Untitled - Notepad"/);
  assert.match(h.calls.confirm[1].summary, /example\.com/);
  assert.deepEqual(h.calls.moves, [{hwnd: 101, x: 100, y: 100, width: 640, height: 480}]);
  assert.deepEqual(h.calls.urls, ['https://example.com/docs']);

  const declined = harness({confirm: async (s) => !/Move/.test(s)});
  await declined.engine.init();
  const v2 = await declined.engine.save({name: 'Desk', steps: [moveStep({onFailure: 'continue'}), urlStep()]});
  const r2 = await declined.engine.run(v2.routines[0].id);
  assert.equal(r2.status, 'declined');
  assert.deepEqual(r2.steps.map((s) => s.status), ['declined', 'skipped']);
  assert.match(r2.steps[1].reason, /declined/);
  assert.equal(declined.calls.moves.length, 0, 'nothing moved without confirmation');
  assert.equal(declined.calls.urls.length, 0, 'a decline stops later steps even with onFailure continue');
});

test('a port that skips confirmation for a sensitive action is refused', async () => {
  const executed = [];
  const engine = new RoutineEngine({
    storage: {load: async () => null, save: async () => {}}, now: () => T0, newId: (() => { let i = 0; return () => `x${++i}`; })(),
    actions: {preview: async () => ({id: 'p', summary: 'Open', allowed: true, requiresApproval: false}), execute: async (...a) => { executed.push(a); return {executed: true}; }},
  });
  await engine.init();
  const v = await engine.save({name: 'Bad port', steps: [urlStep()]});
  const run = await engine.run(v.routines[0].id);
  assert.equal(run.steps[0].status, 'blocked');
  assert.match(run.steps[0].reason, /must require confirmation/);
  assert.equal(executed.length, 0);
});

test('bounded retries use a fresh preview and confirmation each attempt; declines and policy blocks are not retried', async () => {
  const h = harness({focusResults: [false, false, true]});
  await h.engine.init();
  const v = await h.engine.save({name: 'Retry', steps: [focusStep({retries: 2, retryDelaySeconds: 1})]});
  const run = await h.engine.run(v.routines[0].id);
  assert.equal(run.steps[0].status, 'succeeded');
  assert.equal(run.steps[0].attempts, 3);
  assert.equal(h.calls.confirm.length, 3);

  const h2 = harness({focusResults: [false, false, false, false, false]});
  await h2.engine.init();
  const v2 = await h2.engine.save({name: 'Retry', steps: [focusStep({retries: 1})]});
  const r2 = await h2.engine.run(v2.routines[0].id);
  assert.equal(r2.status, 'failed');
  assert.equal(r2.steps[0].attempts, 2);
  assert.match(r2.steps[0].reason, /after 2 attempts/);

  const h3 = harness({confirm: async () => false});
  await h3.engine.init();
  const v3 = await h3.engine.save({name: 'No', steps: [focusStep({retries: 3})]});
  const r3 = await h3.engine.run(v3.routines[0].id);
  assert.equal(r3.steps[0].status, 'declined');
  assert.equal(h3.calls.confirm.length, 1, 'a declined confirmation is never asked again by a retry');

  const h4 = harness();
  await h4.engine.init();
  const v4 = await h4.engine.save({name: 'Blocked', steps: [{kind: 'action', request: {type: 'launch', target: 'notepad.exe'}, retries: 3}]});
  const r4 = await h4.engine.run(v4.routines[0].id);
  assert.equal(r4.steps[0].status, 'blocked', 'an app that is not approved is blocked by policy');
  assert.equal(h4.calls.confirm.length, 0);
  assert.equal(h4.calls.spawned.length, 0);
});

test('partial results, conditions and onFailure continue are recorded per step', async () => {
  const h = harness();
  await h.engine.init();
  const v = await h.engine.save({name: 'Mixed', steps: [
    {kind: 'action', request: {type: 'focus', target: 'Calculator'}, onFailure: 'continue'},
    urlStep({condition: {kind: 'previous', is: 'failed'}}),
    focusStep({condition: {kind: 'window', match: 'Calculator', present: true}}),
    focusStep({condition: {kind: 'weekday', days: [0]}}),
  ]});
  const run = await h.engine.run(v.routines[0].id);
  assert.equal(run.status, 'partial');
  assert.deepEqual(run.steps.map((s) => s.status), ['blocked', 'succeeded', 'skipped', 'skipped']);
  assert.match(run.steps[2].reason, /not open/);
  assert.match(run.steps[3].reason, /weekdays/);
  const stored = h.storage.data.runs[0];
  assert.equal(stored.status, 'partial', 'history is persisted');
});

test('duplicate prevention: one run per routine, no overlapping routines, safe launch and pause refuse starts', async () => {
  let release;
  const h = harness({sleep: (ms, signal) => new Promise((res) => { release = res; signal.addEventListener('abort', res); })});
  await h.engine.init();
  const a = (await h.engine.save({name: 'A', steps: [{kind: 'wait', seconds: 10}, urlStep()]})).routines[0];
  const b = (await h.engine.save({name: 'B', steps: [urlStep()]})).routines[1];
  const first = h.engine.start(a.id);
  await new Promise((r) => setImmediate(r));
  assert.throws(() => h.engine.start(a.id), /already running/);
  assert.throws(() => h.engine.start(b.id), /never overlap/);
  await assert.rejects(h.engine.remove(a.id), /Cancel the running routine/);
  release();
  assert.equal((await first.done).status, 'succeeded');
  assert.equal(h.engine.view().activeRunId, null);
  await h.engine.pauseAll();
  assert.throws(() => h.engine.start(b.id), /paused/);
  const safe = harness({safe: () => true});
  await safe.engine.init();
  const s = (await safe.engine.save({name: 'S', steps: [urlStep()]})).routines[0];
  assert.throws(() => safe.engine.start(s.id), /Safe launch/);
});

test('schedules: trusted start confirmation, exactly-once slots across restarts, missed and grace handling', async () => {
  const h = harness();
  await h.engine.init();
  const r = (await h.engine.save({name: 'Daily', schedule: {kind: 'daily', time: '09:00'}, steps: [urlStep()]})).routines[0];
  const nine = new Date(2026, 9, 14, 9, 0).getTime();
  assert.equal(r.nextDueAt, new Date(nine).toISOString());
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, nine - T0, 'one timer aimed at the next slot, no polling');
  h.setNow(nine + 1000);
  assert.equal(await h.engine.fire(), 1);
  const run = await new Promise((res) => { const t = setInterval(() => { const x = h.engine.view(); if (!x.activeRunId) { clearInterval(t); res(x.runs[0]); } }, 1); });
  assert.equal(run.trigger, 'schedule');
  assert.equal(run.status, 'succeeded');
  assert.equal(h.calls.start.length, 1);
  assert.match(h.calls.start[0].s, /Run routine "Daily" now\?/);
  assert.match(h.calls.start[0].d, /Each desktop action asks for its own confirmation/);
  assert.equal(h.calls.confirm.length, 1, 'the step still had its own action confirmation');
  assert.equal(await h.engine.fire(), 0, 'the same slot never runs twice');

  // Restart with the persisted data: the consumed slot is remembered.
  const again = harness({stored: h.storage.data});
  again.setNow(nine + 2000);
  await again.engine.init();
  assert.equal(again.calls.start.length, 0);
  assert.equal(again.engine.view().routines[0].nextDueAt, new Date(2026, 9, 15, 9, 0).toISOString());

  // Closed for a day: the 15th's slot was missed long ago, so it is recorded, not run.
  const late = harness({stored: again.storage.data});
  late.setNow(new Date(2026, 9, 15, 11, 0).getTime());
  await late.engine.init();
  assert.equal(late.calls.start.length, 0);
  assert.equal(late.engine.view().runs[0].status, 'missed');

  // Within the grace window after start-up, the slot runs once.
  const grace = harness({stored: late.storage.data});
  grace.setNow(new Date(2026, 9, 16, 9, 0).getTime() + SCHEDULE_GRACE_MS - 1000);
  await grace.engine.init();
  assert.equal(grace.calls.start.length, 1);
});

test('scheduled runs without a trusted confirmation, or declined, never start', async () => {
  for (const [startConfirm, re] of [[null, /No trusted confirmation/], [async () => false, /declined in the native confirmation/]]) {
    const h = harness({startConfirm});
    await h.engine.init();
    await h.engine.save({name: 'Every', schedule: {kind: 'interval', minutes: 5}, steps: [urlStep()]});
    h.setNow(T0 + 5 * 60_000);
    assert.equal(await h.engine.fire(), 0);
    const run = h.engine.view().runs[0];
    assert.equal(run.status, 'declined');
    assert.match(run.reason, re);
    assert.equal(h.calls.confirm.length, 0);
    assert.equal(h.calls.urls.length, 0);
  }
});

test('pause-all holds a running routine between steps and skips slots that came due while paused', async () => {
  let release;
  const h = harness({sleep: (ms, signal) => new Promise((res) => { release = res; signal.addEventListener('abort', res); })});
  await h.engine.init();
  const r = (await h.engine.save({name: 'P', schedule: {kind: 'interval', minutes: 5}, steps: [{kind: 'wait', seconds: 3}, urlStep()]})).routines[0];
  const started = h.engine.start(r.id);
  await new Promise((res) => setImmediate(res));
  await h.engine.pauseAll();
  assert.equal(h.timers.length, 0, 'no timer while paused');
  release();
  await new Promise((res) => setTimeout(res, 5));
  let view = h.engine.view();
  assert.equal(view.runs[0].status, 'paused');
  assert.equal(h.calls.urls.length, 0, 'the next step waits for resume');
  h.setNow(T0 + 20 * 60_000);
  assert.equal(await h.engine.fire(), 0);
  await h.engine.resumeAll();
  const done = await started.done;
  assert.equal(done.status, 'succeeded');
  assert.equal(h.calls.urls.length, 1);
  view = h.engine.view();
  assert.ok(Date.parse(view.routines[0].nextDueAt) > h.now, 'slots during the pause were skipped, not run in a burst');
  assert.equal(h.calls.start.length, 0);
});

test('cancellation stops before the next step and keeps partial results', async () => {
  let release;
  const h = harness({sleep: (ms, signal) => new Promise((res) => { release = res; signal.addEventListener('abort', res); })});
  await h.engine.init();
  const r = (await h.engine.save({name: 'C', steps: [urlStep(), {kind: 'wait', seconds: 60}, moveStep()]})).routines[0];
  const s = h.engine.start(r.id);
  await new Promise((res) => setTimeout(res, 5));
  await h.engine.cancel(s.runId);
  const run = await s.done;
  assert.equal(run.status, 'cancelled');
  assert.deepEqual(run.steps.map((x) => x.status), ['succeeded', 'cancelled', 'cancelled']);
  assert.equal(h.calls.moves.length, 0);
  await assert.rejects(h.engine.cancel(s.runId), /not active/);
  assert.ok(release);
});

test('undo reverses only explicitly reversible moves, through confirmation, once', async () => {
  const h = harness();
  await h.engine.init();
  const r = (await h.engine.save({name: 'U', steps: [moveStep({undoable: true}), urlStep()]})).routines[0];
  const run = await h.engine.run(r.id);
  assert.equal(run.status, 'succeeded');
  assert.match(run.steps[0].undo.summary, /back to 10,20 size 300×200/);
  assert.equal(run.steps[1].undo, undefined, 'opening a link is not reversible');
  const before = h.calls.confirm.length;
  const u = await h.engine.undo(run.id);
  assert.equal(u.undone, 1);
  assert.equal(h.calls.confirm.length, before + 1, 'undo asks for its own confirmation');
  assert.deepEqual(h.calls.moves.at(-1), {hwnd: 101, x: 10, y: 20, width: 300, height: 200});
  const again = await h.engine.undo(run.id);
  assert.equal(again.undone, 0);
  assert.match(again.reason, /Nothing/);

  const amb = harness({windows: [
    {hwnd: 1001, title: 'a - Notepad', pid: 5, process: 'notepad.exe', x: 0, y: 0, width: 10, height: 10, minimized: false, maximized: false, foreground: false, elevated: 0},
    {hwnd: 1002, title: 'b - Notepad', pid: 6, process: 'notepad.exe', x: 0, y: 0, width: 10, height: 10, minimized: false, maximized: false, foreground: false, elevated: 0},
  ]});
  await amb.engine.init();
  const ar = (await amb.engine.save({name: 'A', steps: [moveStep({undoable: true})]})).routines[0];
  const arun = await amb.engine.run(ar.id);
  assert.equal(arun.steps[0].status, 'failed');
  assert.match(arun.steps[0].reason, /needs exactly one/);
  assert.equal(amb.calls.moves.length, 0);
});

test('restart marks in-flight runs interrupted, drops invalid stored routines, and bounds history', async () => {
  const runs = Array.from({length: MAX_RUN_HISTORY + 10}, (_, i) => ({id: `old${i}`, routineId: 'gone', routineName: 'Old', trigger: 'manual', status: 'succeeded', startedAt: '', steps: []}));
  runs[0] = {id: 'live', routineId: 'gone', routineName: 'Live', trigger: 'manual', status: 'running', startedAt: '', steps: [{stepId: 'a', label: 'a', status: 'succeeded', attempts: 1}, {stepId: 'b', label: 'b', status: 'pending', attempts: 0}]};
  const stored = {version: 1, paused: false, slots: {}, anchors: {}, runs, routines: [
    {id: 'ok1', name: 'Fine', enabled: true, schedule: {kind: 'manual'}, steps: [urlStep({id: 's1'})], createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString()},
    {id: 'bad1', name: 'Evil', enabled: true, schedule: {kind: 'manual'}, steps: [{kind: 'action', id: 's1', request: {type: 'click', x: 1, y: 1}}]},
  ]};
  const h = harness({stored});
  const v = await h.engine.init();
  assert.deepEqual(v.routines.map((r) => r.id), ['ok1']);
  assert.match(v.loadError, /1 stored routine was invalid/);
  assert.equal(v.runs.length, MAX_RUN_HISTORY);
  assert.equal(v.runs[0].status, 'interrupted');
  assert.deepEqual(v.runs[0].steps.map((s) => s.status), ['succeeded', 'cancelled']);
  assert.equal(h.calls.confirm.length, 0, 'nothing resumes automatically');
});

test('gates for recording, semantic drag and richer adapters are honest, and the API plans candidates only', async () => {
  assert.deepEqual(ROUTINE_GATES.map((g) => g.id), [88, 89, 90]);
  for (const g of ROUTINE_GATES) { assert.equal(g.available, false); assert.match(g.reason, /G4/); }
  const h = harness();
  await h.engine.init();
  const api = createRoutinesApi(h.engine);
  const plan = await api.planText('open https://example.com\nwait 2 seconds\nfocus hwnd:201');
  assert.equal(plan.status, 'ready');
  assert.equal(plan.previewOnly, true);
  assert.equal(plan.steps.length, 3);
  assert.equal(h.calls.confirm.length + h.calls.urls.length + h.calls.focus, 0, 'planning never executes');
  const m = await api.planModel('{"name":"x","steps":[{"type":"open-url","target":"https://example.com"}],"schedule":{"kind":"daily"}}');
  assert.equal(m.status, 'blocked');
  assert.match(m.reason, /schedules, tools and commands/);
  const saved = await api.save({name: 'From plan', steps: plan.steps.map((s) => (s.kind === 'wait' ? {kind: 'wait', seconds: s.seconds} : {kind: 'action', request: s.request}))});
  assert.equal(saved.routines[0].steps.length, 3);
  const {runId} = await api.start(saved.routines[0].id);
  assert.equal(typeof runId, 'string');
});

test('storage failures surface as saveError instead of being hidden', async () => {
  const h = harness();
  h.storage.save = async () => { throw new Error('disk full'); };
  await h.engine.init();
  const v = await h.engine.save({name: 'x', steps: [urlStep()]});
  assert.match(v.saveError, /disk full/);
});

// ---------------------------------------------------------------------------------------------------------------
// Persisted lifecycle through the IPC API a main-process owner would expose (createRoutinesApi), with the injected
// action confirmation. Every engine below is rebuilt from the stored data only, like an app restart.
const settle = () => new Promise((r) => setTimeout(r, 5));

test('persisted routines survive a restart and start through the API with the injected action confirmation', async () => {
  const first = harness();
  await first.engine.init();
  const saved = await createRoutinesApi(first.engine).save({name: 'Morning', steps: [urlStep(), focusStep()]});
  assert.equal(saved.routines.length, 1);

  const decline = harness({stored: first.storage.data, confirm: async () => false});
  const dApi = createRoutinesApi(decline.engine);
  const loaded = await decline.engine.init();
  assert.equal(loaded.routines[0].name, 'Morning');
  const id = loaded.routines[0].id;
  const {runId} = await dApi.start(id);
  await settle();
  const declined = (await dApi.list()).runs.find((r) => r.id === runId);
  assert.equal(declined.status, 'declined');
  assert.equal(decline.calls.confirm.length, 1, 'the first sensitive step went to the injected confirmation');
  assert.match(decline.calls.confirm[0].detail, /example\.com/);
  assert.equal(decline.calls.urls.length, 0, 'a declined step never reaches the shell');
  assert.equal(decline.calls.focus, 0, 'later steps are not attempted after a decline');
  assert.deepEqual(declined.steps.map((s) => s.status), ['declined', 'skipped']);

  const approve = harness({stored: decline.storage.data, confirm: async () => true});
  await approve.engine.init();
  const aApi = createRoutinesApi(approve.engine);
  const started = approve.engine.start(id);
  const run = await started.done;
  assert.equal(run.status, 'succeeded');
  assert.equal(approve.calls.confirm.length, 2, 'one confirmation per sensitive step');
  assert.deepEqual(approve.calls.urls, ['https://example.com/docs']);
  assert.equal(approve.storage.data.runs[0].status, 'succeeded', 'the finished run is persisted');
  assert.equal((await aApi.list()).routines[0].id, id);
});

test('duplicate prevention holds through the API and a persisted run never blocks the next start', async () => {
  let release;
  const stall = (ms, signal) => new Promise((res) => { release = res; signal.addEventListener('abort', res); });
  const seed = harness();
  await seed.engine.init();
  await seed.engine.save({name: 'Dup', steps: [{kind: 'wait', seconds: 30}, urlStep()]});

  const h = harness({stored: seed.storage.data, sleep: stall});
  const api = createRoutinesApi(h.engine);
  const id = (await h.engine.init()).routines[0].id;
  const [a, b] = await Promise.allSettled([api.start(id), api.start(id)]);
  assert.equal([a, b].filter((x) => x.status === 'fulfilled').length, 1, 'a double click starts exactly one run');
  assert.equal([a, b].filter((x) => x.status === 'rejected').length, 1);
  assert.match([a, b].find((x) => x.status === 'rejected').reason.message, /already running/);
  const runId = [a, b].find((x) => x.status === 'fulfilled').value.runId;
  assert.equal((await api.list()).runs.filter((r) => r.status === 'running').length, 1);
  assert.equal((await api.list()).activeRunId, runId);

  // Pause-all keeps the run held; the routine still cannot be started a second time.
  await settle();
  await api.pauseAll();
  release();
  await settle();
  assert.equal((await api.list()).runs[0].status, 'paused');
  await assert.rejects(api.start(id), /already running|paused/);
  assert.equal(h.calls.urls.length, 0);

  // Cancel while paused: the held run stops, keeps its partial result and frees the routine.
  await api.cancel(runId);
  await settle();
  const view = await api.list();
  const done = view.runs.find((r) => r.id === runId);
  assert.equal(done.status, 'cancelled');
  assert.equal(view.activeRunId, null);
  assert.equal(h.calls.urls.length, 0, 'cancelled before the sensitive step');
  assert.equal(h.calls.confirm.length, 0, 'no confirmation is raised for a cancelled routine');
  await assert.rejects(api.cancel(runId), /not active/);

  // The cancelled and persisted run does not lock the routine: after resume it can start again and complete.
  await api.resumeAll();
  const again = harness({stored: h.storage.data, sleep: async () => {}});
  const againApi = createRoutinesApi(again.engine);
  await again.engine.init();
  const next = await againApi.start(id);
  await settle();
  const history = (await againApi.list()).runs; // harness ids restart per engine, so address runs by position
  assert.ok(next.runId);
  assert.deepEqual(history.slice(0, 2).map((r) => r.status), ['succeeded', 'cancelled']);
  assert.equal(again.calls.confirm.length, 1);
});

test('a run in flight when the app closed is interrupted, never auto-resumed, and the routine can start fresh', async () => {
  const h = harness({sleep: (ms, signal) => new Promise((res) => signal.addEventListener('abort', res))});
  await h.engine.init();
  const id = (await h.engine.save({name: 'Hang', steps: [{kind: 'wait', seconds: 30}, urlStep()]})).routines[0].id;
  const run = h.engine.start(id);
  await settle();
  const snapshot = structuredClone(h.storage.data); // what is on disk while the app dies mid-run
  assert.equal(snapshot.runs[0].status, 'running');
  h.engine.dispose();
  await run.done;

  const r = harness({stored: snapshot});
  const view = await r.engine.init();
  assert.equal(view.runs[0].status, 'interrupted');
  assert.equal(view.activeRunId, null);
  assert.equal(r.calls.confirm.length, 0);
  const fresh = await r.engine.run(id);
  assert.equal(fresh.status, 'succeeded');
});

test('contracts.ts type imports from the routines module resolve (RoutinePlan, RoutinesView, UndoOutcome)', async () => {
  const ts = (await import('typescript')).default;
  const file = path.join(root, 'src', 'shared', 'contracts.ts');
  const cfg = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  const program = ts.createProgram({rootNames: [file], options: {...parsed.options, noEmit: true}});
  const messages = ts.getPreEmitDiagnostics(program, program.getSourceFile(file)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(messages.filter((m) => /RoutinePlan|RoutinesView|UndoOutcome|has no exported member/.test(m)), []);
  const exp = ts.createProgram({rootNames: [path.join(root, 'electron', 'services', 'routines.ts')], options: {...parsed.options, noEmit: true}});
  const checker = exp.getTypeChecker();
  const names = checker.getExportsOfModule(checker.getSymbolAtLocation(exp.getSourceFile(path.join(root, 'electron', 'services', 'routines.ts')))).map((s) => s.name);
  for (const n of ['RoutinePlan', 'RoutineStepCandidate', 'RoutinesView', 'UndoOutcome', 'RoutinesApi', 'createRoutinesApi']) assert.ok(names.includes(n), `${n} is exported from routines.ts`);
});

// ---------------------------------------------------------------------------------------------------------------
// Routines.tsx: pure editor helpers and a static render with an injected view (no Electron, no window.jarvis).
const ICONS = ['ArrowCounterClockwise', 'ArrowDown', 'ArrowUp', 'Clock', 'Pause', 'PencilSimple', 'Play', 'Plus', 'Stop', 'Trash', 'Lightning', 'X', 'CircleNotch', 'Info', 'Warning', 'WarningCircle', 'CheckCircle'];
const ui = await build({
  stdin: {resolveDir: root, sourcefile: 'routines-ui-entry.tsx', loader: 'tsx', contents: `export * from './src/components/Routines.tsx'; export {renderToStaticMarkup} from 'react-dom/server'; export {createElement} from 'react';`},
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  // react-dom/server's CommonJS build requires Node built-ins; give the in-memory ESM bundle a real require.
  banner: {js: `import {createRequire as __cr} from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});`},
  plugins: [{name: 'icon-stub', setup(b) {
    b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
    b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n')}));
  }}],
});
const R = await import(`data:text/javascript;base64,${Buffer.from(ui.outputFiles[0].text).toString('base64')}`);

test('editor helpers: draft round-trip, client checks, planner candidates and labels', async () => {
  const d = R.blankDraft();
  assert.deepEqual(R.draftIssues(d), ['Give the routine a name.', 'Step 1: choose the app or file.']);
  d.name = 'Desk';
  d.schedule = 'daily';
  d.days = [];
  d.steps = [{...R.blankStep('action', 'move-window'), target: 'notepad', x: '1', y: '2', width: 'abc', height: '4', undoable: true, cond: 'prev-ok'}];
  const issues = R.draftIssues(d);
  assert.ok(issues.includes('Choose at least one weekday.'));
  assert.ok(issues.includes('Step 1: width must be a whole number.'));
  assert.ok(issues.includes('Step 1 cannot depend on a previous step.'));

  d.days = [5, 1];
  d.steps = [{...R.blankStep('action', 'move-window'), target: 'notepad', x: '1', y: '2', width: '300', height: '4', undoable: true}, {...R.blankStep('wait'), seconds: '7', cond: 'window-absent', condMatch: 'Mail'}, {...R.blankStep('action', 'open-url'), target: 'https://example.com', undoable: true}];
  assert.deepEqual(R.draftIssues(d), []);
  const payload = R.draftToPayload(d);
  assert.deepEqual(payload.schedule, {kind: 'daily', time: '09:00', days: [1, 5]});
  assert.deepEqual(payload.steps[0].request, {type: 'move-window', target: 'notepad', x: 1, y: 2, width: 300, height: 4});
  assert.equal(payload.steps[0].undoable, true);
  assert.deepEqual(payload.steps[1], {condition: {kind: 'window', match: 'Mail', present: false}, kind: 'wait', seconds: 7});
  assert.equal(payload.steps[2].undoable, false, 'only moves are sent as undoable');

  // The payload is accepted by the real engine validator, and a saved routine maps back to the same draft fields.
  const saved = validateRoutine(payload, (() => { let i = 0; return () => `z${++i}`; })(), T0);
  const back = R.routineToDraft({...saved, nextDueAt: null});
  assert.equal(back.name, 'Desk');
  assert.deepEqual(back.days, [1, 5]);
  assert.equal(back.steps[0].width, '300');
  assert.equal(back.steps[1].cond, 'window-absent');
  assert.deepEqual(R.draftToPayload(back).steps.map((s) => s.kind), ['action', 'wait', 'action']);

  const h = harness();
  await h.engine.init();
  const plan = await createRoutinesApi(h.engine).planText('open https://example.com\nwait 3 seconds');
  const steps = R.candidatesToSteps(plan);
  assert.deepEqual(steps.map((s) => [s.kind, s.type, s.target, s.seconds]), [['action', 'open-url', 'https://example.com/', '5'], ['wait', 'launch', '', '3']]);
  assert.deepEqual(R.candidatesToSteps({status: 'blocked', reason: 'x'}), []);
  assert.equal(R.describeSchedule({kind: 'daily', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6]}), 'Daily at 08:00');
  assert.equal(R.describeSchedule({kind: 'interval', minutes: 30}), 'Every 30 min');
  assert.equal(R.statusTone('declined'), 'danger');
  assert.equal(R.statusTone('partial'), 'warn');
});

test('routines screen renders library, partial history with undo, pause state and honest gates', async () => {
  const h = harness({focusResults: [false]});
  await h.engine.init();
  const r = (await h.engine.save({name: 'Morning desk', schedule: {kind: 'interval', minutes: 30}, steps: [moveStep({undoable: true}), focusStep({onFailure: 'continue'})]})).routines[0];
  await h.engine.run(r.id);
  await h.engine.pauseAll();
  const view = h.engine.view();
  const api = createRoutinesApi(h.engine);
  const html = R.renderToStaticMarkup(R.createElement(R.Routines, {api, initialView: view}));
  assert.match(html, /Morning desk/);
  assert.match(html, /Every 30 min/);
  assert.match(html, /partial/);
  assert.match(html, /Undo moves/);
  assert.match(html, /Resume all/);
  assert.match(html, /Times that pass while paused are skipped/);
  for (const g of ROUTINE_GATES) assert.ok(html.includes(g.name));
  assert.equal((html.match(/Unavailable/g) ?? []).length, ROUTINE_GATES.length);
  assert.match(html, /Every desktop step asks for confirmation/);
  const none = R.renderToStaticMarkup(R.createElement(R.Routines, {}));
  assert.match(none, /Routines are not connected/);
  assert.doesNotMatch(none, /New routine/, 'no controls are offered without a backend');
});

test('engine and editor sources stay free of shell, filesystem, network, Electron and input-recording access', async () => {
  const {readFile} = await import('node:fs/promises');
  const engine = await readFile(path.join(root, 'electron/services/routines.ts'), 'utf8');
  const view = await readFile(path.join(root, 'src/components/Routines.tsx'), 'utf8');
  for (const src of [engine, view]) {
    for (const re of [/child_process/, /\bfetch\s*\(/, /node:fs/, /node:net|node:http/, /from 'electron'/, /\beval\s*\(/, /new Function/, /\bspawn\w*\s*\(/, /\bexec(File|Sync)\b/, /openExternal|openPath/, /typeText|\.click\(|SendInput|keydown|GetAsyncKeyState|SetWindowsHookEx/]) assert.doesNotMatch(src, re, String(re));
  }
  assert.deepEqual([...engine.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort(), ['../../src/shared/contracts', './intent']);
  // The editor only takes types from the engine; nothing from electron/ is bundled into the renderer.
  for (const m of view.matchAll(/^import (type )?.*from '([^']+)'/gm)) if (m[2].includes('electron/')) assert.equal(m[1], 'type ', m[0]);
});
