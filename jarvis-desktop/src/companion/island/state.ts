import type { AgentEvent } from '../api';
import type { Answer, BubbleEdge, Failure, ToolStep } from '../surfaces';

/**
 * The island's state, derived only from real events: the person's own actions (invoke, ask, stop, collapse) and the
 * main process's agent events for the current run. Events from an older run are ignored, so a late reply can never
 * overwrite a newer request. Pure and unit-tested; no React, no DOM.
 *
 * Views (what the shell shows while open): command, working, confirm, answer, error, tray. Rest is `open: false`.
 * Listening and transcribing happen inside the command view (the voice session has its own state).
 */

export type IslandView = 'command' | 'working' | 'confirm' | 'answer' | 'error' | 'tray';
/** What the current request is really doing. `model` = waiting for Claude's next step after tool results. */
export type WorkStage = 'sending' | 'model' | 'tool' | 'confirm' | 'verifying';

export type IslandDraft = { text: string; withRegion: boolean; withTarget: boolean };

export type IslandState = {
  open: boolean;
  view: IslandView;
  runId: string | null;
  /** The view to return to when the tray closes. */
  before: IslandView | null;
  stage: WorkStage | null;
  steps: ToolStep[];
  answer: Answer | null;
  failure: Failure | null;
  /** The last request, kept so Retry and Follow up can restore it (the region token is single-use and is not kept). */
  draft: IslandDraft | null;
  /** What was on screen when it closed has been seen: the next opening starts at the command view. */
  seen: boolean;
};

export type IslandAction =
  | { type: 'invoke' }
  | { type: 'collapse' }
  | { type: 'tray'; open: boolean }
  | { type: 'ask'; runId: string; draft: IslandDraft }
  | { type: 'ask-failed'; message: string }
  | { type: 'agent'; runId: string; event: AgentEvent }
  /** Back to the command view (Follow up, Try again, or Back from the tray). */
  | { type: 'compose' };

export const initialIsland = (): IslandState => ({ open: false, view: 'command', runId: null, before: null, stage: null, steps: [], answer: null, failure: null, draft: null, seen: false });

const upsert = (steps: ToolStep[], s: ToolStep): ToolStep[] => {
  const i = steps.findIndex((x) => x.callId === s.callId);
  if (i < 0) return [...steps, s];
  const next = steps.slice();
  next[i] = s;
  return next;
};

export function islandReducer(s: IslandState, a: IslandAction): IslandState {
  switch (a.type) {
    case 'invoke':
      if (s.open) return s;
      return s.seen ? { ...s, open: true, seen: false, view: 'command', before: null, stage: null, steps: [], answer: null, failure: null } : { ...s, open: true };
    case 'collapse':
      // The content stays as it is while the island closes. A run in progress keeps going (its result waits for the
      // next opening); only Stop cancels it. With nothing in flight, the next opening starts at the command view.
      return { ...s, open: false, before: null, view: s.view === 'tray' ? s.before ?? 'command' : s.view, seen: !s.runId };
    case 'tray':
      if (a.open) return s.view === 'tray' ? s : { ...s, open: true, view: 'tray', before: s.view };
      return s.view === 'tray' ? { ...s, view: s.before ?? 'command', before: null } : s;
    case 'ask':
      return { ...s, open: true, view: 'working', runId: a.runId, stage: 'sending', steps: [], answer: null, failure: null, draft: a.draft, before: null };
    case 'ask-failed':
      return { ...s, view: 'error', stage: null, runId: null, failure: { type: 'error', reason: 'setup', message: a.message } };
    case 'compose':
      return { ...s, view: 'command', stage: null, before: null, ...(s.runId && s.stage ? {} : { steps: [], answer: null, failure: null }) };
    case 'agent': {
      if (a.runId !== s.runId) return s;
      const e = a.event;
      // While the tray is open the run still advances; the view returns to the run's view when the tray closes.
      const at = (view: IslandView): Pick<IslandState, 'view' | 'before'> => (s.view === 'tray' ? { view: 'tray', before: view } : { view, before: s.before });
      if (e.type === 'status') return { ...s, ...at('working'), stage: e.phase === 'sending' ? 'sending' : 'model' };
      if (e.type === 'tool') {
        const steps = upsert(s.steps, e);
        if (e.phase === 'awaiting-confirm') return { ...s, ...at('confirm'), steps, stage: 'confirm' };
        if (e.phase === 'running') return { ...s, ...at('working'), steps, stage: e.stage === 'verifying' ? 'verifying' : 'tool' };
        // done / declined / failed: Claude reads the result next.
        return { ...s, ...at('working'), steps, stage: 'model' };
      }
      if (e.type === 'answer') return { ...s, ...at('answer'), stage: null, answer: e, runId: null, seen: false };
      return { ...s, ...at('error'), stage: null, failure: e, runId: null, seen: false };
    }
  }
}

/** A change the companion checked after making it (a task it read back), as opposed to one it could not check. */
export const verifiedChanges = (steps: ToolStep[]) => steps.filter((x) => x.phase === 'done' && x.verified === true && x.undo);

/**
 * The perimeter light, from real state only: it traces while a request is being worked on, holds while waiting for the
 * person's answer, settles once on a verified change, and stops on Stop or an error. An answer that changed nothing
 * checkable gets no celebration.
 */
export function islandEdge(s: IslandState): { edge: BubbleEdge; key?: string } {
  if (s.view === 'working') return { edge: 'working' };
  if (s.view === 'confirm') return { edge: 'waiting' };
  if (s.view === 'error') return { edge: s.failure?.reason === 'cancelled' ? 'idle' : 'error' };
  if (s.view === 'answer') {
    const v = verifiedChanges(s.steps);
    return v.length ? { edge: 'done', key: v.map((x) => x.callId).join(',') } : { edge: 'idle' };
  }
  return { edge: 'idle' };
}

/** The named operation for the working and confirm views. Never a percentage, never the model's reasoning. */
export function workLine(s: IslandState): { title: string; detail: string } {
  const current = [...s.steps].reverse().find((x) => x.phase === 'running' || x.phase === 'awaiting-confirm');
  const done = s.steps.filter((x) => x.phase === 'done').length;
  switch (s.stage) {
    case 'sending':
      return { title: 'Sending your request to Claude', detail: 'Waiting for the reply. Nothing has run yet.' };
    case 'model':
      return { title: 'Claude is choosing the next step', detail: done ? `${done} step${done === 1 ? '' : 's'} finished so far.` : 'Reading what the last step returned.' };
    case 'tool':
      return { title: current?.label ?? 'Running a step', detail: current?.summary && current.summary !== current.label ? current.summary : 'Running on this computer.' };
    case 'confirm':
      return { title: 'Waiting for your answer', detail: current?.summary ?? 'Answer the Windows confirmation.' };
    case 'verifying':
      return { title: 'Checking the result', detail: current?.summary ?? 'Reading back what changed.' };
    default:
      return { title: 'Ready', detail: '' };
  }
}
