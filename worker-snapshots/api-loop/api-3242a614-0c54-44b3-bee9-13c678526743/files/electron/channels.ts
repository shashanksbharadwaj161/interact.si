// IPC channel table shared by preload and main. No Electron imports: safe to bundle into the sandboxed preload.
export const METHODS = [
  'getState', 'saveSettings', 'getSystemInfo',
  'saveCapsule', 'deleteCapsule', 'restoreCapsule',
  'saveNote', 'deleteNote', 'saveTask', 'deleteTask',
  'chat', 'clearChat', 'setCloudKey', 'cloudKeyStatus', 'deleteCloudKey',
  'cloudProviderStatus', 'setProviderKey', 'clearProviderKey',
  'previewAction', 'executeAction', 'speak', 'transcribe',
  'exportData', 'importData', 'pickPath',
  // API v2
  'getApiInfo', 'planIntent', 'search', 'listLocalModels',
  // v2.1 captain integration: routines, model runtime, integrations, usage ledger, clipboard history, resources
  'routinesList', 'routinesSave', 'routinesRemove', 'routinesStart', 'routinesCancel', 'routinesPauseAll', 'routinesResumeAll', 'routinesUndo', 'routinesPlanText', 'routinesPlanModel',
  'modelsOverview', 'modelsSelect', 'modelsUnload', 'modelsSetProfile', 'modelsValidatePack', 'modelsStartImport', 'modelsStartPull', 'modelsCancelJob', 'modelsPickPackFolder',
  'integrationsList', 'integrationsPreview', 'integrationsCheck', 'integrationsSetKey', 'integrationsRemoveKey', 'integrationsSetEnabled', 'integrationsUsage', 'integrationsClearUsage',
  'usageReport', 'usageExport', 'usageSetPrices', 'usageSetBudget',
  'clipboardStatus', 'clipboardSetEnabled', 'clipboardList', 'clipboardGet', 'clipboardRemove', 'clipboardPurge',
  'systemResources',
  // v2.2 data API: productivity sidecar, capsule restore preview/packs, history forgetting, local .ics calendar
  'productivityGet', 'productivityApply', 'productivityForgetHistory', 'productivitySignals',
  'capsulePreviewRestore', 'capsuleListWindows', 'capsuleCaptureGeometry', 'capsuleExportPack', 'capsuleReadPack', 'capsuleParsePack',
  'calendarList', 'calendarImportText', 'calendarImportFile', 'calendarExport', 'calendarClear',
  'ocrStatus', 'ocrRecognize', 'ocrCancel',
  // v2.3 streaming chat: start, long-poll read (events reach only the invoking caller) and cancel.
  'chatStreamStart', 'chatStreamRead', 'chatStreamCancel',
  // v2.4 approved documents: main-process dialog, token-held preview, save as note only after review.
  'documentsChoose', 'documentsSave', 'documentsDiscard',
] as const;

export type MethodName = (typeof METHODS)[number];

/** Maximum number of arguments each method accepts. */
export const ARITY: Record<MethodName, number> = {
  getState: 0, saveSettings: 1, getSystemInfo: 0,
  saveCapsule: 1, deleteCapsule: 1, restoreCapsule: 1,
  saveNote: 1, deleteNote: 1, saveTask: 1, deleteTask: 1,
  chat: 1, clearChat: 0, setCloudKey: 1, cloudKeyStatus: 0, deleteCloudKey: 0,
  cloudProviderStatus: 0, setProviderKey: 2, clearProviderKey: 1,
  previewAction: 1, executeAction: 2, speak: 1, transcribe: 1,
  exportData: 0, importData: 0, pickPath: 1,
  getApiInfo: 0, planIntent: 2, search: 2, listLocalModels: 0,
  routinesList: 0, routinesSave: 1, routinesRemove: 1, routinesStart: 1, routinesCancel: 1, routinesPauseAll: 0, routinesResumeAll: 0, routinesUndo: 1, routinesPlanText: 1, routinesPlanModel: 1,
  modelsOverview: 0, modelsSelect: 2, modelsUnload: 1, modelsSetProfile: 1, modelsValidatePack: 1, modelsStartImport: 2, modelsStartPull: 1, modelsCancelJob: 1, modelsPickPackFolder: 0,
  integrationsList: 0, integrationsPreview: 1, integrationsCheck: 1, integrationsSetKey: 2, integrationsRemoveKey: 1, integrationsSetEnabled: 2, integrationsUsage: 0, integrationsClearUsage: 0,
  usageReport: 0, usageExport: 1, usageSetPrices: 1, usageSetBudget: 1,
  clipboardStatus: 0, clipboardSetEnabled: 1, clipboardList: 0, clipboardGet: 1, clipboardRemove: 1, clipboardPurge: 0,
  systemResources: 0,
  productivityGet: 0, productivityApply: 1, productivityForgetHistory: 1, productivitySignals: 0,
  capsulePreviewRestore: 1, capsuleListWindows: 0, capsuleCaptureGeometry: 2, capsuleExportPack: 2, capsuleReadPack: 0, capsuleParsePack: 2,
  ocrStatus: 0, ocrRecognize: 1, ocrCancel: 0,
  calendarList: 0, calendarImportText: 1, calendarImportFile: 0, calendarExport: 0, calendarClear: 0,
  chatStreamStart: 1, chatStreamRead: 2, chatStreamCancel: 1,
  documentsChoose: 0, documentsSave: 2, documentsDiscard: 1,
};

export const channel = (m: string) => `jarvis:${m}`;

/**
 * Subset of the authoritative METHODS table for provider key validation and clients.
 * Registration and sender checks use the same dispatch path as every other method.
 */
export const PROVIDER_KEY_METHODS = ['cloudProviderStatus', 'setProviderKey', 'clearProviderKey'] as const;
export type ProviderKeyMethod = (typeof PROVIDER_KEY_METHODS)[number];
export const PROVIDER_KEY_ARITY: Record<ProviderKeyMethod, number> = {cloudProviderStatus: 0, setProviderKey: 2, clearProviderKey: 1};
export const CLOUD_PROVIDER_IDS = ['anthropic', 'openai', 'openrouter'] as const;
const MAX_KEY_ARG = 4096;

/** Returns a user-safe problem for the arguments of a provider key call, or null when they are acceptable. Never echoes a key. */
export function providerKeyArgsProblem(method: string, args: readonly unknown[]): string | null {
  if (!(PROVIDER_KEY_METHODS as readonly string[]).includes(method)) return 'Unknown method';
  const m = method as ProviderKeyMethod;
  if (!Array.isArray(args) || args.length !== PROVIDER_KEY_ARITY[m]) return 'Wrong number of arguments';
  if (m === 'cloudProviderStatus') return null;
  if (typeof args[0] !== 'string' || !(CLOUD_PROVIDER_IDS as readonly string[]).includes(args[0])) return `Invalid argument 1 for ${m}: expected one of ${CLOUD_PROVIDER_IDS.join(', ')}`;
  if (m === 'setProviderKey' && (typeof args[1] !== 'string' || args[1].length < 1 || args[1].length > MAX_KEY_ARG)) return `Invalid argument 2 for ${m}: expected a key of 1 to ${MAX_KEY_ARG} characters`;
  return null;
}
export const ACTIVITY_CHANNEL = 'jarvis:activity';
/**
 * Main -> renderer push of host power state (Electron powerMonitor): sent after the trusted app page loads and on every
 * 'on-battery'/'on-ac' change, only to pages that pass isTrustedUrl. Not a METHOD: the renderer never sends on it.
 */
export const HOST_BATTERY_EVENT = 'jarvis:hostBatteryChanged';

/**
 * Model pinning channels (goals 17-19). Kept outside METHODS, like the host battery channel, so the backend method table
 * is unchanged: ipc.ts registers them with the same trusted-sender check and modelPinArgsProblem below, and the preload
 * exposes them as window.jarvisModelPins. The main process re-validates the name (validation.ts validatePinModelName).
 */
export const MODEL_PIN_METHODS = ['modelsPin', 'modelsUnpin', 'modelsPins'] as const;
export type ModelPinMethod = (typeof MODEL_PIN_METHODS)[number];
export const MODEL_PIN_ARITY: Record<ModelPinMethod, number> = {modelsPin: 1, modelsUnpin: 1, modelsPins: 0};
export const modelPinChannel = (m: ModelPinMethod) => `jarvis:${m}`;
const MAX_PIN_NAME = 200;

/** Returns a user-safe problem for a model pin call's arguments, or null when the shape is acceptable. */
export function modelPinArgsProblem(method: string, args: readonly unknown[]): string | null {
  if (!(MODEL_PIN_METHODS as readonly string[]).includes(method)) return 'Unknown method';
  const m = method as ModelPinMethod;
  if (!Array.isArray(args) || args.length !== MODEL_PIN_ARITY[m]) return 'Wrong number of arguments';
  if (m === 'modelsPins') return null;
  if (typeof args[0] !== 'string' || args[0].length < 1 || args[0].length > MAX_PIN_NAME) return `Invalid argument 1 for ${m}: expected a model name of 1 to ${MAX_PIN_NAME} characters`;
  return null;
}
