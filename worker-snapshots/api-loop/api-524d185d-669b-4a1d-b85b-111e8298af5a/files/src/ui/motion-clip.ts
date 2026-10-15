/**
 * Local animation / clip export (roadmap 140).
 *
 * Everything here runs offline in the renderer. A clip spec is a small, portable JSON document that pins a
 * Motion Lab composition (scene layers, timeline and keyframe tracks), a backdrop scene id from src/ui/scenes.ts,
 * the preset it started from and the export settings, plus keyframes sampled from the procedural model.
 *
 * The spec, validator, sampler and capability probe are DOM-free and deterministic so they can be tested in Node.
 * Only the optional WebM recorder and the local save helper touch browser APIs, and both receive the environment
 * explicitly and report honestly when an API is missing. Nothing is uploaded and nothing calls IPC.
 */

import { BUILT_IN_PRESETS, LAB_PRESETS, MAX_LAYERS, SCENE_TEMPLATES, isMotionKind, layerRate, parseLab, resolveLayer, serializeLab, type MotionKind, type MotionLab } from './motion-presets';
import { TAU, clamp, framePhase, mod } from './motion-timing';
import { DEFAULT_SCENE, isKnownScene, sceneMotionAt, type SceneMotionSample } from './scenes';

/* =====================================================================================
 * Spec
 * ===================================================================================== */

export const CLIP_VERSION = 1 as const;
export const CLIP_TYPE = 'motion-clip' as const;
export const CLIP_EXPORT_FPS = [12, 24, 30, 60] as const;
export type ClipExportFps = (typeof CLIP_EXPORT_FPS)[number];
export const CLIP_SPEC_LIMITS = {
  minDurationMs: 100,
  maxDurationMs: 60_000,
  minWidth: 160,
  maxWidth: 1920,
  minHeight: 90,
  maxHeight: 1080,
} as const;
/** Keyframes are stored twice per second of clip, plus the last frame. */
export const KEYFRAMES_PER_SECOND = 2;
export const MAX_CLIP_KEYFRAMES = (CLIP_SPEC_LIMITS.maxDurationMs / 1000) * KEYFRAMES_PER_SECOND + 1;
export const MAX_CLIP_BYTES = 512 * 1024;
export const CUSTOM_PRESET_ID = 'custom';

export type LayerSnapshot = {
  id: string;
  kind: MotionKind;
  intensity: number;
  hue: number;
  opacity: number;
  /** 1 = 100% */
  scale: number;
  /** Offset in % of width / height. */
  x: number;
  y: number;
  /** Motion phase in radians, 0..TAU. */
  phase: number;
};

export type ClipKeyframe = { frame: number; timeMs: number; scene: SceneMotionSample; layers: LayerSnapshot[] };
export type FrameSnapshot = ClipKeyframe & { /** Fractional Lab frame the snapshot was evaluated at; used for drawing. */ labFrame: number };

export type ClipSpec = {
  version: typeof CLIP_VERSION;
  type: typeof CLIP_TYPE;
  sceneId: string;
  presetId: string;
  durationMs: number;
  fps: ClipExportFps;
  width: number;
  height: number;
  /** Whether reduced motion was on when the clip was made. Informational; export works either way. */
  reducedMotion: boolean;
  /** The composition that is sampled. Validated with parseLab on import. */
  lab: MotionLab;
  keyframes: ClipKeyframe[];
};

export type ClipSettings = Omit<ClipSpec, 'version' | 'type' | 'keyframes'>;
type SampleSource = Pick<ClipSpec, 'sceneId' | 'fps' | 'lab' | 'durationMs'>;

export type ClipParse = { ok: true; spec: ClipSpec; issues: string[] } | { ok: false; error: string };

export const isClipFps = (v: unknown): v is ClipExportFps => typeof v === 'number' && (CLIP_EXPORT_FPS as readonly number[]).includes(v);

/** Preset ids a clip may reference: built-in presets, scene templates, Lab presets, or "custom". */
export const CLIP_PRESET_IDS: readonly string[] = [CUSTOM_PRESET_ID, ...BUILT_IN_PRESETS.map((p) => p.id), ...SCENE_TEMPLATES.map((s) => s.id), ...LAB_PRESETS.map((p) => p.id)];
export const isClipPresetId = (v: unknown): v is string => typeof v === 'string' && CLIP_PRESET_IDS.includes(v);

/** Total frames a clip renders: duration × fps, rounded, at least one. */
export const clipTotalFrames = (s: Pick<ClipSpec, 'durationMs' | 'fps'>): number => Math.max(1, Math.round((s.durationMs * s.fps) / 1000));

/** Frame indices that carry keyframes: every fps/KEYFRAMES_PER_SECOND frames and always the last frame. */
export function keyframeIndices(s: Pick<ClipSpec, 'durationMs' | 'fps'>): number[] {
  const total = clipTotalFrames(s);
  const stride = Math.max(1, Math.round(s.fps / KEYFRAMES_PER_SECOND));
  const out: number[] = [];
  for (let n = 0; n < total; n += stride) out.push(n);
  if (out[out.length - 1] !== total - 1) out.push(total - 1);
  return out;
}

/** Round to 4 decimals and fold -0 into 0, so JSON round trips compare equal. */
const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;

/** Lab frame (fractional) shown at clip time t. Looping timelines wrap, one-shot timelines hold the last frame. */
export function labFrameAt(lab: MotionLab, seconds: number): number {
  const f = seconds * lab.timeline.fps;
  return lab.timeline.loop ? mod(f, lab.timeline.frames) : clamp(f, 0, lab.timeline.frames - 1);
}

/**
 * Deterministic snapshot of frame n: the scene is evaluated at t = n / fps. No clock, no randomness and no state,
 * so frame n is the same whether it is sampled alone or as part of a full run.
 */
export function sampleFrame(s: Pick<ClipSpec, 'sceneId' | 'fps' | 'lab'>, n: number): FrameSnapshot {
  const frame = Math.max(0, Math.trunc(n));
  const seconds = frame / s.fps;
  const labFrame = labFrameAt(s.lab, seconds);
  const scene = sceneMotionAt(s.sceneId, seconds) ?? (sceneMotionAt(DEFAULT_SCENE, seconds) as SceneMotionSample);
  const layers: LayerSnapshot[] = s.lab.scene.layers.map((layer) => {
    const r = resolveLayer(s.lab, layer, labFrame);
    const phase = mod(framePhase(labFrame, s.lab.timeline, layerRate(layer.speed)), TAU);
    return { id: layer.id, kind: layer.kind, intensity: r4(r.intensity), hue: r4(r.hue), opacity: r4(r.opacity), scale: r4(r.scale), x: r4(r.x), y: r4(r.y), phase: r4(phase) };
  });
  return { frame, timeMs: r4((frame * 1000) / s.fps), scene, layers, labFrame };
}

const toKeyframe = (f: FrameSnapshot): ClipKeyframe => ({ frame: f.frame, timeMs: f.timeMs, scene: f.scene, layers: f.layers });

export function clipKeyframes(s: SampleSource): ClipKeyframe[] {
  return keyframeIndices(s).map((n) => toKeyframe(sampleFrame(s, n)));
}

/** Structural and range checks shared by build and parse. Returns the first problem, or null when valid. */
export function validateClipSettings(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Clip must be a JSON object.';
  const o = input as Record<string, unknown>;
  if (typeof o.sceneId !== 'string' || !isKnownScene(o.sceneId)) return `Unknown scene id "${String(o.sceneId).slice(0, 40)}".`;
  if (!isClipPresetId(o.presetId)) return `Unknown preset id "${String(o.presetId).slice(0, 40)}".`;
  if (!isClipFps(o.fps)) return `Frame rate ${String(o.fps).slice(0, 12)} is not allowed; use ${CLIP_EXPORT_FPS.join(', ')} fps.`;
  if (typeof o.durationMs !== 'number' || !Number.isInteger(o.durationMs)) return 'Duration must be a whole number of milliseconds.';
  if (o.durationMs < CLIP_SPEC_LIMITS.minDurationMs) return `Duration must be at least ${CLIP_SPEC_LIMITS.minDurationMs} ms.`;
  if (o.durationMs > CLIP_SPEC_LIMITS.maxDurationMs) return `Duration is over ${CLIP_SPEC_LIMITS.maxDurationMs / 1000} s.`;
  const dims: [string, string, number, number][] = [
    ['width', 'Width', CLIP_SPEC_LIMITS.minWidth, CLIP_SPEC_LIMITS.maxWidth],
    ['height', 'Height', CLIP_SPEC_LIMITS.minHeight, CLIP_SPEC_LIMITS.maxHeight],
  ];
  for (const [k, label, lo, hi] of dims) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) return `${label} must be a whole number from ${lo} to ${hi} px.`;
  }
  if (typeof o.reducedMotion !== 'boolean') return 'reducedMotion must be true or false.';
  return null;
}

/** Build a complete spec from editor settings; keyframes are sampled from the model. Throws on invalid settings. */
export function buildClipSpec(settings: ClipSettings): ClipSpec {
  const problem = validateClipSettings(settings);
  if (problem) throw new Error(problem);
  const lab = parseLab(JSON.parse(serializeLab(settings.lab)));
  if (!lab.ok) throw new Error(`Composition: ${lab.error}`);
  const base = { sceneId: settings.sceneId, presetId: settings.presetId, durationMs: settings.durationMs, fps: settings.fps, width: settings.width, height: settings.height, reducedMotion: settings.reducedMotion, lab: lab.lab };
  return { version: CLIP_VERSION, type: CLIP_TYPE, ...base, keyframes: clipKeyframes(base) };
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function keyframeProblem(raw: unknown, total: number): string | null {
  if (!Array.isArray(raw)) return 'Keyframes must be a list.';
  if (raw.length === 0) return 'Clip has no keyframes.';
  if (raw.length > MAX_CLIP_KEYFRAMES) return `Clip has more than ${MAX_CLIP_KEYFRAMES} keyframes.`;
  let last = -1;
  for (const [i, k] of raw.entries()) {
    if (!k || typeof k !== 'object' || Array.isArray(k)) return `Keyframe ${i + 1} is not an object.`;
    const o = k as Record<string, unknown>;
    if (typeof o.frame !== 'number' || !Number.isInteger(o.frame) || o.frame < 0 || o.frame >= total) return `Keyframe ${i + 1} frame is outside the clip.`;
    if (o.frame <= last) return `Keyframe ${i + 1} is out of order.`;
    last = o.frame;
    if (!isFiniteNum(o.timeMs)) return `Keyframe ${i + 1} time is not a number.`;
    const sc = o.scene && typeof o.scene === 'object' ? (o.scene as Record<string, unknown>) : null;
    if (!sc || !['driftX', 'driftY', 'rotation', 'glow', 'hue'].every((f) => isFiniteNum(sc[f]))) return `Keyframe ${i + 1} scene values are malformed.`;
    if (!Array.isArray(o.layers) || o.layers.length === 0 || o.layers.length > MAX_LAYERS) return `Keyframe ${i + 1} layers are malformed.`;
    for (const l of o.layers) {
      const lo = l && typeof l === 'object' ? (l as Record<string, unknown>) : null;
      if (!lo || typeof lo.id !== 'string' || !isMotionKind(lo.kind)) return `Keyframe ${i + 1} has a malformed layer.`;
      if (!['intensity', 'hue', 'opacity', 'scale', 'x', 'y', 'phase'].every((f) => isFiniteNum(lo[f]))) return `Keyframe ${i + 1} has a non-numeric layer value.`;
    }
  }
  return null;
}

/**
 * Strict clip validator for files and pastes. Malformed structure, unknown versions, disallowed fps, durations over
 * 60 s, unknown scene or preset ids and broken compositions are rejected. Keyframes are derived data: after they
 * pass the structural check they are re-sampled from the composition, and a mismatch is reported as an issue.
 */
export function parseClip(input: unknown): ClipParse {
  let raw = input;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).length > MAX_CLIP_BYTES) return { ok: false, error: `Clip is larger than ${MAX_CLIP_BYTES / 1024} KB.` };
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Clip is not valid JSON.' };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Clip must be a JSON object.' };
  const o = raw as Record<string, unknown>;
  if (o.type !== CLIP_TYPE) return { ok: false, error: 'This is not a motion clip (type must be "motion-clip").' };
  if (o.version !== CLIP_VERSION) return { ok: false, error: `Unsupported clip version ${String(o.version).slice(0, 12)}; this build reads version ${CLIP_VERSION}.` };
  const problem = validateClipSettings(o);
  if (problem) return { ok: false, error: problem };
  if (!o.lab || typeof o.lab !== 'object' || (o.lab as Record<string, unknown>).type !== 'motion-lab') return { ok: false, error: 'Clip has no Motion Lab composition.' };
  const lab = parseLab(o.lab);
  if (!lab.ok) return { ok: false, error: `Composition: ${lab.error}` };
  const settings = {
    sceneId: o.sceneId as string,
    presetId: o.presetId as string,
    durationMs: o.durationMs as number,
    fps: o.fps as ClipExportFps,
    width: o.width as number,
    height: o.height as number,
    reducedMotion: o.reducedMotion as boolean,
    lab: lab.lab,
  };
  const kp = keyframeProblem(o.keyframes, clipTotalFrames(settings));
  if (kp) return { ok: false, error: kp };
  const issues = [...lab.issues];
  const keyframes = clipKeyframes(settings);
  if (JSON.stringify(keyframes) !== JSON.stringify(o.keyframes)) issues.push('Stored keyframes did not match this composition and were re-sampled.');
  return { ok: true, spec: { version: CLIP_VERSION, type: CLIP_TYPE, ...settings, keyframes }, issues };
}

/** Compact JSON with a fixed key order, so the same spec always serializes to the same bytes. */
export function serializeClip(spec: ClipSpec): string {
  return JSON.stringify({
    version: CLIP_VERSION,
    type: CLIP_TYPE,
    sceneId: spec.sceneId,
    presetId: spec.presetId,
    durationMs: spec.durationMs,
    fps: spec.fps,
    width: spec.width,
    height: spec.height,
    reducedMotion: spec.reducedMotion,
    lab: JSON.parse(serializeLab(spec.lab)),
    keyframes: spec.keyframes.map((k) => ({
      frame: k.frame,
      timeMs: k.timeMs,
      scene: { driftX: k.scene.driftX, driftY: k.scene.driftY, rotation: k.scene.rotation, glow: k.scene.glow, hue: k.scene.hue },
      layers: k.layers.map((l) => ({ id: l.id, kind: l.kind, intensity: l.intensity, hue: l.hue, opacity: l.opacity, scale: l.scale, x: l.x, y: l.y, phase: l.phase })),
    })),
  });
}

export function describeClip(spec: ClipSpec): string {
  return `${spec.lab.scene.name}: ${clipTotalFrames(spec)} frames at ${spec.fps} fps (${spec.durationMs / 1000} s), ${spec.width}×${spec.height}`;
}

/* =====================================================================================
 * Sampler with cancellation and real progress
 * ===================================================================================== */

/** Anything with an `aborted` flag; an AbortSignal works too. */
export type AbortToken = { readonly aborted: boolean };
export type AbortHandle = { token: AbortToken; abort: () => void };

export function createAbortToken(): AbortHandle {
  const state = { aborted: false };
  return {
    token: {
      get aborted() {
        return state.aborted;
      },
    },
    abort: () => {
      state.aborted = true;
    },
  };
}

export type SampleProgress = { done: number; total: number };
export type SampleOptions = {
  signal?: AbortToken;
  /** Called after each batch and once at the end, with real frame counts. */
  onProgress?: (p: SampleProgress) => void;
  /** Called for every frame in order; may be async (e.g. to pace a recorder). */
  onFrame?: (snapshot: FrameSnapshot) => void | Promise<void>;
  /** Frames evaluated between progress reports and yields to the event loop. */
  batchSize?: number;
  /** How to yield between batches; defaults to a zero timeout. */
  yieldFn?: () => Promise<void>;
  /** Keep every snapshot in the result (default true). Turn off for long recordings. */
  keep?: boolean;
};
export type SampleResult = { status: 'complete' | 'cancelled'; done: number; total: number; frames: FrameSnapshot[] };

const defaultYield = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Evaluate every frame n = 0..total-1 at t = n / fps, in order. Stops before the next frame once the token aborts. */
export async function sampleClipFrames(spec: SampleSource, options: SampleOptions = {}): Promise<SampleResult> {
  const total = clipTotalFrames(spec);
  const batch = Math.max(1, Math.trunc(options.batchSize ?? 30));
  const yieldFn = options.yieldFn ?? defaultYield;
  const keep = options.keep !== false;
  const frames: FrameSnapshot[] = [];
  let done = 0;
  const report = () => options.onProgress?.({ done, total });
  while (done < total) {
    if (options.signal?.aborted) {
      report();
      return { status: 'cancelled', done, total, frames };
    }
    const snap = sampleFrame(spec, done);
    if (options.onFrame) await options.onFrame(snap);
    if (keep) frames.push(snap);
    done++;
    if (done % batch === 0 && done < total) {
      report();
      await yieldFn();
    }
  }
  report();
  return { status: 'complete', done, total, frames };
}

/* =====================================================================================
 * Capability probe
 * ===================================================================================== */

export type CapabilityStatus = 'supported' | 'unsupported';
export type ClipCapabilities = {
  canvas: CapabilityStatus;
  canvasCapture: CapabilityStatus;
  mediaRecorder: CapabilityStatus;
  webm: CapabilityStatus;
  webmMime: string | null;
  formats: ('json' | 'webm')[];
  summary: string;
  reasons: string[];
};

/** The subset of the environment the probe and recorder look at. Pass `{}` to simulate a runtime with no DOM. */
export type ClipEnv = {
  document?: unknown;
  HTMLCanvasElement?: unknown;
  MediaRecorder?: unknown;
  URL?: unknown;
  setTimeout?: unknown;
};

type DocLike = { createElement: (tag: string) => unknown; body?: { appendChild?: (n: unknown) => unknown } | null };
type UrlLike = { createObjectURL: (b: Blob) => string; revokeObjectURL?: (u: string) => void };

export const WEBM_MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'] as const;

const docOf = (env: ClipEnv): DocLike | null => {
  const d = env.document as Partial<DocLike> | undefined | null;
  return d && typeof d.createElement === 'function' ? (d as DocLike) : null;
};

/** Honest per-API status. Never throws; environments without canvas capture or a WebM encoder get "JSON clip only". */
export function probeClipCapabilities(env: ClipEnv = globalThis as unknown as ClipEnv): ClipCapabilities {
  const reasons: string[] = [];
  const canvas: CapabilityStatus = docOf(env) && typeof env.HTMLCanvasElement === 'function' ? 'supported' : 'unsupported';
  if (canvas === 'unsupported') reasons.push('No DOM canvas in this environment.');
  let canvasCapture: CapabilityStatus = 'unsupported';
  try {
    const proto = canvas === 'supported' ? ((env.HTMLCanvasElement as { prototype?: { captureStream?: unknown } }).prototype ?? null) : null;
    if (proto && typeof proto.captureStream === 'function') canvasCapture = 'supported';
  } catch {
    canvasCapture = 'unsupported';
  }
  if (canvas === 'supported' && canvasCapture === 'unsupported') reasons.push('Canvas stream capture is not available.');
  const rawRecorder: unknown = env.MediaRecorder;
  const mediaRecorder: CapabilityStatus = typeof rawRecorder === 'function' ? 'supported' : 'unsupported';
  if (mediaRecorder === 'unsupported') reasons.push('MediaRecorder is not available.');
  let webmMime: string | null = null;
  if (mediaRecorder === 'supported') {
    const isTypeSupported = (rawRecorder as { isTypeSupported?: unknown }).isTypeSupported;
    if (typeof isTypeSupported === 'function') {
      for (const m of WEBM_MIME_CANDIDATES) {
        try {
          if ((rawRecorder as { isTypeSupported: (x: string) => boolean }).isTypeSupported(m)) {
            webmMime = m;
            break;
          }
        } catch {
          /* treated as unsupported */
        }
      }
    }
    if (!webmMime) reasons.push('No WebM encoder is available.');
  }
  const webm: CapabilityStatus = webmMime && canvasCapture === 'supported' ? 'supported' : 'unsupported';
  return {
    canvas,
    canvasCapture,
    mediaRecorder,
    webm,
    webmMime: webm === 'supported' ? webmMime : null,
    formats: webm === 'supported' ? ['json', 'webm'] : ['json'],
    summary: webm === 'supported' ? 'WebM video and JSON clip' : 'JSON clip only',
    reasons,
  };
}

/* =====================================================================================
 * Export helpers
 * ===================================================================================== */

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Safe local file name: no paths, control or reserved characters, bounded length, fixed extension. */
export function sanitizeClipFileName(name: unknown, ext: 'clip.json' | 'webm'): string {
  const base = (typeof name === 'string' ? name : '')
    .replace(/\.(clip\.json|json|webm)$/i, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .toLowerCase()
    .slice(0, 60)
    .replace(/[-_]+$/g, '');
  const safe = !base ? 'motion-clip' : RESERVED.test(base) ? `clip-${base}` : base;
  return `${safe}.${ext}`;
}

export function clipJsonBlob(spec: ClipSpec): Blob {
  return new Blob([serializeClip(spec)], { type: 'application/json' });
}

/** Byte size in a short human form. */
export function formatBytes(n: number): string {
  if (!(n >= 0)) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Hand a blob to the browser download flow through a temporary object URL anchor. The user chooses where it goes.
 * Returns false when this runtime cannot do that (no DOM or no object URLs). The name is re-sanitized here.
 */
export function saveBlobLocally(blob: Blob, fileName: string, env: ClipEnv = globalThis as unknown as ClipEnv): boolean {
  const doc = docOf(env);
  const url = env.URL as Partial<UrlLike> | undefined | null;
  if (!doc || !url || typeof url.createObjectURL !== 'function') return false;
  const ext = /\.webm$/i.test(fileName) ? 'webm' : 'clip.json';
  const href = url.createObjectURL(blob);
  const a = doc.createElement('a') as { href: string; download: string; rel: string; click: () => void; remove: () => void };
  a.href = href;
  a.download = sanitizeClipFileName(fileName, ext);
  a.rel = 'noopener';
  doc.body?.appendChild?.(a);
  a.click();
  a.remove();
  const revoke = () => url.revokeObjectURL?.(href);
  if (typeof env.setTimeout === 'function') (env.setTimeout as (fn: () => void, ms: number) => unknown)(revoke, 1000);
  else revoke();
  return true;
}

export type WebmResult =
  | { ok: true; blob: Blob; mime: string; frames: number; total: number }
  | { ok: false; cancelled: boolean; reason: string; frames: number; total: number };

type TrackLike = { stop: () => void; requestFrame?: () => void };
type MediaStreamLike = { getTracks: () => TrackLike[]; getVideoTracks?: () => TrackLike[] };
type CanvasLike = { getContext: (k: '2d') => unknown; width: number; height: number; captureStream: (fps?: number) => MediaStreamLike };
type RecorderLike = { state: string; start: (ms?: number) => void; stop: () => void; ondataavailable: ((e: { data: Blob }) => void) | null; onstop: (() => void) | null; onerror: (() => void) | null };

/**
 * Render a clip to WebM with MediaRecorder on a detached canvas (an OffscreenCanvas cannot be captured as a stream).
 * Frames are drawn in order with `draw` and paced at 1/fps of real time, because MediaRecorder timestamps follow the
 * wall clock; the export takes about as long as the clip and timing can still jitter. Cancelling stops the recorder
 * and discards the data.
 */
export async function recordClipWebm(
  spec: ClipSpec,
  draw: (ctx: unknown, snapshot: FrameSnapshot, width: number, height: number) => void,
  options: { signal?: AbortToken; onProgress?: (p: SampleProgress) => void; env?: ClipEnv; pace?: (ms: number) => Promise<void> } = {},
): Promise<WebmResult> {
  const env = options.env ?? (globalThis as unknown as ClipEnv);
  const total = clipTotalFrames(spec);
  const caps = probeClipCapabilities(env);
  const doc = docOf(env);
  if (caps.webm !== 'supported' || !caps.webmMime || !doc) return { ok: false, cancelled: false, reason: `WebM is unavailable here (${caps.reasons.join(' ') || 'unsupported'}). JSON clip only.`, frames: 0, total };
  const mime = caps.webmMime;
  const canvas = doc.createElement('canvas') as CanvasLike;
  canvas.width = spec.width;
  canvas.height = spec.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { ok: false, cancelled: false, reason: 'A 2D canvas context could not be created.', frames: 0, total };
  let stream: MediaStreamLike;
  try {
    stream = canvas.captureStream(0);
  } catch {
    return { ok: false, cancelled: false, reason: 'The canvas could not start a capture stream.', frames: 0, total };
  }
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  let rec: RecorderLike;
  try {
    rec = new (env.MediaRecorder as new (s: unknown, o: unknown) => RecorderLike)(stream, { mimeType: mime });
  } catch {
    stopTracks();
    return { ok: false, cancelled: false, reason: 'The recorder could not be created.', frames: 0, total };
  }
  const chunks: Blob[] = [];
  let failed = false;
  let resolveStop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  rec.onstop = () => resolveStop();
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.onerror = () => {
    failed = true;
  };
  const video = (stream.getVideoTracks?.() ?? stream.getTracks())[0];
  const pace = options.pace ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const userSignal = options.signal;
  let result: SampleResult = { status: 'cancelled', done: 0, total, frames: [] };
  try {
    rec.start(250);
    result = await sampleClipFrames(spec, {
      signal: {
        get aborted() {
          return Boolean(userSignal?.aborted) || failed;
        },
      },
      onProgress: options.onProgress,
      keep: false,
      batchSize: 1,
      yieldFn: () => Promise.resolve(),
      onFrame: async (snap) => {
        draw(ctx, snap, spec.width, spec.height);
        video?.requestFrame?.();
        await pace(1000 / spec.fps);
      },
    });
  } catch {
    failed = true;
  } finally {
    try {
      if (rec.state !== 'inactive') rec.stop();
      else resolveStop();
    } catch {
      resolveStop();
    }
  }
  await stopped;
  stopTracks();
  rec.ondataavailable = null;
  rec.onerror = null;
  rec.onstop = null;
  if (failed) return { ok: false, cancelled: false, reason: 'The recorder failed; no clip was produced.', frames: result.done, total };
  if (result.status === 'cancelled') return { ok: false, cancelled: true, reason: 'Export cancelled; nothing was kept.', frames: result.done, total };
  if (chunks.length === 0) return { ok: false, cancelled: false, reason: 'The recorder produced no data.', frames: result.done, total };
  return { ok: true, blob: new Blob(chunks, { type: mime }), mime, frames: result.done, total };
}
