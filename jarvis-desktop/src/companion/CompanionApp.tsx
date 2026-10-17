import {useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type MutableRefObject} from 'react';
import {PetIdentity} from './PetIdentity';
import type {PetHitTest} from '../pet/PetSprite';
import {Bubble, Command, Working, AnswerView, ErrorView, PlacementOptions} from './surfaces';
import '../styles/companion-bubble.css';
import {companionApi, type AgentEvent, type CompanionPush, type CompanionStatus, type PlacementEvent, type RegionEvent, type TypingTarget} from './api';

/*
 * The desktop companion island (production). One element docked to a screen edge that opens into a command surface,
 * shows the real progress of a request (model calls, tool steps, the Windows confirmation), answers briefly with the
 * saved items it used, offers undo for what it changed, and collapses back, giving the keyboard back to the app the
 * person was using. Every state shown comes from the main process: nothing here simulates activity.
 */

type Surface = 'rest' | 'command' | 'working' | 'answer' | 'error';
type ToolStep = Extract<AgentEvent, {type: 'tool'}>;
type Answer = Extract<AgentEvent, {type: 'answer'}>;
type Failure = Extract<AgentEvent, {type: 'error'}>;
type Edge = 'idle' | 'working' | 'waiting' | 'done' | 'error';


export function CompanionApp() {
  const api = companionApi();
  const [invoked, setInvoked] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const [gaze, setGaze] = useState<number | null>(null);
  const petHit = useRef<PetHitTest | null>(null);
  const [target, setTarget] = useState<TypingTarget | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [surface, setSurface] = useState<Surface>('rest');
  const [text, setText] = useState('');
  const [region, setRegion] = useState<RegionEvent | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [pending, setPending] = useState<'sending' | 'thinking' | null>(null);
  const [steps, setSteps] = useState<ToolStep[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [undone, setUndone] = useState<Record<string, 'done' | 'failed'>>({});
  const [note, setNote] = useState<string | null>(null);
  const [doneFlash, setDoneFlash] = useState(0);
  // The run id is tracked in a ref (set as soon as ask() returns) so events are matched without waiting for a render.
  const runRef = useRef<string | null>(null);
  const starting = useRef(false);
  const early = useRef<Extract<CompanionPush, {runId: string}>[]>([]);
  const anchor = 'corner';

  const refresh = useCallback(() => {
    void api?.state().then(s => {setStatus(s); setTarget(s.target);}).catch(() => undefined);
  }, [api]);
  useEffect(refresh, [refresh]);
  // The hub and floating window have distinct documents. Read only the narrow status (never user data) while visible
  // so a saved motion preference applies here as well. Pause the timer while this window is hidden.
  useEffect(() => {
    if (!api) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      clearInterval(timer);
      if (!document.hidden) {refresh(); timer = setInterval(refresh, 1500);}
    };
    document.addEventListener('visibilitychange', sync); sync();
    return () => {clearInterval(timer); document.removeEventListener('visibilitychange', sync);};
  }, [api, refresh]);
  useEffect(() => {
    document.documentElement.dataset.motion = status?.reduceMotion ? 'reduced' : 'full';
  }, [status?.reduceMotion]);
  // The surface thins out only when Windows reports the acrylic material applied; otherwise it stays solid smoked glass.
  useEffect(() => {
    document.documentElement.dataset.material = status?.material.applied ? 'acrylic' : 'solid';
  }, [status?.material.applied]);

  const open = useCallback(() => {
    refresh();
    setNote(null);
    setSurface((s) => (s === 'rest' ? 'command' : s));
  }, [refresh]);
  const collapse = useCallback(() => setSurface('rest'), []);

  // Applies one event of the current run. Only state setters are used, so it never goes stale.
  const applyRunEvent = useCallback((ev: AgentEvent) => {
    if (ev.type === 'status') setPending(ev.phase);
    else if (ev.type === 'tool') {
      setPending(null);
      setSteps((all) => {
        const i = all.findIndex((s) => s.callId === ev.callId);
        if (i < 0) return [...all, ev];
        const next = [...all];
        next[i] = ev;
        return next;
      });
    } else {
      setPending(null);
      runRef.current = null;
      setRunId(null);
      if (ev.type === 'answer') {
        setAnswer(ev);
        setSurface('answer');
        setDoneFlash((n) => n + 1);
      } else {
        setFailure(ev);
        setSurface('error');
      }
    }
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    return api.onEvent((e: CompanionPush) => {
      if ('runId' in e) {
        if (e.runId === runRef.current) applyRunEvent(e.event);
        // A fast reply (an instant provider error) can arrive before ask() has returned its run id: keep it until then.
        else if (starting.current) early.current.push(e);
        return;
      }
      if (e.type === 'drag') setDrag(e.vx);
      else if (e.type === 'gaze') setGaze(e.index);
      else if (e.type === 'placement') setStatus(s => s ? {...s, size: e.size, dock: e.dock} : s);
      else if (e.type === 'target') setTarget(e.target);
      else if (e.type === 'invoke') {setInvoked(v => v + 1); open();}
      else if (e.type === 'collapse') collapse();
      else if (e.type === 'region') {
        setRegion(e);
        setSurface('command');
      } else if (e.type === 'region-cancelled') setSurface('command');
    });
  }, [api, open, collapse, applyRunEvent]);

  // Escape: stop a running request first, otherwise collapse.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (runRef.current || starting.current) void api?.cancel();
      else collapse();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [api, collapse]);

  const ask = async () => {
    const t = text.trim();
    if (!api || !t || runRef.current || starting.current) return;
    setSteps([]);
    setAnswer(null);
    setFailure(null);
    setUndone({});
    setPending('sending');
    setSurface('working');
    const token = region?.token;
    setRegion(null);
    starting.current = true;
    early.current = [];
    try {
      const r = await api.ask(t, token, Boolean(target));
      runRef.current = r.runId;
      setRunId(r.runId);
      const queued = early.current.filter((q) => q.runId === r.runId);
      early.current = [];
      for (const q of queued) if (runRef.current === r.runId) applyRunEvent(q.event);
    } catch (e) {
      setPending(null);
      setFailure({type: 'error', reason: 'provider', message: e instanceof Error ? e.message : 'The request could not start.'});
      setSurface('error');
    } finally {
      starting.current = false;
    }
  };

  const undo = async (id: string) => {
    if (!api) return;
    const ok = await api.undo(id).catch(() => false);
    setUndone((u) => ({...u, [id]: ok ? 'done' : 'failed'}));
  };

  const working = surface === 'working';
  const waiting = steps.some((s) => s.phase === 'awaiting-confirm');
  const doneVisible = useDoneFlash(doneFlash);
  const edge: Edge = surface === 'error' ? 'error' : waiting ? 'waiting' : working ? 'working' : doneVisible ? 'done' : 'idle';

  return (
    <Island surface={surface} anchor={anchor} edge={edge} doneKey={doneFlash} onOpen={open} label={`Desktop companion, ${surface === 'rest' ? 'resting' : surface}`} hitRef={petHit} core={size => <PetIdentity size={size} appearance={status?.appearance ?? 'pet'} surface={surface} steps={steps} failure={failure?.reason ?? null} invoked={invoked} answered={doneFlash} drag={drag} gaze={gaze} hitRef={petHit} />}>

      {surface === 'command' && (
        <Command
          status={status}
          target={target}
          onClearTarget={() => { setTarget(null); void api?.clearTarget(); }}
          showOptions={showOptions}
          onToggleOptions={() => setShowOptions(v => !v)}
          options={<PetControls status={status} onRefresh={refresh} />}
          text={text}
          setText={setText}
          region={region}
          note={note}
          onAsk={() => void ask()}
          onRegion={async () => {
            setNote(null);
            const r = await api?.regionBegin().catch(() => ({ok: false as const, reason: 'The selection could not start.'}));
            if (r && !r.ok) setNote(r.reason);
          }}
          onRemoveRegion={() => {
            if (region) void api?.regionDiscard(region.token);
            setRegion(null);
          }}
          onHub={(v) => void api?.openHub(v)}
          onClose={collapse}
        />
      )}
      {surface === 'working' && <Working pending={pending} steps={steps} hasRun={!!runId} onStop={() => void api?.cancel()} />}
      {surface === 'answer' && answer && (
        <AnswerView answer={answer} steps={steps} undone={undone} onUndo={(id) => void undo(id)} onOpen={(kind, id) => void api?.openHub(kind === 'note' ? 'notes' : kind === 'task' ? 'tasks' : 'capsules', id)} onFollow={() => { setText(''); setSurface('command'); }} onDone={collapse} />
      )}
      {surface === 'error' && failure && <ErrorView failure={failure} steps={steps} undone={undone} onUndo={(id) => void undo(id)} onRetry={() => setSurface('command')} onSettings={() => void api?.openHub('settings')} onDone={collapse} />}
      {!api && <p className="cmp-browser">This page runs inside the Desktop Companion app. In a browser it cannot reach the app.</p>}
    </Island>
  );
}

function PetControls({status, onRefresh}: {status: CompanionStatus | null; onRefresh: () => void}) {
  const api = companionApi();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); onRefresh(); }
    catch { setError('That change could not be saved. Try again.'); }
    finally { setBusy(false); }
  };
  if (!api || !status) return null;
  return <div className="pet-preferences" aria-busy={busy}>
    <fieldset disabled={busy}>
      <legend className="sr-only">Companion appearance and placement</legend>
      <PlacementOptions size={status.size} dock={status.dock} appearance={status.appearance}
        onDock={d => void change(() => api.dock(d))}
        onResize={size => void change(() => api.resize(size))}
        onAppearance={appearance => void change(() => api.setAppearance(appearance))} />
      <label className="pet-control-row"><span>Windows frosted glass</span><input type="checkbox" checked={status.material.requested === 'acrylic'} onChange={e => { const material = e.target.checked ? 'acrylic' : 'none'; void change(() => api.setMaterial(material)); }} /></label>
    </fieldset>
    <p className="b-meta">{status.material.note}</p>
    <p className="b-meta">Animated character preview. The sprite includes nine action states and sixteen look directions.</p>
    {error && <p className="cmd-note" role="alert">{error}</p>}
  </div>;
}

function useDoneFlash(key: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!key) return undefined;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), 900);
    return () => window.clearTimeout(id);
  }, [key]);
  return on;
}

/**
 * The island element. Its size follows the current surface's content and the window follows the island: growing, the
 * window is enlarged first and the island springs open inside it; shrinking, the island closes first and the window
 * follows after the transition, so the edge light and shadow are never clipped.
 */
function Island({surface, edge, doneKey, onOpen, label, core, hitRef, children}: {surface: Surface; anchor: string; edge: Edge; doneKey: number; onOpen: () => void; label: string; core: (size: number) => ReactNode; hitRef: MutableRefObject<PetHitTest | null>; children: ReactNode}) {
  const api = companionApi();
  const panel = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState<PlacementEvent | null>(null);
  const pressed = useRef(false);
  const rest = surface === 'rest';
  useEffect(() => {
    if (!api) return;
    const off = api.onEvent(e => { if ('type' in e && e.type === 'placement') setPlacement(e); });
    return () => { off(); if (pressed.current) void api.drag('end'); };
  }, [api]);
  useLayoutEffect(() => {
    if (!api) return;
    if (rest) { void api.layout({bubble: null}); return; }
    const el = panel.current?.querySelector<HTMLElement>('.bubble-body');
    if (!el) return;
    const measure = () => void api.layout({bubble: {width: Math.ceil(el.offsetWidth), height: Math.ceil(el.offsetHeight)}});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [api, rest, surface]);
  const pet = placement?.pet ?? {x: 20, y: 20, width: 140, height: 152};
  const bubble = placement?.bubble ?? {x: 180, y: 20};
  const hit = useRef<boolean | null>(null);
  useEffect(() => {
    if (!api) return;
    const update = (e: MouseEvent) => {
      const inPet = hitRef.current?.(e.clientX - pet.x, e.clientY - pet.y) ?? false;
      const box = panel.current?.getBoundingClientRect();
      const inBubble = !!box && e.clientX >= box.left && e.clientY >= box.top && e.clientX < box.right && e.clientY < box.bottom;
      const over = inPet || inBubble;
      if (over !== hit.current) { hit.current = over; void api.hit(over).catch(() => undefined); }
    };
    const leave = () => { hit.current = false; void api.hit(false).catch(() => undefined); };
    document.addEventListener('mousemove', update); document.addEventListener('mouseleave', leave);
    return () => { document.removeEventListener('mousemove', update); document.removeEventListener('mouseleave', leave); };
  }, [api, pet.x, pet.y, pet.width, pet.height, rest, hitRef]);
  const endDrag = () => {
    if (!pressed.current) return;
    pressed.current = false;
    void api?.drag('end');
  };
  return <div className="pet-desktop" data-surface={surface} aria-label={label}>
    <button type="button" className="pet-handle" style={{left: pet.x, top: pet.y, width: pet.width, height: pet.height}}
      aria-label="Open companion. Drag to move. Use arrow keys to dock; plus or minus to resize."
      onPointerDown={e => { if (e.button !== 0 || !api) return; pressed.current = true; e.currentTarget.setPointerCapture(e.pointerId); void api.drag('start'); }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onClick={e => { if (!api || e.detail === 0) onOpen(); }}
      onKeyDown={e => {
        const docks = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom-right'} as const;
        if (e.key in docks) { e.preventDefault(); void api?.dock(docks[e.key as keyof typeof docks]); }
        if (e.key === '+' || e.key === '-') { e.preventDefault(); void api?.resize(e.key === '+' ? 'grow' : 'shrink'); }
      }}>{core(placement?.size ?? 96)}</button>
    {!rest && <Bubble ref={panel} surface={surface} side={placement?.side ?? 'none'} edge={edge} edgeKey={doneKey} label="Companion conversation"
      measuring={!!api && !placement?.bubble}
      style={{position: 'absolute', left: bubble.x, top: bubble.y, ...(placement?.bubble ? {width: placement.bubble.width, maxHeight: placement.bubble.height, '--bubble-height': `${placement.bubble.height}px`} : {})}}>
      {children}
    </Bubble>}
    <span className="sr-only" role="status" aria-live="polite">{label}</span>
  </div>;
}
