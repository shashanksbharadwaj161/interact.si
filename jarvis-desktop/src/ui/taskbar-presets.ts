/**
 * Taskbar and Start menu presets (roadmap 73) — preview and reversibility planning only.
 *
 * Pure, DOM-free data and helpers. Nothing here reads or writes Windows settings: the "current" values come from
 * the user typing them in, and a plan is only a description of steps plus their exact inverse. Applying a plan is
 * not available in this build pending the licence/safety gate G5, so every plan carries applied:false and
 * requiresConfirmation:true.
 */

export type TaskbarSetting = {
  /** Value name under HKCU Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced (or `location` when noted). */
  key: string;
  label: string;
  kind: 'dword';
  allowed: number[];
  /** Human label for every allowed value. */
  valueLabels: Record<number, string>;
  /** Windows 11 default value. */
  defaultValue: number;
  description: string;
  /** Per-user key the value name lives under. */
  location: string;
  /** Whether File Explorer usually has to restart before the change shows. */
  explorerRestart: boolean;
};

const ADVANCED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const SEARCH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Search';

export const TASKBAR_SETTINGS: readonly TaskbarSetting[] = [
  {
    key: 'TaskbarAl',
    label: 'Taskbar alignment',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Left', 1: 'Center' },
    defaultValue: 1,
    description: 'Where taskbar icons sit. Windows 11 default: 1 (Center).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'TaskbarDa',
    label: 'Widgets button',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Hidden', 1: 'Shown' },
    defaultValue: 1,
    description: 'Shows or hides the Widgets button on the taskbar. Windows 11 default: 1 (Shown).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'ShowTaskViewButton',
    label: 'Task View button',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Hidden', 1: 'Shown' },
    defaultValue: 1,
    description: 'Shows or hides the Task View (virtual desktops) button. Windows 11 default: 1 (Shown).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'TaskbarMn',
    label: 'Chat button',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Hidden', 1: 'Shown' },
    defaultValue: 1,
    description: 'Shows or hides the Chat button found on early Windows 11 releases. Windows 11 default: 1 (Shown).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'TaskbarSd',
    label: 'Show desktop corner',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 1,
    description: 'Lets the far corner of the taskbar show the desktop when clicked. Windows 11 default: 1 (On).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'Start_Layout',
    label: 'Start menu layout',
    kind: 'dword',
    allowed: [0, 1, 2],
    valueLabels: { 0: 'Default', 1: 'More pins', 2: 'More recommendations' },
    defaultValue: 0,
    description: 'Balance between pinned apps and recommendations in Start. Windows 11 default: 0 (Default).',
    location: ADVANCED,
    explorerRestart: true,
  },
  {
    key: 'Start_TrackDocs',
    label: 'Recent files in Start',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 1,
    description: 'Whether Start and Jump Lists show recently opened items. Windows 11 default: 1 (On).',
    location: ADVANCED,
    explorerRestart: true,
  },
  {
    key: 'SearchboxTaskbarMode',
    label: 'Taskbar search',
    kind: 'dword',
    allowed: [0, 1, 2, 3],
    valueLabels: { 0: 'Hidden', 1: 'Icon only', 2: 'Search box', 3: 'Icon and label' },
    defaultValue: 2,
    description: 'How search appears on the taskbar (stored under the Search key, not Advanced). Windows 11 default: 2 (Search box).',
    location: SEARCH,
    explorerRestart: false,
  },
];

export type TaskbarPreset = {
  id: string;
  name: string;
  values: Record<string, number>;
  reversible: true;
  note: string;
};

export const TASKBAR_PRESETS: readonly TaskbarPreset[] = [
  {
    id: 'default-windows-11',
    name: 'Windows 11 defaults',
    values: { TaskbarAl: 1, TaskbarDa: 1, ShowTaskViewButton: 1, TaskbarMn: 1, TaskbarSd: 1, Start_Layout: 0, Start_TrackDocs: 1, SearchboxTaskbarMode: 2 },
    reversible: true,
    note: 'Returns every listed setting to the value a fresh Windows 11 install uses.',
  },
  {
    id: 'left-aligned-minimal',
    name: 'Left-aligned minimal',
    values: { TaskbarAl: 0, TaskbarDa: 0, ShowTaskViewButton: 0, TaskbarMn: 0, SearchboxTaskbarMode: 1 },
    reversible: true,
    note: 'Classic left-aligned icons with extra buttons hidden and search reduced to an icon.',
  },
  {
    id: 'focus-clean',
    name: 'Focus clean',
    values: { TaskbarDa: 0, TaskbarMn: 0, Start_Layout: 1, Start_TrackDocs: 0, SearchboxTaskbarMode: 0 },
    reversible: true,
    note: 'Fewer distractions: no widgets, chat, search box or recent files, and more room for pinned apps.',
  },
];

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: boolean; errors: ValidationError[] };

const SETTING_BY_KEY = new Map(TASKBAR_SETTINGS.map((s) => [s.key, s]));
const ORDER = new Map(TASKBAR_SETTINGS.map((s, i) => [s.key, i]));

export const PLAN_MAX_CHARS = 20000;
export const TASKBAR_SNAPSHOT_PREF_KEY = 'customization.taskbarSnapshot';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function getSetting(key: string): TaskbarSetting | undefined {
  return SETTING_BY_KEY.get(key);
}

export function valueLabel(key: string, value: number): string {
  const s = SETTING_BY_KEY.get(key);
  if (!s) return String(value);
  return s.valueLabels[value] ?? String(value);
}

/** Validates a partial key->value map against TASKBAR_SETTINGS. Error paths look like `values.TaskbarAl`. */
export function validatePresetValues(values: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isRecord(values)) return { ok: false, errors: [{ path: 'values', message: 'values must be an object of setting name to number' }] };
  for (const key of Object.keys(values)) {
    const path = `values.${key}`;
    const setting = SETTING_BY_KEY.get(key);
    if (!setting) {
      errors.push({ path, message: `Unknown setting "${key}"` });
      continue;
    }
    const v = values[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || !setting.allowed.includes(v)) {
      errors.push({ path, message: `Value ${JSON.stringify(v)} is not allowed for ${key}; allowed: ${setting.allowed.join(', ')}` });
    }
  }
  return { ok: errors.length === 0, errors };
}

function toIso(now: number | Date): string {
  const t = now instanceof Date ? now.getTime() : now;
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`Invalid timestamp: ${String(now)}`);
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(now)}`);
  return d.toISOString();
}

export type TaskbarSnapshot = { capturedAt: string; values: Record<string, number> };

/** Builds a full snapshot from manually entered values. Every setting must be present with an allowed value. */
export function captureSnapshot(current: Record<string, number>, now: number | Date): TaskbarSnapshot {
  const capturedAt = toIso(now);
  const check = validatePresetValues(current);
  if (!check.ok) throw new Error(`Invalid snapshot: ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  const values: Record<string, number> = {};
  for (const s of TASKBAR_SETTINGS) {
    if (!hasOwn(current, s.key)) throw new Error(`Invalid snapshot: values.${s.key}: missing value`);
    values[s.key] = current[s.key];
  }
  return { capturedAt, values };
}

/** Windows 11 defaults for every setting, useful as the initial manual entry. */
export function defaultValues(): Record<string, number> {
  return Object.fromEntries(TASKBAR_SETTINGS.map((s) => [s.key, s.defaultValue]));
}

/** Keeps allowed stored values and fills anything missing or invalid with the Windows 11 default. */
export function normalizeManualValues(raw: unknown): Record<string, number> {
  const out = defaultValues();
  if (!isRecord(raw)) return out;
  for (const s of TASKBAR_SETTINGS) {
    const v = raw[s.key];
    if (typeof v === 'number' && Number.isInteger(v) && s.allowed.includes(v)) out[s.key] = v;
  }
  return out;
}

export function findPreset(id: string): TaskbarPreset {
  const p = TASKBAR_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown taskbar preset id "${id}"`);
  return p;
}

export type PlanStep = { key: string; from: number; to: number; label: string };

function stepLabel(key: string, from: number, to: number): string {
  const s = SETTING_BY_KEY.get(key);
  return `${s ? s.label : key}: ${valueLabel(key, from)} → ${valueLabel(key, to)}`;
}

function makeStep(key: string, from: number, to: number): PlanStep {
  return { key, from, to, label: stepLabel(key, from, to) };
}

function resolvePreset(preset: TaskbarPreset | string): TaskbarPreset {
  if (typeof preset === 'string') return findPreset(preset);
  if (!isRecord(preset) || typeof preset.id !== 'string') throw new Error('Preset must be a preset object or id');
  const check = validatePresetValues(preset.values);
  if (!check.ok) throw new Error(`Invalid preset "${preset.id}": ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  return preset;
}

/** Ordered (TASKBAR_SETTINGS order) steps only for settings whose value would change. */
export function diffPreset(snapshot: TaskbarSnapshot, preset: TaskbarPreset | string): PlanStep[] {
  const p = resolvePreset(preset);
  const steps: PlanStep[] = [];
  for (const s of TASKBAR_SETTINGS) {
    if (!hasOwn(p.values, s.key)) continue;
    if (!hasOwn(snapshot.values, s.key)) throw new Error(`Snapshot is missing values.${s.key}`);
    const from = snapshot.values[s.key];
    const to = p.values[s.key];
    if (from !== to) steps.push(makeStep(s.key, from, to));
  }
  return steps;
}

export type TaskbarPlan = {
  presetId: string;
  createdAt: string;
  applySteps: PlanStep[];
  undoSteps: PlanStep[];
  explorerRestartRequired: boolean;
  requiresConfirmation: true;
  applied: false;
};

function invert(steps: PlanStep[]): PlanStep[] {
  return steps
    .slice()
    .reverse()
    .map((s) => makeStep(s.key, s.to, s.from));
}

function needsRestart(steps: PlanStep[]): boolean {
  return steps.some((s) => SETTING_BY_KEY.get(s.key)?.explorerRestart === true);
}

export function buildPlan(snapshot: TaskbarSnapshot, preset: TaskbarPreset | string, now: number | Date): TaskbarPlan {
  const createdAt = toIso(now);
  const p = resolvePreset(preset);
  const applySteps = diffPreset(snapshot, p);
  return {
    presetId: p.id,
    createdAt,
    applySteps,
    undoSteps: invert(applySteps),
    explorerRestartRequired: needsRestart(applySteps),
    requiresConfirmation: true,
    applied: false,
  };
}

export function serializePlan(plan: TaskbarPlan): string {
  const text = JSON.stringify(plan, null, 2);
  if (text.length > PLAN_MAX_CHARS) throw new Error(`Plan JSON exceeds ${PLAN_MAX_CHARS} characters`);
  return text;
}

function parseStep(raw: unknown, path: string): PlanStep {
  if (!isRecord(raw)) throw new Error(`${path}: step must be an object`);
  const { key, from, to } = raw;
  if (typeof key !== 'string' || !SETTING_BY_KEY.has(key)) throw new Error(`${path}.key: unknown setting ${JSON.stringify(key)}`);
  const s = SETTING_BY_KEY.get(key)!;
  for (const [name, v] of [['from', from], ['to', to]] as const) {
    if (typeof v !== 'number' || !Number.isInteger(v) || !s.allowed.includes(v)) throw new Error(`${path}.${name}: value ${JSON.stringify(v)} is not allowed for ${key}`);
  }
  if (from === to) throw new Error(`${path}: step does not change anything`);
  return makeStep(key, from as number, to as number);
}

/** Parses and fully validates plan JSON. Throws descriptive Errors for oversize, malformed or inconsistent plans. */
export function parsePlan(text: unknown): TaskbarPlan {
  if (typeof text !== 'string') throw new Error('Plan must be a JSON string');
  if (text.length > PLAN_MAX_CHARS) throw new Error(`Plan JSON exceeds ${PLAN_MAX_CHARS} characters`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Plan is not valid JSON');
  }
  if (!isRecord(raw)) throw new Error('plan: must be an object');
  if (typeof raw.presetId !== 'string') throw new Error('plan.presetId: must be a string');
  findPreset(raw.presetId);
  if (typeof raw.createdAt !== 'string' || Number.isNaN(Date.parse(raw.createdAt))) throw new Error('plan.createdAt: Invalid timestamp');
  const createdAt = new Date(Date.parse(raw.createdAt)).toISOString();
  if (!Array.isArray(raw.applySteps)) throw new Error('plan.applySteps: must be an array');
  if (!Array.isArray(raw.undoSteps)) throw new Error('plan.undoSteps: must be an array');
  const applySteps = raw.applySteps.map((s, i) => parseStep(s, `plan.applySteps[${i}]`));
  const undoSteps = raw.undoSteps.map((s, i) => parseStep(s, `plan.undoSteps[${i}]`));
  const seen = new Set<string>();
  let last = -1;
  for (const s of applySteps) {
    if (seen.has(s.key)) throw new Error(`plan.applySteps: duplicate setting ${s.key}`);
    seen.add(s.key);
    const idx = ORDER.get(s.key)!;
    if (idx < last) throw new Error('plan.applySteps: steps are out of order');
    last = idx;
  }
  const expectedUndo = invert(applySteps);
  if (
    undoSteps.length !== expectedUndo.length ||
    undoSteps.some((u, i) => u.key !== expectedUndo[i].key || u.from !== expectedUndo[i].from || u.to !== expectedUndo[i].to)
  ) {
    throw new Error('plan.undoSteps: must be the exact inverse of applySteps in reverse order');
  }
  if (raw.requiresConfirmation !== true) throw new Error('plan.requiresConfirmation: must be true');
  if (raw.applied !== false) throw new Error('plan.applied: must be false in this build');
  if (typeof raw.explorerRestartRequired !== 'boolean') throw new Error('plan.explorerRestartRequired: must be a boolean');
  if (raw.explorerRestartRequired !== needsRestart(applySteps)) throw new Error('plan.explorerRestartRequired: does not match the steps');
  return {
    presetId: raw.presetId,
    createdAt,
    applySteps,
    undoSteps: expectedUndo,
    explorerRestartRequired: raw.explorerRestartRequired,
    requiresConfirmation: true,
    applied: false,
  };
}
