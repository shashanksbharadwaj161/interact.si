// Cloud API key vault. The key is encrypted with Windows DPAPI (CurrentUser) by a native helper that
// receives it on stdin. Only ciphertext touches disk. Nothing here returns the key to the renderer.
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';
import type {NativeAdapter} from '../native/adapter';
import {ValidationError} from './validation';

export interface SecretsFs {
  read(p: string): Promise<string | null>;
  write(p: string, data: string): Promise<void>;
  remove(p: string): Promise<void>;
}

export const nodeSecretsFs: SecretsFs = {
  read: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  write: async (p, data) => {
    await fsp.mkdir(path.dirname(p), {recursive: true});
    const tmp = p + '.tmp';
    try {
      await fsp.writeFile(tmp, data, 'utf8');
      await fsp.rename(tmp, p);
    } catch (e) {
      await fsp.rm(tmp, {force: true}).catch(() => undefined);
      throw e;
    }
  },
  remove: async (p) => { await fsp.rm(p, {force: true}); },
};

export function validateCloudKey(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('API key must be a string');
  const k = v.trim();
  if (k.length < 20 || k.length > 300) throw new ValidationError('API key length is not valid');
  if (!/^[\x21-\x7e]+$/.test(k)) throw new ValidationError('API key contains invalid characters');
  return k;
}

export class Secrets {
  private file: string;
  constructor(private native: Pick<NativeAdapter, 'dpapi'>, dir: string, private fs: SecretsFs = nodeSecretsFs) {
    this.file = path.join(dir, 'secrets', 'cloud-key.bin');
  }

  async available(): Promise<{available: boolean; reason?: string}> {
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

  async set(key: unknown): Promise<{configured: boolean}> {
    const k = validateCloudKey(key);
    let enc: {ok: boolean; data?: string};
    try { enc = await this.native.dpapi('protect', k); } catch { throw new Error('Windows DPAPI is unavailable; the key was not stored'); }
    if (!enc.ok || typeof enc.data !== 'string' || !/^[A-Za-z0-9+/=\s]{16,16384}$/.test(enc.data)) throw new Error('Windows DPAPI could not protect the key; the key was not stored');
    await this.fs.write(this.file, enc.data);
    return {configured: true};
  }

  /** Main-process only. Never expose through IPC. */
  async reveal(): Promise<string | null> {
    const blob = await this.fs.read(this.file);
    if (blob === null) return null;
    try {
      const r = await this.native.dpapi('unprotect', blob.trim());
      return r.ok && r.data ? r.data : null;
    } catch { return null; }
  }

  async delete(): Promise<void> {
    await this.fs.remove(this.file);
  }
}
