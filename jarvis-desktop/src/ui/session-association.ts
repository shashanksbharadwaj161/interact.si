/**
 * Goal 36: task/project association for recorded sessions (application timeline entries and focus sessions).
 * Pure and DOM-free: ranks deterministic suggestions, applies a manual correction immutably and lists corrections.
 * Persistence goes through the existing productivity `association.set` / `association.clear` operations
 * (see toAssociationOp); nothing here reads files, the network or a model.
 */

export const ASSOCIATION_LIMITS = Object.freeze({
  /** Most suggestion chips shown for one session. */
  maxSuggestions: 5,
  /** Checkpoints and task times within this many minutes of the session window count as "near". */
  nearMinutes: 120,
  /** Nearby checkpoints counted per capsule. */
  maxCheckpointHits: 3,
  /** Shortest title word that counts for token overlap. */
  minTokenLength: 3,
  /** Session/task titles longer than this are cut before tokenizing. */
  titleChars: 200,
  /** Most sessions offered for association in one list. */
  maxSessions: 200,
});

export type AssocTask = { id: string; title: string; createdAt: string; completedAt?: string; done?: boolean };
export type AssocCapsule = { id: string; name: string };
export type AssocCheckpoint = { id: string; createdAt: string; capsuleId?: string; title?: string };
export type AssocSessionKind = 'timeline' | 'focus';
export type AssocSession = {
  id: string;
  kind: AssocSessionKind;
  startedAt: string;
  endedAt?: string;
  title: string;
  taskId?: string;
  capsuleId?: string;
  /** What the recorder stored (focus sessions only); shown again when the user clears a correction. */
  recordedTaskId?: string;
  recordedCapsuleId?: string;
  correctedAt?: string;
  correctedBy?: 'user';
};
export type AssociationSuggestion = { kind: 'task' | 'capsule'; id: string; label: string; score: number; reasons: string[] };
export type AssociationChange = { taskId?: string | null; capsuleId?: string | null; reason: 'manual' };
export type AssociationCorrection = { sessionId: string; kind: AssocSessionKind; title: string; taskId?: string; capsuleId?: string; correctedAt: string };
export type AssociationOp = { op: 'association.set'; sessionId: string; taskId?: string; capsuleId?: string } | { op: 'association.clear'; sessionId: string };

type SourceTimeline = { id: string; at: string; endedAt?: string; app: string; title?: string };
type SourceFocus = { id: string; startedAt: string; endedAt: string; taskId?: string; taskTitle?: string; capsuleId?: string };
type SourceAssociation = { sessionId: string; taskId?: string; capsuleId?: string; at: string };

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'this', 'that', 'session', 'focus', 'task']);

function tokens(text: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const w of String(text ?? '').slice(0, ASSOCIATION_LIMITS.titleChars).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= ASSOCIATION_LIMITS.minTokenLength && !STOP.has(w)) out.add(w);
  }
  return out;
}

const shared = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).sort();
const ms = (iso: string | undefined) => (iso === undefined ? NaN : Date.parse(iso));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Ranks tasks and capsules for one session. Signals: task completed or created near the session window, a task's
 * created→completed span covering the window, capsule checkpoints near the window, and title word overlap.
 * Sorted by score (highest first), then id, then kind, so identical input always gives identical output.
 */
export function suggestAssociations(
  session: AssocSession,
  ctx: { tasks?: readonly AssocTask[]; capsules?: readonly AssocCapsule[]; checkpoints?: readonly AssocCheckpoint[] },
): AssociationSuggestion[] {
  const start = ms(session.startedAt);
  if (Number.isNaN(start)) return [];
  const endRaw = ms(session.endedAt);
  const end = Number.isNaN(endRaw) || endRaw < start ? start : endRaw;
  const near = ASSOCIATION_LIMITS.nearMinutes * 60_000;
  const inWindow = (t: number) => !Number.isNaN(t) && t >= start - near && t <= end + near;
  const words = tokens(session.title);
  const out: AssociationSuggestion[] = [];

  for (const t of ctx.tasks ?? []) {
    if (!t || typeof t.id !== 'string' || t.id === session.taskId) continue;
    let score = 0;
    const reasons: string[] = [];
    const created = ms(t.createdAt), completed = ms(t.completedAt);
    if (inWindow(completed)) { score += 3; reasons.push('completed near this session'); }
    if (inWindow(created)) { score += 2; reasons.push('created near this session'); }
    else if (!Number.isNaN(created) && !Number.isNaN(completed) && created <= start && completed >= end) { score += 1; reasons.push('open during this session'); }
    const w = shared(words, tokens(t.title));
    if (w.length) { score += 2 * w.length; reasons.push(`title words: ${w.join(', ')}`); }
    if (score > 0) out.push({ kind: 'task', id: t.id, label: String(t.title ?? '').slice(0, ASSOCIATION_LIMITS.titleChars), score, reasons });
  }

  for (const c of ctx.capsules ?? []) {
    if (!c || typeof c.id !== 'string' || c.id === session.capsuleId) continue;
    let score = 0;
    const reasons: string[] = [];
    const hits = (ctx.checkpoints ?? []).filter((cp) => cp && cp.capsuleId === c.id && inWindow(ms(cp.createdAt)));
    const n = Math.min(hits.length, ASSOCIATION_LIMITS.maxCheckpointHits);
    if (n) { score += 2 * n; reasons.push(`${n} checkpoint(s) near this session`); }
    const w = shared(words, tokens(c.name));
    if (w.length) { score += 2 * w.length; reasons.push(`name words: ${w.join(', ')}`); }
    if (score > 0) out.push({ kind: 'capsule', id: c.id, label: String(c.name ?? '').slice(0, ASSOCIATION_LIMITS.titleChars), score, reasons });
  }

  return out.sort((a, b) => b.score - a.score || cmp(a.id, b.id) || cmp(a.kind, b.kind)).slice(0, ASSOCIATION_LIMITS.maxSuggestions);
}

/**
 * Applies a manual correction. Returns a new array; the input array and its sessions are never modified.
 * `undefined` keeps a field, `null` removes it, a string sets it (validated against ctx lists when given).
 * When both links end up empty the correction is removed and the recorded links (if any) come back.
 */
export function applyAssociation(
  sessions: readonly AssocSession[],
  sessionId: string,
  change: AssociationChange,
  ctx: { tasks?: readonly { id: string }[]; capsules?: readonly { id: string }[]; now?: string } = {},
): AssocSession[] {
  if (!Array.isArray(sessions)) throw new Error('sessions must be a list');
  if (!change || change.reason !== 'manual') throw new Error("Association changes must have reason 'manual'");
  const idx = sessions.findIndex((s) => s.id === sessionId);
  if (idx < 0) throw new Error(`Unknown session id: ${String(sessionId)}`);
  const check = (v: string | null | undefined, list: readonly { id: string }[] | undefined, what: 'task' | 'capsule') => {
    if (v === undefined || v === null) return;
    if (typeof v !== 'string' || !v) throw new Error(`${what} id must be a non-empty string`);
    if (list && !list.some((x) => x.id === v)) throw new Error(`Unknown ${what} id: ${v}`);
  };
  check(change.taskId, ctx.tasks, 'task');
  check(change.capsuleId, ctx.capsules, 'capsule');
  const now = ctx.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error('now must be an ISO date');

  const cur = sessions[idx];
  const taskId = change.taskId === undefined ? cur.taskId : change.taskId ?? undefined;
  const capsuleId = change.capsuleId === undefined ? cur.capsuleId : change.capsuleId ?? undefined;
  const { taskId: _t, capsuleId: _c, correctedAt: _a, correctedBy: _b, ...rest } = cur;
  let next: AssocSession;
  if (!taskId && !capsuleId) {
    next = { ...rest, ...(cur.recordedTaskId ? { taskId: cur.recordedTaskId } : {}), ...(cur.recordedCapsuleId ? { capsuleId: cur.recordedCapsuleId } : {}) };
  } else {
    next = { ...rest, ...(taskId ? { taskId } : {}), ...(capsuleId ? { capsuleId } : {}), correctedAt: new Date(Date.parse(now)).toISOString(), correctedBy: 'user' };
  }
  return sessions.map((s, i) => (i === idx ? next : s));
}

/** User corrections for the timeline, newest first (ties by session id). */
export function listCorrections(sessions: readonly AssocSession[]): AssociationCorrection[] {
  return sessions
    .filter((s) => s.correctedBy === 'user' && typeof s.correctedAt === 'string')
    .map((s) => ({ sessionId: s.id, kind: s.kind, title: s.title, ...(s.taskId ? { taskId: s.taskId } : {}), ...(s.capsuleId ? { capsuleId: s.capsuleId } : {}), correctedAt: s.correctedAt as string }))
    .sort((a, b) => cmp(b.correctedAt, a.correctedAt) || cmp(a.sessionId, b.sessionId));
}

/** Builds association sessions from the persisted productivity sidecar (timeline + focus + saved associations). */
export function buildAssociationSessions(prod: { timeline?: readonly SourceTimeline[]; focus?: readonly SourceFocus[]; associations?: readonly SourceAssociation[] } | null | undefined): AssocSession[] {
  if (!prod) return [];
  const byId = new Map<string, SourceAssociation>();
  for (const a of prod.associations ?? []) byId.set(a.sessionId, a);
  const out: AssocSession[] = [];
  for (const t of prod.timeline ?? []) out.push({ id: t.id, kind: 'timeline', startedAt: t.at, ...(t.endedAt ? { endedAt: t.endedAt } : {}), title: t.title ? `${t.app} · ${t.title}` : t.app });
  for (const f of prod.focus ?? []) {
    out.push({
      id: f.id, kind: 'focus', startedAt: f.startedAt, endedAt: f.endedAt, title: f.taskTitle || 'Focus session',
      ...(f.taskId ? { taskId: f.taskId, recordedTaskId: f.taskId } : {}), ...(f.capsuleId ? { capsuleId: f.capsuleId, recordedCapsuleId: f.capsuleId } : {}),
    });
  }
  return out
    .map((s) => {
      const a = byId.get(s.id);
      if (!a) return s;
      const { taskId: _t, capsuleId: _c, ...rest } = s;
      return { ...rest, ...(a.taskId ? { taskId: a.taskId } : {}), ...(a.capsuleId ? { capsuleId: a.capsuleId } : {}), correctedAt: a.at, correctedBy: 'user' as const };
    })
    .sort((a, b) => cmp(b.startedAt, a.startedAt) || cmp(a.id, b.id));
}

/** The persisted operation for a session after applyAssociation: set while a user correction exists, else clear. */
export function toAssociationOp(session: AssocSession): AssociationOp {
  if (session.correctedBy === 'user' && (session.taskId || session.capsuleId)) {
    return { op: 'association.set', sessionId: session.id, ...(session.taskId ? { taskId: session.taskId } : {}), ...(session.capsuleId ? { capsuleId: session.capsuleId } : {}) };
  }
  return { op: 'association.clear', sessionId: session.id };
}
