// The ONLY HTTP egress path from the main process. No other module may call fetch / net / http(s).
// Filesystem access cannot reach the network either: paths.ts accepts local drive paths only (no UNC/WebDAV/device paths).
//
// Policy in one place:
//  - Cloud chat: exactly one origin, one path, POST, only for 'cloud-chat', only in online mode with a key, rate capped.
//  - Provider checks: 'provider-check' may GET exactly the PROVIDER_CHECKS origin+path+query triples, only in online
//    mode, with only the credential header listed for that entry, and shares the cloud rate cap.
//  - Loopback: only for purposes listed in LOOPBACK_PURPOSES, only listed routes and methods, and (when the caller
//    supplies the configured endpoint) only that exact origin, so a changed port or service is never reached by accident.
//  - Redirects are never followed; credential headers never go anywhere except where an entry above names them.
import type {Mode} from '../../src/shared/contracts';
import {isLoopbackHost} from './validation';

export type Purpose = 'ollama' | 'cloud-chat' | 'provider-check';

export class NetworkDenied extends Error {}

export interface LoopbackRoute {
  /** Exact pathname, or a RegExp that must match the whole pathname. */
  path: string | RegExp;
  methods: readonly string[];
}

/**
 * Explicit table of loopback purposes. A new local model service needs a new entry here (and a matching Purpose),
 * agreed with the owner of the shared API surface; nothing else may talk to loopback.
 */
export const LOOPBACK_PURPOSES: Readonly<Record<string, {routes: readonly LoopbackRoute[]}>> = {
  ollama: {
    routes: [
      {path: '/api/version', methods: ['GET']},
      {path: '/api/tags', methods: ['GET']},
      {path: '/api/ps', methods: ['GET']},
      {path: '/api/show', methods: ['POST']},
      {path: '/api/chat', methods: ['POST']},
      {path: '/api/generate', methods: ['POST']},
      {path: '/api/pull', methods: ['POST']},
      {path: '/api/create', methods: ['POST']},
      // Model blob upload: existence check (HEAD) then upload (POST), addressed by a full sha256 digest.
      {path: /^\/api\/blobs\/sha256:[0-9a-f]{64}$/, methods: ['HEAD', 'POST']},
    ],
  },
};

export const CLOUD_PATHS: readonly string[] = ['/v1/messages'];
export const MAX_CLOUD_REQUESTS_PER_MINUTE = 30;

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';

export interface ProviderCheck {
  id: string;
  origin: string;
  path: string;
  /** Exact query string including the leading '?', or absent for none. Nothing else may ride along in the URL. */
  query?: string;
  /** Credential header this check may carry (lower case); none means no credentials at all. */
  credentialHeader?: string;
}

/**
 * The only destinations 'provider-check' may reach (GET). These checks verify a credential or read public data;
 * they never need, and are never allowed, the Anthropic chat key gate (hasCloudKey is about chat only).
 */
export const PROVIDER_CHECKS: readonly ProviderCheck[] = [
  {id: 'anthropic', origin: ANTHROPIC_ORIGIN, path: '/v1/models', credentialHeader: 'x-api-key'},
  {id: 'openai', origin: 'https://api.openai.com', path: '/v1/models', credentialHeader: 'authorization'},
  {id: 'github', origin: 'https://api.github.com', path: '/user', credentialHeader: 'authorization'},
  {id: 'open-meteo', origin: 'https://api.open-meteo.com', path: '/v1/forecast', query: '?latitude=0&longitude=0&current=temperature_2m'},
];

export interface GuardContext {
  mode: () => Mode;
  hasCloudKey: () => boolean;
  /** Called for every allowed and denied attempt; origin and purpose only. */
  audit?: (decision: 'allowed' | 'denied', origin: string, purpose: string, reason?: string) => void;
  fetchImpl?: typeof fetch;
  /** Test hook: origin that stands in for api.anthropic.com. Never set in production. */
  cloudOriginOverride?: string;
  /** Configured local model endpoint. When given, loopback requests must go to exactly this origin. */
  localEndpoint?: () => string;
  /** Clock for the cloud rate cap (tests). */
  now?: () => number;
  /** Cloud requests (chat and provider checks together) allowed per minute (default MAX_CLOUD_REQUESTS_PER_MINUTE). */
  maxCloudPerMinute?: number;
}

/** Every header that carries a credential. Each route below names the only one it may send; all others are refused. */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'proxy-authorization', 'cookie'];

function headerNames(h: HeadersInit | undefined): string[] {
  if (!h) return [];
  if (typeof Headers !== 'undefined' && h instanceof Headers) return [...h.keys()].map((k) => k.toLowerCase());
  if (Array.isArray(h)) return h.map((p) => String(p[0]).toLowerCase());
  return Object.keys(h).map((k) => k.toLowerCase());
}

function routeMatches(route: LoopbackRoute, pathname: string): boolean {
  return typeof route.path === 'string' ? route.path === pathname : route.path.test(pathname);
}

/** Pure decision function, unit tested. Returns null when allowed, otherwise the denial reason. */
export function evaluateEgress(
  rawUrl: string,
  purpose: string,
  mode: Mode,
  hasCloudKey: boolean,
  cloudOrigin = ANTHROPIC_ORIGIN,
  opts: {localEndpoint?: string; method?: string; headers?: HeadersInit} = {},
): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return 'Invalid URL'; }
  if (u.username || u.password) return 'URLs with credentials are not allowed';
  // A pure caller may omit the method; guardedFetch always passes the real one (default GET, like fetch).
  const method = opts.method?.toUpperCase();
  const sensitive = headerNames(opts.headers).filter((h) => CREDENTIAL_HEADERS.includes(h));

  if (purpose === 'provider-check') {
    const entry = PROVIDER_CHECKS.find((c) => (c.origin === ANTHROPIC_ORIGIN ? cloudOrigin : c.origin) === u.origin && c.path === u.pathname && (c.query ?? '') === u.search);
    if (!entry) return 'Provider checks are limited to the listed provider endpoints';
    if (mode !== 'online') return 'Offline mode: provider checks are blocked';
    if (method !== undefined && method !== 'GET') return 'Provider checks must use GET';
    if (sensitive.some((h) => h !== entry.credentialHeader)) return 'Credential header is not allowed for this provider check';
    return null;
  }

  if (u.origin === cloudOrigin) {
    if (purpose !== 'cloud-chat') return 'Cloud origin is only for cloud chat';
    if (mode !== 'online') return 'Offline mode: cloud requests are blocked';
    if (!hasCloudKey) return 'No cloud API key is configured';
    if (!CLOUD_PATHS.includes(u.pathname)) return 'Cloud requests are limited to the chat endpoint';
    if (method !== undefined && method !== 'POST') return 'Cloud chat requests must use POST';
    if (sensitive.some((h) => h !== 'x-api-key')) return 'Only the API key header may be sent to the cloud provider';
    return null;
  }
  if (sensitive.length) return 'Credential headers may only be sent to the cloud provider';
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) {
    const rule = LOOPBACK_PURPOSES[purpose];
    if (!rule) return 'Loopback is only for the local model';
    const route = rule.routes.find((r) => routeMatches(r, u.pathname));
    if (!route) return 'Local model requests are limited to the model API paths';
    if (method !== undefined && !route.methods.includes(method)) return `Local model requests to ${route.path instanceof RegExp ? 'this path' : route.path} may not use ${method}`;
    if (opts.localEndpoint !== undefined && u.origin !== opts.localEndpoint) return 'Loopback address is not the configured local model endpoint';
    return null;
  }
  return mode === 'offline' ? 'Offline mode: only loopback addresses are allowed' : 'Destination is not on the allow list';
}

export function createGuardedFetch(ctx: GuardContext) {
  const cloudStamps: number[] = [];
  const clock = ctx.now ?? Date.now;
  const cloudCap = ctx.maxCloudPerMinute ?? MAX_CLOUD_REQUESTS_PER_MINUTE;
  return async function guardedFetch(url: string, init: RequestInit & {timeoutMs?: number} = {}, purpose: Purpose): Promise<Response> {
    let origin = '(invalid)';
    try { origin = new URL(url).origin; } catch { /* keep placeholder */ }
    // provider-check never depends on the Anthropic chat key: pass true so only chat is gated on it.
    const reason = evaluateEgress(url, purpose, ctx.mode(), purpose === 'provider-check' ? true : ctx.hasCloudKey(), ctx.cloudOriginOverride, {
      localEndpoint: ctx.localEndpoint?.(), method: init.method ?? 'GET', headers: init.headers,
    });
    if (reason) {
      ctx.audit?.('denied', origin, purpose, reason);
      throw new NetworkDenied(reason);
    }
    if (purpose === 'cloud-chat' || purpose === 'provider-check') {
      const t = clock();
      while (cloudStamps.length && t - cloudStamps[0] >= 60_000) cloudStamps.shift();
      if (cloudStamps.length >= cloudCap) {
        const why = `Cloud request limit reached (${cloudCap} per minute)`;
        ctx.audit?.('denied', origin, purpose, why);
        throw new NetworkDenied(why);
      }
      cloudStamps.push(t);
    }
    ctx.audit?.('allowed', origin, purpose);
    const {timeoutMs, ...rest} = init;
    // The timeout always applies, even when the caller brings its own cancellation signal. AbortSignal.any keeps the
    // reason of whichever source fired first, so a caller abort surfaces the caller's own reason (never TimeoutError).
    const timeout = AbortSignal.timeout(timeoutMs ?? 120_000);
    const signal = rest.signal ? AbortSignal.any([rest.signal, timeout]) : timeout;
    return (ctx.fetchImpl ?? fetch)(url, {...rest, signal, redirect: 'error'});
  };
}
export type GuardedFetch = ReturnType<typeof createGuardedFetch>;
