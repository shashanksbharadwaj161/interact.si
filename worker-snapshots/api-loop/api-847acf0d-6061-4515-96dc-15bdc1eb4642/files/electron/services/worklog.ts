// Worklog and standup drafts (roadmap feature 35). Offline and evidence-only: a draft is assembled from records the app
// already holds — explicit project checkpoints (feature 31), the opt-in application timeline (feature 33), tasks, and the
// daily-recap evidence (feature 34, services/search buildDailyRecap). No model, no network, no file reads. Every bullet
// cites the records it came from (kind, id, the record's timestamp); a day without records is reported as such instead of
// padded. Texts are sanitized and absolute file paths are removed. Nothing is stored or posted anywhere: a draft becomes a
// note only through save() with reviewed:true, which the renderer sends after the user reviewed (and maybe edited) it.
import {randomUUID} from 'node:crypto';
import type {AppState, WorklogBullet, WorklogDay, WorklogDraft, WorklogEvidence, WorklogFormat, WorklogSectionId, WorklogSections, WorklogSource} from '../../src/shared/contracts';
import type {ProductivityState} from './store';
import {buildDailyRecap, dayRange, sanitizeText} from './search';
import {dueAt} from './reminders';
import {LIMITS, ValidationError} from './validation';

export const WORKLOG_LIMITS = {
  /** Longest range one draft covers, in local days (inclusive). */
  maxDays: 14,
  /** Oldest start day accepted, counted back from today. */
  maxAgeDays: 400,
  defaultBullets: 5,
  /** Upper bound for the per-heading standup bullet count. */
  maxBullets: 10,
  bulletChars: 200,
  /** Bullets per section per day, and over the whole draft; anything beyond is counted as truncated, never dropped silently. */
  perSectionPerDay: 15,
  totalBullets: 150,
  evidencePerBullet: 5,
  timelineApps: 5,
  checkpointNoteLines: 20,
  /** Drafts awaiting review kept at once; generating another drops the oldest. */
  maxPending: 4,
  ttlMs: 30 * 60_000,
};
export type WorklogLimits = typeof WORKLOG_LIMITS;

/** Note titles are validated to 200 characters (validation.ts buildNote). */
const NOTE_TITLE_MAX = 200;
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_KEYS = ['from', 'to', 'format', 'maxBullets', 'withEvidence'];
const SAVE_KEYS = ['body', 'title', 'reviewed'];
/** Words the user wrote that mark something as blocked. Matched only in titles/notes the user typed. */
const BLOCKED_RE = /\b(blocked|blocker|blockers|stuck|waiting (?:on|for))\b/i;
/** Checkpoint note lines with an explicit prefix become their own bullets; other lines are left out. */
const NOTE_LINE_RE = /^\s*(?:[-*•]\s*)?(next|todo|to do|then|done|blocked|blocker|blockers|waiting on|waiting for)\s*[:\u2013\u2014-]\s*(.+?)\s*$/i;

export const SECTION_IDS: readonly WorklogSectionId[] = ['done', 'inProgress', 'blocked', 'next'];
export const SECTION_LABELS: Record<WorklogSectionId, string> = {done: 'Done', inProgress: 'In progress', blocked: 'Blocked', next: 'Next'};

// ---------- text hygiene ----------

const PATH_RES: RegExp[] = [
  /\bfile:\/\/[^\s"'<>]*/gi,
  // UNC and device paths (\\server\share, \\?\C:\...).
  /\\\\(?:[^\\/\n"'<>|]*[\\/])*[^\s\\/"'<>|]*/g,
  // Drive paths; inner segments may contain spaces (C:\Program Files\App\x.exe).
  /\b[A-Za-z]:[\\/](?:[^\\/\n"'<>|:]*[\\/])*[^\s\\/"'<>|]*/g,
];
const POSIX_HOME_RE = /(^|[^\w.~])(?:~|\/(?:Users|home|root|mnt|media|Volumes|private|tmp|var|opt|srv|etc))\/[^\s"'<>]*/g;
const BACKSLASH_FRAGMENT_RE = /[^\s"'<>]*\\[^\s"'<>]*/g;

/** Replaces absolute file paths (drive, UNC, device, file: URLs, home-style POSIX paths) with "[path]". */
export function stripPaths(text: string): string {
  let out = text;
  for (const re of PATH_RES) out = out.replace(re, '[path]');
  out = out.replace(POSIX_HOME_RE, (_m, pre: string) => `${pre}[path]`);
  return out.replace(BACKSLASH_FRAGMENT_RE, '[path]');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
/** Single-line, control-free, path-free, bounded. */
export function cleanText(v: unknown, max: number = WORKLOG_LIMITS.bulletChars): string {
  return clip(stripPaths(sanitizeText(v)).trim(), max);
}
/** Application names only: a full executable path is reduced to its file name. */
const appName = (app: string) => cleanText(String(app).split(/[\\/]/).pop() ?? '', 60) || 'Unknown application';
const fmtMin = (sec: number) => (sec < 60 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`);

// ---------- days ----------

/** Local YYYY-MM-DD of an instant. */
export function localDayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(key: string, n: number): string {
  const r = dayRange(key);
  if (!r) throw new ValidationError('Invalid day');
  const d = new Date(r.start);
  return localDayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime());
}

export type WorklogRequest = {from: string; to: string; days: string[]; format: WorklogFormat; maxBullets: number; withEvidence: boolean};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strict request reader: known keys only, valid local days, from <= to, at most maxDays, not in the future, not too old. */
export function parseWorklogRequest(raw: unknown, nowMs: number, limits: WorklogLimits = WORKLOG_LIMITS): WorklogRequest {
  if (!isObj(raw)) throw new ValidationError('The draft request must be an object');
  for (const k of Object.keys(raw)) if (!REQUEST_KEYS.includes(k)) throw new ValidationError(`Unknown draft option: ${k.slice(0, 30)}`);
  const {from, to} = raw;
  if (typeof from !== 'string' || typeof to !== 'string' || !DAY_RE.test(from) || !DAY_RE.test(to) || !dayRange(from) || !dayRange(to)) throw new ValidationError('Choose a start and an end day (YYYY-MM-DD)');
  if (from > to) throw new ValidationError('The start day must not be after the end day');
  const today = localDayKey(nowMs);
  if (to > today) throw new ValidationError('The end day cannot be in the future');
  if (from < addDays(today, -limits.maxAgeDays)) throw new ValidationError(`The start day is more than ${limits.maxAgeDays} days ago`);
  const days: string[] = [from];
  while (days[days.length - 1] !== to) {
    if (days.length >= limits.maxDays) throw new ValidationError(`A draft covers at most ${limits.maxDays} days`);
    days.push(addDays(days[days.length - 1], 1));
  }
  const format = raw.format === undefined ? 'worklog' : raw.format;
  if (format !== 'worklog' && format !== 'standup') throw new ValidationError('Format must be "standup" or "worklog"');
  const maxBullets = raw.maxBullets === undefined ? limits.defaultBullets : raw.maxBullets;
  if (typeof maxBullets !== 'number' || !Number.isSafeInteger(maxBullets) || maxBullets < 1 || maxBullets > limits.maxBullets) throw new ValidationError(`Bullets per heading must be a whole number from 1 to ${limits.maxBullets}`);
  if (raw.withEvidence !== undefined && typeof raw.withEvidence !== 'boolean') throw new ValidationError('withEvidence must be true or false');
  return {from, to, days, format, maxBullets, withEvidence: raw.withEvidence !== false};
}

// ---------- collection ----------

export type WorklogCore = Omit<WorklogDraft, 'draftId' | 'text' | 'markdown'>;

const emptySections = (): WorklogSections => ({done: [], inProgress: [], blocked: [], next: []});
const byAt = (a: WorklogBullet, b: WorklogBullet) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
const within = (iso: string | undefined, r: {start: number; end: number}) => {
  const t = iso ? Date.parse(iso) : NaN;
  return !Number.isNaN(t) && t >= r.start && t < r.end;
};
const iso = (v: string) => { const t = Date.parse(v); return Number.isNaN(t) ? v : new Date(t).toISOString(); };

/**
 * Builds the evidence-backed draft content for a parsed request. Pure apart from the inputs: reads the given AppState and
 * productivity snapshot only. Records outside the range are never used (open tasks due on the day after the range are the
 * single, labelled exception, shown under Next).
 */
export function collectWorklog(state: AppState, prod: ProductivityState | null | undefined, req: WorklogRequest, nowMs: number, limits: WorklogLimits = WORKLOG_LIMITS): WorklogCore {
  const p = prod ?? undefined;
  const timelineOn = p?.policy?.timelineEnabled === true;
  let total = 0, truncated = 0, fromRecap = 0, timelineCount = 0;
  const checkpointIds = new Set<string>(), taskIds = new Set<string>();
  const days: WorklogDay[] = [];

  for (const day of req.days) {
    const r = dayRange(day)!;
    const sections = emptySections();
    const push = (sec: WorklogSectionId, at: string, text: string, evidence: WorklogEvidence[]): boolean => {
      const t = cleanText(text, limits.bulletChars);
      // A bullet without text or without evidence is never produced.
      if (!t || !evidence.length) return false;
      if (sections[sec].length >= limits.perSectionPerDay || total >= limits.totalBullets) { truncated++; return false; }
      total++;
      sections[sec].push({section: sec, day, at, text: t, evidence: evidence.slice(0, limits.evidencePerBullet)});
      return true;
    };

    // Daily-recap evidence (feature 34): every recap line names one stored record; classify it by looking that record up.
    for (const line of buildDailyRecap(state, p, day).lines) {
      const id = line.source.id;
      switch (line.source.kind) {
        case 'focus': {
          const f = p?.focus.find((x) => x.id === id);
          if (!f) break;
          const on = f.taskTitle ? ` on "${cleanText(f.taskTitle, 80)}"` : '';
          if (push(f.outcome === 'completed' ? 'done' : 'inProgress', iso(f.endedAt), `Focus session${on}: ${fmtMin(f.actualSec)}${f.outcome === 'completed' ? '' : ' (stopped early)'}`, [{kind: 'focus', id, at: iso(f.endedAt)}])) fromRecap++;
          break;
        }
        case 'checkpoint': {
          // Explicit project checkpoints (feature 31): the title, plus note lines the user prefixed with Next:/Blocked:/Done:.
          const c = p?.checkpoints.find((x) => x.id === id);
          if (!c) break;
          checkpointIds.add(c.id);
          const ev: WorklogEvidence[] = [{kind: 'checkpoint', id, at: iso(c.createdAt)}];
          if (push(BLOCKED_RE.test(c.title) ? 'blocked' : 'done', iso(c.createdAt), `Checkpoint: ${c.title}`, ev)) fromRecap++;
          for (const raw of String(c.note ?? '').split('\n').slice(0, limits.checkpointNoteLines)) {
            const m = NOTE_LINE_RE.exec(raw);
            if (!m) continue;
            const key = m[1].toLowerCase();
            const rest = m[2];
            if (key === 'done') push('done', iso(c.createdAt), rest, ev);
            else if (key.startsWith('waiting')) push('blocked', iso(c.createdAt), `Waiting ${key.slice(8)} ${rest}`, ev);
            else if (key.startsWith('block')) push('blocked', iso(c.createdAt), rest, ev);
            else push('next', iso(c.createdAt), rest, ev);
          }
          break;
        }
        case 'note': {
          const n = state.notes.find((x) => x.id === id);
          if (n && push('inProgress', iso(n.updatedAt), `Updated note: ${n.title || 'Untitled note'}`, [{kind: 'note', id, at: iso(n.updatedAt)}])) fromRecap++;
          break;
        }
        case 'task': {
          const t = state.tasks.find((x) => x.id === id);
          if (!t) break;
          taskIds.add(t.id);
          const ev: WorklogEvidence[] = [{kind: 'task', id, at: iso(t.createdAt)}];
          const ok = t.done ? push('done', iso(t.createdAt), `Completed task: ${t.title} (added this day; completion time is not recorded)`, ev)
            : BLOCKED_RE.test(t.title) ? push('blocked', iso(t.createdAt), `Open task: ${t.title}`, ev)
            : push('inProgress', iso(t.createdAt), `Open task added: ${t.title}`, ev);
          if (ok) fromRecap++;
          break;
        }
        case 'activity': {
          const a = state.activity.find((x) => x.id === id);
          if (a && push('done', iso(a.at), `Project activity: ${a.summary}`, [{kind: 'activity', id, at: iso(a.at)}])) fromRecap++;
          break;
        }
        default:
          // 'session' lines are rebuilt below from the timeline itself, only while the opt-in timeline is on.
          break;
      }
    }

    // Opt-in application timeline (feature 33): application names and durations only, never window titles.
    if (timelineOn) {
      const byApp = new Map<string, {sec: number; refs: WorklogEvidence[]; first: string}>();
      for (const e of p?.timeline ?? []) {
        if (!within(e.at, r) || !e.endedAt) continue;
        const app = appName(e.app);
        const cur = byApp.get(app) ?? {sec: 0, refs: [], first: iso(e.at)};
        cur.sec += Math.max(0, (Date.parse(e.endedAt) - Date.parse(e.at)) / 1000);
        cur.refs.push({kind: 'session', id: e.id, at: iso(e.at)});
        if (iso(e.at) < cur.first) cur.first = iso(e.at);
        byApp.set(app, cur);
        timelineCount++;
      }
      for (const [app, v] of [...byApp.entries()].sort((a, b) => b[1].sec - a[1].sec).slice(0, limits.timelineApps)) {
        push('inProgress', v.first, `Application time: ${app} for ${fmtMin(v.sec)}`, v.refs.sort((a, b) => (a.at < b.at ? -1 : 1)));
      }
    }

    for (const s of SECTION_IDS) sections[s].sort(byAt);
    days.push({day, empty: SECTION_IDS.every((s) => sections[s].length === 0), sections});
  }

  // Open tasks due inside the range or on the following day become Next items, cited by the task and its due time.
  const lookaheadUntil = addDays(req.to, 1);
  const startMs = dayRange(req.from)!.start, endMs = dayRange(lookaheadUntil)!.end;
  const due: WorklogBullet[] = [];
  for (const t of state.tasks) {
    if (t.done) continue;
    const at = dueAt(t);
    if (at === null || at < startMs || at >= endMs) continue;
    if (due.length >= limits.perSectionPerDay || total >= limits.totalBullets) { truncated++; continue; }
    const text = cleanText(`Due ${localDayKey(at)}: ${t.title}`);
    if (!text) continue;
    total++;
    taskIds.add(t.id);
    const when = new Date(at).toISOString();
    due.push({section: 'next', day: localDayKey(at), at: when, text, evidence: [{kind: 'task', id: t.id, at: when}]});
  }
  due.sort(byAt);

  const sections = emptySections();
  for (const d of days) for (const s of SECTION_IDS) sections[s].push(...d.sections[s]);
  sections.next.push(...due);
  const emptyDays = days.filter((d) => d.empty).map((d) => d.day);
  const sources: WorklogSource[] = [
    {id: 'recap', label: 'Daily recap evidence', used: true, count: fromRecap, note: 'Focus sessions, checkpoints, saved notes, tasks added and capsule activity on each day.'},
    {id: 'checkpoints', label: 'Project checkpoints', used: true, count: checkpointIds.size, note: 'Checkpoint titles, plus note lines starting with "Next:", "Blocked:", "Waiting on:" or "Done:".'},
    {id: 'tasks', label: 'Tasks', used: true, count: taskIds.size, note: `Tasks added in the range, and open tasks due by ${lookaheadUntil}.`},
    {id: 'timeline', label: 'Application timeline', used: timelineOn, count: timelineCount, note: timelineOn ? 'Application names and durations only; window titles are never included.' : 'The application timeline is off, so it was not used.'},
  ];
  const limitations = [
    'Tasks do not record when they were completed; a done task is listed on the day it was added.',
    'Only records stored on this computer are used. No model wrote any of this text.',
    ...(timelineOn ? [] : ['Application time is not included because the application timeline is off.']),
    ...(truncated ? [`${truncated} item(s) were left out to keep the draft short.`] : []),
  ];
  const suggestedTitle = clip(req.format === 'standup' ? `Standup ${req.to}` : req.from === req.to ? `Worklog ${req.from}` : `Worklog ${req.from} to ${req.to}`, NOTE_TITLE_MAX);
  return {
    format: req.format, range: {from: req.from, to: req.to, days: req.days.length, lookaheadUntil}, generatedAt: new Date(nowMs).toISOString(),
    maxBullets: req.maxBullets, withEvidence: req.withEvidence, empty: emptyDays.length === days.length && due.length === 0, emptyDays, days, sections,
    sources, limitations, truncated, suggestedTitle,
  };
}

// ---------- rendering ----------

export type RenderStyle = 'text' | 'markdown';

/** Escapes Markdown control characters so record text stays literal. */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_[\]<>#|~])/g, '\\$1');
}

const NO_EVIDENCE = 'No evidence recorded.';

function bulletLine(b: WorklogBullet, style: RenderStyle, withEvidence: boolean): string {
  if (style === 'text') return `- ${b.text}${withEvidence ? ` [${b.evidence.map((e) => `${e.kind}:${e.id} @ ${e.at}`).join('; ')}]` : ''}`;
  return `- ${escapeMarkdown(b.text)}${withEvidence ? ` — evidence: ${b.evidence.map((e) => `\`${e.kind}:${e.id}\` ${e.at}`).join('; ')}` : ''}`;
}

/** Plain-text or Markdown rendering. Uses only the sanitized bullet texts, so no absolute path can appear. */
export function renderWorklog(d: WorklogCore, style: RenderStyle, withEvidence: boolean = d.withEvidence): string {
  const md = style === 'markdown';
  const span = d.range.from === d.range.to ? d.range.from : `${d.range.from} to ${d.range.to}`;
  const out: string[] = [];
  const kind = d.format === 'standup' ? 'standup' : 'worklog';
  out.push(md ? `# Draft ${kind}: ${span}` : `DRAFT ${kind}: ${span}`);
  out.push(md ? '_Assembled from local records only. Review and edit before sharing; nothing has been posted._' : 'Assembled from local records only. Review and edit before sharing; nothing has been posted.');
  if (d.empty) out.push('', 'No recorded evidence in this range, so there is nothing to report.');
  const heading = (t: string, level: 2 | 3) => (md ? `${'#'.repeat(level)} ${t}` : level === 2 ? t : `  ${t}`);
  if (d.format === 'standup') {
    const groups: [string, WorklogBullet[]][] = [['Yesterday', d.sections.done], ['Today', [...d.sections.inProgress, ...d.sections.next]], ['Blockers', d.sections.blocked]];
    for (const [title, items] of groups) {
      out.push('', heading(title, 2));
      if (!items.length) { out.push(`- ${NO_EVIDENCE}`); continue; }
      for (const b of items.slice(0, d.maxBullets)) out.push(bulletLine(b, style, withEvidence));
      if (items.length > d.maxBullets) out.push(`- …and ${items.length - d.maxBullets} more (see the worklog format)`);
    }
    if (d.emptyDays.length) out.push('', `No recorded evidence on: ${d.emptyDays.join(', ')}.`);
  } else {
    for (const day of d.days) {
      out.push('', heading(day.day, 2));
      if (day.empty) { out.push(md ? 'No recorded evidence for this day.' : '  No recorded evidence for this day.'); continue; }
      for (const s of SECTION_IDS) {
        const items = day.sections[s];
        if (!items.length) continue;
        out.push(heading(SECTION_LABELS[s], 3));
        for (const b of items) out.push(md ? bulletLine(b, style, withEvidence) : `  ${bulletLine(b, style, withEvidence)}`);
      }
    }
    const due = d.sections.next.filter((b) => b.evidence.length === 1 && b.evidence[0].kind === 'task' && b.text.startsWith('Due '));
    if (due.length) {
      out.push('', heading(`Next (open tasks due by ${d.range.lookaheadUntil})`, 2));
      for (const b of due) out.push(bulletLine(b, style, withEvidence));
    }
  }
  if (d.truncated) out.push('', `${d.truncated} item(s) were left out to keep the draft short.`);
  return out.join('\n');
}

// ---------- service ----------

export type WorklogReaders = {state: () => AppState; productivity: () => ProductivityState | null | undefined};
export type SaveWorklogNote = (note: {title: string; body: string; tags: string[]}) => Promise<void>;
interface Pending { title: string; format: WorklogFormat; expires: number }

export class WorklogDrafts {
  private pending = new Map<string, Pending>();

  constructor(private opts: {readers: WorklogReaders; now?: () => number; saveNote?: SaveWorklogNote; newToken?: () => string; limits?: Partial<WorklogLimits>}) {}

  private get limits(): WorklogLimits { return {...WORKLOG_LIMITS, ...this.opts.limits}; }
  private now() { return (this.opts.now ?? Date.now)(); }

  get pendingCount(): number { this.sweep(); return this.pending.size; }

  /** Builds a draft from local records. Stores nothing except a short-lived review token. */
  draft(raw: unknown): WorklogDraft {
    const now = this.now();
    const req = parseWorklogRequest(raw, now, this.limits);
    const core = collectWorklog(this.opts.readers.state(), this.opts.readers.productivity(), req, now, this.limits);
    this.sweep();
    while (this.pending.size >= this.limits.maxPending) this.pending.delete(this.pending.keys().next().value as string);
    const draftId = (this.opts.newToken ?? randomUUID)();
    if (!TOKEN_RE.test(draftId)) throw new Error('Could not allocate a draft');
    this.pending.set(draftId, {title: core.suggestedTitle, format: core.format, expires: now + this.limits.ttlMs});
    return {draftId, ...core, text: renderWorklog(core, 'text'), markdown: renderWorklog(core, 'markdown')};
  }

  /** Saves the reviewed (possibly edited) draft text as a new local note. Requires reviewed:true; nothing is sent anywhere. */
  async save(token: unknown, options: unknown): Promise<{saved: true; title: string}> {
    const p = this.peek(token);
    if (!isObj(options)) throw new ValidationError('Save options must be an object');
    for (const k of Object.keys(options)) if (!SAVE_KEYS.includes(k)) throw new ValidationError(`Unknown save option: ${k.slice(0, 30)}`);
    if (options.reviewed !== true) throw new ValidationError('Review the draft first, then confirm that you reviewed it before saving');
    if (typeof options.body !== 'string') throw new ValidationError('The draft text must be text');
    const body = options.body.replace(/\r\n?/g, '\n');
    if (!body.trim()) throw new ValidationError('The draft is empty');
    if (body.length > LIMITS.noteBody) throw new ValidationError(`The draft is longer than ${LIMITS.noteBody} characters`);
    if (options.title !== undefined && typeof options.title !== 'string') throw new ValidationError('The title must be text');
    const title = typeof options.title === 'string' && options.title.trim() ? options.title.trim() : p.title;
    if (!this.opts.saveNote) throw new ValidationError('Saving drafts as notes is not connected');
    await this.opts.saveNote({title, body, tags: [p.format]});
    this.pending.delete(token as string);
    return {saved: true, title};
  }

  discard(token: unknown): boolean {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ValidationError('Invalid draft id');
    return this.pending.delete(token);
  }

  clear(): void { this.pending.clear(); }

  private peek(token: unknown): Pending {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ValidationError('Invalid draft id');
    this.sweep();
    const p = this.pending.get(token);
    if (!p) throw new ValidationError('This draft expired or was already saved. Generate it again');
    return p;
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
  }
}
