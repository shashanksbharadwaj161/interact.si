// Sandboxed preload for the companion island and its selection overlay: exposes window.companion with exactly the
// companion methods (see companionCore.ts) and one event subscription. Not the hub's window.jarvis, and no Node APIs.
import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron';
import {COMPANION_EVENT_CHANNEL, companionChannel, type CompanionMethod} from './companionCore';

const call = <T>(method: CompanionMethod, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(companionChannel(method), ...args) as Promise<T>;

contextBridge.exposeInMainWorld('companion', {
  state: () => call('companionState'),
  ask: (text: string, token?: string, withTarget?: boolean) => (withTarget === undefined ? (token === undefined ? call('companionAsk', text) : call('companionAsk', text, token)) : call('companionAsk', text, token, withTarget)),
  cancel: () => call('companionCancel'),
  undo: (id: string) => call('companionUndo', id),
  layout: (l: {bubble: {width: number; height: number} | null}) => call('companionLayout', l),
  drag: (phase: 'start' | 'end') => call('companionDrag', phase),
  hit: (over: boolean) => call('companionHit', over),
  resize: (op: 'S' | 'M' | 'L' | 'grow' | 'shrink') => call('companionResize', op),
  dock: (target: 'bottom-left' | 'bottom-right' | 'left' | 'right' | 'top') => call('companionDock', target),
  gaze: (on: boolean) => call('companionGaze', on),
  setAppearance: (a: 'pet' | 'legacy-orb') => call('companionSetAppearance', a),
  clearTarget: () => call('companionClearTarget'),
  openHub: (view: string, item?: string) => (item === undefined ? call('companionOpenHub', view) : call('companionOpenHub', view, item)),
  setMaterial: (m: 'none' | 'acrylic') => call('companionSetMaterial', m),
  voiceStatus: () => call('companionVoiceStatus'),
  transcribe: (wav: number[]) => call('companionTranscribe', wav),
  transcribeCancel: () => call('companionTranscribeCancel'),
  speak: (text: string) => call('companionSpeak', text),
  speechStop: () => call('companionSpeechStop'),
  regionBegin: () => call('regionBegin'),
  regionDiscard: (token: string) => call('regionDiscard', token),
  overlayImage: () => call('overlayImage'),
  overlaySubmit: (rect: {x: number; y: number; width: number; height: number}) => call('overlaySubmit', rect),
  overlayCancel: () => call('overlayCancel'),
  onEvent: (cb: (e: unknown) => void) => {
    const fn = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(COMPANION_EVENT_CHANNEL, fn);
    return () => { ipcRenderer.removeListener(COMPANION_EVENT_CHANNEL, fn); };
  },
});
