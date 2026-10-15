/**
 * Scene 3D studio model and renderer. Pure, offline and dependency free.
 *
 * Every frame is a function of (config, time): camera, orbs, planes, particles and lights are all derived from the
 * scene config, a seed and the loop time. The same time always gives the same frame, which makes exported frames and
 * contact sheets reproducible and loop seams inspectable. The GPU path is hand written WebGL2 / GLSL ES 3.00 (no
 * library, no CDN, no remote media). When no context is available the same frame description is drawn as a static
 * SVG by fallbackSvg, clearly marked as a non-GPU preview.
 *
 * This module never touches the DOM, the clock, storage or Math.random. The renderer only receives a WebGL2 context
 * object; the React component (src/components/Scene3D.tsx) owns the canvas, visibility, exports and persistence.
 * Matrix, hashing and colour helpers follow the shared math used by the earlier scene3d draft.
 */

export const SCENE3D_VERSION = 1 as const;
export const SCENE3D_PREF_KEY = 'scene3d.studio';

/* ------------------------------------------------------------------ hard limits ------------------------------------------------------------------ */

/** Upper bounds compiled into the shaders and buffers; quality profiles and user limits may only lower them. */
export const GL_LIMITS = Object.freeze({
  maxOrbs: 24,
  maxPlanes: 3,
  maxParticles: 4000,
  /** Largest per-fragment contact shadow loop (one iteration per orb considered). */
  maxShadowOrbs: 24,
  maxDpr: 2,
  minDpr: 0.5,
  /** Largest canvas edge in device pixels the renderer will allocate. */
  maxEdge: 2048,
  /** Longest simulated step between two frames; a hidden tab never "catches up" with a jump. */
  maxFrameS: 0.05,
  /** Loop length used by the scrubber, export and contact sheet. */
  loopSeconds: 12,
  maxSphereSegments: 32,
  /** Contact sheet bounds (tiles and device pixels per edge). */
  maxSheetTiles: 16,
  maxSheetEdge: 2048,
});
export const LOOP_SECONDS = GL_LIMITS.loopSeconds;

export type QualityId = 'low' | 'balanced' | 'high';
export type QualityProfile = {
  id: QualityId;
  name: string;
  hint: string;
  maxDpr: number;
  maxOrbs: number;
  maxParticles: number;
  sphereSegments: number;
  shadowOrbs: number;
  antialias: boolean;
  /** Frames per second cap while playing. */
  maxFps: number;
};

export const QUALITY_PROFILES: Record<QualityId, QualityProfile> = {
  low: { id: 'low', name: 'Low', hint: '1x pixels, 8 orbs, 600 particles, 30 fps cap', maxDpr: 1, maxOrbs: 8, maxParticles: 600, sphereSegments: 12, shadowOrbs: 4, antialias: false, maxFps: 30 },
  balanced: { id: 'balanced', name: 'Balanced', hint: '1.5x pixels, 16 orbs, 2000 particles, 60 fps cap', maxDpr: 1.5, maxOrbs: 16, maxParticles: 2000, sphereSegments: 20, shadowOrbs: 12, antialias: true, maxFps: 60 },
  high: { id: 'high', name: 'High', hint: '2x pixels, 24 orbs, 4000 particles, 60 fps cap', maxDpr: 2, maxOrbs: 24, maxParticles: 4000, sphereSegments: 28, shadowOrbs: 24, antialias: true, maxFps: 60 },
};
export const QUALITY_IDS: readonly QualityId[] = ['low', 'balanced', 'high'];

/* ------------------------------------------------------------------ configuration ------------------------------------------------------------------ */

export type CameraConfig = { yaw: number; pitch: number; distance: number; fov: number; autoOrbit: boolean };
export type MaterialConfig = { hue: number; saturation: number; roughness: number; metal: number };
export type LightingConfig = { key: number; fill: number; ambient: number; azimuth: number; elevation: number; fog: number };
export type ObjectsConfig = { orbs: number; planes: number; particles: number };
export type MotionConfig = { speed: number; seed: number };
/** User resource limits applied on top of the quality profile. */
export type LimitsConfig = { fps: number; dpr: number };
export type SceneConfig = {
  version: 1;
  camera: CameraConfig;
  material: MaterialConfig;
  lighting: LightingConfig;
  objects: ObjectsConfig;
  motion: MotionConfig;
  limits: LimitsConfig;
  quality: QualityId;
};

export type Range = { min: number; max: number; step?: number };
/** Every numeric field with its inclusive range. The UI reads slider bounds from here. */
export const LIMITS = Object.freeze({
  camera: { yaw: { min: 0, max: 360 }, pitch: { min: -10, max: 80 }, distance: { min: 2, max: 14, step: 0.1 }, fov: { min: 25, max: 100 } },
  material: { hue: { min: 0, max: 360 }, saturation: { min: 0, max: 100 }, roughness: { min: 0, max: 100 }, metal: { min: 0, max: 100 } },
  lighting: { key: { min: 0, max: 200 }, fill: { min: 0, max: 100 }, ambient: { min: 0, max: 100 }, azimuth: { min: 0, max: 360 }, elevation: { min: 5, max: 85 }, fog: { min: 0, max: 100 } },
  objects: { orbs: { min: 0, max: GL_LIMITS.maxOrbs }, planes: { min: 0, max: GL_LIMITS.maxPlanes }, particles: { min: 0, max: GL_LIMITS.maxParticles, step: 50 } },
  motion: { speed: { min: 0, max: 200 }, seed: { min: 0, max: 9999 } },
  limits: { fps: { min: 10, max: 60 }, dpr: { min: GL_LIMITS.minDpr, max: GL_LIMITS.maxDpr, step: 0.25 } },
} satisfies Record<string, Record<string, Range>>);

export const DEFAULT_SCENE: SceneConfig = Object.freeze({
  version: 1,
  camera: { yaw: 35, pitch: 22, distance: 7, fov: 55, autoOrbit: true },
  material: { hue: 210, saturation: 70, roughness: 45, metal: 20 },
  lighting: { key: 110, fill: 35, ambient: 18, azimuth: 300, elevation: 50, fog: 30 },
  objects: { orbs: 9, planes: 1, particles: 900 },
  motion: { speed: 100, seed: 42 },
  limits: { fps: 60, dpr: 2 },
  quality: 'balanced',
}) as SceneConfig;

const clampNum = (raw: unknown, range: Range, fallback: number): number => {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  const snapped = range.step ? Math.round(n / range.step) * range.step : Math.round(n);
  const fixed = range.step && range.step < 1 ? Number(snapped.toFixed(3)) : snapped;
  return Math.min(range.max, Math.max(range.min, fixed));
};
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function normalizeGroup<T extends Record<string, number>>(raw: unknown, ranges: Record<keyof T, Range>, fallback: T): T {
  const r = asRecord(raw);
  const out = { ...fallback };
  for (const key of Object.keys(ranges) as (keyof T)[]) out[key] = clampNum(r[key as string], ranges[key], fallback[key]) as T[keyof T];
  return out;
}

/** Accepts anything (stored preference, pasted JSON, partial objects) and returns a complete, in-range config. */
export function normalizeScene(raw: unknown, fallback: SceneConfig = DEFAULT_SCENE): SceneConfig {
  const r = asRecord(raw);
  const cam = asRecord(r.camera);
  const camera: CameraConfig = {
    ...normalizeGroup(cam, LIMITS.camera, { yaw: fallback.camera.yaw, pitch: fallback.camera.pitch, distance: fallback.camera.distance, fov: fallback.camera.fov }),
    autoOrbit: typeof cam.autoOrbit === 'boolean' ? cam.autoOrbit : fallback.camera.autoOrbit,
  };
  const quality = QUALITY_IDS.includes(r.quality as QualityId) ? (r.quality as QualityId) : fallback.quality;
  return {
    version: 1,
    camera,
    material: normalizeGroup(r.material, LIMITS.material, fallback.material),
    lighting: normalizeGroup(r.lighting, LIMITS.lighting, fallback.lighting),
    objects: normalizeGroup(r.objects, LIMITS.objects, fallback.objects),
    motion: normalizeGroup(r.motion, LIMITS.motion, fallback.motion),
    limits: normalizeGroup(r.limits, LIMITS.limits, fallback.limits),
    quality,
  };
}

export const MAX_SCENE_BYTES = 16 * 1024;
export type SceneParse = { ok: true; scene: SceneConfig } | { ok: false; error: string };
/** Parses scene JSON from any source. Only plain data is read; nothing is executed. */
export function parseSceneJson(text: unknown): SceneParse {
  if (typeof text !== 'string') return { ok: false, error: 'Scene must be JSON text.' };
  const clean = text.replace(/^﻿/, '').trim();
  if (!clean) return { ok: false, error: 'Scene JSON is empty.' };
  if (new TextEncoder().encode(text).byteLength > MAX_SCENE_BYTES) return { ok: false, error: `Scene JSON exceeds ${MAX_SCENE_BYTES / 1024} KB.` };
  let data: unknown;
  try {
    data = JSON.parse(clean);
  } catch {
    return { ok: false, error: 'Scene JSON could not be parsed.' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'Scene JSON must be an object.' };
  const version = (data as { version?: unknown }).version;
  if (version !== undefined && version !== SCENE3D_VERSION) return { ok: false, error: `Unsupported scene version ${String(version)}.` };
  return { ok: true, scene: normalizeScene(data) };
}
export const serializeScene = (scene: SceneConfig): string => JSON.stringify(normalizeScene(scene), null, 2);

/** Counts actually rendered after the quality profile caps are applied. */
export function effectiveCounts(scene: SceneConfig): ObjectsConfig & { shadowOrbs: number; sphereSegments: number; triangles: number } {
  const q = QUALITY_PROFILES[scene.quality];
  const orbs = Math.min(scene.objects.orbs, q.maxOrbs, GL_LIMITS.maxOrbs);
  const planes = Math.min(scene.objects.planes, GL_LIMITS.maxPlanes);
  const particles = Math.min(scene.objects.particles, q.maxParticles, GL_LIMITS.maxParticles);
  const sphereSegments = Math.min(q.sphereSegments, GL_LIMITS.maxSphereSegments);
  return {
    orbs,
    planes,
    particles,
    shadowOrbs: Math.min(q.shadowOrbs, GL_LIMITS.maxShadowOrbs, orbs),
    sphereSegments,
    triangles: orbs * sphereSegments * sphereSegments * 2 * 2 + planes * 2,
  };
}

/** Effective frame cap and pixel ratio: the stricter of the quality profile and the user limits. */
export const effectiveFps = (scene: SceneConfig): number => Math.max(LIMITS.limits.fps.min, Math.min(QUALITY_PROFILES[scene.quality].maxFps, scene.limits.fps));
export const effectiveFrameMs = (scene: SceneConfig): number => 1000 / effectiveFps(scene);
export function pickDpr(devicePixelRatio: unknown, scene: SceneConfig): number {
  const dpr = typeof devicePixelRatio === 'number' && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.max(GL_LIMITS.minDpr, Math.min(dpr, QUALITY_PROFILES[scene.quality].maxDpr, scene.limits.dpr, GL_LIMITS.maxDpr));
}
/** Device pixel size for a CSS box, never exceeding GL_LIMITS.maxEdge on either side and never below 1x1. */
export function fitCanvas(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  dpr = Number.isFinite(dpr) ? Math.max(GL_LIMITS.minDpr, Math.min(GL_LIMITS.maxDpr, dpr)) : 1;
  const w0 = Math.max(1, Math.round(Math.min(GL_LIMITS.maxEdge * 2, Number.isFinite(cssWidth) ? cssWidth : 1) * dpr));
  const h0 = Math.max(1, Math.round(Math.min(GL_LIMITS.maxEdge * 2, Number.isFinite(cssHeight) ? cssHeight : 1) * dpr));
  const scale = Math.min(1, GL_LIMITS.maxEdge / Math.max(w0, h0));
  return { width: Math.max(1, Math.floor(w0 * scale)), height: Math.max(1, Math.floor(h0 * scale)) };
}

export type ScenePreset = { id: string; name: string; hint: string; scene: SceneConfig };
export const SCENE_PRESETS: readonly ScenePreset[] = Object.freeze([
  { id: 'orbit-garden', name: 'Orbit garden', hint: 'Nine orbs over a lit floor with drifting particles.', scene: DEFAULT_SCENE },
  { id: 'studio-wall', name: 'Studio wall', hint: 'Three planes, warm key light, matte material.', scene: normalizeScene({ camera: { yaw: 320, pitch: 14, distance: 8.5, fov: 48, autoOrbit: false }, material: { hue: 28, saturation: 55, roughness: 80, metal: 5 }, lighting: { key: 140, fill: 25, ambient: 22, azimuth: 40, elevation: 40, fog: 15 }, objects: { orbs: 6, planes: 3, particles: 300 }, motion: { speed: 50, seed: 7 }, quality: 'balanced' }) },
  { id: 'cold-dust', name: 'Cold dust', hint: 'Many particles, few orbs, deep fog.', scene: normalizeScene({ camera: { yaw: 90, pitch: 30, distance: 10, fov: 65, autoOrbit: true }, material: { hue: 190, saturation: 80, roughness: 25, metal: 60 }, lighting: { key: 90, fill: 50, ambient: 10, azimuth: 200, elevation: 70, fog: 75 }, objects: { orbs: 3, planes: 1, particles: 3000 }, motion: { speed: 150, seed: 1234 }, quality: 'high' }) },
  { id: 'quiet-still', name: 'Quiet still', hint: 'Low cost profile for small screens and reduced motion.', scene: normalizeScene({ camera: { yaw: 20, pitch: 18, distance: 6, fov: 50, autoOrbit: false }, material: { hue: 265, saturation: 45, roughness: 60, metal: 10 }, lighting: { key: 100, fill: 40, ambient: 30, azimuth: 330, elevation: 55, fog: 20 }, objects: { orbs: 4, planes: 1, particles: 0 }, motion: { speed: 0, seed: 3 }, limits: { fps: 30, dpr: 1 }, quality: 'low' }) },
]);

/* ------------------------------------------------------------------ small math ------------------------------------------------------------------ */

export type Vec3 = [number, number, number];
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Deterministic 0..1 hash of two integers (no Math.random anywhere in this module). */
export function hashUnit(seed: number, index: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(index | 0, 668265263) + 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function perspective(fovDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan((fovDeg * DEG) / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / Math.max(1e-4, aspect);
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Float32Array {
  const z = normalize(sub(eye, target));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  const m = new Float32Array(16);
  m[0] = x[0]; m[1] = y[0]; m[2] = z[0];
  m[4] = x[1]; m[5] = y[1]; m[6] = z[1];
  m[8] = x[2]; m[9] = y[2]; m[10] = z[2];
  m[12] = -dot(x, eye); m[13] = -dot(y, eye); m[14] = -dot(z, eye);
  m[15] = 1;
  return m;
}

/** Column-major 4x4 multiply (a * b). */
export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return out;
}

/** Projects a world point with a combined matrix; returns normalized device coordinates and clip w. */
export function project(m: Float32Array, p: Vec3): { x: number; y: number; z: number; w: number } {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const iw = w !== 0 ? 1 / w : 0;
  return { x: x * iw, y: y * iw, z: z * iw, w };
}

/** HSL (hue degrees, 0..1 sat/light) to RGB 0..1. */
export function hslToRgb(h: number, s: number, l: number): Vec3 {
  const hue = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/* ------------------------------------------------------------------ motion ------------------------------------------------------------------ */

/** Loop position 0..1 for any time (negative and over-long times wrap). */
export function loopFraction(time: number, loopSeconds: number = LOOP_SECONDS): number {
  if (!Number.isFinite(time) || loopSeconds <= 0) return 0;
  const t = ((time % loopSeconds) + loopSeconds) % loopSeconds;
  return t / loopSeconds;
}
/** Whole cycles per loop for a speed percentage. Integer so the loop seam (t = 0 and t = loop) is identical. */
export const cyclesFor = (speed: number): number => Math.max(0, Math.min(4, Math.round((Number.isFinite(speed) ? speed : 0) / 50)));

/**
 * One hop over u in 0..1 with explicit staging: anticipation dip (0..0.15), rise with overshoot (0.15..0.5),
 * settle (0.5..0.7) and follow-through fall (0.7..1). hop(0) = hop(1) = 0 so it loops without a seam.
 */
export function hopCurve(u: number): number {
  const x = u - Math.floor(u);
  if (x < 0.15) return -0.18 * Math.sin(Math.PI * (x / 0.15));
  if (x < 0.5) {
    const a = (x - 0.15) / 0.35;
    return 1.12 * (1 - Math.pow(1 - a, 3));
  }
  if (x < 0.7) return 1 + 0.12 * Math.cos((Math.PI / 2) * ((x - 0.5) / 0.2));
  const a = (x - 0.7) / 0.3;
  const e = a < 0.5 ? 4 * a * a * a : 1 - Math.pow(-2 * a + 2, 3) / 2;
  return 1 - e;
}

/* ------------------------------------------------------------------ frame description ------------------------------------------------------------------ */

export type OrbDesc = { x: number; y: number; z: number; radius: number; color: Vec3 };
export type PlaneDesc = { kind: 'floor' | 'back' | 'side'; center: Vec3; u: Vec3; v: Vec3; size: [number, number]; color: Vec3 };
export type FrameDesc = {
  time: number;
  phase: number;
  cycles: number;
  eye: Vec3;
  target: Vec3;
  fov: number;
  lightDir: Vec3;
  key: number;
  fill: number;
  ambient: number;
  roughness: number;
  metal: number;
  fog: number;
  background: Vec3;
  orbs: OrbDesc[];
  planes: PlaneDesc[];
  particles: number;
  particleTint: Vec3;
  seed: number;
};

export const CAMERA_TARGET: Vec3 = [0, 0.9, 0];
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 60;

/** Everything a frame needs, as plain numbers. Same (scene, time) always gives the same description. */
export function describeFrame(scene: SceneConfig, time: number): FrameDesc {
  scene = normalizeScene(scene);
  time = Number.isFinite(time) ? time : 0;
  const counts = effectiveCounts(scene);
  const phase = loopFraction(time);
  const cycles = cyclesFor(scene.motion.speed);
  const seed = scene.motion.seed | 0;
  const spin = scene.camera.autoOrbit && cycles > 0 ? phase * 360 : 0;
  const yaw = (scene.camera.yaw + spin) * DEG;
  const pitch = scene.camera.pitch * DEG;
  const d = scene.camera.distance;
  const eye: Vec3 = [CAMERA_TARGET[0] + d * Math.cos(pitch) * Math.sin(yaw), CAMERA_TARGET[1] + d * Math.sin(pitch), CAMERA_TARGET[2] + d * Math.cos(pitch) * Math.cos(yaw)];
  const az = scene.lighting.azimuth * DEG;
  const el = scene.lighting.elevation * DEG;
  const lightDir: Vec3 = normalize([Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)]);
  const hue = scene.material.hue;
  const sat = scene.material.saturation / 100;
  const orbs: OrbDesc[] = [];
  for (let i = 0; i < counts.orbs; i++) {
    const a0 = hashUnit(seed, i * 4) * TAU;
    const ring = 1.2 + hashUnit(seed, i * 4 + 1) * 2.8;
    const height = 0.5 + hashUnit(seed, i * 4 + 2) * 1.4;
    const radius = 0.22 + hashUnit(seed, i * 4 + 3) * 0.3;
    const dir = hashUnit(seed, 100 + i) < 0.5 ? -1 : 1;
    const angle = a0 + dir * TAU * phase * cycles;
    const hopOffset = hashUnit(seed, 200 + i);
    const hop = hopCurve(hopOffset + phase * cycles * 2);
    orbs.push({ x: Math.cos(angle) * ring, y: height + 0.45 * hop, z: Math.sin(angle) * ring, radius, color: hslToRgb(hue + (hashUnit(seed, 300 + i) - 0.5) * 50, sat, 0.5 + (scene.material.metal / 100) * 0.1) });
  }
  const planeColor = (l: number) => hslToRgb(hue, sat * 0.3, l);
  const allPlanes: PlaneDesc[] = [
    { kind: 'floor', center: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1], size: [14, 14], color: planeColor(0.22) },
    { kind: 'back', center: [0, 3, -6], u: [1, 0, 0], v: [0, 1, 0], size: [14, 6], color: planeColor(0.2) },
    { kind: 'side', center: [-6, 3, 0], u: [0, 0, -1], v: [0, 1, 0], size: [14, 6], color: planeColor(0.18) },
  ];
  return {
    time,
    phase,
    cycles,
    eye,
    target: CAMERA_TARGET,
    fov: scene.camera.fov,
    lightDir,
    key: scene.lighting.key / 100,
    fill: scene.lighting.fill / 100,
    ambient: scene.lighting.ambient / 100,
    roughness: scene.material.roughness / 100,
    metal: scene.material.metal / 100,
    fog: scene.lighting.fog / 100,
    background: hslToRgb(hue, sat * 0.35, 0.07),
    orbs,
    planes: allPlanes.slice(0, counts.planes),
    particles: counts.particles,
    particleTint: hslToRgb(hue + 20, sat, 0.72),
    seed,
  };
}

/** Deterministic per-particle attributes (four 0..1 hashes each); motion itself happens in the vertex shader. */
export function particleSeeds(count: number, seed: number): Float32Array {
  const n = Math.max(0, Math.min(GL_LIMITS.maxParticles, count | 0));
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) out[i * 4 + k] = hashUnit(seed | 0, 1000 + i * 4 + k);
  return out;
}

export function cameraMatrices(desc: Pick<FrameDesc, 'eye' | 'target' | 'fov'>, aspect: number): { view: Float32Array; proj: Float32Array; viewProj: Float32Array } {
  const view = lookAt(desc.eye, desc.target);
  const proj = perspective(desc.fov, aspect > 0 && Number.isFinite(aspect) ? aspect : 1, CAMERA_NEAR, CAMERA_FAR);
  return { view, proj, viewProj: mul4(proj, view) };
}

/* ------------------------------------------------------------------ playhead ------------------------------------------------------------------ */

export type PlayheadStep = { time: number; wrapped: boolean; stopped: boolean };
export type Playhead = {
  readonly time: number;
  readonly playing: boolean;
  readonly loop: boolean;
  readonly loopSeconds: number;
  play(): void;
  pause(): void;
  toggle(): boolean;
  setLoop(loop: boolean): void;
  seek(time: number): number;
  /** Advances by a wall-clock delta; steps are clamped so a hidden tab never jumps. */
  advance(dtMs: number): PlayheadStep;
};

/** Pure transport state for scrub / play / loop. No timers: the owner feeds it deltas. */
export function createPlayhead(opts: { loopSeconds?: number; maxStepS?: number; time?: number; loop?: boolean } = {}): Playhead {
  const loopSeconds = Number.isFinite(opts.loopSeconds) && (opts.loopSeconds ?? 0) > 0 ? Math.min(LOOP_SECONDS, opts.loopSeconds!) : LOOP_SECONDS;
  const maxStepS = Number.isFinite(opts.maxStepS) && (opts.maxStepS ?? 0) > 0 ? Math.min(GL_LIMITS.maxFrameS, opts.maxStepS!, loopSeconds) : Math.min(GL_LIMITS.maxFrameS, loopSeconds);
  const clamp = (t: number) => (Number.isFinite(t) ? Math.min(loopSeconds, Math.max(0, t)) : 0);
  let time = clamp(opts.time ?? 0);
  let playing = false;
  let loop = opts.loop ?? true;
  return {
    get time() { return time; },
    get playing() { return playing; },
    get loop() { return loop; },
    get loopSeconds() { return loopSeconds; },
    play() { if (!loop && time >= loopSeconds) time = 0; playing = true; },
    pause() { playing = false; },
    toggle() { if (playing) playing = false; else this.play(); return playing; },
    setLoop(v) { loop = !!v; },
    seek(t) { time = clamp(t); return time; },
    advance(dtMs) {
      if (!playing) return { time, wrapped: false, stopped: false };
      const step = Number.isFinite(dtMs) ? Math.min(maxStepS, Math.max(0, dtMs / 1000)) : 0;
      time += step;
      if (time < loopSeconds) return { time, wrapped: false, stopped: false };
      if (loop) { time %= loopSeconds; return { time, wrapped: true, stopped: false }; }
      time = loopSeconds;
      playing = false;
      return { time, wrapped: false, stopped: true };
    },
  };
}

/** Frame gate: paint when at least minFrameMs passed since the last paint (half a millisecond of tolerance for timer jitter). */
export const shouldPaint = (lastPaintTs: number | null, nowTs: number, minFrameMs: number): boolean => lastPaintTs === null || nowTs - lastPaintTs >= minFrameMs - 0.5;

/* ------------------------------------------------------------------ contact sheet ------------------------------------------------------------------ */

export type ContactSheetPlan = { tiles: number; columns: number; rows: number; tileWidth: number; tileHeight: number; width: number; height: number; times: number[] };

/** Grid of evenly spaced loop times. Always within GL_LIMITS.maxSheetTiles and maxSheetEdge; the first tile is the loop seam. */
export function contactSheetPlan(opts: { tiles?: number; tileWidth?: number; aspect?: number } = {}): ContactSheetPlan {
  const tiles = Math.max(1, Math.min(GL_LIMITS.maxSheetTiles, Math.round(Number.isFinite(opts.tiles ?? NaN) ? (opts.tiles as number) : 12)));
  const aspect = Number.isFinite(opts.aspect) && (opts.aspect ?? 0) > 0 ? Math.min(8, Math.max(0.125, opts.aspect!)) : 16 / 9;
  const columns = Math.ceil(Math.sqrt(tiles));
  const rows = Math.ceil(tiles / columns);
  let tileWidth = Math.max(64, Math.min(GL_LIMITS.maxSheetEdge, Math.round(Number.isFinite(opts.tileWidth ?? NaN) ? (opts.tileWidth as number) : 320)));
  let tileHeight = Math.max(36, Math.round(tileWidth / aspect));
  const scale = Math.min(1, GL_LIMITS.maxSheetEdge / (columns * tileWidth), GL_LIMITS.maxSheetEdge / (rows * tileHeight));
  if (scale < 1) {
    tileWidth = Math.max(1, Math.floor(tileWidth * scale));
    tileHeight = Math.max(1, Math.floor(tileHeight * scale));
  }
  const times = Array.from({ length: tiles }, (_, i) => (i * LOOP_SECONDS) / tiles);
  return { tiles, columns, rows, tileWidth, tileHeight, width: columns * tileWidth, height: rows * tileHeight, times };
}

/* ------------------------------------------------------------------ static fallback ------------------------------------------------------------------ */

const css = (c: Vec3, alpha = 1): string => `rgba(${Math.round(Math.min(1, Math.max(0, c[0])) * 255)},${Math.round(Math.min(1, Math.max(0, c[1])) * 255)},${Math.round(Math.min(1, Math.max(0, c[2])) * 255)},${alpha})`;
const fix = (n: number) => Number(n.toFixed(2));

/**
 * Static SVG of the same frame description for hosts without WebGL2. It is a flat projection (no shading, shadows or
 * particles) and says so in its label; it is never presented as the GPU result.
 */
export function fallbackSvg(scene: SceneConfig, time: number, width = 960, height = 540): string {
  time = Number.isFinite(time) ? time : 0;
  const w = Math.max(16, Math.min(GL_LIMITS.maxEdge, Math.round(Number.isFinite(width) ? width : 960)));
  const h = Math.max(9, Math.min(GL_LIMITS.maxEdge, Math.round(Number.isFinite(height) ? height : 540)));
  const desc = describeFrame(scene, time);
  const { viewProj } = cameraMatrices(desc, w / h);
  const toPx = (p: Vec3) => {
    const q = project(viewProj, p);
    return { x: ((q.x + 1) / 2) * w, y: ((1 - q.y) / 2) * h, w: q.w };
  };
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${css(desc.background)}"/>`];
  for (const plane of desc.planes) {
    const corners: Vec3[] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([a, b]) => [
      plane.center[0] + plane.u[0] * a * plane.size[0] + plane.v[0] * b * plane.size[1],
      plane.center[1] + plane.u[1] * a * plane.size[0] + plane.v[1] * b * plane.size[1],
      plane.center[2] + plane.u[2] * a * plane.size[0] + plane.v[2] * b * plane.size[1],
    ] as Vec3);
    const pts = corners.map(toPx);
    if (pts.some((p) => p.w <= CAMERA_NEAR)) continue;
    parts.push(`<polygon points="${pts.map((p) => `${fix(p.x)},${fix(p.y)}`).join(' ')}" fill="${css(plane.color, 0.9)}"/>`);
  }
  const sorted = desc.orbs.map((o) => ({ o, p: toPx([o.x, o.y, o.z]) })).filter(({ p }) => p.w > CAMERA_NEAR).sort((a, b) => b.p.w - a.p.w);
  const f = 1 / Math.tan((desc.fov * DEG) / 2);
  for (const { o, p } of sorted) {
    const r = Math.max(1, ((o.radius * f) / p.w) * (h / 2));
    parts.push(`<circle cx="${fix(p.x)}" cy="${fix(p.y)}" r="${fix(r)}" fill="${css(o.color)}" stroke="${css(desc.background, 0.6)}" stroke-width="1"/>`);
  }
  parts.push(`<text x="12" y="${h - 12}" font-family="system-ui, sans-serif" font-size="12" fill="rgba(255,255,255,0.75)">Static preview (no WebGL2): flat projection without lighting or particles, t=${fix(time)}s</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Static scene preview without GPU rendering">${parts.join('')}</svg>`;
}

/* ------------------------------------------------------------------ WebGL2 renderer ------------------------------------------------------------------ */

export type GL = WebGL2RenderingContext;

export class Scene3DError extends Error {
  readonly stage: 'context' | 'shader' | 'program';
  constructor(message: string, stage: 'context' | 'shader' | 'program') {
    super(message);
    this.name = 'Scene3DError';
    this.stage = stage;
  }
}

const SURFACE_FRAG = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vWorld; in vec3 vColor;
uniform vec3 uEye; uniform vec3 uLightDir; uniform vec3 uBackground;
uniform float uKey; uniform float uFill; uniform float uAmbient; uniform float uRoughness; uniform float uMetal; uniform float uFog;
uniform int uShadowCount; uniform vec4 uShadowOrbs[${GL_LIMITS.maxShadowOrbs}]; uniform int uShadowed;
out vec4 fragColor;
float shadowAt(vec3 p) {
  float s = 1.0;
  for (int i = 0; i < ${GL_LIMITS.maxShadowOrbs}; i++) {
    if (i >= uShadowCount) break;
    vec4 o = uShadowOrbs[i];
    vec3 d = o.xyz - p;
    float h = max(d.y, 0.0);
    float horiz = length(d.xz);
    float soft = o.w * 1.4 + h * 0.5 + 0.001;
    float cover = clamp(1.0 - (horiz - o.w * 0.8) / soft, 0.0, 1.0);
    float fall = 1.0 / (1.0 + h * 0.9);
    s *= 1.0 - 0.7 * cover * fall;
  }
  return s;
}
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  if (uShadowed == 1 && dot(n, v) < 0.0) n = -n;
  vec3 l = normalize(uLightDir);
  vec3 h = normalize(l + v);
  float diff = max(dot(n, l), 0.0);
  float shin = mix(6.0, 90.0, 1.0 - uRoughness);
  float spec = pow(max(dot(n, h), 0.0), shin) * (1.0 - uRoughness * 0.75);
  vec3 fillDir = normalize(vec3(-l.x, 0.6, -l.z));
  float fillL = max(dot(n, fillDir), 0.0);
  float sh = uShadowed == 1 ? shadowAt(vWorld) : 1.0;
  vec3 specCol = mix(vec3(1.0), vColor, uMetal);
  vec3 col = vColor * (uAmbient + uKey * diff * sh + uFill * fillL) + specCol * spec * uKey * sh;
  float dist = length(uEye - vWorld);
  float fog = clamp(1.0 - exp(-dist * uFog * 0.12), 0.0, 1.0);
  col = mix(col, uBackground, fog);
  col = col / (col + vec3(1.0));
  fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;

const ORB_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aInst;
layout(location = 2) in vec3 aColor;
uniform mat4 uViewProj;
out vec3 vNormal; out vec3 vWorld; out vec3 vColor;
void main() {
  vec3 w = aInst.xyz + aPos * aInst.w;
  vNormal = aPos; vWorld = w; vColor = aColor;
  gl_Position = uViewProj * vec4(w, 1.0);
}
`;

const PLANE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aQuad;
layout(location = 1) in vec3 aCenter;
layout(location = 2) in vec3 aU;
layout(location = 3) in vec3 aV;
layout(location = 4) in vec3 aColor;
layout(location = 5) in vec2 aSize;
uniform mat4 uViewProj;
out vec3 vNormal; out vec3 vWorld; out vec3 vColor;
void main() {
  vec3 w = aCenter + aU * (aQuad.x * aSize.x) + aV * (aQuad.y * aSize.y);
  vNormal = normalize(cross(aU, aV)); vWorld = w; vColor = aColor;
  gl_Position = uViewProj * vec4(w, 1.0);
}
`;

const PARTICLE_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec4 aSeed;
uniform mat4 uViewProj; uniform float uPhase; uniform float uCycles; uniform float uPointScale;
out float vAlpha;
const float TAU = 6.28318530718;
void main() {
  float ang = aSeed.x * TAU + 0.4 * sin((uPhase * uCycles + aSeed.y) * TAU);
  float rad = 0.8 + aSeed.z * 6.5;
  float y = 0.15 + aSeed.w * 4.2 + 0.35 * sin((uPhase * uCycles * 2.0 + aSeed.x) * TAU);
  vec3 p = vec3(cos(ang) * rad, y, sin(ang) * rad);
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_Position = clip;
  float size = 0.5 + aSeed.y * 0.8;
  gl_PointSize = clamp(uPointScale * size / max(clip.w, 0.2), 1.0, 24.0);
  vAlpha = 0.3 + 0.45 * aSeed.w;
}
`;

const PARTICLE_FRAG = `#version 300 es
precision mediump float;
in float vAlpha; uniform vec3 uTint;
out vec4 fragColor;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = (1.0 - smoothstep(0.12, 0.5, d)) * vAlpha;
  if (a < 0.01) discard;
  fragColor = vec4(uTint * a, a);
}
`;

/** GLSL ES 3.00 sources, exported so tests can check versions and compiled limits. */
export const SHADERS = Object.freeze({ orbVert: ORB_VERT, planeVert: PLANE_VERT, surfaceFrag: SURFACE_FRAG, particleVert: PARTICLE_VERT, particleFrag: PARTICLE_FRAG });

/** Context attributes for canvas.getContext('webgl2', ...). preserveDrawingBuffer keeps PNG export of the last frame reliable. */
export function contextAttributes(scene: SceneConfig): WebGLContextAttributes {
  return { alpha: false, depth: true, stencil: false, antialias: QUALITY_PROFILES[scene.quality].antialias, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power', failIfMajorPerformanceCaveat: false };
}

export type SphereMesh = { positions: Float32Array; indices: Uint16Array; triangles: number };
/** UV sphere with `segments` latitude rings and twice as many longitude steps; positions double as normals. */
export function sphereMesh(segments: number): SphereMesh {
  const lat = Math.max(3, Math.min(GL_LIMITS.maxSphereSegments, segments | 0));
  const lon = lat * 2;
  const positions = new Float32Array((lat + 1) * (lon + 1) * 3);
  const indices = new Uint16Array(lat * lon * 6);
  let p = 0;
  for (let i = 0; i <= lat; i++) {
    const theta = (i / lat) * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let j = 0; j <= lon; j++) {
      const phi = (j / lon) * TAU;
      positions[p++] = st * Math.cos(phi);
      positions[p++] = ct;
      positions[p++] = st * Math.sin(phi);
    }
  }
  let q = 0;
  for (let i = 0; i < lat; i++) {
    for (let j = 0; j < lon; j++) {
      const a = i * (lon + 1) + j, b = a + lon + 1;
      indices[q++] = a; indices[q++] = b; indices[q++] = a + 1;
      indices[q++] = b; indices[q++] = b + 1; indices[q++] = a + 1;
    }
  }
  return { positions, indices, triangles: lat * lon * 2 };
}

export type RenderResult = { ok: boolean; reason?: string; width: number; height: number; orbs: number; planes: number; particles: number; drawCalls: number; triangles: number };
export type SceneRenderer = {
  /** Draws (scene, time) into the current drawing buffer at the given device pixel size. Deterministic for equal inputs. */
  renderAt(scene: SceneConfig, time: number, width: number, height: number): RenderResult;
  /** Frees GPU objects. Safe to call twice and after context loss. */
  dispose(): void;
  isLost(): boolean;
  readonly last: RenderResult | null;
};

type ProgramInfo = { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

function compile(gl: GL, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Scene3DError(`Could not allocate the ${label} shader.`, 'context');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) || gl.isContextLost()) {
    const log = (gl.getShaderInfoLog(sh) || '').trim();
    gl.deleteShader(sh);
    throw new Scene3DError(`${label} shader failed to compile: ${log || 'no log'}`, 'shader');
  }
  return sh;
}

function link(gl: GL, vertSrc: string, fragSrc: string, label: string, uniforms: string[]): ProgramInfo {
  let vs: WebGLShader | null = null, fs: WebGLShader | null = null, program: WebGLProgram | null = null;
  try {
  vs = compile(gl, gl.VERTEX_SHADER, vertSrc, `${label} vertex`);
  fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc, `${label} fragment`);
  program = gl.createProgram();
  if (!program) throw new Scene3DError(`Could not allocate the ${label} program.`, 'context');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS) || gl.isContextLost()) {
    const log = (gl.getProgramInfoLog(program) || '').trim();
    throw new Scene3DError(`${label} program failed to link: ${log || 'no log'}`, 'program');
  }
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
  }
}

const SURFACE_UNIFORMS = ['uViewProj', 'uEye', 'uLightDir', 'uBackground', 'uKey', 'uFill', 'uAmbient', 'uRoughness', 'uMetal', 'uFog', 'uShadowCount', 'uShadowOrbs[0]', 'uShadowed'];
const ORB_STRIDE = 7, PLANE_STRIDE = 14;

/**
 * Creates the GPU renderer for one WebGL2 context. Throws Scene3DError when a shader does not compile so the caller can
 * fall back honestly. The renderer keeps bounded buffers: at most GL_LIMITS orbs / planes / particles and one sphere mesh.
 */
export function createSceneRenderer(gl: GL): SceneRenderer {
  const allocatedPrograms: WebGLProgram[] = [], allocatedBuffers: WebGLBuffer[] = [], allocatedVaos: WebGLVertexArrayObject[] = [];
  const program = (v: string, f: string, label: string, u: string[]) => { const p = link(gl, v, f, label, u); allocatedPrograms.push(p.program); return p; };
  const buffer = () => { const b = gl.createBuffer(); if (b) allocatedBuffers.push(b); return b; };
  const vao = () => { const v = gl.createVertexArray(); if (v) allocatedVaos.push(v); return v; };
  try {
  const orbProg = program(ORB_VERT, SURFACE_FRAG, 'orb', SURFACE_UNIFORMS);
  const planeProg = program(PLANE_VERT, SURFACE_FRAG, 'plane', SURFACE_UNIFORMS);
  const particleProg = program(PARTICLE_VERT, PARTICLE_FRAG, 'particle', ['uViewProj', 'uPhase', 'uCycles', 'uPointScale', 'uTint']);

  const sphereVbo = buffer(), sphereIbo = buffer(), orbInst = buffer();
  const quadVbo = buffer(), planeInst = buffer(), particleVbo = buffer();
  const orbVao = vao(), planeVao = vao(), particleVao = vao();
  if (!sphereVbo || !sphereIbo || !orbInst || !quadVbo || !planeInst || !particleVbo || !orbVao || !planeVao || !particleVao) throw new Scene3DError('Could not allocate GPU buffers.', 'context');

  let sphereSegments = -1, sphereIndexCount = 0, sphereTriangles = 0;
  let particleKey = '', particleCount = 0;
  const orbData = new Float32Array(GL_LIMITS.maxOrbs * ORB_STRIDE);
  const planeData = new Float32Array(GL_LIMITS.maxPlanes * PLANE_STRIDE);
  const shadowData = new Float32Array(GL_LIMITS.maxShadowOrbs * 4);
  let disposed = false;
  let last: RenderResult | null = null;

  // Orb VAO: sphere positions at 0, per-instance (xyz, radius) at 1 and colour at 2.
  gl.bindVertexArray(orbVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, sphereVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIbo);
  gl.bindBuffer(gl.ARRAY_BUFFER, orbInst);
  gl.bufferData(gl.ARRAY_BUFFER, orbData.byteLength, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, ORB_STRIDE * 4, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 3, gl.FLOAT, false, ORB_STRIDE * 4, 16);
  gl.vertexAttribDivisor(2, 1);

  // Plane VAO: unit quad at 0, per-instance centre / u / v / colour / size at 1..5.
  gl.bindVertexArray(planeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, planeInst);
  gl.bufferData(gl.ARRAY_BUFFER, planeData.byteLength, gl.DYNAMIC_DRAW);
  const planeLayout: [number, number, number][] = [[1, 3, 0], [2, 3, 3], [3, 3, 6], [4, 3, 9], [5, 2, 12]];
  for (const [loc, size, offset] of planeLayout) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, PLANE_STRIDE * 4, offset * 4);
    gl.vertexAttribDivisor(loc, 1);
  }

  // Particle VAO: four hashes per point.
  gl.bindVertexArray(particleVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, particleVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const ensureSphere = (segments: number) => {
    if (segments === sphereSegments) return;
    const mesh = sphereMesh(segments);
    gl.bindBuffer(gl.ARRAY_BUFFER, sphereVbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphereIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    sphereSegments = segments;
    sphereIndexCount = mesh.indices.length;
    sphereTriangles = mesh.triangles;
  };
  const ensureParticles = (count: number, seed: number) => {
    const key = `${count}:${seed}`;
    if (key === particleKey) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, particleVbo);
    gl.bufferData(gl.ARRAY_BUFFER, particleSeeds(count, seed), gl.STATIC_DRAW);
    particleKey = key;
    particleCount = count;
  };
  const setSurfaceUniforms = (p: ProgramInfo, desc: FrameDesc, viewProj: Float32Array, shadowed: boolean, shadowCount: number) => {
    gl.useProgram(p.program);
    gl.uniformMatrix4fv(p.u.uViewProj, false, viewProj);
    gl.uniform3fv(p.u.uEye, desc.eye);
    gl.uniform3fv(p.u.uLightDir, desc.lightDir);
    gl.uniform3fv(p.u.uBackground, desc.background);
    gl.uniform1f(p.u.uKey, desc.key);
    gl.uniform1f(p.u.uFill, desc.fill);
    gl.uniform1f(p.u.uAmbient, desc.ambient);
    gl.uniform1f(p.u.uRoughness, desc.roughness);
    gl.uniform1f(p.u.uMetal, desc.metal);
    gl.uniform1f(p.u.uFog, desc.fog);
    gl.uniform1i(p.u.uShadowed, shadowed ? 1 : 0);
    gl.uniform1i(p.u.uShadowCount, shadowCount);
    gl.uniform4fv(p.u['uShadowOrbs[0]'], shadowData);
  };

  const fail = (reason: string, width: number, height: number): RenderResult => (last = { ok: false, reason, width, height, orbs: 0, planes: 0, particles: 0, drawCalls: 0, triangles: 0 });

  return {
    get last() { return last; },
    isLost: () => gl.isContextLost(),
    renderAt(scene, time, width, height) {
      scene = normalizeScene(scene);
      const w = Math.max(1, Math.min(GL_LIMITS.maxEdge, Math.floor(Number.isFinite(width) ? width : 1)));
      const h = Math.max(1, Math.min(GL_LIMITS.maxEdge, Math.floor(Number.isFinite(height) ? height : 1)));
      if (disposed) return fail('renderer disposed', w, h);
      if (gl.isContextLost()) return fail('context lost', w, h);
      const counts = effectiveCounts(scene);
      const desc = describeFrame(scene, time);
      const { viewProj } = cameraMatrices(desc, w / h);
      let drawCalls = 0;
      let triangles = 0;

      const bg = desc.background.map((c) => Math.pow(c / (c + 1), 1 / 2.2)) as Vec3;
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const shadowCount = Math.min(counts.shadowOrbs, desc.orbs.length);
      shadowData.fill(0);
      for (let i = 0; i < shadowCount; i++) {
        const o = desc.orbs[i];
        shadowData.set([o.x, o.y, o.z, o.radius], i * 4);
      }

      if (desc.planes.length > 0) {
        for (let i = 0; i < desc.planes.length; i++) {
          const pl = desc.planes[i];
          planeData.set([...pl.center, ...pl.u, ...pl.v, ...pl.color, pl.size[0], pl.size[1]], i * PLANE_STRIDE);
        }
        setSurfaceUniforms(planeProg, desc, viewProj, true, shadowCount);
        gl.bindVertexArray(planeVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, planeInst);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, planeData, 0, desc.planes.length * PLANE_STRIDE);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, desc.planes.length);
        drawCalls++;
        triangles += desc.planes.length * 2;
      }

      if (desc.orbs.length > 0) {
        ensureSphere(counts.sphereSegments);
        for (let i = 0; i < desc.orbs.length; i++) {
          const o = desc.orbs[i];
          orbData.set([o.x, o.y, o.z, o.radius, o.color[0], o.color[1], o.color[2]], i * ORB_STRIDE);
        }
        setSurfaceUniforms(orbProg, desc, viewProj, false, 0);
        gl.bindVertexArray(orbVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, orbInst);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, orbData, 0, desc.orbs.length * ORB_STRIDE);
        gl.drawElementsInstanced(gl.TRIANGLES, sphereIndexCount, gl.UNSIGNED_SHORT, 0, desc.orbs.length);
        drawCalls++;
        triangles += sphereTriangles * desc.orbs.length;
      }

      if (desc.particles > 0) {
        ensureParticles(desc.particles, desc.seed);
        gl.useProgram(particleProg.program);
        gl.uniformMatrix4fv(particleProg.u.uViewProj, false, viewProj);
        gl.uniform1f(particleProg.u.uPhase, desc.phase);
        gl.uniform1f(particleProg.u.uCycles, desc.cycles);
        gl.uniform1f(particleProg.u.uPointScale, h * 0.08);
        gl.uniform3fv(particleProg.u.uTint, desc.particleTint);
        gl.bindVertexArray(particleVao);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.POINTS, 0, particleCount);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
        drawCalls++;
      }
      gl.bindVertexArray(null);
      return (last = { ok: true, width: w, height: h, orbs: desc.orbs.length, planes: desc.planes.length, particles: desc.particles, drawCalls, triangles });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const p of [orbProg, planeProg, particleProg]) gl.deleteProgram(p.program);
      for (const b of [sphereVbo, sphereIbo, orbInst, quadVbo, planeInst, particleVbo]) gl.deleteBuffer(b);
      for (const v of [orbVao, planeVao, particleVao]) gl.deleteVertexArray(v);
    },
  };
  } catch (error) {
    for (const p of allocatedPrograms) gl.deleteProgram(p);
    for (const b of allocatedBuffers) gl.deleteBuffer(b);
    for (const v of allocatedVaos) gl.deleteVertexArray(v);
    throw error;
  }
}
