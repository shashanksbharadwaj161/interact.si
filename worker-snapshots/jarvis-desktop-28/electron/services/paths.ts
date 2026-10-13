// Pure Windows path-scope helpers. Lexical checks use path.win32 so behaviour is identical in tests.
// Only local drive paths (X:\...) are ever accepted: UNC, WebDAV, device and extended-length paths are rejected
// lexically, before any filesystem call, so a hostile target cannot make Windows contact the network or a device.
import * as nodePath from 'node:path';
import {promises as fsp} from 'node:fs';

const w = nodePath.win32;

export class PolicyError extends Error {}

/**
 * File types that may be opened through their default handler. Everything else (executables, scripts, installers,
 * disk images, shortcuts, search connectors, macro documents, ...) must go through approvedApps. Allowlist, not denylist.
 */
const OPENABLE_FILE_EXT = new Set([
  '.txt', '.md', '.pdf', '.rtf', '.csv', '.json', '.log',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff',
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.mp4', '.mkv', '.webm', '.mov', '.avi',
  '.zip',
]);

const RESERVED_NAMES = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

export function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(s);
}

/**
 * Lexically validates and normalizes an absolute local Windows path (drive letter only). Forward slashes are
 * converted first so every check sees the same string Windows would. Returns the path or a reason.
 */
export function normalizeAbsolutePath(input: unknown): {path: string} | {error: string} {
  if (typeof input !== 'string') return {error: 'Path must be a string'};
  const trimmed = input.trim();
  if (!trimmed) return {error: 'Path is empty'};
  if (trimmed.length > 520) return {error: 'Path is too long'};
  if (hasControlChars(trimmed)) return {error: 'Path contains control characters'};
  const raw = trimmed.replace(/\//g, '\\');
  if (/^\\\\[?.]/.test(raw)) return {error: 'Device paths are not allowed'};
  if (raw.startsWith('\\\\')) return {error: 'Network (UNC and WebDAV) paths are not allowed; use a local drive path'};
  if (/^[a-zA-Z]:(?!\\)/.test(raw)) return {error: 'Drive-relative paths are not allowed'};
  if (!/^[a-zA-Z]:\\/.test(raw)) return {error: 'Path must be absolute and start with a drive letter such as C:\\'};
  const segments = raw.slice(3).split('\\').filter((s) => s !== '');
  if (segments.some((seg) => seg === '..')) return {error: 'Path must not contain ".." segments'};
  const rest = raw.slice(2);
  if (rest.includes(':')) return {error: 'Alternate data streams are not allowed'};
  if (/[<>"|?*]/.test(rest)) return {error: 'Path contains invalid characters'};
  if (segments.some((seg) => seg !== '.' && /[. ]$/.test(seg))) return {error: 'Path segments must not end with a dot or space'};
  if (segments.some((seg) => RESERVED_NAMES.test(seg))) return {error: 'Reserved device names are not allowed in paths'};
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

/** True when a file of this type may be opened with its default handler (see OPENABLE_FILE_EXT). */
export function isOpenableFileExtension(p: string): boolean {
  return OPENABLE_FILE_EXT.has(w.extname(p).toLowerCase());
}

/** Kept for compatibility: anything that is not on the openable allowlist counts as dangerous. */
export function isDangerousFileExtension(p: string): boolean {
  return !isOpenableFileExtension(p);
}

export interface FsLike {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<{isDirectory(): boolean; isFile(): boolean}>;
}

export const realFs: FsLike = {realpath: (p) => fsp.realpath(p), stat: (p) => fsp.stat(p)};

export type ScopedPath = {ok: true; path: string; isDirectory: boolean} | {ok: false; reason: string};

/**
 * Resolves target through symlinks and requires it to exist inside one of allowedRoots
 * (roots are also resolved through symlinks). Rejects "..", ADS, UNC/device paths and file types that are not
 * on the openable allowlist. The lexical containment check runs before any filesystem call.
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
  const lexicalRoots: string[] = [];
  for (const root of allowedRoots) {
    const r = normalizeAbsolutePath(root);
    if (!('error' in r) && isInside(r.path, n.path)) lexicalRoots.push(r.path);
  }
  if (!lexicalRoots.length) return {ok: false, reason: 'Target is outside the allowed folders'};
  let real: string;
  try {
    real = await fs.realpath(n.path);
  } catch {
    return {ok: false, reason: 'Target does not exist'};
  }
  if (!/^[a-zA-Z]:\\/.test(real)) return {ok: false, reason: 'Target resolves to a network or device location, which is not allowed'};
  let isDirectory = false;
  try {
    const st = await fs.stat(real);
    isDirectory = st.isDirectory();
    if (!isDirectory && !st.isFile()) return {ok: false, reason: 'Target is not a regular file or folder'};
  } catch {
    return {ok: false, reason: 'Target does not exist'};
  }
  for (const root of lexicalRoots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (isInside(realRoot, real)) {
      if (!isDirectory && !opts.allowDangerousFiles && !isOpenableFileExtension(real)) {
        return {ok: false, reason: 'This file type cannot be opened directly (only documents, images, audio, video and archives); add an app to the approved apps instead'};
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
