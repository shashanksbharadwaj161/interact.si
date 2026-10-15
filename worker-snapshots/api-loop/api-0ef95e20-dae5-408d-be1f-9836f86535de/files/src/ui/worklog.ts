// Deterministic, evidence-backed worklog / standup drafting. Pure: no model, no network, no clock reads (pass `now`).
// Every bullet is assembled from a stored record and ends with a reference to it, e.g. "(checkpoint abc123 · 14:05)".
// Nothing is invented: an empty range yields one explicit "No recorded activity …" line.
import type { Note, Task } from '../shared/contracts';
// Type-only: erased at build time, same as src/ui/store.tsx, so no Node-side module reaches the renderer bundle.
import type { ProductivityState } from '../../electron/services/store';

export type WorklogKind = 'checkpoint' | 'task' | 'focus' | 'note';
export type WorklogFormat = 'worklog' | 'standup';
export type WorklogItem = { at: number; kind: WorklogKind; id: string; text: string };
export type WorklogCheckpoint = ProductivityState['checkpoints'][number];
export type WorklogFocus = ProductivityState['focus'][number];
/** `blocked` is not part of the stored Task schema today; it is honoured only if a record happens to carry it. */
export type WorklogTask = Task & { blocked?: boolean };
export type WorklogInput = {
  checkpoints: readonly WorklogCheckpoint[];
  tasks: readonly WorklogTask[];
  focusSessions: readonly WorklogFocus[];
  notes: readonly Note[];
  since: number;
  until: number;
  format: WorklogFormat;
  /** Reference time for the header; never read from the system clock here. */
  now?: number;
};
export type WorklogDraft = { markdown: string; items: WorklogItem[]; counts: Record<string, number> };

export const WORKLOG_LIMITS = { textChars: 160, items: 2000 } as const;
const KIND_ORDER: Record<WorklogKind, number> = { checkpoint: 0, task: 1, focus: 2, note: 3 };
const BLOCKER_TAGS = new Set(['blocker', 'blocked']);

const pad = (n: number) => String(n).padStart(2, '0');
/** Local wall-clock time "HH:MM". Stable across runtimes (no Intl/locale dependence). */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** Local calendar day "YYYY-MM-DD". */
export function fmtDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Local "YYYY-MM-DD HH:MM". */
export function fmtStamp(ms: number): string {
  return `${fmtDay(ms)} ${fmtClock(ms)}`;
}

/** Start of the local day containing ms. */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export type RangePreset = 'today' | 'yesterday' | 'last7';
export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
];
/** Inclusive [since, until] for a preset, relative to `now` (local days). */
export function rangeForPreset(preset: RangePreset, now: number): { since: number; until: number } {
  const today = startOfLocalDay(now);
  if (preset === 'yesterday') {
    const d = new Date(today);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
    return { since: start, until: today - 1 };
  }
  if (preset === 'last7') {
    const d = new Date(today);
    return { since: new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime(), until: now };
  }
  return { since: today, until: now };
}

/** One printable line: control characters removed, whitespace collapsed, length bounded. */
function clean(v: unknown, max: number = WORKLOG_LIMITS.textChars): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}
function firstLine(v: unknown): string {
  return typeof v === 'string' ? clean(v.split(/\r?\n/).find((l) => l.trim()) ?? '') : '';
}
function parseAt(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
function minutes(sec: unknown): string {
  const n = typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? Math.round(sec / 60) : 0;
  return n < 1 ? 'under 1 min' : `${n} min`;
}

export function evidenceRef(item: Pick<WorklogItem, 'kind' | 'id' | 'at'>): string {
  return `(${item.kind} ${item.id} · ${fmtClock(item.at)})`;
}
const bullet = (item: WorklogItem) => `- ${item.text} ${evidenceRef(item)}`;
const NONE = '- None recorded';

type Classified = WorklogItem & { section: 'done' | 'open' | 'blocker' };

function collect(input: WorklogInput, since: number, until: number): Classified[] {
  const out: Classified[] = [];
  const inRange = (t: number | null): t is number => t !== null && t >= since && t <= until;
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128;

  // Checkpoints: the newest checkpoint per project in range is the "active" one (where work stands now).
  const cps = (input.checkpoints ?? []).map((c) => ({ c, at: parseAt(c?.createdAt) })).filter((x) => validId(x.c?.id) && inRange(x.at));
  const newest = new Map<string, { id: string; at: number }>();
  for (const { c, at } of cps) {
    const key = c.capsuleId ?? '';
    const prev = newest.get(key);
    if (!prev || at! > prev.at || (at === prev.at && c.id > prev.id)) newest.set(key, { id: c.id, at: at! });
  }
  for (const { c, at } of cps) {
    const title = clean(c.title) || 'Untitled checkpoint';
    const note = firstLine(c.note);
    const active = newest.get(c.capsuleId ?? '')?.id === c.id;
    out.push({ at: at!, kind: 'checkpoint', id: c.id, text: `Checkpoint: ${title}${note ? ` — ${note}` : ''}`, section: active ? 'open' : 'done' });
  }

  for (const t of input.tasks ?? []) {
    const at = parseAt(t?.createdAt);
    if (!validId(t?.id) || !inRange(at)) continue;
    const title = clean(t.title) || 'Untitled task';
    const due = clean(t.due, 40);
    if (t.done === true) out.push({ at, kind: 'task', id: t.id, text: `Done: ${title}`, section: 'done' });
    else if (t.blocked === true) out.push({ at, kind: 'task', id: t.id, text: `Blocked: ${title}${due ? ` (due ${due})` : ''}`, section: 'blocker' });
    else out.push({ at, kind: 'task', id: t.id, text: `Open: ${title}${due ? ` (due ${due})` : ''}`, section: 'open' });
  }

  for (const f of input.focusSessions ?? []) {
    const at = parseAt(f?.startedAt);
    if (!validId(f?.id) || !inRange(at)) continue;
    const on = clean(f.taskTitle);
    const outcome = f.outcome === 'completed' ? 'completed' : 'stopped early';
    out.push({ at, kind: 'focus', id: f.id, text: `Focus session: ${minutes(f.actualSec)}${on ? ` on ${on}` : ''} (${outcome})`, section: 'done' });
  }

  for (const n of input.notes ?? []) {
    const at = parseAt(n?.updatedAt);
    if (!validId(n?.id) || !inRange(at)) continue;
    const title = clean(n.title) || firstLine(n.body) || 'Untitled note';
    const blocker = Array.isArray(n.tags) && n.tags.some((tag) => typeof tag === 'string' && BLOCKER_TAGS.has(tag.trim().toLowerCase()));
    out.push({ at, kind: 'note', id: n.id, text: `${blocker ? 'Blocker note' : 'Note'}: ${title}`, section: blocker ? 'blocker' : 'done' });
  }

  out.sort((a, b) => a.at - b.at || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out.slice(0, WORKLOG_LIMITS.items);
}

/**
 * Drafts a worklog (date-grouped bullets) or a standup (Yesterday / Today / Blockers) from local records in the
 * inclusive range [since, until]. Deterministic for equal input.
 */
export function draftWorklog(input: WorklogInput): WorklogDraft {
  const { since, until } = input;
  const counts: Record<string, number> = { checkpoint: 0, task: 0, focus: 0, note: 0, total: 0 };
  if (!Number.isFinite(since) || !Number.isFinite(until) || since > until) {
    return { markdown: 'No recorded activity: the selected date range is not valid.', items: [], counts };
  }
  const classified = collect(input, since, until);
  const items: WorklogItem[] = classified.map(({ at, kind, id, text }) => ({ at, kind, id, text }));
  for (const i of items) counts[i.kind]++;
  counts.total = items.length;
  const range = `${fmtStamp(since)} and ${fmtStamp(until)}`;
  if (!items.length) return { markdown: `No recorded activity between ${range}.`, items, counts };

  const generated = typeof input.now === 'number' && Number.isFinite(input.now) ? ` · drafted ${fmtStamp(input.now)}` : '';
  const lines: string[] = [];
  if (input.format === 'standup') {
    const done = classified.filter((i) => i.section === 'done');
    const open = classified.filter((i) => i.section === 'open');
    const blockers = classified.filter((i) => i.section === 'blocker');
    counts.yesterday = done.length;
    counts.today = open.length;
    counts.blockers = blockers.length;
    lines.push(`# Standup (${fmtStamp(since)} – ${fmtStamp(until)}${generated})`, '');
    lines.push('## Yesterday', ...(done.length ? done.map(bullet) : [NONE]), '');
    lines.push('## Today', ...(open.length ? open.map(bullet) : [NONE]), '');
    lines.push('## Blockers', ...(blockers.length ? blockers.map(bullet) : [NONE]));
  } else {
    lines.push(`# Worklog (${fmtStamp(since)} – ${fmtStamp(until)}${generated})`);
    let day = '';
    for (const item of items) {
      const d = fmtDay(item.at);
      if (d !== day) { day = d; lines.push('', `## ${d}`); }
      lines.push(bullet(item));
    }
  }
  return { markdown: lines.join('\n'), items, counts };
}

/** Human summary of counts, e.g. "5 items: 2 checkpoints, 1 task, 2 notes". */
export function summarizeCounts(counts: Record<string, number>): string {
  const total = counts.total ?? 0;
  if (!total) return 'No items in this range.';
  const parts = (['checkpoint', 'task', 'focus', 'note'] as const)
    .filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${counts[k]} ${k === 'focus' ? (counts[k] === 1 ? 'focus session' : 'focus sessions') : counts[k] === 1 ? k : `${k}s`}`);
  return `${total} ${total === 1 ? 'item' : 'items'}: ${parts.join(', ')}`;
}

/**
 * Copies text through an injected writer (a bridge method when one exists), otherwise the guarded browser clipboard.
 * Never touches the network. Resolves with how it copied, or 'unavailable' when nothing could.
 */
export async function copyText(text: string, opts: { write?: ((t: string) => Promise<unknown>) | null; nav?: { clipboard?: { writeText?: (t: string) => Promise<void> } } | null } = {}): Promise<'bridge' | 'browser' | 'unavailable'> {
  if (typeof opts.write === 'function') {
    try { await opts.write(text); return 'bridge'; } catch { /* fall back */ }
  }
  const nav = opts.nav === undefined ? (typeof navigator !== 'undefined' ? navigator : null) : opts.nav;
  const writeText = nav?.clipboard?.writeText;
  if (typeof writeText === 'function') {
    try { await writeText.call(nav!.clipboard, text); return 'browser'; } catch { /* blocked */ }
  }
  return 'unavailable';
}
