import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/taskbar-presets.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const tp = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {TASKBAR_SETTINGS, TASKBAR_PRESETS, validatePresetValues, captureSnapshot, diffPreset, buildPlan, serializePlan, parsePlan, defaultValues, normalizeManualValues, PLAN_MAX_CHARS} = tp;

const T0 = Date.UTC(2026, 9, 15, 9, 0, 0);
const defaults = () => defaultValues();
const snap = (over = {}) => captureSnapshot({...defaults(), ...over}, T0);

test('taskbar presets: settings are well formed and document Windows 11 defaults', () => {
  assert.ok(TASKBAR_SETTINGS.length >= 6 && TASKBAR_SETTINGS.length <= 10);
  const keys = TASKBAR_SETTINGS.map((s) => s.key);
  for (const k of ['TaskbarAl', 'TaskbarDa', 'ShowTaskViewButton', 'TaskbarMn', 'Start_Layout', 'SearchboxTaskbarMode']) assert.ok(keys.includes(k), k);
  assert.equal(new Set(keys).size, keys.length);
  for (const s of TASKBAR_SETTINGS) {
    assert.equal(s.kind, 'dword');
    assert.ok(s.allowed.includes(s.defaultValue), s.key);
    for (const v of s.allowed) assert.equal(typeof s.valueLabels[v], 'string');
    assert.match(s.description, /Windows 11 default: \d/);
  }
  assert.equal(TASKBAR_SETTINGS.find((s) => s.key === 'TaskbarAl').defaultValue, 1);
});

test('taskbar presets: every preset validates and is reversible', () => {
  assert.ok(TASKBAR_PRESETS.length >= 3);
  const ids = TASKBAR_PRESETS.map((p) => p.id);
  for (const id of ['left-aligned-minimal', 'default-windows-11', 'focus-clean']) assert.ok(ids.includes(id));
  for (const p of TASKBAR_PRESETS) {
    assert.deepEqual(validatePresetValues(p.values), {ok:true, errors:[]}, p.id);
    assert.equal(p.reversible, true);
    assert.ok(p.note.length > 0);
  }
});

test('taskbar presets: validatePresetValues reports exact paths', () => {
  const r = validatePresetValues({TaskbarAl: 0, Bogus: 1, TaskbarDa: 7, Start_Layout: 1.5, TaskbarMn: '1'});
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.path), ['values.Bogus', 'values.TaskbarDa', 'values.Start_Layout', 'values.TaskbarMn']);
  assert.match(r.errors[0].message, /Unknown setting "Bogus"/);
  assert.match(r.errors[1].message, /not allowed for TaskbarDa/);
  assert.deepEqual(validatePresetValues(null).errors.map((e) => e.path), ['values']);
  assert.deepEqual(validatePresetValues([]).errors.map((e) => e.path), ['values']);
});

test('taskbar presets: captureSnapshot validates values and timestamps', () => {
  const s = snap();
  assert.equal(s.capturedAt, new Date(T0).toISOString());
  assert.deepEqual(s.values, defaults());
  assert.throws(() => captureSnapshot(defaults(), Number.NaN), /Invalid timestamp/);
  assert.throws(() => captureSnapshot(defaults(), new Date('nope')), /Invalid timestamp/);
  assert.throws(() => captureSnapshot({...defaults(), TaskbarAl: 5}, T0), /values\.TaskbarAl/);
  assert.throws(() => captureSnapshot({...defaults(), Extra: 0}, T0), /values\.Extra/);
  const partial = defaults(); delete partial.TaskbarSd;
  assert.throws(() => captureSnapshot(partial, T0), /values\.TaskbarSd: missing/);
  assert.deepEqual(normalizeManualValues({TaskbarAl: 0, TaskbarDa: 9, junk: 1}), {...defaults(), TaskbarAl: 0});
  assert.deepEqual(normalizeManualValues('x'), defaults());
});

test('taskbar presets: diff omits unchanged keys and keeps settings order', () => {
  const s = snap({TaskbarDa: 0});
  const steps = diffPreset(s, 'left-aligned-minimal');
  assert.deepEqual(steps.map((x) => x.key), ['TaskbarAl', 'ShowTaskViewButton', 'TaskbarMn', 'SearchboxTaskbarMode']);
  assert.deepEqual(steps[0], {key:'TaskbarAl', from:1, to:0, label:'Taskbar alignment: Center → Left'});
  const order = TASKBAR_SETTINGS.map((x) => x.key);
  const idx = steps.map((x) => order.indexOf(x.key));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.deepEqual(diffPreset(snap(), 'default-windows-11'), []);
  assert.throws(() => diffPreset(s, 'no-such-preset'), /Unknown taskbar preset id "no-such-preset"/);
});

test('taskbar presets: plan undo steps are the exact inverse in reverse order', () => {
  const plan = buildPlan(snap(), 'focus-clean', T0 + 5);
  assert.equal(plan.presetId, 'focus-clean');
  assert.equal(plan.createdAt, new Date(T0 + 5).toISOString());
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.applied, false);
  assert.equal(plan.explorerRestartRequired, true);
  assert.ok(plan.applySteps.length > 1);
  const rev = [...plan.applySteps].reverse();
  assert.equal(plan.undoSteps.length, rev.length);
  plan.undoSteps.forEach((u, i) => {
    assert.equal(u.key, rev[i].key);
    assert.equal(u.from, rev[i].to);
    assert.equal(u.to, rev[i].from);
  });
  // applying then undoing returns to the snapshot
  const state = {...snap().values};
  for (const s of plan.applySteps) { assert.equal(state[s.key], s.from); state[s.key] = s.to; }
  for (const s of plan.undoSteps) { assert.equal(state[s.key], s.from); state[s.key] = s.to; }
  assert.deepEqual(state, snap().values);
  const noRestart = buildPlan(snap(), 'left-aligned-minimal', T0);
  assert.equal(noRestart.explorerRestartRequired, false);
  assert.throws(() => buildPlan(snap(), 'focus-clean', Number.NaN), /Invalid timestamp/);
  assert.throws(() => buildPlan(snap(), 'missing', T0), /Unknown taskbar preset id/);
});

test('taskbar presets: serialize/parse round-trip and rejection of invalid plans', () => {
  const plan = buildPlan(snap({TaskbarAl: 0}), 'focus-clean', T0);
  const text = serializePlan(plan);
  assert.deepEqual(parsePlan(text), plan);
  assert.throws(() => parsePlan('x'.repeat(PLAN_MAX_CHARS + 1)), /exceeds 20000/);
  assert.equal(PLAN_MAX_CHARS, 20000);
  assert.throws(() => parsePlan('{not json'), /not valid JSON/);
  assert.throws(() => parsePlan(42), /JSON string/);
  const obj = JSON.parse(text);
  const bad = (mut) => { const o = structuredClone(obj); mut(o); return JSON.stringify(o); };
  assert.throws(() => parsePlan(bad((o) => { o.applied = true; })), /plan\.applied/);
  assert.throws(() => parsePlan(bad((o) => { o.requiresConfirmation = false; })), /plan\.requiresConfirmation/);
  assert.throws(() => parsePlan(bad((o) => { o.presetId = 'nope'; })), /Unknown taskbar preset id/);
  assert.throws(() => parsePlan(bad((o) => { o.createdAt = 'yesterday'; })), /plan\.createdAt: Invalid timestamp/);
  assert.throws(() => parsePlan(bad((o) => { o.applySteps[0].to = 9; })), /plan\.applySteps\[0\]\.to/);
  assert.throws(() => parsePlan(bad((o) => { o.applySteps[0].key = 'Bogus'; })), /plan\.applySteps\[0\]\.key/);
  assert.throws(() => parsePlan(bad((o) => { o.undoSteps.reverse(); })), /exact inverse/);
  assert.throws(() => parsePlan(bad((o) => { o.undoSteps.pop(); })), /exact inverse/);
  assert.throws(() => parsePlan(bad((o) => { o.explorerRestartRequired = !o.explorerRestartRequired; })), /explorerRestartRequired/);
});

test('taskbar presets: module and panel stay preview-only with no system access', () => {
  const mod = readFileSync(path.join(root, 'src/ui/taskbar-presets.ts'), 'utf8');
  for (const bad of ['reg ', 'regedit', 'child_process', 'ipcRenderer', 'fetch(']) assert.ok(!mod.includes(bad), bad);
  assert.doesNotMatch(mod, /document\.|window\.|XMLHttpRequest|WebSocket/);
  const ui = readFileSync(path.join(root, 'src/components/Customization.tsx'), 'utf8');
  for (const s of ['Taskbar and Start presets (preview only)', 'Enter your current values manually — this build does not read the registry', 'Preview plan', 'Copy plan JSON', 'gate G5']) assert.ok(ui.includes(s), s);
  assert.match(ui, /usePref<unknown>\(TASKBAR_SNAPSHOT_PREF_KEY/);
  assert.equal(tp.TASKBAR_SNAPSHOT_PREF_KEY, 'customization.taskbarSnapshot');
  for (const bad of ['ipcRenderer', 'child_process', 'fetch(', 'regedit']) assert.ok(!ui.includes(bad), bad);
});
