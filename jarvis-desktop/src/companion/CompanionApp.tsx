import {useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {CompanionPet} from '../components/CompanionPet';
import {CompanionOrb} from '../components/CompanionOrb';
import type {CompanionState} from '../ui/appearance';
import {companionApi, type AgentEvent, type CompanionPush, type CompanionStatus, type PlacementEvent, type RegionEvent} from './api';

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
    void api?.state().then(setStatus).catch(() => undefined);
  }, [api]);
  useEffect(refresh, [refresh]);
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
      if (e.type === 'invoke') open();
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
      const r = await api.ask(t, token);
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
  const orbState: CompanionState = surface === 'error' ? 'alert' : working ? 'thinking' : 'idle';

  return (
    <Island surface={surface} anchor={anchor} edge={edge} doneKey={doneFlash} onOpen={open} label={`Desktop companion, ${surface === 'rest' ? 'resting' : surface}`} core={status?.appearance === 'legacy-orb' ? <CompanionOrb size={96} state={orbState} level={null} decorative showWhenHidden /> : <CompanionPet state={edge} decorative />}>
      {surface === 'rest' && <RestPill status={status} />}
      {surface === 'command' && (
        <Command
          status={status}
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
      {surface === 'command' && api && <PetControls status={status} onRefresh={refresh} />}
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
  if (!api) return null;
  return <details className="pet-controls">
    <summary>Make yourself at home</summary>
    <div className="pet-controls-body">
      <div className="pet-control-row"><span>Pet size</span><div role="group" aria-label="Pet size">
        {(['S', 'M', 'L'] as const).map((size, i) => <button key={size} type="button" className="btn btn-sm" disabled={busy} aria-pressed={status?.size === [64,96,128][i]} onClick={() => void change(() => api.resize(size))}>{size}</button>)}
      </div></div>
      <label className="pet-control-row"><span>Keep near</span><select aria-label="Dock companion" defaultValue="" disabled={busy} onChange={e => { const target = e.target.value as 'bottom-left' | 'bottom-right' | 'left' | 'right' | 'top'; if (target) void change(() => api.dock(target)); }}>
        <option value="" disabled>Choose an edge</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option><option value="left">Left</option><option value="right">Right</option><option value="top">Top</option>
      </select></label>
      <label className="pet-control-row"><span>Windows frosted glass</span><input type="checkbox" disabled={busy} checked={status?.material.requested === 'acrylic'} onChange={e => { const material = e.target.checked ? 'acrylic' : 'none'; void change(() => api.setMaterial(material)); }} /></label>
      <p className="p-meta">{status?.material.note}</p>
      <p className="p-meta">Drag the pet to move it. Character artwork is a concept; full pose animations are still being developed.</p>
      {error && <p className="cmd-note" role="alert">{error}</p>}
    </div>
  </details>;
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
function Island({surface, edge, doneKey, onOpen, label, core, children}: {surface: Surface; anchor: string; edge: Edge; doneKey: number; onOpen: () => void; label: string; core: ReactNode; children: ReactNode}) {
  const api = companionApi();
  const panel = useRef<HTMLDivElement>(null);
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
    const el = panel.current;
    if (!el) return;
    const measure = () => void api.layout({bubble: {width: Math.ceil(el.offsetWidth), height: Math.ceil(el.offsetHeight)}});
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [api, rest, surface]);
  const pet = placement?.pet ?? {x: 20, y: 20, width: 140, height: 152};
  const bubble = placement?.bubble ?? {x: 180, y: 20};
  const hit = (over: boolean) => { void api?.hit(over).catch(() => undefined); };
  const endDrag = () => {
    if (!pressed.current) return;
    pressed.current = false;
    void api?.drag('end');
  };
  return <div className="pet-desktop" aria-label={label}>
    <button type="button" className="pet-handle" style={{left: pet.x, top: pet.y, width: pet.width, height: pet.height}}
      aria-label="Open companion. Drag to move. Use arrow keys to dock; plus or minus to resize."
      onPointerEnter={() => hit(true)} onPointerLeave={() => hit(false)}
      onPointerDown={e => { if (e.button !== 0 || !api) return; pressed.current = true; e.currentTarget.setPointerCapture(e.pointerId); void api.drag('start'); }}
      onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={endDrag}
      onClick={e => { if (!api || e.detail === 0) onOpen(); }}
      onKeyDown={e => {
        const docks = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom-right'} as const;
        if (e.key in docks) { e.preventDefault(); void api?.dock(docks[e.key as keyof typeof docks]); }
        if (e.key === '+' || e.key === '-') { e.preventDefault(); void api?.resize(e.key === '+' ? 'grow' : 'shrink'); }
      }}>{core}</button>
    {!rest && <section className="island pet-bubble" data-surface={surface} data-edge={edge} style={{left: bubble.x, top: bubble.y, ...(placement?.bubble ? {maxWidth: placement.bubble.width, maxHeight: placement.bubble.height} : {})}}
      onPointerEnter={() => hit(true)} onPointerLeave={() => hit(false)}>
      <span className="edge" aria-hidden key={edge === 'done' ? `done-${doneKey}` : edge} />
      <div className="island-panel" data-s={surface} key={surface} ref={panel}>{children}</div>
    </section>}
    <span className="sr-only" role="status" aria-live="polite">{label}</span>
  </div>;
}

function Head({title, meta, children}: {title: string; meta?: ReactNode; children?: ReactNode}) {
  return (
    <header className="p-head">
      <div className="p-title">
        <strong>{title}</strong>
        {meta && <span className="p-meta">{meta}</span>}
      </div>
      <div className="p-tools">{children}</div>
    </header>
  );
}

function Foot({children}: {children: ReactNode}) {
  return <footer className="p-foot">{children}</footer>;
}

function RestPill({status}: {status: CompanionStatus | null}) {
  const ready = status?.readiness.ready;
  return (
    <div className="pill">
      <span className="pill-text">
        <strong>{ready ? 'Ready' : 'Companion'}</strong>
        <span>{status ? (ready ? 'Nothing is listening' : 'Not connected yet') : 'Starting…'}</span>
      </span>
      {status?.shortcut && <kbd>{status.shortcut.replace(/Control/g, 'Ctrl').replace(/\+/g, ' ')}</kbd>}
    </div>
  );
}

function Command(p: {
  status: CompanionStatus | null;
  text: string;
  setText: (t: string) => void;
  region: RegionEvent | null;
  note: string | null;
  onAsk: () => void;
  onRegion: () => void;
  onRemoveRegion: () => void;
  onHub: (view: 'home' | 'settings') => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  const readiness = p.status?.readiness;
  const ready = readiness?.ready === true;
  return (
    <div className="cmd">
      <Head title="Companion" meta={ready ? `Claude · ${readiness.model}` : 'Not connected'}>
        <button type="button" className="ibtn" onClick={() => p.onHub('home')} aria-label="Open the full hub" title="Open the full hub">
          <span aria-hidden>⤢</span>
        </button>
        <button type="button" className="ibtn" onClick={p.onClose} aria-label="Close (Esc)" title="Close (Esc)">
          <span aria-hidden>✕</span>
        </button>
      </Head>
      {readiness && !readiness.ready && (
        <div className="cmd-setup" role="status">
          <p>{readiness.reason}</p>
          <button type="button" className="btn btn-sm" onClick={() => p.onHub('settings')}>
            Open Settings › AI
          </button>
        </div>
      )}
      <form
        className="cmd-row"
        onSubmit={(e) => {
          e.preventDefault();
          p.onAsk();
        }}
      >
        <label htmlFor="cmp-input" className="sr-only">
          Ask or tell the companion
        </label>
        <textarea
          id="cmp-input"
          ref={input}
          className="cmd-input"
          rows={1}
          maxLength={2000}
          value={p.text}
          onChange={(e) => p.setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              p.onAsk();
            }
          }}
          placeholder={p.region ? 'Ask about the selected region' : 'Ask, or tell it to do something'}
          disabled={!ready}
        />
        <button type="submit" className="btn btn-primary" disabled={!ready || !p.text.trim()}>
          Ask
        </button>
      </form>
      {p.note && (
        <p className="cmd-note" role="status">
          {p.note}
        </p>
      )}
      <div className="ctx">
        {p.region ? (
          <div className="ctx-chip">
            <img className="ctx-img" src={p.region.preview} alt="The selected screen region" />
            <span className="grow">
              <strong>Region attached</strong>
              <span>
                {p.region.width}×{p.region.height} px. Sent with this request only, then forgotten.
              </span>
            </span>
            <button type="button" className="linkbtn" onClick={p.onRemoveRegion}>
              Remove
            </button>
          </div>
        ) : (
          <div className="ctx-empty">
            <span>No screen context attached.</span>
            <button type="button" className="chipbtn" onClick={p.onRegion} disabled={!ready}>
              Select a region
            </button>
          </div>
        )}
      </div>
      <Foot>
        <span className="p-meta">{ready ? `Sends your request${p.region ? ' and the region' : ''} to Anthropic with your key. Esc closes.` : 'Notes, tasks and search work in the hub without a key.'}</span>
      </Foot>
    </div>
  );
}

const PHASE_WORD: Record<ToolStep['phase'], string> = {running: 'Working', 'awaiting-confirm': 'Needs your answer', done: 'Done', declined: 'Not done', failed: 'Did not work'};

function StepList({steps}: {steps: ToolStep[]}) {
  if (!steps.length) return null;
  return (
    <ol className="steps">
      {steps.map((s) => (
        <li key={s.callId} className={`is-${s.phase}`}>
          <span className="step-word">{PHASE_WORD[s.phase]}</span> {s.summary}
          {s.phase === 'done' && s.verified && <span className="tag-ok">checked</span>}
        </li>
      ))}
    </ol>
  );
}

function Working({pending, steps, hasRun, onStop}: {pending: 'sending' | 'thinking' | null; steps: ToolStep[]; hasRun: boolean; onStop: () => void}) {
  const stop = useRef<HTMLButtonElement>(null);
  useEffect(() => stop.current?.focus(), []);
  const waiting = steps.some((s) => s.phase === 'awaiting-confirm');
  return (
    <div className="work">
      <Head title={waiting ? 'Waiting for you' : 'Working'} meta={waiting ? 'Answer the Windows confirmation. Cancel is the default.' : pending === 'sending' ? 'Sending to Claude' : pending === 'thinking' ? 'Claude is working on the next step' : 'Running a step'} />
      <StepList steps={steps} />
      <Foot>
        <span className="p-meta">Esc stops. Anything already confirmed stays done.</span>
        <button type="button" className="stop" ref={stop} onClick={onStop} disabled={!hasRun && !pending}>
          Stop
        </button>
      </Foot>
    </div>
  );
}

const CITE_RE = /\[(note|task|capsule):([A-Za-z0-9_-]{1,64})\]/g;

function AnswerView({answer, steps, undone, onUndo, onOpen, onFollow, onDone}: {answer: Answer; steps: ToolStep[]; undone: Record<string, 'done' | 'failed'>; onUndo: (id: string) => void; onOpen: (kind: 'note' | 'task' | 'capsule', id: string) => void; onFollow: () => void; onDone: () => void}) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => done.current?.focus(), []);
  const plain = answer.text.replace(CITE_RE, '').replace(/[ \t]+([.,;:!?])/g, '$1').trim();
  return (
    <div className="ans">
      <Head title="Answer" meta={`Claude · ${answer.steps} step${answer.steps === 1 ? '' : 's'}`} />
      <p className="ans-text">{plain}</p>
      {answer.citations.length > 0 && (
        <div className="cites" aria-label="Saved items used">
          {answer.citations.map((c) => (
            <button key={`${c.kind}:${c.id}`} type="button" className="cite" onClick={() => onOpen(c.kind, c.id)}>
              <span className="cite-kind">{c.kind}</span> {c.title.slice(0, 48)}
            </button>
          ))}
        </div>
      )}
      {/* What did not happen is shown as plainly as what did. */}
      <StepList steps={steps.filter((s) => s.phase === 'declined' || s.phase === 'failed')} />
      <Receipts steps={steps} undone={undone} onUndo={onUndo} />
      <Foot>
        <button type="button" className="btn" onClick={onFollow}>
          Follow up
        </button>
        <button type="button" className="btn btn-primary" ref={done} onClick={onDone}>
          Done
        </button>
      </Foot>
    </div>
  );
}

function Receipts({steps, undone, onUndo}: {steps: ToolStep[]; undone: Record<string, 'done' | 'failed'>; onUndo: (id: string) => void}) {
  const changes = steps.filter((s) => s.undo);
  if (!changes.length) return null;
  return (
    <ul className="receipts" aria-label="What changed">
      {changes.map((s) => (
        <li key={s.callId}>
          <span className="grow">{s.summary}</span>
          {undone[s.undo!.id] === 'done' ? (
            <span className="tag-ok">undone</span>
          ) : undone[s.undo!.id] === 'failed' ? (
            <span className="tag-warn">could not undo</span>
          ) : (
            <button type="button" className="btn btn-sm" onClick={() => onUndo(s.undo!.id)}>
              Undo
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ErrorView({failure, steps, undone, onUndo, onRetry, onSettings, onDone}: {failure: Failure; steps: ToolStep[]; undone: Record<string, 'done' | 'failed'>; onUndo: (id: string) => void; onRetry: () => void; onSettings: () => void; onDone: () => void}) {
  const title = {setup: 'Not set up yet', cancelled: 'Stopped', refused: 'Declined by Claude', truncated: 'Cut off', steps: 'Stopped after too many steps', provider: 'Claude could not answer', network: 'Could not reach Claude'}[failure.reason];
  return (
    <div className="ans is-error">
      <Head title={title} />
      <p className="ans-text" role="alert">
        {failure.message}
      </p>
      <StepList steps={steps} />
      <Receipts steps={steps} undone={undone} onUndo={onUndo} />
      <Foot>
        {failure.reason === 'setup' && (
          <button type="button" className="btn" onClick={onSettings}>
            Open Settings › AI
          </button>
        )}
        <button type="button" className="btn" onClick={onRetry}>
          {failure.reason === 'cancelled' ? 'Ask again' : 'Try again'}
        </button>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </Foot>
    </div>
  );
}
