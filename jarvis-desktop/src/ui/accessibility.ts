/**
 * Accessibility helpers: system preference detection, the root attributes that
 * src/styles/accessibility.css reads, and keyboard chord matching for the shell.
 *
 * DOM-free by design. Browser objects (matchMedia, the root element, key events) are passed in as
 * small structural types, so the Node tests can exercise every function with fakes. Nothing here
 * reads storage, files or desktop input.
 */

/**
 * The shell entry must import this stylesheet after the component styles (src/main.tsx does). Without that import the
 * reduced-motion, forced-colors and focus rules do not apply, and the Switch knob and track lose their forced-colors fills.
 */
export const ACCESSIBILITY_STYLESHEET = './styles/accessibility.css' as const;

/** Media queries for the OS signals. src/styles/accessibility.css uses the same strings. */
export const MEDIA = {
  reducedMotion: '(prefers-reduced-motion: reduce)',
  forcedColors: '(forced-colors: active)',
} as const;

/** The subset of MediaQueryList this module uses. The browser's window.matchMedia satisfies it. */
export type MediaQueryLike = {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
};
export type MatchMediaLike = (query: string) => MediaQueryLike;

export type SystemPreferences = { reducedMotion: boolean; forcedColors: boolean };

/** Missing matchMedia (or a missing query result) reads as "no preference", never as an error. */
export function readSystemPreferences(matchMedia: MatchMediaLike | undefined): SystemPreferences {
  const matches = (query: string): boolean => matchMedia?.(query)?.matches === true;
  return { reducedMotion: matches(MEDIA.reducedMotion), forcedColors: matches(MEDIA.forcedColors) };
}

/**
 * Calls onChange with a fresh reading whenever any watched query changes. Returns a function that
 * removes the listeners. Without matchMedia it does nothing and returns a no-op cleanup.
 */
export function watchSystemPreferences(matchMedia: MatchMediaLike | undefined, onChange: (prefs: SystemPreferences) => void): () => void {
  if (!matchMedia) return () => {};
  const lists = Object.values(MEDIA).map((query) => matchMedia(query));
  const emit = () => onChange(readSystemPreferences(matchMedia));
  for (const mq of lists) mq.addEventListener?.('change', emit);
  return () => {
    for (const mq of lists) mq.removeEventListener?.('change', emit);
  };
}

/** Reduced motion is requested if either the OS or the in-app setting asks for it. Neither can cancel the other. */
export function resolveReducedMotion(systemReduced: boolean, appReduced: boolean): boolean {
  return systemReduced === true || appReduced === true;
}

/** Non-sensitive accessibility choices kept with the other UI preferences (see src/ui/prefs.ts). */
export type AccessibilityPrefs = { reduceMotion: boolean };
export const DEFAULT_ACCESSIBILITY_PREFS: AccessibilityPrefs = { reduceMotion: false };

/** Coerce stored or imported values into valid prefs. Only a literal true enables a setting; unknown fields are dropped. */
export function normalizeAccessibilityPrefs(raw: unknown): AccessibilityPrefs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_ACCESSIBILITY_PREFS };
  return { reduceMotion: (raw as { reduceMotion?: unknown }).reduceMotion === true };
}

export type AccessibilityState = { reduceMotion: boolean; forcedColors: boolean };

export function resolveAccessibilityState(system: SystemPreferences, prefs: AccessibilityPrefs): AccessibilityState {
  return {
    reduceMotion: resolveReducedMotion(system.reducedMotion, prefs.reduceMotion),
    forcedColors: system.forcedColors,
  };
}

/**
 * Writes the state to the root element as data attributes: data-motion="reduced|full" (the value
 * App.tsx already used) and data-forced-colors="active|none". Styles and components read these.
 */
export function applyAccessibilityAttributes(el: { dataset: Record<string, string | undefined> }, state: AccessibilityState): void {
  el.dataset.motion = state.reduceMotion ? 'reduced' : 'full';
  el.dataset.forcedColors = state.forcedColors ? 'active' : 'none';
}

/* ---------- Keyboard chords ---------- */

export type KeyEventLike = { key: string; altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean };

export type Chord = { key: string; alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };

const MODIFIERS: Record<string, keyof Omit<Chord, 'key'>> = {
  alt: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  meta: 'meta',
  win: 'meta',
};

/**
 * Parses "Ctrl+Shift+S" style text. Returns null for unknown modifiers or a missing key.
 * The key itself cannot be "+"; no shortcut in this app needs it.
 */
export function parseChord(chord: string): Chord | null {
  const parts = chord.split('+').map((p) => p.trim());
  const key = parts.pop() ?? '';
  if (!key) return null;
  const parsed: Chord = { key: key.toLowerCase(), alt: false, ctrl: false, shift: false, meta: false };
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    parsed[modifier] = true;
  }
  return parsed;
}

/** True only when the key and all four modifiers match exactly. Extra modifiers do not match. */
export function matchesChord(chord: string, e: KeyEventLike): boolean {
  const want = parseChord(chord);
  if (!want) return false;
  return (
    want.key === e.key.toLowerCase() &&
    want.alt === e.altKey &&
    want.ctrl === e.ctrlKey &&
    want.shift === e.shiftKey &&
    want.meta === e.metaKey
  );
}

/** Alt+1…Alt+9 reach positions 1–9 and Alt+0 reaches position 10. The shell never shows more than ten. */
export const VIEW_SHORTCUT_LIMIT = 10;
export const VIEW_SHORTCUTS: readonly { position: number; chord: string }[] = Array.from({ length: VIEW_SHORTCUT_LIMIT }, (_, i) => ({
  position: i + 1,
  chord: i === VIEW_SHORTCUT_LIMIT - 1 ? 'Alt+0' : `Alt+${i + 1}`,
}));

/** Chord label for a 1-based nav position, or null when that position has no shortcut (for example 11). */
export function viewShortcut(position: number): string | null {
  return Number.isInteger(position) ? VIEW_SHORTCUTS[position - 1]?.chord ?? null : null;
}

/**
 * The 1-based view position a key event asks for, or null. Only Alt plus a digit counts, with no other
 * modifiers. Positions above viewCount (capped at ten) return null, so a short nav list cannot be jumped past.
 */
export function viewPositionFromEvent(e: KeyEventLike, viewCount: number = VIEW_SHORTCUT_LIMIT): number | null {
  if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey) return null;
  if (!/^[0-9]$/.test(e.key)) return null;
  const position = e.key === '0' ? VIEW_SHORTCUT_LIMIT : Number(e.key);
  return position <= Math.min(VIEW_SHORTCUT_LIMIT, viewCount) ? position : null;
}
