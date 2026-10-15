// Local routine engine: stored multi-step workflows, schedules, bounded retries, duplicate prevention, pause/cancel,
// partial-result history, retry of unfinished steps, persisted schedule status with overdue recovery, bounded JSON
// import/export, and undo for explicitly reversible steps. No Electron import and no direct native access:
// storage, clock, timers, window snapshots, the trusted start confirmation and the action port are injected.
// Every action step goes through the action port (ActionService.preview + execute), so each sensitive step still
// raises the trusted native confirmation there. The engine never builds shell commands, never records input and
// never clicks. Runs interrupted by a restart are marked interrupted and never resumed automatically.
import type {ActionPreview, ActionRequest} from '../../src/shared/contracts';
import {MAX_ROUTINE_STEPS, MAX_WAIT_SECONDS, checkPlannedRequest, parseModelRoutine, planRoutineLines, type RoutinePlan, type RoutineStepCandidate} from './intent';

// src/shared/contracts.ts imports the planner result type from this module, so it is re-exported here.
export type {RoutinePlan, RoutineStepCandidate};

export const MAX_ROUTINES = 50;
export const MAX_RUN_HISTORY = 50;
export const MAX_RETRIES = 3;
export const MAX_RETRY_DELAY_SECONDS = 60;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 24 * 60;
/** A scheduled slot missed by less than this (app closed, machine asleep) still runs once; older slots are recorded as missed. */
export const SCHEDULE_GRACE_MS = 10 * 60_000;
export const MAX_TIMER_MS = 2_147_483_647;
export const STORE_VERSION = 1;
export const MAX_IMPORT_CHARS = 64 * 1024;
export const EXPORT_FORMAT = 'desktop-companion-routine';
const RETRYABLE_RUN: readonly string[] = ['failed', 'partial', 'declined', 'cancelled', 'interrupted'];
const MAX_COUNTED_SLOTS = 1000;

export type Schedule =
  | {kind: 'manual'}
  | {kind: 'once'; at: string}
  | {kind: 'daily'; time: string; days: number[]}
  | {kind: 'interval'; minutes: number};

export type StepCondition =
  | {kind: 'previous'; is: 'succeeded' | 'failed'}
  | {kind: 'window'; match: string; present: boolean}
  | {kind: 'weekday'; days: number[]}
  | {kind: 'time'; start: string; end: string};

type StepBase = {id: string; label: string; condition?: StepCondition};
export type ActionStep = StepBase & {kind: 'action'; request: ActionRequest; retries: number; retryDelaySeconds: number; onFailure: 'stop' | 'continue'; undoable: boolean};
export type WaitStep = StepBase & {kind: 'wait'; seconds: number};
export type RoutineStep = ActionStep | WaitStep;

export type Routine = {id: string; name: string; enabled: boolean; schedule: Schedule; steps: RoutineStep[]; createdAt: string; updatedAt: string};

export type StepStatus = 'pending' | 'succeeded' | 'failed' | 'blocked' | 'declined' | 'skipped' | 'cancelled';
export type UndoRecord = {request: ActionRequest; summary: string; undone: boolean; result?: string};
export type StepResult = {stepId: string; label: string; status: StepStatus; attempts: number; summary?: string; reason?: string; undo?: UndoRecord};
export type RunStatus = 'running' | 'paused' | 'succeeded' | 'partial' | 'failed' | 'declined' | 'cancelled' | 'interrupted' | 'missed' | 'skipped';
/** retryOf: id of the earlier run whose unfinished steps this run repeats. slot on a manual run: the missed slot it recovers. */
export type RunRecord = {id: string; routineId: string; routineName: string; trigger: 'manual' | 'schedule'; slot?: string; retryOf?: string; status: RunStatus; startedAt: string; endedAt?: string; reason?: string; steps: StepResult[]};

/** Persisted per-routine scheduling facts, so overdue state and counters survive restarts. */
export type ScheduleState = {lastSlot?: string; lastRunId?: string; lastRunAt?: string; lastResult?: RunStatus; missedCount: number; overdueSlot?: string; overdueReason?: string};
export type ScheduleStatusKind = 'manual' | 'disabled' | 'paused' | 'running' | 'overdue' | 'completed' | 'scheduled';
export type RoutineScheduleStatus = ScheduleState & {state: ScheduleStatusKind; nextDueAt: string | null};

export type RoutineGate = {id: number; name: string; available: boolean; reason: string};
/** Honest status of the roadmap items this module does not implement. */
export const ROUTINE_GATES: readonly RoutineGate[] = [
  {id: 88, name: 'Selected file/browser action adapters', available: false, reason: 'Routines can launch approved apps/files and open links through the action service. Richer file and browser adapters wait for the input-injection gate (G4).'},
  {id: 89, name: 'Watch-once routine recording', available: false, reason: 'Not implemented: there is no keyboard or mouse recording. Requires the input-injection gate (G4) and a consented capture design.'},
  {id: 90, name: 'Cross-app semantic drag-to-action workflows', available: false, reason: 'Not implemented: no drag capture or semantic understanding of dragged content. Requires the input-injection gate (G4).'},
];

/** slots: last consumed (or schedule-start) instant per routine, persisted so a slot never runs twice. anchors: interval origin. */
export type RoutineData = {version: number; paused: boolean; routines: Routine[]; runs: RunRecord[]; slots: Record<string, number>; anchors: Record<string, number>; status: Record<string, ScheduleState>};

export interface RoutineStorage {
  load(): Promise<unknown>;
  save(data: RoutineData): Promise<void>;
}

/** Narrow view of ActionService. Captain wires preview → ActionService.preview, execute → ActionService.execute. */
export interface RoutineActionPort {
  preview(req: ActionRequest): Promise<ActionPreview>;
  execute(previewId: string, approved: boolean): Promise<unknown>;
}

export type RoutineWindow = {hwnd: number; pid: number; title: string; process: string; x: number; y: number; width: number; height: number};
export type TimerHandle = {unref?: () => unknown} | number;

export interface RoutineDeps {
  storage: RoutineStorage;
  actions: RoutineActionPort;
  now: () => number;
  newId: () => string;
  /** Read-only window snapshot (native.listWindows). Needed for window conditions and undoable moves. */
  windows?: () => Promise<readonly RoutineWindow[]>;
  /** Trusted main-process dialog (BackendEnv.confirm). Scheduled runs need it before starting; missing means no run. */
  confirm?: (summary: string, detail: string) => Promise<boolean>;
  activity?: (kind: string, summary: string, details?: string) => Promise<unknown>;
  safeLaunch?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  /** Cancellable delay used for wait steps and retry delays. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class RoutineError extends Error {}

const clip = (s: string, n = 300) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const iso = (ms: number) => new Date(ms).toISOString();
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new RoutineError(`${what} must be an object`);
  return v as Record<string, unknown>;
}
function onlyKeys(o: Record<string, unknown>, keys: string[], what: string) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new RoutineError(`${what}: field "${clip(k, 30)}" is not allowed`);
}
function text(v: unknown, what: string, max: number, required = true): string {
  if (v === undefined && !required) return '';
  if (typeof v !== 'string') throw new RoutineError(`${what} must be text`);
  const t = v.trim();
  if (required && !t) throw new RoutineError(`${what} is required`);
  if (t.length > max) throw new RoutineError(`${what} is too long (max ${max})`);
  if (CONTROL_RE.test(t)) throw new RoutineError(`${what} contains control characters`);
  return t;
}
function int(v: unknown, what: string, min: number, max: number, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new RoutineError(`${what} must be a whole number from ${min} to ${max}`);
  return v;
}
function days(v: unknown, what: string): number[] {
  if (v === undefined) return [0, 1, 2, 3, 4, 5, 6];
  if (!Array.isArray(v) || !v.length || v.length > 7) throw new RoutineError(`${what} must list 1 to 7 weekdays`);
  const set = new Set(v.map((d) => int(d, `${what} entry`, 0, 6)));
  return [...set].sort((a, b) => a - b);
}
function hhmm(v: unknown, what: string): string {
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw new RoutineError(`${what} must be a 24-hour time like 08:30`);
  return v;
}

export function validateSchedule(raw: unknown): Schedule {
  const o = obj(raw ?? {kind: 'manual'}, 'schedule');
  switch (o.kind) {
    case 'manual': onlyKeys(o, ['kind'], 'schedule'); return {kind: 'manual'};
    case 'once': {
      onlyKeys(o, ['kind', 'at'], 'schedule');
      const t = typeof o.at === 'string' ? Date.parse(o.at) : NaN;
      if (!Number.isFinite(t)) throw new RoutineError('schedule.at must be a date and time');
      return {kind: 'once', at: iso(t)};
    }
    case 'daily': onlyKeys(o, ['kind', 'time', 'days'], 'schedule'); return {kind: 'daily', time: hhmm(o.time, 'schedule.time'), days: days(o.days, 'schedule.days')};
    case 'interval': onlyKeys(o, ['kind', 'minutes'], 'schedule'); return {kind: 'interval', minutes: int(o.minutes, 'schedule.minutes', MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES)};
    default: throw new RoutineError('schedule.kind must be manual, once, daily or interval');
  }
}

function validateCondition(raw: unknown): StepCondition | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = obj(raw, 'condition');
  switch (o.kind) {
    case 'previous':
      onlyKeys(o, ['kind', 'is'], 'condition');
      if (o.is !== 'succeeded' && o.is !== 'failed') throw new RoutineError('condition.is must be succeeded or failed');
      return {kind: 'previous', is: o.is};
    case 'window':
      onlyKeys(o, ['kind', 'match', 'present'], 'condition');
      if (typeof o.present !== 'boolean') throw new RoutineError('condition.present must be true or false');
      return {kind: 'window', match: text(o.match, 'condition.match', 260), present: o.present};
    case 'weekday': onlyKeys(o, ['kind', 'days'], 'condition'); return {kind: 'weekday', days: days(o.days, 'condition.days')};
    case 'time': onlyKeys(o, ['kind', 'start', 'end'], 'condition'); return {kind: 'time', start: hhmm(o.start, 'condition.start'), end: hhmm(o.end, 'condition.end')};
    default: throw new RoutineError('condition.kind must be previous, window, weekday or time');
  }
}

/** Validates one step. Action requests are re-planned with the intent rules, so clicks, shell strings and unknown fields never get stored. */
export function validateStep(raw: unknown, index: number, newId: () => string): RoutineStep {
  const o = obj(raw, `Step ${index}`);
  const what = `Step ${index}`;
  const id = o.id === undefined ? newId() : typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : (() => { throw new RoutineError(`${what}: id is invalid`); })();
  const condition = validateCondition(o.condition);
  const withCond = <T extends object>(s: T) => (condition ? {...s, condition} : s);
  if (o.kind === 'wait') {
    onlyKeys(o, ['id', 'kind', 'label', 'seconds', 'condition'], what);
    const seconds = int(o.seconds, `${what} seconds`, 1, MAX_WAIT_SECONDS);
    return withCond({id, kind: 'wait' as const, label: text(o.label, `${what} label`, 80, false) || `Wait ${seconds} s`, seconds});
  }
  if (o.kind === 'record' || o.kind === 'drag') throw new RoutineError(`${what}: ${o.kind === 'record' ? 'recording' : 'semantic drag'} steps are not available (gate G4)`);
  if (o.kind !== 'action') throw new RoutineError(`${what}: kind must be action or wait`);
  onlyKeys(o, ['id', 'kind', 'label', 'request', 'retries', 'retryDelaySeconds', 'onFailure', 'undoable', 'condition'], what);
  const plan = checkPlannedRequest(o.request);
  if (plan.status === 'blocked') throw new RoutineError(`${what}: ${plan.reason}`);
  if (plan.status === 'clarify') throw new RoutineError(`${what}: ${plan.question}`);
  const onFailure = o.onFailure === undefined ? 'stop' : o.onFailure;
  if (onFailure !== 'stop' && onFailure !== 'continue') throw new RoutineError(`${what}: onFailure must be stop or continue`);
  if (o.undoable !== undefined && typeof o.undoable !== 'boolean') throw new RoutineError(`${what}: undoable must be true or false`);
  const undoable = o.undoable === true;
  if (undoable && plan.request.type !== 'move-window') throw new RoutineError(`${what}: only window moves can be undone; ${plan.request.type} is not reversible`);
  return withCond({
    id, kind: 'action' as const, label: text(o.label, `${what} label`, 80, false) || clip(plan.summary, 80), request: plan.request,
    retries: int(o.retries, `${what} retries`, 0, MAX_RETRIES, 0), retryDelaySeconds: int(o.retryDelaySeconds, `${what} retry delay`, 0, MAX_RETRY_DELAY_SECONDS, 5),
    onFailure, undoable,
  });
}

/** Validates an editor draft or stored routine. Unknown fields, duplicate step ids and gated step kinds are refused. */
export function validateRoutine(raw: unknown, newId: () => string, nowMs: number, existing?: Routine): Routine {
  const o = obj(raw, 'routine');
  onlyKeys(o, ['id', 'name', 'enabled', 'schedule', 'steps', 'createdAt', 'updatedAt'], 'routine');
  if (!Array.isArray(o.steps) || !o.steps.length) throw new RoutineError('A routine needs at least one step');
  if (o.steps.length > MAX_ROUTINE_STEPS) throw new RoutineError(`A routine can have at most ${MAX_ROUTINE_STEPS} steps`);
  const steps = o.steps.map((s, i) => validateStep(s, i + 1, newId));
  const ids = new Set<string>();
  for (const s of steps) { if (ids.has(s.id)) throw new RoutineError(`Duplicate step id "${s.id}"`); ids.add(s.id); }
  if (steps[0].condition?.kind === 'previous') throw new RoutineError('Step 1 cannot depend on a previous step');
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw new RoutineError('enabled must be true or false');
  return {
    id: existing?.id ?? newId(), name: text(o.name, 'Name', 80), enabled: o.enabled !== false, schedule: validateSchedule(o.schedule), steps,
    createdAt: existing?.createdAt ?? iso(nowMs), updatedAt: iso(nowMs),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Import / export. A routine file is data, never code: bounded size, strict fields, the same step validation as the
// editor (action types, URL rules, no clicks or recordings, at most MAX_ROUTINE_STEPS steps). Imports never carry ids,
// schedules or the enabled flag; the user reviews the steps in the editor and chooses a schedule there.

export type RoutineImport =
  | {status: 'ready'; routine: {name: string; enabled: false; schedule: {kind: 'manual'}; steps: RoutineStep[]}; warnings: string[]}
  | {status: 'blocked'; reason: string};

/** Portable JSON for one routine: name, schedule and steps only. */
export function exportRoutine(r: Routine): string {
  const steps = r.steps.map((s) => { const {id: _id, ...rest} = s; return rest; });
  return JSON.stringify({format: EXPORT_FORMAT, version: 1, routine: {name: r.name, schedule: r.schedule, steps}}, null, 2);
}

function stepWarning(s: RoutineStep, i: number): string | null {
  if (s.kind !== 'action') return null;
  const t = s.request.target ? clip(s.request.target, 80) : '';
  switch (s.request.type) {
    case 'open-url': return `Step ${i + 1} opens ${t}`;
    case 'launch': return `Step ${i + 1} launches ${t} (only apps you approved in settings can start)`;
    case 'type-text': return `Step ${i + 1} types text into the window "${t}"`;
    case 'move-window': return `Step ${i + 1} moves the window "${t}"`;
    default: return null;
  }
}

export function parseRoutineImport(input: unknown, newId: () => string): RoutineImport {
  const blocked = (reason: string): RoutineImport => ({status: 'blocked', reason});
  if (typeof input !== 'string' || !input.trim()) return blocked('Paste the routine file text first');
  if (input.length > MAX_IMPORT_CHARS) return blocked(`The routine file is too large (max ${MAX_IMPORT_CHARS / 1024} KB)`);
  let json: unknown;
  try { json = JSON.parse(input); } catch { return blocked('The text is not valid JSON'); }
  try {
    const o = obj(json, 'routine file');
    onlyKeys(o, ['format', 'version', 'routine'], 'routine file');
    if (o.format !== EXPORT_FORMAT) throw new RoutineError('This is not a routine file from this app');
    if (o.version !== 1) throw new RoutineError('Unsupported routine file version');
    const r = obj(o.routine, 'routine');
    onlyKeys(r, ['name', 'schedule', 'steps'], 'routine');
    if (!Array.isArray(r.steps) || !r.steps.length) throw new RoutineError('A routine needs at least one step');
    if (r.steps.length > MAX_ROUTINE_STEPS) throw new RoutineError(`A routine can have at most ${MAX_ROUTINE_STEPS} steps`);
    const schedule = validateSchedule(r.schedule);
    const steps = r.steps.map((raw, i) => {
      const so = {...obj(raw, `Step ${i + 1}`)};
      delete so.id;
      return validateStep(so, i + 1, newId);
    });
    if (steps[0].condition?.kind === 'previous') throw new RoutineError('Step 1 cannot depend on a previous step');
    const warnings = steps.map(stepWarning).filter((w): w is string => w !== null);
    if (schedule.kind !== 'manual') warnings.push('The schedule was not imported. Choose one in the editor after reviewing the steps.');
    warnings.push('The routine is saved disabled. Each desktop step still asks for confirmation when it runs.');
    return {status: 'ready', routine: {name: text(r.name, 'Name', 80), enabled: false, schedule: {kind: 'manual'}, steps}, warnings};
  } catch (e) {
    return blocked(e instanceof RoutineError ? e.message : 'The routine file is invalid');
  }
}
// ---------------------------------------------------------------------------------------------------------------
// Schedule math (local time). Pure, so tests compute expected instants with the same Date constructor.

const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const atLocal = (base: Date, dayOffset: number, time: string) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, Number(time.slice(0, 2)), Number(time.slice(3, 5)), 0, 0).getTime();

/** First scheduled instant strictly after `after`, or null. Interval slots are anchored to `anchor`. */
export function nextSlot(s: Schedule, after: number, anchor: number): number | null {
  switch (s.kind) {
    case 'manual': return null;
    case 'once': { const t = Date.parse(s.at); return t > after ? t : null; }
    case 'interval': {
      const step = s.minutes * 60_000;
      if (after < anchor) return anchor + step;
      return anchor + (Math.floor((after - anchor) / step) + 1) * step;
    }
    case 'daily': {
      const base = new Date(after);
      for (let d = 0; d <= 8; d++) {
        const t = atLocal(base, d, s.time);
        if (t > after && s.days.includes(new Date(t).getDay())) return t;
      }
      return null;
    }
  }
}

/** Latest scheduled instant at or before `now` and strictly after `since`, or null. */
export function latestSlot(s: Schedule, now: number, since: number, anchor: number): number | null {
  let t: number | null = null;
  switch (s.kind) {
    case 'manual': return null;
    case 'once': t = Date.parse(s.at); break;
    case 'interval': {
      const step = s.minutes * 60_000;
      t = now < anchor + step ? null : anchor + Math.floor((now - anchor) / step) * step;
      break;
    }
    case 'daily': {
      const base = new Date(now);
      for (let d = 0; d >= -8; d--) {
        const c = atLocal(base, d, s.time);
        if (c <= now && s.days.includes(new Date(c).getDay())) { t = c; break; }
      }
    }
  }
  return t !== null && t <= now && t > since ? t : null;
}

/** Number of scheduled instants in (since, upTo], capped so a long absence stays cheap. */
export function countSlots(s: Schedule, since: number, upTo: number, anchor: number): number {
  let n = 0;
  let cursor = since;
  while (n < MAX_COUNTED_SLOTS) {
    const t = nextSlot(s, cursor, anchor);
    if (t === null || t > upTo) break;
    n++;
    cursor = t;
  }
  return n;
}

export function inTimeWindow(c: Extract<StepCondition, {kind: 'time'}>, at: number): boolean {
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  const a = minutesOf(c.start), b = minutesOf(c.end);
  return a <= b ? m >= a && m < b : m >= a || m < b; // windows may wrap midnight
}

// ---------------------------------------------------------------------------------------------------------------
// Engine

export type RoutineView = Routine & {nextDueAt: string | null; scheduleStatus: RoutineScheduleStatus};
export type RoutinesView = {paused: boolean; routines: RoutineView[]; runs: RunRecord[]; activeRunId: string | null; gates: readonly RoutineGate[]; loadError?: string; saveError?: string};
export type UndoOutcome = {run: RunRecord; undone: number; failed: number; reason?: string};

const RUN_STATUSES: readonly RunStatus[] = ['running', 'paused', 'succeeded', 'partial', 'failed', 'declined', 'cancelled', 'interrupted', 'missed', 'skipped'];
const STEP_STATUSES: readonly StepStatus[] = ['pending', 'succeeded', 'failed', 'blocked', 'declined', 'skipped', 'cancelled'];
const DECLINED_RE = /^not approved$|confirmation declined/i;
const FINAL_RE = /rate limit|policy changed|not allowed|safe launch|stale preview|changed since|unknown, expired/i;

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done);
});

/** Restores a stored run record defensively; malformed records are dropped. */
function loadRun(raw: unknown): RunRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, n = 300) => (typeof v === 'string' ? clip(v, n) : undefined);
  if (!s(r.id) || !s(r.routineId) || !RUN_STATUSES.includes(r.status as RunStatus) || !Array.isArray(r.steps)) return null;
  const steps: StepResult[] = [];
  for (const x of r.steps.slice(0, MAX_ROUTINE_STEPS)) {
    if (typeof x !== 'object' || x === null) return null;
    const st = x as Record<string, unknown>;
    if (!s(st.stepId) || !STEP_STATUSES.includes(st.status as StepStatus)) return null;
    const res: StepResult = {stepId: s(st.stepId)!, label: s(st.label, 80) ?? '', status: st.status as StepStatus, attempts: typeof st.attempts === 'number' ? Math.min(MAX_RETRIES + 1, Math.max(0, Math.floor(st.attempts))) : 0};
    if (s(st.summary)) res.summary = s(st.summary);
    if (s(st.reason)) res.reason = s(st.reason);
    const u = st.undo as Record<string, unknown> | undefined;
    if (u && typeof u === 'object') {
      const plan = checkPlannedRequest(u.request);
      if (plan.status === 'ready' && plan.request.type === 'move-window') res.undo = {request: plan.request, summary: s(u.summary) ?? '', undone: u.undone === true, ...(s(u.result) ? {result: s(u.result)} : {})};
    }
    steps.push(res);
  }
  const run: RunRecord = {id: s(r.id)!, routineId: s(r.routineId)!, routineName: s(r.routineName, 80) ?? '', trigger: r.trigger === 'schedule' ? 'schedule' : 'manual', status: r.status as RunStatus, startedAt: s(r.startedAt) ?? '', steps};
  if (s(r.slot)) run.slot = s(r.slot);
  if (s(r.retryOf)) run.retryOf = s(r.retryOf);
  if (s(r.endedAt)) run.endedAt = s(r.endedAt);
  if (s(r.reason)) run.reason = s(r.reason);
  return run;
}

/** Restores persisted schedule status defensively; unknown routines and malformed fields are dropped. */
function loadStatus(raw: unknown, routines: readonly Routine[]): Record<string, ScheduleState> {
  const out: Record<string, ScheduleState> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const date = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? clip(v, 40) : undefined);
  for (const [id, v] of Object.entries(raw)) {
    if (!routines.some((r) => r.id === id) || typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    const st: ScheduleState = {missedCount: typeof o.missedCount === 'number' && Number.isFinite(o.missedCount) ? Math.min(100_000, Math.max(0, Math.floor(o.missedCount))) : 0};
    const lastSlot = date(o.lastSlot), lastRunAt = date(o.lastRunAt), overdueSlot = date(o.overdueSlot);
    if (lastSlot) st.lastSlot = lastSlot;
    if (lastRunAt) st.lastRunAt = lastRunAt;
    if (typeof o.lastRunId === 'string' && ID_RE.test(o.lastRunId)) st.lastRunId = o.lastRunId;
    if (RUN_STATUSES.includes(o.lastResult as RunStatus)) st.lastResult = o.lastResult as RunStatus;
    if (overdueSlot) { st.overdueSlot = overdueSlot; if (typeof o.overdueReason === 'string') st.overdueReason = clip(o.overdueReason, 200); }
    out[id] = st;
  }
  return out;
}

function finalStatus(steps: StepResult[], cancelled: boolean): RunStatus {
  if (cancelled) return 'cancelled';
  const ok = steps.some((s) => s.status === 'succeeded');
  if (steps.some((s) => s.status === 'declined')) return ok ? 'partial' : 'declined';
  if (steps.some((s) => s.status === 'failed' || s.status === 'blocked')) return ok ? 'partial' : 'failed';
  return 'succeeded';
}

type Active = {run: RunRecord; abort: AbortController; wake: (() => void) | null; done: Promise<RunRecord>};

export class RoutineEngine {
  private data: RoutineData = {version: STORE_VERSION, paused: false, routines: [], runs: [], slots: {}, anchors: {}, status: {}};
  private active: Active | null = null;
  private undoing = false;
  private timer: TimerHandle | null = null;
  private writing: Promise<void> = Promise.resolve();
  private disposed = false;
  private loadError?: string;
  private saveError?: string;
  private setTimer: NonNullable<RoutineDeps['setTimer']>;
  private clearTimer: NonNullable<RoutineDeps['clearTimer']>;
  private sleep: NonNullable<RoutineDeps['sleep']>;

  constructor(private d: RoutineDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.sleep = d.sleep ?? defaultSleep;
  }

  /** Loads stored routines, marks runs interrupted by a restart, handles slots due while closed, and arms the timer. */
  async init(): Promise<RoutinesView> {
    let raw: unknown;
    try { raw = await this.d.storage.load(); } catch (e) { raw = null; this.loadError = `Stored routines could not be read: ${clip((e as Error).message, 200)}`; }
    const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    let dropped = 0;
    const routines: Routine[] = [];
    for (const r of Array.isArray(o.routines) ? o.routines.slice(0, MAX_ROUTINES) : []) {
      try {
        const src = r as Partial<Routine>;
        const v = validateRoutine(r, this.d.newId, this.d.now(), typeof src.id === 'string' && ID_RE.test(src.id) ? (r as Routine) : undefined);
        if (typeof src.updatedAt === 'string' && Number.isFinite(Date.parse(src.updatedAt))) v.updatedAt = src.updatedAt;
        if (!routines.some((x) => x.id === v.id)) routines.push(v);
      } catch { dropped++; }
    }
    if (dropped) this.loadError = `${dropped} stored routine${dropped === 1 ? ' was' : 's were'} invalid and not loaded`;
    const runs = (Array.isArray(o.runs) ? o.runs : []).slice(0, MAX_RUN_HISTORY).map(loadRun).filter((r): r is RunRecord => r !== null);
    for (const run of runs) {
      if (run.status !== 'running' && run.status !== 'paused') continue;
      run.status = 'interrupted';
      run.reason = 'The app closed during this run; it was not resumed';
      run.endedAt ??= iso(this.d.now());
      for (const s of run.steps) if (s.status === 'pending') { s.status = 'cancelled'; s.reason = 'Not run (app closed)'; }
    }
    const nums = (v: unknown) => {
      const out: Record<string, number> = {};
      if (typeof v === 'object' && v !== null) for (const [k, n] of Object.entries(v)) if (routines.some((r) => r.id === k) && typeof n === 'number' && Number.isFinite(n)) out[k] = n;
      return out;
    };
    this.data = {version: STORE_VERSION, paused: o.paused === true, routines, runs, slots: nums(o.slots), anchors: nums(o.anchors), status: loadStatus(o.status, routines)};
    const now = this.d.now();
    for (const r of routines) { this.data.slots[r.id] ??= now; this.data.anchors[r.id] ??= now; this.st(r.id); }
    for (const run of runs) if (run.status === 'interrupted' && this.data.status[run.routineId]?.lastRunId === run.id) this.data.status[run.routineId].lastResult = 'interrupted';
    await this.persist();
    await this.fire();
    return this.view();
  }

  view(): RoutinesView {
    const now = this.d.now();
    const v: RoutinesView = {
      paused: this.data.paused,
      routines: this.data.routines.map((r) => {
        const next = r.enabled && !this.data.paused ? nextSlot(r.schedule, Math.max(now, this.data.slots[r.id] ?? now), this.data.anchors[r.id] ?? now) : null;
        const nextDueAt = next === null ? null : iso(next);
        return {...structuredClone(r), nextDueAt, scheduleStatus: this.scheduleStatus(r, nextDueAt)};
      }),
      runs: structuredClone(this.data.runs),
      activeRunId: this.active?.run.id ?? null,
      gates: ROUTINE_GATES,
    };
    if (this.loadError) v.loadError = this.loadError;
    if (this.saveError) v.saveError = this.saveError;
    return v;
  }

  private st(id: string): ScheduleState { return (this.data.status[id] ??= {missedCount: 0}); }

  private scheduleStatus(r: Routine, nextDueAt: string | null): RoutineScheduleStatus {
    const st = this.st(r.id);
    let state: ScheduleStatusKind;
    if (r.schedule.kind === 'manual') state = 'manual';
    else if (!r.enabled) state = 'disabled';
    else if (this.active?.run.routineId === r.id) state = 'running';
    else if (this.data.paused) state = 'paused';
    else if (st.overdueSlot) state = 'overdue';
    else if (r.schedule.kind === 'once' && nextDueAt === null) state = 'completed';
    else state = 'scheduled';
    return {...st, state, nextDueAt};
  }

  private find(id: unknown): Routine {
    const r = typeof id === 'string' ? this.data.routines.find((x) => x.id === id) : undefined;
    if (!r) throw new RoutineError('Routine not found');
    return r;
  }

  /** Creates or updates a routine from an editor draft. A new or changed schedule only counts slots after this save. */
  async save(raw: unknown): Promise<RoutinesView> {
    const id = (raw as {id?: unknown} | null)?.id;
    const existing = id === undefined ? undefined : this.data.routines.find((r) => r.id === id);
    if (id !== undefined && !existing) throw new RoutineError('Routine not found');
    if (!existing && this.data.routines.length >= MAX_ROUTINES) throw new RoutineError(`At most ${MAX_ROUTINES} routines`);
    const r = validateRoutine(raw, this.d.newId, this.d.now(), existing);
    const now = this.d.now();
    if (!existing || JSON.stringify(existing.schedule) !== JSON.stringify(r.schedule) || (!existing.enabled && r.enabled)) {
      this.data.slots[r.id] = now;
      this.data.anchors[r.id] = now;
      const st = this.st(r.id);
      delete st.overdueSlot;
      delete st.overdueReason;
    }
    this.data.routines = existing ? this.data.routines.map((x) => (x.id === r.id ? r : x)) : [...this.data.routines, r];
    await this.persist();
    this.schedule();
    return this.view();
  }

  async remove(id: unknown): Promise<RoutinesView> {
    const r = this.find(id);
    if (this.active?.run.routineId === r.id) throw new RoutineError('Cancel the running routine before deleting it');
    this.data.routines = this.data.routines.filter((x) => x.id !== r.id);
    delete this.data.slots[r.id];
    delete this.data.anchors[r.id];
    delete this.data.status[r.id];
    await this.persist();
    this.schedule();
    return this.view();
  }

  /** Global pause: no schedules fire and a running routine stops before its next step until resumed or cancelled. */
  async pauseAll(): Promise<RoutinesView> {
    this.data.paused = true;
    await this.persist();
    this.schedule();
    await this.d.activity?.('routine', 'Routines paused');
    return this.view();
  }

  /** Resumes. Slots that came due while paused are skipped, never run in a burst. */
  async resumeAll(): Promise<RoutinesView> {
    this.data.paused = false;
    const now = this.d.now();
    for (const r of this.data.routines) {
      const prev = this.data.slots[r.id] ?? now;
      if (r.enabled) {
        const slot = latestSlot(r.schedule, now, prev, this.data.anchors[r.id] ?? now);
        if (slot !== null) this.markOverdue(r, prev, slot, 'Routines were paused at the scheduled time');
      }
      this.data.slots[r.id] = Math.max(prev, now);
    }
    this.active?.wake?.();
    await this.persist();
    this.schedule();
    await this.d.activity?.('routine', 'Routines resumed');
    return this.view();
  }

  /** Requests cancellation. Takes effect before the next step or retry; an open native confirmation is not dismissed. */
  async cancel(runId: unknown): Promise<RoutinesView> {
    if (!this.active || this.active.run.id !== runId) throw new RoutineError('That run is not active');
    this.active.abort.abort();
    this.active.wake?.();
    return this.view();
  }

  /** Records a slot that did not run. It stays overdue (recoverable by the user) until a run starts, it is dismissed or the schedule changes. */
  private markOverdue(r: Routine, prev: number, slot: number, reason: string, run = true) {
    const st = this.st(r.id);
    st.missedCount += Math.max(1, countSlots(r.schedule, prev, slot, this.data.anchors[r.id] ?? slot));
    st.overdueSlot = iso(slot);
    st.overdueReason = reason;
    if (run) this.pushRun({id: this.d.newId(), routineId: r.id, routineName: r.name, trigger: 'schedule', slot: iso(slot), status: 'skipped', startedAt: iso(this.d.now()), endedAt: iso(this.d.now()), reason, steps: []});
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.writing = this.writing.then(() => this.d.storage.save(snapshot)).then(
      () => { this.saveError = undefined; },
      (e) => { this.saveError = `Routines could not be saved: ${clip((e as Error).message, 200)}`; },
    );
    await this.writing;
  }

  private pushRun(run: RunRecord) {
    this.data.runs.unshift(run);
    if (this.data.runs.length > MAX_RUN_HISTORY) this.data.runs.length = MAX_RUN_HISTORY;
  }

  get armed(): boolean { return this.timer !== null; }

  private schedule(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (this.disposed || this.data.paused) return;
    const now = this.d.now();
    let best: number | null = null;
    for (const r of this.data.routines) {
      if (!r.enabled) continue;
      const t = nextSlot(r.schedule, Math.max(now, this.data.slots[r.id] ?? now), this.data.anchors[r.id] ?? now);
      if (t !== null && (best === null || t < best)) best = t;
    }
    if (best === null) return;
    const h = this.setTimer(() => { void this.fire(); }, Math.min(MAX_TIMER_MS, Math.max(0, best - now)));
    if (typeof h === 'object' && typeof h.unref === 'function') h.unref();
    this.timer = h;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.active?.abort.abort();
    this.active?.wake?.();
  }

  /**
   * Timer callback; also callable directly. Each routine's latest due slot is consumed (and persisted) before anything
   * runs, so a slot never runs twice, even across restarts. Slots older than the grace window are recorded as missed.
   * A scheduled start needs the trusted confirmation; then every sensitive step still gets its own action confirmation.
   */
  async fire(): Promise<number> {
    this.timer = null;
    if (this.disposed) return 0;
    if (this.data.paused) { this.schedule(); return 0; }
    const now = this.d.now();
    const due: {r: Routine; slot: number; prev: number}[] = [];
    for (const r of this.data.routines) {
      if (!r.enabled) continue;
      const prev = this.data.slots[r.id] ?? now;
      const slot = latestSlot(r.schedule, now, prev, this.data.anchors[r.id] ?? now);
      if (slot === null) continue;
      this.data.slots[r.id] = slot;
      this.st(r.id).lastSlot = iso(slot);
      due.push({r, slot, prev});
    }
    if (!due.length) { this.schedule(); return 0; }
    const record = (r: Routine, slot: number, status: RunStatus, reason: string) =>
      this.pushRun({id: this.d.newId(), routineId: r.id, routineName: r.name, trigger: 'schedule', slot: iso(slot), status, startedAt: iso(now), endedAt: iso(now), reason, steps: []});
    const runnable: {r: Routine; slot: number}[] = [];
    const overdue = (x: {r: Routine; slot: number; prev: number}, status: 'missed' | 'skipped', reason: string) => {
      record(x.r, x.slot, status, reason);
      this.markOverdue(x.r, x.prev, x.slot, reason, false);
    };
    for (const x of due) {
      if (now - x.slot > SCHEDULE_GRACE_MS) overdue(x, 'missed', 'The app was closed or asleep at the scheduled time');
      else if (this.active || this.undoing || runnable.length) overdue(x, 'skipped', 'Another routine was running; routines never overlap');
      else if (this.d.safeLaunch?.()) overdue(x, 'skipped', 'Safe launch is active');
      else runnable.push(x);
    }
    await this.persist();
    this.schedule();
    let started = 0;
    for (const {r, slot} of runnable) {
      const prev = this.data.slots[r.id] ?? slot;
      const ok = this.d.confirm ? await this.d.confirm(`Run routine "${r.name}" now?`, this.describe(r)).catch(() => false) : false;
      if (this.active || this.undoing || this.disposed || this.data.paused) { record(r, slot, 'skipped', 'Another routine started or routines were paused'); this.markOverdue(r, prev, slot, 'Another routine started or routines were paused', false); await this.persist(); continue; }
      if (!ok) {
        record(r, slot, 'declined', this.d.confirm ? 'Scheduled start was declined in the native confirmation' : 'No trusted confirmation is available, so scheduled runs cannot start');
        await this.persist();
        continue;
      }
      this.begin(r, 'schedule', slot);
      started++;
    }
    return started;
  }

  /** Full step list for the trusted start confirmation. */
  describe(r: Routine): string {
    const lines = r.steps.map((s, i) => `${i + 1}. ${s.kind === 'wait' ? `Wait ${s.seconds} s` : `${s.label} [${s.request.type}${s.request.target ? ` → ${s.request.target}` : ''}]`}${s.condition ? ' (conditional)' : ''}`);
    return `Routine: ${r.name}\n${lines.join('\n')}\n\nEach desktop action asks for its own confirmation before it runs.`;
  }

  /** Shared start guards: duplicates, overlap, global pause and safe launch. */
  private assertCanStart(r: Routine) {
    if (this.active?.run.routineId === r.id) throw new RoutineError('This routine is already running');
    if (this.active || this.undoing) throw new RoutineError('Another routine is running; routines never overlap so confirmations stay clear');
    if (this.data.paused) throw new RoutineError('Routines are paused. Resume them first.');
    if (this.d.safeLaunch?.()) throw new RoutineError('Safe launch is active: routines are disabled');
  }

  /** Starts a manual run. Refuses duplicates, overlap, global pause and safe launch. Resolves with the run id; poll view() or await `done`. */
  start(id: unknown): {runId: string; done: Promise<RunRecord>} {
    const r = this.find(id);
    this.assertCanStart(r);
    return this.begin(r, 'manual');
  }

  async run(id: unknown): Promise<RunRecord> { return this.start(id).done; }

  /**
   * Repeats the steps of an earlier run that did not complete (failed, blocked, declined, cancelled, never reached),
   * using the routine's current step definitions. Succeeded steps are not repeated. A new run, so every sensitive
   * step raises its own native confirmation again and the usual guards apply.
   */
  retry(runId: unknown): {runId: string; done: Promise<RunRecord>} {
    const src = this.data.runs.find((r) => r.id === runId);
    if (!src) throw new RoutineError('Run not found');
    if (src.status === 'running' || src.status === 'paused') throw new RoutineError('Wait for that run to finish before retrying it');
    if (!RETRYABLE_RUN.includes(src.status)) throw new RoutineError('Only runs that did not finish cleanly can be retried');
    const r = this.data.routines.find((x) => x.id === src.routineId);
    if (!r) throw new RoutineError('The routine was deleted, so this run cannot be retried');
    this.assertCanStart(r);
    const redo = new Set(src.steps.filter((s) => ['failed', 'blocked', 'declined', 'cancelled', 'pending'].includes(s.status) || (s.status === 'skipped' && /^Stopped/.test(s.reason ?? ''))).map((s) => s.stepId));
    const todo = r.steps.filter((s) => redo.has(s.id));
    if (!todo.length) throw new RoutineError('Nothing to retry: every step of that run completed or no longer exists');
    const before = r.steps[r.steps.indexOf(todo[0]) - 1];
    const seed = before ? (src.steps.find((s) => s.stepId === before.id)?.status ?? null) : null;
    return this.begin(r, 'manual', undefined, {only: new Set(todo.map((s) => s.id)), retryOf: src.id, seed});
  }

  /**
   * Runs an overdue routine on the user's request. Because this is a scheduled run happening late, it needs the same
   * trusted start confirmation as a scheduled start; every desktop step still asks for its own confirmation.
   */
  async recover(id: unknown): Promise<{runId: string; done: Promise<RunRecord>}> {
    const r = this.find(id);
    const slot = this.st(r.id).overdueSlot;
    if (!slot) throw new RoutineError('Nothing is overdue for this routine');
    this.assertCanStart(r);
    if (!this.d.confirm) throw new RoutineError('No trusted confirmation is available, so an overdue run cannot be started');
    const ok = await this.d.confirm(`Run overdue routine "${r.name}" now?`, `It was due at ${slot}.

${this.describe(r)}`).catch(() => false);
    if (!ok) throw new RoutineError('The overdue run was declined in the native confirmation');
    this.assertCanStart(this.find(id));
    return this.begin(this.find(id), 'manual', Date.parse(slot), {recovered: true});
  }

  /** Clears the overdue mark without running anything. */
  async dismissOverdue(id: unknown): Promise<RoutinesView> {
    const r = this.find(id);
    const st = this.st(r.id);
    delete st.overdueSlot;
    delete st.overdueReason;
    await this.persist();
    await this.d.activity?.('routine', `Overdue run dismissed: ${r.name}`);
    return this.view();
  }

  /** JSON text for one routine (no ids or enabled flag). */
  exportText(id: unknown): string { return exportRoutine(this.find(id)); }

  /** Validates a routine file for the editor. Saves nothing. */
  importPreview(text: unknown): RoutineImport { return parseRoutineImport(text, this.d.newId); }

  private begin(r: Routine, trigger: 'manual' | 'schedule', slot?: number, opts: {only?: ReadonlySet<string>; retryOf?: string; seed?: StepStatus | null; recovered?: boolean} = {}): {runId: string; done: Promise<RunRecord>} {
    const routine = structuredClone(r);
    if (opts.only) routine.steps = routine.steps.filter((s) => opts.only!.has(s.id));
    const run: RunRecord = {id: this.d.newId(), routineId: r.id, routineName: r.name, trigger, status: 'running', startedAt: iso(this.d.now()),
      steps: routine.steps.map((s) => ({stepId: s.id, label: s.label, status: 'pending' as StepStatus, attempts: 0}))};
    if (slot !== undefined) run.slot = iso(slot);
    if (opts.retryOf) { run.retryOf = opts.retryOf; run.reason = `Retry of the steps that did not complete in the earlier run`; }
    if (opts.recovered) run.reason = `Recovery of the run that was due at ${iso(slot ?? this.d.now())}`;
    this.pushRun(run);
    const st = this.st(r.id);
    st.lastRunId = run.id;
    st.lastRunAt = run.startedAt;
    delete st.lastResult;
    if (!opts.retryOf) { delete st.overdueSlot; delete st.overdueReason; }
    const active: Active = {run, abort: new AbortController(), wake: null, done: Promise.resolve(run)};
    this.active = active;
    active.done = this.execute(routine, active, opts.seed ?? null).catch((e) => {
      run.status = 'failed';
      run.reason = clip(`Routine engine error: ${(e as Error).message}`);
      return run;
    }).finally(async () => {
      run.endedAt = iso(this.d.now());
      if (this.active === active) this.active = null;
      if (this.data.status[r.id]?.lastRunId === run.id) this.data.status[r.id].lastResult = run.status;
      await this.persist();
      await this.d.activity?.('routine', `Routine ${run.status}: ${r.name}`, run.reason);
    }).then(() => structuredClone(run));
    return {runId: run.id, done: active.done};
  }

  private async execute(routine: Routine, a: Active, seed: StepStatus | null = null): Promise<RunRecord> {
    const {run, abort} = a;
    await this.persist();
    await this.d.activity?.('routine', `Routine started (${run.trigger}): ${routine.name}`);
    let last: StepStatus | null = seed;
    let stop: {status: StepStatus; reason: string} | null = null;
    for (let i = 0; i < routine.steps.length; i++) {
      const step = routine.steps[i];
      const res = run.steps[i];
      if (stop) { res.status = stop.status; res.reason = stop.reason; continue; }
      while (this.data.paused && !abort.signal.aborted) {
        run.status = 'paused';
        await this.persist();
        // Re-check after the await above: resume or cancel may already have happened.
        await new Promise<void>((resolve) => { if (!this.data.paused || abort.signal.aborted) resolve(); else a.wake = resolve; });
        a.wake = null;
      }
      run.status = 'running';
      if (abort.signal.aborted) { stop = {status: 'cancelled', reason: 'Cancelled before this step'}; res.status = stop.status; res.reason = stop.reason; continue; }
      const skip = await this.conditionFails(step.condition, last);
      if (skip) { res.status = 'skipped'; res.reason = skip; await this.persist(); continue; }
      if (step.kind === 'wait') {
        await this.sleep(step.seconds * 1000, abort.signal);
        res.attempts = 1;
        res.status = abort.signal.aborted ? 'cancelled' : 'succeeded';
        res.summary = `Waited ${step.seconds} s`;
      } else {
        Object.assign(res, await this.runAction(step, abort.signal));
      }
      last = res.status;
      if (res.status === 'cancelled') stop = {status: 'cancelled', reason: 'Cancelled'};
      else if (res.status === 'declined') stop = {status: 'skipped', reason: `Stopped: step ${i + 1} was declined`};
      else if ((res.status === 'failed' || res.status === 'blocked') && step.kind === 'action' && step.onFailure === 'stop') stop = {status: 'skipped', reason: `Stopped after step ${i + 1} did not complete`};
      await this.persist();
    }
    run.status = finalStatus(run.steps, abort.signal.aborted || run.steps.some((s) => s.status === 'cancelled'));
    return run;
  }

  /** Returns a skip reason when the condition is not met, otherwise null. */
  private async conditionFails(c: StepCondition | undefined, last: StepStatus | null): Promise<string | null> {
    if (!c) return null;
    const now = this.d.now();
    switch (c.kind) {
      case 'previous': {
        const ok = c.is === 'succeeded' ? last === 'succeeded' : last === 'failed' || last === 'blocked';
        return ok ? null : `Condition not met: previous step did not ${c.is === 'succeeded' ? 'succeed' : 'fail'}`;
      }
      case 'weekday': return c.days.includes(new Date(now).getDay()) ? null : 'Condition not met: not one of the chosen weekdays';
      case 'time': return inTimeWindow(c, now) ? null : `Condition not met: outside ${c.start}–${c.end}`;
      case 'window': {
        if (!this.d.windows) return 'Condition could not be checked: window list unavailable';
        let list: readonly RoutineWindow[];
        try { list = await this.d.windows(); } catch (e) { return `Condition could not be checked: ${clip((e as Error).message, 120)}`; }
        const m = c.match.toLowerCase();
        const present = list.some((w) => w.title.toLowerCase().includes(m) || w.process.toLowerCase() === m);
        return present === c.present ? null : `Condition not met: a window matching "${clip(c.match, 60)}" is ${present ? '' : 'not '}open`;
      }
    }
  }

  /** Captures the exact window and its current rectangle so a move can be reversed. */
  private async captureMove(req: ActionRequest): Promise<{request: ActionRequest; undo: UndoRecord} | {reason: string}> {
    if (!this.d.windows) return {reason: 'Undo needs a window snapshot, which is unavailable; the step was not run'};
    let list: readonly RoutineWindow[];
    try { list = await this.d.windows(); } catch (e) { return {reason: `Windows could not be listed: ${clip((e as Error).message, 120)}`}; }
    const t = (req.target ?? '').trim();
    const h = /^hwnd:(\d+)$/i.exec(t);
    const lower = t.toLowerCase();
    const hits = h ? list.filter((w) => w.hwnd === Number(h[1])) : t ? list.filter((w) => w.title.toLowerCase().includes(lower) || w.process.toLowerCase() === lower) : [];
    if (hits.length !== 1) return {reason: hits.length ? `${hits.length} windows match "${clip(t, 60)}"; an undoable move needs exactly one` : `No window matches "${clip(t, 60)}"`};
    const w = hits[0];
    return {
      request: {...req, target: `hwnd:${w.hwnd}`},
      undo: {request: {type: 'move-window', target: `hwnd:${w.hwnd}`, x: w.x, y: w.y, width: w.width, height: w.height}, summary: `Move "${clip(w.title, 60)}" back to ${w.x},${w.y} size ${w.width}×${w.height}`, undone: false},
    };
  }

  /**
   * One action through the action port. `approved: true` only says the routine was started by the user (or by their
   * confirmed schedule); ActionService still shows its trusted native confirmation for every sensitive action.
   * Each attempt uses a fresh single-use preview. Declines, policy blocks and rate limits are never retried.
   */
  private async runAction(step: ActionStep, signal: AbortSignal): Promise<Partial<StepResult>> {
    let attempts = 0;
    let reason = 'Action failed';
    for (let attempt = 0; attempt <= step.retries; attempt++) {
      if (signal.aborted) return {status: 'cancelled', attempts, reason: 'Cancelled'};
      if (attempt > 0 && step.retryDelaySeconds > 0) {
        await this.sleep(step.retryDelaySeconds * 1000, signal);
        if (signal.aborted) return {status: 'cancelled', attempts, reason: 'Cancelled during retry delay'};
      }
      if (this.d.safeLaunch?.()) return {status: 'blocked', attempts, reason: 'Safe launch is active'};
      let request = step.request;
      let undo: UndoRecord | undefined;
      if (step.undoable) {
        const cap = await this.captureMove(request);
        if ('reason' in cap) return {status: 'failed', attempts, reason: cap.reason};
        request = cap.request;
        undo = cap.undo;
      }
      let preview: ActionPreview;
      try { preview = await this.d.actions.preview(request); } catch (e) { return {status: 'blocked', attempts, reason: clip((e as Error).message)}; }
      if (!preview.allowed) return {status: 'blocked', attempts, summary: preview.summary, reason: clip(preview.reason ?? 'Not allowed')};
      if (request.type !== 'list-windows' && !preview.requiresApproval) return {status: 'blocked', attempts, summary: preview.summary, reason: 'Refused: a desktop action must require confirmation'};
      attempts++;
      let result: unknown;
      try { result = await this.d.actions.execute(preview.id, true); } catch (e) { result = {executed: false, reason: (e as Error).message}; }
      const o = (typeof result === 'object' && result !== null ? result : {}) as {executed?: unknown; reason?: unknown};
      if (o.executed === true) return undo ? {status: 'succeeded', attempts, summary: preview.summary, undo} : {status: 'succeeded', attempts, summary: preview.summary};
      reason = clip(typeof o.reason === 'string' && o.reason ? o.reason : 'Action failed');
      if (DECLINED_RE.test(reason)) return {status: 'declined', attempts, summary: preview.summary, reason};
      if (FINAL_RE.test(reason)) return {status: 'failed', attempts, summary: preview.summary, reason};
    }
    return {status: 'failed', attempts, reason: step.retries ? `${reason} (after ${attempts} attempts)` : reason};
  }

  /**
   * Reverses the explicitly reversible steps of a finished run, newest first. Each reversal is its own ActionService
   * preview and native confirmation, is used at most once, and stops at the first decline.
   */
  async undo(runId: unknown): Promise<UndoOutcome> {
    const run = this.data.runs.find((r) => r.id === runId);
    if (!run) throw new RoutineError('Run not found');
    if (this.active || this.undoing) throw new RoutineError('Wait for the running routine to finish');
    if (this.d.safeLaunch?.()) throw new RoutineError('Safe launch is active');
    const todo = run.steps.filter((s) => s.status === 'succeeded' && s.undo && !s.undo.undone).reverse();
    if (!todo.length) return {run: structuredClone(run), undone: 0, failed: 0, reason: 'Nothing in this run can be undone'};
    this.undoing = true;
    let undone = 0, failed = 0;
    try {
      for (const s of todo) {
        const u = s.undo!;
        let preview: ActionPreview;
        try { preview = await this.d.actions.preview(u.request); } catch (e) { u.result = clip((e as Error).message); failed++; continue; }
        if (!preview.allowed || !preview.requiresApproval) { u.result = clip(preview.reason ?? 'Not allowed'); failed++; continue; }
        let result: unknown;
        try { result = await this.d.actions.execute(preview.id, true); } catch (e) { result = {executed: false, reason: (e as Error).message}; }
        const o = (typeof result === 'object' && result !== null ? result : {}) as {executed?: unknown; reason?: unknown};
        if (o.executed === true) { u.undone = true; u.result = 'Undone'; undone++; continue; }
        u.result = clip(typeof o.reason === 'string' ? o.reason : 'Undo failed');
        failed++;
        if (DECLINED_RE.test(u.result)) break;
      }
    } finally {
      this.undoing = false;
      await this.persist();
    }
    await this.d.activity?.('routine', `Undo for ${run.routineName}: ${undone} reversed, ${failed} not reversed`);
    return {run: structuredClone(run), undone, failed};
  }
}

// ---------------------------------------------------------------------------------------------------------------
// API for IPC wiring (captain). Every method takes untrusted renderer input; the engine validates it.

export interface RoutinesApi {
  list(): Promise<RoutinesView>;
  save(draft: unknown): Promise<RoutinesView>;
  remove(id: string): Promise<RoutinesView>;
  start(id: string): Promise<{runId: string}>;
  cancel(runId: string): Promise<RoutinesView>;
  pauseAll(): Promise<RoutinesView>;
  resumeAll(): Promise<RoutinesView>;
  undo(runId: string): Promise<UndoOutcome>;
  // Optional so existing bridges stay compatible. The UI hides the matching control when one is missing.
  /** Repeats only the unfinished steps of an earlier run as a new run (new confirmations). */
  retry?(runId: string): Promise<{runId: string}>;
  /** Starts an overdue routine after the trusted native confirmation. */
  recover?(id: string): Promise<{runId: string}>;
  dismissOverdue?(id: string): Promise<RoutinesView>;
  /** Portable JSON for one routine. */
  exportRoutine?(id: string): Promise<string>;
  /** Validates pasted routine JSON for the editor; saves nothing, never enables or schedules. */
  importPreview?(text: string): Promise<RoutineImport>;
  /** Deterministic rule planner, one command per line. Preview candidates for the editor only. */
  planText(text: string): Promise<RoutinePlan>;
  /** Local model JSON routine proposal. Preview candidates for the editor only. */
  planModel(json: string): Promise<RoutinePlan>;
}

export function createRoutinesApi(engine: RoutineEngine): RoutinesApi {
  return {
    list: async () => engine.view(),
    save: (draft) => engine.save(draft),
    remove: (id) => engine.remove(id),
    start: async (id) => ({runId: engine.start(id).runId}),
    cancel: (runId) => engine.cancel(runId),
    pauseAll: () => engine.pauseAll(),
    resumeAll: () => engine.resumeAll(),
    undo: (runId) => engine.undo(runId),
    retry: async (runId) => ({runId: engine.retry(runId).runId}),
    recover: async (id) => ({runId: (await engine.recover(id)).runId}),
    dismissOverdue: (id) => engine.dismissOverdue(id),
    exportRoutine: async (id) => engine.exportText(id),
    importPreview: async (text) => engine.importPreview(text),
    planText: async (text) => planRoutineLines(text),
    planModel: async (json) => parseModelRoutine(json),
  };
}
