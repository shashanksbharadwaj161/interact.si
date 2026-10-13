/**
 * Motion Studio presets and simulation maths.
 *
 * Pure, DOM-free module so it can be unit tested in Node. The canvas component in
 * src/components/MotionStudio.tsx only draws what these functions return.
 * Everything here is deterministic for a given seed and time; nothing is random at draw time.
 * Saved presets contain only a kind, three numbers and a short user-chosen name.
 */

export type MotionKind = 'wave' | 'particles' | 'orbit';

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

export const isMotionKind = (v: unknown): v is MotionKind => v === 'wave' || v === 'particles' || v === 'orbit';
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
  const kind = MOTION_KINDS.find((k) => k.id === s.kind)?.name ?? s.kind;
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
