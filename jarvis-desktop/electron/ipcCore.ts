// Pure IPC dispatch core (no Electron import, unit tested): sender trust, arity, error redaction,
// plus the small pure policies main.ts needs (file-request confinement, dev URL, trusted confirmation).
import * as nodePath from 'node:path';
import type {ChatMessage, ChatStreamBatch, ChatStreamEvent, ChatStreamOutcome, ChatStreamRoute, ChatStreamStart, JarvisAPI} from '../src/shared/contracts';
import {ARITY, METHODS, CLOUD_PROVIDER_IDS, type MethodName} from './channels';
import {MAX_COMMAND_CHARS} from './services/intent';
import {LIMITS} from './services/validation';

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function decodedPath(u: URL): string | null {
  try { return decodeURIComponent(u.pathname); } catch { return null; }
}

/** True only for the packaged index.html (exact file, empty host) or, in development, the configured dev origin. */
export function isTrustedUrl(url: string | undefined, appFileUrl: string, devOrigin?: string): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') {
    let a: URL;
    try { a = new URL(appFileUrl); } catch { return false; }
    // A file URL with a host is a UNC/SMB location, never the app.
    if (a.protocol !== 'file:' || u.host !== '' || a.host !== '') return false;
    const up = decodedPath(u), ap = decodedPath(a);
    return up !== null && ap !== null && samePath(up, ap);
  }
  return !!devOrigin && (u.protocol === 'http:') && u.origin === devOrigin;
}

/** A file: request is allowed only with an empty host and a path inside the packaged dist directory. */
export function isAllowedFileRequest(url: string, distDir: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'file:' || u.host !== '') return false;
  const p = decodedPath(u);
  if (p === null || p.includes('\0')) return false;
  const file = nodePath.win32.normalize(p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'));
  const root = nodePath.win32.normalize(distDir).replace(/[\\/]+$/, '');
  if (file.startsWith('\\\\') || !/^[A-Za-z]:\\/.test(file)) return false;
  return file.toLowerCase() === root.toLowerCase() || file.toLowerCase().startsWith(`${root.toLowerCase()}\\`);
}

export function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && Number(m[1]) === 127 && m.slice(1).every((o) => Number(o) <= 255);
}

/** Dev server origin is honoured only when it is a plain http loopback origin. Returns the origin or null. */
export function parseDevOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || u.username || u.password || !isLoopbackHostname(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Session-level request allow-list (webRequest.onBeforeRequest). Everything else is cancelled, which keeps offline mode offline:
 * file: only inside dist with an empty host, devtools:/data:/blob: (no network), and the loopback dev origin (http + ws) in development.
 */
export function isAllowedRequestUrl(url: string, distDir: string, devOrigin?: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  switch (u.protocol) {
    case 'file:': return isAllowedFileRequest(url, distDir);
    case 'devtools:': case 'data:': case 'blob:': return true;
    case 'http:': case 'ws:': {
      if (!devOrigin) return false;
      let d: URL;
      try { d = new URL(devOrigin); } catch { return false; }
      return d.protocol === 'http:' && isLoopbackHostname(d.hostname) && !u.username && !u.password && u.host.toLowerCase() === d.host.toLowerCase();
    }
    default: return false;
  }
}

/** Test mode may only run against an isolated temp userData whose folder name starts with a fixture prefix. */
export function isTestFixtureDir(dir: string, tmpDir: string, prefixes: readonly string[] = ['jarvis-smoke-', 'jarvis-test-', 'desktop-companion-test-']): boolean {
  const d = nodePath.win32.resolve(dir), t = nodePath.win32.resolve(tmpDir).replace(/[\\/]+$/, '');
  if (nodePath.win32.dirname(d).toLowerCase() !== t.toLowerCase()) return false;
  const base = nodePath.win32.basename(d).toLowerCase();
  return prefixes.some((p) => base.startsWith(p) && base.length > p.length);
}

export interface ConfirmWindowLike { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean }

export interface MessageBoxOptions {
  type: 'warning'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true;
}

export interface TrustedConfirmDeps<W extends ConfirmWindowLike> {
  getWindow(): W | null;
  /** True when the window has finished loading the trusted app page. */
  isTrusted(win: W): boolean;
  showMessageBox(win: W, options: MessageBoxOptions): Promise<{response: number}>;
}

/**
 * Builds BackendEnv.confirm. The dialog is owned by the main window, defaults to Cancel and carries the full detail.
 * Fails closed: no visible, focused, ready, trusted window; a dialog already open; or any dialog error -> false.
 */
export function createTrustedConfirm<W extends ConfirmWindowLike>(deps: TrustedConfirmDeps<W>): (summary: string, detail: string) => Promise<boolean> {
  let open = false;
  return async (summary, detail) => {
    if (open || typeof summary !== 'string' || typeof detail !== 'string') return false;
    const win = deps.getWindow();
    try {
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused() || !deps.isTrusted(win)) return false;
    } catch { return false; }
    open = true;
    try {
      const r = await deps.showMessageBox(win, {
        type: 'warning', title: 'Desktop Companion', message: summary.slice(0, 300), detail,
        buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return r.response === 1;
    } catch { return false; } finally { open = false; }
  };
}

/** User-safe error text: keeps the message, redacts user profile paths, bounds the length. */
/** Replaces credential-shaped tokens (Anthropic/OpenAI-style keys, bearer tokens, api-key headers, GitHub tokens) with [redacted]. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk)-(?:ant-)?[\w-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(x-api-key|api[-_]?key|authorization)(\s*[:=]\s*|\s+(?=[A-Za-z0-9._~+/=-]{16,}))(?!\[redacted\]|Bearer \[redacted\])\S+/gi, '$1$2[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]');
}

export function safeErrorMessage(e: unknown): string {
  const msg = redactSecrets(e instanceof Error ? e.message : 'Request failed');
  // Profile paths in the forms errors actually carry: C:\Users\x, C:/Users/x (file: URLs) and JSON-escaped C:\\Users\\x.
  return msg.replace(/[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[^\\/\s"']+/gi, '%USERPROFILE%').replace(/\s+/g, ' ').slice(0, 400) || 'Request failed';
}

export interface RouterOptions {
  appFileUrl: string;
  devOrigin?: string;
}

export type HandlerMap = Pick<Required<JarvisAPI>, MethodName>;

/**
 * Shape of each IPC argument, checked before any handler runs. This is a coarse boundary filter (type, presence, size);
 * the services still do the full semantic validation. Undefined counts as absent, so only optional arguments may be omitted.
 */
export type ArgSpec =
  | {kind: 'string'; max: number; min?: number; optional?: true}
  | {kind: 'object'; optional?: true}
  | {kind: 'boolean'; optional?: true}
  | {kind: 'enum'; values: readonly string[]; optional?: true}
  | {kind: 'numbers'; max: number; optional?: true}
  | {kind: 'integer'; min: number; max: number; optional?: true}
  | {kind: 'objects'; max: number; optional?: true};

const ID: ArgSpec = {kind: 'string', min: 1, max: 64};
const OBJ: ArgSpec = {kind: 'object'};
const OPTIONS: ArgSpec = {kind: 'object', optional: true};
const MODEL_NAME: ArgSpec = {kind: 'string', min: 1, max: 200};
const PATH_ARG: ArgSpec = {kind: 'string', min: 1, max: 4096};
/** Window handles chosen for geometry capture. Integers only; the backend re-checks each against a fresh window list. */
const HWNDS: ArgSpec = {kind: 'numbers', max: 50};
/** Stream ids are random UUIDs; ChatStreamHub re-checks the exact format. */
const STREAM_ID: ArgSpec = {kind: 'string', min: 36, max: 36};

export const ARG_SPECS: Record<MethodName, readonly ArgSpec[]> = {
  getState: [], saveSettings: [OBJ], getSystemInfo: [],
  saveCapsule: [OBJ], deleteCapsule: [ID], restoreCapsule: [ID],
  saveNote: [OBJ], deleteNote: [ID], saveTask: [OBJ], deleteTask: [ID],
  chat: [{kind: 'string', max: LIMITS.chat}], clearChat: [],
  setCloudKey: [{kind: 'string', min: 1, max: 4096}], cloudKeyStatus: [], deleteCloudKey: [],
  cloudProviderStatus: [],
  setProviderKey: [{kind: 'enum', values: CLOUD_PROVIDER_IDS}, {kind: 'string', min: 1, max: 4096}],
  clearProviderKey: [{kind: 'enum', values: CLOUD_PROVIDER_IDS}],
  cloudModels: [{kind: 'enum', values: CLOUD_PROVIDER_IDS}],
  // The renderer may only propose. `approved` must be a real boolean; the native confirmation still decides.
  previewAction: [OBJ], executeAction: [ID, {kind: 'boolean'}],
  speak: [{kind: 'string', max: LIMITS.speakChars}],
  transcribe: [{kind: 'numbers', max: 44 + LIMITS.audioSamples * 2 + 1024}],
  exportData: [], importData: [], pickPath: [{kind: 'enum', values: ['file', 'folder']}],
  getApiInfo: [], planIntent: [{kind: 'string', max: MAX_COMMAND_CHARS}, OPTIONS], search: [{kind: 'string', max: 1000}, OPTIONS], listLocalModels: [],
  // v2.1 captain integration. Services re-validate every argument; these specs only bound shape and size at the IPC edge.
  routinesList: [], routinesSave: [OBJ], routinesRemove: [ID], routinesStart: [ID], routinesCancel: [ID], routinesPauseAll: [], routinesResumeAll: [], routinesUndo: [ID],
  routinesPlanText: [{kind: 'string', max: 20_000}], routinesPlanModel: [{kind: 'string', max: 50_000}],
  modelsOverview: [], modelsSelect: [MODEL_NAME, OPTIONS], modelsUnload: [{kind: 'string', max: 200, optional: true}], modelsSetProfile: [{kind: 'enum', values: ['default', 'low-memory', 'balanced', 'performance']}],
  modelsValidatePack: [PATH_ARG], modelsStartImport: [PATH_ARG, {kind: 'string', max: 200, optional: true}], modelsStartPull: [MODEL_NAME], modelsCancelJob: [ID], modelsPickPackFolder: [],
  integrationsList: [], integrationsPreview: [ID], integrationsCheck: [ID], integrationsSetKey: [ID, {kind: 'string', min: 1, max: 4096}], integrationsRemoveKey: [ID], integrationsSetEnabled: [ID, {kind: 'boolean'}], integrationsUsage: [], integrationsClearUsage: [],
  usageReport: [], usageExport: [{kind: 'enum', values: ['csv', 'json']}], usageSetPrices: [OBJ], usageSetBudget: [OBJ],
  clipboardStatus: [], clipboardSetEnabled: [{kind: 'boolean'}], clipboardList: [], clipboardGet: [ID], clipboardRemove: [ID], clipboardPurge: [],
  systemResources: [],
  // v2.2 data API. ProductivityStore/parseCapsulePack/parseIcs re-validate content; 1 MB matches PACK_LIMITS.bytes and MAX_ICS_BYTES.
  productivityGet: [], productivityApply: [OBJ], productivityForgetHistory: [OBJ], productivitySignals: [],
  capsulePreviewRestore: [ID], capsuleListWindows: [], capsuleCaptureGeometry: [ID, HWNDS], capsuleExportPack: [ID, {kind: 'objects', max: 10}],
  capsuleReadPack: [], capsuleParsePack: [{kind: 'string', min: 1, max: 1_000_000}, {kind: 'objects', max: 20}],
  ocrStatus: [], ocrRecognize: [OPTIONS], ocrCancel: [],
  calendarList: [], calendarImportText: [{kind: 'string', min: 1, max: 1_000_000}], calendarImportFile: [], calendarExport: [], calendarClear: [],
  chatStreamStart: [{kind: 'string', max: LIMITS.chat}], chatStreamRead: [STREAM_ID, {kind: 'integer', min: 0, max: 1_000_000}], chatStreamCancel: [STREAM_ID],
  // Preview tokens are random UUIDs; ApprovedDocuments re-checks the exact format and that the token is still pending.
  documentsChoose: [], documentsSave: [STREAM_ID, OPTIONS], documentsDiscard: [STREAM_ID],
  speechStop: [], transcribeCancel: [],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function argProblem(spec: ArgSpec, v: unknown): string | null {
  switch (spec.kind) {
    case 'string':
      if (typeof v !== 'string') return 'expected text';
      if (v.length > spec.max) return `text is too long (max ${spec.max})`;
      return v.length < (spec.min ?? 0) ? 'text is required' : null;
    case 'object': return isPlainObject(v) ? null : 'expected an object';
    case 'boolean': return typeof v === 'boolean' ? null : 'expected true or false';
    case 'enum': return typeof v === 'string' && spec.values.includes(v) ? null : `expected one of ${spec.values.join(', ')}`;
    case 'numbers':
      if (!Array.isArray(v)) return 'expected an array of numbers';
      if (v.length > spec.max) return `array is too long (max ${spec.max})`;
      for (let i = 0; i < v.length; i++) if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return 'array contains a non-number';
      return null;
    case 'integer':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return 'expected a whole number';
      return v < spec.min || v > spec.max ? 'number is out of range' : null;
    case 'objects':
      if (!Array.isArray(v)) return 'expected a list';
      if (v.length > spec.max) return `list is too long (max ${spec.max})`;
      return v.every(isPlainObject) ? null : 'list contains a non-object';
  }
}

/** Returns a user-safe message for the first invalid argument, or null when every argument matches its spec. */
export function validateArgs(method: MethodName, args: readonly unknown[]): string | null {
  return validateArgsAgainst(method, ARG_SPECS[method], args);
}

/** The same check against any spec list (the companion window has its own method table). */
export function validateArgsAgainst(method: string, specs: readonly ArgSpec[], args: readonly unknown[]): string | null {
  if (args.length > specs.length) return 'Wrong number of arguments';
  for (let i = 0; i < specs.length; i++) {
    const v = args[i];
    if (v === undefined) {
      if (specs[i].optional) continue;
      return 'Wrong number of arguments';
    }
    const problem = argProblem(specs[i], v);
    if (problem) return `Invalid argument ${i + 1} for ${method}: ${problem}`;
  }
  return null;
}

/** Pure dispatcher, unit tested without Electron. */
export async function dispatch(handlers: HandlerMap, method: string, args: unknown[], senderUrl: string | undefined, opts: RouterOptions, isMainFrame = true): Promise<unknown> {
  if (!isMainFrame || !isTrustedUrl(senderUrl, opts.appFileUrl, opts.devOrigin)) throw new Error('Request rejected: untrusted sender');
  if (!(METHODS as readonly string[]).includes(method)) throw new Error('Unknown method');
  const m = method as MethodName;
  if (!Array.isArray(args) || args.length > ARITY[m]) throw new Error('Wrong number of arguments');
  const invalid = validateArgs(m, args);
  if (invalid) throw new Error(invalid);
  try {
    return await (handlers[m] as (...a: unknown[]) => Promise<unknown>)(...args);
  } catch (e) {
    throw new Error(safeErrorMessage(e));
  }
}

// ---------- Streaming chat lifecycle (pure; the backend wires providers and persistence) ----------

export const CHAT_STREAM_LIMITS = {
  /** Longest a read waits for new events before returning an empty batch. */
  pollMs: 15_000,
  /** A running stream nobody has read for this long (window closed or reloaded) is aborted upstream. */
  abandonMs: 45_000,
  /** An ended stream stays readable this long so the caller can collect the final event, then it is forgotten. */
  retainMs: 60_000,
  /** Largest text carried by one delta event; consecutive undelivered deltas are merged up to this size. */
  eventChars: 16_384,
  /** Undelivered events kept per stream; exceeding it aborts the stream (the reader is not keeping up). */
  maxEvents: 256,
};
export type ChatStreamLimits = typeof CHAT_STREAM_LIMITS;
export const STREAM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a stream was stopped before its provider finished. cleared/disposed streams must not write anything afterwards. */
export type StreamStopReason = 'user' | 'offline' | 'abandoned' | 'cleared' | 'disposed';

/** The producer side of one stream. Every method is a no-op once the stream ended, so late provider callbacks cannot leak. */
export interface ChatStreamSink {
  readonly streamId: string;
  readonly generation: number;
  readonly route: ChatStreamRoute;
  readonly signal: AbortSignal;
  /** Null while running normally. */
  stopReason(): StreamStopReason | null;
  /** False once ended, or when the stream was cleared/disposed: the caller must not persist anything. */
  mayPersist(): boolean;
  status(status: 'connecting' | 'streaming'): boolean;
  delta(text: string): boolean;
  /** Ends the stream with its final event. Returns false (and does nothing) if it already ended. */
  finish(outcome: ChatStreamOutcome, reply: ChatMessage, stored: ChatMessage[]): boolean;
}

/** keepAlive: a pending read's poll timer holds the event loop (it is short and bounded); housekeeping timers do not. */
export type HubTimers = {setTimeout: (fn: () => void, ms: number, keepAlive?: boolean) => unknown; clearTimeout: (t: unknown) => void};
const realTimers: HubTimers = {
  setTimeout: (fn, ms, keepAlive = false) => { const t = setTimeout(fn, ms); if (!keepAlive) (t as {unref?: () => void}).unref?.(); return t; },
  clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
};

interface StreamEntry {
  sink: ChatStreamSink;
  ac: AbortController;
  events: ChatStreamEvent[];
  produced: number;
  delivered: number;
  ended: boolean;
  stop: StreamStopReason | null;
  waiters: Set<() => void>;
  abandonTimer: unknown;
  retainTimer: unknown;
}

/**
 * Owns every streaming chat's AbortController and event queue. One generation runs at a time. Events are read with a
 * long-poll cursor; a read acknowledges everything before its cursor. Stream ids are unguessable and only returned to
 * the caller that started the stream, so another window cannot read or cancel it, and generations make stale events
 * recognisable. Cancel, offline switch, clear, abandonment and dispose all abort the upstream request.
 */
export class ChatStreamHub {
  private streams = new Map<string, StreamEntry>();
  private generation = 0;
  private isDisposed = false;
  private limits: ChatStreamLimits;
  private timers: HubTimers;

  constructor(private opts: {newId: () => string; limits?: Partial<ChatStreamLimits>; timers?: HubTimers}) {
    this.limits = {...CHAT_STREAM_LIMITS, ...opts.limits};
    this.timers = opts.timers ?? realTimers;
  }

  get disposed(): boolean { return this.isDisposed; }
  /** Number of streams still running. */
  get running(): number { let n = 0; for (const e of this.streams.values()) if (!e.ended) n++; return n; }

  open(route: ChatStreamRoute): {start: ChatStreamStart; sink: ChatStreamSink} {
    if (this.isDisposed) throw new Error('The app is shutting down');
    if (this.running > 0) throw new Error('A reply is already being generated. Stop it first');
    const streamId = this.opts.newId();
    if (!STREAM_ID_RE.test(streamId) || this.streams.has(streamId)) throw new Error('Could not allocate a stream');
    const generation = ++this.generation;
    const ac = new AbortController();
    const hub = this;
    const entry: StreamEntry = {sink: undefined as unknown as ChatStreamSink, ac, events: [], produced: 0, delivered: 0, ended: false, stop: null, waiters: new Set(), abandonTimer: undefined, retainTimer: undefined};
    const tag = () => ({streamId, generation, seq: entry.produced++});
    entry.sink = {
      streamId, generation, route, signal: ac.signal,
      stopReason: () => entry.stop,
      mayPersist: () => !entry.ended && !hub.isDisposed && entry.stop !== 'cleared' && entry.stop !== 'disposed',
      // After a stop was requested (or the signal aborted) late provider callbacks are dropped, not queued.
      status(status) { if (entry.ended || entry.stop !== null || ac.signal.aborted) return false; hub.push(entry, {...tag(), type: 'status', status}); return true; },
      delta(text) {
        if (entry.ended || entry.stop !== null || ac.signal.aborted || typeof text !== 'string' || !text) return false;
        for (let i = 0; i < text.length; i += hub.limits.eventChars) hub.pushDelta(entry, text.slice(i, i + hub.limits.eventChars));
        return true;
      },
      finish(outcome, reply, stored) {
        if (entry.ended) return false;
        hub.push(entry, {...tag(), type: 'done', outcome, reply, stored});
        hub.end(entry);
        return true;
      },
    };
    this.streams.set(streamId, entry);
    this.armAbandon(entry);
    return {start: {streamId, generation, route}, sink: entry.sink};
  }

  /** Returns events at or after cursor, waiting up to pollMs when there are none yet. */
  async read(streamId: unknown, cursor: unknown): Promise<ChatStreamBatch> {
    if (typeof streamId !== 'string' || !STREAM_ID_RE.test(streamId)) throw new Error('Invalid stream id');
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid stream cursor');
    const e = this.streams.get(streamId);
    if (!e) throw new Error('Unknown or expired stream');
    const base = e.events.length ? e.events[0].seq : e.produced;
    // A cursor may re-read the last delivered batch (a lost reply) but never acknowledged events or the future.
    if (cursor > e.produced || cursor < Math.min(base, e.delivered)) throw new Error('Stale stream cursor');
    e.events = e.events.filter((ev) => ev.seq >= cursor);
    if (!e.ended) this.armAbandon(e);
    if (!e.events.length && !e.ended && !this.isDisposed) {
      await new Promise<void>((resolve) => {
        const wake = () => { this.timers.clearTimeout(t); e.waiters.delete(wake); resolve(); };
        const t = this.timers.setTimeout(wake, this.limits.pollMs, true);
        e.waiters.add(wake);
      });
      if (!e.ended) this.armAbandon(e);
    }
    const events = e.events.map((ev) => ({...ev}));
    e.delivered = e.produced;
    return {events, next: e.produced, ended: e.ended || this.isDisposed};
  }

  cancel(streamId: unknown, reason: StreamStopReason = 'user'): boolean {
    if (typeof streamId !== 'string' || !STREAM_ID_RE.test(streamId)) throw new Error('Invalid stream id');
    const e = this.streams.get(streamId);
    if (!e || e.ended) return false;
    this.abort(e, reason);
    return true;
  }

  /** Aborts every running stream on a route (for example cloud streams when online mode is switched off). */
  abortRoute(route: ChatStreamRoute, reason: StreamStopReason): number {
    let n = 0;
    for (const e of this.streams.values()) if (!e.ended && e.sink.route === route) { this.abort(e, reason); n++; }
    return n;
  }

  abortAll(reason: StreamStopReason): number {
    let n = 0;
    for (const e of this.streams.values()) if (!e.ended) { this.abort(e, reason); n++; }
    return n;
  }

  /** Aborts everything, wakes pending reads and forgets all streams. Nothing can be persisted afterwards. */
  dispose(): void {
    if (this.isDisposed) return;
    this.abortAll('disposed');
    this.isDisposed = true;
    for (const e of this.streams.values()) {
      this.timers.clearTimeout(e.abandonTimer);
      this.timers.clearTimeout(e.retainTimer);
      e.ended = true;
      for (const w of [...e.waiters]) w();
    }
    this.streams.clear();
  }

  private abort(e: StreamEntry, reason: StreamStopReason) {
    if (e.stop === null) e.stop = reason;
    e.ac.abort(new DOMException(`Stream stopped: ${reason}`, 'AbortError'));
  }

  private armAbandon(e: StreamEntry) {
    this.timers.clearTimeout(e.abandonTimer);
    e.abandonTimer = this.timers.setTimeout(() => { if (!e.ended) this.abort(e, 'abandoned'); }, this.limits.abandonMs);
  }

  private wake(e: StreamEntry) { for (const w of [...e.waiters]) w(); }

  private push(e: StreamEntry, ev: ChatStreamEvent) {
    e.events.push(ev);
    if (e.events.length > this.limits.maxEvents && !e.ended) this.abort(e, 'abandoned');
    this.wake(e);
  }

  private pushDelta(e: StreamEntry, text: string) {
    const last = e.events[e.events.length - 1];
    if (last && last.type === 'delta' && last.seq >= e.delivered && last.text.length + text.length <= this.limits.eventChars) {
      last.text += text;
      this.wake(e);
      return;
    }
    this.push(e, {streamId: e.sink.streamId, generation: e.sink.generation, seq: e.produced++, type: 'delta', text});
  }

  private end(e: StreamEntry) {
    e.ended = true;
    this.timers.clearTimeout(e.abandonTimer);
    e.retainTimer = this.timers.setTimeout(() => { if (this.streams.get(e.sink.streamId) === e) this.streams.delete(e.sink.streamId); }, this.limits.retainMs);
  }
}
