/**
 * Offline fine-tuning dataset builder (goal 20, dataset slice only).
 * Pure and DOM-free: no module dependencies, no network, no file system, no model calls.
 * It curates pasted transcripts into validated chat examples and serialises them as JSONL.
 * No training or upload is started by anything in this module.
 */

export const DATASET_LIMITS = { inputChars: 400000, examples: 2000, turnChars: 8000, minTurnChars: 2 } as const;

export const DATASET_FORMAT = { format: 'desktop-companion-finetune-dataset', version: 1 } as const;

export const TOKEN_ESTIMATE_LABEL = 'approximate tokens (estimate: characters ÷ 4, not a real tokenizer)';

export type DatasetRole = 'user' | 'assistant';
export interface DatasetMessage { role: DatasetRole; content: string }
export interface DatasetExample { id: string; messages: DatasetMessage[] }
export interface SkippedLine { line: number; reason: string }
export interface TranscriptParseResult { examples: DatasetExample[]; skipped: SkippedLine[]; truncated: boolean }

const PREFIX = /^\s*(user|me|assistant|ai)\s*:[ \t]?(.*)$/i;

interface RawTurn { role: DatasetRole; content: string; line: number }

function roleOf(prefix: string): DatasetRole {
  const p = prefix.toLowerCase();
  return p === 'user' || p === 'me' ? 'user' : 'assistant';
}

/** Turn one blank-line separated block into an alternating user/assistant conversation, or null. */
function finishConversation(turns: RawTurn[], startLine: number, skipped: SkippedLine[]): DatasetMessage[] | null {
  if (turns.length === 0) return null;
  const nonEmpty: RawTurn[] = [];
  for (const t of turns) {
    const content = t.content.trim();
    if (!content) skipped.push({ line: t.line, reason: 'empty turn' });
    else nonEmpty.push({ ...t, content });
  }
  const merged: RawTurn[] = [];
  for (const t of nonEmpty) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content = `${last.content}\n${t.content}`;
    else merged.push({ ...t });
  }
  while (merged.length > 0 && merged[0].role !== 'user') {
    const t = merged.shift() as RawTurn;
    skipped.push({ line: t.line, reason: 'assistant turn before any user turn' });
  }
  while (merged.length > 0 && merged[merged.length - 1].role !== 'assistant') {
    const t = merged.pop() as RawTurn;
    skipped.push({ line: t.line, reason: 'user turn has no assistant reply' });
  }
  if (merged.length < 2) {
    if (nonEmpty.length > 0 && merged.length === 0) skipped.push({ line: startLine, reason: 'conversation has no user/assistant pair' });
    return null;
  }
  return merged.map((t) => ({ role: t.role, content: t.content }));
}

/**
 * Split a pasted transcript into examples. Lines start with "User:"/"Me:" or "Assistant:"/"AI:" (any case);
 * unprefixed lines continue the previous turn; a blank line ends a conversation.
 */
export function parseTranscript(text: string): TranscriptParseResult {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('The transcript is empty. Paste lines that start with "User:" or "Assistant:" (or "Me:" / "AI:").');
  }
  if (text.length > DATASET_LIMITS.inputChars) {
    throw new Error(`The transcript has ${text.length} characters; the limit is ${DATASET_LIMITS.inputChars}. Split it into smaller parts.`);
  }
  const lines = text.split(/\r?\n/);
  const examples: DatasetExample[] = [];
  const skipped: SkippedLine[] = [];
  let truncated = false;
  let sawTurn = false;
  let turns: RawTurn[] = [];
  let startLine = 0;

  const flush = () => {
    if (turns.length === 0) return;
    const messages = finishConversation(turns, startLine, skipped);
    turns = [];
    if (!messages) return;
    if (examples.length >= DATASET_LIMITS.examples) { truncated = true; return; }
    examples.push({ id: `ex-${examples.length + 1}`, messages });
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const m = PREFIX.exec(line);
    if (m) {
      sawTurn = true;
      if (turns.length === 0) startLine = lineNo;
      turns.push({ role: roleOf(m[1]), content: m[2], line: lineNo });
    } else if (turns.length > 0) {
      turns[turns.length - 1].content += `\n${line}`;
    } else {
      skipped.push({ line: lineNo, reason: 'no User:/Assistant: prefix before this line' });
    }
  }
  flush();

  if (!sawTurn) {
    throw new Error('No recognizable turns found. Each turn must start with "User:", "Assistant:", "Me:" or "AI:".');
  }
  if (examples.length === 0) {
    throw new Error(`No recognizable turns formed a user/assistant example (${skipped.length} line(s) skipped). Each conversation needs a user turn followed by an assistant reply.`);
  }
  return { examples, skipped, truncated };
}

export interface BuildOptions { dedupe?: boolean; maxTurnChars?: number }
export interface BuildCounts { input: number; kept: number; duplicates: number; truncatedTurns: number; droppedShort: number; droppedOverLimit: number }
export interface BuildResult { examples: DatasetExample[]; counts: BuildCounts }

function contentKey(ex: DatasetExample): string {
  return ex.messages.map((m) => `${m.role}\u0001${m.content}`).join('\u0002');
}

/** Clean examples: trim, truncate long turns, drop examples with too-short turns, optionally drop duplicates. */
export function buildExamples(examples: DatasetExample[], opts: BuildOptions = {}): BuildResult {
  const dedupe = opts.dedupe !== false;
  const maxTurnChars = opts.maxTurnChars ?? DATASET_LIMITS.turnChars;
  if (!Number.isInteger(maxTurnChars) || maxTurnChars < DATASET_LIMITS.minTurnChars || maxTurnChars > DATASET_LIMITS.turnChars) {
    throw new RangeError(`maxTurnChars must be a whole number from ${DATASET_LIMITS.minTurnChars} to ${DATASET_LIMITS.turnChars}.`);
  }
  if (!Array.isArray(examples)) throw new TypeError('examples must be an array.');
  const counts: BuildCounts = { input: examples.length, kept: 0, duplicates: 0, truncatedTurns: 0, droppedShort: 0, droppedOverLimit: 0 };
  const seen = new Set<string>();
  const out: DatasetExample[] = [];
  for (const ex of examples) {
    let short = false;
    let cut = 0;
    const messages = ex.messages.map((m) => {
      let content = String(m.content ?? '').trim();
      if (content.length < DATASET_LIMITS.minTurnChars) short = true;
      if (content.length > maxTurnChars) { content = content.slice(0, maxTurnChars); cut++; }
      return { role: m.role, content };
    });
    if (short) { counts.droppedShort++; continue; }
    const next = { id: ex.id, messages };
    if (dedupe) {
      const key = contentKey(next);
      if (seen.has(key)) { counts.duplicates++; continue; }
      seen.add(key);
    }
    if (out.length >= DATASET_LIMITS.examples) { counts.droppedOverLimit++; continue; }
    counts.truncatedTurns += cut;
    out.push(next);
  }
  counts.kept = out.length;
  return { examples: out, counts };
}

export type ScanKind = 'email' | 'url' | 'secret' | 'digits';
export interface ScanSample { exampleId: string; kind: ScanKind; masked: string }
export interface ScanResult { emails: number; urls: number; secrets: number; longDigits: number; total: number; samples: ScanSample[] }

const SCAN_PATTERNS: Array<[ScanKind, RegExp]> = [
  ['secret', /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bapi[_-]?key\s*[:=]\s*["']?[A-Za-z0-9._-]{6,}/gi],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['url', /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi],
  ['digits', /\d{16,}/g],
];

/** Mask a sensitive match: keep at most two characters at each end. */
export function maskValue(s: string): string {
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(s.length - 4, 12))}${s.slice(-2)}`;
}

/** Count likely personal data and secrets. Samples are masked; at most 10 are returned. */
export function scanExamples(examples: DatasetExample[]): ScanResult {
  const r: ScanResult = { emails: 0, urls: 0, secrets: 0, longDigits: 0, total: 0, samples: [] };
  for (const ex of examples) {
    for (const m of ex.messages) {
      let text = m.content;
      for (const [kind, re] of SCAN_PATTERNS) {
        re.lastIndex = 0;
        const found = text.match(re) ?? [];
        if (found.length === 0) continue;
        if (kind === 'email') r.emails += found.length;
        else if (kind === 'url') r.urls += found.length;
        else if (kind === 'secret') r.secrets += found.length;
        else r.longDigits += found.length;
        r.total += found.length;
        for (const f of found) if (r.samples.length < 10) r.samples.push({ exampleId: ex.id, kind, masked: maskValue(f) });
        // Blank out matches so one value is not counted twice by a later pattern.
        text = text.replace(re, ' ');
      }
    }
  }
  return r;
}

/** 32-bit FNV-1a over UTF-16 code units, as 8 lowercase hex digits. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface SplitResult { train: DatasetExample[]; validation: DatasetExample[]; ratio: number; seed: string }

/**
 * Deterministic split: examples are ranked by FNV-1a of seed + content and the lowest
 * round(n * ratio) go to validation. Same input, ratio and seed always give the same split.
 */
export function splitDataset(examples: DatasetExample[], validationRatio: number, seed: string | number = 0): SplitResult {
  if (typeof validationRatio !== 'number' || !Number.isFinite(validationRatio) || validationRatio < 0 || validationRatio > 0.5) {
    throw new RangeError('Validation ratio must be a number from 0 to 0.5.');
  }
  const s = String(seed);
  const n = examples.length;
  let k = Math.round(n * validationRatio);
  if (validationRatio > 0 && k === 0 && n > 1) k = 1;
  const ranked = examples
    .map((ex, i) => ({ i, h: parseInt(fnv1a(`${s}\u0000${contentKey(ex)}`), 16) }))
    .sort((a, b) => a.h - b.h || a.i - b.i);
  const val = new Set(ranked.slice(0, k).map((r) => r.i));
  return {
    train: examples.filter((_, i) => !val.has(i)),
    validation: examples.filter((_, i) => val.has(i)),
    ratio: validationRatio,
    seed: s,
  };
}

/** One JSON object per line: {"messages":[{"role","content"}...]}. */
export function toJsonl(examples: DatasetExample[]): string {
  if (examples.length === 0) return '';
  return `${examples.map((ex) => JSON.stringify({ messages: ex.messages.map((m) => ({ role: m.role, content: m.content })) })).join('\n')}\n`;
}

/** Parse and validate JSONL. Errors name the exact 1-based line. */
export function parseJsonl(text: string): DatasetExample[] {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The JSONL text is empty.');
  if (text.length > DATASET_LIMITS.inputChars * 2) throw new Error(`The JSONL text is too large (limit ${DATASET_LIMITS.inputChars * 2} characters).`);
  const lines = text.split(/\r?\n/);
  const out: DatasetExample[] = [];
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    if (!lines[i].trim()) continue;
    let obj: unknown;
    try { obj = JSON.parse(lines[i]); } catch { throw new Error(`Line ${n}: not valid JSON.`); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`Line ${n}: expected a JSON object.`);
    const messages = (obj as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length === 0) throw new Error(`Line ${n}: "messages" must be a non-empty array.`);
    const msgs: DatasetMessage[] = [];
    messages.forEach((m: unknown, j: number) => {
      if (!m || typeof m !== 'object') throw new Error(`Line ${n}: messages[${j}] must be an object.`);
      const { role, content } = m as { role?: unknown; content?: unknown };
      if (role !== 'user' && role !== 'assistant') throw new Error(`Line ${n}: messages[${j}].role must be "user" or "assistant".`);
      if (typeof content !== 'string' || !content.trim()) throw new Error(`Line ${n}: messages[${j}].content must be a non-empty string.`);
      const expected: DatasetRole = j % 2 === 0 ? 'user' : 'assistant';
      if (role !== expected) {
        throw new Error(j === 0 ? `Line ${n}: messages[0] must be a user turn.` : `Line ${n}: messages[${j}] must be "${expected}" (turns alternate user/assistant).`);
      }
      if (content.length > DATASET_LIMITS.turnChars) throw new Error(`Line ${n}: messages[${j}].content is longer than ${DATASET_LIMITS.turnChars} characters.`);
      msgs.push({ role, content });
    });
    if (msgs[msgs.length - 1].role !== 'assistant') throw new Error(`Line ${n}: the last turn must be an assistant reply.`);
    if (out.length >= DATASET_LIMITS.examples) throw new Error(`Line ${n}: more than ${DATASET_LIMITS.examples} examples.`);
    out.push({ id: `ex-${out.length + 1}`, messages: msgs });
  }
  if (out.length === 0) throw new Error('The JSONL text is empty.');
  return out;
}

export interface DatasetStats {
  examples: number;
  turns: number;
  /** Characters per example (sum of all turn contents). */
  minChars: number;
  meanChars: number;
  maxChars: number;
  totalChars: number;
  /** ceil(totalChars / 4). An estimate only; no tokenizer is used. */
  approxTokens: number;
  approxTokensLabel: string;
}

export function datasetStats(examples: DatasetExample[]): DatasetStats {
  const sizes = examples.map((ex) => ex.messages.reduce((s, m) => s + m.content.length, 0));
  const totalChars = sizes.reduce((s, x) => s + x, 0);
  return {
    examples: examples.length,
    turns: examples.reduce((s, ex) => s + ex.messages.length, 0),
    minChars: sizes.length ? Math.min(...sizes) : 0,
    meanChars: sizes.length ? Math.round(totalChars / sizes.length) : 0,
    maxChars: sizes.length ? Math.max(...sizes) : 0,
    totalChars,
    approxTokens: Math.ceil(totalChars / 4),
    approxTokensLabel: TOKEN_ESTIMATE_LABEL,
  };
}

export interface DatasetManifest {
  format: typeof DATASET_FORMAT.format;
  version: typeof DATASET_FORMAT.version;
  createdAt: string;
  counts: { train: number; validation: number; total: number; turns: number };
  fingerprint: string;
}

/** Manifest describing an exported split. `createdAt` is passed in so the output is deterministic. */
export function buildManifest(split: { train: DatasetExample[]; validation: DatasetExample[] }, createdAt: string): DatasetManifest {
  if (typeof createdAt !== 'string' || !createdAt) throw new TypeError('createdAt must be a non-empty string.');
  const all = [...split.train, ...split.validation];
  return {
    format: DATASET_FORMAT.format,
    version: DATASET_FORMAT.version,
    createdAt,
    counts: { train: split.train.length, validation: split.validation.length, total: all.length, turns: all.reduce((s, ex) => s + ex.messages.length, 0) },
    fingerprint: fnv1a(`${toJsonl(split.train)}\u0000${toJsonl(split.validation)}`),
  };
}
