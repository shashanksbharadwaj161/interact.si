/**
 * Pet animation clock (PET-RENDERER-PLAN.md section 4). One shared scheduler serves every pet on the page: each
 * sprite subscribes with the time of its next frame change, the scheduler keeps a single timer for the earliest
 * change and draws every due sprite inside one animation frame. Nothing runs between frame changes, and nothing
 * runs while the page is hidden. Time sources are injected so tests run on fake time.
 *
 * Animator and the calm idle source compute the current frame from elapsed time alone, so frames never drift.
 */
import { PET_ROWS } from './contract';

export type FrameSubscription = {
  /** Time of this sprite's next frame change after `now`, or null when it will not change on its own. */
  nextChangeAt(now: number): number | null;
  draw(now: number): void;
};

export type SchedulerEnv = {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  requestFrame?: (fn: () => void) => unknown;
  isHidden?: () => boolean;
  /** Registers a visibility listener and returns its removal. */
  onVisibilityChange?: (fn: () => void) => () => void;
};

export type FrameScheduler = {
  /** Draws the subscription in the next frame. Subscribing it again marks it due now (use after its sequence changes). */
  subscribe(sub: FrameSubscription): () => void;
  size(): number;
  dispose(): void;
};

type Entry = { sub: FrameSubscription; dueAt: number | null; version: number };

const browserEnv = (): Required<SchedulerEnv> => {
  const g = globalThis as typeof globalThis & { document?: Document };
  const doc = typeof g.document === 'undefined' ? null : g.document;
  return {
    now: typeof g.performance?.now === 'function' ? () => g.performance.now() : () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    requestFrame: typeof g.requestAnimationFrame === 'function' ? (fn) => g.requestAnimationFrame(() => fn()) : (fn) => setTimeout(fn, 16),
    isHidden: () => doc?.visibilityState === 'hidden',
    onVisibilityChange: (fn) => {
      if (!doc) return () => {};
      doc.addEventListener('visibilitychange', fn);
      return () => doc.removeEventListener('visibilitychange', fn);
    },
  };
};

export function createFrameScheduler(env: SchedulerEnv = {}): FrameScheduler {
  const e = { ...browserEnv(), ...env };
  const entries = new Map<FrameSubscription, Entry>();
  let timer: unknown = null;
  let timerAt = 0;
  let frameRequested = false;
  let inFrame = false;
  let hidden = e.isHidden();
  let disposed = false;

  const clearTimer = (): void => {
    if (timer !== null) e.clearTimer(timer);
    timer = null;
  };

  const schedule = (): void => {
    if (disposed || hidden) return clearTimer();
    if (frameRequested || inFrame) return;
    let earliest = Infinity;
    for (const entry of entries.values()) if (entry.dueAt !== null && entry.dueAt < earliest) earliest = entry.dueAt;
    if (earliest === Infinity) return clearTimer();
    const delay = earliest - e.now();
    if (delay <= 0) {
      clearTimer();
      frameRequested = true;
      e.requestFrame(onFrame);
      return;
    }
    if (timer !== null && timerAt === earliest) return;
    clearTimer();
    timerAt = earliest;
    timer = e.setTimer(onTimer, delay);
  };

  function onTimer(): void {
    timer = null;
    if (disposed || hidden || frameRequested) return;
    frameRequested = true;
    e.requestFrame(onFrame);
  }

  function onFrame(): void {
    frameRequested = false;
    if (disposed || hidden) return;
    const t = e.now();
    let firstError: unknown = null;
    inFrame = true;
    for (const entry of [...entries.values()]) {
      if (entries.get(entry.sub) !== entry || entry.dueAt === null || entry.dueAt > t) continue;
      const version = entry.version;
      try {
        entry.sub.draw(t);
        if (entry.version === version) {
          const next = entry.sub.nextChangeAt(t);
          entry.dueAt = next === null || !Number.isFinite(next) ? null : Math.max(next, t + 1);
        }
      } catch (err) {
        entry.dueAt = null;
        firstError ??= err;
      }
    }
    inFrame = false;
    schedule();
    if (firstError !== null) throw firstError;
  }

  const stopVisibility = e.onVisibilityChange(() => {
    const was = hidden;
    hidden = e.isHidden();
    if (hidden) return clearTimer();
    if (was) {
      const t = e.now();
      for (const entry of entries.values()) entry.dueAt = t;
    }
    schedule();
  });

  return {
    subscribe(sub) {
      if (disposed) return () => {};
      const existing = entries.get(sub);
      const entry = existing ?? { sub, dueAt: 0, version: 0 };
      entry.dueAt = e.now();
      entry.version++;
      if (!existing) entries.set(sub, entry);
      schedule();
      return () => {
        if (entries.get(sub) !== entry) return;
        entries.delete(sub);
        schedule();
      };
    },
    size: () => entries.size,
    dispose() {
      disposed = true;
      clearTimer();
      entries.clear();
      stopVisibility();
    },
  };
}

let shared: FrameScheduler | null = null;
/** The page-wide scheduler on browser time sources. */
export const sharedFrameScheduler = (): FrameScheduler => (shared ??= createFrameScheduler());

/* =====================================================================================
 * Frame sources
 * ===================================================================================== */

export type FrameSequence = Readonly<{ durations: readonly number[] }>;
export type PlayOptions = Readonly<{
  loop?: boolean;
  /** When not looping: after the last play, stay on the last frame (true) or return to frame 0 (false). */
  holdLast?: boolean;
  startAt?: number;
  /** Plays before a non-looping sequence ends. */
  repeat?: number;
}>;

/** What a sprite needs from any animation: the frame now, when it next changes, and whether it has finished. */
export interface FrameSource {
  frameAt(now: number): number;
  /** Next time frameAt or done changes, strictly after `now`; null when neither will change. */
  nextChangeAt(now: number): number | null;
  done(now: number): boolean;
}

const checkDurations = (durations: readonly number[]): number[] => {
  if (!durations.length || durations.some((d) => !Number.isFinite(d) || d <= 0)) throw new RangeError('A frame sequence needs at least one positive, finite duration.');
  let sum = 0;
  return durations.map((d) => (sum += d));
};

/** Index of the frame showing at offset t within one pass (0 <= t < total). */
const frameIn = (ends: readonly number[], t: number): number => {
  let i = 0;
  while (i < ends.length - 1 && ends[i] <= t) i++;
  return i;
};

export class Animator implements FrameSource {
  private ends: number[] = [];
  private total = 0;
  private loop = false;
  private holdLast = false;
  private startAt = 0;
  private plays = 1;

  play(sequence: FrameSequence, options: PlayOptions = {}): this {
    this.ends = checkDurations(sequence.durations);
    this.total = this.ends[this.ends.length - 1];
    this.loop = options.loop ?? false;
    this.holdLast = options.holdLast ?? false;
    this.startAt = options.startAt ?? 0;
    this.plays = Math.max(1, Math.floor(options.repeat ?? 1));
    return this;
  }

  private get length(): number {
    return this.loop ? Infinity : this.total * this.plays;
  }

  frameAt(now: number): number {
    if (!this.ends.length) return 0;
    const t = now - this.startAt;
    if (t <= 0) return 0;
    if (t >= this.length) return this.holdLast ? this.ends.length - 1 : 0;
    return frameIn(this.ends, t % this.total);
  }

  nextChangeAt(now: number): number | null {
    if (!this.ends.length) return null;
    const t = Math.max(0, now - this.startAt);
    if (t >= this.length) return null;
    if (this.ends.length === 1) return this.loop ? null : this.startAt + this.length;
    const pass = Math.floor(t / this.total);
    const next = this.startAt + pass * this.total + this.ends[frameIn(this.ends, t - pass * this.total)];
    return Math.min(next, this.startAt + this.length);
  }

  done(now: number): boolean {
    return !this.loop && now - this.startAt >= this.length;
  }
}

export const CALM_IDLE = Object.freeze({ minRestMs: 2000, maxRestMs: 5000 });

/**
 * Calm idle: one full idle pass, then frame 0 held for a random 2-5 s, then the next pass. `random` returns [0, 1).
 * Rests are drawn in order as time moves forward, so the same random source gives the same timeline. Time is expected
 * to move forward; a query before the current pass shows frame 0.
 */
export function idleWithRests(random: () => number = Math.random, options: { startAt?: number; durations?: readonly number[] } = {}): FrameSource {
  const ends = checkDurations(options.durations ?? PET_ROWS.idle.durations);
  const total = ends[ends.length - 1];
  const drawRest = (): number => {
    const r = random();
    const u = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
    return Math.round(CALM_IDLE.minRestMs + u * (CALM_IDLE.maxRestMs - CALM_IDLE.minRestMs));
  };
  let passStart = options.startAt ?? 0;
  let rest = drawRest();

  const advance = (now: number): void => {
    // After a long pause (hidden window), restart at now instead of replaying every missed rest.
    if (now - passStart > 64 * (total + CALM_IDLE.maxRestMs)) {
      passStart = now;
      rest = drawRest();
      return;
    }
    while (now >= passStart + total + rest) {
      passStart += total + rest;
      rest = drawRest();
    }
  };

  return {
    frameAt(now) {
      advance(now);
      const t = now - passStart;
      return t <= 0 || t >= total ? 0 : frameIn(ends, t);
    },
    nextChangeAt(now) {
      advance(now);
      const t = now - passStart;
      if (ends.length === 1) return null;
      if (t < 0) return passStart + ends[0];
      // Resting on frame 0 runs straight into the next pass's frame 0, so the next change is its first boundary.
      if (t >= total) return passStart + total + rest + ends[0];
      return passStart + ends[frameIn(ends, t)];
    },
    done: () => false,
  };
}
