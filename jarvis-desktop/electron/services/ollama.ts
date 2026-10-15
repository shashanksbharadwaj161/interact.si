// Streaming local chat (Ollama NDJSON over the loopback endpoint) plus the bounded byte → line framing shared with cloud.ts.
// Every request goes through the injected GuardedFetch; nothing here opens a connection on its own.
// Limits are hard: oversized lines, oversized bodies, invalid UTF-8 and malformed JSON fail the stream; reading stops (and the body is cancelled) at the end marker.
import type {GuardedFetch} from './netGuard';
import {parseOllamaMetrics} from './usage';

export const STREAM_LIMITS = {
  /** Longest single NDJSON line or SSE line, in characters. */
  lineChars: 256 * 1024,
  /** Total bytes accepted from one streamed response. */
  bodyBytes: 8 * 1024 * 1024,
  /** Reply text kept (matches the one-shot chat cap). */
  replyChars: 60_000,
  /** A stream that delivers nothing for this long is abandoned (a cold model load can take tens of seconds). */
  idleMs: 120_000,
  /** Absolute cap on one streamed request, enforced by GuardedFetch's timeout. */
  totalMs: 10 * 60_000,
} as const;

export type StreamLimits = {lineChars: number; bodyBytes: number; replyChars: number; idleMs: number; totalMs: number};

/** Token counts the provider reported. Null fields were not reported and are never guessed. */
export interface StreamUsage {inputTokens: number; outputTokens: number; generationMs: number | null; promptMs: number | null}

export interface StreamResult {
  text: string;
  /** True when the provider sent its end marker, or when the reply was cut at the local cap (then truncated is true). */
  complete: boolean;
  /** True when Desktop Companion stopped reading at replyChars: the provider may have had more to say. Never reported as a natural end. */
  truncated: boolean;
  /** Null when the provider did not report both token counts. */
  usage: StreamUsage | null;
}

/** Thrown when the stream itself is unsafe or malformed. The message is user-safe and never includes headers or keys. */
export class StreamProtocolError extends Error {
  override name = 'StreamProtocolError';
}

/** Raised when the caller's signal aborted. partial is the text that arrived before. */
export class StreamAborted extends Error {
  override name = 'StreamAborted';
  constructor(readonly partial: string, readonly reason: unknown) { super('The stream was stopped'); }
}

/** Raised when the body ended (or idled out) before the end marker. partial is the text that arrived before. */
export class StreamIncomplete extends Error {
  override name = 'StreamIncomplete';
  constructor(readonly partial: string, readonly idle = false) { super(idle ? 'No data from the server' : 'The connection ended before the reply was finished'); }
}

/**
 * Incremental UTF-8 → line splitter with hard caps. Multi-byte characters split across chunks are reassembled;
 * invalid UTF-8 (including a truncated final character) is a protocol error, not replacement characters.
 */
export class LineSplitter {
  private dec = new TextDecoder('utf-8', {fatal: true});
  private buf = '';
  private bytes = 0;
  constructor(private limits: Pick<StreamLimits, 'lineChars' | 'bodyBytes'> = STREAM_LIMITS) {}

  push(chunk: Uint8Array): string[] {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.limits.bodyBytes) throw new StreamProtocolError('The server sent more data than allowed');
    let text: string;
    try { text = this.dec.decode(chunk, {stream: true}); } catch { throw new StreamProtocolError('The server sent invalid UTF-8 text'); }
    return this.split(this.buf + text);
  }

  /** Flushes the decoder at end of body. A dangling partial line is returned as the last line. */
  end(): string[] {
    let text: string;
    try { text = this.dec.decode(); } catch { throw new StreamProtocolError('The server sent invalid UTF-8 text'); }
    const lines = this.split(this.buf + text);
    const rest = this.buf;
    this.buf = '';
    return rest ? [...lines, rest] : lines;
  }

  private split(s: string): string[] {
    const out: string[] = [];
    let start = 0, nl: number;
    while ((nl = s.indexOf('\n', start)) >= 0) {
      const line = s.slice(start, nl);
      if (line.length > this.limits.lineChars + 1) throw new StreamProtocolError('The server sent an oversized stream line');
      out.push(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = nl + 1;
    }
    this.buf = s.slice(start);
    if (this.buf.length > this.limits.lineChars) throw new StreamProtocolError('The server sent an oversized stream line');
    return out;
  }
}

/**
 * Reads a response body through a LineSplitter and hands each line to onLine. Returns normally only at end of body.
 * Aborting `signal` cancels the reader. If no chunk arrives for idleMs the body is cancelled and StreamIncomplete(idle) thrown.
 * onLine returning true stops reading (the end marker was seen) and cancels the rest of the body.
 */
export async function pumpLines(body: ReadableStream<Uint8Array> | null, splitter: LineSplitter, signal: AbortSignal, idleMs: number, onLine: (line: string) => boolean | void, partial: () => string): Promise<void> {
  if (!body) throw new StreamIncomplete(partial());
  const reader = body.getReader();
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { void reader.cancel().catch(() => undefined); };
  const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { idle = true; stop(); }, idleMs); };
  signal.addEventListener('abort', stop, {once: true});
  arm();
  try {
    for (;;) {
      if (signal.aborted) throw new StreamAborted(partial(), signal.reason);
      let r: ReadableStreamReadResult<Uint8Array>;
      try { r = await reader.read(); } catch (e) {
        if (signal.aborted) throw new StreamAborted(partial(), signal.reason);
        if (idle) throw new StreamIncomplete(partial(), true);
        throw e;
      }
      // Cancelling the reader makes read() report a normal end; that must never look like a finished reply.
      if (signal.aborted) throw new StreamAborted(partial(), signal.reason);
      if (idle) throw new StreamIncomplete(partial(), true);
      if (r.done) break;
      arm();
      if (!(r.value instanceof Uint8Array)) throw new StreamProtocolError('The server sent a non-binary chunk');
      for (const line of splitter.push(r.value)) if (onLine(line) === true) return;
    }
    for (const line of splitter.end()) if (onLine(line) === true) return;
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    stop();
  }
}

/** Accumulates reply text up to the cap. Returns the piece actually kept (possibly empty). */
export function appendCapped(acc: {text: string}, piece: string, cap: number): string {
  const kept = piece.slice(0, Math.max(0, cap - acc.text.length));
  acc.text += kept;
  return kept;
}

/** Validates one parsed Ollama /api/chat stream frame. Returns the text delta and whether this is the final frame. */
export function parseOllamaFrame(v: unknown): {delta: string; done: boolean; metrics: unknown} {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StreamProtocolError('Ollama sent a malformed stream frame');
  const f = v as Record<string, unknown>;
  if (f.error !== undefined) throw new StreamProtocolError(`Ollama reported: ${String(f.error).replace(/\s+/g, ' ').slice(0, 160)}`);
  if (f.done !== undefined && typeof f.done !== 'boolean') throw new StreamProtocolError('Ollama sent a malformed stream frame');
  let delta = '';
  if (f.message !== undefined) {
    const m = f.message as Record<string, unknown> | null;
    if (!m || typeof m !== 'object' || (m.content !== undefined && typeof m.content !== 'string')) throw new StreamProtocolError('Ollama sent a malformed stream frame');
    delta = typeof m.content === 'string' ? m.content : '';
  }
  return {delta, done: f.done === true, metrics: f.done === true ? f : undefined};
}

function metricsOrNull(raw: unknown): StreamUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.prompt_eval_count === undefined || r.eval_count === undefined) return null;
  try { return parseOllamaMetrics(raw); } catch { return null; }
}

export interface OllamaStreamRequest {
  endpoint: string;
  model: string;
  messages: {role: 'user' | 'assistant'; content: string}[];
  keepAlive: string;
  numCtx: number | null;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /** Called once when the HTTP response arrived and is OK. */
  onOpen?: () => void;
  limits?: Partial<StreamLimits>;
}

/**
 * Reads at most maxBytes of a response body as text, then cancels the rest. Never throws; the body is always released.
 * Used only for error bodies, which must not be read without a bound.
 */
export async function readBoundedText(res: Response, maxBytes = 4096, signal?: AbortSignal, readMs = 2000): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', stop, {once: true});
  // Absolute deadline: a provider trickling error bytes must not extend the read indefinitely.
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
    timer = setTimeout(() => { stop(); resolve({done: true, value: undefined}); }, readMs);
  });
  try {
    while (total < maxBytes && !signal?.aborted) {
      const {done, value} = await Promise.race([reader.read(), deadline]);
      if (done || !(value instanceof Uint8Array)) break;
      const take = value.subarray(0, maxBytes - total);
      parts.push(take);
      total += take.byteLength;
    }
  } catch { /* a broken error body is just missing detail */ } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    stop();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { buf.set(p, off); off += p.byteLength; }
  return new TextDecoder('utf-8', {fatal: false}).decode(buf);
}

/** Ollama's HTTP error as user-safe text (loopback only, no credentials involved). 404 means the model is not installed. */
async function ollamaHttpError(res: Response, model: string): Promise<Error> {
  const raw = await readBoundedText(res);
  if (res.status === 404) return new Error(`Model "${model}" is not installed in Ollama. Install it once with "ollama pull ${model}" or choose an installed model in Settings`);
  let detail = '';
  try {
    const j = JSON.parse(raw) as {error?: unknown};
    if (typeof j.error === 'string') detail = j.error.replace(/\s+/g, ' ').slice(0, 160);
  } catch { /* body is not JSON (or was cut at the bound): status alone */ }
  return new Error(`Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
}

/** Streams one local chat reply. Throws StreamAborted / StreamIncomplete (with partial text) or a plain Error. */
export async function streamOllamaChat(guardedFetch: GuardedFetch, req: OllamaStreamRequest): Promise<StreamResult> {
  const limits: StreamLimits = {...STREAM_LIMITS, ...req.limits};
  const acc = {text: ''};
  if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
  const body = JSON.stringify({
    model: req.model, messages: req.messages, stream: true, keep_alive: req.keepAlive,
    ...(req.numCtx ? {options: {num_ctx: req.numCtx}} : {}),
  });
  let res: Response;
  try {
    res = await guardedFetch(`${req.endpoint}/api/chat`, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: req.signal, timeoutMs: limits.totalMs}, 'ollama');
  } catch (e) {
    if (req.signal.aborted) throw new StreamAborted('', req.signal.reason);
    throw e;
  }
  if (!res.ok) throw await ollamaHttpError(res, req.model);
  req.onOpen?.();
  let complete = false, truncated = false, usage: StreamUsage | null = null;
  await pumpLines(res.body, new LineSplitter(limits), req.signal, limits.idleMs, (line) => {
    if (!line.trim()) return;
    let v: unknown;
    try { v = JSON.parse(line); } catch { throw new StreamProtocolError('Ollama sent a malformed stream line'); }
    const frame = parseOllamaFrame(v);
    if (frame.delta) {
      const kept = appendCapped(acc, frame.delta, limits.replyChars);
      if (kept) req.onDelta(kept);
      if (acc.text.length >= limits.replyChars && !frame.done) { complete = true; truncated = true; return true; }
    }
    if (frame.done) { complete = true; usage = metricsOrNull(frame.metrics); return true; }
  }, () => acc.text);
  if (!complete) throw new StreamIncomplete(acc.text);
  if (!acc.text.trim()) throw new Error('Ollama returned an empty reply');
  return {text: acc.text, complete, truncated, usage};
}
