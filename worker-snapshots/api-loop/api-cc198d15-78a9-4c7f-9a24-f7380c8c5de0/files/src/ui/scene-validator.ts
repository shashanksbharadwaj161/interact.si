/**
 * Strict validator for Motion Studio scene specifications (roadmap feature 139).
 *
 * Input is untrusted: text pasted by the user or produced by a local model. The validator only ever calls
 * JSON.parse on text; it never evaluates, imports or fetches anything. Unlike the forgiving import path
 * (parseScene in motion-presets.ts, which clamps and drops), this validator rejects any spec that is not
 * exactly inside the whitelist, and reports every problem with a precise path such as `$.layers[1].hue`.
 *
 * Two document shapes are accepted, both already used by Motion Studio:
 *  - a scene:      {"version":1,"name","background","layers":[...]}
 *  - a lab doc:    {"version":1,"type":"motion-lab","scene":{...},"timeline":{...},"tracks":[...],"quality"}
 *
 * Pure and DOM-free so it can be unit tested in Node.
 */

import {
  ALL_MOTION_KINDS,
  LAB_VERSION,
  MAX_LAB_BYTES,
  MAX_LAYERS,
  MAX_PRESET_NAME,
  MAX_TRACKS,
  SCENE_SCHEMA_HINT,
  SCENE_VERSION,
  TRACK_PARAMS,
  isMotionKind,
  isTrackParam,
  trackParam,
  type MotionLab,
  type MotionLayer,
  type MotionScene,
  type Track,
} from './motion-presets';
import {
  BEZIER_Y_LIMIT,
  EASING_LIST,
  MAX_KEYS,
  SPRING_LIMITS,
  TIMELINE_FPS,
  TIMELINE_LIMITS,
  isEasingName,
  isQualityId,
  type Ease,
  type Keyframe,
  type QualityId,
  type Timeline,
  type TimelineFps,
} from './motion-timing';

/* ---------- limits ---------- */

/** Largest accepted text, in UTF-8 bytes. */
export const MAX_SPEC_BYTES = MAX_LAB_BYTES;
/** Upper bound on JSON values (objects, arrays, strings, numbers...) in one spec. */
export const MAX_SPEC_NODES = 2000;
/** Deepest nesting a valid lab document needs is 6 (lab > tracks > track > keys > key > ease); allow a little slack. */
export const MAX_SPEC_DEPTH = 8;
/** Longest string anywhere in a spec. Names are shorter still. */
export const MAX_SPEC_STRING = 200;
/** Issues listed before the rest are summarised. */
export const MAX_ISSUES = 40;
/** Longest scene description a user may send to the local model. */
export const MAX_COMPOSE_REQUEST = 300;

export const LAYER_RANGES = {
  intensity: { min: 0, max: 100 },
  speed: { min: 0, max: 100 },
  hue: { min: 0, max: 360 },
  opacity: { min: 0, max: 100 },
  seed: { min: 1, max: 1_000_000 },
} as const;

/** Whitelisted keys per object. Anything else is rejected, including `__proto__` and `constructor`. */
export const SCENE_KEYS = ['version', 'id', 'name', 'background', 'layers'] as const;
export const LAYER_KEYS = ['id', 'kind', 'intensity', 'speed', 'hue', 'opacity', 'seed'] as const;
export const LAB_KEYS = ['version', 'type', 'scene', 'timeline', 'tracks', 'quality'] as const;
export const TIMELINE_KEYS = ['fps', 'frames', 'loop', 'poster'] as const;
export const TRACK_KEYS = ['layer', 'param', 'keys'] as const;
export const KEY_KEYS = ['frame', 'value', 'ease'] as const;

const ID_RE = /^[a-z0-9:_-]{1,48}$/i;
const has = (o: Record<string, unknown>, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/* ---------- result types ---------- */

export type SpecIssue = { path: string; message: string };
export type SpecValidation =
  | { ok: true; scene: MotionScene; lab: MotionLab | null; issues: [] }
  | { ok: false; scene: null; lab: null; issues: SpecIssue[] };

export const formatIssue = (i: SpecIssue): string => `${i.path}: ${i.message}`;

/* ---------- string screening ---------- */

// Written as patterns so this source never contains a literal URL.
const URL_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,20}:\/\//i, // any scheme://
  /\/\/[a-z0-9-]+\.[a-z]/i, // protocol-relative //host.tld
  /\bwww\.[a-z0-9-]+\./i,
  /\b(?:javascript|vbscript|data|file|blob|mailto)\s*:/i,
  /\burl\s*\(/i,
  /@import\b/i,
  /\.(?:png|jpe?g|gif|webp|svg|mp4|webm|mp3|wav|ogg|glb|gltf|obj|fbx|js|mjs|css|html?|json|wasm)(?:[?#\s]|$)/i,
  /^(?:[a-z]:)?[\\/]/i, // absolute or drive path
  /\.\.[\\/]/,
];

const SCRIPT_PATTERNS: readonly RegExp[] = [
  /<\s*\/?\s*[a-z!?]/i, // any markup tag, including <script and <!--
  /\bon[a-z]+\s*=/i, // inline event handlers
  /\b(?:eval|Function|setTimeout|setInterval|require|import|fetch|XMLHttpRequest|WebSocket)\s*\(/,
  /\bimport\s+[\w{*]/,
  /\$\{/, // template interpolation
  /=>/,
  /\b(?:document|window|globalThis|process|constructor|__proto__|prototype)\s*[.[]/,
  /&#x?[0-9a-f]+;?/i, // encoded characters used to smuggle markup
  /\\u[0-9a-f]{4}|\\x[0-9a-f]{2}/i,
];

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** Reason a string is unsafe for a spec, or null when it is plain text. */
export function unsafeStringReason(s: string): string | null {
  if (s.length > MAX_SPEC_STRING) return `is longer than ${MAX_SPEC_STRING} characters`;
  if (CONTROL_RE.test(s)) return 'contains control or bidirectional formatting characters';
  if (URL_PATTERNS.some((re) => re.test(s))) return 'looks like a URL, file path or external asset reference, which scenes may not contain';
  if (SCRIPT_PATTERNS.some((re) => re.test(s))) return 'looks like markup or script, which scenes may not contain';
  return null;
}

/* ---------- helpers ---------- */

const quote = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'a list';
  return typeof v === 'object' ? 'an object' : typeof v;
};

const keyPath = (base: string, key: string): string => (/^[a-z_][a-z0-9_]*$/i.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key.slice(0, 40))}]`);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

class Issues {
  readonly list: SpecIssue[] = [];
  private dropped = 0;
  add(path: string, message: string) {
    if (this.list.length < MAX_ISSUES) this.list.push({ path, message });
    else this.dropped++;
  }
  get count() {
    return this.list.length + this.dropped;
  }
  finish(): SpecIssue[] {
    return this.dropped > 0 ? [...this.list, { path: '$', message: `${this.dropped} more issue${this.dropped === 1 ? '' : 's'} not listed.` }] : [...this.list];
  }
}

/** Generic structural pass: node budget, depth, finite numbers and safe strings everywhere (also inside unknown keys). */
function screen(value: unknown, path: string, depth: number, budget: { nodes: number }, issues: Issues): void {
  budget.nodes++;
  if (budget.nodes === MAX_SPEC_NODES + 1) issues.add('$', `has more than ${MAX_SPEC_NODES} values; specs must stay small.`);
  if (budget.nodes > MAX_SPEC_NODES) return;
  if (depth > MAX_SPEC_DEPTH) {
    issues.add(path, `is nested deeper than ${MAX_SPEC_DEPTH} levels.`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.add(path, `must be a finite number, got ${quote(value)}.`);
    return;
  }
  if (typeof value === 'string') {
    const reason = unsafeStringReason(value);
    if (reason) issues.add(path, `${reason}.`);
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => screen(v, `${path}[${i}]`, depth + 1, budget, issues));
    return;
  }
  if (isPlainObject(value)) {
    for (const k of Object.keys(value)) {
      const reason = unsafeStringReason(k);
      if (reason) issues.add(keyPath(path, k), `key ${reason}.`);
      screen(value[k], keyPath(path, k), depth + 1, budget, issues);
    }
    return;
  }
  issues.add(path, `has unsupported type ${typeof value}; only JSON values are allowed.`);
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, issues: Issues): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) issues.add(keyPath(path, k), `unknown key; allowed keys are ${allowed.join(', ')}.`);
}

function int(o: Record<string, unknown>, key: string, path: string, lo: number, hi: number, issues: Issues, fallback?: number): number {
  const p = keyPath(path, key);
  if (!has(o, key)) {
    if (fallback !== undefined) return fallback;
    issues.add(p, `is required (a whole number from ${lo} to ${hi}).`);
    return lo;
  }
  const v = o[key];
  if (typeof v !== 'number') {
    issues.add(p, `must be a number from ${lo} to ${hi}, got ${quote(v)}.`);
    return lo;
  }
  if (!Number.isFinite(v)) return lo; // already reported by screen()
  if (!Number.isInteger(v)) issues.add(p, `must be a whole number, got ${v}.`);
  else if (v < lo || v > hi) issues.add(p, `${v} is out of range; allowed ${lo} to ${hi}.`);
  return v;
}

function num(o: Record<string, unknown>, key: string, path: string, lo: number, hi: number, issues: Issues): number {
  const p = keyPath(path, key);
  if (!has(o, key)) {
    issues.add(p, `is required (a number from ${lo} to ${hi}).`);
    return lo;
  }
  const v = o[key];
  if (typeof v !== 'number') {
    issues.add(p, `must be a number from ${lo} to ${hi}, got ${quote(v)}.`);
    return lo;
  }
  if (!Number.isFinite(v)) return lo;
  if (v < lo || v > hi) issues.add(p, `${v} is out of range; allowed ${lo} to ${hi}.`);
  return v;
}

/* ---------- schema ---------- */

const KIND_LIST = (): string => ALL_MOTION_KINDS.map((k) => k.id).join(', ');

function validateLayer(raw: unknown, path: string, index: number, seen: Set<string>, issues: Issues): MotionLayer | null {
  if (!isPlainObject(raw)) {
    issues.add(path, `must be an object, got ${quote(raw)}.`);
    return null;
  }
  onlyKeys(raw, LAYER_KEYS, path, issues);
  let id = `l-${index + 1}`;
  if (has(raw, 'id')) {
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) issues.add(`${path}.id`, `must be 1 to 48 letters, digits, ":", "_" or "-", got ${quote(raw.id)}.`);
    else id = raw.id;
  }
  if (seen.has(id)) issues.add(`${path}.id`, `${quote(id)} is used by another layer; layer ids must be unique.`);
  seen.add(id);
  let kind = ALL_MOTION_KINDS[0].id;
  if (!has(raw, 'kind')) issues.add(`${path}.kind`, `is required; allowed: ${KIND_LIST()}.`);
  else if (!isMotionKind(raw.kind)) issues.add(`${path}.kind`, `unknown kind ${quote(raw.kind)}; allowed: ${KIND_LIST()}.`);
  else kind = raw.kind;
  const R = LAYER_RANGES;
  return {
    id,
    kind,
    intensity: int(raw, 'intensity', path, R.intensity.min, R.intensity.max, issues),
    speed: int(raw, 'speed', path, R.speed.min, R.speed.max, issues),
    hue: int(raw, 'hue', path, R.hue.min, R.hue.max, issues),
    opacity: int(raw, 'opacity', path, R.opacity.min, R.opacity.max, issues, 100),
    seed: int(raw, 'seed', path, R.seed.min, R.seed.max, issues, 7),
  };
}

function validateName(raw: Record<string, unknown>, path: string, issues: Issues): string {
  if (!has(raw, 'name')) {
    issues.add(`${path}.name`, `is required (1 to ${MAX_PRESET_NAME} characters).`);
    return '';
  }
  const v = raw.name;
  if (typeof v !== 'string') {
    issues.add(`${path}.name`, `must be text, got ${quote(v)}.`);
    return '';
  }
  const name = v.replace(/\s+/g, ' ').trim();
  if (!name) issues.add(`${path}.name`, 'must not be empty.');
  else if (name.length > MAX_PRESET_NAME) issues.add(`${path}.name`, `is ${name.length} characters; at most ${MAX_PRESET_NAME} are allowed.`);
  return name;
}

function validateSceneObject(raw: unknown, path: string, issues: Issues): MotionScene | null {
  if (!isPlainObject(raw)) {
    issues.add(path, `must be a scene object, got ${quote(raw)}.`);
    return null;
  }
  onlyKeys(raw, SCENE_KEYS, path, issues);
  if (raw.version !== SCENE_VERSION) issues.add(`${path}.version`, `must be ${SCENE_VERSION}, got ${quote(raw.version)}.`);
  if (has(raw, 'id') && (typeof raw.id !== 'string' || !ID_RE.test(raw.id))) issues.add(`${path}.id`, `must be 1 to 48 letters, digits, ":", "_" or "-", got ${quote(raw.id)}.`);
  const name = validateName(raw, path, issues);
  const background = int(raw, 'background', path, LAYER_RANGES.hue.min, LAYER_RANGES.hue.max, issues);
  const layers: MotionLayer[] = [];
  if (!Array.isArray(raw.layers)) issues.add(`${path}.layers`, `must be a list of 1 to ${MAX_LAYERS} layers, got ${quote(raw.layers)}.`);
  else if (raw.layers.length === 0) issues.add(`${path}.layers`, 'needs at least one layer.');
  else if (raw.layers.length > MAX_LAYERS) issues.add(`${path}.layers`, `has ${raw.layers.length} layers; at most ${MAX_LAYERS} are allowed.`);
  else {
    const seen = new Set<string>();
    raw.layers.forEach((l, i) => {
      const layer = validateLayer(l, `${path}.layers[${i}]`, i, seen, issues);
      if (layer) layers.push(layer);
    });
  }
  return { version: SCENE_VERSION, name, background, layers };
}

function validateTimeline(raw: unknown, path: string, issues: Issues): Timeline {
  const fallback: Timeline = { fps: 30, frames: 2, loop: true, poster: 0 };
  if (!isPlainObject(raw)) {
    issues.add(path, `must be an object with fps, frames and loop, got ${quote(raw)}.`);
    return fallback;
  }
  onlyKeys(raw, TIMELINE_KEYS, path, issues);
  let fps: TimelineFps = 30;
  if (!(TIMELINE_FPS as readonly unknown[]).includes(raw.fps)) issues.add(`${path}.fps`, `must be one of ${TIMELINE_FPS.join(', ')}, got ${quote(raw.fps)}.`);
  else fps = raw.fps as TimelineFps;
  const maxFrames = Math.min(TIMELINE_LIMITS.maxFrames, fps * TIMELINE_LIMITS.maxSeconds);
  const frames = int(raw, 'frames', path, TIMELINE_LIMITS.minFrames, maxFrames, issues);
  let loop = true;
  if (has(raw, 'loop')) {
    if (typeof raw.loop !== 'boolean') issues.add(`${path}.loop`, `must be true or false, got ${quote(raw.loop)}.`);
    else loop = raw.loop;
  }
  const safeFrames = Number.isInteger(frames) && frames >= TIMELINE_LIMITS.minFrames && frames <= maxFrames ? frames : TIMELINE_LIMITS.minFrames;
  const poster = int(raw, 'poster', path, 0, safeFrames - 1, issues, 0);
  return { fps, frames: safeFrames, loop, poster };
}

function validateEase(raw: unknown, path: string, issues: Issues): Ease {
  const fallback: Ease = { type: 'preset', name: 'linear' };
  if (!isPlainObject(raw)) {
    issues.add(path, `must be an ease object, got ${quote(raw)}.`);
    return fallback;
  }
  if (raw.type === 'preset') {
    onlyKeys(raw, ['type', 'name'], path, issues);
    if (!isEasingName(raw.name)) {
      issues.add(`${path}.name`, `unknown easing ${quote(raw.name)}; allowed: ${EASING_LIST.map((e) => e.id).join(', ')}.`);
      return fallback;
    }
    return { type: 'preset', name: raw.name };
  }
  if (raw.type === 'bezier') {
    onlyKeys(raw, ['type', 'x1', 'y1', 'x2', 'y2'], path, issues);
    const Y = BEZIER_Y_LIMIT;
    return { type: 'bezier', x1: num(raw, 'x1', path, 0, 1, issues), y1: num(raw, 'y1', path, Y.min, Y.max, issues), x2: num(raw, 'x2', path, 0, 1, issues), y2: num(raw, 'y2', path, Y.min, Y.max, issues) };
  }
  if (raw.type === 'spring') {
    onlyKeys(raw, ['type', 'stiffness', 'damping', 'mass'], path, issues);
    const S = SPRING_LIMITS;
    return { type: 'spring', stiffness: num(raw, 'stiffness', path, S.stiffness.min, S.stiffness.max, issues), damping: num(raw, 'damping', path, S.damping.min, S.damping.max, issues), mass: num(raw, 'mass', path, S.mass.min, S.mass.max, issues) };
  }
  issues.add(`${path}.type`, `must be "preset", "bezier" or "spring", got ${quote(raw.type)}.`);
  return fallback;
}

function validateTracks(raw: unknown, path: string, scene: MotionScene, tl: Timeline, issues: Issues): Track[] {
  if (!Array.isArray(raw)) {
    issues.add(path, `must be a list of tracks, got ${quote(raw)}.`);
    return [];
  }
  if (raw.length > MAX_TRACKS) {
    issues.add(path, `has ${raw.length} tracks; at most ${MAX_TRACKS} are allowed.`);
    return [];
  }
  const ids = new Set(scene.layers.map((l) => l.id));
  const seen = new Set<string>();
  const out: Track[] = [];
  raw.forEach((item, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(item)) {
      issues.add(p, `must be a track object, got ${quote(item)}.`);
      return;
    }
    onlyKeys(item, TRACK_KEYS, p, issues);
    const layerOk = typeof item.layer === 'string' && ids.has(item.layer);
    if (!layerOk) issues.add(`${p}.layer`, `${quote(item.layer)} is not the id of a layer in this scene.`);
    const paramOk = isTrackParam(item.param);
    if (!paramOk) issues.add(`${p}.param`, `unknown parameter ${quote(item.param)}; allowed: ${TRACK_PARAMS.map((t) => t.id).join(', ')}.`);
    if (layerOk && paramOk) {
      const k = `${item.layer}/${item.param}`;
      if (seen.has(k)) issues.add(p, `repeats the ${k} track; each layer property may have one track.`);
      seen.add(k);
    }
    const spec = paramOk ? trackParam(item.param as Track['param']) : null;
    const keys: Keyframe[] = [];
    if (!Array.isArray(item.keys) || item.keys.length === 0) issues.add(`${p}.keys`, `must be a list of 1 to ${MAX_KEYS} keyframes.`);
    else if (item.keys.length > MAX_KEYS) issues.add(`${p}.keys`, `has ${item.keys.length} keyframes; at most ${MAX_KEYS} are allowed.`);
    else {
      const frames = new Set<number>();
      item.keys.forEach((key, j) => {
        const kp = `${p}.keys[${j}]`;
        if (!isPlainObject(key)) {
          issues.add(kp, `must be a keyframe object, got ${quote(key)}.`);
          return;
        }
        onlyKeys(key, KEY_KEYS, kp, issues);
        const frame = int(key, 'frame', kp, 0, tl.frames - 1, issues);
        if (frames.has(frame)) issues.add(`${kp}.frame`, `frame ${frame} already has a keyframe in this track.`);
        frames.add(frame);
        const value = spec ? num(key, 'value', kp, spec.min, spec.max, issues) : 0;
        const ease: Ease = has(key, 'ease') ? validateEase(key.ease, `${kp}.ease`, issues) : { type: 'preset', name: 'in-out-cubic' };
        keys.push({ frame, value, ease });
      });
    }
    if (layerOk && paramOk) out.push({ layer: item.layer as string, param: item.param as Track['param'], keys: keys.sort((a, b) => a.frame - b.frame) });
  });
  return out;
}

function validateLabObject(raw: Record<string, unknown>, issues: Issues): MotionLab | null {
  onlyKeys(raw, LAB_KEYS, '$', issues);
  if (raw.version !== LAB_VERSION) issues.add('$.version', `must be ${LAB_VERSION}, got ${quote(raw.version)}.`);
  const scene = validateSceneObject(raw.scene, '$.scene', issues);
  if (!scene) return null;
  if (!has(raw, 'timeline')) issues.add('$.timeline', 'is required in a lab document.');
  const timeline = has(raw, 'timeline') ? validateTimeline(raw.timeline, '$.timeline', issues) : { fps: 30 as TimelineFps, frames: 2, loop: true, poster: 0 };
  const tracks = has(raw, 'tracks') ? validateTracks(raw.tracks, '$.tracks', scene, timeline, issues) : [];
  let quality: QualityId = 'balanced';
  if (has(raw, 'quality')) {
    if (!isQualityId(raw.quality)) issues.add('$.quality', `must be eco, balanced or studio, got ${quote(raw.quality)}.`);
    else quality = raw.quality;
  }
  return { version: LAB_VERSION, type: 'motion-lab', scene, timeline, tracks, quality };
}

/**
 * Validate an already-parsed value. Returns a fresh scene (and lab, for lab documents) built only from
 * whitelisted fields; the input object is never returned or mutated. Any issue rejects the whole spec.
 */
export function validateSceneSpec(value: unknown): SpecValidation {
  const issues = new Issues();
  if (!isPlainObject(value)) {
    issues.add('$', `must be a JSON object, got ${quote(value)}.`);
    return { ok: false, scene: null, lab: null, issues: issues.finish() };
  }
  screen(value, '$', 0, { nodes: 0 }, issues);
  let scene: MotionScene | null = null;
  let lab: MotionLab | null = null;
  if (has(value, 'type')) {
    if (value.type !== 'motion-lab') issues.add('$.type', `must be "motion-lab" when present, got ${quote(value.type)}.`);
    else {
      lab = validateLabObject(value, issues);
      scene = lab?.scene ?? null;
    }
  } else scene = validateSceneObject(value, '$', issues);
  if (issues.count > 0 || !scene) {
    const list = issues.finish();
    return { ok: false, scene: null, lab: null, issues: list.length ? list : [{ path: '$', message: 'is not a valid scene.' }] };
  }
  return { ok: true, scene, lab, issues: [] };
}

const utf8Length = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

/**
 * Pull the JSON object out of untrusted text: a bare object, a ```json fenced block, or the outermost braces
 * of a model reply that wraps JSON in prose. Returns null when there is no candidate.
 */
export function extractSpecJson(text: string): string | null {
  const t = text.trim();
  if (t.startsWith('{') && t.endsWith('}')) return t;
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/i.exec(t);
  if (fence && fence[1].trim().startsWith('{')) return fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  return start >= 0 && end > start ? t.slice(start, end + 1) : null;
}

/** Validate untrusted text. Only JSON.parse touches it; nothing is evaluated. */
export function validateSceneText(text: unknown): SpecValidation {
  const fail = (path: string, message: string): SpecValidation => ({ ok: false, scene: null, lab: null, issues: [{ path, message }] });
  if (typeof text !== 'string') return fail('$', 'input must be text.');
  if (!text.trim()) return fail('$', 'input is empty.');
  if (text.length > MAX_SPEC_BYTES || utf8Length(text) > MAX_SPEC_BYTES) return fail('$', `input is larger than ${MAX_SPEC_BYTES / 1024} KB.`);
  const json = extractSpecJson(text);
  if (json === null) return fail('$', 'no JSON object was found in the text.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const detail = e instanceof Error ? e.message.replace(/[^\w .,:'"()-]/g, '').slice(0, 120) : '';
    return fail('$', `is not valid JSON${detail ? ` (${detail})` : ''}.`);
  }
  return validateSceneSpec(parsed);
}

/* ---------- local model gate and prompt ---------- */

export type ComposeAvailability = { ok: true; model: string } | { ok: false; reason: string };
export type ComposeAvailabilityInput = {
  /** The window exposes chat() and listLocalModels(). */
  bridge: boolean;
  /** Browser preview bridge: no real local model behind it. */
  preview: boolean;
  /** Settings mode. Chat stays on the local model only while this is 'offline'. */
  mode: string | null;
  /** Result of listLocalModels(), or null when it could not be read. */
  models: { available: boolean; models: { name: string }[]; reason?: string } | null;
  /** Settings localModel. */
  configuredModel: string;
};

const NEEDS = 'Needs a local model:';

/**
 * Whether the Compose panel may ask the local model. There is no cloud fallback: when this says no, the panel
 * only offers paste-and-validate.
 */
export function composeAvailability(input: ComposeAvailabilityInput): ComposeAvailability {
  if (!input.bridge) return { ok: false, reason: `${NEEDS} this window has no local chat bridge. Paste a spec instead.` };
  if (input.preview) return { ok: false, reason: `${NEEDS} the browser preview has no local model. Paste a spec instead.` };
  if (input.mode !== 'offline') return { ok: false, reason: `${NEEDS} online mode is on and this panel never sends requests to a cloud model. Switch to offline mode to use the local model, or paste a spec.` };
  if (!input.models) return { ok: false, reason: `${NEEDS} the local model runtime could not be checked.` };
  if (!input.models.available) return { ok: false, reason: `${NEEDS} ${String(input.models.reason || 'the local model runtime is not running.').slice(0, 200)}` };
  const names = input.models.models.map((m) => m.name);
  if (names.length === 0) return { ok: false, reason: `${NEEDS} no local models are installed.` };
  const want = input.configuredModel.trim();
  const base = (n: string) => n.replace(/:latest$/i, '');
  if (!want) return { ok: false, reason: `${NEEDS} no local model is selected in Settings.` };
  if (!names.some((n) => n === want || base(n) === base(want))) return { ok: false, reason: `${NEEDS} the selected model "${want.slice(0, 60)}" is not installed.` };
  return { ok: true, model: want };
}

/** Trim, drop control characters and bound a scene request before it goes into a local prompt. */
export function normalizeComposeRequest(text: unknown): string {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_COMPOSE_REQUEST);
}

/**
 * Prompt for the local model. The reply is untrusted: it only ever reaches validateSceneText and is applied
 * after the user clicks Apply validated scene.
 */
export function buildComposePrompt(request: string): string {
  const r = normalizeComposeRequest(request);
  return [
    'Reply with one JSON object only, with no prose around it. It describes an abstract animated background for an offline motion studio.',
    `Schema: ${SCENE_SCHEMA_HINT}.`,
    'All numbers are whole numbers inside the stated ranges. Do not add other keys. Do not include links, file names, markup or scripts.',
    `Scene request: ${r || 'a calm, slow scene'}`,
  ].join('\n');
}
