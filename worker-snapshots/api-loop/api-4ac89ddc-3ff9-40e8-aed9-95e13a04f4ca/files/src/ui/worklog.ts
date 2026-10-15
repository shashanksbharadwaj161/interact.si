// Offline worklog and standup drafts (registry 35), built only from records the app already persisted: explicit
// project checkpoints (31), focus sessions, quick notes, tasks and routine execution results, filtered to a date
// window like the daily recap (34). Pure and deterministic: no I/O, no clock (the caller passes `now`), no model.
// Every bullet carries the source record (kind + id + timestamp) and every draft ends with an Evidence footer.
// Nothing is guessed: records without a usable timestamp are skipped and reported, and no progress percentages exist.

export type WorklogSourceKind = 'checkpoint' | 'task' | 'focus' | 'note' | 'routine-run';
export type SourceRef = { kind: WorklogSourceKind; id: string; at: string };

export type WorklogTaskInput = { id: string; title: string; done: boolean; createdAt: string; completedAt?: string; capsuleId?: string };
export type WorklogCheckpointInput = { id: string; title: string; note?: string; createdAt: string; capsuleId?: string };
export type WorklogFocusInput = { id: string; startedAt: string; endedAt: string; actualSec: number; outcome: 'completed' | 'stopped'; taskId?: string; taskTitle?: string; capsuleId?: string };
export type WorklogNoteInput = { id: string; title: string; updatedAt: string; capsuleId?: string };
export type WorklogRoutineRunInput = { id: string; routineName: string; status: string; startedAt: string; endedAt?: string; steps?: { status: string }[] };
export type WorklogProject = { id: string; name: string };

export type WorklogInput = {
  tasks?: readonly WorklogTaskInput[];
  checkpoints?: readonly WorklogCheckpointInput[];
  focus?: readonly WorklogFocusInput[];
  notes?: readonly WorklogNoteInput[];
  routineRuns?: readonly WorklogRoutineRunInput[];
  projects?: readonly WorklogProject[];
};

export type WorklogWindow = { kind: 'today' } | { kind: 'yesterday-today' } | { kind: 'custom'; from: string; to: string };
export type WorklogFormat = 'plain' | 'markdown';
export type WorklogOptions = {
  window: WorklogWindow;
  format: WorklogFormat;
  /** The caller's clock. Required so the output is deterministic. */
  now: Date | string | number;
  /** Minutes east of UTC used for day boundaries and clock times. Omitted: the host's local time zone. */
  utcOffsetMinutes?: number;
};

export type ResolvedWindow = { from: string; to: string; startMs: number; endMs: number; days: string[]; label: string; valid: boolean; problem?: string };
export type DraftBullet = { text: string; source: SourceRef; projectId: string | null; day: string; time: string; issue: boolean };
export type ProjectGroup = { projectId: string | null; name: string; bullets: DraftBullet[] };
export type WorklogDraft = {
  kind: 'worklog' | 'standup';
  format: WorklogFormat;
  window: ResolvedWindow;
  bullets: DraftBullet[];
  sources: SourceRef[];
  /** Honest notes about records that could not be placed (no timestamp, unfinished runs). Never bullets. */
  omitted: string[];
  empty: boolean;
  text: string;
};

export const WORKLOG_LIMITS = { titleChars: 160, maxDays: 31, maxBullets: 400, clipboardChars: 20_000 } as const;
export const NO_EVIDENCE_LINE = 'No recorded evidence for this window.';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const KIND_ORDER: Record<WorklogSourceKind, number> = { checkpoint: 0, task: 1, focus: 2, 'routine-run': 3, note: 4 };
const ISSUE_RUN = new Set(['failed', 'partial', 'declined', 'cancelled', 'interrupted', 'missed']);
const UNFINISHED_RUN = new Set(['running', 'paused']);

/* ---------- Time ---------- */

const pad = (n: number) => String(n).padStart(2, '0');
const toMs = (v: Date | string | number): number => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v));
const normOffset = (v: number | undefined): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-840, Math.min(840, Math.round(v))) : undefined);

function dayKeyOf(ms: number, offset: number | undefined): string {
  if (offset === undefined) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  return new Date(ms + offset * 60_000).toISOString().slice(0, 10);
}
function clockOf(ms: number, offset: number | undefined): string {
  if (offset === undefined) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  return new Date(ms + offset * 60_000).toISOString().slice(11, 16);
}
function dayStart(day: string, offset: number | undefined): number {
  const [y, m, d] = day.split('-').map(Number);
  if (offset === undefined) return new Date(y, m - 1, d).getTime();
  return Date.UTC(y, m - 1, d) - offset * 60_000;
}
function validDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Turns a window choice into inclusive local day keys and a half-open [startMs, endMs) instant range. */
export function resolveWindow(window: WorklogWindow, now: Date | string | number, utcOffsetMinutes?: number): ResolvedWindow {
  const offset = normOffset(utcOffsetMinutes);
  const nowMs = toMs(now);
  const invalid = (problem: string): ResolvedWindow => ({ from: '', to: '', startMs: 0, endMs: 0, days: [], label: 'Invalid date range', valid: false, problem });
  if (!Number.isFinite(nowMs)) return invalid('The current time is not available.');
  const today = dayKeyOf(nowMs, offset);
  let from = today, to = today;
  if (window?.kind === 'yesterday-today') from = shiftDay(today, -1);
  else if (window?.kind === 'custom') {
    if (!validDay(window.from) || !validDay(window.to)) return invalid('Choose a start and an end date.');
    from = window.from; to = window.to;
    if (from > to) return invalid('The start date is after the end date.');
  }
  const days: string[] = [];
  for (let d = from; d <= to && days.length <= WORKLOG_LIMITS.maxDays; d = shiftDay(d, 1)) days.push(d);
  if (days.length > WORKLOG_LIMITS.maxDays) return invalid(`Choose at most ${WORKLOG_LIMITS.maxDays} days.`);
  const label = window?.kind === 'yesterday-today' ? `Yesterday and today (${from} to ${to})` : window?.kind === 'custom' ? (from === to ? from : `${from} to ${to}`) : `Today (${today})`;
  return { from, to, startMs: dayStart(from, offset), endMs: dayStart(shiftDay(to, 1), offset), days, label, valid: true };
}

/* ---------- Text ---------- */

/** Single line, no control or bidi-override characters, bounded. Record text is untrusted and cannot fake a source tag. */
export function cleanText(v: unknown, max: number = WORKLOG_LIMITS.titleChars): string {
  if (typeof v !== 'string') return '';
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\[\s*source\s*:/gi, '(source:')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
const escapeMd = (s: string) => s.replace(/([\\`*_[\]<>#|~])/g, '\\$1');
const refLabel = (r: SourceRef) => `${r.kind}:${r.id} @ ${r.at}`;
const validId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

/* ---------- Collection ---------- */

type Ctx = { win: ResolvedWindow; offset?: number; omitted: string[] };

function inWindow(at: unknown, ctx: Ctx): number | null {
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms) || ms < ctx.win.startMs || ms >= ctx.win.endMs) return null;
  return ms;
}

function bullet(ctx: Ctx, kind: WorklogSourceKind, id: string, ms: number, text: string, projectId: unknown, issue = false): DraftBullet {
  return { text, source: { kind, id, at: new Date(ms).toISOString() }, projectId: validId(projectId) ? projectId : null, day: dayKeyOf(ms, ctx.offset), time: clockOf(ms, ctx.offset), issue };
}

function collect(input: WorklogInput, ctx: Ctx): DraftBullet[] {
  const out: DraftBullet[] = [];
  for (const c of input.checkpoints ?? []) {
    if (!validId(c?.id)) continue;
    const ms = inWindow(c.createdAt, ctx);
    if (ms === null) continue;
    const title = cleanText(c.title) || 'Untitled checkpoint';
    const note = cleanText(c.note ?? '', 200);
    out.push(bullet(ctx, 'checkpoint', c.id, ms, `Checkpoint: ${title}${note ? ` — ${note}` : ''}`, c.capsuleId));
  }
  let undatedDone = 0;
  for (const t of input.tasks ?? []) {
    if (!validId(t?.id)) continue;
    const title = cleanText(t.title) || 'Untitled task';
    const created = inWindow(t.createdAt, ctx);
    if (created !== null) out.push(bullet(ctx, 'task', t.id, created, `Added task: ${title}${t.done ? '' : ' (still open)'}`, t.capsuleId));
    if (t.done === true) {
      if (typeof t.completedAt !== 'string' || !Number.isFinite(Date.parse(t.completedAt))) { if (created !== null) undatedDone++; continue; }
      const done = inWindow(t.completedAt, ctx);
      if (done !== null) out.push(bullet(ctx, 'task', t.id, done, `Completed task: ${title}`, t.capsuleId));
    }
  }
  if (undatedDone) ctx.omitted.push(`${undatedDone} task(s) added in this window are marked done but have no recorded completion time, so no completion is listed for them.`);
  for (const f of input.focus ?? []) {
    if (!validId(f?.id)) continue;
    const ms = inWindow(f.endedAt, ctx) ?? inWindow(f.startedAt, ctx);
    if (ms === null) continue;
    const sec = typeof f.actualSec === 'number' && Number.isFinite(f.actualSec) && f.actualSec > 0 ? f.actualSec : 0;
    const dur = sec < 60 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`;
    const on = cleanText(f.taskTitle ?? '');
    out.push(bullet(ctx, 'focus', f.id, ms, `Focus session, ${dur}, ${f.outcome === 'completed' ? 'completed' : 'stopped early'}${on ? `: ${on}` : ''}`, f.capsuleId));
  }
  let unfinished = 0;
  for (const r of input.routineRuns ?? []) {
    if (!validId(r?.id)) continue;
    const status = cleanText(r.status, 20) || 'unknown';
    if (UNFINISHED_RUN.has(status)) { if (inWindow(r.startedAt, ctx) !== null) unfinished++; continue; }
    const ms = inWindow(r.endedAt, ctx) ?? inWindow(r.startedAt, ctx);
    if (ms === null) continue;
    const steps = Array.isArray(r.steps) ? r.steps : [];
    const ok = steps.filter((s) => s?.status === 'succeeded').length;
    const counts = steps.length ? ` (${ok} of ${steps.length} steps succeeded)` : '';
    out.push(bullet(ctx, 'routine-run', r.id, ms, `Routine "${cleanText(r.routineName, 80) || 'Unnamed routine'}" ${status}${counts}`, undefined, ISSUE_RUN.has(status)));
  }
  if (unfinished) ctx.omitted.push(`${unfinished} routine run(s) were still running or paused and have no result yet.`);
  for (const n of input.notes ?? []) {
    if (!validId(n?.id)) continue;
    const ms = inWindow(n.updatedAt, ctx);
    if (ms === null) continue;
    out.push(bullet(ctx, 'note', n.id, ms, `Saved note: ${cleanText(n.title) || 'Untitled note'}`, n.capsuleId));
  }
  out.sort(compareBullets);
  if (out.length > WORKLOG_LIMITS.maxBullets) {
    ctx.omitted.push(`${out.length - WORKLOG_LIMITS.maxBullets} older record(s) were left out to keep the draft short; narrow the window to see them.`);
    return out.slice(out.length - WORKLOG_LIMITS.maxBullets);
  }
  return out;
}

/** Oldest first; ties by kind, then id, then text. Total order, so the same input always gives the same draft. */
export function compareBullets(a: DraftBullet, b: DraftBullet): number {
  if (a.source.at !== b.source.at) return a.source.at < b.source.at ? -1 : 1;
  if (a.source.kind !== b.source.kind) return KIND_ORDER[a.source.kind] - KIND_ORDER[b.source.kind];
  if (a.source.id !== b.source.id) return a.source.id < b.source.id ? -1 : 1;
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Groups bullets by project: named projects alphabetically (then by id), unknown project ids next, unassigned last. */
export function groupByProject(bullets: readonly DraftBullet[], projects: readonly WorklogProject[] = []): ProjectGroup[] {
  const names = new Map(projects.filter((p) => validId(p?.id)).map((p) => [p.id, cleanText(p.name, 80) || 'Untitled project']));
  const groups = new Map<string | null, ProjectGroup>();
  for (const b of bullets) {
    const key = b.projectId;
    const g = groups.get(key) ?? { projectId: key, name: key === null ? 'No project' : names.get(key) ?? `Deleted or unknown project (${key})`, bullets: [] };
    g.bullets.push(b);
    groups.set(key, g);
  }
  const rank = (g: ProjectGroup) => (g.projectId === null ? 2 : names.has(g.projectId) ? 0 : 1);
  return [...groups.values()]
    .map((g) => ({ ...g, bullets: [...g.bullets].sort(compareBullets) }))
    .sort((a, b) => rank(a) - rank(b) || cmpStr(a.name.toLowerCase(), b.name.toLowerCase()) || cmpStr(String(a.projectId), String(b.projectId)));
}

function uniqueSources(bullets: readonly DraftBullet[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const b of bullets) { const k = refLabel(b.source); if (!seen.has(k)) seen.set(k, b.source); }
  return [...seen.values()].sort((a, b) => cmpStr(a.at, b.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || cmpStr(a.id, b.id));
}

/* ---------- Rendering ---------- */

function renderBullet(b: DraftBullet, format: WorklogFormat, showDay: boolean): string {
  const when = showDay ? `${b.day} ${b.time}` : b.time;
  return format === 'markdown'
    ? `- ${when} ${escapeMd(b.text)} — source: \`${refLabel(b.source)}\``
    : `- ${when} ${b.text} [source: ${refLabel(b.source)}]`;
}
function heading(text: string, level: 1 | 2, format: WorklogFormat): string {
  return format === 'markdown' ? `${level === 1 ? '##' : '###'} ${escapeMd(text)}` : level === 1 ? text.toUpperCase() : `${text}:`;
}
function footer(sources: readonly SourceRef[], omitted: readonly string[], format: WorklogFormat): string[] {
  const lines = ['', heading('Evidence', 2, format)];
  if (!sources.length) lines.push(format === 'markdown' ? '_No sources: nothing was recorded in this window._' : 'No sources: nothing was recorded in this window.');
  else sources.forEach((s, i) => lines.push(format === 'markdown' ? `${i + 1}. \`${refLabel(s)}\`` : `${i + 1}. ${refLabel(s)}`));
  for (const o of omitted) lines.push(format === 'markdown' ? `> Not included: ${escapeMd(o)}` : `Not included: ${o}`);
  lines.push(format === 'markdown' ? '_Assembled offline from local records; review before sharing._' : 'Assembled offline from local records; review before sharing.');
  return lines;
}

function prepare(input: WorklogInput | null | undefined, options: WorklogOptions) {
  const offset = normOffset(options.utcOffsetMinutes);
  const win = resolveWindow(options.window, options.now, offset);
  const ctx: Ctx = { win, offset, omitted: [] };
  const format: WorklogFormat = options.format === 'markdown' ? 'markdown' : 'plain';
  const bullets = win.valid ? collect(input ?? {}, ctx) : [];
  if (!win.valid && win.problem) ctx.omitted.push(win.problem);
  return { win, offset, format, bullets, omitted: ctx.omitted, sources: uniqueSources(bullets) };
}

/** Worklog: bullets grouped by project, oldest first within each project. */
export function buildWorklogDraft(input: WorklogInput | null | undefined, options: WorklogOptions): WorklogDraft {
  const { win, format, bullets, omitted, sources } = prepare(input, options);
  const multiDay = win.days.length > 1;
  const lines = [heading(`Worklog — ${win.label}`, 1, format)];
  if (!bullets.length) lines.push('', NO_EVIDENCE_LINE);
  for (const g of groupByProject(bullets, input?.projects ?? [])) {
    lines.push('', heading(g.name, 2, format));
    for (const b of g.bullets) lines.push(renderBullet(b, format, multiDay));
  }
  lines.push(...footer(sources, omitted, format));
  return { kind: 'worklog', format, window: win, bullets, sources, omitted, empty: bullets.length === 0, text: lines.join('\n') };
}

function dayTitle(day: string, win: ResolvedWindow, now: Date | string | number, offset?: number): string {
  const nowMs = toMs(now);
  const today = Number.isFinite(nowMs) ? dayKeyOf(nowMs, offset) : '';
  if (day === today) return `Today (${day})`;
  if (today && day === shiftDay(today, -1)) return `Yesterday (${day})`;
  return win.days.length > 1 ? day : `On ${day}`;
}

/** Standup: one section per day with recorded activity, then routine problems under "Issues recorded". No "next" guesses. */
export function buildStandupDraft(input: WorklogInput | null | undefined, options: WorklogOptions): WorklogDraft {
  const { win, offset, format, bullets, omitted, sources } = prepare(input, options);
  const names = new Map((input?.projects ?? []).filter((p) => validId(p?.id)).map((p) => [p.id, cleanText(p.name, 80)]));
  const tag = (b: DraftBullet): DraftBullet => (b.projectId && names.get(b.projectId) ? { ...b, text: `[${names.get(b.projectId)}] ${b.text}` } : b);
  const lines = [heading(`Standup — ${win.label}`, 1, format)];
  if (!bullets.length) lines.push('', NO_EVIDENCE_LINE);
  const issues = bullets.filter((b) => b.issue);
  for (const day of win.days) {
    const own = bullets.filter((b) => !b.issue && b.day === day);
    if (!own.length) continue;
    lines.push('', heading(dayTitle(day, win, options.now, offset), 2, format));
    for (const b of own) lines.push(renderBullet(tag(b), format, false));
  }
  if (issues.length) {
    lines.push('', heading('Issues recorded', 2, format));
    for (const b of issues) lines.push(renderBullet(tag(b), format, win.days.length > 1));
  }
  lines.push(...footer(sources, omitted, format));
  return { kind: 'standup', format, window: win, bullets, sources, omitted, empty: bullets.length === 0, text: lines.join('\n') };
}

/** Clipboard-ready text: control characters removed, trailing spaces trimmed, blank runs collapsed, bounded, one final newline. */
export function formatForClipboard(draft: WorklogDraft | string, eol: '\n' | '\r\n' = '\n'): string {
  const raw = typeof draft === 'string' ? draft : draft?.text ?? '';
  // eslint-disable-next-line no-control-regex
  let s = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  s = s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > WORKLOG_LIMITS.clipboardChars) s = `${s.slice(0, WORKLOG_LIMITS.clipboardChars - 1)}…`;
  return `${s}\n`.replace(/\n/g, eol);
}

/* ---------- Adapters from persisted shapes ---------- */

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const rec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Defensive mapping of stored routine runs (RoutinesView.runs) to worklog input; malformed records are dropped. */
export function routineRunsFromView(view: unknown): WorklogRoutineRunInput[] {
  const runs = rec(view) && Array.isArray(view.runs) ? view.runs : [];
  const out: WorklogRoutineRunInput[] = [];
  for (const r of runs) {
    if (!rec(r) || !validId(r.id) || typeof r.startedAt !== 'string' || typeof r.status !== 'string') continue;
    const endedAt = str(r.endedAt);
    out.push({
      id: r.id, routineName: str(r.routineName) ?? '', status: r.status, startedAt: r.startedAt,
      ...(endedAt ? { endedAt } : {}),
      steps: Array.isArray(r.steps) ? r.steps.filter(rec).map((s) => ({ status: str(s.status) ?? '' })) : [],
    });
  }
  return out;
}

/** Tasks from AppState. The shared Task shape has no completion time; a completedAt field is used only when present. */
export function tasksFromState(tasks: readonly unknown[]): WorklogTaskInput[] {
  const out: WorklogTaskInput[] = [];
  for (const t of tasks) {
    if (!rec(t) || !validId(t.id) || typeof t.createdAt !== 'string') continue;
    const completedAt = str(t.completedAt), capsuleId = str(t.capsuleId);
    out.push({ id: t.id, title: str(t.title) ?? '', done: t.done === true, createdAt: t.createdAt, ...(completedAt ? { completedAt } : {}), ...(capsuleId ? { capsuleId } : {}) });
  }
  return out;
}
