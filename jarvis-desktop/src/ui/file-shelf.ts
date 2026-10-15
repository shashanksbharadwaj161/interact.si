// Pure, DOM-free file shelf model for Home.
// Items are pinned files, folders and http(s) URLs. Paths come only from the system picker or typed text;
// nothing here opens, reads or probes anything. Opening goes through the app's preview/confirm/execute flow.

export const SHELF_PREF_KEY = 'fileShelf.v1';
export const SHELF_LIMITS = { items: 200, label: 80, note: 500, recent: 20, tags: 12, tagChars: 40, target: 2048 } as const;

export type ShelfKind = 'file' | 'folder' | 'url';
export const SHELF_KINDS: readonly ShelfKind[] = ['file', 'folder', 'url'];

export type ShelfItem = {
  id: string;
  kind: ShelfKind;
  target: string;
  label: string;
  note: string;
  tags: string[];
  addedAt: string;
  lastOpenedAt?: string;
  openCount: number;
};

export type Shelf = { version: 1; items: ShelfItem[] };

export type AddShelfInput = { kind: ShelfKind; target: string; label?: string; note?: string; tags?: string[] };
export type ShelfUpdate = { label?: string; note?: string; tags?: string[] };
export type AddResult = { shelf: Shelf; item: ShelfItem; duplicate: boolean };

export const emptyShelf = (): Shelf => ({ version: 1, items: [] });

const isKind = (v: unknown): v is ShelfKind => typeof v === 'string' && (SHELF_KINDS as readonly string[]).includes(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function toIso(now: unknown): string {
  const d = now === undefined ? new Date() : now instanceof Date ? now : typeof now === 'number' || typeof now === 'string' ? new Date(now) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error(`Invalid "now" for the file shelf: ${String(now)}.`);
  return d.toISOString();
}

/** Lowercase with diacritics removed, for search and comparisons. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Windows drive (C:\...) or UNC (\\server\share) path. */
export const isWindowsPath = (target: string): boolean => /^[a-zA-Z]:[\\/]/.test(target) || /^\\\\[^\\]/.test(target);

/** Comparison key: Windows paths compare case-insensitively with either slash; URLs and other paths compare exactly. */
export function targetKey(kind: ShelfKind, target: string): string {
  const t = target.trim();
  if (kind === 'url') {
    try {
      return new URL(t).href;
    } catch {
      return t;
    }
  }
  return isWindowsPath(t) ? t.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : t.replace(/\/+$/, '') || t;
}

/** Last path segment or URL host+path, used as the default label. */
export function defaultLabel(kind: ShelfKind, target: string): string {
  const t = target.trim();
  if (kind === 'url') {
    try {
      const u = new URL(t);
      const tail = u.pathname.split('/').filter(Boolean).pop();
      return tail ? `${u.hostname} › ${decodeURIComponentSafe(tail)}` : u.hostname;
    } catch {
      return t;
    }
  }
  const parts = t.split(/[\\/]+/).filter(Boolean);
  return parts.pop() ?? t;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export type TargetCheck = { ok: true; target: string } | { ok: false; reason: string };

/** Validates a target for its kind. URLs must be http(s); script, data and file schemes are refused with a reason. */
export function checkTarget(kind: ShelfKind, target: unknown): TargetCheck {
  if (!isKind(kind)) return { ok: false, reason: `Unknown shelf item kind: ${String(kind)}. Use file, folder or url.` };
  if (typeof target !== 'string') return { ok: false, reason: 'The target must be text.' };
  const t = target.trim();
  if (!t) return { ok: false, reason: 'The target is empty.' };
  if (t.length > SHELF_LIMITS.target) return { ok: false, reason: `The target is longer than ${SHELF_LIMITS.target} characters.` };
  if (CONTROL.test(t)) return { ok: false, reason: 'The target contains control characters.' };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(t)?.[1]?.toLowerCase();
  if (scheme === 'javascript' || scheme === 'vbscript') return { ok: false, reason: `${scheme}: links run script and are never added to the shelf.` };
  if (scheme === 'data') return { ok: false, reason: 'data: links embed content and are never added to the shelf.' };
  if (scheme === 'file') return { ok: false, reason: 'file: links are not accepted; add the file or folder with the picker or as a plain path.' };
  if (kind === 'url') {
    if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: `Only http:// and https:// links can be added${scheme ? ` (got ${scheme}:)` : ''}.` };
    try {
      const u = new URL(t);
      if (!u.hostname) return { ok: false, reason: 'The link has no host name.' };
      return { ok: true, target: u.href };
    } catch {
      return { ok: false, reason: 'The link is not a valid URL.' };
    }
  }
  if (scheme && scheme.length > 1) return { ok: false, reason: `A ${kind} must be a local path, not a ${scheme}: link.` };
  return { ok: true, target: t };
}

/** Guess the kind of typed text: http(s) links are URLs, everything else a file path. */
export function guessKind(text: string): ShelfKind {
  return /^https?:\/\//i.test(text.trim()) ? 'url' : 'file';
}

function cleanLabel(v: unknown, field = 'label'): string {
  if (typeof v !== 'string') throw new Error(`The ${field} must be text.`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length > SHELF_LIMITS.label) throw new Error(`The ${field} is longer than ${SHELF_LIMITS.label} characters.`);
  return t;
}

function cleanNote(v: unknown): string {
  if (typeof v !== 'string') throw new Error('The note must be text.');
  const t = v.trim();
  if (t.length > SHELF_LIMITS.note) throw new Error(`The note is longer than ${SHELF_LIMITS.note} characters.`);
  return t;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('Tags must be a list of text.');
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') throw new Error('Each tag must be text.');
    const t = raw.replace(/^#+/, '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, SHELF_LIMITS.tagChars);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > SHELF_LIMITS.tags) throw new Error(`At most ${SHELF_LIMITS.tags} tags per item.`);
  return out;
}

/** Splits typed tag text ("a, b #c") into tags. */
export function parseTagText(text: string): string[] {
  return text.split(/[,\s]+/).map((t) => t.replace(/^#+/, '')).filter(Boolean);
}

let seq = 0;
function newId(now: string, existing: ShelfItem[]): string {
  const base = `shelf_${Date.parse(now).toString(36)}`;
  let id = `${base}_${(++seq).toString(36)}`;
  while (existing.some((i) => i.id === id)) id = `${base}_${(++seq).toString(36)}`;
  return id;
}

function normalizeItem(raw: unknown): ShelfItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 80) return null;
  if (!isKind(r.kind)) return null;
  const check = checkTarget(r.kind, r.target);
  if (!check.ok) return null;
  if (!isIso(r.addedAt)) return null;
  try {
    const label = typeof r.label === 'string' ? cleanLabel(r.label.slice(0, SHELF_LIMITS.label)) : '';
    const note = typeof r.note === 'string' ? cleanNote(r.note.slice(0, SHELF_LIMITS.note)) : '';
    const tags = Array.isArray(r.tags) ? cleanTags(r.tags.filter((t) => typeof t === 'string').slice(0, SHELF_LIMITS.tags)) : [];
    const openCount = typeof r.openCount === 'number' && Number.isInteger(r.openCount) && r.openCount >= 0 ? r.openCount : 0;
    const item: ShelfItem = { id: r.id, kind: r.kind, target: check.target, label: label || defaultLabel(r.kind, check.target), note, tags, addedAt: new Date(r.addedAt).toISOString(), openCount };
    if (isIso(r.lastOpenedAt)) item.lastOpenedAt = new Date(r.lastOpenedAt).toISOString();
    return item;
  } catch {
    return null;
  }
}

/** Accepts anything from storage. Malformed items, duplicate ids and duplicate targets are dropped; the item cap is enforced. */
export function normalizeShelf(raw: unknown): Shelf {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
  const items: ShelfItem[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const r of list) {
    if (items.length >= SHELF_LIMITS.items) break;
    const item = normalizeItem(r);
    if (!item) continue;
    const key = `${item.kind === 'url' ? 'url' : 'path'}|${targetKey(item.kind, item.target)}`;
    if (ids.has(item.id) || keys.has(key)) continue;
    ids.add(item.id);
    keys.add(key);
    items.push(item);
  }
  return { version: 1, items };
}

function findDuplicate(shelf: Shelf, kind: ShelfKind, target: string): ShelfItem | undefined {
  const isUrl = kind === 'url';
  const key = targetKey(kind, target);
  return shelf.items.find((i) => (i.kind === 'url') === isUrl && targetKey(i.kind, i.target) === key);
}

/**
 * Adds an item. An existing item with the same target (case-insensitive for Windows paths) is returned
 * unchanged with duplicate:true. Throws a descriptive Error for invalid input or a full shelf.
 */
export function addShelfItem(shelf: Shelf, input: AddShelfInput, now?: number | string | Date): AddResult {
  const base = normalizeShelf(shelf);
  if (!input || typeof input !== 'object') throw new Error('Nothing to add: expected a shelf item.');
  const check = checkTarget(input.kind, input.target);
  if (!check.ok) throw new Error(check.reason);
  const dup = findDuplicate(base, input.kind, check.target);
  if (dup) return { shelf: base, item: dup, duplicate: true };
  if (base.items.length >= SHELF_LIMITS.items) throw new Error(`The shelf is full (${SHELF_LIMITS.items} items). Remove one before adding another.`);
  const at = toIso(now);
  const label = input.label === undefined ? '' : cleanLabel(input.label);
  const item: ShelfItem = {
    id: newId(at, base.items),
    kind: input.kind,
    target: check.target,
    label: label || defaultLabel(input.kind, check.target),
    note: input.note === undefined ? '' : cleanNote(input.note),
    tags: input.tags === undefined ? [] : cleanTags(input.tags),
    addedAt: at,
    openCount: 0,
  };
  return { shelf: { version: 1, items: [item, ...base.items] }, item, duplicate: false };
}

function requireItem(shelf: Shelf, id: string): ShelfItem {
  const item = shelf.items.find((i) => i.id === id);
  if (!item) throw new Error(`No shelf item with id "${String(id)}".`);
  return item;
}

/** Updates label, note and/or tags. An empty label falls back to the default label. */
export function updateShelfItem(shelf: Shelf, id: string, patch: ShelfUpdate): Shelf {
  const base = normalizeShelf(shelf);
  const item = requireItem(base, id);
  if (!patch || typeof patch !== 'object') throw new Error('Nothing to update: expected label, note or tags.');
  const next: ShelfItem = { ...item };
  if (patch.label !== undefined) next.label = cleanLabel(patch.label) || defaultLabel(item.kind, item.target);
  if (patch.note !== undefined) next.note = cleanNote(patch.note);
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  return { version: 1, items: base.items.map((i) => (i.id === id ? next : i)) };
}

export function removeShelfItem(shelf: Shelf, id: string): Shelf {
  const base = normalizeShelf(shelf);
  requireItem(base, id);
  return { version: 1, items: base.items.filter((i) => i.id !== id) };
}

/** Records one confirmed open: bumps openCount and sets lastOpenedAt. */
export function recordOpened(shelf: Shelf, id: string, now?: number | string | Date): Shelf {
  const base = normalizeShelf(shelf);
  requireItem(base, id);
  const at = toIso(now);
  return { version: 1, items: base.items.map((i) => (i.id === id ? { ...i, openCount: i.openCount + 1, lastOpenedAt: at } : i)) };
}

const byLabel = (a: ShelfItem, b: ShelfItem) => foldText(a.label).localeCompare(foldText(b.label)) || a.id.localeCompare(b.id);

/** Opened items only, newest open first, ties by label; at most n (capped at SHELF_LIMITS.recent). */
export function recentItems(shelf: Shelf, n: number = SHELF_LIMITS.recent): ShelfItem[] {
  const count = Math.max(0, Math.min(SHELF_LIMITS.recent, Number.isFinite(n) ? Math.floor(n) : SHELF_LIMITS.recent));
  return normalizeShelf(shelf)
    .items.filter((i) => i.lastOpenedAt)
    .sort((a, b) => (b.lastOpenedAt ?? '').localeCompare(a.lastOpenedAt ?? '') || byLabel(a, b))
    .slice(0, count);
}

/** Case- and accent-insensitive search over label, target, tags and note; every word must match. Sorted by label. */
export function filterShelf(shelf: Shelf, query: string): ShelfItem[] {
  const items = normalizeShelf(shelf).items;
  const words = foldText(typeof query === 'string' ? query.slice(0, 200) : '').split(/\s+/).filter(Boolean);
  const hits = words.length === 0 ? items : items.filter((i) => {
    const hay = foldText([i.label, i.target, i.note, ...i.tags, ...i.tags.map((t) => `#${t}`)].join('\n'));
    return words.every((w) => hay.includes(w));
  });
  return [...hits].sort(byLabel);
}

export type ShelfGroup = { kind: ShelfKind; title: string; items: ShelfItem[] };
const GROUP_TITLES: Record<ShelfKind, string> = { folder: 'Folders', file: 'Files', url: 'Links' };

/** Groups in a fixed order (folders, files, links), skipping empty groups and keeping the input order inside each. */
export function groupByKind(items: ShelfItem[]): ShelfGroup[] {
  const order: ShelfKind[] = ['folder', 'file', 'url'];
  return order.map((kind) => ({ kind, title: GROUP_TITLES[kind], items: items.filter((i) => i.kind === kind) })).filter((g) => g.items.length > 0);
}
