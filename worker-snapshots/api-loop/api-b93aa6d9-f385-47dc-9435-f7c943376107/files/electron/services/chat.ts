// Chat routing: local Ollama (loopback only) by default; cloud only when mode is explicitly 'online' AND a key is stored.
// There is never a silent fallback in either direction. Failures become honest 'system' messages.
// Streaming and cancellation: ChatService.start() returns a handle with cancel(); sendChat keeps the one-shot behaviour.
import type {Capability, ChatMessage, Settings} from '../../src/shared/contracts';
import type {GuardedFetch} from './netGuard';
import {NetworkDenied} from './netGuard';
import type {Store} from './store';
import type {Secrets} from './secrets';
import {validateChatText} from './validation';

const HISTORY_CHARS = 8000;
const REPLY_CAP = 60_000;
export const ANTHROPIC_VERSION = '2023-06-01';
/** How long Ollama keeps the model in memory after a reply. Short on purpose: frees RAM/VRAM soon after chatting stops. */
export const LOCAL_KEEP_ALIVE = '2m';
/** A stream that delivers nothing for this long is abandoned. Generous because a cold model load can take tens of seconds. */
export const STREAM_IDLE_MS = 120_000;
const LINE_CAP = 1_000_000;

type Turn = {role: 'user' | 'assistant'; content: string};

/** Per-request resource settings. Structural so the profiles in models.ts can be passed straight in. numCtx null keeps Ollama's own default. */
export interface ChatProfile {keepAlive: string; numCtx: number | null}

export interface ChatCallOptions {
  /** Aborting stops the request and, for streams, the reply. */
  signal?: AbortSignal;
  /** When set, the reply is streamed and each text fragment is passed here as it arrives. */
  onDelta?: (text: string) => void;
  profile?: ChatProfile;
}

/** Thrown when the caller aborted. partial is whatever text had arrived (empty for non-streaming calls). */
export class ChatCancelled extends Error {
  constructor(readonly partial = '') { super('Generation was cancelled'); }
}

/** Thrown when a stream ended without the server's end marker (dropped connection, crashed server). partial is what arrived. */
export class ChatIncomplete extends Error {
  constructor(readonly partial: string) { super('The connection ended before the reply was finished'); }
}

/** Reads a response body as text lines. Aborting `signal` ends it early with the abort reason. */
export async function* readLines(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<string> {
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const {done, value} = await reader.read();
      // Cancelling the reader (onAbort) makes read() report a normal end. That must not look like a finished reply.
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        yield line;
      }
      if (buf.length > LINE_CAP) throw new Error('The server sent an oversized stream line');
    }
    buf += dec.decode();
    if (buf.trim()) yield buf.replace(/\r$/, '');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => undefined);
  }
}

/** Parses newline-delimited JSON (Ollama). A line that is not JSON is an error, not silently skipped. */
export async function* readNdjson(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  for await (const line of readLines(body, signal)) {
    if (!line.trim()) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { throw new Error('The server sent a malformed stream line'); }
    if (v && typeof v === 'object') yield v as Record<string, unknown>;
  }
}

/** Parses server-sent events (Anthropic): yields the JSON payload of each `data:` line. */
export async function* readSseData(body: ReadableStream<Uint8Array> | null, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
  for await (const line of readLines(body, signal)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    let v: unknown;
    try { v = JSON.parse(raw); } catch { throw new Error('The provider sent a malformed stream event'); }
    if (v && typeof v === 'object') yield v as Record<string, unknown>;
  }
}

/**
 * Runs fn with a signal that fires when the caller aborts or when no stream data arrived for idleMs.
 * touch() resets the idle timer. A caller abort surfaces as ChatCancelled; an idle expiry as a TimeoutError.
 */
export async function withIdleSignal<T>(user: AbortSignal | undefined, idleMs: number, fn: (signal: AbortSignal, touch: () => void) => Promise<T>, partial: () => string = () => ''): Promise<T> {
  if (user?.aborted) throw new ChatCancelled(partial());
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { idle = true; ac.abort(new DOMException('No data from the server', 'TimeoutError')); }, idleMs);
  };
  const onUser = () => ac.abort(user?.reason);
  user?.addEventListener('abort', onUser, {once: true});
  arm();
  try {
    return await fn(ac.signal, arm);
  } catch (e) {
    if (user?.aborted) throw new ChatCancelled(partial());
    if (idle) throw Object.assign(new Error('No data from the server'), {name: 'TimeoutError'});
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    user?.removeEventListener('abort', onUser);
  }
}

export function buildHistory(chat: ChatMessage[], newUserText: string): Turn[] {
  const turns: Turn[] = [];
  let budget = HISTORY_CHARS - newUserText.length;
  for (let i = chat.length - 1; i >= 0 && budget > 0; i--) {
    const m = chat[i];
    if (m.source === 'system') continue;
    budget -= m.text.length;
    if (budget < 0) break;
    turns.unshift({role: m.role, content: m.text});
  }
  turns.push({role: 'user', content: newUserText});
  // Anthropic needs strictly alternating roles starting with user; merge neighbours and drop a leading assistant turn.
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += '\n\n' + t.content;
    else merged.push({...t});
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as {error?: string | {message?: string}};
    const e = typeof j.error === 'string' ? j.error : j.error?.message;
    return e ? String(e).slice(0, 160) : '';
  } catch { return ''; }
}

/** Guidance shown when the configured model is not installed. Installing a model needs a one-time download that this app never does on its own. */
export function missingModelHelp(model: string): string {
  return `Model "${model}" is not installed in Ollama. Install it once with "ollama pull ${model}" (that download needs internet; Desktop Companion never downloads models unless you start a download in online mode) or choose an installed model in Settings`;
}

export async function ollamaChat(guardedFetch: GuardedFetch, settings: Settings, history: Turn[], opts: ChatCallOptions = {}): Promise<string> {
  const stream = typeof opts.onDelta === 'function';
  const body = JSON.stringify({
    model: settings.localModel, messages: history, stream,
    keep_alive: opts.profile?.keepAlive ?? LOCAL_KEEP_ALIVE,
    ...(opts.profile?.numCtx ? {options: {num_ctx: opts.profile.numCtx}} : {}),
  });
  const url = `${settings.localEndpoint}/api/chat`;
  const failed = async (res: Response) => {
    const detail = await errorText(res);
    return new Error(res.status === 404 ? missingModelHelp(settings.localModel) : `Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  };
  if (!stream) {
    if (opts.signal?.aborted) throw new ChatCancelled();
    let res: Response;
    try {
      res = await guardedFetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body, timeoutMs: 120_000, ...(opts.signal ? {signal: AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])} : {})}, 'ollama');
    } catch (e) {
      if (opts.signal?.aborted) throw new ChatCancelled();
      throw e;
    }
    if (!res.ok) throw await failed(res);
    const j = (await res.json()) as {message?: {content?: string}};
    const text = j.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('Ollama returned an empty reply');
    return text.slice(0, REPLY_CAP);
  }
  let acc = '';
  let complete = false;
  return withIdleSignal(opts.signal, STREAM_IDLE_MS, async (signal, touch) => {
    const res = await guardedFetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal}, 'ollama');
    if (!res.ok) throw await failed(res);
    for await (const part of readNdjson(res.body, signal)) {
      touch();
      if (typeof part.error === 'string') throw new Error(`Ollama reported: ${part.error.slice(0, 160)}`);
      const delta = (part.message as {content?: unknown} | undefined)?.content;
      if (typeof delta === 'string' && delta) {
        const piece = delta.slice(0, Math.max(0, REPLY_CAP - acc.length));
        if (piece) { acc += piece; opts.onDelta!(piece); }
        if (acc.length >= REPLY_CAP) { complete = true; break; }
      }
      if (part.done === true) { complete = true; break; }
    }
    if (!acc.trim()) throw new Error('Ollama returned an empty reply');
    if (!complete) throw new ChatIncomplete(acc);
    return acc;
  }, () => acc);
}

export async function cloudChat(guardedFetch: GuardedFetch, settings: Settings, key: string, history: Turn[], origin = 'https://api.anthropic.com', opts: ChatCallOptions = {}): Promise<string> {
  const stream = typeof opts.onDelta === 'function';
  const init = {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION},
    body: JSON.stringify({model: settings.cloudModel, max_tokens: 1024, messages: history, ...(stream ? {stream: true} : {})}),
  };
  // Status only: provider and proxy bodies can echo request headers, including the key (PS-01).
  const failed = async (res: Response) => {
    await res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) return new CloudChatError('The cloud provider rejected the API key');
    return new CloudChatError(`Cloud provider returned HTTP ${res.status}${CLOUD_STATUS_HINTS[res.status] ?? ''}`);
  };
  if (!stream) {
    if (opts.signal?.aborted) throw new ChatCancelled();
    let res: Response;
    try {
      res = await guardedFetch(`${origin}/v1/messages`, {...init, timeoutMs: 120_000, ...(opts.signal ? {signal: AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])} : {})}, 'cloud-chat');
    } catch (e) {
      if (opts.signal?.aborted) throw new ChatCancelled();
      throw e;
    }
    if (!res.ok) throw await failed(res);
    const j = (await res.json()) as {content?: {type: string; text?: string}[]};
    const text = (j.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (!text.trim()) throw new CloudChatError('The cloud provider returned an empty reply');
    return text.slice(0, REPLY_CAP);
  }
  let acc = '';
  let complete = false;
  return withIdleSignal(opts.signal, STREAM_IDLE_MS, async (signal, touch) => {
    const res = await guardedFetch(`${origin}/v1/messages`, {...init, signal}, 'cloud-chat');
    if (!res.ok) throw await failed(res);
    for await (const ev of readSseData(res.body, signal)) {
      touch();
      if (ev.type === 'error') {
        // The error type is a short machine word; the free-text message is never kept.
        const type = (ev.error as {type?: unknown} | undefined)?.type;
        throw new CloudChatError(`Cloud provider reported an error${typeof type === 'string' && /^[a-z_]{1,40}$/.test(type) ? ` (${type})` : ''}`);
      }
      const d = ev.delta as {type?: string; text?: unknown} | undefined;
      if (ev.type === 'content_block_delta' && d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        const piece = d.text.slice(0, Math.max(0, REPLY_CAP - acc.length));
        if (piece) { acc += piece; opts.onDelta!(piece); }
        if (acc.length >= REPLY_CAP) { complete = true; break; }
      }
      if (ev.type === 'message_stop') { complete = true; break; }
    }
    if (!acc.trim()) throw new CloudChatError('The cloud provider returned an empty reply');
    if (!complete) throw new ChatIncomplete(acc);
    return acc;
  }, () => acc);
}

export interface ChatDeps {
  store: Store;
  secrets: Pick<Secrets, 'configured' | 'reveal'>;
  fetch: GuardedFetch;
  cloudOrigin?: string;
  /** Optional resource profile for local chats (see models.ts). Absent means the long-standing defaults. */
  profile?: () => ChatProfile | undefined;
}

/** Cloud failures whose text this module wrote itself. Only these reach the reply and stored chat verbatim. */
class CloudChatError extends Error {}

const CLOUD_STATUS_HINTS: Record<number, string> = {
  429: ' (rate limited; try again later)', 500: ' (provider error)', 502: ' (bad gateway)', 503: ' (service unavailable)', 529: ' (provider overloaded)',
};

function describe(e: unknown, where: 'local' | 'cloud', settings: Settings): string {
  if (e instanceof NetworkDenied) return `Blocked: ${e.message}`;
  const err = e as Error & {name?: string; cause?: {code?: string}};
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return where === 'local' ? 'Ollama did not answer in time' : 'The cloud provider did not answer in time';
  if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message ?? '')) {
    return where === 'local' ? `Ollama is not running at ${settings.localEndpoint}. Start Ollama, then try again` : 'Could not reach the cloud provider';
  }
  // Any other cloud error (transport, TLS, proxy) can carry request text, so only a fixed sentence is stored (PS-01).
  if (where === 'cloud' && !(e instanceof CloudChatError)) return 'The cloud provider request failed. Details were not kept because they can include request headers';
  return String(err?.message ?? 'Unknown error').slice(0, 300);
}

/**
 * Where a chat goes. Online mode is the user's explicit opt-in to the cloud; without a stored key it is denied,
 * and a denial never turns into a local request (or the other way round).
 */
export function resolveChatRoute(settings: Pick<Settings, 'mode'>, keyConfigured: boolean): {route: 'local' | 'cloud'; denied: string | null} {
  if (settings.mode === 'online') {
    return {route: 'cloud', denied: keyConfigured ? null : 'No cloud API key is configured. Add a key in Settings or switch to offline mode'};
  }
  return {route: 'local', denied: null};
}

export interface RunOptions {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
}

async function runChat(deps: ChatDeps, rawText: unknown, opts: RunOptions): Promise<ChatMessage> {
  const text = validateChatText(rawText);
  const state = deps.store.snapshot();
  const settings = state.settings;
  const now = () => deps.store.nowIso();
  const routeSource: 'local' | 'cloud' = settings.mode === 'online' ? 'cloud' : 'local';
  const userMsg: ChatMessage = {id: deps.store.id(), role: 'user', text, createdAt: now(), source: routeSource};
  const history = buildHistory(state.chat, text);
  await deps.store.mutate((d) => { d.chat.push(userMsg); });
  const callOpts: ChatCallOptions = {signal: opts.signal, onDelta: opts.onDelta, profile: routeSource === 'local' ? deps.profile?.() : undefined};
  let reply: ChatMessage;
  let partial: ChatMessage | null = null;
  // True once a cloud request was handed to the network layer; from then on the provider may have received the text.
  let cloudRequestStarted = false;
  try {
    let out: string;
    const decision = resolveChatRoute(settings, routeSource === 'local' || (await deps.secrets.configured()));
    if (decision.denied) throw new CloudChatError(decision.denied);
    if (decision.route === 'cloud') {
      const key = await deps.secrets.reveal();
      if (!key) throw new CloudChatError('The stored API key could not be decrypted; set it again in Settings');
      if (opts.signal?.aborted) throw new ChatCancelled();
      cloudRequestStarted = true;
      out = await cloudChat(deps.fetch, settings, key, history, deps.cloudOrigin, callOpts);
    } else {
      out = await ollamaChat(deps.fetch, settings, history, callOpts);
    }
    reply = {id: deps.store.id(), role: 'assistant', text: out, createdAt: now(), source: routeSource};
  } catch (e) {
    // Be exact about where the text may have gone. A request the guard blocked, or one never started, left nothing.
    const reached = cloudRequestStarted && !(e instanceof NetworkDenied);
    const where = routeSource === 'cloud'
      ? (reached ? 'Your message may have reached the cloud provider.' : 'Your message was not sent.')
      : 'Your message was not sent to any cloud provider.';
    if (e instanceof ChatIncomplete) {
      partial = {id: deps.store.id(), role: 'assistant', text: e.partial, createdAt: now(), source: routeSource};
      reply = {id: deps.store.id(), role: 'assistant', text: `The connection ended before the reply was finished. The reply above is incomplete and no other model was tried. ${where}`, createdAt: now(), source: 'system'};
    } else if (e instanceof ChatCancelled || opts.signal?.aborted) {
      const text = e instanceof ChatCancelled ? e.partial : '';
      if (text.trim()) partial = {id: deps.store.id(), role: 'assistant', text, createdAt: now(), source: routeSource};
      reply = {id: deps.store.id(), role: 'assistant', text: `Stopped by you. ${partial ? 'The reply above is incomplete.' : 'No reply was generated.'} ${where}`, createdAt: now(), source: 'system'};
    } else {
      const reason = describe(e, routeSource, settings);
      reply = {id: deps.store.id(), role: 'assistant', text: `${routeSource === 'cloud' ? 'Cloud' : 'Local'} model unavailable: ${reason}. No reply was generated and no other model was tried. ${where}`, createdAt: now(), source: 'system'};
    }
  }
  const stored = partial ? [partial, reply] : [reply];
  await deps.store.mutate((d) => { d.chat.push(...stored); });
  return reply;
}

/** One-shot chat (no streaming, not cancellable). The backend uses this today. */
export async function sendChat(deps: ChatDeps, rawText: unknown): Promise<ChatMessage> {
  return runChat(deps, rawText, {});
}

export interface ChatStream {
  /** Identifies this generation for cancel(). Empty when the start was refused. */
  id: string;
  cancel(): void;
  /** Resolves with the stored final message (assistant reply or system note). Rejects only for invalid input or a busy service. */
  done: Promise<ChatMessage>;
}

/** Streaming chat with explicit cancellation. One generation at a time: a second start is refused, never queued. */
export class ChatService {
  private active: {id: string; ac: AbortController} | null = null;

  constructor(private deps: ChatDeps) {}

  get busy(): boolean { return this.active !== null; }

  start(rawText: unknown, hooks: {onDelta?: (text: string) => void} = {}): ChatStream {
    if (this.active) {
      return {id: '', cancel: () => undefined, done: Promise.reject(new Error('A reply is already being generated. Stop it first'))};
    }
    const ac = new AbortController();
    const id = this.deps.store.id();
    const slot = {id, ac};
    this.active = slot;
    const onDelta = hooks.onDelta ? (t: string) => { try { hooks.onDelta!(t); } catch { /* a broken sink must not stop generation */ } } : undefined;
    const done = runChat(this.deps, rawText, {signal: ac.signal, onDelta}).finally(() => { if (this.active === slot) this.active = null; });
    return {id, cancel: () => ac.abort(), done};
  }

  /** Cancels the active generation (optionally only if it matches id). Returns whether something was cancelled. */
  cancel(id?: string): boolean {
    if (!this.active || (id !== undefined && id !== this.active.id)) return false;
    this.active.ac.abort();
    return true;
  }
}

/** Capability probe for the local model: GET /api/tags with a short timeout. */
export async function probeLocalModel(guardedFetch: GuardedFetch, settings: Settings): Promise<Capability> {
  const base = {id: 'local-llm', name: 'Local model (Ollama)'};
  try {
    const res = await guardedFetch(`${settings.localEndpoint}/api/tags`, {timeoutMs: 1500}, 'ollama');
    if (!res.ok) return {...base, available: false, reason: `Ollama returned HTTP ${res.status}`};
    const j = (await res.json()) as {models?: {name?: string; model?: string}[]};
    const names = (j.models ?? []).map((m) => String(m.name ?? m.model ?? ''));
    const want = settings.localModel.includes(':') ? settings.localModel : `${settings.localModel}:latest`;
    if (!names.includes(want) && !names.includes(settings.localModel)) {
      return {...base, available: false, reason: `Ollama is running but model "${settings.localModel}" is not installed. Install it once with "ollama pull ${settings.localModel}"`};
    }
    return {...base, available: true};
  } catch (e) {
    if (e instanceof NetworkDenied) return {...base, available: false, reason: `Endpoint blocked: ${e.message}`};
    return {...base, available: false, reason: `Ollama is not running at ${settings.localEndpoint}`};
  }
}
