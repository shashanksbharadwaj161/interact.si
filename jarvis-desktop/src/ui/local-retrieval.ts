// Honest on-device related-item retrieval: lexical BM25 over saved titles and text. No embedding model, no network,
// no DOM. Pure and synchronous so it can run in the renderer or in tests.

export const RETRIEVAL_LIMITS = Object.freeze({ maxDocs: 5000, maxDocChars: 20000, maxResults: 20, maxTerms: 64 });

export const RETRIEVAL_KINDS = Object.freeze(['note', 'task', 'capsule', 'checkpoint'] as const);
export type RetrievalKind = (typeof RETRIEVAL_KINDS)[number];

export type RetrievalDoc = { id: string; kind: RetrievalKind; title: string; text: string; updatedAt?: string };

export type IndexedDoc = Readonly<{
  id: string;
  kind: RetrievalKind;
  title: string;
  updatedAt?: string;
  /** Sort key for tie-breaks; -Infinity when missing or unparseable. */
  updatedMs: number;
  /** Token count with title tokens counted twice. */
  length: number;
  /** BM25 weight per term. */
  weights: Readonly<Record<string, number>>;
}>;

export type RetrievalIndex = Readonly<{
  docs: readonly IndexedDoc[];
  /** Number of documents containing each term. */
  df: Readonly<Record<string, number>>;
  avgLength: number;
  truncatedDocs: number;
  k1: number;
  b: number;
}>;

export type RetrievalOptions = { limit?: number; kinds?: RetrievalKind[] };
export type RetrievalHit = { id: string; kind: RetrievalKind; title: string; score: number; sharedTerms: string[] };

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 10;
const MAX_SHARED = 8;
const SPLIT = /[^\p{L}\p{N}]+/u;

const STOP_WORDS: ReadonlySet<string> = new Set([
  'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'as', 'not', 'no', 'do', 'does', 'did', 'have',
  'has', 'had', 'we', 'you', 'he', 'she', 'they', 'them', 'our', 'your', 'my', 'me', 'us', 'so', 'if', 'then', 'than',
  'into', 'about', 'over', 'will', 'can', 'just', 'all', 'any', 'there', 'their', 'what', 'which', 'who', 'when', 'how',
  'also', 'up', 'out', 'am', 'his', 'her', 'him', 'i', 'a',
]);

/** Every kept token in order, duplicates included. */
function tokenStream(text: string): string[] {
  if (typeof text !== 'string' || !text) return [];
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const out: string[] = [];
  for (const t of folded.split(SPLIT)) {
    if (t.length < 2 || STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Lower-cased, accent-folded unique terms in first-seen order, without stop words or 1-char tokens, capped at maxTerms. */
export function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const t of tokenStream(text)) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (seen.size >= RETRIEVAL_LIMITS.maxTerms) break;
  }
  return [...seen];
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

function dateMs(v: string | undefined): number {
  if (typeof v !== 'string') return -Infinity;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function validLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (typeof limit !== 'number' || !Number.isInteger(limit)) throw new Error(`limit must be an integer, got ${String(limit)}`);
  if (limit < 1 || limit > RETRIEVAL_LIMITS.maxResults) throw new Error(`limit must be between 1 and ${RETRIEVAL_LIMITS.maxResults}, got ${limit}`);
  return limit;
}

function validKinds(kinds: unknown): Set<RetrievalKind> | null {
  if (kinds === undefined) return null;
  if (!Array.isArray(kinds)) throw new Error('kinds must be an array');
  for (const k of kinds) if (!RETRIEVAL_KINDS.includes(k)) throw new Error(`Unknown kind "${String(k)}"`);
  return new Set(kinds as RetrievalKind[]);
}

/** Builds a frozen BM25 index (k1 1.2, b 0.75) over title + text; title tokens count twice. */
export function buildIndex(docs: RetrievalDoc[]): RetrievalIndex {
  if (!Array.isArray(docs)) throw new Error('docs must be an array');
  if (docs.length > RETRIEVAL_LIMITS.maxDocs) throw new Error(`Too many documents: ${docs.length} (max ${RETRIEVAL_LIMITS.maxDocs})`);
  const ids = new Set<string>();
  const df = new Map<string, number>();
  let truncatedDocs = 0;
  const staged: { doc: RetrievalDoc; title: string; tf: Map<string, number>; length: number }[] = [];
  docs.forEach((d, i) => {
    if (typeof d !== 'object' || d === null) throw new Error(`Document ${i} is not an object`);
    if (typeof d.id !== 'string' || !d.id) throw new Error(`Document ${i} has no id`);
    if (ids.has(d.id)) throw new Error(`Duplicate document id "${d.id}"`);
    ids.add(d.id);
    if (!RETRIEVAL_KINDS.includes(d.kind)) throw new Error(`Document "${d.id}" has unknown kind "${String(d.kind)}"`);
    if (typeof d.title !== 'string') throw new Error(`Document "${d.id}" title must be a string`);
    if (typeof d.text !== 'string') throw new Error(`Document "${d.id}" text must be a string`);
    if (d.updatedAt !== undefined && typeof d.updatedAt !== 'string') throw new Error(`Document "${d.id}" updatedAt must be a string`);
    let title = d.title;
    let text = d.text;
    let cut = false;
    if (title.length > RETRIEVAL_LIMITS.maxDocChars) { title = title.slice(0, RETRIEVAL_LIMITS.maxDocChars); cut = true; }
    if (text.length > RETRIEVAL_LIMITS.maxDocChars) { text = text.slice(0, RETRIEVAL_LIMITS.maxDocChars); cut = true; }
    if (cut) truncatedDocs++;
    const tf = new Map<string, number>();
    let length = 0;
    for (const t of tokenStream(title)) { tf.set(t, (tf.get(t) ?? 0) + 2); length += 2; }
    for (const t of tokenStream(text)) { tf.set(t, (tf.get(t) ?? 0) + 1); length += 1; }
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    staged.push({ doc: d, title, tf, length });
  });
  const n = staged.length;
  const avgLength = n ? staged.reduce((s, x) => s + x.length, 0) / n : 0;
  const idf = (t: string) => {
    const f = df.get(t) ?? 0;
    return Math.log(1 + (n - f + 0.5) / (f + 0.5));
  };
  const indexed = staged.map(({ doc, title, tf, length }) => {
    const weights: Record<string, number> = Object.create(null);
    const norm = K1 * (1 - B + B * (avgLength ? length / avgLength : 0));
    for (const [t, f] of tf) weights[t] = (idf(t) * f * (K1 + 1)) / (f + norm);
    const out: IndexedDoc = { id: doc.id, kind: doc.kind, title, updatedMs: dateMs(doc.updatedAt), length, weights: Object.freeze(weights), ...(doc.updatedAt !== undefined ? { updatedAt: doc.updatedAt } : {}) };
    return Object.freeze(out);
  });
  const dfObj: Record<string, number> = Object.create(null);
  for (const [t, f] of df) dfObj[t] = f;
  return Object.freeze({ docs: Object.freeze(indexed), df: Object.freeze(dfObj), avgLength, truncatedDocs, k1: K1, b: B });
}

function assertIndex(index: unknown): asserts index is RetrievalIndex {
  if (typeof index !== 'object' || index === null || !Array.isArray((index as RetrievalIndex).docs)) throw new Error('index must come from buildIndex');
}

function rank(index: RetrievalIndex, terms: string[], exclude: string | null, opts: RetrievalOptions | undefined): RetrievalHit[] {
  const limit = validLimit(opts?.limit);
  const kinds = validKinds(opts?.kinds);
  const scored: { doc: IndexedDoc; score: number; shared: string[] }[] = [];
  for (const doc of index.docs) {
    if (doc.id === exclude || (kinds && !kinds.has(doc.kind))) continue;
    let score = 0;
    const shared: string[] = [];
    for (const t of terms) {
      const w = doc.weights[t];
      if (w === undefined) continue;
      score += w;
      shared.push(t);
    }
    if (shared.length && score > 0) scored.push({ doc, score: round4(score), shared });
  }
  scored.sort((a, b) => b.score - a.score || (b.doc.updatedMs === a.doc.updatedMs ? 0 : b.doc.updatedMs > a.doc.updatedMs ? 1 : -1) || (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0));
  return scored.slice(0, limit).map(({ doc, score, shared }) => ({
    id: doc.id,
    kind: doc.kind,
    title: doc.title,
    score,
    sharedTerms: shared
      .sort((x, y) => doc.weights[y] - doc.weights[x] || (x < y ? -1 : x > y ? 1 : 0))
      .slice(0, MAX_SHARED),
  }));
}

/** Documents that share the most distinctive words with docId (excluding docId itself). */
export function findRelated(index: RetrievalIndex, docId: string, opts?: RetrievalOptions): RetrievalHit[] {
  assertIndex(index);
  if (typeof docId !== 'string' || !docId) throw new Error('docId is required');
  const source = index.docs.find((d) => d.id === docId);
  if (!source) throw new Error(`No document with id "${docId}" in the index`);
  // The source's most distinctive terms form the query (capped at maxTerms).
  const terms = Object.keys(source.weights)
    .sort((x, y) => source.weights[y] - source.weights[x] || (x < y ? -1 : x > y ? 1 : 0))
    .slice(0, RETRIEVAL_LIMITS.maxTerms);
  return rank(index, terms, docId, opts);
}

/** Free-text lookup scored the same way as findRelated. */
export function query(index: RetrievalIndex, text: string, opts?: RetrievalOptions): RetrievalHit[] {
  assertIndex(index);
  if (typeof text !== 'string') throw new Error('query text must be a string');
  return rank(index, tokenize(text.slice(0, RETRIEVAL_LIMITS.maxDocChars)), null, opts);
}

/** Minimal shapes so this module stays free of app/runtime imports. */
type StateLike = {
  notes?: { id: string; title: string; body: string; updatedAt?: string }[];
  tasks?: { id: string; title: string; createdAt?: string }[];
  capsules?: { id: string; name: string; description?: string; goal?: string; updatedAt?: string }[];
};
type ProductivityLike = {
  checkpoints?: { id: string; title: string; note?: string; summary?: string; createdAt?: string }[];
  capsuleMeta?: Record<string, { goals?: { text: string }[] } | undefined>;
} | null | undefined;

/** Key used for retrieval docs built from app state; ids are only unique within one kind. */
export const retrievalKey = (kind: RetrievalKind, id: string) => `${kind}:${id}`;
export function parseRetrievalKey(key: string): { kind: RetrievalKind; id: string } | null {
  const i = key.indexOf(':');
  const kind = key.slice(0, i) as RetrievalKind;
  return i > 0 && RETRIEVAL_KINDS.includes(kind) ? { kind, id: key.slice(i + 1) } : null;
}

/** Retrieval docs from renderer state only: notes, tasks, capsules (+ goals) and checkpoints. Capped at maxDocs. */
export function docsFromState(state: StateLike, productivity?: ProductivityLike): RetrievalDoc[] {
  const docs: RetrievalDoc[] = [];
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  for (const n of state.notes ?? []) docs.push({ id: retrievalKey('note', n.id), kind: 'note', title: s(n.title), text: s(n.body), updatedAt: n.updatedAt });
  for (const t of state.tasks ?? []) docs.push({ id: retrievalKey('task', t.id), kind: 'task', title: s(t.title), text: '', updatedAt: t.createdAt });
  for (const c of state.capsules ?? []) {
    const goals = (productivity?.capsuleMeta?.[c.id]?.goals ?? []).map((g) => s(g.text));
    docs.push({ id: retrievalKey('capsule', c.id), kind: 'capsule', title: s(c.name), text: [s(c.goal), s(c.description), ...goals].filter(Boolean).join('\n'), updatedAt: c.updatedAt });
  }
  for (const cp of productivity?.checkpoints ?? []) docs.push({ id: retrievalKey('checkpoint', cp.id), kind: 'checkpoint', title: s(cp.title), text: s(cp.summary) || s(cp.note), updatedAt: cp.createdAt });
  const seen = new Set<string>();
  return docs.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true))).slice(0, RETRIEVAL_LIMITS.maxDocs);
}
