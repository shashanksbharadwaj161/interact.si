/**
 * Companion appearance: one typed model shared by every place the companion appears (shell, Today, Assistant,
 * Studio, onboarding). Pure and DOM-free so it can be unit tested in Node.
 *
 * Forms are original procedural renderings drawn by src/ui/orb-engine.ts. "Classic character" is the
 * compatibility adapter for avatar packs saved by earlier builds: it draws the saved pack through the same shared
 * renderer, so personal work stays usable and nothing is erased.
 */

export const APPEARANCE_VERSION = 1 as const;
export const APPEARANCE_PREF_KEY = 'companion.appearance';

export type CompanionForm = 'core' | 'lattice' | 'ribbon' | 'frost' | 'character';
/** live: full motion. calm: slower, lower frame rate. still: one rendered frame per state change, no animation loop. */
export type CompanionMotion = 'live' | 'calm' | 'still';

export type CompanionAppearance = {
  version: typeof APPEARANCE_VERSION;
  form: CompanionForm;
  /** Hue of the inner light, 0..360. */
  tint: number;
  motion: CompanionMotion;
  /** False hides the companion in the shell, Today and Assistant. Studio still shows it so it can be turned back on. */
  visible: boolean;
};

export const DEFAULT_APPEARANCE: CompanionAppearance = { version: 1, form: 'core', tint: 190, motion: 'live', visible: true };

export type FormInfo = { id: CompanionForm; name: string; description: string; defaultTint: number };

export const FORMS: readonly FormInfo[] = [
  { id: 'core', name: 'Arc core', description: 'Dark refractive glass holding cyan plasma filaments over ultraviolet depth.', defaultTint: 190 },
  { id: 'lattice', name: 'Lattice', description: 'A holographic cage of light that turns inside the glass as the app works.', defaultTint: 186 },
  { id: 'ribbon', name: 'Ribbon', description: 'Three thin bands of light orbiting inside clear glass.', defaultTint: 262 },
  { id: 'frost', name: 'Frost', description: 'Pale frosted glass with a soft inner light. Calmest on the Chrome theme.', defaultTint: 196 },
  { id: 'character', name: 'Classic character', description: 'The character pack you edited in earlier versions, drawn from your saved pack.', defaultTint: 190 },
];

export const TINT_PRESETS: readonly { name: string; hue: number }[] = [
  { name: 'Cyan', hue: 190 },
  { name: 'Ultraviolet', hue: 255 },
  { name: 'Magenta', hue: 318 },
  { name: 'Acid', hue: 82 },
  { name: 'Amber', hue: 38 },
];

export const formInfo = (id: CompanionForm): FormInfo => FORMS.find((f) => f.id === id) ?? FORMS[0];

const isForm = (v: unknown): v is CompanionForm => typeof v === 'string' && FORMS.some((f) => f.id === v);
/** Form ids used during development of this revamp; mapped so a saved preview choice is not lost. */
const RENAMED: Record<string, CompanionForm> = { porcelain: 'frost', smoke: 'core' };
const isMotion = (v: unknown): v is CompanionMotion => v === 'live' || v === 'calm' || v === 'still';

/** Accepts anything read from storage; unknown fields are dropped and bad values fall back to the defaults. */
export function normalizeAppearance(raw: unknown): CompanionAppearance {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_APPEARANCE };
  const r = raw as Record<string, unknown>;
  const tint = typeof r.tint === 'number' && Number.isFinite(r.tint) ? ((Math.round(r.tint) % 360) + 360) % 360 : DEFAULT_APPEARANCE.tint;
  return {
    version: 1,
    form: isForm(r.form) ? r.form : typeof r.form === 'string' && RENAMED[r.form] ? RENAMED[r.form] : DEFAULT_APPEARANCE.form,
    tint,
    motion: isMotion(r.motion) ? r.motion : DEFAULT_APPEARANCE.motion,
    visible: typeof r.visible === 'boolean' ? r.visible : true,
  };
}

export function sameAppearance(a: CompanionAppearance, b: CompanionAppearance): boolean {
  return a.form === b.form && a.tint === b.tint && a.motion === b.motion && a.visible === b.visible;
}

/* ---------- Real companion states ---------- */

/**
 * States come from what the app is actually doing. "thinking" is shown as Working and "alert" as Needs attention;
 * the stored ids are unchanged so older code and tests keep their meaning.
 */
export type CompanionState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'alert';

export const COMPANION_STATES: readonly { id: CompanionState; label: string; description: string }[] = [
  { id: 'idle', label: 'Idle', description: 'Nothing is running.' },
  { id: 'listening', label: 'Listening', description: 'The microphone is recording because you pressed talk.' },
  { id: 'transcribing', label: 'Transcribing', description: 'Your recording is being turned into text.' },
  { id: 'thinking', label: 'Working', description: 'Waiting for a reply or planning an action.' },
  { id: 'speaking', label: 'Speaking', description: 'A reply is being read aloud.' },
  { id: 'alert', label: 'Needs attention', description: 'Something did not work. The screen says what and how to fix it.' },
];

export const stateLabel = (s: string): string => COMPANION_STATES.find((x) => x.id === s)?.label ?? 'Idle';

/**
 * Visual targets for the renderer, per state. energy: how bright and active the core is. swirl: speed of the
 * inner flow. sweep: the transcribing band. pulse: the speaking rhythm. alert: warm warning tint.
 * Audio amplitude is never part of this table: only a real measured level (passed separately) moves the core.
 */
export type StateTargets = { energy: number; swirl: number; sweep: number; pulse: number; alert: number; ring: number };

export const STATE_TARGETS: Record<CompanionState, StateTargets> = {
  idle: { energy: 0.42, swirl: 0.18, sweep: 0, pulse: 0, alert: 0, ring: 0.28 },
  listening: { energy: 0.66, swirl: 0.3, sweep: 0, pulse: 0, alert: 0, ring: 1 },
  transcribing: { energy: 0.58, swirl: 0.45, sweep: 1, pulse: 0, alert: 0, ring: 0.7 },
  thinking: { energy: 0.74, swirl: 1, sweep: 0, pulse: 0, alert: 0, ring: 0.85 },
  speaking: { energy: 0.7, swirl: 0.35, sweep: 0, pulse: 1, alert: 0, ring: 0.8 },
  alert: { energy: 0.5, swirl: 0.12, sweep: 0, pulse: 0, alert: 1, ring: 0.6 },
};

export function stateTargets(s: string): StateTargets {
  return STATE_TARGETS[(s in STATE_TARGETS ? s : 'idle') as CompanionState];
}

/** Moves the current values toward the targets with a time constant, so a state change eases instead of jumping. */
export function easeTargets(cur: StateTargets, target: StateTargets, dtMs: number, tauMs = 260): StateTargets {
  const k = dtMs <= 0 ? 0 : 1 - Math.exp(-dtMs / Math.max(1, tauMs));
  const step = (a: number, b: number) => a + (b - a) * k;
  return { energy: step(cur.energy, target.energy), swirl: step(cur.swirl, target.swirl), sweep: step(cur.sweep, target.sweep), pulse: step(cur.pulse, target.pulse), alert: step(cur.alert, target.alert), ring: step(cur.ring, target.ring) };
}

/* ---------- Frame scheduling ---------- */

/**
 * Frames per second a placement asks for. Still motion and reduced motion never loop (0 = draw only when something
 * changes). Small idle placements run slower than the large Studio preview.
 */
export function placementFps(o: { motion: CompanionMotion; reducedMotion: boolean; state: string; cssSize: number; lowPower?: boolean }): number {
  if (o.reducedMotion || o.motion === 'still') return 0;
  const active = o.state !== 'idle';
  if (o.lowPower) return active ? 30 : 15;
  if (o.motion === 'calm') return active ? 30 : 20;
  if (o.cssSize >= 160) return 60;
  return active ? 60 : 30;
}

/** Device-pixel ratio used for a placement's canvas: at most 2, and at most 1.5 for very large previews. */
export function placementDpr(devicePixelRatio: number, cssSize: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, cssSize > 280 ? 1.5 : 2);
}

/** HSL hue to linear-ish RGB (0..1) for shader uniforms. Saturation and lightness are fixed per form in the shader. */
export function hueToRgb(hue: number, s = 0.62, l = 0.58): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
