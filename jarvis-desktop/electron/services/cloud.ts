// Optional cloud chat streaming (Anthropic Messages API, server-sent events). Only ever reached when the user chose online
// mode and stored a key; the request goes through GuardedFetch (purpose 'cloud-chat'), which re-checks mode, key and origin.
// The key is placed in one request header and is never logged, echoed in errors or returned.
import type {GuardedFetch} from './netGuard';
import {ANTHROPIC_ORIGIN, chatUrlForProvider, originForProvider, type CompatProvider} from './netGuard';
import type {CloudProvider} from '../../src/shared/contracts';

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
      body: JSON.stringify({model: req.model, messages: req.messages, stream: true, max_tokens: CLOUD_MAX_TOKENS, stream_options: {include_usage: true}}),
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
}

/**
 * Status-only error. The provider's message text is never shown: it could echo request content, including the key header.
 * The body is drained up to a small bound and released so the connection is not held open.
 */
async function cloudHttpError(res: Response, signal: AbortSignal): Promise<Error> {
  await readBoundedText(res, 1024, signal);
  if (res.status === 401 || res.status === 403) return new CloudProviderError('The cloud provider rejected the API key');
  if (res.status === 429) return new CloudProviderError('The cloud provider is rate limiting requests (HTTP 429). Try again later');
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
      body: JSON.stringify({model: req.model, max_tokens: CLOUD_MAX_TOKENS, messages: req.messages, stream: true}),
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
