import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CompanionApi, CompanionStatus, PlacementEvent, RegionEvent, TypingTarget } from '../api';
import { AnswerView, Command, ConfirmView, ErrorView, WorkView, type HubView } from '../surfaces';
import { companionVoiceBackend } from '../../voice/backends';
import { useCompanionVoiceCaps } from '../../voice/companion';
import { useVoiceSession } from '../../voice/useVoiceSession';
import { TalkButton, VoiceBar } from '../../voice/VoiceBar';
import { IslandShell } from './IslandShell';
import type { Rect, Side } from './motion';
import { islandEdge, workLine, type IslandState } from './state';
import { islandPetSignals, useIslandRun } from './useIslandRun';
import { useReducedMotion } from './useReducedMotion';
import '../../styles/voice.css';

/*
 * The companion island, end to end: the production shell (IslandShell) with the shared surfaces, driven only by real
 * state: the person's actions, the main process's pushes (invoke, collapse, placement, target, region) and the
 * current run's agent events. It owns the request, the context chips (remembered window, picked screen area, voice
 * transcript), the voice session, the utility tray, Escape, and the native layout requests (grow before opening,
 * shrink only after the close animation ended).
 *
 * The page around it (CompanionApp, owned separately) keeps the character: its sprite, drag, hit testing, gaze and
 * the pet adapter. Integration: render <CompanionIsland api={api} … /> instead of the old bubble block, feed
 * `onPetSignals` into the adapter, and include `hitRect` in the hit test. See planning/ui-revamp/ISLAND-INTEGRATION.md.
 */

export type CompanionIslandProps = {
  api: CompanionApi | null;
  /** Keyboard alternatives for placement (PlacementOptions from ../surfaces), shown from the command view's ⋯ button. */
  options?: ReactNode;
  reducedMotion?: boolean;
  /** Where the island's content is on screen (window-local px), for the page's hit test; null while closed. */
  onHitRect?: (r: Rect | null) => void;
  /** Real island state for the character (feed into createPetAdapter().signal). */
  onPetSignals?: (s: ReturnType<typeof islandPetSignals>) => void;
  /** Called with the latest status the island fetched (readiness, appearance, size, dock, target, material). */
  onStatus?: (s: CompanionStatus) => void;
  /** The utility tray's content (tasks, notes, routines, apps…). Without it the Utilities button is not shown. */
  tray?: (close: () => void) => ReactNode;
  /** Frame timing of the shell's moves (review journeys and diagnostics only). */
  onFrameSample?: (f: { at: number; dt: number; via: 'raf' | 'timer'; phase: 'open' | 'morph' | 'close' }) => void;
  /** Toggle that opens the utility tray (default Ctrl+.). */
  utilitiesShortcut?: { key: string; ctrl?: boolean; label: string };
};

const DEFAULT_UTILITIES = { key: '.', ctrl: true, label: 'Ctrl+.' };
const CONSENT_HINT = 'Allow the microphone for the companion first (Utilities › Voice). Nothing is recorded until you do.';

export function CompanionIsland(p: CompanionIslandProps) {
  const api = p.api;
  const run = useIslandRun(api);
  const { state, dispatch } = run;
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [placement, setPlacement] = useState<PlacementEvent | null>(null);
  const [target, setTarget] = useState<TypingTarget | null>(null);
  const [region, setRegion] = useState<RegionEvent | null>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const shortcut = p.utilitiesShortcut ?? DEFAULT_UTILITIES;
  const liveReduced = useReducedMotion();
  // The app's own setting arrives on status (reduceMotion, when the main process provides it) or on the root attribute.
  const reduced = p.reducedMotion ?? (liveReduced || (status as (CompanionStatus & { reduceMotion?: boolean }) | null)?.reduceMotion === true);
  const hasTray = !!p.tray;
  const props = useRef(p);
  props.current = p;

  // Voice: the island's own session over its island-only IPC (local Windows speech). The transcript goes into the
  // message field for review; nothing is sent until the person presses Ask.
  const backend = useMemo(() => companionVoiceBackend(api), [api]);
  const voiceCaps = useCompanionVoiceCaps(api);
  const { voice, snap, blocks } = useVoiceSession({
    backend,
    caps: voiceCaps.caps,
    consentHint: CONSENT_HINT,
    onTranscript: (t) => {
      setText((prev) => (prev.trim() ? `${prev.trim()} ${t.text}` : t.text).slice(0, 2000));
      setNote(t.hint ? `Transcript added for review. ${t.hint}` : 'Transcript added for review. Edit it, then Ask.');
    },
  });

  const refresh = useCallback(() => {
    if (!api) return;
    void api.state().then((s) => {
      setStatus(s);
      setTarget(s.target);
      props.current.onStatus?.(s);
    }).catch(() => undefined);
  }, [api]);
  useEffect(refresh, [refresh]);

  // Collapsing forgets the picked screen area (its single-use token is discarded in the main process too) and stops voice.
  const regionRef = useRef<RegionEvent | null>(null);
  regionRef.current = region;
  const collapse = useCallback(() => {
    voice.release();
    setShowOptions(false);
    const r = regionRef.current;
    if (r) void api?.regionDiscard(r.token);
    setRegion(null);
    dispatch({ type: 'collapse' });
  }, [api, voice, dispatch]);

  const invoke = useCallback(() => {
    refresh();
    voiceCaps.refresh();
    setNote(null);
    dispatch({ type: 'invoke' });
  }, [refresh, voiceCaps, dispatch]);

  // Pushes from the main process.
  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((e) => {
      if ('runId' in e) return;
      if (e.type === 'invoke') invoke();
      else if (e.type === 'collapse') collapse();
      else if (e.type === 'placement') setPlacement(e);
      else if (e.type === 'target') setTarget(e.target);
      else if (e.type === 'region') {
        setRegion(e);
        dispatch({ type: 'invoke' });
        dispatch({ type: 'compose' });
      } else if (e.type === 'region-cancelled') dispatch({ type: 'compose' });
    });
  }, [api, invoke, collapse, dispatch]);

  // Reports for the page: the character's signals and where the island can be hit.
  useEffect(() => {
    props.current.onPetSignals?.(islandPetSignals(state));
  }, [state]);

  const ask = useCallback(async () => {
    const t = text.trim();
    if (!t) return;
    const token = region?.token;
    const ok = await run.ask({ text: t, token, withRegion: !!region, withTarget: !!target });
    // The region token is single use: once sent (or refused) it is gone either way.
    setRegion(null);
    if (ok) setText('');
  }, [text, region, target, run]);

  const removeRegion = useCallback(() => {
    if (region) void api?.regionDiscard(region.token);
    setRegion(null);
  }, [api, region]);

  const pickRegion = useCallback(async () => {
    setNote(null);
    const r = await api?.regionBegin().catch(() => ({ ok: false as const, reason: 'The selection could not start.' }));
    if (r && !r.ok) setNote(r.reason);
  }, [api]);

  const hub = useCallback((v: HubView, item?: string) => void api?.openHub(v, item), [api]);

  // Escape ends whatever is happening, one thing at a time: voice, then a request, then the tray, then the island.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (hasTray && e.key === shortcut.key && (shortcut.ctrl ? e.ctrlKey : true) && state.open) {
        e.preventDefault();
        dispatch({ type: 'tray', open: state.view !== 'tray' });
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      const v = voice.getSnapshot().phase;
      if (v === 'speaking') void voice.stopSpeaking();
      else if (v !== 'idle') voice.cancel();
      else if (run.running()) run.stop();
      else if (state.view === 'tray') dispatch({ type: 'tray', open: false });
      else collapse();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [voice, run, state.open, state.view, dispatch, collapse, shortcut.key, shortcut.ctrl, hasTray]);

  const box: Rect | null = placement?.bubble ?? null;
  const side: Side = placement?.side ?? 'left';
  const { edge, key } = islandEdge(state);
  const line = workLine(state);
  const confirmStep = [...state.steps].reverse().find((s) => s.phase === 'awaiting-confirm') ?? null;
  const ready = status?.readiness.ready === true;
  // Focus moves into the island once, when it is placed and visible (a hidden, measuring element cannot take focus).
  const focusNow = box !== null;

  let view: ReactNode = null;
  switch (state.view) {
    case 'command':
      view = (
        <Command
          status={status}
          text={text}
          setText={setText}
          region={region}
          note={note}
          options={p.options}
          showOptions={showOptions}
          onToggleOptions={() => setShowOptions((v) => !v)}
          onAsk={() => void ask()}
          onRegion={() => void pickRegion()}
          onRemoveRegion={removeRegion}
          onHub={hub}
          onClose={collapse}
          target={target}
          onClearTarget={() => {
            setTarget(null);
            void api?.clearTarget();
          }}
          autoFocus={focusNow}
          voice={
            <>
              <VoiceBar voice={voice} snap={snap} voiceName={voiceCaps.status?.voice || 'Windows default voice'} compact />
              {blocks.listen?.code === 'consent' && voiceCaps.caps.stt?.available && (
                <div className="ctx-chip vx-consent">
                  <span className="grow">
                    <strong>Talk is off</strong>
                    <span>The companion may use the microphone only after you allow it. It records only while you hold or tap Talk.</span>
                  </span>
                  <button type="button" className="chipbtn" onClick={() => voice.setConsent(true)}>
                    Allow microphone
                  </button>
                </div>
              )}
            </>
          }
          talk={ready || snap.phase !== 'idle' ? <TalkButton voice={voice} snap={snap} block={blocks.listen} /> : null}
          onUtilities={p.tray ? () => dispatch({ type: 'tray', open: true }) : undefined}
          utilitiesShortcut={shortcut.label}
        />
      );
      break;
    case 'working':
      view = <WorkView line={line} steps={state.steps} onStop={run.stop} autoFocus={focusNow} />;
      break;
    case 'confirm':
      view = <ConfirmView step={confirmStep} target={state.draft?.withTarget ? target : null} steps={state.steps} onStop={run.stop} autoFocus={focusNow} />;
      break;
    case 'answer':
      view = state.answer && (
        <AnswerView
          answer={state.answer}
          steps={state.steps}
          undone={run.undone}
          onUndo={(id) => void run.undo(id)}
          onOpen={(kind, id) => hub(kind === 'note' ? 'notes' : kind === 'task' ? 'tasks' : 'capsules', id)}
          onFollow={() => dispatch({ type: 'compose' })}
          onDone={collapse}
          autoFocus={focusNow}
        />
      );
      break;
    case 'error':
      view = state.failure && (
        <ErrorView
          failure={state.failure}
          steps={state.steps}
          undone={run.undone}
          onUndo={(id) => void run.undo(id)}
          draft={state.draft?.text ?? null}
          onBack={() => {
            if (state.draft && !text.trim()) setText(state.draft.text);
            dispatch({ type: 'compose' });
          }}
          onRetry={() => {
            const d = state.draft;
            if (d) void run.ask({ text: d.text, withRegion: false, withTarget: d.withTarget && !!target });
            else dispatch({ type: 'compose' });
          }}
          onSettings={() => hub('settings')}
          onDone={collapse}
          autoFocus={focusNow}
        />
      );
      break;
    case 'tray':
      view = p.tray ? p.tray(() => dispatch({ type: 'tray', open: false })) : null;
      break;
  }

  if (!api) return <p className="cmp-browser">This page runs inside the Desktop Companion app. In a browser it cannot reach the app.</p>;
  return (
    <IslandShell
      open={state.open}
      view={state.view}
      box={box}
      side={side}
      edge={edge}
      edgeKey={key}
      label={`Desktop companion: ${state.open ? state.view : 'resting'}`}
      reducedMotion={reduced}
      onContentSize={(size) => {
        if (state.open) void api.layout({ bubble: size });
      }}
      onRect={(r) => props.current.onHitRect?.(r)}
      onFrame={(f) => props.current.onFrameSample?.(f)}
      onClosed={() => {
        props.current.onHitRect?.(null);
        void api.layout({ bubble: null });
      }}
    >
      {view}
    </IslandShell>
  );
}
