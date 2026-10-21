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

export type LiveTestConfig = {
  budgetId: string;
  maxOutputTokens: number;
  maxSteps: number;
  maxBodyChars: number;
  maxRequests: number;
  maxReservedUsd: number;
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
};

export const LIVE_TEST_ENV = 'DESKTOP_COMPANION_LIVE_TEST';
/** Allowance per image block: above the provider's per-image token count at the 1568 px edge this app sends. */
export const IMAGE_TOKEN_ALLOWANCE = 3300;
/** Images per request in live-test mode (the companion sends at most one screen area). */
export const MAX_IMAGES_PER_REQUEST = 1;
const KEYS = ['budgetId', 'maxOutputTokens', 'maxSteps', 'maxBodyChars', 'maxRequests', 'maxReservedUsd', 'inputPerMillionUsd', 'outputPerMillionUsd'] as const;

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
  if (typeof o.budgetId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(o.budgetId)) throw new LiveBudgetError('budgetId must be 1 to 40 letters, digits, _ or -');
  return {
    budgetId: o.budgetId,
    maxOutputTokens: int('maxOutputTokens', 1, 1024),
    maxSteps: int('maxSteps', 1, 5),
    maxBodyChars: int('maxBodyChars', 200, 4_000_000),
    maxRequests: int('maxRequests', 1, 500),
    maxReservedUsd: num('maxReservedUsd', 0.01, 20),
    // Prices are required: without them no dollar ceiling could be enforced.
    inputPerMillionUsd: num('inputPerMillionUsd', 0.01, 1000),
    outputPerMillionUsd: num('outputPerMillionUsd', 0.01, 1000),
  };
}

export type LiveLedger = {budgetId: string; requests: number; reservedUsd: number};
export interface LiveLedgerStore { load(): Promise<unknown>; save(l: LiveLedger): Promise<void> }

/** Worst-case input tokens for a JSON request body: characters / 3 (images excluded), plus an allowance per image block. */
export function estimateInputTokens(body: string): {tokens: number; images: number; textChars: number} {
  // Image data is base64 inside "data":"…"; count those blocks and leave their bytes out of the text estimate.
  let images = 0;
  const text = body.replace(/"type"\s*:\s*"base64"\s*,\s*"media_type"\s*:\s*"image\/(?:png|jpeg)"\s*,\s*"data"\s*:\s*"[A-Za-z0-9+/=]*"/g, () => { images++; return ''; })
    .replace(/"image_url"\s*:\s*\{\s*"url"\s*:\s*"data:[^"]*"/g, () => { images++; return ''; });
  return {tokens: Math.ceil(text.length / 3) + images * IMAGE_TOKEN_ALLOWANCE, images, textChars: text.length};
}

export class LiveBudget {
  private ledger: LiveLedger;
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(readonly config: LiveTestConfig, private readonly store: LiveLedgerStore, ledger: LiveLedger) { this.ledger = ledger; }

  static async open(config: LiveTestConfig, store: LiveLedgerStore): Promise<LiveBudget> {
    let ledger: LiveLedger = {budgetId: config.budgetId, requests: 0, reservedUsd: 0};
    const raw = await store.load().catch(() => null);
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      if (r.budgetId === config.budgetId && typeof r.requests === 'number' && typeof r.reservedUsd === 'number' && r.requests >= 0 && r.reservedUsd >= 0) {
        ledger = {budgetId: config.budgetId, requests: r.requests, reservedUsd: r.reservedUsd};
      }
    }
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
