import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/explorer-presets.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const ep = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {EXPLORER_SETTINGS, EXPLORER_PRESETS, validatePresetValues, captureSnapshot, diffPreset, buildPlan, serializePlan, parsePlan, defaultValues, normalizeManualValues, settingsByScope, PLAN_MAX_CHARS} = ep;

const T0 = Date.UTC(2026, 9, 16, 10, 0, 0);
const defaults = () => defaultValues();
const snap = (over = {}) => captureSnapshot({...defaults(), ...over}, T0);

test('explorer presets: settings table is well formed and documents Windows 11 defaults', () => {
  assert.ok(EXPLORER_SETTINGS.length >= 8);
  const keys = EXPLORER_SETTINGS.map((s) => s.key);
  for (const k of ['HideFileExt', 'Hidden', 'ShowSuperHidden', 'LaunchTo', 'NavPaneShowAllFolders', 'UseCompactMode', 'ToastEnabled', 'NOC_GLOBAL_SETTING_TOASTS_ENABLED', 'FocusAssistMode']) assert.ok(keys.includes(k), k);
  assert.equal(new Set(keys).size, keys.length);
  for (const s of EXPLORER_SETTINGS) {
    assert.ok(['explorer', 'notifications'].includes(s.scope), s.key);
    assert.equal(s.kind, 'dword');
    assert.ok(s.allowed.includes(s.defaultValue), s.key);
    for (const v of s.allowed) assert.equal(typeof s.valueLabels[v], 'string');
    assert.match(s.description, /Windows 11 default: \d/);
    assert.equal(typeof s.location, 'string');
    assert.ok(s.location.length > 0);
    assert.equal(typeof s.explorerRestart, 'boolean');
  }
  assert.equal(EXPLORER_SETTINGS.find((s) => s.key === 'HideFileExt').defaultValue, 1);
  assert.equal(EXPLORER_SETTINGS.find((s) => s.key === 'Hidden').defaultValue, 2);
  assert.ok(settingsByScope('explorer').length >= 4);
  assert.ok(settingsByScope('notifications').length >= 3);
  assert.equal(settingsByScope('explorer').length + settingsByScope('notifications').length, EXPLORER_SETTINGS.length);
});

test('explorer presets: every preset validates and is reversible', () => {
  assert.ok(EXPLORER_PRESETS.length >= 3);
  const ids = EXPLORER_PRESETS.map((p) => p.id);
  for (const id of ['default-windows-11', 'power-user-explorer', 'quiet-notifications']) assert.ok(ids.includes(id));
  for (const p of EXPLORER_PRESETS) {
    assert.deepEqual(validatePresetValues(p.values), {ok:true, errors:[]}, p.id);
    assert.equal(p.reversible, true);
    assert.ok(p.note.length > 0);
  }
  assert.deepEqual(EXPLORER_PRESETS.find((p) => p.id === 'default-windows-11').values, defaults());
});

test('explorer presets: validatePresetValues reports exact paths', () => {
  const r = validatePresetValues({HideFileExt: 0, Bogus: 1, Hidden: 0, LaunchTo: 1.5, ToastEnabled: '1'});
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => e.path), ['values.Bogus', 'values.Hidden', 'values.LaunchTo', 'values.ToastEnabled']);
  assert.match(r.errors[0].message, /Unknown setting "Bogus"/);
  assert.match(r.errors[1].message, /not allowed for Hidden/);
  assert.deepEqual(validatePresetValues(null).errors.map((e) => e.path), ['values']);
  assert.deepEqual(validatePresetValues([]).errors.map((e) => e.path), ['values']);
  assert.deepEqual(validatePresetValues({}), {ok:true, errors:[]});
});

test('explorer presets: captureSnapshot validates values and timestamps', () => {
  const s = snap();
  assert.equal(s.capturedAt, new Date(T0).toISOString());
  assert.deepEqual(s.values, defaults());
  assert.throws(() => captureSnapshot(defaults(), Number.NaN), /Invalid timestamp/);
  assert.throws(() => captureSnapshot(defaults(), new Date('nope')), /Invalid timestamp/);
  assert.throws(() => captureSnapshot({...defaults(), FocusAssistMode: 5}, T0), /values\.FocusAssistMode/);
  assert.throws(() => captureSnapshot({...defaults(), Extra: 0}, T0), /values\.Extra/);
  const partial = defaults(); delete partial.UseCompactMode;
  assert.throws(() => captureSnapshot(partial, T0), /values\.UseCompactMode: missing/);
  assert.deepEqual(normalizeManualValues({HideFileExt: 0, Hidden: 9, junk: 1}), {...defaults(), HideFileExt: 0});
  assert.deepEqual(normalizeManualValues('x'), defaults());
});

test('explorer presets: diff lists only changed keys in settings order', () => {
  const s = snap({Hidden: 1});
  const steps = diffPreset(s, 'power-user-explorer');
  assert.deepEqual(steps.map((x) => x.key), ['HideFileExt', 'ShowSuperHidden', 'LaunchTo', 'NavPaneShowAllFolders', 'UseCompactMode']);
  assert.deepEqual(steps[0], {key:'HideFileExt', from:1, to:0, label:'Hide file name extensions: Hide extensions → Show extensions'});
  const order = EXPLORER_SETTINGS.map((x) => x.key);
  const idx = steps.map((x) => order.indexOf(x.key));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  assert.deepEqual(diffPreset(snap(), 'default-windows-11'), []);
  assert.deepEqual(diffPreset(snap({ToastEnabled: 0}), 'quiet-notifications').map((x) => x.key), ['NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK', 'FocusAssistMode']);
  assert.throws(() => diffPreset(s, 'no-such-preset'), /Unknown explorer preset id "no-such-preset"/);
});

test('explorer presets: undo steps are the exact inverse in reverse order and flags are fixed', () => {
  const plan = buildPlan(snap(), 'power-user-explorer', T0 + 5);
  assert.equal(plan.presetId, 'power-user-explorer');
  assert.equal(plan.createdAt, new Date(T0 + 5).toISOString());
  assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.applied, false);
  assert.equal(plan.explorerRestartNeeded, true);
  assert.ok(plan.applySteps.length > 1);
  const rev = [...plan.applySteps].reverse();
  assert.equal(plan.undoSteps.length, rev.length);
  plan.undoSteps.forEach((u, i) => {
    assert.equal(u.key, rev[i].key);
    assert.equal(u.from, rev[i].to);
    assert.equal(u.to, rev[i].from);
  });
  const state = {...snap().values};
  for (const s of plan.applySteps) { assert.equal(state[s.key], s.from); state[s.key] = s.to; }
  for (const s of plan.undoSteps) { assert.equal(state[s.key], s.from); state[s.key] = s.to; }
  assert.deepEqual(state, snap().values);
  const quiet = buildPlan(snap(), 'quiet-notifications', T0);
  assert.equal(quiet.explorerRestartNeeded, false);
  assert.equal(quiet.requiresConfirmation, true);
  assert.equal(quiet.applied, false);
  const empty = buildPlan(snap(), 'default-windows-11', T0);
  assert.deepEqual(empty.applySteps, []);
  assert.deepEqual(empty.undoSteps, []);
  assert.equal(empty.explorerRestartNeeded, false);
  assert.throws(() => buildPlan(snap(), 'power-user-explorer', Number.NaN), /Invalid timestamp/);
  assert.throws(() => buildPlan(snap(), 'power-user-explorer', new Date('bad')), /Invalid timestamp/);
  assert.throws(() => buildPlan(snap(), 'missing', T0), /Unknown explorer preset id "missing"/);
});

test('explorer presets: serialize/parse round-trip and rejection of invalid plans', () => {
  const plan = buildPlan(snap({HideFileExt: 0}), 'power-user-explorer', T0);
  const text = serializePlan(plan);
  assert.deepEqual(parsePlan(text), plan);
  const quiet = buildPlan(snap(), 'quiet-notifications', T0);
  assert.deepEqual(parsePlan(serializePlan(quiet)), quiet);
  assert.equal(PLAN_MAX_CHARS, 20000);
  assert.throws(() => parsePlan('x'.repeat(PLAN_MAX_CHARS + 1)), /exceeds 20000/);
  assert.throws(() => parsePlan('{not json'), /not valid JSON/);
  assert.throws(() => parsePlan(42), /JSON string/);
  assert.throws(() => parsePlan('[]'), /plan: must be an object/);
  const obj = JSON.parse(text);
  const bad = (mut) => { const o = structuredClone(obj); mut(o); return JSON.stringify(o); };
  assert.throws(() => parsePlan(bad((o) => { o.applied = true; })), /plan\.applied/);
  assert.throws(() => parsePlan(bad((o) => { o.requiresConfirmation = false; })), /plan\.requiresConfirmation/);
  assert.throws(() => parsePlan(bad((o) => { delete o.presetId; })), /plan\.presetId: must be a string/);
  assert.throws(() => parsePlan(bad((o) => { o.presetId = 'nope'; })), /Unknown explorer preset id "nope"/);
  assert.throws(() => parsePlan(bad((o) => { o.createdAt = 'yesterday'; })), /plan\.createdAt: Invalid timestamp/);
  assert.throws(() => parsePlan(bad((o) => { o.applySteps = {}; })), /plan\.applySteps: must be an array/);
  assert.throws(() => parsePlan(bad((o) => { o.applySteps[0].to = 9; })), /plan\.applySteps\[0\]\.to/);
  assert.throws(() => parsePlan(bad((o) => { o.applySteps[0].key = 'Bogus'; })), /plan\.applySteps\[0\]\.key/);
  assert.throws(() => parsePlan(bad((o) => { o.applySteps.reverse(); })), /out of order/);
  assert.throws(() => parsePlan(bad((o) => { o.undoSteps.reverse(); })), /exact inverse/);
  assert.throws(() => parsePlan(bad((o) => { o.undoSteps.pop(); })), /exact inverse/);
  assert.throws(() => parsePlan(bad((o) => { o.explorerRestartNeeded = !o.explorerRestartNeeded; })), /plan\.explorerRestartNeeded: does not match/);
  assert.throws(() => parsePlan(bad((o) => { o.explorerRestartNeeded = 'yes'; })), /plan\.explorerRestartNeeded: must be a boolean/);
  const huge = {...plan, padding: 'x'.repeat(PLAN_MAX_CHARS)};
  assert.throws(() => serializePlan(huge), /exceeds 20000/);
});

test('explorer presets: module and panel stay preview-only with no system access', () => {
  const mod = readFileSync(path.join(root, 'src/ui/explorer-presets.ts'), 'utf8');
  for (const bad of ['regedit', 'child_process', 'ipcRenderer', 'fetch(', 'fetch ', 'taskbar-presets']) assert.ok(!mod.includes(bad), bad);
  assert.doesNotMatch(mod, /document\.|window\.|XMLHttpRequest|WebSocket|require\(/);
  const ui = readFileSync(path.join(root, 'src/components/Customization.tsx'), 'utf8');
  for (const s of ['Explorer and notification presets (preview only)', 'this build does not read the registry', 'Preview plan', 'Copy plan JSON', 'gate G5', 'navigator.clipboard.writeText']) assert.ok(ui.includes(s), s);
  assert.match(ui, /usePref<unknown>\(EXPLORER_SNAPSHOT_PREF_KEY/);
  assert.equal(ep.EXPLORER_SNAPSHOT_PREF_KEY, 'customization.explorerSnapshot');
  assert.ok(ui.indexOf('<TaskbarPresetsPanel />') < ui.indexOf('<ExplorerPresetsPanel />'));
  for (const bad of ['ipcRenderer', 'child_process', 'fetch(', 'regedit']) assert.ok(!ui.includes(bad), bad);
});
