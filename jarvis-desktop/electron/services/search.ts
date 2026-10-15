// Read-only ranked search over data already held in AppState (notes, tasks, capsules, optionally chat).
// Pure and synchronous: no filesystem traversal, no network, no model calls. Safe to import from the renderer.
import type {AppState} from '../../src/shared/contracts';
// Type-only: erased at build time, so the renderer never loads the Node-side store module.
import type {ProductivityOp, ProductivityState} from './store';
import {dueAt} from './reminders';

export type SearchCategory = 'note' | 'task' | 'capsule' | 'checkpoint' | 'reference' | 'history' | 'external' | 'chat';

export type SearchResult = {
  category: SearchCategory;
  id: string;
  title: string;
  snippet: string;
  /** 0 (weak) .. 1 (strongest possible match); rounded to 3 decimals so ordering is stable. */
  relevance: number;
};

/** A record owned by another module (calendar events, clipboard items). The caller decides what may be shared. */
export type ExternalDoc = {source: string; id: string; title: string; text?: string; at?: string};

export type SearchOptions = {
  /** Chat history is excluded unless explicitly requested. */
  includeChat?: boolean;
  /** Activity log entries (restores, imports, reminders) are excluded unless explicitly requested. */
  includeHistory?: boolean;
  /** Productivity sidecar: capsule goals and references, checkpoints, the file shelf. */
  productivity?: ProductivityState;
  /** Records from other modules, searched as category "external". */
  external?: ExternalDoc[];
  /** Restrict to these categories. */
  categories?: SearchCategory[];
  /** Only notes carrying this tag (lower-case, without #). Other categories are dropped. */
  tag?: string;
  /** Project scope: this capsule, its checkpoints and the notes/tasks it references. Default is all projects. */
  capsuleId?: string;
  /** ISO date; only records updated, created or logged at or after it. Records without a date are kept. */
  since?: string;
  /** Maximum results returned; clamped to 1..SEARCH_LIMITS.maxResults. */
  limit?: number;
};

/** The categories of the shared contract (src/shared/contracts.ts): the ones that have a screen of their own. */
export type NavCategory = 'note' | 'task' | 'capsule' | 'chat';
/** Contract-shaped result handed to navigation callbacks; see navResult. */
export type NavResult = Omit<SearchResult, 'category'> & {category: NavCategory};
/** Options a caller of the original two-option search can pass; with only these, results are NavCategory-only. */
export type BasicSearchOptions = {includeChat?: boolean; limit?: number; includeHistory?: never; productivity?: never; external?: never; categories?: never; tag?: never; capsuleId?: never; since?: never};

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

export const CATEGORY_ORDER: readonly SearchCategory[] = ['note', 'task', 'capsule', 'checkpoint', 'reference', 'history', 'external', 'chat'];
export const CATEGORY_LABELS: Record<SearchCategory, string> = {note: 'Notes', task: 'Tasks', capsule: 'Capsules', checkpoint: 'Checkpoints', reference: 'File shelf', history: 'Activity history', external: 'Other sources', chat: 'Chat history'};

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
type Doc = {category: SearchCategory; id: string; title: string; fields: Field[]; fallbackSnippet: string; at?: string; tags?: string[]};

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

function buildDocs(state: AppState, opts: SearchOptions): Doc[] {
  const docs: Doc[] = [];
  const s = (isObj(state) ? state : {}) as Record<string, unknown>;
  const prod = opts.productivity;
  const metaOf = (id: string) => prod?.capsuleMeta?.[id];
  for (const n of list(s.notes)) {
    if (!validId(n.id)) continue;
    const tagList = Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === 'string') : [];
    const body = field(n.body, WEIGHT.body);
    docs.push({category: 'note', id: n.id, title: title(n.title, 'Untitled note'), fields: [field(n.title, WEIGHT.title), field(tagList.join(' '), WEIGHT.tag), body], fallbackSnippet: clip(body.text, SEARCH_LIMITS.snippetChars), at: typeof n.updatedAt === 'string' ? n.updatedAt : undefined, tags: tagList.map((t) => t.toLowerCase())});
  }
  for (const t of list(s.tasks)) {
    if (!validId(t.id)) continue;
    const status = t.done === true ? 'Done' : 'Open';
    const due = sanitizeText(t.due);
    docs.push({category: 'task', id: t.id, title: title(t.title, 'Untitled task'), fields: [field(t.title, WEIGHT.title)], fallbackSnippet: due ? `${status} · due ${due.slice(0, 32)}` : status, at: typeof t.createdAt === 'string' ? t.createdAt : undefined});
  }
  for (const c of list(s.capsules)) {
    if (!validId(c.id)) continue;
    const items = list(c.items);
    const meta = metaOf(c.id);
    const labels = items.map((i) => sanitizeText(i.label)).filter(Boolean).join(' · ');
    const targets = items.map((i) => sanitizeText(i.target)).filter(Boolean).join(' · ');
    const goals = (meta?.goals ?? []).map((g) => sanitizeText(g.text)).filter(Boolean).join(' · ');
    const refs = (meta?.references ?? []).map((r) => sanitizeText(`${r.label} ${r.note ?? ''}`)).filter(Boolean).join(' · ');
    const desc = field(c.description, WEIGHT.body);
    const fallback = desc.text || (goals ? `Goals: ${goals}` : labels ? `${items.length} item${items.length === 1 ? '' : 's'}: ${labels}` : 'Empty capsule');
    docs.push({category: 'capsule', id: c.id, title: title(c.name, 'Untitled capsule'), fields: [field(c.name, WEIGHT.title), desc, field(goals, WEIGHT.body), field(`${labels} ${refs}`, WEIGHT.body), field(targets, WEIGHT.minor)], fallbackSnippet: clip(fallback, SEARCH_LIMITS.snippetChars), at: typeof c.updatedAt === 'string' ? c.updatedAt : undefined});
  }
  for (const c of prod?.checkpoints ?? []) {
    if (!validId(c.id)) continue;
    const note = field(c.note, WEIGHT.body);
    docs.push({category: 'checkpoint', id: c.id, title: title(c.title, 'Checkpoint'), fields: [field(c.title, WEIGHT.title), note], fallbackSnippet: clip(note.text, SEARCH_LIMITS.snippetChars), at: c.createdAt});
  }
  for (const r of prod?.shelf ?? []) {
    if (!validId(r.id)) continue;
    docs.push({category: 'reference', id: r.id, title: title(r.label || r.target, 'Shelf item'), fields: [field(r.label, WEIGHT.title), field(r.target, WEIGHT.minor)], fallbackSnippet: clip(sanitizeText(r.target), SEARCH_LIMITS.snippetChars), at: r.addedAt});
  }
  if (opts.includeHistory === true) {
    for (const a of list(s.activity)) {
      if (!validId(a.id)) continue;
      docs.push({category: 'history', id: a.id, title: title(a.summary, 'Activity'), fields: [field(a.summary, WEIGHT.title), field(a.kind, WEIGHT.tag), field(a.details, WEIGHT.minor)], fallbackSnippet: clip(sanitizeText(a.summary), SEARCH_LIMITS.snippetChars), at: typeof a.at === 'string' ? a.at : undefined});
    }
  }
  for (const x of (opts.external ?? []).slice(0, SEARCH_LIMITS.itemsPerCategory)) {
    if (!isObj(x) || !validId(x.id) || typeof x.source !== 'string') continue;
    const text = field(x.text, WEIGHT.body);
    docs.push({category: 'external', id: x.id, title: title(x.title, x.source), fields: [field(x.title, WEIGHT.title), text, field(x.source, WEIGHT.minor)], fallbackSnippet: clip(text.text || sanitizeText(x.source), SEARCH_LIMITS.snippetChars), at: typeof x.at === 'string' ? x.at : undefined});
  }
  if (opts.includeChat === true) {
    for (const m of list(s.chat)) {
      if (!validId(m.id)) continue;
      const who = m.role === 'user' ? 'You' : 'Assistant';
      const text = field(m.text, WEIGHT.body);
      docs.push({category: 'chat', id: m.id, title: who, fields: [text], fallbackSnippet: clip(text.text, SEARCH_LIMITS.snippetChars), at: typeof m.createdAt === 'string' ? m.createdAt : undefined});
    }
  }
  return scopeDocs(docs, opts);
}

/** Applies category, tag, date and project-scope filters. Scope keeps the capsule, its checkpoints and its referenced notes/tasks. */
function scopeDocs(docs: Doc[], opts: SearchOptions): Doc[] {
  const cats = opts.categories ? new Set(opts.categories) : null;
  const tag = typeof opts.tag === 'string' ? opts.tag.trim().replace(/^#/, '').toLowerCase() : '';
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const prod = opts.productivity;
  const notes = new Set<string>(), tasks = new Set<string>();
  for (const r of opts.capsuleId ? prod?.capsuleMeta?.[opts.capsuleId]?.references ?? [] : []) {
    if (r.kind === 'note') notes.add(r.target);
    else if (r.kind === 'task') tasks.add(r.target);
  }
  const checkpoints = new Set((prod?.checkpoints ?? []).filter((c) => c.capsuleId === opts.capsuleId).map((c) => c.id));
  return docs.filter((d) => {
    if (cats && !cats.has(d.category)) return false;
    if (tag && !(d.category === 'note' && d.tags?.includes(tag))) return false;
    if (!Number.isNaN(since) && d.at && !(Date.parse(d.at) >= since)) return false;
    if (opts.capsuleId) {
      if (d.category === 'capsule') return d.id === opts.capsuleId;
      if (d.category === 'checkpoint') return checkpoints.has(d.id);
      if (d.category === 'note') return notes.has(d.id);
      if (d.category === 'task') return tasks.has(d.id);
      return false;
    }
    return true;
  });
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
export function searchState(state: AppState, query: unknown, options?: BasicSearchOptions): NavResult[];
export function searchState(state: AppState, query: unknown, options?: SearchOptions): SearchResult[];
export function searchState(state: AppState, query: unknown, options: SearchOptions = {}): SearchResult[] {
  const terms = parseQuery(query);
  if (!terms.length) return [];
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(SEARCH_LIMITS.maxResults, Math.floor(options.limit as number))) : SEARCH_LIMITS.defaultResults;
  const phrase = terms.join(' ');
  const results: (SearchResult & {key: string})[] = [];
  for (const doc of buildDocs(state, options)) {
    const hit = score(doc, terms, phrase);
    if (hit) results.push({category: doc.category, id: doc.id, title: doc.title, snippet: hit.snippet, relevance: hit.relevance, key: foldText(doc.title)});
  }
  results.sort((a, b) => b.relevance - a.relevance || rank(a.category) - rank(b.category) || cmp(a.key, b.key) || cmp(a.id, b.id));
  return results.slice(0, limit).map(({key: _key, ...r}) => r);
}

/**
 * The screen that holds a result, in contract terms. A checkpoint opens its capsule; shelf items, activity history and
 * records from other modules have no screen of their own, so they return null and are shown without a link.
 */
export function navResult(r: SearchResult, prod?: ProductivityState | null): NavResult | null {
  if (r.category === 'note' || r.category === 'task' || r.category === 'capsule' || r.category === 'chat') return {...r, category: r.category};
  if (r.category === 'checkpoint') {
    const capsuleId = prod?.checkpoints.find((c) => c.id === r.id)?.capsuleId;
    return capsuleId ? {...r, category: 'capsule', id: capsuleId} : null;
  }
  return null;
}

/** Group ranked results by category in a fixed order, preserving rank order inside each group. */
export function groupResults(results: SearchResult[]): SearchGroup[] {
  return CATEGORY_ORDER.map((category) => ({category, label: CATEGORY_LABELS[category], results: results.filter((r) => r.category === category)})).filter((g) => g.results.length > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Memory & journal helpers (roadmap 34-37, 45, 52-53). Pure and renderer-safe. Every line of a recap or worklog is
// built from a stored record and cites it; nothing is summarized by a model and nothing is invented. When there is
// no evidence the result says so instead of padding.
// ---------------------------------------------------------------------------------------------------------------

export type EvidenceKind = 'note' | 'task' | 'capsule' | 'activity' | 'focus' | 'checkpoint' | 'session';
export type RecapLine = {text: string; source: {kind: EvidenceKind; id: string}; at?: string};
export type Recap = {title: string; lines: RecapLine[]; empty: boolean};

const fmtMin = (sec: number) => (sec < 60 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);
const label = (s: string, n = 80) => clip(sanitizeText(s), n);

/** Local-calendar day range [start, end) for a YYYY-MM-DD key; null for anything else. */
export function dayRange(dateKey: string): {start: number; end: number} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const start = new Date(y, mo, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) return null;
  return {start: start.getTime(), end: new Date(y, mo, d + 1).getTime()};
}

const within = (iso: string | undefined, r: {start: number; end: number}) => {
  const t = iso ? Date.parse(iso) : NaN;
  return !Number.isNaN(t) && t >= r.start && t < r.end;
};

/** Evidence-backed recap of one local day: focus sessions, checkpoints, notes edited, tasks created, activity, timeline. */
export function buildDailyRecap(state: AppState, prod: ProductivityState | undefined, dateKey: string): Recap {
  const r = dayRange(dateKey);
  const out: Recap = {title: `Recap for ${dateKey}`, lines: [], empty: true};
  if (!r) return out;
  for (const f of prod?.focus ?? []) {
    if (!within(f.endedAt, r)) continue;
    out.lines.push({at: f.endedAt, source: {kind: 'focus', id: f.id}, text: `Focus ${f.outcome === 'completed' ? 'session' : 'session (stopped early)'}: ${fmtMin(f.actualSec)}${f.taskTitle ? ` on "${label(f.taskTitle)}"` : ''}`});
  }
  for (const c of prod?.checkpoints ?? []) {
    if (within(c.createdAt, r)) out.lines.push({at: c.createdAt, source: {kind: 'checkpoint', id: c.id}, text: `Checkpoint: ${label(c.title)}`});
  }
  for (const n of state.notes) {
    if (within(n.updatedAt, r)) out.lines.push({at: n.updatedAt, source: {kind: 'note', id: n.id}, text: `Note saved: ${label(n.title || 'Untitled note')}`});
  }
  for (const t of state.tasks) {
    if (within(t.createdAt, r)) out.lines.push({at: t.createdAt, source: {kind: 'task', id: t.id}, text: `Task added: ${label(t.title)}`});
  }
  for (const a of state.activity) {
    if (a.kind === 'capsule' && within(a.at, r)) out.lines.push({at: a.at, source: {kind: 'activity', id: a.id}, text: label(a.summary, 140)});
  }
  const byApp = new Map<string, {sec: number; id: string}>();
  for (const e of (prod?.timeline ?? []).filter((x) => within(x.at, r) && x.endedAt)) {
    const cur = byApp.get(e.app) ?? {sec: 0, id: e.id};
    cur.sec += Math.max(0, (Date.parse(e.endedAt as string) - Date.parse(e.at)) / 1000);
    byApp.set(e.app, cur);
  }
  for (const [app, v] of [...byApp.entries()].sort((a, b) => b[1].sec - a[1].sec).slice(0, 5)) {
    out.lines.push({source: {kind: 'session', id: v.id}, text: `Application timeline: ${label(app, 60)} for ${fmtMin(v.sec)}`});
  }
  const key = (l: RecapLine) => l.at ?? '~';
  out.lines.sort((a, b) => cmp(key(a), key(b)));
  out.empty = out.lines.length === 0;
  return out;
}

/** Resume recap for one capsule: goals, last checkpoints, focus time, referenced notes and tasks, last restore. */
export function buildResumeRecap(state: AppState, prod: ProductivityState | undefined, capsuleId: string): Recap {
  const capsule = state.capsules.find((c) => c.id === capsuleId);
  const out: Recap = {title: capsule ? `Resume "${label(capsule.name, 60)}"` : 'Resume', lines: [], empty: true};
  if (!capsule) return out;
  const meta = prod?.capsuleMeta?.[capsuleId];
  const goals = meta?.goals ?? [];
  const open = goals.filter((g) => !g.done);
  for (const g of open) out.lines.push({source: {kind: 'capsule', id: capsuleId}, text: `Goal open: ${label(g.text, 140)}`});
  if (goals.length && !open.length) out.lines.push({source: {kind: 'capsule', id: capsuleId}, text: `All ${goals.length} goal(s) are marked done`});
  const cps = (prod?.checkpoints ?? []).filter((c) => c.capsuleId === capsuleId).sort((a, b) => cmp(b.createdAt, a.createdAt)).slice(0, 3);
  for (const c of cps) out.lines.push({at: c.createdAt, source: {kind: 'checkpoint', id: c.id}, text: `Checkpoint ${c.createdAt.slice(0, 10)}: ${label(c.title)}${c.note ? ` — ${label(c.note, 120)}` : ''}`});
  const sessions = (prod?.focus ?? []).filter((f) => f.capsuleId === capsuleId);
  if (sessions.length) {
    const last = sessions[sessions.length - 1];
    out.lines.push({at: last.endedAt, source: {kind: 'focus', id: last.id}, text: `Focus on this capsule: ${sessions.length} session(s), ${fmtMin(sessions.reduce((n, f) => n + f.actualSec, 0))} total; last ${last.endedAt.slice(0, 10)}`});
  }
  for (const r of meta?.references ?? []) {
    if (r.kind === 'note') {
      const n = state.notes.find((x) => x.id === r.target);
      if (n) out.lines.push({at: n.updatedAt, source: {kind: 'note', id: n.id}, text: `Note: ${label(n.title || 'Untitled note')} (edited ${n.updatedAt.slice(0, 10)})`});
    } else if (r.kind === 'task') {
      const t = state.tasks.find((x) => x.id === r.target);
      if (t && !t.done) out.lines.push({source: {kind: 'task', id: t.id}, text: `Task open: ${label(t.title)}${t.due ? ` (due ${t.due.slice(0, 16)})` : ''}`});
    }
  }
  const restore = [...state.activity].reverse().find((a) => a.kind === 'capsule' && a.summary.includes(`"${capsule.name.slice(0, 80)}"`));
  if (restore) out.lines.push({at: restore.at, source: {kind: 'activity', id: restore.id}, text: `Last restored ${restore.at.slice(0, 10)}: ${label(restore.summary, 120)}`});
  out.empty = out.lines.length === 0;
  return out;
}

/** A plain-text worklog/standup draft. Always labelled a draft; each line is a recap line, optionally with its source. */
export function draftWorklog(recap: Recap, opts: {withSources?: boolean} = {}): string {
  const head = `DRAFT — assembled from local records only; review before sharing.\n${recap.title}`;
  if (recap.empty) return `${head}\n(No recorded activity to report.)`;
  return `${head}\n${recap.lines.map((l) => `- ${l.text}${opts.withSources ? ` [${l.source.kind}:${l.source.id}]` : ''}`).join('\n')}`;
}

export type AssociationSuggestion = {kind: 'task' | 'capsule'; id: string; title: string; reason: string};

/**
 * Suggests which task or capsule a session might belong to by words shared with its app/title. Suggestions only:
 * nothing is associated until the user confirms (association.set), and a confirmed association always wins.
 */
export function suggestAssociations(subject: string, state: AppState, limit = 3): AssociationSuggestion[] {
  const terms = parseQuery(subject).filter((t) => t.length >= 3);
  if (!terms.length) return [];
  const out: (AssociationSuggestion & {score: number})[] = [];
  const consider = (kind: 'task' | 'capsule', id: string, name: string, skip = false) => {
    if (skip) return;
    const words = new Set(foldText(sanitizeText(name)).split(TOKEN_SPLIT).filter(Boolean));
    const shared = terms.filter((t) => words.has(t));
    if (shared.length) out.push({kind, id, title: label(name), reason: `shares "${shared.slice(0, 3).join('", "')}"`, score: shared.length});
  };
  for (const t of state.tasks) consider('task', t.id, t.title, t.done);
  for (const c of state.capsules) consider('capsule', c.id, c.name);
  return out.sort((a, b) => b.score - a.score || cmp(a.id, b.id)).slice(0, limit).map(({score: _s, ...x}) => x);
}

export type ReminderStatus = {state: 'none' | 'due' | 'upcoming' | 'snoozed' | 'dismissed'; until?: string};

/** Visible state of a task reminder given saved snooze/dismiss states. Done tasks and tasks without a due value are 'none'. */
export function reminderStatus(task: {id: string; done: boolean; due?: string}, states: ProductivityState['reminders'], nowMs: number): ReminderStatus {
  const at = task.done ? null : dueAt(task);
  if (at === null) return {state: 'none'};
  const saved = states.find((s) => s.taskId === task.id && s.due === task.due);
  if (saved?.state === 'dismissed') return {state: 'dismissed'};
  if (saved?.state === 'snoozed' && saved.until && Date.parse(saved.until) > nowMs) return {state: 'snoozed', until: saved.until};
  return {state: at <= nowMs ? 'due' : 'upcoming'};
}

export const SNOOZE_PRESETS = ['10m', '1h', 'tomorrow'] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];
/** ISO time a snooze preset ends. "tomorrow" is 09:00 local the next day. */
export function snoozeUntil(preset: SnoozePreset, nowMs: number): string {
  if (preset === '10m') return new Date(nowMs + 10 * 60_000).toISOString();
  if (preset === '1h') return new Date(nowMs + 60 * 60_000).toISOString();
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 9, 0, 0, 0).toISOString();
}

export type FocusSummary = {sessions: number; completed: number; totalSec: number; byTask: {taskId?: string; title: string; sec: number}[]};

/** Totals over focus sessions that ended at or after `sinceMs` (0 = all). */
export function focusSummary(sessions: ProductivityState['focus'], sinceMs = 0): FocusSummary {
  const picked = sessions.filter((f) => Date.parse(f.endedAt) >= sinceMs);
  const by = new Map<string, {taskId?: string; title: string; sec: number}>();
  for (const f of picked) {
    const key = f.taskId ?? f.taskTitle ?? '';
    const cur = by.get(key) ?? {taskId: f.taskId, title: f.taskTitle || 'No task', sec: 0};
    cur.sec += f.actualSec;
    by.set(key, cur);
  }
  return {sessions: picked.length, completed: picked.filter((f) => f.outcome === 'completed').length, totalSec: picked.reduce((n, f) => n + f.actualSec, 0), byTask: [...by.values()].sort((a, b) => b.sec - a.sec)};
}

export type RetentionPreview = {chat: number; activity: number; focus: number; checkpoints: number; reminders: number; timeline: number};

/** What the saved retention settings would remove right now. Counts only; nothing is changed. */
export function previewRetention(state: AppState, prod: ProductivityState | undefined, nowMs: number): RetentionPreview {
  const old = (at: string | undefined, days: number) => days > 0 && at !== undefined && Date.parse(at) < nowMs - days * 86_400_000;
  const days = state.settings.retainDays;
  const r = prod?.policy.retainDays;
  return {
    chat: state.chat.filter((m) => old(m.createdAt, days)).length,
    activity: state.activity.filter((a) => old(a.at, days)).length,
    focus: r ? (prod?.focus ?? []).filter((x) => old(x.endedAt, r.focus)).length : 0,
    checkpoints: r ? (prod?.checkpoints ?? []).filter((x) => old(x.createdAt, r.checkpoints)).length : 0,
    reminders: r ? (prod?.reminders ?? []).filter((x) => old(x.until ?? x.at, r.reminders)).length : 0,
    timeline: r ? (prod?.timeline ?? []).filter((x) => old(x.at, r.timeline)).length : 0,
  };
}

/**
 * The task list a reminder scheduler (Reminders in reminders.ts) should watch: dismissed tasks are left out and a
 * snoozed task gets its snooze end as the due time, so the scheduler announces it again when the snooze ends.
 * The snooze end stays the due time after it has passed: the scheduler evaluates this list at that very moment, and
 * reverting to the original due time would make it look like an old, already-announced reminder.
 */
export function effectiveReminderTasks<T extends {id: string; done: boolean; due?: string}>(tasks: readonly T[], states: ProductivityState['reminders']): T[] {
  const out: T[] = [];
  for (const t of tasks) {
    const saved = t.done || !t.due ? undefined : states.find((s) => s.taskId === t.id && s.due === t.due);
    if (saved?.state === 'dismissed') continue;
    if (saved?.state === 'snoozed' && saved.until) out.push({...t, due: saved.until});
    else out.push(t);
  }
  return out;
}

export type FocusObservation = {phase: string; durationSec: number; remainingSec: number; taskId: string | null; taskTitle: string | null; startedAt: number | null};
export type FocusRecordOp = Extract<ProductivityOp, {op: 'focus.record'}>;
/** Sessions shorter than this are accidental starts and are not recorded. */
export const MIN_RECORDED_FOCUS_SEC = 60;

/**
 * Folds one observation of the focus timer into the previous one. Returns the new observation and, when a session just
 * finished (running -> done) or was stopped (running/paused -> idle) after at least a minute, the focus.record
 * operation for it. Only observed transitions are recorded; a session already running when observation began has its
 * start reconstructed from the elapsed time.
 */
export function observeFocus(prev: FocusObservation | null, cur: {phase: string; durationSec: number; remainingSec: number; taskId: string | null; taskTitle: string | null}, nowMs: number): {next: FocusObservation; record: FocusRecordOp | null} {
  const active = cur.phase === 'running' || cur.phase === 'paused';
  const wasActive = prev !== null && (prev.phase === 'running' || prev.phase === 'paused');
  const startedAt = wasActive ? prev.startedAt : active ? nowMs - (cur.durationSec - cur.remainingSec) * 1000 : null;
  const next: FocusObservation = {...cur, startedAt};
  let record: FocusRecordOp | null = null;
  if (prev && prev.startedAt !== null) {
    const finished = prev.phase === 'running' && cur.phase === 'done';
    const stopped = wasActive && cur.phase === 'idle';
    const actualSec = finished ? prev.durationSec : Math.max(0, prev.durationSec - prev.remainingSec);
    if ((finished || stopped) && actualSec >= MIN_RECORDED_FOCUS_SEC) {
      record = {
        op: 'focus.record', startedAt: new Date(prev.startedAt).toISOString(), endedAt: new Date(nowMs).toISOString(),
        plannedSec: prev.durationSec, actualSec, outcome: finished ? 'completed' : 'stopped',
        ...(prev.taskId ? {taskId: prev.taskId} : {}), ...(prev.taskTitle ? {taskTitle: prev.taskTitle.slice(0, 120)} : {}),
      };
    }
  }
  return {next, record};
}


// ---------------------------------------------------------------------------------------------------------------
// Evidence resolution and recap filtering for the memory workbench. Pure: no clock, no I/O.
// ---------------------------------------------------------------------------------------------------------------

export type EvidenceStatus = 'ok' | 'missing' | 'unsupported';
/** A recap or checkpoint reference checked against what the app still holds. Missing records are reported, never invented. */
export type ResolvedEvidence = {kind: EvidenceKind; id: string; status: EvidenceStatus; title: string; at?: string; /** True when the app has a screen for this record (note, task, capsule). */ linkable: boolean};

const MISSING: Record<EvidenceKind, string> = {note: 'Deleted note', task: 'Deleted task', capsule: 'Deleted capsule', activity: 'Activity entry no longer kept', focus: 'Focus session no longer kept', checkpoint: 'Deleted checkpoint', session: 'Timeline entry no longer kept'};

/** Looks one evidence reference up in the current app state and sidecar. Stale references come back as status 'missing' with an honest label. */
export function resolveEvidence(ref: {kind: EvidenceKind; id: string}, state: AppState, prod?: ProductivityState | null): ResolvedEvidence {
  const base = {kind: ref.kind, id: ref.id, linkable: ref.kind === 'note' || ref.kind === 'task' || ref.kind === 'capsule'};
  const miss = (): ResolvedEvidence => ({...base, status: 'missing', title: MISSING[ref.kind]});
  switch (ref.kind) {
    case 'note': { const n = state.notes.find((x) => x.id === ref.id); return n ? {...base, status: 'ok', title: label(n.title || 'Untitled note'), at: n.updatedAt} : miss(); }
    case 'task': { const t = state.tasks.find((x) => x.id === ref.id); return t ? {...base, status: 'ok', title: `${t.done ? '✓ ' : ''}${label(t.title)}`, at: t.createdAt} : miss(); }
    case 'capsule': { const c = state.capsules.find((x) => x.id === ref.id); return c ? {...base, status: 'ok', title: label(c.name), at: c.updatedAt} : miss(); }
    case 'activity': { const a = state.activity.find((x) => x.id === ref.id); return a ? {...base, status: 'ok', title: label(a.summary, 120), at: a.at} : miss(); }
    case 'checkpoint': { const c = prod?.checkpoints.find((x) => x.id === ref.id); return c ? {...base, status: 'ok', title: label(c.title), at: c.createdAt} : miss(); }
    case 'focus': { const f = prod?.focus.find((x) => x.id === ref.id); return f ? {...base, status: 'ok', title: `Focus ${fmtMin(f.actualSec)}${f.taskTitle ? ` on ${label(f.taskTitle, 60)}` : ''}`, at: f.endedAt} : miss(); }
    case 'session': { const e = prod?.timeline.find((x) => x.id === ref.id); return e ? {...base, status: 'ok', title: `Timeline: ${label(e.app, 60)}`, at: e.at} : miss(); }
    default: return {...base, status: 'unsupported', title: 'Unknown reference'};
  }
}

export type RecapFilter = {kinds?: readonly EvidenceKind[]; query?: string};

/** Keeps the lines whose evidence kind is selected and whose text matches every query word (folded, substring). Title and emptiness are recomputed. */
export function filterRecap(recap: Recap, filter: RecapFilter): Recap {
  const kinds = filter.kinds && filter.kinds.length ? new Set(filter.kinds) : null;
  const terms = parseQuery(filter.query ?? '');
  const lines = recap.lines.filter((l) => (!kinds || kinds.has(l.source.kind)) && (!terms.length || terms.every((t) => foldText(l.text).includes(t))));
  return {title: recap.title, lines, empty: lines.length === 0};
}

/** Daily recap plus a plain worklog draft whose lines each cite a resolvable local record; lines whose source is gone are flagged in the draft instead of being silently kept. */
export function draftWorklogVerified(recap: Recap, state: AppState, prod?: ProductivityState | null, opts: {withSources?: boolean} = {}): {text: string; stale: number} {
  const head = `DRAFT — assembled from local records only; review before sharing.\n${recap.title}`;
  if (recap.empty) return {text: `${head}\n(No recorded activity to report.)`, stale: 0};
  let stale = 0;
  const lines = recap.lines.map((l) => {
    const r = resolveEvidence(l.source, state, prod);
    if (r.status !== 'ok') stale++;
    const cite = opts.withSources ? ` [${l.source.kind}:${l.source.id}${r.status === 'ok' ? '' : ', no longer available'}]` : r.status === 'ok' ? '' : ' (source no longer available)';
    return `- ${l.text}${cite}`;
  });
  return {text: `${head}\n${lines.join('\n')}`, stale};
}
