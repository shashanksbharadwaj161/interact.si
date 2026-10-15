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
const wr = await load('src/ui/worker-roles.ts');
const tb = await load('src/ui/task-board.ts');
const {WORKER_ROLES, KNOWN_MODELS, TOOL_SCOPES, ROLE_PREF_KEY, recommendModel, validateAssignment, normalizeOverrides, describeRole} = wr;

test('worker roles: frozen definitions with defaults inside allowed models and known scopes', () => {
  assert.equal(ROLE_PREF_KEY, 'developer.roleOverrides');
  assert.ok(Object.isFrozen(WORKER_ROLES));
  assert.ok(WORKER_ROLES.length >= 5);
  const ids = WORKER_ROLES.map((r) => r.id);
  for (const id of ['planner', 'implementer', 'reviewer', 'tester', 'docs']) assert.ok(ids.includes(id), id);
  assert.deepEqual([...TOOL_SCOPES], ['read-files', 'edit-files', 'run-tests', 'write-docs', 'none']);
  const devSrc = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  for (const r of WORKER_ROLES) {
    assert.ok(Object.isFrozen(r), r.id);
    assert.ok(r.label && r.purpose, r.id);
    assert.ok(r.allowedModels.includes(r.defaultModel), `${r.id} default in allowed`);
    assert.ok(r.allowedModels.length > 0);
    for (const m of r.allowedModels) {
      assert.ok(KNOWN_MODELS.includes(m), m);
      assert.ok(devSrc.includes(`'${m}'`), `model ${m} offered by Developer select`);
    }
    assert.ok(r.toolScopes.length > 0);
    for (const s of r.toolScopes) assert.ok(TOOL_SCOPES.includes(s), s);
  }
});

test('worker roles: recommendModel returns default, falls back with a reason, or null', () => {
  const def = recommendModel('tester', KNOWN_MODELS);
  assert.equal(def.model, 'claude-haiku-5-5');
  assert.match(def.reason, /Default model for tester/);
  const fb = recommendModel('tester', ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(fb.model, 'claude-sonnet-5-5');
  assert.match(fb.reason, /not offered; using the first allowed model/);
  const none = recommendModel('tester', ['claude-opus-5-5']);
  assert.equal(none.model, null);
  assert.match(none.reason, /No model allowed for tester is offered/);
  assert.equal(recommendModel('nobody', KNOWN_MODELS).model, null);
  const ov = recommendModel('tester', KNOWN_MODELS, {tester:{defaultModel:'claude-sonnet-5-5'}});
  assert.equal(ov.model, 'claude-sonnet-5-5');
  assert.match(ov.reason, /Saved default/);
  // disallowed override is ignored
  assert.equal(recommendModel('tester', KNOWN_MODELS, {tester:{defaultModel:'claude-opus-5-5'}}).model, 'claude-haiku-5-5');
});

test('worker roles: validateAssignment accepts a valid assignment', () => {
  assert.deepEqual(validateAssignment({roleId:'implementer', model:'claude-sonnet-5-5', scopes:['read-files', 'edit-files']}), {ok:true, problems:[]});
});

test('worker roles: validateAssignment rejects unknown role, disallowed model, out-of-scope tool and empty scopes with exact messages', () => {
  assert.deepEqual(validateAssignment({roleId:'wizard', model:'claude-sonnet-5-5', scopes:['read-files']}), {ok:false, problems:['Unknown role "wizard".']});
  assert.deepEqual(validateAssignment({roleId:'tester', model:'claude-opus-5-5', scopes:['read-files']}).problems, [
    'Model "claude-opus-5-5" is not allowed for role tester. Allowed: claude-sonnet-5-5, claude-haiku-5-5.',
  ]);
  assert.deepEqual(validateAssignment({roleId:'reviewer', model:'claude-sonnet-5-5', scopes:['read-files', 'edit-files']}).problems, [
    'Scope "edit-files" is not in the tool scopes of role reviewer. Allowed: read-files.',
  ]);
  const empty = validateAssignment({roleId:'reviewer', model:'claude-sonnet-5-5', scopes:[]});
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.problems, ['Select at least one tool scope.']);
});

test('worker roles: non-string ids throw descriptive errors', () => {
  assert.throws(() => recommendModel(42, KNOWN_MODELS), /Role id must be a string, got number/);
  assert.throws(() => describeRole(null), /Role id must be a string, got null/);
  assert.throws(() => validateAssignment({roleId:{}, model:'x', scopes:[]}), /Role id must be a string, got object/);
  assert.throws(() => validateAssignment({roleId:'tester', model:7, scopes:[]}), /Model id must be a string, got number/);
  assert.throws(() => validateAssignment({roleId:'tester', model:'claude-haiku-5-5', scopes:'read-files'}), /Scopes must be an array/);
});

test('worker roles: normalizeOverrides keeps allowed overrides and drops the rest with warnings', () => {
  const {overrides, warnings} = normalizeOverrides({
    reviewer:{defaultModel:'claude-haiku-5-5'},
    tester:{defaultModel:'claude-opus-5-5'},
    ghost:{defaultModel:'claude-haiku-5-5'},
    docs:'claude-fable-5-1',
  });
  assert.deepEqual(overrides, {reviewer:{defaultModel:'claude-haiku-5-5'}});
  assert.ok(warnings.includes('Override for tester dropped: model "claude-opus-5-5" is not allowed for role tester.'));
  assert.ok(warnings.includes('Override for unknown role "ghost" dropped.'));
  assert.ok(warnings.includes('Override for docs dropped: expected { defaultModel }.'));
  assert.equal(warnings.length, 3);
  assert.deepEqual(normalizeOverrides(undefined), {overrides:{}, warnings:[]});
  assert.equal(normalizeOverrides([]).warnings.length, 1);
  assert.deepEqual(normalizeOverrides(normalizeOverrides({planner:{defaultModel:'claude-sonnet-5-5'}}).overrides).overrides, {planner:{defaultModel:'claude-sonnet-5-5'}});
});

test('worker roles: describeRole returns a non-empty single paragraph for every role', () => {
  for (const r of WORKER_ROLES) {
    const d = describeRole(r.id);
    assert.equal(typeof d, 'string');
    assert.ok(d.length > 40, r.id);
    assert.doesNotMatch(d, /\n/);
    assert.ok(d.includes(r.purpose));
  }
  assert.throws(() => describeRole('nobody'), /Unknown role "nobody"/);
});

test('worker roles: scope note survives parseBoard round trip', () => {
  const t = tb.createTask({title:'Write docs', role:'docs', model:'claude-haiku-5-5'}, Date.UTC(2026, 0, 1), {next:0});
  const stored = {...t, scopes:['read-files', 'write-docs'], note:'Scopes: read-files, write-docs'};
  const parsed = tb.parseBoard(JSON.parse(JSON.stringify([stored])));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].note, 'Scopes: read-files, write-docs');
  assert.equal(parsed[0].role, 'docs');
});

test('worker roles: module is offline and Developer form is role-aware', () => {
  const mod = readFileSync(path.join(root, 'src/ui/worker-roles.ts'), 'utf8');
  assert.doesNotMatch(mod, /fetch|child_process|XMLHttpRequest|WebSocket|setTimeout|setInterval|document\.|window\./);
  const src = readFileSync(path.join(root, 'src/components/Developer.tsx'), 'utf8');
  assert.ok(src.includes('Roles describe intended scope for a task record; this build does not launch workers.'));
  assert.match(src, /usePref<unknown>\(ROLE_PREF_KEY/);
  assert.match(src, /recommendModel\(next, BOARD_MODELS, overrides\)/);
  assert.match(src, /disabled=\{!title\.trim\(\) \|\| full \|\| !assignment\.ok\}/);
  assert.match(src, /normalizeOverrides\(next\)\.overrides/);
  assert.ok(src.includes('Role defaults'));
});
