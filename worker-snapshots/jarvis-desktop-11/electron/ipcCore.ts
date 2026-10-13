// Pure IPC dispatch core (no Electron import, unit tested): sender trust, arity, error redaction.
import type {JarvisAPI} from '../src/shared/contracts';
import {ARITY, METHODS, type MethodName} from './channels';

/** True only for the packaged index.html (exact file) or, in development, the configured dev origin. */
export function isTrustedUrl(url: string | undefined, appFileUrl: string, devOrigin?: string): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') {
    let a: URL;
    try { a = new URL(appFileUrl); } catch { return false; }
    return a.protocol === 'file:' && decodeURIComponent(u.pathname).toLowerCase() === decodeURIComponent(a.pathname).toLowerCase();
  }
  return !!devOrigin && (u.protocol === 'http:') && u.origin === devOrigin;
}

/** User-safe error text: keeps the message, redacts user profile paths, bounds the length. */
export function safeErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : 'Request failed';
  return msg.replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, '%USERPROFILE%').replace(/\s+/g, ' ').slice(0, 400) || 'Request failed';
}

export interface RouterOptions {
  appFileUrl: string;
  devOrigin?: string;
}

export type HandlerMap = Pick<JarvisAPI, MethodName>;

/** Pure dispatcher, unit tested without Electron. */
export async function dispatch(handlers: HandlerMap, method: string, args: unknown[], senderUrl: string | undefined, opts: RouterOptions, isMainFrame = true): Promise<unknown> {
  if (!isMainFrame || !isTrustedUrl(senderUrl, opts.appFileUrl, opts.devOrigin)) throw new Error('Request rejected: untrusted sender');
  if (!(METHODS as readonly string[]).includes(method)) throw new Error('Unknown method');
  const m = method as MethodName;
  if (!Array.isArray(args) || args.length > ARITY[m]) throw new Error('Wrong number of arguments');
  try {
    return await (handlers[m] as (...a: unknown[]) => Promise<unknown>)(...args);
  } catch (e) {
    throw new Error(safeErrorMessage(e));
  }
}

