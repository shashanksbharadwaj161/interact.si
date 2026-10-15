/**
 * Local animation clip export (roadmap 140).
 *
 * Pure, DOM-free and offline. A clip is a deterministic list of sampled frames computed from a validated
 * scene using the same timing maths as the Motion Lab renderer (framePhase, layerRate, loopNoise, waveAt,
 * bloomCoreScale). Nothing here reads a clock, the network or the file system: the optional generatedAt
 * timestamp only appears when the caller injects a clock. Exports never carry file paths or personal data;
 * the scene name is reduced to a short, path-free label and layer ids are renumbered.
 *
 * This module produces data (JSON) and CSS @keyframes only. It does not encode video or GIF.
 */

import { bloomCoreScale, layerRate, normalizePresetName, parseScene, waveAt, type MotionKind, type MotionLayer, type MotionScene } from './motion-presets';
import { TAU, clamp, fract, framePhase, loopNoise, mod, round, type Timeline } from './motion-timing';

export const CLIP_FORMAT = 'desktop-companion-clip' as const;
export const CLIP_VERSION = 1 as const;
export const CLIP_BOUNDS = { minFps: 1, maxFps: 60, minDurationMs: 100, maxDurationMs: 30_000, maxFrames: 1800 } as const;
export const DEFAULT_CLIP_REQUEST = { fps: 24, durationMs: 4000, maxFrames: CLIP_BOUNDS.maxFrames } as const;

export type ClipOptions = { fps: number; durationMs: number; maxFrames?: number };
export type ClipRequest = ClipOptions & { scene: unknown };
export type ClipValidation =
  | { ok: true; scene: MotionScene; fps: number; durationMs: number; maxFrames: number; frameCount: number; errors: string[] }
  | { ok: false; error: string; errors: string[] };

export type ClipLayerSample = {
  id: string;
  kind: MotionKind;
  /** Base phase in radians, wrapped to 0..TAU. */
  phase: number;
  /** 0..1 */
  opacity: number;
  /** 1 = 100% */
  scale: number;
  /** Offset as a percentage of width / height. */
  x: number;
  y: number;
  /** Hue in degrees after the sampled sway. */
  hue: number;
};

export type ClipFrame = {
  index: number;
  timeMs: number;
  /** Position in the loop, 0 (inclusive) to 1 (exclusive). */
  progress: number;
  /** Composite stage values used for CSS keyframes. */
  opacity: number;
  scale: number;
  x: number;
  y: number;
  /** Opacity-weighted hue sway in degrees, relative to each layer's own hue. */
  hueRotate: number;
  layers: ClipLayerSample[];
};

export type ClipMeta = { fps: number; scene: MotionScene; now?: () => number | Date };
export type ClipFormatId = 'json' | 'css';

/** Finite number or 0; rounding never yields NaN, -0 or Infinity in an export. */
const num = (v: number, places = 4): number => {
  if (!Number.isFinite(v)) return 0;
  const r = round(v, places);
  return Object.is(r, -0) ? 0 : r;
};

/** Frames a clip contains: round(fps × seconds), at least 1, never above maxFrames (itself at most 1800). */
export function clipFrameTotal(fps: number, durationMs: number, maxFrames: number = CLIP_BOUNDS.maxFrames): number {
  const cap = Math.max(1, Math.min(CLIP_BOUNDS.maxFrames, Math.floor(Number.isFinite(maxFrames) ? maxFrames : CLIP_BOUNDS.maxFrames)));
  const raw = Math.round((fps * durationMs) / 1000);
  return Math.max(1, Math.min(cap, Number.isFinite(raw) ? raw : 1));
}

/** Actual loop length in ms of a sampled clip (shorter than requested when the frame limit capped it). */
export const clipDurationMs = (frameCount: number, fps: number): number => (fps > 0 ? num((frameCount * 1000) / fps, 3) : 0);

/**
 * Check a clip request and explain every problem in plain language. Accepts either one request object
 * ({ scene, fps, durationMs, maxFrames }) or (scene, options).
 */
export function validateClipRequest(requestOrScene: unknown, options?: Partial<ClipOptions>): ClipValidation {
  const req = (options !== undefined ? { ...options, scene: requestOrScene } : requestOrScene && typeof requestOrScene === 'object' ? requestOrScene : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const { minFps, maxFps, minDurationMs, maxDurationMs, maxFrames: frameCap } = CLIP_BOUNDS;

  const fps = req.fps;
  if (typeof fps !== 'number' || !Number.isFinite(fps)) errors.push(`Frame rate must be a number between ${minFps} and ${maxFps}.`);
  else if (fps < minFps || fps > maxFps) errors.push(`Frame rate ${fps} is out of range; choose ${minFps} to ${maxFps} frames per second.`);
  else if (!Number.isInteger(fps)) errors.push(`Frame rate must be a whole number between ${minFps} and ${maxFps}.`);

  const durationMs = req.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) errors.push(`Duration must be a number of milliseconds between ${minDurationMs} and ${maxDurationMs}.`);
  else if (durationMs < minDurationMs) errors.push(`Duration ${durationMs} ms is too short; the shortest clip is ${minDurationMs} ms.`);
  else if (durationMs > maxDurationMs) errors.push(`Duration ${durationMs} ms is too long; the longest clip is ${maxDurationMs / 1000} seconds.`);

  let maxFrames: number = frameCap;
  if (req.maxFrames !== undefined) {
    const m = req.maxFrames;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1) errors.push(`Frame limit must be a whole number from 1 to ${frameCap}.`);
    else if (m > frameCap) errors.push(`Frame limit ${m} is too high; at most ${frameCap} frames can be exported.`);
    else maxFrames = m;
  }

  const parsed = parseScene(req.scene);
  if (!parsed.ok) errors.push(`The scene cannot be exported: ${parsed.error}`);

  if (errors.length > 0 || !parsed.ok) return { ok: false, error: errors.join(' '), errors };
  const f = fps as number;
  const d = durationMs as number;
  return { ok: true, scene: exportScene(parsed.scene), fps: f, durationMs: d, maxFrames, frameCount: clipFrameTotal(f, d, maxFrames), errors: [] };
}

/** Scene names are user text: keep a short label, drop anything that looks like a path, address or link. */
export function clipSceneName(name: unknown): string {
  const clean = normalizePresetName(name);
  if (!clean || /[\\/@:~<>]|\.\./.test(clean)) return 'Untitled scene';
  return clean;
}

/** Renumber layer ids and clean the name so exports do not leak timestamp-based ids or personal text. */
function exportScene(scene: MotionScene): MotionScene {
  return {
    version: scene.version,
    name: clipSceneName(scene.name),
    background: scene.background,
    layers: scene.layers.map((l, i) => ({ id: `l-${i + 1}`, kind: l.kind, intensity: l.intensity, speed: l.speed, hue: l.hue, opacity: l.opacity, seed: l.seed })),
  };
}

/**
 * Per-layer motion envelope at a base phase. Each value is built only from whole harmonics of the phase,
 * so a clip that spans whole loop cycles ends where it began.
 */
export function sampleLayer(layer: MotionLayer, phase: number): Omit<ClipLayerSample, 'id' | 'kind' | 'phase'> {
  const I = clamp(layer.intensity, 0, 100) / 100;
  const base = clamp(layer.opacity, 0, 100) / 100;
  const sway = loopNoise(layer.seed, 2, phase, 2);
  let scale = 1;
  let x = 0;
  let y = 0;
  let opacity = base;
  switch (layer.kind) {
    case 'wave':
      y = (waveAt(0, 0.5, phase, layer.intensity) - waveAt(0, 0.5, 0, layer.intensity)) * 100;
      break;
    case 'particles':
      x = 3 * I * loopNoise(layer.seed, 0, phase);
      y = 3 * I * loopNoise(layer.seed, 1, phase);
      opacity = base * (0.85 + 0.15 * Math.sin(2 * phase));
      break;
    case 'orbit':
      scale = 1 + 0.08 * Math.sin(phase);
      break;
    case 'aurora':
      y = 4 * (0.4 + 0.6 * I) * loopNoise(layer.seed, 1, phase);
      opacity = base * (0.8 + 0.2 * Math.sin(phase));
      break;
    case 'bloom': {
      const rings = 3 + Math.round(I * 4);
      scale = bloomCoreScale(fract((phase / TAU) * rings));
      break;
    }
    case 'lattice':
      opacity = base * (0.75 + 0.25 * Math.cos(phase));
      break;
  }
  return { opacity: num(clamp(opacity, 0, 1)), scale: num(scale), x: num(x, 3), y: num(y, 3), hue: num(layer.hue + 12 * sway, 2) };
}

/**
 * Deterministic frame list for a scene. Throws an Error with a plain-language message when the request is
 * out of bounds; call validateClipRequest first to show the message in a form instead.
 */
export function sampleClip(scene: unknown, options: ClipOptions): ClipFrame[] {
  const v = validateClipRequest(scene, options);
  if (!v.ok) throw new Error(v.error);
  const n = v.frameCount;
  const tl: Timeline = { fps: v.fps as Timeline['fps'], frames: n, loop: true, poster: 0 };
  const frames: ClipFrame[] = [];
  for (let i = 0; i < n; i++) {
    const layers: ClipLayerSample[] = v.scene.layers.map((layer) => {
      const phase = framePhase(i, tl, layerRate(layer.speed));
      return { id: layer.id, kind: layer.kind, phase: num(mod(phase, TAU)), ...sampleLayer(layer, phase) };
    });
    const total = layers.reduce((a, l) => a + l.opacity, 0);
    const weight = (j: number) => (total > 0 ? layers[j].opacity / total : 1 / layers.length);
    const avg = (pick: (l: ClipLayerSample, j: number) => number) => layers.reduce((a, l, j) => a + weight(j) * pick(l, j), 0);
    frames.push({
      index: i,
      timeMs: num((i * 1000) / v.fps, 3),
      progress: num(i / n, 6),
      opacity: num(layers.reduce((a, l) => Math.max(a, l.opacity), 0)),
      scale: num(avg((l) => l.scale)),
      x: num(avg((l) => l.x), 3),
      y: num(avg((l) => l.y), 3),
      hueRotate: num(avg((l, j) => l.hue - v.scene.layers[j].hue), 2),
      layers,
    });
  }
  return frames;
}

/** Versioned JSON document. generatedAt only appears when a clock is injected, so output stays reproducible. */
export function serializeClipJson(frames: readonly ClipFrame[], meta: ClipMeta): string {
  const fps = num(meta.fps, 3);
  const doc: Record<string, unknown> = { format: CLIP_FORMAT, version: CLIP_VERSION, fps, frameCount: frames.length, durationMs: clipDurationMs(frames.length, fps), loop: true };
  if (meta.now) {
    const t = meta.now();
    const ms = t instanceof Date ? t.getTime() : t;
    if (typeof ms === 'number' && Number.isFinite(ms)) doc.generatedAt = new Date(ms).toISOString();
  }
  doc.scene = exportScene(meta.scene);
  doc.frames = frames.map((f) => ({
    index: f.index,
    timeMs: num(f.timeMs, 3),
    progress: num(f.progress, 6),
    opacity: num(f.opacity),
    scale: num(f.scale),
    x: num(f.x, 3),
    y: num(f.y, 3),
    hueRotate: num(f.hueRotate, 2),
    layers: f.layers.map((l) => ({ id: l.id, kind: l.kind, phase: num(l.phase), opacity: num(l.opacity), scale: num(l.scale), x: num(l.x, 3), y: num(l.y, 3), hue: num(l.hue, 2) })),
  }));
  return JSON.stringify(doc, null, 2);
}

/** A safe CSS identifier: letters, digits, hyphen and underscore, starting with a letter. */
export function cssKeyframesName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const id = raw.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').toLowerCase().slice(0, 48);
  if (!id) return 'motion-clip';
  return /^[a-z]/.test(id) ? id : `clip-${id}`;
}

const cssStop = (f: Pick<ClipFrame, 'opacity' | 'scale' | 'x' | 'y' | 'hueRotate'>) =>
  `opacity: ${num(f.opacity)}; transform: translate(${num(f.x, 3)}%, ${num(f.y, 3)}%) scale(${num(f.scale)}); filter: hue-rotate(${num(f.hueRotate, 2)}deg);`;

/**
 * One @keyframes block with a percentage stop per frame. The clip is a seamless loop, so the 100% stop
 * repeats the first frame. Stops are rounded to three decimals and de-duplicated.
 */
export function serializeCssKeyframes(frames: readonly ClipFrame[], name: string): string {
  const id = cssKeyframesName(name);
  const lines = [`@keyframes ${id} {`];
  if (frames.length === 0) {
    lines.push('  0% { opacity: 1; }', '  100% { opacity: 1; }', '}');
    return lines.join('\n');
  }
  const n = frames.length;
  let last = -1;
  frames.forEach((f, i) => {
    const pct = num((i / n) * 100, 3);
    if (pct <= last || pct >= 100) return;
    last = pct;
    lines.push(`  ${pct}% { ${cssStop(f)} }`);
  });
  lines.push(`  100% { ${cssStop(frames[0])} }`, '}');
  return lines.join('\n');
}

/** Keyframes plus a ready-to-use class that turns itself off for reduced motion. */
export function serializeCssClip(frames: readonly ClipFrame[], name: string, fps: number): string {
  const id = cssKeyframesName(name);
  const secs = num(Math.max(0.001, clipDurationMs(frames.length, fps) / 1000), 3);
  return [
    `/* ${frames.length} frames at ${num(fps, 3)} fps, ${secs}s loop. Generated offline. */`,
    serializeCssKeyframes(frames, id),
    `.${id} { animation: ${id} ${secs}s linear infinite; }`,
    `@media (prefers-reduced-motion: reduce) { .${id} { animation: none; } }`,
    '',
  ].join('\n');
}

const utf8Length = (s: string): number => {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
};

/** Exact UTF-8 size of an export string. */
export const exportBytes = utf8Length;

/**
 * Byte size estimate before export: serialize up to four frames and extrapolate per frame.
 * Exact for clips of four frames or fewer.
 */
export function estimateClipBytes(frames: readonly ClipFrame[], format: ClipFormatId, meta: ClipMeta, name = 'motion-clip'): number {
  const size = (fs: readonly ClipFrame[]) => utf8Length(format === 'json' ? serializeClipJson(fs, { fps: meta.fps, scene: meta.scene }) : serializeCssClip(fs, name, meta.fps));
  if (frames.length <= 4) return size(frames);
  const one = size(frames.slice(0, 1));
  const four = size(frames.slice(0, 4));
  return Math.round(one + ((four - one) / 3) * (frames.length - 1));
}

export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${round(bytes / 1024, 1)} KB`;
  return `${round(bytes / (1024 * 1024), 2)} MB`;
}

export const CLIP_CAPABILITY_NOTE = 'Video and GIF encoding is not available yet. This export writes animation data (JSON) or CSS keyframes only.';
