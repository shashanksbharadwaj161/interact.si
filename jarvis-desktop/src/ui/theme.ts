/**
 * Theme choice. The principal experience is the dark Obsidian theme, so Dark is the default; Chrome (light) and
 * System are explicit choices. The stored settings.theme value from earlier builds is kept untouched for compatibility
 * and only used to migrate: an explicit Paper choice becomes Light.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREF_KEY = 'appearance.theme';

export const THEME_CHOICES: readonly { value: ThemeChoice; label: string }[] = [
  { value: 'dark', label: 'Obsidian' },
  { value: 'light', label: 'Chrome' },
  { value: 'system', label: 'System' },
];

export function normalizeThemeChoice(raw: unknown, legacy?: string): ThemeChoice {
  if (raw === 'system' || raw === 'light' || raw === 'dark') return raw;
  return legacy === 'paper' ? 'light' : 'dark';
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice;
  return systemDark ? 'dark' : 'light';
}

/** The legacy settings.theme value that matches a choice, so older builds reading the same data still look right. */
export function legacyThemeFor(choice: ThemeChoice): 'graphite' | 'paper' | null {
  return choice === 'light' ? 'paper' : choice === 'dark' ? 'graphite' : null;
}
