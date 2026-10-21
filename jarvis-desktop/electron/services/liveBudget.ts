// Bounded live-provider testing, enforced in the main process for every request that leaves the computer.
//
// Opt-in only: main.ts reads DESKTOP_COMPANION_LIVE_TEST (a JSON object, no secrets) at start-up. Without it nothing
// here is active and production behaviour is unchanged. With it, every provider POST (Anthropic Messages, OpenAI and
// OpenRouter chat completions; island, hub chat and the connection test alike) passes through LiveBudget.admit first:
// - the output cap is written into the request (max_tokens / max_completion_tokens never exceed maxOutputTokens);
// - the request's text is bounded (maxBodyChars, image data excluded) and at most one image is allowed;
// - a worst-case cost is reserved BEFORE sending: estimated input tokens (characters / 3, plus a fixed allowance per
//   image) at the configured input price, plus the full output cap at the output price. The reservation is never
//   refunded, so the real spend stays below the ceiling even when the provider counts tokens differently;
// - the request count and the reserved total are written to <userData>/live-test-budget.json before the request is
//   sent, keyed by budgetId, so restarting the app does not reset the ceiling;
// - once a request would go over maxRequests or maxReservedUsd, it is refused without contacting the provider.
// The companion also uses maxSteps and makes no automatic retry while the budget is active (backend.ts).
// Costs are estimates from the prices in the configuration, not provider invoices.

import {promises as fsp} from 'node:fs';

export type LiveTestConfig = {
  budgetId: string;
  /** The one model the test may call; it must be in MODEL_PRICE_FLOOR. Requests for any other model are refused. */
  model: string;
  maxOutputTokens: number;
  maxSteps: number;
  maxBodyChars: number;
  maxRequests: number;
  maxReservedUsd: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

export const LIVE_TEST_ENV = 'DESKTOP_COMPANION_LIVE_TEST';
/**
 * Upper bound per image block. Anthropic documents at most 4784 image tokens per image on its high-resolution models
 * (2576 px edge); this app sends at most 1568 px, which is less. Rounded up.
 */
export const IMAGE_TOKEN_ALLOWANCE = 4800;
/** Fixed allowance per request for tokens the provider adds that are not in the body (tool-use framing, roles). */
export const REQUEST_OVERHEAD_TOKENS = 2048;
/**
 * Minimum USD prices per million tokens (input / output) for the models a live test may use, from Anthropic's model
 * documentation as bundled with the claude-api reference (October 2026). For Claude Haiku 5.5 the higher long-prompt
 * card is used. A configuration with lower prices, or with a model not listed here, is refused: an unknown model is
 * never silently under-priced. Check the provider's pricing page before a run; raise these numbers if it changed.
 */
export const MODEL_PRICE_FLOOR: Readonly<Record<string, {input: number; output: number}>> = {
  'claude-haiku-4-5': {input: 1, output: 5},
  'claude-haiku-5-5': {input: 0.5, output: 2.5},
  'claude-sonnet-4-6': {input: 3, output: 15},
  'claude-sonnet-5': {input: 2, output: 10},
  'claude-sonnet-5-5': {input: 2, output: 10},
  'claude-opus-4-8': {input: 5, output: 25},
  'claude-opus-5': {input: 5, output: 25},
  'claude-opus-5-5': {input: 4, output: 20},
  'claude-fable-5': {input: 10, output: 50},
  'claude-fable-5-1': {input: 10, output: 50},
};
/** Images per request in live-test mode (the companion sends at most one screen area). */
export const MAX_IMAGES_PER_REQUEST = 1;
const KEYS = ['budgetId', 'model', 'maxOutputTokens', 'maxSteps', 'maxBodyChars', 'maxRequests', 'maxReservedUsd', 'inputPerMillionUsd', 'outputPerMillionUsd'] as const;

export class LiveBudgetError extends Error { override name = 'LiveBudgetError'; }

/** Strict parse: unknown keys, missing keys or out-of-range values are errors (the caller then blocks all provider calls). */
export function parseLiveTestConfig(raw: string): LiveTestConfig {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new LiveBudgetError('The live-test configuration is not valid JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new LiveBudgetError('The live-test configuration must be a JSON object');
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length) throw new LiveBudgetError(`Unknown live-test settings: ${extra.slice(0, 5).join(', ')}`);
  const int = (k: string, lo: number, hi: number) => {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) throw new LiveBudgetError(`${k} must be a whole number from ${lo} to ${hi}`);
    return n;
  };
  const num = (k: string, lo: number, hi: number) => {
    const n = o[k];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw new LiveBudgetError(`${k} must be a number from ${lo} to ${hi}`);
    return n;
  };
  if (typeof o.budgetId !== 'string' || !/^[a-z0-9-]{1,40}$/.test(o.budgetId)) throw new LiveBudgetError('budgetId must be 1 to 40 lowercase letters, digits or -');
  if (typeof o.model !== 'string' || !Object.prototype.hasOwnProperty.call(MODEL_PRICE_FLOOR, o.model)) throw new LiveBudgetError(`model must be one of ${Object.keys(MODEL_PRICE_FLOOR).join(', ')}`);
  const floor = MODEL_PRICE_FLOOR[o.model];
  const cfg: LiveTestConfig = {
    budgetId: o.budgetId,
    model: o.model,
    maxOutputTokens: int('maxOutputTokens', 1, 1024),
    maxSteps: int('maxSteps', 1, 5),
    maxBodyChars: int('maxBodyChars', 200, 4_000_000),
    maxRequests: int('maxRequests', 1, 500),
    maxReservedUsd: num('maxReservedUsd', 0.01, 20),
    // Prices are required: without them no dollar ceiling could be enforced.
    inputPerMillionUsd: num('inputPerMillionUsd', 0.01, 1000),
    outputPerMillionUsd: num('outputPerMillionUsd', 0.01, 1000),
  };
  if (cfg.inputPerMillionUsd < floor.input || cfg.outputPerMillionUsd < floor.output) {
    throw new LiveBudgetError(`Prices for ${cfg.model} must be at least $${floor.input} input and $${floor.output} output per million tokens`);
  }
  return cfg;
}

export type LiveLedger = {budgetId: string; requests: number; reservedUsd: number};
/** `load` resolves `{missing: true}` only when the ledger file certainly does not exist yet; every other failure throws. */
export interface LiveLedgerStore { load(): Promise<{missing: true} | {missing: false; value: unknown}>; save(l: LiveLedger): Promise<void> }

/** The ledger file for one budget id, written atomically (temporary file, then rename). */
export function createLedgerFile(dir: string, budgetId: string, fs: {readFile: (f: string, e: 'utf8') => Promise<string>; writeFile: (f: string, d: string, o: {encoding: 'utf8'; mode: number}) => Promise<void>; rename: (a: string, b: string) => Promise<void>} = nodeFsPromises()): LiveLedgerStore {
  const file = `${dir.replace(/[\\/]+$/, '')}/live-test-budget-${budgetId}.json`;
  return {
    async load() {
      let text: string;
      try { text = await fs.readFile(file, 'utf8'); } catch (e) {
        if ((e as {code?: string}).code === 'ENOENT') return {missing: true};
        throw new LiveBudgetError('Live-test mode: the budget ledger could not be read, so no provider request is sent');
      }
      try { return {missing: false, value: JSON.parse(text) as unknown}; } catch { throw new LiveBudgetError('Live-test mode: the budget ledger is damaged, so no provider request is sent'); }
    },
    async save(l) {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(l), {encoding: 'utf8', mode: 0o600});
      await fs.rename(tmp, file);
    },
  };
}
function nodeFsPromises() {
  return {readFile: (f: string, e: 'utf8') => fsp.readFile(f, e), writeFile: (f: string, d: string, o: {encoding: 'utf8'; mode: number}) => fsp.writeFile(f, d, o), rename: (a: string, b: string) => fsp.rename(a, b)};
}

/** A stored ledger must be exactly {budgetId, requests, reservedUsd} for this budget, with sane counters. */
export function parseLedger(v: unknown, budgetId: string): LiveLedger {
  const bad = () => new LiveBudgetError('Live-test mode: the budget ledger is damaged, so no provider request is sent');
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(',') !== 'budgetId,requests,reservedUsd') throw bad();
  if (o.budgetId !== budgetId) throw bad();
  if (typeof o.requests !== 'number' || !Number.isSafeInteger(o.requests) || o.requests < 0) throw bad();
  if (typeof o.reservedUsd !== 'number' || !Number.isFinite(o.reservedUsd) || o.reservedUsd < 0) throw bad();
  return {budgetId, requests: o.requests, reservedUsd: o.reservedUsd};
}

/**
 * Upper bound on input tokens for a JSON request body: the UTF-8 byte count of everything except image data (a token
 * covers at least one byte, so no tokenizer yields more tokens than bytes), plus a fixed per-request overhead, plus
 * IMAGE_TOKEN_ALLOWANCE per image block.
 */
export function estimateInputTokens(body: string): {tokens: number; images: number; textChars: number; textBytes: number} {
  // Image data is base64 inside "data":"…"; count those blocks and leave their bytes out of the text estimate.
  let images = 0;
  const text = body.replace(/"type"\s*:\s*"base64"\s*,\s*"media_type"\s*:\s*"image\/(?:png|jpeg)"\s*,\s*"data"\s*:\s*"[A-Za-z0-9+/=]*"/g, () => { images++; return ''; })
    .replace(/"image_url"\s*:\s*\{\s*"url"\s*:\s*"data:[^"]*"/g, () => { images++; return ''; });
  const textBytes = Buffer.byteLength(text, 'utf8');
  return {tokens: textBytes + REQUEST_OVERHEAD_TOKENS + images * IMAGE_TOKEN_ALLOWANCE, images, textChars: text.length, textBytes};
}

export class LiveBudget {
  private ledger: LiveLedger;
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(readonly config: LiveTestConfig, private readonly store: LiveLedgerStore, ledger: LiveLedger) { this.ledger = ledger; }

  /**
   * Opens the ledger. Only a confirmed first use (no file) starts at zero; a read failure or a damaged, foreign or
   * malformed ledger throws, and the caller then blocks every provider request (never restarts the ceiling).
   */
  static async open(config: LiveTestConfig, store: LiveLedgerStore): Promise<LiveBudget> {
    const r = await store.load();
    const ledger = r.missing ? {budgetId: config.budgetId, requests: 0, reservedUsd: 0} : parseLedger(r.value, config.budgetId);
    return new LiveBudget(config, store, ledger);
  }

  get spent(): LiveLedger { return {...this.ledger}; }
  remainingUsd(): number { return Math.max(0, this.config.maxReservedUsd - this.ledger.reservedUsd); }

  /**
   * Checks and rewrites one outgoing provider request. Resolves with the body to send (output cap applied) after the
   * reservation is saved; throws LiveBudgetError (nothing sent) when any limit would be exceeded or the body is unreadable.
   */
  admit(url: string, method: string, body: unknown): Promise<string | undefined> {
    const run = this.chain.then(() => this.admitNow(url, method, body));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async admitNow(url: string, method: string, body: unknown): Promise<string | undefined> {
    if (method.toUpperCase() !== 'POST') return typeof body === 'string' ? body : undefined;
    if (typeof body !== 'string') throw new LiveBudgetError('Live-test mode: only JSON provider requests are allowed');
    const c = this.config;
    // A hard ceiling on the raw body too (images included), far above one screen area.
    if (body.length > 8_000_000) throw new LiveBudgetError('Live-test mode: the request is too large. Nothing was sent');
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { throw new LiveBudgetError('Live-test mode: the request body could not be read. Nothing was sent'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LiveBudgetError('Live-test mode: unexpected request body. Nothing was sent');
    // Only the configured, priced model: an unpriced model would make the ceiling meaningless.
    if (parsed.model !== c.model) throw new LiveBudgetError(`Live-test mode: only ${c.model} may be called (this request asked for ${String(parsed.model).slice(0, 60)}). Nothing was sent`);
    // The output cap is enforced here, whatever the caller asked for.
    const asked = [parsed.max_tokens, parsed.max_completion_tokens].filter((x): x is number => typeof x === 'number');
    const cap = Math.min(c.maxOutputTokens, ...(asked.length ? asked : [c.maxOutputTokens]));
    if ('max_completion_tokens' in parsed) parsed.max_completion_tokens = cap;
    else parsed.max_tokens = cap;
    // Extended thinking would spend output tokens beyond what the cap allows a reply to show; it is never sent here.
    delete parsed.thinking;
    const out = JSON.stringify(parsed);
    const est = estimateInputTokens(out);
    if (est.textChars > c.maxBodyChars) throw new LiveBudgetError(`Live-test mode: the request has ${est.textChars} characters of text; the limit is ${c.maxBodyChars}. Nothing was sent`);
    if (est.images > MAX_IMAGES_PER_REQUEST) throw new LiveBudgetError(`Live-test mode: at most ${MAX_IMAGES_PER_REQUEST} image per request. Nothing was sent`);
    const input = est.tokens;
    const cost = (input * c.inputPerMillionUsd + cap * c.outputPerMillionUsd) / 1_000_000;
    if (this.ledger.requests + 1 > c.maxRequests) throw new LiveBudgetError(`Live-test mode: the request limit (${c.maxRequests}) is reached. Nothing was sent`);
    if (this.ledger.reservedUsd + cost > c.maxReservedUsd + 1e-9) {
      throw new LiveBudgetError(`Live-test mode: this request could cost up to $${cost.toFixed(4)} (estimate) and only $${this.remainingUsd().toFixed(4)} of the $${c.maxReservedUsd.toFixed(2)} ceiling is left. Nothing was sent`);
    }
    const next = {budgetId: c.budgetId, requests: this.ledger.requests + 1, reservedUsd: this.ledger.reservedUsd + cost};
    // Saved before sending: if saving fails, the request is not sent.
    try { await this.store.save(next); } catch { throw new LiveBudgetError('Live-test mode: the budget ledger could not be saved, so nothing was sent'); }
    this.ledger = next;
    void url;
    return out;
  }
}

type FetchLike<P extends string> = (url: string, init: (RequestInit & {timeoutMs?: number}) | undefined, purpose: P) => Promise<Response>;

/** Wraps a guarded fetch so provider-bound requests pass through the budget first. Loopback model traffic is untouched. */
export function withLiveBudget<P extends string>(fetchFn: FetchLike<P>, budget: LiveBudget | null, blocked: string | null): FetchLike<P> {
  if (!budget && !blocked) return fetchFn;
  return async (url, init = {}, purpose) => {
    // Loopback model traffic and account sign-in are not model calls.
    if (purpose === 'ollama' || purpose === 'oauth') return fetchFn(url, init, purpose);
    if (blocked) throw new LiveBudgetError(`Live-test mode is misconfigured (${blocked}); no provider request is sent`);
    const body = await budget!.admit(url, init.method ?? 'GET', init.body);
    return fetchFn(url, body === undefined ? init : {...init, body}, purpose);
  };
}
