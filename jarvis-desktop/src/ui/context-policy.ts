/**
 * Explicit screen / active-app / clipboard context controls. Pure and DOM-free: no capture, no network, no storage
 * access here. The UI persists the policy through the existing non-sensitive prefs helper under CONTEXT_POLICY_PREF_KEY.
 * Every source defaults to 'off'; nothing is attached unless the user turns a source on and the decision allows it.
 */

export type ContextMode = 'off' | 'ask' | 'on';
export type ContextSource = 'screen' | 'activeApp' | 'clipboard';
export type ContextPolicy = {
  screen: ContextMode;
  activeApp: ContextMode;
  clipboard: ContextMode;
  allowedApps: string[];
  deniedApps: string[];
};

export const CONTEXT_SOURCES: readonly ContextSource[] = ['screen', 'activeApp', 'clipboard'];
export const CONTEXT_POLICY_PREF_KEY = 'assistant.contextPolicy';
export const CONTEXT_LIMITS = { appsPerList: 50, appNameChars: 120, excerptChars: 200, totalChars: 8000, items: 50 } as const;

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = Object.freeze({
  screen: 'off',
  activeApp: 'off',
  clipboard: 'off',
  allowedApps: Object.freeze([]) as unknown as string[],
  deniedApps: Object.freeze([]) as unknown as string[],
}) as ContextPolicy;

export const SOURCE_LABEL: Record<ContextSource, string> = { screen: 'screen', activeApp: 'active app', clipboard: 'clipboard' };

const isSource = (s: unknown): s is ContextSource => s === 'screen' || s === 'activeApp' || s === 'clipboard';

function normalizeMode(v: unknown): ContextMode {
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'off' || t === 'ask' || t === 'on') return t;
    return 'off';
  }
  // Legacy boolean toggles: an old "true" still requires a prompt rather than silently sharing.
  if (v === true) return 'ask';
  return 'off';
}

const appKey = (name: string) => name.toLowerCase();

function normalizeApps(v: unknown): string[] {
  const raw: unknown[] = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const name = item.replace(/\s+/g, ' ').trim().slice(0, CONTEXT_LIMITS.appNameChars).trim();
    if (!name) continue;
    const k = appKey(name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
    if (out.length >= CONTEXT_LIMITS.appsPerList) break;
  }
  return out;
}

/** Coerces any stored or legacy value into a valid policy. Denied apps win: they are removed from the allowed list. */
export function normalizeContextPolicy(raw: unknown): ContextPolicy {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const deniedApps = normalizeApps(r.deniedApps);
  const denied = new Set(deniedApps.map(appKey));
  const allowedApps = normalizeApps(r.allowedApps).filter((a) => !denied.has(appKey(a)));
  return { screen: normalizeMode(r.screen), activeApp: normalizeMode(r.activeApp), clipboard: normalizeMode(r.clipboard), allowedApps, deniedApps };
}

export type ContextRequest = { source: ContextSource; appName?: string };
export type ContextDecision = { allowed: boolean; requiresPrompt: boolean; reason: string };

/**
 * Whether one piece of context may be shared. Order: source off → denied app → allowed-list miss → ask → on.
 * A denied app blocks even when the source is 'on'; a non-empty allowed list lets only listed apps through.
 */
export function decideContextShare(policy: ContextPolicy, request: ContextRequest): ContextDecision {
  const p = normalizeContextPolicy(policy);
  if (!request || !isSource(request.source)) return { allowed: false, requiresPrompt: false, reason: 'unknown context source' };
  const mode = p[request.source];
  if (mode === 'off') return { allowed: false, requiresPrompt: false, reason: `${SOURCE_LABEL[request.source]} context is off` };
  const app = typeof request.appName === 'string' ? request.appName.replace(/\s+/g, ' ').trim() : '';
  if (app && p.deniedApps.some((d) => appKey(d) === appKey(app))) return { allowed: false, requiresPrompt: false, reason: `app "${app}" is denied` };
  if (p.allowedApps.length > 0) {
    if (!app) return { allowed: false, requiresPrompt: false, reason: 'no app name to check against the allowed list' };
    if (!p.allowedApps.some((a) => appKey(a) === appKey(app))) return { allowed: false, requiresPrompt: false, reason: `app "${app}" is not in the allowed list` };
  }
  if (mode === 'ask') return { allowed: false, requiresPrompt: true, reason: 'ask before sharing' };
  return { allowed: true, requiresPrompt: false, reason: `${SOURCE_LABEL[request.source]} context is on` };
}

export type ContextItem = { source: ContextSource; appName?: string; text: string };
export type ContextPreview = {
  included: { source: ContextSource; appName?: string; chars: number; excerpt: string }[];
  excluded: { source: ContextSource; appName?: string; reason: string }[];
  totalChars: number;
  truncated: boolean;
};

/**
 * Exactly what WOULD be attached for these items under the policy. Builds a preview only: it attaches nothing.
 * Sources that are off, denied, outside the allowed list or set to 'ask' are excluded (never auto-included).
 */
export function buildContextPreview(items: ContextItem[], policy: ContextPolicy, opts: { maxChars?: number; excerptChars?: number } = {}): ContextPreview {
  const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars as number) >= 0 ? Math.floor(opts.maxChars as number) : CONTEXT_LIMITS.totalChars;
  const excerptChars = Number.isFinite(opts.excerptChars) && (opts.excerptChars as number) >= 0 ? Math.floor(opts.excerptChars as number) : CONTEXT_LIMITS.excerptChars;
  const out: ContextPreview = { included: [], excluded: [], totalChars: 0, truncated: false };
  const list = Array.isArray(items) ? items : [];
  if (list.length > CONTEXT_LIMITS.items) out.truncated = true;
  for (const item of list.slice(0, CONTEXT_LIMITS.items)) {
    if (!item || !isSource(item.source)) continue;
    const appName = typeof item.appName === 'string' && item.appName.trim() ? item.appName.trim() : undefined;
    const tag = appName ? { source: item.source, appName } : { source: item.source };
    const d = decideContextShare(policy, { source: item.source, appName });
    if (!d.allowed) { out.excluded.push({ ...tag, reason: d.reason }); continue; }
    const text = typeof item.text === 'string' ? item.text : '';
    if (!text) { out.excluded.push({ ...tag, reason: 'empty' }); continue; }
    const remaining = maxChars - out.totalChars;
    if (remaining <= 0) { out.excluded.push({ ...tag, reason: 'total context limit reached' }); out.truncated = true; continue; }
    const chars = Math.min(text.length, remaining);
    if (chars < text.length) out.truncated = true;
    out.included.push({ ...tag, chars, excerpt: text.slice(0, Math.min(chars, excerptChars)) });
    out.totalChars += chars;
  }
  return out;
}

/** Parses a comma-separated app list from a text input. */
export const parseAppList = (text: string): string[] => normalizeApps(text);
