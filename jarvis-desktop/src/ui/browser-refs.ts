// Pure, DOM-free parser for pasted browser bookmarks and tab lists (scope 47: browser-profile and tab adapters).
// It reads only the text it is given: no network, no filesystem, no browser profile, no live tabs.
// Supported inputs: Netscape bookmark HTML exports, a JSON array of {title|name, url}, Markdown links and plain lines.
import type { Capsule } from '../shared/contracts';

export const BROWSER_REFS_LIMITS = { inputChars: 400000, items: 500, labelChars: 160 } as const;

/** Longest URL kept; matches the capsule item target limit enforced by the main process. */
const MAX_TARGET_CHARS = 2048;

export type BrowserRef = { kind: 'url'; target: string; label: string; folder?: string; addedAt?: string };
export type BrowserRefSkip = { line: number; reason: string };
export type BrowserRefFormat = 'netscape-html' | 'json' | 'markdown' | 'lines';
export type BrowserRefsResult = { items: BrowserRef[]; skipped: BrowserRefSkip[]; folders: string[]; detected: BrowserRefFormat; truncated: boolean };
type CapsuleItem = Capsule['items'][number];

/** Exact skip reasons, exported so the UI and tests use the same wording. */
export const BROWSER_REF_REASONS = {
  javascript: 'Blocked scheme javascript: (scripts are never imported)',
  data: 'Blocked scheme data: (inline data is never imported)',
  file: 'Blocked scheme file: (local files are not imported as links)',
  chrome: 'Blocked scheme chrome: (browser-internal pages cannot be opened as links)',
  credentials: 'URL contains embedded credentials (user:password@); not imported',
  notAbsolute: 'Not an absolute http(s) URL',
  malformed: 'Malformed URL',
  whitespace: 'URL contains spaces or control characters',
  tooLong: `URL is longer than ${MAX_TARGET_CHARS} characters`,
  duplicate: 'Duplicate of an earlier link (same normalized URL)',
  jsonEntry: 'JSON entry has no "url" string',
  unrecognizedLine: 'Line is not "title<TAB>url", "url" or "title - url"',
} as const;

const unsupported = (scheme: string) => `Unsupported scheme ${scheme}: (only http and https are kept)`;

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8}|#39);/gi, (m, body: string) => {
    const b = body.toLowerCase();
    if (b.startsWith('#x') || (b.startsWith('#') && b !== '#39')) {
      const cp = b.startsWith('#x') ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[b] ?? m;
  });
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;

function cleanLabel(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/g, ' ')).replace(CONTROL_OR_INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, BROWSER_REFS_LIMITS.labelChars).trim();
}

/** Lowercase scheme and host, drop the fragment and trailing '/'. Unparseable text falls back to trimmed lowercase. */
export function normalizeBrowserUrl(target: string): string {
  try {
    const u = new URL(target.trim());
    u.hash = '';
    return u.href.replace(/\/+$/, '');
  } catch {
    return target.trim().toLowerCase().replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

type Classified = { ok: true; target: string; url: URL } | { ok: false; reason: string };

function classifyUrl(raw: string): Classified {
  const s = raw.trim();
  if (s.length > MAX_TARGET_CHARS) return { ok: false, reason: BROWSER_REF_REASONS.tooLong };
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!m) return { ok: false, reason: BROWSER_REF_REASONS.notAbsolute };
  const scheme = m[1].toLowerCase();
  if (scheme === 'javascript') return { ok: false, reason: BROWSER_REF_REASONS.javascript };
  if (scheme === 'data') return { ok: false, reason: BROWSER_REF_REASONS.data };
  if (scheme === 'file') return { ok: false, reason: BROWSER_REF_REASONS.file };
  if (scheme === 'chrome' || scheme === 'chrome-extension') return { ok: false, reason: BROWSER_REF_REASONS.chrome };
  if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: unsupported(scheme) };
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return { ok: false, reason: BROWSER_REF_REASONS.whitespace };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: BROWSER_REF_REASONS.malformed };
  }
  if (u.username || u.password) return { ok: false, reason: BROWSER_REF_REASONS.credentials };
  if (!u.hostname) return { ok: false, reason: BROWSER_REF_REASONS.malformed };
  if (u.href.length > MAX_TARGET_CHARS) return { ok: false, reason: BROWSER_REF_REASONS.tooLong };
  return { ok: true, target: u.href, url: u };
}

function fallbackLabel(u: URL): string {
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return cleanLabel(`${u.hostname}${path}`) || u.hostname;
}

/** Accumulates items with validation, dedupe and the item cap. */
class Collector {
  items: BrowserRef[] = [];
  skipped: BrowserRefSkip[] = [];
  truncated = false;
  candidates = 0;
  private seen = new Set<string>();

  add(line: number, rawUrl: string, rawTitle: string | undefined, extra: { folder?: string; addedAt?: string } = {}) {
    this.candidates++;
    const c = classifyUrl(rawUrl);
    if (!c.ok) return void this.skipped.push({ line, reason: c.reason });
    const key = normalizeBrowserUrl(c.target);
    if (this.seen.has(key)) return void this.skipped.push({ line, reason: BROWSER_REF_REASONS.duplicate });
    if (this.items.length >= BROWSER_REFS_LIMITS.items) {
      this.truncated = true;
      return;
    }
    this.seen.add(key);
    const label = (rawTitle !== undefined ? cleanLabel(rawTitle) : '') || fallbackLabel(c.url);
    const item: BrowserRef = { kind: 'url', target: c.target, label };
    if (extra.folder) item.folder = extra.folder;
    if (extra.addedAt) item.addedAt = extra.addedAt;
    this.items.push(item);
  }
}

function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function unixToIso(v: string | undefined): string | undefined {
  if (!v || !/^\d{1,13}$/.test(v.trim())) return undefined;
  let n = Number(v.trim());
  if (n <= 0) return undefined;
  if (n > 1e11) n = Math.floor(n / 1000); // milliseconds were used instead of seconds
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function parseNetscape(text: string, col: Collector) {
  const stack: (string | null)[] = [];
  let pending: string | null = null;
  const tagRe = /<\s*(\/?)\s*(dl|h3|a)\b([^>]*)>/gi;
  let line = 1;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    for (let i = lastIdx; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
    lastIdx = m.index;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'dl') {
      if (closing) stack.pop();
      else {
        stack.push(pending);
        pending = null;
      }
      continue;
    }
    if (closing) continue;
    const end = text.slice(tagRe.lastIndex).search(tag === 'h3' ? /<\s*\/\s*h3\s*>/i : /<\s*\/\s*a\s*>/i);
    const inner = end >= 0 ? text.slice(tagRe.lastIndex, tagRe.lastIndex + end) : '';
    if (tag === 'h3') {
      pending = cleanLabel(inner).replace(/\//g, '-') || 'Untitled folder';
      continue;
    }
    const a = attrs(m[3]);
    if (a.href === undefined) continue;
    const folder = stack.filter((x): x is string => Boolean(x)).join('/');
    col.add(line, a.href, inner, { folder: folder || undefined, addedAt: unixToIso(a.add_date) });
  }
}

function parseJson(text: string, col: Collector) {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`The input looks like JSON but could not be parsed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(data)) throw new Error('JSON input must be an array of {title, url} or {name, url} objects.');
  data.forEach((entry, i) => {
    const o = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
    if (!o || typeof o.url !== 'string') {
      col.candidates++;
      col.skipped.push({ line: i + 1, reason: BROWSER_REF_REASONS.jsonEntry });
      return;
    }
    const title = typeof o.title === 'string' ? o.title : typeof o.name === 'string' ? o.name : undefined;
    col.add(i + 1, o.url, title);
  });
}

const MD_LINK = /\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"\n]*")?\s*\)/g;

function parseMarkdown(lines: string[], col: Collector) {
  lines.forEach((l, i) => {
    for (const m of l.matchAll(MD_LINK)) col.add(i + 1, m[2], m[1]);
  });
}

const SCHEME_TOKEN = /^[a-z][a-z0-9+.-]*:\S*$/i;

function parseLines(lines: string[], col: Collector) {
  lines.forEach((raw, i) => {
    const l = raw.trim();
    if (!l) return;
    const line = i + 1;
    if (l.includes('\t')) {
      const cut = l.lastIndexOf('\t');
      return col.add(line, l.slice(cut + 1).trim(), l.slice(0, cut));
    }
    if (!/\s/.test(l)) {
      if (SCHEME_TOKEN.test(l)) return col.add(line, l, undefined);
      return void col.skipped.push({ line, reason: BROWSER_REF_REASONS.notAbsolute });
    }
    const dash = /^(.*?)\s+[-–—]\s+(\S+)$/.exec(l);
    if (dash && SCHEME_TOKEN.test(dash[2])) return col.add(line, dash[2], dash[1]);
    col.skipped.push({ line, reason: BROWSER_REF_REASONS.unrecognizedLine });
  });
}

export function detectBrowserRefsFormat(text: string): BrowserRefFormat {
  const t = text.trim();
  if (/<!DOCTYPE\s+NETSCAPE-Bookmark-file/i.test(t) || /<\s*a\s[^>]*\bhref\s*=/i.test(t)) return 'netscape-html';
  if (/^\[\s*[{\]]/.test(t)) return 'json';
  if (/\[[^\]\n]*\]\(\s*<?[^)\s>]+>?(?:\s+"[^"\n]*")?\s*\)/.test(t)) return 'markdown';
  return 'lines';
}

/** Parses pasted bookmark/tab text. Throws a descriptive Error for empty, oversize or unrecognizable input. */
export function parseBrowserRefs(text: string): BrowserRefsResult {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Nothing to import: paste bookmark HTML, a JSON tab list, Markdown links or one URL per line.');
  if (text.length > BROWSER_REFS_LIMITS.inputChars) throw new Error(`The pasted text is too large (${text.length} characters; the limit is ${BROWSER_REFS_LIMITS.inputChars}).`);
  const detected = detectBrowserRefsFormat(text);
  const col = new Collector();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (detected === 'netscape-html') parseNetscape(text.replace(/\r\n?/g, '\n'), col);
  else if (detected === 'json') parseJson(text.trim(), col);
  else if (detected === 'markdown') parseMarkdown(lines, col);
  else parseLines(lines, col);
  if (col.candidates === 0) throw new Error(`No links were recognized. Paste a Netscape bookmark HTML export, a JSON array of {title, url}, Markdown [title](url) links or lines like "title<TAB>url", "url" or "title - url".`);
  const folders: string[] = [];
  for (const it of col.items) if (it.folder && !folders.includes(it.folder)) folders.push(it.folder);
  return { items: col.items, skipped: col.skipped, folders, detected, truncated: col.truncated };
}

/** Splits parsed links into ones not yet in the capsule and ones already present (same normalized URL). */
export function splitAgainstCapsule(items: BrowserRef[], capsuleItems: readonly CapsuleItem[]): { fresh: BrowserRef[]; alreadyPresent: BrowserRef[] } {
  const have = new Set(capsuleItems.filter((i) => i.kind === 'url').map((i) => normalizeBrowserUrl(i.target)));
  const fresh: BrowserRef[] = [];
  const alreadyPresent: BrowserRef[] = [];
  for (const it of items) (have.has(normalizeBrowserUrl(it.target)) ? alreadyPresent : fresh).push(it);
  return { fresh, alreadyPresent };
}

/** Maps parsed links to the exact capsule item shape {kind, target, label}. */
export function toCapsuleItems(items: BrowserRef[]): CapsuleItem[] {
  return items.map((i) => ({ kind: 'url' as const, target: i.target, label: i.label }));
}
