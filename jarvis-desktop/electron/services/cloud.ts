// Optional cloud chat streaming (Anthropic Messages API, server-sent events). Only ever reached when the user chose online
// mode and stored a key; the request goes through GuardedFetch (purpose 'cloud-chat'), which re-checks mode, key and origin.
// The key is placed in one request header and is never logged, echoed in errors or returned.
import type {GuardedFetch} from './netGuard';
import {ANTHROPIC_ORIGIN, chatUrlForProvider, originForProvider, type CompatProvider} from './netGuard';
import type {CloudModelInfo, CloudProvider} from '../../src/shared/contracts';

/** Failures whose text this module wrote itself (status-only HTTP errors, empty reply). Safe to show verbatim. */
export class CloudProviderError extends Error {
  override name = 'CloudProviderError';
}
import {LineSplitter, STREAM_LIMITS, StreamAborted, StreamIncomplete, StreamProtocolError, appendCapped, pumpLines, readBoundedText, type StreamLimits, type StreamResult} from './ollama';

export const ANTHROPIC_STREAM_VERSION = '2023-06-01';
export const CLOUD_MAX_TOKENS = 1024;

export type SseEvent = {event: string; data: string};

/** Incremental server-sent-events parser over whole lines. Bounded: one event's data may not exceed maxData characters. */
export class SseParser {
  private event = '';
  private data: string[] = [];
  private size = 0;
  constructor(private maxData = STREAM_LIMITS.lineChars) {}

  /** Feeds one line; returns the event completed by a blank line, if any. */
  line(line: string): SseEvent | null {
    if (line === '') {
      if (!this.data.length) { this.event = ''; return null; }
      const ev = {event: this.event, data: this.data.join('\n')};
      this.event = ''; this.data = []; this.size = 0;
      return ev;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value.slice(0, 64);
    else if (field === 'data') {
      this.size += value.length + 1;
      if (this.size > this.maxData) throw new StreamProtocolError('The provider sent an oversized stream event');
      this.data.push(value);
    }
    // id / retry / unknown fields carry nothing this client uses.
    return null;
  }

  /** At end of body: a final event without its blank line is still delivered (the sequence check decides if it is valid). */
  flush(): SseEvent | null { return this.line(''); }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const tokenCount = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Enforces the Messages streaming event order: message_start, then for each content block (indexes 0, 1, …)
 * content_block_start → content_block_delta* → content_block_stop, then message_delta*, then message_stop.
 * ping may appear anywhere before the end; unknown event types are ignored; anything after message_stop is an error.
 */
export class AnthropicStreamValidator {
  private state: 'start' | 'message' | 'block' | 'stopped' = 'start';
  private nextIndex = 0;
  private blockType = '';
  inputTokens: number | null = null;
  outputTokens: number | null = null;

  get stopped(): boolean { return this.state === 'stopped'; }

  /** Returns the text delta carried by this event (empty for all other events). */
  accept(ev: SseEvent): string {
    let v: unknown;
    try { v = JSON.parse(ev.data); } catch { throw new StreamProtocolError('The provider sent a malformed stream event'); }
    if (!isObj(v) || typeof v.type !== 'string') throw new StreamProtocolError('The provider sent a malformed stream event');
    const type = v.type;
    if (ev.event && ev.event !== type) throw new StreamProtocolError('The provider sent an inconsistent stream event');
    if (this.state === 'stopped') throw new StreamProtocolError('The provider sent data after the end of the reply');
    const bad = () => new StreamProtocolError('The provider sent stream events out of order');
    switch (type) {
      case 'ping': return '';
      case 'error': {
        // Only the machine-readable error type is surfaced; free text from the provider is never echoed.
        const kind = isObj(v.error) && typeof v.error.type === 'string' && /^[a-z_]{1,40}$/.test(v.error.type) ? v.error.type : 'error';
        throw new StreamProtocolError(`Cloud provider reported an error during the reply (${kind})`);
      }
      case 'message_start': {
        if (this.state !== 'start' || !isObj(v.message)) throw bad();
        const u = v.message.usage;
        if (isObj(u)) { this.inputTokens = tokenCount(u.input_tokens); const o = tokenCount(u.output_tokens); if (o !== null) this.outputTokens = o; }
        this.state = 'message';
        return '';
      }
      case 'content_block_start': {
        if (this.state !== 'message' || v.index !== this.nextIndex || !isObj(v.content_block) || typeof v.content_block.type !== 'string') throw bad();
        this.blockType = v.content_block.type;
        this.state = 'block';
        return '';
      }
      case 'content_block_delta': {
        if (this.state !== 'block' || v.index !== this.nextIndex || !isObj(v.delta) || typeof v.delta.type !== 'string') throw bad();
        if (v.delta.type !== 'text_delta') return '';
        if (this.blockType !== 'text' || typeof v.delta.text !== 'string') throw bad();
        return v.delta.text;
      }
      case 'content_block_stop': {
        if (this.state !== 'block' || v.index !== this.nextIndex) throw bad();
        this.nextIndex++;
        this.state = 'message';
        return '';
      }
      case 'message_delta': {
        if (this.state !== 'message') throw bad();
        if (isObj(v.usage)) { const o = tokenCount(v.usage.output_tokens); if (o !== null) this.outputTokens = o; }
        return '';
      }
      case 'message_stop': {
        if (this.state !== 'message') throw bad();
        this.state = 'stopped';
        return '';
      }
      default:
        if (this.state === 'start') throw bad();
        return '';
    }
  }
}

/**
 * OpenAI-compatible chat-completions stream (OpenAI and OpenRouter). Each event is one data line holding a JSON chunk with
 * choices[0].delta.content (string or absent) and optional usage {prompt_tokens, completion_tokens}; the stream ends with the
 * literal sentinel [DONE]. Anything after [DONE], malformed JSON or a malformed chunk is a StreamProtocolError. An error chunk
 * surfaces only a short machine-readable code; provider free text is never kept.
 */
export class OpenAiStreamValidator {
  private ended = false;
  inputTokens: number | null = null;
  outputTokens: number | null = null;

  get done(): boolean { return this.ended; }

  /** Returns the text delta carried by this event (empty for usage-only, role-only and the [DONE] event). */
  accept(ev: SseEvent): string {
    if (this.ended) throw new StreamProtocolError('The provider sent data after the end of the reply');
    if (ev.data === '[DONE]') { this.ended = true; return ''; }
    const malformed = () => new StreamProtocolError('The provider sent a malformed stream event');
    let v: unknown;
    try { v = JSON.parse(ev.data); } catch { throw malformed(); }
    if (!isObj(v)) throw malformed();
    if (v.error !== undefined && v.error !== null) {
      const e = isObj(v.error) ? v.error : {};
      const raw = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : typeof e.type === 'string' ? e.type : '';
      const code = /^[A-Za-z0-9_]{1,40}$/.test(raw) ? raw : 'error';
      throw new StreamProtocolError(`Cloud provider reported an error during the reply (${code})`);
    }
    if (isObj(v.usage)) {
      const p = tokenCount(v.usage.prompt_tokens), c = tokenCount(v.usage.completion_tokens);
      if (p !== null && c !== null) { this.inputTokens = p; this.outputTokens = c; }
    }
    if (v.choices === undefined || v.choices === null) return '';
    if (!Array.isArray(v.choices)) throw malformed();
    if (!v.choices.length) return '';
    const c0: unknown = v.choices[0];
    if (!isObj(c0)) throw malformed();
    if (c0.delta === undefined || c0.delta === null) return '';
    if (!isObj(c0.delta)) throw malformed();
    const content = c0.delta.content;
    if (content === undefined || content === null) return '';
    if (typeof content !== 'string') throw malformed();
    return content;
  }
}

export interface CompatStreamRequest extends CloudStreamRequest {
  provider: CompatProvider;
}

/**
 * Streams one reply from an OpenAI-compatible provider. Mirrors streamCloudChat: one bearer header holds the key (never
 * logged or echoed), the same STREAM_LIMITS bounds, StreamAborted (with partial text) on cancel, StreamIncomplete when
 * [DONE] never arrives, status-only HTTP errors. Reading stops at [DONE].
 */
export async function streamOpenAiCompatibleChat(guardedFetch: GuardedFetch, req: CompatStreamRequest): Promise<StreamResult> {
  const limits: StreamLimits = {...STREAM_LIMITS, ...req.limits};
  const acc = {text: ''};
  if (req.provider !== 'openai' && req.provider !== 'openrouter') throw new CloudProviderError('Unknown cloud provider');
  if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
  let res: Response;
  try {
    res = await guardedFetch(chatUrlForProvider(req.provider, req.origin ?? originForProvider(req.provider)), {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${req.key}`},
      body: JSON.stringify({model: req.model, messages: req.messages, stream: true, max_tokens: Math.min(CLOUD_MAX_TOKENS, req.maxTokens ?? CLOUD_MAX_TOKENS), stream_options: {include_usage: true}}),
      signal: req.signal,
      timeoutMs: limits.totalMs,
    }, 'cloud-chat');
  } catch (e) {
    if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
    throw e;
  }
  if (!res.ok) throw await cloudHttpError(res, req.signal);
  req.onOpen?.();
  const sse = new SseParser(limits.lineChars);
  const seq = new OpenAiStreamValidator();
  let capped = false;
  const handle = (ev: SseEvent | null): boolean => {
    if (!ev) return false;
    const text = seq.accept(ev);
    if (text) {
      const kept = appendCapped(acc, text, limits.replyChars);
      if (kept) req.onDelta(kept);
      if (acc.text.length >= limits.replyChars) { capped = true; return true; }
    }
    return seq.done;
  };
  let ended = false;
  await pumpLines(res.body, new LineSplitter(limits), req.signal, limits.idleMs, (line) => (ended = handle(sse.line(line))), () => acc.text);
  if (!ended && !capped) handle(sse.flush());
  if (!seq.done && !capped) throw new StreamIncomplete(acc.text);
  if (!acc.text.trim()) throw new CloudProviderError('The cloud provider returned an empty reply');
  const usage = !capped && seq.inputTokens !== null && seq.outputTokens !== null ? {inputTokens: seq.inputTokens, outputTokens: seq.outputTokens, generationMs: null, promptMs: null} : null;
  return {text: acc.text, complete: true, truncated: capped, usage};
}

/** Dispatches one streamed reply to the adapter and origin of the chosen provider. Never tries another provider. */
export function streamProviderChat(provider: CloudProvider, guardedFetch: GuardedFetch, req: CloudStreamRequest): Promise<StreamResult> {
  if (provider === 'anthropic') return streamCloudChat(guardedFetch, {...req, origin: req.origin ?? ANTHROPIC_ORIGIN});
  if (provider === 'openai' || provider === 'openrouter') return streamOpenAiCompatibleChat(guardedFetch, {...req, provider});
  return Promise.reject(new CloudProviderError('Unknown cloud provider'));
}

export interface CloudStreamRequest {
  origin?: string;
  key: string;
  model: string;
  messages: {role: 'user' | 'assistant'; content: string}[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onOpen?: () => void;
  limits?: Partial<StreamLimits>;
  /** Lower output cap than CLOUD_MAX_TOKENS (the connection test asks for a few tokens); never higher. */
  maxTokens?: number;
}

/**
 * Status-only error. The provider's message text is never shown: it could echo request content, including the key header.
 * The body is drained up to a small bound and released so the connection is not held open.
 */
async function cloudHttpError(res: Response, signal: AbortSignal): Promise<Error> {
  await readBoundedText(res, 1024, signal);
  if (res.status === 401 || res.status === 403) return new CloudProviderError('The cloud provider rejected the API key');
  if (res.status === 429) return new CloudProviderError('The cloud provider is rate limiting requests (HTTP 429). Try again later');
  if (res.status === 529 || res.status === 503) return new CloudProviderError(`The cloud provider is overloaded right now (HTTP ${res.status}). Try again in a moment`);
  return new CloudProviderError(`Cloud provider returned HTTP ${res.status}`);
}

/** Streams one cloud reply. Throws StreamAborted / StreamIncomplete (with partial text) or a plain Error. */
export async function streamCloudChat(guardedFetch: GuardedFetch, req: CloudStreamRequest): Promise<StreamResult> {
  const limits: StreamLimits = {...STREAM_LIMITS, ...req.limits};
  const acc = {text: ''};
  if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
  let res: Response;
  try {
    res = await guardedFetch(`${req.origin ?? ANTHROPIC_ORIGIN}/v1/messages`, {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': req.key, 'anthropic-version': ANTHROPIC_STREAM_VERSION},
      body: JSON.stringify({model: req.model, max_tokens: Math.min(CLOUD_MAX_TOKENS, req.maxTokens ?? CLOUD_MAX_TOKENS), messages: req.messages, stream: true}),
      signal: req.signal,
      timeoutMs: limits.totalMs,
    }, 'cloud-chat');
  } catch (e) {
    if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
    throw e;
  }
  if (!res.ok) throw await cloudHttpError(res, req.signal);
  req.onOpen?.();
  const sse = new SseParser(limits.lineChars);
  const seq = new AnthropicStreamValidator();
  let capped = false;
  const handle = (ev: SseEvent | null): boolean => {
    if (!ev) return false;
    const text = seq.accept(ev);
    if (text) {
      const kept = appendCapped(acc, text, limits.replyChars);
      if (kept) req.onDelta(kept);
      if (acc.text.length >= limits.replyChars) { capped = true; return true; }
    }
    return seq.stopped;
  };
  let ended = false;
  await pumpLines(res.body, new LineSplitter(limits), req.signal, limits.idleMs, (line) => (ended = handle(sse.line(line))), () => acc.text);
  if (!ended && !capped) handle(sse.flush());
  if (!seq.stopped && !capped) throw new StreamIncomplete(acc.text);
  if (!acc.text.trim()) throw new CloudProviderError('The cloud provider returned an empty reply');
  const usage = !capped && seq.inputTokens !== null && seq.outputTokens !== null ? {inputTokens: seq.inputTokens, outputTokens: seq.outputTokens, generationMs: null, promptMs: null} : null;
  return {text: acc.text, complete: true, truncated: capped, usage};
}

/* ---------- Model availability (GET /v1/models) ---------- */

/** Most models listed for one provider; the rest are dropped rather than paged through. */
export const MAX_LISTED_MODELS = 60;
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

/** OpenAI lists embedding, audio and image models too; only chat-capable families are offered for the chat route. */
const OPENAI_CHAT_RE = /^(gpt-|chatgpt-|o[1-9](-|$))/i;

/**
 * Parses a provider's model list. Pure and bounded: only ids that pass the same character rule as the cloudModel
 * setting are kept, names are trimmed to 100 characters, and nothing from the response is executed or rendered as HTML.
 * Anthropic returns {data:[{id, display_name, created_at}]}; OpenAI returns {data:[{id, created}]}.
 */
export function parseModelList(provider: CloudProvider, body: unknown): CloudModelInfo[] {
  const data = body && typeof body === 'object' && Array.isArray((body as {data?: unknown}).data) ? (body as {data: unknown[]}).data : null;
  if (!data) throw new CloudProviderError('The provider returned a model list this app could not read');
  const out: CloudModelInfo[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    if (provider === 'openai' && !OPENAI_CHAT_RE.test(id)) continue;
    seen.add(id);
    const name = typeof r.display_name === 'string' && r.display_name.trim() ? r.display_name.trim().slice(0, 100) : id;
    const created = typeof r.created_at === 'string' ? r.created_at : typeof r.created === 'number' && Number.isFinite(r.created) ? new Date(r.created * 1000).toISOString() : undefined;
    out.push(created && !Number.isNaN(Date.parse(created)) ? {id, name, createdAt: new Date(created).toISOString()} : {id, name});
    if (out.length >= MAX_LISTED_MODELS) break;
  }
  // Newest first when the provider gives dates; otherwise the provider's own order is kept.
  return out.every((m) => m.createdAt) ? out.sort((a, b) => (b.createdAt as string).localeCompare(a.createdAt as string)) : out;
}

/**
 * Which listed Anthropic models say they accept images, from the Models API's own capabilities tree
 * (capabilities.image_input.supported). A model without that field is left out: unknown, not assumed either way.
 */
export function parseImageSupport(body: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const data = isObj(body) && Array.isArray(body.data) ? body.data : [];
  for (const r of data.slice(0, MAX_LISTED_MODELS * 4)) {
    if (!isObj(r) || typeof r.id !== 'string' || !MODEL_ID_RE.test(r.id.trim())) continue;
    const img = isObj(r.capabilities) && isObj(r.capabilities.image_input) ? r.capabilities.image_input.supported : undefined;
    if (typeof img === 'boolean') out.set(r.id.trim(), img);
  }
  return out;
}

/** Plain-language reason for a failed model list request, by HTTP status. */
export function modelListFailure(status: number): string {
  if (status === 401 || status === 403) return `The provider rejected the saved key (HTTP ${status}). Check the key or save a new one.`;
  if (status === 429) return 'The provider is rate limiting this key (HTTP 429). Wait a moment and check again.';
  if (status >= 500) return `The provider had a problem answering (HTTP ${status}). Try again later.`;
  return `The provider did not return a model list (HTTP ${status}).`;
}

// ---------- One non-streaming Messages request, for the companion's tool loop ----------

/** Content blocks the companion sends. The model's own blocks (text, tool_use, thinking, …) are sent back unchanged. */
export type AnthropicImageBlock = {type: 'image'; source: {type: 'base64'; media_type: 'image/png' | 'image/jpeg'; data: string}};
export type AnthropicTextBlock = {type: 'text'; text: string};
export type AnthropicToolResultBlock = {type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean};
export type AnthropicToolUseBlock = {type: 'tool_use'; id: string; name: string; input: Record<string, unknown>};
/** Any block the model returned. Kept as received so the next request can replay it exactly (thinking blocks included). */
export type AnthropicResponseBlock = AnthropicToolUseBlock | AnthropicTextBlock | ({type: string} & Record<string, unknown>);
export type AnthropicMessageParam =
  | {role: 'user'; content: (AnthropicTextBlock | AnthropicImageBlock | AnthropicToolResultBlock)[]}
  | {role: 'assistant'; content: AnthropicResponseBlock[]};
export type AnthropicToolDef = {name: string; description: string; input_schema: Record<string, unknown>};
export type AnthropicMessageBody = {model: string; max_tokens: number; system: string; tools: AnthropicToolDef[]; messages: AnthropicMessageParam[]};
export type AnthropicMessageResult = {content: AnthropicResponseBlock[]; stopReason: string; inputTokens: number | null; outputTokens: number | null};

/** Output budget for one companion step. Current models think before answering and that thinking counts towards it. */
export const AGENT_MAX_TOKENS = 16000;
/** A complete Messages response is read up to this many bytes (images are only ever sent, never returned). */
export const AGENT_RESPONSE_MAX_BYTES = 2_000_000;

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Validates a parsed Messages response. Returns the blocks as received (so they can be replayed), with tool_use blocks
 * checked for a usable id, a known-shape name and an object input. Anything else malformed is a protocol error.
 */
export function parseAnthropicMessage(v: unknown): AnthropicMessageResult {
  const bad = () => new StreamProtocolError('The provider sent a malformed reply');
  if (!isObj(v) || v.type !== 'message' || !Array.isArray(v.content) || typeof v.stop_reason !== 'string') throw bad();
  if (v.content.length > 64) throw bad();
  const content: AnthropicResponseBlock[] = [];
  for (const b of v.content) {
    if (!isObj(b) || typeof b.type !== 'string') throw bad();
    if (b.type === 'text' && typeof b.text !== 'string') throw bad();
    if (b.type === 'tool_use' && (typeof b.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(b.id) || typeof b.name !== 'string' || !TOOL_NAME_RE.test(b.name) || !isObj(b.input))) throw bad();
    content.push(b as AnthropicResponseBlock);
  }
  const u = isObj(v.usage) ? v.usage : {};
  return {content, stopReason: v.stop_reason.slice(0, 40), inputTokens: tokenCount(u.input_tokens), outputTokens: tokenCount(u.output_tokens)};
}

/**
 * Sends one Messages request (no streaming) through the guarded fetch: online mode, stored key, the exact /v1/messages
 * path and only the x-api-key credential header, as for chat. Errors are status-only; provider text is never echoed.
 */
export async function createAnthropicMessage(guardedFetch: GuardedFetch, req: {origin?: string; key: string; body: AnthropicMessageBody; signal: AbortSignal; timeoutMs?: number}): Promise<AnthropicMessageResult> {
  if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
  let res: Response;
  try {
    res = await guardedFetch(`${req.origin ?? ANTHROPIC_ORIGIN}/v1/messages`, {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'application/json', 'x-api-key': req.key, 'anthropic-version': ANTHROPIC_STREAM_VERSION},
      body: JSON.stringify(req.body),
      signal: req.signal,
      timeoutMs: req.timeoutMs ?? 180_000,
    }, 'cloud-chat');
  } catch (e) {
    if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
    throw e;
  }
  if (!res.ok) throw await cloudHttpError(res, req.signal);
  const raw = await readBoundedText(res, AGENT_RESPONSE_MAX_BYTES, req.signal, 30_000);
  if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new StreamProtocolError('The provider sent a malformed reply'); }
  return parseAnthropicMessage(parsed);
}

/**
 * The same Messages request as createAnthropicMessage, streamed. Content blocks are rebuilt from the event stream exactly
 * as the provider sent them (text, tool_use with its JSON input, thinking with its signature, and any other block type
 * kept whole), then checked by parseAnthropicMessage, so the caller gets the same result shape and can replay it.
 * onText receives text as it arrives; nothing else from the stream reaches the caller before the reply is complete.
 * Bounds: STREAM_LIMITS (line, body bytes, idle gap) and the total timeout; errors are status-only as above.
 */
export async function streamAnthropicMessage(guardedFetch: GuardedFetch, req: {origin?: string; key: string; body: AnthropicMessageBody; signal: AbortSignal; onText?: (text: string) => void; limits?: Partial<StreamLimits>}): Promise<AnthropicMessageResult> {
  const limits: StreamLimits = {...STREAM_LIMITS, ...req.limits};
  if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
  let res: Response;
  try {
    res = await guardedFetch(`${req.origin ?? ANTHROPIC_ORIGIN}/v1/messages`, {
      method: 'POST',
      headers: {'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': req.key, 'anthropic-version': ANTHROPIC_STREAM_VERSION},
      body: JSON.stringify({...req.body, stream: true}),
      signal: req.signal,
      timeoutMs: limits.totalMs,
    }, 'cloud-chat');
  } catch (e) {
    if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
    throw e;
  }
  if (!res.ok) throw await cloudHttpError(res, req.signal);
  const sse = new SseParser(limits.lineChars);
  const seq = new AnthropicStreamValidator();
  const acc = new MessageAccumulator();
  const shown = {text: ''};
  const handle = (ev: SseEvent | null): boolean => {
    if (!ev) return false;
    const text = seq.accept(ev);
    acc.accept(ev.data);
    if (text && req.onText) {
      const kept = appendCapped(shown, text, limits.replyChars);
      if (kept) req.onText(kept);
    }
    return seq.stopped;
  };
  let ended = false;
  try {
    await pumpLines(res.body, new LineSplitter(limits), req.signal, limits.idleMs, (line) => (ended = handle(sse.line(line))), () => shown.text);
  } catch (e) {
    if (req.signal.aborted) throw new StreamAborted(shown.text, req.signal.reason);
    throw e;
  }
  if (!ended) handle(sse.flush());
  if (!seq.stopped) throw new StreamIncomplete(shown.text);
  const out = parseAnthropicMessage(acc.message());
  return {...out, inputTokens: seq.inputTokens, outputTokens: seq.outputTokens};
}

/** Rebuilds the Messages content blocks from validated stream events (the validator has already checked the order). */
export class MessageAccumulator {
  private blocks: Record<string, unknown>[] = [];
  private json: string[] = [];
  private stop: string | null = null;
  accept(data: string): void {
    const v = JSON.parse(data) as Record<string, unknown>;
    const bad = () => new StreamProtocolError('The provider sent a malformed stream event');
    switch (v.type) {
      case 'content_block_start': {
        const b = v.content_block as Record<string, unknown>;
        const copy: Record<string, unknown> = {...b};
        // tool_use and server tool blocks start with an empty input that input_json_delta fills in.
        if (b.type === 'tool_use' || b.type === 'server_tool_use') copy.input = {};
        this.blocks.push(copy);
        this.json.push('');
        return;
      }
      case 'content_block_delta': {
        const i = this.blocks.length - 1;
        const b = this.blocks[i];
        const d = v.delta as Record<string, unknown>;
        if (!b || !isObj(d)) throw bad();
        if (d.type === 'text_delta' && typeof d.text === 'string' && b.type === 'text') b.text = String(b.text ?? '') + d.text;
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') this.json[i] += d.partial_json;
        else if (d.type === 'thinking_delta' && typeof d.thinking === 'string' && b.type === 'thinking') b.thinking = String(b.thinking ?? '') + d.thinking;
        else if (d.type === 'signature_delta' && typeof d.signature === 'string') b.signature = d.signature;
        else if (d.type === 'citations_delta' && isObj(d.citation)) b.citations = [...(Array.isArray(b.citations) ? b.citations : []), d.citation];
        else throw bad();
        return;
      }
      case 'content_block_stop': {
        const i = this.blocks.length - 1;
        const b = this.blocks[i];
        if (!b) throw bad();
        if ((b.type === 'tool_use' || b.type === 'server_tool_use') && this.json[i]) {
          // A tool input that is not one complete JSON object is never run: it is a protocol error, not a guess.
          let input: unknown;
          try { input = JSON.parse(this.json[i]); } catch { throw bad(); }
          if (!isObj(input)) throw bad();
          b.input = input;
        }
        return;
      }
      case 'message_delta': {
        const d = v.delta;
        if (isObj(d) && typeof d.stop_reason === 'string') this.stop = d.stop_reason;
        return;
      }
      default: return;
    }
  }
  message(): unknown {
    return {type: 'message', content: this.blocks, stop_reason: this.stop};
  }
}
