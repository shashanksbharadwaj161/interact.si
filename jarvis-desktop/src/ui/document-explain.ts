// Approved document explanations. Pure, DOM-free text handling only:
// - the user pastes a document, sees a sensitive-content scan, and explicitly approves that exact text;
// - the approval is bound to a fingerprint and length, so any edit afterwards invalidates it;
// - prompts are assembled for one chunk at a time and only when the approval is still current.
// This module never opens files or touches the network itself. The "Explain with AI" helpers at the end only pass an
// already-reviewed prompt to the guarded chat bridge object the UI hands in (chat / chatStreamStart), which routes by
// settings.mode in the main process; the renderer never sees a key.

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

/* ---------- Explain with AI (guarded chat call) ---------- */

/** Limits for the one-shot "Explain with AI" request (separate from EXPLAIN_LIMITS, which the approval flow uses). */
export const EXPLAIN_AI_LIMITS = Object.freeze({
  /** User-selected text (or the whole note body) included in one request; longer text is cut with a warning. */
  documentChars: 12000,
  /** The assembled prompt; stays under the chat route's 16 KiB input limit. */
  promptChars: 15000,
  /** Reply text kept for display and insertion. */
  replyChars: 20000,
  /** A request with no final answer after this long is stopped and reported as incomplete. */
  timeoutMs: 180000,
});

export type ExplainDepth = 'summary' | 'detailed' | 'plain-language';
export const EXPLAIN_DEPTHS: readonly Readonly<{ id: ExplainDepth; label: string; instruction: string }>[] = Object.freeze([
  Object.freeze({ id: 'summary' as const, label: 'Short summary', instruction: 'Give a short explanation of the main points, in at most five numbered sections.' }),
  Object.freeze({ id: 'detailed' as const, label: 'Detailed', instruction: 'Give a detailed explanation that walks through the text in order, one numbered section per idea or clause.' }),
  Object.freeze({ id: 'plain-language' as const, label: 'Plain language', instruction: 'Explain it in plain, everyday language for someone without specialist knowledge, defining any jargon.' }),
]);

export type ExplainRequestOptions = { depth: ExplainDepth; question?: string; noteTitle?: string | null; selection?: string | null };
export type ExplainRequest = Readonly<{
  /** The exact text passed to chat(). */
  prompt: string;
  /** Identical to prompt: shown under "What will be sent". */
  preview: string;
  /** Characters of the user's text included in the prompt (after any cut). */
  sentChars: number;
  warnings: readonly string[];
  truncated: boolean;
  /** Whether the selection or the whole note body was used. */
  source: 'selection' | 'text';
  depth: ExplainDepth;
}>;

// eslint-disable-next-line no-control-regex
const AI_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const AI_CONTROL_ALL = /[\u0000-\u001f\u007f]+/g;
const normalizeBody = (s: unknown) => (typeof s === 'string' ? s : '').replace(/\r\n?/g, '\n').replace(AI_CONTROL, '');
const oneLine = (s: unknown) => (typeof s === 'string' ? s : '').replace(AI_CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();

/**
 * Builds the exact explain prompt from user-chosen text only: the selection when it has content, otherwise the whole note
 * body. Deterministic and frozen; throws a descriptive Error when there is nothing to explain or the depth is unknown.
 */
export function buildExplainRequest(text: string, opts: ExplainRequestOptions): ExplainRequest {
  const depthDef = EXPLAIN_DEPTHS.find((d) => d.id === opts?.depth);
  if (!depthDef) throw new Error(`Unknown explanation depth "${String(opts?.depth)}". Choose one of: ${EXPLAIN_DEPTHS.map((d) => d.id).join(', ')}.`);
  const warnings: string[] = [];
  const selection = normalizeBody(opts.selection);
  const source: 'selection' | 'text' = selection.trim() ? 'selection' : 'text';
  const full = (source === 'selection' ? selection : normalizeBody(text)).trim();
  if (!full) throw new Error('There is nothing to explain. Select some text or write in the note first.');
  const max = EXPLAIN_AI_LIMITS.documentChars;
  const truncated = full.length > max;
  const body = truncated ? full.slice(0, max) : full;
  if (truncated) warnings.push(`The ${source === 'selection' ? 'selection' : 'note'} is ${full.length.toLocaleString('en-US')} characters; only the first ${max.toLocaleString('en-US')} are sent and the model will not see the rest.`);
  let question = oneLine(opts.question);
  if (question.length > EXPLAIN_QUESTION_CHARS) {
    question = question.slice(0, EXPLAIN_QUESTION_CHARS);
    warnings.push(`The question was cut to ${EXPLAIN_QUESTION_CHARS} characters.`);
  }
  const title = oneLine(opts.noteTitle).slice(0, EXPLAIN_LIMITS.titleChars);

  const parts = [
    `Task: Explain the text below. ${depthDef.instruction}`,
    ...(question ? [`Question from the user: ${question}`] : []),
    [
      'Format:',
      '- Plain text only: no Markdown headings, tables, bold markers or code fences.',
      '- Use short numbered sections (1., 2., 3.).',
      '- In each section, quote the exact words from the source text you are explaining, in double quotes.',
      '- Use only the text below. If something is not in the text, say that it is not in the text. Do not invent facts.',
      '- Start directly with section 1: no preamble.',
    ].join('\n'),
    `Source: ${title ? `"${title}", ` : ''}${source === 'selection' ? 'selected passage' : 'whole note'} (${body.length} characters)\n"""\n${body}\n"""`,
  ];
  const prompt = parts.join('\n\n');
  if (prompt.length > EXPLAIN_AI_LIMITS.promptChars) throw new Error(`The prompt is ${prompt.length} characters; the limit is ${EXPLAIN_AI_LIMITS.promptChars}. Select less text.`);
  return Object.freeze({ prompt, preview: prompt, sentChars: body.length, warnings: Object.freeze(warnings), truncated, source, depth: depthDef.id });
}

export type ExplainDestination = Readonly<{ mode: 'offline' | 'online'; label: 'local model' | 'Anthropic cloud (stored key)'; requiresConfirmation: boolean }>;

/** Where chat() sends the prompt for a given settings.mode. Anything but 'online' is the local model and needs no confirmation. */
export function describeDestination(mode: unknown): ExplainDestination {
  return mode === 'online'
    ? Object.freeze({ mode: 'online' as const, label: 'Anthropic cloud (stored key)' as const, requiresConfirmation: true })
    : Object.freeze({ mode: 'offline' as const, label: 'local model' as const, requiresConfirmation: false });
}

const EXPLAIN_PREAMBLE = /^(?:(?:sure|certainly|of course|okay|ok|absolutely)[!,.]?\s+)?here(?:'s|’s|\s+is|\s+are)\b[^\n:]{0,100}:[ \t]*\n?/i;

function cleanExplainUncapped(raw: unknown): string {
  let s = normalizeBody(raw).trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(EXPLAIN_PREAMBLE, '').trim();
    s = s.replace(/^[ \t]*```[\w-]*[ \t]*$\n?/gm, '').trim();
  }
  return s.replace(/\n{3,}/g, '\n\n');
}

/** Strips "Here is…:" preambles and code-fence lines, and caps the length. Pure. */
export function cleanExplainReply(raw: unknown): string {
  const s = cleanExplainUncapped(raw);
  return s.length > EXPLAIN_AI_LIMITS.replyChars ? s.slice(0, EXPLAIN_AI_LIMITS.replyChars) : s;
}

export type ExplainStatus = 'complete' | 'truncated' | 'cancelled' | 'incomplete' | 'failed';
export type ExplainResult = { status: ExplainStatus; text: string; source: 'local' | 'cloud' | 'system'; reason?: string };

type ExplainMsg = { text: string; source: 'local' | 'cloud' | 'system' };
type ExplainStart = { streamId: string; generation: number; route: 'local' | 'cloud' };
type ExplainEvent =
  | { type: 'status' }
  | { type: 'delta'; text: string }
  | { type: 'done'; outcome: ExplainStatus; reply?: ExplainMsg | null }
  | { type: 'lost'; reason: string };

export type ExplainChatApi = {
  chat(text: string): Promise<ExplainMsg>;
  chatStreamStart?(text: string): Promise<ExplainStart>;
  onChatStream?(start: ExplainStart, handler: (event: any) => void): () => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  chatStreamCancel?(streamId: string): Promise<boolean>;
};

export type ExplainRunOptions = { signal?: AbortSignal; onDelta?: (delta: string, soFar: string) => void; timeoutMs?: number };

const explainMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : typeof e === 'string' && e ? e : fallback);

function explainFinish(status: ExplainStatus, raw: string, source: ExplainResult['source'], reason?: string): ExplainResult {
  const full = cleanExplainUncapped(raw);
  const capped = full.length > EXPLAIN_AI_LIMITS.replyChars;
  const out: ExplainResult = { status: status === 'complete' && capped ? 'truncated' : status, text: capped ? full.slice(0, EXPLAIN_AI_LIMITS.replyChars) : full, source };
  if (reason) out.reason = reason;
  return out;
}

/**
 * Sends exactly request.prompt once. Prefers the cancellable stream API, otherwise chat(). Never retries, never sends twice
 * and never throws for expected failures: failed, lost and system replies resolve as {status:'failed'|'incomplete', reason}.
 */
export async function runDocumentExplain(api: ExplainChatApi, request: Pick<ExplainRequest, 'prompt'>, opts: ExplainRunOptions = {}): Promise<ExplainResult> {
  const { signal, onDelta } = opts;
  const timeoutMs = opts.timeoutMs ?? EXPLAIN_AI_LIMITS.timeoutMs;
  if (!api || (typeof api.chat !== 'function' && typeof api.chatStreamStart !== 'function')) return { status: 'failed', text: '', source: 'system', reason: 'The assistant is not available.' };
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) return { status: 'failed', text: '', source: 'system', reason: 'There is no prompt to send.' };
  if (signal?.aborted) return { status: 'cancelled', text: '', source: 'system', reason: 'Cancelled before sending.' };

  if (typeof api.chatStreamStart === 'function' && typeof api.onChatStream === 'function') {
    let start: ExplainStart;
    try {
      start = await api.chatStreamStart(request.prompt);
    } catch (e) {
      return { status: 'failed', text: '', source: 'system', reason: explainMessage(e, 'The assistant could not start a reply.') };
    }
    const cancelStream = () => {
      try { if (api.chatStreamCancel) void Promise.resolve(api.chatStreamCancel(start.streamId)).catch(() => undefined); } catch { /* ignore */ }
    };
    let collected = '';
    return new Promise<ExplainResult>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (r: ExplainResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try { unsubscribe?.(); } catch { /* already gone */ }
        resolve(r);
      };
      const onAbort = () => { cancelStream(); settle(explainFinish('cancelled', collected, start.route, 'Stopped by you; the partial text is kept.')); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { cancelStream(); settle(explainFinish('incomplete', collected, start.route, `No final reply after ${Math.round(timeoutMs / 1000)} seconds; stopped.`)); }, timeoutMs);
      try {
        unsubscribe = api.onChatStream!(start, (ev: ExplainEvent) => {
          if (settled || !ev || typeof ev !== 'object') return;
          if (ev.type === 'delta' && typeof ev.text === 'string') {
            if (collected.length < EXPLAIN_AI_LIMITS.replyChars + 1000) collected += ev.text;
            try { onDelta?.(ev.text, collected); } catch { /* UI callback errors do not stop the run */ }
          } else if (ev.type === 'done') {
            const raw = typeof ev.reply?.text === 'string' && ev.reply.text ? ev.reply.text : collected;
            const source = ev.reply?.source ?? start.route;
            if (ev.outcome === 'failed' || source === 'system') settle({ status: 'failed', text: '', source: 'system', reason: ev.reply?.text || 'The assistant produced no reply.' });
            else {
              const r = explainFinish(ev.outcome ?? 'complete', raw, source, ev.outcome === 'incomplete' ? 'The connection ended early; the reply is incomplete.' : undefined);
              settle(r.text || r.status !== 'complete' ? r : { status: 'failed', text: '', source: 'system', reason: 'The assistant returned an empty reply.' });
            }
          } else if (ev.type === 'lost') {
            settle(explainFinish('incomplete', collected, start.route, `The connection to the assistant was lost (${String(ev.reason)}).`));
          }
        });
        if (settled) { try { unsubscribe?.(); } catch { /* ignore */ } }
      } catch (e) {
        cancelStream();
        settle({ status: 'failed', text: '', source: 'system', reason: explainMessage(e, 'The assistant stream could not be read.') });
      }
    });
  }

  // One-shot fallback: chat() cannot be stopped mid-request, so cancel/timeout stop waiting and say so honestly.
  return new Promise<ExplainResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: ExplainResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => settle({ status: 'cancelled', text: '', source: 'system', reason: 'Stopped waiting. This bridge cannot stop a running reply, so it may still appear in the Assistant conversation history.' });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle({ status: 'incomplete', text: '', source: 'system', reason: `No reply after ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    Promise.resolve()
      .then(() => api.chat(request.prompt))
      .then((reply) => {
        if (!reply || typeof reply.text !== 'string') return settle({ status: 'failed', text: '', source: 'system', reason: 'The assistant produced no reply.' });
        if (reply.source === 'system') return settle({ status: 'failed', text: '', source: 'system', reason: reply.text || 'The assistant produced no reply.' });
        const r = explainFinish('complete', reply.text, reply.source === 'cloud' ? 'cloud' : 'local');
        settle(r.text ? r : { status: 'failed', text: '', source: 'system', reason: 'The assistant returned an empty reply.' });
      }, (e) => settle({ status: 'failed', text: '', source: 'system', reason: explainMessage(e, 'The assistant could not reply.') }));
  });
}
