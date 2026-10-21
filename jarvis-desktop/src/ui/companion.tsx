import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AvatarState } from '../components/Avatar';
import { createAnimMachine, finish, isSettled, setReducedMotion, transition, viewAt, type AnimMachine, type AnimView } from './anim-state';

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

/** True when the root motion attribute (setting, Windows or battery rule) or the OS media query asks for reduced motion. */
export function readReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.dataset.motion === 'reduced') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Drives one interruptible animation slot from a target (null = hidden). Each target change starts a new leg
 * from the CURRENT progress; the previous requestAnimationFrame loop is cancelled first so two loops never run,
 * and the loop is cancelled on unmount. With reduced motion every change is a single instantaneous step.
 */
export function useAnimMachine(target: string | null, opts?: { reducedMotion?: boolean }): AnimView {
  const reduced = opts?.reducedMotion ?? readReducedMotion();
  const machine = useRef<AnimMachine | null>(null);
  if (machine.current === null) machine.current = createAnimMachine({ reducedMotion: reduced, now: nowMs(), initial: target });
  const [view, setView] = useState<AnimView>(() => viewAt(machine.current as AnimMachine, nowMs()));
  useEffect(() => {
    let raf = 0;
    const start = nowMs();
    let m = setReducedMotion(machine.current as AnimMachine, reduced, start);
    m = transition(m, target === null ? { type: 'hide' } : { type: 'show', target }, start);
    machine.current = m;
    setView(viewAt(m, start));
    const canFrame = typeof requestAnimationFrame === 'function';
    const step = () => {
      raf = 0;
      const t = nowMs();
      m = transition(m, { type: 'tick' }, t);
      machine.current = m;
      setView(viewAt(m, t));
      if (!isSettled(m)) raf = requestAnimationFrame(step);
    };
    if (!isSettled(m)) {
      if (canFrame) raf = requestAnimationFrame(step);
      else {
        m = finish(m, start);
        machine.current = m;
        setView(viewAt(m, start));
      }
    }
    return () => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
  }, [target, reduced]);
  return view;
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

/** The live companion when rendered inside CompanionProvider, otherwise null (isolated previews and tests). */
export function useOptionalCompanion(): Companion | null {
  return useContext(Ctx);
}

export function useCompanion(): Companion {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCompanion outside provider');
  return c;
}
