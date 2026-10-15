// File access for paths chosen in a main-process dialog. Every path component is checked with lstat,
// which never dereferences, so a symlink or junction (including one that points at a UNC/WebDAV share)
// is refused before anything reads through it. realpath is deliberately not used: resolving a link
// to a network target can itself contact that target.
import {promises as fsp} from 'node:fs';
import * as w from 'node:path/win32';
import {normalizeAbsolutePath} from './paths';
import {ValidationError} from './validation';

export interface LinkStat { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean; size: number; ino?: number | bigint }

/** Filesystem seam. lstat must not follow links; the rest act on paths already checked. */
export interface LocalFileFs {
  lstat(p: string): Promise<LinkStat>;
  readFile(p: string): Promise<string>;
  /** Exclusive create: fails when anything (including a dangling link) already exists at p. */
  createFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(p: string): Promise<void>;
}

export const realLocalFs: LocalFileFs = {
  lstat: (p) => fsp.lstat(p),
  readFile: (p) => fsp.readFile(p, 'utf8'),
  createFile: (p, data) => fsp.writeFile(p, data, {encoding: 'utf8', flag: 'wx'}),
  rename: (a, b) => fsp.rename(a, b),
  unlink: (p) => fsp.unlink(p),
};

const LINK_REFUSED = 'goes through a shortcut link or junction, which is not allowed';
const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

async function lstatOrNull(fs: LocalFileFs, p: string): Promise<LinkStat | null> {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** A dialog result as a normalized local drive path; UNC, device, relative, ".." and stream paths fail. */
export function chosenLocalPath(p: unknown, what: string): string {
  const n = normalizeAbsolutePath(p);
  if ('error' in n || !/^[a-zA-Z]:\\/.test(n.path)) throw new ValidationError(`The chosen ${what} location is not valid`);
  return n.path;
}

/** Requires every folder from the drive root down to dir to exist as a real folder, not a link or junction. */
export async function assertRealFolders(dir: string, what: string, fs: LocalFileFs = realLocalFs): Promise<void> {
  const root = w.parse(dir).root;
  const parts = dir.slice(root.length).split('\\').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = w.join(cur, part);
    const st = await lstatOrNull(fs, cur);
    if (!st) throw new ValidationError(`The chosen ${what} folder does not exist`);
    if (st.isSymbolicLink()) throw new ValidationError(`The chosen ${what} location ${LINK_REFUSED}`);
    if (!st.isDirectory()) throw new ValidationError(`The chosen ${what} location is not inside a folder`);
  }
}

/**
 * Bounded read of a chosen file: a regular local file with the extension and at most maxBytes, reached only
 * through real folders. A leading byte-order mark is removed. The path never leaves the main process.
 */
export async function readChosenFile(p: unknown, opts: {ext?: string; maxBytes: number; what: string}, fs: LocalFileFs = realLocalFs): Promise<string> {
  const file = chosenLocalPath(p, opts.what);
  if (opts.ext && !file.toLowerCase().endsWith(opts.ext)) throw new ValidationError(`Choose a ${opts.ext} file`);
  await assertRealFolders(w.dirname(file), opts.what, fs);
  const st = await lstatOrNull(fs, file);
  if (!st) throw new ValidationError(`The chosen ${opts.what} does not exist`);
  if (st.isSymbolicLink()) throw new ValidationError(`The chosen ${opts.what} ${LINK_REFUSED}`);
  if (!st.isFile()) throw new ValidationError(`The chosen ${opts.what} is not a file`);
  if (st.size > opts.maxBytes) throw new ValidationError(`The chosen ${opts.what} is larger than ${Math.round(opts.maxBytes / 1000)} KB`);
  const text = await fs.readFile(file);
  if (text.length > opts.maxBytes) throw new ValidationError(`The chosen ${opts.what} changed while it was being read`);
  return stripBom(text);
}

export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * Writes data to a chosen destination through a fresh temporary file and a rename. The parent chain must be real
 * folders, and an existing destination or leftover temporary file must be a regular file (never a link).
 */
export async function writeChosenFile(file: string, data: string, what: string, fs: LocalFileFs = realLocalFs): Promise<void> {
  const target = chosenLocalPath(file, what);
  await assertRealFolders(w.dirname(target), what, fs);
  const tmp = `${target}.tmp`;
  for (const p of [target, tmp]) {
    const st = await lstatOrNull(fs, p);
    if (st && (st.isSymbolicLink() || !st.isFile())) throw new ValidationError(`The chosen ${what} destination ${st.isSymbolicLink() ? LINK_REFUSED : 'is not a file'}`);
  }
  if (await lstatOrNull(fs, tmp)) await fs.unlink(tmp);
  await fs.createFile(tmp, data);
  try {
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}
