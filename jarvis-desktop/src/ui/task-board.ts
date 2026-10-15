// Pure, DOM-free task board model for the Agent Control Room section of the Developer page.
// Development tooling only: no network, no model calls, no invented activity and no progress percentages.

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled' | 'stopped';
export type StopReason = 'completed' | 'user-cancelled' | 'error' | 'timeout' | 'budget-exhausted' | 'checks-failed' | 'blocked';

export type BoardTask = {
  id: string;
  title: string;
  role: string;
  model?: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  stopReason?: StopReason;
  note?: string;
  files?: string[];
};

export const TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'paused', 'done', 'failed', 'cancelled', 'stopped'];
export const STOP_REASONS: readonly StopReason[] = ['completed', 'user-cancelled', 'error', 'timeout', 'budget-exhausted', 'checks-failed', 'blocked'];
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['done', 'failed', 'cancelled', 'stopped'];
export const TASK_BOARD_PREF_KEY = 'developer.taskBoard';
export const TASK_BOARD_LIMITS = { titleChars: 120, roleChars: 60, modelChars: 80, noteChars: 500, files: 50, fileChars: 260, tasks: 200 } as const;

/** Allowed status moves. Terminal states have no outgoing moves. */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['paused', 'done', 'failed', 'cancelled', 'stopped'],
  paused: ['running', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
  stopped: [],
};

const REQUIRES_REASON: readonly TaskStatus[] = ['done', 'failed', 'cancelled', 'stopped'];

export const isTerminal = (s: TaskStatus) => TERMINAL_STATUSES.includes(s);
export const canTransition = (from: TaskStatus, to: TaskStatus) => (TRANSITIONS[from] ?? []).includes(to);

const isStatus = (v: unknown): v is TaskStatus => typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
const isReason = (v: unknown): v is StopReason => typeof v === 'string' && (STOP_REASONS as readonly string[]).includes(v);

function iso(now: number | Date | string): string {
  const d = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid timestamp.');
  return d.toISOString();
}

function cleanFiles(files: unknown): string[] | undefined {
  if (!Array.isArray(files)) return undefined;
  const out = [...new Set(files.filter((f): f is string => typeof f === 'string').map((f) => f.trim()).filter((f) => f && f.length <= TASK_BOARD_LIMITS.fileChars))].slice(0, TASK_BOARD_LIMITS.files);
  return out.length ? out : undefined;
}

export type NewTaskInput = { title: string; role: string; model?: string; files?: string[] };

/**
 * Creates a queued task. `counter` supplies the per-board index so ids are deterministic: 't-<base36 now>-<index>'.
 * Pass an object `{ next: number }` (incremented in place) or a function returning the next index.
 */
export function createTask(input: NewTaskInput, now: number | Date, counter: { next: number } | (() => number) = { next: 0 }): BoardTask {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const role = typeof input?.role === 'string' ? input.role.trim() : '';
  if (!title) throw new Error('Task title is required.');
  if (title.length > TASK_BOARD_LIMITS.titleChars) throw new Error(`Task title must be at most ${TASK_BOARD_LIMITS.titleChars} characters.`);
  if (!role) throw new Error('Task role is required.');
  if (role.length > TASK_BOARD_LIMITS.roleChars) throw new Error(`Task role must be at most ${TASK_BOARD_LIMITS.roleChars} characters.`);
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('Invalid timestamp.');
  const index = typeof counter === 'function' ? counter() : counter.next++;
  const task: BoardTask = { id: `t-${Math.floor(ms).toString(36)}-${index}`, title, role, status: 'queued', createdAt: iso(ms) };
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (model) task.model = model.slice(0, TASK_BOARD_LIMITS.modelChars);
  const files = cleanFiles(input.files);
  if (files) task.files = files;
  return task;
}

export type TransitionOptions = { now: number | Date; stopReason?: StopReason; note?: string };

/** Returns a new task in the next status. Throws a descriptive Error on illegal moves or missing/invalid stop reasons. */
export function transitionTask(task: BoardTask, next: TaskStatus, opts: TransitionOptions): BoardTask {
  if (!isStatus(next)) throw new Error(`Unknown task status "${String(next)}".`);
  if (isTerminal(task.status)) throw new Error(`Task ${task.id} is ${task.status}; terminal tasks cannot change.`);
  if (!canTransition(task.status, next)) throw new Error(`Illegal transition for task ${task.id}: ${task.status} -> ${next}. Allowed: ${TRANSITIONS[task.status].join(', ') || 'none'}.`);
  const at = iso(opts?.now as number | Date);
  const reason = opts?.stopReason;
  if (REQUIRES_REASON.includes(next)) {
    if (reason === undefined) throw new Error(`A stop reason is required to move task ${task.id} to ${next}.`);
    if (!isReason(reason)) throw new Error(`Unknown stop reason "${String(reason)}".`);
    if (next === 'done' && reason !== 'completed') throw new Error(`Task ${task.id} can only be marked done with stop reason "completed".`);
    if (next !== 'done' && reason === 'completed') throw new Error(`Stop reason "completed" is only allowed for done, not ${next}.`);
  } else if (reason !== undefined) {
    throw new Error(`A stop reason is not accepted when moving task ${task.id} to ${next}.`);
  }
  const out: BoardTask = { ...task, status: next };
  if (next === 'running' && !out.startedAt) out.startedAt = at;
  if (isTerminal(next)) {
    out.endedAt = at;
    out.stopReason = reason;
  }
  if (typeof opts.note === 'string' && opts.note.trim()) out.note = opts.note.trim().slice(0, TASK_BOARD_LIMITS.noteChars);
  if (out.files) out.files = [...out.files];
  return out;
}

export type WorkerState = 'idle' | 'busy' | 'paused';
export type WorkerStatus = { id: string; role: string; model: string; state: WorkerState; currentTaskId?: string; completed: number; failed: number };

/** Groups tasks by role+model. State is derived only from the task list: running -> busy, else paused -> paused, else idle. */
export function deriveWorkerStatus(tasks: readonly BoardTask[]): WorkerStatus[] {
  const map = new Map<string, WorkerStatus>();
  for (const t of tasks) {
    const model = t.model ?? '';
    const id = `${t.role}+${model}`;
    let w = map.get(id);
    if (!w) {
      w = { id, role: t.role, model, state: 'idle', completed: 0, failed: 0 };
      map.set(id, w);
    }
    if (t.status === 'done') w.completed++;
    else if (t.status === 'failed') w.failed++;
    else if (t.status === 'running' && w.state !== 'busy') {
      w.state = 'busy';
      w.currentTaskId = t.id;
    } else if (t.status === 'paused' && w.state === 'idle') {
      w.state = 'paused';
      w.currentTaskId = t.id;
    }
  }
  return [...map.values()].map((w) => {
    const out: WorkerStatus = { id: w.id, role: w.role, model: w.model, state: w.state, completed: w.completed, failed: w.failed };
    if (w.currentTaskId) out.currentTaskId = w.currentTaskId;
    return out;
  });
}

export type BoardSummary = { total: number; byStatus: Record<TaskStatus, number>; byStopReason: Record<StopReason, number> };

export function summarizeBoard(tasks: readonly BoardTask[]): BoardSummary {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
  const byStopReason = Object.fromEntries(STOP_REASONS.map((r) => [r, 0])) as Record<StopReason, number>;
  for (const t of tasks) {
    if (isStatus(t.status)) byStatus[t.status]++;
    if (isReason(t.stopReason)) byStopReason[t.stopReason]++;
  }
  return { total: tasks.length, byStatus, byStopReason };
}

const isIsoString = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** Validates persisted data: drops malformed entries, keeps the first of duplicate ids, caps at 200. */
export function parseBoard(raw: unknown): BoardTask[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: BoardTask[] = [];
  for (const e of raw) {
    if (out.length >= TASK_BOARD_LIMITS.tasks) break;
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim() || r.id.length > 80 || seen.has(r.id)) continue;
    if (typeof r.title !== 'string' || !r.title.trim() || r.title.length > TASK_BOARD_LIMITS.titleChars) continue;
    if (typeof r.role !== 'string' || !r.role.trim() || r.role.length > TASK_BOARD_LIMITS.roleChars) continue;
    if (!isStatus(r.status) || !isIsoString(r.createdAt)) continue;
    if (r.model !== undefined && (typeof r.model !== 'string' || r.model.length > TASK_BOARD_LIMITS.modelChars)) continue;
    if (r.startedAt !== undefined && !isIsoString(r.startedAt)) continue;
    if (r.endedAt !== undefined && !isIsoString(r.endedAt)) continue;
    if (r.stopReason !== undefined && !isReason(r.stopReason)) continue;
    if (isTerminal(r.status) && (!isReason(r.stopReason) || !isIsoString(r.endedAt))) continue;
    if (r.status === 'done' && r.stopReason !== 'completed') continue;
    const t: BoardTask = { id: r.id, title: r.title, role: r.role, status: r.status, createdAt: r.createdAt };
    if (typeof r.model === 'string' && r.model) t.model = r.model;
    if (typeof r.startedAt === 'string') t.startedAt = r.startedAt;
    if (typeof r.endedAt === 'string') t.endedAt = r.endedAt;
    if (isReason(r.stopReason) && isTerminal(r.status)) t.stopReason = r.stopReason;
    if (typeof r.note === 'string' && r.note.trim()) t.note = r.note.slice(0, TASK_BOARD_LIMITS.noteChars);
    const files = cleanFiles(r.files);
    if (files) t.files = files;
    seen.add(r.id);
    out.push(t);
  }
  return out;
}
