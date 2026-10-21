// Semantic control of the one app window the person attached to the companion, through Windows UI Automation.
//
// Pure policy (no Electron, no PowerShell of its own; the native helpers are injected), unit tested with a fake desktop:
// - Inspect: a bounded, sanitized snapshot of that window's own UI elements (same process only). Each element gets a
//   short ref ("e7") that is valid only inside that snapshot; the snapshot expires, and any action makes it stale, so
//   the model must look again before acting again. The model never sees or sends coordinates, window handles,
//   runtime ids or indexes of its own: an unknown ref is refused.
// - Act: one named action (invoke, toggle, expand, collapse, select, focus, scroll_into_view, scroll_up, scroll_down) on
//   one element that offers it. The person sees the exact app, window, element and effect in the trusted native
//   confirmation (Cancel is the default). After Continue, and again just before the helper runs, the window is checked
//   again: same handle, same process id and name, not elevated, not minimized, still attached, not stopped. The helper
//   finds the element again by its runtime id and refuses unless its type, name and automation id still match.
// - Password fields, protected or elevated windows, disabled, unlabelled or ambiguous elements are refused.
// - Receipts keep "performed" apart from "verified": an action counts as verified only when an independent read-back of
//   the element shows the expected state (toggled, expanded, selected, focused, scrolled into view). Invoke and scroll
//   are reported as performed, not verified. There is no undo: none of these actions is reversed by this app.
// There is no shell, script, free-form code, keystroke or coordinate path here.

export const UIA_LIMITS = {
  /** Elements kept in one snapshot (the helper also stops walking at maxNodes). */
  maxElements: 150,
  maxDepth: 12,
  nameChars: 120,
  valueChars: 200,
  idChars: 64,
  /** A snapshot older than this is refused; the model must inspect again. */
  ttlMs: 60_000,
} as const;

export const UIA_ACTIONS = ['invoke', 'toggle', 'expand', 'collapse', 'select', 'focus', 'scroll_into_view', 'scroll_up', 'scroll_down'] as const;
export type UiaAction = (typeof UIA_ACTIONS)[number];

/** One element as the native helper reports it (untrusted: every field is checked). */
export type RawUiaNode = {
  /** prid: the parent's runtime id, or '' at the top of the walk. */
  rid: string; prid: string; type: string; name: string; aid: string; cls?: string; pid: number;
  enabled: boolean; offscreen: boolean; password: boolean; focusable: boolean; focused?: boolean;
  patterns: string[]; toggle?: string; expand?: string; selected?: boolean; value?: string; readOnly?: boolean;
};
export type UiaReadback = {exists: boolean; toggle?: string; expand?: string; selected?: boolean; focused?: boolean; offscreen?: boolean; value?: string; name?: string};

export interface UiaNative {
  inspect(w: {hwnd: number; pid: number}, opts: {maxNodes: number; maxDepth: number}, signal: AbortSignal): Promise<{nodes: unknown[]; truncated: boolean}>;
  act(w: {hwnd: number; pid: number}, req: {rid: string; expect: {type: string; name: string; aid: string}; action: UiaAction}, signal: AbortSignal): Promise<{performed: boolean; reason?: string; readback?: UiaReadback}>;
}

export type UiaTarget = {hwnd: number; pid: number; process: string; title: string};
export type UiaWindow = {hwnd: number; pid: number; process: string; title: string; elevated: number; minimized: boolean};

/** What the model sees for one element. */
export type UiaElement = {
  ref: string; role: string; name: string; automationId?: string; parent?: string;
  enabled: boolean; offscreen: boolean; actions: UiaAction[];
  state?: {toggle?: string; expand?: string; selected?: boolean; focused?: boolean; value?: string};
  /** Why this element offers no actions, when it has none (password field, disabled, unlabelled, duplicate label). */
  refused?: string;
};
export type UiaSnapshot = {id: string; takenAt: number; expiresAt: number; app: string; title: string; elements: UiaElement[]; truncated: boolean};

type Kept = {el: UiaElement; raw: RawUiaNode};
type Session = {snapshot: UiaSnapshot; target: UiaTarget; byRef: Map<string, Kept>; stale: boolean};

const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
const clean = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');
const ROLE_RE = /^[A-Za-z]{1,32}$/;
const RID_RE = /^-?\d{1,10}(\.-?\d{1,10}){0,15}$/;
const PATTERNS = new Set(['Invoke', 'Toggle', 'ExpandCollapse', 'SelectionItem', 'ScrollItem', 'Scroll', 'Value']);

/** Validates one raw node; null when it is malformed (it is then dropped, never repaired). */
export function parseRawNode(v: unknown): RawUiaNode | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.rid !== 'string' || !RID_RE.test(o.rid) || typeof o.type !== 'string' || !ROLE_RE.test(o.type)) return null;
  if (typeof o.pid !== 'number' || !Number.isSafeInteger(o.pid)) return null;
  const prid = typeof o.prid === 'string' && RID_RE.test(o.prid) ? o.prid : '';
  const bool = (k: string) => o[k] === true;
  return {
    rid: o.rid, prid, type: o.type, pid: o.pid,
    name: clean(o.name, UIA_LIMITS.nameChars), aid: clean(o.aid, UIA_LIMITS.idChars), cls: clean(o.cls, UIA_LIMITS.idChars),
    enabled: bool('enabled'), offscreen: bool('offscreen'), password: bool('password'), focusable: bool('focusable'), focused: bool('focused'),
    patterns: Array.isArray(o.patterns) ? o.patterns.filter((p): p is string => typeof p === 'string' && PATTERNS.has(p)) : [],
    ...(typeof o.toggle === 'string' && /^(On|Off|Indeterminate)$/.test(o.toggle) ? {toggle: o.toggle} : {}),
    ...(typeof o.expand === 'string' && /^(Expanded|Collapsed|PartiallyExpanded|LeafNode)$/.test(o.expand) ? {expand: o.expand} : {}),
    ...(typeof o.selected === 'boolean' ? {selected: o.selected} : {}),
    ...(typeof o.value === 'string' ? {value: clean(o.value, UIA_LIMITS.valueChars)} : {}),
    ...(typeof o.readOnly === 'boolean' ? {readOnly: o.readOnly} : {}),
  };
}

function actionsFor(n: RawUiaNode): UiaAction[] {
  const a: UiaAction[] = [];
  const has = (p: string) => n.patterns.includes(p);
  if (has('Invoke')) a.push('invoke');
  if (has('Toggle')) a.push('toggle');
  if (has('ExpandCollapse') && n.expand !== 'LeafNode') a.push(n.expand === 'Expanded' ? 'collapse' : 'expand');
  if (has('SelectionItem') && n.selected !== true) a.push('select');
  if (n.focusable && !n.focused) a.push('focus');
  if (has('ScrollItem') && n.offscreen) a.push('scroll_into_view');
  if (has('Scroll')) a.push('scroll_up', 'scroll_down');
  // Offscreen elements can only be brought into view first.
  return n.offscreen ? a.filter((x) => x === 'scroll_into_view') : a;
}

/**
 * Turns the helper's raw list into the model's view: same-process elements only, bounded, labels cleaned, password
 * values never kept, refs e1… assigned in walk order. Elements that cannot be named unambiguously offer no actions.
 */
export function sanitizeSnapshot(raw: unknown[], target: UiaTarget, ctx: {id: string; now: number; ttlMs?: number; truncated?: boolean}): {snapshot: UiaSnapshot; byRef: Map<string, Kept>} {
  const nodes: RawUiaNode[] = [];
  let truncated = !!ctx.truncated;
  for (const r of raw.slice(0, UIA_LIMITS.maxElements * 2)) {
    const n = parseRawNode(r);
    if (!n || n.pid !== target.pid) continue;
    if (nodes.length >= UIA_LIMITS.maxElements) { truncated = true; break; }
    nodes.push(n);
  }
  // A label is ambiguous when another element with the same role and name exists and neither has an automation id.
  const key = (n: RawUiaNode) => `${n.type}\u0000${n.name}`;
  const counts = new Map<string, number>();
  for (const n of nodes) if (!n.aid) counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  const ridToRef = new Map<string, string>();
  const byRef = new Map<string, Kept>();
  const elements: UiaElement[] = [];
  const seenRid = new Set<string>();
  nodes.forEach((n, i) => {
    if (seenRid.has(n.rid)) return; // the same element twice: keep the first, never guess
    seenRid.add(n.rid);
    const ref = `e${i + 1}`;
    ridToRef.set(n.rid, ref);
    let refused: string | undefined;
    if (n.password) refused = 'password field';
    else if (!n.enabled) refused = 'disabled';
    else if (!n.name && !n.aid) refused = 'unlabelled';
    else if (!n.aid && (counts.get(key(n)) ?? 0) > 1) refused = 'ambiguous: another element has the same label';
    const actions = refused ? [] : actionsFor(n);
    const state: UiaElement['state'] = {};
    if (n.toggle) state.toggle = n.toggle;
    if (n.expand && n.expand !== 'LeafNode') state.expand = n.expand;
    if (n.selected !== undefined) state.selected = n.selected;
    if (n.focused) state.focused = true;
    // Values are read only from plain, non-password fields; password content never enters a snapshot.
    if (!n.password && n.value !== undefined && n.value !== '') state.value = n.value;
    const el: UiaElement = {
      ref, role: n.type, name: n.name, ...(n.aid ? {automationId: n.aid} : {}),
      ...(n.prid && ridToRef.has(n.prid) ? {parent: ridToRef.get(n.prid)} : {}),
      enabled: n.enabled, offscreen: n.offscreen, actions, ...(Object.keys(state).length ? {state} : {}), ...(refused ? {refused} : {}),
    };
    elements.push(el);
    byRef.set(ref, {el, raw: n});
  });
  const ttl = ctx.ttlMs ?? UIA_LIMITS.ttlMs;
  return {snapshot: {id: ctx.id, takenAt: ctx.now, expiresAt: ctx.now + ttl, app: target.process, title: clean(target.title, 120), elements, truncated}, byRef};
}

const VERB: Record<UiaAction, string> = {
  invoke: 'Press', toggle: 'Switch', expand: 'Expand', collapse: 'Collapse', select: 'Select', focus: 'Move focus to',
  scroll_into_view: 'Scroll into view', scroll_up: 'Scroll up in', scroll_down: 'Scroll down in',
};

/** Whether an independent read-back shows the action's expected effect. Invoke and scroll have no such state. */
export function verifyReadback(action: UiaAction, before: RawUiaNode, rb: UiaReadback | undefined): boolean {
  if (!rb || !rb.exists) return false;
  switch (action) {
    case 'toggle': return !!rb.toggle && rb.toggle !== before.toggle;
    case 'expand': return rb.expand === 'Expanded';
    case 'collapse': return rb.expand === 'Collapsed';
    case 'select': return rb.selected === true;
    case 'focus': return rb.focused === true;
    case 'scroll_into_view': return rb.offscreen === false;
    default: return false;
  }
}

export type UiaReceipt =
  | {performed: true; verified: boolean; summary: string; readback?: UiaReadback; note: string}
  | {performed: false; declined?: boolean; summary: string; reason: string};

export type UiaDeps = {
  native: UiaNative;
  /** Fresh window list from Windows (never cached). */
  listWindows: () => Promise<UiaWindow[]>;
  now?: () => number;
  newId: () => string;
};

export class UiaControl {
  private session: Session | null = null;
  private readonly now: () => number;
  constructor(private readonly deps: UiaDeps) { this.now = deps.now ?? (() => Date.now()); }

  /** Forgets the snapshot (bubble closed, target removed, lock, Stop). */
  clear(): void { this.session = null; }

  /** Checks the attached window is still the same, unelevated, visible app window. Returns a reason or null. */
  async revalidate(target: UiaTarget): Promise<string | null> {
    let windows: UiaWindow[];
    try { windows = await this.deps.listWindows(); } catch { return 'Windows could not confirm the app window'; }
    const w = windows.find((x) => x.hwnd === target.hwnd);
    if (!w) return 'The app window is gone';
    if (w.pid !== target.pid || w.process.toLowerCase() !== target.process.toLowerCase()) return 'That window now belongs to a different program';
    if (w.elevated !== 0) return 'The app runs with administrator rights or is protected, so it cannot be controlled';
    if (w.minimized) return 'The app window is minimized';
    return null;
  }

  async inspect(target: UiaTarget, signal: AbortSignal): Promise<{ok: true; snapshot: UiaSnapshot} | {ok: false; reason: string}> {
    this.session = null;
    if (signal.aborted) return {ok: false, reason: 'Stopped'};
    const bad = await this.revalidate(target);
    if (bad) return {ok: false, reason: bad};
    if (signal.aborted) return {ok: false, reason: 'Stopped'};
    let raw: {nodes: unknown[]; truncated: boolean};
    try {
      raw = await this.deps.native.inspect({hwnd: target.hwnd, pid: target.pid}, {maxNodes: UIA_LIMITS.maxElements, maxDepth: UIA_LIMITS.maxDepth}, signal);
    } catch (e) {
      return {ok: false, reason: signal.aborted ? 'Stopped' : `The app's controls could not be read (${e instanceof Error ? e.message.slice(0, 120) : 'helper failed'})`};
    }
    if (signal.aborted) return {ok: false, reason: 'Stopped'};
    const {snapshot, byRef} = sanitizeSnapshot(Array.isArray(raw.nodes) ? raw.nodes : [], target, {id: this.deps.newId(), now: this.now(), truncated: raw.truncated});
    this.session = {snapshot, target, byRef, stale: false};
    return {ok: true, snapshot};
  }

  /** The exact effect the person will be asked about, or why it is refused. Nothing runs here. */
  preview(target: UiaTarget, snapshotId: string, ref: string, action: UiaAction): {ok: true; summary: string; detail: string; kept: Kept} | {ok: false; reason: string} {
    const s = this.session;
    if (!s || s.snapshot.id !== snapshotId) return {ok: false, reason: 'That snapshot is not current. Inspect the app again.'};
    if (s.stale) return {ok: false, reason: 'The app may have changed since the last action. Inspect it again first.'};
    if (this.now() >= s.snapshot.expiresAt) return {ok: false, reason: 'That snapshot expired. Inspect the app again.'};
    if (s.target.hwnd !== target.hwnd || s.target.pid !== target.pid) return {ok: false, reason: 'That snapshot belongs to a different window.'};
    const kept = s.byRef.get(ref);
    if (!kept) return {ok: false, reason: `There is no element ${ref.slice(0, 16)} in that snapshot.`};
    if (kept.el.refused) return {ok: false, reason: `That element cannot be controlled (${kept.el.refused}).`};
    if (!kept.el.actions.includes(action)) return {ok: false, reason: `That element does not offer ${action}.`};
    const label = kept.el.name ? `“${kept.el.name}”` : `the element with id “${kept.el.automationId}”`;
    const what = `${VERB[action]} ${label} (${kept.el.role.toLowerCase()})`;
    const app = target.process.replace(/\.exe$/i, '');
    const summary = `${what} in ${app}?`;
    const detail = `App: ${target.process} (process ${target.pid})\nWindow: ${clean(target.title, 120)}\nElement: ${kept.el.role} ${label}${kept.el.automationId ? `, id ${kept.el.automationId}` : ''}\nEffect: ${what}.\n\nThe app decides what this does. Cancel is the default.`;
    return {ok: true, summary, detail, kept};
  }

  /**
   * One confirmed action. `current` says the person still has this window attached (and the bubble open);
   * `confirm` is the trusted native confirmation. Any change after the snapshot is refused rather than guessed.
   */
  async perform(target: UiaTarget, snapshotId: string, ref: string, action: UiaAction, h: {confirm: (summary: string, detail: string) => Promise<boolean>; current: () => boolean; signal: AbortSignal; onConfirm?: (open: boolean) => void}): Promise<UiaReceipt> {
    const p = this.preview(target, snapshotId, ref, action);
    if (!p.ok) return {performed: false, summary: 'Not done', reason: p.reason};
    if (!h.current() || h.signal.aborted) return {performed: false, summary: 'Not done', reason: 'You removed that window, closed the bubble or pressed Stop'};
    h.onConfirm?.(true);
    let ok = false;
    try { ok = await h.confirm(p.summary, p.detail); } catch { ok = false; } finally { h.onConfirm?.(false); }
    if (!ok) return {performed: false, declined: true, summary: 'Not confirmed. Nothing was done', reason: 'Cancelled or the confirmation could not be shown'};
    // After Continue: everything is checked again, immediately before the helper runs.
    if (h.signal.aborted || !h.current()) return {performed: false, summary: 'Not done', reason: 'Stopped, or the window was removed, while the confirmation was open'};
    const bad = await this.revalidate(target);
    if (bad) return {performed: false, summary: 'Not done', reason: bad};
    if (h.signal.aborted || !h.current()) return {performed: false, summary: 'Not done', reason: 'Stopped before the action ran'};
    const again = this.preview(target, snapshotId, ref, action);
    if (!again.ok) return {performed: false, summary: 'Not done', reason: again.reason};
    // Whatever happens next, this snapshot no longer describes the app.
    if (this.session) this.session.stale = true;
    const raw = p.kept.raw;
    let r: Awaited<ReturnType<UiaNative['act']>>;
    try {
      r = await this.deps.native.act({hwnd: target.hwnd, pid: target.pid}, {rid: raw.rid, expect: {type: raw.type, name: raw.name, aid: raw.aid}, action}, h.signal);
    } catch (e) {
      return {performed: false, summary: 'Not done', reason: h.signal.aborted ? 'Stopped' : `The action could not be run (${e instanceof Error ? e.message.slice(0, 120) : 'helper failed'})`};
    }
    if (!r.performed) return {performed: false, summary: 'Not done', reason: clean(r.reason ?? 'The app refused the action', 160)};
    const verified = verifyReadback(action, raw, r.readback);
    const label = p.kept.el.name || p.kept.el.automationId || p.kept.el.role;
    return {
      performed: true, verified,
      summary: `${VERB[action]} “${label}”${verified ? '. Checked' : '. Not independently verified'}`,
      ...(r.readback ? {readback: r.readback} : {}),
      note: verified ? 'A fresh read of the element shows the expected state.' : 'Windows accepted the action. Its effect was not independently confirmed; inspect the app again to see what changed.',
    };
  }
}
