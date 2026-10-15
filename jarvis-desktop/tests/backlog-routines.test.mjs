// Backlog routine tests: persisted schedule status and overdue recovery (injected clock), retry of unfinished steps,
// bounded import/export validation, per-routine pause/resume, and the history/overdue UX. Actions run through the REAL
// ActionService with a mock native adapter and a stub trusted confirmation, so no desktop input ever happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backlog-routines-entry.ts',
    loader: 'ts',
    contents: `export * from './electron/services/routines.ts'; export {ActionService} from './electron/services/actions.ts'; export {DEFAULT_SETTINGS} from './electron/services/validation.ts';`,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {RoutineEngine, ActionService, DEFAULT_SETTINGS, createRoutinesApi, parseRoutineImport, exportRoutine, countSlots, MAX_IMPORT_CHARS, SCHEDULE_GRACE_MS} = mod;

const T0 = new Date(2026, 9, 14, 8, 0, 0, 0).getTime(); // Wednesday 14 Oct 2026, 08:00 local
const HOUR = 60 * 60_000;

function harness({startConfirm, focusResults, stored, safe = () => false, at = T0, sleep} = {}) {
  let now = at;
  let id = 0;
  const calls = {confirm: [], start: [], urls: [], focus: 0, activity: []};
  const wins = [
    {hwnd: 101, title: 'Untitled - Notepad', pid: 11, process: 'notepad.exe', x: 10, y: 20, width: 300, height: 200, minimized: false, maximized: false, foreground: false, elevated: 0},
    {hwnd: 201, title: 'Inbox - Mail', pid: 21, process: 'olk.exe', x: 0, y: 0, width: 800, height: 600, minimized: false, maximized: false, foreground: false, elevated: 0},
  ];
  const focus = [...(focusResults ?? [])];
  const native = {
    listWindows: async () => wins.map((w) => ({...w})),
    focusWindow: async () => { calls.focus++; return {focused: focus.length ? focus.shift() : true}; },
    moveWindow: async (ref, rect) => { const w = wins.find((x) => x.hwnd === ref.hwnd); Object.assign(w, rect); return {...rect, clamped: false}; },
    typeText: async () => { throw new Error('typeText must not be used'); },
    click: async () => { throw new Error('click must never be used'); },
  };
  const actions = new ActionService({
    settings: () => ({...DEFAULT_SETTINGS}), activity: async () => {}, native,
    shell: {openExternal: async (u) => { calls.urls.push(u); }, openPath: async () => '', spawnApp: async () => {}},
    selfPids: () => [1], safeLaunch: safe, now: () => now, newId: () => `p${++id}`,
    confirm: async (summary, detail) => { calls.confirm.push({summary, detail}); return true; },
  });
  const storage = {data: stored ?? null, saves: 0, async load() { return this.data === null ? null : structuredClone(this.data); }, async save(d) { this.saves++; this.data = structuredClone(d); }};
  const engine = new RoutineEngine({
    storage, actions, now: () => now, newId: () => `r${++id}`, windows: async () => native.listWindows(),
    confirm: startConfirm === null ? undefined : async (s, d) => { calls.start.push({s, d}); return (startConfirm ?? (async () => true))(s, d); },
    activity: async (k, s) => { calls.activity.push(s); }, safeLaunch: safe,
    setTimer: () => ({unref() {}}), clearTimer: () => {}, sleep: sleep ?? (async () => {}),
  });
  return {engine, storage, calls, setNow: (t) => { now = t; }, get now() { return now; }};
}

const urlStep = (extra = {}, target = 'https://example.com/docs') => ({kind: 'action', request: {type: 'open-url', target}, ...extra});
const focusStep = (extra = {}) => ({kind: 'action', request: {type: 'focus', target: 'hwnd:201'}, ...extra});
const restart = async (h, opts = {}) => { const n = harness({stored: h.storage.data, at: h.now, ...opts}); await n.engine.init(); return n; };

test('a missed one-time slot stays overdue across restarts, never runs late by itself, and counts as missed', async () => {
  const h = harness();
  await h.engine.init();
  const at = new Date(T0 + HOUR).toISOString();
  const r = (await h.engine.save({name: 'Standup', schedule: {kind: 'once', at}, steps: [urlStep()]})).routines[0];
  assert.equal(r.scheduleStatus.state, 'scheduled');

  // App closed for three hours: the slot is far outside the grace window.
  h.setNow(T0 + 4 * HOUR);
  const closed = await restart(h);
  assert.equal(closed.calls.start.length, 0);
  assert.equal(closed.calls.urls.length, 0, 'nothing ran late by itself');
  let v = closed.engine.view();
  assert.equal(v.runs[0].status, 'missed');
  const ss = v.routines[0].scheduleStatus;
  assert.equal(ss.state, 'overdue');
  assert.equal(ss.overdueSlot, at);
  assert.equal(ss.missedCount, 1);
  assert.equal(ss.lastSlot, at);

  // The overdue mark is persisted: another restart still shows it, and does not double count.
  const again = await restart(closed);
  assert.equal(again.engine.view().routines[0].scheduleStatus.state, 'overdue');
  assert.equal(again.engine.view().routines[0].scheduleStatus.missedCount, 1);
  assert.equal(again.engine.view().runs.filter((x) => x.status === 'missed').length, 1);

  // Recovery: needs the trusted start confirmation, then each step its own confirmation.
  const run = await (await again.engine.recover(r.id)).done;
  assert.equal(again.calls.start.length, 1);
  assert.match(again.calls.start[0].s, /Run overdue routine "Standup" now\?/);
  assert.match(again.calls.start[0].d, /due at/);
  assert.equal(again.calls.confirm.length, 1, 'the step still asked for its own confirmation');
  assert.equal(run.status, 'succeeded');
  assert.equal(run.slot, at);
  assert.equal(run.trigger, 'manual');
  assert.match(run.reason, /Recovery of the run that was due/);
  v = again.engine.view();
  assert.equal(v.routines[0].scheduleStatus.state, 'completed');
  assert.equal(v.routines[0].scheduleStatus.overdueSlot, undefined);
  assert.equal(v.routines[0].scheduleStatus.lastResult, 'succeeded');
  assert.equal(v.routines[0].scheduleStatus.lastRunId, run.id);
  await assert.rejects(() => again.engine.recover(r.id), /Nothing is overdue/);
});

test('recovery needs a trusted approval: declined or missing confirmation starts nothing and keeps the overdue mark', async () => {
  for (const [startConfirm, re] of [[async () => false, /declined in the native confirmation/], [null, /No trusted confirmation/]]) {
    const h = harness({startConfirm});
    await h.engine.init();
    const r = (await h.engine.save({name: 'Late', schedule: {kind: 'once', at: new Date(T0 + HOUR).toISOString()}, steps: [urlStep()]})).routines[0];
    h.setNow(T0 + 5 * HOUR);
    await h.engine.fire();
    assert.equal(h.engine.view().routines[0].scheduleStatus.state, 'overdue');
    await assert.rejects(() => h.engine.recover(r.id), re);
    assert.equal(h.calls.urls.length, 0);
    assert.equal(h.engine.view().routines[0].scheduleStatus.state, 'overdue');
    assert.equal(h.engine.view().runs.filter((x) => x.trigger === 'manual').length, 0);
  }
  const safe = harness({safe: () => true});
  await safe.engine.init();
  const r = (await safe.engine.save({name: 'S', schedule: {kind: 'once', at: new Date(T0 + HOUR).toISOString()}, steps: [urlStep()]})).routines[0];
  safe.setNow(T0 + 5 * HOUR);
  await safe.engine.fire();
  await assert.rejects(() => safe.engine.recover(r.id), /Safe launch/);
  assert.equal(safe.calls.start.length, 0);
});

test('dismissing, editing the schedule or running manually clears the overdue mark', async () => {
  const h = harness();
  await h.engine.init();
  const mk = async (name) => (await h.engine.save({name, schedule: {kind: 'once', at: new Date(T0 + HOUR).toISOString()}, steps: [urlStep()]})).routines.find((x) => x.name === name);
  const a = await mk('A');
  const b = await mk('B');
  const c = await mk('C');
  h.setNow(T0 + 6 * HOUR);
  await h.engine.fire();
  assert.equal(h.engine.view().routines.filter((x) => x.scheduleStatus.state === 'overdue').length, 3);

  const v1 = await h.engine.dismissOverdue(a.id);
  assert.equal(v1.routines.find((x) => x.id === a.id).scheduleStatus.state, 'completed');
  assert.equal(v1.routines.find((x) => x.id === a.id).scheduleStatus.missedCount, 1, 'dismissal keeps the history of what was missed');

  const v2 = await h.engine.save({id: b.id, name: 'B', schedule: {kind: 'interval', minutes: 30}, steps: [urlStep()]});
  assert.equal(v2.routines.find((x) => x.id === b.id).scheduleStatus.state, 'scheduled');

  await h.engine.run(c.id);
  assert.notEqual(h.engine.view().routines.find((x) => x.id === c.id).scheduleStatus.state, 'overdue');
  await assert.rejects(() => h.engine.dismissOverdue('nope'), /Routine not found/);
});

test('interval schedules count every slot missed while closed, with one history record and no catch-up burst', async () => {
  const h = harness();
  await h.engine.init();
  const r = (await h.engine.save({name: 'Poll', schedule: {kind: 'interval', minutes: 30}, steps: [urlStep()]})).routines[0];
  h.setNow(T0 + 3 * HOUR + 10_000); // 6 slots at 30-minute steps, the latest 10 s ago... within grace
  const n = harness({stored: h.storage.data, at: T0 + 3 * HOUR + SCHEDULE_GRACE_MS + 10_000});
  await n.engine.init();
  assert.equal(n.calls.urls.length, 0);
  const ss = n.engine.view().routines[0].scheduleStatus;
  assert.equal(ss.state, 'overdue');
  assert.equal(ss.missedCount, 6);
  assert.equal(n.engine.view().runs.length, 1);
  assert.equal(countSlots(r.schedule, T0, T0 + 3 * HOUR, T0), 6);
  assert.equal(countSlots({kind: 'manual'}, T0, T0 + 3 * HOUR, T0), 0);
  assert.equal(countSlots({kind: 'interval', minutes: 5}, T0, T0 + 1000 * 24 * HOUR, T0), 1000, 'bounded');
});

test('slots that pass while routines are paused are recorded as overdue, not run in a burst', async () => {
  const h = harness();
  await h.engine.init();
  const r = (await h.engine.save({name: 'Hourly', schedule: {kind: 'interval', minutes: 60}, steps: [urlStep()]})).routines[0];
  await h.engine.pauseAll();
  assert.equal(h.engine.view().routines[0].scheduleStatus.state, 'paused');
  h.setNow(T0 + 3 * HOUR + 60_000);
  await h.engine.resumeAll();
  const v = h.engine.view();
  assert.equal(h.calls.start.length, 0);
  assert.equal(h.calls.urls.length, 0);
  assert.equal(v.routines[0].scheduleStatus.state, 'overdue');
  assert.equal(v.routines[0].scheduleStatus.missedCount, 3);
  assert.equal(v.runs[0].status, 'skipped');
  assert.match(v.runs[0].reason, /paused/);
  const run = await (await h.engine.recover(r.id)).done;
  assert.equal(run.status, 'succeeded');
});

test('an overlapping or safe-launch skipped slot is overdue and recoverable', async () => {
  let release;
  const h = harness({sleep: () => new Promise((res) => { release = res; })});
  await h.engine.init();
  const slow = (await h.engine.save({name: 'Slow', schedule: {kind: 'manual'}, steps: [{kind: 'wait', seconds: 5}]})).routines[0];
  const timed = (await h.engine.save({name: 'Timed', schedule: {kind: 'interval', minutes: 5}, steps: [urlStep()]})).routines.find((x) => x.name === 'Timed');
  const started = h.engine.start(slow.id);
  await new Promise((res) => setImmediate(res));
  h.setNow(T0 + 5 * 60_000 + 1000);
  assert.equal(await h.engine.fire(), 0);
  assert.equal(h.engine.view().routines.find((x) => x.id === timed.id).scheduleStatus.state, 'overdue');
  release();
  await started.done;
  assert.equal(h.calls.urls.length, 0);
  const run = await (await h.engine.recover(timed.id)).done;
  assert.equal(run.status, 'succeeded');
  assert.equal(h.calls.urls.length, 1);
});

test('schedule status (last run, result, counters) is persisted and malformed stored status is dropped safely', async () => {
  const h = harness({focusResults: [false]});
  await h.engine.init();
  const r = (await h.engine.save({name: 'Desk', schedule: {kind: 'daily', time: '09:00'}, steps: [focusStep()]})).routines[0];
  const run = await h.engine.run(r.id);
  assert.equal(run.status, 'failed');
  const n = await restart(h);
  const ss = n.engine.view().routines[0].scheduleStatus;
  assert.equal(ss.lastRunId, run.id);
  assert.equal(ss.lastResult, 'failed');
  assert.equal(ss.state, 'scheduled');
  assert.ok(Date.parse(ss.lastRunAt) === T0);

  const bad = structuredClone(h.storage.data);
  bad.status = {[r.id]: {missedCount: 'x', lastResult: 'exploded', overdueSlot: 'not a date', lastRunId: '../evil path', lastRunAt: 5}, ghost: {missedCount: 3}};
  const tolerant = harness({stored: bad});
  await tolerant.engine.init();
  const t = tolerant.engine.view().routines[0].scheduleStatus;
  assert.equal(t.missedCount, 0);
  assert.equal(t.lastResult, undefined);
  assert.equal(t.overdueSlot, undefined);
  assert.equal(t.lastRunId, undefined);
  assert.equal(tolerant.storage.data.status.ghost, undefined);

  // A run that was in flight when the app closed is recorded as interrupted in the status too.
  const mid = structuredClone(h.storage.data);
  mid.runs[0].status = 'running';
  delete mid.runs[0].endedAt;
  const crashed = harness({stored: mid});
  await crashed.engine.init();
  assert.equal(crashed.engine.view().routines[0].scheduleStatus.lastResult, 'interrupted');
});

test('retry repeats only the unfinished steps as a new run with fresh confirmations', async () => {
  const h = harness({focusResults: [false]});
  await h.engine.init();
  const r = (await h.engine.save({name: 'Flow', steps: [urlStep({label: 'Docs'}), focusStep({label: 'Mail'}), urlStep({label: 'Wiki'}, 'https://example.com/wiki')]})).routines[0];
  const first = await h.engine.run(r.id);
  assert.equal(first.status, 'partial');
  assert.deepEqual(first.steps.map((s) => s.status), ['succeeded', 'failed', 'skipped']);
  assert.equal(h.calls.urls.length, 1);
  const before = h.calls.confirm.length;

  const retry = h.engine.retry(first.id);
  const run = await retry.done;
  assert.equal(run.retryOf, first.id);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.steps.map((s) => s.label), ['Mail', 'Wiki']);
  assert.deepEqual(run.steps.map((s) => s.status), ['succeeded', 'succeeded']);
  assert.equal(h.calls.urls.length, 2, 'the step that already succeeded was not repeated');
  assert.equal(h.calls.confirm.length - before, 2, 'each retried step asked for its own confirmation');
  assert.equal(h.engine.view().routines[0].scheduleStatus.lastResult, 'succeeded');
});

test('retry is refused for clean, unfinished or guarded runs and never repeats condition skips', async () => {
  const h = harness({focusResults: [false, true, true, true, false]});
  await h.engine.init();
  const r = (await h.engine.save({name: 'Cond', steps: [focusStep({onFailure: 'continue'}), urlStep({condition: {kind: 'previous', is: 'succeeded'}})]})).routines[0];
  const first = await h.engine.run(r.id);
  assert.deepEqual(first.steps.map((s) => s.status), ['failed', 'skipped']);
  assert.match(first.steps[1].reason, /Condition not met/);
  const ok = await h.engine.run(r.id);
  assert.equal(ok.status, 'succeeded');
  assert.throws(() => h.engine.retry(ok.id), /did not finish cleanly/);
  assert.throws(() => h.engine.retry('missing'), /Run not found/);

  // Only the failed step is retried; the condition-skipped one is left alone, and the retry sees "previous" correctly.
  const retried = await h.engine.retry(first.id).done;
  assert.deepEqual(retried.steps.map((s) => s.label.length > 0), [true]);
  assert.equal(retried.steps.length, 1);

  const clean = await h.engine.run(r.id);
  assert.throws(() => h.engine.retry(clean.id), /did not finish cleanly/);

  // Deleted routine, active run and safe launch guards.
  const gone = (await h.engine.save({name: 'Gone', steps: [focusStep()]})).routines.find((x) => x.name === 'Gone');
  const failed = await h.engine.run(gone.id);
  await h.engine.remove(gone.id);
  assert.throws(() => h.engine.retry(failed.id), /deleted/);
  const view = harness({focusResults: [false], safe: () => true});
  await view.engine.init();
  const s = (await view.engine.save({name: 'Safe', steps: [focusStep()]})).routines[0];
  assert.throws(() => view.engine.start(s.id), /Safe launch/);
});

test('retry honours the duplicate guard and a pause, and a cancelled run can be retried', async () => {
  let release;
  const h = harness({sleep: () => new Promise((res) => { release = res; })});
  await h.engine.init();
  const r = (await h.engine.save({name: 'W', steps: [{kind: 'wait', seconds: 5}, urlStep()]})).routines[0];
  const s = h.engine.start(r.id);
  await new Promise((res) => setImmediate(res));
  assert.throws(() => h.engine.retry(h.engine.view().runs[0].id), /Wait for that run to finish/);
  await h.engine.cancel(s.runId);
  release();
  const cancelled = await s.done;
  assert.equal(cancelled.status, 'cancelled');
  await h.engine.pauseAll();
  assert.throws(() => h.engine.retry(cancelled.id), /paused/);
  await h.engine.resumeAll();
  const wait = h.engine.retry(cancelled.id);
  await new Promise((res) => setImmediate(res));
  assert.throws(() => h.engine.retry(cancelled.id), /already running/);
  release();
  const run = await wait.done;
  assert.equal(run.status, 'succeeded');
  assert.equal(run.steps.length, 2);
  assert.equal(h.calls.urls.length, 1);
});

test('exported routines round-trip through the import validator as disabled, schedule-free drafts with fresh ids', async () => {
  const h = harness();
  await h.engine.init();
  const r = (await h.engine.save({name: 'Round trip', schedule: {kind: 'daily', time: '07:30', days: [1, 3]}, steps: [urlStep({label: 'Open docs'}), {kind: 'wait', seconds: 3}, focusStep({retries: 2, condition: {kind: 'weekday', days: [1]}})]})).routines[0];
  const text = exportRoutine(r);
  const file = JSON.parse(text);
  assert.equal(file.format, 'desktop-companion-routine');
  assert.equal(file.routine.id, undefined);
  assert.equal(file.routine.createdAt, undefined);
  assert.ok(file.routine.steps.every((s) => s.id === undefined));
  assert.equal(await createRoutinesApi(h.engine).exportRoutine(r.id), text);

  let n = 0;
  const res = parseRoutineImport(text, () => `n${++n}`);
  assert.equal(res.status, 'ready');
  assert.equal(res.routine.name, 'Round trip');
  assert.equal(res.routine.enabled, false);
  assert.deepEqual(res.routine.schedule, {kind: 'manual'});
  assert.deepEqual(res.routine.steps.map((s) => s.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(res.routine.steps[2].condition, {kind: 'weekday', days: [1]});
  assert.ok(res.warnings.some((w) => /opens https:\/\/example\.com\/docs/.test(w)));
  assert.ok(res.warnings.some((w) => /schedule was not imported/.test(w)));
  assert.ok(res.warnings.some((w) => /saved disabled/.test(w)));

  // The draft saves through the normal validator and stays disabled.
  const api = createRoutinesApi(h.engine);
  const prev = await api.importPreview(text);
  const saved = (await api.save(prev.routine)).routines.find((x) => x.name === 'Round trip' && !x.enabled);
  assert.ok(saved);
  assert.equal(saved.scheduleStatus.state, 'manual');
  assert.equal(saved.steps.length, 3);
});

test('import validation bounds size, steps, fields, URLs and action types', () => {
  const ids = () => { let i = 0; return () => `i${++i}`; };
  const wrap = (routine, extra = {}) => JSON.stringify({format: 'desktop-companion-routine', version: 1, routine, ...extra});
  const step = (request, extra = {}) => ({kind: 'action', request, ...extra});
  const blockedWith = (text, re) => { const r = parseRoutineImport(text, ids()); assert.equal(r.status, 'blocked', String(text).slice(0, 120)); assert.match(r.reason, re); };
  const okUrl = step({type: 'open-url', target: 'https://example.com/a'});

  assert.equal(parseRoutineImport(wrap({name: 'ok', schedule: {kind: 'manual'}, steps: [okUrl]}), ids()).status, 'ready');
  blockedWith(undefined, /Paste/);
  blockedWith('   ', /Paste/);
  blockedWith('x'.repeat(MAX_IMPORT_CHARS + 1), /too large/);
  blockedWith('{not json', /not valid JSON/);
  blockedWith('[]', /must be an object/);
  blockedWith(JSON.stringify({format: 'other', version: 1, routine: {}}), /not a routine file/);
  blockedWith(JSON.stringify({format: 'desktop-companion-routine', version: 2, routine: {}}), /Unsupported/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [okUrl]}, {extra: 1}), /field "extra" is not allowed/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [okUrl], id: 'abc'}), /field "id" is not allowed/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [okUrl], enabled: true}), /field "enabled" is not allowed/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: []}), /at least one step/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: Array.from({length: 21}, () => okUrl)}), /at most 20 steps/);
  blockedWith(wrap({name: '', schedule: {kind: 'manual'}, steps: [okUrl]}), /Name is required/);
  blockedWith(wrap({name: 'a\u0007b', schedule: {kind: 'manual'}, steps: [okUrl]}), /control characters/);
  blockedWith(wrap({name: 'x'.repeat(81), schedule: {kind: 'manual'}, steps: [okUrl]}), /too long/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'interval', minutes: 1}, steps: [okUrl]}), /minutes/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'cron', expr: '* * * * *'}, steps: [okUrl]}), /schedule\.kind/);
  // URLs and action types.
  for (const target of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'data:text/html,x', 'ftp://example.com/x', 'https://user:pw@example.com/', 'https://exa mple.com']) {
    blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [step({type: 'open-url', target})]}), /Step 1/);
  }
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [step({type: 'click', x: 1, y: 1})]}), /Clicking is not available/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [step({type: 'shell', target: 'cmd /c calc'})]}), /Unsupported action type|Step 1/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{kind: 'record', events: []}]}), /recording steps are not available/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{kind: 'drag'}]}), /semantic drag/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [step({type: 'open-url', target: 'https://example.com', command: 'calc'})]}), /Unknown action field|Step 1/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{...okUrl, script: 'calc'}]}), /field "script" is not allowed/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{kind: 'wait', seconds: 301}]}), /seconds/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{...okUrl, retries: 9}]}), /retries/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{...okUrl, condition: {kind: 'previous', is: 'succeeded'}}]}), /Step 1 cannot depend/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{...okUrl, undoable: true}]}), /only window moves can be undone/);
  blockedWith(wrap({name: 'x', schedule: {kind: 'manual'}, steps: ['open https://example.com']}), /must be an object/);
  // A step id inside the file is ignored and replaced.
  const withId = parseRoutineImport(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [{...okUrl, id: '../../evil'}]}), ids());
  assert.equal(withId.status, 'ready');
  assert.equal(withId.routine.steps[0].id, 'i1');
  // Risky step kinds are called out before the user saves.
  const risky = parseRoutineImport(wrap({name: 'x', schedule: {kind: 'manual'}, steps: [step({type: 'type-text', target: 'Notepad', text: 'hello'}), step({type: 'launch', target: 'notepad.exe'})]}), ids());
  assert.equal(risky.status, 'ready');
  assert.ok(risky.warnings.some((w) => /types text into the window "Notepad"/.test(w)));
  assert.ok(risky.warnings.some((w) => /launches notepad\.exe \(only apps you approved/.test(w)));
  assert.ok(!JSON.stringify(risky.warnings).includes('hello'), 'typed text is not echoed into warnings');
});

// ---------------------------------------------------------------------------------------------------------------
// UI
const ICONS = ['ArrowCounterClockwise', 'ArrowDown', 'ArrowUp', 'Clock', 'Pause', 'PencilSimple', 'Play', 'Plus', 'Stop', 'Trash', 'Lightning', 'X', 'CircleNotch', 'Info', 'Warning', 'WarningCircle', 'CheckCircle'];
const ui = await build({
  stdin: {resolveDir: root, sourcefile: 'backlog-routines-ui.tsx', loader: 'tsx', contents: `export * from './src/components/Routines.tsx'; export {renderToStaticMarkup} from 'react-dom/server'; export {createElement} from 'react';`},
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  banner: {js: `import {createRequire as __cr} from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});`},
  plugins: [{name: 'icon-stub', setup(b) {
    b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
    b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n')}));
  }}],
});
const R = await import(`data:text/javascript;base64,${Buffer.from(ui.outputFiles[0].text).toString('base64')}`);

test('editing keeps weekday/time conditions, and pausing one schedule is a lossless save that does not run past slots', async () => {
  const h = harness();
  await h.engine.init();
  const cond = {kind: 'time', start: '08:00', end: '17:00'};
  const r = (await h.engine.save({name: 'Work hours', schedule: {kind: 'interval', minutes: 30}, steps: [urlStep({condition: cond}), urlStep({condition: {kind: 'weekday', days: [1, 2]}}, 'https://example.com/b')]})).routines[0];
  const draft = R.routineToDraft(r);
  assert.equal(draft.steps[0].cond, 'kept');
  assert.deepEqual(R.draftToPayload(draft).steps[0].condition, cond);
  assert.deepEqual(R.draftToPayload(draft).steps[1].condition, {kind: 'weekday', days: [1, 2]});
  assert.equal(R.describeCondition(cond), 'Only between 08:00 and 17:00');
  assert.equal(R.describeCondition({kind: 'weekday', days: [1, 2]}), 'Only on Mon, Tue');
  draft.steps[0].cond = 'none';
  assert.equal(R.draftToPayload(draft).steps[0].condition, undefined, 'choosing Always removes the kept condition');

  // Pause the schedule (save with enabled=false), time passes, resume: past slots are not run.
  const paused = await h.engine.save(R.routinePayload(r, false));
  assert.equal(paused.routines[0].enabled, false);
  assert.equal(paused.routines[0].scheduleStatus.state, 'disabled');
  assert.deepEqual(paused.routines[0].steps.map((s) => s.condition), [cond, {kind: 'weekday', days: [1, 2]}]);
  h.setNow(T0 + 5 * HOUR);
  assert.equal(await h.engine.fire(), 0);
  const resumed = await h.engine.save(R.routinePayload(paused.routines[0], true));
  assert.equal(resumed.routines[0].scheduleStatus.state, 'scheduled');
  assert.ok(Date.parse(resumed.routines[0].nextDueAt) > h.now);
  assert.equal(await h.engine.fire(), 0);
  assert.equal(h.calls.urls.length, 0);
});

test('history helpers filter, time and label runs', () => {
  const runs = [
    {id: '1', status: 'succeeded', trigger: 'manual', routineId: 'a', routineName: 'A', startedAt: '2026-10-14T08:00:00.000Z', endedAt: '2026-10-14T08:00:42.000Z', steps: []},
    {id: '2', status: 'partial', trigger: 'manual', routineId: 'a', routineName: 'A', startedAt: '2026-10-14T08:00:00.000Z', steps: []},
    {id: '3', status: 'missed', trigger: 'schedule', routineId: 'a', routineName: 'A', startedAt: '', steps: []},
    {id: '4', status: 'succeeded', trigger: 'manual', slot: '2026-10-14T07:00:00.000Z', routineId: 'a', routineName: 'A', startedAt: '', steps: []},
  ];
  assert.deepEqual(R.filterRuns(runs, 'all').map((r) => r.id), ['1', '2', '3', '4']);
  assert.deepEqual(R.filterRuns(runs, 'problems').map((r) => r.id), ['2', '3']);
  assert.deepEqual(R.filterRuns(runs, 'scheduled').map((r) => r.id), ['3', '4']);
  assert.equal(R.durationText('2026-10-14T08:00:00.000Z', '2026-10-14T08:00:42.000Z'), '42 s');
  assert.equal(R.durationText('2026-10-14T08:00:00.000Z', '2026-10-14T08:02:05.000Z'), '2 min 5 s');
  assert.equal(R.durationText('2026-10-14T08:00:00.000Z', undefined), '');
  assert.equal(R.durationText('x', 'y'), '');
  assert.equal(R.scheduleTone('overdue'), 'warn');
  assert.equal(R.SCHEDULE_STATE_LABEL.completed, 'Done');
});

test('the screen shows overdue recovery, retry, schedule pause, history filters and the import box only when the API supports them', async () => {
  const h = harness({focusResults: [false]});
  await h.engine.init();
  const flow = (await h.engine.save({name: 'Mail flow', steps: [urlStep(), focusStep({label: 'Focus mail'})]})).routines[0];
  await h.engine.run(flow.id);
  const timed = (await h.engine.save({name: 'Standup', schedule: {kind: 'once', at: new Date(T0 + HOUR).toISOString()}, steps: [urlStep()]})).routines.find((x) => x.name === 'Standup');
  h.setNow(T0 + 4 * HOUR);
  await h.engine.fire();
  const view = h.engine.view();
  assert.equal(view.routines.find((x) => x.id === timed.id).scheduleStatus.state, 'overdue');

  const api = createRoutinesApi(h.engine);
  const html = R.renderToStaticMarkup(R.createElement(R.Routines, {api, initialView: view}));
  assert.match(html, /“Standup” is overdue/);
  assert.match(html, /never run late on its own/);
  assert.match(html, /Run now…/);
  assert.match(html, /Dismiss/);
  assert.match(html, /Overdue/);
  assert.match(html, /1 missed/);
  assert.match(html, /Pause schedule/);
  assert.match(html, /Retry unfinished steps/);
  assert.match(html, /Needs attention/);
  assert.match(html, /1\/2 steps/);
  assert.match(html, /Export/);
  assert.match(html, /last run/);

  // An older bridge without the new methods still renders the original controls, without dead buttons.
  const {retry, recover, dismissOverdue, exportRoutine, importPreview, ...legacy} = api;
  const old = R.renderToStaticMarkup(R.createElement(R.Routines, {api: legacy, initialView: view}));
  assert.match(old, /Mail flow/);
  assert.match(old, /Undo moves|partial/);
  for (const re of [/Retry unfinished steps/, /Run now…/, />Dismiss</, />Export</]) assert.doesNotMatch(old, re);
  assert.match(old, /overdue/i, 'the overdue state is still shown');
});

test('the engine and editor sources keep the new features free of shell, filesystem, network, Electron and input access', async () => {
  const {readFile} = await import('node:fs/promises');
  for (const f of ['electron/services/routines.ts', 'src/components/Routines.tsx']) {
    const src = await readFile(path.join(root, f), 'utf8');
    for (const re of [/child_process/, /\bfetch\s*\(/, /node:fs/, /\beval\s*\(/, /new Function/, /\bspawn\w*\s*\(/, /\bexec(File|Sync)\b/, /openExternal|openPath/, /typeText|SendInput|keydown|GetAsyncKeyState|SetWindowsHookEx/, /Date\.now\s*\(/, /new Date\(\)/]) assert.doesNotMatch(src, re, `${f}: ${re}`);
  }
});
