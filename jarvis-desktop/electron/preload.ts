// Sandboxed preload: exposes exactly the typed JarvisAPI surface (window.jarvis) plus the read-only HostBatteryAPI
// (window.jarvisHost) and nothing else. No Node APIs.
import {contextBridge, ipcRenderer} from 'electron';
import type {Activity, FullJarvisAPI} from '../src/shared/contracts';
import {ACTIVITY_CHANNEL, HOST_BATTERY_EVENT, channel} from './channels';
import {createHostBatteryApi, productivityBridge, subscribeChatStream} from '../src/ui/bridges';

const call = <T>(method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel(method), ...args) as Promise<T>;

const flat: Omit<FullJarvisAPI, 'productivity'> = {
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
  speechStop: () => call('speechStop'),
  transcribeCancel: () => call('transcribeCancel'),
  exportData: () => call('exportData'),
  importData: () => call('importData'),
  pickPath: (kind) => call('pickPath', kind),
  getApiInfo: () => call('getApiInfo'),
  // Per-provider cloud keys: only a provider id and (for set) the key go in; only booleans and provider metadata come back.
  cloudProviderStatus: () => call('cloudProviderStatus'),
  setProviderKey: (provider, key) => call('setProviderKey', provider, key),
  cloudModels: (provider) => call('cloudModels', provider),
  clearProviderKey: (provider) => call('clearProviderKey', provider),
  // Optional arguments are forwarded only when given, so the main-process arity/shape check sees exactly what the caller passed.
  planIntent: (command, options) => (options === undefined ? call('planIntent', command) : call('planIntent', command, options)),
  search: (query, options) => (options === undefined ? call('search', query) : call('search', query, options)),
  listLocalModels: () => call('listLocalModels'),
  // v2.1 captain integration. Optional trailing arguments are forwarded only when given (arity check in main).
  routinesList: () => call('routinesList'), routinesSave: (d) => call('routinesSave', d), routinesRemove: (id) => call('routinesRemove', id), routinesStart: (id) => call('routinesStart', id),
  routinesCancel: (id) => call('routinesCancel', id), routinesPauseAll: () => call('routinesPauseAll'), routinesResumeAll: () => call('routinesResumeAll'), routinesUndo: (id) => call('routinesUndo', id),
  routinesPlanText: (t) => call('routinesPlanText', t), routinesPlanModel: (j) => call('routinesPlanModel', j),
  modelsOverview: () => call('modelsOverview'), modelsSelect: (n, o) => (o === undefined ? call('modelsSelect', n) : call('modelsSelect', n, o)), modelsUnload: (n) => (n === undefined ? call('modelsUnload') : call('modelsUnload', n)),
  modelsSetProfile: (id) => call('modelsSetProfile', id), modelsValidatePack: (d) => call('modelsValidatePack', d), modelsStartImport: (d, n) => (n === undefined ? call('modelsStartImport', d) : call('modelsStartImport', d, n)),
  modelsStartPull: (m) => call('modelsStartPull', m), modelsCancelJob: (id) => call('modelsCancelJob', id), modelsPickPackFolder: () => call('modelsPickPackFolder'),
  integrationsList: () => call('integrationsList'), integrationsPreview: (id) => call('integrationsPreview', id), integrationsCheck: (id) => call('integrationsCheck', id), integrationsSetKey: (id, k) => call('integrationsSetKey', id, k),
  integrationsRemoveKey: (id) => call('integrationsRemoveKey', id), integrationsSetEnabled: (id, on) => call('integrationsSetEnabled', id, on), integrationsUsage: () => call('integrationsUsage'), integrationsClearUsage: () => call('integrationsClearUsage'),
  usageReport: () => call('usageReport'), usageExport: (f) => call('usageExport', f), usageSetPrices: (i) => call('usageSetPrices', i), usageSetBudget: (i) => call('usageSetBudget', i),
  clipboardStatus: () => call('clipboardStatus'), clipboardSetEnabled: (on) => call('clipboardSetEnabled', on), clipboardList: () => call('clipboardList'), clipboardGet: (id) => call('clipboardGet', id), clipboardRemove: (id) => call('clipboardRemove', id), clipboardPurge: () => call('clipboardPurge'),
  systemResources: () => call('systemResources'),
  // v2.2 data API. Paths for packs and calendars are chosen in main-process dialogs and never cross this bridge.
  productivityGet: () => call('productivityGet'), productivityApply: (op) => call('productivityApply', op), productivityForgetHistory: (o) => call('productivityForgetHistory', o), productivitySignals: () => call('productivitySignals'),
  capsulePreviewRestore: (id) => call('capsulePreviewRestore', id), capsuleListWindows: () => call('capsuleListWindows'), capsuleCaptureGeometry: (id, h) => call('capsuleCaptureGeometry', id, h),
  capsuleExportPack: (id, r) => call('capsuleExportPack', id, r), capsuleReadPack: () => call('capsuleReadPack'), capsuleParsePack: (raw, m) => call('capsuleParsePack', raw, m),
  calendarList: () => call('calendarList'), calendarImportText: (t) => call('calendarImportText', t), calendarImportFile: () => call('calendarImportFile'), calendarExport: () => call('calendarExport'), calendarClear: () => call('calendarClear'),
  ocrStatus: () => call('ocrStatus'), ocrRecognize: (o) => o === undefined ? call('ocrRecognize') : call('ocrRecognize', o), ocrCancel: () => call('ocrCancel'),
  // v2.3 streaming chat. onChatStream long-polls chatStreamRead for exactly one stream; the id is a capability only the starter holds.
  chatStreamStart: (text) => call('chatStreamStart', text),
  chatStreamRead: (id, cursor) => call('chatStreamRead', id, cursor),
  chatStreamCancel: (id) => call('chatStreamCancel', id),
  // v2.4 approved documents: the main process opens the dialog; only a token and plain-text preview come back.
  documentsChoose: () => call('documentsChoose'),
  documentsSave: (token, o) => o === undefined ? call('documentsSave', token) : call('documentsSave', token, o),
  documentsDiscard: (token) => call('documentsDiscard', token),
  onChatStream: (start, handler) => subscribeChatStream((id, cursor) => call('chatStreamRead', id, cursor), start, handler),
  onActivity: (handler) => {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    const listener = (_e: unknown, a: Activity) => handler(a);
    ipcRenderer.on(ACTIVITY_CHANNEL, listener);
    return () => { ipcRenderer.removeListener(ACTIVITY_CHANNEL, listener); };
  },
};

// Nested namespace read by src/ui/store.tsx; every member is one of the flat calls above.
const productivity = productivityBridge(flat);
if (!productivity) throw new Error('Productivity bridge is incomplete');
// v2.6 provider readiness. Typed locally until FullJarvisAPI carries these two methods (shared contract, Codex).
const providerTest = {
  providerConnectionTest: (provider: string) => call('providerConnectionTest', provider),
  providerConnectionTestCancel: (): Promise<boolean> => call('providerConnectionTestCancel'),
  accountsStatus: (provider: string) => call('accountsStatus', provider),
  accountsConnect: (provider: string) => call('accountsConnect', provider),
  accountsCancel: (): Promise<boolean> => call('accountsCancel'),
  accountsDisconnect: (provider: string) => call('accountsDisconnect', provider),
};
const api: FullJarvisAPI & typeof providerTest = {...flat, productivity, ...providerTest};

contextBridge.exposeInMainWorld('jarvis', api);

// Read-only host power state, kept apart from the backend method table. Main pushes it (trusted page only); nothing is
// ever sent from here. The latest valid value is cached so the renderer can read it at any time.
const jarvisHost = createHostBatteryApi((listener) => {
  const l = (_e: unknown, s: unknown) => listener(s);
  ipcRenderer.on(HOST_BATTERY_EVENT, l);
  return () => { ipcRenderer.removeListener(HOST_BATTERY_EVENT, l); };
});
contextBridge.exposeInMainWorld('jarvisHost', jarvisHost);
