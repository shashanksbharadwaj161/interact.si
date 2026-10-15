// Capsule restore: open configured items (each re-authorized), then restore supported window geometry.
// Anything unsupported, unapproved or missing is reported in failed[], never faked.
import type {AppState, Capsule} from '../../src/shared/contracts';
import type {NativeAdapter, WindowInfo} from '../native/adapter';
import type {ActionService} from './actions';
import {normalizeAbsolutePath} from './paths';
import {checkWindowPolicy, validateOpenUrl} from './policy';

export interface CapsuleDeps {
  state: () => AppState;
  actions: Pick<ActionService, 'prepareItem' | 'claimAction'>;
  confirm?: (summary: string, detail: string) => Promise<boolean>;
  safeLaunch?: () => boolean;
  native: Pick<NativeAdapter, 'listWindows' | 'moveWindow'>;
  selfPids: () => number[];
  activity: (kind: string, summary: string, details?: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  windowWaitMs?: number;
}

export interface RestoreResult { opened: string[]; failed: {target: string; reason: string}[] }

function pickWindow(saved: NonNullable<Capsule['windows']>[number], windows: WindowInfo[], used: Set<number>): WindowInfo | undefined {
  const proc = saved.process.toLowerCase();
  const sameProc = windows.filter((w) => !used.has(w.hwnd) && w.process.toLowerCase() === proc);
  if (saved.title) {
    const t = saved.title.toLowerCase();
    const byTitle = sameProc.find((w) => w.title.toLowerCase().includes(t));
    if (byTitle) return byTitle;
  }
  return sameProc[0];
}

export async function restoreCapsule(deps: CapsuleDeps, id: unknown): Promise<RestoreResult> {
  if (typeof id !== 'string' || id.length > 64) throw new Error('Capsule id is invalid');
  const capsule = deps.state().capsules.find((c) => c.id === id);
  if (!capsule) throw new Error('Capsule not found');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const result: RestoreResult = {opened: [], failed: []};
  const allTargets = [...capsule.items.map((i) => i.target), ...(capsule.windows ?? []).map((i) => `window ${i.process} ${i.title ?? ''}`)];
  const stop = (reason: string) => ({opened: [], failed: allTargets.map((target) => ({target, reason}))});
  if (deps.safeLaunch?.()) return stop('Safe launch is active');
  const prepared = await Promise.all(capsule.items.map((item) => deps.actions.prepareItem(item.kind, item.target)));
  const detail = [
    ...prepared.map((p, i) => `${capsule.items[i].kind}: ${capsule.items[i].target}\n${p.ok ? p.detail : `Blocked: ${p.reason}`}`),
    ...(capsule.windows ?? []).map((win) => `Move window ${win.process} "${win.title ?? ''}" to ${win.x},${win.y}, ${win.width}×${win.height}`),
  ].join('\n\n');
  if (allTargets.length && !(await deps.confirm?.(`Restore capsule "${capsule.name}"`, detail))) return stop('Native confirmation declined or unavailable');
  if (deps.safeLaunch?.()) return stop('Safe launch is active');

  for (let i = 0; i < capsule.items.length; i++) {
    const item = capsule.items[i];
    const preparedItem = prepared[i];
    const r = preparedItem.ok ? await preparedItem.run() : preparedItem;
    if (r.ok) result.opened.push(item.target);
    else result.failed.push({target: item.target, reason: r.reason});
  }

  const pending = [...(capsule.windows ?? [])];
  const used = new Set<number>();
  if (pending.length) {
    const waitMs = result.opened.length ? deps.windowWaitMs ?? 10_000 : 0;
    const deadline = now() + waitMs;
    let lastError = '';
    for (;;) {
      let windows: WindowInfo[] = [];
      try { windows = await deps.native.listWindows(); lastError = ''; } catch (e) { lastError = (e as Error).message; }
      for (let i = pending.length - 1; i >= 0; i--) {
        const saved = pending[i];
        const win = pickWindow(saved, windows, used);
        if (!win) continue;
        pending.splice(i, 1);
        used.add(win.hwnd);
        const name = `${saved.process}${saved.title ? ` "${saved.title}"` : ''}`;
        const why = checkWindowPolicy(win, 'move-window', deps.selfPids());
        if (why) { result.failed.push({target: `window ${name}`, reason: why}); continue; }
        if (deps.safeLaunch?.() || !deps.actions.claimAction()) { result.failed.push({target: `window ${name}`, reason: deps.safeLaunch?.() ? 'Safe launch is active' : 'Action rate limit reached'}); continue; }
        try {
          await deps.native.moveWindow({hwnd: win.hwnd, pid: win.pid}, {x: saved.x, y: saved.y, width: saved.width, height: saved.height});
          result.opened.push(`window ${name}`);
        } catch (e) {
          result.failed.push({target: `window ${name}`, reason: (e as Error).message.slice(0, 200)});
        }
      }
      if (!pending.length || now() >= deadline) break;
      await sleep(500);
    }
    for (const saved of pending) {
      result.failed.push({target: `window ${saved.process}${saved.title ? ` "${saved.title}"` : ''}`, reason: lastError ? `Windows could not be enumerated: ${lastError}` : 'No matching window appeared in time'});
    }
  }

  await deps.activity('capsule', `Restored capsule "${capsule.name.slice(0, 80)}": ${result.opened.length} opened, ${result.failed.length} failed`);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Capsule preview, geometry capture and portable packs (roadmap 41-43, 48). Nothing here launches, moves or
// types: previews and captures only read, packs are plain data. Imported packs never carry permissions; every
// item is authorized again by prepareItem and confirmed natively when the capsule is restored.
// ---------------------------------------------------------------------------------------------------------------

export type WindowRect = NonNullable<Capsule['windows']>[number];

export type GeometryRow = {
  saved: WindowRect;
  /** match: a live window would be moved; no-match: nothing open fits; blocked: policy forbids moving it. */
  status: 'match' | 'no-match' | 'blocked';
  window?: {hwnd: number; title: string; process: string; x: number; y: number; width: number; height: number};
  /** The saved rectangle lies completely outside every known display (e.g. a monitor that is gone). */
  offscreen?: boolean;
  reason?: string;
};

export interface Display { x: number; y: number; width: number; height: number }

const intersects = (a: Display, b: Display) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Read-only dry run of the window part of a restore: which live window each saved rectangle would be applied to. */
export function previewGeometry(capsule: Pick<Capsule, 'windows'>, windows: WindowInfo[], selfPids: number[], displays: Display[] = []): GeometryRow[] {
  const used = new Set<number>();
  return (capsule.windows ?? []).map((saved) => {
    const offscreen = displays.length > 0 && !displays.some((d) => intersects(d, saved));
    const win = pickWindow(saved, windows, used);
    if (!win) return {saved, status: 'no-match', offscreen, reason: 'No open window matches yet; restoring opens the capsule items first and waits for it'};
    used.add(win.hwnd);
    const why = checkWindowPolicy(win, 'move-window', selfPids);
    const live = {hwnd: win.hwnd, title: win.title, process: win.process, x: win.x, y: win.y, width: win.width, height: win.height};
    return why ? {saved, status: 'blocked', window: live, offscreen, reason: why} : {saved, status: 'match', window: live, offscreen};
  });
}

export type CaptureSkip = {hwnd: number; process: string; reason: string};

/**
 * Builds Capsule.windows from live windows the user ticked (hwnd list). Windows that could not be restored anyway
 * (minimized, maximized, elevated, ours, zero-sized, no process) are skipped with a reason, never silently dropped.
 */
export function captureGeometry(windows: WindowInfo[], selected: number[], selfPids: number[]): {windows: WindowRect[]; skipped: CaptureSkip[]} {
  const pick = new Set(selected);
  const out: {windows: WindowRect[]; skipped: CaptureSkip[]} = {windows: [], skipped: []};
  for (const w of windows) {
    if (!pick.has(w.hwnd)) continue;
    const skip = (reason: string) => out.skipped.push({hwnd: w.hwnd, process: w.process, reason});
    const why = checkWindowPolicy(w, 'move-window', selfPids);
    if (why) skip(why);
    else if (w.minimized) skip('Minimized windows have no usable position');
    else if (w.maximized) skip('Maximized windows are not captured; restore them first');
    else if (w.width < 1 || w.height < 1) skip('The window has no size');
    else if (out.windows.length >= 100) skip('A capsule holds at most 100 windows');
    else out.windows.push({title: w.title.slice(0, 500), process: w.process.slice(0, 260), x: w.x, y: w.y, width: w.width, height: w.height});
  }
  const found = new Set(windows.map((w) => w.hwnd));
  for (const h of pick) if (!found.has(h)) out.skipped.push({hwnd: h, process: '', reason: 'The window is no longer open'});
  return out;
}

export type PreviewItem = {kind: Capsule['items'][number]['kind']; target: string; label: string; ok: boolean; detail: string};
export type RestorePreview = {capsule: string; items: PreviewItem[]; windows: GeometryRow[]; windowsError?: string};

/**
 * Dry run of restoreCapsule: authorizes every item exactly as a restore would (without running anything) and matches
 * windows. Shows the user what will be allowed and what will be refused before they press Restore.
 */
export async function previewRestore(deps: Pick<CapsuleDeps, 'state' | 'actions' | 'native' | 'selfPids'>, id: unknown, displays: Display[] = []): Promise<RestorePreview> {
  if (typeof id !== 'string' || id.length > 64) throw new Error('Capsule id is invalid');
  const capsule = deps.state().capsules.find((c) => c.id === id);
  if (!capsule) throw new Error('Capsule not found');
  const prepared = await Promise.all(capsule.items.map((i) => deps.actions.prepareItem(i.kind, i.target)));
  const items = capsule.items.map((i, n): PreviewItem => {
    const p = prepared[n];
    return {kind: i.kind, target: i.target, label: i.label, ok: p.ok, detail: p.ok ? p.detail : p.reason};
  });
  let windows: GeometryRow[] = [], windowsError: string | undefined;
  if (capsule.windows?.length) {
    try { windows = previewGeometry(capsule, await deps.native.listWindows(), deps.selfPids(), displays); } catch (e) { windowsError = (e as Error).message.slice(0, 200); }
  }
  return {capsule: capsule.name, items, windows, ...(windowsError ? {windowsError} : {})};
}

// ---- Portable packs -------------------------------------------------------------------------------------------

export const PACK_FORMAT = 'jarvis-capsule-pack';
export const PACK_LIMITS = {bytes: 1_000_000, capsules: 20, items: 100, goals: 50, references: 100};
export type PathRoot = {name: string; path: string};
export type PathMapping = {from: string; to: string};

export type PackedCapsule = {
  name: string; description: string; scene: string;
  items: Capsule['items']; windows?: WindowRect[];
  goals: string[];
  references: {kind: 'file' | 'folder' | 'url'; target: string; label: string; note?: string}[];
};

const ROOT_TOKEN = /^\{ROOT:([A-Za-z0-9_-]{1,32})\}(?:\\(.*))?$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const normPath = (p: string) => p.replace(/\//g, '\\');

/** Replaces a leading registered root with {ROOT:name}; returns null when no root contains the path. */
function tokenize(target: string, roots: PathRoot[]): string | null {
  const t = normPath(target);
  let best: {name: string; len: number} | null = null;
  for (const r of roots) {
    const base = normPath(r.path).replace(/\\+$/, '');
    if (!base) continue;
    const inside = t.toLowerCase() === base.toLowerCase() || t.toLowerCase().startsWith(`${base.toLowerCase()}\\`);
    if (inside && (!best || base.length > best.len)) best = {name: r.name, len: base.length};
  }
  if (!best) return null;
  const rest = t.slice(best.len).replace(/^\\+/, '');
  return rest ? `{ROOT:${best.name}}\\${rest}` : `{ROOT:${best.name}}`;
}

/** Exports one capsule (plus its goals and references) as pack JSON. Paths under a registered root become {ROOT:name} tokens. */
export function exportCapsulePack(capsule: Capsule, meta: {goals: {text: string}[]; references: PackedCapsule['references'] | {kind: string; target: string; label: string; note?: string}[]} | undefined, roots: PathRoot[] = [], now = new Date()): {json: string; unmapped: string[]} {
  const unmapped: string[] = [];
  const conv = (kind: string, target: string): string => {
    if (kind === 'url' || kind === 'note' || kind === 'task' || !/^[a-zA-Z]:[\\/]/.test(target)) return target;
    const tok = tokenize(target, roots);
    if (tok) return tok;
    unmapped.push(target);
    return target;
  };
  const packed: PackedCapsule = {
    name: capsule.name, description: capsule.description, scene: capsule.scene,
    items: capsule.items.map((i) => ({kind: i.kind, label: i.label, target: conv(i.kind, i.target)})),
    ...(capsule.windows ? {windows: capsule.windows} : {}),
    goals: (meta?.goals ?? []).map((g) => g.text),
    // Notes and tasks are internal ids that mean nothing in another install, so only file/folder/url references travel.
    references: (meta?.references ?? []).filter((r) => r.kind === 'file' || r.kind === 'folder' || r.kind === 'url').map((r) => ({kind: r.kind as 'file' | 'folder' | 'url', target: conv(r.kind, r.target), label: r.label, ...(r.note ? {note: r.note} : {})})),
  };
  return {json: JSON.stringify({format: PACK_FORMAT, schemaVersion: 1, exportedAt: now.toISOString(), roots: roots.map((r) => ({name: r.name})), capsules: [packed]}, null, 2), unmapped};
}

/** Applies mappings to one stored path. Longest `from` wins; matching is case-insensitive on whole path segments. */
export function mapPath(target: string, mappings: PathMapping[]): {path: string} | {error: string} {
  const t = normPath(target);
  const tok = ROOT_TOKEN.exec(t);
  const sorted = [...mappings].sort((a, b) => b.from.length - a.from.length);
  for (const m of sorted) {
    const from = normPath(m.from).replace(/\\+$/, '');
    if (!from) continue;
    const lower = t.toLowerCase(), f = from.toLowerCase();
    if (lower === f || lower.startsWith(`${f}\\`)) {
      const joined = `${normPath(m.to).replace(/\\+$/, '')}${t.slice(from.length)}`;
      return normalizeAbsolutePath(joined);
    }
  }
  if (tok) return {error: `Choose a folder for {ROOT:${tok[1]}} before importing`};
  return normalizeAbsolutePath(t);
}

export type ImportIssue = {capsule: string; target: string; reason: string};
export type PackImport = {
  capsules: PackedCapsule[];
  /** Pack roots that need a local folder before their items can be imported. */
  roots: string[];
  mappedPaths: number;
  skipped: ImportIssue[];
  notes: string[];
};

/**
 * Parses and validates a capsule pack. Returns drafts for the caller to save through the normal validated save path;
 * does not save anything itself. Items that cannot be mapped to a safe local path are skipped with a reason: UNC,
 * device, relative and ".." paths are never accepted, and urls must be http(s). Unknown keys are ignored.
 */
export function parseCapsulePack(raw: unknown, mappings: PathMapping[] = []): PackImport {
  if (typeof raw !== 'string') throw new Error('Pack data must be text');
  if (raw.length > PACK_LIMITS.bytes) throw new Error('Pack is too large to import');
  let j: unknown;
  try { j = JSON.parse(raw); } catch { throw new Error('File is not valid JSON'); }
  if (!isPlainObject(j) || j.format !== PACK_FORMAT) throw new Error('File is not a capsule pack');
  if (j.schemaVersion !== 1) throw new Error('Pack was created by a newer version');
  if (!Array.isArray(j.capsules) || !j.capsules.length || j.capsules.length > PACK_LIMITS.capsules) throw new Error(`Pack must contain 1 to ${PACK_LIMITS.capsules} capsules`);
  const out: PackImport = {capsules: [], roots: [], mappedPaths: 0, skipped: [], notes: ['Imported items are not pre-approved: each one is checked against your allowed folders and approved apps and needs your confirmation when the capsule is restored.']};
  const needRoots = new Set<string>();
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

  const resolve = (name: string, kind: string, target: string): string | null => {
    if (kind === 'url') {
      const u = validateOpenUrl(target);
      if (!u.ok) { out.skipped.push({capsule: name, target: target.slice(0, 200), reason: u.reason}); return null; }
      return u.url;
    }
    if (kind === 'app' && /^[\w .+-]{1,64}\.exe$/i.test(target)) return target;
    if (/^[\s\S]*[\u0000-\u001f\u007f]/.test(target)) { out.skipped.push({capsule: name, target: target.slice(0, 80), reason: 'Path contains control characters'}); return null; }
    const tok = ROOT_TOKEN.exec(normPath(target));
    const r = mapPath(target, mappings);
    if ('error' in r) {
      if (tok && !mappings.some((m) => m.from.toLowerCase() === `{root:${tok[1]}}`.toLowerCase())) needRoots.add(tok[1]);
      out.skipped.push({capsule: name, target: target.slice(0, 200), reason: r.error});
      return null;
    }
    if (tok || mappings.some((m) => normPath(target).toLowerCase().startsWith(normPath(m.from).toLowerCase()))) out.mappedPaths++;
    return r.path;
  };

  for (const c of j.capsules) {
    if (!isPlainObject(c)) throw new Error('A capsule in the pack is invalid');
    const name = str(c.name, 120);
    if (!name) throw new Error('A capsule in the pack has no name');
    const rawItems = Array.isArray(c.items) ? c.items.slice(0, PACK_LIMITS.items) : [];
    const items: Capsule['items'] = [];
    for (const it of rawItems) {
      if (!isPlainObject(it) || !['file', 'folder', 'url', 'app'].includes(String(it.kind)) || typeof it.target !== 'string') { out.skipped.push({capsule: name, target: '(invalid item)', reason: 'Item is malformed'}); continue; }
      const target = resolve(name, String(it.kind), it.target);
      if (target) items.push({kind: it.kind as Capsule['items'][number]['kind'], target, label: str(it.label, 200)});
    }
    const windows: WindowRect[] = [];
    for (const w of Array.isArray(c.windows) ? c.windows.slice(0, 100) : []) {
      const n = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
      if (!isPlainObject(w)) continue;
      const x = n(w.x, -100000, 100000), y = n(w.y, -100000, 100000), width = n(w.width, 1, 100000), height = n(w.height, 1, 100000);
      const process = str(w.process, 260);
      if (x === null || y === null || width === null || height === null || !process) { out.skipped.push({capsule: name, target: `window ${process || '?'}`, reason: 'Window geometry is invalid'}); continue; }
      windows.push({title: str(w.title, 500), process, x, y, width, height});
    }
    const references: PackedCapsule['references'] = [];
    for (const r of Array.isArray(c.references) ? c.references.slice(0, PACK_LIMITS.references) : []) {
      if (!isPlainObject(r) || !['file', 'folder', 'url'].includes(String(r.kind)) || typeof r.target !== 'string') continue;
      const target = resolve(name, String(r.kind), r.target);
      if (target) references.push({kind: r.kind as 'file' | 'folder' | 'url', target, label: str(r.label, 120), ...(str(r.note, 500) ? {note: str(r.note, 500)} : {})});
    }
    out.capsules.push({
      name, description: str(c.description, 2000), scene: str(c.scene, 64) || 'graphite', items, ...(windows.length ? {windows} : {}),
      goals: (Array.isArray(c.goals) ? c.goals : []).filter((g): g is string => typeof g === 'string').map((g) => str(g, 200)).filter(Boolean).slice(0, PACK_LIMITS.goals),
      references,
    });
  }
  out.roots = [...needRoots];
  return out;
}
