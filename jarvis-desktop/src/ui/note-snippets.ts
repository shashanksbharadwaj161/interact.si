/**
 * Quick notes and snippets: pure, DOM-free helpers for reusing notes tagged #snippet inside other notes and for
 * exporting/importing notes as Markdown or JSON. No network, file system, clock (unless the caller omits `now`) or
 * model calls happen here; the Notes page owns downloads and saving.
 */

export const SNIPPET_TAG = 'snippet';
export const SNIPPET_LIMITS = Object.freeze({ maxSnippets: 200, maxInsertChars: 20000, maxQueryChars: 200 });
export const NOTES_EXPORT_FORMAT = 'desktop-companion-notes';
export const NOTES_EXPORT_VERSION = 1;
export const NOTES_IMPORT_LIMITS = Object.freeze({ maxChars: 2_000_000, maxNotes: 5000, maxTitle: 120, maxBody: 20000, maxTags: 12, maxTagChars: 24 });

export type NoteLike = { id: string; title: string; body: string; tags: string[]; updatedAt: string };
export type ExportedNote = { id: string; title: string; body: string; tags: string[]; updatedAt: string };
export type NotesExport = { format: typeof NOTES_EXPORT_FORMAT; version: 1; exportedAt: string; notes: ExportedNote[] };
/** An imported note never carries an id: the caller always creates a new note. */
export type ImportedNote = { title: string; body: string; tags: string[] };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Lower-case and strip combining accents so "Café" matches "cafe". */
export const foldText = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Notes tagged #snippet, sorted by title then id, capped at SNIPPET_LIMITS.maxSnippets. */
export function listSnippets<T extends NoteLike>(notes: readonly T[]): { snippets: T[]; truncated: boolean } {
  const all = (Array.isArray(notes) ? notes : []).filter((n) => n && Array.isArray(n.tags) && n.tags.includes(SNIPPET_TAG));
  all.sort((a, b) => cmp(String(a.title ?? ''), String(b.title ?? '')) || cmp(String(a.id ?? ''), String(b.id ?? '')));
  return { snippets: all.slice(0, SNIPPET_LIMITS.maxSnippets), truncated: all.length > SNIPPET_LIMITS.maxSnippets };
}

/** Case- and accent-insensitive match on title and body. Title matches come first; input order is kept within each group. */
export function filterSnippets<T extends NoteLike>(snippets: readonly T[], query: string): T[] {
  const q = foldText(String(query ?? '').slice(0, SNIPPET_LIMITS.maxQueryChars)).trim();
  if (!q) return [...snippets];
  const inTitle: T[] = [];
  const inBody: T[] = [];
  for (const s of snippets) {
    if (foldText(s.title ?? '').includes(q)) inTitle.push(s);
    else if (foldText(s.body ?? '').includes(q)) inBody.push(s);
  }
  return [...inTitle, ...inBody];
}

/**
 * Replace body[selectionStart, selectionEnd) with snippetBody. The result never exceeds maxChars; when the snippet
 * does not fit it is cut (never splitting a surrogate pair) and `truncated` is true. `cursor` sits after the insert.
 */
export function insertAtCursor(body: string, selectionStart: number, selectionEnd: number, snippetBody: string, maxChars: number = SNIPPET_LIMITS.maxInsertChars): { body: string; cursor: number; truncated: boolean } {
  if (typeof body !== 'string') throw new Error('insertAtCursor: body must be a string');
  if (typeof snippetBody !== 'string') throw new Error('insertAtCursor: snippetBody must be a string');
  if (!Number.isInteger(maxChars) || maxChars < 0) throw new Error(`insertAtCursor: maxChars must be a non-negative integer (got ${maxChars})`);
  if (!Number.isInteger(selectionStart) || selectionStart < 0) throw new Error(`insertAtCursor: selectionStart must be a non-negative integer (got ${selectionStart})`);
  if (!Number.isInteger(selectionEnd) || selectionEnd < 0) throw new Error(`insertAtCursor: selectionEnd must be a non-negative integer (got ${selectionEnd})`);
  if (selectionStart > body.length || selectionEnd > body.length) throw new Error(`insertAtCursor: selection ${selectionStart}-${selectionEnd} is outside the body (length ${body.length})`);
  if (selectionStart > selectionEnd) throw new Error(`insertAtCursor: selectionStart ${selectionStart} is after selectionEnd ${selectionEnd}`);
  let before = body.slice(0, selectionStart);
  let after = body.slice(selectionEnd);
  let cut = false;
  if (before.length > maxChars) {
    before = before.slice(0, maxChars);
    after = '';
    cut = true;
  } else if (before.length + after.length > maxChars) {
    after = after.slice(0, maxChars - before.length);
    cut = true;
  }
  const room = maxChars - before.length - after.length;
  let inserted = snippetBody.slice(0, Math.max(0, room));
  if (inserted.length < snippetBody.length && inserted.length > 0) {
    const last = inserted.charCodeAt(inserted.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) inserted = inserted.slice(0, -1);
  }
  return { body: before + inserted + after, cursor: before.length + inserted.length, truncated: cut || inserted.length < snippetBody.length };
}

/** Roving-focus target for the snippet list: ArrowUp/ArrowDown/Home/End without wrap; null for other keys or an empty list. */
export function snippetKeyboardTarget(key: string, index: number, count: number): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  const i = Number.isInteger(index) ? Math.min(count - 1, index) : -1;
  if (key === 'ArrowDown') return i < 0 ? 0 : Math.min(count - 1, i + 1);
  if (key === 'ArrowUp') return i <= 0 ? 0 : i - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

function isoOf(now: Date | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  if (typeof now === 'string') return now;
  if (now instanceof Date && !Number.isNaN(now.getTime())) return now.toISOString();
  throw new Error('now must be a valid Date or an ISO string');
}

const exportOrder = <T extends NoteLike>(notes: readonly T[]): T[] => [...notes].sort((a, b) => cmp(String(b.updatedAt ?? ''), String(a.updatedAt ?? '')) || cmp(String(a.id ?? ''), String(b.id ?? '')));

/** Deterministic Markdown: one "## title" section per note, newest first (updatedAt desc, then id). Bodies are verbatim. */
export function notesToMarkdown(notes: readonly NoteLike[], opts: { now: Date | string }): string {
  const exportedAt = isoOf(opts?.now);
  const sorted = exportOrder(notes);
  const out: string[] = ['# Desktop Companion notes', '', `Exported ${exportedAt}. ${sorted.length} note${sorted.length === 1 ? '' : 's'}.`, ''];
  for (const n of sorted) {
    const title = String(n.title ?? '').replace(/\s+/g, ' ').trim() || 'Untitled';
    const tags = Array.isArray(n.tags) && n.tags.length ? n.tags.map((t) => `#${t}`).join(' ') : 'none';
    out.push(`## ${title}`, '', `Tags: ${tags}`, `Updated: ${String(n.updatedAt ?? '')}`, '', String(n.body ?? ''), '');
  }
  return out.join('\n');
}

/** JSON envelope of all notes; only id, title, body, tags and updatedAt are kept. */
export function notesToJson(notes: readonly NoteLike[], opts: { now?: Date | string } = {}): string {
  const env: NotesExport = {
    format: NOTES_EXPORT_FORMAT,
    version: NOTES_EXPORT_VERSION,
    exportedAt: isoOf(opts.now),
    notes: exportOrder(notes).map((n) => ({ id: String(n.id), title: String(n.title ?? ''), body: String(n.body ?? ''), tags: Array.isArray(n.tags) ? n.tags.map(String) : [], updatedAt: String(n.updatedAt ?? '') })),
  };
  return JSON.stringify(env, null, 2);
}

const normTag = (t: string): string => t.trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase().slice(0, NOTES_IMPORT_LIMITS.maxTagChars);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate a notes export. Envelope problems throw an Error naming the exact $-path. Individual notes that are invalid
 * are dropped and listed in `errors`. Ids are never imported: the caller saves each note as a new note.
 */
export function parseNotesExport(json: string): { notes: ImportedNote[]; dropped: number; errors: string[] } {
  if (typeof json !== 'string') throw new Error('$: expected the export as text');
  if (json.length > NOTES_IMPORT_LIMITS.maxChars) throw new Error(`$: export is larger than ${NOTES_IMPORT_LIMITS.maxChars} characters`);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('$: not valid JSON');
  }
  if (!isObj(data)) throw new Error('$: expected an object');
  if (data.format !== NOTES_EXPORT_FORMAT) throw new Error(`$.format: expected "${NOTES_EXPORT_FORMAT}"`);
  if (data.version !== NOTES_EXPORT_VERSION) throw new Error(`$.version: expected ${NOTES_EXPORT_VERSION}`);
  if (typeof data.exportedAt !== 'string') throw new Error('$.exportedAt: expected a string');
  if (!Array.isArray(data.notes)) throw new Error('$.notes: expected an array');
  const notes: ImportedNote[] = [];
  const errors: string[] = [];
  data.notes.forEach((raw: unknown, i: number) => {
    const p = `$.notes[${i}]`;
    if (i >= NOTES_IMPORT_LIMITS.maxNotes) return void errors.push(`${p}: more than ${NOTES_IMPORT_LIMITS.maxNotes} notes`);
    if (!isObj(raw)) return void errors.push(`${p}: expected an object`);
    if (typeof raw.title !== 'string') return void errors.push(`${p}.title: expected a string`);
    if (typeof raw.body !== 'string') return void errors.push(`${p}.body: expected a string`);
    if (raw.body.length > NOTES_IMPORT_LIMITS.maxBody) return void errors.push(`${p}.body: longer than ${NOTES_IMPORT_LIMITS.maxBody} characters`);
    const tagsRaw = raw.tags === undefined ? [] : raw.tags;
    if (!Array.isArray(tagsRaw)) return void errors.push(`${p}.tags: expected an array`);
    const bad = tagsRaw.findIndex((t) => typeof t !== 'string');
    if (bad >= 0) return void errors.push(`${p}.tags[${bad}]: expected a string`);
    const tags: string[] = [];
    for (const t of tagsRaw as string[]) {
      const n = normTag(t);
      if (n && !tags.includes(n) && tags.length < NOTES_IMPORT_LIMITS.maxTags) tags.push(n);
    }
    notes.push({ title: raw.title.replace(/\s+/g, ' ').trim().slice(0, NOTES_IMPORT_LIMITS.maxTitle) || 'Untitled', body: raw.body, tags });
  });
  return { notes, dropped: errors.length, errors };
}

/** File name for a download, e.g. desktop-companion-notes-2025-01-31.md. */
export const notesExportFileName = (dateKey: string, ext: 'md' | 'json'): string => `desktop-companion-notes-${dateKey}.${ext}`;
