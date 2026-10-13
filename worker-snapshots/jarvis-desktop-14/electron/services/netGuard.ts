// The ONLY HTTP egress path from the main process. No other module may call fetch / net / http(s).
// Filesystem access cannot reach the network either: paths.ts accepts local drive paths only (no UNC/WebDAV/device paths).
import type {Mode} from '../../src/shared/contracts';
import {isLoopbackHost} from './validation';

export type Purpose = 'ollama' | 'cloud-chat';

export class NetworkDenied extends Error {}

export interface GuardContext {
  mode: () => Mode;
  hasCloudKey: () => boolean;
  /** Called for every allowed and denied attempt; origin and purpose only. */
  audit?: (decision: 'allowed' | 'denied', origin: string, purpose: string, reason?: string) => void;
  fetchImpl?: typeof fetch;
  /** Test hook: origin that stands in for api.anthropic.com. Never set in production. */
  cloudOriginOverride?: string;
}

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com';

/** Pure decision function, unit tested. Returns null when allowed, otherwise the denial reason. */
export function evaluateEgress(rawUrl: string, purpose: string, mode: Mode, hasCloudKey: boolean, cloudOrigin = ANTHROPIC_ORIGIN): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return 'Invalid URL'; }
  if (u.username || u.password) return 'URLs with credentials are not allowed';
  if (u.origin === cloudOrigin) {
    if (purpose !== 'cloud-chat') return 'Cloud origin is only for cloud chat';
    if (mode !== 'online') return 'Offline mode: cloud requests are blocked';
    if (!hasCloudKey) return 'No cloud API key is configured';
    return null;
  }
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) {
    return purpose === 'ollama' ? null : 'Loopback is only for the local model';
  }
  return mode === 'offline' ? 'Offline mode: only loopback addresses are allowed' : 'Destination is not on the allow list';
}

export function createGuardedFetch(ctx: GuardContext) {
  return async function guardedFetch(url: string, init: RequestInit & {timeoutMs?: number} = {}, purpose: Purpose): Promise<Response> {
    const reason = evaluateEgress(url, purpose, ctx.mode(), ctx.hasCloudKey(), ctx.cloudOriginOverride);
    let origin = '(invalid)';
    try { origin = new URL(url).origin; } catch { /* keep placeholder */ }
    if (reason) {
      ctx.audit?.('denied', origin, purpose, reason);
      throw new NetworkDenied(reason);
    }
    ctx.audit?.('allowed', origin, purpose);
    const {timeoutMs, ...rest} = init;
    const signal = rest.signal ?? AbortSignal.timeout(timeoutMs ?? 120_000);
    return (ctx.fetchImpl ?? fetch)(url, {...rest, signal, redirect: 'error'});
  };
}
export type GuardedFetch = ReturnType<typeof createGuardedFetch>;
