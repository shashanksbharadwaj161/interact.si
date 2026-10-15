/**
 * Goal 44 / 67: a project-specific visual scene that is applied when a capsule is resumed, with a deterministic
 * project-to-project transition plan. Pure and DOM-free: persistence goes through the renderer prefs helpers in the
 * store (key CAPSULE_SCENE_PREF_KEY), and the transition itself runs on the shared interruptible anim-state machine.
 *
 * Every function returns new frozen values and never mutates its input.
 */
import { ANIM_LIMITS } from './anim-state';
import { SCENE_IDS, isKnownScene } from './scenes';

export const CAPSULE_SCENE_PREF_KEY = 'capsuleScenes.v1';

export const CAPSULE_SCENE_LIMITS = Object.freeze({
  /** Most capsule → scene mappings kept; extra entries are dropped in key order. */
  maxMappings: 200,
  /** Longest accepted capsule id. */
  maxIdChars: 128,
});

/** capsuleId → sceneId. Always frozen. */
export type CapsuleSceneMap = Readonly<Record<string, string>>;

export type SceneResolution = Readonly<{ sceneId: string; source: 'capsule' | 'fallback'; transition: 'crossfade' | 'none' }>;

export type SceneTransitionPlan = Readonly<{
  kind: 'crossfade' | 'none';
  from: string;
  to: string;
  /** Total time: fade the current scene out, then the next one in (0 for 'none'). */
  durationMs: number;
  exitMs: number;
  enterMs: number;
  startedAt: number;
  endsAt: number;
  interruptible: true;
}>;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

export function isValidCapsuleId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= CAPSULE_SCENE_LIMITS.maxIdChars && ID_RE.test(id);
}

function assertCapsuleId(id: unknown): asserts id is string {
  if (!isValidCapsuleId(id)) {
    const shown = typeof id === 'string' ? JSON.stringify(id.slice(0, 40)) : typeof id;
    throw new Error(`Invalid capsule id ${shown}: expected 1-${CAPSULE_SCENE_LIMITS.maxIdChars} letters, digits, '_', '-', '.' or ':'.`);
  }
}

function assertSceneId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !isKnownScene(id)) {
    const shown = typeof id === 'string' ? JSON.stringify(id.slice(0, 40)) : typeof id;
    throw new Error(`Unknown scene id ${shown}: expected one of ${SCENE_IDS.join(', ')}.`);
  }
}

function freezeMap(entries: [string, string][]): CapsuleSceneMap {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) out[k] = v;
  return Object.freeze(out);
}

/** Validates untrusted stored data: keeps valid capsule ids mapped to known scene ids, capped at the limit. Never throws. */
export function normalizeCapsuleScenes(raw: unknown): CapsuleSceneMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return freezeMap([]);
  const kept: [string, string][] = [];
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (kept.length >= CAPSULE_SCENE_LIMITS.maxMappings) break;
    const value = (raw as Record<string, unknown>)[key];
    if (isValidCapsuleId(key) && typeof value === 'string' && isKnownScene(value)) kept.push([key, value]);
  }
  return freezeMap(kept);
}

/** Returns a new map with capsuleId → sceneId. Throws a descriptive Error for a bad capsule id, an unknown scene or a full map. */
export function setCapsuleScene(mappings: CapsuleSceneMap, capsuleId: string, sceneId: string): CapsuleSceneMap {
  assertCapsuleId(capsuleId);
  assertSceneId(sceneId);
  const base = normalizeCapsuleScenes(mappings);
  const entries = Object.entries(base).filter(([k]) => k !== capsuleId);
  if (entries.length >= CAPSULE_SCENE_LIMITS.maxMappings) {
    throw new Error(`At most ${CAPSULE_SCENE_LIMITS.maxMappings} project scenes can be saved; clear one first.`);
  }
  entries.push([capsuleId, sceneId]);
  return freezeMap(entries);
}

/** Returns a new map without capsuleId. Throws a descriptive Error for a bad capsule id. */
export function clearCapsuleScene(mappings: CapsuleSceneMap, capsuleId: string): CapsuleSceneMap {
  assertCapsuleId(capsuleId);
  return freezeMap(Object.entries(normalizeCapsuleScenes(mappings)).filter(([k]) => k !== capsuleId));
}

/** Picks the capsule's mapped scene, else the fallback. Reduced motion always means an instant switch. */
export function resolveSceneForCapsule(input: { capsuleId: string; mappings: CapsuleSceneMap; fallbackSceneId: string; reducedMotion: boolean }): SceneResolution {
  assertCapsuleId(input?.capsuleId);
  assertSceneId(input.fallbackSceneId);
  const mapped = normalizeCapsuleScenes(input.mappings)[input.capsuleId];
  const transition = input.reducedMotion ? 'none' : 'crossfade';
  return Object.freeze(mapped ? { sceneId: mapped, source: 'capsule' as const, transition } : { sceneId: input.fallbackSceneId, source: 'fallback' as const, transition });
}

/** Deterministic plan for moving the backdrop between two scenes, matching the anim-state machine's default leg times. */
export function planSceneTransition(fromSceneId: string, toSceneId: string, opts: { reducedMotion: boolean; now: number }): SceneTransitionPlan {
  assertSceneId(fromSceneId);
  assertSceneId(toSceneId);
  const startedAt = typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : 0;
  const none = fromSceneId === toSceneId || Boolean(opts?.reducedMotion);
  const exitMs = none ? 0 : ANIM_LIMITS.exitMs;
  const enterMs = none ? 0 : ANIM_LIMITS.enterMs;
  const durationMs = exitMs + enterMs;
  return Object.freeze({ kind: none ? 'none' : 'crossfade', from: fromSceneId, to: toSceneId, durationMs, exitMs, enterMs, startedAt, endsAt: startedAt + durationMs, interruptible: true });
}
