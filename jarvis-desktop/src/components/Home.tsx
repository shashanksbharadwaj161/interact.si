import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowsClockwise, ChatCircleDots, CheckSquare, Cube, EyeSlash, Lightning, Note as NoteIcon, Plus, SquaresFour, WarningCircle } from '@phosphor-icons/react';
import type { ActionPreview, ActionRequest, Activity, Capability, Capsule, ChatMessage, Note, Task } from '../shared/contracts';
import { Avatar } from './Avatar';
import { MemorySearch } from './MemorySearch';
import { SHELL_PREF, useShellPref } from './Settings';
import { WidgetPicker } from './WidgetPicker';
import { Badge, Button, Empty, Notice, PageHeader, Panel } from '../ui/primitives';
import { useCompanion } from '../ui/companion';
import { useReady } from '../ui/store';
import { usePref } from '../ui/prefs';
import * as dashboard from '../ui/widgets';
import { VIEW_FOR_CATEGORY, type ViewId } from '../ui/nav';
import { cx, dueBucket, dueKey, fmtDueKey, localDateKey, relTime, truncate } from '../ui/util';
import { sceneName } from '../ui/scenes';
import { ModelReadinessNotice, modelReadiness, useModelCheck } from './Onboarding';
import '../styles/parallel-home.css';
import * as shelfModel from '../ui/file-shelf';
import { isPreviewBridge } from '../preview';
import { actionOutcome } from '../ui/action-result';

/* ---------- Widget registry and layout (pure, tested) ---------- */

export type WidgetId = 'status' | 'capture' | 'actions' | 'totals' | 'readiness' | 'due' | 'capsules' | 'notes' | 'search' | 'companion' | 'capabilities' | 'activity';
export type WidgetDef = { id: WidgetId; title: string; span: 'full' | 'half'; blurb: string };

export const WIDGETS: readonly WidgetDef[] = [
  { id: 'status', title: 'Status', span: 'full', blurb: 'The one thing that needs attention first, then the rest of the system state.' },
  { id: 'capture', title: 'Quick capture', span: 'half', blurb: 'Add a task or a note without leaving Home.' },
  { id: 'actions', title: 'Quick actions', span: 'half', blurb: 'Shortcuts into the screens you are most likely to need right now.' },
  { id: 'totals', title: 'Totals', span: 'full', blurb: 'Counts of capsules, notes, open tasks and chat messages.' },
  { id: 'readiness', title: 'Model readiness', span: 'full', blurb: 'Whether the assistant can answer right now. Hidden automatically while the model is ready.' },
  { id: 'due', title: 'Due now', span: 'half', blurb: 'Tasks that are overdue, due today or due this week.' },
  { id: 'companion', title: 'Companion', span: 'half', blurb: 'Live avatar state and the last chat message.' },
  { id: 'capsules', title: 'Recent capsules', span: 'half', blurb: 'The four most recently changed capsules.' },
  { id: 'capabilities', title: 'Capabilities', span: 'half', blurb: 'What this app detected on this computer.' },
  { id: 'notes', title: 'Recent notes', span: 'half', blurb: 'The four most recently changed notes.' },
  { id: 'search', title: 'Memory search', span: 'half', blurb: 'Quick search over saved items, five results.' },
  { id: 'activity', title: 'Recent activity', span: 'half', blurb: 'The audit trail of writes and approved actions, grouped by day.' },
];

export type HomeLayout = { order: WidgetId[]; hidden: WidgetId[] };
const WIDGET_IDS = WIDGETS.map((w) => w.id);
const isWidgetId = (v: unknown): v is WidgetId => typeof v === 'string' && (WIDGET_IDS as string[]).includes(v);

export const DEFAULT_LAYOUT: HomeLayout = { order: [...WIDGET_IDS], hidden: [] };

/** Accepts anything from storage: unknown ids are dropped, duplicates removed, missing widgets appended in default order. */
export function normalizeLayout(raw: unknown): HomeLayout {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { order?: unknown; hidden?: unknown };
  const order: WidgetId[] = [];
  for (const id of Array.isArray(r.order) ? r.order : []) if (isWidgetId(id) && !order.includes(id)) order.push(id);
  for (const id of WIDGET_IDS) if (!order.includes(id)) order.push(id);
  const hidden: WidgetId[] = [];
  for (const id of Array.isArray(r.hidden) ? r.hidden : []) if (isWidgetId(id) && !hidden.includes(id)) hidden.push(id);
  return { order, hidden };
}

export function moveWidget(layout: HomeLayout, id: WidgetId, dir: -1 | 1): HomeLayout {
  const visible = layout.order.filter((w) => !layout.hidden.includes(w));
  const i = visible.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= visible.length) return layout;
  const swapped = [...visible];
  [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
  // Hidden widgets keep their place relative to the visible ones they followed.
  const order: WidgetId[] = [];
  let v = 0;
  for (const w of layout.order) order.push(layout.hidden.includes(w) ? w : swapped[v++]);
  return { ...layout, order };
}

export function setWidgetHidden(layout: HomeLayout, id: WidgetId, hidden: boolean): HomeLayout {
  const rest = layout.hidden.filter((w) => w !== id);
  return { ...layout, hidden: hidden ? [...rest, id] : rest };
}

export const layoutIsDefault = (l: HomeLayout): boolean => l.hidden.length === 0 && l.order.every((id, i) => id === DEFAULT_LAYOUT.order[i]);

/** Time-of-day greeting; the name is optional and already normalised by Settings. */
export function greeting(hour: number, name: string): string {
  const part = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}.` : `${part}.`;
}

/* ---------- Cockpit model (pure, tested): everything below reads saved data and takes time as a parameter ---------- */

export type ReadinessLevel = 'ready' | 'blocked' | 'unknown';

export type CockpitInput = {
  tasks: Task[];
  notes: Note[];
  capsules: Capsule[];
  chat: ChatMessage[];
  activity: Activity[];
  /** null until a system check has answered. */
  capabilities: Capability[] | null;
  systemError: string | null;
  systemLoading: boolean;
  readiness: ReadinessLevel;
  mode: 'offline' | 'online';
  /** Local calendar day, YYYY-MM-DD. */
  today: string;
  /** Reference time for relative stamps; relTime's own clock is used when absent. */
  now?: number;
};

export type Triage = { overdue: Task[]; today: Task[]; week: Task[]; later: Task[]; undated: Task[]; open: number; done: number };

const byDue = (a: Task, b: Task) => (dueKey(a) ?? '9999').localeCompare(dueKey(b) ?? '9999') || a.createdAt.localeCompare(b.createdAt);

/** Whole days between two YYYY-MM-DD keys, read as local dates; null when either key is unreadable. */
export function dayDiff(fromKey: string, toKey: string): number | null {
  const a = new Date(`${fromKey}T00:00:00`);
  const b = new Date(`${toKey}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Open tasks split into the buckets Home shows, each sorted by due date then creation. */
export function triageTasks(tasks: Task[], today: string): Triage {
  const t: Triage = { overdue: [], today: [], week: [], later: [], undated: [], open: 0, done: 0 };
  for (const task of tasks) {
    if (task.done) {
      t.done += 1;
      continue;
    }
    t.open += 1;
    const bucket = dueBucket(task, today);
    if (bucket === 'overdue') t.overdue.push(task);
    else if (bucket === 'today') t.today.push(task);
    else if (bucket === 'none') t.undated.push(task);
    else {
      const d = dayDiff(today, dueKey(task) ?? '');
      (d !== null && d <= 7 ? t.week : t.later).push(task);
    }
  }
  for (const k of ['overdue', 'today', 'week', 'later', 'undated'] as const) t[k].sort(byDue);
  return t;
}

/** Short due phrase for one task relative to today. */
export function dueLabel(task: Pick<Task, 'due'>, today: string): string {
  const key = dueKey(task);
  if (!key) return 'No date';
  const d = dayDiff(today, key);
  if (d === null) return key;
  if (d < 0) return d === -1 ? 'Due yesterday' : `Overdue since ${fmtDueKey(key)}`;
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d <= 7) return `In ${d} days`;
  return fmtDueKey(key);
}

export type StatusTier = 'attention' | 'notice' | 'ok';
export type StatusItem = { id: string; tier: StatusTier; title: string; detail: string; view?: ViewId; params?: Record<string, string>; actionLabel?: string };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Ordered status list: attention items first, then notices, then the all-clear. The first entry is the
 * primary line of the cockpit. Every entry is derived from data the app already holds; nothing is probed here.
 */
export function statusHierarchy(input: CockpitInput): StatusItem[] {
  const items: StatusItem[] = [];
  const triage = triageTasks(input.tasks, input.today);
  const unavailable = input.capabilities?.filter((c) => !c.available) ?? [];
  if (input.systemError) items.push({ id: 'system-error', tier: 'attention', title: 'The system check failed', detail: input.systemError, view: 'status', actionLabel: 'Open Status' });
  if (input.readiness === 'blocked') {
    const detail = input.mode === 'online' ? 'Online mode needs a model name and a saved key.' : 'The local model settings are incomplete.';
    items.push({ id: 'model-blocked', tier: 'attention', title: 'The assistant cannot answer yet', detail, view: 'settings', params: { q: 'model' }, actionLabel: 'Open Settings' });
  }
  if (triage.overdue.length) {
    const n = triage.overdue.length;
    items.push({ id: 'overdue', tier: 'attention', title: `${n} ${plural(n, 'task is', 'tasks are')} overdue`, detail: `Oldest: ${truncate(triage.overdue[0].title, 60)}.`, view: 'tasks', actionLabel: 'Open Tasks' });
  }
  if (input.readiness === 'unknown') items.push({ id: 'model-unknown', tier: 'notice', title: 'The model has not been checked', detail: 'Run a check before relying on chat.', view: 'settings', params: { q: 'model' }, actionLabel: 'Open Settings' });
  if (triage.today.length) {
    const n = triage.today.length;
    items.push({ id: 'due-today', tier: 'notice', title: `${n} ${plural(n, 'task', 'tasks')} due today`, detail: `First: ${truncate(triage.today[0].title, 60)}.`, view: 'tasks', actionLabel: 'Open Tasks' });
  }
  if (unavailable.length) {
    const names = unavailable.map((c) => c.name).slice(0, 3).join(', ') + (unavailable.length > 3 ? ' and more' : '');
    items.push({ id: 'capabilities', tier: 'notice', title: `${unavailable.length} of ${input.capabilities?.length ?? 0} capabilities unavailable`, detail: `${names}.`, view: 'status', actionLabel: 'See details' });
  }
  if (!input.capabilities && !input.systemError && !input.systemLoading) items.push({ id: 'system-unchecked', tier: 'notice', title: 'The system check has not run', detail: 'Capability state is unknown until it answers.', view: 'status', actionLabel: 'Open Status' });
  if (items.length === 0) {
    const detail = triage.open === 0 ? 'No open tasks and nothing needs attention.' : `${triage.open} open ${plural(triage.open, 'task', 'tasks')}, none overdue or due today.`;
    items.push({ id: 'all-clear', tier: 'ok', title: 'All clear', detail });
  }
  const rank: Record<StatusTier, number> = { attention: 0, notice: 1, ok: 2 };
  return items.sort((a, b) => rank[a.tier] - rank[b.tier]);
}

export type QuickAction = { id: string; label: string; hint: string; view: ViewId; params?: Record<string, string> };

const stamp = (iso: string, input: CockpitInput) => (input.now === undefined ? relTime(iso) : relTime(iso, input.now));
const newest = <T extends { updatedAt: string }>(items: T[]): T | undefined => [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

/** Navigation shortcuts only. Nothing here sends, runs or probes anything; each entry opens a screen. */
export function quickActions(input: CockpitInput): QuickAction[] {
  const out: QuickAction[] = [];
  const lastChat = input.chat[input.chat.length - 1];
  const capsule = newest(input.capsules);
  const note = newest(input.notes);
  const unavailable = input.capabilities?.filter((c) => !c.available).length ?? 0;
  if (input.readiness === 'blocked') out.push({ id: 'setup-model', label: 'Finish model setup', hint: 'The assistant is blocked until this is done.', view: 'settings', params: { q: 'model' } });
  if (lastChat) out.push({ id: 'continue-chat', label: 'Continue the conversation', hint: `Last message ${stamp(lastChat.createdAt, input)}: ${truncate(lastChat.text.replace(/\s+/g, ' '), 60)}`, view: 'assistant' });
  else out.push({ id: 'ask', label: 'Ask the assistant', hint: input.mode === 'online' ? 'Online mode: messages go to your cloud model only when you send them.' : 'Offline mode: answers come from the local model.', view: 'assistant' });
  if (capsule) out.push({ id: 'reopen-capsule', label: `Reopen ${truncate(capsule.name, 28)}`, hint: `${capsule.items.length} ${plural(capsule.items.length, 'item', 'items')}, changed ${stamp(capsule.updatedAt, input)}.`, view: 'capsules', params: { item: capsule.id } });
  else out.push({ id: 'new-capsule', label: 'Create a capsule', hint: 'Bundle files, folders, apps and URLs for one project.', view: 'capsules' });
  if (note) out.push({ id: 'latest-note', label: `Open ${truncate(note.title || 'Untitled', 28)}`, hint: `Note changed ${stamp(note.updatedAt, input)}.`, view: 'notes', params: { item: note.id } });
  out.push({ id: 'tasks', label: 'Plan tasks', hint: 'Due dates, checklist and the focus timer.', view: 'tasks' });
  if (unavailable > 0) out.push({ id: 'review-capabilities', label: 'Review capabilities', hint: `${unavailable} unavailable on this computer.`, view: 'status' });
  out.push({ id: 'search', label: 'Search memory', hint: 'Find saved notes, tasks and capsules by text.', view: 'search' });
  return out.slice(0, 6);
}

export type ActivityGroup = { label: 'Today' | 'Yesterday' | 'Earlier'; items: Activity[] };

/** Newest first, grouped by local day relative to `today`, capped at `limit` entries in total. */
export function groupActivity(activity: Activity[], today: string, limit = 8): ActivityGroup[] {
  const sorted = [...activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  const groups: ActivityGroup[] = [];
  for (const a of sorted) {
    const d = new Date(a.at);
    const key = Number.isNaN(d.getTime()) ? '' : localDateKey(d);
    const diff = key ? dayDiff(key, today) : null;
    const label: ActivityGroup['label'] = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : 'Earlier';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(a);
    else groups.push({ label, items: [a] });
  }
  return groups;
}

const KIND_LABELS: Record<string, string> = { task: 'Task', note: 'Note', capsule: 'Capsule', action: 'Action', settings: 'Settings', session: 'Session', calendar: 'Calendar', tts: 'Read aloud', stt: 'Dictation' };

export function kindLabel(kind: string): string {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind];
  const clean = kind.replace(/[-_.]+/g, ' ').trim();
  return clean ? clean[0].toUpperCase() + clean.slice(1) : 'Event';
}

export type CapabilityView = { status: 'loading' | 'error' | 'unloaded' | 'loaded'; available: number; total: number; unavailable: Capability[] };

export function capabilityView(capabilities: Capability[] | null, systemError: string | null, loading: boolean): CapabilityView {
  if (capabilities) return { status: 'loaded', available: capabilities.filter((c) => c.available).length, total: capabilities.length, unavailable: capabilities.filter((c) => !c.available) };
  return { status: systemError ? 'error' : loading ? 'loading' : 'unloaded', available: 0, total: 0, unavailable: [] };
}

export type CaptureDue = 'none' | 'today' | 'tomorrow';

/** Due key for the quick-capture choices, from today's key. Returns '' for 'none' or an unreadable day. */
export function captureDueKey(choice: CaptureDue, today: string): string {
  if (choice === 'none') return '';
  if (choice === 'today') return today;
  const d = new Date(`${today}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() + 1);
  return localDateKey(d);
}

/* ---------- Screen ---------- */

type Go = (v: ViewId, params?: Record<string, string>) => void;

function WidgetFrame({ def, arranging, first, last, onMove, onHide, children }: { def: WidgetDef; arranging: boolean; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; onHide: () => void; children: ReactNode }) {
  return (
    <div className={cx('widget', `widget-${def.span}`, arranging && 'is-arranging')} data-widget={def.id}>
      {arranging && (
        <div className="widget-tools" role="group" aria-label={`Arrange ${def.title}`}>
          <span className="widget-name">{def.title}</span>
          <button type="button" className="iconbtn" aria-label={`Move ${def.title} earlier`} disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp size={14} aria-hidden />
          </button>
          <button type="button" className="iconbtn" aria-label={`Move ${def.title} later`} disabled={last} onClick={() => onMove(1)}>
            <ArrowDown size={14} aria-hidden />
          </button>
          <button type="button" className="iconbtn" aria-label={`Hide ${def.title}`} onClick={onHide}>
            <EyeSlash size={14} aria-hidden />
          </button>
        </div>
      )}
      {children}
    </div>
  );
}

/* ---------- Status strip: one primary line, then the rest in tier order ---------- */

function StatusStrip({ items, mode, readiness, go }: { items: StatusItem[]; mode: 'offline' | 'online'; readiness: ReadinessLevel; go: Go }) {
  const [primary, ...rest] = items;
  return (
    <section className={cx('panel ph-status', `ph-status-${primary.tier}`)} aria-label="Status" data-status-tier={primary.tier}>
      <div className="ph-status-main">
        <span className="ph-status-dot" aria-hidden="true" />
        <div className="ph-status-text">
          <p className="eyebrow">{primary.tier === 'attention' ? 'Needs attention' : primary.tier === 'notice' ? 'Worth knowing' : 'Status'}</p>
          <h2 className="ph-status-title">{primary.title}</h2>
          <p className="ph-status-detail">{primary.detail}</p>
        </div>
        {primary.view && (
          <Button size="sm" icon={ArrowRight} onClick={() => go(primary.view!, primary.params)}>
            {primary.actionLabel ?? 'Open'}
          </Button>
        )}
      </div>
      <div className="ph-status-side">
        <ul className="ph-badges" aria-label="Mode and model">
          <li>
            <Badge tone={mode === 'online' ? 'warn' : 'ok'}>{mode === 'online' ? 'Online mode' : 'Offline mode'}</Badge>
          </li>
          <li>
            <Badge tone={readiness === 'ready' ? 'ok' : readiness === 'blocked' ? 'danger' : 'muted'}>{readiness === 'ready' ? 'Model ready' : readiness === 'blocked' ? 'Model blocked' : 'Model not checked'}</Badge>
          </li>
        </ul>
        {rest.length > 0 && (
          <ul className="ph-status-rest" aria-label="Other status items">
            {rest.map((s) => (
              <li key={s.id} className={`ph-tier-${s.tier}`}>
                {s.view ? (
                  <button type="button" className="ph-status-link" onClick={() => go(s.view!, s.params)}>
                    <span className="ph-status-mark" aria-hidden="true" />
                    {s.title}
                  </button>
                ) : (
                  <span>
                    <span className="ph-status-mark" aria-hidden="true" />
                    {s.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/* ---------- Quick capture: real saves through the same contract Tasks and Notes use ---------- */

function QuickCapture({ today, go }: { today: string; go: Go }) {
  const { api, mutate } = useReady();
  const [kind, setKind] = useState<'task' | 'note'>('task');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [due, setDue] = useState<CaptureDue>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const dueId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const trimmed = title.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed || savingRef.current) return;
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    const dueKeyValue = captureDueKey(due, today);
    const ok = await mutate(() => (kind === 'task' ? api.saveTask({ title: trimmed, done: false, ...(dueKeyValue ? { due: dueKeyValue } : {}) }) : api.saveNote({ title: trimmed, body: body.trim(), tags: [] })));
    savingRef.current = false;
    setBusy(false);
    if (!ok) {
      setError(kind === 'task' ? 'The task was not saved. Local storage did not accept it; see the message in the corner.' : 'The note was not saved. Local storage did not accept it; see the message in the corner.');
      return;
    }
    setSaved(kind === 'task' ? `Task “${truncate(trimmed, 40)}” saved${dueKeyValue ? `, due ${due}` : ''}.` : `Note “${truncate(trimmed, 40)}” saved.`);
    setTitle('');
    setBody('');
    setDue('none');
    titleRef.current?.focus();
  };

  return (
    <Panel
      title="Quick capture"
      eyebrow="Add without leaving"
      className="ph-capture"
      actions={
        <div className="ph-seg" role="radiogroup" aria-label="What to capture">
          <button type="button" role="radio" aria-checked={kind === 'task'} className={cx('chip', kind === 'task' && 'on')} disabled={busy} onClick={() => setKind('task')}>
            <CheckSquare size={13} aria-hidden /> Task
          </button>
          <button type="button" role="radio" aria-checked={kind === 'note'} className={cx('chip', kind === 'note' && 'on')} disabled={busy} onClick={() => setKind('note')}>
            <NoteIcon size={13} aria-hidden /> Note
          </button>
        </div>
      }
    >
      <form className="ph-capture-form" onSubmit={(e) => void submit(e)} aria-busy={busy}>
        <label htmlFor={titleId} className="ph-label">
          {kind === 'task' ? 'Task' : 'Note title'}
        </label>
        <input id={titleId} ref={titleRef} className="input" value={title} maxLength={200} placeholder={kind === 'task' ? 'What needs doing?' : 'A short title'} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        {kind === 'note' ? (
          <>
            <label htmlFor={bodyId} className="ph-label">
              Body <span className="sub">optional</span>
            </label>
            <textarea id={bodyId} className="input ph-capture-body" rows={3} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} disabled={busy} />
          </>
        ) : (
          <>
            <label htmlFor={dueId} className="ph-label">
              Due
            </label>
            <select id={dueId} className="input" value={due} onChange={(e) => setDue(e.target.value as CaptureDue)} disabled={busy}>
              <option value="none">No date</option>
              <option value="today">Today</option>
              <option value="tomorrow">Tomorrow</option>
            </select>
          </>
        )}
        <div className="ph-capture-row">
          <Button type="submit" variant="primary" icon={Plus} busy={busy} disabled={!trimmed || busy}>
            {kind === 'task' ? 'Add task' : 'Save note'}
          </Button>
          <Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go(kind === 'task' ? 'tasks' : 'notes')}>
            {kind === 'task' ? 'All tasks' : 'All notes'}
          </Button>
        </div>
        <p className="field-hint" role="status">
          {saved ?? (busy ? 'Saving on this computer…' : 'Saved on this computer only. Nothing is sent anywhere.')}
        </p>
        {error && (
          <Notice tone="danger" title="Not saved">
            {error}
          </Notice>
        )}
      </form>
    </Panel>
  );
}

/* ---------- File shelf: pinned files, folders and links; opening always goes through preview → Confirm → execute ---------- */

type ShelfEdit = { id: string; label: string; note: string; tags: string };
type ShelfPending = { item: shelfModel.ShelfItem; preview: ActionPreview };

function shelfRequest(item: shelfModel.ShelfItem): ActionRequest {
  return item.kind === 'url' ? { type: 'open-url', target: item.target } : { type: 'launch', target: item.target };
}

export function FileShelf() {
  const { api } = useReady();
  const [rawShelf, setRawShelf] = usePref<unknown>(shelfModel.SHELF_PREF_KEY, shelfModel.emptyShelf());
  const shelf = useMemo(() => shelfModel.normalizeShelf(rawShelf), [rawShelf]);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<ShelfEdit | null>(null);
  const [pending, setPending] = useState<ShelfPending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const queryId = useId();
  const typedId = useId();
  const preview = isPreviewBridge();
  const canPick = !preview && typeof api.pickPath === 'function';
  const canOpen = !preview && typeof api.previewAction === 'function' && typeof api.executeAction === 'function';
  const filtered = useMemo(() => shelfModel.filterShelf(shelf, query), [shelf, query]);
  const groups = useMemo(() => shelfModel.groupByKind(filtered), [filtered]);
  const recent = useMemo(() => shelfModel.recentItems(shelf, 8), [shelf]);

  const save = (next: shelfModel.Shelf) => setRawShelf(next);
  const report = (ok: string | null, err: string | null) => {
    setMessage(ok);
    setError(err);
  };

  const add = (kind: shelfModel.ShelfKind, target: string): boolean => {
    try {
      const r = shelfModel.addShelfItem(shelf, { kind, target });
      if (r.duplicate) {
        report(`“${truncate(r.item.label, 50)}” is already on the shelf.`, null);
      } else {
        save(r.shelf);
        report(`Added “${truncate(r.item.label, 50)}”.`, null);
      }
      return true;
    } catch (e) {
      report(null, e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const pick = async (kind: 'file' | 'folder') => {
    if (!canPick || busyRef.current) return;
    busyRef.current = true;
    setBusy(`pick-${kind}`);
    try {
      const chosen = await api.pickPath(kind);
      if (chosen) add(kind, chosen);
      else report('Nothing was chosen.', null);
    } catch (e) {
      report(null, `The ${kind} picker failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const addTyped = (e: FormEvent) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    if (add(shelfModel.guessKind(text), text)) setTyped('');
  };

  const startEdit = (item: shelfModel.ShelfItem) => setEdit({ id: item.id, label: item.label, note: item.note, tags: item.tags.join(', ') });
  const saveEdit = () => {
    if (!edit) return;
    try {
      save(shelfModel.updateShelfItem(shelf, edit.id, { label: edit.label, note: edit.note, tags: shelfModel.parseTagText(edit.tags) }));
      setEdit(null);
      report('Changes saved.', null);
    } catch (e) {
      report(null, e instanceof Error ? e.message : String(e));
    }
  };
  const editKeys = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEdit(null);
    }
  };

  const remove = (item: shelfModel.ShelfItem) => {
    try {
      save(shelfModel.removeShelfItem(shelf, item.id));
      if (pending?.item.id === item.id) setPending(null);
      if (edit?.id === item.id) setEdit(null);
      report(`Removed “${truncate(item.label, 50)}” from the shelf. The ${item.kind} itself was not touched.`, null);
    } catch (e) {
      report(null, e instanceof Error ? e.message : String(e));
    }
  };

  // Step 1: ask the backend for a preview. Nothing runs here.
  const requestOpen = async (item: shelfModel.ShelfItem) => {
    if (!canOpen || busyRef.current) return;
    busyRef.current = true;
    setBusy(item.id);
    setPending(null);
    report(null, null);
    try {
      const p = await api.previewAction(shelfRequest(item));
      setPending({ item, preview: p });
    } catch (e) {
      report(null, `Could not prepare “${truncate(item.label, 50)}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // Step 2: only after an explicit Confirm click on an allowed preview.
  const confirmOpen = async () => {
    if (!pending || !pending.preview.allowed || busyRef.current) return;
    const { item, preview: p } = pending;
    busyRef.current = true;
    setBusy(item.id);
    try {
      const outcome = actionOutcome(await api.executeAction(p.id, true), true);
      setPending(null);
      if (outcome.kind === 'ran') {
        save(shelfModel.recordOpened(shelf, item.id));
        report(`Opened “${truncate(item.label, 50)}”.`, null);
      } else {
        report(null, outcome.message ?? 'The item was not opened.');
      }
    } catch (e) {
      setPending(null);
      report(null, `“${truncate(item.label, 50)}” was not opened: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const cancelOpen = () => {
    setPending(null);
    report('Cancelled. Nothing was opened.', null);
  };

  const unavailable = preview ? 'Unavailable in browser preview (no Electron backend).' : 'Unavailable: this bridge does not provide it.';

  const renderItem = (item: shelfModel.ShelfItem) => {
    const editing = edit?.id === item.id;
    const isPending = pending?.item.id === item.id;
    return (
      <li key={item.id} className={cx('file-shelf-item', isPending && 'is-pending')} data-shelf-item={item.id}>
        {editing && edit ? (
          <div className="file-shelf-edit" role="group" aria-label={`Edit ${item.label}`}>
            <label className="ph-label">
              Label
              <input className="input" value={edit.label} maxLength={shelfModel.SHELF_LIMITS.label} autoFocus onChange={(e) => setEdit({ ...edit, label: e.target.value })} onKeyDown={editKeys} />
            </label>
            <label className="ph-label">
              Note
              <input className="input" value={edit.note} maxLength={shelfModel.SHELF_LIMITS.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} onKeyDown={editKeys} />
            </label>
            <label className="ph-label">
              Tags <span className="sub">comma separated</span>
              <input className="input" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} onKeyDown={editKeys} />
            </label>
            <div className="file-shelf-row">
              <Button size="sm" variant="primary" onClick={saveEdit}>
                Save
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <span className="field-hint">Enter saves, Escape cancels.</span>
            </div>
          </div>
        ) : (
          <div className="file-shelf-main">
            <span className="file-shelf-text">
              <strong>{item.label}</strong>
              <span className="sub file-shelf-target" title={item.target}>
                {item.target}
              </span>
              {item.note && <span className="sub">{item.note}</span>}
              {item.tags.length > 0 && <span className="sub">{item.tags.map((t) => `#${t}`).join(' ')}</span>}
            </span>
            <span className="file-shelf-actions">
              <Button size="sm" disabled={!canOpen || busy !== null} busy={busy === item.id} aria-label={`Open ${item.label}`} onClick={() => void requestOpen(item)}>
                Open
              </Button>
              <Button size="sm" variant="quiet" aria-label={`Edit ${item.label}`} onClick={() => startEdit(item)}>
                Edit
              </Button>
              <Button size="sm" variant="quiet" aria-label={`Remove ${item.label}`} onClick={() => remove(item)}>
                Remove
              </Button>
            </span>
          </div>
        )}
        {isPending && pending && (
          <div className="file-shelf-confirm" role="alertdialog" aria-label={`Confirm opening ${item.label}`}>
            <p>
              <strong>{pending.preview.summary}</strong>
            </p>
            {pending.preview.reason && <p className="field-hint">{pending.preview.reason}</p>}
            {pending.preview.allowed ? (
              <div className="file-shelf-row">
                <Button size="sm" variant="primary" autoFocus busy={busy === item.id} disabled={busy !== null} onClick={() => void confirmOpen()}>
                  Confirm
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null} onClick={cancelOpen}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="file-shelf-row">
                <span className="field-hint">Not allowed{pending.preview.reason ? '' : ' by the app’s safety rules'}. Nothing was opened.</span>
                <Button size="sm" variant="quiet" onClick={() => setPending(null)}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <Panel title="File shelf" eyebrow="Pinned files, folders and links" className="file-shelf">
      <div className="file-shelf-add">
        <div className="file-shelf-row">
          <Button size="sm" icon={Plus} disabled={!canPick || busy !== null} busy={busy === 'pick-file'} onClick={() => void pick('file')}>
            Add file…
          </Button>
          <Button size="sm" icon={Plus} disabled={!canPick || busy !== null} busy={busy === 'pick-folder'} onClick={() => void pick('folder')}>
            Add folder…
          </Button>
          {!canPick && <span className="field-hint">File and folder pickers: {unavailable}</span>}
        </div>
        <form className="file-shelf-row" onSubmit={addTyped}>
          <label htmlFor={typedId} className="ph-label">
            Path or link
          </label>
          <input id={typedId} className="input grow" value={typed} maxLength={shelfModel.SHELF_LIMITS.target} placeholder={'C:\\Projects\\notes.txt or https://example.com'} onChange={(e) => setTyped(e.target.value)} />
          <Button size="sm" type="submit" disabled={!typed.trim()}>
            Add
          </Button>
        </form>
      </div>
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
      {error && (
        <Notice tone="danger" title="File shelf">
          {error}
        </Notice>
      )}
      {!canOpen && <p className="field-hint">Open: {unavailable}</p>}
      {recent.length > 0 && (
        <section className="file-shelf-recent" aria-label="Recently opened">
          <h3 className="widget-name">Recently opened</h3>
          <ul className="chips">
            {recent.map((r) => (
              <li key={r.id}>
                <button type="button" className="chip" disabled={!canOpen || busy !== null} onClick={() => void requestOpen(r)} title={r.target}>
                  {truncate(r.label, 30)}
                  {r.lastOpenedAt && <span className="sub"> · {relTime(r.lastOpenedAt)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {shelf.items.length === 0 ? (
        <Empty title="The shelf is empty">Pin files, folders or http(s) links you return to often. Opening one always asks you to confirm first.</Empty>
      ) : (
        <>
          <label htmlFor={queryId} className="ph-label">
            Search the shelf
          </label>
          <input id={queryId} type="search" className="input" value={query} placeholder="Label, path, tag…" onChange={(e) => setQuery(e.target.value)} />
          {groups.length === 0 && <p className="field-hint">No shelf items match “{truncate(query, 40)}”.</p>}
          {groups.map((g) => (
            <section key={g.kind} className="file-shelf-group" aria-label={g.title}>
              <h3 className="widget-name">
                {g.title} <span className="sub">{g.items.length}</span>
              </h3>
              <ul className="file-shelf-list">{g.items.map(renderItem)}</ul>
            </section>
          ))}
          <p className="field-hint">
            {shelf.items.length} of {shelfModel.SHELF_LIMITS.items} items. Kept in this window’s preferences; the files themselves are never read or changed by the shelf.
          </p>
        </>
      )}
    </Panel>
  );
}

/* ---------- Dashboard summaries (saved layout, picker, read-only data) ---------- */

/**
 * Summary cards placed on the same 12-column grid that the picker previews. The layout is read from
 * the saved preference on every render and validated there; a saved value that does not pass is shown
 * as the default and the reason is reported above the grid. Card text comes from summarizeWidget, so a
 * source that has not loaded shows as 'Not loaded' instead of a made-up number.
 * `startEditing` only sets the first render; Home leaves the picker closed until the user opens it.
 */
export function DashboardWidgets({ source, startEditing = false }: { source: dashboard.WidgetSource; startEditing?: boolean }) {
  const [stored, setStored] = usePref<unknown>(dashboard.LAYOUT_PREF_KEY, null);
  const [editing, setEditing] = useState(startEditing);
  const pickerId = useId();
  const { layout, issues } = typeof stored === 'string' ? dashboard.parseLayout(stored) : dashboard.normalizeLayout(stored);
  const { items } = dashboard.packLayout(layout);
  const isDefault = dashboard.serializeLayout(layout) === dashboard.serializeLayout(dashboard.defaultLayout());
  const save = (next: dashboard.WidgetLayout) => setStored(dashboard.serializeLayout(next));

  return (
    <>
      <Panel
        title="At a glance"
        eyebrow="Dashboard widgets"
        actions={
          <Button size="sm" variant="quiet" icon={SquaresFour} aria-expanded={editing} aria-controls={editing ? pickerId : undefined} onClick={() => setEditing((open) => !open)}>
            {editing ? 'Done with widgets' : 'Choose widgets'}
          </Button>
        }
      >
        {issues.length > 0 && (
          <Notice tone="warn" title="Saved widget layout was adjusted">
            {issues.join(' ')}
          </Notice>
        )}
        {items.length === 0 ? (
          <Empty icon={SquaresFour} title="No widgets are shown">
            Choose widgets to see summaries of your saved tasks, notes and capsules here.
          </Empty>
        ) : (
          <div className="dash-wrap">
          <div className="dash-grid">
            {items.map((item) => {
              const def = dashboard.widgetDef(item.kind);
              if (!def) return null;
              const summary = dashboard.summarizeWidget(item.kind, source);
              const titleId = `${pickerId}-${item.kind}`;
              return (
                <section
                  key={item.kind}
                  className="panel dash-card"
                  data-dash-widget={item.kind}
                  aria-labelledby={titleId}
                  style={dashboard.widgetPlacement(item) as CSSProperties}
                >
                  <h3 id={titleId} className="widget-name">
                    {def.name}
                  </h3>
                  <p className="big-line">{summary.value}</p>
                  <p className="field-hint">{summary.detail}</p>
                </section>
              );
            })}
          </div>
          </div>
        )}
        <p className="field-hint">
          {isDefault
            ? 'Showing the default layout: every widget, in its standard order and width.'
            : 'Showing a customised layout. Choose widgets to change it or to go back to the default.'}
        </p>
      </Panel>
      {editing && (
        <div id={pickerId}>
          <WidgetPicker layout={layout} onLayoutChange={save} onClose={() => setEditing(false)} />
        </div>
      )}
    </>
  );
}

export function Home({ go }: { go: Go }) {
  const { state, settings, system, systemError, systemLoading, cloudConfigured, api, mutate } = useReady();
  const check = useModelCheck();
  const { state: avatarState } = useCompanion();
  const [rawLayout, setRawLayout] = useShellPref<unknown>(SHELL_PREF.homeLayout, DEFAULT_LAYOUT);
  const [displayName] = useShellPref<string>(SHELL_PREF.displayName, '');
  const layout = useMemo(() => normalizeLayout(rawLayout), [rawLayout]);
  const [arranging, setArranging] = useState(false);
  // The calendar day is read once per mount and refreshed when the window comes back; it is never computed inside the pure helpers.
  const [today, setToday] = useState(() => localDateKey());
  useEffect(() => {
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setToday(localDateKey());
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const online = settings.mode === 'online';
  // Readiness comes from the backend's live check (local) or the saved key (online), not from whether fields are filled in.
  const readiness = modelReadiness({ settings, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });
  const cockpit: CockpitInput = useMemo(
    () => ({
      tasks: state.tasks,
      notes: state.notes,
      capsules: state.capsules,
      chat: state.chat,
      activity: state.activity,
      capabilities: system?.capabilities ?? null,
      systemError,
      systemLoading,
      readiness: readiness.level,
      mode: online ? 'online' : 'offline',
      today,
    }),
    [state.tasks, state.notes, state.capsules, state.chat, state.activity, system, systemError, systemLoading, readiness.level, online, today],
  );
  const triage = useMemo(() => triageTasks(state.tasks, today), [state.tasks, today]);
  const status = useMemo(() => statusHierarchy(cockpit), [cockpit]);
  const actions = useMemo(() => quickActions(cockpit), [cockpit]);
  const activityGroups = useMemo(() => groupActivity(state.activity, today), [state.activity, today]);
  const caps = capabilityView(system?.capabilities ?? null, systemError, systemLoading);
  const urgent = useMemo(() => [...triage.overdue, ...triage.today, ...triage.week].slice(0, 6), [triage]);
  const capsules = useMemo(() => [...state.capsules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4), [state.capsules]);
  const notes = useMemo(() => [...state.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4), [state.notes]);
  const lastChat = state.chat[state.chat.length - 1];
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const completingRef = useRef(false);
  const completeTask = async (t: Task) => {
    if (completingRef.current) return;
    completingRef.current = true;
    setPendingTask(t.id);
    setTaskError(null);
    const ok = await mutate(() => api.saveTask({ id: t.id, done: true }));
    completingRef.current = false;
    setPendingTask(null);
    if (!ok) setTaskError(`“${truncate(t.title, 50)}” was not marked done. Try again from Tasks.`);
  };
  // Only data the app already holds. A null capability list (no successful system check) reads as 'Not loaded'.
  const dashboardSource: dashboard.WidgetSource = {
    settings,
    tasks: state.tasks,
    notes: state.notes,
    capsules: state.capsules,
    activity: state.activity,
    capabilities: system?.capabilities ?? null,
  };

  const visible = layout.order.filter((id) => !layout.hidden.includes(id));
  const hiddenDefs = WIDGETS.filter((w) => layout.hidden.includes(w.id));

  const render = (id: WidgetId): ReactNode => {
    switch (id) {
      case 'status':
        return <StatusStrip items={status} mode={online ? 'online' : 'offline'} readiness={readiness.level} go={go} />;
      case 'capture':
        return <QuickCapture today={today} go={go} />;
      case 'actions':
        return (
          <Panel title="Quick actions" eyebrow="Open a screen" className="ph-actions">
            <ul className="ph-action-list">
              {actions.map((a) => (
                <li key={a.id}>
                  <button type="button" className="ph-action" data-action={a.id} onClick={() => go(a.view, a.params)}>
                    <Lightning size={16} weight="duotone" aria-hidden />
                    <span className="ph-action-text">
                      <strong>{a.label}</strong>
                      <span className="sub">{a.hint}</span>
                    </span>
                    <ArrowRight size={14} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <p className="field-hint">Each shortcut opens a screen. Nothing is sent or run until you act there.</p>
          </Panel>
        );
      case 'totals':
        return (
          <section className="stat-row" aria-label="Totals">
            <button className="stat" onClick={() => go('capsules')}>
              <span className="stat-n">{state.capsules.length}</span>
              <span className="stat-l">Capsules</span>
            </button>
            <button className="stat" onClick={() => go('notes')}>
              <span className="stat-n">{state.notes.length}</span>
              <span className="stat-l">Notes</span>
            </button>
            <button className={`stat ${triage.overdue.length ? 'warn' : ''}`} onClick={() => go('tasks')}>
              <span className="stat-n">{triage.open}</span>
              <span className="stat-l">Open tasks{triage.overdue.length ? ` · ${triage.overdue.length} overdue` : ''}</span>
            </button>
            <button className="stat" onClick={() => go('assistant')}>
              <span className="stat-n">{state.chat.length}</span>
              <span className="stat-l">Chat messages</span>
            </button>
          </section>
        );
      case 'readiness':
        if (readiness.level === 'ready' && !arranging) return null;
        return readiness.level === 'ready' ? (
          <Notice title={readiness.title}>{readiness.detail}</Notice>
        ) : (
          <ModelReadinessNotice readiness={readiness} checking={check.checking} onRecheck={() => void check.recheck()} action={<Button size="sm" onClick={() => go('settings', { q: 'model' })}>Open Settings</Button>} />
        );
      case 'due':
        return (
          <Panel title="Due now" eyebrow="Tasks" className="ph-due" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('tasks')}>All tasks</Button>}>
            {taskError && (
              <Notice tone="danger" title="Not updated">
                {taskError}
              </Notice>
            )}
            {urgent.length === 0 ? (
              <Empty icon={CheckSquare} title={triage.open ? 'Nothing due this week' : 'No open tasks'} action={triage.open ? undefined : <Button size="sm" onClick={() => go('tasks')}>Add a task</Button>}>
                {triage.open ? `${triage.open} open ${triage.open === 1 ? 'task' : 'tasks'}${triage.undated.length ? `, ${triage.undated.length} without a date` : ''}.` : 'Tasks with due dates show up here, overdue first.'}
              </Empty>
            ) : (
              <>
                <ul className="list">
                  {urgent.map((t) => {
                    const b = dueBucket(t, today);
                    return (
                      <li key={t.id} className={cx('list-row', pendingTask === t.id && 'is-pending')}>
                        <input type="checkbox" className="check" aria-label={`Mark “${t.title}” done`} checked={t.done} disabled={pendingTask !== null} onChange={() => void completeTask(t)} />
                        <span className="grow">{t.title}</span>
                        <Badge tone={b === 'overdue' ? 'danger' : b === 'today' ? 'warn' : 'muted'}>{dueLabel(t, today)}</Badge>
                      </li>
                    );
                  })}
                </ul>
                {triage.overdue.length + triage.today.length + triage.week.length > urgent.length && (
                  <p className="field-hint">{triage.overdue.length + triage.today.length + triage.week.length - urgent.length} more due this week in Tasks.</p>
                )}
              </>
            )}
          </Panel>
        );
      case 'capsules':
        return (
          <Panel title="Recent capsules" eyebrow="Workspaces" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('capsules')}>Open</Button>}>
            {capsules.length === 0 ? (
              <Empty icon={Cube} title="No capsules yet" action={<Button size="sm" onClick={() => go('capsules')}>Create one</Button>}>
                A capsule bundles files, folders, apps and URLs for one project so you can reopen them together.
              </Empty>
            ) : (
              <ul className="list">
                {capsules.map((c) => (
                  <li key={c.id} className="list-row">
                    <Cube size={16} aria-hidden />
                    <button type="button" className="grow list-link" onClick={() => go('capsules', { item: c.id })}>
                      <strong>{c.name}</strong>
                      <span className="sub">
                        {c.items.length} item{c.items.length === 1 ? '' : 's'} · {sceneName(c.scene)} · {relTime(c.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      case 'notes':
        return (
          <Panel title="Recent notes" eyebrow="Memory" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('notes')}>Open</Button>}>
            {notes.length === 0 ? (
              <Empty icon={NoteIcon} title="No notes yet" action={<Button size="sm" onClick={() => go('notes')}>Write one</Button>}>
                Notes are stored on this computer and searchable by text and tag.
              </Empty>
            ) : (
              <ul className="list">
                {notes.map((n) => (
                  <li key={n.id} className="list-row">
                    <button type="button" className="grow list-link" onClick={() => go('notes', { item: n.id })}>
                      <strong>{n.title || 'Untitled'}</strong>
                      <span className="sub">{truncate(n.body.replace(/\s+/g, ' '), 90) || 'Empty note'}</span>
                    </button>
                    <span className="sub">{relTime(n.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      case 'search':
        return (
          <Panel title="Memory search" eyebrow="Saved items" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('search')}>Full search</Button>}>
            <MemorySearch state={state} limit={5} onNavigate={(r) => go(VIEW_FOR_CATEGORY[r.category], { item: r.id })} />
          </Panel>
        );
      case 'companion':
        return (
          <Panel title="Companion" eyebrow="Live state" className="panel-companion">
            <div className="companion-mini">
              <Avatar state={avatarState} size={120} />
              <div className="stack tight">
                <Badge tone={online ? 'warn' : 'ok'}>{online ? 'Online mode' : 'Offline mode'}</Badge>
                <Badge tone={readiness.level === 'ready' ? 'ok' : readiness.level === 'blocked' ? 'warn' : 'muted'}>{readiness.level === 'ready' ? 'Model ready' : readiness.level === 'blocked' ? 'Model not ready' : 'Model not checked'}</Badge>
                <p className="field-hint">
                  {online ? `Cloud model: ${settings.cloudModel || 'not set'}. Key ${cloudConfigured ? 'saved' : cloudConfigured === false ? 'missing' : 'status unknown'}.` : `Local model: ${settings.localModel || 'not set'}.`}
                </p>
                {lastChat ? (
                  <p className="quote">
                    <span className="sub">Last message · {lastChat.role} · {relTime(lastChat.createdAt)}</span>
                    {truncate(lastChat.text, 140)}
                  </p>
                ) : (
                  <p className="field-hint">No chat yet. The companion is {avatarState}.</p>
                )}
              </div>
            </div>
          </Panel>
        );
      case 'capabilities':
        return (
          <Panel title="Capabilities" eyebrow="Checked by this app" actions={<Button size="sm" variant="quiet" icon={ArrowRight} onClick={() => go('status')}>Details</Button>}>
            {caps.status === 'error' && <Notice tone="warn" title="The system check failed">{systemError}</Notice>}
            {caps.status === 'loading' && <p className="field-hint" role="status">Checking what this computer supports…</p>}
            {caps.status === 'unloaded' && (
              <Empty icon={WarningCircle} title="Not checked yet" action={<Button size="sm" onClick={() => go('status')}>Open Status</Button>}>
                The system check has not answered, so nothing is assumed about this computer.
              </Empty>
            )}
            {caps.status === 'loaded' && (
              <>
                <p className="big-line">
                  {caps.available}
                  <span> of {caps.total} available</span>
                </p>
                {caps.unavailable.length > 0 ? (
                  <ul className="list compact">
                    {caps.unavailable.slice(0, 4).map((c) => (
                      <li key={c.id} className="list-row">
                        <WarningCircle size={15} aria-hidden />
                        <span className="grow">
                          {c.name}
                          {c.reason && <span className="sub">{truncate(c.reason, 90)}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="field-hint">Everything the app checks for is available here.</p>
                )}
              </>
            )}
          </Panel>
        );
      case 'activity':
        return (
          <Panel title="Recent activity" eyebrow="Audit trail" className="ph-activity">
            {activityGroups.length === 0 ? (
              <Empty title="No activity recorded">Writes and approved actions appear here as they happen. Nothing is recorded in the background.</Empty>
            ) : (
              activityGroups.map((g) => (
                <section key={g.label} className="ph-activity-group" aria-label={g.label}>
                  <h3 className="ph-activity-day">{g.label}</h3>
                  <ol className="timeline">
                    {g.items.map((a) => (
                      <li key={a.id}>
                        <span className="tl-kind">{kindLabel(a.kind)}</span>
                        <span>{truncate(a.summary, 120)}</span>
                        <time dateTime={a.at}>{relTime(a.at)}</time>
                      </li>
                    ))}
                  </ol>
                </section>
              ))
            )}
          </Panel>
        );
      default:
        return null;
    }
  };

  return (
    <div className="page ph-home">
      <PageHeader
        eyebrow="Cockpit"
        title={greeting(new Date().getHours(), displayName)}
        subtitle="What is saved on this computer right now."
        actions={
          <>
            <Button icon={ChatCircleDots} variant="primary" onClick={() => go('assistant')}>
              Ask the assistant
            </Button>
            <Button icon={Plus} onClick={() => go('notes')}>
              New note
            </Button>
            <Button icon={SquaresFour} aria-pressed={arranging} onClick={() => setArranging((a) => !a)}>
              {arranging ? 'Done arranging' : 'Arrange'}
            </Button>
          </>
        }
      />

      {arranging && (
        <Notice
          title="Arrange the dashboard"
          action={
            <Button size="sm" icon={ArrowsClockwise} disabled={layoutIsDefault(layout)} onClick={() => setRawLayout(DEFAULT_LAYOUT)}>
              Reset layout
            </Button>
          }
        >
          Move panels earlier or later, or hide the ones you do not need. Changes show immediately and are kept in this window’s preferences.
          {hiddenDefs.length > 0 && (
            <ul className="chips" aria-label="Hidden panels">
              {hiddenDefs.map((w) => (
                <li key={w.id}>
                  <button type="button" className="chip off" onClick={() => setRawLayout(setWidgetHidden(layout, w.id, false))} aria-label={`Show ${w.title}`}>
                    <Plus size={12} aria-hidden /> {w.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      <DashboardWidgets source={dashboardSource} />

      <div className={cx('home-widgets', arranging && 'is-arranging')}>
        {visible.map((id, i) => {
          const def = WIDGETS.find((w) => w.id === id)!;
          const body = render(id);
          if (body === null) return null;
          return (
            <WidgetFrame key={id} def={def} arranging={arranging} first={i === 0} last={i === visible.length - 1} onMove={(d) => setRawLayout(moveWidget(layout, id, d))} onHide={() => setRawLayout(setWidgetHidden(layout, id, true))}>
              {body}
            </WidgetFrame>
          );
        })}
        {visible.length === 0 && (
          <div className="widget widget-full">
            <Empty icon={SquaresFour} title="Every panel is hidden" action={<Button onClick={() => setRawLayout(DEFAULT_LAYOUT)}>Reset layout</Button>}>
              Use Arrange to bring panels back.
            </Empty>
          </div>
        )}
      </div>

      <FileShelf />
    </div>
  );
}
