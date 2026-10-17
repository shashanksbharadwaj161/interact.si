import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AgentEvent, CompanionApi, CompanionPush } from '../api';
import { initialIsland, islandReducer, type IslandAction, type IslandDraft, type IslandState } from './state';

type RunPush = Extract<CompanionPush, { runId: string }>;

/**
 * The island's request lifecycle over window.companion: ask, follow the run's real events, stop, undo. Events that
 * arrive before ask() has returned the run id (an instant provider error) are held and replayed for that id only;
 * events of any other run are ignored by the reducer.
 */
export function useIslandRun(api: Pick<CompanionApi, 'ask' | 'cancel' | 'undo' | 'onEvent'> | null) {
  const [state, dispatchRaw] = useReducer(islandReducer, undefined, initialIsland);
  const [undone, setUndone] = useState<Record<string, 'done' | 'failed'>>({});
  const runRef = useRef<string | null>(null);
  const starting = useRef(false);
  const early = useRef<RunPush[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback((a: IslandAction) => {
    if (a.type === 'agent' && (a.event.type === 'answer' || a.event.type === 'error') && a.runId === runRef.current) runRef.current = null;
    dispatchRaw(a);
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((e) => {
      if (!('runId' in e)) return;
      if (e.runId === runRef.current) dispatch({ type: 'agent', runId: e.runId, event: e.event as AgentEvent });
      else if (starting.current) early.current.push(e);
    });
  }, [api, dispatch]);

  const ask = useCallback(
    async (draft: IslandDraft & { token?: string }) => {
      const text = draft.text.trim();
      if (!api || !text || runRef.current || starting.current) return false;
      starting.current = true;
      early.current = [];
      setUndone({});
      try {
        const r = await api.ask(text, draft.token, draft.withTarget);
        runRef.current = r.runId;
        dispatchRaw({ type: 'ask', runId: r.runId, draft: { text, withRegion: draft.withRegion, withTarget: draft.withTarget } });
        const queued = early.current.filter((q) => q.runId === r.runId);
        early.current = [];
        for (const q of queued) dispatch({ type: 'agent', runId: q.runId, event: q.event as AgentEvent });
        return true;
      } catch (e) {
        dispatchRaw({ type: 'ask-failed', message: e instanceof Error && e.message ? e.message.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '') : 'The request could not start.' });
        return false;
      } finally {
        starting.current = false;
      }
    },
    [api, dispatch],
  );

  /** Stop: the main process aborts the run, which also closes an open Windows confirmation as Cancel. */
  const stop = useCallback(() => {
    if (runRef.current || starting.current) void api?.cancel();
  }, [api]);

  const undo = useCallback(
    async (id: string) => {
      if (!api) return;
      const ok = await api.undo(id).catch(() => false);
      setUndone((u) => ({ ...u, [id]: ok ? 'done' : 'failed' }));
    },
    [api],
  );

  const running = () => runRef.current !== null || starting.current;
  return { state, dispatch, ask, stop, undo, undone, running, stateRef };
}

/** What the character should know about the island, for the pet adapter (src/pet/adapter.ts PetSignals). */
export function islandPetSignals(s: IslandState): { surface: 'rest' | 'command' | 'working' | 'answer' | 'error'; requestInFlight: boolean; awaitingPerson: boolean; failure: Extract<AgentEvent, { type: 'error' }>['reason'] | null } {
  const surface = !s.open ? 'rest' : s.view === 'working' || s.view === 'confirm' ? 'working' : s.view === 'answer' ? 'answer' : s.view === 'error' ? 'error' : 'command';
  return {
    surface,
    requestInFlight: s.stage !== null && s.stage !== 'confirm',
    awaitingPerson: s.stage === 'confirm',
    failure: s.view === 'error' && s.failure && s.failure.reason !== 'cancelled' ? s.failure.reason : null,
  };
}
