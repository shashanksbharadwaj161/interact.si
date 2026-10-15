export type SceneDef = { id: string; name: string; blurb: string };

/** Procedural CSS scenes. A capsule stores one of these ids in `scene`; the app-wide pick is a UI preference. */
export const SCENES: SceneDef[] = [
  { id: 'deep-space', name: 'Deep space', blurb: 'Drifting star field with a faint nebula wash.' },
  { id: 'orbit', name: 'Orbit', blurb: 'Concentric rings around a quiet core.' },
  { id: 'aurora', name: 'Aurora', blurb: 'Slow blurred ribbons of cool light.' },
  { id: 'horizon', name: 'Horizon grid', blurb: 'Perspective grid receding to a warm horizon.' },
  { id: 'dusk', name: 'Dusk ridge', blurb: 'Layered ridgelines under an amber sky.' },
];

export const DEFAULT_SCENE = 'deep-space';

export const sceneName = (id: string): string => SCENES.find((s) => s.id === id)?.name ?? (id || 'No scene');
export const isKnownScene = (id: string): boolean => SCENES.some((s) => s.id === id);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic star field as a box-shadow list (px positions inside a 1000x1000 layer). */
export function starShadow(count: number, seed: number): string {
  const r = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.round(r() * 1000);
    const y = Math.round(r() * 1000);
    const a = (0.25 + r() * 0.6).toFixed(2);
    out.push(`${x}px ${y}px 0 0 rgba(220,232,255,${a})`);
  }
  return out.join(',');
}

/* ---------- scene backdrop motion (used by clip export, roadmap 140) ---------- */

/**
 * Parametric description of how each CSS backdrop moves. These mirror the slow drift the CSS scenes animate, as plain
 * numbers, so a clip can sample the backdrop at any time without reading the DOM or a clock.
 */
export type SceneMotionDef = {
  /** Seconds for one full backdrop cycle; every sampled value repeats exactly after this. */
  periodS: number;
  /** Drift amplitude as a fraction of the frame width / height. */
  driftX: number;
  driftY: number;
  /** Whole turns of rotation per cycle (0 = none). */
  turns: number;
  /** Glow pulse depth 0..1 around a 0.5 baseline. */
  glow: number;
  /** Hue the backdrop light leans towards, 0..360. */
  hue: number;
};

export const SCENE_MOTION: Readonly<Record<string, SceneMotionDef>> = {
  'deep-space': { periodS: 40, driftX: 0.03, driftY: 0.015, turns: 0, glow: 0.2, hue: 225 },
  orbit: { periodS: 30, driftX: 0, driftY: 0, turns: 1, glow: 0.3, hue: 265 },
  aurora: { periodS: 20, driftX: 0.06, driftY: 0.02, turns: 0, glow: 0.45, hue: 160 },
  horizon: { periodS: 12, driftX: 0, driftY: 0.04, turns: 0, glow: 0.25, hue: 25 },
  dusk: { periodS: 50, driftX: 0.02, driftY: 0.01, turns: 0, glow: 0.15, hue: 35 },
};

export type SceneMotionSample = {
  /** Horizontal drift, fraction of frame width (-driftX..driftX). */
  driftX: number;
  /** Vertical drift, fraction of frame height. */
  driftY: number;
  /** Rotation in degrees, 0..360. */
  rotation: number;
  /** Backdrop light level 0..1. */
  glow: number;
  hue: number;
};

const r4 = (v: number): number => Math.round(v * 10000) / 10000 + 0;

/**
 * Backdrop parameters of a scene at `seconds`. Pure and periodic; returns null for unknown ids so callers must
 * validate scene ids instead of silently drawing a default.
 */
export function sceneMotionAt(id: string, seconds: number): SceneMotionSample | null {
  const def = Object.prototype.hasOwnProperty.call(SCENE_MOTION, id) ? SCENE_MOTION[id] : undefined;
  if (!def || !Number.isFinite(seconds)) return null;
  const u = (((seconds / def.periodS) % 1) + 1) % 1;
  const phase = u * Math.PI * 2;
  return {
    driftX: r4(def.driftX * Math.sin(phase)),
    driftY: r4(def.driftY * Math.sin(2 * phase)),
    rotation: r4((u * def.turns * 360) % 360),
    glow: r4(Math.min(1, Math.max(0, 0.5 + def.glow * Math.sin(phase)))),
    hue: def.hue,
  };
}
