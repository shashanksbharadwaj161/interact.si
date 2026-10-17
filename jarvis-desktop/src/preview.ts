/**
 * BROWSER PREVIEW BRIDGE — for visual QA only.
 *
 * Installed by src/main.tsx only when `window.jarvis` is missing (i.e. the page is opened in a plain
 * browser instead of Electron). It implements the JarvisAPI contract in memory/localStorage so the
 * interface can be reviewed. Everything that would touch the machine, a model, a microphone, a speaker
 * or a cloud service is UNAVAILABLE and says so; nothing is simulated as a real result. Only local
 * demo CRUD (settings, capsules, notes, tasks, chat clearing) works, and the UI labels the whole
 * session as a preview.
 */
import type { Activity, ActionPreview, ActionRequest, AppState, Capsule, JarvisAPI, Note, Settings, SystemInfo, Task } from './shared/contracts';

const KEY = 'jarvis.preview.state.v1';
const UNAVAILABLE = 'Unavailable in browser preview (no Electron backend).';

let preview = false;
export const isPreviewBridge = (): boolean => preview;

const defaults = (): AppState => ({
  settings: {
    onboarded: false,
    mode: 'offline',
    theme: 'graphite',
    reduceMotion: false,
    startInTray: false,
    localModel: '',
    localEndpoint: 'http://127.0.0.1:11434',
    cloudModel: '',
    voice: '',
    allowedRoots: [],
    approvedApps: [],
    retainDays: 90,
  },
  capsules: [],
  notes: [],
  tasks: [],
  chat: [],
  activity: [],
});

let mem: AppState | null = null;
const handlers = new Set<(a: Activity) => void>();
let seq = 0;
const id = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}`;
const now = () => new Date().toISOString();
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function load(): AppState {
  if (mem) return mem;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AppState>;
      mem = { ...defaults(), ...parsed, settings: { ...defaults().settings, ...(parsed.settings ?? {}) } };
      return mem;
    }
  } catch {
    /* fall through to defaults */
  }
  mem = defaults();
  return mem;
}

function save(): AppState {
  const s = load();
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* in-memory only */
  }
  return clone(s);
}

function log(kind: string, summary: string): void {
  const a: Activity = { id: id('act'), at: now(), kind: `preview:${kind}`, summary: `[preview] ${summary}` };
  const s = load();
  s.activity = [a, ...s.activity].slice(0, 100);
  handlers.forEach((h) => h(a));
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [item, ...list];
}

function systemInfo(): SystemInfo {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    platform: `${navigator.platform || 'browser'} (browser preview)`,
    arch: 'unknown',
    ramGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0,
    cpu: navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency} logical threads (browser-reported)` : 'unknown',
    capabilities: [
      { id: 'preview-storage', name: 'Demo storage (this browser only)', available: true, reason: 'Records live in this browser’s localStorage and are not the Electron app’s data.' },
      { id: 'local-model', name: 'Local text model', available: false, reason: UNAVAILABLE },
      { id: 'speech-recognition', name: 'Speech recognition', available: false, reason: UNAVAILABLE },
      { id: 'speech-playback', name: 'Speech playback', available: false, reason: UNAVAILABLE },
      { id: 'computer-actions', name: 'Computer actions', available: false, reason: UNAVAILABLE },
      { id: 'capsule-restore', name: 'Capsule restore', available: false, reason: UNAVAILABLE },
      { id: 'cloud-provider', name: 'Cloud provider', available: false, reason: UNAVAILABLE },
    ],
  };
}

export function createPreviewBridge(): JarvisAPI {
  preview = true;
  const api: JarvisAPI = {
    async getState() {
      return clone(load());
    },
    async saveSettings(patch: Partial<Settings>) {
      const s = load();
      s.settings = { ...s.settings, ...patch };
      log('settings', 'Settings saved');
      return save();
    },
    async getSystemInfo() {
      return systemInfo();
    },
    async saveCapsule(c: Partial<Capsule>) {
      const s = load();
      const prev = s.capsules.find((x) => x.id === c.id);
      const full: Capsule = {
        id: c.id ?? id('cap'),
        name: c.name ?? prev?.name ?? 'Untitled capsule',
        description: c.description ?? prev?.description ?? '',
        scene: c.scene ?? prev?.scene ?? 'deep-space',
        createdAt: prev?.createdAt ?? now(),
        updatedAt: now(),
        items: c.items ?? prev?.items ?? [],
        windows: c.windows ?? prev?.windows,
      };
      s.capsules = upsert(s.capsules, full);
      log('capsule', `Capsule “${full.name}” saved`);
      return save();
    },
    async deleteCapsule(cid: string) {
      const s = load();
      s.capsules = s.capsules.filter((x) => x.id !== cid);
      log('capsule', 'Capsule deleted');
      return save();
    },
    async restoreCapsule(cid: string) {
      const c = load().capsules.find((x) => x.id === cid);
      return { opened: [], failed: (c?.items ?? []).map((i) => ({ target: i.target, reason: UNAVAILABLE })) };
    },
    async saveNote(n: Partial<Note>) {
      const s = load();
      const prev = s.notes.find((x) => x.id === n.id);
      const full: Note = { id: n.id ?? id('note'), title: n.title ?? prev?.title ?? 'Untitled', body: n.body ?? prev?.body ?? '', tags: n.tags ?? prev?.tags ?? [], updatedAt: now() };
      s.notes = upsert(s.notes, full);
      log('note', `Note “${full.title}” saved`);
      return save();
    },
    async deleteNote(nid: string) {
      const s = load();
      s.notes = s.notes.filter((x) => x.id !== nid);
      log('note', 'Note deleted');
      return save();
    },
    async saveTask(t: Partial<Task>) {
      const s = load();
      const prev = s.tasks.find((x) => x.id === t.id);
      const full: Task = { id: t.id ?? id('task'), title: t.title ?? prev?.title ?? 'Untitled task', done: t.done ?? prev?.done ?? false, due: 'due' in t ? t.due : prev?.due, createdAt: prev?.createdAt ?? now() };
      s.tasks = upsert(s.tasks, full);
      log('task', `Task “${full.title}” saved`);
      return save();
    },
    async deleteTask(tid: string) {
      const s = load();
      s.tasks = s.tasks.filter((x) => x.id !== tid);
      log('task', 'Task deleted');
      return save();
    },
    async chat() {
      throw new Error(`No assistant in browser preview. ${UNAVAILABLE}`);
    },
    async clearChat() {
      load().chat = [];
      return save();
    },
    async setCloudKey() {
      throw new Error('Cloud keys are never stored by the browser preview.');
    },
    async cloudKeyStatus() {
      return { configured: false };
    },
    async deleteCloudKey() {
      /* nothing is stored in preview */
    },
    async previewAction(action: ActionRequest): Promise<ActionPreview> {
      return { id: id('prev'), summary: `Preview of “${action.type}” is not available.`, requiresApproval: true, allowed: false, reason: UNAVAILABLE };
    },
    async executeAction() {
      throw new Error(UNAVAILABLE);
    },
    async speak() {
      return { ok: false, reason: UNAVAILABLE };
    },
    async transcribe() {
      return { text: '', reason: UNAVAILABLE };
    },
    async speechStop() {
      return false;
    },
    async transcribeCancel() {
      return false;
    },
    async exportData() {
      return { path: null };
    },
    async importData() {
      throw new Error(`Import is unavailable in browser preview.`);
    },
    async pickPath() {
      return null;
    },
    onActivity(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return api;
}

/** Adds clearly labelled demo records so layouts can be reviewed. Preview only. */
export async function seedPreviewDemo(api: JarvisAPI): Promise<void> {
  const today = new Date();
  const day = (offset: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  await api.saveCapsule({
    name: '[Demo] Layout review capsule',
    description: 'Demo record created by the browser preview. Restoring it does nothing here.',
    scene: 'orbit',
    items: [
      { kind: 'url', target: 'https://example.com/', label: 'Example URL' },
      { kind: 'folder', target: 'C:\\Demo\\Folder', label: 'Demo folder' },
      { kind: 'app', target: 'notepad.exe', label: 'Demo app' },
    ],
  });
  await api.saveNote({ title: '[Demo] Sample note', body: 'Demo text for reviewing the notes layout.\n\nCreated by the browser preview, not by the app.', tags: ['demo'] });
  await api.saveTask({ title: '[Demo] Overdue example', due: day(-1), done: false });
  await api.saveTask({ title: '[Demo] Due today example', due: day(0), done: false });
  await api.saveTask({ title: '[Demo] Upcoming example', due: day(3), done: false });
  await api.saveTask({ title: '[Demo] Finished example', done: true });
}

export function resetPreviewData(): void {
  mem = defaults();
  save();
}
