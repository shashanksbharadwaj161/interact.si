// IPC channel table shared by preload and main. No Electron imports: safe to bundle into the sandboxed preload.
export const METHODS = [
  'getState', 'saveSettings', 'getSystemInfo',
  'saveCapsule', 'deleteCapsule', 'restoreCapsule',
  'saveNote', 'deleteNote', 'saveTask', 'deleteTask',
  'chat', 'clearChat', 'setCloudKey', 'cloudKeyStatus', 'deleteCloudKey',
  'previewAction', 'executeAction', 'speak', 'transcribe',
  'exportData', 'importData', 'pickPath',
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
};

export const channel = (m: string) => `jarvis:${m}`;
export const ACTIVITY_CHANNEL = 'jarvis:activity';
