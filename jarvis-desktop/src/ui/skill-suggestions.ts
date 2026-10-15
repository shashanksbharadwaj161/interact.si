// Pure, DOM-free skill suggestions for the Developer task board.
// Suggestions are derived only from manually recorded board tasks and agent log entries.
// Saving or queuing a skill never starts a worker: nothing here contacts a network, calls a model or schedules work.

import { TASK_BOARD_LIMITS, type BoardTask, type NewTaskInput } from './task-board';
import type { LogEntry } from './agent-log';
import { TOOL_SCOPES, getRole } from './worker-roles';

export const SKILL_LIMITS = { skills: 50, name: 80, steps: 20, stepChars: 200, minOccurrences: 2 } as const;
export const SKILLS_PREF_KEY = 'developer.skills';
const TITLE_KEY_TOKENS = 6;
const ELLIPSIS = '…';

export type Skill = {
  id: string;
  name: string;
  role: string;
  model: string | null;
  scopes: string[];
  steps: string[];
  sourceTaskIds: string[];
  createdAt: string;
};

export type SkillSuggestion = {
  key: string;
  occurrences: number;
  sourceTaskIds: string[];
  lastCompletedAt: string;
  skill: Skill;
};

export type SuggestOptions = { now?: number | Date | string; minOccurrences?: number };

/** Task input for createTask plus the scopes/note the Developer add path stores on the task. */
export type SkillTaskInput = NewTaskInput & { model: string; note: string; scopes: string[] };

const typeName = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const isIsoString = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

function toIso(now: number | Date | string | undefined): string {
  const valid = now === undefined || typeof now === 'number' || typeof now === 'string' || now instanceof Date;
  const d = !valid ? null : now === undefined ? new Date() : now instanceof Date ? now : new Date(now);
  if (!d || Number.isNaN(d.getTime())) throw new Error(`Invalid "now" for skill suggestions: ${String(now)}.`);
  return d.toISOString();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

/** Lowercase, punctuation stripped, digit runs replaced by '#', first 6 tokens joined by single spaces. */
export function normalizeTitleKey(title: string): string {
  if (typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\d+/g, '#')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TITLE_KEY_TOKENS)
    .join(' ');
}

/** Reads the 'Scopes: a, b' line the worker-roles add path stores in a task note, keeping only known tool scopes (TOOL_SCOPES order). */
export function parseNoteScopes(note: unknown): string[] {
  if (typeof note !== 'string') return [];
  const found = new Set<string>();
  for (const line of note.split(/\r?\n/)) {
    const m = /^\s*Scopes:\s*(.*)$/i.exec(line);
    if (!m) continue;
    for (const part of m[1].split(',')) found.add(part.trim());
  }
  return TOOL_SCOPES.filter((s) => found.has(s));
}

/** The exact note line the Developer add path writes for a task's scopes. */
export const scopesNote = (scopes: readonly string[]) => `Scopes: ${scopes.join(', ')}`;

const slug = (text: string) => text.replace(/#/g, 'n').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');

/**
 * Groups completed tasks (status 'done', stop reason 'completed') by role and normalized title key.
 * Only groups with at least `minOccurrences` tasks are returned, ordered by occurrences desc,
 * then latest endedAt desc, then key asc. Steps come from the group's info/result log entries.
 */
export function suggestSkills(tasks: readonly BoardTask[], logEntries: readonly LogEntry[], opts: SuggestOptions = {}): SkillSuggestion[] {
  if (!Array.isArray(tasks)) throw new Error(`Tasks must be an array, got ${typeName(tasks)}.`);
  if (!Array.isArray(logEntries)) throw new Error(`Log entries must be an array, got ${typeName(logEntries)}.`);
  const createdAt = toIso(opts?.now);
  const min = opts?.minOccurrences ?? SKILL_LIMITS.minOccurrences;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) throw new Error(`minOccurrences must be a positive integer, got ${String(min)}.`);

  const groups = new Map<string, { role: string; titleKey: string; tasks: BoardTask[] }>();
  for (const t of tasks) {
    if (!t || typeof t !== 'object' || t.status !== 'done' || t.stopReason !== 'completed') continue;
    if (typeof t.id !== 'string' || typeof t.role !== 'string' || !t.role.trim()) continue;
    const titleKey = normalizeTitleKey(t.title);
    if (!titleKey) continue;
    const role = t.role.trim();
    const key = `${role}:${titleKey}`;
    let g = groups.get(key);
    if (!g) {
      g = { role, titleKey, tasks: [] };
      groups.set(key, g);
    }
    if (!g.tasks.some((x) => x.id === t.id)) g.tasks.push(t);
  }

  const out: SkillSuggestion[] = [];
  for (const [key, g] of groups) {
    if (g.tasks.length < min) continue;
    const ended = (t: BoardTask) => (isIsoString(t.endedAt) ? Date.parse(t.endedAt) : -Infinity);
    const latest = g.tasks.reduce((a, b) => (ended(b) > ended(a) ? b : a));
    const ids = new Set(g.tasks.map((t) => t.id));
    const seen = new Set<string>();
    const steps: string[] = [];
    for (const e of logEntries) {
      if (steps.length >= SKILL_LIMITS.steps) break;
      if (!e || typeof e !== 'object' || !ids.has(e.taskId) || (e.level !== 'info' && e.level !== 'result')) continue;
      const msg = typeof e.message === 'string' ? e.message.trim() : '';
      if (!msg || seen.has(msg)) continue;
      seen.add(msg);
      steps.push(truncate(msg, SKILL_LIMITS.stepChars));
    }
    const scopeSet = new Set(g.tasks.flatMap((t) => parseNoteScopes(t.note)));
    const scopes = TOOL_SCOPES.filter((s) => scopeSet.has(s));
    const sourceTaskIds = g.tasks.map((t) => t.id);
    const name = truncate(latest.title.trim(), SKILL_LIMITS.name);
    out.push({
      key,
      occurrences: g.tasks.length,
      sourceTaskIds,
      lastCompletedAt: latest.endedAt ?? '',
      skill: {
        id: `skill-${slug(`${g.role}-${g.titleKey}`)}`.slice(0, 80),
        name,
        role: g.role,
        model: typeof latest.model === 'string' && latest.model ? latest.model : null,
        scopes,
        steps,
        sourceTaskIds: [...sourceTaskIds],
        createdAt,
      },
    });
  }
  const endedMs = (s: SkillSuggestion) => (isIsoString(s.lastCompletedAt) ? Date.parse(s.lastCompletedAt) : -Infinity);
  return out.sort((a, b) => b.occurrences - a.occurrences || endedMs(b) - endedMs(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const isStringArray = (v: unknown, maxItems: number, maxChars: number) =>
  Array.isArray(v) && v.length <= maxItems && v.every((x) => typeof x === 'string' && x.trim() !== '' && x.length <= maxChars);

/** Returns a clean copy of a skill or null when malformed. */
function cleanSkill(raw: unknown): Skill | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim() || r.id.length > 80) return null;
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > SKILL_LIMITS.name) return null;
  if (typeof r.role !== 'string' || !r.role.trim() || r.role.length > TASK_BOARD_LIMITS.roleChars) return null;
  if (r.model !== null && (typeof r.model !== 'string' || !r.model.trim() || r.model.length > TASK_BOARD_LIMITS.modelChars)) return null;
  if (!Array.isArray(r.scopes) || !r.scopes.every((s) => typeof s === 'string' && (TOOL_SCOPES as readonly string[]).includes(s))) return null;
  if (!isStringArray(r.steps, SKILL_LIMITS.steps, SKILL_LIMITS.stepChars)) return null;
  if (!isStringArray(r.sourceTaskIds, TASK_BOARD_LIMITS.tasks, 80)) return null;
  if (!isIsoString(r.createdAt)) return null;
  return {
    id: r.id,
    name: r.name,
    role: r.role,
    model: r.model as string | null,
    scopes: TOOL_SCOPES.filter((s) => (r.scopes as string[]).includes(s)),
    steps: [...(r.steps as string[])],
    sourceTaskIds: [...(r.sourceTaskIds as string[])],
    createdAt: r.createdAt,
  };
}

/** Validates persisted skills: drops malformed and duplicate ids (newest kept), newest first, capped at 50. */
export function normalizeSkills(raw: unknown): Skill[] {
  if (!Array.isArray(raw)) return [];
  const cleaned = raw
    .map((r, i) => ({ s: cleanSkill(r), i }))
    .filter((x): x is { s: Skill; i: number } => x.s !== null)
    .sort((a, b) => Date.parse(b.s.createdAt) - Date.parse(a.s.createdAt) || a.i - b.i);
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const { s } of cleaned) {
    if (out.length >= SKILL_LIMITS.skills) break;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/** Adds or replaces (by id) a skill. Throws a descriptive Error for a malformed skill. */
export function upsertSkill(skills: readonly Skill[], skill: Skill): Skill[] {
  if (!Array.isArray(skills)) throw new Error(`Skills must be an array, got ${typeName(skills)}.`);
  const clean = cleanSkill(skill);
  if (!clean) throw new Error('Invalid skill: expected id, name, role, model, known scopes, steps, source task ids and createdAt.');
  return normalizeSkills([clean, ...normalizeSkills(skills).filter((s) => s.id !== clean.id)]);
}

export function removeSkill(skills: readonly Skill[], id: string): Skill[] {
  if (!Array.isArray(skills)) throw new Error(`Skills must be an array, got ${typeName(skills)}.`);
  if (typeof id !== 'string') throw new Error(`Skill id must be a string, got ${typeName(id)}.`);
  return normalizeSkills(skills).filter((s) => s.id !== id);
}

/**
 * Builds the queued-task input for createTask from a saved skill. It only describes a task record;
 * the caller adds it as queued and the board's own start checks still apply.
 */
export function taskFromSkill(skill: Skill, opts: { title?: string; model?: string } = {}): SkillTaskInput {
  const clean = cleanSkill(skill);
  if (!clean) throw new Error('Invalid skill: cannot queue a task from a malformed skill.');
  if (opts?.title !== undefined && (typeof opts.title !== 'string' || !opts.title.trim())) throw new Error('Task title override must be a non-empty string.');
  if (opts?.model !== undefined && (typeof opts.model !== 'string' || !opts.model.trim())) throw new Error('Model override must be a non-empty string.');
  const title = truncate((opts?.title ?? clean.name).trim(), TASK_BOARD_LIMITS.titleChars);
  const model = (opts?.model ?? clean.model ?? getRole(clean.role)?.defaultModel ?? '').trim();
  if (!model) throw new Error(`Skill "${clean.name}" has no model and role "${clean.role}" has no default model.`);
  return { title, role: clean.role, model, scopes: [...clean.scopes], note: scopesNote(clean.scopes) };
}
