/**
 * Motion Lab timing: easing, cubic-bezier, damped springs, keyframe tracks, frame/loop maths,
 * seeded noise and bounded quality profiles.
 *
 * Pure and DOM-free so every function can be unit tested in Node. Nothing here reads a clock:
 * callers pass an explicit frame or time, so the same input always produces the same output.
 * That is what makes frame stepping, exact loops and contact sheets repeatable.
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** Fractional part that is always in [0, 1), also for negative input. */
export const fract = (v: number): number => v - Math.floor(v);
/** Euclidean modulo: always in [0, m). */
export const mod = (v: number, m: number): number => ((v % m) + m) % m;
/** Round to a fixed number of decimals so derived geometry is stable and compact. */
export const round = (v: number, places = 2): number => {
  const k = 10 ** places;
  return Math.round(v * k) / k;
};
export const smoothstep = (e0: number, e1: number, v: number): number => {
  const u = clamp01((v - e0) / (e1 - e0));
  return u * u * (3 - 2 * u);
};

const finite = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/* =====================================================================================
 * Easing
 * ===================================================================================== */

export type EasingName =
  | 'linear'
  | 'hold'
  | 'in-quad'
  | 'out-quad'
  | 'in-out-quad'
  | 'in-cubic'
  | 'out-cubic'
  | 'in-out-cubic'
  | 'in-out-sine'
  | 'out-expo'
  | 'anticipate'
  | 'overshoot'
  | 'anticipate-overshoot'
  | 'out-elastic';

const C1 = 1.70158;
const C2 = C1 * 1.525;
const C3 = C1 + 1;

/** Named curves. `anticipate` pulls back before moving (in-back); `overshoot` passes the target and settles (out-back). */
export const EASINGS: Record<EasingName, (u: number) => number> = {
  linear: (u) => u,
  hold: (u) => (u >= 1 ? 1 : 0),
  'in-quad': (u) => u * u,
  'out-quad': (u) => 1 - (1 - u) * (1 - u),
  'in-out-quad': (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2),
  'in-cubic': (u) => u * u * u,
  'out-cubic': (u) => 1 - (1 - u) ** 3,
  'in-out-cubic': (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
  'in-out-sine': (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  'out-expo': (u) => (u >= 1 ? 1 : 1 - 2 ** (-10 * u)),
  anticipate: (u) => C3 * u * u * u - C1 * u * u,
  overshoot: (u) => 1 + C3 * (u - 1) ** 3 + C1 * (u - 1) ** 2,
  'anticipate-overshoot': (u) => (u < 0.5 ? ((2 * u) ** 2 * ((C2 + 1) * 2 * u - C2)) / 2 : ((2 * u - 2) ** 2 * ((C2 + 1) * (u * 2 - 2) + C2) + 2) / 2),
  'out-elastic': (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
};

export const EASING_LIST: { id: EasingName; name: string; css: string | null }[] = [
  { id: 'linear', name: 'Linear', css: 'linear' },
  { id: 'hold', name: 'Hold', css: 'steps(1, end)' },
  { id: 'in-quad', name: 'Ease in (quad)', css: 'cubic-bezier(0.11, 0, 0.5, 0)' },
  { id: 'out-quad', name: 'Ease out (quad)', css: 'cubic-bezier(0.5, 1, 0.89, 1)' },
  { id: 'in-out-quad', name: 'Ease in out (quad)', css: 'cubic-bezier(0.45, 0, 0.55, 1)' },
  { id: 'in-cubic', name: 'Ease in (cubic)', css: 'cubic-bezier(0.32, 0, 0.67, 0)' },
  { id: 'out-cubic', name: 'Ease out (cubic)', css: 'cubic-bezier(0.33, 1, 0.68, 1)' },
  { id: 'in-out-cubic', name: 'Ease in out (cubic)', css: 'cubic-bezier(0.65, 0, 0.35, 1)' },
  { id: 'in-out-sine', name: 'Ease in out (sine)', css: 'cubic-bezier(0.37, 0, 0.63, 1)' },
  { id: 'out-expo', name: 'Ease out (expo)', css: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { id: 'anticipate', name: 'Anticipate', css: 'cubic-bezier(0.36, 0, 0.66, -0.56)' },
  { id: 'overshoot', name: 'Overshoot', css: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  { id: 'anticipate-overshoot', name: 'Anticipate and overshoot', css: 'cubic-bezier(0.68, -0.6, 0.32, 1.6)' },
  { id: 'out-elastic', name: 'Elastic settle', css: null },
];

export const isEasingName = (v: unknown): v is EasingName => typeof v === 'string' && Object.prototype.hasOwnProperty.call(EASINGS, v);

/**
 * CSS-style cubic-bezier timing function. x handles are clamped to 0..1 (so time stays monotonic);
 * y handles may leave 0..1 for anticipation and overshoot. Solved with Newton steps and a bisection fallback.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const ax1 = clamp01(x1);
  const ax2 = clamp01(x2);
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * ax1 + 3 * (1 - t) * t * t * ax2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  const dx = (t: number) => 3 * (1 - t) * (1 - t) * ax1 + 6 * (1 - t) * t * (ax2 - ax1) + 3 * t * t * (1 - ax2);
  return (u: number) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let t = u;
    for (let i = 0; i < 8; i++) {
      const err = bx(t) - u;
      if (Math.abs(err) < 1e-7) return by(t);
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t = clamp01(t - err / d);
    }
    let lo = 0;
    let hi = 1;
    t = u;
    for (let i = 0; i < 40; i++) {
      const v = bx(t);
      if (Math.abs(v - u) < 1e-7) break;
      if (v < u) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return by(t);
  };
}

/* =====================================================================================
 * Springs (closed form, no integration, so any time can be evaluated directly)
 * ===================================================================================== */

export type SpringParams = { stiffness: number; damping: number; mass: number };

export const SPRING_LIMITS = { stiffness: { min: 10, max: 600 }, damping: { min: 1, max: 80 }, mass: { min: 0.2, max: 5 } } as const;
export const DEFAULT_SPRING: SpringParams = { stiffness: 170, damping: 14, mass: 1 };

export function normalizeSpring(input: unknown): SpringParams {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    stiffness: round(clamp(finite(o.stiffness, DEFAULT_SPRING.stiffness), SPRING_LIMITS.stiffness.min, SPRING_LIMITS.stiffness.max), 1),
    damping: round(clamp(finite(o.damping, DEFAULT_SPRING.damping), SPRING_LIMITS.damping.min, SPRING_LIMITS.damping.max), 1),
    mass: round(clamp(finite(o.mass, DEFAULT_SPRING.mass), SPRING_LIMITS.mass.min, SPRING_LIMITS.mass.max), 2),
  };
}

/** zeta < 1 bounces, = 1 is critically damped, > 1 creeps in without overshoot. */
export const dampingRatio = (p: SpringParams): number => p.damping / (2 * Math.sqrt(p.stiffness * p.mass));

/** Position of a spring released from 0 at rest towards 1, at `t` seconds. Exact solution of m x'' + c x' + k (x - 1) = 0. */
export function springValue(p: SpringParams, t: number): number {
  if (!(t > 0)) return 0;
  const w0 = Math.sqrt(p.stiffness / p.mass);
  const zeta = dampingRatio(p);
  if (zeta < 1 - 1e-9) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-zeta * w0 * t);
    return 1 - e * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  }
  if (zeta <= 1 + 1e-9) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const s = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - s);
  const r2 = -w0 * (zeta + s);
  // x(0) = 0 and x'(0) = 0 for the displacement e(t) = 1 - x(t): e = A e^{r1 t} + B e^{r2 t}, A + B = 1, r1 A + r2 B = 0.
  const a = r2 / (r2 - r1);
  const b = 1 - a;
  return 1 - (a * Math.exp(r1 * t) + b * Math.exp(r2 * t));
}

/** Seconds until the spring stays within `tolerance` of its target. Scanned at 1 ms, capped at 10 s. */
export function springSettleTime(p: SpringParams, tolerance = 0.001): number {
  const dt = 0.001;
  let last = 0;
  for (let t = 0; t <= 10; t += dt) if (Math.abs(1 - springValue(p, t)) > tolerance) last = t;
  return round(Math.min(10, last + dt), 3);
}

/** Largest overshoot past the target as a fraction (0.12 means 12% beyond). */
export function springOvershoot(p: SpringParams): number {
  let peak = 0;
  for (let t = 0; t <= 10; t += 0.002) peak = Math.max(peak, springValue(p, t));
  return round(Math.max(0, peak - 1), 4);
}

/**
 * Spring used as a segment easing. The physical curve runs in real seconds; the last 15% of the segment
 * blends any unsettled remainder to exactly 1 so a keyframe always lands on its value. When the segment is
 * shorter than the settle time the blend is visible, and the editor says so (see springFitsSegment).
 */
export function springEase(p: SpringParams, segmentSeconds: number): (u: number) => number {
  const dur = Math.max(1e-3, segmentSeconds);
  return (u: number) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    const v = springValue(p, u * dur);
    return 1 - (1 - v) * (1 - smoothstep(0.85, 1, u));
  };
}

export const springFitsSegment = (p: SpringParams, segmentSeconds: number): boolean => springSettleTime(p) <= segmentSeconds + 1e-9;

/* =====================================================================================
 * Ease specs (what keyframes store)
 * ===================================================================================== */

export type Ease =
  | { type: 'preset'; name: EasingName }
  | { type: 'bezier'; x1: number; y1: number; x2: number; y2: number }
  | ({ type: 'spring' } & SpringParams);

export const DEFAULT_EASE: Ease = { type: 'preset', name: 'in-out-cubic' };
export const BEZIER_Y_LIMIT = { min: -1, max: 2 } as const;

export function normalizeEase(input: unknown): Ease {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (o.type === 'bezier') {
    const y = (v: unknown, f: number) => round(clamp(finite(v, f), BEZIER_Y_LIMIT.min, BEZIER_Y_LIMIT.max), 3);
    return { type: 'bezier', x1: round(clamp01(finite(o.x1, 0.25)), 3), y1: y(o.y1, 0.1), x2: round(clamp01(finite(o.x2, 0.25)), 3), y2: y(o.y2, 1) };
  }
  if (o.type === 'spring') return { type: 'spring', ...normalizeSpring(o) };
  if (o.type === 'preset' && isEasingName(o.name)) return { type: 'preset', name: o.name };
  return { ...DEFAULT_EASE };
}

/** The curve for one segment. Springs need the segment length in seconds; the others ignore it. */
export function easeFn(ease: Ease, segmentSeconds = 1): (u: number) => number {
  if (ease.type === 'bezier') return cubicBezier(ease.x1, ease.y1, ease.x2, ease.y2);
  if (ease.type === 'spring') return springEase(ease, segmentSeconds);
  return EASINGS[ease.name] ?? EASINGS.linear;
}

export const evaluateEase = (ease: Ease, u: number, segmentSeconds = 1): number => easeFn(ease, segmentSeconds)(clamp01(u));

/** Evenly spaced samples of a curve, for previews and CSS linear() export. */
export function sampleEase(ease: Ease, count: number, segmentSeconds = 1): { u: number; v: number }[] {
  const n = Math.max(2, Math.min(240, Math.round(count)));
  const fn = easeFn(ease, segmentSeconds);
  return Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1);
    return { u, v: fn(u) };
  });
}

/** Lowest and highest value a curve reaches, so a preview can frame anticipation and overshoot. */
export function easeRange(ease: Ease, segmentSeconds = 1): { min: number; max: number } {
  const pts = sampleEase(ease, 160, segmentSeconds);
  return { min: Math.min(0, ...pts.map((p) => p.v)), max: Math.max(1, ...pts.map((p) => p.v)) };
}

/**
 * A CSS timing function equivalent. Named curves with a bezier twin and custom beziers map to cubic-bezier();
 * springs and elastic curves are sampled into CSS linear() (Chromium 113 and later, which Electron ships).
 */
export function easeToCss(ease: Ease, segmentSeconds = 1): string {
  if (ease.type === 'bezier') return `cubic-bezier(${ease.x1}, ${ease.y1}, ${ease.x2}, ${ease.y2})`;
  if (ease.type === 'preset') {
    const css = EASING_LIST.find((e) => e.id === ease.name)?.css;
    if (css) return css;
  }
  const pts = sampleEase(ease, 40, segmentSeconds);
  return `linear(${pts.map((p) => round(p.v, 4)).join(', ')})`;
}

export function describeEase(ease: Ease): string {
  if (ease.type === 'bezier') return `Bezier ${ease.x1}, ${ease.y1}, ${ease.x2}, ${ease.y2}`;
  if (ease.type === 'spring') return `Spring k${ease.stiffness} c${ease.damping} m${ease.mass}`;
  return EASING_LIST.find((e) => e.id === ease.name)?.name ?? ease.name;
}

/* =====================================================================================
 * Timeline and frames
 * ===================================================================================== */

export const TIMELINE_FPS = [12, 24, 30, 60] as const;
export type TimelineFps = (typeof TIMELINE_FPS)[number];
export const TIMELINE_LIMITS = { minFrames: 2, maxFrames: 1200, maxSeconds: 20 } as const;

export type Timeline = {
  fps: TimelineFps;
  /** Total frames. A loop shows frames 0..frames-1 and frame `frames` is identical to frame 0. */
  frames: number;
  loop: boolean;
  /** Frame shown as the still when reduced motion is on, and the default PNG/SVG frame. */
  poster: number;
};

export const DEFAULT_TIMELINE: Timeline = { fps: 30, frames: 180, loop: true, poster: 45 };

export function normalizeTimeline(input: unknown): Timeline {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const fps: TimelineFps = (TIMELINE_FPS as readonly number[]).includes(o.fps as number) ? (o.fps as TimelineFps) : DEFAULT_TIMELINE.fps;
  const maxFrames = Math.min(TIMELINE_LIMITS.maxFrames, fps * TIMELINE_LIMITS.maxSeconds);
  const frames = Math.round(clamp(finite(o.frames, DEFAULT_TIMELINE.frames), TIMELINE_LIMITS.minFrames, maxFrames));
  const loop = typeof o.loop === 'boolean' ? o.loop : DEFAULT_TIMELINE.loop;
  const poster = Math.round(clamp(finite(o.poster, Math.min(DEFAULT_TIMELINE.poster, frames - 1)), 0, frames - 1));
  return { fps, frames, loop, poster };
}

/** Exact time of a frame. Frames are the unit of truth; time is derived, never accumulated. */
export const frameToTime = (frame: number, fps: number): number => frame / fps;
/** Frame shown at a time. The small epsilon stops 0.1 * 30 = 2.9999999 landing on frame 2. */
export const timeToFrame = (seconds: number, fps: number): number => Math.floor(seconds * fps + 1e-6);
export const loopSeconds = (tl: Timeline): number => tl.frames / tl.fps;
export const lastFrame = (tl: Timeline): number => tl.frames - 1;

/** Move by `delta` frames. Loops wrap; one-shot timelines clamp at the ends. */
export function stepFrame(frame: number, delta: number, tl: Timeline): number {
  const f = Math.round(frame) + Math.round(delta);
  return tl.loop ? mod(f, tl.frames) : clamp(f, 0, tl.frames - 1);
}

/** Frame reached `elapsedSeconds` after starting playback at `startFrame`, and whether a one-shot ended. */
export function playbackFrame(startFrame: number, elapsedSeconds: number, tl: Timeline): { frame: number; ended: boolean } {
  const f = startFrame + timeToFrame(Math.max(0, elapsedSeconds), tl.fps);
  if (tl.loop) return { frame: mod(f, tl.frames), ended: false };
  return f >= tl.frames - 1 ? { frame: tl.frames - 1, ended: true } : { frame: f, ended: false };
}

/** "s:ff" timecode, e.g. 2:07 is two seconds and seven frames. */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame));
  const s = Math.floor(f / fps);
  return `${s}:${String(f % fps).padStart(2, '0')}`;
}

/**
 * Whole number of base cycles that fit in the loop for a playback rate, so periodic motion ends exactly
 * where it began. A rate of 0 stays frozen; any positive rate gets at least one cycle.
 */
export function loopCycles(cyclesPerSecond: number, seconds: number): number {
  if (!(cyclesPerSecond > 0) || !(seconds > 0)) return 0;
  return Math.max(1, Math.round(cyclesPerSecond * seconds));
}

/**
 * Base phase in radians at a frame. In a loop the phase advances a whole number of turns over the loop,
 * so phase(frames) is phase(0) plus a multiple of TAU and the seam is exact. Off loop it uses the raw rate.
 */
export function framePhase(frame: number, tl: Timeline, cyclesPerSecond: number): number {
  const t = frameToTime(frame, tl.fps);
  if (!tl.loop) return TAU * cyclesPerSecond * t;
  const L = loopSeconds(tl);
  return (TAU * loopCycles(cyclesPerSecond, L) * t) / L;
}

/* =====================================================================================
 * Keyframe tracks
 * ===================================================================================== */

export type Keyframe = { frame: number; value: number; /** Curve from this key to the next one. */ ease: Ease };
export const MAX_KEYS = 16;

/** Sort by frame, drop duplicates (the later entry wins), clamp frames into the timeline. */
export function normalizeKeys(input: unknown, frames: number, lo: number, hi: number): Keyframe[] {
  if (!Array.isArray(input)) return [];
  const byFrame = new Map<number, Keyframe>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const v = finite(o.value, NaN);
    if (!Number.isFinite(v)) continue;
    const frame = Math.round(clamp(finite(o.frame, 0), 0, frames - 1));
    byFrame.set(frame, { frame, value: round(clamp(v, lo, hi), 2), ease: normalizeEase(o.ease) });
  }
  return Array.from(byFrame.values())
    .sort((a, b) => a.frame - b.frame)
    .slice(0, MAX_KEYS);
}

/**
 * Value of a track at a frame (fractional frames allowed). Before the first key and after the last key a
 * one-shot timeline holds the end values. A looping timeline treats the track as circular: after the last key
 * it eases towards the first key again, arriving exactly at frame `frames`, so the loop seam is continuous.
 */
export function evaluateKeys(keys: readonly Keyframe[], frame: number, tl: Timeline): number | null {
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0].value;
  const segSeconds = (a: number, b: number) => (b - a) / tl.fps;
  const seg = (a: Keyframe, b: Keyframe, bFrame: number, f: number) => {
    const span = bFrame - a.frame;
    if (span <= 0) return b.value;
    const u = (f - a.frame) / span;
    return lerp(a.value, b.value, easeFn(a.ease, segSeconds(a.frame, bFrame))(clamp01(u)));
  };
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (tl.loop) {
    const f = mod(frame, tl.frames);
    if (f >= last.frame) return seg(last, first, first.frame + tl.frames, f);
    if (f < first.frame) return seg(last, first, first.frame + tl.frames, f + tl.frames);
    for (let i = 0; i < keys.length - 1; i++) if (f < keys[i + 1].frame) return seg(keys[i], keys[i + 1], keys[i + 1].frame, f);
    return last.value;
  }
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < keys.length - 1; i++) if (frame < keys[i + 1].frame) return seg(keys[i], keys[i + 1], keys[i + 1].frame, frame);
  return last.value;
}

/** Insert or replace a key at a frame and keep the list sorted and bounded. Returns ok false when full. */
export function upsertKey(keys: readonly Keyframe[], key: Keyframe): { keys: Keyframe[]; ok: boolean } {
  const i = keys.findIndex((k) => k.frame === key.frame);
  if (i >= 0) return { keys: keys.map((k, j) => (j === i ? key : k)), ok: true };
  if (keys.length >= MAX_KEYS) return { keys: [...keys], ok: false };
  return { keys: [...keys, key].sort((a, b) => a.frame - b.frame), ok: true };
}

/* =====================================================================================
 * Seeded randomness and loopable noise
 * ===================================================================================== */

/** Small, fast 32-bit generator. Same seed, same sequence, on every machine. */
export function seededRandom(seed: number): () => number {
  let a = (Math.trunc(seed) >>> 0) || 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless hash of (seed, index) to [0, 1). Lets any element be looked up without generating the ones before it. */
export function hash01(seed: number, index: number): number {
  let h = Math.imul((Math.trunc(seed) >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.trunc(index) >>> 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Smooth noise in about -1..1 built only from whole-number harmonics of `phase`, so it repeats exactly every
 * TAU. Seeded phases and weights make each (seed, channel) look different.
 */
export function loopNoise(seed: number, channel: number, phase: number, harmonics = 3): number {
  let sum = 0;
  let norm = 0;
  for (let h = 1; h <= harmonics; h++) {
    const w = 1 / h;
    sum += w * Math.sin(h * phase + hash01(seed, channel * 31 + h) * TAU);
    norm += w;
  }
  return sum / norm;
}

/* =====================================================================================
 * Quality and resource profiles
 * ===================================================================================== */

export type QualityId = 'eco' | 'balanced' | 'studio';
export type QualityProfile = {
  id: QualityId;
  name: string;
  blurb: string;
  /** Upper bound on canvas device pixel ratio. */
  maxDpr: number;
  /** Highest preview frame rate; the timeline rate is used when lower. */
  fpsCap: number;
  /** Upper bound on particles, lattice nodes and similar per layer. */
  elementCap: number;
  /** Horizontal sampling step for curves, in CSS pixels. */
  curveStep: number;
  /** Soft glows (radial gradients) are the most expensive fill; eco skips them. */
  glow: boolean;
  /** Paint budget in milliseconds; sustained overruns suggest a lighter profile. */
  budgetMs: number;
};

export const QUALITY_PROFILES: Record<QualityId, QualityProfile> = {
  eco: { id: 'eco', name: 'Eco', blurb: '1x pixels, 30 fps cap, fewer elements, no glows. Kindest to battery.', maxDpr: 1, fpsCap: 30, elementCap: 60, curveStep: 8, glow: false, budgetMs: 6 },
  balanced: { id: 'balanced', name: 'Balanced', blurb: 'Up to 1.5x pixels, 60 fps cap, soft glows.', maxDpr: 1.5, fpsCap: 60, elementCap: 120, curveStep: 5, glow: true, budgetMs: 8 },
  studio: { id: 'studio', name: 'Studio', blurb: 'Up to 2x pixels and every element. For final frames and exports.', maxDpr: 2, fpsCap: 60, elementCap: 200, curveStep: 3, glow: true, budgetMs: 12 },
};
export const QUALITY_IDS = Object.keys(QUALITY_PROFILES) as QualityId[];
export const isQualityId = (v: unknown): v is QualityId => v === 'eco' || v === 'balanced' || v === 'studio';

/** Preview interval between drawn frames in ms: the timeline rate, never above the profile cap. */
export const previewIntervalMs = (tl: Timeline, q: QualityProfile): number => 1000 / Math.min(tl.fps, q.fpsCap);

/** Rolling paint-cost tracker. Pure: returns a new state each call. */
export type PaintStats = { samples: number[]; avg: number; over: number };
export const EMPTY_PAINT_STATS: PaintStats = { samples: [], avg: 0, over: 0 };
export function trackPaint(stats: PaintStats, ms: number, budgetMs: number, size = 30): PaintStats {
  const samples = [...stats.samples, Math.max(0, ms)].slice(-size);
  const avg = round(samples.reduce((a, b) => a + b, 0) / samples.length, 2);
  return { samples, avg, over: samples.filter((s) => s > budgetMs).length };
}
/** True when most recent frames ran over budget, so the UI may suggest a lighter profile. */
export const overBudget = (s: PaintStats): boolean => s.samples.length >= 20 && s.over > s.samples.length / 2;

/* =====================================================================================
 * Contact sheets
 * ===================================================================================== */

/**
 * Representative frames for a contact sheet: evenly spaced across the timeline, always including the first
 * and last frame so a reviewer can compare the loop seam (last frame then frame 0) side by side.
 */
export function contactFrames(tl: Timeline, count: number): number[] {
  const n = Math.max(2, Math.min(36, Math.round(count), tl.frames));
  const last = tl.frames - 1;
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round((i * last) / (n - 1)));
  return Array.from(out).sort((a, b) => a - b);
}

export function contactLayout(count: number, cellWidth: number, aspect = 16 / 9, gap = 6, label = 18): { cols: number; rows: number; cellW: number; cellH: number; width: number; height: number; gap: number; label: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * 1.4)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = Math.round(clamp(cellWidth, 80, 480));
  const cellH = Math.round(cellW / aspect);
  return { cols, rows, cellW, cellH, gap, label, width: cols * cellW + (cols + 1) * gap, height: rows * (cellH + label) + (rows + 1) * gap };
}
