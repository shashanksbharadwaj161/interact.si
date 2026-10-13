// Composition root for the backend services. Contains no Electron imports: Electron-only capabilities
// (dialogs, shell, pids) are injected, so the whole JarvisAPI surface is testable under node --test.
import {promises as fsp} from 'node:fs';
import type {Activity, AppState, ChatMessage, JarvisAPI, SystemInfo} from '../src/shared/contracts';
import {ActionService, type ShellAdapter} from './services/actions';
import {sendChat} from './services/chat';
import {restoreCapsule} from './services/capsules';
import {createGuardedFetch} from './services/netGuard';
import {normalizeAbsolutePath} from './services/paths';
import {Secrets} from './services/secrets';
import {Speech} from './services/speech';
import {Store, type LoadResult, type StoreFs} from './services/store';
import {System} from './services/system';
import {LIMITS, ValidationError, buildCapsule, buildNote, buildTask, checkId, mergeSettings} from './services/validation';
import {createNativeAdapter, type NativeAdapter} from './native/adapter';
import {NativeRunner} from './native/runner';

export interface Dialogs {
  /** Returns the chosen destination or null when cancelled. */
  saveExport(defaultName: string): Promise<string | null>;
  openImport(): Promise<string | null>;
  pick(kind: 'file' | 'folder'): Promise<string | null>;
}

export interface BackendEnv {
  userData: string;
  nativeDir: string;
  tmpDir: string;
  dialogs: Dialogs;
  shell: ShellAdapter;
  selfPids: () => number[];
  safeLaunch?: () => boolean;
  /** Test seams. Production leaves these undefined. */
  native?: NativeAdapter;
  storeFs?: StoreFs;
  fetchImpl?: typeof fetch;
  cloudOriginOverride?: string;
  now?: () => Date;
  newId?: () => string;
  windowWaitMs?: number;
}

export type Backend = JarvisAPI & {
  load: LoadResult;
  store: Store;
  actions: ActionService;
  system: System;
  speech: Speech;
  runner: NativeRunner | null;
  runRetention(): Promise<void>;
  dispose(): Promise<void>;
};

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

function stampForName(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export async function createBackend(env: BackendEnv): Promise<Backend> {
  const store = new Store({dir: env.userData, fs: env.storeFs, now: env.now, newId: env.newId});
  const load = await store.load();
  const runner = env.native ? null : new NativeRunner({nativeDir: env.nativeDir});
  const native = env.native ?? createNativeAdapter(runner!);
  const secrets = new Secrets(native, env.userData);
  let keyConfigured = await secrets.configured();
  const settings = () => store.snapshot().settings;
  const safeLaunch = env.safeLaunch ?? (() => false);
  const activity = (kind: string, summary: string, details?: string) => store.addActivity(kind, summary, details);

  const guardedFetch = createGuardedFetch({
    mode: () => settings().mode,
    hasCloudKey: () => keyConfigured,
    fetchImpl: env.fetchImpl,
    cloudOriginOverride: env.cloudOriginOverride,
    audit: (decision, origin, purpose, reason) => {
      // Loopback model traffic is not logged (it would flood the log); denials and cloud traffic always are.
      if (decision === 'denied' || purpose === 'cloud-chat') void activity('network', `${decision === 'denied' ? 'Blocked' : 'Allowed'} ${origin}`, `${purpose}${reason ? `: ${reason}` : ''}`);
    },
  });
  const speech = new Speech({native, settings, tmpDir: env.tmpDir, newId: () => store.id()});
  const system = new System({settings, fetch: guardedFetch, speech, secrets, native, safeLaunch});
  const actions = new ActionService({
    settings, activity, native, shell: env.shell, selfPids: env.selfPids, safeLaunch, newId: () => store.id(),
  });

  const withLimit = (n: number, max: number, what: string) => { if (n >= max) throw new ValidationError(`Too many ${what} (max ${max})`); };

  const api: Omit<JarvisAPI, 'onActivity'> = {
    async getState(): Promise<AppState> { return store.snapshot(); },

    async saveSettings(patch) {
      let changed: string[] = [];
      await store.mutate((d) => {
        const merged = mergeSettings(d.settings, patch);
        changed = Object.keys(merged).filter((k) => JSON.stringify((merged as unknown as Record<string, unknown>)[k]) !== JSON.stringify((d.settings as unknown as Record<string, unknown>)[k]));
        d.settings = merged;
      });
      system.invalidate();
      if (changed.length) await activity('settings', `Settings changed: ${changed.join(', ')}`);
      return store.snapshot();
    },

    async getSystemInfo(): Promise<SystemInfo> { return system.info(); },

    async saveCapsule(input) {
      return store.mutate((d) => {
        const id = (input as {id?: unknown})?.id;
        const existing = typeof id === 'string' ? d.capsules.find((c) => c.id === id) : undefined;
        const c = buildCapsule(input, existing, () => store.id(), store.nowIso());
        if (existing) d.capsules[d.capsules.indexOf(existing)] = c;
        else { withLimit(d.capsules.length, LIMITS.capsules, 'capsules'); d.capsules.push(c); }
      });
    },
    async deleteCapsule(id) {
      checkId(id);
      return store.mutate((d) => { d.capsules = d.capsules.filter((c) => c.id !== id); });
    },
    async restoreCapsule(id) {
      return restoreCapsule({state: () => store.snapshot(), actions, native, selfPids: env.selfPids, activity, windowWaitMs: env.windowWaitMs}, id);
    },

    async saveNote(input) {
      return store.mutate((d) => {
        const id = (input as {id?: unknown})?.id;
        const existing = typeof id === 'string' ? d.notes.find((n) => n.id === id) : undefined;
        const n = buildNote(input, existing, () => store.id(), store.nowIso());
        if (existing) d.notes[d.notes.indexOf(existing)] = n;
        else { withLimit(d.notes.length, LIMITS.notes, 'notes'); d.notes.push(n); }
      });
    },
    async deleteNote(id) {
      checkId(id);
      return store.mutate((d) => { d.notes = d.notes.filter((n) => n.id !== id); });
    },
    async saveTask(input) {
      return store.mutate((d) => {
        const id = (input as {id?: unknown})?.id;
        const existing = typeof id === 'string' ? d.tasks.find((t) => t.id === id) : undefined;
        const t = buildTask(input, existing, () => store.id(), store.nowIso());
        if (existing) d.tasks[d.tasks.indexOf(existing)] = t;
        else { withLimit(d.tasks.length, LIMITS.tasks, 'tasks'); d.tasks.push(t); }
      });
    },
    async deleteTask(id) {
      checkId(id);
      return store.mutate((d) => { d.tasks = d.tasks.filter((t) => t.id !== id); });
    },

    async chat(text): Promise<ChatMessage> {
      return sendChat({store, secrets, fetch: guardedFetch, cloudOrigin: env.cloudOriginOverride}, text);
    },
    async clearChat() { return store.mutate((d) => { d.chat = []; }); },

    async setCloudKey(key) {
      const r = await secrets.set(key);
      keyConfigured = true;
      system.invalidate();
      await activity('settings', 'Cloud API key stored (protected by Windows DPAPI)');
      return r;
    },
    async cloudKeyStatus() { keyConfigured = await secrets.configured(); return {configured: keyConfigured}; },
    async deleteCloudKey() {
      await secrets.delete();
      keyConfigured = false;
      system.invalidate();
      await activity('settings', 'Cloud API key removed');
    },

    previewAction: (a) => actions.preview(a),
    executeAction: (id, approved) => actions.execute(id, approved),

    speak: (text) => speech.speak(text),
    transcribe: (audio) => speech.transcribe(audio),

    async exportData() {
      const dest = await env.dialogs.saveExport(`jarvis-export-${stampForName((env.now ?? (() => new Date()))())}.json`);
      if (!dest) return {path: null};
      const n = normalizeAbsolutePath(dest);
      if ('error' in n) throw new ValidationError('The chosen export location is not valid');
      const file = /\.json$/i.test(n.path) ? n.path : `${n.path}.json`;
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, store.exportDocument(), 'utf8');
      await fsp.rename(tmp, file);
      await activity('backup', 'Exported data');
      return {path: file};
    },
    async importData() {
      const src = await env.dialogs.openImport();
      if (!src) return store.snapshot();
      const n = normalizeAbsolutePath(src);
      if ('error' in n) throw new ValidationError('The chosen import file is not valid');
      const st = await fsp.stat(n.path);
      if (!st.isFile() || st.size > MAX_IMPORT_BYTES) throw new ValidationError('The import file is not a file or is too large');
      const raw = await fsp.readFile(n.path, 'utf8');
      const state = await store.importDocument(raw);
      system.invalidate();
      await activity('backup', 'Imported data (a pre-import backup was taken)');
      return state;
    },
    async pickPath(kind) {
      if (kind !== 'file' && kind !== 'folder') throw new ValidationError('kind must be "file" or "folder"');
      const p = await env.dialogs.pick(kind);
      if (!p) return null;
      const n = normalizeAbsolutePath(p);
      return 'error' in n ? null : n.path;
    },
  };

  return {
    ...api,
    onActivity: (h: (a: Activity) => void) => store.onActivity(h),
    load, store, actions, system, speech, runner,
    async runRetention() { await store.applyRetention(); },
    async dispose() {
      speech.cancel();
      runner?.killAll();
      await store.backup('auto').catch(() => undefined);
    },
  };
}
