/**
 * Explicit, interruptible animation state machine. Pure and DOM-free so it can be tested without a browser.
 *
 * One machine drives one visual slot (the assistant status badge, an open/close panel, a scene backdrop).
 * The slot shows a single piece of content (`shown`) whose visibility is `progress` 0..1:
 *
 *   idle ──show──▶ entering ──(done)──▶ active ──hide/show other──▶ exiting ──(done)──▶ idle | entering(next)
 *
 * Any show/hide that arrives while a leg is still running moves to `interrupted`: the new leg starts from the
 * CURRENT progress (never snapping back to 0) and only one leg ever runs at a time, so two animations never
 * overlap. A different target fades the current content out from where it is, then fades the new one in.
 * `cancel` returns to idle immediately. With reducedMotion every change is one instantaneous step.
 *
 * Every function returns a new frozen machine and never mutates its input.
 */

export type AnimPhase = 'idle' | 'entering' | 'active' | 'exiting' | 'interrupted';

export const ANIM_PHASES: readonly AnimPhase[] = Object.freeze(['idle', 'entering', 'active', 'exiting', 'interrupted']);

export const ANIM_LIMITS = Object.freeze({
  /** Full 0→1 fade-in time. A partial leg takes a proportional share. */
  enterMs: 220,
  /** Full 1→0 fade-out time. */
  exitMs: 180,
  /** Bounds applied to any custom duration. */
  minMs: 0,
  maxMs: 2000,
  /** Guard for the settle loop; a machine never needs more than two legs to resolve. */
  maxSettleSteps: 4,
});

export type AnimMachine = Readonly<{
  phase: AnimPhase;
  /** Content currently rendered in the slot (null when idle). */
  shown: string | null;
  /** Content the slot is heading towards (null means hide). */
  target: string | null;
  /** Progress at `startedAt`. */
  from: number;
  /** Progress the current leg ends at. */
  to: number;
  startedAt: number;
  durationMs: number;
  reducedMotion: boolean;
  enterMs: number;
  exitMs: number;
  /** Count of mid-leg interruptions since creation (diagnostic only). */
  interruptions: number;
}>;

export type AnimEvent =
  | { type: 'show'; target: string }
  | { type: 'hide' }
  | { type: 'tick' }
  | { type: 'cancel' };

export type AnimOptions = {
  reducedMotion: boolean;
  now?: number;
  /** Content shown fully at creation (no entry animation on first paint). */
  initial?: string | null;
  enterMs?: number;
  exitMs?: number;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampMs(n: unknown, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(ANIM_LIMITS.maxMs, Math.max(ANIM_LIMITS.minMs, n));
}

function finiteOr(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function freeze(m: AnimMachine): AnimMachine {
  return Object.freeze({ ...m });
}

export function createAnimMachine(opts: AnimOptions): AnimMachine {
  const now = finiteOr(opts?.now, 0);
  const initial = typeof opts?.initial === 'string' ? opts.initial : null;
  return freeze({
    phase: initial === null ? 'idle' : 'active',
    shown: initial,
    target: initial,
    from: initial === null ? 0 : 1,
    to: initial === null ? 0 : 1,
    startedAt: now,
    durationMs: 0,
    reducedMotion: Boolean(opts?.reducedMotion),
    enterMs: clampMs(opts?.enterMs, ANIM_LIMITS.enterMs),
    exitMs: clampMs(opts?.exitMs, ANIM_LIMITS.exitMs),
    interruptions: 0,
  });
}

/** Visibility of `shown` at `atMs`, clamped 0..1. Deterministic: same machine and time always give the same value. */
export function progressAt(m: AnimMachine, atMs: number): number {
  const t = finiteOr(atMs, m.startedAt);
  if (m.durationMs <= 0) return clamp01(m.to);
  const k = clamp01((t - m.startedAt) / m.durationMs);
  return clamp01(m.from + (m.to - m.from) * k);
}

/** True when the current leg has finished (or there is no leg). */
export function isDoneAt(m: AnimMachine, atMs: number): boolean {
  return m.durationMs <= 0 || finiteOr(atMs, m.startedAt) >= m.startedAt + m.durationMs;
}

/** True when nothing more will change without a new event: idle, or active on the requested target. */
export function isSettled(m: AnimMachine): boolean {
  return m.phase === 'idle' || (m.phase === 'active' && m.durationMs <= 0);
}

function leg(m: AnimMachine, phase: AnimPhase, shown: string | null, target: string | null, from: number, to: number, at: number, interrupted: boolean): AnimMachine {
  const full = to > from ? m.enterMs : m.exitMs;
  const durationMs = m.reducedMotion ? 0 : Math.round(full * Math.abs(to - from));
  return freeze({ ...m, phase, shown, target, from: clamp01(from), to: clamp01(to), startedAt: at, durationMs, interruptions: m.interruptions + (interrupted ? 1 : 0) });
}

function idleAt(m: AnimMachine, at: number): AnimMachine {
  return freeze({ ...m, phase: 'idle', shown: null, target: null, from: 0, to: 0, startedAt: at, durationMs: 0 });
}

function activeAt(m: AnimMachine, shown: string, at: number): AnimMachine {
  return freeze({ ...m, phase: 'active', shown, target: shown, from: 1, to: 1, startedAt: at, durationMs: 0 });
}

/** Resolves every leg that has completed by `at`, chaining exit → enter(next) at the exact completion time. */
function settle(m: AnimMachine, at: number): AnimMachine {
  let cur = m;
  for (let i = 0; i < ANIM_LIMITS.maxSettleSteps; i++) {
    if (isSettled(cur) || !isDoneAt(cur, at)) return cur;
    const end = cur.startedAt + cur.durationMs;
    if (cur.to >= 1 && cur.shown !== null) {
      cur = activeAt(cur, cur.shown, end);
    } else if (cur.target !== null) {
      // Faded out fully: swap in the next content and fade it in from 0.
      cur = leg(cur, 'entering', cur.target, cur.target, 0, 1, end, false);
    } else {
      cur = idleAt(cur, end);
    }
  }
  return cur;
}

/** A leg is running (not idle, not resting at active) and has not finished yet. */
function inFlight(m: AnimMachine, at: number): boolean {
  return !isSettled(m) && !isDoneAt(m, at);
}

/** Applies one event at `atMs` and returns a new frozen machine. Never mutates `m`. Time never runs backwards. */
export function transition(m: AnimMachine, event: AnimEvent, atMs: number): AnimMachine {
  const at = Math.max(m.startedAt, finiteOr(atMs, m.startedAt));
  if (!event || event.type === 'cancel') return event ? cancel(m, at) : freeze(m);

  if (m.reducedMotion) {
    if (event.type === 'show' && typeof event.target === 'string') return activeAt(m, event.target, at);
    if (event.type === 'hide') return idleAt(m, at);
    return settle(m, at);
  }

  const s = settle(m, at);
  if (event.type === 'tick') return s;
  const p = progressAt(s, at);
  const running = inFlight(s, at);

  if (event.type === 'hide') {
    if (s.phase === 'idle' || s.shown === null) return idleAt(s, at);
    if (s.to <= 0 && s.target === null) return s; // already fading out to nothing
    return leg(s, running ? 'interrupted' : 'exiting', s.shown, null, p, 0, at, running);
  }

  if (event.type !== 'show' || typeof event.target !== 'string') return s;
  const target = event.target;

  if (s.phase === 'idle' || s.shown === null) return leg(s, 'entering', target, target, 0, 1, at, false);

  if (s.shown === target) {
    if (s.to >= 1) return s.target === target ? s : freeze({ ...s, target });
    // Fading this same content out: reverse from the current progress.
    return leg(s, 'interrupted', target, target, p, 1, at, true);
  }

  // Different content: fade the current one out from where it is, then the settle step swaps in the target.
  if (p <= 0) return leg(s, 'entering', target, target, 0, 1, at, false);
  if (s.to <= 0 && running) return s.target === target ? s : freeze({ ...s, target });
  return leg(s, running ? 'interrupted' : 'exiting', s.shown, target, p, 0, at, running);
}

/** Stops any running leg and returns to idle immediately. */
export function cancel(m: AnimMachine, atMs?: number): AnimMachine {
  return idleAt(m, Math.max(m.startedAt, finiteOr(atMs, m.startedAt)));
}

/** Changes the reduced-motion flag; turning it on collapses any running leg to its end state immediately. */
export function setReducedMotion(m: AnimMachine, reducedMotion: boolean, atMs: number): AnimMachine {
  const at = Math.max(m.startedAt, finiteOr(atMs, m.startedAt));
  const next = freeze({ ...m, reducedMotion: Boolean(reducedMotion) });
  if (!next.reducedMotion) return next;
  return finish(next, at);
}

/** Jumps straight to where the machine is heading: active on the target, or idle. */
export function finish(m: AnimMachine, atMs?: number): AnimMachine {
  const at = Math.max(m.startedAt, finiteOr(atMs, m.startedAt));
  if (m.target === null) return isSettled(m) && m.phase === 'idle' ? freeze(m) : idleAt(m, at);
  return activeAt(m, m.target, at);
}

/** Small render snapshot for hosts: what to draw and how visible it is. */
export type AnimView = Readonly<{ phase: AnimPhase; shown: string | null; progress: number }>;

export function viewAt(m: AnimMachine, atMs: number): AnimView {
  return Object.freeze({ phase: m.phase, shown: m.shown, progress: Math.round(progressAt(m, atMs) * 1000) / 1000 });
}
