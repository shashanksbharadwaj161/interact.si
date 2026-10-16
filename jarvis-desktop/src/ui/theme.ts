/**
 * Theme choice for the Porcelain / Ink system. The choice is a UI preference (System by default); the stored
 * settings.theme value from earlier builds is kept untouched for compatibility and only used to migrate:
 * an explicit Paper choice becomes Light, the older dark themes follow the system.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREF_KEY = 'appearance.theme';

export const THEME_CHOICES: readonly { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function normalizeThemeChoice(raw: unknown, legacy?: string): ThemeChoice {
  if (raw === 'system' || raw === 'light' || raw === 'dark') return raw;
  return legacy === 'paper' ? 'light' : 'system';
}

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'light' || choice === 'dark') return choice;
  return systemDark ? 'dark' : 'light';
}

/** The legacy settings.theme value that matches a choice, so older builds reading the same data still look right. */
export function legacyThemeFor(choice: ThemeChoice): 'graphite' | 'paper' | null {
  return choice === 'light' ? 'paper' : choice === 'dark' ? 'graphite' : null;
}
