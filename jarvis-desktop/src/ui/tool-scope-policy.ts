// Pure, DOM-free renderer-side scope gate for computer actions.
// This is a pre-check only: it never runs, previews or approves anything, and it performs no
// network, file system or process access. The main process still previews, requires approval and
// enforces its own limits.

import type { ActionRequest } from '../shared/contracts';
import { TOOL_SCOPES, WORKER_ROLES } from './worker-roles';

/** Computer-action scope ids. worker-roles.ts TOOL_SCOPES has no matching ids, so they are defined here. */
export const ACTION_SCOPES: readonly string[] = Object.freeze(['windows.read', 'windows.control', 'apps.launch', 'web.open', 'input.inject']);
/** Every scope id a policy may hold: the computer-action scopes plus the worker-role tool scopes. */
export const KNOWN_SCOPES: readonly string[] = Object.freeze([...ACTION_SCOPES, ...TOOL_SCOPES.filter((s) => s !== 'none')]);

export type ScopePolicy = { scopes: string[]; allowedRoots: string[]; approvedApps: string[]; allowedHosts: string[]; maxTextChars: number };
export type ScopeDecision = { allowed: boolean; scope: string; reasons: string[] };

export const SCOPE_POLICY_PREF_KEY = 'computer.scopePolicy';
export const MAX_POLICY_ENTRIES = 50;
export const MAX_TEXT_CHARS_LIMIT = 20000;
export const DEFAULT_MAX_TEXT_CHARS = 2000;

export const DEFAULT_SCOPE_POLICY: Readonly<ScopePolicy> = Object.freeze({
  scopes: Object.freeze([]) as unknown as string[],
  allowedRoots: Object.freeze([]) as unknown as string[],
  approvedApps: Object.freeze([]) as unknown as string[],
  allowedHosts: Object.freeze([]) as unknown as string[],
  maxTextChars: DEFAULT_MAX_TEXT_CHARS,
});

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v));

function cleanList(v: unknown, map: (s: string) => string = (s) => s, keep: (s: string) => boolean = () => true): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = map(item.trim());
    if (!s || !keep(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_POLICY_ENTRIES) break;
  }
  return out;
}

function clampChars(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_MAX_TEXT_CHARS;
  return Math.min(MAX_TEXT_CHARS_LIMIT, Math.max(1, Math.floor(n)));
}

const normHost = (s: string) => s.toLowerCase().replace(/\.$/, '');

/** Bad input becomes the deny-all default. Lists are trimmed, de-duplicated and capped at 50 entries. */
export function normalizeScopePolicy(input: unknown): ScopePolicy {
  if (!isRecord(input)) return { scopes: [], allowedRoots: [], approvedApps: [], allowedHosts: [], maxTextChars: DEFAULT_MAX_TEXT_CHARS };
  return {
    scopes: cleanList(input.scopes, (s) => s, (s) => KNOWN_SCOPES.includes(s)),
    allowedRoots: cleanList(input.allowedRoots),
    approvedApps: cleanList(input.approvedApps),
    allowedHosts: cleanList(input.allowedHosts, normHost, (s) => /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s)),
    maxTextChars: clampChars(input.maxTextChars),
  };
}

/** Builds a policy from a worker role's tool scopes plus the settings' allowed roots and approved apps. Unknown roles get no scopes. */
export function policyFromRole(roleId: string, settings: { allowedRoots?: unknown; approvedApps?: unknown } | null | undefined): ScopePolicy {
  const role = WORKER_ROLES.find((r) => r.id === roleId);
  const s = isRecord(settings) ? settings : {};
  return normalizeScopePolicy({ scopes: role ? [...role.toolScopes] : [], allowedRoots: s.allowedRoots, approvedApps: s.approvedApps, allowedHosts: [], maxTextChars: DEFAULT_MAX_TEXT_CHARS });
}

const SCOPE_BY_TYPE: Record<ActionRequest['type'], string> = {
  'list-windows': 'windows.read',
  focus: 'windows.control',
  'move-window': 'windows.control',
  launch: 'apps.launch',
  'open-url': 'web.open',
  'type-text': 'input.inject',
  click: 'input.inject',
};

/** The scope an action needs, or '' for an unknown action type. */
export function requiredScopeFor(request: ActionRequest): string {
  const type = isRecord(request) ? request.type : undefined;
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(SCOPE_BY_TYPE, type) ? SCOPE_BY_TYPE[type as ActionRequest['type']] : '';
}

const isWindowsPath = (p: string) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.includes('\\');
const segments = (p: string) => p.split(/[\\/]+/);
const hasDotDot = (p: string) => segments(p).some((s) => s === '..');

/** Forward slashes, no repeated or trailing separators; lower-cased for Windows paths. */
function normPath(p: string): string {
  const win = isWindowsPath(p);
  let out = p.replace(/\\/g, '/');
  const unc = out.startsWith('//');
  out = out.replace(/\/{2,}/g, '/');
  if (unc) out = '/' + out;
  if (out.length > 1 && out.endsWith('/') && !/^[a-zA-Z]:\/$/.test(out)) out = out.replace(/\/+$/, '');
  return win ? out.toLowerCase() : out;
}

const baseName = (p: string) => {
  const parts = segments(p).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

function launchReasons(target: string, policy: ScopePolicy): string[] {
  if (!target) return ['Launch needs an app name or path.'];
  if (hasDotDot(target)) return ['Launch target contains a ".." path segment.'];
  const bare = !/[\\/]/.test(target);
  for (const app of policy.approvedApps) {
    if (app === target) return [];
    if (bare && baseName(app).toLowerCase() === target.toLowerCase()) return [];
    if (!bare && !hasDotDot(app) && /[\\/]/.test(app) && normPath(app) === normPath(target)) return [];
  }
  if (!bare) {
    const t = normPath(target);
    for (const rootEntry of policy.allowedRoots) {
      if (hasDotDot(rootEntry)) continue;
      const r = normPath(rootEntry);
      if (!r || r === '/') continue;
      // normPath lower-cases Windows paths, so Windows comparisons are case-insensitive and POSIX ones are not.
      const prefix = r.endsWith('/') ? r : r + '/';
      if (t === r || t.startsWith(prefix)) return [];
    }
  }
  return [`Launch target "${target}" is not an approved app and is not under an allowed root.`];
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true;
    } else if (host === entry) return true;
  }
  return false;
}

function urlReasons(target: string, policy: ScopePolicy): string[] {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return ['Open URL needs a full http:// or https:// address.'];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [`Scheme "${url.protocol}" is not allowed; only http and https.`];
  if (url.username || url.password) return ['Addresses with embedded credentials are not allowed.'];
  const host = normHost(url.hostname);
  if (!hostAllowed(host, policy.allowedHosts)) return [`Host "${host}" is not in the allowed hosts.`];
  return [];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
const int = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);

/** Applies, in order: missing scope, then the per-action checks. Every failing check adds one exact reason. */
export function evaluateActionScope(request: ActionRequest, policyInput: ScopePolicy): ScopeDecision {
  const policy = normalizeScopePolicy(policyInput);
  const scope = requiredScopeFor(request);
  if (!scope) return { allowed: false, scope: '', reasons: ['Unknown action type.'] };
  const reasons: string[] = [];
  if (!policy.scopes.includes(scope)) reasons.push(`Missing scope ${scope}.`);
  const target = typeof request.target === 'string' ? request.target.trim() : '';
  switch (request.type) {
    case 'launch':
      reasons.push(...launchReasons(target, policy));
      break;
    case 'open-url':
      reasons.push(...urlReasons(target, policy));
      break;
    case 'type-text': {
      const text = typeof request.text === 'string' ? request.text : '';
      if (!target) reasons.push('Type text needs a target window.');
      if (!text) reasons.push('Type text needs text.');
      if (text.length > policy.maxTextChars) reasons.push(`Text is ${text.length} characters; the policy allows at most ${policy.maxTextChars}.`);
      if (CONTROL.test(text)) reasons.push('Text contains control characters other than newline or tab.');
      break;
    }
    case 'click':
    case 'move-window':
      if (!target) reasons.push(`${request.type === 'click' ? 'Click' : 'Move window'} needs a target window.`);
      if (!int(request.x) || !int(request.y)) reasons.push('Coordinates x and y must be finite whole numbers.');
      if (request.type === 'move-window' && ((request.width !== undefined && !(int(request.width) && (request.width as number) > 0)) || (request.height !== undefined && !(int(request.height) && (request.height as number) > 0))))
        reasons.push('Width and height must be positive whole numbers.');
      break;
    case 'focus':
      if (!target) reasons.push('Focus needs a target window.');
      break;
    default:
      break;
  }
  return { allowed: reasons.length === 0, scope, reasons };
}

/** Plain-text summary lines of a policy. */
export function describePolicy(policyInput: ScopePolicy): string[] {
  const p = normalizeScopePolicy(policyInput);
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  const actionScopes = p.scopes.filter((s) => ACTION_SCOPES.includes(s));
  return [
    `Scopes: ${p.scopes.length ? p.scopes.join(', ') : 'none (every computer action is denied)'}`,
    `Computer-action scopes: ${actionScopes.length ? actionScopes.join(', ') : 'none'}`,
    `Allowed roots: ${list(p.allowedRoots)}`,
    `Approved apps: ${list(p.approvedApps)}`,
    `Allowed hosts: ${list(p.allowedHosts)}`,
    `Max text characters: ${p.maxTextChars}`,
  ];
}

/** Persisted UI preference: which role (or 'manual') and the manual parts of the policy. */
export type ScopePref = { roleId: string; scopes: string[]; allowedHosts: string[]; maxTextChars: number };
export const MANUAL_ROLE = 'manual';

export function normalizeScopePref(input: unknown): ScopePref {
  const r = isRecord(input) ? input : {};
  const roleId = typeof r.roleId === 'string' && WORKER_ROLES.some((w) => w.id === r.roleId) ? r.roleId : MANUAL_ROLE;
  const p = normalizeScopePolicy(r);
  return { roleId, scopes: p.scopes, allowedHosts: p.allowedHosts, maxTextChars: p.maxTextChars };
}

/** Effective policy: role scopes (or manual scopes) plus settings roots/apps and the saved hosts/limit. */
export function effectivePolicy(prefInput: unknown, settings: { allowedRoots?: unknown; approvedApps?: unknown } | null | undefined): ScopePolicy {
  const pref = normalizeScopePref(prefInput);
  const s = isRecord(settings) ? settings : {};
  const scopes = pref.roleId === MANUAL_ROLE ? pref.scopes : policyFromRole(pref.roleId, s).scopes;
  return normalizeScopePolicy({ scopes, allowedRoots: s.allowedRoots, approvedApps: s.approvedApps, allowedHosts: pref.allowedHosts, maxTextChars: pref.maxTextChars });
}
