// User-approved TXT/Markdown documents for the writing workspace. The user picks one file in a main-process dialog;
// the main process validates the path (local drive only, no UNC/device/stream paths, no links or junctions anywhere
// in the chain), the extension and the size BEFORE reading, then decodes strict UTF-8. The renderer receives a
// bounded plain-text preview and an opaque token, never the path. Nothing is stored until the user reviews the
// preview and saves it as a note; discarding or letting the token expire forgets the text.
import {promises as fsp} from 'node:fs';
import * as w from 'node:path/win32';
import {assertRealFolders, chosenLocalPath, type LinkStat, type LocalFileFs} from './localFile';
import {LIMITS, ValidationError} from './validation';
import type {ApprovedDocumentPreview, ApprovedDocumentSaveOptions} from '../../src/shared/contracts';

export const DOCUMENT_LIMITS = {
  /** Largest file read at all; also the largest note body the store accepts. */
  maxBytes: LIMITS.noteBody,
  /** Previews kept in memory at once; opening another drops the oldest. */
  maxPending: 4,
  /** A preview nobody saved or discarded is forgotten after this long. */
  ttlMs: 10 * 60_000,
};

/** Note titles are validated to 200 characters (validation.ts buildNote). */
const NOTE_TITLE_MAX = 200;

export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown'] as const;
/** Formats people commonly pick that need a parser this app does not ship. Reported explicitly, never read. */
export const UNSUPPORTED_EXTENSIONS: Readonly<Record<string, string>> = {
  '.pdf': 'PDF', '.doc': 'Word', '.docx': 'Word', '.rtf': 'Rich Text', '.odt': 'OpenDocument', '.pages': 'Pages', '.html': 'HTML', '.htm': 'HTML',
};
export const DOCUMENT_FILTERS = [
  {name: 'Text or Markdown', extensions: ['txt', 'md', 'markdown']},
];

/** Filesystem seam: lstat never follows links; readBytes acts only on a path that already passed every check. */
export interface DocumentFs {
  lstat(p: string): Promise<LinkStat>;
  readBytes(p: string, maxBytes: number): Promise<Uint8Array>;
}

export const realDocumentFs: DocumentFs = {
  lstat: (p) => fsp.lstat(p),
  async readBytes(p, maxBytes) {
    // Read at most maxBytes + 1 so a file that grew after lstat is detected without reading it whole.
    const fh = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes + 1);
      let n = 0;
      while (n < buf.length) {
        const {bytesRead} = await fh.read(buf, n, buf.length - n, n);
        if (!bytesRead) break;
        n += bytesRead;
      }
      return buf.subarray(0, n);
    } finally {
      await fh.close();
    }
  },
};

export type DocumentDialog = () => Promise<string | null>;
export type SaveNote = (note: {title: string; body: string; tags: string[]}) => Promise<void>;

interface Pending { name: string; text: string; expires: number }

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINK_REFUSED = 'goes through a shortcut link or junction, which is not allowed';

/** C0/C1 controls other than tab and newline are dropped so the preview is plain text with no terminal/bidi tricks. */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function decodeStrictUtf8(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes);
  } catch {
    throw new ValidationError('The chosen document is not valid UTF-8 text. Save it as UTF-8 and try again');
  }
  if (text.includes('\u0000')) throw new ValidationError('The chosen document contains binary data, not text');
  return text;
}

export function cleanDocumentText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
}

/** First Markdown heading or first non-empty line, else the file name without extension; bounded to a note title. */
export function suggestTitle(text: string, name: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const heading = line.replace(/^#{1,6}\s+/, '').trim();
  const base = heading || w.basename(name, w.extname(name));
  return (base || 'Imported document').slice(0, NOTE_TITLE_MAX);
}

export class ApprovedDocuments {
  private pending = new Map<string, Pending>();

  constructor(private opts: {dialog: DocumentDialog; saveNote: SaveNote; newToken: () => string; fs?: DocumentFs; now?: () => number; limits?: Partial<typeof DOCUMENT_LIMITS>}) {}

  private get limits() { return {...DOCUMENT_LIMITS, ...this.opts.limits}; }
  private now() { return (this.opts.now ?? Date.now)(); }
  private get fs() { return this.opts.fs ?? realDocumentFs; }

  get pendingCount(): number { this.sweep(); return this.pending.size; }

  /** Opens the dialog and returns a preview. Cancel and unsupported formats read nothing. */
  async choose(): Promise<ApprovedDocumentPreview> {
    const picked = await this.opts.dialog();
    if (!picked) return {status: 'cancelled'};
    const file = chosenLocalPath(picked, 'document');
    const name = w.basename(file);
    const ext = w.extname(file).toLowerCase();
    if (UNSUPPORTED_EXTENSIONS[ext]) {
      return {status: 'unsupported', name, format: UNSUPPORTED_EXTENSIONS[ext], reason: `${UNSUPPORTED_EXTENSIONS[ext]} documents are not supported yet. Save a copy as .txt or .md and choose that instead.`};
    }
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) throw new ValidationError('Choose a .txt or .md document');
    const {maxBytes} = this.limits;
    // assertRealFolders only calls lstat; the other members are never reached through it.
    await assertRealFolders(w.dirname(file), 'document', this.fs as unknown as LocalFileFs);
    let st: LinkStat;
    try { st = await this.fs.lstat(file); } catch { throw new ValidationError('The chosen document does not exist'); }
    if (st.isSymbolicLink()) throw new ValidationError(`The chosen document ${LINK_REFUSED}`);
    if (!st.isFile()) throw new ValidationError('The chosen document is not a file');
    if (st.size > maxBytes) throw new ValidationError(`The chosen document is larger than ${Math.round(maxBytes / 1000)} KB`);
    const bytes = await this.fs.readBytes(file, maxBytes);
    if (bytes.length > maxBytes) throw new ValidationError('The chosen document changed while it was being read');
    const text = cleanDocumentText(decodeStrictUtf8(bytes));
    if (!text.trim()) throw new ValidationError('The chosen document is empty');
    this.sweep();
    while (this.pending.size >= this.limits.maxPending) this.pending.delete(this.pending.keys().next().value as string);
    const token = this.opts.newToken();
    if (!TOKEN_RE.test(token)) throw new Error('Could not allocate a preview');
    this.pending.set(token, {name, text, expires: this.now() + this.limits.ttlMs});
    return {
      status: 'ready', token, name, format: ext === '.txt' ? 'text' : 'markdown', bytes: bytes.length, chars: text.length,
      lines: text.split('\n').length, text, suggestedTitle: suggestTitle(text, name),
    };
  }

  /** Saves a reviewed preview as a new note, then forgets it. The body is exactly the previewed text. */
  async save(token: unknown, options: unknown): Promise<{saved: true; title: string}> {
    const p = this.peek(token);
    const o = (options ?? {}) as ApprovedDocumentSaveOptions;
    if (typeof o !== 'object' || Array.isArray(o)) throw new ValidationError('Save options must be an object');
    for (const k of Object.keys(o)) if (k !== 'title' && k !== 'tags') throw new ValidationError(`Unknown save option: ${k}`);
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : suggestTitle(p.text, p.name);
    const tags = Array.isArray(o.tags) ? o.tags : ['imported'];
    // Kept until the note is stored, so a rejected title or tag can be corrected without choosing the file again.
    await this.opts.saveNote({title, body: p.text, tags});
    this.pending.delete(token as string);
    return {saved: true, title};
  }

  discard(token: unknown): boolean {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ValidationError('Invalid preview token');
    return this.pending.delete(token);
  }

  clear(): void { this.pending.clear(); }

  private peek(token: unknown): Pending {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ValidationError('Invalid preview token');
    this.sweep();
    const p = this.pending.get(token);
    if (!p) throw new ValidationError('This preview expired or was already saved. Choose the document again');
    return p;
  }

  private sweep() {
    const t = this.now();
    for (const [k, v] of this.pending) if (v.expires <= t) this.pending.delete(k);
  }
}
