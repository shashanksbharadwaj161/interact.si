// Feature 35: draft worklog / standup updates from local records only. Pure: no network, no model, no clock unless
// options.now is omitted (then only used to reject windows that start in the future). Every bullet cites a real record.

export type WorklogFormat = 'standup' | 'worklog';
export type WorklogEvidenceKind = 'checkpoint' | 'task' | 'note' | 'focus';
export type WorklogEvidence = { kind: WorklogEvidenceKind; id: string; title: string };
export type WorklogSectionTitle = 'Done' | 'In progress' | 'Blocked/Open';
export type WorklogItem = { text: string; at: string; evidence: WorklogEvidence };
export type WorklogSection = { title: WorklogSectionTitle; items: WorklogItem[] };
export type WorklogDraft = { text: string; sections: WorklogSection[]; evidence: WorklogEvidence[]; empty: boolean };

/** Structural subsets of the AppState / ProductivityState records used by MemoryWorkbench. Extra fields are ignored. */
export type WorklogInput = {
  checkpoints?: readonly { id: string; title: string; createdAt: string; capsuleId?: string; refs?: readonly { kind: string; id: string }[] }[];
  tasks?: readonly { id: string; title: string; done: boolean; createdAt: string; completedAt?: string; updatedAt?: string }[];
  notes?: readonly { id: string; title: string; updatedAt: string; createdAt?: string }[];
  focusSessions?: readonly { id: string; startedAt: string; endedAt: string; actualSec?: number; outcome: 'completed' | 'stopped'; taskId?: string; taskTitle?: string; capsuleId?: string }[];
};
export type WorklogOptions = { since: string; until: string; capsuleId?: string; format: WorklogFormat; /** ISO "now"; defaults to the current time. */ now?: string };

const SECTION_ORDER: WorklogSectionTitle[] = ['Done', 'In progress', 'Blocked/Open'];
const KIND_ORDER: Record<WorklogEvidenceKind, number> = { checkpoint: 0, task: 1, focus: 2, note: 3 };
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseIso(v: unknown, name: string): number {
  if (typeof v !== 'string' || !ISO_LIKE.test(v)) throw new Error(`Worklog window: ${name} must be an ISO date-time string`);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Worklog window: ${name} is not a valid date`);
  return t;
}

const oneLine = (s: unknown, fallback: string) => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return (t || fallback).slice(0, 200);
};
const time = (s: string | undefined): number => (typeof s === 'string' ? Date.parse(s) : NaN);
const fmtMin = (sec: number | undefined) => (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? ` (${Math.round(sec / 60)} min)` : '');

type Row = { section: WorklogSectionTitle; t: number; item: WorklogItem };

/**
 * Builds a deterministic, evidence-backed draft. A record counts when its timestamp t satisfies since <= t < until
 * (half-open window, so adjacent windows never double count). Tasks use completedAt, then updatedAt, then createdAt;
 * notes use updatedAt; checkpoints use createdAt; focus sessions use endedAt.
 * With capsuleId, checkpoints and focus sessions must belong to that capsule; tasks and notes are included only when an
 * in-capsule checkpoint or focus session references them. Returns {text:'',sections:[],evidence:[],empty:true} when
 * nothing matches. Throws on invalid windows (unparseable, since >= until, or since in the future).
 */
export function buildWorklogDraft(input: WorklogInput, options: WorklogOptions): WorklogDraft {
  if (!options || typeof options !== 'object') throw new Error('Worklog window: options are required');
  const since = parseIso(options.since, 'since');
  const until = parseIso(options.until, 'until');
  if (since >= until) throw new Error('Worklog window: since must be earlier than until');
  const now = options.now === undefined ? Date.now() : parseIso(options.now, 'now');
  if (since > now) throw new Error('Worklog window: since is in the future');
  if (options.format !== 'standup' && options.format !== 'worklog') throw new Error("Worklog format must be 'standup' or 'worklog'");
  const capsuleId = typeof options.capsuleId === 'string' && options.capsuleId ? options.capsuleId : undefined;

  const inside = (t: number) => Number.isFinite(t) && t >= since && t < until;
  const arr = <T,>(v: readonly T[] | undefined): readonly T[] => (Array.isArray(v) ? v : []);
  const checkpoints = arr(input?.checkpoints).filter((c) => !capsuleId || c.capsuleId === capsuleId);
  const focus = arr(input?.focusSessions).filter((f) => !capsuleId || f.capsuleId === capsuleId);
  const linkedTasks = new Set<string>(), linkedNotes = new Set<string>();
  if (capsuleId) {
    for (const c of checkpoints) for (const r of arr(c.refs)) { if (r.kind === 'task') linkedTasks.add(r.id); else if (r.kind === 'note') linkedNotes.add(r.id); }
    for (const f of focus) if (f.taskId) linkedTasks.add(f.taskId);
  }

  const rows: Row[] = [];
  const push = (section: WorklogSectionTitle, t: number, at: string, kind: WorklogEvidenceKind, id: string, title: string, text: string) =>
    rows.push({ section, t, item: { text, at, evidence: { kind, id, title } } });

  for (const c of checkpoints) {
    const t = time(c.createdAt);
    if (!inside(t)) continue;
    const title = oneLine(c.title, 'Untitled checkpoint');
    push('Done', t, c.createdAt, 'checkpoint', c.id, title, `Checkpoint: ${title}`);
  }
  for (const k of arr(input?.tasks)) {
    if (capsuleId && !linkedTasks.has(k.id)) continue;
    const at = k.completedAt ?? k.updatedAt ?? k.createdAt;
    const t = time(at);
    if (!inside(t)) continue;
    const title = oneLine(k.title, 'Untitled task');
    if (k.done) push('Done', t, at, 'task', k.id, title, `Completed task: ${title}`);
    else push('Blocked/Open', t, at, 'task', k.id, title, `Open task: ${title}`);
  }
  for (const f of focus) {
    const t = time(f.endedAt);
    if (!inside(t)) continue;
    const title = oneLine(f.taskTitle, 'Focus session');
    if (f.outcome === 'completed') push('Done', t, f.endedAt, 'focus', f.id, title, `Focus completed: ${title}${fmtMin(f.actualSec)}`);
    else push('In progress', t, f.endedAt, 'focus', f.id, title, `Focus stopped early: ${title}${fmtMin(f.actualSec)}`);
  }
  for (const n of arr(input?.notes)) {
    if (capsuleId && !linkedNotes.has(n.id)) continue;
    const t = time(n.updatedAt);
    if (!inside(t)) continue;
    const title = oneLine(n.title, 'Untitled note');
    push('In progress', t, n.updatedAt, 'note', n.id, title, `Updated note: ${title}`);
  }

  if (!rows.length) return { text: '', sections: [], evidence: [], empty: true };

  rows.sort((a, b) => a.t - b.t || KIND_ORDER[a.item.evidence.kind] - KIND_ORDER[b.item.evidence.kind] || (a.item.evidence.id < b.item.evidence.id ? -1 : a.item.evidence.id > b.item.evidence.id ? 1 : 0));
  const sections: WorklogSection[] = SECTION_ORDER
    .map((title) => ({ title, items: rows.filter((r) => r.section === title).map((r) => r.item) }))
    .filter((s) => s.items.length > 0);
  const evidence = sections.flatMap((s) => s.items.map((i) => i.evidence));

  const windowLabel = `${new Date(since).toISOString()} → ${new Date(until).toISOString()}${capsuleId ? ` · project ${capsuleId}` : ''}`;
  const lines: string[] = [];
  if (options.format === 'worklog') {
    lines.push('# Worklog', '', `_Window: ${windowLabel}_`);
    for (const s of sections) {
      lines.push('', `## ${s.title}`);
      for (const i of s.items) lines.push(`- ${i.at} — ${i.text} [${i.evidence.kind}:${i.evidence.id}]`);
    }
  } else {
    lines.push(`**Standup** (${windowLabel})`);
    for (const s of sections) {
      lines.push('', `**${s.title}**`);
      for (const i of s.items) lines.push(`- ${i.text} [${i.evidence.kind}:${i.evidence.id}]`);
    }
  }
  return { text: lines.join('\n') + '\n', sections, evidence, empty: false };
}
