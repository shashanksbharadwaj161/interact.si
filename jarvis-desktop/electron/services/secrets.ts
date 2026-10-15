// Cloud API key vault. Only ciphertext touches disk, written atomically (temp file, flush, rename). Nothing here
// returns the key to the renderer, and the vault object itself never holds or serializes it (so it cannot end up in
// an export, a log line or a JSON dump by accident).
//
// Two protectors, both bound to the current Windows user:
//  - Electron safeStorage (preferred; no child process, matches docs/architecture.md). Injected so this module has
//    no Electron import. Blobs are stored as "ss1:<base64>".
//  - Windows DPAPI through the native helper (fallback, and the format of every key stored before safeStorage was
//    wired). Blobs are the bare helper output.
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';
import {randomBytes} from 'node:crypto';
import type {NativeAdapter} from '../native/adapter';
import {ValidationError} from './validation';

export interface SecretsFs {
  read(p: string): Promise<string | null>;
  write(p: string, data: string): Promise<void>;
  remove(p: string): Promise<void>;
}

/** Writers to the same file are serialized: Windows refuses concurrent renames onto one target (EPERM). */
const writeQueues = new Map<string, Promise<unknown>>();

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rename(from, to); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // A virus scanner or indexer can hold the target briefly; anything else is a real failure.
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
    }
  }
}

export const nodeSecretsFs: SecretsFs = {
  read: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  write: (p, data) => {
    const run = (writeQueues.get(p) ?? Promise.resolve()).catch(() => undefined).then(() => writeAtomic(p, data));
    writeQueues.set(p, run);
    return run.finally(() => { if (writeQueues.get(p) === run) writeQueues.delete(p); });
  },
  remove: async (p) => { await fsp.rm(p, {force: true}); },
};

async function writeAtomic(p: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), {recursive: true});
  // Unique temp name: two writers never share (and corrupt) one temp file.
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(tmp, 'wx');
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, p);
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await fsp.rm(tmp, {force: true}).catch(() => undefined);
    throw e;
  }
}

/** The part of Electron's safeStorage this module needs. Injected by the main process. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

const SAFE_PREFIX = 'ss1:';
const BLOB_RE = /^[A-Za-z0-9+/=\s]{16,16384}$/;

export function validateCloudKey(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('API key must be a string');
  const k = v.trim();
  if (k.length < 20 || k.length > 300) throw new ValidationError('API key length is not valid');
  if (!/^[\x21-\x7e]+$/.test(k)) throw new ValidationError('API key contains invalid characters');
  return k;
}

export class Secrets {
  private file: string;
  constructor(private native: Pick<NativeAdapter, 'dpapi'>, dir: string, private fs: SecretsFs = nodeSecretsFs, private safeStorage?: SafeStorageLike) {
    this.file = path.join(dir, 'secrets', 'cloud-key.bin');
  }

  /** Never serializes anything: JSON.stringify(vault) is safe to put in a log or an export. */
  toJSON(): {secrets: 'redacted'} { return {secrets: 'redacted'}; }

  private useSafeStorage(): boolean {
    try { return !!this.safeStorage && this.safeStorage.isEncryptionAvailable(); } catch { return false; }
  }

  async available(): Promise<{available: boolean; reason?: string}> {
    if (this.useSafeStorage()) return {available: true};
    try {
      const r = await this.native.dpapi('probe');
      return r.ok ? {available: true} : {available: false, reason: 'Windows DPAPI self-test failed'};
    } catch {
      return {available: false, reason: 'Windows DPAPI is unavailable (PowerShell could not run)'};
    }
  }

  async configured(): Promise<boolean> {
    const blob = await this.fs.read(this.file);
    return blob !== null && blob.trim().length > 0;
  }

  private async protect(k: string): Promise<string> {
    if (this.useSafeStorage()) {
      try { return SAFE_PREFIX + this.safeStorage!.encryptString(k).toString('base64'); } catch { /* fall through to DPAPI */ }
    }
    let enc: {ok: boolean; data?: string};
    try { enc = await this.native.dpapi('protect', k); } catch { throw new Error('Windows DPAPI is unavailable; the key was not stored'); }
    if (!enc.ok || typeof enc.data !== 'string' || !BLOB_RE.test(enc.data)) throw new Error('Windows DPAPI could not protect the key; the key was not stored');
    return enc.data;
  }

  private async unprotect(blob: string): Promise<string | null> {
    const b = blob.trim();
    if (b.startsWith(SAFE_PREFIX)) {
      if (!this.useSafeStorage()) return null;
      try { return this.safeStorage!.decryptString(Buffer.from(b.slice(SAFE_PREFIX.length), 'base64')); } catch { return null; }
    }
    try {
      const r = await this.native.dpapi('unprotect', b);
      return r.ok && r.data ? r.data : null;
    } catch { return null; }
  }

  /**
   * Encrypts, proves the blob decrypts back to the same key, and only then replaces the stored blob atomically.
   * A protector that returns garbage can therefore never destroy a working key.
   */
  async set(key: unknown): Promise<{configured: boolean}> {
    const k = validateCloudKey(key);
    const blob = await this.protect(k);
    if ((await this.unprotect(blob)) !== k) throw new Error('The protected key could not be verified; the previous key was kept');
    await this.fs.write(this.file, blob);
    return {configured: true};
  }

  /** Main-process only. Never expose through IPC (it is deliberately absent from electron/channels.ts). */
  async reveal(): Promise<string | null> {
    const blob = await this.fs.read(this.file);
    if (blob === null) return null;
    return this.unprotect(blob);
  }

  async delete(): Promise<void> {
    await this.fs.remove(this.file);
  }
}
