// Pure, DOM-free budget limits for the Developer page task board.
// Development tooling only: no network, no model calls, no timers. Output contains exact counts and limits only.

import type { BoardTask } from './task-board';

export type TaskBudget = {
  maxConcurrentRunning: number;
  maxTasksPerDay: number;
  maxWallClockMinutesPerTask: number;
  /** 0 means no spend is allowed. */
  maxEstimatedCostUsdPerDay: number;
};

export const DEFAULT_TASK_BUDGET: Readonly<TaskBudget> = Object.freeze({
  maxConcurrentRunning: 1,
  maxTasksPerDay: 20,
  maxWallClockMinutesPerTask: 60,
  maxEstimatedCostUsdPerDay: 0,
});

export const TASK_BUDGET_PREF_KEY = 'developer.taskBudget';
export const TASK_SPEND_PREF_KEY = 'developer.taskSpend';
export const TASK_SPEND_LEDGER_CAP = 500;

export const TASK_BUDGET_BOUNDS = {
  maxConcurrentRunning: { min: 1, max: 10, integer: true },
  maxTasksPerDay: { min: 1, max: 500, integer: true },
  maxWallClockMinutesPerTask: { min: 1, max: 1440, integer: true },
  maxEstimatedCostUsdPerDay: { min: 0, max: 1000, integer: false },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function coerceField(raw: unknown, key: keyof TaskBudget): number {
  const b = TASK_BUDGET_BOUNDS[key];
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw.trim());
  else return DEFAULT_TASK_BUDGET[key];
  if (!Number.isFinite(n)) return DEFAULT_TASK_BUDGET[key];
  if (b.integer) n = Math.round(n);
  else n = Math.round(n * 100) / 100;
  return Math.min(b.max, Math.max(b.min, n));
}

/** Coerces bad or legacy input to defaults, clamps to bounds and rounds integer fields. */
export function normalizeTaskBudget(raw: unknown): TaskBudget {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    maxConcurrentRunning: coerceField(r.maxConcurrentRunning, 'maxConcurrentRunning'),
    maxTasksPerDay: coerceField(r.maxTasksPerDay, 'maxTasksPerDay'),
    maxWallClockMinutesPerTask: coerceField(r.maxWallClockMinutesPerTask, 'maxWallClockMinutesPerTask'),
    maxEstimatedCostUsdPerDay: coerceField(r.maxEstimatedCostUsdPerDay, 'maxEstimatedCostUsdPerDay'),
  };
}

export type TimeInput = number | Date | string;

function toMs(now: TimeInput, label = 'now'): number {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : typeof now === 'number' ? now : Number.NaN;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new Error(`Invalid ${label} timestamp: ${String(now)}.`);
  return ms;
}

/** Start of the counting day: dayStartIso when given (validated), else UTC midnight of now. */
function dayWindow(nowMs: number, dayStartIso?: string): [number, number] {
  let start: number;
  if (dayStartIso !== undefined) {
    if (typeof dayStartIso !== 'string') throw new Error(`Invalid dayStartIso timestamp: ${String(dayStartIso)}.`);
    start = toMs(dayStartIso, 'dayStartIso');
  } else {
    const d = new Date(nowMs);
    start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return [start, start + DAY_MS];
}

export type SpendEntry = { taskId: string; usd: number; at: string };

const fmtUsd = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)} USD`;

function validEntry(e: unknown): e is SpendEntry {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.taskId === 'string' && r.taskId.trim() !== '' && r.taskId.length <= 80 &&
    typeof r.usd === 'number' && Number.isFinite(r.usd) && r.usd >= 0 && r.usd <= 1_000_000 &&
    typeof r.at === 'string' && r.at.length <= 40 && !Number.isNaN(Date.parse(r.at))
  );
}

/** Validates persisted ledger data: drops malformed entries and keeps the newest 500. */
export function parseSpendLedger(raw: unknown): SpendEntry[] {
  if (!Array.isArray(raw)) return [];
  const out = raw.filter(validEntry).map((e) => ({ taskId: e.taskId, usd: e.usd, at: e.at }));
  return out.slice(Math.max(0, out.length - TASK_SPEND_LEDGER_CAP));
}

/** Returns a new ledger with the entry appended (oldest dropped beyond 500). Throws on invalid input. */
export function recordSpend(ledger: readonly SpendEntry[], entry: { taskId: string; usd: number; at: TimeInput }): SpendEntry[] {
  const taskId = typeof entry?.taskId === 'string' ? entry.taskId.trim() : '';
  if (!taskId) throw new Error('Spend entry needs a task id.');
  if (taskId.length > 80) throw new Error('Spend entry task id must be at most 80 characters.');
  const usd = entry.usd;
  if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new Error(`Spend amount must be a finite number, got ${String(usd)}.`);
  if (usd < 0) throw new Error(`Spend amount must be 0 or more, got ${usd}.`);
  if (usd > 1_000_000) throw new Error('Spend amount must be at most 1000000 USD.');
  const atMs = toMs(entry.at, 'spend');
  const next = [...parseSpendLedger(ledger), { taskId, usd, at: new Date(atMs).toISOString() }];
  return next.slice(Math.max(0, next.length - TASK_SPEND_LEDGER_CAP));
}

/** Sums valid ledger entries whose time falls inside the day window, rounded to cents. */
export function sumSpendForDay(ledger: readonly SpendEntry[], now: TimeInput, dayStartIso?: string): number {
  const nowMs = toMs(now);
  const [start, end] = dayWindow(nowMs, dayStartIso);
  let cents = 0;
  for (const e of parseSpendLedger(ledger)) {
    const t = Date.parse(e.at);
    if (t >= start && t < end) cents += Math.round(e.usd * 100);
  }
  return cents / 100;
}

export type StartReason = 'ok' | 'concurrency-limit' | 'daily-task-limit' | 'spend-limit';
export type StartEvaluation = { allowed: boolean; reason: StartReason; detail: string };
export type EvaluateOptions = { now: TimeInput; dayStartIso?: string; ledger?: readonly SpendEntry[] };

/** Checks concurrency, then daily task count, then daily spend. The first failing check wins. */
export function evaluateStart(tasks: readonly BoardTask[], budget: TaskBudget, opts: EvaluateOptions): StartEvaluation {
  const nowMs = toMs(opts?.now as TimeInput);
  const b = normalizeTaskBudget(budget);
  const [start, end] = dayWindow(nowMs, opts.dayStartIso);
  const running = tasks.filter((t) => t.status === 'running').length;
  const startedToday = tasks.filter((t) => {
    if (!t.startedAt) return false;
    const s = Date.parse(t.startedAt);
    return s >= start && s < end;
  }).length;
  const spent = sumSpendForDay(opts.ledger ?? [], nowMs, opts.dayStartIso);
  const limit = b.maxEstimatedCostUsdPerDay;
  if (running >= b.maxConcurrentRunning) {
    return { allowed: false, reason: 'concurrency-limit', detail: `Concurrency limit reached: ${running} running, limit ${b.maxConcurrentRunning}.` };
  }
  if (startedToday >= b.maxTasksPerDay) {
    return { allowed: false, reason: 'daily-task-limit', detail: `Daily task limit reached: ${startedToday} started today, limit ${b.maxTasksPerDay}.` };
  }
  if (spent > 0 && spent >= limit) {
    return { allowed: false, reason: 'spend-limit', detail: `Spend limit reached: ${fmtUsd(spent)} recorded today, limit ${fmtUsd(limit)}.` };
  }
  return {
    allowed: true,
    reason: 'ok',
    detail: `Within budget: ${running} of ${b.maxConcurrentRunning} running, ${startedToday} of ${b.maxTasksPerDay} started today, ${fmtUsd(spent)} of ${fmtUsd(limit)} recorded today.`,
  };
}

export type OverdueTask = { task: BoardTask; elapsedMinutes: number; limitMinutes: number };

/**
 * Running tasks whose wall-clock time since startedAt exceeds the per-task limit.
 * Elapsed minutes are whole minutes (floor). Callers stop them via transitionTask(..., 'stopped', { stopReason: 'timeout' }).
 */
export function findOverdue(tasks: readonly BoardTask[], budget: TaskBudget, now: TimeInput): OverdueTask[] {
  const nowMs = toMs(now);
  const limitMinutes = normalizeTaskBudget(budget).maxWallClockMinutesPerTask;
  const out: OverdueTask[] = [];
  for (const task of tasks) {
    if (task.status !== 'running' || !task.startedAt) continue;
    const s = Date.parse(task.startedAt);
    if (Number.isNaN(s)) continue;
    const elapsedMs = nowMs - s;
    if (elapsedMs > limitMinutes * MINUTE_MS) out.push({ task, elapsedMinutes: Math.floor(elapsedMs / MINUTE_MS), limitMinutes });
  }
  return out;
}
