import {StrictMode, useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AgentEvent, CompanionApi, CompanionPush, CompanionStatus, PlacementEvent} from '../src/companion/api';
import {CompanionIsland} from '../src/companion/island/CompanionIsland';
import {PlacementOptions} from '../src/companion/surfaces';
import {CompanionPet} from '../src/components/CompanionPet';
import type {PetState} from '../src/pet/contract';
import {petBoxWidth} from '../src/pet/PetSprite';
import '../src/styles/companion-bubble.css';
import '../src/styles/pet.css';
import './fonts/fonts.css';
import './island.css';

/*
 * Island review journey (prototype only). It mounts the PRODUCTION island (src/companion/island/CompanionIsland.tsx,
 * sharing the native companion's production shell and surfaces) over original mock desktops, against a SCRIPTED preview of
 * window.companion: every run event, placement and confirmation below is a labelled preview, not the native app.
 * The original First Light animation is a labelled review pack; actions remain scripted examples.
 *
 * window.__island exposes the controls scripts/island-journey.mjs drives; window.__frames records the shell's frame
 * timing; window.__layout records the native layout requests the island made, in order.
 */

const SIZE = 96;
const MARGIN = 18;
const DESK = {width: 1280, height: 720};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Frame = {at: number; dt: number; via: string; phase: string};
declare global {
  interface Window {
    __island: Record<string, (...a: never[]) => unknown>;
    __frames: Frame[];
    __layout: {at: number; bubble: {width: number; height: number} | null}[];
    __events: string[];
  }
}
window.__frames = [];
window.__layout = [];
window.__events = [];

/** A scripted stand-in for window.companion. Its placement mimics the main process: the bubble beside the pet, left side. */
function previewApi(): CompanionApi & {emit: (e: CompanionPush) => void; confirm: (yes: boolean) => void; scenario: string} {
  const listeners = new Set<(e: CompanionPush) => void>();
  const emit = (e: CompanionPush) => {
    window.__events.push('runId' in e ? `run:${e.event.type}${e.event.type === 'tool' ? `:${e.event.phase}` : ''}` : e.type);
    for (const l of listeners) l(e);
  };
  const petW = petBoxWidth(SIZE);
  const pet = {x: DESK.width - MARGIN - petW, y: DESK.height - MARGIN - SIZE, width: petW, height: SIZE};
  const place = (bubble: {width: number; height: number} | null) => {
    const b = bubble ? {x: Math.max(12, pet.x - MARGIN - bubble.width), y: Math.max(12, pet.y + pet.height - bubble.height), width: bubble.width, height: bubble.height} : null;
    const p: PlacementEvent = {type: 'placement', window: {x: 0, y: 0, ...DESK}, pet, bubble: b, side: b ? 'left' : null, size: SIZE, dock: 'bottom'};
    // The main process answers a layout request after an IPC round trip and a native setBounds.
    setTimeout(() => emit(p), 16);
  };
  let run = 0;
  let current: string | null = null;
  let pendingConfirm: ((yes: boolean) => void) | null = null;
  const status: CompanionStatus = {readiness: {ready: true, model: 'preview (no model is called)'}, shortcut: 'Control+Shift+Space', material: {requested: 'none', applied: false, note: ''}, platform: 'win32', appearance: 'pet', size: SIZE, dock: 'bottom', target: {process: 'notepad.exe', title: 'Shopping list - Notepad (sample window)'}};
  const api = {
    scenario: 'saved',
    emit,
    confirm: (yes: boolean) => pendingConfirm?.(yes),
    state: async () => status,
    ask: async (text: string) => {
      const runId = `preview-${++run}`;
      current = runId;
      void script(runId, text);
      return {runId};
    },
    cancel: async () => {
      if (!current) return false;
      const id = current;
      current = null;
      pendingConfirm?.(false);
      emit({runId: id, event: {type: 'error', reason: 'cancelled', message: 'Stopped. Anything already confirmed stays done; nothing else will run.'}});
      return true;
    },
    undo: async () => true,
    layout: async (l: {bubble: {width: number; height: number} | null}) => {
      window.__layout.push({at: performance.now(), bubble: l.bubble});
      place(l.bubble);
      return true;
    },
    drag: async () => ({started: false}), hit: async () => true, resize: async () => SIZE, dock: async () => 'bottom' as const, gaze: async () => true,
    setAppearance: async (a: 'pet' | 'legacy-orb') => a, clearTarget: async () => true, openHub: async () => true,
    setMaterial: async () => status.material,
    regionBegin: async () => {
      setTimeout(() => emit({type: 'region', token: 'preview-region-token-0001', preview: REGION_PREVIEW, width: 420, height: 180, sourceScale: 1}), 300);
      return {ok: true as const};
    },
    regionDiscard: async () => true,
    overlayImage: async () => null, overlaySubmit: async () => ({ok: true as const}), overlayCancel: async () => true,
    voiceStatus: async () => ({stt: {available: false, reason: 'Preview: speech runs only in the desktop app (Windows speech).'}, tts: {available: false, reason: 'Preview: speech runs only in the desktop app (Windows speech).'}, voice: null, speaking: false, transcribing: false, cloud: false as const}),
    transcribe: async () => ({text: '', reason: 'Preview: no recognizer'}), transcribeCancel: async () => false,
    speak: async () => ({ok: false, reason: 'Preview: no voice'}), speechStop: async () => false,
    onEvent: (cb: (e: CompanionPush) => void) => {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
  const ev = (runId: string, event: AgentEvent) => { if (current === runId) emit({runId, event}); };
  async function script(runId: string, text: string) {
    await wait(30);
    ev(runId, {type: 'status', phase: 'sending'});
    await wait(900);
    if (api.scenario === 'offline') {
      current = null;
      emit({runId, event: {type: 'error', reason: 'network', kind: 'offline', message: 'Offline mode: cloud requests are blocked'}});
      return;
    }
    if (api.scenario === 'type') {
      ev(runId, {type: 'tool', callId: 't1', tool: 'type_into_app', label: 'Typing into the app you were using', phase: 'running', summary: 'Preparing the text'});
      await wait(400);
      ev(runId, {type: 'tool', callId: 't1', tool: 'type_into_app', label: 'Typing into the app you were using', phase: 'awaiting-confirm', summary: 'Waiting for your answer in the Windows confirmation (typing 64 characters into notepad)'});
      const yes = await new Promise<boolean>((r) => { pendingConfirm = r; });
      pendingConfirm = null;
      if (current !== runId) return;
      if (!yes) {
        ev(runId, {type: 'tool', callId: 't1', tool: 'type_into_app', label: 'Typing into the app you were using', phase: 'declined', summary: 'Not confirmed. Nothing was typed'});
        await wait(500);
        ev(runId, {type: 'answer', text: 'You chose Cancel, so nothing was typed.', citations: [], steps: 2});
        current = null;
        return;
      }
      ev(runId, {type: 'tool', callId: 't1', tool: 'type_into_app', label: 'Typing into the app you were using', phase: 'running', summary: 'Typing into notepad'});
      await wait(700);
      ev(runId, {type: 'tool', callId: 't1', tool: 'type_into_app', label: 'Typing into the app you were using', phase: 'done', summary: 'Typed 64 characters into notepad. Not read back', verified: false});
      await wait(700);
      ev(runId, {type: 'answer', text: 'I typed the list into Notepad. I could not read it back, so check it there.', citations: [], steps: 2});
      current = null;
      return;
    }
    ev(runId, {type: 'tool', callId: 's1', tool: 'search_saved', label: 'Searching saved items', phase: 'running', summary: 'Searching saved items'});
    await wait(800);
    ev(runId, {type: 'tool', callId: 's1', tool: 'search_saved', label: 'Searching saved items', phase: 'done', summary: 'Found 1 saved item for “router reset”', verified: true});
    ev(runId, {type: 'status', phase: 'thinking'});
    await wait(900);
    ev(runId, {type: 'tool', callId: 'k1', tool: 'create_task', label: 'Adding a task', phase: 'running', summary: 'Adding a task'});
    await wait(300);
    ev(runId, {type: 'tool', callId: 'k1', tool: 'create_task', label: 'Adding a task', phase: 'awaiting-confirm', summary: 'Waiting for your answer in the Windows confirmation'});
    const yes = await new Promise<boolean>((r) => { pendingConfirm = r; });
    pendingConfirm = null;
    if (current !== runId) return;
    if (!yes) {
      ev(runId, {type: 'tool', callId: 'k1', tool: 'create_task', label: 'Adding a task', phase: 'declined', summary: 'Not confirmed. Nothing was saved'});
      await wait(400);
      ev(runId, {type: 'answer', text: 'Nothing was saved because you chose Cancel.', citations: [], steps: 3});
      current = null;
      return;
    }
    ev(runId, {type: 'tool', callId: 'k1', tool: 'create_task', label: 'Adding a task', phase: 'running', summary: 'Saving the task'});
    await wait(250);
    ev(runId, {type: 'tool', callId: 'k1', tool: 'create_task', label: 'Adding a task', phase: 'running', summary: 'Checking the task is in your list', stage: 'verifying'});
    await wait(450);
    ev(runId, {type: 'tool', callId: 'k1', tool: 'create_task', label: 'Adding a task', phase: 'done', summary: 'Added “Re-pair the mesh”, due 2026-10-19', verified: true, undo: {kind: 'task', id: 'task-preview-1', label: 'Remove'}});
    ev(runId, {type: 'status', phase: 'thinking'});
    await wait(800);
    ev(runId, {type: 'answer', text: `Your router note says: hold the reset pin for 10 seconds, then sign in at 192.168.1.1. I added a task to re-pair the mesh tomorrow. [note:n1] [task:task-preview-1]${text ? '' : ''}`, citations: [{kind: 'note', id: 'n1', title: 'Router reset steps (sample)'}, {kind: 'task', id: 'task-preview-1', title: 'Re-pair the mesh (sample)'}], steps: 3});
    current = null;
  }
  return api as unknown as CompanionApi & {emit: (e: CompanionPush) => void; confirm: (yes: boolean) => void; scenario: string};
}

const REGION_PREVIEW = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180"><rect width="420" height="180" fill="#f4f1ea"/><rect x="14" y="14" width="392" height="22" rx="4" fill="#d9d3c4"/><text x="22" y="30" font-family="Segoe UI, sans-serif" font-size="13" fill="#333">Router reset steps (sample screen area)</text><text x="22" y="66" font-family="Segoe UI, sans-serif" font-size="12" fill="#444">1. Hold the reset pin for 10 seconds</text><text x="22" y="88" font-family="Segoe UI, sans-serif" font-size="12" fill="#444">2. Wait for the amber light</text><text x="22" y="110" font-family="Segoe UI, sans-serif" font-size="12" fill="#444">3. Sign in at 192.168.1.1</text></svg>')}`;

const api = previewApi();

function Desk() {
  const [scene, setScene] = useState<'light' | 'dark' | 'busy'>('light');
  const [reduced, setReduced] = useState(false);
  const [pose, setPose] = useState<PetState>('idle');
  useEffect(() => {
    window.__island = {
      invoke: () => api.emit({type: 'invoke'}),
      collapse: () => api.emit({type: 'collapse'}),
      confirm: (yes: boolean) => api.confirm(yes),
      scene: (s: 'light' | 'dark' | 'busy') => setScene(s),
      scenario: (s: string) => { api.scenario = s; },
      reduced: (on: boolean) => {
        setReduced(on);
        document.documentElement.dataset.motion = on ? 'reduced' : 'full';
      },
      resetFrames: () => { window.__frames = []; },
    };
    // The first placement: the window at rest is the pet plus margin (no bubble).
    void api.layout({bubble: null});
  }, []);
  const petW = petBoxWidth(SIZE);
  return (
    <div className="desk" data-scene={scene}>
      <MockDesktop scene={scene} />
      <div className="preview-tag" role="note">
        Preview: the production island over a mock desktop. Run events, placement and the Windows confirmation are scripted; no model, microphone or native window is used.
      </div>
      <div className="island-review-controls" aria-label="Motion preview controls">
        <button type="button" onClick={() => api.emit({type: 'invoke'})}>Open companion</button>
        <button type="button" onClick={() => api.emit({type: 'collapse'})}>Collapse</button>
        <label>Desktop <select aria-label="Desktop scene" value={scene} onChange={e => setScene(e.target.value as typeof scene)}><option value="light">Light</option><option value="dark">Dark</option><option value="busy">Busy / grid</option></select></label>
        <label>Example <select aria-label="Preview example" defaultValue="saved" onChange={e => {api.scenario = e.target.value;}}><option value="saved">Saved information + task</option><option value="type">Typing receipt</option><option value="offline">Offline recovery</option></select></label>
        <label><input type="checkbox" checked={reduced} onChange={e => {setReduced(e.target.checked); document.documentElement.dataset.motion = e.target.checked ? 'reduced' : 'full';}} /> Reduce motion</label>
        <span>Scripted confirmation:</span>
        <button type="button" onClick={() => api.confirm(true)}>Accept sample</button>
        <button type="button" onClick={() => api.confirm(false)}>Decline sample</button>
      </div>
      <button type="button" className="pet-anchor review-pet" aria-label="Open companion motion preview" onClick={() => api.emit({type: 'invoke'})} style={{left: DESK.width - MARGIN - petW, top: DESK.height - MARGIN - SIZE, width: petW, height: SIZE}}>
        <CompanionPet size={SIZE} pose={pose} showWhenHidden />
      </button>
      <CompanionIsland
        api={api}
        reducedMotion={reduced}
        onPetSignals={signals => setPose(signals.awaitingPerson ? 'waiting' : signals.surface === 'working' ? 'running' : signals.surface === 'answer' ? 'review' : signals.surface === 'error' ? 'failed' : 'idle')}
        options={<PlacementOptions size={SIZE} dock="bottom" appearance="pet" onDock={() => undefined} onResize={() => undefined} onAppearance={() => undefined} />}
        onFrameSample={(f) => window.__frames.push(f)}
      />
    </div>
  );
}

function MockDesktop({scene}: {scene: 'light' | 'dark' | 'busy'}) {
  return (
    <div className="mock" aria-hidden>
      <div className="mock-win mock-notepad">
        <div className="mock-bar">Shopping list - Notepad (sample window)</div>
        <div className="mock-body">eggs{'\n'}oat milk{'\n'}rye bread{'\n'}</div>
      </div>
      {scene !== 'light' && (
        <div className="mock-win mock-code">
          <div className="mock-bar">router-notes.md (sample editor)</div>
          <div className="mock-body">## Router reset{'\n'}1. Hold the reset pin for 10 seconds{'\n'}2. Wait for the amber light{'\n'}3. Sign in at 192.168.1.1</div>
        </div>
      )}
      {scene === 'busy' && (
        <>
          <div className="mock-win mock-browser"><div className="mock-bar">Weather (sample page)</div><div className="mock-body">Rain later, 14°</div></div>
          <div className="mock-win mock-chat"><div className="mock-bar">Messages (sample)</div><div className="mock-body">Can you send the list?</div></div>
          <div className="mock-icons">{Array.from({length: 8}, (_, i) => <span key={i} />)}</div>
        </>
      )}
      <div className="mock-taskbar"><span /><span /><span /><span /></div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Desk />
  </StrictMode>,
);
