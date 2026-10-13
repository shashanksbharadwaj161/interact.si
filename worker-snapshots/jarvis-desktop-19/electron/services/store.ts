// AppState persistence: atomic writes, serialized mutations, backups, corruption recovery, retention.
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Activity, AppState} from '../../src/shared/contracts';
import {LIMITS, ValidationError, defaultState, parseState} from './validation';

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
