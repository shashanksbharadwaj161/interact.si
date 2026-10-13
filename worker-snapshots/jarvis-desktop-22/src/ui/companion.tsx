import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AvatarState } from '../components/Avatar';

type Companion = {
  /** Live state derived from real activity (recording, waiting on a reply, speaking, error). */
  state: AvatarState;
  level: number;
  set: (s: AvatarState, holdMs?: number) => void;
  setLevel: (l: number) => void;
};

const Ctx = createContext<Companion | null>(null);

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AvatarState>('idle');
  const [level, setLevelState] = useState(0);
  const timer = useRef(0);
  const set = useCallback((s: AvatarState, holdMs?: number) => {
    window.clearTimeout(timer.current);
    setState(s);
    if (holdMs) timer.current = window.setTimeout(() => setState('idle'), holdMs);
  }, []);
  const setLevel = useCallback((l: number) => setLevelState(Math.round(l * 20) / 20), []);
  const value = useMemo(() => ({ state, level, set, setLevel }), [state, level, set, setLevel]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCompanion(): Companion {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCompanion outside provider');
  return c;
}
