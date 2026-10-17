/**
 * Pet state adapter (PET-RENDERER-PLAN.md section 5). Turns real companion signals and events into what the pet
 * shows, by a fixed priority list. It never invents activity: every view traces to a main-process signal or a
 * person's input, and carries a short reason for the accessible status text. No clock, DOM or React: callers pass
 * the time with every call.
 *
 * Listening and speaking are not in the v2 contract, so voice state never maps to a row here.
 */
import { REDUCED_MOTION_KEY_FRAME, angleToLookIndex, rowDurationMs, type PetState } from './contract';

export type PetSurface = 'rest' | 'command' | 'working' | 'answer' | 'error';
export type PetFailure = 'setup' | 'refused' | 'truncated' | 'steps' | 'provider' | 'network' | 'cancelled';

export type PetSignals = Readonly<{
  surface: PetSurface;
  /** Status 'sending'/'thinking' or a tool 'running'. */
  requestInFlight: boolean;
  /** A tool step in 'awaiting-confirm'. */
  awaitingPerson: boolean;
  failure: PetFailure | null;
  /** px/s while the person drags the pet; null when not dragging. */
  dragVx: number | null;
  /** Degrees clockwise from up, from the local cursor; null in the deadzone or when stale. */
  gaze: number | null;
  reducedMotion: boolean;
}>;

export type PetEvent = { kind: 'invoked' } | { kind: 'verified-change' } | { kind: 'answer-shown' };

export type PetStateView = Readonly<{
  kind: 'state';
  state: PetState;
  /** Loops until the signals change. */
  loop: boolean;
  /** Reduced motion: draw `frame` only, with no animation. */
  still: boolean;
  reason: string;
  /** When this state began; animation starts here. */
  since: number;
  /** Passes through the row for a non-looping animation; 0 when looping or still. */
  plays: number;
  /** After its passes, stays on the last frame. */
  holdLast: boolean;
  /** The key frame when still; null when animated. */
  frame: number | null;
  /** When the view ends by itself (one-shots and review); null otherwise. */
  until: number | null;
}>;
export type PetLookView = Readonly<{ kind: 'look'; index: number; reason: string }>;
export type PetView = PetStateView | PetLookView;

export type PetAdapter = {
  signal(s: PetSignals, now: number): void;
  event(e: PetEvent, now: number): void;
  view(now: number): PetView;
};

/** Drag speed (px/s) at which the pet runs instead of being carried. */
export const DRAG_RUN_MIN_VX = 60;
export const REVIEW_PLAYS = 2;

export const RESTING_SIGNALS: PetSignals = Object.freeze({
  surface: 'rest',
  requestInFlight: false,
  awaitingPerson: false,
  failure: null,
  dragVx: null,
  gaze: null,
  reducedMotion: false,
});

const FAILURE_REASONS: Readonly<Record<Exclude<PetFailure, 'cancelled'>, string>> = Object.freeze({
  setup: 'Stopped: the AI provider is not set up yet',
  refused: 'Stopped: the request was refused',
  truncated: 'Stopped: the reply was cut off at the length limit',
  steps: 'Stopped: the step limit was reached',
  provider: 'Stopped: the AI provider returned an error',
  network: 'Stopped: the network request failed',
});

type OneShot = { state: 'jumping' | 'waving'; since: number; until: number };
type Timed = { since: number; until: number };
type Base = { state: PetState; reason: string; loop: boolean };

const ONE_SHOT_RANK: Readonly<Record<OneShot['state'], number>> = { jumping: 2, waving: 1 };

const finiteOrNull = (v: number | null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Rules 1-4: states held by the current signals. */
function baseRule(s: PetSignals): Base | null {
  if (s.dragVx !== null && Math.abs(s.dragVx) >= DRAG_RUN_MIN_VX) {
    return s.dragVx > 0
      ? { state: 'running-right', reason: 'Running right as you drag it', loop: true }
      : { state: 'running-left', reason: 'Running left as you drag it', loop: true };
  }
  if (s.failure !== null && s.failure !== 'cancelled') return { state: 'failed', reason: FAILURE_REASONS[s.failure], loop: false };
  if (s.awaitingPerson) return { state: 'waiting', reason: 'Waiting for your answer in the confirmation', loop: true };
  if (s.requestInFlight || s.surface === 'working') return { state: 'running', reason: 'Working on your request', loop: true };
  return null;
}

function idleReason(s: PetSignals): string {
  if (s.failure === 'cancelled') return 'Stopped because you cancelled';
  if (s.dragVx !== null) return 'Being carried while you move it';
  if (s.surface === 'command') return 'Ready for your request';
  if (s.surface === 'answer') return 'Showing the answer';
  return 'Resting until you need it';
}

export function createPetAdapter(startAt = 0): PetAdapter {
  let signals: PetSignals = RESTING_SIGNALS;
  let baseKey: PetState | null = null;
  let baseSince = startAt;
  let oneShot: OneShot | null = null;
  let review: Timed | null = null;

  const stateView = (state: PetState, reason: string, since: number, motion: { loop: boolean; plays: number; holdLast: boolean }, until: number | null): PetStateView => {
    const still = signals.reducedMotion;
    return Object.freeze({
      kind: 'state',
      state,
      loop: still ? false : motion.loop,
      still,
      reason,
      since,
      plays: still || motion.loop ? 0 : motion.plays,
      holdLast: still ? false : motion.holdLast,
      frame: still ? REDUCED_MOTION_KEY_FRAME[state] : null,
      until,
    });
  };

  return {
    signal(s, now) {
      const next: PetSignals = Object.freeze({
        surface: s.surface,
        requestInFlight: s.requestInFlight === true,
        awaitingPerson: s.awaitingPerson === true,
        failure: s.failure ?? null,
        dragVx: finiteOrNull(s.dragVx),
        gaze: finiteOrNull(s.gaze),
        reducedMotion: s.reducedMotion === true,
      });
      const key = baseRule(next)?.state ?? null;
      if (key !== baseKey) {
        baseKey = key;
        baseSince = now;
      }
      if (signals.surface === 'answer' && next.surface !== 'answer') review = null;
      signals = next;
    },

    event(e, now) {
      if (e.kind === 'answer-shown') {
        review = { since: now, until: now + REVIEW_PLAYS * rowDurationMs('review') };
        return;
      }
      const state = e.kind === 'verified-change' ? 'jumping' : 'waving';
      if (oneShot && now < oneShot.until && ONE_SHOT_RANK[state] < ONE_SHOT_RANK[oneShot.state]) return;
      oneShot = { state, since: now, until: now + rowDurationMs(state) };
    },

    view(now) {
      const base = baseRule(signals);
      if (base) return stateView(base.state, base.reason, baseSince, { loop: base.loop, plays: 1, holdLast: !base.loop }, null);

      if (oneShot && now < oneShot.until) {
        const reason = oneShot.state === 'jumping' ? 'A change was verified' : 'Saying hello: you opened the companion';
        return stateView(oneShot.state, reason, oneShot.since, { loop: false, plays: 1, holdLast: false }, oneShot.until);
      }
      if (review && signals.surface === 'answer' && now < review.until) {
        return stateView('review', 'Looking over the answer just shown', review.since, { loop: false, plays: REVIEW_PLAYS, holdLast: false }, review.until);
      }
      if (signals.gaze !== null && !signals.reducedMotion && (signals.surface === 'rest' || signals.surface === 'command')) {
        return Object.freeze({ kind: 'look', index: angleToLookIndex(signals.gaze), reason: 'Looking toward your pointer' });
      }

      let since = baseSince;
      if (oneShot && oneShot.until <= now) since = Math.max(since, oneShot.until);
      if (review && signals.surface === 'answer' && review.until <= now) since = Math.max(since, review.until);
      return stateView('idle', idleReason(signals), since, { loop: true, plays: 0, holdLast: false }, null);
    },
  };
}
