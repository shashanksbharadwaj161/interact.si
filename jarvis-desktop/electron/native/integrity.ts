// Helper-script integrity (NSR-13). scripts/build-main.mjs hashes native/*.ps1 at build time and embeds the manifest in the main
// bundle; the runner re-hashes the script (and the shared common.ps1 it dot-sources) before every spawn.
// This is tamper-evidence for a partly modified install, not a signature: someone who can rewrite the whole bundle can rewrite the
// manifest too. Authenticode signing of the installer/helpers is a separate, currently unavailable gate.
import {createHash} from 'node:crypto';

export interface NativeManifest {
  version: 1;
  algorithm: 'sha256';
  /** File name (e.g. "click.ps1") -> lowercase hex digest of the raw bytes. */
  files: Record<string, string>;
}

export interface IntegrityConfig {
  manifest: NativeManifest | null;
  /** True for packaged builds: a missing manifest then refuses to run helpers instead of skipping the check. */
  required: boolean;
}

export type ReadFileFn = (file: string) => Promise<Uint8Array>;

/** Shared module every helper dot-sources; always verified together with the requested script. */
export const SHARED_HELPERS = ['common.ps1'] as const;

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export function isNativeManifest(v: unknown): v is NativeManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<NativeManifest>;
  if (m.version !== 1 || m.algorithm !== 'sha256' || !m.files || typeof m.files !== 'object') return false;
  const entries = Object.entries(m.files);
  return entries.length > 0 && entries.every(([k, d]) => /^[A-Za-z0-9._-]+\.ps1$/.test(k) && typeof d === 'string' && /^[0-9a-f]{64}$/.test(d));
}

export function buildManifest(files: Record<string, Uint8Array | string>): NativeManifest {
  const out: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) out[name] = sha256Hex(files[name]);
  return {version: 1, algorithm: 'sha256', files: out};
}

export class IntegrityError extends Error {
  constructor(message: string, readonly file: string) { super(message); }
}

/** Constant-structure comparison of two hex digests (length is fixed, so a plain loop is enough). */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies each named file against the manifest. `join` builds the on-disk path from a bare file name.
 * Throws IntegrityError for a file missing from the manifest, unreadable, or whose digest differs.
 */
export async function verifyFiles(manifest: NativeManifest, names: readonly string[], join: (name: string) => string, read: ReadFileFn): Promise<void> {
  for (const name of names) {
    const want = Object.prototype.hasOwnProperty.call(manifest.files, name) ? manifest.files[name] : undefined;
    if (!want) throw new IntegrityError(`Native helper ${name} is not in the integrity manifest`, name);
    let bytes: Uint8Array;
    try { bytes = await read(join(name)); } catch { throw new IntegrityError(`Native helper ${name} could not be read`, name); }
    if (!sameDigest(sha256Hex(bytes), want)) throw new IntegrityError(`Native helper ${name} failed its integrity check and was not run`, name);
  }
}

let configured: IntegrityConfig = {manifest: null, required: false};

/** Called once by main.ts before the backend starts. Tests that build their own runner pass `integrity` explicitly instead. */
export function configureNativeIntegrity(c: IntegrityConfig): void { configured = {manifest: c.manifest, required: c.required}; }
export function getNativeIntegrity(): IntegrityConfig { return configured; }
