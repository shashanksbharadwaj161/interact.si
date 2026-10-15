// AppState persistence: atomic writes, serialized mutations, backups, corruption recovery, retention.
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Activity, AppState} from '../../src/shared/contracts';
import {LIMITS, ValidationError, defaultState, parseState} from './validation';
import {normalizeAbsolutePath} from './paths';
import {validateOpenUrl} from './policy';
import {PRODUCTIVITY_LIMITS} from './portable';

// Settings that grant reach or change where data goes. An import must never change them (see importDocument).
const SECURITY_SETTING_KEYS = ['mode', 'allowedRoots', 'approvedApps', 'localEndpoint', 'cloudModel'] as const;
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const SCHEMA_VERSION = 1;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const KEEP_NEWEST = 10;
const KEEP_DAYS = 7;
const KEEP_PRE_IMPORT = 5;

export interface StoreFs {
  mkdir(p: string): Promise<void>;
  readFile(p: string): Promise<string>;
  /** Writes and fsyncs. */
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readdir(p: string): Promise<string[]>;
  unlink(p: string): Promise<void>;
}

export const nodeStoreFs: StoreFs = {
  mkdir: async (p) => { await fsp.mkdir(p, {recursive: true}); },
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: async (p, data) => {
    const fh = await fsp.open(p, 'w');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  rename: (a, b) => fsp.rename(a, b),
  readdir: (p) => fsp.readdir(p),
  unlink: (p) => fsp.unlink(p),
};

export interface Envelope { schemaVersion: number; savedAt: string; state: AppState }

export interface StoreOptions {
  dir: string;
  fs?: StoreFs;
  now?: () => Date;
  newId?: () => string;
}

export interface LoadResult { recovered: boolean; readOnly: boolean; warning?: string }

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export function parseEnvelope(raw: string, formats: string[] = []): {schemaVersion: number; state: unknown; format?: string} {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new ValidationError('File is not valid JSON'); }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new ValidationError('File has an unexpected structure');
  const o = j as Record<string, unknown>;
  if (formats.length && !formats.includes(String(o.format))) throw new ValidationError('File is not a Desktop Companion export');
  if (typeof o.schemaVersion !== 'number' || !Number.isInteger(o.schemaVersion) || o.schemaVersion < 1) throw new ValidationError('File has no valid schemaVersion');
  return {schemaVersion: o.schemaVersion, state: o.state, format: typeof o.format === 'string' ? o.format : undefined};
}

export type ForgetHistoryOptions = {chat?: boolean; activity?: boolean; before?: string};

/** Validates forgetHistory options that arrive over IPC: only booleans and a date, at least one history kind chosen. */
export function parseForgetHistory(raw: unknown): ForgetHistoryOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError('Choose what to forget');
  const o = raw as Record<string, unknown>;
  for (const k of ['chat', 'activity'] as const) if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new ValidationError(`${k} must be true or false`);
  if (o.chat !== true && o.activity !== true) throw new ValidationError('Choose chat history, activity history or both');
  const out: ForgetHistoryOptions = {chat: o.chat === true, activity: o.activity === true};
  if (o.before !== undefined) out.before = pIso(o.before, 'before');
  return out;
}

export class Store {
  private fs: StoreFs;
  private dir: string;
  private now: () => Date;
  private newId: () => string;
  private state: AppState = defaultState();
  private queue: Promise<unknown> = Promise.resolve();
  private readOnly = false;
  private lastBackup = 0;
  private listeners = new Set<(a: Activity) => void>();

  constructor(opts: StoreOptions) {
    this.dir = opts.dir;
    this.fs = opts.fs ?? nodeStoreFs;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  get statePath() { return path.join(this.dir, 'state.json'); }
  get backupDir() { return path.join(this.dir, 'backups'); }
  get isReadOnly() { return this.readOnly; }
  id(): string { return this.newId(); }
  nowIso(): string { return this.now().toISOString(); }

  snapshot(): AppState { return structuredClone(this.state); }

  onActivity(cb: (a: Activity) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async load(): Promise<LoadResult> {
    await this.fs.mkdir(this.dir);
    await this.fs.mkdir(this.backupDir);
    let result: LoadResult = {recovered: false, readOnly: false};
    let raw: string | null = null;
    try { raw = await this.fs.readFile(this.statePath); } catch { raw = null; }
    if (raw === null) {
      this.state = defaultState();
    } else {
      let env: ReturnType<typeof parseEnvelope> | null = null;
      try { env = parseEnvelope(raw); } catch (e) { result = await this.recover(raw, (e as Error).message); }
      if (env) {
        const dropped: string[] = [];
        try {
          this.state = parseState(env.state, {lenient: true, dropped});
          if (env.schemaVersion > SCHEMA_VERSION) {
            this.readOnly = true;
            result = {recovered: false, readOnly: true, warning: 'Data was written by a newer version of Desktop Companion and is opened read-only.'};
          } else if (dropped.length) {
            this.pushActivity('recovery', `Removed ${dropped.length} permission entr${dropped.length === 1 ? 'y' : 'ies'} that are no longer allowed (network, device or invalid paths)`, dropped.join('\n'));
          }
        } catch (e) {
          if (env.schemaVersion > SCHEMA_VERSION) {
            // The file is intact but in a format this version cannot read: never overwrite or "recover" it.
            this.readOnly = true;
            this.state = defaultState();
            result = {recovered: false, readOnly: true, warning: 'Data was written by a newer version of Desktop Companion and cannot be read; nothing was changed.'};
          } else {
            result = await this.recover(raw, (e as Error).message);
          }
        }
      }
    }
    this.applyRetentionInMemory();
    if (!this.readOnly) await this.persist();
    return result;
  }

  private async recover(badRaw: string, why: string): Promise<LoadResult> {
    const corrupt = path.join(this.dir, `state.corrupt-${stamp(this.now())}.json`);
    try { await this.fs.writeFile(corrupt, badRaw); } catch { /* best effort */ }
    let recovered: AppState | null = null;
    let names: string[] = [];
    try { names = (await this.fs.readdir(this.backupDir)).filter((n) => /^state-\d{8}-\d{6}\.json$/.test(n)).sort().reverse(); } catch { names = []; }
    for (const n of names) {
      try {
        const env = parseEnvelope(await this.fs.readFile(path.join(this.backupDir, n)));
        if (env.schemaVersion > SCHEMA_VERSION) continue;
        recovered = parseState(env.state, {lenient: true});
        break;
      } catch { /* try older */ }
    }
    this.state = recovered ?? defaultState();
    this.pushActivity('recovery', recovered ? 'State file was corrupt; restored from the newest valid backup' : 'State file was corrupt and no valid backup exists; started with defaults', why.slice(0, 200));
    return {recovered: true, readOnly: false, warning: recovered ? 'Saved data was damaged and restored from a backup.' : 'Saved data was damaged and could not be recovered; defaults were loaded.'};
  }

  private envelope(): Envelope {
    return {schemaVersion: SCHEMA_VERSION, savedAt: this.nowIso(), state: this.state};
  }

  /** tmp file + fsync + rename. A failure before rename leaves the previous state.json untouched. */
  private async persist(): Promise<void> {
    const tmp = this.statePath + '.tmp';
    try {
      await this.fs.writeFile(tmp, JSON.stringify(this.envelope()));
      // Windows can briefly lock the target (antivirus, indexer); retry the rename a few times.
      for (let attempt = 0; ; attempt++) {
        try { await this.fs.rename(tmp, this.statePath); break; } catch (e) {
          if (attempt >= 3 || !RETRYABLE_RENAME.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
          await sleep(25 * (attempt + 1));
        }
      }
    } catch (e) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  /** Runs fn after every earlier queued operation, whether those succeeded or failed. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Must run inside the queue. fn mutates a clone; on throw nothing changes in memory or on disk. */
  private async applyMutation(fn: (draft: AppState) => void): Promise<AppState> {
    if (this.readOnly) throw new ValidationError('Data is read-only because it was written by a newer version');
    const draft = structuredClone(this.state);
    fn(draft);
    draft.chat = draft.chat.slice(-LIMITS.chatMessages);
    draft.activity = draft.activity.slice(-LIMITS.activity);
    const prev = this.state;
    this.state = draft;
    try {
      await this.persist();
    } catch (e) {
      this.state = prev;
      throw new Error('Could not save data to disk');
    }
    await this.maybeBackup();
    return structuredClone(this.state);
  }

  /** Serialized, atomic mutation. fn mutates a clone; on throw nothing changes in memory or on disk. */
  mutate(fn: (draft: AppState) => void): Promise<AppState> {
    return this.enqueue(() => this.applyMutation(fn));
  }

  private pushActivity(kind: string, summary: string, details?: string): Activity {
    const a: Activity = {id: this.newId(), at: this.nowIso(), kind: kind.slice(0, 64), summary: summary.slice(0, 500)};
    if (details) a.details = details.slice(0, 2000);
    this.state.activity.push(a);
    this.state.activity = this.state.activity.slice(-LIMITS.activity);
    return a;
  }

  /** Appends a bounded activity entry, persists it and notifies listeners. Never throws. */
  async addActivity(kind: string, summary: string, details?: string): Promise<Activity | null> {
    let created: Activity | null = null;
    try {
      await this.mutate((d) => {
        const a: Activity = {id: this.newId(), at: this.nowIso(), kind: kind.slice(0, 64), summary: summary.slice(0, 500)};
        if (details) a.details = details.slice(0, 2000);
        d.activity.push(a);
        created = a;
      });
    } catch {
      return null;
    }
    if (created) for (const l of this.listeners) { try { l(created); } catch { /* ignore */ } }
    return created;
  }

  private applyRetentionInMemory(): void {
    const cutoff = this.now().getTime() - this.state.settings.retainDays * 86_400_000;
    const keep = <T>(x: T, at: string) => { const t = Date.parse(at); return Number.isNaN(t) || t >= cutoff; };
    this.state.chat = this.state.chat.filter((m) => keep(m, m.createdAt));
    this.state.activity = this.state.activity.filter((a) => keep(a, a.at));
  }

  /** Drops chat and activity older than retainDays. Notes, tasks and capsules are never touched. */
  async applyRetention(): Promise<AppState> {
    return this.mutate((d) => {
      const cutoff = this.now().getTime() - d.settings.retainDays * 86_400_000;
      d.chat = d.chat.filter((m) => !(Date.parse(m.createdAt) < cutoff));
      d.activity = d.activity.filter((a) => !(Date.parse(a.at) < cutoff));
    });
  }

  /**
   * User-requested forgetting of chat and/or activity history, optionally only entries older than `before`.
   * Notes, tasks and capsules are never touched. The removal itself is recorded in the activity log (as a count,
   * never the removed content) so the user can see that it happened. Atomic like every other mutation.
   */
  async forgetHistory(raw: unknown): Promise<{state: AppState; removed: {chat: number; activity: number}}> {
    const opts = parseForgetHistory(raw);
    const cutoff = opts.before === undefined ? Infinity : Date.parse(opts.before);
    const removed = {chat: 0, activity: 0};
    const state = await this.mutate((d) => {
      const gone = (at: string) => cutoff === Infinity || Date.parse(at) < cutoff;
      if (opts.chat) { const n = d.chat.length; d.chat = d.chat.filter((m) => !gone(m.createdAt)); removed.chat = n - d.chat.length; }
      if (opts.activity) { const n = d.activity.length; d.activity = d.activity.filter((a) => !gone(a.at)); removed.activity = n - d.activity.length; }
      if (removed.chat || removed.activity) {
        d.activity.push({id: this.newId(), at: this.nowIso(), kind: 'memory', summary: `Forgot ${removed.chat} chat message(s) and ${removed.activity} activity entr${removed.activity === 1 ? 'y' : 'ies'}`});
      }
    });
    return {state, removed};
  }

  private async maybeBackup(): Promise<void> {
    if (this.now().getTime() - this.lastBackup < BACKUP_INTERVAL_MS) return;
    await this.backup('auto').catch(() => undefined);
  }

  async backup(kind: 'auto' | 'pre-import' = 'auto'): Promise<string> {
    await this.fs.mkdir(this.backupDir);
    const name = `${kind === 'auto' ? 'state' : 'pre-import'}-${stamp(this.now())}.json`;
    const file = path.join(this.backupDir, name);
    await this.fs.writeFile(file, JSON.stringify(this.envelope()));
    this.lastBackup = this.now().getTime();
    await this.rotate().catch(() => undefined);
    return file;
  }

  /** Newest KEEP_NEWEST backups + newest per day for the last KEEP_DAYS days; newest KEEP_PRE_IMPORT pre-import files. */
  async rotate(): Promise<void> {
    const names = await this.fs.readdir(this.backupDir);
    const rolling = names.filter((n) => /^state-\d{8}-\d{6}\.json$/.test(n)).sort().reverse();
    const keep = new Set(rolling.slice(0, KEEP_NEWEST));
    const cutoff = stamp(new Date(this.now().getTime() - KEEP_DAYS * 86_400_000)).slice(0, 8);
    const days = new Set<string>();
    for (const n of rolling) {
      const day = n.slice(6, 14);
      if (day < cutoff || days.has(day)) continue;
      days.add(day);
      keep.add(n);
    }
    const pre = names.filter((n) => /^pre-import-\d{8}-\d{6}\.json$/.test(n)).sort().reverse();
    pre.slice(0, KEEP_PRE_IMPORT).forEach((n) => keep.add(n));
    for (const n of [...rolling, ...pre]) if (!keep.has(n)) await this.fs.unlink(path.join(this.backupDir, n)).catch(() => undefined);
  }

  /** Export document. Contains no secrets: AppState never holds the cloud key. */
  exportDocument(): string {
    return JSON.stringify({format: 'jarvis-export', schemaVersion: SCHEMA_VERSION, exportedAt: this.nowIso(), state: this.state}, null, 2);
  }

  /**
   * Validates fully before touching anything, then (inside the write queue) takes a pre-import backup and replaces
   * state. Permissions are never imported: the current mode, allowed folders, approved apps, local endpoint and cloud
   * model are kept, so a shared file cannot widen what the app may open or where data is sent. What was ignored is
   * recorded in the activity log.
   */
  async importDocument(raw: string): Promise<AppState> {
    if (typeof raw !== 'string') throw new ValidationError('Import data must be text');
    const env = parseEnvelope(raw, ['jarvis-export']);
    if (env.schemaVersion > SCHEMA_VERSION) throw new ValidationError('Export was created by a newer version of Desktop Companion');
    const dropped: string[] = [];
    const next = parseState(env.state, {lenient: true, dropped});
    if (this.readOnly) throw new ValidationError('Data is read-only because it was written by a newer version');
    return this.enqueue(async () => {
      await this.backup('pre-import');
      return this.applyMutation((d) => {
        const kept = d.settings;
        const lower = (l: string[]) => new Set(l.map((x) => x.toLowerCase()));
        const haveApps = lower(kept.approvedApps), haveRoots = lower(kept.allowedRoots);
        const ignored: string[] = [];
        const addedApps = next.settings.approvedApps.filter((a) => !haveApps.has(a.toLowerCase()));
        const addedRoots = next.settings.allowedRoots.filter((r) => !haveRoots.has(r.toLowerCase()));
        if (addedApps.length) ignored.push(`${addedApps.length} approved app(s): ${addedApps.join(', ')}`);
        if (addedRoots.length) ignored.push(`${addedRoots.length} allowed folder(s): ${addedRoots.join(', ')}`);
        if (next.settings.mode !== kept.mode) ignored.push(`mode ${next.settings.mode}`);
        if (next.settings.localEndpoint !== kept.localEndpoint) ignored.push(`local endpoint ${next.settings.localEndpoint}`);
        if (next.settings.cloudModel !== kept.cloudModel) ignored.push(`cloud model ${next.settings.cloudModel}`);
        const merged = {...next.settings} as unknown as Record<string, unknown>;
        for (const k of SECURITY_SETTING_KEYS) merged[k] = kept[k];
        d.settings = merged as unknown as AppState['settings'];
        d.capsules = next.capsules; d.notes = next.notes; d.tasks = next.tasks; d.chat = next.chat; d.activity = next.activity;
        const notes = [...(ignored.length ? [`Ignored imported permissions: ${ignored.join('; ')}`] : []), ...(dropped.length ? [`Dropped invalid entries: ${dropped.join('; ')}`] : [])];
        d.activity.push({
          id: this.newId(), at: this.nowIso(), kind: 'import',
          summary: notes.length ? 'Imported data; current permissions were kept (see details)' : 'Imported data; current permissions were kept',
          ...(notes.length ? {details: notes.join('\n').slice(0, 2000)} : {}),
        });
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Productivity sidecar (roadmap 31-38, 41-60 app data). AppState has a fixed shared schema, so everything beyond
// notes/tasks/capsules lives in its own versioned file next to state.json: capsule goals and references, project
// checkpoints, focus history, reminder states, the opt-in application timeline, task/session associations, the file
// shelf, recent items and retention policy. Same guarantees as Store: validated input, serialized mutations,
// tmp+fsync+rename writes, rollback on a failed write, corrupt-file quarantine. It never reads user files; file
// and URL entries are references only.
// ---------------------------------------------------------------------------------------------------------------

export const PRODUCTIVITY_VERSION = 1;

export {PRODUCTIVITY_LIMITS, PORTABLE_VERSION, PORTABLE_LIMITS, exportPortable, parsePortable} from './portable';
export type {PortableMemory, PortableImport} from './portable';

export type CapsuleGoal = {id: string; text: string; done: boolean};
export type ReferenceKind = 'file' | 'folder' | 'url' | 'note' | 'task';
export type CapsuleReference = {id: string; kind: ReferenceKind; target: string; label: string; note?: string};
export type CapsuleMeta = {goals: CapsuleGoal[]; references: CapsuleReference[]; updatedAt: string};
export type EvidenceRef = {kind: 'note' | 'task' | 'capsule' | 'activity' | 'focus' | 'checkpoint' | 'session'; id: string};
export type Checkpoint = {id: string; capsuleId?: string; title: string; note: string; createdAt: string; refs: EvidenceRef[]};
export type FocusSession = {id: string; startedAt: string; endedAt: string; plannedSec: number; actualSec: number; outcome: 'completed' | 'stopped'; taskId?: string; taskTitle?: string; capsuleId?: string};
export type ReminderState = {key: string; taskId: string; due: string; state: 'snoozed' | 'dismissed'; until?: string; at: string};
export type TimelineEntry = {id: string; at: string; endedAt?: string; app: string; title?: string};
export type Association = {sessionId: string; taskId?: string; capsuleId?: string; at: string};
export type ShelfItem = {id: string; kind: 'file' | 'folder' | 'url'; target: string; label: string; addedAt: string; pinned: boolean};
export type RecentItem = {id: string; kind: 'file' | 'folder' | 'url' | 'app'; target: string; label: string; openedAt: string; count: number};
/** A retention value of 0 keeps data until the user forgets it. */
export type MemoryPolicy = {timelineEnabled: boolean; timelineTitles: boolean; retainDays: {focus: number; timeline: number; checkpoints: number; reminders: number}};

export type ProductivityState = {
  capsuleMeta: Record<string, CapsuleMeta>;
  checkpoints: Checkpoint[];
  focus: FocusSession[];
  reminders: ReminderState[];
  timeline: TimelineEntry[];
  associations: Association[];
  shelf: ShelfItem[];
  recents: RecentItem[];
  policy: MemoryPolicy;
};

export const FORGET_SCOPES = ['checkpoints', 'focus', 'timeline', 'reminders', 'associations', 'shelf', 'recents', 'all'] as const;
export type ForgetScope = (typeof FORGET_SCOPES)[number];

export type ProductivityOp =
  | {op: 'capsule.setMeta'; capsuleId: string; goals?: {id?: string; text: string; done?: boolean}[]; references?: {id?: string; kind: ReferenceKind; target: string; label?: string; note?: string}[]}
  | {op: 'checkpoint.add'; title: string; note?: string; capsuleId?: string; refs?: EvidenceRef[]; /** Optional original time for imported checkpoints; never in the future. */ createdAt?: string}
  | {op: 'checkpoint.update'; id: string; title?: string; note?: string; /** Replaces the evidence list, for example to drop a reference whose record was deleted. */ refs?: EvidenceRef[]}
  | {op: 'checkpoint.delete'; id: string}
  | {op: 'focus.record'; startedAt: string; endedAt: string; plannedSec: number; actualSec: number; outcome: 'completed' | 'stopped'; taskId?: string; taskTitle?: string; capsuleId?: string}
  | {op: 'focus.delete'; id: string}
  | {op: 'reminder.snooze'; taskId: string; due: string; until: string}
  | {op: 'reminder.dismiss'; taskId: string; due: string}
  | {op: 'reminder.clear'; taskId: string; due: string}
  | {op: 'timeline.record'; at: string; endedAt?: string; app: string; title?: string}
  | {op: 'timeline.delete'; id: string}
  | {op: 'association.set'; sessionId: string; taskId?: string; capsuleId?: string}
  | {op: 'association.clear'; sessionId: string}
  | {op: 'shelf.add'; kind: 'file' | 'folder' | 'url'; target: string; label?: string}
  | {op: 'shelf.pin'; id: string; pinned: boolean}
  | {op: 'shelf.remove'; id: string}
  | {op: 'recent.record'; kind: 'file' | 'folder' | 'url' | 'app'; target: string; label?: string}
  | {op: 'recent.remove'; id: string}
  | {op: 'policy.set'; timelineEnabled?: boolean; timelineTitles?: boolean; retainDays?: Partial<MemoryPolicy['retainDays']>}
  | {op: 'forget'; scope: ForgetScope; before?: string};

export function emptyProductivity(): ProductivityState {
  return {
    capsuleMeta: {}, checkpoints: [], focus: [], reminders: [], timeline: [], associations: [], shelf: [], recents: [],
    policy: {timelineEnabled: false, timelineTitles: false, retainDays: {focus: 365, timeline: 30, checkpoints: 0, reminders: 90}},
  };
}

export const reminderKey = (taskId: string, due: string) => `${taskId}\u0000${due}`;

const P = PRODUCTIVITY_LIMITS;
const PID = /^[A-Za-z0-9_-]{1,64}$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pText(v: unknown, name: string, max: number, o: {multiline?: boolean; required?: boolean} = {}): string {
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  const s = o.multiline ? v.replace(/\r\n/g, '\n').trim() : v.trim();
  if (o.required && !s) throw new ValidationError(`${name} is required`);
  if (s.length > max) throw new ValidationError(`${name} is too long (max ${max})`);
  // eslint-disable-next-line no-control-regex
  if ((o.multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(s)) throw new ValidationError(`${name} contains control characters`);
  return s;
}
function pId(v: unknown, name: string): string {
  if (typeof v !== 'string' || !PID.test(v)) throw new ValidationError(`${name} is invalid`);
  return v;
}
function pIso(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length > 40 || Number.isNaN(Date.parse(v))) throw new ValidationError(`${name} must be a date`);
  return new Date(Date.parse(v)).toISOString();
}
function pNum(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ValidationError(`${name} must be a number from ${min} to ${max}`);
  return Math.round(v);
}
/** Task due values are free text in the app ("2026-10-20" or an ISO instant); keep them short and printable. */
const pDue = (v: unknown) => pText(v, 'due', 40, {required: true});

/** A reference target is never opened by this module. Local paths must be lexically safe, URLs http(s) only. */
function pTarget(kind: string, v: unknown): string {
  if (kind === 'url') {
    const u = validateOpenUrl(v);
    if (!u.ok) throw new ValidationError(u.reason);
    return u.url;
  }
  if (kind === 'file' || kind === 'folder' || kind === 'app') {
    if (kind === 'app' && typeof v === 'string' && /^[\w .+-]{1,64}\.exe$/i.test(v)) return v;
    const p = normalizeAbsolutePath(v);
    if ('error' in p) throw new ValidationError(p.error);
    return p.path;
  }
  return pId(v, 'reference target');
}

function pRefs(v: unknown): EvidenceRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > P.checkpointRefs) throw new ValidationError(`refs must be a list of at most ${P.checkpointRefs}`);
  return v.map((r) => {
    if (!isRec(r) || !['note', 'task', 'capsule', 'activity', 'focus', 'checkpoint', 'session'].includes(String(r.kind))) throw new ValidationError('reference kind is invalid');
    return {kind: r.kind as EvidenceRef['kind'], id: pId(r.id, 'reference id')};
  });
}

const sortAt = <T,>(l: T[], at: (x: T) => string) => l.sort((a, b) => (at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : 0));

function buildMeta(goals: unknown, refs: unknown, updatedAt: string, newId: () => string): CapsuleMeta {
  const g = goals ?? [], r = refs ?? [];
  if (!Array.isArray(g) || g.length > P.goals) throw new ValidationError(`goals must be a list of at most ${P.goals}`);
  if (!Array.isArray(r) || r.length > P.references) throw new ValidationError(`references must be a list of at most ${P.references}`);
  return {
    updatedAt,
    goals: g.map((x) => {
      if (!isRec(x)) throw new ValidationError('goal is invalid');
      return {id: x.id === undefined ? newId() : pId(x.id, 'goal id'), text: pText(x.text, 'goal', P.goalChars, {required: true}), done: x.done === true};
    }),
    references: r.map((x) => {
      if (!isRec(x) || !['file', 'folder', 'url', 'note', 'task'].includes(String(x.kind))) throw new ValidationError('reference kind is invalid');
      const ref: CapsuleReference = {id: x.id === undefined ? newId() : pId(x.id, 'reference id'), kind: x.kind as ReferenceKind, target: pTarget(String(x.kind), x.target), label: pText(x.label ?? '', 'label', P.labelChars)};
      if (x.note !== undefined && x.note !== '') ref.note = pText(x.note, 'note', P.noteChars);
      return ref;
    }),
  };
}

function buildFocus(x: Record<string, unknown>, id: string): FocusSession {
  const startedAt = pIso(x.startedAt, 'startedAt'), endedAt = pIso(x.endedAt, 'endedAt');
  if (endedAt < startedAt) throw new ValidationError('endedAt is before startedAt');
  if (x.outcome !== 'completed' && x.outcome !== 'stopped') throw new ValidationError('outcome is invalid');
  const f: FocusSession = {id, startedAt, endedAt, plannedSec: pNum(x.plannedSec, 'plannedSec', 1, P.maxFocusSec), actualSec: pNum(x.actualSec, 'actualSec', 0, P.maxFocusSec), outcome: x.outcome};
  if (x.taskId !== undefined) f.taskId = pId(x.taskId, 'taskId');
  if (x.taskTitle !== undefined) f.taskTitle = pText(x.taskTitle, 'taskTitle', P.labelChars);
  if (x.capsuleId !== undefined) f.capsuleId = pId(x.capsuleId, 'capsuleId');
  return f;
}

function buildPolicy(base: MemoryPolicy, v: unknown): MemoryPolicy {
  if (!isRec(v)) throw new ValidationError('policy is invalid');
  const next: MemoryPolicy = {...base, retainDays: {...base.retainDays}};
  if (v.timelineEnabled !== undefined) { if (typeof v.timelineEnabled !== 'boolean') throw new ValidationError('timelineEnabled must be true or false'); next.timelineEnabled = v.timelineEnabled; }
  if (v.timelineTitles !== undefined) { if (typeof v.timelineTitles !== 'boolean') throw new ValidationError('timelineTitles must be true or false'); next.timelineTitles = v.timelineTitles; }
  if (v.retainDays !== undefined) {
    if (!isRec(v.retainDays)) throw new ValidationError('retainDays is invalid');
    for (const k of Object.keys(next.retainDays) as (keyof MemoryPolicy['retainDays'])[]) if (v.retainDays[k] !== undefined) next.retainDays[k] = pNum(v.retainDays[k], `retainDays.${k}`, 0, P.maxRetainDays);
  }
  if (!next.timelineEnabled) next.timelineTitles = false;
  return next;
}

/** Validates a persisted sidecar. Unknown keys are dropped; any invalid entry fails the whole file (then recovery runs). */
export function parseProductivity(raw: unknown): ProductivityState {
  if (!isRec(raw)) throw new ValidationError('productivity data is invalid');
  const out = emptyProductivity();
  const arr = (k: string, max: number): unknown[] => {
    const v = raw[k] ?? [];
    if (!Array.isArray(v) || v.length > max) throw new ValidationError(`${k} is invalid`);
    return v;
  };
  const meta = raw.capsuleMeta ?? {};
  if (!isRec(meta) || Object.keys(meta).length > LIMITS.capsules) throw new ValidationError('capsuleMeta is invalid');
  for (const [id, m] of Object.entries(meta)) {
    pId(id, 'capsule id');
    if (!isRec(m)) throw new ValidationError('capsule metadata is invalid');
    // Persisted goals and references always carry ids; one without is damage, not something to repair silently.
    out.capsuleMeta[id] = buildMeta(m.goals, m.references, pIso(m.updatedAt, 'updatedAt'), () => { throw new ValidationError('a saved goal or reference has no id'); });
  }
  out.checkpoints = arr('checkpoints', P.checkpoints).map((x) => {
    if (!isRec(x)) throw new ValidationError('checkpoint is invalid');
    const c: Checkpoint = {id: pId(x.id, 'id'), title: pText(x.title, 'title', P.checkpointTitle, {required: true}), note: pText(x.note ?? '', 'note', P.checkpointNote, {multiline: true}), createdAt: pIso(x.createdAt, 'createdAt'), refs: pRefs(x.refs)};
    if (x.capsuleId !== undefined) c.capsuleId = pId(x.capsuleId, 'capsuleId');
    return c;
  });
  out.focus = arr('focus', P.focus).map((x) => {
    if (!isRec(x)) throw new ValidationError('focus session is invalid');
    return buildFocus(x, pId(x.id, 'id'));
  });
  out.reminders = arr('reminders', P.reminders).map((x) => {
    if (!isRec(x) || (x.state !== 'snoozed' && x.state !== 'dismissed')) throw new ValidationError('reminder state is invalid');
    const taskId = pId(x.taskId, 'taskId'), due = pDue(x.due);
    const r: ReminderState = {key: reminderKey(taskId, due), taskId, due, state: x.state, at: pIso(x.at, 'at')};
    if (x.until !== undefined) r.until = pIso(x.until, 'until');
    return r;
  });
  out.timeline = arr('timeline', P.timeline).map((x) => {
    if (!isRec(x)) throw new ValidationError('timeline entry is invalid');
    const e: TimelineEntry = {id: pId(x.id, 'id'), at: pIso(x.at, 'at'), app: pText(x.app, 'app', 64, {required: true})};
    if (x.endedAt !== undefined) e.endedAt = pIso(x.endedAt, 'endedAt');
    if (x.title !== undefined) e.title = pText(x.title, 'title', P.labelChars);
    return e;
  });
  out.associations = arr('associations', P.associations).map((x) => {
    if (!isRec(x)) throw new ValidationError('association is invalid');
    const a: Association = {sessionId: pId(x.sessionId, 'sessionId'), at: pIso(x.at, 'at')};
    if (x.taskId !== undefined) a.taskId = pId(x.taskId, 'taskId');
    if (x.capsuleId !== undefined) a.capsuleId = pId(x.capsuleId, 'capsuleId');
    return a;
  });
  out.shelf = arr('shelf', P.shelf).map((x) => {
    if (!isRec(x) || !['file', 'folder', 'url'].includes(String(x.kind))) throw new ValidationError('shelf item is invalid');
    return {id: pId(x.id, 'id'), kind: x.kind as ShelfItem['kind'], target: pTarget(String(x.kind), x.target), label: pText(x.label ?? '', 'label', P.labelChars), addedAt: pIso(x.addedAt, 'addedAt'), pinned: x.pinned === true};
  });
  out.recents = arr('recents', P.recents).map((x) => {
    if (!isRec(x) || !['file', 'folder', 'url', 'app'].includes(String(x.kind))) throw new ValidationError('recent item is invalid');
    return {id: pId(x.id, 'id'), kind: x.kind as RecentItem['kind'], target: pTarget(String(x.kind), x.target), label: pText(x.label ?? '', 'label', P.labelChars), openedAt: pIso(x.openedAt, 'openedAt'), count: pNum(x.count, 'count', 1, 1_000_000)};
  });
  if (raw.policy !== undefined) out.policy = buildPolicy(out.policy, raw.policy);
  return out;
}

function pruneIn(d: ProductivityState, nowMs: number): void {
  const keep = (days: number) => (at: string) => days === 0 || Date.parse(at) >= nowMs - days * 86_400_000;
  const r = d.policy.retainDays;
  d.focus = d.focus.filter((x) => keep(r.focus)(x.endedAt));
  d.checkpoints = d.checkpoints.filter((x) => keep(r.checkpoints)(x.createdAt));
  d.reminders = d.reminders.filter((x) => keep(r.reminders)(x.until ?? x.at));
  d.timeline = d.timeline.filter((x) => keep(r.timeline)(x.at));
  dropDeadAssociations(d);
}

/** An association whose session (timeline entry or focus session) is gone carries no information any more. */
function dropDeadAssociations(d: ProductivityState): void {
  const live = new Set([...d.timeline.map((t) => t.id), ...d.focus.map((f) => f.id)]);
  d.associations = d.associations.filter((a) => live.has(a.sessionId));
}

function forgetIn(d: ProductivityState, scope: ForgetScope, before?: string): void {
  const gone = (at: string) => before === undefined || at < before;
  const all = scope === 'all';
  if (all || scope === 'checkpoints') d.checkpoints = d.checkpoints.filter((x) => !gone(x.createdAt));
  if (all || scope === 'focus') d.focus = d.focus.filter((x) => !gone(x.endedAt));
  if (all || scope === 'timeline') d.timeline = d.timeline.filter((x) => !gone(x.at));
  if (all || scope === 'reminders') d.reminders = d.reminders.filter((x) => !gone(x.at));
  if (all || scope === 'shelf') d.shelf = d.shelf.filter((x) => !gone(x.addedAt));
  if (all || scope === 'recents') d.recents = d.recents.filter((x) => !gone(x.openedAt));
  if (scope === 'associations') d.associations = d.associations.filter((x) => !gone(x.at));
  else dropDeadAssociations(d);
  // "Forget everything" also clears capsule goals/references only when no date limit was given.
  if (all && before === undefined) d.capsuleMeta = {};
}

export interface ProductivityStoreOptions extends StoreOptions { fileName?: string }

export class ProductivityStore {
  private fs: StoreFs;
  private dir: string;
  private file: string;
  private now: () => Date;
  private newId: () => string;
  private state: ProductivityState = emptyProductivity();
  private queue: Promise<unknown> = Promise.resolve();
  private readOnly = false;

  constructor(opts: ProductivityStoreOptions) {
    this.dir = opts.dir;
    this.file = opts.fileName ?? 'productivity.json';
    this.fs = opts.fs ?? nodeStoreFs;
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? (() => randomUUID());
  }

  get statePath() { return path.join(this.dir, this.file); }
  private get prevPath() { return this.statePath.replace(/\.json$/, '') + '.prev.json'; }
  get isReadOnly() { return this.readOnly; }
  snapshot(): ProductivityState { return structuredClone(this.state); }

  async load(): Promise<LoadResult> {
    await this.fs.mkdir(this.dir);
    let raw: string | null = null;
    try { raw = await this.fs.readFile(this.statePath); } catch { raw = null; }
    let result: LoadResult = {recovered: false, readOnly: false};
    if (raw !== null) {
      try {
        const env = parseEnvelope(raw);
        if (env.schemaVersion > PRODUCTIVITY_VERSION) {
          this.readOnly = true;
          return {recovered: false, readOnly: true, warning: 'Productivity data was written by a newer version of Desktop Companion and is left unchanged.'};
        }
        this.state = parseProductivity(env.state);
        await this.writeAtomic(this.prevPath).catch(() => undefined);
      } catch (e) {
        result = await this.recover(raw, (e as Error).message);
      }
    }
    pruneIn(this.state, this.now().getTime());
    await this.persist();
    return result;
  }

  private async recover(badRaw: string, why: string): Promise<LoadResult> {
    try { await this.fs.writeFile(this.statePath.replace(/\.json$/, '') + `.corrupt-${stamp(this.now())}.json`, badRaw); } catch { /* best effort */ }
    let restored: ProductivityState | null = null;
    try { restored = parseProductivity(parseEnvelope(await this.fs.readFile(this.prevPath)).state); } catch { restored = null; }
    this.state = restored ?? emptyProductivity();
    return {recovered: true, readOnly: false, warning: `${restored ? 'Productivity data was damaged and restored from the previous copy.' : 'Productivity data was damaged and could not be recovered; it was reset.'} (${why.slice(0, 120)})`};
  }

  /** tmp file + fsync + rename; a failure before the rename leaves the target untouched. */
  private async writeAtomic(target: string): Promise<void> {
    const tmp = target + '.tmp';
    try {
      await this.fs.writeFile(tmp, JSON.stringify({schemaVersion: PRODUCTIVITY_VERSION, savedAt: this.now().toISOString(), state: this.state}));
      for (let attempt = 0; ; attempt++) {
        try { await this.fs.rename(tmp, target); break; } catch (e) {
          if (attempt >= 3 || !RETRYABLE_RENAME.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
          await sleep(25 * (attempt + 1));
        }
      }
    } catch (e) {
      await this.fs.unlink(tmp).catch(() => undefined);
      throw e;
    }
  }

  private persist(): Promise<void> { return this.writeAtomic(this.statePath); }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** On throw (validation or disk) nothing changes in memory or on disk. */
  private run(fn: (draft: ProductivityState) => void): Promise<ProductivityState> {
    return this.enqueue(async () => {
      if (this.readOnly) throw new ValidationError('Productivity data is read-only because it was written by a newer version');
      const draft = structuredClone(this.state);
      fn(draft);
      const prev = this.state;
      this.state = draft;
      try { await this.persist(); } catch { this.state = prev; throw new Error('Could not save data to disk'); }
      return structuredClone(this.state);
    });
  }

  /** Validates one operation fully, then applies it atomically. Unknown operations are rejected. */
  apply(raw: unknown): Promise<ProductivityState> {
    try { return this.dispatch(raw); } catch (e) { return Promise.reject(e); }
  }

  private dispatch(raw: unknown): Promise<ProductivityState> {
    if (!isRec(raw) || typeof raw.op !== 'string') throw new ValidationError('operation is invalid');
    const o = raw;
    const at = this.now().toISOString();
    const id = () => this.newId();
    switch (o.op) {
      case 'capsule.setMeta': {
        const capsuleId = pId(o.capsuleId, 'capsuleId');
        buildMeta(o.goals, o.references, at, id); // validate before queueing
        return this.run((d) => {
          const cur = d.capsuleMeta[capsuleId];
          d.capsuleMeta[capsuleId] = buildMeta(o.goals === undefined ? cur?.goals : o.goals, o.references === undefined ? cur?.references : o.references, at, id);
          if (Object.keys(d.capsuleMeta).length > LIMITS.capsules) throw new ValidationError('Too many capsules with metadata');
        });
      }
      case 'checkpoint.add': {
        const c: Checkpoint = {id: id(), title: pText(o.title, 'title', P.checkpointTitle, {required: true}), note: pText(o.note ?? '', 'note', P.checkpointNote, {multiline: true}), createdAt: at, refs: pRefs(o.refs)};
        if (o.capsuleId !== undefined) c.capsuleId = pId(o.capsuleId, 'capsuleId');
        if (o.createdAt !== undefined) {
          c.createdAt = pIso(o.createdAt, 'createdAt');
          if (c.createdAt > at) throw new ValidationError('createdAt cannot be in the future');
        }
        return this.run((d) => { d.checkpoints.push(c); d.checkpoints = sortAt(d.checkpoints, (x) => x.createdAt).slice(-P.checkpoints); });
      }
      case 'checkpoint.update': {
        const cid = pId(o.id, 'id');
        const title = o.title === undefined ? undefined : pText(o.title, 'title', P.checkpointTitle, {required: true});
        const note = o.note === undefined ? undefined : pText(o.note, 'note', P.checkpointNote, {multiline: true});
        const refs = o.refs === undefined ? undefined : pRefs(o.refs);
        return this.run((d) => {
          const c = d.checkpoints.find((x) => x.id === cid);
          if (!c) throw new ValidationError('Checkpoint not found');
          if (title !== undefined) c.title = title;
          if (note !== undefined) c.note = note;
          if (refs !== undefined) c.refs = refs;
        });
      }
      case 'checkpoint.delete': { const cid = pId(o.id, 'id'); return this.run((d) => { d.checkpoints = d.checkpoints.filter((x) => x.id !== cid); }); }
      case 'focus.record': {
        const f = buildFocus(o, id());
        return this.run((d) => {
          // Idempotent: two recorders (or a reload) may report the same session with start times a moment apart.
          if (d.focus.some((x) => Math.abs(Date.parse(x.startedAt) - Date.parse(f.startedAt)) < 30_000)) return;
          d.focus.push(f);
          d.focus = sortAt(d.focus, (x) => x.startedAt).slice(-P.focus);
        });
      }
      case 'focus.delete': { const fid = pId(o.id, 'id'); return this.run((d) => { d.focus = d.focus.filter((x) => x.id !== fid); dropDeadAssociations(d); }); }
      case 'reminder.snooze': case 'reminder.dismiss': {
        const taskId = pId(o.taskId, 'taskId'), due = pDue(o.due);
        const state: ReminderState = {key: reminderKey(taskId, due), taskId, due, state: o.op === 'reminder.snooze' ? 'snoozed' : 'dismissed', at};
        if (o.op === 'reminder.snooze') {
          state.until = pIso(o.until, 'until');
          if (state.until <= at) throw new ValidationError('Snooze time must be in the future');
        }
        return this.run((d) => { d.reminders = d.reminders.filter((x) => x.key !== state.key); d.reminders.push(state); d.reminders = d.reminders.slice(-P.reminders); });
      }
      case 'reminder.clear': { const key = reminderKey(pId(o.taskId, 'taskId'), pDue(o.due)); return this.run((d) => { d.reminders = d.reminders.filter((x) => x.key !== key); }); }
      case 'timeline.record': {
        const e: TimelineEntry = {id: id(), at: pIso(o.at, 'at'), app: pText(o.app, 'app', 64, {required: true})};
        if (o.endedAt !== undefined) { e.endedAt = pIso(o.endedAt, 'endedAt'); if (e.endedAt < e.at) throw new ValidationError('endedAt is before at'); }
        const title = o.title === undefined ? undefined : pText(o.title, 'title', P.labelChars);
        return this.run((d) => {
          if (!d.policy.timelineEnabled) throw new ValidationError('The application timeline is off; turn it on first');
          // Window titles can hold private text, so they are stored only when the user enabled that separately.
          if (title && d.policy.timelineTitles) e.title = title;
          d.timeline.push(e);
          d.timeline = sortAt(d.timeline, (x) => x.at).slice(-P.timeline);
        });
      }
      case 'timeline.delete': { const tid = pId(o.id, 'id'); return this.run((d) => { d.timeline = d.timeline.filter((x) => x.id !== tid); dropDeadAssociations(d); }); }
      case 'association.set': {
        const a: Association = {sessionId: pId(o.sessionId, 'sessionId'), at};
        if (o.taskId !== undefined) a.taskId = pId(o.taskId, 'taskId');
        if (o.capsuleId !== undefined) a.capsuleId = pId(o.capsuleId, 'capsuleId');
        if (!a.taskId && !a.capsuleId) throw new ValidationError('Choose a task or a capsule to associate');
        return this.run((d) => {
          if (!d.timeline.some((t) => t.id === a.sessionId) && !d.focus.some((f) => f.id === a.sessionId)) throw new ValidationError('Session not found');
          d.associations = d.associations.filter((x) => x.sessionId !== a.sessionId);
          d.associations.push(a);
          d.associations = d.associations.slice(-P.associations);
        });
      }
      case 'association.clear': { const sid = pId(o.sessionId, 'sessionId'); return this.run((d) => { d.associations = d.associations.filter((x) => x.sessionId !== sid); }); }
      case 'shelf.add': {
        if (!['file', 'folder', 'url'].includes(String(o.kind))) throw new ValidationError('shelf kind is invalid');
        const item: ShelfItem = {id: id(), kind: o.kind as ShelfItem['kind'], target: pTarget(String(o.kind), o.target), label: pText(o.label ?? '', 'label', P.labelChars), addedAt: at, pinned: false};
        return this.run((d) => {
          if (d.shelf.some((x) => x.kind === item.kind && x.target.toLowerCase() === item.target.toLowerCase())) throw new ValidationError('Already on the shelf');
          if (d.shelf.length >= P.shelf) throw new ValidationError(`The shelf holds at most ${P.shelf} items`);
          d.shelf.push(item);
        });
      }
      case 'shelf.pin': { const sid = pId(o.id, 'id'); const pinned = o.pinned === true; return this.run((d) => { const x = d.shelf.find((s) => s.id === sid); if (!x) throw new ValidationError('Shelf item not found'); x.pinned = pinned; }); }
      case 'shelf.remove': { const sid = pId(o.id, 'id'); return this.run((d) => { d.shelf = d.shelf.filter((x) => x.id !== sid); }); }
      case 'recent.record': {
        if (!['file', 'folder', 'url', 'app'].includes(String(o.kind))) throw new ValidationError('recent kind is invalid');
        const kind = o.kind as RecentItem['kind'], target = pTarget(kind, o.target), label = pText(o.label ?? '', 'label', P.labelChars);
        return this.run((d) => {
          const hit = d.recents.find((x) => x.kind === kind && x.target.toLowerCase() === target.toLowerCase());
          const rest = d.recents.filter((x) => x !== hit);
          rest.unshift({id: hit?.id ?? id(), kind, target, label: label || hit?.label || '', openedAt: at, count: (hit?.count ?? 0) + 1});
          d.recents = rest.slice(0, P.recents);
        });
      }
      case 'recent.remove': { const rid = pId(o.id, 'id'); return this.run((d) => { d.recents = d.recents.filter((x) => x.id !== rid); }); }
      case 'policy.set': {
        buildPolicy(this.state.policy, o);
        return this.run((d) => { d.policy = buildPolicy(d.policy, o); });
      }
      case 'forget': {
        if (!FORGET_SCOPES.includes(o.scope as ForgetScope)) throw new ValidationError('forget scope is invalid');
        const scope = o.scope as ForgetScope;
        const before = o.before === undefined ? undefined : pIso(o.before, 'before');
        return this.run((d) => forgetIn(d, scope, before));
      }
      default: throw new ValidationError(`unknown operation "${String(o.op).slice(0, 40)}"`);
    }
  }

  /** Drops data tied to capsules or tasks that no longer exist. Call after deletes and imports. */
  reconcile(valid: {capsuleIds: string[]; taskIds: string[]}): Promise<ProductivityState> {
    const caps = new Set(valid.capsuleIds), tasks = new Set(valid.taskIds);
    return this.run((d) => {
      for (const k of Object.keys(d.capsuleMeta)) {
        if (!caps.has(k)) delete d.capsuleMeta[k];
        else d.capsuleMeta[k].references = d.capsuleMeta[k].references.filter((r) => r.kind !== 'task' || tasks.has(r.target));
      }
      d.checkpoints.forEach((c) => { if (c.capsuleId && !caps.has(c.capsuleId)) delete c.capsuleId; });
      d.focus.forEach((f) => { if (f.capsuleId && !caps.has(f.capsuleId)) delete f.capsuleId; if (f.taskId && !tasks.has(f.taskId)) delete f.taskId; });
      d.reminders = d.reminders.filter((r) => tasks.has(r.taskId));
      d.associations = d.associations.flatMap((a) => {
        const n = {...a};
        if (n.taskId && !tasks.has(n.taskId)) delete n.taskId;
        if (n.capsuleId && !caps.has(n.capsuleId)) delete n.capsuleId;
        return n.taskId || n.capsuleId ? [n] : [];
      });
    });
  }

  /** Applies the user's retention policy now (also runs on load). */
  applyRetention(): Promise<ProductivityState> { return this.run((d) => { pruneIn(d, this.now().getTime()); }); }
}
