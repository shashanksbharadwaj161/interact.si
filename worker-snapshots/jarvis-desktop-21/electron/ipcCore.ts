// Pure IPC dispatch core (no Electron import, unit tested): sender trust, arity, error redaction,
// plus the small pure policies main.ts needs (file-request confinement, dev URL, trusted confirmation).
import * as nodePath from 'node:path';
import type {JarvisAPI} from '../src/shared/contracts';
import {ARITY, METHODS, type MethodName} from './channels';

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function decodedPath(u: URL): string | null {
  try { return decodeURIComponent(u.pathname); } catch { return null; }
}

/** True only for the packaged index.html (exact file, empty host) or, in development, the configured dev origin. */
export function isTrustedUrl(url: string | undefined, appFileUrl: string, devOrigin?: string): boolean {
  if (!url) return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'file:') {
    let a: URL;
    try { a = new URL(appFileUrl); } catch { return false; }
    // A file URL with a host is a UNC/SMB location, never the app.
    if (a.protocol !== 'file:' || u.host !== '' || a.host !== '') return false;
    const up = decodedPath(u), ap = decodedPath(a);
    return up !== null && ap !== null && samePath(up, ap);
  }
  return !!devOrigin && (u.protocol === 'http:') && u.origin === devOrigin;
}

/** A file: request is allowed only with an empty host and a path inside the packaged dist directory. */
export function isAllowedFileRequest(url: string, distDir: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'file:' || u.host !== '') return false;
  const p = decodedPath(u);
  if (p === null || p.includes('\0')) return false;
  const file = nodePath.win32.normalize(p.replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\'));
  const root = nodePath.win32.normalize(distDir).replace(/[\\/]+$/, '');
  if (file.startsWith('\\\\') || !/^[A-Za-z]:\\/.test(file)) return false;
  return file.toLowerCase() === root.toLowerCase() || file.toLowerCase().startsWith(`${root.toLowerCase()}\\`);
}

export function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && Number(m[1]) === 127 && m.slice(1).every((o) => Number(o) <= 255);
}

/** Dev server origin is honoured only when it is a plain http loopback origin. Returns the origin or null. */
export function parseDevOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' || u.username || u.password || !isLoopbackHostname(u.hostname)) return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Session-level request allow-list (webRequest.onBeforeRequest). Everything else is cancelled, which keeps offline mode offline:
 * file: only inside dist with an empty host, devtools:/data:/blob: (no network), and the loopback dev origin (http + ws) in development.
 */
export function isAllowedRequestUrl(url: string, distDir: string, devOrigin?: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  switch (u.protocol) {
    case 'file:': return isAllowedFileRequest(url, distDir);
    case 'devtools:': case 'data:': case 'blob:': return true;
    case 'http:': case 'ws:': {
      if (!devOrigin) return false;
      let d: URL;
      try { d = new URL(devOrigin); } catch { return false; }
      return d.protocol === 'http:' && isLoopbackHostname(d.hostname) && !u.username && !u.password && u.host.toLowerCase() === d.host.toLowerCase();
    }
    default: return false;
  }
}

/** Test mode may only run against an isolated temp userData whose folder name starts with a fixture prefix. */
export function isTestFixtureDir(dir: string, tmpDir: string, prefixes: readonly string[] = ['jarvis-smoke-', 'jarvis-test-', 'desktop-companion-test-']): boolean {
  const d = nodePath.win32.resolve(dir), t = nodePath.win32.resolve(tmpDir).replace(/[\\/]+$/, '');
  if (nodePath.win32.dirname(d).toLowerCase() !== t.toLowerCase()) return false;
  const base = nodePath.win32.basename(d).toLowerCase();
  return prefixes.some((p) => base.startsWith(p) && base.length > p.length);
}

export interface ConfirmWindowLike { isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean }

export interface MessageBoxOptions {
  type: 'warning'; title: string; message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number; noLink: true;
}

export interface TrustedConfirmDeps<W extends ConfirmWindowLike> {
  getWindow(): W | null;
  /** True when the window has finished loading the trusted app page. */
  isTrusted(win: W): boolean;
  showMessageBox(win: W, options: MessageBoxOptions): Promise<{response: number}>;
}

/**
 * Builds BackendEnv.confirm. The dialog is owned by the main window, defaults to Cancel and carries the full detail.
 * Fails closed: no visible, focused, ready, trusted window; a dialog already open; or any dialog error -> false.
 */
export function createTrustedConfirm<W extends ConfirmWindowLike>(deps: TrustedConfirmDeps<W>): (summary: string, detail: string) => Promise<boolean> {
  let open = false;
  return async (summary, detail) => {
    if (open || typeof summary !== 'string' || typeof detail !== 'string') return false;
    const win = deps.getWindow();
    try {
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused() || !deps.isTrusted(win)) return false;
    } catch { return false; }
    open = true;
    try {
      const r = await deps.showMessageBox(win, {
        type: 'warning', title: 'Desktop Companion', message: summary.slice(0, 300), detail,
        buttons: ['Cancel', 'Continue'], defaultId: 0, cancelId: 0, noLink: true,
      });
      return r.response === 1;
    } catch { return false; } finally { open = false; }
  };
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
