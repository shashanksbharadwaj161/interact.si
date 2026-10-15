// Captain integration glue: adapts the flat, validated IPC methods on window.jarvis to the object-shaped
// client interfaces the module views expect. Every builder returns null when the backend (or the browser
// preview bridge) does not expose the methods, so views can say "not connected" instead of pretending.
import type { ModelPin, ModelPinsAPI, PinActionResult, PinListResult, PinVerifyResult } from '../shared/contracts';
import type { ApprovedDocumentPreview, ApprovedDocumentSaveOptions, CalendarImportSummary, HostBatteryAPI, HostBatteryStatus, ChatMessage, ChatStreamBatch, ChatStreamEvent, ChatStreamOutcome, ChatStreamStart, JarvisAPI, ProductivityNamespace, UsageSummary } from '../shared/contracts';
import type { RoutinesApi } from '../../electron/services/routines';
import type { ModelsClient } from '../../electron/services/models';
import type { IntegrationsBridge } from './integration-catalog';
import type { Price, Budget } from '../../electron/services/usage';
import type { ClipboardStatus, ClipboardEntryView } from '../../electron/services/clipboard';
import type { ResourceSnapshot } from '../../electron/services/system';
import type { CalendarEvent } from '../../electron/services/calendar';

type Api = Partial<JarvisAPI>;

const has = (api: Api, names: readonly (keyof JarvisAPI)[]): boolean => names.every((n) => typeof api[n] === 'function');

export const ROUTINE_METHODS = ['routinesList', 'routinesSave', 'routinesRemove', 'routinesStart', 'routinesCancel', 'routinesPauseAll', 'routinesResumeAll', 'routinesUndo', 'routinesPlanText', 'routinesPlanModel'] as const;
export const MODEL_METHODS = ['modelsOverview', 'modelsSelect', 'modelsUnload', 'modelsSetProfile', 'modelsValidatePack', 'modelsStartImport', 'modelsStartPull', 'modelsCancelJob'] as const;
export const INTEGRATION_BRIDGE_METHODS = ['integrationsList', 'integrationsPreview', 'integrationsCheck', 'integrationsSetKey', 'integrationsRemoveKey', 'integrationsSetEnabled', 'integrationsUsage', 'integrationsClearUsage'] as const;
export const USAGE_METHODS = ['usageReport', 'usageExport', 'usageSetPrices', 'usageSetBudget'] as const;
export const CLIPBOARD_METHODS = ['clipboardStatus', 'clipboardSetEnabled', 'clipboardList', 'clipboardGet', 'clipboardRemove', 'clipboardPurge'] as const;
export const PRODUCTIVITY_METHODS = ['productivityGet', 'productivityApply', 'productivityForgetHistory', 'productivitySignals', 'capsulePreviewRestore', 'capsuleListWindows', 'capsuleCaptureGeometry', 'capsuleExportPack', 'capsuleReadPack', 'capsuleParsePack'] as const;
export const CALENDAR_METHODS = ['calendarList', 'calendarImportText', 'calendarClear'] as const;

/** Local usage ledger. report() matches UsagePanel's report/performance props. */
export interface UsageClient {
  report(): Promise<UsageSummary>;
  exportAs(format: 'csv' | 'json'): Promise<{ path: string | null; rows: number; truncated: boolean }>;
  setPrices(prices: unknown): Promise<Price[]>;
  setBudget(budget: unknown): Promise<Budget | null>;
}

/** Opt-in clipboard history. Turning it on shows a native confirmation in the main process. */
export interface ClipboardClient {
  status(): Promise<ClipboardStatus>;
  setEnabled(on: boolean): Promise<ClipboardStatus>;
  list(): Promise<ClipboardEntryView[]>;
  get(id: string): Promise<string | null>;
  remove(id: string): Promise<boolean>;
  purge(): Promise<ClipboardStatus>;
}

/**
 * Local .ics calendar. list/importIcs/clear match the CalendarClient in src/components/Calendar.tsx; the main process
 * re-parses imported text, so a renderer preview is never trusted for storage. importFile/exportIcs use main-process
 * dialogs and never expose a file path.
 */
export interface CalendarBridge {
  list(): Promise<CalendarEvent[]>;
  importIcs(text: string): Promise<CalendarImportSummary>;
  clear(): Promise<void>;
  importFile?(): Promise<CalendarImportSummary & { imported: boolean }>;
  exportIcs?(): Promise<{ saved: boolean; events: number }>;
}

export function routinesBridge(api: Api): RoutinesApi | null {
  if (!has(api, ROUTINE_METHODS)) return null;
  return {
    list: () => api.routinesList!(),
    save: (draft) => api.routinesSave!(draft),
    remove: (id) => api.routinesRemove!(id),
    start: (id) => api.routinesStart!(id),
    cancel: (runId) => api.routinesCancel!(runId),
    pauseAll: () => api.routinesPauseAll!(),
    resumeAll: () => api.routinesResumeAll!(),
    undo: (runId) => api.routinesUndo!(runId),
    planText: (text) => api.routinesPlanText!(text),
    planModel: (json) => api.routinesPlanModel!(json),
  };
}

export function modelsBridge(api: Api): ModelsClient | null {
  if (!has(api, MODEL_METHODS)) return null;
  const client: ModelsClient = {
    overview: () => api.modelsOverview!(),
    select: (name, opts) => (opts === undefined ? api.modelsSelect!(name) : api.modelsSelect!(name, opts)),
    unload: (name) => (name === undefined ? api.modelsUnload!() : api.modelsUnload!(name)),
    setProfile: (id) => api.modelsSetProfile!(id),
    validatePack: (dir) => api.modelsValidatePack!(dir),
    startImport: (dir, name) => (name === undefined ? api.modelsStartImport!(dir) : api.modelsStartImport!(dir, name)),
    startPull: (model) => api.modelsStartPull!(model),
    cancelJob: (id) => api.modelsCancelJob!(id),
  };
  if (typeof api.modelsPickPackFolder === 'function') client.pickPackFolder = () => api.modelsPickPackFolder!();
  return client;
}

export function integrationsBridge(api: Api): IntegrationsBridge | null {
  if (!has(api, INTEGRATION_BRIDGE_METHODS)) return null;
  return {
    list: () => api.integrationsList!(),
    preview: (id) => api.integrationsPreview!(id),
    check: (id) => api.integrationsCheck!(id),
    setKey: (id, key) => api.integrationsSetKey!(id, key),
    removeKey: (id) => api.integrationsRemoveKey!(id),
    setEnabled: (id, on) => api.integrationsSetEnabled!(id, on),
    usage: () => api.integrationsUsage!(),
    clearUsage: () => api.integrationsClearUsage!(),
  };
}

export function usageBridge(api: Api): UsageClient | null {
  if (!has(api, USAGE_METHODS)) return null;
  return {
    report: () => api.usageReport!(),
    exportAs: (format) => api.usageExport!(format),
    setPrices: (prices) => api.usageSetPrices!({ prices }),
    setBudget: (budget) => api.usageSetBudget!({ budget }),
  };
}

export function clipboardBridge(api: Api): ClipboardClient | null {
  if (!has(api, CLIPBOARD_METHODS)) return null;
  return {
    status: () => api.clipboardStatus!(),
    setEnabled: (on) => api.clipboardSetEnabled!(on),
    list: () => api.clipboardList!(),
    get: (id) => api.clipboardGet!(id),
    remove: (id) => api.clipboardRemove!(id),
    purge: () => api.clipboardPurge!(),
  };
}

export function resourcesBridge(api: Api): (() => Promise<ResourceSnapshot>) | null {
  return typeof api.systemResources === 'function' ? () => api.systemResources!() : null;
}

/** Read-only host power state (Electron powerMonitor). subscribe is present only when the backend pushes on-battery/on-ac changes. */
export interface HostBatteryBridge {
  read(): Promise<HostBatteryStatus>;
  subscribe?(handler: (status: HostBatteryStatus) => void): () => void;
}

/** Adapts window.jarvisHost. Null when it is absent (browser preview, older preload), so the UI can fall back to unmeasured. */
export function hostBatteryBridge(api: Partial<HostBatteryAPI> | null | undefined): HostBatteryBridge | null {
  if (!api || typeof api.hostBattery !== 'function') return null;
  const bridge: HostBatteryBridge = { read: () => api.hostBattery!() };
  if (typeof api.onHostBattery === 'function') bridge.subscribe = (handler) => api.onHostBattery!(handler);
  return bridge;
}

/** Validates one pushed host status. Anything malformed is dropped rather than shown. */
export function parseHostBatteryStatus(v: unknown): HostBatteryStatus | null {
  if (!isRecord(v) || typeof v.measuredAt !== 'string' || v.measuredAt.length > 40 || !Number.isFinite(Date.parse(v.measuredAt))) return null;
  if (v.source === 'host' && typeof v.onBattery === 'boolean') return { source: 'host', onBattery: v.onBattery, measuredAt: v.measuredAt };
  if (v.source === 'unmeasured' && v.onBattery === null) return { source: 'unmeasured', onBattery: null, measuredAt: v.measuredAt };
  return null;
}

/**
 * Builds window.jarvisHost in the preload from a raw subscription to the main-process push channel. Keeps the latest valid
 * status (unmeasured until the first push), forwards valid changes to subscribers, and never sends anything to main.
 */
export function createHostBatteryApi(listen: (listener: (raw: unknown) => void) => () => void, now: () => number = Date.now): Required<HostBatteryAPI> {
  let latest: HostBatteryStatus | null = null;
  const handlers = new Set<(s: HostBatteryStatus) => void>();
  listen((raw) => {
    const s = parseHostBatteryStatus(raw);
    if (!s) return;
    latest = s;
    for (const h of [...handlers]) { try { h({ ...s }); } catch { /* a broken view must not stop the others */ } }
  });
  return {
    hostBattery: async () => (latest ? { ...latest } : { source: 'unmeasured', onBattery: null, measuredAt: new Date(now()).toISOString() }),
    onHostBattery: (handler) => {
      if (typeof handler !== 'function') throw new TypeError('handler must be a function');
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
}

/** The Battery Status API object shape (BatteryManager) that the renderer may read. */
export interface BrowserBatteryManagerLike {
  charging: unknown;
  level: unknown;
}

/**
 * Wraps navigator.getBattery (passed in, never looked up here) as a labelled reader for resolveBatteryStatus in
 * src/ui/resource-policy.ts. Returns null when the API is absent, which is common in Electron builds.
 */
export function navigatorBatteryReader(getBattery: unknown, thisArg?: unknown): (() => Promise<{ source: 'navigator'; charging: unknown; level: unknown }>) | null {
  if (typeof getBattery !== 'function') return null;
  return async () => {
    const b = (await (getBattery as () => Promise<BrowserBatteryManagerLike>).call(thisArg)) as BrowserBatteryManagerLike | null;
    if (!b || typeof b !== 'object') throw new Error('No battery manager');
    return { source: 'navigator', charging: b.charging, level: b.level };
  };
}

/** window.jarvis.productivity, built from the flat validated IPC methods. The preload uses this, so the shapes cannot drift. */
export function productivityBridge(api: Api): ProductivityNamespace | null {
  if (!has(api, PRODUCTIVITY_METHODS)) return null;
  return {
    get: () => api.productivityGet!(),
    apply: (op) => api.productivityApply!(op),
    forgetHistory: (opts) => api.productivityForgetHistory!(opts),
    capsule: {
      previewRestore: (id) => api.capsulePreviewRestore!(id),
      listWindows: () => api.capsuleListWindows!(),
      captureGeometry: (id, hwnds) => api.capsuleCaptureGeometry!(id, hwnds),
      exportPack: (id, roots) => api.capsuleExportPack!(id, roots),
      readPack: () => api.capsuleReadPack!(),
      parsePack: (raw, mappings) => api.capsuleParsePack!(raw, mappings),
    },
    signals: () => api.productivitySignals!(),
  };
}

export function calendarBridge(api: Api): CalendarBridge | null {
  if (!has(api, CALENDAR_METHODS)) return null;
  const client: CalendarBridge = {
    list: () => api.calendarList!(),
    importIcs: (text) => api.calendarImportText!(text),
    clear: async () => { await api.calendarClear!(); },
  };
  if (typeof api.calendarImportFile === 'function') client.importFile = () => api.calendarImportFile!();
  if (typeof api.calendarExport === 'function') client.exportIcs = () => api.calendarExport!();
  return client;
}

/** Approved documents (writing workspace). The renderer never supplies or sees a path: the main process opens the dialog. */
export const DOCUMENT_METHODS = ['documentsChoose', 'documentsSave', 'documentsDiscard'] as const;
export type DocumentsBridge = {
  /** Opens the main-process dialog. 'ready' text is untrusted: render it as plain text only. */
  choose(): Promise<ApprovedDocumentPreview>;
  /** Stores the reviewed preview as a new note (default tag "imported"); the token is then spent. */
  saveAsNote(token: string, options?: ApprovedDocumentSaveOptions): Promise<{ saved: true; title: string }>;
  discard(token: string): Promise<boolean>;
};
export function documentsBridge(api: Api): DocumentsBridge | null {
  if (!has(api, DOCUMENT_METHODS)) return null;
  return {
    choose: () => api.documentsChoose!(),
    saveAsNote: (token, options) => (options === undefined ? api.documentsSave!(token) : api.documentsSave!(token, options)),
    discard: (token) => api.documentsDiscard!(token),
  };
}

/**
 * Model version pins (window.jarvisModelPins). The renderer never sends or sees a file path: the main process hashes only
 * model files it already knows. Optional trailing arguments are forwarded only when given (arity check in main).
 */
// Member names of window.jarvisModelPins (not IPC method names, so deliberately not a *_METHODS list).
export const MODEL_PIN_API_KEYS = ['list', 'pinCurrent', 'unpin', 'verify', 'cancelVerify', 'acknowledgeRepin'] as const;
export type ModelPinsClient = ModelPinsAPI;

/** Builds window.jarvisModelPins in the preload from an invoke function for the `jarvis:modelPins*` channels. */
export function createModelPinsApi(invoke: (method: string, ...args: unknown[]) => Promise<unknown>): ModelPinsAPI {
  return {
    list: () => invoke('modelPinsList') as Promise<ModelPin[]>,
    pinCurrent: (modelId, label) => (label === undefined ? invoke('modelPinsPinCurrent', modelId) : invoke('modelPinsPinCurrent', modelId, label)) as Promise<PinActionResult>,
    unpin: (modelId) => invoke('modelPinsUnpin', modelId) as Promise<PinListResult>,
    verify: (modelId) => invoke('modelPinsVerify', modelId) as Promise<PinVerifyResult>,
    cancelVerify: (modelId) => (modelId === undefined ? invoke('modelPinsCancelVerify') : invoke('modelPinsCancelVerify', modelId)) as Promise<boolean>,
    acknowledgeRepin: (modelId) => invoke('modelPinsAcknowledgeRepin', modelId) as Promise<PinActionResult>,
  };
}

/** Adapts window.jarvisModelPins. Null when it is absent or incomplete (browser preview, older preload). */
export function modelPinsBridge(api: Partial<ModelPinsAPI> | null | undefined): ModelPinsClient | null {
  if (!api || !MODEL_PIN_API_KEYS.every((n) => typeof api[n] === 'function')) return null;
  return {
    list: () => api.list!(),
    pinCurrent: (modelId, label) => (label === undefined ? api.pinCurrent!(modelId) : api.pinCurrent!(modelId, label)),
    unpin: (modelId) => api.unpin!(modelId),
    verify: (modelId) => api.verify!(modelId),
    cancelVerify: (modelId) => (modelId === undefined ? api.cancelVerify!() : api.cancelVerify!(modelId)),
    acknowledgeRepin: (modelId) => api.acknowledgeRepin!(modelId),
  };
}

/** OCR never accepts a path or hands recognized text to desktop actions. */
export function ocrBridge(api: Api) {
  if (!has(api, ['ocrStatus', 'ocrRecognize', 'ocrCancel'])) return null;
  return {status: () => api.ocrStatus!(), chooseAndRecognize: (options?: {language?: string}) => api.ocrRecognize!(options), cancel: () => api.ocrCancel!()};
}

// ---------- Streaming chat subscription (used by the preload; no Electron import) ----------

export const STREAM_SUBSCRIPTION = {
  /** Consecutive failed reads tolerated before the subscription reports 'lost'. */
  maxFailures: 3,
  retryMs: 500,
  /** Matches CHAT_STREAM_LIMITS.eventChars in main; a larger delta is a protocol violation. */
  maxDeltaChars: 16_384,
} as const;

const OUTCOMES: readonly ChatStreamOutcome[] = ['complete', 'truncated', 'cancelled', 'incomplete', 'failed'];
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isMessage = (v: unknown): v is ChatMessage => isRecord(v) && typeof v.id === 'string' && typeof v.text === 'string' && (v.role === 'user' || v.role === 'assistant') && (v.source === 'local' || v.source === 'cloud' || v.source === 'system');

/** Checks one event from main against the subscribed stream. Returns a reason when it is unsafe, null when valid. */
export function streamEventProblem(ev: unknown, start: ChatStreamStart): string | null {
  if (!isRecord(ev)) return 'malformed event';
  if (ev.streamId !== start.streamId || ev.generation !== start.generation) return 'event belongs to another stream';
  if (typeof ev.seq !== 'number' || !Number.isSafeInteger(ev.seq) || ev.seq < 0) return 'malformed sequence number';
  switch (ev.type) {
    case 'status': return ev.status === 'connecting' || ev.status === 'streaming' ? null : 'malformed status';
    case 'delta': return typeof ev.text === 'string' && ev.text.length > 0 && ev.text.length <= STREAM_SUBSCRIPTION.maxDeltaChars ? null : 'malformed delta';
    case 'done': return OUTCOMES.includes(ev.outcome as ChatStreamOutcome) && isMessage(ev.reply) && Array.isArray(ev.stored) && ev.stored.length <= 3 && ev.stored.every(isMessage) ? null : 'malformed final event';
    default: return 'unknown event type';
  }
}

type Wait = (ms: number) => Promise<void>;
const realWait: Wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Delivers one stream's events, in order and exactly once, by long-polling read(). Events for another stream or
 * generation, out-of-order sequences and malformed payloads end the subscription with a 'lost' event; duplicates from a
 * retried read are skipped. After 'done' or 'lost' nothing more is delivered. The returned function unsubscribes.
 */
export function subscribeChatStream(read: (streamId: string, cursor: number) => Promise<ChatStreamBatch>, start: ChatStreamStart, handler: (event: ChatStreamEvent) => void, wait: Wait = realWait): () => void {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  if (!isRecord(start) || typeof start.streamId !== 'string' || typeof start.generation !== 'number') throw new TypeError('start must come from chatStreamStart');
  const {streamId, generation} = start;
  let active = true, cursor = 0, expected = 0, failures = 0;
  const emit = (ev: ChatStreamEvent) => { if (!active) return; if (ev.type === 'done' || ev.type === 'lost') active = false; try { handler(ev); } catch { /* a broken view must not stop delivery bookkeeping */ } };
  const lose = (reason: string) => emit({type: 'lost', streamId, generation, seq: expected, reason});
  void (async () => {
    while (active) {
      let batch: ChatStreamBatch;
      try {
        batch = await read(streamId, cursor);
        failures = 0;
      } catch (e) {
        if (!active) return;
        if (++failures >= STREAM_SUBSCRIPTION.maxFailures) { lose(e instanceof Error ? e.message.slice(0, 200) : 'The reply stream stopped answering'); return; }
        await wait(STREAM_SUBSCRIPTION.retryMs);
        continue;
      }
      if (!active) return;
      if (!isRecord(batch) || !Array.isArray(batch.events) || typeof batch.next !== 'number' || !Number.isSafeInteger(batch.next) || batch.next < cursor) { lose('malformed stream batch'); return; }
      for (const ev of batch.events) {
        const problem = streamEventProblem(ev, start);
        if (problem) { lose(problem); return; }
        if (ev.seq < expected) continue;
        if (ev.seq > expected) { lose('stream events arrived out of order'); return; }
        expected++;
        emit(ev);
        if (!active) return;
      }
      cursor = batch.next;
      if (batch.ended) { lose('The reply stream ended without a final result'); return; }
    }
  })();
  return () => { active = false; };
}
