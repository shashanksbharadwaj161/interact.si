/**
 * Motion Studio presets and simulation maths.
 *
 * Pure, DOM-free module so it can be unit tested in Node. The canvas component in
 * src/components/MotionStudio.tsx only draws what these functions return.
 * Everything here is deterministic for a given seed and time; nothing is random at draw time.
 * Saved presets contain only a kind, three numbers and a short user-chosen name.
 */

import {
  QUALITY_PROFILES,
  TAU,
  clamp,
  contactFrames,
  easeToCss,
  evaluateKeys,
  fract,
  framePhase,
  frameToTime,
  hash01,
  isQualityId,
  loopCycles,
  loopNoise,
  loopSeconds,
  normalizeKeys,
  normalizeTimeline,
  round,
  smoothstep,
  springValue,
  EASINGS,
  DEFAULT_TIMELINE,
  type Keyframe,
  type QualityId,
  type QualityProfile,
  type Timeline,
} from './motion-timing';

/** The first three kinds are the classic studio set; aurora, bloom and lattice were added with Motion Lab. */
export type MotionKind = 'wave' | 'particles' | 'orbit' | 'aurora' | 'bloom' | 'lattice';

export type MotionSettings = {
  kind: MotionKind;
  /** 0..100: how busy the scene is (layers, particle count, orbit count, amplitude). */
  intensity: number;
  /** 0..100: playback rate. 0 freezes time, 50 is the natural rate. */
  speed: number;
  /** 0..360: base hue of the palette. */
  hue: number;
};

export type SavedPreset = MotionSettings & { id: string; name: string };

export const MOTION_KINDS: { id: MotionKind; name: string; blurb: string }[] = [
  { id: 'wave', name: 'Wave', blurb: 'Layered sine ribbons rolling across the canvas.' },
  { id: 'particles', name: 'Particles', blurb: 'A slow drift of glowing points that wrap at the edges.' },
  { id: 'orbit', name: 'Orbit', blurb: 'Bodies circling a quiet core on tilted rings.' },
];

/** Motion Lab kinds. Same layer schema; scenes using them need a build that knows these ids. */
export const LAB_KINDS: { id: MotionKind; name: string; blurb: string }[] = [
  { id: 'aurora', name: 'Aurora', blurb: 'Soft curtains of light with shimmering rays.' },
  { id: 'bloom', name: 'Bloom', blurb: 'A core that gathers, bursts and settles, sending out springy rings.' },
  { id: 'lattice', name: 'Lattice', blurb: 'A seeded constellation grid with a signal sweeping through it.' },
];
export const ALL_MOTION_KINDS = [...MOTION_KINDS, ...LAB_KINDS];
export const kindName = (k: MotionKind): string => ALL_MOTION_KINDS.find((x) => x.id === k)?.name ?? k;

export const LIMITS = {
  intensity: { min: 0, max: 100, step: 1 },
  speed: { min: 0, max: 100, step: 1 },
  hue: { min: 0, max: 360, step: 1 },
} as const;

/** Upper bound on user presets kept in local storage. */
export const MAX_SAVED_PRESETS = 12;
export const MAX_PRESET_NAME = 40;
/** Key under the shared non-sensitive UI preference prefix (see src/ui/prefs.ts). */
export const PRESET_PREF_KEY = 'motion.presets';

export const DEFAULT_SETTINGS: MotionSettings = { kind: 'wave', intensity: 55, speed: 45, hue: 210 };

/** Built-in starting points. Ids are prefixed so they can never collide with saved ones. */
export const BUILT_IN_PRESETS: readonly SavedPreset[] = [
  { id: 'builtin:wave', name: 'Calm wave', kind: 'wave', intensity: 55, speed: 40, hue: 210 },
  { id: 'builtin:particles', name: 'Ember drift', kind: 'particles', intensity: 50, speed: 35, hue: 28 },
  { id: 'builtin:orbit', name: 'Violet orbit', kind: 'orbit', intensity: 60, speed: 50, hue: 268 },
];

export const isMotionKind = (v: unknown): v is MotionKind => typeof v === 'string' && ALL_MOTION_KINDS.some((k) => k.id === v);
export const isBuiltInId = (id: string): boolean => id.startsWith('builtin:');

const clampNum = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** Coerce anything (storage, form input, an old schema) into valid settings. Unknown fields are dropped. */
export function normalizeSettings(input: unknown, fallback: MotionSettings = DEFAULT_SETTINGS): MotionSettings {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    kind: isMotionKind(o.kind) ? o.kind : fallback.kind,
    intensity: clampNum(o.intensity, LIMITS.intensity.min, LIMITS.intensity.max, fallback.intensity),
    speed: clampNum(o.speed, LIMITS.speed.min, LIMITS.speed.max, fallback.speed),
    hue: clampNum(o.hue, LIMITS.hue.min, LIMITS.hue.max, fallback.hue),
  };
}

/** Trim, collapse whitespace, strip control characters and bound the length. Empty result means "no name". */
export function normalizePresetName(name: unknown): string {
  if (typeof name !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_PRESET_NAME);
}

const ID_RE = /^[a-z0-9:_-]{1,48}$/i;

/** Parse the stored preset list. Bad entries are skipped, duplicates collapse to the first, and the count is capped. */
export function parseSavedPresets(raw: unknown): SavedPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedPreset[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || !ID_RE.test(o.id) || isBuiltInId(o.id) || seen.has(o.id)) continue;
    const name = normalizePresetName(o.name);
    if (!name || !isMotionKind(o.kind)) continue;
    seen.add(o.id);
    out.push({ id: o.id, name, ...normalizeSettings(o) });
    if (out.length >= MAX_SAVED_PRESETS) break;
  }
  return out;
}

/** Deterministic id from a counter or timestamp; the caller decides the source. */
export const makePresetId = (seed: number): string => `p-${Math.abs(Math.trunc(seed)).toString(36)}`;

/** Replace a preset with the same id, else append. Returns false in `ok` when the list is full. */
export function upsertPreset(list: SavedPreset[], preset: SavedPreset): { list: SavedPreset[]; ok: boolean } {
  const clean: SavedPreset = { id: preset.id, name: normalizePresetName(preset.name), ...normalizeSettings(preset) };
  if (!clean.name || !ID_RE.test(clean.id) || isBuiltInId(clean.id)) return { list, ok: false };
  const i = list.findIndex((p) => p.id === clean.id);
  if (i >= 0) return { list: list.map((p, j) => (j === i ? clean : p)), ok: true };
  if (list.length >= MAX_SAVED_PRESETS) return { list, ok: false };
  return { list: [...list, clean], ok: true };
}

export const removePreset = (list: SavedPreset[], id: string): SavedPreset[] => list.filter((p) => p.id !== id);

/** Short human description used for the canvas label and the status line. */
export function describeSettings(s: MotionSettings): string {
  const kind = kindName(s.kind);
  return `${kind}, intensity ${s.intensity}%, speed ${s.speed}%, hue ${s.hue}°`;
}

/* ---------- colour ---------- */

export function hueColor(hue: number, sat: number, light: number, alpha = 1): string {
  const h = ((Math.round(hue) % 360) + 360) % 360;
  const s = Math.min(100, Math.max(0, Math.round(sat)));
  const l = Math.min(100, Math.max(0, Math.round(light)));
  const a = Math.min(1, Math.max(0, alpha));
  return `hsla(${h}, ${s}%, ${l}%, ${Number(a.toFixed(3))})`;
}

/* ---------- time ---------- */

/** Playback multiplier: 0 freezes, 50 is 1×, 100 is 2.5×, with a gentle curve in between. */
export function timeScale(speed: number): number {
  const s = Math.min(100, Math.max(0, speed)) / 100;
  if (s === 0) return 0;
  return Number((0.15 + 2.35 * s * s).toFixed(4));
}

/* ---------- deterministic randomness ---------- */

function prng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

/* ---------- wave ---------- */

export const waveLayerCount = (intensity: number): number => 2 + Math.round((Math.min(100, Math.max(0, intensity)) / 100) * 3);

/**
 * Height (0..1 of the canvas, 0 = top) of a wave layer at horizontal position x (0..1) and sim time t (seconds).
 * Layers differ in frequency, phase and drift direction so they cross rather than stack.
 */
export function wavePoint(layer: number, x: number, t: number, intensity: number): number {
  const amp = 0.04 + (Math.min(100, Math.max(0, intensity)) / 100) * 0.16;
  const freq = 1.5 + layer * 0.7;
  const dir = layer % 2 === 0 ? 1 : -1;
  const base = 0.5 + (layer - 1.5) * 0.07;
  const main = Math.sin(x * freq * Math.PI * 2 + dir * t * (0.8 + layer * 0.15));
  const ripple = Math.sin(x * freq * 5.3 * Math.PI + t * 1.7 + layer) * 0.25;
  return base + amp * (main + ripple);
}

/* ---------- particles ---------- */

export type Particle = { x: number; y: number; vx: number; vy: number; r: number; phase: number };

export const particleCount = (intensity: number): number => 24 + Math.round((Math.min(100, Math.max(0, intensity)) / 100) * 136);

/** Particles in normalized 0..1 space. Same count and seed always give the same field. */
export function seedParticles(count: number, seed: number): Particle[] {
  const r = prng(seed);
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const angle = r() * Math.PI * 2;
    const sp = 0.015 + r() * 0.03;
    out.push({ x: r(), y: r(), vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp, r: 1 + r() * 2.5, phase: r() * Math.PI * 2 });
  }
  return out;
}

/**
 * Advance particles in place by dt seconds (already scaled by timeScale). Positions wrap at the edges and
 * a gentle swirl keyed to intensity keeps them from drifting in straight lines. Returns the same array.
 */
export function stepParticles(ps: Particle[], dt: number, intensity: number, t: number): Particle[] {
  if (!(dt > 0)) return ps;
  const swirl = 0.02 + (Math.min(100, Math.max(0, intensity)) / 100) * 0.06;
  for (const p of ps) {
    const wob = Math.sin(t * 0.6 + p.phase) * swirl;
    p.x += (p.vx + wob * -p.vy) * dt;
    p.y += (p.vy + wob * p.vx) * dt;
    if (p.x < 0) p.x += 1;
    else if (p.x >= 1) p.x -= 1;
    if (p.y < 0) p.y += 1;
    else if (p.y >= 1) p.y -= 1;
  }
  return ps;
}

/* ---------- orbit ---------- */

export type OrbitBody = {
  /** Ring radius as a fraction of the smaller half-dimension. */
  radius: number;
  /** Seconds per revolution at 1× speed. */
  period: number;
  phase: number;
  /** Vertical squash of the ring (perspective tilt), 0.3..1. */
  tilt: number;
  size: number;
  direction: 1 | -1;
};

export const orbitCount = (intensity: number): number => 2 + Math.round((Math.min(100, Math.max(0, intensity)) / 100) * 6);

export function seedOrbits(count: number, seed: number): OrbitBody[] {
  const r = prng(seed);
  const out: OrbitBody[] = [];
  for (let i = 0; i < count; i++) {
    const radius = 0.18 + (i / Math.max(1, count - 1)) * 0.72 + (r() - 0.5) * 0.04;
    out.push({
      radius: Math.min(0.95, Math.max(0.1, radius)),
      period: 6 + radius * 22 + r() * 4,
      phase: r() * Math.PI * 2,
      tilt: 0.3 + r() * 0.7,
      size: 2 + r() * 3,
      direction: r() < 0.5 ? 1 : -1,
    });
  }
  return out;
}

/** Position of a body at sim time t in centred -1..1 space (y positive downwards). */
export function orbitPosition(b: OrbitBody, t: number): { x: number; y: number } {
  const a = b.phase + b.direction * ((t / b.period) * Math.PI * 2);
  return { x: Math.cos(a) * b.radius, y: Math.sin(a) * b.radius * b.tilt };
}

/* =====================================================================================
 * Scene composition (roadmap 137–140). A scene stacks up to MAX_LAYERS layers, each one
 * a preset plus opacity and seed, over a background hue. Still pure and DOM-free.
 * ===================================================================================== */

export const SCENE_VERSION = 1 as const;
export const MAX_LAYERS = 4;
export const MAX_SAVED_SCENES = 8;
export const MAX_SCENE_BYTES = 16 * 1024;
export const SCENE_PREF_KEY = 'motion.scenes';

export type MotionLayer = MotionSettings & { id: string; /** 0..100 */ opacity: number; seed: number };
export type MotionScene = { version: typeof SCENE_VERSION; name: string; /** 0..360 */ background: number; layers: MotionLayer[] };
export type SavedScene = MotionScene & { id: string };

export const makeLayerId = (seed: number): string => `l-${Math.abs(Math.trunc(seed)).toString(36)}`;

export function normalizeLayer(input: unknown, fallbackId: string): MotionLayer {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const id = typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : fallbackId;
  return { id, ...normalizeSettings(o), opacity: clampNum(o.opacity, 0, 100, 100), seed: clampNum(o.seed, 1, 1_000_000, 7) };
}

export function sceneFromSettings(s: MotionSettings, name = 'Untitled scene'): MotionScene {
  return { version: SCENE_VERSION, name: normalizePresetName(name) || 'Untitled scene', background: s.hue, layers: [{ id: makeLayerId(1), ...normalizeSettings(s), opacity: 100, seed: 7 }] };
}

/** Original scene templates (scope 138). Ids are reserved with the builtin prefix. */
export const SCENE_TEMPLATES: readonly SavedScene[] = [
  { id: 'builtin:tide', version: 1, name: 'Tide', background: 205, layers: [
    { id: 'l-1', kind: 'wave', intensity: 70, speed: 30, hue: 205, opacity: 100, seed: 7 },
    { id: 'l-2', kind: 'particles', intensity: 25, speed: 20, hue: 190, opacity: 55, seed: 11 },
  ] },
  { id: 'builtin:ember', version: 1, name: 'Ember field', background: 22, layers: [
    { id: 'l-1', kind: 'particles', intensity: 65, speed: 35, hue: 24, opacity: 100, seed: 3 },
    { id: 'l-2', kind: 'wave', intensity: 20, speed: 25, hue: 10, opacity: 35, seed: 5 },
  ] },
  { id: 'builtin:deep-orbit', version: 1, name: 'Deep orbit', background: 262, layers: [
    { id: 'l-1', kind: 'orbit', intensity: 75, speed: 45, hue: 268, opacity: 100, seed: 9 },
    { id: 'l-2', kind: 'particles', intensity: 15, speed: 10, hue: 300, opacity: 40, seed: 21 },
  ] },
  { id: 'builtin:aurora-stack', version: 1, name: 'Aurora stack', background: 160, layers: [
    { id: 'l-1', kind: 'wave', intensity: 45, speed: 25, hue: 160, opacity: 90, seed: 2 },
    { id: 'l-2', kind: 'wave', intensity: 80, speed: 15, hue: 120, opacity: 45, seed: 4 },
    { id: 'l-3', kind: 'orbit', intensity: 20, speed: 30, hue: 200, opacity: 30, seed: 6 },
  ] },
];

export type SceneParse = { ok: true; scene: MotionScene; issues: string[] } | { ok: false; error: string; issues: string[] };

/**
 * Strict scene validator used for import and for anything a model proposes (scope 139).
 * Structural problems reject; out-of-range numbers are clamped and listed as issues. Unknown keys are dropped.
 */
export function parseScene(input: unknown): SceneParse {
  const issues: string[] = [];
  let raw = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_SCENE_BYTES) return { ok: false, error: `Scene is larger than ${MAX_SCENE_BYTES / 1024} KB.`, issues };
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Scene is not valid JSON.', issues };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Scene must be a JSON object.', issues };
  const o = raw as Record<string, unknown>;
  if (o.version !== SCENE_VERSION) return { ok: false, error: `Unsupported scene version ${String(o.version)}; this build reads version ${SCENE_VERSION}.`, issues };
  if (!Array.isArray(o.layers) || o.layers.length === 0) return { ok: false, error: 'Scene needs at least one layer.', issues };
  if (o.layers.length > MAX_LAYERS) issues.push(`Only the first ${MAX_LAYERS} layers were kept.`);
  const layers: MotionLayer[] = [];
  const seen = new Set<string>();
  for (const [i, item] of o.layers.slice(0, MAX_LAYERS).entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `Layer ${i + 1} is not an object.`, issues };
    const l = item as Record<string, unknown>;
    if (!isMotionKind(l.kind)) return { ok: false, error: `Layer ${i + 1} has unknown kind "${String(l.kind)}". Allowed: ${ALL_MOTION_KINDS.map((k) => k.id).join(', ')}.`, issues };
    let layer = normalizeLayer(l, makeLayerId(i + 1));
    if (seen.has(layer.id)) layer = { ...layer, id: makeLayerId(i + 1 + 100) };
    seen.add(layer.id);
    for (const k of ['intensity', 'speed', 'hue', 'opacity'] as const) {
      if (typeof l[k] === 'number' && l[k] !== layer[k]) issues.push(`Layer ${i + 1} ${k} ${String(l[k])} was clamped to ${layer[k]}.`);
      if (l[k] === undefined) issues.push(`Layer ${i + 1} ${k} was missing; using ${layer[k]}.`);
    }
    layers.push(layer);
  }
  const background = clampNum(o.background, 0, 360, layers[0].hue);
  if (o.background === undefined) issues.push('Background hue was missing; using the first layer hue.');
  const name = normalizePresetName(o.name) || 'Untitled scene';
  if (!normalizePresetName(o.name)) issues.push('Scene had no name.');
  return { ok: true, scene: { version: SCENE_VERSION, name, background, layers }, issues };
}

export function serializeScene(scene: MotionScene): string {
  return JSON.stringify({ version: SCENE_VERSION, name: scene.name, background: scene.background, layers: scene.layers.map((l) => ({ id: l.id, kind: l.kind, intensity: l.intensity, speed: l.speed, hue: l.hue, opacity: l.opacity, seed: l.seed })) }, null, 2);
}

/**
 * Pull the first JSON object out of free text (a model reply often wraps JSON in prose or fences)
 * and validate it with parseScene. Nothing is trusted until it passes.
 */
export function sceneFromText(text: string): SceneParse {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'No JSON object found in the text.', issues: [] };
  return parseScene(text.slice(start, end + 1));
}

/** Compact schema description a host can place in a model prompt. The validator is the contract; this is the hint. */
export const SCENE_SCHEMA_HINT = `{"version":1,"name":"string (max ${MAX_PRESET_NAME})","background":0-360,"layers":[{"kind":"${ALL_MOTION_KINDS.map((k) => k.id).join('|')}","intensity":0-100,"speed":0-100,"hue":0-360,"opacity":0-100,"seed":1-1000000}]} with 1 to ${MAX_LAYERS} layers`;

export function parseSavedScenes(raw: unknown): SavedScene[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedScene[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.id !== 'string' || !ID_RE.test(o.id) || isBuiltInId(o.id) || seen.has(o.id)) continue;
    const parsed = parseScene(o);
    if (!parsed.ok) continue;
    seen.add(o.id);
    out.push({ id: o.id, ...parsed.scene });
    if (out.length >= MAX_SAVED_SCENES) break;
  }
  return out;
}

export function upsertScene(list: SavedScene[], scene: SavedScene): { list: SavedScene[]; ok: boolean } {
  if (!ID_RE.test(scene.id) || isBuiltInId(scene.id)) return { list, ok: false };
  const i = list.findIndex((s) => s.id === scene.id);
  if (i >= 0) return { list: list.map((s, j) => (j === i ? scene : s)), ok: true };
  if (list.length >= MAX_SAVED_SCENES) return { list, ok: false };
  return { list: [...list, scene], ok: true };
}

export function describeScene(scene: MotionScene): string {
  const kinds = scene.layers.map((l) => kindName(l.kind));
  return `${scene.name}: ${scene.layers.length} layer${scene.layers.length === 1 ? '' : 's'} (${kinds.join(', ')}), background hue ${scene.background}°`;
}

/* ---------- clip export planning (scope 140) ---------- */

export const CLIP_FPS = [12, 24, 30] as const;
export const CLIP_LIMITS = { minSeconds: 1, maxSeconds: 10, maxWidth: 1280, maxFrames: 300 } as const;
export type ClipFps = (typeof CLIP_FPS)[number];
export type ClipPlan = { fps: ClipFps; seconds: number; width: number; height: number };

export function normalizeClipPlan(input: Partial<ClipPlan>): ClipPlan {
  const fps: ClipFps = (CLIP_FPS as readonly number[]).includes(input.fps as number) ? (input.fps as ClipFps) : 24;
  const seconds = clampNum(input.seconds, CLIP_LIMITS.minSeconds, CLIP_LIMITS.maxSeconds, 4);
  const width = clampNum(input.width, 160, CLIP_LIMITS.maxWidth, 960);
  const height = clampNum(input.height, 90, CLIP_LIMITS.maxWidth, Math.round((width * 9) / 16));
  return { fps, seconds, width, height };
}

/** Frames a plan renders; never above CLIP_LIMITS.maxFrames (30 fps × 10 s is the ceiling). */
export const clipFrameCount = (p: ClipPlan): number => Math.min(CLIP_LIMITS.maxFrames, p.fps * p.seconds);

/* =====================================================================================
 * Motion Lab: deterministic frame rendering.
 *
 * renderFrame(lab, frame, w, h, quality) is a pure function of its arguments. It returns drawing
 * primitives; the canvas painter and the SVG serializer both draw from the same list, so a
 * preview, a PNG, an SVG and a contact sheet of one frame agree. There is no simulation state:
 * frame 90 is computed directly, never by stepping from frame 0.
 * ===================================================================================== */

/** Seconds per base cycle at 1x speed. Each kind expresses its motion as whole harmonics of this cycle. */
export const BASE_CYCLE_S = 8;

export type Paint = string | { y0: number; y1: number; from: string; to: string };
export type Prim =
  | { p: 'poly'; pts: number[]; closed: boolean; fill?: Paint; stroke?: string; width?: number }
  | { p: 'circle'; x: number; y: number; r: number; fill: string }
  | { p: 'ellipse'; x: number; y: number; rx: number; ry: number; stroke: string; width: number }
  | { p: 'glow'; x: number; y: number; r: number; inner: string; outer: string }
  | { p: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; width: number };

export type ResolvedLayer = MotionLayer & { /** 1 = 100% */ scale: number; /** % of width */ x: number; /** % of height */ y: number };
export type FrameLayer = { id: string; kind: MotionKind; alpha: number; scale: number; dx: number; dy: number; prims: Prim[] };
export type RenderedFrame = { width: number; height: number; frame: number; time: number; background: { base: string; tint: string }; layers: FrameLayer[] };

const r2 = (v: number) => round(v, 2);

/** Wave height (0..1, 0 = top) at x for a base phase. Only whole harmonics of the phase, so it loops exactly. */
export function waveAt(layer: number, x: number, phase: number, intensity: number): number {
  const amp = 0.04 + (clamp(intensity, 0, 100) / 100) * 0.16;
  const freq = 1.5 + layer * 0.7;
  const dir = layer % 2 === 0 ? 1 : -1;
  const base = 0.5 + (layer - 1.5) * 0.07;
  const main = Math.sin(x * freq * TAU + dir * (1 + (layer % 2)) * phase);
  const ripple = Math.sin(x * freq * 5.3 * Math.PI + 2 * phase + layer) * 0.25;
  return base + amp * (main + ripple);
}

function curve(w: number, step: number, fn: (x: number) => number): number[] {
  const pts: number[] = [];
  for (let x = 0; x <= w + step; x += step) pts.push(r2(x), r2(fn(x)));
  return pts;
}

function renderWave(l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile): Prim[] {
  const out: Prim[] = [];
  const n = waveLayerCount(l.intensity);
  for (let layer = n - 1; layer >= 0; layer--) {
    const top = curve(w, q.curveStep, (x) => waveAt(layer, x / w, th, l.intensity) * h);
    const hue = l.hue + layer * 16;
    out.push({ p: 'poly', pts: [...top, r2(w + q.curveStep), h, 0, h], closed: true, fill: { y0: r2(h * 0.3), y1: h, from: hueColor(hue, 70, 50, 0.18), to: hueColor(hue, 70, 40, 0) } });
    out.push({ p: 'poly', pts: top, closed: false, stroke: hueColor(hue, 82, 64, 0.85 - layer * 0.12), width: layer === 0 ? 2.2 : 1.4 });
  }
  return out;
}

function renderParticles(l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile): Prim[] {
  const out: Prim[] = [];
  const count = Math.min(q.elementCap, particleCount(l.intensity));
  for (let i = 0; i < count; i++) {
    const hh = (k: number) => hash01(l.seed, i * 8 + k);
    const size = 1 + hh(2) * 2.5;
    const depth = size > 2.4 ? 2 : 1;
    const ph = hh(4) * TAU;
    const y = fract(hh(1) - (depth * th) / TAU);
    const x = fract(hh(0) + (0.01 + hh(3) * 0.03) * Math.sin((1 + Math.floor(hh(5) * 2)) * th + ph));
    const pulse = 0.5 + 0.5 * Math.sin((1 + Math.floor(hh(6) * 3)) * th + ph);
    const edge = smoothstep(0, 0.06, y) * smoothstep(1, 0.94, y);
    const r = size * (0.8 + 0.4 * pulse);
    const hue = l.hue + (ph / TAU) * 50;
    if (q.glow && size > 2.6) out.push({ p: 'glow', x: r2(x * w), y: r2(y * h), r: r2(r * 4), inner: hueColor(hue, 90, 70, 0.35 * edge), outer: hueColor(hue, 90, 60, 0) });
    out.push({ p: 'circle', x: r2(x * w), y: r2(y * h), r: r2(r), fill: hueColor(hue, 85, 68, (0.3 + 0.5 * pulse) * edge) });
  }
  return out;
}

function renderOrbit(l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile): Prim[] {
  const out: Prim[] = [];
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.min(w, h) / 2 - 6;
  const breathe = 1 + 0.08 * Math.sin(th);
  const glow = (10 + (l.intensity / 100) * 12) * breathe;
  if (q.glow) out.push({ p: 'glow', x: r2(cx), y: r2(cy), r: r2(glow * 2.4), inner: hueColor(l.hue, 90, 72, 0.9), outer: hueColor(l.hue, 90, 60, 0) });
  else out.push({ p: 'circle', x: r2(cx), y: r2(cy), r: r2(glow * 0.7), fill: hueColor(l.hue, 90, 72, 0.9) });
  const bodies = seedOrbits(orbitCount(l.intensity), l.seed);
  bodies.forEach((b, i) => out.push({ p: 'ellipse', x: r2(cx), y: r2(cy), rx: r2(b.radius * half), ry: r2(b.radius * half * b.tilt), stroke: hueColor(l.hue + i * 9, 60, 60, 0.26), width: 1 }));
  bodies.forEach((b, i) => {
    const n = 1 + Math.floor((bodies.length - 1 - i) / 2);
    const at = (a: number) => ({ x: cx + Math.cos(a) * b.radius * half, y: cy + Math.sin(a) * b.radius * half * b.tilt });
    const a = b.phase + b.direction * n * th;
    const trail: number[] = [];
    for (let k = 8; k >= 0; k--) {
      const p = at(a - b.direction * k * 0.06);
      trail.push(r2(p.x), r2(p.y));
    }
    out.push({ p: 'poly', pts: trail, closed: false, stroke: hueColor(l.hue + i * 9, 85, 70, 0.3), width: r2(b.size * 0.6) });
    const p = at(a);
    const depth = (Math.sin(a) + 1) / 2;
    out.push({ p: 'circle', x: r2(p.x), y: r2(p.y), r: r2(b.size * (0.7 + depth * 0.6)), fill: hueColor(l.hue + i * 9, 85, 70, 0.45 + depth * 0.5) });
  });
  return out;
}

function renderAurora(l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile): Prim[] {
  const out: Prim[] = [];
  const I = clamp(l.intensity, 0, 100) / 100;
  const bands = 2 + Math.round(I * 3);
  for (let b = 0; b < bands; b++) {
    const hh = (k: number) => hash01(l.seed, b * 16 + k);
    const hue = l.hue + b * 22 - 20;
    const base = h * (0.22 + b * 0.09);
    const amp = h * (0.05 + 0.08 * I);
    const f1 = 0.6 + hh(0) * 0.8;
    const f2 = 1.5 + hh(1) * 1.5;
    const p1 = hh(2) * TAU;
    const p2 = hh(3) * TAU;
    const depth = h * (0.2 + 0.1 * I);
    const topAt = (x: number) => base + amp * (Math.sin((x / w) * f1 * TAU + (1 + (b % 2)) * th + p1) + 0.5 * Math.sin((x / w) * f2 * TAU - 2 * th + p2));
    const top = curve(w, q.curveStep, topAt);
    const bottom: number[] = [];
    for (let i = top.length - 2; i >= 0; i -= 2) {
      const x = top[i];
      bottom.push(x, r2(top[i + 1] + depth * (0.7 + 0.3 * Math.sin((x / w) * 3 * TAU + th + p2))));
    }
    out.push({ p: 'poly', pts: [...top, ...bottom], closed: true, fill: { y0: r2(base - amp * 1.5), y1: r2(base + amp * 1.5 + depth), from: hueColor(hue, 80, 62, 0.42), to: hueColor(hue + 30, 80, 50, 0) } });
    if (q.glow) {
      const rays = Math.min(24, Math.floor(q.elementCap / bands));
      for (let k = 0; k < rays; k++) {
        const x = hash01(l.seed, 900 + b * 64 + k) * w;
        const y = topAt(x);
        const len = depth * (0.5 + 0.4 * Math.sin((1 + (k % 3)) * th + k));
        out.push({ p: 'line', x1: r2(x), y1: r2(y), x2: r2(x), y2: r2(y + len), stroke: hueColor(hue + 10, 90, 75, 0.12), width: 1.5 });
      }
    }
    out.push({ p: 'poly', pts: top, closed: false, stroke: hueColor(hue, 90, 75, 0.55), width: 1.2 });
  }
  return out;
}

const BLOOM_RING_SPRING = { stiffness: 120, damping: 9, mass: 1 };
const BLOOM_CORE_SPRING = { stiffness: 200, damping: 16, mass: 1 };

/**
 * Bloom core scale over one beat (b in 0..1): anticipation (gathers to 86%), a fast burst to 130%, then a
 * spring settle back to 100% with a little follow-through wobble.
 */
export function bloomCoreScale(b: number): number {
  if (b < 0.18) return 1 - 0.14 * EASINGS['out-quad'](b / 0.18);
  if (b < 0.3) return 0.86 + 0.44 * EASINGS['out-cubic']((b - 0.18) / 0.12);
  return 1.3 - 0.3 * springValue(BLOOM_CORE_SPRING, (b - 0.3) * 2.2);
}

function renderBloom(l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile): Prim[] {
  const out: Prim[] = [];
  const cx = w / 2;
  const cy = h / 2;
  const R = (Math.min(w, h) / 2) * 0.92;
  const rings = 3 + Math.round((clamp(l.intensity, 0, 100) / 100) * 4);
  const P = (th / TAU) * rings;
  for (let j = 0; j < rings; j++) {
    const age = fract((P - 0.24 - j) / rings);
    const radius = R * springValue(BLOOM_RING_SPRING, age * 1.4);
    const alpha = smoothstep(0, 0.06, age) * (1 - age) ** 1.6;
    out.push({ p: 'ellipse', x: r2(cx), y: r2(cy), rx: r2(radius), ry: r2(radius), stroke: hueColor(l.hue + j * 6, 85, 68, 0.7 * alpha), width: r2(1 + 3 * (1 - age)) });
  }
  const b = fract(P);
  const s = bloomCoreScale(b);
  const core = (Math.min(w, h) / 360) * 22 * s;
  if (q.glow) out.push({ p: 'glow', x: r2(cx), y: r2(cy), r: r2(core * 3), inner: hueColor(l.hue, 95, 75, 0.85), outer: hueColor(l.hue, 90, 60, 0) });
  out.push({ p: 'circle', x: r2(cx), y: r2(cy), r: r2(core), fill: hueColor(l.hue, 90, 80, 0.95) });
  for (let i = 0; i < 6; i++) {
    const a = th + (i * TAU) / 6;
    const rr = core * (2.1 + 0.25 * Math.sin(2 * th + i));
    out.push({ p: 'circle', x: r2(cx + Math.cos(a) * rr), y: r2(cy + Math.sin(a) * rr), r: r2(core * 0.16 * (0.8 + 0.4 * (1 - b))), fill: hueColor(l.hue + 30, 85, 72, 0.8) });
  }
  return out;
}

function renderLattice(l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile): Prim[] {
  const out: Prim[] = [];
  let cols = 5 + Math.round((clamp(l.intensity, 0, 100) / 100) * 7);
  let rows = Math.max(2, Math.round((cols * h) / w));
  while (cols * rows > q.elementCap && cols > 3) {
    cols--;
    rows = Math.max(2, Math.round((cols * h) / w));
  }
  const cw = w / cols;
  const ch = h / rows;
  const nodes: { x: number; y: number; s: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = (c + 0.5 + (hash01(l.seed, i * 4) - 0.5) * 0.6 + 0.18 * loopNoise(l.seed, i * 2, th, 2)) * cw;
      const y = (r + 0.5 + (hash01(l.seed, i * 4 + 1) - 0.5) * 0.6 + 0.18 * loopNoise(l.seed, i * 2 + 1, th, 2)) * ch;
      const d = Math.hypot(x / w, y / h);
      nodes.push({ x, y, s: 0.5 + 0.5 * Math.cos(th - d * TAU * 1.5) });
    }
  }
  const link = (a: number, b: number) => {
    const A = nodes[a];
    const B = nodes[b];
    out.push({ p: 'line', x1: r2(A.x), y1: r2(A.y), x2: r2(B.x), y2: r2(B.y), stroke: hueColor(l.hue, 70, 65, 0.08 + 0.35 * ((A.s + B.s) / 2)), width: 1 });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c < cols - 1) link(i, i + 1);
      if (r < rows - 1) link(i, i + cols);
      if (q.glow && c < cols - 1 && r < rows - 1 && hash01(l.seed, 5000 + i) < 0.35) link(i, i + cols + 1);
    }
  }
  nodes.forEach((n, i) => {
    if (q.glow && n.s > 0.85) out.push({ p: 'glow', x: r2(n.x), y: r2(n.y), r: r2(10 * n.s), inner: hueColor(l.hue + 20, 90, 75, 0.5), outer: hueColor(l.hue + 20, 90, 60, 0) });
    out.push({ p: 'circle', x: r2(n.x), y: r2(n.y), r: r2(1.2 + 2 * n.s), fill: hueColor(l.hue + (i % 5) * 4, 85, 72, 0.4 + 0.5 * n.s) });
  });
  return out;
}

const RENDERERS: Record<MotionKind, (l: ResolvedLayer, th: number, w: number, h: number, q: QualityProfile) => Prim[]> = {
  wave: renderWave,
  particles: renderParticles,
  orbit: renderOrbit,
  aurora: renderAurora,
  bloom: renderBloom,
  lattice: renderLattice,
};

/* ---------- Lab documents: scene + timeline + keyframe tracks ---------- */

export const LAB_VERSION = 1 as const;
export const LAB_PREF_KEY = 'motion.lab';
export const MAX_TRACKS = 12;
export const MAX_LAB_BYTES = 64 * 1024;

export type TrackParam = 'intensity' | 'hue' | 'opacity' | 'scale' | 'x' | 'y';
export const TRACK_PARAMS: { id: TrackParam; name: string; unit: string; min: number; max: number; rest: (l: MotionLayer) => number }[] = [
  { id: 'intensity', name: 'Intensity', unit: '%', min: 0, max: 100, rest: (l) => l.intensity },
  { id: 'hue', name: 'Hue', unit: '°', min: -360, max: 720, rest: (l) => l.hue },
  { id: 'opacity', name: 'Opacity', unit: '%', min: 0, max: 100, rest: (l) => l.opacity },
  { id: 'scale', name: 'Scale', unit: '%', min: 25, max: 300, rest: () => 100 },
  { id: 'x', name: 'Offset X', unit: '%', min: -50, max: 50, rest: () => 0 },
  { id: 'y', name: 'Offset Y', unit: '%', min: -50, max: 50, rest: () => 0 },
];
export const isTrackParam = (v: unknown): v is TrackParam => TRACK_PARAMS.some((p) => p.id === v);
export const trackParam = (id: TrackParam) => TRACK_PARAMS.find((p) => p.id === id) ?? TRACK_PARAMS[0];

export type Track = { layer: string; param: TrackParam; keys: Keyframe[] };
export type MotionLab = { version: typeof LAB_VERSION; type: 'motion-lab'; scene: MotionScene; timeline: Timeline; tracks: Track[]; quality: QualityId };
export type SavedLab = { id: string; name: string; blurb: string; lab: MotionLab };
export type LabParse = { ok: true; lab: MotionLab; issues: string[] } | { ok: false; error: string; issues: string[] };

export function labFromScene(scene: MotionScene, timeline: Partial<Timeline> = {}): MotionLab {
  return { version: LAB_VERSION, type: 'motion-lab', scene, timeline: normalizeTimeline({ ...DEFAULT_TIMELINE, ...timeline }), tracks: [], quality: 'balanced' };
}

export const DEFAULT_LAB: MotionLab = labFromScene(sceneFromSettings(DEFAULT_SETTINGS));

function normalizeTracks(input: unknown, scene: MotionScene, tl: Timeline, issues: string[]): Track[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    issues.push('Tracks were not a list and were ignored.');
    return [];
  }
  const ids = new Set(scene.layers.map((l) => l.id));
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const [i, item] of input.entries()) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.layer !== 'string' || !ids.has(o.layer)) {
      issues.push(`Track ${i + 1} points at a layer that does not exist and was dropped.`);
      continue;
    }
    if (!isTrackParam(o.param)) {
      issues.push(`Track ${i + 1} has unknown parameter "${String(o.param)}" and was dropped.`);
      continue;
    }
    const key = `${o.layer}/${o.param}`;
    if (seen.has(key)) {
      issues.push(`Track ${i + 1} repeats ${key}; only the first was kept.`);
      continue;
    }
    const spec = trackParam(o.param);
    const keys = normalizeKeys(o.keys, tl.frames, spec.min, spec.max);
    if (keys.length === 0) continue;
    if (out.length >= MAX_TRACKS) {
      issues.push(`Only the first ${MAX_TRACKS} tracks were kept.`);
      break;
    }
    seen.add(key);
    out.push({ layer: o.layer, param: o.param, keys });
  }
  return out;
}

/**
 * Strict Lab validator for files, pastes and model replies. A plain scene is accepted and given a default
 * timeline. Tracks pointing at missing layers or unknown parameters are dropped with an issue.
 */
export function parseLab(input: unknown): LabParse {
  const issues: string[] = [];
  let raw = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_LAB_BYTES) return { ok: false, error: `Lab file is larger than ${MAX_LAB_BYTES / 1024} KB.`, issues };
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Lab file is not valid JSON.', issues };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Lab file must be a JSON object.', issues };
  const o = raw as Record<string, unknown>;
  if (o.type !== 'motion-lab') {
    const sc = parseScene(o);
    if (!sc.ok) return sc;
    return { ok: true, lab: labFromScene(sc.scene), issues: [...sc.issues, 'This was a plain scene; a default timeline was added.'] };
  }
  if (o.version !== LAB_VERSION) return { ok: false, error: `Unsupported lab version ${String(o.version)}; this build reads version ${LAB_VERSION}.`, issues };
  const sc = parseScene(o.scene);
  if (!sc.ok) return { ok: false, error: `Scene: ${sc.error}`, issues: sc.issues };
  issues.push(...sc.issues);
  const timeline = normalizeTimeline(o.timeline);
  if (!o.timeline || typeof o.timeline !== 'object') issues.push('Timeline was missing; using the default.');
  const tracks = normalizeTracks(o.tracks, sc.scene, timeline, issues);
  const quality = isQualityId(o.quality) ? o.quality : 'balanced';
  return { ok: true, lab: { version: LAB_VERSION, type: 'motion-lab', scene: sc.scene, timeline, tracks, quality }, issues };
}

export function serializeLab(lab: MotionLab): string {
  return JSON.stringify(
    {
      version: LAB_VERSION,
      type: 'motion-lab',
      scene: JSON.parse(serializeScene(lab.scene)),
      timeline: { fps: lab.timeline.fps, frames: lab.timeline.frames, loop: lab.timeline.loop, poster: lab.timeline.poster },
      tracks: lab.tracks.map((t) => ({ layer: t.layer, param: t.param, keys: t.keys.map((k) => ({ frame: k.frame, value: k.value, ease: k.ease })) })),
      quality: lab.quality,
    },
    null,
    2,
  );
}

export const LAB_SCHEMA_HINT = `{"version":1,"type":"motion-lab","scene":${'<scene>'},"timeline":{"fps":12|24|30|60,"frames":2-1200,"loop":true,"poster":0},"tracks":[{"layer":"<layer id>","param":"${TRACK_PARAMS.map((p) => p.id).join('|')}","keys":[{"frame":0,"value":0,"ease":{"type":"preset","name":"in-out-cubic"}}]}],"quality":"eco|balanced|studio"}`;

export function describeLab(lab: MotionLab): string {
  const s = loopSeconds(lab.timeline);
  return `${describeScene(lab.scene)}; ${lab.timeline.frames} frames at ${lab.timeline.fps} fps (${round(s, 2)} s${lab.timeline.loop ? ' loop' : ''}), ${lab.tracks.length} track${lab.tracks.length === 1 ? '' : 's'}`;
}

/** Layer values at a frame after keyframe tracks are applied. Values are not rounded so motion stays smooth. */
export function resolveLayer(lab: MotionLab, layer: MotionLayer, frame: number): ResolvedLayer {
  const val = (param: TrackParam): number => {
    const spec = trackParam(param);
    const tr = lab.tracks.find((t) => t.layer === layer.id && t.param === param);
    const v = tr ? evaluateKeys(tr.keys, frame, lab.timeline) : null;
    return v ?? spec.rest(layer);
  };
  return {
    ...layer,
    intensity: clamp(val('intensity'), 0, 100),
    hue: val('hue'),
    opacity: clamp(val('opacity'), 0, 100),
    scale: clamp(val('scale'), 10, 400) / 100,
    x: val('x'),
    y: val('y'),
  };
}

/** Base cycles per second for a layer speed. */
export const layerRate = (speed: number): number => timeScale(speed) / BASE_CYCLE_S;

/** Whole cycles each layer completes in one loop; 0 means frozen (speed 0) or not looping. */
export const layerLoopCycles = (lab: MotionLab): number[] =>
  lab.scene.layers.map((l) => (lab.timeline.loop ? loopCycles(layerRate(l.speed), loopSeconds(lab.timeline)) : 0));

export function renderFrame(lab: MotionLab, frame: number, width: number, height: number, quality: QualityProfile = QUALITY_PROFILES[lab.quality]): RenderedFrame {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const tl = lab.timeline;
  const layers: FrameLayer[] = lab.scene.layers.map((layer) => {
    const r = resolveLayer(lab, layer, frame);
    const th = framePhase(frame, tl, layerRate(layer.speed));
    return { id: layer.id, kind: layer.kind, alpha: round(r.opacity / 100, 4), scale: round(r.scale, 4), dx: r2((r.x / 100) * w), dy: r2((r.y / 100) * h), prims: RENDERERS[layer.kind](r, th, w, h, quality) };
  });
  return { width: w, height: h, frame, time: frameToTime(frame, tl.fps), background: { base: hueColor(lab.scene.background, 35, 7), tint: hueColor(lab.scene.background, 70, 45, 0.22) }, layers };
}

const numbersOf = (f: RenderedFrame): number[] => {
  const out: number[] = [];
  for (const l of f.layers) {
    out.push(l.alpha, l.scale, l.dx, l.dy, l.prims.length);
    for (const p of l.prims) for (const v of Object.values(p)) if (typeof v === 'number') out.push(v);
      else if (Array.isArray(v)) out.push(...v);
  }
  return out;
};

/**
 * Compare frame `frames` (one past the end) with frame 0. In a loop they must match, so playback can wrap
 * without a jump. Reports the largest coordinate drift in pixels; exact means under 0.05 px.
 */
export function loopSeamReport(lab: MotionLab, w = 320, h = 180): { loop: boolean; exact: boolean; drift: number; cycles: number[] } {
  const cycles = layerLoopCycles(lab);
  if (!lab.timeline.loop) return { loop: false, exact: false, drift: NaN, cycles };
  const a = numbersOf(renderFrame(lab, 0, w, h));
  const b = numbersOf(renderFrame(lab, lab.timeline.frames, w, h));
  if (a.length !== b.length) return { loop: true, exact: false, drift: Infinity, cycles };
  let drift = 0;
  for (let i = 0; i < a.length; i++) drift = Math.max(drift, Math.abs(a[i] - b[i]));
  return { loop: true, exact: drift < 0.05, drift: round(drift, 3), cycles };
}

/* ---------- SVG export (vector frame and contact sheet) ---------- */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgBody(f: RenderedFrame, idp: string): { defs: string; body: string } {
  let g = 0;
  const defs: string[] = [];
  const w = f.width;
  const h = f.height;
  defs.push(`<radialGradient id="${idp}bg" gradientUnits="userSpaceOnUse" cx="${w / 2}" cy="${r2(h * 1.1)}" r="${r2(Math.max(w, h) * 0.9)}"><stop offset="0" stop-color="${f.background.tint}"/><stop offset="1" stop-color="${hueColor(0, 0, 0, 0)}"/></radialGradient>`);
  const paint = (p: Paint): string => {
    if (typeof p === 'string') return p;
    const id = `${idp}g${g++}`;
    defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${p.y0}" x2="0" y2="${p.y1}"><stop offset="0" stop-color="${p.from}"/><stop offset="1" stop-color="${p.to}"/></linearGradient>`);
    return `url(#${id})`;
  };
  const body: string[] = [`<rect width="${w}" height="${h}" fill="${f.background.base}"/>`, `<rect width="${w}" height="${h}" fill="url(#${idp}bg)"/>`];
  for (const l of f.layers) {
    const cx = w / 2;
    const cy = h / 2;
    body.push(`<g opacity="${l.alpha}" transform="translate(${r2(cx + l.dx)} ${r2(cy + l.dy)}) scale(${l.scale}) translate(${-cx} ${-cy})">`);
    for (const p of l.prims) {
      if (p.p === 'poly') {
        const pts = [];
        for (let i = 0; i < p.pts.length; i += 2) pts.push(`${p.pts[i]},${p.pts[i + 1]}`);
        const tag = p.closed ? 'polygon' : 'polyline';
        body.push(`<${tag} points="${pts.join(' ')}" fill="${p.fill ? paint(p.fill) : 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.width ?? 1}" stroke-linejoin="round" stroke-linecap="round"` : ''}/>`);
      } else if (p.p === 'circle') body.push(`<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${p.fill}"/>`);
      else if (p.p === 'ellipse') body.push(`<ellipse cx="${p.x}" cy="${p.y}" rx="${p.rx}" ry="${p.ry}" fill="none" stroke="${p.stroke}" stroke-width="${p.width}"/>`);
      else if (p.p === 'line') body.push(`<line x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" stroke="${p.stroke}" stroke-width="${p.width}" stroke-linecap="round"/>`);
      else {
        const id = `${idp}g${g++}`;
        defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${p.x}" cy="${p.y}" r="${p.r}"><stop offset="0" stop-color="${p.inner}"/><stop offset="1" stop-color="${p.outer}"/></radialGradient>`);
        body.push(`<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="url(#${id})"/>`);
      }
    }
    body.push('</g>');
  }
  return { defs: defs.join(''), body: body.join('') };
}

/** Standalone SVG of one frame. Every value is a number or a generated colour; names are escaped. */
export function frameToSvg(f: RenderedFrame, title = 'Motion Lab frame'): string {
  const { defs, body } = svgBody(f, 'f');
  return `<svg xmlns="${SVG_NS}" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}"><title>${esc(title)}</title><defs>${defs}</defs>${body}</svg>`;
}

/** Contact sheet of representative frames (first and last included) as one SVG, labelled with frame and timecode. */
export function contactSheetSvg(lab: MotionLab, count = 12, cellW = 240, quality: QualityProfile = QUALITY_PROFILES[lab.quality]): { svg: string; frames: number[] } {
  const frames = contactFrames(lab.timeline, count);
  const cols = Math.max(1, Math.ceil(Math.sqrt(frames.length * 1.4)));
  const rows = Math.ceil(frames.length / cols);
  const cellH = Math.round((cellW * 9) / 16);
  const gap = 6;
  const label = 18;
  const W = cols * cellW + (cols + 1) * gap;
  const H = rows * (cellH + label) + (rows + 1) * gap;
  const parts: string[] = [`<rect width="${W}" height="${H}" fill="${hueColor(lab.scene.background, 20, 5)}"/>`];
  frames.forEach((fr, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = gap + c * (cellW + gap);
    const y = gap + r * (cellH + label + gap);
    const { defs, body } = svgBody(renderFrame(lab, fr, cellW, cellH, quality), `c${i}`);
    parts.push(`<svg x="${x}" y="${y}" width="${cellW}" height="${cellH}" viewBox="0 0 ${cellW} ${cellH}"><defs>${defs}</defs>${body}</svg>`);
    const s = Math.floor(fr / lab.timeline.fps);
    parts.push(`<text x="${x + 2}" y="${y + cellH + 13}" fill="${hueColor(0, 0, 80)}" font-family="monospace" font-size="11">frame ${fr}  ${s}:${String(fr % lab.timeline.fps).padStart(2, '0')}</text>`);
  });
  return { svg: `<svg xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><title>${esc(lab.scene.name)} contact sheet</title>${parts.join('')}</svg>`, frames };
}

/* ---------- CSS export of keyframe tracks ---------- */

const cssIdent = (s: string) => s.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

/**
 * CSS @keyframes for tracks that map to CSS properties (opacity, scale, translate). Intensity and hue drive
 * canvas maths only and are listed as comments. Easing per segment uses easeToCss, so springs become linear().
 */
export function tracksToCss(lab: MotionLab): string {
  const tl = lab.timeline;
  const secs = round(loopSeconds(tl), 3);
  const lines: string[] = [`/* ${lab.scene.name.replace(/\*\//g, '')}: ${tl.frames} frames at ${tl.fps} fps, ${secs}s${tl.loop ? ' loop' : ''}. Generated offline by Motion Lab. */`];
  if (lab.tracks.length === 0) lines.push('/* No keyframe tracks yet. */');
  for (const t of lab.tracks) {
    const name = `lab-${cssIdent(t.layer)}-${t.param}`;
    const prop = t.param === 'opacity' ? 'opacity' : t.param === 'scale' ? 'scale' : t.param === 'x' || t.param === 'y' ? 'translate' : null;
    if (!prop) {
      lines.push(`/* ${name}: ${t.param} drives canvas drawing only; keys ${t.keys.map((k) => `${k.frame}=${k.value}`).join(', ')} */`);
      continue;
    }
    const fmt = (v: number) => (prop === 'opacity' ? String(round(v / 100, 4)) : prop === 'scale' ? String(round(v / 100, 4)) : t.param === 'x' ? `${v}% 0` : `0 ${v}%`);
    const keys = [...t.keys];
    const steps: string[] = [];
    if (keys[0].frame > 0) steps.push(`  0% { ${prop}: ${fmt(tl.loop ? (evaluateKeys(keys, 0, tl) ?? keys[0].value) : keys[0].value)}; }`);
    keys.forEach((k, i) => {
      const next = keys[i + 1];
      const segFrames = next ? next.frame - k.frame : tl.loop ? tl.frames - k.frame + keys[0].frame : 0;
      const ease = segFrames > 0 ? ` animation-timing-function: ${easeToCss(k.ease, segFrames / tl.fps)};` : '';
      steps.push(`  ${round((k.frame / tl.frames) * 100, 3)}% { ${prop}: ${fmt(k.value)};${ease} }`);
    });
    steps.push(`  100% { ${prop}: ${fmt(tl.loop ? (evaluateKeys(keys, tl.frames, tl) ?? keys[0].value) : keys[keys.length - 1].value)}; }`);
    lines.push(`@keyframes ${name} {`, ...steps, '}', `.${name} { animation: ${name} ${secs}s linear ${tl.loop ? 'infinite' : '1 both'}; }`);
  }
  lines.push('@media (prefers-reduced-motion: reduce) { [class^="lab-"] { animation: none; } }');
  return lines.join('\n');
}

/* ---------- Premium Lab presets (original) ---------- */

const key = (frame: number, value: number, ease: Keyframe['ease'] = { type: 'preset', name: 'in-out-sine' }): Keyframe => ({ frame, value, ease });
const lab = (name: string, background: number, layers: Omit<MotionLayer, 'id'>[], timeline: Partial<Timeline>, tracks: Track[]): MotionLab => ({
  version: LAB_VERSION,
  type: 'motion-lab',
  scene: { version: SCENE_VERSION, name, background, layers: layers.map((l, i) => ({ id: `l-${i + 1}`, ...l })) },
  timeline: normalizeTimeline({ ...DEFAULT_TIMELINE, ...timeline }),
  tracks,
  quality: 'balanced',
});

export const LAB_PRESETS: readonly SavedLab[] = [
  {
    id: 'builtin:lab-halo',
    name: 'Halo bloom',
    blurb: 'Gather, burst and springy rings over a faint lattice. 4 s loop.',
    lab: lab('Halo bloom', 250, [
      { kind: 'lattice', intensity: 30, speed: 30, hue: 220, opacity: 35, seed: 13 },
      { kind: 'bloom', intensity: 55, speed: 45, hue: 265, opacity: 100, seed: 5 },
    ], { fps: 30, frames: 120, poster: 40 }, [
      { layer: 'l-2', param: 'scale', keys: [key(0, 96, { type: 'preset', name: 'overshoot' }), key(60, 108, { type: 'spring', stiffness: 140, damping: 10, mass: 1 })] },
      { layer: 'l-2', param: 'hue', keys: [key(0, 265), key(60, 300)] },
    ]),
  },
  {
    id: 'builtin:lab-veil',
    name: 'Northern veil',
    blurb: 'Aurora curtains drifting through teal and violet with rising motes. 8 s loop.',
    lab: lab('Northern veil', 175, [
      { kind: 'aurora', intensity: 70, speed: 30, hue: 150, opacity: 100, seed: 3 },
      { kind: 'particles', intensity: 20, speed: 20, hue: 190, opacity: 55, seed: 17 },
    ], { fps: 30, frames: 240, poster: 90 }, [
      { layer: 'l-1', param: 'hue', keys: [key(0, 150), key(120, 205)] },
      { layer: 'l-2', param: 'opacity', keys: [key(0, 30), key(120, 70)] },
    ]),
  },
  {
    id: 'builtin:lab-signal',
    name: 'Signal lattice',
    blurb: 'A pulse sweeping a seeded grid while satellites circle. Spring intensity. 4 s loop.',
    lab: lab('Signal lattice', 205, [
      { kind: 'orbit', intensity: 25, speed: 30, hue: 185, opacity: 40, seed: 9 },
      { kind: 'lattice', intensity: 65, speed: 45, hue: 200, opacity: 100, seed: 21 },
    ], { fps: 24, frames: 96, poster: 30 }, [
      { layer: 'l-2', param: 'intensity', keys: [key(0, 45, { type: 'spring', stiffness: 220, damping: 12, mass: 1 }), key(48, 75, { type: 'preset', name: 'in-out-cubic' })] },
    ]),
  },
  {
    id: 'builtin:lab-tide',
    name: 'Tidal pulse',
    blurb: 'Waves that dip before they rise, with a soft bloom underneath. 6 s loop.',
    lab: lab('Tidal pulse', 200, [
      { kind: 'bloom', intensity: 25, speed: 30, hue: 210, opacity: 40, seed: 2 },
      { kind: 'wave', intensity: 60, speed: 40, hue: 195, opacity: 100, seed: 7 },
    ], { fps: 30, frames: 180, poster: 60 }, [
      { layer: 'l-2', param: 'y', keys: [key(0, 6, { type: 'preset', name: 'anticipate-overshoot' }), key(90, -6, { type: 'preset', name: 'anticipate-overshoot' })] },
    ]),
  },
  {
    id: 'builtin:lab-ember',
    name: 'Ember ascent',
    blurb: 'Warm motes rising through a low glow that breathes. 5 s loop.',
    lab: lab('Ember ascent', 18, [
      { kind: 'aurora', intensity: 25, speed: 20, hue: 10, opacity: 40, seed: 11 },
      { kind: 'particles', intensity: 75, speed: 40, hue: 24, opacity: 100, seed: 3 },
    ], { fps: 30, frames: 150, poster: 50 }, [
      { layer: 'l-1', param: 'opacity', keys: [key(0, 25), key(75, 55)] },
    ]),
  },
  {
    id: 'builtin:lab-orrery',
    name: 'Quiet orrery',
    blurb: 'Tilted rings with trails; the system leans in with anticipation and settles. 6 s loop.',
    lab: lab('Quiet orrery', 268, [
      { kind: 'particles', intensity: 15, speed: 10, hue: 300, opacity: 35, seed: 21 },
      { kind: 'orbit', intensity: 70, speed: 45, hue: 268, opacity: 100, seed: 9 },
    ], { fps: 30, frames: 180, poster: 70 }, [
      { layer: 'l-2', param: 'scale', keys: [key(0, 94, { type: 'preset', name: 'anticipate' }), key(70, 106, { type: 'spring', stiffness: 90, damping: 9, mass: 1 })] },
      { layer: 'l-2', param: 'x', keys: [key(0, -3), key(90, 3)] },
    ]),
  },
];

export const LAB_GATES: { feature: string; status: string }[] = [
  { feature: 'GIF, MP4 and APNG export', status: 'Unavailable: no local encoder is bundled. Use WebM, PNG, SVG or the contact sheet.' },
  { feature: 'Frame-exact video timing', status: 'Unavailable: WebM captures the live stage at the selected capture rate. Timing can jitter or skip frames. SVG and contact-sheet frames use deterministic geometry.' },
  { feature: '3D scenes and photoreal rendering', status: 'Not included. The Lab draws 2D canvas and SVG only.' },
  { feature: 'Soundtrack', status: 'Not included. No audio is generated or played.' },
  { feature: 'Cloud rendering or accounts', status: 'None. Everything runs on this computer.' },
];

/** Frames a contact sheet of this lab would show, for hosts that render their own sheet. */
export const contactSheetFrameList = (l: MotionLab, count = 12): number[] => contactFrames(l.timeline, count);
