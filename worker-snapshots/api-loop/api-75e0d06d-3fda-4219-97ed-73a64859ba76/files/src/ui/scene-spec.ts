/**
 * Validated scene spec (roadmap feature 139 groundwork).
 *
 * A SceneSpec is a small, strictly typed description of a motion scene that a person or a local model can
 * write as JSON. Nothing here draws: a valid spec is mapped onto an existing built-in Motion Studio scene
 * template id (sceneSpecToPresetId) so the preview reuses the current, already-audited renderer.
 *
 * Pure and DOM-free: every function is deterministic, side-effect free and never throws for any input.
 */

export const SCENE_SPEC_VERSION = 1 as const;
export const SPEC_LAYER_KINDS = ['stars', 'rings', 'ribbons', 'grid', 'ridge', 'particles'] as const;
export const SPEC_EASINGS = ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'in-out-sine'] as const;
export const SPEC_REDUCED_MODES = ['still', 'fade'] as const;
export const SPEC_LIMITS = {
  maxName: 60,
  maxBlurb: 200,
  maxId: 48,
  minLayers: 1,
  maxLayers: 8,
  minDurationMs: 200,
  maxDurationMs: 60_000,
  minCount: 1,
  maxCount: 400,
  maxTextBytes: 16 * 1024,
} as const;

export type SpecLayerKind = (typeof SPEC_LAYER_KINDS)[number];
export type SpecEasing = (typeof SPEC_EASINGS)[number];
export type SpecReducedMode = (typeof SPEC_REDUCED_MODES)[number];

export type SceneSpecLayer = {
  kind: SpecLayerKind;
  /** #rrggbb */
  color: string;
  /** Optional second colour, #rrggbb. */
  accent?: string;
  /** 200..60000, integer milliseconds per motion cycle. */
  durationMs: number;
  easing: SpecEasing;
  /** 1..400 integer element count. */
  count: number;
};

export type SceneSpecReducedMotion = {
  /** 'still' shows one frame; 'fade' allows only a slow opacity change. */
  mode: SpecReducedMode;
  /** Optional plain-text description of the still frame. */
  description?: string;
};

export type SceneSpec = {
  version: typeof SCENE_SPEC_VERSION;
  id: string;
  name: string;
  blurb?: string;
  /** #rrggbb */
  background: string;
  layers: SceneSpecLayer[];
  reducedMotion: SceneSpecReducedMotion;
};

export type SceneSpecError = { path: string; message: string };
export type SceneSpecResult = { ok: true; spec: SceneSpec } | { ok: false; errors: SceneSpecError[] };

/** Existing built-in Motion Studio scene templates (SCENE_TEMPLATES ids in src/ui/motion-presets.ts). */
export type SpecPresetId = 'builtin:tide' | 'builtin:ember' | 'builtin:deep-orbit' | 'builtin:aurora-stack';

const KIND_TO_PRESET: Record<SpecLayerKind, SpecPresetId> = {
  stars: 'builtin:ember',
  particles: 'builtin:ember',
  rings: 'builtin:deep-orbit',
  ribbons: 'builtin:tide',
  ridge: 'builtin:aurora-stack',
  grid: 'builtin:aurora-stack',
};

const HEX_RE = /^#[0-9a-f]{6}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ownGet = (o: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const describe = (v: unknown): string => {
  if (v === undefined) return 'missing';
  if (v === null) return 'null';
  if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return Array.isArray(v) ? 'an array' : `a ${typeof v}`;
};

function checkText(v: unknown, path: string, max: number, errors: SceneSpecError[], required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string') {
    errors.push({ path, message: `Expected text, got ${describe(v)}.` });
    return undefined;
  }
  const text = v.trim();
  if (required && text.length === 0) {
    errors.push({ path, message: 'Must not be empty.' });
    return undefined;
  }
  if (text.length > max) {
    errors.push({ path, message: `Must be at most ${max} characters (got ${text.length}).` });
    return undefined;
  }
  if (CONTROL_RE.test(text)) {
    errors.push({ path, message: 'Must not contain control characters.' });
    return undefined;
  }
  return text;
}

function checkHex(v: unknown, path: string, errors: SceneSpecError[], required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !HEX_RE.test(v)) {
    errors.push({ path, message: `Expected a #rrggbb hex colour, got ${describe(v)}.` });
    return undefined;
  }
  return v.toLowerCase();
}

function checkInt(v: unknown, path: string, min: number, max: number, errors: SceneSpecError[]): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    errors.push({ path, message: `Expected a whole number from ${min} to ${max}, got ${describe(v)}.` });
    return undefined;
  }
  return v;
}

function checkLayer(item: unknown, i: number, errors: SceneSpecError[]): SceneSpecLayer | undefined {
  const base = `layers[${i}]`;
  if (!isRecord(item)) {
    errors.push({ path: base, message: `Expected a layer object, got ${describe(item)}.` });
    return undefined;
  }
  const before = errors.length;
  const kindRaw = ownGet(item, 'kind');
  if (!oneOf(SPEC_LAYER_KINDS, kindRaw)) errors.push({ path: `${base}.kind`, message: `Unknown kind ${describe(kindRaw)}. Allowed: ${SPEC_LAYER_KINDS.join(', ')}.` });
  const color = checkHex(ownGet(item, 'color'), `${base}.color`, errors, true);
  const accent = checkHex(ownGet(item, 'accent'), `${base}.accent`, errors, false);
  const durationMs = checkInt(ownGet(item, 'durationMs'), `${base}.durationMs`, SPEC_LIMITS.minDurationMs, SPEC_LIMITS.maxDurationMs, errors);
  const easingRaw = ownGet(item, 'easing');
  if (!oneOf(SPEC_EASINGS, easingRaw)) errors.push({ path: `${base}.easing`, message: `Unknown easing ${describe(easingRaw)}. Allowed: ${SPEC_EASINGS.join(', ')}.` });
  const count = checkInt(ownGet(item, 'count'), `${base}.count`, SPEC_LIMITS.minCount, SPEC_LIMITS.maxCount, errors);
  if (errors.length > before) return undefined;
  const layer: SceneSpecLayer = { kind: kindRaw as SpecLayerKind, color: color!, durationMs: durationMs!, easing: easingRaw as SpecEasing, count: count! };
  if (accent !== undefined) layer.accent = accent;
  return layer;
}

/** Strict validator. Returns one error per failing field and never throws. Unknown keys are dropped. */
export function validateSceneSpec(input: unknown): SceneSpecResult {
  const errors: SceneSpecError[] = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: '$', message: `Scene spec must be a JSON object, got ${describe(input)}.` }] };

  const version = ownGet(input, 'version');
  if (version !== SCENE_SPEC_VERSION) errors.push({ path: 'version', message: `Unsupported version ${describe(version)}; this build reads version ${SCENE_SPEC_VERSION}.` });

  const idRaw = ownGet(input, 'id');
  let id: string | undefined;
  if (typeof idRaw !== 'string' || idRaw.length > SPEC_LIMITS.maxId || !SLUG_RE.test(idRaw)) errors.push({ path: 'id', message: `Expected a lowercase slug (a-z, 0-9, single hyphens, up to ${SPEC_LIMITS.maxId} characters), got ${describe(idRaw)}.` });
  else id = idRaw;

  const name = checkText(ownGet(input, 'name'), 'name', SPEC_LIMITS.maxName, errors, true);
  const blurb = checkText(ownGet(input, 'blurb'), 'blurb', SPEC_LIMITS.maxBlurb, errors, false);
  const background = checkHex(ownGet(input, 'background'), 'background', errors, true);

  const layersRaw = ownGet(input, 'layers');
  const layers: SceneSpecLayer[] = [];
  if (!Array.isArray(layersRaw)) errors.push({ path: 'layers', message: `Expected an array of ${SPEC_LIMITS.minLayers} to ${SPEC_LIMITS.maxLayers} layers, got ${describe(layersRaw)}.` });
  else if (layersRaw.length < SPEC_LIMITS.minLayers || layersRaw.length > SPEC_LIMITS.maxLayers) errors.push({ path: 'layers', message: `Expected ${SPEC_LIMITS.minLayers} to ${SPEC_LIMITS.maxLayers} layers, got ${layersRaw.length}.` });
  else layersRaw.forEach((item, i) => { const layer = checkLayer(item, i, errors); if (layer) layers.push(layer); });

  const rmRaw = ownGet(input, 'reducedMotion');
  let reducedMotion: SceneSpecReducedMotion | undefined;
  if (!isRecord(rmRaw)) errors.push({ path: 'reducedMotion', message: `A reduced-motion fallback object is required, got ${describe(rmRaw)}.` });
  else {
    const mode = ownGet(rmRaw, 'mode');
    const description = checkText(ownGet(rmRaw, 'description'), 'reducedMotion.description', SPEC_LIMITS.maxBlurb, errors, false);
    if (!oneOf(SPEC_REDUCED_MODES, mode)) errors.push({ path: 'reducedMotion.mode', message: `Unknown mode ${describe(mode)}. Allowed: ${SPEC_REDUCED_MODES.join(', ')}.` });
    else {
      reducedMotion = { mode };
      if (description !== undefined) reducedMotion.description = description;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const spec: SceneSpec = { version: SCENE_SPEC_VERSION, id: id!, name: name!, background: background!, layers, reducedMotion: reducedMotion! };
  if (blurb !== undefined && blurb.length > 0) spec.blurb = blurb;
  return { ok: true, spec };
}

/** Returns the body of the first Markdown code fence (``` or ```json), or the trimmed text when there is none. */
export function stripCodeFences(text: string): string {
  const fenced = /```[ \t]*[a-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

/** Strips code fences, parses JSON without throwing and validates. A parse failure is an error, never an exception. */
export function sceneSpecFromText(text: string): SceneSpecResult {
  if (typeof text !== 'string') return { ok: false, errors: [{ path: '$', message: 'Expected text.' }] };
  if (text.length > SPEC_LIMITS.maxTextBytes) return { ok: false, errors: [{ path: '$', message: `Text is longer than ${SPEC_LIMITS.maxTextBytes / 1024} KB.` }] };
  const body = stripCodeFences(text);
  if (!body) return { ok: false, errors: [{ path: '$', message: 'Parse error: no JSON found.' }] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, errors: [{ path: '$', message: 'Parse error: the text is not valid JSON.' }] };
  }
  return validateSceneSpec(parsed);
}

/**
 * Maps a valid spec onto an existing built-in scene template id. The dominant layer (highest count, first on a
 * tie) picks the template, so the preview reuses current rendering only.
 */
export function sceneSpecToPresetId(spec: SceneSpec): SpecPresetId {
  let dominant = spec.layers[0];
  for (const layer of spec.layers) if (layer.count > dominant.count) dominant = layer;
  return KIND_TO_PRESET[dominant.kind];
}

/** A valid sample used as the textarea placeholder and in tests. */
export const SCENE_SPEC_SAMPLE: SceneSpec = {
  version: 1,
  id: 'night-tide',
  name: 'Night tide',
  blurb: 'Slow ribbons under a few stars.',
  background: '#0b1626',
  layers: [
    { kind: 'ribbons', color: '#3a7bd5', durationMs: 8000, easing: 'in-out-sine', count: 4 },
    { kind: 'stars', color: '#f5f7ff', accent: '#9fb8ff', durationMs: 12000, easing: 'linear', count: 3 },
  ],
  reducedMotion: { mode: 'still', description: 'Calm blue ribbons with faint stars.' },
};
