// window.companion, exposed by electron/companionPreload.ts. Absent in a browser, where the page says so instead of failing.
import type {AgentEvent} from '../../electron/services/agent';

export type Readiness = {ready: true; model: string} | {ready: false; reason: string};
export type MaterialState = {requested: 'none' | 'acrylic'; applied: boolean; note: string};
export type Appearance = 'pet' | 'legacy-orb';
export type Dock = 'free' | 'bottom' | 'top' | 'left' | 'right';
export type DockTarget = 'bottom-left' | 'bottom-right' | 'left' | 'right' | 'top';
export type TypingTarget = {process: string; title: string};
export type CompanionStatus = {readiness: Readiness; shortcut: string | null; material: MaterialState; platform: string; appearance: Appearance; size: number; dock: Dock; target: TypingTarget | null; reduceMotion?: boolean};
export type Box = {x: number; y: number; width: number; height: number};
/** The island's voice engines (local Windows speech; `cloud` is always false). */
export type CompanionVoiceStatus = {stt: {available: boolean; reason?: string}; tts: {available: boolean; reason?: string}; voice: string | null; speaking: boolean; transcribing: boolean; cloud: false; /** The native microphone policy; the session refuses audio while false. Optional for older main processes. */ inputAllowed?: boolean};
export type PlacementEvent = {type: 'placement'; window: Box; pet: Box; bubble: Box | null; side: 'left' | 'right' | 'above' | 'below' | null; size: number; dock: Dock};
export type RegionEvent = {type: 'region'; token: string; preview: string; width: number; height: number; sourceScale: number};
export type CompanionPush =
  | {type: 'invoke'}
  | {type: 'collapse'}
  | {type: 'region-cancelled'}
  | {type: 'region-expired'; token: string}
  | RegionEvent
  | PlacementEvent
  | {type: 'drag'; vx: number | null}
  | {type: 'gaze'; index: number | null}
  | {type: 'target'; target: TypingTarget | null}
  /** The microphone policy changed (hub settings, the island or an import). */
  | {type: 'voice-policy'; allowed: boolean}
  | {runId: string; event: AgentEvent};

export interface CompanionApi {
  state(): Promise<CompanionStatus>;
  /** `withTarget`: the page showed the remembered app window and the person kept it attached (typing may go there). */
  ask(text: string, token?: string, withTarget?: boolean): Promise<{runId: string}>;
  cancel(): Promise<boolean>;
  undo(id: string): Promise<boolean>;
  layout(l: {bubble: {width: number; height: number} | null}): Promise<boolean>;
  drag(phase: 'start' | 'end'): Promise<{started: boolean} | {moved: boolean}>;
  hit(over: boolean): Promise<boolean>;
  resize(op: 'S' | 'M' | 'L' | 'grow' | 'shrink'): Promise<number>;
  dock(target: DockTarget): Promise<Dock>;
  gaze(on: boolean): Promise<boolean>;
  setAppearance(a: Appearance): Promise<Appearance>;
  clearTarget(): Promise<boolean>;
  openHub(view: 'home' | 'assistant' | 'notes' | 'tasks' | 'capsules' | 'search' | 'companion' | 'settings', item?: string): Promise<boolean>;
  setMaterial(m: 'none' | 'acrylic'): Promise<MaterialState>;
  /** Voice (island only). Same local Windows speech as the hub; closing the bubble stops the island's speech and transcription. */
  voiceStatus(): Promise<CompanionVoiceStatus>;
  transcribe(wav: number[]): Promise<{text: string; reason?: string; cancelled?: boolean}>;
  transcribeCancel(): Promise<boolean>;
  speak(text: string): Promise<{ok: boolean; reason?: string}>;
  speechStop(): Promise<boolean>;
  /** The native microphone policy. Turning it on shows a trusted Windows confirmation; the result says what is in force. */
  setVoiceInput(on: boolean): Promise<{allowed: boolean; reason?: string}>;
  /** Types this reviewed text into the remembered window without asking Claude. Events arrive as a run, like ask(). */
  insertText(text: string): Promise<{runId: string}>;
  regionBegin(): Promise<{ok: true} | {ok: false; reason: string}>;
  regionDiscard(token: string): Promise<boolean>;
  overlayImage(): Promise<{dataUrl: string; width: number; height: number} | null>;
  overlaySubmit(rect: {x: number; y: number; width: number; height: number}): Promise<{ok: true} | {ok: false; reason: string}>;
  overlayCancel(): Promise<boolean>;
  onEvent(cb: (e: CompanionPush) => void): () => void;
}

export const companionApi = (): CompanionApi | null => (window as unknown as {companion?: CompanionApi}).companion ?? null;
export type {AgentEvent};
