// Pure, DOM-free agent log model for the Agent Control Room section of the Developer page.
// Development tooling only: entries are recorded by hand. No network, timers, model calls or completion ratios.

export type LogLevel = 'info' | 'warn' | 'error' | 'result';

export type LogEntry = {
  id: string;
  taskId: string;
  at: string;
  level: LogLevel;
  message: string;
  data?: string;
};

export type NewLogEntry = { taskId: string; level: LogLevel; message: string; data?: string };

export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error', 'result'];
export const AGENT_LOG_PREF_KEY = 'developer.agentLog';
export const AGENT_LOG_LIMITS = { messageChars: 500, dataChars: 4000, entriesPerTask: 200, totalEntries: 1000, taskIdChars: 80 } as const;
export const AGENT_LOG_FORMAT = 'desktop-companion-agent-log';
export const AGENT_LOG_VERSION = 1;
export const TRUNCATED_MARKER = '…[truncated]';
export const REDACTED = '[redacted]';

export const isLogLevel = (v: unknown): v is LogLevel => typeof v === 'string' && (LOG_LEVELS as readonly string[]).includes(v);
const isIsoString = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function truncateData(data: string): string {
  if (data.length <= AGENT_LOG_LIMITS.dataChars) return data;
  return data.slice(0, AGENT_LOG_LIMITS.dataChars - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
}

/** Applies per-task then total caps, keeping the newest (last appended) entries. Order is preserved. */
function applyCaps(log: readonly LogEntry[]): LogEntry[] {
  const perTask = new Map<string, number>();
  const keep: boolean[] = new Array(log.length).fill(false);
  let total = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (total >= AGENT_LOG_LIMITS.totalEntries) break;
    const n = perTask.get(log[i].taskId) ?? 0;
    if (n >= AGENT_LOG_LIMITS.entriesPerTask) continue;
    perTask.set(log[i].taskId, n + 1);
    keep[i] = true;
    total++;
  }
  return log.filter((_, i) => keep[i]);
}

/**
 * Returns a new log with one entry appended. Ids are deterministic: 'l-<base36 now>-<index within log>'.
 * Throws descriptive Errors for an unknown level, missing task id or missing/oversized message.
 */
export function appendEntry(log: readonly LogEntry[], input: NewLogEntry, now: number | Date): LogEntry[] {
  const level = typeof input?.level === 'string' ? input.level.trim() : input?.level;
  if (!isLogLevel(level)) throw new Error(`Unknown log level "${String(input?.level)}". Expected one of: ${LOG_LEVELS.join(', ')}.`);
  const taskId = typeof input?.taskId === 'string' ? input.taskId.trim() : '';
  if (!taskId) throw new Error('Log entry task id is required.');
  if (taskId.length > AGENT_LOG_LIMITS.taskIdChars) throw new Error(`Log entry task id must be at most ${AGENT_LOG_LIMITS.taskIdChars} characters.`);
  const message = typeof input?.message === 'string' ? input.message.trim() : '';
  if (!message) throw new Error('Log entry message is required.');
  if (message.length > AGENT_LOG_LIMITS.messageChars) throw new Error(`Log entry message must be at most ${AGENT_LOG_LIMITS.messageChars} characters.`);
  if (input.data !== undefined && typeof input.data !== 'string') throw new Error('Log entry data must be text.');
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('Invalid timestamp.');
  const base = Array.isArray(log) ? log : [];
  const ids = new Set(base.map((e) => e.id));
  let index = base.length;
  let id = `l-${Math.floor(ms).toString(36)}-${index}`;
  while (ids.has(id)) id = `l-${Math.floor(ms).toString(36)}-${++index}`;
  const entry: LogEntry = { id, taskId, at: new Date(ms).toISOString(), level, message };
  if (typeof input.data === 'string' && input.data.trim()) entry.data = truncateData(input.data);
  return applyCaps([...base, entry]);
}

export type RedactionResult = { text: string; count: number };

const KEY_VALUE_RE = /([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_.-]*)(["']?\s*[=:]\s*)(["']?)([^\s"'&,;]+)/gi;
const BEARER_RE = /\b(Bearer)\s+([A-Za-z0-9._~+/-]+=*)/gi;
const SK_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;
const LONG_RUN_RE = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/** Masks values that look like API keys or tokens with '[redacted]' and reports how many were masked. */
export function redactSecrets(text: string): RedactionResult {
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', count: 0 };
  let count = 0;
  let out = text.replace(BEARER_RE, (m, word: string, value: string) => {
    if (value === REDACTED) return m;
    count++;
    return `${word} ${REDACTED}`;
  });
  out = out.replace(SK_RE, () => {
    count++;
    return REDACTED;
  });
  out = out.replace(KEY_VALUE_RE, (m, key: string, sep: string, quote: string, value: string) => {
    if (value === REDACTED || value.startsWith(REDACTED) || /^bearer$/i.test(value)) return m;
    count++;
    return `${key}${sep}${quote}${REDACTED}`;
  });
  out = out.replace(LONG_RUN_RE, (m) => {
    const hex = /^[0-9a-f]+$/i.test(m);
    const mixed = /\d/.test(m) && /[A-Za-z]/.test(m);
    if (!hex && !mixed) return m;
    count++;
    return REDACTED;
  });
  return { text: out, count };
}

export type LogFilter = { taskId?: string; level?: LogLevel | ''; query?: string };

/** Filters by task, level and a case-insensitive substring (message, data, task id). Newest first, ties by later position first. */
export function filterLog(log: readonly LogEntry[], filter: LogFilter = {}): LogEntry[] {
  const taskId = filter.taskId?.trim() ?? '';
  const level = filter.level ?? '';
  const q = filter.query?.trim().toLowerCase() ?? '';
  return log
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => (!taskId || e.taskId === taskId) && (!level || e.level === level) && (!q || `${e.message}\n${e.data ?? ''}\n${e.taskId}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.e.at === b.e.at ? b.i - a.i : a.e.at < b.e.at ? 1 : -1))
    .map(({ e }) => e);
}

export type TaskLogSummary = { taskId: string; total: number; counts: Record<LogLevel, number>; lastResult: LogEntry | null };

/** Counts entries per level for one task and returns the newest recorded 'result' entry, or null if none was recorded. */
export function summarizeTask(log: readonly LogEntry[], taskId: string): TaskLogSummary {
  const counts = Object.fromEntries(LOG_LEVELS.map((l) => [l, 0])) as Record<LogLevel, number>;
  let total = 0;
  for (const e of log) {
    if (e.taskId !== taskId) continue;
    total++;
    if (isLogLevel(e.level)) counts[e.level]++;
  }
  const lastResult = filterLog(log, { taskId, level: 'result' })[0] ?? null;
  return { taskId, total, counts, lastResult };
}

/** Returns redacted JSON text: { format, version: 1, entries } in recorded order. */
export function exportLog(log: readonly LogEntry[], opts: { taskId?: string } = {}): string {
  const entries = log
    .filter((e) => !opts.taskId || e.taskId === opts.taskId)
    .map((e) => {
      const out: LogEntry = { id: e.id, taskId: e.taskId, at: e.at, level: e.level, message: redactSecrets(e.message).text };
      if (typeof e.data === 'string') out.data = redactSecrets(e.data).text;
      return out;
    });
  return JSON.stringify({ format: AGENT_LOG_FORMAT, version: AGENT_LOG_VERSION, entries }, null, 2);
}

function cleanEntry(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim() || r.id.length > 80) return null;
  if (typeof r.taskId !== 'string' || !r.taskId.trim() || r.taskId.length > AGENT_LOG_LIMITS.taskIdChars) return null;
  if (!isIsoString(r.at) || !isLogLevel(r.level)) return null;
  if (typeof r.message !== 'string' || !r.message.trim() || r.message.length > AGENT_LOG_LIMITS.messageChars) return null;
  if (r.data !== undefined && (typeof r.data !== 'string' || r.data.length > AGENT_LOG_LIMITS.dataChars)) return null;
  const e: LogEntry = { id: r.id, taskId: r.taskId, at: r.at, level: r.level, message: r.message };
  if (typeof r.data === 'string' && r.data) e.data = r.data;
  return e;
}

/** Validates persisted pref data: drops malformed and duplicate-id entries, then applies caps. */
export function normalizeLog(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const r of raw) {
    const e = cleanEntry(r);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return applyCaps(out);
}

export type ParsedLog = { entries: LogEntry[]; dropped: number };

/** Parses exported JSON. Throws with exact paths for envelope problems; drops malformed entries and reports the count. */
export function parseLog(json: string): ParsedLog {
  if (typeof json !== 'string') throw new Error('$: expected JSON text.');
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('$: invalid JSON.');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('$: expected an object.');
  const d = doc as Record<string, unknown>;
  if (d.format !== AGENT_LOG_FORMAT) throw new Error(`$.format: expected "${AGENT_LOG_FORMAT}".`);
  if (d.version !== AGENT_LOG_VERSION) throw new Error(`$.version: expected ${AGENT_LOG_VERSION}.`);
  if (!Array.isArray(d.entries)) throw new Error('$.entries: expected an array.');
  const entries = normalizeLog(d.entries);
  return { entries, dropped: d.entries.length - entries.length };
}
