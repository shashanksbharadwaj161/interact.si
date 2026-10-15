// Worklog and standup drafts assembled only from records already stored on this computer: checkpoints, notes, tasks,
// focus sessions and routine run results. No model, no filesystem and no network: the store reader and the clock are
// injected. Every drafted line cites at least one real record (kind, id, ISO time); a record that cannot be verified
// (missing id or time) is left out and counted, never guessed. Output is bounded in lines and bytes, titles are
// stripped of control and bidi characters, and every date is rendered as ISO 8601 UTC (no locale formatting).
import {ValidationError} from './validation';
import type {WorklogDraft, WorklogDraftKind, WorklogEvidence, WorklogEvidenceKind, WorklogItem, WorklogRange} from '../../src/shared/contracts';

export const WORKLOG_LIMITS = {
  /** Most lines in one draft; further evidence is counted as omitted. */
  maxItems: 50,
  /** Largest Markdown draft in UTF-8 bytes. */
  maxBytes: 20 * 1024,
  /** Longest title or detail taken from a record. */
  labelChars: 160,
  detailChars: 200,
  /** Longest range accepted by the pure draft functions. */
  maxRangeDays: 31,
  /** Records looked at per draft; the store is bounded far below this. */
  maxRecords: 20_000,
} as const;

export const WORKLOG_KINDS: readonly WorklogEvidenceKind[] = ['checkpoint', 'note', 'task', 'focus', 'routine'];
export const WORKLOG_RANGES: readonly WorklogRange[] = ['today', 'yesterday', 'last7'];
export const WORKLOG_DRAFT_KINDS: readonly WorklogDraftKind[] = ['worklog', 'standup'];

/** One stored record offered as evidence. Values are untrusted until draftWorklog/draftStandup check them. */
export type WorklogRecord = {
  kind: WorklogEvidenceKind;
  id: unknown;
  at: unknown;
  title: unknown;
  detail?: unknown;
  /** Standup bucket: done (finished work), open (next up), blocked (needs attention). Defaults to done. */
  state?: 'done' | 'open' | 'blocked';
};

export type WorklogInput = {since: string; until: string; evidence: readonly WorklogRecord[]};

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DAY_MS = 86_400_000;

/** Removes control, zero-width and bidi characters, collapses whitespace to single spaces and bounds the length. */
export function sanitizeLabel(raw: unknown, max: number = WORKLOG_LIMITS.labelChars): string {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Strict ISO time: parses, then renders as toISOString (UTC, no locale). Null when it does not parse. */
export function isoTime(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function parseRange(since: unknown, until: unknown): {since: string; until: string; from: number; to: number} {
  const s = isoTime(since), u = isoTime(until);
  if (!s || !u) throw new ValidationError('The draft range needs a valid start and end time');
  const from = Date.parse(s), to = Date.parse(u);
  if (to <= from) throw new ValidationError('The draft range must end after it starts');
  if (to - from > WORKLOG_LIMITS.maxRangeDays * DAY_MS) throw new ValidationError(`The draft range can cover at most ${WORKLOG_LIMITS.maxRangeDays} days`);
  return {since: s, until: u, from, to};
}

const PREFIX: Record<WorklogEvidenceKind, string> = {checkpoint: 'Checkpoint', note: 'Updated note', task: 'Task', focus: 'Focus session', routine: 'Routine run'};
const LABEL_KIND: Record<WorklogEvidenceKind, string> = {checkpoint: 'checkpoint', note: 'note', task: 'task', focus: 'focus', routine: 'routine'};

type Line = {item: WorklogItem; state: 'done' | 'open' | 'blocked'; day: string};

function lineText(kind: WorklogEvidenceKind, state: Line['state'], title: string, detail: string): string {
  let prefix = PREFIX[kind];
  if (kind === 'task') prefix = state === 'done' ? 'Task done' : 'Task added';
  return `${prefix}: ${title}${detail ? ` (${detail})` : ''}`;
}

const cite = (e: WorklogEvidence) => `[${e.kind}:${e.id} @ ${e.at}]`;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * Checks each record and turns the ones inside [since, until) into lines. A record without a valid id or time has
 * no verifiable evidence and is counted, not drafted. Records outside the range are simply not part of this draft.
 */
function collect(input: WorklogInput): {range: ReturnType<typeof parseRange>; lines: Line[]; unverifiable: number} {
  if (typeof input !== 'object' || input === null) throw new ValidationError('Draft input must be an object');
  const range = parseRange(input.since, input.until);
  if (!Array.isArray(input.evidence)) throw new ValidationError('Draft evidence must be a list');
  const lines: Line[] = [];
  let unverifiable = Math.max(0, input.evidence.length - WORKLOG_LIMITS.maxRecords);
  for (const r of input.evidence.slice(0, WORKLOG_LIMITS.maxRecords)) {
    if (typeof r !== 'object' || r === null || !WORKLOG_KINDS.includes(r.kind)) { unverifiable++; continue; }
    const at = isoTime(r.at);
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || !at) { unverifiable++; continue; }
    const t = Date.parse(at);
    if (t < range.from || t >= range.to) continue;
    const title = sanitizeLabel(r.title) || '(untitled)';
    const detail = sanitizeLabel(r.detail, WORKLOG_LIMITS.detailChars);
    const state = r.state === 'open' || r.state === 'blocked' ? r.state : 'done';
    const evidence: WorklogEvidence = {kind: r.kind, id: r.id, at, label: `${LABEL_KIND[r.kind]}: ${title}`.slice(0, WORKLOG_LIMITS.labelChars + 20)};
    lines.push({item: {text: lineText(r.kind, state, title, detail), evidence: [evidence]}, state, day: at.slice(0, 10)});
  }
  // Deterministic order: time, then kind, then id.
  lines.sort((a, b) => {
    const x = a.item.evidence[0], y = b.item.evidence[0];
    return x.at < y.at ? -1 : x.at > y.at ? 1 : x.kind < y.kind ? -1 : x.kind > y.kind ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return {range, lines, unverifiable};
}

function omittedReason(unverifiable: number, overLimit: number): string {
  const parts: string[] = [];
  if (unverifiable) parts.push(`${unverifiable} record(s) had no verifiable id or time and were left out`);
  if (overLimit) parts.push(`${overLimit} line(s) did not fit the ${WORKLOG_LIMITS.maxItems}-line / ${WORKLOG_LIMITS.maxBytes / 1024} KB limit`);
  return parts.length ? `${parts.join('; ')}.` : 'Nothing was left out.';
}

const EMPTY_TEXT = (kind: WorklogDraftKind, since: string, until: string) =>
  `No checkpoints, notes, tasks, focus sessions or routine runs were recorded between ${since} and ${until}, so there is nothing to put in a ${kind === 'standup' ? 'standup update' : 'worklog'}. Nothing was invented.`;

/**
 * Renders sections of lines into bounded Markdown. Lines are added in order until the item or byte limit is reached;
 * the rest are counted as omitted. Every emitted line ends with its citation.
 */
function render(kind: WorklogDraftKind, input: WorklogInput, sections: (lines: Line[]) => {heading: string; lines: Line[]}[]): WorklogDraft {
  const {range, lines, unverifiable} = collect(input);
  const base = {kind, since: range.since, until: range.until};
  if (!lines.length) {
    return {...base, status: 'empty', markdown: '', items: [], omitted: {reason: omittedReason(unverifiable, 0), count: unverifiable}, truncated: false, explanation: EMPTY_TEXT(kind, range.since, range.until)};
  }
  const title = kind === 'standup' ? 'Standup update' : 'Worklog';
  const head = [`# ${title}: ${range.since} to ${range.until}`, '', `_Drafted from local records only. Each line cites its source record. Times are ISO 8601 UTC._`];
  let out = head.join('\n');
  const items: WorklogItem[] = [];
  let overLimit = 0;
  const footerReserve = 400; // room for the omitted-count footer
  for (const sec of sections(lines)) {
    if (!sec.lines.length) continue;
    let headed = false;
    for (const l of sec.lines) {
      const add = `${headed ? '' : `\n\n## ${sec.heading}\n`}\n- ${l.item.text} ${l.item.evidence.map(cite).join(' ')}`;
      if (items.length >= WORKLOG_LIMITS.maxItems || byteLength(out + add) > WORKLOG_LIMITS.maxBytes - footerReserve) { overLimit++; continue; }
      out += add;
      headed = true;
      items.push(l.item);
    }
  }
  const count = unverifiable + overLimit;
  if (count) out += `\n\n_Left out: ${omittedReason(unverifiable, overLimit)}_`;
  out += '\n';
  return {...base, status: 'ready', markdown: out, items, omitted: {reason: omittedReason(unverifiable, overLimit), count}, truncated: overLimit > 0};
}

/** Worklog: every in-range record, grouped by UTC day, oldest first. */
export function draftWorklog(input: WorklogInput): WorklogDraft {
  return render('worklog', input, (lines) => {
    const days = [...new Set(lines.map((l) => l.day))];
    return days.map((d) => ({heading: d, lines: lines.filter((l) => l.day === d)}));
  });
}

/** Standup: done, next (open tasks) and needs-attention (failed routine runs), each oldest first. */
export function draftStandup(input: WorklogInput): WorklogDraft {
  return render('standup', input, (lines) => [
    {heading: 'Done', lines: lines.filter((l) => l.state === 'done')},
    {heading: 'Next', lines: lines.filter((l) => l.state === 'open')},
    {heading: 'Needs attention', lines: lines.filter((l) => l.state === 'blocked')},
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// Store adapter. The reader returns plain snapshots; nothing here writes.

export type WorklogSource = {
  notes?: readonly {id: string; title: string; updatedAt: string}[];
  tasks?: readonly {id: string; title: string; done: boolean; due?: string; createdAt: string}[];
  checkpoints?: readonly {id: string; title: string; note: string; createdAt: string}[];
  focus?: readonly {id: string; endedAt: string; actualSec: number; outcome: string; taskTitle?: string}[];
  runs?: readonly {id: string; routineName: string; status: string; startedAt: string; endedAt?: string; reason?: string}[];
};

const BLOCKED_RUNS = new Set(['failed', 'partial', 'declined', 'interrupted', 'missed']);
const firstLine = (s: unknown) => (typeof s === 'string' ? s.split('\n').find((l) => l.trim()) ?? '' : '');

/** Maps store snapshots to evidence records. Fields are passed through unchecked; the draft functions verify them. */
export function collectEvidence(src: WorklogSource): WorklogRecord[] {
  const out: WorklogRecord[] = [];
  for (const c of src.checkpoints ?? []) out.push({kind: 'checkpoint', id: c.id, at: c.createdAt, title: c.title, detail: firstLine(c.note)});
  for (const n of src.notes ?? []) out.push({kind: 'note', id: n.id, at: n.updatedAt, title: n.title});
  for (const t of src.tasks ?? []) out.push({kind: 'task', id: t.id, at: t.createdAt, title: t.title, detail: !t.done && t.due ? `due ${isoTime(t.due) ?? sanitizeLabel(t.due, 40)}` : '', state: t.done ? 'done' : 'open'});
  for (const f of src.focus ?? []) {
    const mins = Number.isFinite(f.actualSec) ? Math.max(0, Math.round(f.actualSec / 60)) : 0;
    out.push({kind: 'focus', id: f.id, at: f.endedAt, title: f.taskTitle || 'Focus session', detail: `${mins} min, ${f.outcome === 'completed' ? 'completed' : 'stopped early'}`});
  }
  for (const r of src.runs ?? []) {
    if (r.status === 'running' || r.status === 'paused') continue;
    out.push({kind: 'routine', id: r.id, at: r.endedAt ?? r.startedAt, title: r.routineName || 'Routine', detail: `${r.status}${r.reason ? `: ${r.reason}` : ''}`, state: BLOCKED_RUNS.has(r.status) ? 'blocked' : 'done'});
  }
  return out;
}

/** Local-day range for the UI choices, computed from the injected clock. until is exclusive. */
export function rangeBounds(range: WorklogRange, now: Date): {since: string; until: string} {
  const midnight = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 0, 0, 0, 0);
  switch (range) {
    case 'today': return {since: midnight(0).toISOString(), until: midnight(1).toISOString()};
    case 'yesterday': return {since: midnight(-1).toISOString(), until: midnight(0).toISOString()};
    case 'last7': return {since: midnight(-6).toISOString(), until: midnight(1).toISOString()};
  }
}

/** Parses IPC options {range, kind}; unknown keys and values are refused. */
export function parseDraftOptions(raw: unknown): {range: WorklogRange; kind: WorklogDraftKind} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError('Draft options must be an object');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'range' && k !== 'kind') throw new ValidationError(`Unknown draft option: ${k.slice(0, 30)}`);
  if (!WORKLOG_RANGES.includes(o.range as WorklogRange)) throw new ValidationError('range must be today, yesterday or last7');
  const kind = o.kind === undefined ? 'worklog' : o.kind;
  if (!WORKLOG_DRAFT_KINDS.includes(kind as WorklogDraftKind)) throw new ValidationError('kind must be worklog or standup');
  return {range: o.range as WorklogRange, kind: kind as WorklogDraftKind};
}

export class WorklogService {
  constructor(private opts: {read: () => WorklogSource; now: () => Date}) {}

  /** Read-only: builds a draft from the current snapshots. Nothing is stored. */
  draft(options: unknown): WorklogDraft {
    const {range, kind} = parseDraftOptions(options);
    const {since, until} = rangeBounds(range, this.opts.now());
    const evidence = collectEvidence(this.opts.read());
    return kind === 'standup' ? draftStandup({since, until, evidence}) : draftWorklog({since, until, evidence});
  }
}
