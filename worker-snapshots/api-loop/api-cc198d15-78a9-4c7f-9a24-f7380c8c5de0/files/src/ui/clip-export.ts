/**
 * Local animation/clip export (roadmap feature 140).
 *
 * Samples a Motion Studio scene (or a full Motion Lab document with keyframe tracks) at a bounded frame rate
 * and frame count into a portable clip JSON, and turns that clip into CSS @keyframes text. Everything is a pure
 * function of its input: no clock, no randomness, no DOM, no network and no file paths. The same scene and
 * options always produce byte-identical output.
 */

import { CLIP_FPS, CLIP_LIMITS, MAX_LAYERS, labFromScene, layerRate, resolveLayer, type ClipFps, type MotionKind, type MotionLab, type MotionScene } from './motion-presets';
import { TAU, framePhase, mod, round } from './motion-timing';

export const CLIP_FORMAT = 'motion-studio-clip' as const;
export const CLIP_VERSION = 1 as const;

/** Hard bounds. maxFrames is also capped by fps * maxSeconds. */
export const CLIP_EXPORT_LIMITS = {
  fps: CLIP_FPS,
  defaultFps: 24 as ClipFps,
  minFrames: 1,
  maxFrames: CLIP_LIMITS.maxFrames,
  maxSeconds: CLIP_LIMITS.maxSeconds,
  maxLayers: MAX_LAYERS,
} as const;

/** Sampled properties, in the order they appear in each layer sample. */
export const CLIP_PROPERTIES = ['intensity', 'hue', 'opacity', 'scale', 'x', 'y', 'phase'] as const;

export type ClipRequest = { fps?: number; frames?: number; seconds?: number };
export type ClipSampling = { fps: ClipFps; frames: number; notes: string[] };

export type ClipLayerInfo = { id: string; kind: MotionKind; seed: number; speed: number; baseHue: number };
/** intensity/opacity in %, hue in degrees, scale as a factor (1 = 100%), x/y in % of the stage, phase in radians 0..2π. */
export type ClipLayerSample = { id: string; intensity: number; hue: number; opacity: number; scale: number; x: number; y: number; phase: number };
export type ClipFrame = { index: number; time: number; layers: ClipLayerSample[] };
export type MotionClip = {
  format: typeof CLIP_FORMAT;
  version: typeof CLIP_VERSION;
  name: string;
  fps: ClipFps;
  frameCount: number;
  durationSeconds: number;
  loop: boolean;
  background: number;
  properties: string[];
  layers: ClipLayerInfo[];
  frames: ClipFrame[];
};

/** Largest frame count allowed at a frame rate. */
export const maxClipFrames = (fps: ClipFps): number => Math.min(CLIP_EXPORT_LIMITS.maxFrames, fps * CLIP_EXPORT_LIMITS.maxSeconds);

const isLab = (v: MotionLab | MotionScene): v is MotionLab => (v as MotionLab).type === 'motion-lab';
const toLab = (input: MotionLab | MotionScene): MotionLab => (isLab(input) ? input : labFromScene(input));

/**
 * Resolve requested fps and frame count into bounded values. Unknown rates snap to the nearest allowed rate;
 * frame counts are rounded and clamped. Every adjustment is reported in `notes`.
 */
export function planClipSampling(req: ClipRequest = {}, input?: MotionLab | MotionScene): ClipSampling {
  const notes: string[] = [];
  const allowed = CLIP_EXPORT_LIMITS.fps as readonly number[];
  let fps: ClipFps = CLIP_EXPORT_LIMITS.defaultFps;
  if (typeof req.fps === 'number' && Number.isFinite(req.fps)) {
    if (allowed.includes(req.fps)) fps = req.fps as ClipFps;
    else {
      const target = req.fps;
      fps = [...CLIP_EXPORT_LIMITS.fps].sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b)[0];
      notes.push(`Frame rate ${round(target, 3)} is not supported; using ${fps} fps.`);
    }
  } else if (req.fps !== undefined) notes.push(`Frame rate was not a number; using ${fps} fps.`);

  const cap = maxClipFrames(fps);
  let frames: number;
  if (typeof req.frames === 'number' && Number.isFinite(req.frames)) frames = Math.round(req.frames);
  else if (typeof req.seconds === 'number' && Number.isFinite(req.seconds)) frames = Math.round(req.seconds * fps);
  else if (input) {
    const tl = toLab(input).timeline;
    frames = Math.round((tl.frames / tl.fps) * fps);
  } else frames = 4 * fps;
  if (req.frames !== undefined && !(typeof req.frames === 'number' && Number.isFinite(req.frames))) notes.push('Frame count was not a number; using the scene duration.');
  if (frames > cap) {
    notes.push(`${frames} frames exceed the limit of ${cap} (${CLIP_EXPORT_LIMITS.maxSeconds} s at most); the clip was shortened.`);
    frames = cap;
  }
  if (frames < CLIP_EXPORT_LIMITS.minFrames) {
    notes.push(`A clip needs at least ${CLIP_EXPORT_LIMITS.minFrames} frame.`);
    frames = CLIP_EXPORT_LIMITS.minFrames;
  }
  return { fps, frames, notes };
}

/**
 * Deterministically sample a scene or lab. Frame i is taken at time i / fps; the lab timeline is evaluated at
 * that time (wrapping for loops, holding the last frame for one-shot timelines). Values are rounded to 4 places.
 */
export function sampleClip(input: MotionLab | MotionScene, req: ClipRequest = {}): MotionClip {
  const lab = toLab(input);
  const { fps, frames } = planClipSampling(req, lab);
  const tl = lab.timeline;
  const layers = lab.scene.layers.slice(0, CLIP_EXPORT_LIMITS.maxLayers);
  const out: ClipFrame[] = [];
  for (let i = 0; i < frames; i++) {
    const time = i / fps;
    let labFrame = time * tl.fps;
    if (!tl.loop) labFrame = Math.min(labFrame, tl.frames - 1);
    out.push({
      index: i,
      time: round(time, 4),
      layers: layers.map((layer) => {
        const r = resolveLayer(lab, layer, labFrame);
        const phase = mod(framePhase(labFrame, tl, layerRate(layer.speed)), TAU);
        return { id: layer.id, intensity: round(r.intensity, 4), hue: round(r.hue, 4), opacity: round(r.opacity, 4), scale: round(r.scale, 4), x: round(r.x, 4), y: round(r.y, 4), phase: round(phase, 4) };
      }),
    });
  }
  return {
    format: CLIP_FORMAT,
    version: CLIP_VERSION,
    name: lab.scene.name,
    fps,
    frameCount: frames,
    durationSeconds: round(frames / fps, 4),
    loop: tl.loop,
    background: lab.scene.background,
    properties: [...CLIP_PROPERTIES],
    layers: layers.map((l) => ({ id: l.id, kind: l.kind, seed: l.seed, speed: l.speed, baseHue: l.hue })),
    frames: out,
  };
}

/** Compact, stable JSON. Key order is fixed by sampleClip, so identical clips serialize identically. */
export const serializeClip = (clip: MotionClip): string => JSON.stringify(clip);

const cssIdent = (s: string): string => s.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'layer';
const commentSafe = (s: string): string => s.replace(/\*\//g, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').slice(0, 80);

/** CSS class (and @keyframes name) for a clip layer. The index keeps names unique if two ids sanitize alike. */
export const clipLayerClass = (index: number, id: string): string => `motion-clip-${index + 1}-${cssIdent(id)}`;

const stopBody = (s: ClipLayerSample, baseHue: number): string =>
  `opacity: ${round(s.opacity / 100, 4)}; transform: translate(${round(s.x, 3)}%, ${round(s.y, 3)}%) scale(${round(s.scale, 4)}); filter: hue-rotate(${round(s.hue - baseHue, 2)}deg);`;

/**
 * CSS @keyframes for every layer of a clip: opacity, translate/scale and a hue rotation relative to the
 * layer's base hue. Intensity and phase drive canvas drawing only and are not expressible in CSS. Frame i maps
 * to i / frameCount of the animation; the 100% stop holds the last sampled frame. Reduced motion disables it.
 */
export function clipToCss(clip: MotionClip): string {
  const n = Math.max(1, clip.frameCount);
  const lines: string[] = [
    `/* ${commentSafe(clip.name)}: ${clip.frameCount} frames at ${clip.fps} fps (${clip.durationSeconds}s${clip.loop ? ' loop' : ''}). Sampled offline by Motion Studio. */`,
    '/* Intensity and phase drive canvas drawing only; they are kept in the clip JSON. */',
  ];
  clip.layers.forEach((info, li) => {
    const name = clipLayerClass(li, info.id);
    const steps: string[] = [];
    clip.frames.forEach((f, i) => {
      const s = f.layers[li];
      if (s) steps.push(`  ${round((i / n) * 100, 3)}% { ${stopBody(s, info.baseHue)} }`);
    });
    const last = clip.frames[clip.frames.length - 1]?.layers[li];
    if (last && clip.frames.length > 0) steps.push(`  100% { ${stopBody(last, info.baseHue)} }`);
    lines.push(`@keyframes ${name} {`, ...steps, '}');
    lines.push(`.${name} { animation: ${name} ${clip.durationSeconds}s linear ${clip.loop ? 'infinite' : '1 both'}; }`);
  });
  lines.push('@media (prefers-reduced-motion: reduce) { [class*="motion-clip-"] { animation: none !important; } }');
  return lines.join('\n');
}
