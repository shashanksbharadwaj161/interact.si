// Worklog and standup drafts (feature 35). Pure TypeScript: no React, no DOM, no I/O, no model. Every drafted line is
// assembled from local records that fall inside the chosen range and cites at least one real record id; records that
// cannot be placed are skipped and counted in `coverage` instead of being guessed at.

export type WorklogFormat = 'standup' | 'worklog' | 'markdown-table';
export type WorklogHeading = 'Done' | 'In progress' | 'Blocked' | 'Next' | 'Focus time';
export type WorklogEvidenceKind = 'task' | 'note' | 'checkpoint' | 'focus' | 'session';
export type WorklogEvidence = { kind: WorklogEvidenceKind; id: string; label: string; at: string };
export type WorklogItem = { text: string; evidence: WorklogEvidence[] };
export type WorklogSection = { heading: WorklogHeading; items: WorklogItem[] };
/** from is inclusive, to is exclusive. Both are ISO instants. */
export type WorklogRange = { from: string; to: string };
export type WorklogCoverage = { counted: number; skipped: number; reasons: string[] };

/** Structural input shapes: the app's Task, Note, Checkpoint, FocusSession and TimelineEntry records all fit. */
export type WorklogTask = { id: string; title: string; done: boolean; due?: string; createdAt?: string; updatedAt?: string; completedAt?: string; blocked?: boolean; tags?: readonly string[] };
export type WorklogNote = { id: string; title: string; body?: string; tags?: readonly string[]; updatedAt: string };
export type WorklogCheckpoint = { id: string; title: string; note?: string; createdAt: string; capsuleId?: string };
export type WorklogFocus = { id: string; startedAt: string; endedAt?: string; actualSec?: number; plannedSec?: number; outcome?: string; taskId?: string; taskTitle?: string };
export type WorklogSession = { id: string; at: string; endedAt?: string; app: string; title?: string };

export type WorklogInput = {
  tasks?: readonly WorklogTask[];
  notes?: readonly WorklogNote[];
  checkpoints?: readonly WorklogCheckpoint[];
  focusSessions?: readonly WorklogFocus[];
  sessionTimeline?: readonly WorklogSession[];
  range: WorklogRange;
  format: WorklogFormat;
  /** Reference time for "due within the next 2 days". Defaults to the end of the range. */
  now?: string | Date;
};

export type WorklogDraft = {
  title: string;
  format: WorklogFormat;
  range: WorklogRange;
  sections: WorklogSection[];
  text: string;
  coverage: WorklogCoverage;
  /** True when no record in the range could be cited. */
  empty: boolean;
};

export const WORKLOG_HEADINGS: readonly WorklogHeading[] = ['Done', 'In progress', 'Blocked', 'Next', 'Focus time'];
export const WORKLOG_FORMATS: readonly { id: WorklogFormat; label: string }[] = [
  { id: 'standup', label: 'Standup (plain text)' },
  { id: 'worklog', label: 'Worklog (Markdown with record ids)' },
  { id: 'markdown-table', label: 'Markdown table' },
];
/** Tag put on drafts saved as notes. Notes carrying it are never cited again, so a draft cannot cite itself. */
export const WORKLOG_NOTE_TAG = 'worklog';
export const NEXT_WINDOW_MS = 2 * 86_400_000;
export const WORKLOG_TEXT_LIMIT = 20_000;

/* ---------- Range presets ---------- */

export type WorklogPresetId = 'yesterday' | 'today' | 'this-week' | 'last-7-days';
export const WORKLOG_PRESETS: readonly { id: WorklogPresetId; label: string }[] = [
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'today', label: 'Today' },
  { id: 'this-week', label: 'This week' },
  { id: 'last-7-days', label: 'Last 7 days' },
];

const localMidnight = (d: Date, addDays = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + addDays);

/**
 * Whole local days, from local midnight (inclusive) to local midnight (exclusive):
 * Yesterday; Today; This week (Monday through today); Last 7 days (six days ago through today).
 */
export function worklogPresetRange(id: WorklogPresetId, now: Date): WorklogRange {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('A valid current date is required');
  const tomorrow = localMidnight(now, 1);
  let from: Date;
  let to = tomorrow;
  switch (id) {
    case 'yesterday': from = localMidnight(now, -1); to = localMidnight(now); break;
    case 'today': from = localMidnight(now); break;
    case 'this-week': from = localMidnight(now, -((now.getDay() + 6) % 7)); break;
    case 'last-7-days': from = localMidnight(now, -6); break;
    default: throw new Error(`Unknown range preset: ${String(id)}`);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export function worklogPresets(now: Date): { id: WorklogPresetId; label: string; range: WorklogRange }[] {
  return WORKLOG_PRESETS.map((p) => ({ ...p, range: worklogPresetRange(p.id, now) }));
}

/* ---------- Helpers ---------- */

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const time = (v: unknown): number => (typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN);
// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max = 160): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() : '').slice(0, max);
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const minutes = (sec: number) => Math.round(sec / 60);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Due values are free text: "2026-10-20" means the end of that local day; anything else must parse as a date. */
export function parseDue(due: unknown): number {
  if (typeof due !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime();
  return time(due.trim());
}

export function isBlockedTask(t: WorklogTask): boolean {
  if (t.blocked === true) return true;
  if (Array.isArray(t.tags) && t.tags.some((x) => typeof x === 'string' && x.trim().toLowerCase() === 'blocked')) return true;
  return typeof t.title === 'string' && /(^|\s)#blocked\b|\[blocked\]/i.test(t.title);
}

/** "2026-10-13" for a one-day range, otherwise "2026-10-13 to 2026-10-19" (the exclusive end shown as the last day). */
export function rangeLabel(range: WorklogRange): string {
  const from = time(range.from);
  const to = time(range.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return 'invalid range';
  const last = dayKey(Math.max(from, to - 1));
  const first = dayKey(from);
  return first === last ? first : `${first} to ${last}`;
}

class Coverage {
  private cited = new Set<string>();
  private skippedIds = new Set<string>();
  private skippedCount = 0;
  private reasons = new Map<string, { kind: string; reason: string; n: number }>();
  cite(kind: WorklogEvidenceKind, id: string) { this.cited.add(`${kind}:${id}`); }
  skip(kind: WorklogEvidenceKind, id: string | null, reason: string) {
    if (id !== null) {
      const k = `${kind}:${id}`;
      if (this.skippedIds.has(k)) return;
      this.skippedIds.add(k);
    }
    this.skippedCount++;
    const key = `${kind}\u0000${reason}`;
    const r = this.reasons.get(key) ?? { kind, reason, n: 0 };
    r.n++;
    this.reasons.set(key, r);
  }
  result(): WorklogCoverage {
    return {
      counted: this.cited.size,
      skipped: this.skippedCount,
      reasons: [...this.reasons.values()].map((r) => `${plural(r.n, `${r.kind} record`)} skipped: ${r.reason}`),
    };
  }
}

/* ---------- Draft ---------- */

/**
 * Builds a worklog or standup draft from local records only. Rules:
 * - every item cites at least one real record id; nothing is invented;
 * - records outside [range.from, range.to) are skipped and counted in coverage;
 * - completed tasks (completion time, else last update, else creation time inside the range) go to Done, with
 *   checkpoints recorded in the range;
 * - open tasks flagged blocked (blocked: true, a "blocked" tag, or #blocked / [blocked] in the title) go to Blocked;
 * - open tasks touched in the range (created, updated or focused on) go to In progress, with notes updated in the range;
 * - other open tasks due within the next 2 days (or already overdue) go to Next;
 * - focus sessions in the range sum to a Focus time line in minutes; app timeline sessions add a separate line.
 * Each task appears in at most one section (Done, Blocked, In progress, Next in that order of precedence).
 */
export function buildWorklogDraft(input: WorklogInput): WorklogDraft {
  const format: WorklogFormat = input?.format === 'worklog' || input?.format === 'markdown-table' ? input.format : 'standup';
  const range: WorklogRange = { from: String(input?.range?.from ?? ''), to: String(input?.range?.to ?? '') };
  const from = time(range.from);
  const to = time(range.to);
  const cov = new Coverage();
  const label = rangeLabel(range);
  const title = `${format === 'standup' ? 'Standup' : format === 'worklog' ? 'Worklog' : 'Worklog table'} · ${label}`;

  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) {
    const coverage: WorklogCoverage = { counted: 0, skipped: 0, reasons: ['The date range is invalid, so no record was read.'] };
    return { title, format, range, sections: [], text: renderEmpty(title, label, coverage), coverage, empty: true };
  }
  const nowT = input.now instanceof Date ? input.now.getTime() : input.now !== undefined ? time(input.now) : to;
  const now = Number.isNaN(nowT) ? to : nowT;
  const inRange = (t: number) => !Number.isNaN(t) && t >= from && t < to;
  const list = <T,>(v: readonly T[] | undefined): T[] => (Array.isArray(v) ? (v as T[]).filter((x) => isRec(x)) : []);

  const buckets: Record<WorklogHeading, WorklogItem[]> = { Done: [], 'In progress': [], Blocked: [], Next: [], 'Focus time': [] };
  const push = (heading: WorklogHeading, text: string, evidence: WorklogEvidence[]) => {
    if (!evidence.length) return; // invariant: no evidence, no item
    for (const e of evidence) cov.cite(e.kind, e.id);
    buckets[heading].push({ text, evidence });
  };
  const ev = (kind: WorklogEvidenceKind, id: string, lbl: string, at: number | string): WorklogEvidence => ({ kind, id, label: lbl, at: typeof at === 'number' ? new Date(at).toISOString() : at });

  // Focus sessions first: they also mark the tasks they were linked to as touched.
  const focusInRange: WorklogFocus[] = [];
  const seenFocus = new Set<string>();
  for (const f of list(input.focusSessions)) {
    if (!validId(f.id) || seenFocus.has(f.id)) { cov.skip('focus', null, 'missing or repeated id'); continue; }
    seenFocus.add(f.id);
    const t = time(f.startedAt);
    if (Number.isNaN(t)) { cov.skip('focus', f.id, 'no valid start time'); continue; }
    if (!inRange(t)) { cov.skip('focus', f.id, 'outside the selected range'); continue; }
    focusInRange.push(f);
  }
  const focusSec = (f: WorklogFocus) => {
    if (typeof f.actualSec === 'number' && Number.isFinite(f.actualSec) && f.actualSec >= 0) return f.actualSec;
    const s = time(f.startedAt), e = time(f.endedAt);
    return !Number.isNaN(s) && !Number.isNaN(e) && e > s ? (e - s) / 1000 : 0;
  };
  const focusLabel = (f: WorklogFocus) => clean(f.taskTitle, 80) || 'Focus session';
  const focusEv = (f: WorklogFocus) => ev('focus', f.id, `${focusLabel(f)} (${minutes(focusSec(f))} min)`, time(f.startedAt));

  // Tasks.
  const seenTasks = new Set<string>();
  for (const task of list(input.tasks)) {
    if (!validId(task.id) || seenTasks.has(task.id)) { cov.skip('task', null, 'missing or repeated id'); continue; }
    seenTasks.add(task.id);
    const name = clean(task.title) || 'Untitled task';
    const created = time(task.createdAt);
    const updated = time(task.updatedAt);
    const focused = focusInRange.filter((f) => f.taskId === task.id);
    const focusedSec = focused.reduce((n, f) => n + focusSec(f), 0);
    if (task.done === true) {
      const completed = time(task.completedAt);
      const when = !Number.isNaN(completed) ? completed : !Number.isNaN(updated) ? updated : created;
      if (Number.isNaN(when)) { cov.skip('task', task.id, 'completed task without a valid time'); continue; }
      if (!inRange(when)) { cov.skip('task', task.id, 'completed outside the selected range'); continue; }
      const how = !Number.isNaN(completed) ? 'completed' : !Number.isNaN(updated) ? 'last updated' : 'created; completion time not recorded';
      push('Done', `Completed: ${name}`, [ev('task', task.id, `${name} (${how})`, when), ...focused.map(focusEv)]);
      continue;
    }
    if (!Number.isNaN(created) && created >= to) { cov.skip('task', task.id, 'created after the selected range'); continue; }
    const at = !Number.isNaN(updated) ? updated : !Number.isNaN(created) ? created : NaN;
    const taskEv = (note: string) => ev('task', task.id, `${name} (${note})`, Number.isNaN(at) ? '' : at);
    if (isBlockedTask(task)) {
      push('Blocked', `Blocked: ${name}`, [taskEv('open, marked blocked'), ...focused.map(focusEv)]);
      continue;
    }
    if (focused.length || inRange(updated) || inRange(created)) {
      const text = focused.length ? `Worked on: ${name} (${minutes(focusedSec)} min focused)` : inRange(updated) ? `Updated: ${name}` : `Added: ${name}`;
      const touch = inRange(updated) ? ev('task', task.id, `${name} (updated)`, updated) : inRange(created) ? ev('task', task.id, `${name} (created)`, created) : taskEv('open');
      push('In progress', text, [touch, ...focused.map(focusEv)]);
      continue;
    }
    const due = parseDue(task.due);
    if (!Number.isNaN(due) && due <= now + NEXT_WINDOW_MS) {
      const dueText = dayKey(due);
      push('Next', due >= now ? `Due ${dueText}: ${name}` : `Overdue since ${dueText}: ${name}`, [ev('task', task.id, `${name} (due ${clean(task.due, 40)})`, due)]);
      continue;
    }
    cov.skip('task', task.id, Number.isNaN(due) ? 'open, not touched in the range and no due date' : 'open, not touched in the range and not due within 2 days');
  }

  // Checkpoints are dated records of what was done.
  const seenCp = new Set<string>();
  for (const c of list(input.checkpoints)) {
    if (!validId(c.id) || seenCp.has(c.id)) { cov.skip('checkpoint', null, 'missing or repeated id'); continue; }
    seenCp.add(c.id);
    const t = time(c.createdAt);
    if (Number.isNaN(t)) { cov.skip('checkpoint', c.id, 'no valid time'); continue; }
    if (!inRange(t)) { cov.skip('checkpoint', c.id, 'outside the selected range'); continue; }
    const name = clean(c.title) || 'Untitled checkpoint';
    const note = clean(typeof c.note === 'string' ? c.note.split('\n')[0] : '', 120);
    push('Done', `Checkpoint: ${name}${note ? ` (${note})` : ''}`, [ev('checkpoint', c.id, name, t)]);
  }

  // Notes updated in the range count as work in progress. Saved drafts are never cited again.
  const seenNotes = new Set<string>();
  for (const n of list(input.notes)) {
    if (!validId(n.id) || seenNotes.has(n.id)) { cov.skip('note', null, 'missing or repeated id'); continue; }
    seenNotes.add(n.id);
    if (Array.isArray(n.tags) && n.tags.some((x) => typeof x === 'string' && x.toLowerCase() === WORKLOG_NOTE_TAG)) { cov.skip('note', n.id, 'saved worklog drafts are not cited again'); continue; }
    const t = time(n.updatedAt);
    if (Number.isNaN(t)) { cov.skip('note', n.id, 'no valid time'); continue; }
    if (!inRange(t)) { cov.skip('note', n.id, 'outside the selected range'); continue; }
    const name = clean(n.title) || 'Untitled note';
    push('In progress', `Updated note: ${name}`, [ev('note', n.id, name, t)]);
  }

  // Focus time.
  if (focusInRange.length) {
    const total = focusInRange.reduce((n, f) => n + focusSec(f), 0);
    push('Focus time', `Focused ${minutes(total)} min across ${plural(focusInRange.length, 'session')}`, focusInRange.map(focusEv));
  }

  // Application timeline sessions (opt-in). App names only; window titles are never copied into a draft.
  const sessions: WorklogSession[] = [];
  const seenSessions = new Set<string>();
  for (const s of list(input.sessionTimeline)) {
    if (!validId(s.id) || seenSessions.has(s.id)) { cov.skip('session', null, 'missing or repeated id'); continue; }
    seenSessions.add(s.id);
    const t = time(s.at);
    if (Number.isNaN(t)) { cov.skip('session', s.id, 'no valid time'); continue; }
    if (!inRange(t)) { cov.skip('session', s.id, 'outside the selected range'); continue; }
    sessions.push(s);
  }
  if (sessions.length) {
    const secOf = (s: WorklogSession) => { const a = time(s.at), b = time(s.endedAt); return !Number.isNaN(b) && b > a ? (b - a) / 1000 : 0; };
    const total = sessions.reduce((n, s) => n + secOf(s), 0);
    const open = sessions.filter((s) => Number.isNaN(time(s.endedAt))).length;
    const byApp = new Map<string, number>();
    for (const s of sessions) { const app = clean(s.app, 60) || 'Unknown app'; byApp.set(app, (byApp.get(app) ?? 0) + secOf(s)); }
    const top = [...byApp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
    push('Focus time', `Application time recorded: ${minutes(total)} min across ${plural(sessions.length, 'session')}${open ? ` (${open} still open)` : ''}${top.length ? `; mostly ${top.join(', ')}` : ''}`,
      sessions.map((s) => ev('session', s.id, `${clean(s.app, 60) || 'Unknown app'} (${minutes(secOf(s))} min)`, time(s.at))));
  }

  const sections: WorklogSection[] = WORKLOG_HEADINGS.filter((h) => buckets[h].length).map((h) => ({ heading: h, items: buckets[h] }));
  const coverage = cov.result();
  const empty = sections.length === 0;
  const text = empty ? renderEmpty(title, label, coverage) : render(format, title, sections, coverage);
  return { title, format, range, sections, text: text.slice(0, WORKLOG_TEXT_LIMIT), coverage, empty };
}

/* ---------- Rendering ---------- */

const cite = (item: WorklogItem) => item.evidence.map((e) => `${e.kind}:${e.id}`).join(', ');
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function footer(c: WorklogCoverage): string {
  const base = `Based on ${plural(c.counted, 'local record')}; ${c.skipped} skipped.`;
  return c.reasons.length ? `${base} ${c.reasons.join('; ')}.` : base;
}

function renderEmpty(title: string, label: string, c: WorklogCoverage): string {
  const lines = [title, '', `No evidence was found for ${label}. No completed or open tasks, notes, checkpoints, focus sessions or application sessions fall in this range, so nothing was drafted.`];
  if (c.skipped || c.reasons.length) lines.push('', footer(c));
  return lines.join('\n');
}

function render(format: WorklogFormat, title: string, sections: WorklogSection[], c: WorklogCoverage): string {
  const out: string[] = [];
  if (format === 'standup') {
    out.push(title);
    for (const s of sections) { out.push('', s.heading); for (const i of s.items) out.push(`- ${i.text}`); }
    out.push('', footer(c));
  } else if (format === 'worklog') {
    out.push(`# ${title}`);
    for (const s of sections) { out.push('', `## ${s.heading}`); for (const i of s.items) out.push(`- ${i.text} [${cite(i)}]`); }
    out.push('', `_${footer(c)}_`);
  } else {
    out.push(`# ${title}`, '', '| Section | Item | Evidence |', '| --- | --- | --- |');
    for (const s of sections) for (const i of s.items) out.push(`| ${cell(s.heading)} | ${cell(i.text)} | ${cell(cite(i))} |`);
    out.push('', footer(c));
  }
  return out.join('\n');
}
