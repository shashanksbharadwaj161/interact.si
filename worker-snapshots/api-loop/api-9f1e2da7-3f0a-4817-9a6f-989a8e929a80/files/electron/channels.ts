// IPC channel table shared by preload and main. No Electron imports: safe to bundle into the sandboxed preload.
export const METHODS = [
  'getState', 'saveSettings', 'getSystemInfo',
  'saveCapsule', 'deleteCapsule', 'restoreCapsule',
  'saveNote', 'deleteNote', 'saveTask', 'deleteTask',
  'chat', 'clearChat', 'setCloudKey', 'cloudKeyStatus', 'deleteCloudKey',
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
export const ACTIVITY_CHANNEL = 'jarvis:activity';
