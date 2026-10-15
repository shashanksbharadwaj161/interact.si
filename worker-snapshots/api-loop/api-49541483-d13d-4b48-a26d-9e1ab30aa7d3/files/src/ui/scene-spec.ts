/**
 * Validated scene specs for the Motion Studio (registry feature 139, building on 137 scene composition).
 *
 * A SceneSpec is the only shape a description composer or a model reply may produce. It is pure data:
 * a version, a short name, a duration, a loop flag, a background from an allowlisted palette (or #rrggbb)
 * and up to MAX_SPEC_LAYERS layers of enumerated kinds with bounded numbers. There are no URLs, file
 * paths, scripts or external asset references anywhere in the schema, and every string is either an
 * enumerated value or a short name restricted to a plain character set.
 *
 * Pure and DOM-free so it can be unit tested in Node. Nothing here performs I/O or calls a model.
 */

import { SCENES, starShadow } from './scenes';
import { MAX_LAYERS, SCENE_VERSION, makeLayerId, normalizeLayer, type MotionKind, type MotionLayer, type MotionScene } from './motion-presets';

export const SCENE_SPEC_VERSION = 1 as const;
export const MAX_SPEC_LAYERS = 12;
export const MAX_SPEC_NAME = 40;
/** Upper bound on raw model output we will look at. */
export const MAX_SPEC_TEXT_BYTES = 32 * 1024;
/** Upper bound on a free-text description fed to the offline composer. */
export const MAX_DESCRIPTION_CHARS = 500;

export const SPEC_LAYER_KINDS = ['stars', 'rings', 'ribbons', 'grid', 'ridges', 'particles'] as const;
export type SpecLayerKind = (typeof SPEC_LAYER_KINDS)[number];

/** Allowlisted background palette. Values are the colours the stage tint is derived from. */
export const SPEC_PALETTE = {
  midnight: '#070b1a',
  ink: '#0b1020',
  ocean: '#06202e',
  forest: '#08201a',
  dusk: '#2a1630',
  ember: '#2a120a',
  slate: '#1a2030',
} as const;
export type SpecPaletteName = keyof typeof SPEC_PALETTE;

export const SPEC_LIMITS = {
  durationMs: { min: 500, max: 60000, fallback: 8000 },
  count: { min: 0, max: 400, fallback: 120 },
  speed: { min: 0, max: 100, fallback: 40 },
  opacity: { min: 0, max: 100, fallback: 80 },
  seed: { min: 1, max: 1_000_000, fallback: 7 },
  hue: { min: 0, max: 360, fallback: 210 },
} as const;

type NumKey = 'count' | 'speed' | 'opacity' | 'seed' | 'hue';
const NUM_KEYS: readonly NumKey[] = ['count', 'speed', 'opacity', 'seed', 'hue'];
const INT_KEYS: ReadonlySet<NumKey> = new Set<NumKey>(['count', 'seed']);

export type SceneSpecLayer = { kind: SpecLayerKind; count: number; speed: number; opacity: number; seed: number; hue: number };
export type SpecBackground = SpecPaletteName | `#${string}`;
export type SceneSpec = {
  version: typeof SCENE_SPEC_VERSION;
  name: string;
  durationMs: number;
  loop: boolean;
  background: SpecBackground;
  layers: SceneSpecLayer[];
};

export type SpecError = { path: string; message: string };
export type SpecValidation = { ok: true; spec: SceneSpec } | { ok: false; errors: SpecError[] };

const TOP_KEYS: readonly string[] = ['version', 'name', 'durationMs', 'loop', 'background', 'layers'];
const LAYER_KEYS: readonly string[] = ['kind', ...NUM_KEYS];
export const DEFAULT_SPEC_NAME = 'Composed scene';
export const DEFAULT_BACKGROUND: SpecPaletteName = 'midnight';

const HEX_RE = /^#[0-9a-f]{6}$/i;
/** Plain names only: letters, digits, spaces and light punctuation. No slashes, colons, angle brackets or quotes. */
const NAME_RE = /^[\p{L}\p{N} .,'!?&()_-]+$/u;
/** Anything that looks like a URL, a file path, markup or script. Used to give a precise rejection message. */
const UNSAFE_RE = /([a-z][a-z0-9+.-]*:\/\/|\b(?:javascript|vbscript|data|file|blob|about):|www\.|<|>|\burl\s*\(|\.\.[\\/]|[a-z]:\\|\\\\|\/\/|\bon[a-z]+\s*=|\bimport\s*\(|\beval\s*\()/i;

export const isSpecLayerKind = (v: unknown): v is SpecLayerKind => typeof v === 'string' && (SPEC_LAYER_KINDS as readonly string[]).includes(v);
export const isPaletteName = (v: unknown): v is SpecPaletteName => typeof v === 'string' && Object.prototype.hasOwnProperty.call(SPEC_PALETTE, v);
export const looksUnsafe = (s: string): boolean => UNSAFE_RE.test(s);

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const shortKey = (k: string): string => k.replace(/[^\w$-]/g, '?').slice(0, 40);

function checkString(path: string, value: string, errors: SpecError[]): boolean {
  if (looksUnsafe(value)) {
    errors.push({ path, message: 'Must not contain URLs, file paths, markup or script.' });
    return false;
  }
  return true;
}

const defaultLayer = (kind: SpecLayerKind): SceneSpecLayer => ({
  kind,
  count: SPEC_LIMITS.count.fallback,
  speed: SPEC_LIMITS.speed.fallback,
  opacity: SPEC_LIMITS.opacity.fallback,
  seed: SPEC_LIMITS.seed.fallback,
  hue: SPEC_LIMITS.hue.fallback,
});

/**
 * Strict validation. Unknown keys, wrong types, unsafe strings and out-of-range values are all rejected
 * with an exact path (for example `layers[2].opacity`). Optional fields that are absent are filled with
 * defaults so the returned spec is always complete. Only `version` and `layers` (each with `kind`) are required.
 */
export function validateSceneSpec(input: unknown): SpecValidation {
  const errors: SpecError[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: [{ path: '$', message: `Scene spec must be an object, got ${describe(input)}.` }] };
  for (const key of Object.keys(input)) {
    if (!TOP_KEYS.includes(key)) errors.push({ path: shortKey(key), message: `Unknown key "${shortKey(key)}". Allowed: ${TOP_KEYS.join(', ')}.` });
  }

  if (input.version !== SCENE_SPEC_VERSION) errors.push({ path: 'version', message: `Must be ${SCENE_SPEC_VERSION}.` });

  let name = DEFAULT_SPEC_NAME;
  const rawName = input.name;
  if (rawName !== undefined) {
    if (typeof rawName !== 'string') errors.push({ path: 'name', message: `Must be a string, got ${describe(rawName)}.` });
    else if (checkString('name', rawName, errors)) {
      const trimmed = rawName.trim();
      if (!trimmed) errors.push({ path: 'name', message: 'Must not be empty.' });
      else if (trimmed.length > MAX_SPEC_NAME) errors.push({ path: 'name', message: `Must be at most ${MAX_SPEC_NAME} characters.` });
      else if (!NAME_RE.test(trimmed)) errors.push({ path: 'name', message: "May only contain letters, digits, spaces and . , ' ! ? & ( ) _ -" });
      else name = trimmed;
    }
  }

  let durationMs: number = SPEC_LIMITS.durationMs.fallback;
  const d = input.durationMs;
  if (d !== undefined) {
    if (typeof d !== 'number' || !Number.isInteger(d)) errors.push({ path: 'durationMs', message: 'Must be a whole number of milliseconds.' });
    else if (d < SPEC_LIMITS.durationMs.min || d > SPEC_LIMITS.durationMs.max) errors.push({ path: 'durationMs', message: `Must be between ${SPEC_LIMITS.durationMs.min} and ${SPEC_LIMITS.durationMs.max}, got ${d}.` });
    else durationMs = d;
  }

  let loop = true;
  const rawLoop = input.loop;
  if (rawLoop !== undefined) {
    if (typeof rawLoop !== 'boolean') errors.push({ path: 'loop', message: `Must be true or false, got ${describe(rawLoop)}.` });
    else loop = rawLoop;
  }

  let background: SpecBackground = DEFAULT_BACKGROUND;
  const b = input.background;
  if (b !== undefined) {
    if (typeof b !== 'string') errors.push({ path: 'background', message: `Must be a palette name or #rrggbb, got ${describe(b)}.` });
    else if (checkString('background', b, errors)) {
      if (isPaletteName(b)) background = b;
      else if (HEX_RE.test(b)) background = b.toLowerCase() as SpecBackground;
      else errors.push({ path: 'background', message: `Must be one of ${Object.keys(SPEC_PALETTE).join(', ')} or #rrggbb.` });
    }
  }

  const layers: SceneSpecLayer[] = [];
  const rawLayers = input.layers;
  if (!Array.isArray(rawLayers)) errors.push({ path: 'layers', message: `Must be an array of 1 to ${MAX_SPEC_LAYERS} layers.` });
  else if (rawLayers.length === 0) errors.push({ path: 'layers', message: 'Needs at least one layer.' });
  else if (rawLayers.length > MAX_SPEC_LAYERS) errors.push({ path: 'layers', message: `At most ${MAX_SPEC_LAYERS} layers are allowed, got ${rawLayers.length}.` });
  else {
    rawLayers.forEach((item: unknown, i: number) => {
      const base = `layers[${i}]`;
      if (!isPlainObject(item)) {
        errors.push({ path: base, message: `Must be an object, got ${describe(item)}.` });
        return;
      }
      for (const key of Object.keys(item)) {
        if (!LAYER_KEYS.includes(key)) errors.push({ path: `${base}.${shortKey(key)}`, message: `Unknown key "${shortKey(key)}". Allowed: ${LAYER_KEYS.join(', ')}.` });
      }
      let kind: SpecLayerKind | null = null;
      const rawKind = item.kind;
      if (typeof rawKind !== 'string') errors.push({ path: `${base}.kind`, message: `Must be one of ${SPEC_LAYER_KINDS.join(', ')}.` });
      else if (checkString(`${base}.kind`, rawKind, errors)) {
        if (isSpecLayerKind(rawKind)) kind = rawKind;
        else errors.push({ path: `${base}.kind`, message: `Must be one of ${SPEC_LAYER_KINDS.join(', ')}.` });
      }
      const layer = defaultLayer(kind ?? 'stars');
      for (const key of NUM_KEYS) {
        const lim = SPEC_LIMITS[key];
        const v = item[key];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ path: `${base}.${key}`, message: `Must be a number, got ${describe(v)}.` });
        else if (INT_KEYS.has(key) && !Number.isInteger(v)) errors.push({ path: `${base}.${key}`, message: 'Must be a whole number.' });
        else if (v < lim.min || v > lim.max) errors.push({ path: `${base}.${key}`, message: `Must be between ${lim.min} and ${lim.max}, got ${v}.` });
        else layer[key] = v;
      }
      if (kind) layers.push(layer);
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, spec: { version: SCENE_SPEC_VERSION, name, durationMs, loop, background, layers } };
}

const clampNum = (v: unknown, lo: number, hi: number, fallback: number, int: boolean): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n)) return fallback;
  const c = Math.min(hi, Math.max(lo, n));
  return int ? Math.round(c) : Math.round(c * 100) / 100;
};

/** Reduce any string to an allowed name, or the default when nothing safe is left. */
export function sanitizeSpecName(v: unknown): string {
  if (typeof v !== 'string' || looksUnsafe(v)) return DEFAULT_SPEC_NAME;
  const cleaned = Array.from(v)
    .filter((ch) => NAME_RE.test(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SPEC_NAME)
    .trim();
  return cleaned || DEFAULT_SPEC_NAME;
}

/**
 * Lenient repair: clamps numbers into range, fills defaults, drops unknown keys and layers of unknown kind,
 * replaces unsafe strings with defaults and caps the layer count. The result always passes validateSceneSpec.
 */
export function normalizeSceneSpec(input: unknown): SceneSpec {
  const o = isPlainObject(input) ? input : {};
  const rawLayers: unknown[] = Array.isArray(o.layers) ? o.layers : [];
  const layers: SceneSpecLayer[] = [];
  for (const item of rawLayers) {
    if (layers.length >= MAX_SPEC_LAYERS) break;
    if (!isPlainObject(item)) continue;
    const kind = item.kind;
    if (!isSpecLayerKind(kind)) continue;
    const l = defaultLayer(kind);
    for (const key of NUM_KEYS) {
      const lim = SPEC_LIMITS[key];
      l[key] = clampNum(item[key], lim.min, lim.max, lim.fallback, INT_KEYS.has(key));
    }
    layers.push(l);
  }
  if (layers.length === 0) layers.push(defaultLayer('stars'));
  const bg = typeof o.background === 'string' && !looksUnsafe(o.background) ? o.background : '';
  const background: SpecBackground = isPaletteName(bg) ? bg : HEX_RE.test(bg) ? (bg.toLowerCase() as SpecBackground) : DEFAULT_BACKGROUND;
  return {
    version: SCENE_SPEC_VERSION,
    name: sanitizeSpecName(o.name),
    durationMs: clampNum(o.durationMs, SPEC_LIMITS.durationMs.min, SPEC_LIMITS.durationMs.max, SPEC_LIMITS.durationMs.fallback, true),
    loop: typeof o.loop === 'boolean' ? o.loop : true,
    background,
    layers,
  };
}

/** Stable JSON for display and export; key order is fixed. */
export function serializeSceneSpec(spec: SceneSpec): string {
  return JSON.stringify(
    {
      version: spec.version,
      name: spec.name,
      durationMs: spec.durationMs,
      loop: spec.loop,
      background: spec.background,
      layers: spec.layers.map((l) => ({ kind: l.kind, count: l.count, speed: l.speed, opacity: l.opacity, seed: l.seed, hue: l.hue })),
    },
    null,
    2,
  );
}

/* ---------- offline keyword composer ---------- */

type Draft = { speed: number; count: number; hue: number | null; background: SpecPaletteName | null; durationMs: number; loop: boolean; kinds: SpecLayerKind[] };
type KeywordRule = { words: readonly string[]; label: string; apply: (d: Draft) => void };

const addKind = (d: Draft, k: SpecLayerKind): void => {
  if (!d.kinds.includes(k)) d.kinds.push(k);
};

/** Ordered rule table. Order is fixed, so the same text always produces the same spec and explanation. */
export const COMPOSER_RULES: readonly KeywordRule[] = [
  { words: ['calm', 'slow', 'gentle', 'quiet', 'relaxed', 'peaceful'], label: 'slow, calm motion', apply: (d) => { d.speed = 18; } },
  { words: ['fast', 'energetic', 'rapid', 'busy', 'lively', 'quick'], label: 'fast motion', apply: (d) => { d.speed = 80; } },
  { words: ['warm', 'amber', 'sunset', 'orange', 'gold', 'golden'], label: 'warm amber palette', apply: (d) => { d.hue = 28; d.background = 'ember'; } },
  { words: ['cool', 'cold', 'blue', 'ice', 'icy', 'ocean', 'sea'], label: 'cool blue palette', apply: (d) => { d.hue = 205; d.background = 'ocean'; } },
  { words: ['violet', 'purple', 'magenta', 'twilight'], label: 'violet palette', apply: (d) => { d.hue = 270; d.background = 'dusk'; } },
  { words: ['green', 'forest', 'emerald', 'jade'], label: 'green palette', apply: (d) => { d.hue = 140; d.background = 'forest'; } },
  { words: ['dense', 'many', 'lots', 'crowded', 'rich'], label: 'dense layers', apply: (d) => { d.count = 300; } },
  { words: ['sparse', 'minimal', 'few', 'simple', 'subtle'], label: 'sparse layers', apply: (d) => { d.count = 40; } },
  { words: ['short', 'brief'], label: 'short 3 s loop', apply: (d) => { d.durationMs = 3000; } },
  { words: ['long', 'extended'], label: 'long 20 s loop', apply: (d) => { d.durationMs = 20000; } },
  { words: ['once', 'oneshot'], label: 'play once', apply: (d) => { d.loop = false; } },
  { words: ['stars', 'star', 'space', 'night', 'galaxy', 'cosmic'], label: 'star field layer', apply: (d) => addKind(d, 'stars') },
  { words: ['rings', 'ring', 'orbit', 'orbits', 'planet'], label: 'orbit rings layer', apply: (d) => addKind(d, 'rings') },
  { words: ['aurora', 'ribbons', 'ribbon', 'waves', 'wave', 'northern'], label: 'aurora ribbons layer', apply: (d) => { addKind(d, 'ribbons'); if (d.hue === null) d.hue = 160; } },
  { words: ['grid', 'horizon', 'retro', 'synthwave'], label: 'horizon grid layer', apply: (d) => addKind(d, 'grid') },
  { words: ['ridges', 'ridge', 'mountains', 'mountain', 'hills', 'dusk'], label: 'ridgeline layer', apply: (d) => addKind(d, 'ridges') },
  { words: ['particles', 'dust', 'embers', 'sparkle', 'sparkles', 'fireflies', 'snow'], label: 'particle layer', apply: (d) => addKind(d, 'particles') },
];

/** Which built-in procedural scene (src/ui/scenes.ts) each spec kind corresponds to. */
export const KIND_TO_SCENE: Record<SpecLayerKind, string> = {
  stars: 'deep-space',
  rings: 'orbit',
  ribbons: 'aurora',
  grid: 'horizon',
  ridges: 'dusk',
  particles: 'deep-space',
};

/** FNV-1a; deterministic seed from text. */
function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type ComposeMatch = { word: string; meaning: string };
export type ComposeResult = { spec: SceneSpec; matched: ComposeMatch[]; explanation: string };

/**
 * Deterministic OFFLINE composer. Matches a fixed keyword table against the description and builds a spec
 * that is then run through validateSceneSpec. No model, network or randomness is involved: the seed comes
 * from a hash of the normalized description.
 */
export function sceneSpecFromText(text: string): ComposeResult {
  const clean = (typeof text === 'string' ? text : '').slice(0, MAX_DESCRIPTION_CHARS).toLowerCase();
  const words = clean.match(/[a-z]+/g) ?? [];
  const wordSet = new Set(words);
  const draft: Draft = { speed: SPEC_LIMITS.speed.fallback, count: SPEC_LIMITS.count.fallback, hue: null, background: null, durationMs: SPEC_LIMITS.durationMs.fallback, loop: true, kinds: [] };
  const matched: ComposeMatch[] = [];
  for (const rule of COMPOSER_RULES) {
    const hit = rule.words.find((w) => wordSet.has(w));
    if (!hit) continue;
    rule.apply(draft);
    matched.push({ word: hit, meaning: rule.label });
  }
  const usedDefaultKind = draft.kinds.length === 0;
  if (usedDefaultKind) draft.kinds.push('stars');
  const hue = draft.hue ?? SPEC_LIMITS.hue.fallback;
  const baseSeed = (hashText(words.join(' ')) % (SPEC_LIMITS.seed.max - 1)) + 1;
  const layers: SceneSpecLayer[] = draft.kinds.slice(0, MAX_SPEC_LAYERS).map((kind, i) => ({
    kind,
    count: i === 0 ? draft.count : Math.round(draft.count * 0.5),
    speed: draft.speed,
    opacity: i === 0 ? 100 : 60,
    seed: (baseSeed + i * 7919) % SPEC_LIMITS.seed.max || 1,
    hue: (hue + i * 24) % 361,
  }));
  const primaryScene = SCENES.find((s) => s.id === KIND_TO_SCENE[layers[0].kind]);
  const name = sanitizeSpecName(`${primaryScene?.name ?? 'Composed'} composition`);
  const candidate = { version: SCENE_SPEC_VERSION, name, durationMs: draft.durationMs, loop: draft.loop, background: draft.background ?? DEFAULT_BACKGROUND, layers };
  const checked = validateSceneSpec(candidate);
  const spec = checked.ok ? checked.spec : normalizeSceneSpec(candidate);
  const parts = matched.map((m) => `"${m.word}" → ${m.meaning}`);
  const explanation = matched.length
    ? `Matched ${matched.length} keyword${matched.length === 1 ? '' : 's'}: ${parts.join('; ')}.${usedDefaultKind ? ' No layer keyword matched, so a star field was used.' : ''}`
    : 'No known keywords matched; using a default star field. Try words like calm, fast, warm, cool, stars, rings, aurora, grid, ridges or particles.';
  return { spec, matched, explanation };
}

/* ---------- model output ---------- */

/** Index of the brace closing the object that opens at `start`, honouring strings and escapes; -1 if unbalanced. */
function balancedEnd(raw: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** At most this many opening braces are tried, which bounds the work on hostile input. */
const MAX_JSON_CANDIDATES = 64;

/**
 * The first balanced `{...}` block in free text that parses as a JSON object. When no block parses, the first
 * balanced block is returned anyway so the caller can report it as malformed. Null when there is none.
 */
export function extractFirstJsonObject(raw: string): string | null {
  let firstBalanced: string | null = null;
  let tries = 0;
  for (let s = raw.indexOf('{'); s >= 0 && tries < MAX_JSON_CANDIDATES; s = raw.indexOf('{', s + 1), tries++) {
    const end = balancedEnd(raw, s);
    if (end < 0) continue;
    const block = raw.slice(s, end + 1);
    if (firstBalanced === null) firstBalanced = block;
    try {
      if (isPlainObject(JSON.parse(block))) return block;
    } catch {
      /* try the next opening brace */
    }
  }
  return firstBalanced;
}

/**
 * Parse a model reply (often prose around a JSON block) into a validated spec. Never throws: oversized input,
 * missing JSON, malformed JSON and schema violations all come back as errors with paths.
 */
export function parseModelSceneJson(raw: string): SpecValidation {
  try {
    if (typeof raw !== 'string') return { ok: false, errors: [{ path: '$', message: 'Model output must be text.' }] };
    if (raw.length > MAX_SPEC_TEXT_BYTES) return { ok: false, errors: [{ path: '$', message: `Model output is larger than ${MAX_SPEC_TEXT_BYTES / 1024} KB.` }] };
    const block = extractFirstJsonObject(raw);
    if (!block) return { ok: false, errors: [{ path: '$', message: 'No complete JSON object found in the model output.' }] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch (e) {
      return { ok: false, errors: [{ path: '$', message: `Malformed JSON: ${e instanceof Error ? e.message.slice(0, 120) : 'parse error'}` }] };
    }
    return validateSceneSpec(parsed);
  } catch {
    return { ok: false, errors: [{ path: '$', message: 'Model output could not be read.' }] };
  }
}

/* ---------- mapping to renderable studio params ---------- */

/** Spec kinds → Motion Studio preset kinds (src/ui/motion-presets.ts). */
export const KIND_TO_MOTION: Record<SpecLayerKind, MotionKind> = {
  stars: 'particles',
  rings: 'orbit',
  ribbons: 'aurora',
  grid: 'lattice',
  ridges: 'wave',
  particles: 'particles',
};

/** Hue (0..360) of a #rrggbb colour; grey falls back to 220. */
export function hexToHue(hex: string): number {
  if (!HEX_RE.test(hex)) return 220;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 220;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((((h * 60) % 360) + 360) % 360);
}

export const backgroundHex = (bg: SpecBackground): string => (isPaletteName(bg) ? SPEC_PALETTE[bg] : bg);

export type RenderablePlan = { scene: MotionScene; sceneId: string; durationMs: number; loop: boolean; starField: string | null; notes: string[] };

/**
 * Map a validated spec onto the Motion Studio scene model. Only a spec that passed validateSceneSpec should be
 * passed in; the values are clamped once more through normalizeLayer regardless. The studio renders at most
 * MAX_LAYERS layers, so extra layers are reported in `notes` rather than silently dropped. `sceneId` names the
 * matching built-in CSS scene and `starField` reuses the deterministic starShadow convention for star layers.
 */
export function specToMotionScene(spec: SceneSpec): RenderablePlan {
  const notes: string[] = [];
  const used = spec.layers.slice(0, MAX_LAYERS);
  if (spec.layers.length > MAX_LAYERS) notes.push(`The studio renders ${MAX_LAYERS} layers; ${spec.layers.length - MAX_LAYERS} more were not applied.`);
  const layers: MotionLayer[] = used.map((l, i) =>
    normalizeLayer(
      { kind: KIND_TO_MOTION[l.kind], intensity: Math.round((l.count / SPEC_LIMITS.count.max) * 100), speed: l.speed, hue: Math.round(l.hue), opacity: Math.round(l.opacity), seed: l.seed },
      makeLayerId(i + 1),
    ),
  );
  const stars = spec.layers.find((l) => l.kind === 'stars');
  return {
    scene: { version: SCENE_VERSION, name: spec.name.slice(0, MAX_SPEC_NAME), background: hexToHue(backgroundHex(spec.background)), layers },
    sceneId: KIND_TO_SCENE[spec.layers[0]?.kind ?? 'stars'],
    durationMs: spec.durationMs,
    loop: spec.loop,
    starField: stars ? starShadow(Math.min(200, stars.count), stars.seed) : null,
    notes,
  };
}

/** Compact schema description for a model prompt. The validator is the contract; this is only a hint. */
export const SCENE_SPEC_SCHEMA_HINT = `{"version":1,"name":"plain text, max ${MAX_SPEC_NAME}","durationMs":${SPEC_LIMITS.durationMs.min}-${SPEC_LIMITS.durationMs.max},"loop":true|false,"background":"${Object.keys(SPEC_PALETTE).join('|')}|#rrggbb","layers":[{"kind":"${SPEC_LAYER_KINDS.join('|')}","count":0-400,"speed":0-100,"opacity":0-100,"seed":1-1000000,"hue":0-360}]} with 1 to ${MAX_SPEC_LAYERS} layers; no other keys`;
