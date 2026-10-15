// Evidence-backed worklog and standup drafts. Pure and injectable: the clock and the evidence loader are passed in, so
// nothing here touches the filesystem, the network or a model. Every content line is built from one stored record
// (task, checkpoint, focus session, note or capsule activity) inside the chosen local date range and cites its kind
// and id. Nothing is summarized or invented: durations appear only for focus sessions, which record them, and no
// progress percentages are produced. Renderer-safe (type-only imports).
import type {AppState} from '../../src/shared/contracts';
import type {ProductivityState} from './store';

export const WORKLOG_FORMATS = ['worklog', 'standup'] as const;
export type WorklogFormat = (typeof WORKLOG_FORMATS)[number];
export type WorklogRequest = {from: string; to: string; format: WorklogFormat};
export type WorklogSourceKind = 'task' | 'checkpoint' | 'focus' | 'note' | 'activity';
export type WorklogLine = {text: string; source: {kind: WorklogSourceKind; id: string}; at?: string};
export type WorklogSection = {title: string; lines: WorklogLine[]};
export type WorklogDraft = {
  format: WorklogFormat;
  from: string;
  to: string;
  /** True when no stored record falls inside the range (standup "Today"/"Blockers" lines do not count). */
  empty: boolean;
  /** Worklog: one section per project (capsule). Standup: Yesterday, Today, Blockers. */
  sections: WorklogSection[];
  lineCount: number;
  /** True when lines or output were cut at the size caps. */
  truncated: boolean;
  markdown: string;
  text: string;
};

/** What the draft is built from. Only these fields are read. */
export type WorklogEvidence = {
  state: Pick<AppState, 'notes' | 'tasks' | 'capsules' | 'activity'>;
  productivity?: Pick<ProductivityState, 'checkpoints' | 'focus' | 'capsuleMeta'> | null;
};

export interface WorklogApi {
  worklogDraft(request: WorklogRequest): Promise<WorklogDraft>;
}

export const WORKLOG_LIMITS = {
  /** Longest range, in days, inclusive. */
  maxRangeDays: 31,
  /** Content lines kept per draft. */
  maxLines: 300,
  /** Open tasks listed under standup "Today". */
  maxTodayLines: 20,
  /** Records scanned per evidence kind. */
  maxRecords: 5000,
  lineChars: 240,
  groupChars: 80,
  /** Largest Markdown or plain-text output. */
  maxOutputChars: 40_000,
  minYear: 2000,
  maxYear: 2100,
};

export class WorklogValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_KEYS = ['from', 'to', 'format'] as const;
// C0/C1 controls, zero-width, line/paragraph separators, bidi embeddings/overrides/isolates, word joiners, BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// Absolute Windows paths, UNC paths and file: URLs (up to the next whitespace or quote).
const ABS_PATH = /(?:\bfile:\/\/[^\s"'<>]*|\\\\[^\s"'<>]+|\b[A-Za-z]:[\\/][^\s"'<>]*)/gi;
// Any remaining token with a backslash separator (for example the tail of a path with spaces).
const SLASHED = /[^\s"'<>]*\\[^\s"'<>]*/g;
const MD_SPECIAL = /[\\`*_[\]<>#|~&!]/g;

const baseName = (p: string): string => {
  const parts = p.replace(/^file:\/+/i, '').split(/[\\/]+/).filter(Boolean);
  const last = parts.length > 1 || /^[A-Za-z]:$/.test(parts[0] ?? '') ? parts[parts.length - 1] : parts[0];
  return !last || /^[A-Za-z]:$/.test(last) ? '[path]' : last;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Plain single-line text: control, invisible and bidi characters removed, paths reduced to their last name, bounded. */
export function sanitizeWorklogText(value: unknown, max: number = WORKLOG_LIMITS.lineChars): string {
  if (typeof value !== 'string') return '';
  const s = value.slice(0, max * 4).replace(UNSAFE_CHARS, ' ').replace(ABS_PATH, baseName).replace(SLASHED, baseName).replace(/\s+/g, ' ').trim();
  return clip(s, max);
}

/** Escapes Markdown punctuation so record text cannot form links, images, HTML, headings or emphasis. */
export function escapeMarkdown(s: string): string {
  return s.replace(MD_SPECIAL, (c) => `\\${c}`);
}

/** Local-calendar [start, end) for a YYYY-MM-DD key, or null when it is not a real date in range. */
function localDay(key: string): {start: number; end: number} | null {
  const m = DATE_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  if (y < WORKLOG_LIMITS.minYear || y > WORKLOG_LIMITS.maxYear) return null;
  const start = new Date(y, mo, d);
  if (start.getFullYear() !== y || start.getMonth() !== mo || start.getDate() !== d) return null;
  return {start: start.getTime(), end: new Date(y, mo, d + 1).getTime()};
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const stamp = (iso: string) => { const d = new Date(Date.parse(iso)); return `${dayKey(d.getTime())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * Strict request check: a plain object with exactly from, to (YYYY-MM-DD, real local dates, from <= to, at most
 * maxRangeDays days inclusive, from not after today) and format ('worklog' | 'standup'). Unknown fields are refused.
 */
export function parseWorklogRequest(raw: unknown, nowMs: number): WorklogRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new WorklogValidationError('Worklog request must be an object');
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) throw new WorklogValidationError('Worklog request must be a plain object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(REQUEST_KEYS as readonly string[]).includes(k)) throw new WorklogValidationError(`Worklog request: unknown field "${k.slice(0, 30)}"`);
  if (typeof o.from !== 'string' || typeof o.to !== 'string') throw new WorklogValidationError('Worklog request: from and to are required dates (YYYY-MM-DD)');
  const from = localDay(o.from), to = localDay(o.to);
  if (!from) throw new WorklogValidationError('Worklog request: from is not a valid date (YYYY-MM-DD)');
  if (!to) throw new WorklogValidationError('Worklog request: to is not a valid date (YYYY-MM-DD)');
  if (to.start < from.start) throw new WorklogValidationError('Worklog request: to must not be before from');
  const days = Math.round((to.end - from.start) / 86_400_000);
  if (days > WORKLOG_LIMITS.maxRangeDays) throw new WorklogValidationError(`Worklog request: choose at most ${WORKLOG_LIMITS.maxRangeDays} days`);
  if (Number.isFinite(nowMs) && from.start > nowMs) throw new WorklogValidationError('Worklog request: the range starts in the future');
  if (typeof o.format !== 'string' || !(WORKLOG_FORMATS as readonly string[]).includes(o.format)) throw new WorklogValidationError('Worklog request: format must be "worklog" or "standup"');
  return {from: o.from, to: o.to, format: o.format as WorklogFormat};
}

const list = <T>(v: readonly T[] | undefined | null): T[] => (Array.isArray(v) ? v.slice(0, WORKLOG_LIMITS.maxRecords) : []);
const validId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Recorded seconds as an exact duration ("25 min", "1 min 30 s", "45 s"). */
const recorded = (sec: number) => {
  const s = Math.max(0, Math.floor(sec)), m = Math.floor(s / 60), r = s % 60;
  return m ? (r ? `${m} min ${r} s` : `${m} min`) : `${r} s`;
};

const BLOCKER_RE = /^\s*(blocked|blocker|blocking)\b/i;

type Collected = WorklogLine & {group: string; groupOrder: string};

/** Builds a draft from explicit evidence. Pure: same evidence, request and clock give the same draft. */
export function buildWorklogDraft(evidence: WorklogEvidence, request: WorklogRequest, nowMs: number): WorklogDraft {
  const req = parseWorklogRequest(request, nowMs);
  const range = {start: localDay(req.from)!.start, end: localDay(req.to)!.end};
  const inRange = (iso: unknown): iso is string => {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return !Number.isNaN(t) && t >= range.start && t < range.end;
  };
  const state = isObj(evidence?.state) ? evidence.state : {notes: [], tasks: [], capsules: [], activity: []};
  const prod = isObj(evidence?.productivity) ? evidence.productivity : null;

  // Project grouping: capsules by id; notes/tasks by the first capsule whose references point at them.
  const capsules = new Map<string, string>();
  for (const c of list(state.capsules)) if (isObj(c) && validId(c.id)) capsules.set(c.id, sanitizeWorklogText(c.name, WORKLOG_LIMITS.groupChars) || 'Untitled project');
  const refOwner = new Map<string, string>();
  for (const [capsuleId, meta] of Object.entries(isObj(prod?.capsuleMeta) ? prod!.capsuleMeta : {})) {
    if (!validId(capsuleId) || !isObj(meta)) continue;
    for (const r of list(meta.references)) if (isObj(r) && (r.kind === 'note' || r.kind === 'task') && typeof r.target === 'string' && !refOwner.has(`${r.kind}:${r.target}`)) refOwner.set(`${r.kind}:${r.target}`, capsuleId);
  }
  const groupOf = (capsuleId: string | undefined): string => (capsuleId ? capsules.get(capsuleId) ?? 'Deleted project' : 'No project');
  const tasks = new Map<string, {title: string; done: boolean}>();
  for (const t of list(state.tasks)) if (isObj(t) && validId(t.id)) tasks.set(t.id, {title: sanitizeWorklogText(t.title, 120) || 'Untitled task', done: t.done === true});

  const lines: Collected[] = [];
  const blockers: WorklogLine[] = [];
  const push = (kind: WorklogSourceKind, id: string, at: string, text: string, capsuleId: string | undefined) => {
    const clean = sanitizeWorklogText(text);
    if (clean) lines.push({text: clean, source: {kind, id}, at, group: groupOf(capsuleId), groupOrder: capsuleId ?? '~'});
  };

  for (const c of list(prod?.checkpoints)) {
    if (!isObj(c) || !validId(c.id) || !inRange(c.createdAt)) continue;
    const t = sanitizeWorklogText(c.title, 120) || 'Checkpoint';
    const note = sanitizeWorklogText(c.note, 120);
    push('checkpoint', c.id, c.createdAt, `Checkpoint: ${t}${note ? ` — ${note}` : ''}`, validId(c.capsuleId) ? c.capsuleId : undefined);
    if (BLOCKER_RE.test(t)) blockers.push({text: sanitizeWorklogText(`Recorded blocker: ${t}`), source: {kind: 'checkpoint', id: c.id}, at: c.createdAt});
  }
  for (const f of list(prod?.focus)) {
    if (!isObj(f) || !validId(f.id) || !inRange(f.endedAt)) continue;
    const sec = typeof f.actualSec === 'number' && Number.isFinite(f.actualSec) ? f.actualSec : null;
    const task = validId(f.taskId) ? tasks.get(f.taskId) : undefined;
    const title = sanitizeWorklogText(f.taskTitle, 120) || task?.title || '';
    const capsuleId = validId(f.capsuleId) ? f.capsuleId : validId(f.taskId) ? refOwner.get(`task:${f.taskId}`) : undefined;
    push('focus', f.id, f.endedAt, `Focus session ${f.outcome === 'completed' ? 'completed' : 'stopped early'}${sec !== null ? `: ${recorded(sec)} recorded` : ''}${title ? ` on "${title}"` : ''}`, capsuleId);
  }
  for (const t of list(state.tasks)) {
    if (!isObj(t) || !validId(t.id) || !inRange(t.createdAt)) continue;
    push('task', t.id, t.createdAt, `Task added: ${tasks.get(t.id)!.title} (currently ${t.done === true ? 'done' : 'open'})`, refOwner.get(`task:${t.id}`));
  }
  for (const n of list(state.notes)) {
    if (!isObj(n) || !validId(n.id) || !inRange(n.updatedAt)) continue;
    push('note', n.id, n.updatedAt, `Note created or edited: ${sanitizeWorklogText(n.title, 120) || 'Untitled note'}`, refOwner.get(`note:${n.id}`));
  }
  for (const a of list(state.activity)) {
    if (!isObj(a) || a.kind !== 'capsule' || !validId(a.id) || !inRange(a.at)) continue;
    const summary = typeof a.summary === 'string' ? a.summary : '';
    const owner = [...capsules.entries()].find(([, name]) => name && summary.includes(`"${name}"`))?.[0];
    push('activity', a.id, a.at, `Capsule activity: ${summary}`, owner);
  }

  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  lines.sort((a, b) => cmp(a.at ?? '', b.at ?? '') || cmp(a.source.kind, b.source.kind) || cmp(a.source.id, b.source.id));
  let truncated = lines.length > WORKLOG_LIMITS.maxLines;
  const kept = lines.slice(0, WORKLOG_LIMITS.maxLines);
  const strip = ({text, source, at}: Collected): WorklogLine => ({text, source, ...(at ? {at} : {})});

  let sections: WorklogSection[];
  if (req.format === 'worklog') {
    const groups = new Map<string, {first: string; lines: WorklogLine[]}>();
    for (const l of kept) {
      const g = groups.get(l.group) ?? {first: l.at ?? '', lines: []};
      g.lines.push(strip(l));
      groups.set(l.group, g);
    }
    sections = [...groups.entries()].sort((a, b) => cmp(a[1].first, b[1].first) || cmp(a[0], b[0])).map(([title, g]) => ({title, lines: g.lines}));
  } else {
    const today: WorklogLine[] = [];
    const open = [...list(state.tasks)].filter((t) => isObj(t) && validId(t.id) && t.done !== true)
      .sort((a, b) => cmp(a.due ?? '\uffff', b.due ?? '\uffff') || cmp(a.createdAt ?? '', b.createdAt ?? '') || cmp(a.id, b.id));
    for (const t of open) {
      const title = tasks.get(t.id)!.title;
      const due = typeof t.due === 'string' ? sanitizeWorklogText(t.due, 32) : '';
      if (BLOCKER_RE.test(title)) blockers.push({text: sanitizeWorklogText(`Open blocker task: ${title}${due ? ` (due ${due})` : ''}`), source: {kind: 'task', id: t.id}});
      else if (today.length < WORKLOG_LIMITS.maxTodayLines) today.push({text: sanitizeWorklogText(`Open task: ${title}${due ? ` (due ${due})` : ''}`), source: {kind: 'task', id: t.id}});
      else truncated = true;
    }
    if (blockers.length > WORKLOG_LIMITS.maxTodayLines) truncated = true;
    sections = [
      {title: 'Yesterday', lines: kept.map(strip)},
      {title: 'Today', lines: today},
      {title: 'Blockers', lines: blockers.slice(0, WORKLOG_LIMITS.maxTodayLines)},
    ];
  }

  const empty = kept.length === 0;
  const lineCount = sections.reduce((n, s) => n + s.lines.length, 0);
  const range = req.from === req.to ? req.from : `${req.from} to ${req.to}`;
  const kindLabel = req.format === 'worklog' ? 'Worklog' : 'Standup';
  const emptyText = 'No recorded evidence for this range.';
  const render = (markdown: boolean) => {
    const out: string[] = [];
    const esc = (s: string) => (markdown ? escapeMarkdown(s) : s);
    const cite = (l: WorklogLine) => (markdown ? `source: \`${l.source.kind}:${l.source.id}\`` : `source: ${l.source.kind}:${l.source.id}`);
    out.push(markdown ? `# DRAFT ${kindLabel} — ${range}` : `DRAFT ${kindLabel.toUpperCase()} — ${range}`);
    out.push(markdown ? '_Assembled from local records only; every line cites its record. Review before sharing._' : 'Assembled from local records only; every line cites its record. Review before sharing.');
    if (empty && req.format === 'worklog') { out.push('', emptyText); return out; }
    for (const s of sections) {
      out.push('', markdown ? `## ${esc(s.title)}` : `${s.title}:`);
      if (!s.lines.length) {
        if (req.format === 'standup' && s.title === 'Yesterday') out.push(emptyText);
        continue;
      }
      for (const l of s.lines) out.push(`- ${l.at ? `${stamp(l.at)} ` : ''}${esc(l.text)} (${cite(l)})`);
    }
    if (truncated) out.push('', markdown ? '_Some records were left out at the size limit; narrow the range to see them._' : 'Some records were left out at the size limit; narrow the range to see them.');
    return out;
  };
  const bound = (rows: string[], note: string): string => {
    let size = 0, i = 0;
    for (; i < rows.length; i++) { if (size + rows[i].length + 1 > WORKLOG_LIMITS.maxOutputChars - note.length - 2) break; size += rows[i].length + 1; }
    if (i === rows.length) return rows.join('\n');
    truncated = true;
    return [...rows.slice(0, i), '', note].join('\n');
  };
  const markdown = bound(render(true), '_Draft cut at the size limit._');
  const text = bound(render(false), 'Draft cut at the size limit.');
  return {format: req.format, from: req.from, to: req.to, empty, sections, lineCount, truncated, markdown, text};
}

export type WorklogDeps = {
  now: () => Date | number;
  /** Returns the stored evidence. Called once per draft; the result is only read. */
  loadEvidence: () => WorklogEvidence | Promise<WorklogEvidence>;
};

/** Draft service. The request is validated before any evidence is loaded. */
export class Worklog implements WorklogApi {
  constructor(private deps: WorklogDeps) {}

  private nowMs(): number {
    const n = this.deps.now();
    return typeof n === 'number' ? n : n.getTime();
  }

  async worklogDraft(request: WorklogRequest): Promise<WorklogDraft> {
    const now = this.nowMs();
    const req = parseWorklogRequest(request, now);
    const evidence = await this.deps.loadEvidence();
    return buildWorklogDraft(evidence, req, now);
  }

  /** Alias kept for callers that prefer the short name. */
  draft(request: WorklogRequest): Promise<WorklogDraft> { return this.worklogDraft(request); }
}
