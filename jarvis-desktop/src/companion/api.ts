// window.companion, exposed by electron/companionPreload.ts. Absent in a browser, where the page says so instead of failing.
import type {AgentEvent} from '../../electron/services/agent';

export type Readiness = {ready: true; model: string} | {ready: false; reason: string};
export type MaterialState = {requested: 'none' | 'acrylic'; applied: boolean; note: string};
export type Appearance = 'pet' | 'legacy-orb';
export type Dock = 'free' | 'bottom' | 'top' | 'left' | 'right';
export type DockTarget = 'bottom-left' | 'bottom-right' | 'left' | 'right' | 'top';
export type CompanionStatus = {readiness: Readiness; shortcut: string | null; material: MaterialState; platform: string; appearance: Appearance; size: number; dock: Dock};
export type Box = {x: number; y: number; width: number; height: number};
export type PlacementEvent = {type: 'placement'; window: Box; pet: Box; bubble: Box | null; side: 'left' | 'right' | 'above' | 'below' | null; size: number; dock: Dock};
export type RegionEvent = {type: 'region'; token: string; preview: string; width: number; height: number; sourceScale: number};
export type CompanionPush =
  | {type: 'invoke'}
  | {type: 'collapse'}
  | {type: 'region-cancelled'}
  | RegionEvent
  | PlacementEvent
  | {type: 'drag'; vx: number | null}
  | {type: 'gaze'; index: number | null}
  | {runId: string; event: AgentEvent};

export interface CompanionApi {
  state(): Promise<CompanionStatus>;
  ask(text: string, token?: string): Promise<{runId: string}>;
  cancel(): Promise<boolean>;
  undo(id: string): Promise<boolean>;
  layout(l: {bubble: {width: number; height: number} | null}): Promise<boolean>;
  drag(phase: 'start' | 'end'): Promise<{started: boolean} | {moved: boolean}>;
  hit(over: boolean): Promise<boolean>;
  resize(op: 'S' | 'M' | 'L' | 'grow' | 'shrink'): Promise<number>;
  dock(target: DockTarget): Promise<Dock>;
  gaze(on: boolean): Promise<boolean>;
  setAppearance(a: Appearance): Promise<Appearance>;
  openHub(view: 'home' | 'assistant' | 'notes' | 'tasks' | 'capsules' | 'search' | 'companion' | 'settings', item?: string): Promise<boolean>;
  setMaterial(m: 'none' | 'acrylic'): Promise<MaterialState>;
  regionBegin(): Promise<{ok: true} | {ok: false; reason: string}>;
  regionDiscard(token: string): Promise<boolean>;
  overlayImage(): Promise<{dataUrl: string; width: number; height: number} | null>;
  overlaySubmit(rect: {x: number; y: number; width: number; height: number}): Promise<{ok: true} | {ok: false; reason: string}>;
  overlayCancel(): Promise<boolean>;
  onEvent(cb: (e: CompanionPush) => void): () => void;
}

export const companionApi = (): CompanionApi | null => (window as unknown as {companion?: CompanionApi}).companion ?? null;
export type {AgentEvent};
