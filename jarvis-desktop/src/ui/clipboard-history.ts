// Pure, DOM-free helpers for the clipboard history panel: search, day grouping, keyboard navigation targets and a
// summary. Nothing here reads or writes the system clipboard, touches the network or calls native code.

export interface HistoryEntryLike {
  id: string;
  preview: string;
  capturedAt: number;
  copies: number;
}

export interface HistoryGroup<T extends HistoryEntryLike = HistoryEntryLike> {
  /** Stable key: 'today', 'yesterday', an ISO date (YYYY-MM-DD, UTC) or 'unknown'. */
  key: string;
  /** Visible heading: 'Today', 'Yesterday', the ISO date, or 'Unknown time'. */
  label: string;
  entries: T[];
}

export interface HistorySummary {
  count: number;
  /** Epoch ms of the oldest valid capture, or null when no entry has a valid timestamp. */
  oldestAt: number | null;
  /** Epoch ms of the newest valid capture, or null when no entry has a valid timestamp. */
  newestAt: number | null;
  totalCopies: number;
}

export const HISTORY_LIMITS = Object.freeze({
  /** Longer queries are cut to this many characters before matching. */
  maxQueryChars: 200,
  /** At most this many search words are used; the rest are ignored. */
  maxTerms: 16,
  dayMs: 86_400_000,
  unknownLabel: 'Unknown time',
});

export const HISTORY_KEYS = Object.freeze(['ArrowUp', 'ArrowDown', 'Home', 'End'] as const);

function assertEntries(entries: unknown, fn: string): asserts entries is HistoryEntryLike[] {
  if (!Array.isArray(entries)) throw new Error(`${fn}: entries must be an array of clipboard entries, got ${entries === null ? 'null' : typeof entries}`);
}

/** Lower-cases, strips accents (NFD combining marks) and collapses whitespace. */
export function foldText(text: string): string {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const validTs = (ts: unknown): ts is number => typeof ts === 'number' && Number.isFinite(ts);

/** Newest capturedAt first, then id ascending. Entries with an invalid timestamp sort last (by id). */
export function compareEntries(a: HistoryEntryLike, b: HistoryEntryLike): number {
  const av = validTs(a.capturedAt);
  const bv = validTs(b.capturedAt);
  if (av && bv && a.capturedAt !== b.capturedAt) return b.capturedAt - a.capturedAt;
  if (av !== bv) return av ? -1 : 1;
  const ai = String(a.id);
  const bi = String(b.id);
  return ai < bi ? -1 : ai > bi ? 1 : 0;
}

/**
 * Case-insensitive, accent-folded search over previews. Every whitespace-separated word must appear (AND). An empty or
 * whitespace-only query returns the entries unchanged (a copy, same order). Matches are ordered newest first, id ascending.
 */
export function filterEntries<T extends HistoryEntryLike>(entries: T[], query: string): T[] {
  assertEntries(entries, 'filterEntries');
  if (typeof query !== 'string') throw new Error(`filterEntries: query must be a string, got ${query === null ? 'null' : typeof query}`);
  const folded = foldText(query.slice(0, HISTORY_LIMITS.maxQueryChars));
  if (folded === '') return entries.slice();
  const terms = [...new Set(folded.split(' '))].slice(0, HISTORY_LIMITS.maxTerms);
  return entries
    .filter((e) => {
      if (!e || typeof e.preview !== 'string') return false;
      const hay = foldText(e.preview);
      return terms.every((t) => hay.includes(t));
    })
    .sort(compareEntries);
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Groups entries by UTC calendar day, newest group first. Labels are 'Today', 'Yesterday' or the exact ISO date; entries
 * with a missing or invalid capturedAt go to a final 'Unknown time' group. Entries inside a group are newest first.
 */
export function groupByDay<T extends HistoryEntryLike>(entries: T[], now: number = Date.now()): HistoryGroup<T>[] {
  assertEntries(entries, 'groupByDay');
  if (!validTs(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('groupByDay: now must be a finite epoch-millisecond number');
  const today = isoDay(now);
  const yesterday = isoDay(now - HISTORY_LIMITS.dayMs);
  const groups: HistoryGroup<T>[] = [];
  const byKey = new Map<string, HistoryGroup<T>>();
  let unknown: HistoryGroup<T> | null = null;
  for (const e of [...entries].sort(compareEntries)) {
    if (!validTs(e?.capturedAt) || !Number.isFinite(new Date(e.capturedAt).getTime())) {
      unknown ??= { key: 'unknown', label: HISTORY_LIMITS.unknownLabel, entries: [] };
      unknown.entries.push(e);
      continue;
    }
    const day = isoDay(e.capturedAt);
    const key = day === today ? 'today' : day === yesterday ? 'yesterday' : day;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: key === 'today' ? 'Today' : key === 'yesterday' ? 'Yesterday' : day, entries: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.entries.push(e);
  }
  if (unknown) groups.push(unknown);
  return groups;
}

/**
 * Next focused row index for a list key press. ArrowUp/ArrowDown move by one without wrapping, Home/End jump to the
 * ends. Returns null for keys that are not handled or when the list is empty.
 */
export function historyKeyboardTarget(key: string, index: number, count: number): number | null {
  if (!Number.isInteger(count) || count < 0) throw new Error(`historyKeyboardTarget: count must be a non-negative integer, got ${String(count)}`);
  if (!Number.isInteger(index)) throw new Error(`historyKeyboardTarget: index must be an integer, got ${String(index)}`);
  if (typeof key !== 'string' || count === 0) return null;
  const at = Math.min(count - 1, Math.max(0, index));
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, at + 1);
    case 'ArrowUp':
      return Math.max(0, at - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Index to focus after the row at `removedIndex` disappears from a list that now has `remaining` rows; null when empty. */
export function focusAfterRemoval(removedIndex: number, remaining: number): number | null {
  if (!Number.isInteger(remaining) || remaining <= 0) return null;
  const i = Number.isInteger(removedIndex) ? removedIndex : 0;
  return Math.min(remaining - 1, Math.max(0, i));
}

/** Count, oldest/newest valid capture time and the total number of copies. */
export function summarizeEntries(entries: HistoryEntryLike[]): HistorySummary {
  assertEntries(entries, 'summarizeEntries');
  let oldestAt: number | null = null;
  let newestAt: number | null = null;
  let totalCopies = 0;
  for (const e of entries) {
    if (validTs(e?.capturedAt)) {
      oldestAt = oldestAt === null ? e.capturedAt : Math.min(oldestAt, e.capturedAt);
      newestAt = newestAt === null ? e.capturedAt : Math.max(newestAt, e.capturedAt);
    }
    if (typeof e?.copies === 'number' && Number.isFinite(e.copies) && e.copies > 0) totalCopies += e.copies;
  }
  return { count: entries.length, oldestAt, newestAt, totalCopies };
}
