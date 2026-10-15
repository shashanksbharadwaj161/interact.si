/**
 * Conversation history and export (pure, DOM-free). Deterministic Markdown, a versioned JSON envelope, a strict parser
 * with exact $-path errors, history filtering and per-conversation summaries. No network, file system or model calls.
 *
 * The backend keeps one running chat (ChatMessage list). Saved conversations are snapshots of that chat; the minimal
 * local types below mirror what the Assistant actually stores (role, text→content, createdAt→timestamp, source→provider).
 */

export const CONVERSATION_EXPORT_FORMAT = 'desktop-companion-conversations';
export const CONVERSATION_EXPORT_VERSION = 1;
export const EXPORT_LIMITS = { jsonChars: 2_000_000, conversations: 500, messagesPerConversation: 2000 } as const;
/** usePref key under which saved conversations are kept (UI preference storage on this computer only). */
export const HISTORY_PREF_KEY = 'assistant.history';

export type ConversationRole = 'user' | 'assistant' | 'system';
export type ConversationMessage = { role: ConversationRole; content: string; timestamp: string; model?: string; provider?: string };
export type Conversation = { id: string; title: string; createdAt: string; messages: ConversationMessage[]; model?: string; provider?: string; imported?: boolean };
export type ConversationExport = { format: typeof CONVERSATION_EXPORT_FORMAT; version: 1; exportedAt: string; conversations: Conversation[] };
export type ParseResult = { ok: boolean; conversations: Conversation[]; errors: string[]; warnings: string[]; droppedDuplicates: number; droppedOverCap: number };
export type ConversationSummary = { messages: number; userTurns: number; assistantTurns: number; firstAt: string | null; lastAt: string | null; chars: number };

const ROLES: readonly ConversationRole[] = ['user', 'assistant', 'system'];
const ENVELOPE_KEYS = ['format', 'version', 'exportedAt', 'conversations'];
const CONVERSATION_KEYS = ['id', 'title', 'createdAt', 'messages', 'model', 'provider', 'imported'];
const MESSAGE_KEYS = ['role', 'content', 'timestamp', 'model', 'provider'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const isIsoTimestamp = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Markdown                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

const ROLE_LABEL: Record<ConversationRole, string> = { user: '**User:**', assistant: '**Assistant:**', system: '**System:**' };

/** Deterministic Markdown. Message text and timestamps are verbatim; model/provider lines appear only when the values exist. */
export function conversationToMarkdown(conversation: Conversation, opts: { includeMeta?: boolean } = {}): string {
  const includeMeta = opts.includeMeta !== false;
  const title = conversation.title.replace(/[\r\n]+/g, ' ').trim() || 'Untitled conversation';
  const out: string[] = [`# ${title}`, ''];
  if (includeMeta) {
    out.push(`Created: ${conversation.createdAt}`);
    if (nonEmpty(conversation.model)) out.push(`Model: ${conversation.model}`);
    if (nonEmpty(conversation.provider)) out.push(`Provider: ${conversation.provider}`);
    if (conversation.imported === true) out.push('Imported: yes');
    out.push(`Messages: ${conversation.messages.length}`, '');
  }
  for (const m of conversation.messages) {
    out.push(`${ROLE_LABEL[m.role] ?? `**${m.role}:**`} ${m.timestamp}`);
    if (includeMeta) {
      const meta = [nonEmpty(m.model) ? `model: ${m.model}` : '', nonEmpty(m.provider) ? `provider: ${m.provider}` : ''].filter(Boolean);
      if (meta.length) out.push(`_${meta.join(' · ')}_`);
    }
    out.push('', m.content, '');
  }
  return out.join('\n').replace(/\n+$/, '') + '\n';
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Envelope                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

function cleanMessage(m: ConversationMessage): ConversationMessage {
  const out: ConversationMessage = { role: m.role, content: m.content, timestamp: m.timestamp };
  if (typeof m.model === 'string') out.model = m.model;
  if (typeof m.provider === 'string') out.provider = m.provider;
  return out;
}
function cleanConversation(c: Conversation): Conversation {
  const out: Conversation = { id: c.id, title: c.title, createdAt: c.createdAt, messages: c.messages.map(cleanMessage) };
  if (typeof c.model === 'string') out.model = c.model;
  if (typeof c.provider === 'string') out.provider = c.provider;
  if (c.imported === true) out.imported = true;
  return out;
}

/** The JSON export envelope. Only known keys are kept; everything else is dropped. */
export function exportConversations(conversations: Conversation[], now: Date | string): ConversationExport {
  const exportedAt = typeof now === 'string' ? now : now.toISOString();
  return { format: CONVERSATION_EXPORT_FORMAT, version: 1, exportedAt, conversations: conversations.map(cleanConversation) };
}

/** desktop-companion-conversations-YYYY-MM-DD.json (UTC date of `now`). */
export function exportFileName(now: Date): string {
  return `${CONVERSATION_EXPORT_FORMAT}-${now.toISOString().slice(0, 10)}.json`;
}
/** A safe .md file name for one conversation. */
export function markdownFileName(c: Pick<Conversation, 'title' | 'createdAt'>): string {
  const slug = c.title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'conversation';
  const day = isIsoTimestamp(c.createdAt) ? c.createdAt.slice(0, 10) : 'undated';
  return `${slug}-${day}.md`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Parser                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

function unknownKeys(o: Record<string, unknown>, known: string[], at: string, warnings: string[]) {
  for (const k of Object.keys(o)) if (!known.includes(k)) warnings.push(`${at}.${k}: unknown key ignored`);
}

function checkOptionalString(o: Record<string, unknown>, key: string, at: string, errors: string[]) {
  if (o[key] !== undefined && typeof o[key] !== 'string') errors.push(`${at}.${key}: expected string`);
}

/** Validates one conversation value. Pushes $-path errors/warnings; returns the cleaned conversation when it has no errors. */
export function validateConversation(v: unknown, at: string, errors: string[], warnings: string[]): Conversation | null {
  const before = errors.length;
  if (!isObj(v)) { errors.push(`${at}: expected object`); return null; }
  unknownKeys(v, CONVERSATION_KEYS, at, warnings);
  if (!nonEmpty(v.id)) errors.push(`${at}.id: expected non-empty string`);
  if (typeof v.title !== 'string') errors.push(`${at}.title: expected string`);
  if (!isIsoTimestamp(v.createdAt)) errors.push(`${at}.createdAt: expected ISO 8601 timestamp`);
  checkOptionalString(v, 'model', at, errors);
  checkOptionalString(v, 'provider', at, errors);
  if (v.imported !== undefined && typeof v.imported !== 'boolean') errors.push(`${at}.imported: expected boolean`);
  const messages: ConversationMessage[] = [];
  if (!Array.isArray(v.messages)) errors.push(`${at}.messages: expected array`);
  else if (v.messages.length > EXPORT_LIMITS.messagesPerConversation) errors.push(`${at}.messages: ${v.messages.length} messages; limit is ${EXPORT_LIMITS.messagesPerConversation}`);
  else {
    v.messages.forEach((m, i) => {
      const mat = `${at}.messages[${i}]`;
      if (!isObj(m)) { errors.push(`${mat}: expected object`); return; }
      unknownKeys(m, MESSAGE_KEYS, mat, warnings);
      if (typeof m.role !== 'string' || !ROLES.includes(m.role as ConversationRole)) errors.push(`${mat}.role: expected "user", "assistant" or "system"`);
      if (typeof m.content !== 'string') errors.push(`${mat}.content: expected string`);
      if (!isIsoTimestamp(m.timestamp)) errors.push(`${mat}.timestamp: expected ISO 8601 timestamp`);
      checkOptionalString(m, 'model', mat, errors);
      checkOptionalString(m, 'provider', mat, errors);
      messages.push(m as unknown as ConversationMessage);
    });
  }
  if (errors.length !== before) return null;
  return cleanConversation({ ...(v as unknown as Conversation), messages });
}

/**
 * Parses an export. Never throws. Any error makes ok:false and returns no conversations, so a partial import never happens.
 * Duplicate ids keep the first and are counted; conversations beyond the cap are dropped and counted.
 */
export function parseConversationExport(json: unknown): ParseResult {
  const res: ParseResult = { ok: false, conversations: [], errors: [], warnings: [], droppedDuplicates: 0, droppedOverCap: 0 };
  if (typeof json !== 'string') { res.errors.push('$: expected JSON text'); return res; }
  if (json.length > EXPORT_LIMITS.jsonChars) { res.errors.push(`$: ${json.length} characters; limit is ${EXPORT_LIMITS.jsonChars}`); return res; }
  if (!json.trim()) { res.errors.push('$: empty input'); return res; }
  let data: unknown;
  try { data = JSON.parse(json); } catch (e) { res.errors.push(`$: invalid JSON (${e instanceof Error ? e.message : 'parse error'})`); return res; }
  if (!isObj(data)) { res.errors.push('$: expected object'); return res; }
  unknownKeys(data, ENVELOPE_KEYS, '$', res.warnings);
  if (data.format !== CONVERSATION_EXPORT_FORMAT) res.errors.push(`$.format: expected "${CONVERSATION_EXPORT_FORMAT}"`);
  if (data.version !== CONVERSATION_EXPORT_VERSION) res.errors.push(`$.version: expected ${CONVERSATION_EXPORT_VERSION}`);
  if (!isIsoTimestamp(data.exportedAt)) res.errors.push('$.exportedAt: expected ISO 8601 timestamp');
  if (!Array.isArray(data.conversations)) { res.errors.push('$.conversations: expected array'); return res; }
  let list = data.conversations;
  if (list.length > EXPORT_LIMITS.conversations) {
    res.droppedOverCap = list.length - EXPORT_LIMITS.conversations;
    res.warnings.push(`$.conversations: ${list.length} conversations; only the first ${EXPORT_LIMITS.conversations} are kept, ${res.droppedOverCap} dropped`);
    list = list.slice(0, EXPORT_LIMITS.conversations);
  }
  const seen = new Set<string>();
  const out: Conversation[] = [];
  list.forEach((c, i) => {
    const at = `$.conversations[${i}]`;
    const conv = validateConversation(c, at, res.errors, res.warnings);
    if (!conv) return;
    if (seen.has(conv.id)) { res.droppedDuplicates++; res.warnings.push(`${at}.id: duplicate id "${conv.id}" dropped`); return; }
    seen.add(conv.id);
    out.push(conv);
  });
  if (res.errors.length === 0) { res.ok = true; res.conversations = out; }
  return res;
}

/** Saved history read back from preference storage: invalid or duplicate entries are skipped, never thrown. */
export function normalizeHistory(stored: unknown): Conversation[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: Conversation[] = [];
  for (const v of stored.slice(0, EXPORT_LIMITS.conversations)) {
    const c = validateConversation(v, '$', [], []);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

/** Adds imported conversations (labelled imported) after the existing ones. Existing ids win; the total stays within the cap. */
export function mergeImported(existing: Conversation[], incoming: Conversation[]): { merged: Conversation[]; added: number; skippedExisting: number; skippedOverCap: number } {
  const ids = new Set(existing.map((c) => c.id));
  const merged = [...existing];
  let added = 0, skippedExisting = 0, skippedOverCap = 0;
  for (const c of incoming) {
    if (ids.has(c.id)) { skippedExisting++; continue; }
    if (merged.length >= EXPORT_LIMITS.conversations) { skippedOverCap++; continue; }
    ids.add(c.id);
    merged.push({ ...cleanConversation(c), imported: true });
    added++;
  }
  return { merged, added, skippedExisting, skippedOverCap };
}

/** Snapshot of the backend's running chat as one conversation. Model names are not stored per message, so none is invented. */
export function chatToConversation(chat: { role: 'user' | 'assistant'; text: string; createdAt: string; source?: string }[], now: Date, id: string): Conversation {
  const firstUser = chat.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim() ?? '';
  const title = firstUser ? (firstUser.length > 80 ? `${firstUser.slice(0, 79)}…` : firstUser) : 'Untitled conversation';
  return {
    id,
    title,
    createdAt: chat[0]?.createdAt && isIsoTimestamp(chat[0].createdAt) ? chat[0].createdAt : now.toISOString(),
    messages: chat.map((m) => ({ role: m.role, content: m.text, timestamp: m.createdAt, ...(m.source ? { provider: m.source } : {}) })),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Filter and summary                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function parseBound(v: string | undefined, name: 'from' | 'to'): number | null {
  if (v === undefined || v.trim() === '') return null;
  const t = v.trim();
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(t) || ISO_RE.test(t);
  const ms = ok ? Date.parse(t) : NaN;
  if (Number.isNaN(ms)) throw new Error(`Invalid "${name}" date "${v}": use YYYY-MM-DD or an ISO 8601 timestamp.`);
  return ms;
}

/**
 * Case-insensitive, accent-folded match on title and message content, within the half-open range from <= createdAt < to.
 * Date-only bounds are UTC midnight. Newest first (ties by id). Throws a descriptive Error for unparseable or reversed dates.
 */
export function filterConversations(conversations: Conversation[], opts: { query?: string; from?: string; to?: string } = {}): Conversation[] {
  const since = parseBound(opts.from, 'from');
  const until = parseBound(opts.to, 'to');
  if (since !== null && until !== null && since > until) throw new Error(`The "from" date (${opts.from}) is after the "to" date (${opts.to}).`);
  const q = fold((opts.query ?? '').trim());
  return conversations
    .filter((c) => {
      const at = Date.parse(c.createdAt);
      if (since !== null && !(at >= since)) return false;
      if (until !== null && !(at < until)) return false;
      if (!q) return true;
      return fold(c.title).includes(q) || c.messages.some((m) => fold(m.content).includes(q));
    })
    .sort((a, b) => (Date.parse(b.createdAt) - Date.parse(a.createdAt)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function summarizeConversation(c: Conversation): ConversationSummary {
  let userTurns = 0, assistantTurns = 0, chars = 0, first: string | null = null, last: string | null = null;
  for (const m of c.messages) {
    if (m.role === 'user') userTurns++;
    else if (m.role === 'assistant') assistantTurns++;
    chars += m.content.length;
    const t = Date.parse(m.timestamp);
    if (Number.isNaN(t)) continue;
    if (first === null || t < Date.parse(first)) first = m.timestamp;
    if (last === null || t >= Date.parse(last)) last = m.timestamp;
  }
  return { messages: c.messages.length, userTurns, assistantTurns, firstAt: first, lastAt: last, chars };
}
