// AppState persistence: atomic writes, serialized mutations, backups, corruption recovery, retention.
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Activity, AppState} from '../../src/shared/contracts';
import {LIMITS, ValidationError, defaultState, parseState} from './validation';

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
  if (formats.length && !formats.includes(String(o.format))) throw new ValidationError('File is not a Jarvis export');
  if (typeof o.schemaVersion !== 'number' || !Number.isInteger(o.schemaVersion) || o.schemaVersion < 1) throw new ValidationError('File has no valid schemaVersion');
  return {schemaVersion: o.schemaVersion, state: o.state, format: typeof o.format === 'string' ? o.format : undefined};
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
      try {
        const env = parseEnvelope(raw);
        if (env.schemaVersion > SCHEMA_VERSION) {
          this.readOnly = true;
          result = {recovered: false, readOnly: true, warning: 'Data was written by a newer version of Jarvis Desktop and is opened read-only.'};
          this.state = parseState(env.state);
        } else {
          this.state = parseState(env.state);
        }
      } catch (e) {
        result = await this.recover(raw, (e as Error).message);
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
        recovered = parseState(env.state);
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
    await this.fs.writeFile(tmp, JSON.stringify(this.envelope()));
    await this.fs.rename(tmp, this.statePath);
  }

  /** Serialized, atomic mutation. fn mutates a clone; on throw nothing changes in memory or on disk. */
  mutate(fn: (draft: AppState) => void): Promise<AppState> {
    const run = async (): Promise<AppState> => {
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
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
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

  /** Validates fully before touching anything, takes a pre-import backup, then replaces state. */
  async importDocument(raw: string): Promise<AppState> {
    const env = parseEnvelope(raw, ['jarvis-export']);
    if (env.schemaVersion > SCHEMA_VERSION) throw new ValidationError('Export was created by a newer version of Jarvis Desktop');
    const next = parseState(env.state);
    if (this.readOnly) throw new ValidationError('Data is read-only because it was written by a newer version');
    await this.queue.catch(() => undefined);
    await this.backup('pre-import');
    return this.mutate((d) => {
      d.settings = next.settings; d.capsules = next.capsules; d.notes = next.notes; d.tasks = next.tasks; d.chat = next.chat; d.activity = next.activity;
    });
  }
}
