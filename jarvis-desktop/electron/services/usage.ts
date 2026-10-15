// Usage ledger (roadmap 121–128): local token and estimated-cost ledger, provider billing snapshots,
// budget pace, performance history, attribution and bounded exports. Pure logic: no network, no console,
// no file I/O. Persistence is the caller's job via snapshot()/loadState().
import {randomUUID} from 'node:crypto';

export class UsageValidationError extends Error {}

export const USAGE_LIMITS = {
  events: 20_000,
  reservations: 500,
  prices: 200,
  billingProviders: 50,
  tokens: 10_000_000,
  durationMs: 24 * 60 * 60 * 1000,
  pricePerMillion: 10_000,
  budget: 1_000_000,
  retainDays: 365,
  exportRows: 5_000,
  exportBytes: 1_000_000,
  staleAfterMs: 6 * 60 * 60 * 1000,
} as const;

export const USAGE_SCHEMA_VERSION = 1;
export const USAGE_DISCLAIMER = 'Local estimates from token counts and the price table you entered. Not a provider invoice; provider billing snapshots are shown separately with their observation time.';

export type Runtime = 'local' | 'cloud';
export type CostState = 'estimated' | 'unpriced' | 'not-applicable';
export type BillingStatus = 'observed' | 'stale' | 'unknown' | 'unsupported';

export interface UsageEvent {
  id: string;
  at: string;
  runtime: Runtime;
  provider: string;
  model: string;
  project: string | null;
  worker: string | null;
  inputTokens: number;
  outputTokens: number;
  generationMs: number | null;
  promptMs: number | null;
  /** Estimated cost in USD; null when unpriced or local (not applicable). */
  cost: number | null;
  costState: CostState;
}

export interface Reservation {
  id: string;
  at: string;
  provider: string;
  model: string;
  project: string | null;
  worker: string | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Conservative maximum cost in USD; null when the model has no price. */
  maxCost: number | null;
}

export interface Price {
  provider: string;
  model: string;
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BillingSnapshot {
  provider: string;
  observedAt: string;
  /** Provider-reported remaining balance in USD; absent when the provider did not report one. */
  balance: number | null;
  /** Provider-reported spend in USD for the provider's own period; absent when not reported. */
  spent: number | null;
  resetsAt: string | null;
}

export interface Budget {
  amount: number;
  period: 'day' | 'month';
  /** Fractions of the amount, e.g. 0.5 for a 50% alert. */
  thresholds: number[];
}

export interface TokenUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  generationMs?: unknown;
  promptMs?: unknown;
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const LABEL_RE = /^[^\u0000-\u001f\u007f]{1,80}$/;

export function fail(message: string): never {
  throw new UsageValidationError(message);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function slug(v: unknown, name: string): string {
  if (typeof v !== 'string') fail(`${name} must be text`);
  const s = (v as string).trim().toLowerCase();
  if (!PROVIDER_RE.test(s)) fail(`${name} must be 1–40 letters, digits, dots, dashes or underscores`);
  return s;
}

function label(v: unknown, name: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !LABEL_RE.test(v)) fail(`${name} must be 1–80 printable characters`);
  return (v as string).trim();
}

function model(v: unknown): string {
  if (typeof v !== 'string' || !LABEL_RE.test(v) || (v as string).trim().length === 0) fail('model must be 1–80 printable characters');
  return (v as string).trim();
}

function count(v: unknown, name: string, max: number = USAGE_LIMITS.tokens): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) fail(`${name} must be a whole number from 0 to ${max}`);
  return v as number;
}

function optionalCount(v: unknown, name: string, max = USAGE_LIMITS.durationMs): number | null {
  if (v === undefined || v === null) return null;
  return count(v, name, max);
}

function money(v: unknown, name: string, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) fail(`${name} must be a number from 0 to ${max}`);
  return v as number;
}

function isoTime(v: unknown, name: string): string {
  if (typeof v !== 'string') fail(`${name} must be an ISO date`);
  const t = Date.parse(v as string);
  if (!Number.isFinite(t)) fail(`${name} must be an ISO date`);
  return new Date(t).toISOString();
}

/** Validates token and timing fields shared by recorded events and reservations. */
export function validateUsage(u: TokenUsage): {inputTokens: number; outputTokens: number; generationMs: number | null; promptMs: number | null} {
  return {
    inputTokens: count(u.inputTokens ?? 0, 'inputTokens'),
    outputTokens: count(u.outputTokens ?? 0, 'outputTokens'),
    generationMs: optionalCount(u.generationMs, 'generationMs'),
    promptMs: optionalCount(u.promptMs, 'promptMs'),
  };
}

export function validatePrice(v: unknown): Price {
  if (!isObj(v)) fail('price must be an object');
  return {
    provider: slug(v.provider, 'provider'),
    model: model(v.model),
    inputPerMillion: money(v.inputPerMillion, 'inputPerMillion', USAGE_LIMITS.pricePerMillion),
    outputPerMillion: money(v.outputPerMillion, 'outputPerMillion', USAGE_LIMITS.pricePerMillion),
  };
}

export function validateBilling(v: unknown): BillingSnapshot {
  if (!isObj(v)) fail('billing snapshot must be an object');
  const nullableMoney = (x: unknown, name: string) => (x === undefined || x === null ? null : money(x, name, USAGE_LIMITS.budget));
  return {
    provider: slug(v.provider, 'provider'),
    observedAt: isoTime(v.observedAt, 'observedAt'),
    balance: nullableMoney(v.balance, 'balance'),
    spent: nullableMoney(v.spent, 'spent'),
    resetsAt: v.resetsAt === undefined || v.resetsAt === null ? null : isoTime(v.resetsAt, 'resetsAt'),
  };
}

export function validateBudget(v: unknown): Budget {
  if (!isObj(v)) fail('budget must be an object');
  if (v.period !== 'day' && v.period !== 'month') fail('period must be day or month');
  const thresholds = v.thresholds === undefined ? [0.5, 0.8, 1] : v.thresholds;
  if (!Array.isArray(thresholds) || thresholds.length > 10) fail('thresholds must be a list of at most 10 fractions');
  const t = thresholds.map((x) => {
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0 || x > 10) fail('each threshold must be a fraction above 0 and at most 10');
    return x as number;
  });
  return {amount: money(v.amount, 'amount', USAGE_LIMITS.budget), period: v.period, thresholds: [...new Set(t)].sort((a, b) => a - b)};
}

export function priceKey(provider: string, modelName: string): string {
  return `${provider}\u0000${modelName}`;
}

/** Estimated cost in USD for a token count. */
export function estimateCost(price: Pick<Price, 'inputPerMillion' | 'outputPerMillion'>, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPerMillion + outputTokens * price.outputPerMillion) / 1_000_000;
}

/** Ollama /api/chat final-chunk metrics (durations are nanoseconds in the response). */
export function parseOllamaMetrics(raw: unknown): {inputTokens: number; outputTokens: number; generationMs: number | null; promptMs: number | null} {
  if (!isObj(raw)) fail('Ollama metrics must be an object');
  const ns = (x: unknown, name: string) => (x === undefined || x === null ? null : count(x, name, Number.MAX_SAFE_INTEGER) / 1e6);
  return validateUsage({
    inputTokens: raw.prompt_eval_count,
    outputTokens: raw.eval_count,
    generationMs: ns(raw.eval_duration, 'eval_duration'),
    promptMs: ns(raw.prompt_eval_duration, 'prompt_eval_duration'),
  });
}

/** Cloud provider usage object (input_tokens / output_tokens, as the Anthropic Messages API reports them). */
export function parseCloudUsage(raw: unknown): {inputTokens: number; outputTokens: number; generationMs: null; promptMs: null} {
  if (!isObj(raw)) fail('usage must be an object');
  return {inputTokens: count(raw.input_tokens, 'input_tokens'), outputTokens: count(raw.output_tokens, 'output_tokens'), generationMs: null, promptMs: null};
}

export interface UsageLedgerOptions {
  now?: () => Date;
  newId?: () => string;
}

export interface UsageReport {
  generatedAt: string;
  disclaimer: string;
  /** Estimated spend from local events and cloud events with a price. Excludes unpriced and local events. */
  estimatedSpend: number;
  /** Maximum cost of reservations not yet settled. Kept conservatively until settled. */
  reservedSpend: number;
  unpricedEvents: number;
  totals: {events: number; inputTokens: number; outputTokens: number};
  byModel: {provider: string; model: string; runtime: Runtime; events: number; inputTokens: number; outputTokens: number; estimatedCost: number | null}[];
  attribution: {project: string | null; worker: string | null; events: number; estimatedCost: number | null}[];
  billing: {provider: string; status: BillingStatus; observedAt: string | null; ageMs: number | null; balance: number | null; spent: number | null; resetsAt: string | null; resetInMs: number | null; resetDue: boolean}[];
  reservations: {id: string; provider: string; model: string; project: string | null; ageMs: number; maxCost: number | null}[];
  budget: {amount: number; period: 'day' | 'month'; periodStart: string; periodEnd: string; spent: number; reserved: number; conservativeTotal: number; remaining: number; fractionUsed: number; projected: number | null; pace: 'insufficient-data' | 'on-track' | 'over-pace'; alerts: {threshold: number; reached: boolean}[]} | null;
}

/** Typed interface for the API owner. Every method validates its input and throws UsageValidationError. */
export interface UsageLedger {
  recordEvent(input: unknown): UsageEvent;
  reserve(input: unknown): Reservation;
  settle(reservationId: string, usage: unknown): UsageEvent;
  setPrices(prices: unknown): Price[];
  declareBillingAdapter(provider: unknown): void;
  recordBilling(snapshot: unknown): BillingSnapshot;
  setBudget(budget: unknown): Budget | null;
  report(): UsageReport;
  performance(options?: {model?: string; limit?: number}): {tokensPerSecond: number | null; eventId: string; at: string; model: string; outputTokens: number}[];
  exportCsv(options?: {from?: string; to?: string}): {content: string; rows: number; truncated: boolean};
  exportJson(options?: {from?: string; to?: string}): {content: string; rows: number; truncated: boolean};
  snapshot(): UsageState;
  loadState(raw: unknown): {accepted: number; rejected: number};
}

export interface UsageState {
  schemaVersion: number;
  events: UsageEvent[];
  reservations: Reservation[];
  prices: Price[];
  billing: BillingSnapshot[];
  declaredBilling: string[];
  budget: Budget | null;
}

const CSV_HEADER = ['at', 'runtime', 'provider', 'model', 'project', 'worker', 'inputTokens', 'outputTokens', 'generationMs', 'tokensPerSecond', 'estimatedCost', 'costState'];

/** Neutralises spreadsheet formulas and quotes a CSV cell. */
export function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tokensPerSecond(e: Pick<UsageEvent, 'outputTokens' | 'generationMs'>): number | null {
  if (!e.generationMs || e.generationMs <= 0 || e.outputTokens <= 0) return null;
  return e.outputTokens / (e.generationMs / 1000);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function periodBounds(period: 'day' | 'month', now: Date): {start: Date; end: Date} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  if (period === 'day') return {start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1))};
  return {start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1))};
}

export function createUsageLedger(options: UsageLedgerOptions = {}): UsageLedger {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  let events: UsageEvent[] = [];
  let reservations = new Map<string, Reservation>();
  let prices = new Map<string, Price>();
  let billing = new Map<string, BillingSnapshot>();
  let declared = new Set<string>();
  let budget: Budget | null = null;

  const priceFor = (provider: string, m: string) => prices.get(priceKey(provider, m)) ?? null;

  const pushEvent = (e: UsageEvent) => {
    events.push(e);
    if (events.length > USAGE_LIMITS.events) events = events.slice(events.length - USAGE_LIMITS.events);
  };

  const recordEvent = (input: unknown): UsageEvent => {
    if (!isObj(input)) fail('event must be an object');
    const runtime = input.runtime;
    if (runtime !== 'local' && runtime !== 'cloud') fail('runtime must be local or cloud');
    const provider = slug(input.provider, 'provider');
    const m = model(input.model);
    const usage = validateUsage(input as TokenUsage);
    const at = input.at === undefined ? now().toISOString() : isoTime(input.at, 'at');
    if (Date.parse(at) > now().getTime() + 24 * 60 * 60 * 1000) fail('at is more than a day in the future');
    const price = runtime === 'cloud' ? priceFor(provider, m) : null;
    const costState: CostState = runtime === 'local' ? 'not-applicable' : price ? 'estimated' : 'unpriced';
    const e: UsageEvent = {
      id: newId(),
      at,
      runtime,
      provider,
      model: m,
      project: label(input.project, 'project'),
      worker: label(input.worker, 'worker'),
      ...usage,
      cost: price ? estimateCost(price, usage.inputTokens, usage.outputTokens) : null,
      costState,
    };
    pushEvent(e);
    return e;
  };

  return {
    recordEvent,

    reserve(input) {
      if (!isObj(input)) fail('reservation must be an object');
      const provider = slug(input.provider, 'provider');
      const m = model(input.model);
      const maxInputTokens = count(input.maxInputTokens, 'maxInputTokens');
      const maxOutputTokens = count(input.maxOutputTokens, 'maxOutputTokens');
      if (reservations.size >= USAGE_LIMITS.reservations) fail('too many unsettled reservations');
      const price = priceFor(provider, m);
      const r: Reservation = {
        id: newId(),
        at: now().toISOString(),
        provider,
        model: m,
        project: label(input.project, 'project'),
        worker: label(input.worker, 'worker'),
        maxInputTokens,
        maxOutputTokens,
        maxCost: price ? estimateCost(price, maxInputTokens, maxOutputTokens) : null,
      };
      reservations.set(r.id, r);
      return r;
    },

    settle(reservationId, usage) {
      const r = reservations.get(reservationId);
      if (!r) fail('no unsettled reservation with that id');
      const u = validateUsage(isObj(usage) ? (usage as TokenUsage) : fail('usage must be an object'));
      reservations.delete(reservationId);
      const price = priceFor(r.provider, r.model);
      const e: UsageEvent = {
        id: newId(),
        at: now().toISOString(),
        runtime: 'cloud',
        provider: r.provider,
        model: r.model,
        project: r.project,
        worker: r.worker,
        ...u,
        cost: price ? estimateCost(price, u.inputTokens, u.outputTokens) : null,
        costState: price ? 'estimated' : 'unpriced',
      };
      pushEvent(e);
      return e;
    },

    setPrices(input) {
      if (!Array.isArray(input) || input.length > USAGE_LIMITS.prices) fail(`prices must be a list of at most ${USAGE_LIMITS.prices}`);
      const next = new Map<string, Price>();
      for (const raw of input) {
        const p = validatePrice(raw);
        next.set(priceKey(p.provider, p.model), p);
      }
      prices = next;
      return [...prices.values()];
    },

    declareBillingAdapter(provider) {
      if (declared.size >= USAGE_LIMITS.billingProviders) fail('too many billing providers');
      declared.add(slug(provider, 'provider'));
    },

    recordBilling(input) {
      const s = validateBilling(input);
      if (!declared.has(s.provider)) fail('no billing adapter is declared for that provider');
      billing.set(s.provider, s);
      return s;
    },

    setBudget(input) {
      budget = input === null || input === undefined ? null : validateBudget(input);
      return budget;
    },

    report() {
      const t = now();
      const estimatedSpend = events.reduce((sum, e) => sum + (e.cost ?? 0), 0);
      const reservedSpend = [...reservations.values()].reduce((sum, r) => sum + (r.maxCost ?? 0), 0);
      const unpricedEvents = events.filter((e) => e.costState === 'unpriced').length;

      const modelRows = new Map<string, UsageReport['byModel'][number]>();
      for (const e of events) {
        const k = `${e.runtime}\u0000${e.provider}\u0000${e.model}`;
        const row = modelRows.get(k) ?? {provider: e.provider, model: e.model, runtime: e.runtime, events: 0, inputTokens: 0, outputTokens: 0, estimatedCost: e.runtime === 'cloud' ? 0 : null};
        row.events += 1;
        row.inputTokens += e.inputTokens;
        row.outputTokens += e.outputTokens;
        if (row.estimatedCost !== null) row.estimatedCost = e.cost === null ? null : row.estimatedCost + e.cost;
        modelRows.set(k, row);
      }

      const attr = new Map<string, UsageReport['attribution'][number]>();
      for (const e of events) {
        const k = `${e.project ?? ''}\u0000${e.worker ?? ''}`;
        const row = attr.get(k) ?? {project: e.project, worker: e.worker, events: 0, estimatedCost: 0};
        row.events += 1;
        // Local events are not charged, so they add nothing; only an unpriced cloud event makes the row unknown.
        if (row.estimatedCost !== null) row.estimatedCost = e.costState === 'unpriced' ? null : row.estimatedCost + (e.cost ?? 0);
        attr.set(k, row);
      }

      const billingRows: UsageReport['billing'] = [...declared].sort().map((provider) => {
        const s = billing.get(provider);
        if (!s) return {provider, status: 'unknown', observedAt: null, ageMs: null, balance: null, spent: null, resetsAt: null, resetInMs: null, resetDue: false};
        const ageMs = Math.max(0, t.getTime() - Date.parse(s.observedAt));
        const resetInMs = s.resetsAt ? Date.parse(s.resetsAt) - t.getTime() : null;
        return {
          provider,
          status: ageMs > USAGE_LIMITS.staleAfterMs ? 'stale' : 'observed',
          observedAt: s.observedAt,
          ageMs,
          balance: s.balance,
          spent: s.spent,
          resetsAt: s.resetsAt,
          resetInMs,
          resetDue: resetInMs !== null && resetInMs <= 0,
        };
      });
      // Providers with events but no declared adapter are reported as unsupported, never as zero.
      for (const p of new Set(events.filter((e) => e.runtime === 'cloud').map((e) => e.provider))) {
        if (!declared.has(p)) billingRows.push({provider: p, status: 'unsupported', observedAt: null, ageMs: null, balance: null, spent: null, resetsAt: null, resetInMs: null, resetDue: false});
      }

      let budgetRow: UsageReport['budget'] = null;
      if (budget) {
        const {start, end} = periodBounds(budget.period, t);
        const inPeriod = events.filter((e) => Date.parse(e.at) >= start.getTime() && Date.parse(e.at) < t.getTime() + 1);
        const spent = inPeriod.reduce((sum, e) => sum + (e.cost ?? 0), 0);
        const conservativeTotal = spent + reservedSpend;
        const elapsed = (t.getTime() - start.getTime()) / (end.getTime() - start.getTime());
        const projected = elapsed >= 0.05 ? conservativeTotal / elapsed : null;
        budgetRow = {
          amount: budget.amount,
          period: budget.period,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
          spent,
          reserved: reservedSpend,
          conservativeTotal,
          remaining: budget.amount - conservativeTotal,
          fractionUsed: budget.amount > 0 ? conservativeTotal / budget.amount : 0,
          projected,
          pace: projected === null ? 'insufficient-data' : projected <= budget.amount ? 'on-track' : 'over-pace',
          alerts: budget.thresholds.map((th) => ({threshold: th, reached: conservativeTotal >= th * budget!.amount})),
        };
      }

      return {
        generatedAt: t.toISOString(),
        disclaimer: USAGE_DISCLAIMER,
        estimatedSpend,
        reservedSpend,
        unpricedEvents,
        totals: {
          events: events.length,
          inputTokens: events.reduce((s, e) => s + e.inputTokens, 0),
          outputTokens: events.reduce((s, e) => s + e.outputTokens, 0),
        },
        byModel: [...modelRows.values()],
        attribution: [...attr.values()],
        billing: billingRows,
        reservations: [...reservations.values()].map((r) => ({id: r.id, provider: r.provider, model: r.model, project: r.project, ageMs: Math.max(0, t.getTime() - Date.parse(r.at)), maxCost: r.maxCost})),
        budget: budgetRow,
      };
    },

    performance(opts = {}) {
      const limit = opts.limit === undefined ? 50 : count(opts.limit, 'limit', 500);
      return events
        .filter((e) => e.runtime === 'local' && (opts.model === undefined || e.model === opts.model))
        .map((e) => ({tokensPerSecond: tokensPerSecond(e), eventId: e.id, at: e.at, model: e.model, outputTokens: e.outputTokens}))
        .filter((row) => row.tokensPerSecond !== null)
        .slice(-limit)
        .reverse();
    },

    exportCsv(opts = {}) {
      const rows = rowsInRange(opts);
      const lines = [CSV_HEADER.join(',')];
      let bytes = lines[0].length;
      let included = 0;
      for (const e of rows) {
        const line = [e.at, e.runtime, e.provider, e.model, e.project, e.worker, e.inputTokens, e.outputTokens, e.generationMs, tokensPerSecond(e), e.cost, e.costState].map((c) => csvCell(c as string | number | null)).join(',');
        if (included >= USAGE_LIMITS.exportRows || bytes + line.length + 1 > USAGE_LIMITS.exportBytes) break;
        lines.push(line);
        bytes += line.length + 1;
        included += 1;
      }
      return {content: lines.join('\n') + '\n', rows: included, truncated: included < rows.length};
    },

    exportJson(opts = {}) {
      const rows = rowsInRange(opts);
      const included: UsageEvent[] = [];
      const base = {format: 'desktop-companion-usage', schemaVersion: USAGE_SCHEMA_VERSION, generatedAt: now().toISOString(), disclaimer: USAGE_DISCLAIMER};
      // Size is summed per event (not re-stringified per row). The envelope is measured with truncated:true, the longer literal, so the bound holds.
      let bytes = JSON.stringify({...base, events: [], truncated: true}).length;
      for (const e of rows) {
        if (included.length >= USAGE_LIMITS.exportRows) break;
        const size = JSON.stringify(e).length + 1;
        if (bytes + size > USAGE_LIMITS.exportBytes) break;
        bytes += size;
        included.push(e);
      }
      const truncated = included.length < rows.length;
      return {content: JSON.stringify({...base, events: included, truncated}), rows: included.length, truncated};
    },

    snapshot() {
      return {
        schemaVersion: USAGE_SCHEMA_VERSION,
        events: [...events],
        reservations: [...reservations.values()],
        prices: [...prices.values()],
        billing: [...billing.values()],
        declaredBilling: [...declared],
        budget,
      };
    },

    loadState(raw) {
      if (!isObj(raw) || raw.schemaVersion !== USAGE_SCHEMA_VERSION) fail('usage state has an unsupported schema version');
      let accepted = 0;
      let rejected = 0;
      const take = <T>(list: unknown, parse: (x: unknown) => T): T[] => {
        if (!Array.isArray(list)) return [];
        const out: T[] = [];
        for (const x of list) {
          try {
            out.push(parse(x));
            accepted += 1;
          } catch {
            rejected += 1;
          }
        }
        return out;
      };
      const cutoff = now().getTime() - USAGE_LIMITS.retainDays * 24 * 60 * 60 * 1000;
      events = take(raw.events, (x) => parseStoredEvent(x)).filter((e) => Date.parse(e.at) >= cutoff).slice(-USAGE_LIMITS.events);
      reservations = new Map(take(raw.reservations, (x) => parseStoredReservation(x)).map((r) => [r.id, r]));
      prices = new Map(take(raw.prices, (x) => validatePrice(x)).map((p) => [priceKey(p.provider, p.model), p]));
      declared = new Set(take(raw.declaredBilling, (x) => slug(x, 'provider')));
      billing = new Map(take(raw.billing, (x) => validateBilling(x)).filter((s) => declared.has(s.provider)).map((s) => [s.provider, s]));
      budget = raw.budget ? validateBudget(raw.budget) : null;
      return {accepted, rejected};
    },
  };

  function rowsInRange(opts: {from?: string; to?: string}): UsageEvent[] {
    const from = opts.from === undefined ? -Infinity : Date.parse(isoTime(opts.from, 'from'));
    const to = opts.to === undefined ? Infinity : Date.parse(isoTime(opts.to, 'to'));
    return events.filter((e) => {
      const t = Date.parse(e.at);
      return t >= from && t <= to;
    });
  }
}

function parseStoredEvent(x: unknown): UsageEvent {
  if (!isObj(x)) fail('event must be an object');
  const runtime = x.runtime;
  if (runtime !== 'local' && runtime !== 'cloud') fail('runtime must be local or cloud');
  const usage = validateUsage(x as TokenUsage);
  const costState = x.costState;
  if (costState !== 'estimated' && costState !== 'unpriced' && costState !== 'not-applicable') fail('costState is invalid');
  return {
    id: label(x.id, 'id') ?? fail('id is required'),
    at: isoTime(x.at, 'at'),
    runtime,
    provider: slug(x.provider, 'provider'),
    model: model(x.model),
    project: label(x.project, 'project'),
    worker: label(x.worker, 'worker'),
    ...usage,
    cost: x.cost === null || x.cost === undefined ? null : money(x.cost, 'cost', USAGE_LIMITS.budget),
    costState,
  };
}

function parseStoredReservation(x: unknown): Reservation {
  if (!isObj(x)) fail('reservation must be an object');
  return {
    id: label(x.id, 'id') ?? fail('id is required'),
    at: isoTime(x.at, 'at'),
    provider: slug(x.provider, 'provider'),
    model: model(x.model),
    project: label(x.project, 'project'),
    worker: label(x.worker, 'worker'),
    maxInputTokens: count(x.maxInputTokens, 'maxInputTokens'),
    maxOutputTokens: count(x.maxOutputTokens, 'maxOutputTokens'),
    maxCost: x.maxCost === null || x.maxCost === undefined ? null : money(x.maxCost, 'maxCost', USAGE_LIMITS.budget),
  };
}
