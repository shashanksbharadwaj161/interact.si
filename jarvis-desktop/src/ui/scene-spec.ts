/**
 * Scene spec (feature 139): a tiny, strictly validated JSON contract for "describe a scene" generation.
 *
 * Pure and DOM-free. This module never calls a model or the network. A spec can come from the
 * deterministic offline keyword composer below, or be pasted from any model's reply; either way it is
 * only applied after validateSceneSpec accepts it.
 */

import {
  ALL_MOTION_KINDS,
  DEFAULT_SETTINGS,
  LIMITS,
  MAX_PRESET_NAME,
  isMotionKind,
  normalizePresetName,
  normalizeSettings,
  type MotionKind,
  type MotionSettings,
  type SavedPreset,
} from './motion-presets';

export const SCENE_SPEC_FORMAT = 'desktop-companion-scene' as const;
export const SCENE_SPEC_VERSION = 1 as const;
/** Largest accepted input, in characters (JSON text, or the serialized object). */
export const MAX_SCENE_SPEC_CHARS = 20000;
export const DEFAULT_SPEC_NAME = 'Untitled scene';

export type SceneSpec = {
  format: typeof SCENE_SPEC_FORMAT;
  version: typeof SCENE_SPEC_VERSION;
  name: string;
  kind: MotionKind;
  intensity: number;
  speed: number;
  hue: number;
};

export type SceneSpecError = { path: string; message: string };
export type SceneSpecResult = { ok: true; spec: SceneSpec; warnings: string[] } | { ok: false; errors: SceneSpecError[] };

const KNOWN_KEYS = new Set(['format', 'version', 'name', 'kind', 'intensity', 'speed', 'hue']);
const NUMERIC_KEYS = ['intensity', 'speed', 'hue'] as const;

/** Validate a scene spec given as JSON text or an object. Nothing outside the known keys reaches the spec. */
export function validateSceneSpec(input: unknown): SceneSpecResult {
  let raw: unknown = input;
  if (typeof input === 'string') {
    if (input.length > MAX_SCENE_SPEC_CHARS) return { ok: false, errors: [{ path: '', message: `Input is larger than ${MAX_SCENE_SPEC_CHARS} characters.` }] };
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, errors: [{ path: '', message: 'Input is not valid JSON.' }] };
    }
  } else if (raw && typeof raw === 'object') {
    let size = Infinity;
    try {
      size = JSON.stringify(raw)?.length ?? Infinity;
    } catch {
      return { ok: false, errors: [{ path: '', message: 'Input could not be serialized as JSON.' }] };
    }
    if (size > MAX_SCENE_SPEC_CHARS) return { ok: false, errors: [{ path: '', message: `Input is larger than ${MAX_SCENE_SPEC_CHARS} characters.` }] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: [{ path: '', message: 'Scene spec must be a JSON object.' }] };

  const o = raw as Record<string, unknown>;
  const errors: SceneSpecError[] = [];
  const warnings: string[] = [];

  if (o.format !== SCENE_SPEC_FORMAT) errors.push({ path: 'format', message: `Expected format "${SCENE_SPEC_FORMAT}", got ${JSON.stringify(o.format) ?? 'nothing'}.` });
  if (o.version !== SCENE_SPEC_VERSION) errors.push({ path: 'version', message: `Unsupported version ${JSON.stringify(o.version) ?? 'missing'}; this build reads version ${SCENE_SPEC_VERSION}.` });
  if (!isMotionKind(o.kind)) errors.push({ path: 'kind', message: `Unknown kind ${JSON.stringify(o.kind) ?? 'missing'}. Allowed: ${ALL_MOTION_KINDS.map((k) => k.id).join(', ')}.` });

  const nums: Partial<Record<(typeof NUMERIC_KEYS)[number], number>> = {};
  for (const key of NUMERIC_KEYS) {
    const v = o[key];
    const { min, max } = LIMITS[key];
    if (v === undefined) errors.push({ path: key, message: `${key} is required (${min} to ${max}).` });
    else if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ path: key, message: `${key} must be a finite number.` });
    else if (v < min || v > max) errors.push({ path: key, message: `${key} ${v} is outside ${min} to ${max}.` });
    else {
      const rounded = Math.round(v);
      if (rounded !== v) warnings.push(`${key} ${v} was rounded to ${rounded}.`);
      nums[key] = rounded;
    }
  }

  let name = DEFAULT_SPEC_NAME;
  if (o.name === undefined) warnings.push(`No name given; using "${DEFAULT_SPEC_NAME}".`);
  else if (typeof o.name !== 'string') errors.push({ path: 'name', message: 'name must be a string.' });
  else if (o.name.trim().length > MAX_PRESET_NAME) errors.push({ path: 'name', message: `name is longer than ${MAX_PRESET_NAME} characters.` });
  else {
    const clean = normalizePresetName(o.name);
    if (!clean) warnings.push(`Name was empty; using "${DEFAULT_SPEC_NAME}".`);
    else {
      if (clean !== o.name) warnings.push('Name whitespace or control characters were cleaned.');
      name = clean;
    }
  }

  for (const key of Object.keys(o)) if (!KNOWN_KEYS.has(key)) warnings.push(`Dropped unknown key "${key.slice(0, 40)}".`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    spec: { format: SCENE_SPEC_FORMAT, version: SCENE_SPEC_VERSION, name, kind: o.kind as MotionKind, intensity: nums.intensity!, speed: nums.speed!, hue: nums.hue! },
    warnings,
  };
}

/* ---------- deterministic offline composer ---------- */

const KIND_WORDS: Record<string, MotionKind> = {
  wave: 'wave', waves: 'wave', ocean: 'wave', tide: 'wave',
  particles: 'particles', particle: 'particles', dust: 'particles', embers: 'particles', sparks: 'particles',
  orbit: 'orbit', orbits: 'orbit', planets: 'orbit', planet: 'orbit',
  aurora: 'aurora', northern: 'aurora',
  bloom: 'bloom', burst: 'bloom', flower: 'bloom',
  lattice: 'lattice', grid: 'lattice', constellation: 'lattice',
};
const SLOW_WORDS = new Set(['calm', 'slow', 'gentle', 'relaxed', 'quiet', 'sleepy', 'peaceful', 'still']);
const FAST_WORDS = new Set(['fast', 'quick', 'rapid', 'energetic', 'lively', 'frantic']);
const DENSE_WORDS = new Set(['busy', 'dense', 'energetic', 'intense', 'crowded', 'rich']);
const SPARSE_WORDS = new Set(['minimal', 'sparse', 'subtle', 'simple', 'calm']);
const HUE_WORDS: Record<string, number> = {
  red: 0, crimson: 350, orange: 30, amber: 40, gold: 45, golden: 45, yellow: 55, lime: 90, green: 120, emerald: 140,
  teal: 175, cyan: 185, aqua: 185, blue: 220, navy: 230, indigo: 250, violet: 270, purple: 275, magenta: 300, pink: 330, rose: 340,
};
export const COMPOSE_VALUES = { slowSpeed: 20, fastSpeed: 80, denseIntensity: 85, sparseIntensity: 25 } as const;

/**
 * Compose a scene spec from a short description with a fixed keyword rule set. Deterministic and offline;
 * the result always passes validateSceneSpec. `now` is accepted for API symmetry and does not affect output.
 */
export function composeSceneFromText(text: string, now?: number): { spec: SceneSpec; rationale: string[] } {
  void now;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Describe the scene in a few words first (for example "calm blue waves").');
  const words = text.slice(0, 2000).toLowerCase().match(/[a-z]+/g) ?? [];
  const s: MotionSettings = { ...DEFAULT_SETTINGS };
  const rationale: string[] = [];

  const kindWord = words.find((w) => w in KIND_WORDS);
  if (kindWord) {
    s.kind = KIND_WORDS[kindWord];
    rationale.push(`"${kindWord}" chose the ${s.kind} kind.`);
  } else rationale.push(`No kind word found; using the default ${s.kind} kind.`);

  const slow = words.find((w) => SLOW_WORDS.has(w));
  const fast = words.find((w) => FAST_WORDS.has(w));
  if (slow && !fast) {
    s.speed = COMPOSE_VALUES.slowSpeed;
    rationale.push(`"${slow}" lowered speed to ${s.speed}.`);
  } else if (fast && !slow) {
    s.speed = COMPOSE_VALUES.fastSpeed;
    rationale.push(`"${fast}" raised speed to ${s.speed}.`);
  } else if (fast && slow) rationale.push(`"${slow}" and "${fast}" conflict; speed stays at ${s.speed}.`);

  const dense = words.find((w) => DENSE_WORDS.has(w));
  const sparse = words.find((w) => SPARSE_WORDS.has(w));
  if (dense && !sparse) {
    s.intensity = COMPOSE_VALUES.denseIntensity;
    rationale.push(`"${dense}" raised intensity to ${s.intensity}.`);
  } else if (sparse && !dense) {
    s.intensity = COMPOSE_VALUES.sparseIntensity;
    rationale.push(`"${sparse}" lowered intensity to ${s.intensity}.`);
  } else if (dense && sparse) rationale.push(`"${sparse}" and "${dense}" conflict; intensity stays at ${s.intensity}.`);

  const colour = words.find((w) => w in HUE_WORDS);
  if (colour) {
    s.hue = HUE_WORDS[colour];
    rationale.push(`"${colour}" set hue to ${s.hue}°.`);
  } else rationale.push(`No colour word found; hue stays at ${s.hue}°.`);

  const clean = normalizeSettings(s);
  const name = normalizePresetName(text) || DEFAULT_SPEC_NAME;
  const spec: SceneSpec = { format: SCENE_SPEC_FORMAT, version: SCENE_SPEC_VERSION, name, ...clean };
  const checked = validateSceneSpec(spec);
  if (!checked.ok) throw new Error(`Internal composer error: ${checked.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  return { spec: checked.spec, rationale };
}

/** Convert a validated spec into a SavedPreset-compatible object. */
export function sceneSpecToPreset(spec: SceneSpec, id: string): SavedPreset {
  return { id, name: normalizePresetName(spec.name) || DEFAULT_SPEC_NAME, ...normalizeSettings(spec) };
}

/** Plain settings from a validated spec, for applying to the studio. */
export const sceneSpecToSettings = (spec: SceneSpec): MotionSettings => normalizeSettings(spec);

export const serializeSceneSpec = (spec: SceneSpec): string =>
  JSON.stringify({ format: spec.format, version: spec.version, name: spec.name, kind: spec.kind, intensity: spec.intensity, speed: spec.speed, hue: spec.hue }, null, 2);
