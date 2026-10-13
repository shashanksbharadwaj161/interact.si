// Pure input validation for everything that crosses the IPC boundary or is loaded from disk.
import type {Activity, AppState, Capsule, ChatMessage, Note, Settings, Task} from '../../src/shared/contracts';
import {hasControlChars, isDriveRoot, normalizeAbsolutePath} from './paths';

export class ValidationError extends Error {}

export const LIMITS = {
  text: 64 * 1024,
  chat: 16 * 1024,
  noteBody: 100_000,
  capsules: 200,
  notes: 5000,
  tasks: 5000,
  chatMessages: 500,
  activity: 1000,
  audioSamples: 480_000,
  speakChars: 4000,
  typeChars: 2000,
};

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  mode: 'offline',
  theme: 'graphite',
  reduceMotion: false,
  startInTray: false,
  localModel: 'llama3.2:3b',
  localEndpoint: DEFAULT_ENDPOINT,
  cloudModel: 'claude-haiku-4-5',
  voice: '',
  allowedRoots: [],
  approvedApps: [],
  retainDays: 90,
};

export function defaultState(): AppState {
  return {settings: {...DEFAULT_SETTINGS, allowedRoots: [], approvedApps: []}, capsules: [], notes: [], tasks: [], chat: [], activity: []};
}

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, name: string, max: number, opts: {min?: number; multiline?: boolean} = {}): string {
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  const s = opts.multiline ? v.replace(/\r\n/g, '\n') : v.trim();
  if (s.length > max) throw new ValidationError(`${name} is too long (max ${max})`);
  if ((opts.min ?? 0) > 0 && s.trim().length < (opts.min ?? 0)) throw new ValidationError(`${name} is required`);
  if (!opts.multiline && hasControlChars(s)) throw new ValidationError(`${name} contains control characters`);
  // eslint-disable-next-line no-control-regex
  if (opts.multiline && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new ValidationError(`${name} contains control characters`);
  return s;
}

function bool(v: unknown, name: string): boolean {
  if (typeof v !== 'boolean') throw new ValidationError(`${name} must be true or false`);
  return v;
}

function isoDate(v: unknown, name: string): string {
  const s = str(v, name, 40, {min: 1});
  if (Number.isNaN(Date.parse(s))) throw new ValidationError(`${name} is not a valid date`);
  return s;
}

export function checkId(v: unknown, name = 'id'): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ValidationError(`${name} is invalid`);
  return v;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function validateLocalEndpoint(v: unknown): string {
  const s = str(v, 'localEndpoint', 200, {min: 1});
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError('localEndpoint is not a valid URL');
  }
  if (u.protocol !== 'http:') throw new ValidationError('localEndpoint must use http on the loopback interface');
  if (!isLoopbackHost(u.hostname)) throw new ValidationError('localEndpoint must be a loopback address (127.0.0.1, localhost or ::1)');
  if (u.username || u.password) throw new ValidationError('localEndpoint must not contain credentials');
  return u.origin;
}

export function validateApprovedApp(v: unknown): string {
  const s = str(v, 'approved app', 520, {min: 1});
  if (/^[A-Za-z0-9._ -]+\.exe$/i.test(s)) return s;
  const n = normalizeAbsolutePath(s);
  if ('error' in n) throw new ValidationError(`approved app "${s}": ${n.error}`);
  if (!/\.exe$/i.test(n.path)) throw new ValidationError('approved apps must be .exe files');
  return n.path;
}

function uniqueCI(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(x.toLowerCase()) ? false : (seen.add(x.toLowerCase()), true)));
}

function settingsField(key: string, v: unknown): unknown {
  switch (key) {
    case 'onboarded': case 'reduceMotion': case 'startInTray': return bool(v, key);
    case 'mode':
      if (v !== 'offline' && v !== 'online') throw new ValidationError('mode must be "offline" or "online"');
      return v;
    case 'theme':
      if (v !== 'graphite' && v !== 'nebula' && v !== 'paper') throw new ValidationError('theme is not supported');
      return v;
    case 'localModel': return str(v, key, 200, {min: 1});
    case 'cloudModel': {
      const s = str(v, key, 100, {min: 1});
      if (!/^[A-Za-z0-9._:-]+$/.test(s)) throw new ValidationError('cloudModel contains invalid characters');
      return s;
    }
    case 'voice': return str(v, key, 200);
    case 'localEndpoint': return validateLocalEndpoint(v);
    case 'retainDays':
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 3650) throw new ValidationError('retainDays must be an integer from 1 to 3650');
      return v;
    case 'allowedRoots': {
      if (!Array.isArray(v) || v.length > 50) throw new ValidationError('allowedRoots must be a list of at most 50 folders');
      return uniqueCI(v.map((p) => {
        const n = normalizeAbsolutePath(p);
        if ('error' in n) throw new ValidationError(`allowed folder: ${n.error}`);
        if (isDriveRoot(n.path)) throw new ValidationError('A whole drive cannot be an allowed folder; choose a folder');
        return n.path;
      }));
    }
    case 'approvedApps': {
      if (!Array.isArray(v) || v.length > 100) throw new ValidationError('approvedApps must be a list of at most 100 entries');
      return uniqueCI(v.map(validateApprovedApp));
    }
    default: throw new ValidationError(`Unknown setting "${key}"`);
  }
}

/** Validates a partial settings update (unknown keys rejected) and returns a full merged Settings. */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isObj(patch)) throw new ValidationError('settings must be an object');
  const next: Record<string, unknown> = {...current};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    next[k] = settingsField(k, v);
  }
  return next as unknown as Settings;
}

export interface ParseOptions {
  /**
   * Disk loads and imports: an invalid allowedRoots/approvedApps entry (for example a UNC path saved before network
   * paths were refused) is dropped and reported in `dropped` instead of failing the whole file.
   */
  lenient?: boolean;
  dropped?: string[];
}

function lenientList(key: 'allowedRoots' | 'approvedApps', v: unknown, opts: ParseOptions): unknown {
  if (!opts.lenient || !Array.isArray(v) || v.length > 200) return v;
  const keep = v.filter((item) => {
    try { settingsField(key, [item]); return true; } catch {
      opts.dropped?.push(`${key}: ${String(item).slice(0, 80)}`);
      return false;
    }
  });
  return keep.slice(0, key === 'allowedRoots' ? 50 : 100);
}

function fullSettings(v: unknown, opts: ParseOptions = {}): Settings {
  if (!isObj(v)) throw new ValidationError('settings missing');
  const out: Record<string, unknown> = {};
  for (const k of SETTING_KEYS) {
    if (!(k in v)) { out[k] = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k]; continue; }
    out[k] = settingsField(k, k === 'allowedRoots' || k === 'approvedApps' ? lenientList(k, v[k], opts) : v[k]);
  }
  for (const k of Object.keys(v)) if (!SETTING_KEYS.includes(k)) throw new ValidationError(`Unknown setting "${k}"`);
  return out as unknown as Settings;
}

function rejectUnknown(o: Record<string, unknown>, allowed: string[], what: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new ValidationError(`Unknown ${what} field "${k}"`);
}

function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  }
  return v;
}

function capsuleItems(v: unknown): Capsule['items'] {
  if (!Array.isArray(v) || v.length > 100) throw new ValidationError('capsule items must be a list of at most 100');
  return v.map((it) => {
    if (!isObj(it)) throw new ValidationError('capsule item is invalid');
    rejectUnknown(it, ['kind', 'target', 'label'], 'capsule item');
    if (it.kind !== 'file' && it.kind !== 'folder' && it.kind !== 'url' && it.kind !== 'app') throw new ValidationError('capsule item kind is invalid');
    return {kind: it.kind, target: str(it.target, 'item target', 2048, {min: 1}), label: str(it.label ?? '', 'item label', 200)};
  });
}

function capsuleWindows(v: unknown): NonNullable<Capsule['windows']> {
  if (!Array.isArray(v) || v.length > 100) throw new ValidationError('capsule windows must be a list of at most 100');
  return v.map((w) => {
    if (!isObj(w)) throw new ValidationError('capsule window is invalid');
    rejectUnknown(w, ['title', 'process', 'x', 'y', 'width', 'height'], 'capsule window');
    return {
      title: str(w.title ?? '', 'window title', 500),
      process: str(w.process, 'window process', 260, {min: 1}),
      x: int(w.x, 'x', -100000, 100000), y: int(w.y, 'y', -100000, 100000),
      width: int(w.width, 'width', 1, 100000), height: int(w.height, 'height', 1, 100000),
    };
  });
}

const CAPSULE_KEYS = ['id', 'name', 'description', 'scene', 'createdAt', 'updatedAt', 'items', 'windows'];

/** Builds a validated Capsule from a partial input merged over an optional existing record. */
export function buildCapsule(input: unknown, existing: Capsule | undefined, newId: () => string, now: string): Capsule {
  if (!isObj(input)) throw new ValidationError('capsule must be an object');
  rejectUnknown(input, CAPSULE_KEYS, 'capsule');
  const base = existing;
  const name = 'name' in input ? str(input.name, 'name', 120, {min: 1}) : base?.name;
  if (!name) throw new ValidationError('name is required');
  const caps: Capsule = {
    id: base?.id ?? (input.id !== undefined ? checkId(input.id) : newId()),
    name,
    description: 'description' in input ? str(input.description, 'description', 2000, {multiline: true}) : base?.description ?? '',
    scene: 'scene' in input ? str(input.scene, 'scene', 64) : base?.scene ?? 'graphite',
    createdAt: base?.createdAt ?? now,
    updatedAt: now,
    items: 'items' in input ? capsuleItems(input.items) : base?.items ?? [],
  };
  const windows = 'windows' in input && input.windows !== undefined ? capsuleWindows(input.windows) : base?.windows;
  if (windows) caps.windows = windows;
  return caps;
}

export function buildNote(input: unknown, existing: Note | undefined, newId: () => string, now: string): Note {
  if (!isObj(input)) throw new ValidationError('note must be an object');
  rejectUnknown(input, ['id', 'title', 'body', 'tags', 'updatedAt'], 'note');
  const title = 'title' in input ? str(input.title, 'title', 200, {min: 1}) : existing?.title;
  if (!title) throw new ValidationError('title is required');
  let tags = existing?.tags ?? [];
  if ('tags' in input) {
    if (!Array.isArray(input.tags) || input.tags.length > 20) throw new ValidationError('tags must be a list of at most 20');
    tags = uniqueCI(input.tags.map((t) => str(t, 'tag', 50, {min: 1})));
  }
  return {
    id: existing?.id ?? (input.id !== undefined ? checkId(input.id) : newId()),
    title,
    body: 'body' in input ? str(input.body, 'body', LIMITS.noteBody, {multiline: true}) : existing?.body ?? '',
    tags,
    updatedAt: now,
  };
}

export function buildTask(input: unknown, existing: Task | undefined, newId: () => string, now: string): Task {
  if (!isObj(input)) throw new ValidationError('task must be an object');
  rejectUnknown(input, ['id', 'title', 'done', 'due', 'createdAt'], 'task');
  const title = 'title' in input ? str(input.title, 'title', 500, {min: 1}) : existing?.title;
  if (!title) throw new ValidationError('title is required');
  const task: Task = {
    id: existing?.id ?? (input.id !== undefined ? checkId(input.id) : newId()),
    title,
    done: 'done' in input ? bool(input.done, 'done') : existing?.done ?? false,
    createdAt: existing?.createdAt ?? now,
  };
  const due = 'due' in input ? (input.due === undefined || input.due === '' ? undefined : isoDate(input.due, 'due')) : existing?.due;
  if (due) task.due = due;
  return task;
}

function chatMessage(v: unknown): ChatMessage {
  if (!isObj(v)) throw new ValidationError('chat message is invalid');
  if (v.role !== 'user' && v.role !== 'assistant') throw new ValidationError('chat role is invalid');
  if (v.source !== 'local' && v.source !== 'cloud' && v.source !== 'system') throw new ValidationError('chat source is invalid');
  return {id: checkId(v.id), role: v.role, text: str(v.text, 'chat text', LIMITS.chat * 4, {multiline: true}), createdAt: isoDate(v.createdAt, 'createdAt'), source: v.source};
}

function activity(v: unknown): Activity {
  if (!isObj(v)) throw new ValidationError('activity entry is invalid');
  const a: Activity = {id: checkId(v.id), at: isoDate(v.at, 'at'), kind: str(v.kind, 'kind', 64, {min: 1}), summary: str(v.summary, 'summary', 500)};
  if (v.details !== undefined) a.details = str(v.details, 'details', 2000, {multiline: true});
  return a;
}

function list<T extends {id?: string}>(v: unknown, name: string, max: number, fn: (x: unknown) => T, unique = false): T[] {
  if (!Array.isArray(v)) throw new ValidationError(`${name} must be a list`);
  if (v.length > max) throw new ValidationError(`${name} has too many entries (max ${max})`);
  const out = v.map(fn);
  if (unique) {
    const ids = new Set<string>();
    for (const x of out) {
      if (x.id === undefined) continue;
      if (ids.has(x.id)) throw new ValidationError(`${name} contains a duplicate id`);
      ids.add(x.id);
    }
  }
  return out;
}

/** Whole-state validation, used for disk loads and imports. Throws ValidationError (see ParseOptions.lenient). */
export function parseState(v: unknown, opts: ParseOptions = {}): AppState {
  if (!isObj(v)) throw new ValidationError('state must be an object');
  const caps = (x: unknown) => {
    if (!isObj(x)) throw new ValidationError('capsule is invalid');
    const c = buildCapsule({...x, createdAt: undefined, updatedAt: undefined}, undefined, () => '', '');
    if (typeof x.id !== 'string') throw new ValidationError('capsule id missing');
    return {...c, id: checkId(x.id), createdAt: isoDate(x.createdAt, 'createdAt'), updatedAt: isoDate(x.updatedAt, 'updatedAt')};
  };
  return {
    settings: fullSettings(v.settings, opts),
    capsules: list(v.capsules, 'capsules', LIMITS.capsules, caps, true),
    notes: list(v.notes, 'notes', LIMITS.notes, (x) => {
      if (!isObj(x) || typeof x.id !== 'string') throw new ValidationError('note is invalid');
      const n = buildNote({...x, updatedAt: undefined}, undefined, () => '', '');
      return {...n, id: checkId(x.id), updatedAt: isoDate(x.updatedAt, 'updatedAt')};
    }, true),
    tasks: list(v.tasks, 'tasks', LIMITS.tasks, (x) => {
      if (!isObj(x) || typeof x.id !== 'string') throw new ValidationError('task is invalid');
      const t = buildTask({...x, createdAt: undefined}, undefined, () => '', '');
      return {...t, id: checkId(x.id), createdAt: isoDate(x.createdAt, 'createdAt')};
    }, true),
    chat: list(v.chat ?? [], 'chat', LIMITS.chatMessages, chatMessage),
    activity: list(v.activity ?? [], 'activity', LIMITS.activity, activity),
  };
}

export function validateChatText(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('chat text must be a string');
  const s = v.trim();
  if (!s) throw new ValidationError('chat text is empty');
  if (s.length > LIMITS.chat) throw new ValidationError(`chat text is too long (max ${LIMITS.chat})`);
  return s;
}

/**
 * Accepts either complete PCM WAV file bytes (RIFF/WAVE header, 0-255 values) or raw 16 kHz mono
 * Int16 samples (values -32768..32767) and returns a WAV file buffer.
 */
export function validateAudio(v: unknown): Buffer {
  if (!Array.isArray(v)) throw new ValidationError('audio must be an array of numbers');
  if (v.length < 2) throw new ValidationError('audio is empty');
  const maxBytes = 44 + LIMITS.audioSamples * 2;
  const isRiff = v.length >= 12 && [0x52, 0x49, 0x46, 0x46].every((b, i) => v[i] === b) && [0x57, 0x41, 0x56, 0x45].every((b, i) => v[8 + i] === b);
  if (isRiff) {
    if (v.length < 44) throw new ValidationError('WAV data is truncated');
    if (v.length > maxBytes + 1024) throw new ValidationError('audio is too long (max 30 seconds at 16 kHz mono)');
    const buf = Buffer.alloc(v.length);
    for (let i = 0; i < v.length; i++) {
      const b = v[i];
      if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) throw new ValidationError('WAV data contains a non-byte value');
      buf[i] = b;
    }
    if (buf.readUInt16LE(20) !== 1) throw new ValidationError('Only uncompressed PCM WAV audio is supported');
    return buf;
  }
  if (v.length > LIMITS.audioSamples) throw new ValidationError('audio is too long (max 30 seconds at 16 kHz mono)');
  const pcm = Buffer.alloc(v.length * 2);
  for (let i = 0; i < v.length; i++) {
    const n = v[i];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < -32768 || n > 32767) throw new ValidationError('audio samples must be 16-bit integers');
    pcm.writeInt16LE(n, i * 2);
  }
  return Buffer.concat([wavHeader(pcm.length, 16000), pcm]);
}

export function wavHeader(dataBytes: number, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}
