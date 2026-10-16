// window.companion, exposed by electron/companionPreload.ts. Absent in a browser, where the page says so instead of failing.
import type {AgentEvent} from '../../electron/services/agent';

export type Anchor = 'corner' | 'top' | 'right';
export type Readiness = {ready: true; model: string} | {ready: false; reason: string};
export type MaterialState = {requested: 'none' | 'acrylic'; applied: boolean; note: string};
export type CompanionStatus = {readiness: Readiness; anchor: Anchor; shortcut: string | null; material: MaterialState; platform: string};
export type RegionEvent = {type: 'region'; token: string; preview: string; width: number; height: number; sourceScale: number};
export type CompanionPush = {type: 'invoke'} | {type: 'collapse'} | {type: 'region-cancelled'} | RegionEvent | {runId: string; event: AgentEvent};

export interface CompanionApi {
  state(): Promise<CompanionStatus>;
  ask(text: string, token?: string): Promise<{runId: string}>;
  cancel(): Promise<boolean>;
  undo(id: string): Promise<boolean>;
  layout(l: {width: number; height: number; anchor: Anchor; release?: boolean}): Promise<boolean>;
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
