/**
 * Avatar Studio model: geometry, expressions, timelines and portable packs.
 *
 * Pure, DOM-free module (unit tested in Node). The React component in src/components/AvatarStudio.tsx
 * only draws what these functions return. Everything is original 2D vector geometry: a round-headed
 * companion made of a head, visor, eyes, mouth, cheeks and an antenna. No model files, no photographs.
 *
 * Scope covered (roadmap ids): 129 geometry editor, 130 expression library, 131 timeline, 132 packs.
 * 133–136 are listed in AVATAR_GATES with their honest status; nothing there pretends to run.
 */

export const AVATAR_PACK_VERSION = 1 as const;

export type HeadShape = 'round' | 'oval' | 'square' | 'hex';
export type EyeStyle = 'dot' | 'ring' | 'bar';
export type MouthStyle = 'line' | 'arc' | 'bar';

export type AvatarGeometry = {
  headShape: HeadShape;
  /** Width/height of the head as a percentage of the 200-unit stage. */
  headWidth: number;
  headHeight: number;
  eyeStyle: EyeStyle;
  eyeSize: number;
  eyeSpacing: number;
  mouthStyle: MouthStyle;
  mouthWidth: number;
  antenna: boolean;
  antennaHeight: number;
  visor: boolean;
  cheeks: boolean;
  /** Hues (0..360) for the body, the visor/eyes accent and the halo glow. */
  bodyHue: number;
  accentHue: number;
  glowHue: number;
};

export type Expression = {
  /** 0 closed .. 1 fully open. */
  eyeOpen: number;
  /** Gaze shift, -1..1 on both axes. */
  eyeShiftX: number;
  eyeShiftY: number;
  /** -1 frown-brow .. 1 raised. */
  browTilt: number;
  /** 0 closed .. 1 wide open. */
  mouthOpen: number;
  /** -1 sad .. 1 smile. */
  mouthCurve: number;
  /** Head roll in degrees, -15..15. */
  headTilt: number;
  /** Halo intensity 0..1. */
  glow: number;
};

export type ExpressionPreset = { id: string; name: string; expression: Expression };

/**
 * How a pose travels to the next keyframe. `anticipate` dips away from the target first, `overshoot` and
 * `spring` pass the target and settle back (follow-through). Packs from older builds only use the first three;
 * an older reader maps the newer names to `ease`, so the schema version stays 1.
 */
export type Ease = 'hold' | 'linear' | 'ease' | 'in' | 'out' | 'anticipate' | 'overshoot' | 'spring';
export const EASE_OPTIONS: { id: Ease; name: string; hint: string }[] = [
  { id: 'ease', name: 'Ease', hint: 'Smooth start and stop.' },
  { id: 'linear', name: 'Linear', hint: 'Constant speed.' },
  { id: 'hold', name: 'Hold', hint: 'Stay on this pose until the next keyframe, then step.' },
  { id: 'in', name: 'Ease in', hint: 'Starts slowly and arrives quickly.' },
  { id: 'out', name: 'Ease out', hint: 'Leaves quickly and settles gently.' },
  { id: 'anticipate', name: 'Anticipate', hint: 'Pulls back slightly before moving to the next pose.' },
  { id: 'overshoot', name: 'Overshoot', hint: 'Passes the next pose a little and eases back (follow-through).' },
  { id: 'spring', name: 'Spring', hint: 'Overshoots and settles with a damped bounce.' },
];
export type Keyframe = { at: number; expressionId: string; ease: Ease };
export type Timeline = { id: string; name: string; duration: number; loop: boolean; keyframes: Keyframe[] };

export type AvatarPack = {
  version: typeof AVATAR_PACK_VERSION;
  name: string;
  geometry: AvatarGeometry;
  expressions: ExpressionPreset[];
  timelines: Timeline[];
};

export const HEAD_SHAPES: { id: HeadShape; name: string }[] = [
  { id: 'round', name: 'Round' },
  { id: 'oval', name: 'Oval' },
  { id: 'square', name: 'Square' },
  { id: 'hex', name: 'Hex' },
];
export const EYE_STYLES: { id: EyeStyle; name: string }[] = [
  { id: 'dot', name: 'Dot' },
  { id: 'ring', name: 'Ring' },
  { id: 'bar', name: 'Bar' },
];
export const MOUTH_STYLES: { id: MouthStyle; name: string }[] = [
  { id: 'line', name: 'Line' },
  { id: 'arc', name: 'Arc' },
  { id: 'bar', name: 'Bar' },
];

type Range = { min: number; max: number; step: number };
export const GEOMETRY_LIMITS: Record<'headWidth' | 'headHeight' | 'eyeSize' | 'eyeSpacing' | 'mouthWidth' | 'antennaHeight' | 'bodyHue' | 'accentHue' | 'glowHue', Range> = {
  headWidth: { min: 50, max: 100, step: 1 },
  headHeight: { min: 50, max: 100, step: 1 },
  eyeSize: { min: 4, max: 24, step: 1 },
  eyeSpacing: { min: 10, max: 60, step: 1 },
  mouthWidth: { min: 10, max: 60, step: 1 },
  antennaHeight: { min: 0, max: 40, step: 1 },
  bodyHue: { min: 0, max: 360, step: 1 },
  accentHue: { min: 0, max: 360, step: 1 },
  glowHue: { min: 0, max: 360, step: 1 },
};

export const EXPRESSION_LIMITS: Record<keyof Expression, Range> = {
  eyeOpen: { min: 0, max: 1, step: 0.05 },
  eyeShiftX: { min: -1, max: 1, step: 0.05 },
  eyeShiftY: { min: -1, max: 1, step: 0.05 },
  browTilt: { min: -1, max: 1, step: 0.05 },
  mouthOpen: { min: 0, max: 1, step: 0.05 },
  mouthCurve: { min: -1, max: 1, step: 0.05 },
  headTilt: { min: -15, max: 15, step: 1 },
  glow: { min: 0, max: 1, step: 0.05 },
};

/** Resource bounds. Imports beyond these are rejected or trimmed with a warning. */
export const AVATAR_LIMITS = {
  packBytes: 64 * 1024,
  nameLength: 40,
  expressions: 32,
  timelines: 16,
  keyframes: 64,
  minDurationMs: 100,
  maxDurationMs: 30_000,
} as const;

/** Key under the non-sensitive UI preference prefix (see src/ui/prefs.ts). */
export const AVATAR_PREF_KEY = 'avatar.pack';

export const DEFAULT_GEOMETRY: AvatarGeometry = {
  headShape: 'round',
  headWidth: 72,
  headHeight: 68,
  eyeStyle: 'dot',
  eyeSize: 10,
  eyeSpacing: 30,
  mouthStyle: 'arc',
  mouthWidth: 26,
  antenna: true,
  antennaHeight: 18,
  visor: true,
  cheeks: true,
  bodyHue: 214,
  accentHue: 188,
  glowHue: 200,
};

export const NEUTRAL_EXPRESSION: Expression = { eyeOpen: 1, eyeShiftX: 0, eyeShiftY: 0, browTilt: 0, mouthOpen: 0, mouthCurve: 0.2, headTilt: 0, glow: 0.2 };

/** Built-in expressions. Ids carry a reserved prefix so saved ones can never collide. */
export const BUILT_IN_EXPRESSIONS: readonly ExpressionPreset[] = [
  { id: 'builtin:neutral', name: 'Neutral', expression: NEUTRAL_EXPRESSION },
  { id: 'builtin:happy', name: 'Happy', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 0.7, mouthCurve: 1, mouthOpen: 0.25, glow: 0.5 } },
  { id: 'builtin:surprised', name: 'Surprised', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 1, browTilt: 1, mouthOpen: 0.8, mouthCurve: 0, glow: 0.6 } },
  { id: 'builtin:thinking', name: 'Thinking', expression: { ...NEUTRAL_EXPRESSION, eyeShiftX: 0.6, eyeShiftY: -0.6, browTilt: 0.4, mouthCurve: -0.1, headTilt: 8, glow: 0.35 } },
  { id: 'builtin:listening', name: 'Listening', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 0.9, headTilt: -5, glow: 0.7, mouthCurve: 0.1 } },
  { id: 'builtin:speaking', name: 'Speaking', expression: { ...NEUTRAL_EXPRESSION, mouthOpen: 0.55, mouthCurve: 0.3, glow: 0.6 } },
  { id: 'builtin:sleepy', name: 'Sleepy', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 0.2, browTilt: -0.3, mouthCurve: 0, headTilt: 4, glow: 0.05 } },
  { id: 'builtin:alert', name: 'Alert', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 1, browTilt: -0.8, mouthOpen: 0.15, mouthCurve: -0.6, glow: 0.9 } },
  { id: 'builtin:curious', name: 'Curious', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 1, eyeShiftX: -0.4, eyeShiftY: -0.2, browTilt: 0.6, mouthCurve: 0.1, headTilt: -9, glow: 0.4 } },
  { id: 'builtin:proud', name: 'Proud', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 0.75, eyeShiftY: -0.15, browTilt: 0.2, mouthCurve: 0.7, mouthOpen: 0.05, headTilt: -3, glow: 0.55 } },
  { id: 'builtin:confused', name: 'Confused', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 0.9, eyeShiftX: 0.3, browTilt: -0.3, mouthCurve: -0.4, mouthOpen: 0.1, headTilt: 10, glow: 0.3 } },
  { id: 'builtin:blink', name: 'Blink', expression: { ...NEUTRAL_EXPRESSION, eyeOpen: 0 } },
];

export const BUILT_IN_TIMELINES: readonly Timeline[] = [
  {
    id: 'builtin:greet',
    name: 'Greeting',
    duration: 2400,
    loop: false,
    keyframes: [
      { at: 0, expressionId: 'builtin:neutral', ease: 'ease' },
      { at: 600, expressionId: 'builtin:surprised', ease: 'ease' },
      { at: 1400, expressionId: 'builtin:happy', ease: 'ease' },
      { at: 2400, expressionId: 'builtin:neutral', ease: 'ease' },
    ],
  },
  {
    id: 'builtin:ponder',
    name: 'Pondering loop',
    duration: 3000,
    loop: true,
    keyframes: [
      { at: 0, expressionId: 'builtin:neutral', ease: 'linear' },
      { at: 1000, expressionId: 'builtin:thinking', ease: 'hold' },
      { at: 2200, expressionId: 'builtin:thinking', ease: 'ease' },
      { at: 3000, expressionId: 'builtin:neutral', ease: 'linear' },
    ],
  },
  {
    id: 'builtin:nod',
    name: 'Attentive nod',
    duration: 1600,
    loop: false,
    keyframes: [
      { at: 0, expressionId: 'builtin:neutral', ease: 'anticipate' },
      { at: 450, expressionId: 'builtin:listening', ease: 'overshoot' },
      { at: 1000, expressionId: 'builtin:proud', ease: 'ease' },
      { at: 1600, expressionId: 'builtin:neutral', ease: 'ease' },
    ],
  },
  {
    id: 'builtin:startle',
    name: 'Startle and settle',
    duration: 2200,
    loop: false,
    keyframes: [
      { at: 0, expressionId: 'builtin:neutral', ease: 'anticipate' },
      { at: 350, expressionId: 'builtin:surprised', ease: 'spring' },
      { at: 1100, expressionId: 'builtin:curious', ease: 'out' },
      { at: 2200, expressionId: 'builtin:neutral', ease: 'ease' },
    ],
  },
  {
    id: 'builtin:cadence',
    name: 'Speaking cadence loop',
    duration: 2400,
    loop: true,
    keyframes: [
      { at: 0, expressionId: 'builtin:neutral', ease: 'ease' },
      { at: 500, expressionId: 'builtin:speaking', ease: 'ease' },
      { at: 1100, expressionId: 'builtin:happy', ease: 'ease' },
      { at: 1700, expressionId: 'builtin:speaking', ease: 'ease' },
      { at: 2400, expressionId: 'builtin:neutral', ease: 'ease' },
    ],
  },
];

export const DEFAULT_PACK: AvatarPack = {
  version: AVATAR_PACK_VERSION,
  name: 'Companion',
  geometry: DEFAULT_GEOMETRY,
  expressions: [],
  timelines: [],
};

/* ---------- helpers ---------- */

const ID_RE = /^[a-z0-9:_-]{1,48}$/i;
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export const isBuiltInId = (id: string): boolean => id.startsWith('builtin:');
export const makeAvatarId = (prefix: string, seed: number): string => `${prefix}-${Math.abs(Math.trunc(seed)).toString(36)}`;

const num = (v: unknown, r: Range, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(r.max, Math.max(r.min, n));
  const snapped = Math.round(clamped / r.step) * r.step;
  return Number(snapped.toFixed(3));
};
const byteLength = (s: string): number => new TextEncoder().encode(s).length;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, allowed: readonly { id: T }[], fallback: T): T => (allowed.some((a) => a.id === v) ? (v as T) : fallback);

export function normalizeName(name: unknown, fallback = ''): string {
  if (typeof name !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, AVATAR_LIMITS.nameLength);
  return clean || fallback;
}

export function normalizeGeometry(input: unknown, fallback: AvatarGeometry = DEFAULT_GEOMETRY): AvatarGeometry {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    headShape: oneOf(o.headShape, HEAD_SHAPES, fallback.headShape),
    headWidth: num(o.headWidth, GEOMETRY_LIMITS.headWidth, fallback.headWidth),
    headHeight: num(o.headHeight, GEOMETRY_LIMITS.headHeight, fallback.headHeight),
    eyeStyle: oneOf(o.eyeStyle, EYE_STYLES, fallback.eyeStyle),
    eyeSize: num(o.eyeSize, GEOMETRY_LIMITS.eyeSize, fallback.eyeSize),
    eyeSpacing: num(o.eyeSpacing, GEOMETRY_LIMITS.eyeSpacing, fallback.eyeSpacing),
    mouthStyle: oneOf(o.mouthStyle, MOUTH_STYLES, fallback.mouthStyle),
    mouthWidth: num(o.mouthWidth, GEOMETRY_LIMITS.mouthWidth, fallback.mouthWidth),
    antenna: bool(o.antenna, fallback.antenna),
    antennaHeight: num(o.antennaHeight, GEOMETRY_LIMITS.antennaHeight, fallback.antennaHeight),
    visor: bool(o.visor, fallback.visor),
    cheeks: bool(o.cheeks, fallback.cheeks),
    bodyHue: num(o.bodyHue, GEOMETRY_LIMITS.bodyHue, fallback.bodyHue),
    accentHue: num(o.accentHue, GEOMETRY_LIMITS.accentHue, fallback.accentHue),
    glowHue: num(o.glowHue, GEOMETRY_LIMITS.glowHue, fallback.glowHue),
  };
}

export function normalizeExpression(input: unknown, fallback: Expression = NEUTRAL_EXPRESSION): Expression {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out = {} as Expression;
  for (const k of Object.keys(EXPRESSION_LIMITS) as (keyof Expression)[]) out[k] = num(o[k], EXPRESSION_LIMITS[k], fallback[k]);
  return out;
}

/** Voice-reactive pose (scope 134). `level` is an amplitude the host injects (0..1); this module never reads audio. */
export function applyVoiceLevel(expr: Expression, level: number): Expression {
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  if (l === 0) return expr;
  return { ...expr, mouthOpen: Math.max(expr.mouthOpen, Number((l * 0.9).toFixed(3))), glow: Math.max(expr.glow, Number((0.2 + l * 0.6).toFixed(3))) };
}

/* ---------- expressions library ---------- */

export function upsertExpression(list: ExpressionPreset[], preset: ExpressionPreset): { list: ExpressionPreset[]; ok: boolean; reason?: string } {
  const name = normalizeName(preset.name);
  if (!name) return { list, ok: false, reason: 'Give the expression a name first.' };
  if (!ID_RE.test(preset.id) || isBuiltInId(preset.id)) return { list, ok: false, reason: 'Invalid expression id.' };
  const clean: ExpressionPreset = { id: preset.id, name, expression: normalizeExpression(preset.expression) };
  const i = list.findIndex((p) => p.id === clean.id);
  if (i >= 0) return { list: list.map((p, j) => (j === i ? clean : p)), ok: true };
  if (list.length >= AVATAR_LIMITS.expressions) return { list, ok: false, reason: `You can keep up to ${AVATAR_LIMITS.expressions} expressions.` };
  return { list: [...list, clean], ok: true };
}

export const findExpression = (id: string, saved: readonly ExpressionPreset[]): ExpressionPreset | undefined =>
  BUILT_IN_EXPRESSIONS.find((p) => p.id === id) ?? saved.find((p) => p.id === id);

/* ---------- timelines ---------- */

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => t * t * (3 - 2 * t);

export function mixExpressions(a: Expression, b: Expression, t: number): Expression {
  const k = Math.min(1, Math.max(0, t));
  const out = {} as Expression;
  for (const key of Object.keys(EXPRESSION_LIMITS) as (keyof Expression)[]) out[key] = Number(lerp(a[key], b[key], k).toFixed(3));
  return out;
}

/** Pose blend that may extrapolate (t below 0 or above 1 for anticipation and overshoot); every field stays inside its limits. */
export function blendExpressions(a: Expression, b: Expression, t: number): Expression {
  const k = Number.isFinite(t) ? Math.min(1.5, Math.max(-0.5, t)) : 0;
  const out = {} as Expression;
  for (const key of Object.keys(EXPRESSION_LIMITS) as (keyof Expression)[]) {
    const r = EXPRESSION_LIMITS[key];
    out[key] = Number(Math.min(r.max, Math.max(r.min, lerp(a[key], b[key], k))).toFixed(3));
  }
  return out;
}

const BACK = 1.70158;
/** Damped-spring settle; the small residual at f=1 is distributed linearly so it lands exactly on 1. */
const springRaw = (f: number): number => 1 - Math.exp(-5 * f) * Math.cos(9 * f);

/** Progress for a keyframe segment. Pure function of f, so the same time always draws the same frame. */
export function applyEase(ease: Ease, f: number): number {
  return easeRaw(ease, clamp01(f)) + 0;
}

function easeRaw(ease: Ease, t: number): number {
  switch (ease) {
    case 'hold':
      return 0;
    case 'linear':
      return t;
    case 'in':
      return t * t;
    case 'out':
      return 1 - (1 - t) * (1 - t);
    case 'anticipate':
      return t * t * ((BACK + 1) * t - BACK);
    case 'overshoot': {
      const u = t - 1;
      return 1 + u * u * ((BACK + 1) * u + BACK);
    }
    case 'spring':
      return springRaw(t) + (1 - springRaw(1)) * t;
    default:
      return smooth(t);
  }
}

/** Sort by time, drop keyframes past the duration and unknown expressions, bound the count. */
export function normalizeTimeline(input: unknown, saved: readonly ExpressionPreset[], fallbackId: string): Timeline | null {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!o) return null;
  const id = typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : fallbackId;
  const name = normalizeName(o.name, 'Timeline');
  const duration = num(o.duration, { min: AVATAR_LIMITS.minDurationMs, max: AVATAR_LIMITS.maxDurationMs, step: 10 }, 2000);
  const raw = Array.isArray(o.keyframes) ? o.keyframes : [];
  const keyframes: Keyframe[] = [];
  for (const k of raw) {
    if (!k || typeof k !== 'object') continue;
    const kf = k as Record<string, unknown>;
    if (typeof kf.expressionId !== 'string' || !findExpression(kf.expressionId, saved)) continue;
    const at = num(kf.at, { min: 0, max: duration, step: 10 }, NaN);
    if (!Number.isFinite(at)) continue;
    const ease: Ease = EASE_OPTIONS.some((z) => z.id === kf.ease) ? (kf.ease as Ease) : 'ease';
    keyframes.push({ at, expressionId: kf.expressionId, ease });
    if (keyframes.length >= AVATAR_LIMITS.keyframes) break;
  }
  keyframes.sort((a, b) => a.at - b.at);
  return { id, name, duration, loop: bool(o.loop, false), keyframes };
}

/**
 * Expression at time `tMs`. Between keyframes the pose tweens by the *outgoing* keyframe's ease;
 * with `reducedMotion` the pose simply holds the last keyframe (no tweening at all).
 */
export function sampleTimeline(tl: Timeline, saved: readonly ExpressionPreset[], tMs: number, reducedMotion = false): Expression {
  const kfs = tl.keyframes;
  if (kfs.length === 0) return NEUTRAL_EXPRESSION;
  let t = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
  if (tl.loop && tl.duration > 0) t %= tl.duration;
  else t = Math.min(t, tl.duration);
  const exprOf = (k: Keyframe) => findExpression(k.expressionId, saved)?.expression ?? NEUTRAL_EXPRESSION;
  let i = -1;
  for (let j = 0; j < kfs.length; j++) if (kfs[j].at <= t) i = j;
  if (i < 0) return exprOf(kfs[0]);
  const cur = kfs[i];
  const next = kfs[i + 1];
  if (!next || reducedMotion || cur.ease === 'hold' || next.at === cur.at) return exprOf(cur);
  const f = (t - cur.at) / (next.at - cur.at);
  return blendExpressions(exprOf(cur), exprOf(next), applyEase(cur.ease, f));
}

export function upsertTimeline(list: Timeline[], tl: Timeline): { list: Timeline[]; ok: boolean; reason?: string } {
  if (!ID_RE.test(tl.id) || isBuiltInId(tl.id)) return { list, ok: false, reason: 'Invalid timeline id.' };
  const i = list.findIndex((p) => p.id === tl.id);
  if (i >= 0) return { list: list.map((p, j) => (j === i ? tl : p)), ok: true };
  if (list.length >= AVATAR_LIMITS.timelines) return { list, ok: false, reason: `You can keep up to ${AVATAR_LIMITS.timelines} timelines.` };
  return { list: [...list, tl], ok: true };
}

export type TimelineReport = {
  /** Largest per-field jump (0..1) when a looping timeline wraps from its end back to time 0; null when it does not loop. */
  seam: number | null;
  warnings: string[];
};

/** Normalized distance between two poses, 0 identical .. 1 every field at opposite limits. */
export function poseDistance(a: Expression, b: Expression): number {
  let d = 0;
  for (const k of Object.keys(EXPRESSION_LIMITS) as (keyof Expression)[]) {
    const r = EXPRESSION_LIMITS[k];
    d = Math.max(d, Math.abs(a[k] - b[k]) / (r.max - r.min));
  }
  return Number(d.toFixed(3));
}

export const SEAM_WARN = 0.12;

/** Checks that matter for a smooth loop and readable timing. Advisory only; nothing is rejected. */
export function analyzeTimeline(tl: Timeline, saved: readonly ExpressionPreset[]): TimelineReport {
  const warnings: string[] = [];
  const kfs = tl.keyframes;
  if (kfs.length === 0) return { seam: null, warnings: ['No keyframes yet.'] };
  if (kfs.length === 1) warnings.push('Only one keyframe: the pose never changes.');
  if (kfs[0].at > 0) warnings.push(`The first keyframe starts at ${kfs[0].at} ms; the pose holds until then.`);
  const last = kfs[kfs.length - 1];
  if (last.at < tl.duration) warnings.push(`The last keyframe is ${tl.duration - last.at} ms before the end; the pose holds for that time.`);
  const dup = kfs.findIndex((k, i) => i > 0 && k.at === kfs[i - 1].at);
  if (dup > 0) warnings.push(`Keyframes ${dup} and ${dup + 1} share ${kfs[dup].at} ms; the later one wins.`);
  const sharp = kfs.findIndex((k, i) => i > 0 && k.at !== kfs[i - 1].at && k.at - kfs[i - 1].at < 80);
  if (sharp > 0) warnings.push(`Keyframes ${sharp} and ${sharp + 1} are under 80 ms apart; the change may read as a flicker.`);
  if (kfs.length > 1 && (last.ease === 'spring' || last.ease === 'overshoot' || last.ease === 'anticipate')) warnings.push(`The last keyframe uses "${last.ease}" but has no next pose to travel to.`);
  let seam: number | null = null;
  if (tl.loop) {
    const first = sampleTimeline(tl, saved, 0);
    const end = sampleTimeline({ ...tl, loop: false }, saved, tl.duration);
    seam = poseDistance(first, end);
    if (seam > SEAM_WARN) warnings.push(`Loop seam: the pose jumps by ${Math.round(seam * 100)}% when it wraps. End on the pose it starts with for a smooth loop.`);
  }
  return { seam, warnings };
}

/** Evenly spaced inspection times including both ends; same inputs give the same list. */
export function timelineFrameTimes(duration: number, count: number): number[] {
  const n = Math.min(24, Math.max(2, Math.trunc(Number.isFinite(count) ? count : 8)));
  const d = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  return Array.from({ length: n }, (_, i) => Math.round((d * i) / (n - 1)));
}

/* ---------- idle life and voice envelope ---------- */

/** Deterministic unit hash of two integers; the basis of seeded, stateless randomness. */
export function hashUnit(a: number, b: number): number {
  let h = (Math.trunc(a) ^ Math.imul(Math.trunc(b), 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function seedFromText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const IDLE = { slotMs: 4200, blinkMs: 160, breathMs: 4000, breathPx: 1.2, swayDeg: 1.2 } as const;
/** eyes: multiplier for eye openness (1 open, 0.05 mid blink). dy: breathing offset in stage units. tilt: extra head roll in degrees (slower follow-through sway). */
export type IdleLayer = { eyes: number; dy: number; tilt: number };
export const NO_IDLE: IdleLayer = { eyes: 1, dy: 0, tilt: 0 };

/**
 * Seeded blink and breathing as a pure function of time. One blink per 4.2 s slot at a seeded moment
 * (about one slot in five skips it so the rhythm is not mechanical). Callers pass NO_IDLE under reduced motion.
 */
export function idleLayer(tMs: number, seed: number): IdleLayer {
  const t = Number.isFinite(tMs) ? Math.max(0, tMs) : 0;
  const slot = Math.floor(t / IDLE.slotMs);
  let eyes = 1;
  if (hashUnit(seed + 7, slot) >= 0.2) {
    const room = IDLE.slotMs - 600 - IDLE.blinkMs;
    const start = slot * IDLE.slotMs + 400 + hashUnit(seed, slot) * room;
    const p = (t - start) / IDLE.blinkMs;
    if (p >= 0 && p <= 1) eyes = 1 - Math.sin(Math.PI * p) * 0.95;
  }
  const phase = hashUnit(seed, 99) * Math.PI * 2;
  return {
    eyes: Number(eyes.toFixed(3)),
    dy: Number((Math.sin((2 * Math.PI * t) / IDLE.breathMs) * IDLE.breathPx).toFixed(3)),
    tilt: Number((Math.sin((2 * Math.PI * t) / (IDLE.breathMs * 1.7) + phase) * IDLE.swayDeg).toFixed(3)),
  };
}

export function applyIdle(expr: Expression, idle: IdleLayer): Expression {
  if (idle.eyes === 1 && idle.tilt === 0) return expr;
  return normalizeExpression({ ...expr, eyeOpen: expr.eyeOpen * idle.eyes, headTilt: expr.headTilt + idle.tilt }, expr);
}

/**
 * One-pole follower for an injected amplitude: quick attack, slower release, so the mouth does not chatter.
 * Deterministic in (prev, target, dt); it only smooths numbers the host provides.
 */
export function smoothVoiceLevel(prev: number, target: number, dtMs: number, attackMs = 60, releaseMs = 220): number {
  const p = clamp01(prev);
  const g = clamp01(target);
  const dt = Number.isFinite(dtMs) ? Math.min(250, Math.max(0, dtMs)) : 0;
  const tau = g > p ? attackMs : releaseMs;
  const next = p + (g - p) * (1 - Math.exp(-dt / tau));
  return g === 0 && next < 0.004 ? 0 : Number(next.toFixed(4));
}

export type VoiceBand = 'silent' | 'soft' | 'speaking' | 'loud';
export function voiceBand(level: number): VoiceBand {
  const l = clamp01(level);
  return l < 0.04 ? 'silent' : l < 0.35 ? 'soft' : l < 0.7 ? 'speaking' : 'loud';
}

/* ---------- packs (scope 132) ---------- */

export type PackParse = { ok: true; pack: AvatarPack; warnings: string[] } | { ok: false; error: string };

/** Strict import. Accepts a JSON string or an already parsed object; bounds size, counts and values. */
export function parseAvatarPack(input: unknown): PackParse {
  let raw = input;
  if (typeof input === 'string') {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    if (byteLength(text) > AVATAR_LIMITS.packBytes) return { ok: false, error: `Pack is larger than ${AVATAR_LIMITS.packBytes / 1024} KB.` };
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Pack is not valid JSON.' };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Pack must be a JSON object.' };
  const o = raw as Record<string, unknown>;
  if (o.version !== AVATAR_PACK_VERSION) return { ok: false, error: `Unsupported pack version ${String(o.version)}; this build reads version ${AVATAR_PACK_VERSION}.` };
  if (!o.geometry || typeof o.geometry !== 'object') return { ok: false, error: 'Pack has no geometry.' };
  const warnings: string[] = [];
  const geometry = normalizeGeometry(o.geometry);
  const rawGeo = o.geometry as Record<string, unknown>;
  const adjusted = (Object.keys(GEOMETRY_LIMITS) as (keyof typeof GEOMETRY_LIMITS)[]).filter((k) => typeof rawGeo[k] === 'number' && rawGeo[k] !== geometry[k]);
  if (adjusted.length > 0) warnings.push(`Out-of-range geometry values were clamped: ${adjusted.join(', ')}.`);

  const expressions: ExpressionPreset[] = [];
  const rawEx = Array.isArray(o.expressions) ? o.expressions : [];
  if (o.expressions !== undefined && !Array.isArray(o.expressions)) return { ok: false, error: 'Pack expressions must be a list.' };
  const seen = new Set<string>();
  for (const item of rawEx) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !ID_RE.test(e.id) || isBuiltInId(e.id) || seen.has(e.id)) {
      warnings.push('Skipped an expression with a missing, reserved or duplicate id.');
      continue;
    }
    const name = normalizeName(e.name);
    if (!name) {
      warnings.push(`Skipped expression "${e.id}" with no name.`);
      continue;
    }
    if (expressions.length >= AVATAR_LIMITS.expressions) {
      warnings.push(`Only the first ${AVATAR_LIMITS.expressions} expressions were kept.`);
      break;
    }
    seen.add(e.id);
    expressions.push({ id: e.id, name, expression: normalizeExpression(e.expression) });
  }

  const timelines: Timeline[] = [];
  if (o.timelines !== undefined && !Array.isArray(o.timelines)) return { ok: false, error: 'Pack timelines must be a list.' };
  const rawTl = Array.isArray(o.timelines) ? o.timelines : [];
  const seenTl = new Set<string>();
  rawTl.forEach((item, i) => {
    if (timelines.length >= AVATAR_LIMITS.timelines) return;
    const tl = normalizeTimeline(item, expressions, makeAvatarId('tl', i + 1));
    if (!tl || isBuiltInId(tl.id) || seenTl.has(tl.id)) {
      warnings.push('Skipped a timeline that was malformed or had a reserved or duplicate id.');
      return;
    }
    const want = item && typeof item === 'object' && Array.isArray((item as Record<string, unknown>).keyframes) ? ((item as Record<string, unknown>).keyframes as unknown[]).length : 0;
    if (tl.keyframes.length < want) warnings.push(`Timeline "${tl.name}" dropped ${want - tl.keyframes.length} keyframe(s) that were out of range or referenced unknown expressions.`);
    seenTl.add(tl.id);
    timelines.push(tl);
  });
  if (rawTl.length > AVATAR_LIMITS.timelines) warnings.push(`Only the first ${AVATAR_LIMITS.timelines} timelines were kept.`);

  return { ok: true, pack: { version: AVATAR_PACK_VERSION, name: normalizeName(o.name, DEFAULT_PACK.name), geometry, expressions, timelines }, warnings };
}

export type PackSummary = { name: string; expressions: number; timelines: number; keyframes: number; loops: number; bytes: number };

export function summarizePack(pack: AvatarPack): PackSummary {
  return {
    name: pack.name,
    expressions: pack.expressions.length,
    timelines: pack.timelines.length,
    keyframes: pack.timelines.reduce((n, t) => n + t.keyframes.length, 0),
    loops: pack.timelines.filter((t) => t.loop).length,
    bytes: byteLength(serializeAvatarPack(pack)),
  };
}

const poseKey = (e: Expression): string => JSON.stringify(normalizeExpression(e));

/** A free id near `want` that is valid under ID_RE and not in `used`. */
function freeId(want: string, used: ReadonlySet<string>): string {
  if (!used.has(want)) return want;
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const id = `${want.slice(0, 48 - suffix.length)}${suffix}`;
    if (!used.has(id)) return id;
  }
  return makeAvatarId('id', used.size + 1);
}

export type MergeResult = { pack: AvatarPack; warnings: string[]; addedExpressions: number; addedTimelines: number };

/**
 * Add an imported pack's saved expressions and timelines to the current pack without touching its geometry or name.
 * Identical poses are not duplicated; id clashes get a new id and the incoming keyframes are re-pointed at it.
 * Anything past the pack limits is dropped with a warning. Pure: neither input is modified.
 */
export function mergeAvatarPacks(base: AvatarPack, incoming: AvatarPack): MergeResult {
  const warnings: string[] = [];
  const expressions = base.expressions.map((e) => ({ ...e }));
  const used = new Set<string>([...expressions.map((e) => e.id), ...BUILT_IN_EXPRESSIONS.map((e) => e.id)]);
  const remap = new Map<string, string>();
  let addedExpressions = 0;
  for (const ex of incoming.expressions) {
    const same = expressions.find((e) => e.id === ex.id && poseKey(e.expression) === poseKey(ex.expression));
    if (same) {
      remap.set(ex.id, same.id);
      continue;
    }
    if (expressions.length >= AVATAR_LIMITS.expressions) {
      warnings.push(`Expression "${ex.name}" was not added: the pack already holds ${AVATAR_LIMITS.expressions}.`);
      continue;
    }
    const id = freeId(ex.id, used);
    used.add(id);
    remap.set(ex.id, id);
    expressions.push({ id, name: ex.name, expression: normalizeExpression(ex.expression) });
    addedExpressions++;
  }
  const timelines = base.timelines.map((t) => ({ ...t, keyframes: t.keyframes.map((k) => ({ ...k })) }));
  const usedTl = new Set<string>(timelines.map((t) => t.id));
  let addedTimelines = 0;
  for (const tl of incoming.timelines) {
    if (timelines.length >= AVATAR_LIMITS.timelines) {
      warnings.push(`Timeline "${tl.name}" was not added: the pack already holds ${AVATAR_LIMITS.timelines}.`);
      continue;
    }
    const keyframes = tl.keyframes.map((k) => ({ ...k, expressionId: remap.get(k.expressionId) ?? k.expressionId }));
    const norm = normalizeTimeline({ ...tl, keyframes }, expressions, tl.id);
    if (!norm) continue;
    if (norm.keyframes.length < tl.keyframes.length) warnings.push(`Timeline "${tl.name}" lost ${tl.keyframes.length - norm.keyframes.length} keyframe(s) whose expression could not be added.`);
    const id = freeId(norm.id, usedTl);
    usedTl.add(id);
    timelines.push({ ...norm, id });
    addedTimelines++;
  }
  return { pack: { ...base, expressions, timelines }, warnings, addedExpressions, addedTimelines };
}

const RESERVED_FILE_STEMS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A Windows-safe file name stem: no separators or reserved device names, bounded length, never empty. */
export function safeFileStem(name: string, fallback = 'avatar'): string {
  let stem = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (!stem) stem = fallback;
  return RESERVED_FILE_STEMS.test(stem) ? `${stem}-pack` : stem;
}

/** Stable JSON for export and storage. Only the pack fields are written. */
export function serializeAvatarPack(pack: AvatarPack): string {
  const clean: AvatarPack = {
    version: AVATAR_PACK_VERSION,
    name: normalizeName(pack.name, DEFAULT_PACK.name),
    geometry: normalizeGeometry(pack.geometry),
    expressions: pack.expressions.map((e) => ({ id: e.id, name: e.name, expression: normalizeExpression(e.expression) })),
    timelines: pack.timelines.map((t) => ({ id: t.id, name: t.name, duration: t.duration, loop: t.loop, keyframes: t.keyframes.map((k) => ({ at: k.at, expressionId: k.expressionId, ease: k.ease })) })),
  };
  return JSON.stringify(clean, null, 2);
}

/** Load whatever is in storage; a bad or missing value yields the default pack. */
export function packFromStorage(raw: unknown): AvatarPack {
  const r = parseAvatarPack(raw);
  return r.ok ? r.pack : DEFAULT_PACK;
}

/* ---------- geometry resolved to drawable shapes ---------- */

export const STAGE = 200;

export type Shape =
  | { kind: 'ellipse'; x: number; y: number; rx: number; ry: number; fill: string; stroke?: string; width?: number; rotate?: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number; fill: string; stroke?: string; width?: number; rotate?: number }
  | { kind: 'polygon'; points: [number, number][]; fill: string; stroke?: string; width?: number; rotate?: number }
  | { kind: 'path'; d: string; fill: string; stroke?: string; width?: number; rotate?: number };

export function hsl(h: number, s: number, l: number, a = 1): string {
  const hh = ((Math.round(h) % 360) + 360) % 360;
  return a >= 1 ? `hsl(${hh}, ${Math.round(s)}%, ${Math.round(l)}%)` : `hsla(${hh}, ${Math.round(s)}%, ${Math.round(l)}%, ${Number(a.toFixed(3))})`;
}

/**
 * The whole avatar as a list of primitive shapes in a 200×200 stage, back to front.
 * Both the canvas painter and the SVG exporter consume this so the two outputs match.
 */
export function avatarShapes(g: AvatarGeometry, e: Expression): Shape[] {
  const cx = STAGE / 2;
  const cy = STAGE / 2 + 6;
  const hw = (g.headWidth / 100) * 70;
  const hh = (g.headHeight / 100) * 70;
  const rot = e.headTilt;
  const body = hsl(g.bodyHue, 38, 46);
  const bodyDark = hsl(g.bodyHue, 40, 32);
  const accent = hsl(g.accentHue, 85, 62);
  const shapes: Shape[] = [];

  // halo
  const glowR = Math.max(hw, hh) + 10 + e.glow * 14;
  shapes.push({ kind: 'ellipse', x: cx, y: cy, rx: glowR, ry: glowR, fill: hsl(g.glowHue, 90, 65, 0.08 + e.glow * 0.3) });

  // shoulders
  shapes.push({ kind: 'path', d: `M ${cx - hw - 6} ${STAGE} Q ${cx - hw - 6} ${cy + hh + 6} ${cx - hw * 0.6} ${cy + hh + 4} L ${cx + hw * 0.6} ${cy + hh + 4} Q ${cx + hw + 6} ${cy + hh + 6} ${cx + hw + 6} ${STAGE} Z`, fill: bodyDark });

  // antenna
  if (g.antenna && g.antennaHeight > 0) {
    const top = cy - hh - g.antennaHeight;
    shapes.push({ kind: 'rect', x: cx - 2, y: top, w: 4, h: g.antennaHeight + 4, r: 2, fill: bodyDark, rotate: rot });
    shapes.push({ kind: 'ellipse', x: cx, y: top, rx: 5, ry: 5, fill: hsl(g.accentHue, 90, 70, 0.6 + e.glow * 0.4), rotate: rot });
  }

  // head
  if (g.headShape === 'square') shapes.push({ kind: 'rect', x: cx - hw, y: cy - hh, w: hw * 2, h: hh * 2, r: Math.min(hw, hh) * 0.35, fill: body, rotate: rot });
  else if (g.headShape === 'hex') {
    const pts: [number, number][] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 2;
      pts.push([cx + Math.cos(a) * hw, cy + Math.sin(a) * hh]);
    }
    shapes.push({ kind: 'polygon', points: pts, fill: body, rotate: rot });
  } else shapes.push({ kind: 'ellipse', x: cx, y: cy, rx: hw, ry: g.headShape === 'oval' ? hh * 1.1 : hh, fill: body, rotate: rot });

  // visor
  if (g.visor) shapes.push({ kind: 'rect', x: cx - hw * 0.82, y: cy - hh * 0.55, w: hw * 1.64, h: hh * 0.95, r: hh * 0.3, fill: hsl(g.bodyHue, 45, 16, 0.85), rotate: rot });

  // eyes
  const es = g.eyeSize * (0.6 + 0.4 * (hw / 70));
  const gap = (g.eyeSpacing / 100) * hw;
  const ey = cy - hh * 0.12 + e.eyeShiftY * 6;
  const open = Math.max(0.08, e.eyeOpen);
  for (const side of [-1, 1] as const) {
    const ex = cx + side * gap + e.eyeShiftX * 6;
    const browSkew = e.browTilt * -3 * side;
    if (g.eyeStyle === 'bar') shapes.push({ kind: 'rect', x: ex - es, y: ey - es * 0.35 * open + browSkew, w: es * 2, h: Math.max(2, es * 0.7 * open), r: 2, fill: accent, rotate: rot });
    else if (g.eyeStyle === 'ring') shapes.push({ kind: 'ellipse', x: ex, y: ey + browSkew, rx: es * 0.9, ry: es * 0.9 * open, fill: 'none', stroke: accent, width: Math.max(2, es * 0.3), rotate: rot });
    else shapes.push({ kind: 'ellipse', x: ex, y: ey + browSkew, rx: es * 0.9, ry: es * 0.9 * open, fill: accent, rotate: rot });
  }

  // mouth
  const mw = (g.mouthWidth / 100) * hw * 1.4;
  const my = cy + hh * 0.42;
  const openH = 2 + e.mouthOpen * 14;
  const curve = e.mouthCurve * 10;
  if (g.mouthStyle === 'bar') shapes.push({ kind: 'rect', x: cx - mw / 2, y: my - openH / 2, w: mw, h: openH, r: 2, fill: accent, rotate: rot });
  else if (g.mouthStyle === 'line') shapes.push({ kind: 'path', d: `M ${cx - mw / 2} ${my - curve / 2} Q ${cx} ${my + curve} ${cx + mw / 2} ${my - curve / 2}`, fill: 'none', stroke: accent, width: Math.max(2, openH * 0.5), rotate: rot });
  else shapes.push({ kind: 'path', d: `M ${cx - mw / 2} ${my - curve / 2} Q ${cx} ${my + curve + openH} ${cx + mw / 2} ${my - curve / 2} Q ${cx} ${my + curve - openH * 0.4} ${cx - mw / 2} ${my - curve / 2} Z`, fill: accent, rotate: rot });

  // cheeks
  if (g.cheeks) {
    for (const side of [-1, 1] as const) shapes.push({ kind: 'ellipse', x: cx + side * hw * 0.68, y: cy + hh * 0.3, rx: 6, ry: 4, fill: hsl(g.accentHue, 70, 65, 0.25 + Math.max(0, e.mouthCurve) * 0.3), rotate: rot });
  }
  return shapes;
}

/* ---------- renderers ---------- */

const f = (n: number): string => String(Number(n.toFixed(2)));
const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Whole-figure offset in stage units (breathing, bob). Kept out of the pose schema on purpose. */
export type AvatarFx = { dx?: number; dy?: number };

/** SVG fragments for one pose, in a 200 by 200 coordinate space. Shared by the single pose and the contact sheet. */
function svgParts(g: AvatarGeometry, e: Expression): string {
  const cx = STAGE / 2;
  const cy = STAGE / 2 + 6;
  const parts = avatarShapes(g, e).map((s) => {
    const stroke = s.stroke ? ` stroke="${s.stroke}" stroke-width="${f(s.width ?? 1)}" stroke-linecap="round"` : '';
    const rot = s.rotate ? ` transform="rotate(${f(s.rotate)} ${f(cx)} ${f(cy)})"` : '';
    switch (s.kind) {
      case 'ellipse':
        return `<ellipse cx="${f(s.x)}" cy="${f(s.y)}" rx="${f(s.rx)}" ry="${f(s.ry)}" fill="${s.fill}"${stroke}${rot}/>`;
      case 'rect':
        return `<rect x="${f(s.x)}" y="${f(s.y)}" width="${f(s.w)}" height="${f(s.h)}" rx="${f(s.r)}" fill="${s.fill}"${stroke}${rot}/>`;
      case 'polygon':
        return `<polygon points="${s.points.map(([x, y]) => `${f(x)},${f(y)}`).join(' ')}" fill="${s.fill}"${stroke}${rot}/>`;
      default:
        return `<path d="${s.d}" fill="${s.fill}"${stroke}${rot}/>`;
    }
  });
  return parts.join('');
}

/** Static SVG of one pose. Self-contained, no scripts, no external references. */
export function renderAvatarSvg(g: AvatarGeometry, e: Expression, title = 'Companion avatar', fx?: AvatarFx): string {
  const dx = Number.isFinite(fx?.dx) ? (fx?.dx as number) : 0;
  const dy = Number.isFinite(fx?.dy) ? (fx?.dy as number) : 0;
  const body = svgParts(g, e);
  const inner = dx || dy ? `<g transform="translate(${f(dx)} ${f(dy)})">${body}</g>` : body;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${STAGE} ${STAGE}" width="${STAGE}" height="${STAGE}" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title>${inner}</svg>`;
}

/**
 * Contact sheet of a timeline: evenly spaced frames from time 0 to the duration, labelled with their time.
 * Derived only from the timeline and pose data, so the same inputs give byte-identical output. Looping
 * timelines mark the last frame as the wrap point so the seam can be compared with the first frame by eye.
 */
export function renderContactSheetSvg(g: AvatarGeometry, tl: Timeline, saved: readonly ExpressionPreset[], opts: { frames?: number; columns?: number; cell?: number; reducedMotion?: boolean } = {}): string {
  const times = timelineFrameTimes(tl.duration, opts.frames ?? 8);
  const cols = Math.min(8, Math.max(1, Math.trunc(opts.columns ?? 4)));
  const cell = Math.min(240, Math.max(60, Math.trunc(opts.cell ?? 120)));
  const label = 16;
  const rows = Math.ceil(times.length / cols);
  const pad = 8;
  const w = cols * (cell + pad) + pad;
  const h = rows * (cell + label + pad) + pad + 20;
  const title = `${normalizeName(tl.name, 'Timeline')} contact sheet`;
  const cells = times.map((t, i) => {
    const x = pad + (i % cols) * (cell + pad);
    const y = 20 + pad + Math.floor(i / cols) * (cell + label + pad);
    const body = svgParts(g, sampleTimeline(tl, saved, t, opts.reducedMotion === true));
    const wrap = tl.loop && i === times.length - 1 ? ' (wraps to 0)' : '';
    return `<g transform="translate(${x} ${y})"><rect width="${cell}" height="${cell}" rx="6" fill="#10151c" stroke="#2c3644"/><g transform="scale(${f(cell / STAGE)})">${body}</g><text x="${f(cell / 2)}" y="${cell + 12}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#9aa7b8">${t} ms${wrap}</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${escapeXml(title)}"><title>${escapeXml(title)}</title><rect width="${w}" height="${h}" fill="#0b0f14"/><text x="${pad}" y="15" font-family="sans-serif" font-size="12" fill="#c8d2e0">${escapeXml(title)}</text>${cells.join('')}</svg>`;
}

/** The subset of CanvasRenderingContext2D the painter needs, so tests can pass a recorder. */
export interface AvatarCanvas {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, start: number, end: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
}

type PathCtor = new (d: string) => unknown;

/** Paint one pose into a w×h canvas (already DPR-transformed). Path shapes use Path2D when the runtime has it. */
export function drawAvatar(ctx: AvatarCanvas, w: number, h: number, g: AvatarGeometry, e: Expression, Path2DImpl?: PathCtor, fx?: AvatarFx): void {
  const scale = Math.min(w, h) / STAGE;
  const cx = STAGE / 2;
  const cy = STAGE / 2 + 6;
  ctx.save();
  ctx.translate((w - STAGE * scale) / 2, (h - STAGE * scale) / 2);
  ctx.scale(scale, scale);
  if (fx && (Number.isFinite(fx.dx) || Number.isFinite(fx.dy))) ctx.translate(Number.isFinite(fx.dx) ? (fx.dx as number) : 0, Number.isFinite(fx.dy) ? (fx.dy as number) : 0);
  for (const s of avatarShapes(g, e)) {
    ctx.save();
    if (s.rotate) {
      ctx.translate(cx, cy);
      ctx.rotate((s.rotate * Math.PI) / 180);
      ctx.translate(-cx, -cy);
    }
    ctx.beginPath();
    let path: unknown = null;
    if (s.kind === 'ellipse') ctx.ellipse(s.x, s.y, Math.max(0.1, s.rx), Math.max(0.1, s.ry), 0, 0, Math.PI * 2);
    else if (s.kind === 'rect') ctx.roundRect(s.x, s.y, Math.max(0.1, s.w), Math.max(0.1, s.h), Math.max(0, Math.min(s.r, s.w / 2, s.h / 2)));
    else if (s.kind === 'polygon') {
      s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
    } else if (Path2DImpl) path = new Path2DImpl(s.d);
    const c = ctx as AvatarCanvas & { fill(p?: unknown): void; stroke(p?: unknown): void };
    if (s.fill !== 'none') {
      ctx.fillStyle = s.fill;
      if (path) c.fill(path);
      else ctx.fill();
    }
    if (s.stroke) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.width ?? 1;
      ctx.lineCap = 'round';
      if (path) c.stroke(path);
      else ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/* ---------- quality profiles (scope 136, manual part) and gates ---------- */

export type QualityProfile = { id: 'battery' | 'balanced' | 'high'; name: string; fps: number; maxDpr: number; blurb: string };
export const QUALITY_PROFILES: readonly QualityProfile[] = [
  { id: 'battery', name: 'Battery', fps: 24, maxDpr: 1, blurb: '24 frames per second at 1× pixels.' },
  { id: 'balanced', name: 'Balanced', fps: 60, maxDpr: 1.5, blurb: '60 frames per second, pixel ratio capped at 1.5×.' },
  { id: 'high', name: 'High', fps: 60, maxDpr: 2, blurb: '60 frames per second, pixel ratio capped at 2×.' },
];
export const DEFAULT_QUALITY: QualityProfile['id'] = 'balanced';
export const QUALITY_PREF_KEY = 'avatar.quality';
/** Preview-only toggle for the seeded blink and breathing layer; off by default and never applied under reduced motion. */
export const IDLE_PREF_KEY = 'avatar.idle';
export const qualityProfile = (id: unknown): QualityProfile => QUALITY_PROFILES.find((q) => q.id === id) ?? (QUALITY_PROFILES.find((q) => q.id === DEFAULT_QUALITY) as QualityProfile);

export type GateStatus = 'unavailable' | 'injected' | 'manual';
export type AvatarGate = { id: number; name: string; status: GateStatus; reason: string };

/** Honest status of the experimental scopes this module does not fully implement. */
export const AVATAR_GATES: readonly AvatarGate[] = [
  { id: 133, name: '3D avatar/model customization', status: 'unavailable', reason: 'No approved 3D runtime or model format is bundled. This build renders 2D vector geometry only.' },
  { id: 134, name: 'Voice-driven mouth/pose states', status: 'injected', reason: 'Mouth and glow follow an amplitude the host passes in. This studio never opens a microphone; the slider here is a simulation.' },
  { id: 135, name: 'Realistic portrait animation adapter', status: 'unavailable', reason: 'No portrait model or licensed adapter is bundled. Nothing here animates photographs.' },
  { id: 136, name: 'Quality/hardware profile manager', status: 'manual', reason: 'Three manual profiles bound frame rate and pixel ratio. Automatic hardware detection is not implemented.' },
];

export type ExportStatus = 'available' | 'unavailable';
/** What this studio can really write out. Nothing in the unavailable rows is faked. */
export const AVATAR_EXPORTS: readonly { id: string; name: string; status: ExportStatus; reason: string }[] = [
  { id: 'json', name: 'Pack JSON', status: 'available', reason: 'Portable, validated and size bounded. Imports back into this build unchanged.' },
  { id: 'svg-pose', name: 'Pose as SVG', status: 'available', reason: 'One still pose as a self-contained vector file.' },
  { id: 'svg-sheet', name: 'Timeline contact sheet (SVG)', status: 'available', reason: 'Evenly spaced frames of a timeline in one file, for checking timing and the loop seam.' },
  { id: 'video', name: 'GIF, MP4 or PNG sequence', status: 'unavailable', reason: 'No encoder is bundled. Use the contact sheet for review; playback happens inside this window only.' },
];

export function describeExpression(e: Expression): string {
  const mood = e.mouthCurve > 0.4 ? 'smiling' : e.mouthCurve < -0.4 ? 'frowning' : 'neutral';
  const eyes = e.eyeOpen < 0.35 ? 'eyes nearly closed' : e.eyeOpen < 0.8 ? 'eyes relaxed' : 'eyes open';
  const mouth = e.mouthOpen > 0.5 ? 'mouth open' : e.mouthOpen > 0.1 ? 'mouth slightly open' : 'mouth closed';
  return `${mood}, ${eyes}, ${mouth}${e.headTilt ? `, head tilted ${Math.round(e.headTilt)}°` : ''}`;
}

/* ------------------------------ edit history: bounded undo and redo ------------------------------ */

/** One restorable step: the pack as it was before the labelled change. */
export type HistoryEntry = { label: string; pack: AvatarPack; coalesce?: string };
export type EditHistory = { past: HistoryEntry[]; future: HistoryEntry[] };
export const HISTORY_LIMIT = 40;
export const EMPTY_HISTORY: EditHistory = { past: [], future: [] };

/**
 * Record a change. The entry holds the state before the change. A redo stack is dropped on any
 * new change. Consecutive entries with the same coalesce key (one slider being dragged) collapse
 * into the first, so a drag undoes in one step. The stack is bounded; the oldest step falls off.
 */
export function pushHistory(h: EditHistory, entry: HistoryEntry, limit = HISTORY_LIMIT): EditHistory {
  const last = h.past[h.past.length - 1];
  if (entry.coalesce && last && last.coalesce === entry.coalesce) return h.future.length ? { past: h.past, future: [] } : h;
  const past = [...h.past, { label: entry.label, pack: entry.pack, ...(entry.coalesce ? { coalesce: entry.coalesce } : {}) }];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

export type HistoryStep = { history: EditHistory; pack: AvatarPack; label: string };

/** Step back: the current pack moves to the redo stack under the same label. */
export function undoHistory(h: EditHistory, current: AvatarPack): HistoryStep | null {
  const entry = h.past[h.past.length - 1];
  if (!entry) return null;
  return { history: { past: h.past.slice(0, -1), future: [...h.future, { label: entry.label, pack: current }] }, pack: entry.pack, label: entry.label };
}

/** Step forward again after an undo. */
export function redoHistory(h: EditHistory, current: AvatarPack): HistoryStep | null {
  const entry = h.future[h.future.length - 1];
  if (!entry) return null;
  return { history: { past: [...h.past, { label: entry.label, pack: current }], future: h.future.slice(0, -1) }, pack: entry.pack, label: entry.label };
}

export const peekUndo = (h: EditHistory): HistoryEntry | null => h.past[h.past.length - 1] ?? null;
export const peekRedo = (h: EditHistory): HistoryEntry | null => h.future[h.future.length - 1] ?? null;

/* ------------------------------ validated preset naming ------------------------------ */

export type NameCheck = { ok: true; name: string; replaces: ExpressionPreset | null; note: string | null } | { ok: false; reason: string };

/**
 * Check a pose name before it is saved. Built-in names are reserved, an existing saved name is a
 * replacement (said so up front), a brand new name needs a free slot and names are length bounded.
 */
export function checkExpressionName(raw: unknown, saved: readonly ExpressionPreset[]): NameCheck {
  const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!text) return { ok: false, reason: 'Give the pose a name before saving.' };
  if (text.length > AVATAR_LIMITS.nameLength) return { ok: false, reason: `Names are limited to ${AVATAR_LIMITS.nameLength} characters; this one is ${text.length}.` };
  const name = normalizeName(text);
  const lower = name.toLowerCase();
  const builtIn = BUILT_IN_EXPRESSIONS.find((b) => b.name.toLowerCase() === lower);
  if (builtIn) return { ok: false, reason: `"${builtIn.name}" is a built-in pose. Pick another name; built-ins cannot be replaced.` };
  const replaces = saved.find((p) => p.name.toLowerCase() === lower) ?? null;
  if (!replaces && saved.length >= AVATAR_LIMITS.expressions) return { ok: false, reason: `All ${AVATAR_LIMITS.expressions} expression slots are used. Delete one or reuse an existing name to replace it.` };
  return { ok: true, name, replaces, note: replaces ? `Saving will replace your pose "${replaces.name}".` : null };
}

/* ------------------------------ keyboard control and keyframe navigation ------------------------------ */

export type StudioAction = 'play' | 'home' | 'end' | 'prevKey' | 'nextKey' | 'back' | 'fwd' | 'backBig' | 'fwdBig' | 'undo' | 'redo';
export type KeyInput = { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean; editing?: boolean; interactive?: boolean };

/** Shown in the studio's keyboard help; the same table drives studioKeyAction. */
export const STUDIO_SHORTCUTS: readonly { keys: string; action: StudioAction; what: string }[] = [
  { keys: 'Space', action: 'play', what: 'Play or pause the open timeline' },
  { keys: 'Home / End', action: 'home', what: 'Jump to the start or end' },
  { keys: '[ / ]', action: 'prevKey', what: 'Previous or next keyframe' },
  { keys: ', / .', action: 'back', what: 'Step 10 ms back or forward (Shift: 100 ms)' },
  { keys: 'Ctrl+Z', action: 'undo', what: 'Undo the last pack change' },
  { keys: 'Ctrl+Y or Ctrl+Shift+Z', action: 'redo', what: 'Redo' },
];

/**
 * Map a key press to a studio action, or null. Text fields keep their own keys (including the
 * browser's undo) and buttons keep Space and Enter, so shortcuts only fire from the stage,
 * sliders or empty space. Sliders keep their arrow keys; the studio does not use arrows at all.
 */
export function studioKeyAction(k: KeyInput): StudioAction | null {
  if (k.alt) return null;
  if (k.ctrl) {
    if (k.editing) return null;
    const key = k.key.toLowerCase();
    if (key === 'z') return k.shift ? 'redo' : 'undo';
    if (key === 'y') return 'redo';
    return null;
  }
  if (k.editing || k.interactive) return null;
  switch (k.key) {
    case ' ':
    case 'Spacebar':
      return 'play';
    case 'Home':
      return 'home';
    case 'End':
      return 'end';
    case '[':
      return 'prevKey';
    case ']':
      return 'nextKey';
    case ',':
    case '<':
      return k.shift ? 'backBig' : 'back';
    case '.':
    case '>':
      return k.shift ? 'fwdBig' : 'fwd';
    default:
      return null;
  }
}

export const STEP_MS = 10;
export const STEP_BIG_MS = 100;

/** Indices of the keyframes strictly before, exactly at and strictly after a time (keyframes are kept sorted). */
export function keyframeNeighbors(tl: Timeline, tMs: number): { prev: number | null; next: number | null; at: number | null } {
  let prev: number | null = null;
  let next: number | null = null;
  let at: number | null = null;
  tl.keyframes.forEach((k, i) => {
    if (k.at < tMs) prev = i;
    else if (k.at === tMs && at === null) at = i;
    else if (k.at > tMs && next === null) next = i;
  });
  return { prev, next, at };
}

/** Where a studio action moves the clock. Steps clamp to the timeline; keyframe jumps stay put at the ends. */
export function stepTime(tl: Timeline, tMs: number, action: StudioAction): number {
  const clamp = (v: number) => Math.min(tl.duration, Math.max(0, Math.round(v)));
  const n = keyframeNeighbors(tl, tMs);
  switch (action) {
    case 'home':
      return 0;
    case 'end':
      return tl.duration;
    case 'back':
      return clamp(tMs - STEP_MS);
    case 'fwd':
      return clamp(tMs + STEP_MS);
    case 'backBig':
      return clamp(tMs - STEP_BIG_MS);
    case 'fwdBig':
      return clamp(tMs + STEP_BIG_MS);
    case 'prevKey':
      return n.prev === null ? clamp(tMs) : tl.keyframes[n.prev].at;
    case 'nextKey':
      return n.next === null ? clamp(tMs) : tl.keyframes[n.next].at;
    default:
      return clamp(tMs);
  }
}

/* ------------------------------ import file classification ------------------------------ */

export type ImportClass = { kind: 'pack' | 'unsupported'; format: string; reason: string };

const IMPORT_FAMILIES: readonly { test: RegExp; format: string; reason: string }[] = [
  { test: /\.(model3\.json|moc3|cmo3|can3)$/, format: 'Live2D model', reason: 'This build has no Live2D runtime, so the file is not read.' },
  { test: /\.(vrm|vrma)$/, format: 'VRM avatar or animation', reason: 'No 3D avatar runtime or VRM reader is bundled. The companion is 2D vector geometry only.' },
  { test: /\.(glb|gltf|fbx|obj|blend|usdz|dae|stl|3ds)$/, format: '3D model or scene', reason: 'No 3D avatar importer is bundled. 3D files are not converted into the 2D geometry.' },
  { test: /\.(bvh|anim|vmd)$/, format: 'Skeletal animation', reason: 'Timelines here are keyframes between saved poses; skeletal animation data has no mapping and is not read.' },
  { test: /\.(png|jpe?g|webp|gif|bmp|avif|tiff?|ico)$/, format: 'Image', reason: 'Images are not traced into geometry and nothing here animates pictures. Build the pose with the sliders instead.' },
  { test: /\.svg$/, format: 'SVG image', reason: 'SVG is an export format only. Shapes are not read back; the pack JSON is the editable source.' },
  { test: /\.(psd|ai|xcf|sketch|fig|kra)$/, format: 'Layered design file', reason: 'Layered art is not imported. The avatar is procedural, so there is no layer mapping.' },
  { test: /\.(zip|7z|rar|tar|gz|tgz)$/, format: 'Archive', reason: 'Archives are not unpacked. Export a single pack JSON from the other app and import that.' },
  { test: /\.(mp4|webm|mov|mkv|avi)$/, format: 'Video', reason: 'Video is neither read nor written here. The contact sheet SVG is the only timeline export.' },
  { test: /\.(wav|mp3|ogg|flac|m4a|aac)$/, format: 'Audio', reason: 'Audio is not analysed in the studio. Voice reaction only uses an amplitude the host passes in.' },
  { test: /\.(yaml|yml|toml|xml|csv|txt|md)$/, format: 'Text document', reason: 'Only pack JSON is read. If this holds pack JSON, paste its contents or rename it to .json.' },
];

/**
 * Say truthfully what a dropped or chosen file is and whether this build can read it. Only pack
 * JSON inside the size bound is read; everything else gets a specific label and reason instead
 * of a generic error, and nothing is read from an unsupported file.
 */
export function classifyImportFile(file: { name: string; type?: string; size: number }): ImportClass {
  const name = String(file.name ?? '').toLowerCase();
  const size = Number.isFinite(file.size) ? Math.max(0, file.size) : 0;
  for (const f of IMPORT_FAMILIES) if (f.test.test(name)) return { kind: 'unsupported', format: f.format, reason: f.reason };
  const isJson = /\.json$/.test(name) || /json/.test(String(file.type ?? '').toLowerCase());
  if (!isJson) return { kind: 'unsupported', format: name.includes('.') ? `Unknown format (${name.slice(name.lastIndexOf('.'))})` : 'Unknown format', reason: 'Only pack JSON (.json) is read. Export a pack from this studio to see the expected shape.' };
  if (size > AVATAR_LIMITS.packBytes) return { kind: 'unsupported', format: 'Pack JSON, too large', reason: `Packs are limited to ${AVATAR_LIMITS.packBytes / 1024} KB; this file is ${Math.ceil(size / 1024)} KB and was not read.` };
  return { kind: 'pack', format: 'Pack JSON', reason: 'Read as text, then every value is checked and clamped before review.' };
}

/* ------------------------------ import and export previews ------------------------------ */

export const GEOMETRY_LABELS: Record<keyof AvatarGeometry, string> = {
  headShape: 'Head shape',
  eyeStyle: 'Eye style',
  mouthStyle: 'Mouth style',
  headWidth: 'Head width',
  headHeight: 'Head height',
  eyeSize: 'Eye size',
  eyeSpacing: 'Eye spacing',
  mouthWidth: 'Mouth width',
  antennaHeight: 'Antenna height',
  bodyHue: 'Body colour',
  accentHue: 'Accent colour',
  glowHue: 'Glow colour',
  antenna: 'Antenna',
  visor: 'Visor',
  cheeks: 'Cheeks',
};

export type ImportPreview = {
  replace: { geometryChanges: string[]; renames: boolean; removedExpressions: number; removedTimelines: number; incomingExpressions: number; incomingTimelines: number };
  merge: { addedExpressions: number; addedTimelines: number; skipped: number; warnings: string[] };
};

/** What Replace and Add would each do, computed without saving anything. */
export function previewImport(current: AvatarPack, incoming: AvatarPack): ImportPreview {
  const geometryChanges = (Object.keys(GEOMETRY_LABELS) as (keyof AvatarGeometry)[]).filter((k) => current.geometry[k] !== incoming.geometry[k]).map((k) => GEOMETRY_LABELS[k]);
  const m = mergeAvatarPacks(current, incoming);
  const skipped = incoming.expressions.length - m.addedExpressions + (incoming.timelines.length - m.addedTimelines);
  return {
    replace: {
      geometryChanges,
      renames: current.name !== incoming.name,
      removedExpressions: current.expressions.length,
      removedTimelines: current.timelines.length,
      incomingExpressions: incoming.expressions.length,
      incomingTimelines: incoming.timelines.length,
    },
    merge: { addedExpressions: m.addedExpressions, addedTimelines: m.addedTimelines, skipped, warnings: m.warnings },
  };
}

export type ExportPreview = { id: string; name: string; fileName: string | null; bytes: number | null; status: ExportStatus; reason: string };

/** Every export row with its real file name and byte size, or its honest reason for being unavailable. */
export function exportPreviews(pack: AvatarPack, pose: Expression, timeline: Timeline | null, sheetSvg: string | null): ExportPreview[] {
  const stem = safeFileStem(pack.name);
  const sizes: Record<string, { fileName: string; bytes: number } | null> = {
    json: { fileName: `${stem}.avatar.json`, bytes: byteLength(serializeAvatarPack(pack)) },
    'svg-pose': { fileName: `${stem}.svg`, bytes: byteLength(renderAvatarSvg(pack.geometry, pose, pack.name)) },
    'svg-sheet': timeline && sheetSvg ? { fileName: `${stem}-${safeFileStem(timeline.name, 'timeline')}-sheet.svg`, bytes: byteLength(sheetSvg) } : null,
  };
  return AVATAR_EXPORTS.map((x) => {
    const s = x.status === 'available' ? (sizes[x.id] ?? null) : null;
    const reason = x.status === 'available' && !s ? 'Open a timeline with at least one keyframe to export its contact sheet.' : x.reason;
    return { id: x.id, name: x.name, fileName: s?.fileName ?? null, bytes: s?.bytes ?? null, status: x.status, reason };
  });
}

export const formatKb = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 102.4) / 10} KB`);
