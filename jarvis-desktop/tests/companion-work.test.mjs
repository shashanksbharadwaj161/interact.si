// Companion saved work and routines: save_note and complete_task ask the trusted confirmation, read back before a
// verified receipt, never repeat an identical change within one request, and stop cleanly; undo re-reads first and
// refuses when the person changed the item; routines are listed, dry-run (every preview discarded, nothing runs) and run
// manually with Stop cancelling the run. Scripted Claude turns and a fake desktop only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root, sourcefile: 'companion-work-entry.ts', loader: 'ts',
    contents: `
      export { createBackend } from './electron/backend.ts';
      export { createWorkTools, undoWork, OncePerRequest } from './electron/services/agent-work.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

/* ---------- Tools against a fake store ---------- */

function store(init = {}) {
  let state = {notes: [], tasks: [], capsules: [], ...init};
  let n = 0;
  const calls = {saveNote: 0, setDone: [], deleteNote: 0};
  return {
    calls,
    snapshot: () => state,
    set: (s) => { state = {...state, ...s}; },
    saveNote: async (v) => { calls.saveNote++; state = {...state, notes: [...state.notes, {id: `n${++n}`, title: v.title, body: v.body, tags: v.tags, updatedAt: `2026-10-21T00:00:0${n}Z`}]}; return state; },
    setTaskDone: async (id, done) => { calls.setDone.push([id, done]); state = {...state, tasks: state.tasks.map((t) => (t.id === id ? {...t, done} : t))}; return state; },
    deleteNote: async (id) => { calls.deleteNote++; state = {...state, notes: state.notes.filter((x) => x.id !== id)}; return state; },
  };
}
const ctx = (signal = new AbortController().signal) => { const phases = []; return {phases, signal, setPhase: (p, s, st) => phases.push([p, st ?? null])}; };
const tool = (tools, name) => tools.find((t) => t.def.name === name);

test('save_note: exact text in the confirmation, saved only after Continue, read back, verified, undo offered', async () => {
  const s = store();
  const confirms = [];
  const tools = m.createWorkTools({...s, confirm: async (a, b) => { confirms.push([a, b]); return true; }});
  const t = tool(tools, 'save_note');
  const v = t.validate({title: 'Invoice numbers', body: 'INV-1\nINV-2', tags: ['work', 'work']});
  assert.deepEqual(v.value, {title: 'Invoice numbers', body: 'INV-1\nINV-2', tags: ['work']});
  const c = ctx();
  const r = await t.run(v.value, c);
  assert.equal(r.phase, 'done');
  assert.equal(r.verified, true);
  assert.deepEqual(confirms, [['Save the note “Invoice numbers”?', 'Title: Invoice numbers\nTags: work\n\nINV-1\nINV-2']]);
  assert.deepEqual(c.phases, [['awaiting-confirm', null], ['running', null], ['running', 'verifying']]);
  assert.deepEqual(r.undo, {kind: 'note', id: 'note:n1', label: 'Delete “Invoice numbers”', target: 'n1', stamp: '2026-10-21T00:00:01Z'});
  for (const bad of [{title: 'a\nb', body: ''}, {title: '', body: 'x'}, {title: 'x', body: 'bell\u0007'}, {title: 'x', body: '', tags: ['a', 'b', 'c', 'd', 'e', 'f']}, {title: 'x', body: '', id: 'n1'}]) assert.equal(t.validate(bad).ok, false, JSON.stringify(bad));
});

test('one request never saves the same note twice; Cancel or Stop saves nothing', async () => {
  const s = store();
  let asked = 0;
  const tools = m.createWorkTools({...s, confirm: async () => { asked++; return true; }});
  const t = tool(tools, 'save_note');
  await t.run({title: 'A', body: 'b', tags: []}, ctx());
  const again = await t.run({title: 'A', body: 'b', tags: []}, ctx());
  assert.equal(s.calls.saveNote, 1);
  assert.equal(asked, 1);
  assert.match(again.summary, /already handled; not repeated/);
  assert.equal(again.undo, undefined, 'the repeat offers no second undo');
  const s2 = store();
  const cancelled = await tool(m.createWorkTools({...s2, confirm: async () => false}), 'save_note').run({title: 'A', body: '', tags: []}, ctx());
  assert.equal(cancelled.phase, 'declined');
  const ctl = new AbortController();
  const stopped = await tool(m.createWorkTools({...s2, confirm: async () => { ctl.abort(); return true; }}), 'save_note').run({title: 'A', body: '', tags: []}, ctx(ctl.signal));
  assert.match(stopped.summary, /Stopped/);
  assert.equal(s2.calls.saveNote, 0);
  assert.equal(await tool(m.createWorkTools({...s2, confirm: async () => { throw new Error('no window'); }}), 'save_note').run({title: 'A', body: '', tags: []}, ctx()).then((x) => x.phase), 'declined');
});

test('a save that does not show up in the read-back is reported as not saved', async () => {
  const s = store();
  const r = await tool(m.createWorkTools({...s, saveNote: async () => s.snapshot(), confirm: async () => true}), 'save_note').run({title: 'A', body: '', tags: []}, ctx());
  assert.equal(r.phase, 'failed');
  assert.equal(r.verified, false);
});

test('complete_task: confirmation, re-read after the dialog, verified, reopen as undo; already done or changed is honest', async () => {
  const s = store({tasks: [{id: 't1', title: 'Pay rent', done: false, due: '2026-10-25', createdAt: 'x'}, {id: 't2', title: 'Done one', done: true, createdAt: 'x'}]});
  const confirms = [];
  const tools = m.createWorkTools({...s, confirm: async (a, b) => { confirms.push([a, b]); return true; }});
  const t = tool(tools, 'complete_task');
  const r = await t.run({id: 't1'}, ctx());
  assert.equal(r.verified, true);
  assert.deepEqual(confirms[0], ['Mark “Pay rent” as done?', 'Task: Pay rent\nDue: 2026-10-25\n\nIt stays in your list as done.']);
  assert.deepEqual(r.undo, {kind: 'task-done', id: 'done:t1', label: 'Reopen “Pay rent”', target: 't1'});
  assert.match((await t.run({id: 't2'}, ctx())).summary, /already done; nothing changed/);
  assert.equal(confirms.length, 1, 'no confirmation for a task that is already done');
  const s2 = store({tasks: [{id: 't1', title: 'Pay rent', done: false, createdAt: 'x'}]});
  const changed = await tool(m.createWorkTools({...s2, confirm: async () => { s2.set({tasks: [{id: 't1', title: 'Pay rent and water', done: false, createdAt: 'x'}]}); return true; }}), 'complete_task').run({id: 't1'}, ctx());
  assert.match(changed.summary, /changed meanwhile/);
  assert.deepEqual(s2.calls.setDone, []);
  assert.equal(t.validate({id: '../x'}).ok, false);
});

test('undo re-reads first: a note edited since is not deleted; a reopened task is not reopened again', async () => {
  const s = store({notes: [{id: 'n1', title: 'A', body: '', tags: [], updatedAt: 'v1'}], tasks: [{id: 't1', title: 'T', done: false, createdAt: 'x'}]});
  assert.equal(await m.undoWork({kind: 'note', target: 'n1', stamp: 'v0'}, s), false);
  assert.equal(s.calls.deleteNote, 0);
  assert.equal(await m.undoWork({kind: 'note', target: 'n1', stamp: 'v1'}, s), true);
  assert.equal(await m.undoWork({kind: 'task-done', target: 't1'}, s), false, 'not done any more: nothing to reopen');
  assert.equal(await m.undoWork({kind: 'task-done', target: '../t'}, s), false);
});

test('routines: list is read-only, dry run reports blocked steps, run needs the confirmation and Stop cancels it', async () => {
  const s = store();
  const runs = [];
  let confirmed = 0;
  const routines = {
    list: () => [{id: 'r1', name: 'Morning', enabled: true, steps: 2, schedule: 'manual only', lastResult: null, lastRunAt: null, overdue: false}],
    describe: (id) => (id === 'r1' ? 'Routine: Morning\n1. Open mail\n2. Wait 5 s' : null),
    dryRun: async () => ({ok: true, name: 'Morning', steps: [{label: 'Open mail', allowed: false, detail: 'Window not found'}, {label: 'Wait 5 s', allowed: true, detail: 'A pause'}], note: 'nothing ran'}),
    run: async (id, signal) => { runs.push(id); await new Promise((r) => setTimeout(r, 5)); return signal.aborted ? {status: 'cancelled', steps: [{label: 'Open mail', status: 'cancelled'}]} : {status: 'succeeded', steps: [{label: 'Open mail', status: 'succeeded'}, {label: 'Wait 5 s', status: 'succeeded'}]}; },
  };
  const tools = m.createWorkTools({...s, confirm: async (a, b) => { confirmed++; assert.match(b, /1\. Open mail/); return true; }, routines});
  assert.match((await tool(tools, 'list_routines').run({}, ctx())).content, /only while the app is open/);
  const dry = await tool(tools, 'preview_routine').run({id: 'r1'}, ctx());
  assert.match(dry.summary, /1 would be blocked\. Nothing ran/);
  assert.equal(runs.length, 0);
  const ok = await tool(tools, 'run_routine').run({id: 'r1'}, ctx());
  assert.equal(ok.phase, 'done');
  assert.equal(ok.verified, false, 'routine results are what steps reported, not independently checked');
  assert.match(ok.summary, /Routine succeeded: 2 succeeded/);
  assert.equal(confirmed, 1);
  const ctl = new AbortController();
  const tools2 = m.createWorkTools({...s, confirm: async () => true, routines});
  const p = tool(tools2, 'run_routine').run({id: 'r1'}, ctx(ctl.signal));
  ctl.abort();
  assert.match((await p).summary, /Stopped|cancelled/);
  assert.match((await tool(tools, 'run_routine').run({id: 'nope'}, ctx())).summary, /does not exist/);
});

/* ---------- Backend: real store, real routine engine ---------- */

const KEY = 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz';
const fakeSafeStorage = {isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(`enc:${p}`), decryptString: (b) => b.toString().slice(4)};
const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
function sse(content, stop) {
  let o = ev('message_start', {message: {id: 'm', type: 'message', role: 'assistant', content: [], usage: {input_tokens: 5, output_tokens: 0}}});
  content.forEach((b, index) => {
    if (b.type === 'text') o += ev('content_block_start', {index, content_block: {type: 'text', text: ''}}) + ev('content_block_delta', {index, delta: {type: 'text_delta', text: b.text}});
    else o += ev('content_block_start', {index, content_block: {type: 'tool_use', id: b.id, name: b.name, input: {}}}) + ev('content_block_delta', {index, delta: {type: 'input_json_delta', partial_json: JSON.stringify(b.input)}});
    o += ev('content_block_stop', {index});
  });
  return new Response(o + ev('message_delta', {delta: {stop_reason: stop}, usage: {output_tokens: 3}}) + ev('message_stop'), {status: 200});
}
const WIN = {hwnd: 12, pid: 23, title: 'Notes', process: 'notepad.exe', x: 0, y: 0, width: 400, height: 300, minimized: false, maximized: false, foreground: true, elevated: 0};

async function backend(turns) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-work-'));
  const log = {typed: [], bodies: [], hubConfirms: 0};
  let setup = true;
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999], safeStorage: fakeSafeStorage, companionRetryMs: 0,
    native: {listWindows: async () => [WIN], focusWindow: async () => ({focused: true}), typeText: async (...a) => { log.typed.push(a); return {typed: 1}; }, dpapi: async () => ({ok: true}), speechVoices: async () => []},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async () => { if (!setup) log.hubConfirms++; return true; },
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); log.bodies.push(body); return turns(log.bodies.length, body); },
  });
  await b.setProviderKey('anthropic', KEY);
  await b.saveSettings({mode: 'online'});
  setup = false;
  return {b, log, close: async () => { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}
const lastResult = (body) => JSON.parse(body.messages.at(-1).content[0].content);

test('backend: a note saved by the companion is in the real store, and its undo deletes exactly that note', async () => {
  const f = await backend((n) => n === 1
    ? sse([{type: 'tool_use', id: 'toolu_1', name: 'save_note', input: {title: 'Wi-Fi', body: 'guest / sunflower'}}, {type: 'tool_use', id: 'toolu_2', name: 'save_note', input: {title: 'Wi-Fi', body: 'guest / sunflower'}}], 'tool_use')
    : sse([{type: 'text', text: 'Saved.'}], 'end_turn'));
  try {
    const events = [];
    let asked = 0;
    await f.b.companion.run({text: 'save the wifi password'}, {emit: (e) => events.push(e), confirm: async () => { asked++; return true; }, signal: new AbortController().signal});
    const notes = (await f.b.getState()).notes.filter((x) => x.title === 'Wi-Fi');
    assert.equal(notes.length, 1, 'two identical calls in one request save once');
    assert.equal(asked, 1);
    const done = events.find((e) => e.type === 'tool' && e.tool === 'save_note' && e.phase === 'done' && e.undo);
    assert.equal(done.verified, true);
    assert.equal(await f.b.companion.undo(done.undo), true);
    assert.equal((await f.b.getState()).notes.some((x) => x.title === 'Wi-Fi'), false);
    assert.equal(await f.b.companion.undo(done.undo), false, 'undo cannot run twice');
  } finally { await f.close(); }
});

test('backend: routines are listed, dry-run without running or confirming anything, then run with the start and step confirmations', async () => {
  let routineId;
  const f = await backend((n, body) => {
    if (n === 1) return sse([{type: 'tool_use', id: 'toolu_1', name: 'list_routines', input: {}}], 'tool_use');
    if (n === 2) { routineId = lastResult(body).routines[0].id; return sse([{type: 'tool_use', id: 'toolu_2', name: 'preview_routine', input: {id: routineId}}], 'tool_use'); }
    if (n === 3) return sse([{type: 'tool_use', id: 'toolu_3', name: 'run_routine', input: {id: routineId}}], 'tool_use');
    return sse([{type: 'text', text: 'It ran.'}], 'end_turn');
  });
  try {
    await f.b.routinesSave({name: 'Say hi', steps: [{kind: 'action', request: {type: 'type-text', target: 'hwnd:12', text: 'hi there'}}]});
    const islandConfirms = [];
    const events = [];
    await f.b.companion.run({text: 'run my say hi routine'}, {emit: (e) => events.push(e), confirm: async (a, b) => { islandConfirms.push([a, b]); return true; }, signal: new AbortController().signal});
    const dry = lastResult(f.log.bodies[2]);
    assert.equal(dry.nothingRan, true);
    assert.equal(dry.steps[0].allowed, true);
    assert.match(dry.steps[0].detail, /asks before running/);
    assert.deepEqual(islandConfirms.map((c) => c[0]), ['Start this routine now?']);
    assert.match(islandConfirms[0][1], /hi there|Say hi/);
    assert.equal(f.log.hubConfirms, 1, 'the desktop step still raised its own confirmation');
    assert.equal(f.log.typed.length, 1);
    const run = events.find((e) => e.type === 'tool' && e.tool === 'run_routine' && e.phase === 'done');
    assert.match(run.summary, /Routine succeeded: 1 succeeded/);
    assert.equal(run.verified, false);
    const list = (await f.b.routinesList()).runs;
    assert.equal(list[0].status, 'succeeded');
  } finally { await f.close(); }
});
