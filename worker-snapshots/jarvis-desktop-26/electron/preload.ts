// Sandboxed preload: exposes exactly the typed JarvisAPI surface and nothing else. No logic, no Node APIs.
import {contextBridge, ipcRenderer} from 'electron';
import type {Activity, JarvisAPI} from '../src/shared/contracts';
import {ACTIVITY_CHANNEL, channel} from './channels';

const call = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel(method), ...args) as Promise<T>;

const api: JarvisAPI = {
  getState: () => call('getState'),
  saveSettings: (s) => call('saveSettings', s),
  getSystemInfo: () => call('getSystemInfo'),
  saveCapsule: (c) => call('saveCapsule', c),
  deleteCapsule: (id) => call('deleteCapsule', id),
  restoreCapsule: (id) => call('restoreCapsule', id),
  saveNote: (n) => call('saveNote', n),
  deleteNote: (id) => call('deleteNote', id),
  saveTask: (t) => call('saveTask', t),
  deleteTask: (id) => call('deleteTask', id),
  chat: (text) => call('chat', text),
  clearChat: () => call('clearChat'),
  setCloudKey: (key) => call('setCloudKey', key),
  cloudKeyStatus: () => call('cloudKeyStatus'),
  deleteCloudKey: () => call('deleteCloudKey'),
  previewAction: (a) => call('previewAction', a),
  executeAction: (id, approved) => call('executeAction', id, approved),
  speak: (text) => call('speak', text),
  transcribe: (audio) => call('transcribe', audio),
  exportData: () => call('exportData'),
  importData: () => call('importData'),
  pickPath: (kind) => call('pickPath', kind),
  onActivity: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const listener = (_e: unknown, a: Activity) => handler(a);
    ipcRenderer.on(ACTIVITY_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(ACTIVITY_CHANNEL, listener); };
  },
};

contextBridge.exposeInMainWorld('jarvis', api);
