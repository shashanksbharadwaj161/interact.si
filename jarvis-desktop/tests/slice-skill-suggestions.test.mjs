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
const ss = await load('src/ui/skill-suggestions.ts');
const tb = await load('src/ui/task-board.ts');
const wr = await load('src/ui/worker-roles.ts');
const {SKILL_LIMITS, SKILLS_PREF_KEY, suggestSkills, normalizeSkills, upsertSkill, removeSkill, taskFromSkill, normalizeTitleKey} = ss;
const {createTask, transitionTask, parseBoard} = tb;
const {validateAssignment} = wr;

const T0 = Date.UTC(2026, 2, 1, 9, 0, 0);
let n = 0;
function done(title, role = 'implementer', {endAt = T0 + 1000, model = 'claude-sonnet-5-5', scopes = 'read-files, edit-files', status = 'done'} = {}) {
  const i = n++;
  const t = createTask({title, role, model}, T0, {next:i});
  const withNote = {...t, note:`Scopes: ${scopes}`};
  const running = transitionTask(withNote, 'running', {now:T0 + 10});
  if (status === 'done') return transitionTask(running, 'done', {now:endAt, stopReason:'completed'});
  if (status === 'failed') return transitionTask(running, 'failed', {now:endAt, stopReason:'error'});
  return running;
}
const log = (taskId, level, message, i = 0) => ({id:`l-${i}-${taskId}-${message.length}`, taskId, at:new Date(T0 + i).toISOString(), level, message});

test('skill suggestions: constants', () => {
  assert.deepEqual({...SKILL_LIMITS}, {skills:50, name:80, steps:20, stepChars:200, minOccurrences:2});
  assert.equal(SKILLS_PREF_KEY, 'developer.skills');
});

test('skill suggestions: title normalization groups by role and key', () => {
  assert.equal(normalizeTitleKey('Fix bug #12 in Parser!'), 'fix bug # in parser');
  assert.equal(normalizeTitleKey('one two three four five six seven eight'), 'one two three four five six');
  const a = done('Fix issue 12: parser');
  const b = done('fix issue 7 parser.');
  const c = done('Fix issue 3 parser', 'tester', {model:'claude-haiku-5-5', scopes:'read-files'});
  const s = suggestSkills([a, b, c], [], {now:T0, minOccurrences:2});
  assert.equal(s.length, 1);
  assert.equal(s[0].key, 'implementer:fix issue # parser');
  assert.equal(s[0].occurrences, 2);
  assert.deepEqual(s[0].sourceTaskIds, [a.id, b.id]);
  assert.equal(s[0].skill.role, 'implementer');
  assert.equal(s[0].skill.createdAt, new Date(T0).toISOString());
  assert.deepEqual(s[0].skill.sourceTaskIds, [a.id, b.id]);
});

test('skill suggestions: minOccurrences threshold and only done/completed tasks count', () => {
  const a = done('Write docs page', 'docs', {model:'claude-haiku-5-5', scopes:'read-files, write-docs'});
  const failed = done('Write docs page', 'docs', {status:'failed'});
  const running = done('Write docs page', 'docs', {status:'running'});
  assert.deepEqual(suggestSkills([a, failed, running], [], {now:T0}), []);
  const b = done('Write docs page', 'docs', {model:'claude-haiku-5-5', scopes:'read-files, write-docs'});
  assert.equal(suggestSkills([a, b], [], {now:T0}).length, 1);
  assert.equal(suggestSkills([a, b], [], {now:T0, minOccurrences:3}).length, 0);
  assert.equal(suggestSkills([a], [], {now:T0, minOccurrences:1}).length, 1);
});

test('skill suggestions: ordering by occurrences, then latest endedAt, then key', () => {
  const x = [done('Alpha task', 'implementer', {endAt:T0 + 100}), done('Alpha task', 'implementer', {endAt:T0 + 200})];
  const y = [done('Beta task', 'implementer', {endAt:T0 + 50}), done('Beta task', 'implementer', {endAt:T0 + 60}), done('Beta task', 'implementer', {endAt:T0 + 70})];
  const z = [done('Gamma task', 'implementer', {endAt:T0 + 500}), done('Gamma task', 'implementer', {endAt:T0 + 900})];
  const w = [done('Delta task', 'implementer', {endAt:T0 + 900}), done('Delta task', 'implementer', {endAt:T0 + 10})];
  const s = suggestSkills([...x, ...y, ...z, ...w], [], {now:T0});
  assert.deepEqual(s.map((g) => g.key), ['implementer:beta task', 'implementer:delta task', 'implementer:gamma task', 'implementer:alpha task']);
  assert.equal(s[1].lastCompletedAt, new Date(T0 + 900).toISOString());
  assert.equal(s[3].lastCompletedAt, new Date(T0 + 200).toISOString());
});

test('skill suggestions: steps from info/result entries, unique, capped and truncated', () => {
  const a = done('Refactor module');
  const b = done('Refactor module');
  const other = done('Something else');
  const entries = [
    log(a.id, 'info', 'Read the module', 1),
    log(a.id, 'warn', 'Warning only', 2),
    log(b.id, 'info', 'Read the module', 3),
    log(other.id, 'info', 'Not in group', 4),
    log(b.id, 'result', 'Tests pass', 5),
    log(a.id, 'error', 'Error only', 6),
    log(a.id, 'info', 'x'.repeat(300), 7),
  ];
  const [s] = suggestSkills([a, b, other], entries, {now:T0});
  assert.equal(s.skill.steps.length, 3);
  assert.deepEqual(s.skill.steps.slice(0, 2), ['Read the module', 'Tests pass']);
  assert.equal(s.skill.steps[2].length, 200);
  assert.ok(s.skill.steps[2].endsWith('…'));
  const many = Array.from({length:30}, (_, i) => log(a.id, 'info', `step ${i}`, 10 + i));
  const [capped] = suggestSkills([a, b], many, {now:T0});
  assert.equal(capped.skill.steps.length, 20);
  assert.equal(capped.skill.steps[0], 'step 0');
  assert.equal(capped.skill.steps[19], 'step 19');
});

test('skill suggestions: scopes parsed from note and intersected with TOOL_SCOPES', () => {
  const a = done('Run suite', 'tester', {model:'claude-haiku-5-5', scopes:'run-tests, launch-rockets, read-files'});
  const b = done('Run suite', 'tester', {model:'claude-haiku-5-5', scopes:'bogus'});
  const [s] = suggestSkills([a, b], [], {now:T0});
  assert.deepEqual(s.skill.scopes, ['read-files', 'run-tests']);
  assert.equal(s.skill.model, 'claude-haiku-5-5');
  const noNote = {...done('No note'), note:undefined};
  const noNote2 = {...done('No note'), note:'Paused on resume'};
  assert.deepEqual(suggestSkills([noNote, noNote2], [], {now:T0})[0].skill.scopes, []);
});

test('skill suggestions: normalizeSkills drops malformed/duplicates, newest first, caps at 50', () => {
  const base = suggestSkills([done('Polish ui'), done('Polish ui')], [], {now:T0})[0].skill;
  const older = {...base, id:'s-old', createdAt:new Date(T0 - 1000).toISOString()};
  const newer = {...base, id:'s-new', createdAt:new Date(T0 + 1000).toISOString()};
  const dupOld = {...newer, createdAt:new Date(T0 - 5000).toISOString(), name:'stale dup'};
  const raw = [older, dupOld, newer, null, 'x', {...base, id:''}, {...base, id:'bad-scope', scopes:['root']}, {...base, id:'bad-date', createdAt:'nope'}, {...base, id:'bad-model', model:5}, {...base, id:'long-steps', steps:Array(21).fill('s')}];
  const out = normalizeSkills(raw);
  assert.deepEqual(out.map((s) => s.id), ['s-new', 's-old']);
  assert.equal(out[0].name, base.name);
  assert.deepEqual(normalizeSkills('nope'), []);
  const lots = Array.from({length:60}, (_, i) => ({...base, id:`s-${i}`, createdAt:new Date(T0 + i).toISOString()}));
  const capped = normalizeSkills(lots);
  assert.equal(capped.length, 50);
  assert.equal(capped[0].id, 's-59');
  let list = upsertSkill([], older);
  list = upsertSkill(list, newer);
  list = upsertSkill(list, {...older, name:'Renamed'});
  assert.equal(list.length, 2);
  assert.equal(list.find((s) => s.id === 's-old').name, 'Renamed');
  assert.deepEqual(removeSkill(list, 's-old').map((s) => s.id), ['s-new']);
  assert.throws(() => upsertSkill(list, {id:'x'}), /Invalid skill/);
});

test('skill suggestions: taskFromSkill output is accepted by createTask and validateAssignment', () => {
  const [s] = suggestSkills([done('Add endpoint'), done('Add endpoint')], [], {now:T0});
  const input = taskFromSkill(s.skill);
  assert.deepEqual(input, {title:'Add endpoint', role:'implementer', model:'claude-sonnet-5-5', scopes:['read-files', 'edit-files'], note:'Scopes: read-files, edit-files'});
  assert.deepEqual(validateAssignment({roleId:input.role, model:input.model, scopes:input.scopes}), {ok:true, problems:[]});
  const task = createTask(input, T0 + 5, {next:0});
  assert.equal(task.status, 'queued');
  assert.equal(task.title, 'Add endpoint');
  assert.equal(task.model, 'claude-sonnet-5-5');
  const stored = parseBoard([{...task, note:input.note}]);
  assert.equal(stored[0].note, 'Scopes: read-files, edit-files');
  const custom = taskFromSkill({...s.skill, model:null}, {title:'Custom title'});
  assert.equal(custom.title, 'Custom title');
  assert.equal(custom.model, 'claude-sonnet-5-5', 'falls back to role default model');
  assert.equal(taskFromSkill(s.skill, {model:'claude-opus-5-5'}).model, 'claude-opus-5-5');
  // round trip: the queued task's note yields the same scopes in a later suggestion
  const again = suggestSkills([{...transitionTask(transitionTask({...task, note:input.note}, 'running', {now:T0 + 6}), 'done', {now:T0 + 7, stopReason:'completed'})}, done('Add endpoint')], [], {now:T0});
  assert.deepEqual(again[0].skill.scopes, ['read-files', 'edit-files']);
});

test('skill suggestions: descriptive errors for bad inputs', () => {
  assert.throws(() => suggestSkills('nope', []), /Tasks must be an array, got string/);
  assert.throws(() => suggestSkills([], {}), /Log entries must be an array, got object/);
  assert.throws(() => suggestSkills([], [], {now:'not a date'}), /Invalid "now"/);
  assert.throws(() => suggestSkills([], [], {now:Number.NaN}), /Invalid "now"/);
  assert.throws(() => suggestSkills([], [], {now:T0, minOccurrences:0}), /minOccurrences must be a positive integer/);
  assert.throws(() => taskFromSkill({id:'x'}), /Invalid skill/);
  assert.throws(() => taskFromSkill(null), /Invalid skill/);
  const [s] = suggestSkills([done('Q task'), done('Q task')], [], {now:T0});
  assert.throws(() => taskFromSkill(s.skill, {title:'  '}), /title override/);
  assert.throws(() => upsertSkill('x', s.skill), /Skills must be an array/);
  assert.throws(() => removeSkill([], 5), /Skill id must be a string/);
});

test('skill suggestions: module is offline and Developer wires the Suggested skills group', () => {
  const mod = readFileSync(path.join(root, 'src/ui/skill-suggestions.ts'), 'utf8');
  assert.doesNotMatch(mod, /fetch|setTimeout|setInterval|XMLHttpRequest|WebSocket|child_process|document\.|window\./);
  const imports = [...mod.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./agent-log', './task-board', './worker-roles']);
  const src = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  assert.ok(src.includes('Skills are templates derived from manually recorded tasks and logs. Saving or queuing a skill never starts a worker.'));
  for (const label of ['Suggested skills', 'Save as skill', 'Queue task from skill', 'Remove', 'Confirm remove']) assert.ok(src.includes(label), label);
  assert.match(src, /usePref<unknown>\(SKILLS_PREF_KEY, \[\]\)/);
  assert.match(src, /upsertSkill\(skills, s\.skill\)/);
  assert.match(src, /onQueue\(taskFromSkill\(skill\)\)/);
  assert.match(src, /<SkillSuggestionsGroup tasks=\{tasks\}/);
  assert.ok(src.indexOf('<SkillSuggestionsGroup') > src.indexOf('<SessionsGroup tasks='), 'after Sessions group');
});
