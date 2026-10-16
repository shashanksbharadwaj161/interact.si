// Sandboxed preload for the companion island and its selection overlay: exposes window.companion with exactly the
// companion methods (see companionCore.ts) and one event subscription. Not the hub's window.jarvis, and no Node APIs.
import {contextBridge, ipcRenderer, type IpcRendererEvent} from 'electron';
import {COMPANION_EVENT_CHANNEL, companionChannel, type CompanionMethod} from './companionCore';

const call = <T>(method: CompanionMethod, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(companionChannel(method), ...args) as Promise<T>;

contextBridge.exposeInMainWorld('companion', {
  state: () => call('companionState'),
  ask: (text: string, token?: string) => (token === undefined ? call('companionAsk', text) : call('companionAsk', text, token)),
  cancel: () => call('companionCancel'),
  undo: (id: string) => call('companionUndo', id),
  layout: (l: {width: number; height: number; anchor: string; release?: boolean}) => call('companionLayout', l),
  openHub: (view: string, item?: string) => (item === undefined ? call('companionOpenHub', view) : call('companionOpenHub', view, item)),
  setMaterial: (m: 'none' | 'acrylic') => call('companionSetMaterial', m),
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
