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

/**
 * Scene the app-wide backdrop shows (goal 44): the active capsule's project scene when it names a known scene,
 * otherwise the app-wide pick, otherwise DEFAULT_SCENE. Pure; an unknown or missing id never reaches the backdrop.
 */
export function resolveActiveScene(capsule: { scene?: unknown } | null | undefined, fallbackSceneId: unknown): string {
  const own = capsule && typeof capsule === 'object' ? capsule.scene : undefined;
  if (typeof own === 'string' && isKnownScene(own)) return own;
  return typeof fallbackSceneId === 'string' && isKnownScene(fallbackSceneId) ? fallbackSceneId : DEFAULT_SCENE;
}

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
