import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/worklog-draft.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const {buildWorklogDraft} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const since = '2026-10-14T00:00:00.000Z', until = '2026-10-15T00:00:00.000Z', now = '2026-10-15T00:00:00.000Z';
const opts = (extra = {}) => ({since, until, now, format:'standup', ...extra});
function snapshot() {
  return {
    checkpoints: [
      {id:'cp-at-since', title:'Boundary start', note:'', createdAt:since, refs:[]},
      {id:'cp-at-until', title:'Boundary end', note:'', createdAt:until, refs:[]},
      {id:'cp-before', title:'Yesterday', note:'', createdAt:'2026-10-13T23:59:59.999Z', refs:[]},
      {id:'cp-proj', title:'Shipped parser', note:'', createdAt:'2026-10-14T10:00:00.000Z', capsuleId:'proj-a', refs:[{kind:'capsule',id:'proj-a'},{kind:'task',id:'t-open'},{kind:'note',id:'n-1'}]},
    ],
    tasks: [
      {id:'t-done', title:'Write tests', done:true, createdAt:'2026-10-14T09:00:00.000Z'},
      {id:'t-open', title:'Review PR\nnow', done:false, createdAt:'2026-10-14T11:00:00.000Z'},
      {id:'t-old', title:'Old task', done:true, createdAt:'2026-10-01T09:00:00.000Z'},
    ],
    notes: [
      {id:'n-1', title:'Design notes', body:'secret body', tags:[], updatedAt:'2026-10-14T12:00:00.000Z'},
      {id:'n-out', title:'Later', body:'', tags:[], updatedAt:'2026-10-15T00:00:00.001Z'},
    ],
    focusSessions: [
      {id:'f-1', startedAt:'2026-10-14T13:00:00.000Z', endedAt:'2026-10-14T13:25:00.000Z', plannedSec:1500, actualSec:1500, outcome:'completed', taskId:'t-done', taskTitle:'Write tests', capsuleId:'proj-b'},
      {id:'f-2', startedAt:'2026-10-14T14:00:00.000Z', endedAt:'2026-10-14T14:10:00.000Z', plannedSec:1500, actualSec:600, outcome:'stopped', capsuleId:'proj-a'},
    ],
  };
}
const ids = (d) => d.evidence.map((e) => `${e.kind}:${e.id}`);

test('window filter is half-open: since included, until and outside excluded', () => {
  const d = buildWorklogDraft(snapshot(), opts());
  const got = ids(d);
  assert.ok(got.includes('checkpoint:cp-at-since'));
  for (const out of ['checkpoint:cp-at-until','checkpoint:cp-before','task:t-old','note:n-out']) assert.ok(!got.includes(out), out);
  assert.equal(d.empty, false);
});

test('groups into Done, In progress, Blocked/Open using task done and focus outcome', () => {
  const d = buildWorklogDraft(snapshot(), opts());
  assert.deepEqual(d.sections.map((s) => s.title), ['Done','In progress','Blocked/Open']);
  const of = (t) => d.sections.find((s) => s.title === t).items.map((i) => `${i.evidence.kind}:${i.evidence.id}`);
  assert.deepEqual(of('Done'), ['checkpoint:cp-at-since','task:t-done','checkpoint:cp-proj','focus:f-1']);
  assert.deepEqual(of('In progress'), ['note:n-1','focus:f-2']);
  assert.deepEqual(of('Blocked/Open'), ['task:t-open']);
});

test('every bullet carries evidence that points at a real record and appears in the text', () => {
  const input = snapshot();
  const d = buildWorklogDraft(input, opts({format:'worklog'}));
  const all = {checkpoint:input.checkpoints, task:input.tasks, note:input.notes, focus:input.focusSessions};
  const bullets = d.text.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bullets.length, d.evidence.length);
  for (const s of d.sections) for (const i of s.items) {
    assert.ok(all[i.evidence.kind].some((r) => r.id === i.evidence.id));
    assert.ok(typeof i.evidence.title === 'string' && i.evidence.title.length > 0);
    assert.ok(d.text.includes(`[${i.evidence.kind}:${i.evidence.id}]`));
  }
  assert.ok(d.text.startsWith('# Worklog'));
  assert.ok(!d.text.includes('secret body'));
  assert.ok(d.text.includes('Open task: Review PR now'), 'titles are single-line');
});

test('capsule filter keeps only that project and records it references', () => {
  const d = buildWorklogDraft(snapshot(), opts({capsuleId:'proj-a'}));
  assert.deepEqual(ids(d).sort(), ['checkpoint:cp-proj','focus:f-2','note:n-1','task:t-open']);
  const none = buildWorklogDraft(snapshot(), opts({capsuleId:'proj-missing'}));
  assert.equal(none.empty, true);
});

test('identical input gives identical output regardless of record order', () => {
  const a = buildWorklogDraft(snapshot(), opts());
  const b = buildWorklogDraft(snapshot(), opts());
  assert.deepEqual(a, b);
  const s = snapshot();
  for (const k of Object.keys(s)) s[k].reverse();
  assert.deepEqual(buildWorklogDraft(s, opts()), a);
});

test('empty window returns explicit empty result without fabricated content', () => {
  const d = buildWorklogDraft(snapshot(), {since:'2026-09-01T00:00:00.000Z', until:'2026-09-02T00:00:00.000Z', now, format:'worklog'});
  assert.deepEqual(d, {text:'', sections:[], evidence:[], empty:true});
  assert.deepEqual(buildWorklogDraft({}, opts()), {text:'', sections:[], evidence:[], empty:true});
});

test('invalid, reversed and future windows are rejected with descriptive errors', () => {
  assert.throws(() => buildWorklogDraft(snapshot(), opts({since:'nope'})), /since must be an ISO/);
  assert.throws(() => buildWorklogDraft(snapshot(), opts({until:'2026-13-45T00:00:00Z'})), /until/);
  assert.throws(() => buildWorklogDraft(snapshot(), opts({since:until, until:since})), /since must be earlier than until/);
  assert.throws(() => buildWorklogDraft(snapshot(), opts({until:since})), /since must be earlier than until/);
  assert.throws(() => buildWorklogDraft(snapshot(), {since:'2026-10-16T00:00:00.000Z', until:'2026-10-17T00:00:00.000Z', now, format:'standup'}), /future/);
  assert.throws(() => buildWorklogDraft(snapshot(), opts({format:'html'})), /format/);
});
