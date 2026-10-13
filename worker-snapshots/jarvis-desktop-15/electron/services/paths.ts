// Pure Windows path-scope helpers. Lexical checks use path.win32 so behaviour is identical in tests.
import * as nodePath from 'node:path';
import {promises as fsp} from 'node:fs';

const w = nodePath.win32;

export class PolicyError extends Error {}

const DANGEROUS_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp',
  '.scr', '.hta', '.reg', '.dll', '.cpl', '.lnk', '.url', '.msc', '.jar', '.pif', '.gadget', '.application', '.appref-ms',
]);

export function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s);
}

/** Lexically validates and normalizes an absolute Windows path. Returns null with a reason when invalid. */
export function normalizeAbsolutePath(input: unknown): {path: string} | {error: string} {
  if (typeof input !== 'string') return {error: 'Path must be a string'};
  const raw = input.trim();
  if (!raw) return {error: 'Path is empty'};
  if (raw.length > 520) return {error: 'Path is too long'};
  if (hasControlChars(raw)) return {error: 'Path contains control characters'};
  if (/^\\\\[?.]\\/.test(raw)) return {error: 'Device paths are not allowed'};
  if (!w.isAbsolute(raw)) return {error: 'Path must be absolute'};
  if (/^[a-zA-Z]:(?![\\/])/.test(raw)) return {error: 'Drive-relative paths are not allowed'};
  if (raw.split(/[\\/]+/).some((seg) => seg === '..')) return {error: 'Path must not contain ".." segments'};
  const rest = raw.replace(/^[a-zA-Z]:/, '');
  if (rest.includes(':')) return {error: 'Alternate data streams are not allowed'};
  if (/[<>"|?*]/.test(rest.replace(/^\\\\[?.]\\/, ''))) return {error: 'Path contains invalid characters'};
  let norm = w.normalize(raw);
  if (!/^[a-zA-Z]:\\$/.test(norm)) norm = norm.replace(/\\+$/, '');
  return {path: norm};
}

export function isDriveRoot(p: string): boolean {
  return /^[a-zA-Z]:\\?$/.test(p) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(p);
}

export function samePath(a: string, b: string): boolean {
  return w.normalize(a).toLowerCase().replace(/\\+$/, '') === w.normalize(b).toLowerCase().replace(/\\+$/, '');
}

/** True when child equals or is inside root (case-insensitive, separator-aware). */
export function isInside(root: string, child: string): boolean {
  const r = w.normalize(root).toLowerCase().replace(/\\+$/, '');
  const c = w.normalize(child).toLowerCase().replace(/\\+$/, '');
  return c === r || c.startsWith(r + '\\');
}

export function isDangerousFileExtension(p: string): boolean {
  return DANGEROUS_EXT.has(w.extname(p).toLowerCase());
}

export interface FsLike {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{isDirectory(): boolean; isFile(): boolean}>;
}

export const realFs: FsLike = {realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p)};

export type ScopedPath = {ok: true; path: string; isDirectory: boolean} | {ok: false; reason: string};

/**
 * Resolves target through symlinks and requires it to exist inside one of allowedRoots
 * (roots are also resolved through symlinks). Rejects "..", ADS, device paths, dangerous file types.
 */
export async function resolveInsideRoots(
  target: unknown,
  allowedRoots: string[],
  fs: FsLike = realFs,
  opts: {allowDangerousFiles?: boolean} = {},
): Promise<ScopedPath> {
  const n = normalizeAbsolutePath(target);
  if ('error' in n) return {ok: false, reason: n.error};
  if (!allowedRoots.length) return {ok: false, reason: 'No allowed folders are configured'};
  let real: string;
  try {
    real = await fs.realpath(n.path);
  } catch {
    return {ok: false, reason: 'Target does not exist'};
  }
  let isDirectory = false;
  try {
    const st = await fs.stat(real);
    isDirectory = st.isDirectory();
    if (!isDirectory && !st.isFile()) return {ok: false, reason: 'Target is not a regular file or folder'};
  } catch {
    return {ok: false, reason: 'Target does not exist'};
  }
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (isInside(realRoot, real)) {
      if (!isDirectory && !opts.allowDangerousFiles && isDangerousFileExtension(real)) {
        return {ok: false, reason: 'Executable and script file types cannot be opened as files; use an approved app'};
      }
      return {ok: true, path: real, isDirectory};
    }
  }
  return {ok: false, reason: 'Target is outside the allowed folders'};
}

/** Maps a path inside app.asar to app.asar.unpacked, as required for executables/scripts. */
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar(?=[\\/]|$)/i, 'app.asar.unpacked');
}
