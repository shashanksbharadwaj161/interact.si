// Optional providers and connectors (roadmap 101–110, Spotify / browser / ChatGPT / Claude requests).
// No Electron imports and no direct network access: every request goes through an injected guarded fetch
// (netGuard), every key lives behind an opaque key adapter, and every request that leaves the device needs the
// trusted main-process confirmation. Keys never appear in results, previews, usage history, audit text or errors.
import {promises as fsp} from 'node:fs';
import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import * as path from 'node:path';
import type {Mode} from '../../src/shared/contracts';
import {
  INTEGRATIONS, findIntegration, isCheckable, keyWarnings, needsOptIn,
  type CheckResult, type ChoiceStorage, type ConnectionState, type EgressPreview, type IntegrationDefinition, type IntegrationView, type UsageEntry,
} from '../../src/ui/integration-catalog';
import type {NativeAdapter} from '../native/adapter';
import {NetworkDenied} from './netGuard';
import {validateCloudKey} from './secrets';
import {isLoopbackHost, ValidationError} from './validation';

// ---------- injected dependencies ----------

/**
 * Same call shape as netGuard's guardedFetch, so the existing GuardedFetch is assignable directly. netGuard's
 * PROVIDER_CHECKS table must list every online origin + path + query in egressRequirements() (a test keeps them in sync).
 */
export type IntegrationFetchFn = (url: string, init: RequestInit & {timeoutMs?: number}, purpose: never) => Promise<Response>;

/** Opaque key storage. The key value exists only inside `use`; nothing returns it. */
export interface KeyAdapter {
  has(slot: string): Promise<boolean>;
  store(slot: string, key: string): Promise<void>;
  remove(slot: string): Promise<void>;
  use<T>(slot: string, fn: (key: string) => Promise<T>): Promise<T | null>;
}

/** Outcome of a past connection check. Fixed provider-facing text only: no key, no response body, no request data. */
export interface StoredCheck { ok: boolean; at: string; status?: number; reason?: string }
export interface IntegrationPrefs { version: 1; enabled: Record<string, boolean>; lastChecks?: Record<string, StoredCheck> }
/**
 * Durable storage for the per-provider opt-in. electron/services/sidecar.ts createJsonSidecar(userData, 'integrations')
 * satisfies this directly. Without a store nothing can be turned on: choices are never kept only in memory.
 */
export interface PrefsStore { load(): Promise<unknown>; save(prefs: IntegrationPrefs): Promise<void> }

export interface IntegrationDeps {
  fetch: IntegrationFetchFn;
  mode: () => Mode;
  keys: KeyAdapter;
  /** Trusted main-process dialog (Cancel default). Missing confirmation always denies. Never a renderer boolean. */
  confirm?: (summary: string, detail: string) => Promise<boolean>;
  /** Loopback Ollama endpoint from Settings; defaults to the catalog origin. */
  localEndpoint?: () => string;
  /** Model name selected in Settings. When given, the local check reports whether that model is installed. */
  localModel?: () => string;
  prefs?: PrefsStore;
  /** Called after a key is stored or removed, so the owner of an aliased slot (the chat key) can refresh its cache. */
  onKeyChange?: (slot: string) => void;
  /** Activity log line. Contains provider name and outcome only. */
  audit?: (summary: string) => void;
  now?: () => number;
  definitions?: readonly IntegrationDefinition[];
  checkTimeoutMs?: number;
  cooldownMs?: number;
  /** A check result older than this no longer counts as "connected" (default 30 minutes). */
  checkMaxAgeMs?: number;
}

// ---------- pure helpers ----------

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export function validateIntegrationId(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ValidationError('Integration id is not valid');
  return v;
}

export function sanitizePrefs(raw: unknown, defs: readonly IntegrationDefinition[] = INTEGRATIONS): IntegrationPrefs {
  const enabled: Record<string, boolean> = {};
  const obj = raw && typeof raw === 'object' ? (raw as {enabled?: unknown; lastChecks?: unknown}) : undefined;
  const src = obj?.enabled;
  if (src && typeof src === 'object') {
    for (const d of defs) {
      const v = (src as Record<string, unknown>)[d.id];
      if (v === true && canEnable(d)) enabled[d.id] = true;
    }
  }
  return withChecks(enabled, sanitizeChecks(obj?.lastChecks, defs));
}

function withChecks(enabled: Record<string, boolean>, checks: Record<string, StoredCheck>): IntegrationPrefs {
  return Object.keys(checks).length ? {version: 1, enabled, lastChecks: checks} : {version: 1, enabled};
}

/** Keeps only well-formed outcomes for known, checkable items. Anything else in a saved file is dropped. */
function sanitizeChecks(raw: unknown, defs: readonly IntegrationDefinition[]): Record<string, StoredCheck> {
  const out: Record<string, StoredCheck> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const d of defs) {
    const v = (raw as Record<string, unknown>)[d.id];
    if (!isCheckable(d) || !v || typeof v !== 'object') continue;
    const c = v as Record<string, unknown>;
    if (typeof c.ok !== 'boolean' || typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at))) continue;
    out[d.id] = {
      ok: c.ok, at: new Date(Date.parse(c.at)).toISOString(),
      ...(typeof c.status === 'number' && Number.isInteger(c.status) && c.status >= 100 && c.status <= 599 ? {status: c.status} : {}),
      ...(typeof c.reason === 'string' && c.reason ? {reason: c.reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200)} : {}),
    };
  }
  return out;
}

/** Only items that can contact a provider take an opt-in; local items need none and handoffs use action approval. */
const canEnable = needsOptIn;

const BLOCKED_REASON: Partial<Record<IntegrationDefinition['availability'], string>> = {
  gated: 'Experimental and turned off until its review passes',
  'setup-required': 'Needs setup that does not exist yet',
  'not-built': 'Not built yet',
  handoff: 'This opens a website; there is no API connection to check',
  local: 'Runs on this device; there is nothing to turn on',
};

/** Maps an HTTP status from a connection check to a user-facing reason. Response bodies are never shown. */
export function describeStatus(d: IntegrationDefinition, status: number): {ok: boolean; reason?: string; hint?: string} {
  if (status >= 200 && status < 300) return {ok: true};
  if (status === 401 || status === 403) return {ok: false, reason: d.key ? `${d.provider} rejected the key` : `${d.provider} refused the request`, ...(d.key ? {hint: 'Create a new key (revoked or expired keys are rejected), store it again, then re-run the check.'} : {})};
  if (status === 404) return {ok: false, reason: `${d.provider} did not recognise the check endpoint`, hint: 'The provider may have changed this endpoint. Your key is probably fine; try again later.'};
  if (status === 429) return {ok: false, reason: `${d.provider} is rate limiting requests; try again later`, hint: 'Wait a few minutes, then check again.'};
  if (status >= 500) return {ok: false, reason: `${d.provider} reported a server error`, hint: 'This is on the provider side. Try again later.'};
  return {ok: false, reason: `${d.provider} answered with HTTP ${status}`, ...(status >= 300 && status < 400 ? {hint: 'Redirects are never followed. Nothing was sent to the redirect target.'} : {})};
}

/**
 * Strict check for a local model address before anything is sent to it: plain http on a loopback host (127.0.0.0/8,
 * ::1 or localhost), no credentials, no query or fragment, no path beyond "/". The request only ever uses the origin.
 */
export function checkLocalEndpoint(raw: unknown): {ok: true; origin: string} | {ok: false; reason: string} {
  if (typeof raw !== 'string' || !raw.trim()) return {ok: false, reason: 'Local model endpoint is empty'};
  const s = raw.trim();
  if (s.length > 200 || /[\u0000-\u001f\u007f\s\\]/.test(s)) return {ok: false, reason: 'Local model endpoint is not a valid address'};
  let u: URL;
  try { u = new URL(s); } catch { return {ok: false, reason: 'Local model endpoint is not a valid address'}; }
  if (u.protocol !== 'http:') return {ok: false, reason: 'Local model endpoint must use http (loopback traffic never leaves this computer)'};
  if (!isLoopbackHost(u.hostname)) return {ok: false, reason: 'Local model endpoint must be a loopback address (127.0.0.1, ::1 or localhost)'};
  if (u.username || u.password) return {ok: false, reason: 'Local model endpoint must not contain a user name or password'};
  if (u.search || u.hash || s.includes('?') || s.includes('#') || (u.pathname !== '/' && u.pathname !== '')) return {ok: false, reason: 'Local model endpoint must be an address only, without a path, query or fragment'};
  return {ok: true, origin: u.origin};
}

function resolveCheckOrigin(d: IntegrationDefinition, localEndpoint?: () => string): {origin: string} | {error: string} {
  const c = d.check!;
  if (c.purpose !== 'ollama') return {origin: c.origin};
  let raw: unknown;
  try { raw = localEndpoint?.() ?? c.origin; } catch { return {error: 'Local model endpoint could not be read from Settings'}; }
  const v = checkLocalEndpoint(raw);
  return v.ok ? {origin: v.origin} : {error: v.reason};
}

/** Largest local model list read from Ollama. Anything bigger is treated as unreadable. */
const LOCAL_BODY_MAX = 1_000_000;

/** Names from Ollama's /api/tags body. Only short names without control characters are kept; nothing else is used. */
export function parseLocalModels(body: unknown): string[] | null {
  const models = (body as {models?: unknown} | null)?.models;
  if (!Array.isArray(models)) return null;
  const names: string[] = [];
  for (const m of models) {
    const o = (m ?? {}) as {name?: unknown; model?: unknown};
    const n = o.name ?? o.model;
    if (typeof n === 'string' && n && n.length <= 200 && !/[\u0000-\u001f\u007f]/.test(n)) names.push(n);
  }
  return names;
}

/** True when `wanted` is installed. Ollama lists untagged pulls as "<name>:latest", so a bare name matches that tag. */
export function localModelInstalled(installed: readonly string[], wanted: string): boolean {
  const w = wanted.trim().toLowerCase();
  if (!w) return false;
  return installed.some((n) => {
    const x = n.toLowerCase();
    return x === w || (!w.includes(':') && x === `${w}:latest`);
  });
}

function headerNames(d: IntegrationDefinition): string[] {
  const names = Object.keys(d.check?.headers ?? {});
  if (d.key) names.push(d.key.header);
  return names;
}

// ---------- service ----------

export function createIntegrationService(deps: IntegrationDeps) {
  const defs = deps.definitions ?? INTEGRATIONS;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.checkTimeoutMs ?? 15_000;
  const cooldownMs = deps.cooldownMs ?? 2_000;
  const maxAgeMs = deps.checkMaxAgeMs ?? 30 * 60_000;
  const lastCheck = new Map<string, CheckResult>();
  /** Origin each session result came from; a result for another address does not describe the current one. */
  const checkedOrigin = new Map<string, string>();
  const lastAttemptAt = new Map<string, number>();
  const inFlight = new Set<string>();
  const usage: UsageEntry[] = [];
  const USAGE_MAX = 200;
  let prefs: IntegrationPrefs = {version: 1, enabled: {}};
  let loaded = false;
  let prefsUnreadable = false;
  let prefsQueue: Promise<unknown> = Promise.resolve();

  const def = (id: unknown): IntegrationDefinition => {
    const d = defs.find((x) => x.id === validateIntegrationId(id));
    if (!d) throw new ValidationError('Unknown integration');
    return d;
  };
  /**
   * Loads saved choices once. A read error leaves everything off and is retried on the next call; it is never treated
   * as "nothing saved", so a later save cannot overwrite choices that merely failed to load.
   */
  let loading: Promise<void> | null = null;
  const ensurePrefs = async () => {
    if (loaded || !deps.prefs) return;
    // list() asks for every view at once; they share one read.
    loading ??= deps.prefs.load().then(
      (raw) => { prefs = sanitizePrefs(raw, defs); loaded = true; prefsUnreadable = false; },
      () => { prefs = {version: 1, enabled: {}}; prefsUnreadable = true; },
    ).finally(() => { loading = null; });
    await loading;
  };
  const choiceStorage = (): ChoiceStorage => (!deps.prefs ? 'not-connected' : prefsUnreadable ? 'unreadable' : 'saved');
  const iso = () => new Date(now()).toISOString();
  const result = (id: string, ok: boolean, extra: Partial<CheckResult> = {}): CheckResult => ({id, ok, at: iso(), ...extra});

  async function keyConfigured(d: IntegrationDefinition): Promise<boolean> {
    if (!d.key) return false;
    try { return await deps.keys.has(d.key.slot); } catch { return false; }
  }

  async function stateOf(d: IntegrationDefinition): Promise<ConnectionState> {
    switch (d.availability) {
      case 'gated': case 'setup-required': case 'not-built': return d.availability;
      case 'handoff': return 'handoff';
    }
    if (!d.check) return 'local-ready';
    if (needsOptIn(d) && prefs.enabled[d.id] !== true) return 'turned-off';
    if (d.check.online && deps.mode() !== 'online') return 'offline';
    if (d.key && !(await keyConfigured(d))) return 'needs-key';
    const lc = lastCheck.get(d.id);
    if (lc && isCurrent(d, lc)) return lc.ok ? 'connected' : 'check-failed';
    return 'ready-to-check';
  }

  /**
   * A session result stays current until it is older than checkMaxAgeMs or the address it was checked against changes
   * (for example a new local endpoint in Settings). Out-of-date results stay visible as lastCheck, but the state drops
   * back to ready-to-check so an old pass is never shown as a live connection.
   */
  function isCurrent(d: IntegrationDefinition, lc: CheckResult): boolean {
    const at = Date.parse(lc.at);
    if (Number.isNaN(at) || now() - at > maxAgeMs) return false;
    const was = checkedOrigin.get(d.id);
    if (was === undefined) return true;
    const o = resolveCheckOrigin(d, deps.localEndpoint);
    return 'origin' in o && o.origin === was;
  }

  async function view(d: IntegrationDefinition): Promise<IntegrationView> {
    await ensurePrefs();
    const lc = lastCheck.get(d.id);
    const prev = prefs.lastChecks?.[d.id];
    return {id: d.id, state: await stateOf(d), keyConfigured: await keyConfigured(d), enabled: prefs.enabled[d.id] === true, choiceStorage: choiceStorage(), ...(lc ? {lastCheck: lc} : {}), ...(!lc && prev ? {previousCheck: {id: d.id, ...prev}} : {})};
  }

  /** What a request would send. Pure apart from reading mode/key presence; sends nothing. */
  async function preview(id: unknown): Promise<EgressPreview> {
    const d = def(id);
    const base = {id: d.id, dataLeaves: [...d.dataLeaves], bodyBytes: 0, keySent: false};
    if (d.availability === 'handoff') {
      const dest = d.handoff ? new URL(d.handoff.url).origin : 'The link you enter';
      return {...base, allowed: true, destination: dest, method: 'Open in browser', path: d.handoff ? new URL(d.handoff.url).pathname : '', headerNames: [], response: 'Your browser loads the page; the app reads nothing back', reason: 'Needs your approval in the Computer action flow'};
    }
    if (!d.check || !isCheckable(d)) {
      return {...base, allowed: false, reason: d.check ? BLOCKED_REASON[d.availability] : 'Nothing is sent: this runs on this device', destination: 'None', method: '', path: '', headerNames: [], response: 'None'};
    }
    const o = resolveCheckOrigin(d, deps.localEndpoint);
    const common = {...base, method: d.check.method, path: d.check.path.split('?')[0], headerNames: headerNames(d), keySent: !!d.key, ...(d.key ? {keyHeader: d.key.header} : {}),
      response: d.check.purpose === 'ollama' ? 'Installed model count is shown; nothing leaves this device' : 'Only the HTTP status is used; the response body is discarded'};
    if ('error' in o) return {...common, allowed: false, reason: o.error, destination: 'None'};
    await ensurePrefs();
    let reason: string | undefined;
    if (needsOptIn(d) && prefs.enabled[d.id] !== true) reason = `Turn on ${d.name} first`;
    else if (d.check.online && deps.mode() !== 'online') reason = `Offline mode: switch to online mode to contact ${d.provider}`;
    else if (d.key && !(await keyConfigured(d))) reason = `Add your ${d.key.label} first`;
    return {...common, allowed: !reason, ...(reason ? {reason} : {}), destination: o.origin};
  }

  function record(entry: UsageEntry) {
    usage.push(entry);
    if (usage.length > USAGE_MAX) usage.splice(0, usage.length - USAGE_MAX);
  }

  async function runCheck(d: IntegrationDefinition, origin: string): Promise<CheckResult> {
    const c = d.check!;
    const url = origin + c.path;
    const baseHeaders: Record<string, string> = {...(c.headers ?? {})};
    const send = async (key?: string): Promise<CheckResult> => {
      const headers = {...baseHeaders};
      if (key !== undefined && d.key) headers[d.key.header] = c.auth === 'bearer' ? `Bearer ${key}` : key;
      let res: Response;
      try {
        res = await deps.fetch(url, {method: c.method, headers, timeoutMs}, c.purpose as never);
      } catch (e) {
        const name = (e as {name?: string})?.name;
        // NetworkDenied messages are fixed strings written by netGuard and never contain request data.
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        const denied = e instanceof NetworkDenied;
        const local = c.purpose === 'ollama';
        const reason = timedOut ? `${d.provider} did not answer in time`
          : denied ? `Blocked by the network guard: ${e.message}`
          : local ? `Ollama is not answering at ${origin}`
          : `Could not reach ${d.provider}`;
        const hint = denied ? undefined
          : local ? (timedOut ? 'Ollama may still be starting or loading a model. Wait a moment and check again.' : 'Start Ollama on this computer (open the Ollama app or run "ollama serve"), confirm the address in Settings, then check again. Nothing was sent anywhere else.')
          : timedOut ? 'Try again. Your connection or the provider is slow.' : 'Check your internet connection, VPN, proxy or firewall, then try again.';
        record({id: d.id, at: iso(), op: 'check', origin, ok: false, reason});
        return result(d.id, false, {reason, ...(hint ? {hint} : {})});
      }
      const s = describeStatus(d, res.status);
      let detail: string | undefined;
      if (s.ok && c.purpose === 'ollama') {
        try {
          const text = await res.text();
          if (text.length > LOCAL_BODY_MAX) throw new Error('model list too large');
          const names = parseLocalModels(JSON.parse(text)) ?? [];
          const n = names.length;
          detail = n === 0 ? 'Ollama answered, but no models are installed' : `Ollama answered with ${n} installed model${n === 1 ? '' : 's'}`;
          let wanted = '';
          try { wanted = (deps.localModel?.() ?? '').trim(); } catch { wanted = ''; }
          if (wanted && n > 0) {
            const shown = wanted.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80);
            detail += localModelInstalled(names, wanted)
              ? `; your selected model "${shown}" is installed`
              : `; your selected model "${shown}" is not installed. Pull it with Ollama or choose an installed model in Settings`;
          }
        } catch { detail = 'Ollama answered, but the model list could not be read'; }
      } else {
        await res.body?.cancel().catch(() => undefined);
      }
      record({id: d.id, at: iso(), op: 'check', origin, ok: s.ok, status: res.status, ...(s.reason ? {reason: s.reason} : {})});
      return result(d.id, s.ok, {status: res.status, ...(s.reason ? {reason: s.reason} : {}), ...(s.hint ? {hint: s.hint} : {}), ...(detail ? {detail} : {})});
    };
    if (!d.key) return send();
    const r = await deps.keys.use(d.key.slot, (k) => send(k));
    return r ?? result(d.id, false, {reason: `Add your ${d.key.label} first`});
  }

  /**
   * Saves the outcome (never the response) so the next session can show "last checked". Best effort: a failed save never
   * fails the check, and nothing is written when the saved choices could not be read (they must not be overwritten).
   */
  async function rememberCheck(d: IntegrationDefinition, r: CheckResult): Promise<void> {
    const store = deps.prefs;
    if (!store) return;
    const run = prefsQueue.catch(() => undefined).then(async () => {
      await ensurePrefs();
      if (!loaded) return;
      const entry: StoredCheck = {ok: r.ok, at: r.at, ...(r.status ? {status: r.status} : {}), ...(r.reason ? {reason: r.reason} : {})};
      const candidate = withChecks({...prefs.enabled}, {...(prefs.lastChecks ?? {}), [d.id]: entry});
      await store.save(candidate);
      prefs = candidate;
    }).catch(() => undefined);
    prefsQueue = run;
    await run;
  }

  /** Drops the saved outcome after a disconnect or key change. Same rules as rememberCheck. */
  async function forgetCheck(d: IntegrationDefinition): Promise<void> {
    const store = deps.prefs;
    if (!store || !prefs.lastChecks?.[d.id]) return;
    const run = prefsQueue.catch(() => undefined).then(async () => {
      if (!loaded || !prefs.lastChecks?.[d.id]) return;
      const rest = {...prefs.lastChecks};
      delete rest[d.id];
      const candidate = withChecks({...prefs.enabled}, rest);
      await store.save(candidate);
      prefs = candidate;
    }).catch(() => undefined);
    prefsQueue = run;
    await run;
  }

  async function check(id: unknown): Promise<CheckResult> {
    const d = def(id);
    if (!isCheckable(d)) return result(d.id, false, {reason: BLOCKED_REASON[d.availability] ?? 'There is nothing to check for this item'});
    if (inFlight.has(d.id)) return result(d.id, false, {reason: 'A check is already running'});
    const last = lastAttemptAt.get(d.id);
    if (last !== undefined && now() - last < cooldownMs) return result(d.id, false, {reason: 'Wait a moment before checking again'});
    const p = await preview(d.id);
    if (!p.allowed) return result(d.id, false, {reason: p.reason});
    if (d.check!.online) {
      const detail = [
        `Destination: ${p.destination}${p.path}`,
        `Sends: ${p.method} request${p.headerNames.length ? ` with headers ${p.headerNames.join(', ')}` : ''}; no chat or personal content.`,
        ...p.dataLeaves.map((x) => `Leaves this device: ${x}`),
        p.response,
      ].join('\n');
      const ok = await deps.confirm?.(`Send a connection check to ${d.provider}?`, detail).catch(() => false);
      if (ok !== true) return result(d.id, false, {reason: 'Not sent: confirmation declined or unavailable'});
      // The dialog may stay open while mode, key or opt-in change; re-evaluate before anything is sent.
      const again = await preview(d.id);
      if (!again.allowed || again.destination !== p.destination) return result(d.id, false, {reason: `Not sent: ${again.reason ?? 'the request changed while you were deciding'}`});
    }
    inFlight.add(d.id);
    lastAttemptAt.set(d.id, now());
    try {
      const r = await runCheck(d, p.destination);
      lastCheck.set(d.id, r);
      checkedOrigin.set(d.id, p.destination);
      deps.audit?.(`Connection check: ${d.name} — ${r.ok ? 'connected' : 'failed'}${r.status ? ` (HTTP ${r.status})` : ''}`);
      await rememberCheck(d, r);
      return r;
    } finally {
      inFlight.delete(d.id);
    }
  }

  async function setKey(id: unknown, raw: unknown): Promise<{configured: boolean; warning?: string}> {
    const d = def(id);
    if (!d.key || !isCheckable(d)) throw new ValidationError(`${d.name} does not take a key`);
    let key: string;
    try { key = validateCloudKey(raw); } catch (e) { throw new ValidationError(e instanceof Error ? e.message : 'Key is not valid'); }
    const warnings = keyWarnings(d, key);
    const warning = warnings.length ? warnings.join(' ') : undefined;
    const detail = `Stored for your Windows account with DPAPI. It is sent only to ${d.check!.origin} in the ${d.key.header} header when you approve a request.${warning ? `\n${warning}` : ''}`;
    const ok = await deps.confirm?.(`Store your ${d.key.label} on this computer?`, detail).catch(() => false);
    if (ok !== true) throw new ValidationError('Native confirmation declined or unavailable');
    await deps.keys.store(d.key.slot, key);
    lastCheck.delete(d.id);
    await forgetCheck(d);
    deps.onKeyChange?.(d.key.slot);
    deps.audit?.(`Key stored: ${d.key.label}`);
    return {configured: true, ...(warning ? {warning} : {})};
  }

  async function removeKey(id: unknown): Promise<{configured: boolean}> {
    const d = def(id);
    if (!d.key) throw new ValidationError(`${d.name} does not take a key`);
    await deps.keys.remove(d.key.slot);
    lastCheck.delete(d.id);
    await forgetCheck(d);
    deps.onKeyChange?.(d.key.slot);
    deps.audit?.(`Key removed: ${d.key.label}`);
    return {configured: false};
  }

  async function setEnabled(id: unknown, enabled: unknown): Promise<IntegrationView> {
    const d = def(id);
    if (typeof enabled !== 'boolean') throw new ValidationError('Enabled must be true or false');
    if (enabled && !canEnable(d)) throw new ValidationError(`${d.name} cannot be turned on: ${BLOCKED_REASON[d.availability] ?? 'not available'}`);
    const store = deps.prefs;
    if (!store) throw new ValidationError('Integration choices cannot be saved in this build, so nothing can be turned on');
    // Serialized: two quick toggles must not each start from the same snapshot and drop the other's change.
    const run = prefsQueue.catch(() => undefined).then(async () => {
      await ensurePrefs();
      if (!loaded) throw new ValidationError('Saved integration choices could not be read; nothing was changed');
      const next = {...prefs.enabled};
      if (enabled) next[d.id] = true; else delete next[d.id];
      const checks = {...(prefs.lastChecks ?? {})};
      if (!enabled) delete checks[d.id];
      const candidate = withChecks(next, checks);
      await store.save(candidate);
      prefs = candidate;
      if (!enabled) lastCheck.delete(d.id);
      deps.audit?.(`${enabled ? 'Turned on' : 'Turned off'}: ${d.name}`);
    });
    prefsQueue = run;
    await run;
    return view(d);
  }

  return {
    definitions: defs,
    list: async () => Promise.all(defs.map(view)),
    view: async (id: unknown) => view(def(id)),
    preview,
    check,
    setKey,
    removeKey,
    setEnabled,
    usage: async (): Promise<UsageEntry[]> => usage.map((u) => ({...u})).reverse(),
    clearUsage: async () => { usage.length = 0; },
  };
}
export type IntegrationService = ReturnType<typeof createIntegrationService>;

// ---------- IPC surface for the captain (validated handlers; channel names follow electron/channels.ts) ----------

export const INTEGRATION_METHODS = ['integrationsList', 'integrationsPreview', 'integrationsCheck', 'integrationsSetKey', 'integrationsRemoveKey', 'integrationsSetEnabled', 'integrationsUsage', 'integrationsClearUsage'] as const;
export type IntegrationMethod = (typeof INTEGRATION_METHODS)[number];
export const INTEGRATION_ARITY: Record<IntegrationMethod, number> = {
  integrationsList: 0, integrationsPreview: 1, integrationsCheck: 1, integrationsSetKey: 2, integrationsRemoveKey: 1, integrationsSetEnabled: 2, integrationsUsage: 0, integrationsClearUsage: 0,
};

/** Maps IPC methods to the service. Wire each as `jarvis:<method>` behind the existing sender checks. */
export function integrationHandlers(s: IntegrationService): Record<IntegrationMethod, (...args: unknown[]) => Promise<unknown>> {
  return {
    integrationsList: () => s.list(),
    integrationsPreview: (id) => s.preview(id),
    integrationsCheck: (id) => s.check(id),
    integrationsSetKey: (id, key) => s.setKey(id, key),
    integrationsRemoveKey: (id) => s.removeKey(id),
    integrationsSetEnabled: (id, on) => s.setEnabled(id, on),
    integrationsUsage: () => s.usage(),
    integrationsClearUsage: () => s.clearUsage(),
  };
}

// ---------- OAuth authorization-code + PKCE helpers (pure; no sign-in exists) ----------
//
// Groundwork for a future owner-registered OAuth client (for example Spotify). Nothing here opens a browser, listens on a
// port, contacts a provider or stores a token, and nothing is wired to IPC. Every spotify-api / calendar definition stays
// `setup-required`. Authorization codes, verifiers, tokens and secrets must never be logged: use redactOAuthText on any
// text that might contain them.

export interface OAuthClientConfig {
  /** https authorization endpoint of the provider, without query or fragment. */
  authorizeUrl: string;
  /** Public client id registered by the app owner. PKCE clients have no secret; never put one here. */
  clientId: string;
  /** https, or http on a loopback IP literal with an explicit port (RFC 8252 section 7.3). `localhost` is refused. */
  redirectUri: string;
  scopes: readonly string[];
}

const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{8,128}$/;
const SCOPE_RE = /^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/;

export function validateOAuthConfig(c: OAuthClientConfig): {ok: true; config: OAuthClientConfig} | {ok: false; reason: string} {
  let auth: URL;
  try { auth = new URL(c?.authorizeUrl ?? ''); } catch { return {ok: false, reason: 'Authorization address is not a valid link'}; }
  if (auth.protocol !== 'https:' || !auth.hostname) return {ok: false, reason: 'Authorization address must be https'};
  if (auth.username || auth.password || auth.search || auth.hash) return {ok: false, reason: 'Authorization address must not contain credentials, a query or a fragment'};
  if (typeof c.clientId !== 'string' || !CLIENT_ID_RE.test(c.clientId)) return {ok: false, reason: 'Client id is not valid'};
  let red: URL;
  try { red = new URL(c.redirectUri ?? ''); } catch { return {ok: false, reason: 'Redirect address is not a valid link'}; }
  if (red.username || red.password || red.hash) return {ok: false, reason: 'Redirect address must not contain credentials or a fragment'};
  const loopback = red.protocol === 'http:' && (red.hostname === '127.0.0.1' || red.hostname === '[::1]');
  if (!(red.protocol === 'https:' || loopback)) return {ok: false, reason: 'Redirect must be https, or http on 127.0.0.1 / [::1] (not localhost)'};
  if (loopback && !red.port) return {ok: false, reason: 'A loopback redirect needs an explicit port'};
  if (!Array.isArray(c.scopes) || c.scopes.length === 0 || c.scopes.length > 20) return {ok: false, reason: 'Provide between 1 and 20 scopes'};
  const scopes = [...new Set(c.scopes)];
  if (scopes.length !== c.scopes.length || !scopes.every((s) => typeof s === 'string' && SCOPE_RE.test(s))) return {ok: false, reason: 'Scopes must be unique and contain no spaces or quotes'};
  return {ok: true, config: {authorizeUrl: auth.href, clientId: c.clientId, redirectUri: red.href, scopes}};
}

export interface PkcePair { verifier: string; challenge: string; method: 'S256' }

/** RFC 7636: 32 random bytes → 43-character verifier; challenge = base64url(SHA-256(verifier)). */
export function createPkce(random: (n: number) => Uint8Array = randomBytes): PkcePair {
  const verifier = Buffer.from(random(32)).toString('base64url');
  return {verifier, challenge: createHash('sha256').update(verifier, 'ascii').digest('base64url'), method: 'S256'};
}

export function createOAuthState(random: (n: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(16)).toString('base64url');
}

/** Builds the authorization link. The caller still has to hand it to the approved open-url flow; this never opens it. */
export function buildAuthorizeUrl(config: OAuthClientConfig, challenge: string, state: string): string {
  const v = validateOAuthConfig(config);
  if (!v.ok) throw new ValidationError(v.reason);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new ValidationError('Code challenge is not valid');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) throw new ValidationError('State is not valid');
  const u = new URL(v.config.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', v.config.clientId);
  u.searchParams.set('redirect_uri', v.config.redirectUri);
  u.searchParams.set('scope', v.config.scopes.join(' '));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('state', state);
  return u.href;
}

/** Constant-time state comparison for the redirect; a missing or different state means the response must be discarded. */
export function stateMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(expected), b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

const OAUTH_SECRET_PARAMS = 'code|code_verifier|access_token|refresh_token|id_token|client_secret|token|state|assertion';

/** Removes OAuth secrets from text meant for logs or messages: query/form parameters, JSON fields and Bearer tokens. */
export function redactOAuthText(text: string): string {
  return String(text)
    .replace(new RegExp(`((?:^|[?&#;\\s])(?:${OAUTH_SECRET_PARAMS}))=[^&\\s#"']*`, 'gi'), '$1=[redacted]')
    .replace(new RegExp(`("(?:${OAUTH_SECRET_PARAMS})"\\s*:\\s*)"[^"]*"`, 'gi'), '$1"[redacted]"')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]');
}

// ---------- DPAPI key vault (per-slot ciphertext files) ----------

export interface VaultFs {
  read(p: string): Promise<string | null>;
  write(p: string, data: string): Promise<void>;
  remove(p: string): Promise<void>;
}

export const nodeVaultFs: VaultFs = {
  read: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  write: async (p, data) => {
    await fsp.mkdir(path.dirname(p), {recursive: true});
    const tmp = p + '.tmp';
    try { await fsp.writeFile(tmp, data, 'utf8'); await fsp.rename(tmp, p); } catch (e) { await fsp.rm(tmp, {force: true}).catch(() => undefined); throw e; }
  },
  remove: async (p) => { await fsp.rm(p, {force: true}); },
};

/** Minimal shape of the existing cloud-key vault (electron/services/secrets.ts Secrets) used as an alias backend. */
export interface SlotBackend {
  configured(): Promise<boolean>;
  set(key: unknown): Promise<unknown>;
  reveal(): Promise<string | null>;
  delete(): Promise<void>;
}

const SLOT_RE = /^[a-z0-9-]{2,32}$/;
const CIPHER_RE = /^[A-Za-z0-9+/=\s]{16,16384}$/;

/**
 * Key adapter backed by Windows DPAPI. Only ciphertext touches disk. `aliases` maps a slot to an existing
 * backend so the Anthropic key stays in the vault chat.ts already reads (pass {anthropic: secrets}).
 */
export function createDpapiKeyVault(opts: {native: Pick<NativeAdapter, 'dpapi'>; dir: string; fs?: VaultFs; aliases?: Record<string, SlotBackend>}): KeyAdapter {
  const fs = opts.fs ?? nodeVaultFs;
  const file = (slot: string) => {
    if (!SLOT_RE.test(slot)) throw new ValidationError('Key slot is not valid');
    return path.join(opts.dir, 'secrets', 'integrations', `${slot}.bin`);
  };
  const alias = (slot: string) => (Object.prototype.hasOwnProperty.call(opts.aliases ?? {}, slot) ? opts.aliases![slot] : undefined);
  return {
    async has(slot) {
      const a = alias(slot);
      if (a) return a.configured();
      const blob = await fs.read(file(slot));
      return blob !== null && blob.trim().length > 0;
    },
    async store(slot, key) {
      const a = alias(slot);
      if (a) { await a.set(key); return; }
      const p = file(slot);
      let enc: {ok: boolean; data?: string};
      try { enc = await opts.native.dpapi('protect', key); } catch { throw new Error('Windows DPAPI is unavailable; the key was not stored'); }
      if (!enc.ok || typeof enc.data !== 'string' || !CIPHER_RE.test(enc.data)) throw new Error('Windows DPAPI could not protect the key; the key was not stored');
      await fs.write(p, enc.data);
    },
    async remove(slot) {
      const a = alias(slot);
      if (a) { await a.delete(); return; }
      await fs.remove(file(slot));
    },
    async use(slot, fn) {
      const a = alias(slot);
      let key: string | null = null;
      if (a) key = await a.reveal();
      else {
        const blob = await fs.read(file(slot));
        if (blob === null || !blob.trim()) return null;
        try {
          const r = await opts.native.dpapi('unprotect', blob.trim());
          key = r.ok && r.data ? r.data : null;
        } catch { key = null; }
      }
      if (!key) return null;
      return fn(key);
    },
  };
}

/** Lookup helper for the captain/API owner (e.g. to label a chat provider). */
export const integrationDefinition = findIntegration;
