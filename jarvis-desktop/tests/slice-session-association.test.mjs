import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/session-association.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {ASSOCIATION_LIMITS, suggestAssociations, applyAssociation, listCorrections, buildAssociationSessions, toAssociationOp} = mod;

const session = {id:'s-1', kind:'timeline', startedAt:'2026-10-14T10:00:00.000Z', endedAt:'2026-10-14T11:00:00.000Z', title:'Code · parser refactor'};
const ctx = () => ({
  tasks: [
    {id:'t-b', title:'Parser refactor', createdAt:'2026-10-01T09:00:00.000Z'},
    {id:'t-a', title:'Write docs', createdAt:'2026-10-14T10:30:00.000Z'},
    {id:'t-c', title:'Ship release', createdAt:'2026-10-13T09:00:00.000Z', completedAt:'2026-10-14T10:45:00.000Z'},
    {id:'t-far', title:'Unrelated', createdAt:'2026-09-01T09:00:00.000Z'},
  ],
  capsules: [{id:'c-x', name:'Website'}, {id:'c-p', name:'Parser'}],
  checkpoints: [
    {id:'cp1', capsuleId:'c-x', createdAt:'2026-10-14T11:30:00.000Z'},
    {id:'cp2', capsuleId:'c-x', createdAt:'2026-10-14T09:00:00.000Z'},
    {id:'cp-old', capsuleId:'c-p', createdAt:'2026-10-01T09:00:00.000Z'},
  ],
});

test('limits are frozen and bounded', () => {
  assert.ok(Object.isFrozen(ASSOCIATION_LIMITS));
  assert.ok(ASSOCIATION_LIMITS.maxSuggestions >= 1 && ASSOCIATION_LIMITS.maxSuggestions <= 10);
});

test('suggestions rank by time overlap, nearby checkpoints and title words; ties by id; deterministic', () => {
  const got = suggestAssociations(session, ctx());
  assert.deepEqual(got.map((s) => `${s.kind}:${s.id}:${s.score}`), ['capsule:c-x:4', 'task:t-b:4', 'task:t-c:3', 'capsule:c-p:2', 'task:t-a:2']);
  assert.ok(!got.some((s) => s.id === 't-far'));
  assert.ok(got.every((s) => s.reasons.length > 0));
  const reversed = ctx();
  for (const k of Object.keys(reversed)) reversed[k].reverse();
  assert.deepEqual(suggestAssociations(session, reversed), got);
  assert.ok(got.length <= ASSOCIATION_LIMITS.maxSuggestions);
  // Already-linked targets are not suggested again; an invalid window yields nothing.
  assert.ok(!suggestAssociations({...session, taskId:'t-b'}, ctx()).some((s) => s.id === 't-b'));
  assert.deepEqual(suggestAssociations({...session, startedAt:'nope'}, ctx()), []);
});

test('apply then clear round trip is immutable and restores recorded links', () => {
  const sessions = buildAssociationSessions({
    timeline: [{id:'s-1', at:session.startedAt, endedAt:session.endedAt, app:'Code'}],
    focus: [{id:'f-1', startedAt:'2026-10-14T12:00:00.000Z', endedAt:'2026-10-14T12:25:00.000Z', taskId:'t-a', taskTitle:'Write docs'}],
    associations: [],
  });
  const frozen = JSON.stringify(sessions);
  const now = '2026-10-15T08:00:00.000Z';
  const c = ctx();
  const set = applyAssociation(sessions, 'f-1', {taskId:'t-b', capsuleId:'c-p', reason:'manual'}, {tasks:c.tasks, capsules:c.capsules, now});
  assert.notEqual(set, sessions);
  assert.equal(JSON.stringify(sessions), frozen, 'input untouched');
  const f = set.find((s) => s.id === 'f-1');
  assert.equal(f.taskId, 't-b'); assert.equal(f.capsuleId, 'c-p');
  assert.equal(f.correctedBy, 'user'); assert.equal(f.correctedAt, now);
  assert.equal(set.find((s) => s.id === 's-1'), sessions.find((s) => s.id === 's-1'), 'other sessions are shared, not copied');
  assert.deepEqual(toAssociationOp(f), {op:'association.set', sessionId:'f-1', taskId:'t-b', capsuleId:'c-p'});
  // Partial change keeps the other link; null removes one.
  const partial = applyAssociation(set, 'f-1', {taskId:null, reason:'manual'}, {now});
  assert.equal(partial.find((s) => s.id === 'f-1').taskId, undefined);
  assert.equal(partial.find((s) => s.id === 'f-1').capsuleId, 'c-p');
  const cleared = applyAssociation(set, 'f-1', {taskId:null, capsuleId:null, reason:'manual'}, {now});
  const g = cleared.find((s) => s.id === 'f-1');
  assert.equal(g.correctedBy, undefined); assert.equal(g.correctedAt, undefined);
  assert.equal(g.taskId, 't-a', 'recorded link returns');
  assert.deepEqual(toAssociationOp(g), {op:'association.clear', sessionId:'f-1'});
  assert.deepEqual(cleared, sessions);
});

test('persisted associations are read back as user corrections (survives reload)', () => {
  const sessions = buildAssociationSessions({
    timeline: [{id:'s-1', at:session.startedAt, app:'Code', title:'main.ts'}],
    focus: [],
    associations: [{sessionId:'s-1', capsuleId:'c-x', at:'2026-10-15T08:00:00.000Z'}, {sessionId:'gone', taskId:'t-a', at:'2026-10-15T08:00:00.000Z'}],
  });
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0], {id:'s-1', kind:'timeline', startedAt:session.startedAt, title:'Code · main.ts', capsuleId:'c-x', correctedAt:'2026-10-15T08:00:00.000Z', correctedBy:'user'});
  assert.deepEqual(buildAssociationSessions(null), []);
});

test('unknown session, task and capsule ids and bad reasons are rejected descriptively', () => {
  const sessions = [session];
  const c = ctx();
  assert.throws(() => applyAssociation(sessions, 'missing', {taskId:'t-a', reason:'manual'}, c), /Unknown session id: missing/);
  assert.throws(() => applyAssociation(sessions, 's-1', {taskId:'t-zzz', reason:'manual'}, c), /Unknown task id: t-zzz/);
  assert.throws(() => applyAssociation(sessions, 's-1', {capsuleId:'c-zzz', reason:'manual'}, c), /Unknown capsule id: c-zzz/);
  assert.throws(() => applyAssociation(sessions, 's-1', {taskId:'t-a', reason:'auto'}, c), /reason 'manual'/);
  assert.throws(() => applyAssociation(sessions, 's-1', {taskId:'t-a', reason:'manual'}, {...c, now:'bad'}), /ISO/);
  assert.deepEqual(sessions, [session]);
});

test('listCorrections returns user corrections newest first with ties by id', () => {
  const base = [
    {...session, id:'b', correctedAt:'2026-10-15T08:00:00.000Z', correctedBy:'user', taskId:'t-a'},
    {...session, id:'a', correctedAt:'2026-10-15T08:00:00.000Z', correctedBy:'user', capsuleId:'c-x'},
    {...session, id:'z', correctedAt:'2026-10-16T08:00:00.000Z', correctedBy:'user', taskId:'t-b'},
    {...session, id:'plain'},
  ];
  assert.deepEqual(listCorrections(base).map((c) => c.sessionId), ['z', 'a', 'b']);
  assert.deepEqual(listCorrections(base)[1], {sessionId:'a', kind:'timeline', title:session.title, capsuleId:'c-x', correctedAt:'2026-10-15T08:00:00.000Z'});
  assert.deepEqual(listCorrections([]), []);
});

test('MemoryWorkbench mounts the association control and persists through the store', () => {
  const ui = readFileSync(path.join(root, 'src/components/MemoryWorkbench.tsx'), 'utf8');
  const store = readFileSync(path.join(root, 'src/ui/store.tsx'), 'utf8');
  for (const s of ['Associate session', 'corrected by you', 'Suggested associations', '<SessionAssociation session=', 'setSessionAssociation(session.id', "reason: 'manual'", 'htmlFor={taskSelect}', 'htmlFor={projectSelect}', '>Save</Button>', '>Clear</Button>', 'listCorrections(sessions)', 'suggestAssociations(session']) {
    assert.ok(ui.includes(s), `MemoryWorkbench missing ${s}`);
  }
  // Existing sections and accepted panels stay mounted.
  for (const s of ["{section === 'recap' && <><RecapSection /><StandupDraft /></>}", "{section === 'timeline' && <Timeline />}", 'MEMORY_SHORTCUTS']) assert.ok(ui.includes(s), s);
  for (const s of ['setSessionAssociation', 'applyAssociation(buildAssociationSessions(productivity)', 'toAssociationOp(session)', 'applyProductivity(op']) assert.ok(store.includes(s), `store missing ${s}`);
  const src = readFileSync(path.join(root, 'src/ui/session-association.ts'), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|document\.|window\.|require\(/.test(src), 'pure module');
});
