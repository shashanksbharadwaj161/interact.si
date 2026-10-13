// Task due-time reminders. No Electron import: the notifier is injected, so tests use a stub.
// One unref'd timer aimed at the next due task (no polling interval), re-armed after task changes.
import type {Task} from '../../src/shared/contracts';

/** Largest delay setTimeout accepts (2^31 - 1 ms, about 24.8 days). */
export const MAX_TIMER_MS = 2_147_483_647;
/** A task that came due this long before the app started is still announced once. */
export const START_GRACE_MS = 10 * 60_000;
/** Date-only due values (YYYY-MM-DD) remind at 09:00 local time. */
export const DATE_ONLY_HOUR = 9;

/** Due instant in ms, or null when the task has no usable due value. */
export function dueAt(task: Pick<Task, 'due'>): number | null {
  const s = task.due?.trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const t = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), DATE_ONLY_HOUR, 0, 0, 0).getTime() : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const keyOf = (t: Pick<Task, 'id' | 'due'>) => `${t.id}\u0000${t.due ?? ''}`;

export type TimerHandle = {unref?: () => unknown} | number;

export interface ReminderDeps {
  tasks: () => readonly Task[];
  now: () => number;
  /** Shows one notification. Must not throw for the scheduler to keep running. */
  notify: (title: string, body: string, task: Task) => void;
  /** Optional audit hook, e.g. Activity{kind:'reminder'}. */
  record?: (summary: string) => void | Promise<void>;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
}

export class Reminders {
  private timer: TimerHandle | null = null;
  private fired = new Set<string>();
  /** Reminders are due when their instant lies in (checkpoint, now]. Advances on every check. */
  private checkpoint: number;
  private disposed = false;
  private setTimer: NonNullable<ReminderDeps['setTimer']>;
  private clearTimer: NonNullable<ReminderDeps['clearTimer']>;

  constructor(private d: ReminderDeps) {
    this.checkpoint = d.now() - START_GRACE_MS;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get armed(): boolean { return this.timer !== null; }

  /** Tasks that are open, dated, due within (checkpoint, now] and not yet announced. */
  due(): Task[] {
    const now = this.d.now();
    return this.d.tasks().filter((t) => {
      if (t.done) return false;
      const at = dueAt(t);
      return at !== null && at > this.checkpoint && at <= now && !this.fired.has(keyOf(t));
    });
  }

  /** The earliest future due time among open tasks, or null. */
  nextAt(): number | null {
    const now = this.d.now();
    let best: number | null = null;
    for (const t of this.d.tasks()) {
      if (t.done || this.fired.has(keyOf(t))) continue;
      const at = dueAt(t);
      if (at !== null && at > now && (best === null || at < best)) best = at;
    }
    return best;
  }

  /** Call after tasks change (save, delete, import). Never announces: dates moved into the past stay silent. */
  rearm(): void {
    if (this.disposed) return;
    this.checkpoint = this.d.now();
    this.schedule();
  }

  /** Timer callback; also callable directly. Announces every due task once, then schedules the next one. */
  async fire(): Promise<number> {
    this.timer = null;
    if (this.disposed) return 0;
    const due = this.due();
    this.checkpoint = this.d.now();
    // Drop bookkeeping for tasks that no longer exist or changed their due value.
    const live = new Set(this.d.tasks().map(keyOf));
    for (const k of this.fired) if (!live.has(k)) this.fired.delete(k);
    for (const t of due) {
      this.fired.add(keyOf(t));
      try { this.d.notify(t.title, 'Due now', t); } catch { /* a failing notifier must not stop later reminders */ }
      try { await this.d.record?.(`Reminder: ${t.title}`); } catch { /* ignore */ }
    }
    this.schedule();
    return due.length;
  }

  /** Arms the timer for the first announcement of this run (announces recent overdue tasks within the grace window). */
  start(): void {
    if (this.disposed) return;
    if (this.due().length) { void this.fire(); return; }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const next = this.nextAt();
    if (next === null) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next - this.d.now()));
    const h = this.setTimer(() => { void this.fire(); }, delay);
    if (typeof h === 'object' && typeof h.unref === 'function') h.unref();
    this.timer = h;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }
}
