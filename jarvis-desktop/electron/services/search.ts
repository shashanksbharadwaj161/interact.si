// Read-only ranked search over data already held in AppState (notes, tasks, capsules, optionally chat).
// Pure and synchronous: no filesystem traversal, no network, no model calls. Safe to import from the renderer.
import type {AppState} from '../../src/shared/contracts';

export type SearchCategory = 'note' | 'task' | 'capsule' | 'chat';

export type SearchResult = {
  category: SearchCategory;
  id: string;
  title: string;
  snippet: string;
  /** 0 (weak) .. 1 (strongest possible match); rounded to 3 decimals so ordering is stable. */
  relevance: number;
};

export type SearchOptions = {
  /** Chat history is excluded unless explicitly requested. */
  includeChat?: boolean;
  /** Maximum results returned; clamped to 1..SEARCH_LIMITS.maxResults. */
  limit?: number;
};

export type SearchGroup = {category: SearchCategory; label: string; results: SearchResult[]};

export const SEARCH_LIMITS = {
  queryChars: 200,
  terms: 12,
  termChars: 64,
  defaultResults: 20,
  maxResults: 50,
  itemsPerCategory: 5000,
  fieldChars: 20_000,
  titleChars: 120,
  snippetChars: 160,
};

export const CATEGORY_ORDER: readonly SearchCategory[] = ['note', 'task', 'capsule', 'chat'];
export const CATEGORY_LABELS: Record<SearchCategory, string> = {note: 'Notes', task: 'Tasks', capsule: 'Capsules', chat: 'Chat history'};

const WEIGHT = {title: 3, tag: 2, body: 1, minor: 0.5};
const MATCH = {exact: 1, prefix: 0.7, substring: 0.4};
const PHRASE_BONUS = 2;
const MAX_WEIGHT = WEIGHT.title;

// C0/C1 controls, zero-width and bidi override/isolate characters, BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const SPECIAL_FOLDS: Record<string, string> = {ß: 'ss', ẞ: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', ı: 'i'};
const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

/** Remove control/invisible characters and collapse all whitespace to single spaces. */
export function sanitizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
}

function foldChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/./gu, (c) => SPECIAL_FOLDS[c] ?? c);
}

/** Case- and accent-insensitive form of a string ("Crème BRÛLÉE" -> "creme brulee"). */
export function foldText(value: string): string {
  let out = '';
  for (const ch of value) out += foldChar(ch);
  return out;
}

/** Folded text plus, for every folded UTF-16 index, the index in the source string it came from. */
function foldWithMap(source: string): {folded: string; map: number[]} {
  let folded = '';
  const map: number[] = [];
  let i = 0;
  for (const ch of source) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
    i += ch.length;
  }
  map.push(source.length);
  return {folded, map};
}

/** Split a raw query into unique folded terms, bounded in count and length. */
export function parseQuery(query: unknown): string[] {
  const clean = sanitizeText(query).slice(0, SEARCH_LIMITS.queryChars);
  const terms: string[] = [];
  for (const t of foldText(clean).split(TOKEN_SPLIT)) {
    const term = t.slice(0, SEARCH_LIMITS.termChars);
    if (term && !terms.includes(term)) terms.push(term);
    if (terms.length >= SEARCH_LIMITS.terms) break;
  }
  return terms;
}

type Field = {text: string; weight: number; folded: string; map: number[]; tokens: Set<string>};
type Doc = {category: SearchCategory; id: string; title: string; fields: Field[]; fallbackSnippet: string};

function field(raw: unknown, weight: number): Field {
  const text = sanitizeText(raw).slice(0, SEARCH_LIMITS.fieldChars);
  const {folded, map} = foldWithMap(text);
  return {text, weight, folded, map, tokens: new Set(folded.split(TOKEN_SPLIT).filter(Boolean))};
}

function matchStrength(f: Field, term: string): number {
  if (!f.folded) return 0;
  if (f.tokens.has(term)) return MATCH.exact;
  for (const tok of f.tokens) if (tok.startsWith(term)) return MATCH.prefix;
  return f.folded.includes(term) ? MATCH.substring : 0;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

function snippetAround(f: Field, terms: string[]): string {
  let at = -1;
  let len = 0;
  for (const t of terms) {
    const i = f.folded.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) {
      at = i;
      len = t.length;
    }
  }
  const max = SEARCH_LIMITS.snippetChars;
  if (at < 0 || f.text.length <= max) return clip(f.text, max);
  const startSrc = f.map[at];
  const endSrc = f.map[Math.min(at + len, f.map.length - 1)];
  let start = Math.max(0, Math.min(startSrc - Math.floor((max - (endSrc - startSrc)) / 3), f.text.length - max));
  // Prefer to start on a word boundary.
  const space = f.text.lastIndexOf(' ', start);
  if (start > 0 && space >= 0 && start - space < 20) start = space + 1;
  const body = f.text.slice(start, start + max - 2).trim();
  return `${start > 0 ? '…' : ''}${body}${start + max - 2 < f.text.length ? '…' : ''}`;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.slice(0, SEARCH_LIMITS.itemsPerCategory).filter(isObj) : []);
const validId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const title = (v: unknown, fallback: string): string => clip(sanitizeText(v), SEARCH_LIMITS.titleChars) || fallback;

function buildDocs(state: AppState, includeChat: boolean): Doc[] {
  const docs: Doc[] = [];
  const s = (isObj(state) ? state : {}) as Record<string, unknown>;
  for (const n of list(s.notes)) {
    if (!validId(n.id)) continue;
    const tags = Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === 'string').join(' ') : '';
    const body = field(n.body, WEIGHT.body);
    docs.push({category: 'note', id: n.id, title: title(n.title, 'Untitled note'), fields: [field(n.title, WEIGHT.title), field(tags, WEIGHT.tag), body], fallbackSnippet: clip(body.text, SEARCH_LIMITS.snippetChars)});
  }
  for (const t of list(s.tasks)) {
    if (!validId(t.id)) continue;
    const status = t.done === true ? 'Done' : 'Open';
    const due = sanitizeText(t.due);
    docs.push({category: 'task', id: t.id, title: title(t.title, 'Untitled task'), fields: [field(t.title, WEIGHT.title)], fallbackSnippet: due ? `${status} · due ${due.slice(0, 32)}` : status});
  }
  for (const c of list(s.capsules)) {
    if (!validId(c.id)) continue;
    const items = list(c.items);
    const labels = items.map((i) => sanitizeText(i.label)).filter(Boolean).join(' · ');
    const targets = items.map((i) => sanitizeText(i.target)).filter(Boolean).join(' · ');
    const desc = field(c.description, WEIGHT.body);
    const fallback = desc.text || (labels ? `${items.length} item${items.length === 1 ? '' : 's'}: ${labels}` : 'Empty capsule');
    docs.push({category: 'capsule', id: c.id, title: title(c.name, 'Untitled capsule'), fields: [field(c.name, WEIGHT.title), desc, field(labels, WEIGHT.body), field(targets, WEIGHT.minor)], fallbackSnippet: clip(fallback, SEARCH_LIMITS.snippetChars)});
  }
  if (includeChat) {
    for (const m of list(s.chat)) {
      if (!validId(m.id)) continue;
      const who = m.role === 'user' ? 'You' : 'Assistant';
      const text = field(m.text, WEIGHT.body);
      docs.push({category: 'chat', id: m.id, title: who, fields: [text], fallbackSnippet: clip(text.text, SEARCH_LIMITS.snippetChars)});
    }
  }
  return docs;
}

function score(doc: Doc, terms: string[], phrase: string): {relevance: number; snippet: string} | null {
  let total = 0;
  let snippetField: Field | null = null;
  let snippetScore = 0;
  for (const term of terms) {
    let best = 0;
    for (const f of doc.fields) {
      const m = matchStrength(f, term);
      if (!m) continue;
      best = Math.max(best, m * f.weight);
      // The snippet comes from the strongest-matching non-title field.
      if (f.weight < WEIGHT.title && m * f.weight > snippetScore) {
        snippetScore = m * f.weight;
        snippetField = f;
      }
    }
    if (!best) return null; // every term must match somewhere
    total += best;
  }
  if (terms.length > 1 && doc.fields[0]?.folded.includes(phrase)) total += PHRASE_BONUS;
  const max = terms.length * MAX_WEIGHT + (terms.length > 1 ? PHRASE_BONUS : 0);
  const relevance = Math.round(Math.min(1, total / max) * 1000) / 1000;
  const snippet = snippetField ? snippetAround(snippetField, terms) : doc.fallbackSnippet;
  return {relevance, snippet};
}

const rank = (c: SearchCategory) => CATEGORY_ORDER.indexOf(c);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Ranked, deterministic search over the given state. Returns [] for an empty or punctuation-only query. */
export function searchState(state: AppState, query: unknown, options: SearchOptions = {}): SearchResult[] {
  const terms = parseQuery(query);
  if (!terms.length) return [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(SEARCH_LIMITS.maxResults, Math.floor(options.limit as number))) : SEARCH_LIMITS.defaultResults;
  const phrase = terms.join(' ');
  const results: (SearchResult & {key: string})[] = [];
  for (const doc of buildDocs(state, options.includeChat === true)) {
    const hit = score(doc, terms, phrase);
    if (hit) results.push({category: doc.category, id: doc.id, title: doc.title, snippet: hit.snippet, relevance: hit.relevance, key: foldText(doc.title)});
  }
  results.sort((a, b) => b.relevance - a.relevance || rank(a.category) - rank(b.category) || cmp(a.key, b.key) || cmp(a.id, b.id));
  return results.slice(0, limit).map(({key: _key, ...r}) => r);
}

/** Group ranked results by category in a fixed order, preserving rank order inside each group. */
export function groupResults(results: SearchResult[]): SearchGroup[] {
  return CATEGORY_ORDER.map((category) => ({category, label: CATEGORY_LABELS[category], results: results.filter((r) => r.category === category)})).filter((g) => g.results.length > 0);
}
