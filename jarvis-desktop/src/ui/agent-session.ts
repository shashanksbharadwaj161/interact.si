// Pure, DOM-free persistent agent sessions for the Developer page task board.
// A session is a snapshot of manually recorded board state (tasks, log, budget, spend).
// Development tooling only: no timers, network or model calls. Resuming never starts a worker.

import { parseBoard, transitionTask, isTerminal, type BoardTask, type TaskStatus } from './task-board';
import { exportLog, normalizeLog, parseLog, type LogEntry } from './agent-log';
import { normalizeTaskBudget, parseSpendLedger, type SpendEntry, type TaskBudget } from './task-budget';

export const AGENT_SESSION_FORMAT = 'desktop-companion-agent-session';
export const AGENT_SESSION_VERSION = 1;
export const AGENT_SESSION_PREF_KEY = 'developer.agentSessions';
export const SESSION_LIMITS = { jsonChars: 400000, name: 80 } as const;
export const SAVED_SESSIONS_CAP = 10;
export const RESUME_PAUSE_NOTE = 'Paused on resume: no worker was executing after restart';
export const STALE_SESSION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionCounts = { tasks: number; log: number; running: number; paused: number; queued: number };

export type AgentSession = {
  format: typeof AGENT_SESSION_FORMAT;
  version: typeof AGENT_SESSION_VERSION;
  name: string;
  savedAt: string;
  tasks: BoardTask[];
  log: LogEntry[];
  budget: TaskBudget;
  spend: SpendEntry[];
  counts: SessionCounts;
};

export type BuildSessionInput = { name: string; tasks: unknown; log: unknown; budget: unknown; spend: unknown; now: number | Date | string };

function toMs(now: unknown): number {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : typeof now === 'number' ? now : Number.NaN;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error(`Invalid session timestamp: ${String(now)}.`);
  return ms;
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Session name is required.');
  const n = name.trim();
  if (n.length > SESSION_LIMITS.name) throw new Error(`Session name must be at most ${SESSION_LIMITS.name} characters.`);
  return n;
}

/** Redacts message/data through the existing agent-log export path, then re-validates entries. */
function redactLog(log: readonly LogEntry[]): LogEntry[] {
  return parseLog(exportLog(log)).entries;
}

function countTasks(tasks: readonly BoardTask[], log: readonly LogEntry[]): SessionCounts {
  const by = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  return { tasks: tasks.length, log: log.length, running: by('running'), paused: by('paused'), queued: by('queued') };
}

/** Builds a session envelope. Malformed tasks/log/spend entries are dropped by the existing parsers; log secrets are redacted. */
export function buildSession(input: BuildSessionInput): AgentSession {
  const name = cleanName(input?.name);
  const savedAt = new Date(toMs(input?.now)).toISOString();
  const tasks = parseBoard(input.tasks);
  const log = redactLog(normalizeLog(input.log));
  const budget = normalizeTaskBudget(input.budget);
  const spend = parseSpendLedger(input.spend);
  return { format: AGENT_SESSION_FORMAT, version: AGENT_SESSION_VERSION, name, savedAt, tasks, log, budget, spend, counts: countTasks(tasks, log) };
}

/** Serializes a session to JSON text. Throws when the text would exceed SESSION_LIMITS.jsonChars. */
export function serializeSession(session: AgentSession): string {
  const text = JSON.stringify(session, null, 2);
  if (text.length > SESSION_LIMITS.jsonChars) throw new Error(`$: session JSON exceeds ${SESSION_LIMITS.jsonChars} characters (${text.length}).`);
  return text;
}

export type ParsedSession = { session: AgentSession; dropped: { tasks: number; log: number; spend: number } };

const isIsoString = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/** Parses session JSON. Throws with exact $-paths for envelope problems; drops malformed section entries and reports counts. */
export function parseSession(json: string): ParsedSession {
  if (typeof json !== 'string') throw new Error('$: expected JSON text.');
  if (json.length > SESSION_LIMITS.jsonChars) throw new Error(`$: session JSON exceeds ${SESSION_LIMITS.jsonChars} characters (${json.length}).`);
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('$: invalid JSON.');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('$: expected an object.');
  const d = doc as Record<string, unknown>;
  if (d.format !== AGENT_SESSION_FORMAT) throw new Error(`$.format: expected "${AGENT_SESSION_FORMAT}".`);
  if (d.version !== AGENT_SESSION_VERSION) throw new Error(`$.version: expected ${AGENT_SESSION_VERSION}.`);
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.trim().length > SESSION_LIMITS.name) {
    throw new Error(`$.name: expected a non-empty string of at most ${SESSION_LIMITS.name} characters.`);
  }
  if (!isIsoString(d.savedAt)) throw new Error('$.savedAt: expected an ISO timestamp.');
  if (!Array.isArray(d.tasks)) throw new Error('$.tasks: expected an array.');
  if (!Array.isArray(d.log)) throw new Error('$.log: expected an array.');
  if (!d.budget || typeof d.budget !== 'object' || Array.isArray(d.budget)) throw new Error('$.budget: expected an object.');
  if (!Array.isArray(d.spend)) throw new Error('$.spend: expected an array.');
  const tasks = parseBoard(d.tasks);
  const log = redactLog(normalizeLog(d.log));
  const spend = parseSpendLedger(d.spend);
  const session: AgentSession = {
    format: AGENT_SESSION_FORMAT,
    version: AGENT_SESSION_VERSION,
    name: d.name.trim(),
    savedAt: d.savedAt,
    tasks,
    log,
    budget: normalizeTaskBudget(d.budget),
    spend,
    counts: countTasks(tasks, log),
  };
  return { session, dropped: { tasks: d.tasks.length - tasks.length, log: d.log.length - log.length, spend: d.spend.length - spend.length } };
}

export type ResumeAction = { taskId: string; from: TaskStatus; to: TaskStatus; reason: string };
export type ResumePlan = { tasks: BoardTask[]; actions: ResumeAction[]; warnings: string[] };

/**
 * Plans a resume. Tasks running at save time are moved to paused (never restarted, never given progress).
 * Queued, paused and terminal tasks are kept verbatim. Warns when savedAt is in the future or older than 30 days.
 */
export function planResume(session: Pick<AgentSession, 'tasks' | 'savedAt'>, now: number | Date | string): ResumePlan {
  const nowMs = toMs(now);
  const tasks = Array.isArray(session?.tasks) ? session.tasks : [];
  const actions: ResumeAction[] = [];
  const warnings: string[] = [];
  const out = tasks.map((t) => {
    if (t.status !== 'running' || isTerminal(t.status)) return t;
    const paused = transitionTask(t, 'paused', { now: nowMs, note: RESUME_PAUSE_NOTE });
    actions.push({ taskId: t.id, from: 'running', to: 'paused', reason: RESUME_PAUSE_NOTE });
    return paused;
  });
  const saved = Date.parse(String(session?.savedAt));
  const nowIso = new Date(nowMs).toISOString();
  if (Number.isNaN(saved)) warnings.push(`Session savedAt "${String(session?.savedAt)}" is not a valid timestamp.`);
  else if (saved > nowMs) warnings.push(`Session savedAt ${session.savedAt} is in the future (now ${nowIso}); check the system clock.`);
  else if (nowMs - saved > STALE_SESSION_DAYS * DAY_MS) warnings.push(`Session savedAt ${session.savedAt} is older than ${STALE_SESSION_DAYS} days (now ${nowIso}); recorded state may be out of date.`);
  return { tasks: out, actions, warnings };
}

export type SessionDiff = {
  onlyInCurrent: string[];
  onlyInIncoming: string[];
  statusChanged: { taskId: string; from: TaskStatus; to: TaskStatus }[];
};

/** Lists task ids present only in current, only in incoming, and ids whose status differs. */
export function diffSessions(current: { tasks: readonly BoardTask[] }, incoming: { tasks: readonly BoardTask[] }): SessionDiff {
  const cur = Array.isArray(current?.tasks) ? current.tasks : [];
  const inc = Array.isArray(incoming?.tasks) ? incoming.tasks : [];
  const curMap = new Map(cur.map((t) => [t.id, t]));
  const incMap = new Map(inc.map((t) => [t.id, t]));
  const onlyInCurrent = [...curMap.keys()].filter((id) => !incMap.has(id));
  const onlyInIncoming = [...incMap.keys()].filter((id) => !curMap.has(id));
  const statusChanged: SessionDiff['statusChanged'] = [];
  for (const [id, t] of curMap) {
    const other = incMap.get(id);
    if (other && other.status !== t.status) statusChanged.push({ taskId: id, from: t.status, to: other.status });
  }
  return { onlyInCurrent, onlyInIncoming, statusChanged };
}

/** Validates a stored session list (pref data): keeps parseable sessions, newest first, capped at 10. */
export function normalizeSavedSessions(raw: unknown): AgentSession[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentSession[] = [];
  const names = new Set<string>();
  for (const e of raw) {
    if (out.length >= SAVED_SESSIONS_CAP) break;
    try {
      const s = parseSession(JSON.stringify(e)).session;
      if (names.has(s.name)) continue;
      names.add(s.name);
      out.push(s);
    } catch {
      /* drop malformed stored session */
    }
  }
  return out;
}

/** Returns a new list with the session first, replacing any session of the same name, capped at 10. */
export function upsertSession(list: readonly AgentSession[], session: AgentSession): AgentSession[] {
  return [session, ...list.filter((s) => s.name !== session.name)].slice(0, SAVED_SESSIONS_CAP);
}
