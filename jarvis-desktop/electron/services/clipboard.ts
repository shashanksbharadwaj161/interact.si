// Optional clipboard history. Off by default. Capture runs only when the caller invokes capture() and only while
// the user has enabled history. The service never reads or writes the real system clipboard itself: the native
// owner injects a reader (and optionally a storage adapter), which keeps the module testable without a desktop.
import {createHash, randomUUID} from 'node:crypto';

export const CLIPBOARD_SCHEMA_VERSION = 1;

export const CLIPBOARD_LIMITS = {
  maxEntries: {min: 1, max: 200, default: 50},
  retentionMs: {min: 60_000, max: 30 * 24 * 60 * 60 * 1000, default: 24 * 60 * 60 * 1000},
  maxChars: {min: 1, max: 20_000, default: 5_000},
  previewChars: 120,
};

export interface ClipboardReader {
  /** Returns the current clipboard text, or '' when the clipboard holds no text. */
  readText(): Promise<string>;
  /** Optional. True when the source marked its clipboard content as concealed (e.g. a password manager). */
  isConcealed?(): Promise<boolean>;
}

export interface ClipboardStorage {
  /** Returns the last saved document, or null when nothing has been saved. */
  read(): Promise<string | null>;
  /** Replaces the saved document. Must be atomic on the native side. */
  write(data: string): Promise<void>;
}

export interface ClipboardEntry {
  id: string;
  text: string;
  /** Epoch ms of the most recent capture of this text. */
  capturedAt: number;
  /** Number of times this text was copied while history was enabled. */
  copies: number;
}

export interface ClipboardEntryView {
  id: string;
  preview: string;
  capturedAt: number;
  copies: number;
}

export type CaptureOutcome =
  | 'disabled'
  | 'unchanged'
  | 'empty'
  | 'concealed'
  | 'sensitive'
  | 'too-large'
  | 'added'
  | 'merged';

export interface ClipboardStatus {
  enabled: boolean;
  persisted: boolean;
  count: number;
  maxEntries: number;
  retentionMs: number;
  maxChars: number;
  lastError?: string;
  warning?: string;
}

export interface ClipboardHistoryOptions {
  reader: ClipboardReader;
  storage?: ClipboardStorage;
  now?: () => number;
  newId?: () => string;
  maxEntries?: number;
  retentionMs?: number;
  maxChars?: number;
}

// Conservative heuristics for credential-shaped text. A match means the text is never stored.
// These reduce accidental capture; they do not guarantee that no secret is stored.
const SENSITIVE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i,
  /\b(?:password|passwd|pwd|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|private[_ -]?key)\b\s*[:=]\s*\S+/i,
];

/** True when the text looks like a credential, token, or password assignment. */
export function looksSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function clampInt(v: number | undefined, range: {min: number; max: number; default: number}): number {
  if (v === undefined) return range.default;
  if (!Number.isFinite(v)) throw new Error('Clipboard limit must be a finite number');
  return Math.min(range.max, Math.max(range.min, Math.floor(v)));
}

function parseDocument(raw: string, maxChars: number): {entries: ClipboardEntry[]; enabled: boolean; warning?: string} {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return {entries: [], enabled: false, warning: 'Clipboard history file was not valid JSON and was ignored.'}; }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return {entries: [], enabled: false, warning: 'Clipboard history file had an unexpected structure and was ignored.'};
  const o = j as Record<string, unknown>;
  if (o.schemaVersion !== CLIPBOARD_SCHEMA_VERSION) return {entries: [], enabled: false, warning: 'Clipboard history file has an unsupported schema and was ignored.'};
  const enabled = o.enabled === true;
  const rawEntries = Array.isArray(o.entries) ? o.entries : [];
  let dropped = 0;
  const entries: ClipboardEntry[] = [];
  for (const e of rawEntries) {
    const x = e as Record<string, unknown>;
    const ok = typeof x?.id === 'string' && typeof x.text === 'string' && x.text.length > 0 && x.text.length <= maxChars
      && typeof x.capturedAt === 'number' && Number.isFinite(x.capturedAt)
      && typeof x.copies === 'number' && Number.isInteger(x.copies) && x.copies >= 1;
    if (ok && !looksSensitive(x.text as string)) entries.push({id: x.id as string, text: x.text as string, capturedAt: x.capturedAt as number, copies: x.copies as number});
    else dropped++;
  }
  return {entries, enabled, warning: dropped ? `${dropped} stored clipboard entries were invalid or sensitive and were dropped.` : undefined};
}

export class ClipboardHistory {
  private readonly reader: ClipboardReader;
  private readonly storage?: ClipboardStorage;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxEntries: number;
  private readonly retentionMs: number;
  private readonly maxChars: number;
  private enabled = false;
  private entries: ClipboardEntry[] = [];
  private lastFingerprint: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastError?: string;
  private warning?: string;

  constructor(opts: ClipboardHistoryOptions) {
    this.reader = opts.reader;
    this.storage = opts.storage;
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => randomUUID());
    this.maxEntries = clampInt(opts.maxEntries, CLIPBOARD_LIMITS.maxEntries);
    this.retentionMs = clampInt(opts.retentionMs, CLIPBOARD_LIMITS.retentionMs);
    this.maxChars = clampInt(opts.maxChars, CLIPBOARD_LIMITS.maxChars);
  }

  /** Loads persisted state. Without storage, history stays in memory only. Safe to call once at startup. */
  async init(): Promise<void> {
    if (!this.storage) return;
    try {
      const raw = await this.storage.read();
      if (raw === null) return;
      const doc = parseDocument(raw, this.maxChars);
      this.enabled = doc.enabled;
      this.entries = doc.entries;
      this.warning = doc.warning;
      this.pruneLocked(this.now());
    } catch (e) {
      this.lastError = `Clipboard history could not be loaded: ${(e as Error).message}`;
    }
  }

  status(): ClipboardStatus {
    return {
      enabled: this.enabled,
      persisted: !!this.storage,
      count: this.entries.length,
      maxEntries: this.maxEntries,
      retentionMs: this.retentionMs,
      maxChars: this.maxChars,
      lastError: this.lastError,
      warning: this.warning,
    };
  }

  /** Turning history on starts capture. Turning it off purges all stored entries. */
  async setEnabled(on: boolean): Promise<ClipboardStatus> {
    return this.serialize(async () => {
      this.enabled = on === true;
      if (!this.enabled) {
        this.entries = [];
        this.lastFingerprint = null;
      }
      await this.persistLocked();
      return this.status();
    });
  }

  /**
   * Reads the clipboard once through the injected reader and records it when history is enabled.
   * Callers own the polling cadence. The service keeps no timers.
   */
  async capture(): Promise<CaptureOutcome> {
    if (!this.enabled) return 'disabled';
    let read: {text: string; concealed: boolean};
    try {
      read = {text: await this.reader.readText(), concealed: this.reader.isConcealed ? await this.reader.isConcealed() : false};
    } catch (e) {
      this.lastError = `Clipboard read failed: ${(e as Error).message}`;
      return 'empty';
    }
    const {text, concealed} = read;
    if (typeof text !== 'string' || text.trim().length === 0) return 'empty';
    const fp = fingerprint(text);
    if (fp === this.lastFingerprint) return 'unchanged';
    this.lastFingerprint = fp;
    if (concealed) return 'concealed';
    if (looksSensitive(text)) return 'sensitive';
    if (text.length > this.maxChars) return 'too-large';
    return this.serialize(async () => {
      if (!this.enabled) return 'disabled';
      const now = this.now();
      this.pruneLocked(now);
      const existing = this.entries.find((e) => e.text === text);
      let outcome: CaptureOutcome;
      if (existing) {
        existing.capturedAt = now;
        existing.copies += 1;
        this.entries = [existing, ...this.entries.filter((e) => e !== existing)];
        outcome = 'merged';
      } else {
        this.entries.unshift({id: this.newId(), text, capturedAt: now, copies: 1});
        this.entries.length = Math.min(this.entries.length, this.maxEntries);
        outcome = 'added';
      }
      await this.persistLocked();
      return outcome;
    });
  }

  /** Lists entries newest first. Returns previews by default; full text is available through get(). */
  list(limit = this.maxEntries): ClipboardEntryView[] {
    this.pruneLocked(this.now());
    const n = Math.min(this.maxEntries, Math.max(0, Math.floor(limit)));
    return this.entries.slice(0, n).map((e) => ({
      id: e.id,
      preview: e.text.replace(/\s+/g, ' ').slice(0, CLIPBOARD_LIMITS.previewChars),
      capturedAt: e.capturedAt,
      copies: e.copies,
    }));
  }

  /** Returns the full text of one entry for the caller to paste. The service never writes to the clipboard. */
  get(id: string): string | null {
    return this.entries.find((e) => e.id === id)?.text ?? null;
  }

  async remove(id: string): Promise<boolean> {
    return this.serialize(async () => {
      const before = this.entries.length;
      this.entries = this.entries.filter((e) => e.id !== id);
      if (this.entries.length === before) return false;
      await this.persistLocked();
      return true;
    });
  }

  /** Removes every stored entry and forgets the last clipboard fingerprint. Does not change the enabled flag. */
  async purge(): Promise<void> {
    return this.serialize(async () => {
      this.entries = [];
      this.lastFingerprint = null;
      await this.persistLocked();
    });
  }

  private pruneLocked(now: number): void {
    const cutoff = now - this.retentionMs;
    this.entries = this.entries.filter((e) => e.capturedAt >= cutoff).slice(0, this.maxEntries);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persistLocked(): Promise<void> {
    if (!this.storage) return;
    const doc = {schemaVersion: CLIPBOARD_SCHEMA_VERSION, enabled: this.enabled, entries: this.entries};
    try {
      await this.storage.write(JSON.stringify(doc));
      this.lastError = undefined;
    } catch (e) {
      this.lastError = `Clipboard history could not be saved: ${(e as Error).message}`;
    }
  }
}
