import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { APPEARANCE_PREF_KEY, normalizeAppearance, type CompanionAppearance } from './appearance';
import { readPref, writePref } from './prefs';

/**
 * The selected companion appearance, shared by every placement in this window. Applying a choice in Studio updates the
 * shell, Today, Assistant and onboarding at once and is saved on this computer (UI preferences, never a secret), so it
 * survives a relaunch. A change made in another window arrives through the storage event.
 */
type AppearanceCtx = { appearance: CompanionAppearance; setAppearance: (next: CompanionAppearance) => void };

const Ctx = createContext<AppearanceCtx | null>(null);

export function readAppearance(): CompanionAppearance {
  return normalizeAppearance(readPref<unknown>(APPEARANCE_PREF_KEY, null));
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setState] = useState<CompanionAppearance>(readAppearance);
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key === null || e.key.endsWith(APPEARANCE_PREF_KEY)) setState(readAppearance());
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, []);
  const setAppearance = useCallback((next: CompanionAppearance) => {
    const clean = normalizeAppearance(next);
    setState(clean);
    writePref(APPEARANCE_PREF_KEY, clean);
  }, []);
  const value = useMemo(() => ({ appearance, setAppearance }), [appearance, setAppearance]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The shared appearance. Outside the provider (isolated tests) it reads the saved value and writes straight to storage. */
export function useAppearance(): [CompanionAppearance, (next: CompanionAppearance) => void] {
  const c = useContext(Ctx);
  if (c) return [c.appearance, c.setAppearance];
  return [readAppearance(), (next) => writePref(APPEARANCE_PREF_KEY, normalizeAppearance(next))];
}
