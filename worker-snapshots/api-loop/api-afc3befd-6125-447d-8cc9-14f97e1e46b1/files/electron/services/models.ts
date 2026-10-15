// Local model runtime management for Ollama on loopback: health, version, list, switch, unload, resource profiles,
// offline model-pack import and guarded online downloads. Every request goes through the guarded fetch ('ollama' purpose).
// The renderer must only import TYPES from this file (it pulls in main-process modules).
// Nothing here downloads anything by itself: a pull is started only in online mode, by an explicit call, after an injected
// trusted guard approves it. The download is then performed by the local Ollama process, not by this app.
import {createReadStream, promises as fsp} from 'node:fs';
import {createHash} from 'node:crypto';
import * as w from 'node:path/win32';
import {assertRealFolders, chosenLocalPath} from './localFile';
import * as nodePath from 'node:path';
import {normalizeAbsolutePath, realFs, resolveInsideRoots, type ScopedPath} from './paths';
import type {Capability, ModelPin, PinActionResult, PinBlockedSelect, PinListResult, PinVerifyResult, Settings} from '../../src/shared/contracts';
import {comparePin, createPin, findPin, isPinMismatch, normalizePins, removePin, upsertPin, validatePinLabel} from '../../src/ui/model-pins';
import type {GuardedFetch} from './netGuard';
import {NetworkDenied} from './netGuard';
import {LOCAL_KEEP_ALIVE, readNdjson, type ChatProfile} from './chat';

// ---------- resource profiles ----------

export type ResourceProfileId = 'default' | 'low-memory' | 'balanced' | 'performance';
export interface ResourceProfile extends ChatProfile {
  id: ResourceProfileId;
  label: string;
  description: string;
}

/** 'default' reproduces the long-standing behaviour (Ollama's own context size, 2 minute keep-alive). */
export const RESOURCE_PROFILES: readonly ResourceProfile[] = [
  {id: 'default', label: 'Default', description: "Ollama's own context size; model stays loaded 2 minutes after a reply.", keepAlive: LOCAL_KEEP_ALIVE, numCtx: null},
  {id: 'low-memory', label: 'Low memory', description: 'Small 2048-token context; model is released 30 seconds after a reply. Best for 8 GB computers.', keepAlive: '30s', numCtx: 2048},
  {id: 'balanced', label: 'Balanced', description: '4096-token context; model stays loaded 5 minutes.', keepAlive: '5m', numCtx: 4096},
  {id: 'performance', label: 'Performance', description: '8192-token context; model stays loaded 15 minutes. Needs plenty of free memory.', keepAlive: '15m', numCtx: 8192},
];

export function getProfile(id: unknown): ResourceProfile {
  return RESOURCE_PROFILES.find((p) => p.id === id) ?? RESOURCE_PROFILES[0];
}

/** A suggestion only; the user picks. Based on installed memory and, when known, the model file size. */
export function recommendProfile(ramGB: number, modelBytes?: number): {id: ResourceProfileId; reason: string} {
  if (!Number.isFinite(ramGB) || ramGB <= 0) return {id: 'default', reason: 'Memory size is unknown.'};
  const modelGB = modelBytes && modelBytes > 0 ? modelBytes / 1024 ** 3 : 0;
  if (ramGB < 8 || (modelGB && modelGB > ramGB * 0.5)) return {id: 'low-memory', reason: modelGB > ramGB * 0.5 ? `The model (${modelGB.toFixed(1)} GB) is large for ${ramGB} GB of memory.` : `${ramGB} GB of memory is tight for local models.`};
  if (ramGB < 16 || (modelGB && modelGB > ramGB * 0.3)) return {id: 'balanced', reason: `${ramGB} GB of memory suits a moderate context.`};
  return {id: 'performance', reason: `${ramGB} GB of memory leaves room for a larger context.`};
}

// ---------- versions, names, formatting ----------

export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Ollama model name: up to three path segments and an optional tag. Rejects anything that could be a URL, path or option. */
const MODEL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){0,2}(:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
export function validateModelName(v: unknown): string {
  if (typeof v !== 'string' || v.length > 200 || !MODEL_NAME_RE.test(v.trim())) throw new Error('Model name is invalid. Use letters, digits, ".", "_", "-", an optional "/" namespace and an optional ":tag"');
  return v.trim();
}

function sameModel(a: string, b: string): boolean {
  const norm = (n: string) => (n.includes(':') ? n : `${n}:latest`).toLowerCase();
  return norm(a) === norm(b);
}

// ---------- types ----------

export interface InstalledModel {name: string; sizeBytes: number; family: string; parameterSize: string; quantization: string; modifiedAt: string}
export interface LoadedModel {name: string; sizeBytes: number; vramBytes: number; expiresAt: string | null}
export type HealthState = 'ready' | 'model-missing' | 'server-down' | 'blocked' | 'error';
export interface RuntimeHealth {
  state: HealthState;
  endpoint: string;
  version: string | null;
  configuredModel: string;
  configuredModelInstalled: boolean | null;
  installedCount: number;
  loaded: LoadedModel[];
  latencyMs: number | null;
  reason?: string;
  notes: string[];
}
export type Result<T> = ({ok: true} & T) | {ok: false; reason: string};

export type JobKind = 'pull' | 'import';
export type JobState = 'running' | 'done' | 'failed' | 'cancelled';
export interface ModelJob {
  id: string;
  kind: JobKind;
  model: string;
  state: JobState;
  status: string;
  /** 0..1 when the server reported totals, otherwise null. */
  progress: number | null;
  error?: string;
  startedAt: number;
}

/** Trusted confirmation owned by the native main process (a real dialog). Never a renderer-supplied boolean. */
export type ModelActionGuard = (req: {kind: JobKind; model: string; endpoint: string; detail: string}) => Promise<{allowed: boolean; reason?: string}>;

export interface PackFileStat {size: number; isFile: boolean; isSymlink: boolean}
export interface ModelPackIO {
  readText(path: string, maxBytes: number): Promise<string>;
  lstat(path: string): Promise<PackFileStat | null>;
  sha256(path: string): Promise<string>;
  openStream(path: string): ReadableStream<Uint8Array>;
}

export function createNodeModelPackIO(): ModelPackIO {
  return {
    async readText(p, max) {
      const st = await fsp.stat(p);
      if (st.size > max) throw new Error('File is too large');
      return fsp.readFile(p, 'utf8');
    },
    async lstat(p) {
      try {
        const st = await fsp.lstat(p);
        return {size: st.size, isFile: st.isFile(), isSymlink: st.isSymbolicLink()};
      } catch { return null; }
    },
    sha256(p) {
      return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(p).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
      });
    },
    openStream(p) {
      const rs = createReadStream(p);
      return new ReadableStream<Uint8Array>({
        start(c) { rs.on('data', (b) => { c.enqueue(new Uint8Array(b as Buffer)); rs.pause(); }); rs.on('end', () => c.close()); rs.on('error', (e) => c.error(e)); rs.pause(); },
        pull() { rs.resume(); },
        cancel() { rs.destroy(); },
      });
    },
  };
}

// ---------- model pack (offline import) ----------

export const PACK_MANIFEST = 'modelpack.json';
export const PACK_FORMAT = 'desktop-companion-modelpack';
const PACK_LIMITS = {manifestBytes: 64 * 1024, files: 8, textChars: 8000, paramEntries: 24};
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface PackFile {path: string; sha256: string; bytes: number}
export interface PackManifest {name: string; files: PackFile[]; template?: string; system?: string; parameters?: Record<string, string | number | string[]>}
export interface PackValidation {ok: boolean; manifest?: PackManifest; errors: string[]; totalBytes: number}

/** A pack-relative path: forward slashes, plain segments only. No drives, streams, traversal, reserved device names. */
export function validatePackPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 200) return 'path must be 1-200 characters';
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p)) return `path "${p.slice(0, 60)}" may only use letters, digits, ".", "_", "-" and "/"`;
  for (const seg of p.split('/')) {
    if (/^\.+$/.test(seg)) return `path "${p}" contains a relative segment`;
    if (RESERVED.test(seg)) return `path "${p}" uses a reserved Windows device name`;
    if (/[. ]$/.test(seg)) return `path "${p}" has a segment ending in a dot`;
  }
  if (!/\.gguf$/i.test(p)) return `file "${p}" is not a .gguf model file (only GGUF is supported)`;
  return null;
}

function localAbsoluteDir(dir: unknown): string | null {
  try { return chosenLocalPath(dir, 'model pack'); } catch { return null; }
}

/** Check ancestors with non-dereferencing lstat before accessing any pack file. */
async function assertPackFolders(dir: string): Promise<void> {
  const root = await fsp.lstat(w.parse(dir).root);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Pack drive root is not a real folder');
  await assertRealFolders(dir, 'model pack');
}

function parseManifest(text: string, errors: string[]): PackManifest | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { errors.push(`${PACK_MANIFEST} is not valid JSON`); return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) { errors.push(`${PACK_MANIFEST} must be an object`); return null; }
  const m = j as Record<string, unknown>;
  if (m.format !== PACK_FORMAT || m.version !== 1) errors.push(`${PACK_MANIFEST} must have format "${PACK_FORMAT}" and version 1`);
  let name = '';
  try { name = validateModelName(m.name); } catch (e) { errors.push(`name: ${(e as Error).message}`); }
  const files: PackFile[] = [];
  if (!Array.isArray(m.files) || m.files.length < 1 || m.files.length > PACK_LIMITS.files) errors.push(`files must list 1-${PACK_LIMITS.files} entries`);
  else {
    const seen = new Set<string>();
    for (const f of m.files as unknown[]) {
      const o = (f ?? {}) as Record<string, unknown>;
      const pe = validatePackPath(o.path);
      if (pe) { errors.push(pe); continue; }
      const path = o.path as string;
      if (seen.has(path.toLowerCase())) { errors.push(`file "${path}" is listed twice`); continue; }
      seen.add(path.toLowerCase());
      if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(o.sha256)) { errors.push(`file "${path}" needs a 64-character hex sha256`); continue; }
      if (typeof o.bytes !== 'number' || !Number.isSafeInteger(o.bytes) || o.bytes <= 0) { errors.push(`file "${path}" needs a positive byte size`); continue; }
      files.push({path, sha256: o.sha256.toLowerCase(), bytes: o.bytes});
    }
  }
  const out: PackManifest = {name, files};
  for (const k of ['template', 'system'] as const) {
    if (m[k] === undefined) continue;
    if (typeof m[k] !== 'string' || (m[k] as string).length > PACK_LIMITS.textChars) errors.push(`${k} must be text up to ${PACK_LIMITS.textChars} characters`);
    else out[k] = m[k] as string;
  }
  if (m.parameters !== undefined) {
    const p = m.parameters as Record<string, unknown>;
    const entries = p && typeof p === 'object' && !Array.isArray(p) ? Object.entries(p) : null;
    if (!entries || entries.length > PACK_LIMITS.paramEntries) errors.push('parameters must be an object with at most 24 entries');
    else {
      const ok: Record<string, string | number | string[]> = {};
      for (const [k, v] of entries) {
        const good = /^[a-z_]{1,32}$/.test(k) && (typeof v === 'number' || (typeof v === 'string' && v.length <= 200) || (Array.isArray(v) && v.length <= 16 && v.every((x) => typeof x === 'string' && x.length <= 200)));
        if (good) ok[k] = v as string | number | string[]; else errors.push(`parameter "${k.slice(0, 32)}" is invalid`);
      }
      out.parameters = ok;
    }
  }
  return errors.length ? null : out;
}

/** Checks a model-pack folder: manifest shape, path safety, no symlinks, exact sizes and SHA-256 of every file. Reads only; never starts anything. */
export async function validateModelPack(io: ModelPackIO, rawDir: unknown): Promise<PackValidation> {
  const dir = localAbsoluteDir(rawDir);
  if (!dir) return {ok: false, errors: ['Pack folder must be a local drive path such as C:\\Models\\pack'], totalBytes: 0};
  const errors: string[] = [];
  try { await assertPackFolders(dir); } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT' || /folder does not exist/.test((e as Error).message);
    return {ok: false, errors: [missing ? `${PACK_MANIFEST} was not found in the folder` : (e as Error).message], totalBytes: 0};
  }
  const mst = await io.lstat(`${dir}\\${PACK_MANIFEST}`);
  if (!mst || !mst.isFile || mst.isSymlink) return {ok: false, errors: [`${PACK_MANIFEST} was not found in the folder`], totalBytes: 0};
  let text = '';
  try { text = await io.readText(`${dir}\\${PACK_MANIFEST}`, PACK_LIMITS.manifestBytes); } catch { return {ok: false, errors: [`${PACK_MANIFEST} could not be read (max 64 KB)`], totalBytes: 0}; }
  const manifest = parseManifest(text, errors);
  if (!manifest) return {ok: false, errors, totalBytes: 0};
  let total = 0;
  for (const f of manifest.files) {
    const full = `${dir}\\${f.path.split('/').join('\\')}`;
    try { await assertPackFolders(w.dirname(full)); } catch (e) { errors.push(`file "${f.path}": ${(e as Error).message}`); continue; }
    const st = await io.lstat(full);
    if (st?.isSymlink) { errors.push(`file "${f.path}" is a link; links are not followed`); continue; }
    if (!st || !st.isFile) { errors.push(`file "${f.path}" is missing`); continue; }
    if (st.size !== f.bytes) { errors.push(`file "${f.path}" is ${st.size} bytes but the manifest says ${f.bytes}`); continue; }
    let digest = '';
    try { digest = await io.sha256(full); } catch { errors.push(`file "${f.path}" could not be read`); continue; }
    if (digest !== f.sha256) errors.push(`file "${f.path}" does not match its checksum`);
    total += st.size;
  }
  return errors.length ? {ok: false, errors, totalBytes: total} : {ok: true, manifest, errors: [], totalBytes: total};
}

// ---------- known local pack files (for version pins) ----------

/** Same normalisation as sameModel(): a bare name means ":latest", case-insensitive. */
export function modelKey(name: string): string {
  return (name.includes(':') ? name : `${name}:latest`).toLowerCase();
}

export interface KnownPackFile {modelId: string; dir: string; file: string}

/**
 * Model files this app has itself verified as part of a model pack (validatePack/startImport). Pins only ever hash a
 * file recorded here or one stored with an earlier pin, and only after a folder-scope check (see ModelPinService).
 */
export class PackPathRegistry {
  private byModel = new Map<string, KnownPackFile>();
  record(modelId: string, dir: string, file: string): void {
    if (typeof modelId !== 'string' || typeof dir !== 'string' || typeof file !== 'string' || !modelId || !dir || !file) return;
    this.byModel.delete(modelKey(modelId));
    this.byModel.set(modelKey(modelId), {modelId, dir, file});
    while (this.byModel.size > 64) this.byModel.delete(this.byModel.keys().next().value as string);
  }
  /** Records the largest file of a validated pack (the model weights). */
  recordPack(modelId: string, dir: string, manifest: PackManifest): void {
    const main = [...manifest.files].sort((a, b) => b.bytes - a.bytes)[0];
    if (main) this.record(modelId, dir, w.join(dir, ...main.path.split('/')));
  }
  get(modelId: string): KnownPackFile | null { return this.byModel.get(modelKey(modelId)) ?? null; }
  dirs(): string[] { return [...this.byModel.values()].map((v) => v.dir); }
}

/** Shared by the backend's ModelRuntime and the pin service registered in ipc.ts (one bundle, one instance). */
export const knownPackFiles = new PackPathRegistry();

/** Folders where local model files may live: OLLAMA_MODELS, the default Ollama store and the app's own models folder. */
export function defaultModelRoots(env: Record<string, string | undefined>, userData?: string): string[] {
  const out: string[] = [];
  const add = (p: string | undefined) => {
    if (!p) return;
    const n = normalizeAbsolutePath(p);
    if (!('error' in n) && !out.some((x) => x.toLowerCase() === n.path.toLowerCase())) out.push(n.path);
  };
  add(env.OLLAMA_MODELS);
  if (env.USERPROFILE) add(w.join(env.USERPROFILE, '.ollama', 'models'));
  if (userData) add(w.join(userData, 'models'));
  return out;
}

// ---------- streaming, cancellable SHA-256 digest ----------

export type DigestErrorCode = 'cancelled' | 'not-found' | 'too-large' | 'not-a-file' | 'unreadable';
export class DigestError extends Error {
  constructor(public readonly code: DigestErrorCode, message: string) {
    super(message);
    this.name = 'DigestError';
  }
}
export interface FileDigest {digest: string; sizeBytes: number}
export interface DigestOptions {signal?: AbortSignal; maxBytes: number}
export type DigestFn = (path: string, opts: DigestOptions) => Promise<FileDigest>;
/** Default upper bound for hashing one model file (64 GiB). */
export const PIN_DIGEST_MAX_BYTES = 64 * 1024 ** 3;

const cancelledDigest = () => new DigestError('cancelled', 'Digest cancelled: the check was stopped before it finished');
const tooLarge = (size: number, max: number) => new DigestError('too-large', `Model file is larger than the digest limit (${size} bytes, limit ${max} bytes)`);

/**
 * Streams a local file through SHA-256. Never follows a link at the final path, never reads more than maxBytes, and
 * stops promptly when signal aborts. Errors: 'cancelled', 'not found', 'too large', 'not a regular file', 'unreadable'.
 */
export const digestFile: DigestFn = async (p, opts) => {
  const max = opts?.maxBytes;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max <= 0) throw new DigestError('too-large', 'Digest limit must be a positive whole number of bytes');
  const signal = opts.signal;
  if (signal?.aborted) throw cancelledDigest();
  let st;
  try { st = await fsp.lstat(p); } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new DigestError('not-found', 'Model file not found: it was moved or deleted');
    throw new DigestError('unreadable', 'Model file could not be read');
  }
  if (signal?.aborted) throw cancelledDigest();
  if (st.isSymbolicLink() || !st.isFile()) throw new DigestError('not-a-file', 'Model file is not a regular file (links are not followed)');
  if (st.size > max) throw tooLarge(st.size, max);
  return new Promise<FileDigest>((resolve, reject) => {
    const h = createHash('sha256');
    const rs = createReadStream(p, {highWaterMark: 1 << 20});
    let n = 0, done = false;
    const finish = (err: Error | null, value?: FileDigest) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) { rs.destroy(); reject(err); } else resolve(value!);
    };
    const onAbort = () => finish(cancelledDigest());
    signal?.addEventListener('abort', onAbort, {once: true});
    rs.on('data', (chunk) => {
      if (done) return;
      const b = chunk as Buffer;
      n += b.length;
      if (n > max) { finish(tooLarge(n, max)); return; }
      h.update(b);
    });
    rs.on('error', (e) => finish((e as NodeJS.ErrnoException).code === 'ENOENT' ? new DigestError('not-found', 'Model file not found: it was moved or deleted') : new DigestError('unreadable', 'Model file could not be read')));
    rs.on('end', () => finish(null, {digest: h.digest('hex'), sizeBytes: n}));
  });
};

// ---------- version pins: persisted storage and verification ----------

export const PIN_STORE_FORMAT = 'desktop-companion-model-pins';
export const PIN_STORE_FILE = 'model-pins.json';

/** Raw persistence for the pin document. read() returns null when nothing was saved yet. */
export interface ModelPinStorage {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

/** model-pins.json in the app data folder: tmp file + rename, like the other sidecars. Never stores file contents. */
export function createFilePinStorage(dir: string): ModelPinStorage {
  const file = nodePath.join(dir, PIN_STORE_FILE);
  return {
    async read() {
      try {
        const st = await fsp.stat(file);
        if (st.size > 512 * 1024) throw new Error('Model pin file is too large');
        return await fsp.readFile(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw e;
      }
    },
    async write(text) {
      await fsp.mkdir(dir, {recursive: true});
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, text, 'utf8');
      try { await fsp.rename(tmp, file); } catch (e) { await fsp.unlink(tmp).catch(() => undefined); throw e; }
    },
  };
}

export function memoryPinStorage(initial: string | null = null): ModelPinStorage & {text: string | null} {
  const s = {text: initial, read: async () => s.text, write: async (t: string) => { s.text = t; }};
  return s;
}

/** File a pin was recorded from: the pack folder (scope root) and the file inside it. */
interface PinFileRef {dir: string; file: string}

export interface ModelPinDeps {
  storage: ModelPinStorage;
  digest?: DigestFn;
  packPaths?: PackPathRegistry;
  /** Fixed model folders (OLLAMA_MODELS, %USERPROFILE%\.ollama\models, app models folder). */
  modelRoots?: () => string[];
  /** Scope check; defaults to resolveInsideRoots (local drive paths only, links resolved, must stay inside a root). */
  resolveFile?: (file: string, roots: string[]) => Promise<ScopedPath>;
  now?: () => number;
  maxBytes?: number;
}

/**
 * Default scope check for a pinned file: a local drive path, reached only through real folders (no links or junctions,
 * checked with lstat before realpath), and inside one of the known model folders.
 */
export async function defaultPinResolve(file: string, roots: string[]): Promise<ScopedPath> {
  const n = normalizeAbsolutePath(file);
  if ('error' in n) return {ok: false, reason: n.error};
  try { await assertRealFolders(w.dirname(n.path), 'model'); } catch (e) { return {ok: false, reason: (e as Error).message}; }
  return resolveInsideRoots(n.path, roots, realFs, {allowDangerousFiles: true});
}

const PIN_ID_MAX = 200;
function pinModelId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > PIN_ID_MAX) throw new Error('Model name is required');
  return validateModelName(raw);
}

/**
 * Version pins for local model files. Offline only: it hashes files this app already knows (recorded pack files, or the
 * file stored with an earlier pin) after a folder-scope check, and never downloads anything. One check per model at a time;
 * cancelVerify aborts it. Writes are serialized.
 */
export class ModelPinService {
  private pins: ModelPin[] = [];
  private files: Record<string, PinFileRef> = {};
  private loading: Promise<void> | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private running = new Map<string, AbortController>();
  private digest: DigestFn;
  private now: () => number;

  constructor(private d: ModelPinDeps) {
    this.digest = d.digest ?? digestFile;
    this.now = d.now ?? Date.now;
  }

  private load(): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        let text: string | null = null;
        try { text = await this.d.storage.read(); } catch { text = null; }
        if (!text) return;
        let j: unknown;
        try { j = JSON.parse(text); } catch { return; }
        const o = (j && typeof j === 'object' && !Array.isArray(j) ? j : {}) as Record<string, unknown>;
        if (o.format !== PIN_STORE_FORMAT || o.version !== 1) return;
        this.pins = normalizePins(o.pins);
        const files = (o.files && typeof o.files === 'object' && !Array.isArray(o.files) ? o.files : {}) as Record<string, unknown>;
        for (const p of this.pins) {
          const ref = files[modelKey(p.modelId)] as Record<string, unknown> | undefined;
          if (ref && typeof ref.dir === 'string' && typeof ref.file === 'string' && ref.dir.length <= 520 && ref.file.length <= 520) this.files[modelKey(p.modelId)] = {dir: ref.dir, file: ref.file};
        }
      })();
    }
    return this.loading;
  }

  private persist(pins: ModelPin[], files: Record<string, PinFileRef>): Promise<void> {
    const run = async () => {
      await this.d.storage.write(JSON.stringify({format: PIN_STORE_FORMAT, version: 1, pins, files}));
      this.pins = pins;
      this.files = files;
    };
    const p = this.writes.then(run, run);
    this.writes = p.catch(() => undefined);
    return p;
  }

  async list(): Promise<ModelPin[]> {
    await this.load();
    return this.pins.map((p) => ({...p}));
  }

  /** The file to hash for a model: the recorded pack file first, then the one stored with its pin. Scope-checked. */
  private async locate(modelId: string): Promise<{dir: string; file: string}> {
    const known = (this.d.packPaths ?? knownPackFiles).get(modelId);
    const stored = this.files[modelKey(modelId)];
    const ref = known ? {dir: known.dir, file: known.file} : stored;
    if (!ref) throw new Error('No local model file is known for this model. Verify or import its model pack on this page first, then pin it');
    if (!/\.gguf$/i.test(ref.file)) throw new Error('Only .gguf model files can be pinned');
    const roots = [...(this.d.modelRoots?.() ?? []), ...(this.d.packPaths ?? knownPackFiles).dirs(), ...Object.values(this.files).map((f) => f.dir)];
    const resolve = this.d.resolveFile ?? defaultPinResolve;
    const scoped = await resolve(ref.file, roots);
    if (!scoped.ok) throw new Error(/does not exist/.test(scoped.reason) ? 'Model file not found: it was moved or deleted' : `Model file is not inside a known model folder: ${scoped.reason}`);
    if (scoped.isDirectory) throw new Error('Model file is a folder, not a file');
    return {dir: ref.dir, file: scoped.path};
  }

  /** Hashes the model's file; a new check for the same model cancels the previous one. */
  private async observe(modelId: string): Promise<{ref: {dir: string; file: string}; observed: FileDigest}> {
    const ref = await this.locate(modelId);
    const key = modelKey(modelId);
    this.running.get(key)?.abort();
    const ac = new AbortController();
    this.running.set(key, ac);
    try {
      return {ref, observed: await this.digest(ref.file, {signal: ac.signal, maxBytes: this.d.maxBytes ?? PIN_DIGEST_MAX_BYTES})};
    } finally {
      if (this.running.get(key) === ac) this.running.delete(key);
    }
  }

  /** Stops a running check (pin, verify or re-pin). With no model, stops every running check. */
  cancelVerify(rawModelId?: unknown): boolean {
    if (rawModelId === undefined) {
      const any = this.running.size > 0;
      for (const ac of this.running.values()) ac.abort();
      return any;
    }
    const ac = this.running.get(modelKey(pinModelId(rawModelId)));
    if (!ac) return false;
    ac.abort();
    return true;
  }

  private async savePin(modelId: string, label: string, ref: {dir: string; file: string}, observed: FileDigest): Promise<PinActionResult> {
    const pin = createPin({modelId, label, digest: observed.digest, sizeBytes: observed.sizeBytes, pinnedAt: new Date(this.now()).toISOString(), source: 'local-file'});
    let pins: ModelPin[];
    try { pins = upsertPin(this.pins, pin); } catch (e) { return {ok: false, reason: (e as Error).message}; }
    await this.persist(pins, {...this.files, [modelKey(modelId)]: {dir: ref.dir, file: ref.file}});
    return {ok: true, pin: {...pin}, pins: pins.map((p) => ({...p}))};
  }

  /** Hashes the model's current file and pins that exact digest and size. */
  async pinCurrent(rawModelId: unknown, rawLabel?: unknown): Promise<PinActionResult> {
    const modelId = pinModelId(rawModelId);
    const label = rawLabel === undefined || rawLabel === '' ? modelId.slice(0, 80) : validatePinLabel(rawLabel);
    await this.load();
    try {
      const {ref, observed} = await this.observe(modelId);
      return await this.savePin(modelId, label, ref, observed);
    } catch (e) { return {ok: false, reason: (e as Error).message}; }
  }

  async unpin(rawModelId: unknown): Promise<PinListResult> {
    const modelId = pinModelId(rawModelId);
    await this.load();
    this.cancelVerify(modelId);
    const key = modelKey(modelId);
    const files = {...this.files};
    delete files[key];
    const pins = removePin(this.pins, modelId).filter((p) => modelKey(p.modelId) !== key);
    await this.persist(pins, files);
    return {ok: true, pins: this.pins.map((p) => ({...p}))};
  }

  /** Re-hashes the file and compares it with the pin. Rejects with 'cancelled', 'not found' or 'too large' errors. */
  async verify(rawModelId: unknown): Promise<PinVerifyResult> {
    const modelId = pinModelId(rawModelId);
    await this.load();
    const pin = findPin(this.pins, modelId) ?? this.pins.find((p) => modelKey(p.modelId) === modelKey(modelId)) ?? null;
    if (!pin) return {modelId, pin: null, observed: null, status: 'unpinned', detail: comparePin(null, {digest: '0'.repeat(64), sizeBytes: 0}).detail};
    const {observed} = await this.observe(modelId);
    const cmp = comparePin(pin, observed);
    return {modelId, pin: {...pin}, observed: {...observed}, status: cmp.status, detail: cmp.detail};
  }

  /** After the user reviewed a mismatch: pins the file's new digest, keeping the label. Needs an existing pin. */
  async acknowledgeRepin(rawModelId: unknown): Promise<PinActionResult> {
    const modelId = pinModelId(rawModelId);
    await this.load();
    const old = this.pins.find((p) => modelKey(p.modelId) === modelKey(modelId));
    if (!old) return {ok: false, reason: 'This model is not pinned; use "Pin current file" instead'};
    try {
      const {ref, observed} = await this.observe(modelId);
      return await this.savePin(old.modelId, old.label, ref, observed);
    } catch (e) { return {ok: false, reason: (e as Error).message}; }
  }

  /**
   * Gate for model switching: null when the model is unpinned or its file matches the pin. Otherwise a blocked result
   * with the mismatch detail; a pinned file that cannot be checked (missing, cancelled, too large) also blocks (fail closed).
   */
  async gate(rawModelId: unknown): Promise<PinBlockedSelect | null> {
    const modelId = pinModelId(rawModelId);
    await this.load();
    if (!this.pins.some((p) => modelKey(p.modelId) === modelKey(modelId))) return null;
    let r: PinVerifyResult;
    try { r = await this.verify(modelId); } catch (e) {
      const detail = String((e as Error)?.message ?? 'The pinned file could not be checked').slice(0, 300);
      return {ok: false, blocked: true, modelId, status: 'unverified', detail, reason: `Blocked by version pin: the pinned file for "${modelId}" could not be verified (${detail}). Unpin it to use the model without a check.`};
    }
    if (!isPinMismatch(r.status)) return null;
    return {ok: false, blocked: true, modelId, status: r.status, detail: r.detail, reason: `Blocked by version pin: ${r.detail} Review the file, then use "Re-pin after review" or unpin it.`};
  }
}

// ---------- adapter contracts (no implementation: unsupported until a real engine is verified) ----------

export interface VisionAdapter {describeImage(image: Uint8Array, prompt: string, signal?: AbortSignal): Promise<string>}
export interface EmbeddingAdapter {embed(texts: string[], signal?: AbortSignal): Promise<number[][]>}
export interface FineTuneAdapter {startJob(datasetPath: string, baseModel: string, signal?: AbortSignal): Promise<{jobId: string}>}
export interface ModelAdapters {vision?: VisionAdapter; embeddings?: EmbeddingAdapter; fineTune?: FineTuneAdapter}

// ---------- runtime ----------

export interface ModelsOverview {
  health: RuntimeHealth;
  installed: InstalledModel[];
  installedError: string | null;
  profiles: ResourceProfile[];
  activeProfile: ResourceProfileId;
  recommendedProfile: {id: ResourceProfileId; reason: string};
  jobs: ModelJob[];
  capabilities: Capability[];
  /** Whether a download could start right now (online mode and a trusted guard); the reason when not. */
  downloads: {allowed: boolean; reason: string | null};
}

/** Renderer-facing surface the captain exposes over IPC. Methods map 1:1 to ModelRuntime. */
export interface ModelsClient {
  overview(): Promise<ModelsOverview>;
  select(name: string, opts?: {warm?: boolean; unloadOthers?: boolean}): Promise<Result<{patch: {localModel: string}; warmed: boolean}>>;
  unload(name?: string): Promise<Result<{unloaded: string[]}>>;
  setProfile(id: ResourceProfileId): Promise<ResourceProfileId>;
  validatePack(dir: string): Promise<PackValidation>;
  startImport(dir: string, name?: string): Promise<Result<{jobId: string}>>;
  startPull(model: string): Promise<Result<{jobId: string}>>;
  cancelJob(id: string): Promise<boolean>;
  pickPackFolder?(): Promise<string | null>;
}

export interface ModelsDeps {
  fetch: GuardedFetch;
  settings: () => Settings;
  ramGB?: () => number;
  /** Required for pulls; optional for imports. Supplied by the native main process (a trusted dialog). */
  guard?: ModelActionGuard;
  io?: ModelPackIO;
  adapters?: ModelAdapters;
  newId: () => string;
  now?: () => number;
  onJob?: (job: ModelJob) => void;
  /** Called when the profile changes so the owner can persist it. Settings has no profile field. */
  onProfile?: (id: ResourceProfileId) => void;
  initialProfile?: ResourceProfileId;
  /** Where verified pack files are recorded for version pins. Defaults to the shared knownPackFiles. */
  packPaths?: PackPathRegistry;
  /**
   * Version-pin check run by select() before anything is activated. A non-null result is returned unchanged instead of
   * the settings patch (the model is pinned and its file no longer matches or cannot be verified).
   */
  pinGate?: (name: string) => Promise<PinBlockedSelect | null>;
}

const PROBE_MS = 1500;
const MAX_JOBS = 20;

export class ModelRuntime {
  private profileId: ResourceProfileId;
  private jobsById = new Map<string, {job: ModelJob; ac: AbortController}>();
  private now: () => number;

  constructor(private d: ModelsDeps) {
    this.profileId = getProfile(d.initialProfile).id;
    this.now = d.now ?? Date.now;
  }

  // -- plumbing

  private endpoint(): string { return this.d.settings().localEndpoint; }

  private req(path: string, init: RequestInit & {timeoutMs?: number} = {}): Promise<Response> {
    return this.d.fetch(`${this.endpoint()}${path}`, init, 'ollama');
  }

  private post(path: string, body: unknown, init: RequestInit & {timeoutMs?: number} = {}): Promise<Response> {
    return this.req(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), ...init});
  }

  private why(e: unknown): {kind: 'blocked' | 'down' | 'error'; reason: string} {
    if (e instanceof NetworkDenied) return {kind: 'blocked', reason: `Endpoint blocked: ${e.message}`};
    const err = e as Error & {cause?: {code?: string}};
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message ?? '')) {
      return {kind: 'down', reason: `Ollama is not running at ${this.endpoint()}`};
    }
    return {kind: 'error', reason: String(err?.message ?? 'Unknown error').slice(0, 200)};
  }

  // -- read-only queries

  async version(): Promise<Result<{version: string}>> {
    try {
      const res = await this.req('/api/version', {timeoutMs: PROBE_MS});
      if (!res.ok) return {ok: false, reason: `Ollama returned HTTP ${res.status}`};
      const v = ((await res.json()) as {version?: unknown}).version;
      return typeof v === 'string' && v ? {ok: true, version: v.slice(0, 40)} : {ok: false, reason: 'Ollama did not report a version'};
    } catch (e) { return {ok: false, reason: this.why(e).reason}; }
  }

  async list(): Promise<Result<{models: InstalledModel[]}>> {
    try {
      const res = await this.req('/api/tags', {timeoutMs: PROBE_MS});
      if (!res.ok) return {ok: false, reason: `Ollama returned HTTP ${res.status}`};
      const j = (await res.json()) as {models?: {name?: string; model?: string; size?: number; modified_at?: string; details?: {family?: string; parameter_size?: string; quantization_level?: string}}[]};
      const models = (j.models ?? []).slice(0, 500).map((m) => ({
        name: String(m.name ?? m.model ?? '').slice(0, 200),
        sizeBytes: typeof m.size === 'number' && m.size >= 0 ? m.size : 0,
        family: String(m.details?.family ?? '').slice(0, 40),
        parameterSize: String(m.details?.parameter_size ?? '').slice(0, 20),
        quantization: String(m.details?.quantization_level ?? '').slice(0, 20),
        modifiedAt: String(m.modified_at ?? '').slice(0, 40),
      })).filter((m) => m.name);
      return {ok: true, models};
    } catch (e) { return {ok: false, reason: this.why(e).reason}; }
  }

  /** Models currently loaded in memory (GET /api/ps). */
  async running(): Promise<Result<{models: LoadedModel[]}>> {
    try {
      const res = await this.req('/api/ps', {timeoutMs: PROBE_MS});
      if (!res.ok) return {ok: false, reason: `Ollama returned HTTP ${res.status}`};
      const j = (await res.json()) as {models?: {name?: string; model?: string; size?: number; size_vram?: number; expires_at?: string}[]};
      return {ok: true, models: (j.models ?? []).slice(0, 50).map((m) => ({name: String(m.name ?? m.model ?? '').slice(0, 200), sizeBytes: Number(m.size) || 0, vramBytes: Number(m.size_vram) || 0, expiresAt: m.expires_at ? String(m.expires_at).slice(0, 40) : null})).filter((m) => m.name)};
    } catch (e) { return {ok: false, reason: this.why(e).reason}; }
  }

  async health(): Promise<RuntimeHealth> {
    const s = this.d.settings();
    const base: RuntimeHealth = {state: 'error', endpoint: s.localEndpoint, version: null, configuredModel: s.localModel, configuredModelInstalled: null, installedCount: 0, loaded: [], latencyMs: null, notes: []};
    const t0 = this.now();
    const [list, ver, ps] = await Promise.all([this.list(), this.version(), this.running()]);
    if (!list.ok) {
      const down = /not running/.test(list.reason);
      return {...base, state: /blocked/i.test(list.reason) ? 'blocked' : down ? 'server-down' : 'error', reason: list.reason};
    }
    const installed = list.models.some((m) => sameModel(m.name, s.localModel));
    const out: RuntimeHealth = {...base, state: installed ? 'ready' : 'model-missing', version: ver.ok ? ver.version : null, configuredModelInstalled: installed, installedCount: list.models.length, loaded: ps.ok ? ps.models : [], latencyMs: Math.max(0, this.now() - t0)};
    if (!installed) out.reason = `Ollama is running but model "${s.localModel}" is not installed.`;
    if (!ver.ok) out.notes.push(`Version unavailable: ${ver.reason}`);
    if (!ps.ok) out.notes.push(`Loaded-model list unavailable: ${ps.reason}`);
    return out;
  }

  // -- actions on already-installed models (loopback only)

  /**
   * Verifies the model is installed and returns the settings patch. It does NOT save settings: saving the AI connection
   * needs the owner's trusted confirmation. Optionally preloads the model and frees the others.
   */
  async select(rawName: unknown, opts: {warm?: boolean; unloadOthers?: boolean} = {}): Promise<Result<{patch: {localModel: string}; warmed: boolean}>> {
    let name: string;
    try { name = validateModelName(rawName); } catch (e) { return {ok: false, reason: (e as Error).message}; }
    const list = await this.list();
    if (!list.ok) return {ok: false, reason: list.reason};
    const found = list.models.find((m) => sameModel(m.name, name));
    if (!found) return {ok: false, reason: `Model "${name}" is not installed in Ollama. Import a model pack or install it with "ollama pull ${name}" first`};
    if (this.d.pinGate) {
      let blocked: PinBlockedSelect | null;
      try { blocked = await this.d.pinGate(found.name); } catch (e) {
        blocked = {ok: false, blocked: true, modelId: found.name, status: 'unverified', detail: String((e as Error)?.message ?? 'Version pin check failed').slice(0, 200), reason: 'Blocked by version pin: the pinned file could not be verified, so the model was not activated'};
      }
      if (blocked) return blocked;
    }
    if (opts.unloadOthers) {
      const ps = await this.running();
      if (ps.ok) for (const m of ps.models) if (!sameModel(m.name, found.name)) await this.unload(m.name);
    }
    let warmed = false;
    if (opts.warm) {
      try {
        const res = await this.post('/api/generate', {model: found.name, keep_alive: getProfile(this.profileId).keepAlive}, {timeoutMs: 120_000});
        warmed = res.ok;
      } catch { warmed = false; }
    }
    return {ok: true, patch: {localModel: found.name}, warmed};
  }

  /** Frees a model from memory (keep_alive 0). With no name, frees every loaded model. */
  async unload(rawName?: unknown): Promise<Result<{unloaded: string[]}>> {
    let names: string[];
    if (rawName === undefined) {
      const ps = await this.running();
      if (!ps.ok) return {ok: false, reason: ps.reason};
      names = ps.models.map((m) => m.name);
    } else {
      try { names = [validateModelName(rawName)]; } catch (e) { return {ok: false, reason: (e as Error).message}; }
    }
    const unloaded: string[] = [];
    for (const n of names) {
      try {
        const res = await this.post('/api/generate', {model: n, keep_alive: 0}, {timeoutMs: 10_000});
        if (!res.ok) return {ok: false, reason: res.status === 404 ? `Model "${n}" is not installed` : `Ollama returned HTTP ${res.status}`};
        unloaded.push(n);
      } catch (e) { return {ok: false, reason: this.why(e).reason}; }
    }
    return {ok: true, unloaded};
  }

  // -- resource profiles

  profile(): ResourceProfile { return getProfile(this.profileId); }

  setProfile(id: unknown): ResourceProfileId {
    const p = RESOURCE_PROFILES.find((x) => x.id === id);
    if (!p) throw new Error('Unknown resource profile');
    this.profileId = p.id;
    try { this.d.onProfile?.(p.id); } catch { /* a failing observer must not undo the change */ }
    return p.id;
  }

  /** For ChatDeps.profile. */
  chatProfile = (): ChatProfile => {
    const p = getProfile(this.profileId);
    return {keepAlive: p.keepAlive, numCtx: p.numCtx};
  };

  // -- capabilities beyond chat: reported honestly

  /** What the configured model says it can do (POST /api/show), or null when it cannot be read. */
  private async reportedCapabilities(): Promise<string[] | null> {
    try {
      const res = await this.post('/api/show', {model: this.d.settings().localModel}, {timeoutMs: PROBE_MS});
      if (!res.ok) return null;
      const c = ((await res.json()) as {capabilities?: unknown}).capabilities;
      return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string').slice(0, 20) : null;
    } catch { return null; }
  }

  async capabilities(): Promise<Capability[]> {
    const reported = await this.reportedCapabilities();
    const a = this.d.adapters ?? {};
    const note = (cap: string) => (reported?.includes(cap) ? ` The configured model reports "${cap}", but this app has no ${cap} pipeline.` : '');
    return [
      a.vision ? {id: 'local-vision', name: 'Local image understanding', available: true, reason: 'A vision adapter is registered; it has not been verified by this module.'}
        : {id: 'local-vision', name: 'Local image understanding', available: false, reason: `Not supported: no image input path exists.${note('vision')}`},
      a.embeddings ? {id: 'local-embeddings', name: 'Local embeddings', available: true, reason: 'An embedding adapter is registered; it has not been verified by this module.'}
        : {id: 'local-embeddings', name: 'Local embeddings', available: false, reason: `Not supported: search uses keyword matching only.${note('embedding')}`},
      a.fineTune ? {id: 'local-finetune', name: 'Local fine-tuning', available: true, reason: 'A fine-tuning adapter is registered; it has not been verified by this module.'}
        : {id: 'local-finetune', name: 'Local fine-tuning', available: false, reason: 'Not supported: no training engine is installed or bundled.'},
    ];
  }

  downloadsStatus(): {allowed: boolean; reason: string | null} {
    if (this.d.settings().mode !== 'online') return {allowed: false, reason: 'Offline mode never downloads models. Switch to online mode to download, or import a model pack.'};
    if (!this.d.guard) return {allowed: false, reason: 'No trusted confirmation is available, so downloads are disabled.'};
    return {allowed: true, reason: null};
  }

  async overview(): Promise<ModelsOverview> {
    const [health, list, capabilities] = await Promise.all([this.health(), this.list(), this.capabilities()]);
    const installed = list.ok ? list.models : [];
    const current = installed.find((m) => sameModel(m.name, this.d.settings().localModel));
    return {
      health, installed, installedError: list.ok ? null : list.reason,
      profiles: [...RESOURCE_PROFILES], activeProfile: this.profileId,
      recommendedProfile: recommendProfile(this.d.ramGB?.() ?? 0, current?.sizeBytes),
      jobs: this.jobs(), capabilities, downloads: this.downloadsStatus(),
    };
  }

  // -- jobs: offline pack import and guarded online pull

  jobs(): ModelJob[] { return [...this.jobsById.values()].map((e) => ({...e.job})); }

  cancelJob(id: string): boolean {
    const e = this.jobsById.get(id);
    if (!e || e.job.state !== 'running') return false;
    e.ac.abort();
    return true;
  }

  private busy(): boolean { return [...this.jobsById.values()].some((e) => e.job.state === 'running'); }

  private begin(kind: JobKind, model: string): {job: ModelJob; ac: AbortController} {
    const e = {job: {id: this.d.newId(), kind, model, state: 'running' as JobState, status: 'Starting', progress: null, startedAt: this.now()} as ModelJob, ac: new AbortController()};
    this.jobsById.set(e.job.id, e);
    while (this.jobsById.size > MAX_JOBS) {
      const old = [...this.jobsById.values()].find((x) => x.job.state !== 'running');
      if (!old) break;
      this.jobsById.delete(old.job.id);
    }
    this.emit(e.job);
    return e;
  }

  /** Job observers are best-effort: one that throws must not fail the job or leave it stuck in 'running'. */
  private emit(job: ModelJob): void {
    try { this.d.onJob?.({...job}); } catch { /* ignore */ }
  }

  private update(e: {job: ModelJob}, patch: Partial<ModelJob>): void {
    Object.assign(e.job, patch);
    this.emit(e.job);
  }

  private finish(e: {job: ModelJob; ac: AbortController}, err?: unknown): void {
    if (!err) return this.update(e, {state: 'done', status: 'Finished', progress: 1});
    if (e.ac.signal.aborted) return this.update(e, {state: 'cancelled', status: 'Cancelled'});
    this.update(e, {state: 'failed', status: 'Failed', error: this.why(err).reason});
  }

  private async consume(res: Response, e: {job: ModelJob; ac: AbortController}, scale: (frac: number) => number = (f) => f): Promise<void> {
    let ok = false;
    for await (const part of readNdjson(res.body, e.ac.signal)) {
      if (typeof part.error === 'string') throw new Error(`Ollama reported: ${part.error.slice(0, 160)}`);
      const status = typeof part.status === 'string' ? part.status.slice(0, 80) : e.job.status;
      const total = Number(part.total), done = Number(part.completed);
      this.update(e, {status, ...(total > 0 && done >= 0 ? {progress: Math.min(1, scale(done / total))} : {})});
      if (status === 'success') ok = true;
    }
    if (!ok) throw new Error('Ollama ended the stream before reporting success');
  }

  private async approve(kind: JobKind, model: string, detail: string): Promise<string | null> {
    if (!this.d.guard) return kind === 'pull' ? 'No trusted confirmation is available, so the download was not started' : null;
    try {
      const r = await this.d.guard({kind, model, endpoint: this.endpoint(), detail});
      return r.allowed ? null : r.reason ?? 'The request was declined';
    } catch { return 'The confirmation could not be shown, so nothing was started'; }
  }

  /** Online download through the local Ollama. Refused offline, without a trusted guard, or when the guard declines. */
  async startPull(rawModel: unknown): Promise<Result<{jobId: string}>> {
    let model: string;
    try { model = validateModelName(rawModel); } catch (e) { return {ok: false, reason: (e as Error).message}; }
    const gate = this.downloadsStatus();
    if (!gate.allowed) return {ok: false, reason: gate.reason!};
    if (this.busy()) return {ok: false, reason: 'Another model job is still running'};
    const denied = await this.approve('pull', model, `Ollama will download "${model}" from the internet. The size depends on the model.`);
    if (denied) return {ok: false, reason: denied};
    if (this.busy()) return {ok: false, reason: 'Another model job is still running'};
    const e = this.begin('pull', model);
    void (async () => {
      try {
        const res = await this.post('/api/pull', {model, stream: true}, {signal: e.ac.signal});
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);
        await this.consume(res, e);
        this.finish(e);
      } catch (err) { this.finish(e, err); }
    })();
    return {ok: true, jobId: e.job.id};
  }

  async validatePack(dir: unknown): Promise<PackValidation> {
    const v = await validateModelPack(this.d.io ?? createNodeModelPackIO(), dir);
    if (v.ok && v.manifest) {
      try { (this.d.packPaths ?? knownPackFiles).recordPack(v.manifest.name, chosenLocalPath(dir, 'model pack'), v.manifest); } catch { /* recording is best-effort */ }
    }
    return v;
  }

  /** Offline import: validates the pack, then hands the verified files to the local Ollama. Never touches the internet. */
  async startImport(dir: unknown, rawName?: unknown): Promise<Result<{jobId: string}>> {
    const io = this.d.io ?? createNodeModelPackIO();
    const v = await validateModelPack(io, dir);
    if (!v.ok || !v.manifest) return {ok: false, reason: `Model pack rejected: ${v.errors.slice(0, 3).join('; ')}`};
    let name = v.manifest.name;
    if (rawName !== undefined && rawName !== '') { try { name = validateModelName(rawName); } catch (e) { return {ok: false, reason: (e as Error).message}; } }
    const keys = v.manifest.files.map((f) => f.path.split('/').pop()!.toLowerCase());
    if (new Set(keys).size !== keys.length) return {ok: false, reason: 'Model pack rejected: two files share the same name'};
    if (this.busy()) return {ok: false, reason: 'Another model job is still running'};
    const denied = await this.approve('import', name, `Import ${v.manifest.files.length} verified file(s), ${(v.totalBytes / 1024 ** 3).toFixed(2)} GB, into Ollama as "${name}". No download happens.`);
    if (denied) return {ok: false, reason: denied};
    if (this.busy()) return {ok: false, reason: 'Another model job is still running'};
    const manifest = v.manifest;
    const base = chosenLocalPath(dir, 'model pack');
    try { (this.d.packPaths ?? knownPackFiles).recordPack(name, base, manifest); } catch { /* recording is best-effort */ }
    const e = this.begin('import', name);
    void (async () => {
      try {
        let sent = 0;
        const files: Record<string, string> = {};
        for (const f of manifest.files) {
          const full = w.join(base, ...f.path.split('/'));
          // Recheck after the trusted dialog, and immediately before opening the stream.
          await assertPackFolders(w.dirname(full));
          const st = await io.lstat(full);
          if (!st || !st.isFile || st.isSymlink || st.size !== f.bytes) throw new Error(`Model pack file "${f.path}" changed or is a link`);
          const digest = `sha256:${f.sha256}`;
          files[f.path.split('/').pop()!] = digest;
          this.update(e, {status: `Checking ${f.path}`});
          const head = await this.req(`/api/blobs/${digest}`, {method: 'HEAD', signal: e.ac.signal});
          if (head.status === 200) { sent += f.bytes; this.update(e, {progress: sent / v.totalBytes * 0.9}); continue; }
          if (head.status !== 404) throw new Error(`Ollama returned HTTP ${head.status}`);
          this.update(e, {status: `Sending ${f.path}`});
          const before = sent;
          let counted = 0;
          const counter = new TransformStream<Uint8Array, Uint8Array>({
            transform: (chunk, c) => { counted += chunk.byteLength; this.update(e, {progress: (before + counted) / v.totalBytes * 0.9}); c.enqueue(chunk); },
          });
          await assertPackFolders(w.dirname(full));
          const current = await io.lstat(full);
          if (!current || !current.isFile || current.isSymlink || current.size !== f.bytes) throw new Error(`Model pack file "${f.path}" changed or is a link`);
          const body = io.openStream(full).pipeThrough(counter);
          const up = await this.req(`/api/blobs/${digest}`, {method: 'POST', body, duplex: 'half', signal: e.ac.signal, headers: {'content-type': 'application/octet-stream'}} as RequestInit);
          if (!up.ok) throw new Error(up.status === 400 ? 'Ollama rejected the file: its checksum did not match' : `Ollama returned HTTP ${up.status}`);
          sent += f.bytes;
        }
        this.update(e, {status: 'Creating model', progress: 0.9});
        const res = await this.post('/api/create', {model: name, files, stream: true, ...(manifest.template ? {template: manifest.template} : {}), ...(manifest.system ? {system: manifest.system} : {}), ...(manifest.parameters ? {parameters: manifest.parameters} : {})}, {signal: e.ac.signal});
        if (!res.ok) throw new Error(res.status === 404 ? 'This Ollama version does not support creating models from files' : `Ollama returned HTTP ${res.status}`);
        await this.consume(res, e, (f) => 0.9 + f * 0.1);
        this.finish(e);
      } catch (err) { this.finish(e, err); }
    })();
    return {ok: true, jobId: e.job.id};
  }
}
