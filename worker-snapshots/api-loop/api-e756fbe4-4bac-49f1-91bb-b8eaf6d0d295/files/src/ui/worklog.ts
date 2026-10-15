// Worklog and standup draft composer (feature 35). Pure and deterministic: no clock (callers pass `now`), no I/O,
// no network, no model. Every line is built from one stored record and carries an evidence reference to it; when a
// record cannot back a line it is left out and reported in `warnings` instead. Nothing is summarized or invented.

export type WorklogFormat = 'worklog' | 'standup';
export type WorklogEvidenceKind = 'task' | 'note' | 'activity' | 'chat' | 'capsule';
export type WorklogEvidence = { kind: WorklogEvidenceKind; id: string; at: string };
export type WorklogLine = { text: string; evidence: WorklogEvidence[] };
export type WorklogSection = { heading: string; lines: WorklogLine[] };
export type WorklogDraft = { sections: WorklogSection[]; plainText: string; warnings: string[] };

/** Structural subset of AppState. Every field is optional; malformed entries are skipped and counted. */
export type WorklogState = {
  tasks?: readonly unknown[];
  notes?: readonly unknown[];
  activity?: readonly unknown[];
  chat?: readonly unknown[];
  capsules?: readonly unknown[];
};

export type WorklogOptions = {
  /** Inclusive start of the range (ISO date-time). */
  from: string;
  /** Exclusive end of the range (ISO date-time). */
  to: string;
  format: WorklogFormat;
  /** Chat history is excluded unless this is exactly true. */
  includeChat?: boolean;
  /** Only records linked to this capsule: the capsule itself, referenced notes/tasks, notes tagged with its name, activity naming it. */
  capsuleId?: string;
  /** Explicit capsule references (for example from the productivity sidecar). */
  capsuleRefs?: { noteIds?: readonly string[]; taskIds?: readonly string[] };
  /** Reference time for "overdue" (ISO). Defaults to `to`, so the result depends only on the inputs. */
  now?: string;
  /** Group by local calendar day instead of UTC day. Defaults to false (UTC) for reproducible output. */
  localDays?: boolean;
  /** Append [kind:id] to every line in plainText. Defaults to true. */
  withSources?: boolean;
};

export const WORKLOG_LIMITS = { maxRangeDays: 92, linesPerSection: 200, textChars: 140, itemsPerKind: 5000 };
export const WORKLOG_DRAFT_TAG = 'worklog-draft';
export const STANDUP_HEADINGS = ['Yesterday', 'Today', 'Blockers'] as const;
const DAY_MS = 86_400_000;
const DRAFT_HEAD = 'DRAFT — assembled from local records only; review before sharing.';

// C0/C1 controls, zero-width and bidi override/isolate characters, BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const items = (v: unknown): Obj[] => (Array.isArray(v) ? v.slice(0, WORKLOG_LIMITS.itemsPerKind).filter(isObj) : []);
const clean = (v: unknown, n = WORKLOG_LIMITS.textChars): string => {
  if (typeof v !== 'string') return '';
  const s = v.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
};
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
/** Parses an ISO-ish date; NaN for anything that is not a non-empty string Date.parse accepts. */
const ms = (v: unknown): number => (typeof v === 'string' && v.trim() && v.length <= 64 ? Date.parse(v) : NaN);
const iso = (t: number) => new Date(t).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');

function dayKey(t: number, local: boolean): string {
  const d = new Date(t);
  return local ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : d.toISOString().slice(0, 10);
}

type Item = { at: number; line: WorklogLine };

function emptyDraft(warnings: string[], format: WorklogFormat): WorklogDraft {
  const sections = format === 'standup' ? STANDUP_HEADINGS.map((heading) => ({ heading, lines: [] as WorklogLine[] })) : [];
  return { sections, plainText: render(sections, '(invalid range)', true), warnings };
}

function render(sections: WorklogSection[], title: string, withSources: boolean): string {
  const out = [DRAFT_HEAD, title];
  for (const s of sections) {
    out.push('', s.heading);
    if (!s.lines.length) out.push('- (nothing recorded)');
    for (const l of s.lines) out.push(`- ${l.text}${withSources ? ` [${l.evidence.map((e) => `${e.kind}:${e.id}`).join(', ')}]` : ''}`);
  }
  if (!sections.length) out.push('', '(No recorded activity in this range.)');
  return out.join('\n');
}

/** Composes an evidence-backed worklog or standup draft for [from, to). */
export function composeWorklog(state: WorklogState | null | undefined, options: WorklogOptions): WorklogDraft {
  const opts: Partial<WorklogOptions> = isObj(options) ? options : {};
  const format: WorklogFormat = opts.format === 'standup' ? 'standup' : 'worklog';
  const warnings: string[] = [];
  const from = ms(opts.from), to = ms(opts.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return emptyDraft(['The date range is invalid: "from" and "to" must be valid dates.'], format);
  if (to <= from) return emptyDraft(['The date range is empty: "to" must be after "from".'], format);
  if (to - from > WORKLOG_LIMITS.maxRangeDays * DAY_MS) return emptyDraft([`The date range is longer than ${WORKLOG_LIMITS.maxRangeDays} days; choose a shorter range.`], format);
  const nowParsed = opts.now === undefined ? NaN : ms(opts.now);
  if (opts.now !== undefined && Number.isNaN(nowParsed)) warnings.push('The reference time is invalid; the end of the range is used for overdue checks.');
  const now = Number.isNaN(nowParsed) ? to : nowParsed;
  const local = opts.localDays === true;
  const withSources = opts.withSources !== false;
  const inRange = (t: number) => !Number.isNaN(t) && t >= from && t < to;

  const s: Obj = isObj(state) ? (state as Obj) : {};
  let skipped = 0;
  const valid = (o: Obj) => (typeof o.id === 'string' && ID_RE.test(o.id) ? true : (skipped++, false));
  const tasks = items(s.tasks).filter(valid);
  const notes = items(s.notes).filter(valid).filter((n) => !(Array.isArray(n.tags) && n.tags.some((t) => typeof t === 'string' && t.toLowerCase() === WORKLOG_DRAFT_TAG)));
  const activity = items(s.activity).filter(valid);
  const capsules = items(s.capsules).filter(valid);
  const chat = opts.includeChat === true ? items(s.chat).filter(valid) : [];

  // Capsule scope: only explicit links count; nothing is associated by guessing.
  let scope: null | { capsule: Obj; name: string; notes: Set<string>; tasks: Set<string> } = null;
  if (typeof opts.capsuleId === 'string' && opts.capsuleId) {
    const capsule = capsules.find((c) => c.id === opts.capsuleId);
    if (!capsule) return emptyDraft([`The selected capsule no longer exists; nothing was drafted.`], format);
    const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    scope = { capsule, name: clean(capsule.name, 120), notes: ids(opts.capsuleRefs?.noteIds), tasks: ids(opts.capsuleRefs?.taskIds) };
  }
  const nameKey = scope ? fold(scope.name) : '';
  const noteInScope = (n: Obj) => !scope || scope.notes.has(n.id as string) || (!!nameKey && Array.isArray(n.tags) && n.tags.some((t) => typeof t === 'string' && fold(t) === nameKey));
  const taskInScope = (t: Obj) => !scope || scope.tasks.has(t.id as string);
  const activityInScope = (a: Obj) => {
    if (!scope) return true;
    const hay = `${typeof a.summary === 'string' ? a.summary : ''} ${typeof a.details === 'string' ? a.details : ''}`;
    return hay.includes(scope.capsule.id as string) || (!!scope.name && hay.includes(`"${scope.name}"`));
  };
  const chatInScope = (m: Obj) => !scope || (!!nameKey && typeof m.text === 'string' && fold(m.text).includes(nameKey));

  const ev = (kind: WorklogEvidenceKind, id: unknown, t: number): WorklogEvidence => ({ kind, id: id as string, at: iso(t) });
  const mk = (kind: WorklogEvidenceKind, o: Obj, t: number, text: string): Item => ({ at: t, line: { text, evidence: [ev(kind, o.id, t)] } });

  // Completed tasks: dated by completedAt/updatedAt when such a field exists, otherwise by creation time (reported once).
  let undatedDone = 0;
  const completed: Item[] = [];
  for (const t of tasks) {
    if (t.done !== true || !taskInScope(t)) continue;
    const explicit = [ms(t.completedAt), ms(t.updatedAt)].find((x) => !Number.isNaN(x));
    const at = explicit ?? ms(t.createdAt);
    if (Number.isNaN(at)) { skipped++; continue; }
    if (!inRange(at)) continue;
    if (explicit === undefined) undatedDone++;
    const title = clean(t.title);
    if (!title) { skipped++; continue; }
    completed.push(mk('task', t, at, `Completed task: ${title}`));
  }
  const edited: Item[] = [];
  for (const n of notes) {
    if (!noteInScope(n)) continue;
    const at = ms(n.updatedAt);
    if (Number.isNaN(at)) { skipped++; continue; }
    if (inRange(at)) edited.push(mk('note', n, at, `Edited note: ${clean(n.title) || 'Untitled note'}`));
  }
  const logged: Item[] = [];
  for (const a of activity) {
    if (!activityInScope(a)) continue;
    const at = ms(a.at);
    if (Number.isNaN(at)) { skipped++; continue; }
    if (!inRange(at)) continue;
    const summary = clean(a.summary);
    if (!summary) { skipped++; continue; }
    const kind = clean(a.kind, 32);
    logged.push(mk('activity', a, at, kind ? `${kind}: ${summary}` : summary));
  }
  const capsuleItems: Item[] = [];
  for (const c of scope ? [scope.capsule] : capsules) {
    const at = ms(c.updatedAt);
    if (inRange(at)) capsuleItems.push(mk('capsule', c, at, `Updated capsule: ${clean(c.name) || 'Untitled capsule'}`));
  }
  const chatItems: Item[] = [];
  for (const m of chat) {
    if (!chatInScope(m)) continue;
    const at = ms(m.createdAt);
    if (Number.isNaN(at)) { skipped++; continue; }
    const text = clean(m.text, 100);
    if (inRange(at) && text) chatItems.push(mk('chat', m, at, `Chat (${m.role === 'user' ? 'you' : 'assistant'}): ${text}`));
  }

  const byTime = (a: Item, b: Item) => a.at - b.at || (a.line.evidence[0].id < b.line.evidence[0].id ? -1 : a.line.evidence[0].id > b.line.evidence[0].id ? 1 : 0);
  const cap = (list: Item[], heading: string): WorklogLine[] => {
    if (list.length > WORKLOG_LIMITS.linesPerSection) warnings.push(`${heading}: ${list.length - WORKLOG_LIMITS.linesPerSection} more line(s) were left out; choose a shorter range.`);
    return list.slice(0, WORKLOG_LIMITS.linesPerSection).map((i) => i.line);
  };

  let sections: WorklogSection[];
  let title: string;
  const rangeLabel = `${dayKey(from, local)} → ${dayKey(to - 1, local)}`;
  if (format === 'standup') {
    title = `Standup ${rangeLabel}`;
    const done = [...completed, ...edited, ...capsuleItems, ...chatItems].sort(byTime);
    const today: Item[] = [];
    const blockers: Item[] = [];
    for (const t of tasks) {
      if (t.done === true || !taskInScope(t)) continue;
      const title = clean(t.title);
      if (!title) continue;
      const due = ms(t.due);
      const created = ms(t.createdAt);
      if (!Number.isNaN(due) && due < now) {
        blockers.push({ at: due, line: { text: `Overdue task: ${title} (due ${dayKey(due, local)})`, evidence: [ev('task', t.id, due)] } });
      } else if (!Number.isNaN(due) && due >= from && due < to + DAY_MS) {
        today.push({ at: due, line: { text: `Due task: ${title} (due ${dayKey(due, local)})`, evidence: [ev('task', t.id, due)] } });
      } else if (inRange(created)) {
        today.push({ at: created, line: { text: `Open task added: ${title}`, evidence: [ev('task', t.id, created)] } });
      }
    }
    sections = [
      { heading: 'Yesterday', lines: cap(done, 'Yesterday') },
      { heading: 'Today', lines: cap(today.sort(byTime), 'Today') },
      { heading: 'Blockers', lines: cap(blockers.sort(byTime), 'Blockers') },
    ];
    for (const sec of sections) if (!sec.lines.length) warnings.push(`${sec.heading}: no recorded evidence for this section.`);
  } else {
    title = `Worklog ${rangeLabel}`;
    const all = [...completed, ...edited, ...logged, ...capsuleItems, ...chatItems].sort(byTime);
    const days = new Map<string, Item[]>();
    for (const i of all) {
      const k = dayKey(i.at, local);
      const list = days.get(k) ?? [];
      list.push(i);
      days.set(k, list);
    }
    sections = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([heading, list]) => ({ heading, lines: cap(list, heading) }));
  }

  // Invariant: every line carries evidence. Anything else is dropped and reported rather than kept unsourced.
  for (const sec of sections) {
    const before = sec.lines.length;
    sec.lines = sec.lines.filter((l) => l.evidence.length > 0 && l.evidence.every((e) => ID_RE.test(e.id) && !Number.isNaN(Date.parse(e.at))));
    if (sec.lines.length < before) warnings.push(`${sec.heading}: ${before - sec.lines.length} line(s) without evidence were left out.`);
  }
  const total = sections.reduce((n, sec) => n + sec.lines.length, 0);
  if (total === 0) warnings.unshift(`No recorded evidence between ${iso(from)} and ${iso(to)}${scope ? ` for capsule "${scope.name}"` : ''}; nothing was drafted.`);
  if (undatedDone) warnings.push(`${undatedDone} completed task(s) have no completion time; they are dated by when they were created.`);
  if (skipped) warnings.push(`${skipped} record(s) with a missing id, title or date were skipped.`);
  if (opts.includeChat !== true && items(s.chat).length) warnings.push('Chat history is excluded. Turn on "Include chat" to add it.');
  return { sections, plainText: render(sections, title, withSources), warnings };
}

/** Local-day range presets for the drafts screen: [from, to) as ISO strings. `nowMs` is supplied by the caller. */
export type WorklogPreset = 'today' | 'yesterday' | 'last7';
export function presetRange(preset: WorklogPreset, nowMs: number): { from: string; to: string } {
  const d = new Date(nowMs);
  const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
  const start = (offset: number) => new Date(y, m, day + offset).toISOString();
  if (preset === 'yesterday') return { from: start(-1), to: start(0) };
  if (preset === 'last7') return { from: start(-6), to: start(1) };
  return { from: start(0), to: start(1) };
}

/** Title for a saved draft note (the note store caps titles at 200 characters). */
export function draftNoteTitle(format: WorklogFormat, from: string, to: string): string {
  const f = ms(from), t = ms(to);
  const range = Number.isNaN(f) || Number.isNaN(t) ? '' : ` ${dayKey(f, true)}${t - f > DAY_MS ? ` – ${dayKey(t - 1, true)}` : ''}`;
  return `${format === 'standup' ? 'Standup draft' : 'Worklog draft'}${range}`.slice(0, 200);
}
