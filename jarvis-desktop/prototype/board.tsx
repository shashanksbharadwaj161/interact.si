import {StrictMode, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {AppearanceProvider} from '../src/ui/appearance-context';
import {AnswerView, Bubble, Command, ErrorView, PlacementOptions, Working, type BubbleEdge, type ToolStep} from '../src/companion/surfaces';
import type {CompanionStatus} from '../src/companion/api';
import {createPetAdapter, type PetFailure, type PetSignals, type PetView} from '../src/pet/adapter';
import {loadAtlas, type PetLoad} from '../src/pet/loader';
import {parsePetManifest} from '../src/pet/manifest';
import {MissingArt} from '../src/pet/MissingArt';
import {PetSlot} from '../src/pet/PetSlot';
import {PetSprite} from '../src/pet/PetSprite';
import patternUrl from '../tests/fixtures/pet-test-pattern/spritesheet.png?inline';
import patternManifestRaw from '../tests/fixtures/pet-test-pattern/pet.json?raw';
import fontsRaw from './fonts/fonts.json?raw';
import {createMicConsent} from '../src/ui/audio';
import {VoiceSession, type VoiceRecorder} from '../src/voice/session';
import {TalkButton, VoiceBar} from '../src/voice/VoiceBar';
import '../src/styles/companion-bubble.css';
import '../src/styles/voice.css';
import '../src/styles/pet.css';
import './fonts/fonts.css';
import './board.css';

/*
 * Direction board (prototype only, for owner review; nothing here is approved). It renders the production pieces: the
 * bubble surfaces (src/companion/surfaces.tsx), the character slot and missing-art state (src/pet), and the renderer
 * driven by the real state adapter. Sample text is labelled. No character art exists in this branch: the renderer is
 * exercised with the engineering TEST PATTERN atlas (flat labelled rectangles), never with a stand-in character.
 */

document.documentElement.dataset.motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full';
const now = () => performance.now();

/* ---------- Sample data (labelled on the page) ---------- */

const READY: CompanionStatus = {readiness: {ready: true, model: 'claude-haiku-4-5'}, shortcut: 'Control+Shift+Space', material: {requested: 'none', applied: false, note: ''}, platform: 'win32', appearance: 'pet', size: 96, dock: 'bottom', target: {process: 'notepad.exe', title: 'Untitled - Notepad'}};
const step = (callId: string, phase: ToolStep['phase'], summary: string, extra: Partial<ToolStep> = {}): ToolStep => ({type: 'tool', callId, tool: 'x', label: 'x', phase, summary, ...extra});
const ANSWER = {type: 'answer' as const, text: 'Your router note says: hold the reset pin for 10 seconds, wait for the amber light, then sign in at 192.168.1.1. I added a reminder for tomorrow and typed the steps into Notepad. [note:n1] [task:t1]', citations: [{kind: 'note' as const, id: 'n1', title: 'Router reset steps'}, {kind: 'task' as const, id: 't1', title: 'Re-pair the mesh'}], steps: 3};
const ANSWER_STEPS = [
  step('a', 'done', 'Found 1 saved item for “router reset”', {verified: true}),
  step('b', 'done', 'Added “Re-pair the mesh”, due 2026-10-18', {verified: true, undo: {kind: 'task', id: 't1', label: 'Remove'}}),
  step('c', 'done', 'Typed 112 characters into notepad. Not read back', {verified: false}),
];
/**
 * Board only: a recorder that emits a scripted TEST level (a slow wave), never a microphone, and a backend that returns
 * labelled sample text after a delay. They drive the real voice session and components so their states can be reviewed.
 */
function scriptedRecorder(): VoiceRecorder {
  let timer = 0;
  let t0 = 0;
  const r: VoiceRecorder = {
    async start() {
      t0 = performance.now();
      timer = window.setInterval(() => r.onLevel?.(0.4 + 0.35 * Math.sin((performance.now() - t0) / 170) * Math.sin((performance.now() - t0) / 610)), 60);
    },
    async stop() {
      window.clearInterval(timer);
      return {wav: [], durationMs: performance.now() - t0, peak: 0.4};
    },
    cancel() { window.clearInterval(timer); },
  };
  return r;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function boardVoice(): VoiceSession {
  const consent = createMicConsent(null);
  consent.grant();
  return new VoiceSession({
    backend: {
      transcribe: async () => { await wait(1600); return {text: 'Sample transcript (board: no recognizer ran)'}; },
      speak: async () => { await wait(60_000); return {ok: true}; },
      stopSpeaking: async () => true,
      cancelTranscribe: async () => true,
    },
    consent,
    support: {supported: true},
    caps: () => ({stt: {available: true}, tts: {available: true}}),
    createRecorder: scriptedRecorder,
  });
}

/** The island's voice row as Codex would place it in the bubble: compact bar plus Talk, from src/voice. */
function VoiceScene({start}: {start: 'listening' | 'speaking'}) {
  const [voice] = useState(boardVoice);
  const snap = useSyncExternalStore(voice.subscribe, voice.getSnapshot);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    voice.onTranscript = (t) => setLast(t.text);
    if (start === 'listening') void voice.startListening();
    else void voice.speak('Your router note says: hold the reset pin for ten seconds.', {key: 'board'});
    return () => voice.release();
  }, [voice, start]);
  return (
    <div className="cmd">
      <div className="b-head">
        <div className="b-title">
          <strong>{start === 'listening' ? 'Voice: listening' : 'Voice: reading the answer'}</strong>
          <span className="b-meta">Real components; scripted test level and sample text</span>
        </div>
      </div>
      <VoiceBar voice={voice} snap={snap} voiceName="Windows default voice" compact />
      {snap.phase === 'idle' && <p className="b-meta">{last ? `Placed for review: “${last}”` : snap.note?.text ?? 'At rest. Talk starts listening.'}</p>}
      <div className="b-foot">
        <span className="b-meta">Level: scripted test signal, not a microphone.</span>
        <TalkButton voice={voice} snap={snap} block={voice.blocks().listen} />
      </div>
    </div>
  );
}

const WORK_STEPS = [step('a', 'done', 'Found 2 saved items for “invoice”', {verified: true}), step('b', 'awaiting-confirm', 'Waiting for your answer in the Windows confirmation (typing into notepad)')];
const noop = () => undefined;

/* ---------- Concepts (briefs only) ---------- */

const CONCEPTS = [
  {letter: 'A', name: 'Dog-eared bookkeeper creature', line: 'A pocket-sized pear-shaped creature with one ear folded like a bookmarked page. Quick, curious, a little smug when it remembers something for you.', identity: 'The page-corner fold on one ear and an ink-dipped brush tail.', palette: ['#F4E9D8', '#2C2F6B', '#FF8A6B', '#7FD6C9', '#1A1A2A'], material: 'Matte soft-vinyl toy', note: 'Codex has generated canonical concept art for this direction on its own branch. It is not in this branch and is not approved.'},
  {letter: 'B', name: 'Fan-crest wind-up automaton', line: 'An enamel-and-brass wind-up toy with a folding paper-fan crest that snaps open with ideas. A gleeful tinkerer that loves pressing the button.', identity: 'The pleated fan crest and the wind-up key that turns while it works.', palette: ['#1F7A78', '#E3B04B', '#D9573B', '#F3E6C8', '#2B2321'], material: 'Glossy painted tin', note: 'No concept art generated yet.'},
  {letter: 'C', name: 'Dusk-felt mothling', line: 'A chubby upright felt moth with feathery antennae (one kinked) and a fluffy apricot collar. Gentle, dreamy, turns toward every light.', identity: 'The kinked antenna, the apricot collar, and its light-seeking glance.', palette: ['#5B3A6E', '#F6B47C', '#C9B8F0', '#FFE6C7', '#2A1830'], material: 'Felt and plush', note: 'No concept art generated yet. Highest originality risk (moth designs exist); judge on real art.'},
];

/* ---------- Typography ---------- */

const FONTS = JSON.parse(fontsRaw) as Record<string, {package: string; version: string; license: string}>;
const PAIRINGS = [
  {id: 'a', title: 'Bricolage Grotesque + Figtree', display: '"Bricolage Grotesque", sans-serif', body: '"Figtree", sans-serif', ids: ['bricolage-grotesque', 'figtree'], note: 'Recommended. Expressive, slightly quirky display with optical sizes; calm, open body text. Warm without looking like a kids app; distinct from the rejected sci-fi lettering. Used by the bubble in this branch.', recommended: true},
  {id: 'b', title: 'Fraunces (soft) + Atkinson Hyperlegible Next', display: '"Fraunces", serif', body: '"Atkinson Hyperlegible Next", sans-serif', ids: ['fraunces', 'atkinson-hyperlegible-next'], note: 'Crafted and storybook-like (soft, wonky serif); the body face is built to tell I/l/1 and O/0 apart. Furthest from the current cyberpunk feel; heaviest download.', recommended: false},
  {id: 'c', title: 'Unbounded + Onest', display: '"Unbounded", sans-serif', body: '"Onest", sans-serif', ids: ['unbounded', 'onest'], note: 'Futuristic but rounded and friendly. Very wide: short strings only. Closest to the old direction, so the most likely to read as generic tech.', recommended: false},
];

function Specimen({p}: {p: (typeof PAIRINGS)[number]}) {
  return (
    <article className="spec" data-recommended={p.recommended || undefined} style={{['--spec-display' as string]: p.display, ['--spec-body' as string]: p.body}}>
      <header className="spec-head">
        <strong>{p.title}</strong>
        {p.recommended && <span className="tag">Recommended</span>}
      </header>
      <p className="spec-first">Hi, I live on your desktop.</p>
      <p className="spec-title">What can I do for you?</p>
      <p className="spec-body">Your router note says: hold the reset pin for 10 seconds, wait for the amber light, then sign in at 192.168.1.1.</p>
      <p className="spec-meta">Claude · 2 steps · Sends your request to Anthropic with your key.</p>
      <p className="spec-controls">
        <span className="spec-btn primary">Ask</span>
        <span className="spec-btn">Follow up</span>
        <span className="spec-chip">Note · Router reset steps</span>
      </p>
      <p className="spec-proof">Il1| O0o rn m 5S 8B — “Task #1I0l” ĀčĘłŐ</p>
      <p className="spec-why">{p.note}</p>
      <p className="spec-lic">
        {p.ids.map((id) => (FONTS[id] ? `${FONTS[id].package}@${FONTS[id].version} (${FONTS[id].license})` : id)).join(' · ')}
      </p>
    </article>
  );
}

/* ---------- Renderer lab: real adapter, engineering test pattern ---------- */

type Lab = {surface: PetSignals['surface']; requestInFlight: boolean; awaitingPerson: boolean; failure: PetFailure | null; dragVx: number | null; gaze: number | null; reduced: boolean};
const LAB_REST: Lab = {surface: 'rest', requestInFlight: false, awaitingPerson: false, failure: null, dragVx: null, gaze: null, reduced: false};

function RendererLab() {
  const [load, setLoad] = useState<PetLoad | null>(null);
  const [lab, setLab] = useState<Lab>(LAB_REST);
  const [size, setSize] = useState(128);
  const [, tick] = useState(0);
  const adapter = useMemo(() => createPetAdapter(now()), []);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parsed = parsePetManifest(JSON.parse(patternManifestRaw));
    if (!parsed.ok) {
      setLoad({status: 'invalid', id: 'test-pattern', errors: parsed.errors});
      return undefined;
    }
    let alive = true;
    void loadAtlas(parsed.manifest, patternUrl).then((l) => {
      if (alive) setLoad(l);
      else if (l.status === 'ready') l.bitmap.close();
    });
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => () => {
    if (load?.status === 'ready') load.bitmap.close();
  }, [load]);

  adapter.signal({surface: lab.surface, requestInFlight: lab.requestInFlight, awaitingPerson: lab.awaitingPerson, failure: lab.failure, dragVx: lab.dragVx, gaze: lab.gaze, reducedMotion: lab.reduced}, now());
  const view: PetView = adapter.view(now());
  // Re-render when a one-shot or the review passes end by themselves.
  const until = view.kind === 'state' ? view.until : null;
  useEffect(() => {
    if (until === null) return undefined;
    const id = window.setTimeout(() => tick((n) => n + 1), Math.max(0, until - now()) + 20);
    return () => window.clearTimeout(id);
  }, [until]);

  const set = (patch: Partial<Lab>) => setLab((l) => ({...l, ...patch}));
  const fire = (kind: 'invoked' | 'verified-change' | 'answer-shown') => {
    adapter.event({kind}, now());
    tick((n) => n + 1);
  };
  const button = (label: string, on: () => void, pressed = false) => (
    <button type="button" className="btn btn-sm" aria-pressed={pressed} onClick={on}>
      {label}
    </button>
  );
  return (
    <div className="lab">
      <div
        className="lab-stage"
        ref={stage}
        onPointerMove={(e) => {
          if (lab.surface !== 'rest' && lab.surface !== 'command') return;
          const r = stage.current!.getBoundingClientRect();
          const hx = r.left + r.width / 2;
          const hy = r.bottom - 24 - size * 0.65;
          const dx = e.clientX - hx;
          const dy = e.clientY - hy;
          const inside = Math.abs(dx) < (size * 0.45) && Math.abs(dy) < size * 0.5;
          set({gaze: inside ? null : ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360});
        }}
        onPointerLeave={() => set({gaze: null})}
      >
        {load?.status === 'ready' ? <PetSprite pet={load} view={view} size={size} /> : <MissingArt size={size} status={load?.status === 'invalid' ? 'invalid' : 'missing'} reason={load?.status === 'invalid' ? load.errors[0] : 'Loading the test pattern…'} />}
        <span className="lab-label">Engineering test pattern, not character art</span>
      </div>
      <div className="lab-side">
        <p className="lab-now">
          <strong>{view.kind === 'look' ? `look ${(view.index * 22.5).toFixed(1)}°` : view.state}</strong>
          {view.kind === 'state' && view.still ? ' · still frame (reduced motion)' : ''}
          <br />
          <span>{view.reason}</span>
        </p>
        <div className="lab-buttons">
          {button('Rest', () => setLab({...LAB_REST, reduced: lab.reduced}))}
          {button('Open (wave once)', () => {
            set({...LAB_REST, reduced: lab.reduced, surface: 'command'});
            fire('invoked');
          })}
          {button('Request in flight', () => set({surface: 'working', requestInFlight: true, awaitingPerson: false, failure: null}), lab.requestInFlight && !lab.awaitingPerson)}
          {button('Confirmation open', () => set({surface: 'working', requestInFlight: true, awaitingPerson: true}), lab.awaitingPerson)}
          {button('Verified change (jump)', () => {
            set({surface: 'answer', requestInFlight: false, awaitingPerson: false, failure: null});
            fire('verified-change');
          })}
          {button('Answer shown (review)', () => {
            set({surface: 'answer', requestInFlight: false, awaitingPerson: false, failure: null});
            fire('answer-shown');
          })}
          {button('Provider error', () => set({surface: 'error', requestInFlight: false, awaitingPerson: false, failure: 'provider'}), lab.failure === 'provider')}
          {button('You cancelled', () => set({surface: 'error', requestInFlight: false, awaitingPerson: false, failure: 'cancelled'}), lab.failure === 'cancelled')}
        </div>
        <div className="lab-buttons">
          <button type="button" className="btn btn-sm" onPointerDown={() => set({dragVx: -240})} onPointerUp={() => set({dragVx: null})} onPointerLeave={() => set({dragVx: null})}>
            Hold: drag left
          </button>
          <button type="button" className="btn btn-sm" onPointerDown={() => set({dragVx: 240})} onPointerUp={() => set({dragVx: null})} onPointerLeave={() => set({dragVx: null})}>
            Hold: drag right
          </button>
          {button(lab.reduced ? 'Reduced motion: on' : 'Reduced motion: off', () => set({reduced: !lab.reduced}), lab.reduced)}
          <span className="seg">
            {[64, 96, 128].map((s) => (
              <button key={s} type="button" aria-pressed={size === s} onClick={() => setSize(s)}>
                {s}px
              </button>
            ))}
          </span>
        </div>
        <p className="note">Move the pointer around the stage: gaze picks one of 16 look cells, computed locally. Frames change only on the contract's own durations; nothing draws between changes.</p>
      </div>
    </div>
  );
}

/* ---------- Board ---------- */

function Section({id, title, lede, children}: {id: string; title: string; lede?: ReactNode; children: ReactNode}) {
  return (
    <section className="sec" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {lede && <p className="lede">{lede}</p>}
      {children}
    </section>
  );
}

function EdgeDemo({edge, label}: {edge: BubbleEdge; label: string}) {
  return (
    <div className="edge-demo">
      <Bubble surface="demo" side="none" edge={edge} edgeKey={label} label={label}>
        <div className="mini">
          <strong>{label}</strong>
        </div>
      </Bubble>
    </div>
  );
}

function Board() {
  const [showOpts, setShowOpts] = useState(true);
  const [text, setText] = useState('Put the router steps into Notepad');
  const [edgeRun, setEdgeRun] = useState(0);
  return (
    <main className="board cd">
      <header className="board-head">
        <p className="kicker">Desktop Companion · direction board</p>
        <h1>A character on your desktop, with a bubble beside it</h1>
        <p className="lede">
          Candidate direction for review, not approved. The character carries expression; the bubble carries text and controls; the edge light reports only real interface state. The three character directions are briefs: this session has no image tool, so no character art appears here. Everything below is a production component unless it says otherwise.
        </p>
      </header>

      <Section id="char" title="The character: three original directions" lede="Pick one direction after seeing generated canonical art. Species and name stay open until then. Boxes show the space the character takes at 64, 96 and 128 px.">
        <div className="concepts">
          {CONCEPTS.map((c) => (
            <article key={c.letter} className="concept">
              <header>
                <span className="letter">{c.letter}</span>
                <strong>{c.name}</strong>
              </header>
              <div className="sizes" aria-label="Character slot at 64, 96 and 128 px">
                <MissingArt size={64} reason="Concept art not generated in this session." />
                <MissingArt size={96} reason="Concept art not generated in this session." />
                <MissingArt size={128} reason="Concept art not generated in this session." />
              </div>
              <p>{c.line}</p>
              <p className="small">
                <strong>Identity:</strong> {c.identity}
              </p>
              <p className="small">
                <strong>Material:</strong> {c.material}
              </p>
              <div className="swatches" aria-label="Palette">
                {c.palette.map((h) => (
                  <span key={h} style={{background: h}} title={h} />
                ))}
              </div>
              <p className="note">{c.note}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section id="lab" title="Renderer and motion, driven by real signals" lede="The app's own sprite renderer and state adapter, playing the engineering test pattern (flat labelled rectangles, never shown to people). Approved character art drops into the same slot with no code change.">
        <RendererLab />
      </Section>

      <Section id="type" title="Typography, rendered at app sizes" lede="All six faces are SIL OFL 1.1, fetched from Fontsource with their licence files; versions and hashes in prototype/fonts/fonts.json. Sentence case everywhere; personality comes from the faces, not from uppercase tracking.">
        <div className="specs">
          {PAIRINGS.map((p) => (
            <Specimen key={p.id} p={p} />
          ))}
        </div>
      </Section>

      <Section id="glass" title="Glass, controls and edge light" lede="Pill controls with neutral hairlines; hover or focus lights the control's own edge. The bubble's perimeter light has five states and each one maps to a real event.">
        <div className="controls">
          <button type="button" className="btn btn-primary">Ask</button>
          <button type="button" className="btn">Follow up</button>
          <button type="button" className="btn btn-sm">Undo</button>
          <button type="button" className="btn" disabled>
            Ask (not connected)
          </button>
          <button type="button" className="chipbtn">Pick an area</button>
          <button type="button" className="cite">
            <span className="cite-kind">Note</span> · Router reset steps
          </button>
          <span className="seg">
            <button type="button" aria-pressed>
              S
            </button>
            <button type="button">M</button>
            <button type="button">L</button>
          </span>
          <button type="button" className="stop">Stop</button>
        </div>
        <div className="edges" key={edgeRun}>
          <EdgeDemo edge="idle" label="Idle: no light" />
          <EdgeDemo edge="working" label="Request in flight" />
          <EdgeDemo edge="waiting" label="Confirmation open" />
          <EdgeDemo edge="done" label="Answer arrived" />
          <EdgeDemo edge="error" label="Error" />
          <button type="button" className="btn btn-sm" onClick={() => setEdgeRun((n) => n + 1)}>
            Replay
          </button>
        </div>
      </Section>

      <Section id="surfaces" title="Resting, listening, working and answering" lede="Sample content, real components. The voice scenes run the real voice session (src/voice) with a scripted test level and labelled sample text: no microphone, recognizer or voice is used on this board.">
        <div className="desk">
          <div className="scene rest">
            <span className="scene-label">Resting: only the character, nothing moving but its idle</span>
            <div className="ground">
              <PetSlot size={96} view={{kind: 'state', state: 'idle', loop: true, still: false, reason: 'Resting until you need it', since: 0, plays: 0, holdLast: false, frame: null, until: null}} />
            </div>
          </div>
          <div className="scene">
            <span className="scene-label">Invoked: command with the remembered window</span>
            <Bubble surface="command" side="left" edge="idle" label="Command">
              <Command status={READY} text={text} setText={setText} region={null} note={null} options={<PlacementOptions size={96} dock="bottom" appearance="pet" onDock={noop} onResize={noop} onAppearance={noop} />} showOptions={showOpts} onToggleOptions={() => setShowOpts((v) => !v)} onAsk={noop} onRegion={noop} onRemoveRegion={noop} onHub={noop} onClose={noop} target={READY.target} onClearTarget={noop} autoFocus={false} />
            </Bubble>
          </div>
          <div className="scene">
            <span className="scene-label">Listening: compact voice bar and Talk (scripted test level)</span>
            <Bubble surface="listening" side="left" edge="waiting" label="Listening">
              <VoiceScene start="listening" />
            </Bubble>
          </div>
          <div className="scene">
            <span className="scene-label">Reading the answer aloud, with Stop (sample, no voice plays)</span>
            <Bubble surface="answer" side="left" edge="done" label="Reading aloud">
              <VoiceScene start="speaking" />
            </Bubble>
          </div>
          <div className="scene">
            <span className="scene-label">Working: waiting for the Windows confirmation</span>
            <Bubble surface="working" side="left" edge="waiting" label="Working">
              <Working pending={null} steps={WORK_STEPS} hasRun onStop={noop} autoFocus={false} />
            </Bubble>
          </div>
          <div className="scene">
            <span className="scene-label">Answer: citations, a checked change with Undo, and an unchecked one without</span>
            <Bubble surface="answer" side="left" edge="idle" label="Answer">
              <AnswerView answer={ANSWER} steps={ANSWER_STEPS} undone={{}} onUndo={noop} onOpen={noop} onFollow={noop} onDone={noop} autoFocus={false} />
            </Bubble>
          </div>
          <div className="scene">
            <span className="scene-label">Error: says exactly what happened</span>
            <Bubble surface="error" side="left" edge="error" label="Error">
              <ErrorView failure={{type: 'error', reason: 'network', message: 'Anthropic could not be reached. Check the connection and try again. Nothing was sent after this point.'}} steps={[]} undone={{}} onUndo={noop} onRetry={noop} onSettings={noop} onDone={noop} />
            </Bubble>
          </div>
        </div>
      </Section>

      <Section id="first" title="First run: meet the character, do one useful thing" lede="Proposal for the first-run screen (Onboarding.tsx is being reworked on Codex's branch). A compact scene instead of a marketing heading and two cards; the character slot shows the missing-art state until real art is approved.">
        <div className="first">
          <div className="first-stage">
            <MissingArt size={128} reason="The chosen character appears here once its art is approved." />
            <Bubble surface="first" side="right" edge="idle" label="First run">
              <div className="cmd">
                <div className="b-head">
                  <div className="b-title">
                    <strong>Hi! I live on your desktop now.</strong>
                    <span className="b-meta">Press Ctrl + Shift + Space any time, or click me.</span>
                  </div>
                </div>
                <p className="first-copy">Tell me one thing to remember. It stays on this computer; you can find it later by asking me.</p>
                <div className="cmd-row">
                  <textarea className="cmd-input" rows={1} defaultValue="The router password is on the sticker under the base" aria-label="Something to remember (sample)" />
                  <button type="button" className="btn btn-primary">Remember it</button>
                </div>
                <div className="b-foot">
                  <span className="b-meta">Works offline. Connect Claude later for questions about your screen and actions in other apps.</span>
                  <button type="button" className="btn btn-sm">Connect Claude</button>
                  <button type="button" className="linkbtn">Skip</button>
                </div>
              </div>
            </Bubble>
          </div>
          <ul className="first-notes">
            <li>“Remember it” would save a real note (the existing saveNote path), and the character would show its verified-change reaction only after the note is read back.</li>
            <li>Theme, reduced motion and privacy choices move to a small “Settings” link; nothing is allowed by default.</li>
            <li>Connecting Claude keeps the existing flow: key in the Windows vault, online mode behind the native confirmation (Cancel is the default).</li>
          </ul>
        </div>
      </Section>

      <footer className="board-foot">
        <p>Product slot right now (product mode, real registry): </p>
        <PetSlot size={64} view={{kind: 'state', state: 'idle', loop: true, still: false, reason: 'Resting until you need it', since: 0, plays: 0, holdLast: false, frame: null, until: null}} />
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppearanceProvider>
      <Board />
    </AppearanceProvider>
  </StrictMode>,
);
