// Draft worklog and standup updates (registry feature 35), built only from evidence already stored on this computer:
// tasks, notes, explicit project checkpoints (feature 31), focus sessions, capsule goals and capsule activity for a
// chosen local date range. Every bullet cites the record it came from (kind + id + the timestamp that placed it in the
// range). Nothing is summarized by a model, nothing is fetched, and an empty range says so instead of padding.
// Pure and renderer-safe: no clock (callers pass `now`), no I/O, type-only imports from Node-side modules.
import type {AppState} from '../../src/shared/contracts';
import type {ProductivityState} from './store';
import {dayRange, sanitizeText} from './search';
import {dueAt} from './reminders';

export const WORKLOG_LIMITS = {
  /** Longest custom range, in local days (inclusive). */
  maxDays: 31,
  /** Oldest accepted date. */
  minDate: '2000-01-01',
  /** Bullets kept per section; the rest are counted in `truncated`. */
  bulletsPerSection: 100,
  textChars: 160,
  noteChars: 100,
} as const;

export const WORKLOG_PRESETS = ['today', 'yesterday', 'custom'] as const;
export type WorklogPreset = (typeof WORKLOG_PRESETS)[number];
export const WORKLOG_FORMATS = ['standup', 'worklog'] as const;
export type WorklogFormat = (typeof WORKLOG_FORMATS)[number];
export const WORKLOG_STYLES = ['text', 'markdown'] as const;
export type WorklogStyle = (typeof WORKLOG_STYLES)[number];

export const WORKLOG_SECTIONS = ['done', 'progress', 'next'] as const;
export type WorklogSectionId = (typeof WORKLOG_SECTIONS)[number];
export const SECTION_TITLES: Record<WorklogSectionId, string> = {done: 'Done', progress: 'In progress', next: 'Blocked/next'};
/** The three standup questions, one per section. */
export const STANDUP_QUESTIONS: Record<WorklogSectionId, string> = {
  done: 'What did I complete?',
  progress: 'What am I working on?',
  next: 'What is blocked or next?',
};

/** What the renderer sends. from/to are local YYYY-MM-DD keys (inclusive) and only allowed with preset 'custom'. */
export type WorklogRangeInput = {preset: WorklogPreset; from?: string; to?: string};
/** A validated range: local day keys plus the exact [start, end) instants used for filtering. */
export type WorklogRange = {preset: WorklogPreset; from: string; to: string; start: string; end: string; days: number; label: string};
export type WorklogRenderOptions = {format: WorklogFormat; style: WorklogStyle};

export type WorklogSourceKind = 'task' | 'note' | 'checkpoint' | 'focus' | 'activity' | 'capsule';
/** Which stored timestamp placed the record in this draft. */
export type WorklogSourceField = 'createdAt' | 'updatedAt' | 'due' | 'endedAt' | 'at';
export type WorklogSource = {kind: WorklogSourceKind; id: string; at: string; field: WorklogSourceField};
export type WorklogBullet = {key: string; section: WorklogSectionId; text: string; source: WorklogSource};
export type WorklogSection = {id: WorklogSectionId; title: string; bullets: WorklogBullet[]};
export type WorklogDraft = {range: WorklogRange; empty: boolean; total: number; truncated: number; sections: WorklogSection[]};
export type WorklogRendered = {format: WorklogFormat; style: WorklogStyle; empty: boolean; bullets: number; text: string};

/** Input that cannot become a range or render request. The message is user-safe. */
export class WorklogInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clean = (v: unknown, n: number = WORKLOG_LIMITS.textChars) => clip(sanitizeText(v), n);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Whole local days from a to b (inclusive count), independent of DST. */
const spanDays = (from: string, to: string) => {
  const u = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((u(to) - u(from)) / 86_400_000) + 1;
};

function strictKeys(raw: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) throw new WorklogInputError(`${name}: unknown field "${k.slice(0, 30)}"`);
}

/** Local day key of `now` shifted by `offset` days. */
export function localDay(now: Date, offset = 0): string {
  return keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
}

/**
 * Validates a range request against the current time. Rejects unknown fields, malformed or impossible dates, ranges that
 * end in the future, start before 2000, run backwards or span more than 31 days.
 */
export function parseWorklogRange(raw: unknown, now: Date): WorklogRange {
  if (!isRec(raw)) throw new WorklogInputError('Worklog range must be an object');
  strictKeys(raw, ['preset', 'from', 'to'], 'Worklog range');
  const preset = raw.preset;
  if (typeof preset !== 'string' || !(WORKLOG_PRESETS as readonly string[]).includes(preset)) throw new WorklogInputError('Worklog range: preset must be today, yesterday or custom');
  if (Number.isNaN(now.getTime())) throw new WorklogInputError('Worklog range: the current time is unknown');
  const today = localDay(now);
  let from: string, to: string;
  if (preset === 'custom') {
    for (const k of ['from', 'to'] as const) {
      const v = raw[k];
      if (typeof v !== 'string' || !DATE_RE.test(v) || !dayRange(v)) throw new WorklogInputError(`Worklog range: ${k} must be a real date (YYYY-MM-DD)`);
    }
    from = raw.from as string; to = raw.to as string;
  } else {
    if (raw.from !== undefined || raw.to !== undefined) throw new WorklogInputError('Worklog range: from and to are only used with a custom range');
    from = to = preset === 'today' ? today : localDay(now, -1);
  }
  if (from > to) throw new WorklogInputError('Worklog range: the start date is after the end date');
  if (to > today) throw new WorklogInputError('Worklog range: the range ends in the future');
  if (from < WORKLOG_LIMITS.minDate) throw new WorklogInputError(`Worklog range: dates before ${WORKLOG_LIMITS.minDate} are out of range`);
  const days = spanDays(from, to);
  if (days > WORKLOG_LIMITS.maxDays) throw new WorklogInputError(`Worklog range: at most ${WORKLOG_LIMITS.maxDays} days`);
  const start = new Date(dayRange(from)!.start).toISOString();
  const end = new Date(dayRange(to)!.end).toISOString();
  const span = from === to ? from : `${from} to ${to}`;
  const label = preset === 'today' ? `Today (${from})` : preset === 'yesterday' ? `Yesterday (${from})` : span;
  return {preset: preset as WorklogPreset, from, to, start, end, days, label};
}

/** Validates render options. Missing fields default to a plain-text standup; anything else unknown is refused. */
export function parseWorklogRenderOptions(raw: unknown): WorklogRenderOptions {
  if (raw === undefined) return {format: 'standup', style: 'text'};
  if (!isRec(raw)) throw new WorklogInputError('Worklog options must be an object');
  strictKeys(raw, ['format', 'style'], 'Worklog options');
  const format = raw.format ?? 'standup', style = raw.style ?? 'text';
  if (typeof format !== 'string' || !(WORKLOG_FORMATS as readonly string[]).includes(format)) throw new WorklogInputError('Worklog options: format must be standup or worklog');
  if (typeof style !== 'string' || !(WORKLOG_STYLES as readonly string[]).includes(style)) throw new WorklogInputError('Worklog options: style must be text or markdown');
  return {format: format as WorklogFormat, style: style as WorklogStyle};
}

/** A checkpoint whose title starts with one of these words is something still to do, not something done. */
const NEXT_TITLE = /^\s*(blocked|blocker|blocking|next|todo|to do|waiting)\b/i;

/**
 * Collects every bullet the evidence supports for the range. Classification is fixed and explainable:
 * - Done: checkpoints in the range; tasks created in the range that are now marked done.
 * - In progress: tasks created in the range and still open (no due date pressing); notes saved; focus sessions; capsule activity.
 * - Blocked/next: open tasks due in the range, overdue at its end or due the following day; checkpoints titled "Blocked…"/"Next…";
 *   open goals of projects that had a checkpoint or capsule change in the range.
 * Tasks store no completion time, so a done task appears only when it was created in the range, and the text says so.
 */
export function buildWorklogDraft(state: AppState, prod: ProductivityState | null | undefined, range: WorklogRange): WorklogDraft {
  const start = Date.parse(range.start), end = Date.parse(range.end);
  const nextEnd = dayRange(localDay(new Date(end - 1), 1))?.end ?? end + 86_400_000;
  const inRange = (iso: unknown) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return !Number.isNaN(t) && t >= start && t < end; };
  const out: WorklogBullet[] = [];
  const push = (section: WorklogSectionId, text: string, source: WorklogSource) => {
    if (!text) return;
    out.push({key: `${section}:${source.kind}:${source.id}:${source.field}`, section, text, source});
  };
  const capsuleName = (id: string | undefined) => (id ? state.capsules.find((c) => c.id === id)?.name : undefined);
  const touched = new Set<string>();

  for (const c of prod?.checkpoints ?? []) {
    if (!inRange(c.createdAt)) continue;
    const name = capsuleName(c.capsuleId);
    if (c.capsuleId) touched.add(c.capsuleId);
    const note = clean(c.note, WORKLOG_LIMITS.noteChars);
    push(NEXT_TITLE.test(c.title) ? 'next' : 'done', `Checkpoint: ${clean(c.title)}${note ? ` — ${note}` : ''}${name ? ` (project: ${clean(name, 60)})` : ''}`, {kind: 'checkpoint', id: c.id, at: c.createdAt, field: 'createdAt'});
  }

  for (const t of state.tasks) {
    const title = clean(t.title) || 'Untitled task';
    const due = t.done ? null : dueAt(t);
    if (due !== null && due < nextEnd) {
      // Open task with a pressing due value: it belongs to "next", once, timestamped by the due value.
      const where = due < start ? `Overdue (due ${clean(t.due, 40)})` : due < end ? `Due ${clean(t.due, 40)}` : `Due next (${clean(t.due, 40)})`;
      push('next', `${where}: ${title}`, {kind: 'task', id: t.id, at: new Date(due).toISOString(), field: 'due'});
      continue;
    }
    if (!inRange(t.createdAt)) continue;
    if (t.done) push('done', `Task done: ${title} (added in this range; completion time is not recorded)`, {kind: 'task', id: t.id, at: t.createdAt, field: 'createdAt'});
    else push('progress', `Task added, still open: ${title}`, {kind: 'task', id: t.id, at: t.createdAt, field: 'createdAt'});
  }

  for (const n of state.notes) {
    if (inRange(n.updatedAt)) push('progress', `Note saved: ${clean(n.title) || 'Untitled note'}`, {kind: 'note', id: n.id, at: n.updatedAt, field: 'updatedAt'});
  }

  for (const f of prod?.focus ?? []) {
    if (!inRange(f.endedAt)) continue;
    const min = Math.max(1, Math.round(f.actualSec / 60));
    const on = f.taskTitle ? ` on "${clean(f.taskTitle, 80)}"` : '';
    push('progress', `Focus session${f.outcome === 'completed' ? '' : ' (stopped early)'}: ${min} min${on}`, {kind: 'focus', id: f.id, at: f.endedAt, field: 'endedAt'});
    if (f.capsuleId) touched.add(f.capsuleId);
  }

  for (const a of state.activity) {
    if (a.kind === 'capsule' && inRange(a.at)) push('progress', `Capsule activity: ${clean(a.summary)}`, {kind: 'activity', id: a.id, at: a.at, field: 'at'});
  }

  for (const c of state.capsules) if (inRange(c.updatedAt)) touched.add(c.id);
  for (const id of [...touched].sort()) {
    const meta = prod?.capsuleMeta?.[id];
    const name = capsuleName(id);
    if (!meta || !name) continue;
    for (const g of meta.goals) {
      if (g.done) continue;
      out.push({key: `next:capsule:${id}:goal:${g.id}`, section: 'next', text: `Open goal (${clean(name, 60)}): ${clean(g.text)}`, source: {kind: 'capsule', id, at: meta.updatedAt, field: 'updatedAt'}});
    }
  }

  const order = (a: WorklogBullet, b: WorklogBullet) => cmp(a.source.at, b.source.at) || cmp(a.source.kind, b.source.kind) || cmp(a.key, b.key);
  let truncated = 0;
  const sections = WORKLOG_SECTIONS.map((id): WorklogSection => {
    const all = out.filter((b) => b.section === id).sort(order);
    truncated += Math.max(0, all.length - WORKLOG_LIMITS.bulletsPerSection);
    return {id, title: SECTION_TITLES[id], bullets: all.slice(0, WORKLOG_LIMITS.bulletsPerSection)};
  });
  const total = sections.reduce((n, s) => n + s.bullets.length, 0);
  return {range, empty: total === 0, total, truncated, sections};
}

/** Short source citation shown next to every bullet: kind:id @ ISO timestamp. */
export function sourceRef(s: WorklogSource): string {
  return `${s.kind}:${s.id} @ ${s.at}`;
}

/** Escapes Markdown control characters in user text so a title cannot become a link, heading or HTML. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()<>#+!|~])/g, '\\$1').replace(/^(\s*)([-=]|\d+\.)(\s)/, '$1\\$2$3');
}

export const EMPTY_EVIDENCE_TEXT = 'No evidence: no tasks, notes, checkpoints, focus sessions or capsule activity were recorded in this range. Nothing was invented to fill it.';

/** Renders a draft. Deterministic: the same draft and options always give the same text (no clock, no locale). */
export function renderWorklog(draft: WorklogDraft, options: WorklogRenderOptions): WorklogRendered {
  const md = options.style === 'markdown';
  const esc = (s: string) => (md ? escapeMarkdown(s) : s);
  const cite = (b: WorklogBullet) => (md ? ` · \`${b.source.kind}:${b.source.id}\` · ${b.source.at}` : ` [${sourceRef(b.source)}]`);
  const kindTitle = options.format === 'standup' ? 'standup' : 'worklog';
  const title = `Draft ${kindTitle} — ${draft.range.label}`;
  const notice = 'Assembled from local records only; review before sharing.';
  const lines: string[] = md ? [`# ${esc(title)}`, '', `_${notice}_`] : [`DRAFT ${kindTitle.toUpperCase()} — ${draft.range.label}`, notice];
  if (draft.empty) {
    lines.push('', esc(EMPTY_EVIDENCE_TEXT));
  } else if (options.format === 'standup') {
    for (const s of draft.sections) {
      lines.push('', md ? `## ${esc(s.title)} — ${esc(STANDUP_QUESTIONS[s.id])}` : `${s.title} — ${STANDUP_QUESTIONS[s.id]}`);
      if (!s.bullets.length) lines.push(md ? '- _Nothing recorded._' : '- Nothing recorded.');
      for (const b of s.bullets) lines.push(`- ${esc(b.text)}${cite(b)}`);
    }
  } else {
    const all = draft.sections.flatMap((s) => s.bullets).sort((a, b) => cmp(a.source.at, b.source.at) || WORKLOG_SECTIONS.indexOf(a.section) - WORKLOG_SECTIONS.indexOf(b.section) || cmp(a.key, b.key));
    lines.push('');
    for (const b of all) {
      lines.push(md
        ? `- **${b.source.at}** · ${esc(SECTION_TITLES[b.section])} · ${esc(b.text)} · \`${b.source.kind}:${b.source.id}\``
        : `${b.source.at}  [${SECTION_TITLES[b.section]}] ${b.text} (${b.source.kind}:${b.source.id})`);
    }
  }
  if (draft.truncated > 0) lines.push('', esc(`${draft.truncated} more item(s) were left out (limit ${WORKLOG_LIMITS.bulletsPerSection} per section).`));
  return {format: options.format, style: options.style, empty: draft.empty, bullets: draft.total, text: lines.join('\n')};
}
