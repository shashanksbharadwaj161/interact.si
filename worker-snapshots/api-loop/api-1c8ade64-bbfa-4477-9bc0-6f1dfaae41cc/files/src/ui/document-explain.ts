// Approved document explanations. Pure, DOM-free text handling only:
// - the user pastes a document, sees a sensitive-content scan, and explicitly approves that exact text;
// - the approval is bound to a fingerprint and length, so any edit afterwards invalidates it;
// - prompts are assembled for one chunk at a time and only when the approval is still current.
// This module never calls a model, opens files or touches the network; sending happens in the UI through the existing route.

export const EXPLAIN_LIMITS = Object.freeze({
  documentChars: 120000,
  chunkChars: 12000,
  maxChunks: 10,
  titleChars: 120,
});

/** Optional follow-up question length (kept out of EXPLAIN_LIMITS so that object stays as specified). */
export const EXPLAIN_QUESTION_CHARS = 500;
const SAMPLE_LIMIT = 10;

export type ExplainModeId = 'summary' | 'key-points' | 'plain-language' | 'questions-to-ask' | 'glossary';
export type ExplainMode = Readonly<{ id: ExplainModeId; label: string; instruction: string }>;

export const EXPLAIN_MODES: readonly ExplainMode[] = Object.freeze([
  Object.freeze({ id: 'summary', label: 'Summary', instruction: 'Summarise this part of the document in a few short paragraphs. Keep names, numbers and dates exactly as written.' }),
  Object.freeze({ id: 'key-points', label: 'Key points', instruction: 'List the key points of this part of the document as short bullet points, most important first.' }),
  Object.freeze({ id: 'plain-language', label: 'Plain language', instruction: 'Explain this part of the document in plain, everyday language for someone without specialist knowledge.' }),
  Object.freeze({ id: 'questions-to-ask', label: 'Questions to ask', instruction: 'List questions a careful reader should ask about this part of the document: unclear terms, obligations, deadlines, costs and anything missing.' }),
  Object.freeze({ id: 'glossary', label: 'Glossary', instruction: 'Make a glossary of the technical, legal or unusual terms used in this part of the document, each with a one-sentence definition based on how the text uses it.' }),
] as ExplainMode[]);

export const explainModeById = (id: string): ExplainMode | undefined => EXPLAIN_MODES.find((m) => m.id === id);

/* ---------- Fingerprint ---------- */

/** FNV-1a 32-bit over UTF-16 code units plus the length: 'fnv1a-<8 hex>-<chars>'. Deterministic; not a security hash. */
export function fingerprintText(text: string): string {
  if (typeof text !== 'string') throw new Error('Document text must be a string.');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, '0')}-${text.length}`;
}

/* ---------- Sensitive-content scan ---------- */

export type SensitiveKind = 'email' | 'url' | 'secret' | 'longNumber';
export type SensitiveSample = { kind: SensitiveKind; index: number; masked: string };
export type SensitiveScan = {
  counts: Record<SensitiveKind, number>;
  total: number;
  /** At most 10 masked samples, in document order per kind. */
  samples: SensitiveSample[];
};

const SCAN_PATTERNS: readonly { kind: SensitiveKind; re: RegExp }[] = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: 'url', re: /\b(?:https?|ftp):\/\/[^\s<>"'`)\]]+/gi },
  { kind: 'secret', re: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*|\bsk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?[^\s"'&,;]{4,}/gi },
  { kind: 'longNumber', re: /(?<!\d)\d{16,}(?!\d)/g },
];

/** Masks a matched value so the scan can be shown without repeating it. Secrets keep only a short prefix. */
export function maskValue(kind: SensitiveKind, value: string): string {
  const stars = (n: number) => '•'.repeat(Math.max(3, Math.min(n, 8)));
  if (kind === 'secret') {
    const prefix = /^bearer\s/i.test(value) ? 'Bearer ' : value.slice(0, 3);
    return `${prefix}${stars(value.length - prefix.length)}`;
  }
  if (value.length <= 6) return stars(value.length);
  return `${value.slice(0, 2)}${stars(value.length - 4)}${value.slice(-2)}`;
}

/** Counts emails, URLs, key/token-like secrets and 16+ digit runs, with up to 10 masked samples. */
export function scanSensitive(text: string): SensitiveScan {
  const counts: Record<SensitiveKind, number> = { email: 0, url: 0, secret: 0, longNumber: 0 };
  const samples: SensitiveSample[] = [];
  if (typeof text !== 'string' || !text) return { counts, total: 0, samples };
  for (const { kind, re } of SCAN_PATTERNS) {
    const rx = new RegExp(re.source, re.flags);
    for (let m = rx.exec(text); m; m = rx.exec(text)) {
      if (m[0].length === 0) { rx.lastIndex++; continue; }
      counts[kind]++;
      if (samples.length < SAMPLE_LIMIT) samples.push({ kind, index: m.index, masked: maskValue(kind, m[0]) });
    }
  }
  const total = counts.email + counts.url + counts.secret + counts.longNumber;
  return { counts, total, samples };
}

/* ---------- Chunking ---------- */

export type DocumentChunk = { index: number; start: number; end: number; text: string };

function checkDocument(text: unknown): string {
  if (typeof text !== 'string') throw new Error('Document text must be a string.');
  if (!text.trim()) throw new Error('The document is empty; paste some text first.');
  if (text.length > EXPLAIN_LIMITS.documentChars) {
    throw new Error(`The document is ${text.length.toLocaleString('en-US')} characters; the limit is ${EXPLAIN_LIMITS.documentChars} characters.`);
  }
  return text;
}

/** Splits a long paragraph into pieces of at most chunkChars, preferring a line break or space near the end. */
function splitLong(start: number, end: number, text: string, max: number): [number, number][] {
  const out: [number, number][] = [];
  let s = start;
  while (end - s > max) {
    const windowEnd = s + max;
    const slice = text.slice(s, windowEnd);
    let cutAt = slice.lastIndexOf('\n');
    if (cutAt < max / 2) cutAt = slice.lastIndexOf(' ');
    const e = cutAt >= max / 2 ? s + cutAt + 1 : windowEnd;
    out.push([s, e]);
    s = e;
  }
  out.push([s, end]);
  return out;
}

/**
 * Splits text on paragraph boundaries (blank lines) into contiguous chunks of at most chunkChars.
 * Chunks cover the whole text in order: chunk.text === text.slice(start, end). Throws for empty, oversized
 * or text that would need more than maxChunks parts.
 */
export function chunkDocument(text: string): DocumentChunk[] {
  checkDocument(text);
  const max = EXPLAIN_LIMITS.chunkChars;
  // Paragraph pieces, each including its trailing blank-line separator, so they tile the text exactly.
  const pieces: [number, number][] = [];
  const sep = /\n[ \t]*\n\s*/g;
  let from = 0;
  for (let m = sep.exec(text); m; m = sep.exec(text)) {
    const e = m.index + m[0].length;
    pieces.push([from, e]);
    from = e;
  }
  if (from < text.length) pieces.push([from, text.length]);

  const ranges: [number, number][] = [];
  let cur: [number, number] | null = null;
  for (const [ps, pe] of pieces) {
    if (pe - ps > max) {
      if (cur) { ranges.push(cur); cur = null; }
      const parts = splitLong(ps, pe, text, max);
      for (let i = 0; i < parts.length - 1; i++) ranges.push(parts[i]);
      cur = parts[parts.length - 1];
      continue;
    }
    if (!cur) cur = [ps, pe];
    else if (pe - cur[0] <= max) cur = [cur[0], pe];
    else { ranges.push(cur); cur = [ps, pe]; }
  }
  if (cur) ranges.push(cur);
  if (ranges.length > EXPLAIN_LIMITS.maxChunks) {
    throw new Error(`The document needs ${ranges.length} parts; at most ${EXPLAIN_LIMITS.maxChunks} parts of ${max} characters are allowed. Shorten it or add paragraph breaks.`);
  }
  return ranges.map(([start, end], index) => ({ index, start, end, text: text.slice(start, end) }));
}

/* ---------- Approval ---------- */

export type DocumentApproval = {
  title: string;
  fingerprint: string;
  chars: number;
  chunkCount: number;
  approvedAt: string;
  sensitive: SensitiveScan;
};

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Approves exactly this text under a title at `now`. Throws descriptive Errors for a bad title, empty/oversized text or invalid time. */
export function approveDocument(input: { title: string; text: string; now: number | Date }): DocumentApproval {
  if (!input || typeof input !== 'object') throw new Error('Approval input is required.');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('A document title is required.');
  if (title.length > EXPLAIN_LIMITS.titleChars) throw new Error(`The document title must be at most ${EXPLAIN_LIMITS.titleChars} characters.`);
  if (CONTROL_RE.test(title)) throw new Error('The document title must not contain control characters.');
  const text = checkDocument(input.text);
  const ms = input.now instanceof Date ? input.now.getTime() : input.now;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('Invalid approval time.');
  const chunks = chunkDocument(text);
  return {
    title,
    fingerprint: fingerprintText(text),
    chars: text.length,
    chunkCount: chunks.length,
    approvedAt: new Date(ms).toISOString(),
    sensitive: scanSensitive(text),
  };
}

/** True only when the approval's fingerprint and length match the current text exactly. */
export function isApprovalCurrent(approval: DocumentApproval | null | undefined, text: string): boolean {
  if (!approval || typeof approval !== 'object' || typeof text !== 'string') return false;
  return approval.chars === text.length && approval.fingerprint === fingerprintText(text);
}

/* ---------- Prompt ---------- */

/**
 * Builds the prompt for one approved chunk. Throws unless the approval is current, the mode is known and the
 * chunk index is in range. The chunk text is included verbatim.
 */
export function buildExplainPrompt(input: { approval: DocumentApproval; text: string; chunk: number; mode: string; question?: string }): string {
  const { approval, text, chunk, mode, question } = input ?? ({} as typeof input);
  if (!isApprovalCurrent(approval, text)) throw new Error('The document is not approved, or it changed after approval. Scan and approve it again.');
  const m = typeof mode === 'string' ? explainModeById(mode) : undefined;
  if (!m) throw new Error(`Unknown explain mode "${String(mode)}". Expected one of: ${EXPLAIN_MODES.map((x) => x.id).join(', ')}.`);
  const chunks = chunkDocument(text);
  if (!Number.isInteger(chunk) || chunk < 0 || chunk >= chunks.length) {
    throw new Error(`Part index ${String(chunk)} is out of range; the document has ${chunks.length} part${chunks.length === 1 ? '' : 's'}.`);
  }
  const q = typeof question === 'string' ? question.trim() : '';
  if (q.length > EXPLAIN_QUESTION_CHARS) throw new Error(`The question must be at most ${EXPLAIN_QUESTION_CHARS} characters.`);
  if (CONTROL_RE.test(q)) throw new Error('The question must not contain control characters.');
  const part = chunks[chunk];
  const lines = [
    `Task: ${m.instruction}`,
    ...(q ? [`Question from the user: ${q}`] : []),
    `Rules: use only the document text below. Cite the part number (for example "part ${chunk + 1}") for each point. If the answer is not in the text, say that it is not in the text. Do not invent facts.`,
    `Document: ${approval.title} (part ${chunk + 1} of ${chunks.length})`,
    `"""\n${part.text}\n"""`,
  ];
  return lines.join('\n\n');
}
