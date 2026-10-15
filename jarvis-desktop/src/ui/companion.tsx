import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AvatarState } from '../components/Avatar';

/**
 * Where the live amplitude comes from. 'none' means no audio source is attached, so a host such as the
 * Avatar Studio must fall back to its clearly labelled simulation. 'microphone' is only set by a view
 * while an explicit, user-initiated recording is open; nothing sets it on load.
 */
export type LevelSource = 'none' | 'microphone';

export type Companion = {
  /** Live state derived from real activity (recording, waiting on a reply, speaking, error). */
  state: AvatarState;
  /** Quantised amplitude 0..1. Meaningful only while `source` is not 'none'. */
  level: number;
  source: LevelSource;
  set: (s: AvatarState, holdMs?: number) => void;
  setLevel: (l: number) => void;
  /** Attach or detach the live amplitude source. Detaching always resets the level to 0. */
  setSource: (s: LevelSource) => void;
};

/** Rounds a raw 0..1 amplitude to 1/20 steps so a 60 Hz meter does not re-render the whole tree for noise. */
export function quantizeLevel(l: number): number {
  if (!Number.isFinite(l)) return 0;
  return Math.round(Math.min(1, Math.max(0, l)) * 20) / 20;
}

/**
 * The amplitude a host avatar should receive: the live level (including 0, so a quiet microphone still
 * counts as attached) while a source is open, or null when nothing real is attached.
 */
export function hostVoiceLevel(c: Pick<Companion, 'level' | 'source'>): number | null {
  return c.source === 'none' ? null : quantizeLevel(c.level);
}

const Ctx = createContext<Companion | null>(null);

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AvatarState>('idle');
  const [level, setLevelState] = useState(0);
  const [source, setSourceState] = useState<LevelSource>('none');
  const timer = useRef(0);
  const set = useCallback((s: AvatarState, holdMs?: number) => {
    window.clearTimeout(timer.current);
    setState(s);
    if (holdMs) timer.current = window.setTimeout(() => setState('idle'), holdMs);
  }, []);
  const setLevel = useCallback((l: number) => setLevelState(quantizeLevel(l)), []);
  const setSource = useCallback((s: LevelSource) => {
    setSourceState(s);
    if (s === 'none') setLevelState(0);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const value = useMemo(() => ({ state, level, source, set, setLevel, setSource }), [state, level, source, set, setLevel, setSource]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCompanion(): Companion {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCompanion outside provider');
  return c;
}
