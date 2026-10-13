import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { readPref, writePref } from './prefs';
import { useStore } from './store';
import { fmtClock } from './util';

export type FocusPhase = 'idle' | 'running' | 'paused' | 'done';
type Saved = { phase: FocusPhase; durationSec: number; endsAt: number | null; pausedLeftSec: number; taskId: string | null; taskTitle: string | null };

const IDLE: Saved = { phase: 'idle', durationSec: 25 * 60, endsAt: null, pausedLeftSec: 25 * 60, taskId: null, taskTitle: null };

type Focus = {
  phase: FocusPhase;
  durationSec: number;
  remainingSec: number;
  taskId: string | null;
  taskTitle: string | null;
  start: (minutes: number, task?: { id: string; title: string } | null) => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
};

const Ctx = createContext<Focus | null>(null);

export function useFocus(): Focus {
  const f = useContext(Ctx);
  if (!f) throw new Error('useFocus outside provider');
  return f;
}

/**
 * Focus timer that survives view changes and reloads by storing an absolute end time. It is a local
 * timer only: finished sessions are not recorded anywhere.
 */
export function FocusProvider({ children }: { children: ReactNode }) {
  const { toast } = useStore();
  const [saved, setSaved] = useState<Saved>(() => {
    const s = readPref<Saved>('focus', IDLE);
    return s.phase === 'running' && s.endsAt !== null && s.endsAt <= Date.now() ? { ...s, phase: 'done', endsAt: null, pausedLeftSec: 0 } : s;
  });
  const [now, setNow] = useState(() => Date.now());

  const commit = useCallback((s: Saved) => {
    setSaved(s);
    writePref('focus', s);
  }, []);

  useEffect(() => {
    if (saved.phase !== 'running') return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [saved.phase]);

  const remainingSec = saved.phase === 'running' && saved.endsAt !== null ? Math.max(0, Math.ceil((saved.endsAt - now) / 1000)) : saved.phase === 'done' ? 0 : saved.pausedLeftSec;

  useEffect(() => {
    if (saved.phase === 'running' && remainingSec <= 0) {
      commit({ ...saved, phase: 'done', endsAt: null, pausedLeftSec: 0 });
      toast('ok', saved.taskTitle ? `Focus session finished: ${saved.taskTitle}` : 'Focus session finished.');
    }
  }, [saved, remainingSec, commit, toast]);

  useEffect(() => {
    const base = 'Desktop Companion';
    document.title = saved.phase === 'running' ? `${fmtClock(remainingSec)} focus · ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [saved.phase, remainingSec]);

  const value = useMemo<Focus>(
    () => ({
      phase: saved.phase,
      durationSec: saved.durationSec,
      remainingSec,
      taskId: saved.taskId,
      taskTitle: saved.taskTitle,
      start: (minutes, task) => {
        const durationSec = Math.round(Math.min(180, Math.max(1, minutes)) * 60);
        setNow(Date.now());
        commit({ phase: 'running', durationSec, endsAt: Date.now() + durationSec * 1000, pausedLeftSec: durationSec, taskId: task?.id ?? null, taskTitle: task?.title ?? null });
      },
      pause: () => commit({ ...saved, phase: 'paused', endsAt: null, pausedLeftSec: remainingSec }),
      resume: () => {
        setNow(Date.now());
        commit({ ...saved, phase: 'running', endsAt: Date.now() + saved.pausedLeftSec * 1000 });
      },
      reset: () => commit({ ...IDLE, durationSec: saved.durationSec, pausedLeftSec: saved.durationSec }),
    }),
    [saved, remainingSec, commit],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
