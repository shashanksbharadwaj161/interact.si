// Portable workspace memory: Node-free so the renderer can bundle it (vite). Shares the productivity limits with store.ts,
// which re-exports everything here for existing importers. Parsing never writes; it plans ordinary ProductivityOps.
import type {CapsuleGoal, CapsuleReference, Checkpoint, EvidenceRef, ProductivityOp, ProductivityState, ReferenceKind, ShelfItem} from "./store";

export const PRODUCTIVITY_LIMITS = {
  goals: 50, goalChars: 200,
  references: 100, labelChars: 120, noteChars: 500,
  checkpoints: 1000, checkpointTitle: 120, checkpointNote: 4000, checkpointRefs: 20,
  focus: 2000, reminders: 2000, timeline: 5000, associations: 5000, shelf: 200, recents: 50,
  maxFocusSec: 24 * 3600, maxRetainDays: 3650,
};

const PID = /^[A-Za-z0-9_-]{1,64}$/;
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Node-free twins of the lexical rules in paths.normalizeAbsolutePath and policy.validateOpenUrl. The store still validates
// every op with the originals; these only let the preview skip and report a bad target individually instead of failing a
// whole capsule.setMeta later. Anything these reject, the store rejects too.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e], [0x200b, 0x200f],
  [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb],
  [0xe0000, 0xe0fff],
];
const hasInvisible = (s: string) => { for (const ch of s) { const cp = ch.codePointAt(0) as number; if (INVISIBLE.some(([lo, hi]) => cp >= lo && cp <= hi)) return true; } return false; };
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

function checkLocalPath(input: string): string | null {
  if (!input.trim()) return 'Path is empty';
  if (input.length > 520) return 'Path is too long';
  if (CONTROL.test(input)) return 'Path contains control characters';
  if (/^\s|\s$/.test(input)) return 'Path must not start or end with whitespace';
  if (hasInvisible(input)) return 'Path contains invisible or direction-changing characters';
  const raw = input.replace(/\//g, '\\');
  if (/^\\\\[?.]/.test(raw)) return 'Device paths are not allowed';
  if (raw.startsWith('\\\\')) return 'Network (UNC and WebDAV) paths are not allowed; use a local drive path';
  if (/^[a-zA-Z]:(?!\\)/.test(raw)) return 'Drive-relative paths are not allowed';
  if (!/^[a-zA-Z]:\\/.test(raw)) return 'Path must be absolute and start with a drive letter such as C:\\';
  const segments = raw.slice(3).split('\\').filter((s) => s !== '');
  if (segments.some((seg) => seg === '..')) return 'Path must not contain ".." segments';
  const rest = raw.slice(2);
  if (rest.includes(':')) return 'Alternate data streams are not allowed';
  if (/[<>"|?*]/.test(rest)) return 'Path contains invalid characters';
  if (segments.some((seg) => seg !== '.' && /[. ]$/.test(seg))) return 'Path segments must not end with a dot or space';
  if (segments.some((seg) => RESERVED.test(seg))) return 'Reserved device names are not allowed in paths';
  return null;
}

// Match policy.validateOpenUrl's mailto checks without importing its Node-backed path policies.
function checkMailto(u: URL): string | null {
  const address = /^[^\s@<>(),;:"\\/?#%]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  const list = (raw: string, what: string): string | null => {
    let decoded: string;
    try { decoded = decodeURIComponent(raw); } catch { return `mailto ${what} is not valid`; }
    const addresses = decoded.split(',').map((s) => s.trim()).filter(Boolean);
    if (addresses.length > 20) return `mailto has too many ${what} addresses`;
    if (!addresses.every((a) => a.length <= 254 && address.test(a))) return `mailto ${what} contains an invalid address`;
    if (what === 'recipient' && !addresses.length) return 'mailto URL has no recipient';
    return null;
  };
  const why = list(u.pathname, 'recipient');
  if (why) return why;
  const seen = new Set<string>();
  for (const [k, v] of u.searchParams) {
    const key = k.toLowerCase();
    if (!['subject', 'body', 'cc', 'bcc'].includes(key)) return `mailto parameter "${k.slice(0, 30)}" is not allowed (only subject, body, cc, bcc)`;
    if (seen.has(key)) return `mailto parameter "${key}" is repeated`;
    seen.add(key);
    if (key === 'cc' || key === 'bcc') {
      const reason = list(encodeURIComponent(v), key);
      if (reason) return reason;
    } else if (v.length > (key === 'subject' ? 200 : 1000)) return `mailto ${key} is too long`;
  }
  return null;
}

function checkUrl(target: string): string | null {
  const t = target.trim();
  if (!t) return 'A URL is required';
  if (t.length > 2048) return 'URL is too long';
  if (CONTROL.test(t) || /\s/.test(t) || hasInvisible(t)) return 'URL contains whitespace, control or invisible characters';
  let u: URL;
  try { u = new URL(t); } catch { return 'URL is not valid'; }
  if (u.protocol === 'mailto:') return checkMailto(u);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Only http, https and mailto links can be opened (not ${u.protocol})`;
  if (!u.hostname) return 'URL has no host';
  if (u.username || u.password) return 'URLs containing credentials are not allowed';
  return null;
}

/** Reason the store would refuse this reference/shelf target, or null when it passes the lexical rules. Note/task ids are checked separately. */
export function checkTarget(kind: string, target: string): string | null {
  if (kind === 'url') return checkUrl(target);
  if (kind === 'file' || kind === 'folder') return checkLocalPath(target);
  return PID.test(target) ? null : 'reference target is invalid';
}

function normalizedTarget(kind: string, target: string): string {
  if (kind === 'file' || kind === 'folder') {
    const raw = target.replace(/\//g, '\\');
    const parts = raw.slice(3).split('\\').filter((s) => s && s !== '.');
    return raw.slice(0, 3) + parts.join('\\');
  }
  if (kind !== 'url') return target;
  const u = new URL(target.trim());
  if (u.protocol !== 'mailto:') return u.href;
  const addresses = (s: string) => decodeURIComponent(s).split(',').map((a) => a.trim()).filter(Boolean).map((a) => encodeURIComponent(a).replace(/%40/g, '@')).join(',');
  const params = [...u.searchParams].map(([k, v]) => {
    const key = k.toLowerCase();
    return `${key}=${key === 'cc' || key === 'bcc' ? addresses(encodeURIComponent(v)) : encodeURIComponent(v)}`;
  });
  return `mailto:${addresses(u.pathname)}${params.length ? '?' + params.join('&') : ''}`;
}
const badMultiline = (s: string) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
// ---------------------------------------------------------------------------------------------------------------
// Portable workspace memory (v1). A bounded, validated JSON text the user copies out of or pastes into the app.
// It carries checkpoints (with their original times), capsule goals/references and the file shelf: nothing else.
// Parsing never writes; it produces ordinary ProductivityOps that go through the same validation as the UI.
// ---------------------------------------------------------------------------------------------------------------

export const PORTABLE_VERSION = 1;
export const PORTABLE_LIMITS = {
  /** Pasted text larger than this is refused before parsing. */
  rawChars: 1_000_000,
  checkpoints: 500, goalsPerCapsule: PRODUCTIVITY_LIMITS.goals, referencesPerCapsule: PRODUCTIVITY_LIMITS.references, shelf: PRODUCTIVITY_LIMITS.shelf,
  capsules: 200,
} as const;

export type PortableMemory = {
  format: 'desktop-companion-memory';
  version: number;
  exportedAt: string;
  /** Capsule names let a reader match goals to a capsule whose id differs on another machine. */
  capsules: {id: string; name: string; goals: CapsuleGoal[]; references: CapsuleReference[]}[];
  checkpoints: Checkpoint[];
  shelf: {kind: ShelfItem['kind']; target: string; label: string; pinned: boolean}[];
};

export type PortableImport = {
  ok: boolean;
  /** One per rejected record: the record is skipped, the rest still import. A fatal error makes ok false with no ops. */
  problems: string[];
  ops: ProductivityOp[];
  counts: {checkpoints: number; goals: number; references: number; shelf: number; skipped: number};
  exportedAt?: string;
};

/** Bounded export of the memory that is worth carrying between machines. Focus, timeline, reminders and recents stay local. */
export function exportPortable(prod: ProductivityState, capsules: readonly {id: string; name: string}[], now: Date = new Date()): PortableMemory {
  const names = new Map(capsules.map((c) => [c.id, c.name]));
  const metaIds = Object.keys(prod.capsuleMeta).filter((id) => names.has(id)).slice(0, PORTABLE_LIMITS.capsules);
  return {
    format: 'desktop-companion-memory',
    version: PORTABLE_VERSION,
    exportedAt: now.toISOString(),
    capsules: metaIds.map((id) => ({id, name: names.get(id) as string, goals: structuredClone(prod.capsuleMeta[id].goals), references: structuredClone(prod.capsuleMeta[id].references)})),
    checkpoints: structuredClone(prod.checkpoints.slice(-PORTABLE_LIMITS.checkpoints)),
    shelf: prod.shelf.slice(0, PORTABLE_LIMITS.shelf).map(({kind, target, label, pinned}) => ({kind, target, label, pinned})),
  };
}

/**
 * Validates pasted text and plans the ops that would import it into the given app state. Capsules are matched by id, then by
 * exact name; goals/references for unknown capsules are skipped and reported. Checkpoints keep their original createdAt
 * (clamped to now, never in the future), and references to records that do not exist here are reported, not invented.
 * Existing goals/references of a matched capsule are kept and the imported ones appended, without duplicates.
 */
export function parsePortable(raw: unknown, ctx: {prod: ProductivityState; capsules: readonly {id: string; name: string}[]; noteIds?: readonly string[]; taskIds?: readonly string[]}, now: Date = new Date()): PortableImport {
  const fail = (msg: string): PortableImport => ({ok: false, problems: [msg], ops: [], counts: {checkpoints: 0, goals: 0, references: 0, shelf: 0, skipped: 0}});
  if (typeof raw !== 'string') return fail('Paste the exported text first.');
  if (raw.length > PORTABLE_LIMITS.rawChars) return fail(`The pasted text is larger than ${PORTABLE_LIMITS.rawChars.toLocaleString()} characters.`);
  if (!raw.trim()) return fail('Paste the exported text first.');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return fail('This is not valid JSON.'); }
  if (!isRec(data) || data.format !== 'desktop-companion-memory') return fail('This text is not a Desktop Companion memory export.');
  if (typeof data.version !== 'number' || data.version > PORTABLE_VERSION) return fail(`This export uses version ${String(data.version)}; this app reads up to version ${PORTABLE_VERSION}.`);
  const out: PortableImport = {ok: true, problems: [], ops: [], counts: {checkpoints: 0, goals: 0, references: 0, shelf: 0, skipped: 0}};
  if (typeof data.exportedAt === 'string' && !Number.isNaN(Date.parse(data.exportedAt))) out.exportedAt = new Date(Date.parse(data.exportedAt)).toISOString();
  const nowIso = now.toISOString();
  const skip = (msg: string) => { out.problems.push(msg); out.counts.skipped++; };
  const byId = new Map(ctx.capsules.map((c) => [c.id, c]));
  const byName = new Map(ctx.capsules.map((c) => [c.name, c]));
  const noteIds = new Set(ctx.noteIds ?? []), taskIds = new Set(ctx.taskIds ?? []);
  const localCheckpointIds = new Set(ctx.prod.checkpoints.map((c) => c.id));
  const localCheckpointKeys = new Set(ctx.prod.checkpoints.map((c) => `${c.createdAt}|${c.title}`));
  const exportedNames = new Map<string, string>();
  for (const c of Array.isArray(data.capsules) ? data.capsules : []) if (isRec(c) && typeof c.id === "string" && typeof c.name === "string") exportedNames.set(c.id, c.name);
  const matchCapsule = (id: unknown, name: unknown) => (typeof id === 'string' && byId.get(id)) || (typeof name === 'string' && byName.get(name)) || null;

  const caps = Array.isArray(data.capsules) ? data.capsules.slice(0, PORTABLE_LIMITS.capsules) : [];
  const plannedCapsules = new Map<string, Extract<ProductivityOp, {op: 'capsule.setMeta'}>>();
  if (data.capsules !== undefined && !Array.isArray(data.capsules)) out.problems.push('capsules is not a list; ignored.');
  for (const c of caps) {
    if (!isRec(c)) { skip('A capsule entry is not an object.'); continue; }
    const target = matchCapsule(c.id, c.name);
    if (!target) { skip(`No capsule here matches "${typeof c.name === 'string' ? c.name.slice(0, 60) : String(c.id).slice(0, 40)}"; its goals and references were skipped.`); continue; }
    const cur = ctx.prod.capsuleMeta[target.id] ?? {goals: [], references: [], updatedAt: nowIso};
    const planned = plannedCapsules.get(target.id);
    const goals: {id?: string; text: string; done?: boolean}[] = (planned?.goals ?? cur.goals).map(({id, text, done}) => ({id, text, done}));
    const refs: {id?: string; kind: ReferenceKind; target: string; label?: string; note?: string}[] = (planned?.references ?? cur.references).map(({id, kind, target: t, label, note}) => ({id, kind, target: t, label, ...(note ? {note} : {})}));
    let added = 0;
    for (const g of Array.isArray(c.goals) ? c.goals.slice(0, PORTABLE_LIMITS.goalsPerCapsule) : []) {
      const gText = isRec(g) && typeof g.text === 'string' ? g.text.trim() : '';
      if (!gText) { skip(`A goal for "${target.name}" has no text.`); continue; }
      if (CONTROL.test(gText)) { skip(`A goal for "${target.name}" contains control characters.`); continue; }
      if (goals.some((x) => x.text === gText)) continue;
      if (goals.length >= PRODUCTIVITY_LIMITS.goals) { skip(`"${target.name}" already holds ${PRODUCTIVITY_LIMITS.goals} goals.`); break; }
      goals.push({text: gText.slice(0, PRODUCTIVITY_LIMITS.goalChars), done: isRec(g) && g.done === true});
      added++; out.counts.goals++;
    }
    for (const r of Array.isArray(c.references) ? c.references.slice(0, PORTABLE_LIMITS.referencesPerCapsule) : []) {
      if (!isRec(r) || typeof r.target !== 'string' || !['file', 'folder', 'url', 'note', 'task'].includes(String(r.kind))) { skip(`A reference for "${target.name}" is malformed.`); continue; }
      if (r.kind === 'note' && !noteIds.has(r.target)) { skip(`Reference to note ${r.target.slice(0, 40)} skipped: that note does not exist here.`); continue; }
      if (r.kind === 'task' && !taskIds.has(r.target)) { skip(`Reference to task ${r.target.slice(0, 40)} skipped: that task does not exist here.`); continue; }
      const why = checkTarget(String(r.kind), r.target);
      if (why) { skip(`Reference "${(typeof r.label === 'string' && r.label) || r.target.slice(0, 60)}" for "${target.name}" skipped: ${why}.`); continue; }
      if ((typeof r.label === 'string' && CONTROL.test(r.label.trim())) || (typeof r.note === 'string' && CONTROL.test(r.note.trim()))) { skip(`A reference for "${target.name}" contains control characters.`); continue; }
      const normalized = normalizedTarget(String(r.kind), r.target);
      if (refs.some((x) => x.kind === r.kind && x.target === normalized)) continue;
      if (refs.length >= PRODUCTIVITY_LIMITS.references) { skip(`"${target.name}" already holds ${PRODUCTIVITY_LIMITS.references} references.`); break; }
      refs.push({kind: r.kind as ReferenceKind, target: normalized, label: typeof r.label === 'string' ? r.label.slice(0, PRODUCTIVITY_LIMITS.labelChars) : '', ...(typeof r.note === 'string' && r.note ? {note: r.note.slice(0, PRODUCTIVITY_LIMITS.noteChars)} : {})});
      added++; out.counts.references++;
    }
    if (added) {
      if (planned) { planned.goals = goals; planned.references = refs; }
      else {
        const op: Extract<ProductivityOp, {op: 'capsule.setMeta'}> = {op: 'capsule.setMeta', capsuleId: target.id, goals, references: refs};
        plannedCapsules.set(target.id, op); out.ops.push(op);
      }
    }
  }

  const cps = Array.isArray(data.checkpoints) ? data.checkpoints : [];
  if (data.checkpoints !== undefined && !Array.isArray(data.checkpoints)) out.problems.push('checkpoints is not a list; ignored.');
  if (cps.length > PORTABLE_LIMITS.checkpoints) out.problems.push(`Only the first ${PORTABLE_LIMITS.checkpoints} of ${cps.length} checkpoints are imported.`);
  for (const c of cps.slice(0, PORTABLE_LIMITS.checkpoints)) {
    if (!isRec(c) || typeof c.title !== 'string' || !c.title.trim()) { skip('A checkpoint has no title.'); continue; }
    if (CONTROL.test(c.title.trim()) || (typeof c.note === 'string' && badMultiline(c.note.trim()))) { skip('A checkpoint contains control characters.'); continue; }
    if (typeof c.id === 'string' && localCheckpointIds.has(c.id)) continue; // already here (same-machine round trip)
    const title = c.title.trim().slice(0, PRODUCTIVITY_LIMITS.checkpointTitle);
    const at = typeof c.createdAt === 'string' && !Number.isNaN(Date.parse(c.createdAt)) ? new Date(Date.parse(c.createdAt)).toISOString() : null;
    if (!at) { skip(`Checkpoint "${c.title.slice(0, 60)}" has no valid time; skipped.`); continue; }
    const createdAt = at > nowIso ? nowIso : at;
    if (localCheckpointKeys.has(`${createdAt}|${title}`)) continue; // same record already imported earlier (ids differ per machine)
    if (createdAt !== at) out.problems.push(`Checkpoint "${c.title.slice(0, 60)}" was dated in the future; it is imported with the current time.`);
    const refs: EvidenceRef[] = [];
    for (const r of Array.isArray(c.refs) ? c.refs.slice(0, PRODUCTIVITY_LIMITS.checkpointRefs) : []) {
      if (!isRec(r) || typeof r.id !== 'string' || !PID.test(r.id)) continue;
      const kind = String(r.kind) as EvidenceRef['kind'];
      const exists = kind === 'note' ? noteIds.has(r.id) : kind === 'task' ? taskIds.has(r.id) : kind === 'capsule' ? byId.has(r.id) : false;
      if (exists) refs.push({kind, id: r.id});
      else out.problems.push(`Checkpoint "${c.title.slice(0, 60)}": dropped a ${kind} reference that does not exist here.`);
    }
    const op: ProductivityOp = {op: 'checkpoint.add', title, note: typeof c.note === 'string' ? c.note.slice(0, PRODUCTIVITY_LIMITS.checkpointNote) : '', refs, createdAt};
    const cap = matchCapsule(c.capsuleId, typeof c.capsuleId === 'string' ? exportedNames.get(c.capsuleId) : undefined);
    if (cap) op.capsuleId = cap.id;
    else if (typeof c.capsuleId === 'string') out.problems.push(`Checkpoint "${c.title.slice(0, 60)}" belonged to a capsule that is not here; imported without a project.`);
    out.ops.push(op);
    out.counts.checkpoints++;
  }

  const shelf = Array.isArray(data.shelf) ? data.shelf.slice(0, PORTABLE_LIMITS.shelf) : [];
  const shelfKeys = new Set(ctx.prod.shelf.map((x) => `${x.kind}:${x.target.toLowerCase()}`));
  let shelfSize = ctx.prod.shelf.length;
  for (const s of shelf) {
    if (!isRec(s) || typeof s.target !== 'string' || !['file', 'folder', 'url'].includes(String(s.kind))) { skip('A shelf item is malformed.'); continue; }
    const why = checkTarget(String(s.kind), s.target);
    if (why) { skip(`Shelf item "${(typeof s.label === 'string' && s.label) || s.target.slice(0, 60)}" skipped: ${why}.`); continue; }
    if (typeof s.label === 'string' && CONTROL.test(s.label.trim())) { skip('A shelf label contains control characters.'); continue; }
    const normalized = normalizedTarget(String(s.kind), s.target);
    const key = `${s.kind}:${normalized.toLowerCase()}`;
    if (shelfKeys.has(key)) continue;
    if (shelfSize >= PRODUCTIVITY_LIMITS.shelf) { skip(`The shelf holds at most ${PRODUCTIVITY_LIMITS.shelf} items.`); continue; }
    shelfKeys.add(key); shelfSize++;
    out.ops.push({op: 'shelf.add', kind: s.kind as ShelfItem['kind'], target: normalized, label: typeof s.label === 'string' ? s.label.slice(0, PRODUCTIVITY_LIMITS.labelChars) : ''});
    out.counts.shelf++;
  }
  return out;
}

