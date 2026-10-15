/**
 * File Explorer and notification presets (roadmap 74) — preview and reversibility planning only.
 *
 * Pure, DOM-free data and helpers, independent of the taskbar presets module. Nothing here reads or writes Windows
 * settings: the "current" values come from the user typing them in, and a plan is only a description of steps plus
 * their exact inverse. Applying a plan is not available in this build pending the licence/safety gate G5, so every
 * plan carries applied:false and requiresConfirmation:true.
 */

export type ExplorerScope = 'explorer' | 'notifications';

export type ExplorerSetting = {
  /** Value name as documented for Windows 11. */
  key: string;
  label: string;
  scope: ExplorerScope;
  kind: 'dword';
  allowed: number[];
  /** Human label for every allowed value. */
  valueLabels: Record<number, string>;
  /** Windows 11 default value. */
  defaultValue: number;
  description: string;
  /** Registry path label (descriptive only; nothing is read from or written to it). */
  location: string;
  /** Whether File Explorer usually has to restart (or windows reopen) before the change shows. */
  explorerRestart: boolean;
};

const ADVANCED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const PUSH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications';
const NOTIF = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';
const DND = 'Settings > System > Notifications > Do not disturb / Focus (stored by Windows in CloudStore; label only)';

export const EXPLORER_SETTINGS: readonly ExplorerSetting[] = [
  {
    key: 'HideFileExt',
    label: 'Hide file name extensions',
    scope: 'explorer',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Show extensions', 1: 'Hide extensions' },
    defaultValue: 1,
    description: 'Whether known file extensions are hidden in File Explorer. Windows 11 default: 1 (Hide extensions).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'Hidden',
    label: 'Hidden files and folders',
    scope: 'explorer',
    kind: 'dword',
    allowed: [1, 2],
    valueLabels: { 1: 'Show', 2: "Don't show" },
    defaultValue: 2,
    description: 'Whether items marked hidden are shown. Windows 11 default: 2 (Don\'t show).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'ShowSuperHidden',
    label: 'Protected operating system files',
    scope: 'explorer',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Hidden', 1: 'Shown' },
    defaultValue: 0,
    description: 'Whether protected system files are shown. Windows 11 default: 0 (Hidden).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'LaunchTo',
    label: 'Open File Explorer to',
    scope: 'explorer',
    kind: 'dword',
    allowed: [1, 2, 3],
    valueLabels: { 1: 'This PC', 2: 'Home', 3: 'Downloads' },
    defaultValue: 2,
    description: 'The folder a new File Explorer window opens on. Windows 11 default: 2 (Home).',
    location: ADVANCED,
    explorerRestart: false,
  },
  {
    key: 'NavPaneShowAllFolders',
    label: 'Navigation pane: show all folders',
    scope: 'explorer',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 0,
    description: 'Shows every folder, including Control Panel and Recycle Bin, in the navigation pane. Windows 11 default: 0 (Off).',
    location: ADVANCED,
    explorerRestart: true,
  },
  {
    key: 'UseCompactMode',
    label: 'Compact view',
    scope: 'explorer',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 0,
    description: 'Reduces spacing between items in File Explorer. Windows 11 default: 0 (Off).',
    location: ADVANCED,
    explorerRestart: true,
  },
  {
    key: 'ToastEnabled',
    label: 'Notifications from apps',
    scope: 'notifications',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 1,
    description: 'Master switch for toast notifications. Windows 11 default: 1 (On).',
    location: PUSH,
    explorerRestart: false,
  },
  {
    key: 'NOC_GLOBAL_SETTING_TOASTS_ENABLED',
    label: 'Notification banners (global)',
    scope: 'notifications',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 1,
    description: 'Global notification centre toast setting; absent means on. Windows 11 default: 1 (On).',
    location: NOTIF,
    explorerRestart: false,
  },
  {
    key: 'NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK',
    label: 'Notifications on the lock screen',
    scope: 'notifications',
    kind: 'dword',
    allowed: [0, 1],
    valueLabels: { 0: 'Off', 1: 'On' },
    defaultValue: 1,
    description: 'Whether notifications can appear on the lock screen. Windows 11 default: 1 (On).',
    location: NOTIF,
    explorerRestart: false,
  },
  {
    key: 'FocusAssistMode',
    label: 'Quiet hours (Focus assist / Do not disturb)',
    scope: 'notifications',
    kind: 'dword',
    allowed: [0, 1, 2],
    valueLabels: { 0: 'Off', 1: 'Priority only', 2: 'Alarms only' },
    defaultValue: 0,
    description: 'Documented Focus assist levels. Windows keeps this in an opaque CloudStore blob, so it is modelled here as an enum label only. Windows 11 default: 0 (Off).',
    location: DND,
    explorerRestart: false,
  },
];

export type ExplorerPreset = {
  id: string;
  name: string;
  values: Record<string, number>;
  reversible: true;
  note: string;
};

export const EXPLORER_PRESETS: readonly ExplorerPreset[] = [
  {
    id: 'default-windows-11',
    name: 'Windows 11 defaults',
    values: {
      HideFileExt: 1,
      Hidden: 2,
      ShowSuperHidden: 0,
      LaunchTo: 2,
      NavPaneShowAllFolders: 0,
      UseCompactMode: 0,
      ToastEnabled: 1,
      NOC_GLOBAL_SETTING_TOASTS_ENABLED: 1,
      NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK: 1,
      FocusAssistMode: 0,
    },
    reversible: true,
    note: 'Returns every listed setting to the value a fresh Windows 11 install uses.',
  },
  {
    id: 'power-user-explorer',
    name: 'Power-user Explorer',
    values: { HideFileExt: 0, Hidden: 1, ShowSuperHidden: 1, LaunchTo: 1, NavPaneShowAllFolders: 1, UseCompactMode: 1 },
    reversible: true,
    note: 'Shows extensions, hidden and protected files, opens to This PC, shows all folders and uses compact view.',
  },
  {
    id: 'quiet-notifications',
    name: 'Quiet notifications',
    values: { ToastEnabled: 0, NOC_GLOBAL_SETTING_ALLOW_TOASTS_ABOVE_LOCK: 0, FocusAssistMode: 1 },
    reversible: true,
    note: 'Turns app toasts and lock-screen notifications off and sets quiet hours to priority only.',
  },
];

export type ValidationError = { path: string; message: string };
export type ValidationResult = { ok: boolean; errors: ValidationError[] };

const SETTING_BY_KEY = new Map(EXPLORER_SETTINGS.map((s) => [s.key, s]));
const ORDER = new Map(EXPLORER_SETTINGS.map((s, i) => [s.key, i]));

export const PLAN_MAX_CHARS = 20000;
export const EXPLORER_SNAPSHOT_PREF_KEY = 'customization.explorerSnapshot';
export const EXPLORER_SCOPES: readonly ExplorerScope[] = ['explorer', 'notifications'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function getSetting(key: string): ExplorerSetting | undefined {
  return SETTING_BY_KEY.get(key);
}

export function settingsByScope(scope: ExplorerScope): ExplorerSetting[] {
  return EXPLORER_SETTINGS.filter((s) => s.scope === scope);
}

export function valueLabel(key: string, value: number): string {
  const s = SETTING_BY_KEY.get(key);
  if (!s) return String(value);
  return s.valueLabels[value] ?? String(value);
}

/** Validates a partial key->value map against EXPLORER_SETTINGS. Error paths look like `values.HideFileExt`. */
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

export type ExplorerSnapshot = { capturedAt: string; values: Record<string, number> };

/** Builds a full snapshot from manually entered values. Every setting must be present with an allowed value. */
export function captureSnapshot(current: Record<string, number>, now: number | Date): ExplorerSnapshot {
  const capturedAt = toIso(now);
  const check = validatePresetValues(current);
  if (!check.ok) throw new Error(`Invalid snapshot: ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  const values: Record<string, number> = {};
  for (const s of EXPLORER_SETTINGS) {
    if (!hasOwn(current, s.key)) throw new Error(`Invalid snapshot: values.${s.key}: missing value`);
    values[s.key] = current[s.key];
  }
  return { capturedAt, values };
}

/** Windows 11 defaults for every setting, useful as the initial manual entry. */
export function defaultValues(): Record<string, number> {
  return Object.fromEntries(EXPLORER_SETTINGS.map((s) => [s.key, s.defaultValue]));
}

/** Keeps allowed stored values and fills anything missing or invalid with the Windows 11 default. */
export function normalizeManualValues(raw: unknown): Record<string, number> {
  const out = defaultValues();
  if (!isRecord(raw)) return out;
  for (const s of EXPLORER_SETTINGS) {
    const v = raw[s.key];
    if (typeof v === 'number' && Number.isInteger(v) && s.allowed.includes(v)) out[s.key] = v;
  }
  return out;
}

export function findPreset(id: string): ExplorerPreset {
  const p = EXPLORER_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown explorer preset id "${id}"`);
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

function resolvePreset(preset: ExplorerPreset | string): ExplorerPreset {
  if (typeof preset === 'string') return findPreset(preset);
  if (!isRecord(preset) || typeof preset.id !== 'string') throw new Error('Preset must be a preset object or id');
  const check = validatePresetValues(preset.values);
  if (!check.ok) throw new Error(`Invalid preset "${preset.id}": ${check.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  return preset;
}

/** Ordered (EXPLORER_SETTINGS order) steps only for settings whose value would change. */
export function diffPreset(snapshot: ExplorerSnapshot, preset: ExplorerPreset | string): PlanStep[] {
  const p = resolvePreset(preset);
  const steps: PlanStep[] = [];
  for (const s of EXPLORER_SETTINGS) {
    if (!hasOwn(p.values, s.key)) continue;
    if (!hasOwn(snapshot.values, s.key)) throw new Error(`Snapshot is missing values.${s.key}`);
    const from = snapshot.values[s.key];
    const to = p.values[s.key];
    if (from !== to) steps.push(makeStep(s.key, from, to));
  }
  return steps;
}

export type ExplorerPlan = {
  presetId: string;
  createdAt: string;
  applySteps: PlanStep[];
  undoSteps: PlanStep[];
  explorerRestartNeeded: boolean;
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

export function buildPlan(snapshot: ExplorerSnapshot, preset: ExplorerPreset | string, now: number | Date): ExplorerPlan {
  const createdAt = toIso(now);
  const p = resolvePreset(preset);
  const applySteps = diffPreset(snapshot, p);
  return {
    presetId: p.id,
    createdAt,
    applySteps,
    undoSteps: invert(applySteps),
    explorerRestartNeeded: needsRestart(applySteps),
    requiresConfirmation: true,
    applied: false,
  };
}

export function serializePlan(plan: ExplorerPlan): string {
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
export function parsePlan(text: unknown): ExplorerPlan {
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
  if (typeof raw.explorerRestartNeeded !== 'boolean') throw new Error('plan.explorerRestartNeeded: must be a boolean');
  if (raw.explorerRestartNeeded !== needsRestart(applySteps)) throw new Error('plan.explorerRestartNeeded: does not match the steps');
  return {
    presetId: raw.presetId,
    createdAt,
    applySteps,
    undoSteps: expectedUndo,
    explorerRestartNeeded: raw.explorerRestartNeeded,
    requiresConfirmation: true,
    applied: false,
  };
}
