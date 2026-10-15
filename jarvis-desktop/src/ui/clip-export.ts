/**
 * Local clip export (feature 140): sample a Motion Studio scene into a portable, validated JSON clip.
 *
 * Pure and DOM-free. No animation-frame callbacks, no clock, no network: every frame value is computed
 * directly from the frame time with the same deterministic maths the Motion Lab renderer uses
 * (resolveLayer for keyframe tracks, framePhase/layerRate for periodic motion). Identical input
 * always produces byte-identical output. All motion is original to this project.
 */

import { ALL_MOTION_KINDS, isMotionKind, labFromScene, layerRate, resolveLayer, type MotionKind, type MotionLab, type MotionScene } from './motion-presets';
import { framePhase, round } from './motion-timing';

export const CLIP_FORMAT = 'desktop-companion-clip' as const;
export const CLIP_VERSION = 1 as const;
export const CLIP_EXPORT_LIMITS = { minFps: 1, maxFps: 60, minDurationMs: 100, maxDurationMs: 30_000 } as const;
/** fps choices offered by the UI. Any integer 1..60 is valid for the module. */
export const CLIP_EXPORT_FPS = [12, 24, 30, 60] as const;
/** Upper bound accepted by parseClip; 60 fps × 30 s × 4 layers stays well below this. */
export const MAX_CLIP_BYTES = 4 * 1024 * 1024;

export type ClipElement = {
  id: string;
  kind: MotionKind;
  /** Horizontal offset in % of stage width. */
  x: number;
  /** Vertical offset in % of stage height. */
  y: number;
  /** 0..1 */
  opacity: number;
  /** 1 = 100% */
  scale: number;
  /** Base motion phase in radians for the layer at this frame. */
  phase: number;
  hue: number;
};
export type ClipFrame = { /** milliseconds from clip start */ t: number; elements: ClipElement[] };
export type Clip = {
  format: typeof CLIP_FORMAT;
  version: typeof CLIP_VERSION;
  sceneId: string;
  fps: number;
  durationMs: number;
  frameCount: number;
  reducedMotion: boolean;
  frames: ClipFrame[];
  license: 'original';
};
export type ClipOptions = { fps: number; durationMs: number; reducedMotion?: boolean };

const ID_RE = /^[a-z0-9:_-]{1,48}$/i;
/** Rounded value with negative zero folded to 0, so JSON round-trips compare exactly. */
const num = (v: number, places: number): number => round(v, places) + 0;

function checkFps(fps: unknown): number {
  if (typeof fps !== 'number' || !Number.isInteger(fps) || fps < CLIP_EXPORT_LIMITS.minFps || fps > CLIP_EXPORT_LIMITS.maxFps) {
    throw new Error(`Clip fps must be an integer from ${CLIP_EXPORT_LIMITS.minFps} to ${CLIP_EXPORT_LIMITS.maxFps}; got ${String(fps)}.`);
  }
  return fps;
}

function checkDuration(ms: unknown): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < CLIP_EXPORT_LIMITS.minDurationMs || ms > CLIP_EXPORT_LIMITS.maxDurationMs) {
    throw new Error(`Clip durationMs must be from ${CLIP_EXPORT_LIMITS.minDurationMs} to ${CLIP_EXPORT_LIMITS.maxDurationMs}; got ${String(ms)}.`);
  }
  return ms;
}

/** Frames in a clip: round(fps × seconds), never below one so the shortest clip still has a frame. */
export const clipExportFrameCount = (fps: number, durationMs: number): number => Math.max(1, Math.round((fps * durationMs) / 1000));

const sceneIdOf = (input: MotionScene | MotionLab): string => {
  const candidate = (input as { id?: unknown }).id;
  if (typeof candidate === 'string' && ID_RE.test(candidate)) return candidate;
  const scene = 'type' in input && input.type === 'motion-lab' ? input.scene : (input as MotionScene);
  return (scene.name || 'scene').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'scene';
};

/**
 * Sample a scene (or a Motion Lab with keyframe tracks) into a clip. Reduced motion holds every
 * frame at the timeline poster frame, so the exported clip is a still with the requested timing.
 */
export function sampleClip(input: MotionScene | MotionLab, options: ClipOptions): Clip {
  if (!input || typeof input !== 'object') throw new Error('Clip export needs a scene object.');
  const fps = checkFps(options?.fps);
  const durationMs = checkDuration(options?.durationMs);
  const reducedMotion = options.reducedMotion === true;
  const lab: MotionLab = 'type' in input && input.type === 'motion-lab' ? input : labFromScene(input as MotionScene);
  if (!Array.isArray(lab.scene?.layers) || lab.scene.layers.length === 0) throw new Error('Clip export needs a scene with at least one layer.');
  const frameCount = clipExportFrameCount(fps, durationMs);
  const frames: ClipFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const seconds = i / fps;
    const labFrame = reducedMotion ? lab.timeline.poster : seconds * lab.timeline.fps;
    const elements: ClipElement[] = lab.scene.layers.map((layer) => {
      const r = resolveLayer(lab, layer, labFrame);
      return {
        id: layer.id,
        kind: layer.kind,
        x: num(r.x, 4),
        y: num(r.y, 4),
        opacity: num(r.opacity / 100, 4),
        scale: num(r.scale, 4),
        phase: num(framePhase(labFrame, lab.timeline, layerRate(layer.speed)), 4),
        hue: num(r.hue, 2),
      };
    });
    frames.push({ t: num(seconds * 1000, 3), elements });
  }
  return { format: CLIP_FORMAT, version: CLIP_VERSION, sceneId: sceneIdOf(input), fps, durationMs, frameCount, reducedMotion, frames, license: 'original' };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Strict validator for clip JSON. Returns a clean copy (unknown keys dropped) or throws a descriptive Error. */
export function parseClip(json: string): Clip {
  if (typeof json !== 'string') throw new Error('Clip must be a JSON string.');
  if (json.length > MAX_CLIP_BYTES) throw new Error(`Clip is larger than ${MAX_CLIP_BYTES / (1024 * 1024)} MB.`);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Clip is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Clip must be a JSON object.');
  const o = raw as Record<string, unknown>;
  if (o.format !== CLIP_FORMAT) throw new Error(`Unsupported clip format ${JSON.stringify(o.format)}; expected "${CLIP_FORMAT}".`);
  if (o.version !== CLIP_VERSION) throw new Error(`Unsupported clip version ${String(o.version)}; this build reads version ${CLIP_VERSION}.`);
  if (o.license !== 'original') throw new Error('Clip license must be "original".');
  if (typeof o.sceneId !== 'string' || !ID_RE.test(o.sceneId)) throw new Error('Clip sceneId is missing or invalid.');
  if (typeof o.reducedMotion !== 'boolean') throw new Error('Clip reducedMotion must be a boolean.');
  const fps = checkFps(o.fps);
  const durationMs = checkDuration(o.durationMs);
  const expected = clipExportFrameCount(fps, durationMs);
  if (o.frameCount !== expected) throw new Error(`Clip frameCount ${String(o.frameCount)} does not match fps and duration (expected ${expected}).`);
  if (!Array.isArray(o.frames) || o.frames.length !== expected) throw new Error(`Clip has ${Array.isArray(o.frames) ? o.frames.length : 'no'} frames; frameCount says ${expected}.`);
  let lastT = -Infinity;
  let layerCount = -1;
  const frames: ClipFrame[] = o.frames.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`Clip frame ${i} is not an object.`);
    const f = item as Record<string, unknown>;
    if (!isNum(f.t) || f.t < 0 || f.t > durationMs || f.t <= lastT) throw new Error(`Clip frame ${i} time is missing, out of range or not increasing.`);
    lastT = f.t;
    if (!Array.isArray(f.elements) || f.elements.length === 0) throw new Error(`Clip frame ${i} has no elements.`);
    if (layerCount >= 0 && f.elements.length !== layerCount) throw new Error(`Clip frame ${i} has a different number of elements.`);
    layerCount = f.elements.length;
    const elements = f.elements.map((el, j): ClipElement => {
      if (!el || typeof el !== 'object') throw new Error(`Clip frame ${i} element ${j} is not an object.`);
      const e = el as Record<string, unknown>;
      if (typeof e.id !== 'string' || !ID_RE.test(e.id)) throw new Error(`Clip frame ${i} element ${j} has an invalid id.`);
      if (!isMotionKind(e.kind)) throw new Error(`Clip frame ${i} element ${j} has unknown kind; allowed: ${ALL_MOTION_KINDS.map((k) => k.id).join(', ')}.`);
      for (const k of ['x', 'y', 'opacity', 'scale', 'phase', 'hue'] as const) if (!isNum(e[k])) throw new Error(`Clip frame ${i} element ${j} ${k} must be a finite number.`);
      const opacity = e.opacity as number;
      if (opacity < 0 || opacity > 1) throw new Error(`Clip frame ${i} element ${j} opacity must be 0..1.`);
      return { id: e.id, kind: e.kind, x: e.x as number, y: e.y as number, opacity, scale: e.scale as number, phase: e.phase as number, hue: e.hue as number };
    });
    return { t: f.t, elements };
  });
  return { format: CLIP_FORMAT, version: CLIP_VERSION, sceneId: o.sceneId, fps, durationMs, frameCount: expected, reducedMotion: o.reducedMotion, frames, license: 'original' };
}

/** JSON text and Blob options for a local download; the caller builds the Blob. Nothing touches the network. */
export function clipToBlobParts(clip: Clip): [string, { type: 'application/json' }] {
  return [JSON.stringify(clip), { type: 'application/json' }];
}

/** UTF-8 size of the exported JSON in bytes, shown before download. */
export const clipByteSize = (clip: Clip): number => new TextEncoder().encode(clipToBlobParts(clip)[0]).length;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${round(bytes / 1024, 1)} KB`;
  return `${round(bytes / (1024 * 1024), 2)} MB`;
}
