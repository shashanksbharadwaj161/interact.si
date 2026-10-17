import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { CompanionOrb } from '../src/components/CompanionOrb';
import { addFlow, type FlowState } from './flow';
import { useAppearance } from '../src/ui/appearance-context';
import { FORMS, TINT_PRESETS, type CompanionState } from '../src/ui/appearance';
import { APPS, ABILITIES, CLIPBOARD_DEMO, INITIAL_TASKS, PERSONALITIES, REGION_REQUEST, REQUESTS, SIGNUPS, VOICE_LINE, type MockTask, type Scripted } from './script';

/*
 * Desktop companion experience prototype.
 *
 * One island lives on a display edge of a mock desktop. It is a single element that changes size, so it keeps its
 * place and mass while it opens into a command surface, a listening preview, a plan to confirm, a compact answer, the
 * utilities drawer, the customisation scene and finally the full hub. The core inside it is the app's real shared
 * renderer, drawn from the saved appearance. Everything said, heard or done is scripted (see script.ts) and labelled.
 */

type Surface = 'rest' | 'command' | 'listening' | 'acting' | 'answer' | 'utilities' | 'customize' | 'hub';
type Anchor = 'corner' | 'top' | 'right';
type Rect = { x: number; y: number; w: number; h: number };
type Answer = { title: string; text: string; basis: string; region?: Rect; tone?: 'error' };
type Plan = { req: Extract<Scripted, { kind: 'act' }>; phase: 'review' | 'saving' | 'saved' | 'undone' | 'failed' };
export type Expression = 'flow' | 'ascii' | 'core';
type Wallpaper = 'dark' | 'light' | 'busy';
/** The perimeter light: idle has none; hover and focus are CSS; the rest come from the island's real (here: scripted) state. */
type Edge = 'idle' | 'listening' | 'working' | 'done' | 'error';
type ListenPhase = 'hearing' | 'transcribing';

const SURFACE_NAME: Record<Surface, string> = {
  rest: 'Resting',
  command: 'Invoked',
  listening: 'Listening preview',
  acting: 'Plan to confirm',
  answer: 'Answer',
  utilities: 'Utilities',
  customize: 'Customise',
  hub: 'Full hub',
};

const reduced = () => document.documentElement.dataset.motion === 'reduced';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, reduced() ? Math.min(ms, 120) : ms));

export function Prototype() {
  const [surface, setSurface] = useState<Surface>('rest');
  const [anchor, setAnchor] = useState<Anchor>('corner');
  const [wall, setWall] = useState<Wallpaper>('dark');
  const [expression, setExpression] = useState<Expression>('flow');
  const [vapor, setVapor] = useState(false);
  const [edgeLight, setEdgeLight] = useState<'on' | 'subtle' | 'off'>('on');
  const [doneFlash, setDoneFlash] = useState(0);
  const [motion, setMotion] = useState<'full' | 'reduced'>(() => (document.documentElement.dataset.motion === 'reduced' ? 'reduced' : 'full'));
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [listen, setListen] = useState<ListenPhase>('hearing');
  const [words, setWords] = useState(0);
  const [level, setLevel] = useState(0);
  const [region, setRegion] = useState<Rect | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [tasks, setTasks] = useState<MockTask[]>(INITIAL_TASKS);
  const [focusedApp, setFocusedApp] = useState<string>('notes');
  const [returnedTo, setReturnedTo] = useState<string | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const desktopRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const tour = useRef(0);
  const stopListenTimersRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    document.documentElement.dataset.motion = motion;
  }, [motion]);

  const open = useCallback((s: Surface) => {
    if (s !== 'rest' && (document.activeElement as HTMLElement | null)?.closest?.('.mock-window')) lastFocus.current = document.activeElement as HTMLElement;
    setNote(null);
    setReturnedTo(null);
    setSurface(s);
  }, []);

  /** Escape and Done collapse to rest and give focus back to the app the person was using. */
  const collapse = useCallback(() => {
    stopListenTimersRef.current();
    setSurface('rest');
    setSelecting(false);
    const el = lastFocus.current;
    if (el && document.contains(el)) {
      el.focus();
      const app = el.closest<HTMLElement>('.mock-window')?.dataset.app;
      if (app) setReturnedTo(APPS.find((a) => a.id === app)?.name ?? null);
    }
  }, []);

  // Ctrl+Space toggles the island from anywhere on the page; Escape collapses it (or cancels a region selection).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        tour.current++;
        setCaption(null);
        if (surface === 'rest') open('command');
        else collapse();
      } else if (e.key === 'Escape') {
        if (selecting) {
          setSelecting(false);
          setSurface('command');
        } else if (surface !== 'rest') {
          e.preventDefault();
          collapse();
        }
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [surface, selecting, open, collapse]);

  /* ---------- Scripted journeys ---------- */

  const runRequest = async (req: Scripted) => {
    if (req.kind === 'answer') {
      setAnswer({ title: req.title, text: req.text, basis: req.basis, tone: req.tone });
      open('answer');
    } else {
      setPlan({ req, phase: 'review' });
      open('acting');
    }
  };

  const confirmPlan = async () => {
    if (!plan) return;
    setPlan({ ...plan, phase: 'saving' });
    await wait(plan.req.failure ? 1100 : 650);
    if (plan.req.failure) {
      setPlan((p) => (p ? { ...p, phase: 'failed' } : p));
      return;
    }
    setTasks((t) => (t.some((x) => x.id === plan.req.task.id) ? t : [...t, plan.req.task]));
    setPlan((p) => (p ? { ...p, phase: 'saved' } : p));
  };

  const undoPlan = () => {
    if (!plan) return;
    setTasks((t) => t.filter((x) => x.id !== plan.req.task.id));
    setPlan({ ...plan, phase: 'undone' });
  };

  const askRegion = () => {
    if (!region) return;
    setAnswer({ title: REGION_REQUEST.title, text: REGION_REQUEST.text, basis: `${REGION_REQUEST.basis}, ${Math.round(region.w)}×${Math.round(region.h)} px`, region });
    open('answer');
  };

  // Listening preview: a scripted line is revealed word by word, with a simulated level. Nothing is recorded.
  const listenTimer = useRef<number[]>([]);
  const stopListenTimers = () => {
    listenTimer.current.forEach((id) => clearTimeout(id));
    listenTimer.current = [];
  };
  stopListenTimersRef.current = stopListenTimers;
  /**
   * Hold to talk, or tap to start and tap Done to finish. A hold is told apart from a tap by how long the pointer stays
   * down; the release is caught on the window because the Talk button is replaced by the listening surface.
   */
  const startListening = (hold = false) => {
    if (hold) {
      const t0 = performance.now();
      const up = () => {
        window.removeEventListener('pointerup', up);
        if (performance.now() - t0 > 450) finishListeningRef.current();
      };
      window.addEventListener('pointerup', up);
    }
    stopListenTimers();
    setWords(0);
    setListen('hearing');
    open('listening');
    VOICE_LINE.forEach((_, i) => listenTimer.current.push(window.setTimeout(() => setWords(i + 1), (reduced() ? 60 : 380) * (i + 1) + 300)));
  };
  const finishListening = () => {
    stopListenTimers();
    setWords(VOICE_LINE.length);
    setListen('transcribing');
    listenTimer.current.push(
      window.setTimeout(() => {
        const req = REQUESTS[0];
        if (req.kind === 'answer') setAnswer({ title: req.title, text: req.text, basis: `${req.basis} · from what you said` });
        setSurface('answer');
      }, reduced() ? 150 : 900),
    );
  };
  const finishListeningRef = useRef(finishListening);
  finishListeningRef.current = finishListening;
  const cancelListening = () => {
    stopListenTimers();
    setSurface('command');
    setNote('Stopped. Nothing was kept and nothing was sent.');
  };
  useEffect(() => stopListenTimers, []);

  useEffect(() => {
    if (surface !== 'listening' || listen !== 'hearing' || reduced()) {
      setLevel(0);
      return undefined;
    }
    let raf = 0;
    let lastSet = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      // About 15 updates a second is enough for the level; React does not re-render on every frame.
      if (t - lastSet < 66) return;
      lastSet = t;
      const s = (t - t0) / 1000;
      // Simulated speech envelope: syllable-rate bumps on a slow phrase contour. Labelled as simulated in the surface.
      const v = Math.max(0, 0.35 + 0.3 * Math.sin(s * 9.1) * Math.sin(s * 2.3) + 0.15 * Math.sin(s * 17.3));
      setLevel(Math.min(1, v));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [surface, listen]);

  // Completion settles into one brief trace around the island, then the light goes quiet again.
  const doneKey = (surface === 'answer' && answer?.tone !== 'error' ? `a:${answer?.text}` : '') + (surface === 'acting' && plan?.phase === 'saved' ? `p:${plan.req.id}` : '');
  useEffect(() => {
    if (!doneKey) return undefined;
    setDoneFlash((n) => n + 1);
    const id = window.setTimeout(() => setDoneFlash(0), reduced() ? 700 : 900);
    return () => window.clearTimeout(id);
  }, [doneKey]);

  /** The guided journey for reviewers: every state in order, with captions. Any key or click stops it. */
  const play = async () => {
    const run = ++tour.current;
    const alive = () => tour.current === run;
    const step = async (text: string, fn: () => void, ms: number) => {
      if (!alive()) return false;
      setCaption(text);
      fn();
      await wait(ms);
      return alive();
    };
    setRegion(null);
    setTasks(INITIAL_TASKS);
    const notes = desktopRef.current?.querySelector<HTMLElement>('.mock-window[data-app="notes"] textarea');
    notes?.focus();
    const steps: [string, () => void, number][] = [
      ['1 · At rest the companion is a small island on the screen edge. Field notes keeps focus.', () => collapse(), 2600],
      ['2 · Ctrl+Space opens it in place. Typing goes to the companion; Field notes stays open behind it.', () => open('command'), 2800],
      ['3 · Ask about part of the screen: you draw the region, and see it before anything is sent.', () => { setRegion(sheetRegion(desktopRef.current)); setSurface('command'); }, 2600],
      ['4 · A short answer appears beside the island. This one is scripted from the mock chart.', () => askRegion2(), 4200],
      ['5 · Hold Talk to speak. Preview only: the microphone is not used and the words are scripted.', () => startListening(false), 3600],
      ['6 · Release to finish. The answer is short, and it can open in the hub.', () => finishListening(), 3600],
      ['7 · Asked to act, it shows a plan first. Cancel is the default; nothing changes until you confirm.', () => void runRequest(REQUESTS[1]), 3200],
      ['8 · Confirmed: a receipt with Undo. In this prototype only the mock list changes.', () => void confirmPlan2(), 3000],
      ['9 · Utilities open from the island: tasks, focus timer, clipboard, launcher, media.', () => open('utilities'), 3600],
      ['10 · Customise voice, personality, appearance and abilities. The core is the real shared renderer.', () => open('customize'), 4000],
      ['11 · For bigger work the island grows into the full hub, the real app on demo data.', () => open('hub'), 4200],
      ['12 · Back to the desktop: Escape collapses it and focus returns to Field notes.', () => collapse(), 2800],
    ];
    for (const [text, fn, ms] of steps) if (!(await step(text, fn, ms))) return;
    setCaption(null);
  };
  // The tour needs the region answer and the confirm without waiting on React state from the previous step.
  const askRegion2 = () => {
    const r = sheetRegion(desktopRef.current);
    if (!r) return;
    setRegion(r);
    setAnswer({ title: REGION_REQUEST.title, text: REGION_REQUEST.text, basis: `${REGION_REQUEST.basis}, ${Math.round(r.w)}×${Math.round(r.h)} px`, region: r });
    setSurface('answer');
  };
  const confirmPlan2 = async () => {
    const req = REQUESTS[1];
    if (req.kind !== 'act') return;
    setPlan({ req, phase: 'saving' });
    await wait(500);
    setTasks((t) => (t.some((x) => x.id === req.task.id) ? t : [...t, req.task]));
    setPlan({ req, phase: 'saved' });
  };
  const stopTour = () => {
    if (caption) {
      tour.current++;
      setCaption(null);
    }
  };

  const orbState: CompanionState = surface === 'listening' ? (listen === 'hearing' ? 'listening' : 'transcribing') : surface === 'acting' && plan?.phase === 'saving' ? 'thinking' : (surface === 'answer' && answer?.tone === 'error') || (surface === 'acting' && plan?.phase === 'failed') ? 'alert' : 'idle';
  const failed = (surface === 'answer' && answer?.tone === 'error') || (surface === 'acting' && plan?.phase === 'failed');
  const working = (surface === 'listening' && listen === 'transcribing') || (surface === 'acting' && plan?.phase === 'saving');
  const edge: Edge = failed ? 'error' : working ? 'working' : surface === 'listening' ? 'listening' : doneFlash ? 'done' : 'idle';

  return (
    <div className="proto" onPointerDownCapture={stopTour}>
      <Guide
        surface={surface}
        anchor={anchor}
        motion={motion}
        playing={caption !== null}
        onAnchor={setAnchor}
        onMotion={setMotion}
        wall={wall}
        onWall={setWall}
        onPlay={() => void play()}
        onJump={(s) => {
          tour.current++;
          setCaption(null);
          if (s === 'answer' && !answer) setAnswer({ title: (REQUESTS[0] as Extract<Scripted, { kind: 'answer' }>).title, text: (REQUESTS[0] as Extract<Scripted, { kind: 'answer' }>).text, basis: (REQUESTS[0] as Extract<Scripted, { kind: 'answer' }>).basis });
          if (s === 'acting' && !plan) setPlan({ req: REQUESTS[1] as Extract<Scripted, { kind: 'act' }>, phase: 'review' });
          if (s === 'listening') startListening(false);
          else if (s === 'rest') collapse();
          else open(s);
        }}
      />
      <div className="desk" ref={desktopRef} data-anchor={anchor} data-wall={wall} data-vapor={vapor && surface !== 'rest' && surface !== 'hub' ? 'on' : undefined}>
        <MockDesktop focusedApp={focusedApp} onFocusApp={setFocusedApp} region={region} signups={SIGNUPS} />
        {selecting && (
          <RegionOverlay
            onCancel={() => {
              setSelecting(false);
              setSurface('command');
            }}
            onDone={(r) => {
              setRegion(r);
              setSelecting(false);
              setSurface('command');
            }}
          />
        )}
        <Island
          surface={surface}
          anchor={anchor}
          orbState={orbState}
          level={surface === 'listening' && listen === 'hearing' ? level : null}
          edge={edge}
          edgeLight={edgeLight}
          doneFlash={doneFlash}
          expression={expression}
          desk={desktopRef}
          onOpen={() => open('command')}
          label={`Companion prototype, ${SURFACE_NAME[surface]}`}
        >
          {surface === 'rest' && <RestPill returnedTo={returnedTo} />}
          {surface === 'command' && (
            <CommandPanel
              note={note}
              region={region}
              backTo={APPS.find((a) => a.id === (lastFocus.current?.closest<HTMLElement>('.mock-window')?.dataset.app ?? focusedApp))?.name ?? 'the desktop'}
              onNote={setNote}
              onRequest={(r) => void runRequest(r)}
              onSelectRegion={() => {
                setSelecting(true);
                setSurface('rest');
              }}
              onSelectSheet={() => setRegion(sheetRegion(desktopRef.current))}
              onClearRegion={() => setRegion(null)}
              onAskRegion={askRegion}
              onTalk={(hold) => startListening(hold)}
              onUtilities={() => open('utilities')}
              onCustomize={() => open('customize')}
              onHub={() => open('hub')}
              onClose={collapse}
            />
          )}
          {surface === 'listening' && <ListeningPanel phase={listen} words={words} onStop={finishListening} onCancel={cancelListening} />}
          {surface === 'acting' && plan && <ActPanel plan={plan} onConfirm={() => void confirmPlan()} onCancel={() => { setPlan({ ...plan, phase: 'undone' }); setSurface('command'); setNote('Cancelled. Nothing was changed.'); }} onUndo={undoPlan} onDone={collapse} onTasks={() => open('utilities')} />}
          {surface === 'answer' && answer && <AnswerPanel answer={answer} onHub={() => open('hub')} onDone={collapse} onFollow={() => open('command')} />}
          {surface === 'utilities' && <UtilitiesPanel tasks={tasks} setTasks={setTasks} onBack={() => open('command')} onClose={collapse} onLaunch={(id) => { setFocusedApp(id); lastFocus.current = desktopRef.current?.querySelector<HTMLElement>(`.mock-window[data-app="${id}"] [data-focus]`) ?? null; collapse(); }} />}
          {surface === 'customize' && <CustomizePanel anchor={anchor} onAnchor={setAnchor} onBack={() => open('command')} onClose={collapse} expression={expression} onExpression={setExpression} vapor={vapor} onVapor={setVapor} edgeLight={edgeLight} onEdgeLight={setEdgeLight} />}
          {surface === 'hub' && <HubPanel onCollapse={collapse} />}
        </Island>
        {caption && (
          <p className="tour-caption" role="status">
            {caption}
            <span className="tour-hint">Click anywhere or press a key to take over.</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** The Sheet window's chart, in desktop coordinates: the region the tour (and the keyboard path) selects. */
function sheetRegion(desk: HTMLElement | null): Rect | null {
  const chart = desk?.querySelector<HTMLElement>('.mock-chart');
  if (!desk || !chart) return null;
  const d = desk.getBoundingClientRect();
  const c = chart.getBoundingClientRect();
  return { x: c.left - d.left - 6, y: c.top - d.top - 6, w: c.width + 12, h: c.height + 12 };
}

/* ---------- The island ---------- */

/**
 * One element. Its size follows the current surface's content (measured), and CSS springs the change, so the island
 * grows from the edge it is docked to and shrinks back to the same place. The core never remounts.
 */
function Island({ surface, anchor, orbState, level, edge, edgeLight, doneFlash, expression, desk, onOpen, label, children }: { surface: Surface; anchor: Anchor; orbState: CompanionState; level: number | null; edge: Edge; edgeLight: 'on' | 'subtle' | 'off'; doneFlash: number; expression: Expression; desk: React.RefObject<HTMLDivElement | null>; onOpen: () => void; label: string; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 176, h: 52 });
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return undefined;
    const measure = () => {
      if (surface === 'hub' && desk.current) {
        const d = desk.current.getBoundingClientRect();
        setSize({ w: Math.round(d.width - 48), h: Math.round(d.height - 48 - (anchor === 'top' ? 0 : 48)) });
      } else setSize({ w: Math.ceil(el.offsetWidth), h: Math.ceil(el.offsetHeight) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (desk.current) ro.observe(desk.current);
    return () => ro.disconnect();
  }, [surface, anchor, desk]);
  const rest = surface === 'rest';
  return (
    <section className="island" data-surface={surface} data-anchor={anchor} data-edge={edge} data-edge-light={edgeLight} style={{ width: size.w, height: size.h, '--lvl': level ?? 0 } as CSSProperties} aria-label={label}>
      <span className="edge" aria-hidden key={edge === 'done' ? `done-${doneFlash}` : edge} />
      <button type="button" className="island-core" onClick={rest ? onOpen : undefined} tabIndex={rest ? 0 : -1} aria-label={rest ? 'Open the companion (Ctrl+Space)' : undefined} aria-hidden={rest ? undefined : true}>
        <CoreView expression={expression} size={rest ? 34 : 44} state={orbState} level={level} />
      </button>
      <div className="island-panel" data-s={surface} key={surface} ref={panelRef}>
        {children}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {SURFACE_NAME[surface]}
      </span>
    </section>
  );
}

const FLOW_STATE: Record<CompanionState, FlowState> = { idle: 'idle', listening: 'listening', transcribing: 'working', thinking: 'working', speaking: 'listening', alert: 'error' };

/**
 * The companion's core in the chosen expression: the prototype's flow field, its ASCII skin, or the app's shared
 * renderer. All three take the same state and level, so the island looks alive only when something is happening.
 */
export function CoreView({ expression, size, state, level }: { expression: Expression; size: number; state: CompanionState; level: number | null }) {
  const [appearance] = useAppearance();
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, level, hue: appearance.tint, skin: expression });
  live.current = { state, level, hue: appearance.tint, skin: expression };
  const handle = useRef<ReturnType<typeof addFlow> | null>(null);
  useEffect(() => {
    if (expression === 'core' || !ref.current) return undefined;
    const h = addFlow(ref.current, size, () => ({ skin: live.current.skin === 'ascii' ? 'ascii' : 'flow', state: FLOW_STATE[live.current.state], level: live.current.level ?? 0, hue: live.current.hue, reduced: document.documentElement.dataset.motion === 'reduced' }));
    handle.current = h;
    return () => {
      h.remove();
      handle.current = null;
    };
  }, [expression, size]);
  useEffect(() => handle.current?.invalidate(), [state, level, appearance.tint]);
  if (expression === 'core') return <CompanionOrb size={size} state={state} level={level} decorative showWhenHidden />;
  return <canvas ref={ref} className={`flow-core flow-${expression}`} style={{ width: size, height: size }} aria-hidden />;
}

function RestPill({ returnedTo }: { returnedTo: string | null }) {
  return (
    <div className="pill">
      <span className="pill-text">
        <strong>Ready</strong>
        <span>{returnedTo ? `Back in ${returnedTo}` : 'Nothing listening'}</span>
      </span>
      <kbd>Ctrl Space</kbd>
    </div>
  );
}

function PanelHead({ title, meta, children }: { title: string; meta?: ReactNode; children?: ReactNode }) {
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

/** The row nearest the docked core when the island rests at the bottom; it keeps clear of the core. */
function PanelFoot({ children }: { children: ReactNode }) {
  return <footer className="p-foot">{children}</footer>;
}

function Scripted({ children = 'Scripted · no AI' }: { children?: ReactNode }) {
  return <span className="tag-scripted">{children}</span>;
}

function CommandPanel(p: {
  note: string | null;
  region: Rect | null;
  backTo: string;
  onNote: (s: string | null) => void;
  onRequest: (r: Scripted) => void;
  onSelectRegion: () => void;
  onSelectSheet: () => void;
  onClearRegion: () => void;
  onAskRegion: () => void;
  onTalk: (hold: boolean) => void;
  onUtilities: () => void;
  onCustomize: () => void;
  onHub: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="cmd">
      <PanelHead title="Companion" meta="Ask, attach part of the screen, or open a tool">
        <IconText onClick={p.onUtilities} label="Utilities">▦</IconText>
        <IconText onClick={p.onCustomize} label="Customise">◈</IconText>
        <IconText onClick={p.onHub} label="Open the full hub">⤢</IconText>
      </PanelHead>
      <form
        className="cmd-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          p.onNote('This prototype has no AI, so it cannot answer what you typed. Choose a scripted request below to see how the companion would respond.');
        }}
      >
        <label htmlFor="proto-cmd" className="sr-only">
          Ask or tell the companion
        </label>
        <input id="proto-cmd" ref={input} className="cmd-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask, or tell it to do something" autoComplete="off" />
      </form>
      {p.note && (
        <p className="cmd-note" role="status">
          {p.note}
        </p>
      )}
      <div className="ctx">
        {p.region ? (
          <div className="ctx-chip">
            <span className="ctx-thumb" aria-hidden />
            <span className="grow">
              <strong>Region attached</strong>
              <span>
                {Math.round(p.region.w)}×{Math.round(p.region.h)} px of the screen. Sent only when you ask.
              </span>
            </span>
            <button type="button" className="linkbtn" onClick={p.onClearRegion}>
              Remove
            </button>
          </div>
        ) : (
          <div className="ctx-empty">
            <span>No screen context attached.</span>
            <button type="button" className="chipbtn" onClick={p.onSelectRegion}>
              Draw a region
            </button>
            <button type="button" className="linkbtn" onClick={p.onSelectSheet}>
              or select the Sheet chart
            </button>
          </div>
        )}
      </div>
      <div className="try">
        <span className="try-label">
          Try <Scripted />
        </span>
        <div className="try-list">
          {p.region && (
            <button type="button" className="try-chip is-hot" onClick={p.onAskRegion}>
              {REGION_REQUEST.prompt}
            </button>
          )}
          {REQUESTS.map((r) => (
            <button key={r.id} type="button" className="try-chip" onClick={() => p.onRequest(r)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <PanelFoot>
        <span className="p-meta">
          Typing goes here · <kbd>Esc</kbd> returns to {p.backTo}
        </span>
        <button
          type="button"
          className="talk"
          onPointerDown={(e) => {
            e.preventDefault();
            p.onTalk(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              p.onTalk(false);
            }
          }}
        >
          <span className="talk-dot" aria-hidden /> Hold to talk
        </button>
      </PanelFoot>
    </div>
  );
}

function IconText({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button type="button" className="ibtn" onClick={onClick} aria-label={label} title={label}>
      <span aria-hidden>{children}</span>
    </button>
  );
}

function ListeningPanel({ phase, words, onStop, onCancel }: { phase: ListenPhase; words: number; onStop: () => void; onCancel: () => void }) {
  const stopRef = useRef<HTMLButtonElement>(null);
  useEffect(() => stopRef.current?.focus(), []);
  return (
    <div className="listen">
      <PanelHead title={phase === 'hearing' ? 'Listening' : 'Turning speech into text'} meta={<Scripted>Preview · microphone not used · level simulated</Scripted>} />
      <p className="listen-line" aria-live="polite">
        {VOICE_LINE.slice(0, words).join(' ')}
        {phase === 'hearing' && <span className="caret" aria-hidden />}
      </p>
      <PanelFoot>
        <span className="p-meta">Release to finish · Esc cancels</span>
        <button type="button" className="linkbtn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="stop" ref={stopRef} onClick={onStop} disabled={phase !== 'hearing'}>
          {phase === 'hearing' ? 'Done talking' : 'Working…'}
        </button>
      </PanelFoot>
    </div>
  );
}

function ActPanel({ plan, onConfirm, onCancel, onUndo, onDone, onTasks }: { plan: Plan; onConfirm: () => void; onCancel: () => void; onUndo: () => void; onDone: () => void; onTasks: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (plan.phase === 'review') cancelRef.current?.focus();
  }, [plan.phase]);
  const { req } = plan;
  return (
    <div className="act">
      <PanelHead title={plan.phase === 'saved' ? 'Done' : plan.phase === 'undone' ? 'Undone' : plan.phase === 'failed' ? 'Did not work as planned' : plan.phase === 'saving' ? 'Working' : 'Plan'} meta={<Scripted />} />
      <p className="act-ask">“{req.prompt}”</p>
      <ol className="steps">
        <li className="is-done">Understood the request</li>
        <li className={plan.phase === 'review' ? 'is-now' : 'is-done'}>
          <strong>{req.tool}</strong>: {req.summary}
          <dl className="fields">
            {req.fields.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <span className="risk">{req.risk}</span>
        </li>
        <li className={plan.phase === 'saved' ? 'is-done' : plan.phase === 'saving' ? 'is-now' : plan.phase === 'failed' ? 'is-failed' : ''}>
          {req.failure ? (plan.phase === 'failed' ? 'Check afterwards: not as planned' : 'Do it, then check the result') : plan.phase === 'saved' ? 'Saved to the list' : plan.phase === 'undone' ? 'Removed again' : 'Save'}
        </li>
      </ol>
      {plan.phase === 'review' || plan.phase === 'saving' ? (
        <PanelFoot>
          <span className="p-meta">Nothing changes until you confirm.</span>
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel} disabled={plan.phase === 'saving'}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={plan.phase === 'saving'}>
            {plan.phase === 'saving' ? 'Working…' : req.failure ? 'Move window' : 'Add task'}
          </button>
        </PanelFoot>
      ) : (
        <div className="receipt">
          <p className={`receipt-text${plan.phase === 'failed' ? ' is-error' : ''}`} role={plan.phase === 'failed' ? 'alert' : undefined}>
            {plan.phase === 'failed' ? req.failure : plan.phase === 'saved' ? 'Added “Call the bank”, due tomorrow 10:00. Only the prototype’s mock list changed.' : 'Undone. Your list is as it was.'}
          </p>
          <PanelFoot>
            {(plan.phase === 'saved' || plan.phase === 'failed') && (
              <button type="button" className="btn" onClick={onUndo}>
                {plan.phase === 'failed' ? 'Put it back' : 'Undo'}
              </button>
            )}
            <button type="button" className="btn" onClick={onTasks}>
              See tasks
            </button>
            <button type="button" className="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </PanelFoot>
        </div>
      )}
    </div>
  );
}

function AnswerPanel({ answer, onHub, onDone, onFollow }: { answer: Answer; onHub: () => void; onDone: () => void; onFollow: () => void }) {
  const doneRef = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => doneRef.current?.focus(), []);
  return (
    <div className={`ans${answer.tone === 'error' ? ' is-error' : ''}`}>
      <PanelHead title={answer.title} meta={<Scripted>{answer.tone === 'error' ? 'Scripted · shows an unavailable ability' : 'Scripted answer · no model was called'}</Scripted>} />
      <p className="ans-text">{answer.text}</p>
      <p className="ans-basis">
        <span aria-hidden>↳</span> Based on: {answer.basis}
      </p>
      <p className="p-meta" title="Speech output needs a chosen speech provider; Claude itself returns text.">
        Read aloud is not part of this prototype.
      </p>
      <PanelFoot>
        <button type="button" className="btn btn-primary" ref={doneRef} onClick={onDone}>
          Done
        </button>
        <button type="button" className="btn" onClick={onFollow}>
          Follow up
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(answer.text).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn" onClick={onHub}>
          Open in hub
        </button>
      </PanelFoot>
    </div>
  );
}

/* ---------- Utilities ---------- */

function UtilitiesPanel({ tasks, setTasks, onBack, onClose, onLaunch }: { tasks: MockTask[]; setTasks: (f: (t: MockTask[]) => MockTask[]) => void; onBack: () => void; onClose: () => void; onLaunch: (id: string) => void }) {
  const [clip, setClip] = useState(false);
  return (
    <div className="util">
      <PanelHead title="Utilities" meta="Local tools. Each says what backs it in the product.">
        <button type="button" className="linkbtn" onClick={onBack}>
          Ask instead
        </button>
        <IconText onClick={onClose} label="Close">✕</IconText>
      </PanelHead>
      <div className="tiles">
        <section className="tile tile-wide" aria-label="Tasks">
          <h3>Tasks</h3>
          <ul className="t-list">
            {tasks.map((t) => (
              <li key={t.id} className={t.done ? 'is-done' : undefined}>
                <label>
                  <input type="checkbox" className="check" checked={t.done} onChange={() => setTasks((all) => all.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
                  <span className="grow">{t.title}</span>
                </label>
                <span className={`due due-${t.tone}`}>{t.due}</span>
                {t.added && <span className="tag-scripted">just added</span>}
              </li>
            ))}
          </ul>
          <p className="backing">Product: the tasks bridge that the hub already uses.</p>
        </section>
        <FocusTile />
        <section className="tile" aria-label="Clipboard">
          <h3>Clipboard</h3>
          {clip ? (
            <ul className="clip">
              {CLIPBOARD_DEMO.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">History is off. It stays off until you turn it on.</p>
          )}
          <label className="mini-switch">
            <input type="checkbox" checked={clip} onChange={(e) => setClip(e.target.checked)} /> Show demo history
          </label>
          <p className="backing">Product: opt-in clipboard history; turning it on asks Windows to confirm.</p>
        </section>
        <section className="tile" aria-label="Launcher">
          <h3>Launcher</h3>
          <ul className="apps">
            {APPS.map((a) => (
              <li key={a.id}>
                <button type="button" className="app-btn" onClick={() => onLaunch(a.id)}>
                  <span className={`app-ico app-${a.id}`} aria-hidden /> {a.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="backing">Product: approved apps only; Windows confirms each launch.</p>
        </section>
        <section className="tile" aria-label="Media">
          <h3>Media</h3>
          <p className="muted">Not connected.</p>
          <p className="backing">Needs a Spotify adapter with your own sign-in. Not built; never shown as connected.</p>
        </section>
      </div>
      <PanelFoot>
        <span className="p-meta">
          <kbd>Esc</kbd> closes · tools work without AI
        </span>
      </PanelFoot>
    </div>
  );
}

function FocusTile() {
  const [left, setLeft] = useState(25 * 60);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return undefined;
    const id = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <section className="tile" aria-label="Focus timer">
      <h3>Focus</h3>
      <p className="timer mono" aria-live="off">
        {mm}:{ss}
      </p>
      <div className="act-row">
        <button type="button" className="btn btn-sm" onClick={() => setRunning((r) => !r)}>
          {running ? 'Pause' : left < 1500 ? 'Resume' : 'Start'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => { setRunning(false); setLeft(1500); }} disabled={left === 1500}>
          Reset
        </button>
      </div>
      <p className="backing">Real timer in this page. Product: the existing focus timer.</p>
    </section>
  );
}

/* ---------- Customisation ---------- */

type CTab = 'appearance' | 'personality' | 'voice' | 'abilities' | 'placement';

function CustomizePanel({ anchor, onAnchor, onBack, onClose, expression, onExpression, vapor, onVapor, edgeLight, onEdgeLight }: { anchor: Anchor; onAnchor: (a: Anchor) => void; onBack: () => void; onClose: () => void; expression: Expression; onExpression: (e: Expression) => void; vapor: boolean; onVapor: (v: boolean) => void; edgeLight: 'on' | 'subtle' | 'off'; onEdgeLight: (v: 'on' | 'subtle' | 'off') => void }) {
  const [tab, setTab] = useState<CTab>('appearance');
  const [appearance, setAppearance] = useAppearance();
  const [persona, setPersona] = useState<string>('steady');
  const tabs: [CTab, string][] = [
    ['appearance', 'Appearance'],
    ['personality', 'Personality'],
    ['voice', 'Voice'],
    ['abilities', 'Abilities'],
    ['placement', 'Placement'],
  ];
  return (
    <div className="cust">
      <PanelHead title="Make it yours" meta="Changes apply to the island live.">
        <button type="button" className="linkbtn" onClick={onBack}>
          Back
        </button>
        <IconText onClick={onClose} label="Close">✕</IconText>
      </PanelHead>
      <div className="cust-body">
        <div className="cust-stage">
          <CoreView expression={expression} size={150} state="idle" level={null} />
          <p className="p-meta">{expression === 'core' ? 'The app’s shared renderer, from your saved appearance.' : 'Prototype flow field, coloured by your saved inner light.'}</p>
        </div>
        <div className="cust-main">
          <div className="seg" role="tablist" aria-label="Customise">
            {tabs.map(([id, name]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : undefined} onClick={() => setTab(id)}>
                {name}
              </button>
            ))}
          </div>
          <div className="cust-tab" role="tabpanel">
            {tab === 'appearance' && (
              <>
                <div className="seg" role="radiogroup" aria-label="Expression">
                  {(
                    [
                      ['flow', 'Flow core'],
                      ['ascii', 'ASCII'],
                      ['core', 'Arc core (app renderer)'],
                    ] as const
                  ).map(([id, name]) => (
                    <button key={id} type="button" role="radio" aria-checked={expression === id} className={expression === id ? 'on' : undefined} onClick={() => onExpression(id)}>
                      {name}
                    </button>
                  ))}
                </div>
                <div className="g-row">
                  <span>Edge light</span>
                  <div className="seg seg-sm" role="radiogroup" aria-label="Edge light">
                    {(
                      [
                        ['on', 'On'],
                        ['subtle', 'Subtle'],
                        ['off', 'Off'],
                      ] as const
                    ).map(([id, name]) => (
                      <button key={id} type="button" role="radio" aria-checked={edgeLight === id} className={edgeLight === id ? 'on' : undefined} onClick={() => onEdgeLight(id)}>
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="mini-switch">
                  <input type="checkbox" checked={vapor} onChange={(e) => onVapor(e.target.checked)} /> Vapor grid behind the open island
                </label>
                <p className="p-meta">Arc core forms and inner light:</p>
                <div className="forms">
                  {FORMS.filter((f) => f.id !== 'character').map((f) => (
                    <button key={f.id} type="button" className={`form-pick${appearance.form === f.id ? ' on' : ''}`} aria-pressed={appearance.form === f.id} onClick={() => setAppearance({ ...appearance, form: f.id, tint: appearance.form === f.id ? appearance.tint : f.defaultTint })}>
                      <CompanionOrb size={46} state="idle" level={null} appearance={{ ...appearance, form: f.id, tint: appearance.form === f.id ? appearance.tint : f.defaultTint, motion: 'still' }} decorative showWhenHidden />
                      <span>{f.name}</span>
                    </button>
                  ))}
                </div>
                <div className="tints" role="radiogroup" aria-label="Inner light">
                  {TINT_PRESETS.map((t) => (
                    <button key={t.name} type="button" role="radio" aria-checked={appearance.tint === t.hue} aria-label={t.name} title={t.name} className={`tint-dot${appearance.tint === t.hue ? ' on' : ''}`} style={{ '--tint': `hsl(${t.hue} 70% 58%)` } as CSSProperties} onClick={() => setAppearance({ ...appearance, tint: t.hue })} />
                  ))}
                </div>
                <p className="p-meta">Saved like the Studio choice in the hub, so the hub frame shows the same companion.</p>
              </>
            )}
            {tab === 'personality' && (
              <>
                <div className="personas">
                  {PERSONALITIES.map((p) => (
                    <button key={p.id} type="button" className={`persona${persona === p.id ? ' on' : ''}`} aria-pressed={persona === p.id} onClick={() => setPersona(p.id)}>
                      <strong>{p.name}</strong>
                      <span>{p.blurb}</span>
                    </button>
                  ))}
                </div>
                <blockquote className="sample">
                  {PERSONALITIES.find((p) => p.id === persona)?.sample}
                  <cite>
                    <Scripted>Written sample, not generated</Scripted>
                  </cite>
                </blockquote>
                <p className="p-meta">In the product this becomes the instructions sent with each request, per profile, and is shown before use.</p>
              </>
            )}
            {tab === 'voice' && <VoiceTab />}
            {tab === 'abilities' && (
              <ul className="abilities">
                {ABILITIES.map((a) => (
                  <li key={a.id} data-state={a.state}>
                    <div className="grow">
                      <strong>{a.name}</strong>
                      <span>
                        {a.scope} · {a.approval}
                      </span>
                    </div>
                    <span className={`ab-status ab-${a.state}`}>{a.status}</span>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'placement' && (
              <>
                <div className="seg" role="radiogroup" aria-label="Where the island rests">
                  {(
                    [
                      ['corner', 'Bottom right'],
                      ['top', 'Top centre'],
                      ['right', 'Right edge'],
                    ] as const
                  ).map(([id, name]) => (
                    <button key={id} type="button" role="radio" aria-checked={anchor === id} className={anchor === id ? 'on' : undefined} onClick={() => onAnchor(id)}>
                      {name}
                    </button>
                  ))}
                </div>
                <ul className="plain">
                  <li>Shortcut: Ctrl+Space opens and closes it; Esc returns to your app.</li>
                  <li>Hide during full-screen apps and games: a desktop-app setting, not shown in a browser.</li>
                  <li>Remembers its edge per display. Multiple displays and scaling need the Windows build to verify.</li>
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
      <PanelFoot>
        <span className="p-meta">Per-profile settings in the product: a work profile can sound and look different from a home one.</span>
      </PanelFoot>
    </div>
  );
}

/** Lists the browser's own voices and can speak one fixed sentence on request. The desktop app would use Windows voices. */
function VoiceTab() {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => synth?.getVoices() ?? []);
  const [voice, setVoice] = useState('');
  const [rate, setRate] = useState(1);
  useEffect(() => {
    if (!synth) return undefined;
    const on = () => setVoices(synth.getVoices());
    synth.addEventListener('voiceschanged', on);
    return () => {
      synth.removeEventListener('voiceschanged', on);
      synth.cancel();
    };
  }, [synth]);
  const speak = () => {
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance('Two things today: the dentist, and the library card.');
    const v = voices.find((x) => x.name === voice);
    if (v) u.voice = v;
    u.rate = rate;
    synth.speak(u);
  };
  return (
    <>
      {voices.length ? (
        <div className="field">
          <label htmlFor="proto-voice">Voice</label>
          <select id="proto-voice" className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
            <option value="">Default voice</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="muted">This browser reports no speech voices.</p>
      )}
      <div className="field">
        <label htmlFor="proto-rate">Speed {rate.toFixed(1)}×</label>
        <input id="proto-rate" type="range" min={0.7} max={1.4} step={0.1} value={rate} onChange={(e) => setRate(Number(e.target.value))} />
      </div>
      <div className="act-row">
        <button type="button" className="btn" onClick={speak} disabled={!synth}>
          Hear a sample
        </button>
        <button type="button" className="btn" onClick={() => synth?.cancel()} disabled={!synth}>
          Stop
        </button>
      </div>
      <p className="p-meta">Browser voices, spoken only when you press the button. Claude returns text; spoken replies need a chosen speech provider or Windows speech, to be verified separately.</p>
    </>
  );
}

/* ---------- Full hub ---------- */

function HubPanel({ onCollapse }: { onCollapse: () => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // The hub's browser preview starts on first run unless told otherwise; open it on Today with demo data.
    try {
      if (!localStorage.getItem('jarvis.preview.state.v1')) localStorage.setItem('jarvis.preview.state.v1', JSON.stringify({ settings: { onboarded: true } }));
    } catch {
      /* private mode: the hub opens on its first-run screen instead */
    }
    const id = window.setTimeout(() => setShown(true), reduced() ? 0 : 260);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="hub">
      <PanelHead title="Desktop Companion" meta="The real hub, running on its browser preview bridge with demo data.">
        <button type="button" className="btn btn-sm" onClick={onCollapse}>
          Collapse to island
        </button>
      </PanelHead>
      <div className="hub-frame">{shown && <iframe title="Desktop Companion hub (browser preview)" src="../index.html#/home" />}</div>
      <PanelFoot>
        <span className="p-meta">The hub keeps history, settings, Studio and saved work. The island stays the quick way in.</span>
      </PanelFoot>
    </div>
  );
}

/* ---------- Region selection ---------- */

function RegionOverlay({ onDone, onCancel }: { onDone: (r: Rect) => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const local = (e: RPointerEvent) => {
    const b = ref.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  return (
    <div
      className="region"
      ref={ref}
      role="application"
      aria-label="Draw a region. Drag with the pointer; Esc cancels."
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = local(e);
        setStart(p);
        setRect({ x: p.x, y: p.y, w: 0, h: 0 });
      }}
      onPointerMove={(e) => {
        if (!start) return;
        const p = local(e);
        setRect({ x: Math.min(p.x, start.x), y: Math.min(p.y, start.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
      }}
      onPointerUp={() => {
        if (rect && rect.w > 24 && rect.h > 24) onDone(rect);
        else {
          setStart(null);
          setRect(null);
        }
      }}
    >
      <p className="region-hint">
        Drag to mark the part of the screen to ask about. Nothing is captured in this prototype. <button type="button" className="linkbtn" onPointerDown={(e) => e.stopPropagation()} onClick={onCancel}>Cancel</button>
      </p>
      {rect && <div className="region-box" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} />}
    </div>
  );
}

/* ---------- Mock desktop ---------- */

function MockDesktop({ focusedApp, onFocusApp, region, signups }: { focusedApp: string; onFocusApp: (id: string) => void; region: Rect | null; signups: readonly number[] }) {
  const max = Math.max(...signups);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const win = (id: string, title: string, cls: string, body: ReactNode) => (
    <div className={`mock-window ${cls}${focusedApp === id ? ' is-focused' : ''}`} data-app={id} onPointerDown={() => onFocusApp(id)} onFocus={() => onFocusApp(id)}>
      <div className="mw-bar">
        <span className={`app-ico app-${id}`} aria-hidden />
        <span>{title}</span>
        <span className="mw-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
      </div>
      <div className="mw-body">{body}</div>
    </div>
  );
  return (
    <div className="mock" aria-label="Mock desktop (not your screen)">
      <div className="wall" aria-hidden />
      {win(
        'notes',
        'Field notes · Quarterly review draft',
        'w-notes',
        <textarea
          data-focus
          aria-label="Field notes draft (mock app)"
          defaultValue={'Quarterly review\n\nWins: shipped offline search; onboarding down to two steps.\nRisks: calendar import needs a recurring-event test.\nAsk Priya for the support numbers before Friday.\n\nSign-ups: see the Sheet. Something happened mid-quarter.'}
        />,
      )}
      {win(
        'sheet',
        'Sheet · Weekly sign-ups, Q3',
        'w-sheet',
        <div className="sheet" data-focus tabIndex={-1}>
          <div className="mock-chart" aria-label={`Bar chart of weekly sign-ups: ${signups.join(', ')}`} role="img">
            {signups.map((v, i) => (
              <span key={i} className={v === Math.min(...signups) ? 'is-low' : undefined} style={{ height: `${(v / max) * 100}%` }}>
                <em>{v}</em>
              </span>
            ))}
          </div>
          <div className="axis">
            {signups.map((_, i) => (
              <span key={i}>W{i + 1}</span>
            ))}
          </div>
        </div>,
      )}
      {win(
        'term',
        'Terminal',
        'w-term',
        <pre className="term" data-focus tabIndex={-1}>
          {'$ npm run build\n✓ built in 6.2s\n$ _'}
        </pre>,
      )}
      {region && <div className="region-mark" style={{ left: region.x, top: region.y, width: region.w, height: region.h }} aria-hidden />}
      <div className="taskbar" aria-hidden>
        <span className="tb-start" />
        {APPS.map((a) => (
          <span key={a.id} className={`tb-app${focusedApp === a.id ? ' on' : ''}`}>
            <span className={`app-ico app-${a.id}`} />
          </span>
        ))}
        <span className="tb-grow" />
        <span className="tb-tray">
          <span className="tb-core" />
          {clock.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  );
}

/* ---------- Guide (outside the mock desktop) ---------- */

function Guide({ surface, anchor, motion, playing, onAnchor, onMotion, onPlay, onJump, wall, onWall }: { surface: Surface; anchor: Anchor; motion: 'full' | 'reduced'; playing: boolean; onAnchor: (a: Anchor) => void; onMotion: (m: 'full' | 'reduced') => void; onPlay: () => void; onJump: (s: Surface) => void; wall: Wallpaper; onWall: (w: Wallpaper) => void }) {
  const order: Surface[] = ['rest', 'command', 'listening', 'acting', 'answer', 'utilities', 'customize', 'hub'];
  return (
    <aside className="guide" aria-label="Prototype guide">
      <p className="hud">Experience prototype</p>
      <h1>
        The companion, <em>on your desktop</em>
      </h1>
      <p className="lede">A design study of the companion’s form: a small island that opens where you are working, answers briefly, acts only after you confirm, and grows into the full hub when the work is bigger.</p>
      <p className="warn-strip">Scripted. No AI, no microphone, no screen capture. The desktop is a mock.</p>
      <button type="button" className="btn btn-primary btn-lg play" onClick={onPlay} disabled={playing}>
        {playing ? 'Playing the journey…' : 'Play the journey'}
      </button>
      <nav aria-label="States">
        <ol className="states">
          {order.map((s, i) => (
            <li key={s}>
              <button type="button" aria-current={surface === s ? 'step' : undefined} onClick={() => onJump(s)}>
                <span className="mono">{String(i + 1).padStart(2, '0')}</span> {SURFACE_NAME[s]}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <div className="g-row">
        <span>Rests at</span>
        <div className="seg seg-sm" role="radiogroup" aria-label="Where the island rests">
          {(
            [
              ['corner', 'Corner'],
              ['top', 'Top'],
              ['right', 'Right'],
            ] as const
          ).map(([id, name]) => (
            <button key={id} type="button" role="radio" aria-checked={anchor === id} className={anchor === id ? 'on' : undefined} onClick={() => onAnchor(id)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span>Desktop</span>
        <div className="seg seg-sm" role="radiogroup" aria-label="Mock desktop">
          {(
            [
              ['dark', 'Dark'],
              ['light', 'Light'],
              ['busy', 'Busy'],
            ] as const
          ).map(([id, name]) => (
            <button key={id} type="button" role="radio" aria-checked={wall === id} className={wall === id ? 'on' : undefined} onClick={() => onWall(id)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div className="g-row">
        <span>Motion</span>
        <div className="seg seg-sm" role="radiogroup" aria-label="Motion">
          {(
            [
              ['full', 'Full'],
              ['reduced', 'Reduced'],
            ] as const
          ).map(([id, name]) => (
            <button key={id} type="button" role="radio" aria-checked={motion === id} className={motion === id ? 'on' : undefined} onClick={() => onMotion(id)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <details className="truth">
        <summary>What is real here</summary>
        <ul>
          <li>The core is the app’s shared renderer and saved appearance.</li>
          <li>Open full hub loads the real app, on its browser preview with demo data.</li>
          <li>Focus really returns to the mock app you were typing in when the island closes.</li>
          <li>The focus timer counts, and voice samples use this browser’s voices when you ask.</li>
        </ul>
      </details>
      <details className="truth">
        <summary>What is not</summary>
        <ul>
          <li>Answers, plans, the transcript and the listening level are written in advance.</li>
          <li>Nothing is sent, recorded or captured; the region is only a rectangle on a mock.</li>
          <li>Always-on-top, focus with other apps, multiple displays and scaling need the Windows build.</li>
        </ul>
      </details>
      <p className="keys">
        <kbd>Ctrl</kbd> <kbd>Space</kbd> open or close · <kbd>Esc</kbd> back to your app
      </p>
    </aside>
  );
}
