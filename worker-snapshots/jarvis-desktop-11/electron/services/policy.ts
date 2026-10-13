// Pure policy: action request validation, target authorization, window selection. No side effects.
import * as nodePath from 'node:path';
import type {ActionRequest, Settings} from '../../src/shared/contracts';
import type {WindowInfo} from '../native/adapter';
import {FsLike, hasControlChars, normalizeAbsolutePath, realFs, resolveInsideRoots, samePath} from './paths';
import {LIMITS, ValidationError} from './validation';

const w = nodePath.win32;

export const ACTION_TYPES = ['launch', 'focus', 'move-window', 'type-text', 'click', 'open-url', 'list-windows'] as const;

export function validateActionRequest(raw: unknown): ActionRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError('action must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['type', 'target', 'text', 'x', 'y', 'width', 'height'].includes(k)) throw new ValidationError(`Unknown action field "${k}"`);
  if (typeof o.type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(o.type)) throw new ValidationError('Unsupported action type');
  const req: ActionRequest = {type: o.type as ActionRequest['type']};
  if (o.target !== undefined) {
    if (typeof o.target !== 'string' || o.target.length > 2048 || hasControlChars(o.target)) throw new ValidationError('target is invalid');
    req.target = o.target.trim();
  }
  if (o.text !== undefined) {
    if (typeof o.text !== 'string') throw new ValidationError('text must be a string');
    if (o.text.length > LIMITS.typeChars) throw new ValidationError(`text is too long (max ${LIMITS.typeChars})`);
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(o.text)) throw new ValidationError('text contains control characters');
    req.text = o.text;
  }
  for (const k of ['x', 'y'] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'number' || !Number.isInteger(o[k]) || Math.abs(o[k] as number) > 100000) throw new ValidationError(`${k} must be an integer`);
      req[k] = o[k] as number;
    }
  }
  for (const k of ['width', 'height'] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'number' || !Number.isInteger(o[k]) || (o[k] as number) < 1 || (o[k] as number) > 100000) throw new ValidationError(`${k} must be a positive integer`);
      req[k] = o[k] as number;
    }
  }
  return req;
}

/** http(s) and mailto only. No credentials, no control chars, bounded length. */
export function validateOpenUrl(target: unknown): {ok: true; url: string} | {ok: false; reason: string} {
  if (typeof target !== 'string' || !target.trim()) return {ok: false, reason: 'A URL is required'};
  const t = target.trim();
  if (t.length > 2048) return {ok: false, reason: 'URL is too long'};
  if (hasControlChars(t) || /\s/.test(t)) return {ok: false, reason: 'URL contains whitespace or control characters'};
  let u: URL;
  try { u = new URL(t); } catch { return {ok: false, reason: 'URL is not valid'}; }
  if (u.protocol === 'mailto:') return u.pathname ? {ok: true, url: u.href} : {ok: false, reason: 'mailto URL has no recipient'};
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return {ok: false, reason: `Only http, https and mailto links can be opened (not ${u.protocol})`};
  if (!u.hostname) return {ok: false, reason: 'URL has no host'};
  if (u.username || u.password) return {ok: false, reason: 'URLs containing credentials are not allowed'};
  return {ok: true, url: u.href};
}

/** Returns the approved entry (never the raw target) that authorizes launching this app, or null. */
export function matchApprovedApp(target: string, approvedApps: string[]): string | null {
  const t = target.trim();
  if (!t) return null;
  if (/[\\/]/.test(t) || /^[a-zA-Z]:/.test(t)) {
    const n = normalizeAbsolutePath(t);
    if ('error' in n) return null;
    return approvedApps.find((e) => !/^[A-Za-z0-9._ -]+\.exe$/i.test(e) && samePath(e, n.path)) ?? null;
  }
  const lower = t.toLowerCase();
  const withExe = lower.endsWith('.exe') ? lower : lower + '.exe';
  return approvedApps.find((e) => {
    const base = w.basename(e).toLowerCase();
    return e.toLowerCase() === lower || base === lower || base === withExe;
  }) ?? null;
}

export type LaunchPlan =
  | {kind: 'launch-app'; entry: string}
  | {kind: 'launch-path'; path: string; isDirectory: boolean}
  | {kind: 'open-url'; url: string};

export type Authorization = {ok: true; plan: LaunchPlan} | {ok: false; reason: string};

/**
 * Single authority for "may Jarvis open this?". Used by previewAction, executeAction (re-check) and capsule restore.
 * kind 'any' is used by the generic launch action.
 */
export async function authorizeTarget(
  kind: 'file' | 'folder' | 'url' | 'app' | 'any',
  target: string,
  settings: Pick<Settings, 'allowedRoots' | 'approvedApps'>,
  fs: FsLike = realFs,
): Promise<Authorization> {
  const t = (target ?? '').trim();
  if (!t) return {ok: false, reason: 'No target was given'};
  if (kind === 'url') {
    const u = validateOpenUrl(t);
    return u.ok ? {ok: true, plan: {kind: 'open-url', url: u.url}} : {ok: false, reason: u.reason};
  }
  if (kind === 'any' && /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//.test(t) && !/^[a-zA-Z]:[\\/]/.test(t)) {
    return {ok: false, reason: 'URLs are opened with the open-url action, not launch'};
  }
  if (kind === 'app' || kind === 'any') {
    const entry = matchApprovedApp(t, settings.approvedApps);
    if (entry) return {ok: true, plan: {kind: 'launch-app', entry}};
    if (kind === 'app') return {ok: false, reason: 'App is not in the approved apps list'};
  }
  const r = await resolveInsideRoots(t, settings.allowedRoots, fs);
  if (!r.ok) {
    return {ok: false, reason: kind === 'any' && !/[\\/]/.test(t) ? 'Not an approved app, and not a path inside the allowed folders' : r.reason};
  }
  if (kind === 'file' && r.isDirectory) return {ok: false, reason: 'Target is a folder, not a file'};
  if (kind === 'folder' && !r.isDirectory) return {ok: false, reason: 'Target is a file, not a folder'};
  return {ok: true, plan: {kind: 'launch-path', path: r.path, isDirectory: r.isDirectory}};
}

export type WindowSelection = {ok: true; window: WindowInfo} | {ok: false; reason: string};

/** `hwnd:<n>` selects exactly; otherwise title substring or exact process name. Ambiguity is refused. Empty = foreground. */
export function selectWindow(target: string | undefined, windows: WindowInfo[], allowForegroundDefault: boolean): WindowSelection {
  const t = (target ?? '').trim();
  if (!t) {
    if (!allowForegroundDefault) return {ok: false, reason: 'A target window is required'};
    const fg = windows.find((x) => x.foreground);
    return fg ? {ok: true, window: fg} : {ok: false, reason: 'No foreground window was found'};
  }
  const m = /^hwnd:(\d{1,18})$/i.exec(t);
  if (m) {
    const win = windows.find((x) => x.hwnd === Number(m[1]));
    return win ? {ok: true, window: win} : {ok: false, reason: 'No visible window has that handle'};
  }
  const lower = t.toLowerCase();
  const hits = windows.filter((x) => x.title.toLowerCase().includes(lower) || x.process.toLowerCase() === lower);
  if (hits.length === 0) return {ok: false, reason: `No visible window matches "${t.slice(0, 60)}"`};
  if (hits.length > 1) return {ok: false, reason: `${hits.length} windows match "${t.slice(0, 60)}"; use hwnd:<number> from list-windows to pick one`};
  return {ok: true, window: hits[0]};
}

export function checkWindowPolicy(win: WindowInfo, type: ActionRequest['type'], selfPids: number[]): string | null {
  if (selfPids.includes(win.pid)) return 'Jarvis Desktop windows cannot be controlled';
  if (win.elevated !== 0) return 'The window is elevated or protected; Windows does not allow it';
  if (!win.process) return 'The owning process of this window could not be identified';
  if (type === 'type-text' || type === 'click') {
    if (win.minimized) return 'The window is minimized';
    if (!win.foreground) return 'The window is not in the foreground; run a focus action first';
  }
  return null;
}
