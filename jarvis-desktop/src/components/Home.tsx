import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChatCircleDots, CheckSquare, Cube, Note as NoteIcon, NotePencil, Plus } from '@phosphor-icons/react';
import type { Activity, Capability, Capsule, ChatMessage, Note, Task } from '../shared/contracts';
import { CompanionOrb } from './CompanionOrb';
import { SHELL_PREF, useShellPref } from './Settings';
import { Button, Spinner } from '../ui/primitives';
import { useReady } from '../ui/store';
import { useCompanion } from '../ui/companion';
import { stateLabel } from '../ui/appearance';
import { type ViewId } from '../ui/nav';
import { cx, dueBucket, dueKey, fmtDueKey, localDateKey, relTime, truncate } from '../ui/util';
import { modelReadiness, useModelCheck } from './Onboarding';
import '../styles/today.css';

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

/* ---------- Today ---------- */

type Go = (v: ViewId, params?: Record<string, string>) => void;
type StartKind = 'note' | 'task' | 'ask';

/** Saved items for Continue and Recent, newest first. Built only from stored records. */
export type RecentItem = { key: string; kind: 'note' | 'capsule' | 'chat'; title: string; detail: string; at: string; when: string; view: ViewId; params?: Record<string, string> };

export function recentItems(input: { notes: Note[]; capsules: Capsule[]; chat: ChatMessage[] }, now?: number): RecentItem[] {
  const when = (iso: string) => (now === undefined ? relTime(iso) : relTime(iso, now));
  const items: RecentItem[] = [
    ...input.notes.map((n): RecentItem => ({ key: `n-${n.id}`, kind: 'note', title: n.title || 'Untitled note', detail: truncate(n.body.replace(/\s+/g, ' ').trim(), 110) || 'Empty note', at: n.updatedAt, when: when(n.updatedAt), view: 'notes', params: { item: n.id } })),
    ...input.capsules.map((c): RecentItem => ({ key: `c-${c.id}`, kind: 'capsule', title: c.name || 'Untitled setup', detail: c.description || `${c.items.length} ${c.items.length === 1 ? 'item' : 'items'}`, at: c.updatedAt, when: when(c.updatedAt), view: 'capsules', params: { item: c.id } })),
  ];
  const last = input.chat[input.chat.length - 1];
  if (last) items.push({ key: `m-${last.id}`, kind: 'chat', title: 'Conversation', detail: truncate(last.text.replace(/\s+/g, ' '), 110), at: last.createdAt, when: when(last.createdAt), view: 'assistant' });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The reason only; the full setup guidance lives in the AI setup flow. */
export const firstSentence = (s: string): string => (/^[\s\S]*?[.!?](?=\s|$)/.exec(s.trim())?.[0] ?? s).trim();

const KIND_ICON = { note: NoteIcon, capsule: Cube, chat: ChatCircleDots } as const;
const KIND_NAME = { note: 'Note', capsule: 'Setup', chat: 'Assistant' } as const;

function todayLine(today: string, dueToday: number, overdue: number): string {
  const d = new Date(`${today}T12:00:00`);
  const date = Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  const parts: string[] = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (dueToday) parts.push(`${dueToday} due today`);
  return [date, parts.length ? parts.join(', ') : null].filter(Boolean).join(' · ');
}

/** One start bar: write a note, add a task, or hand a question to the Assistant. Saves only after a real write. */
function StartBar({ today, go }: { today: string; go: Go }) {
  const { api, mutate, state } = useReady();
  const [kind, setKind] = useState<StartKind>('note');
  const [text, setText] = useState('');
  const [due, setDue] = useState<CaptureDue>('none');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ text: string; view: ViewId; params?: Record<string, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const dueId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const value = text.trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value || savingRef.current) return;
    if (kind === 'ask') {
      go('assistant', { draft: value.slice(0, 200) });
      return;
    }
    savingRef.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    const dueValue = captureDueKey(due, today);
    const before = new Set((kind === 'note' ? state.notes : state.tasks).map((x) => x.id));
    const ok = await mutate(() => (kind === 'task' ? api.saveTask({ title: value, done: false, ...(dueValue ? { due: dueValue } : {}) }) : api.saveNote({ title: value, body: '', tags: [] })));
    savingRef.current = false;
    setBusy(false);
    if (!ok) {
      setError(kind === 'task' ? 'The task was not saved. Nothing was changed; try again.' : 'The note was not saved. Nothing was changed; try again.');
      return;
    }
    const fresh = await api.getState().catch(() => null);
    const created = fresh ? (kind === 'note' ? fresh.notes : fresh.tasks).find((x) => !before.has(x.id)) : undefined;
    setSaved(kind === 'task' ? { text: `Task “${truncate(value, 48)}” saved${dueValue ? `, due ${due}` : ''}.`, view: 'tasks' } : { text: `Note “${truncate(value, 48)}” saved.`, view: 'notes', params: created ? { item: created.id } : undefined });
    setText('');
    setDue('none');
    inputRef.current?.focus();
  };

  const placeholder = kind === 'note' ? 'Write a note title, for example “Ideas for the review”' : kind === 'task' ? 'What needs doing? For example “Call the bank”' : 'Ask anything. It opens in the Assistant; nothing is sent yet.';
  const label = kind === 'note' ? 'New note title' : kind === 'task' ? 'New task' : 'Question for the assistant';
  return (
    <form className="start" onSubmit={(e) => void submit(e)} aria-busy={busy} aria-label="Start something">
      <div className="start-kinds" role="radiogroup" aria-label="What to start">
        {(
          [
            ['note', 'Note', NotePencil],
            ['task', 'Task', CheckSquare],
            ['ask', 'Ask', ChatCircleDots],
          ] as const
        ).map(([k, name, Icon]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={cx('start-kind', kind === k && 'on')}
            onClick={() => {
              setKind(k);
              inputRef.current?.focus();
            }}
          >
            <Icon size={16} weight={kind === k ? 'fill' : 'regular'} aria-hidden />
            {name}
          </button>
        ))}
      </div>
      <div className="start-row">
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <input id={inputId} ref={inputRef} className="start-input" value={text} maxLength={200} placeholder={placeholder} onChange={(e) => setText(e.target.value)} disabled={busy} autoComplete="off" />
        {kind === 'task' && (
          <>
            <label htmlFor={dueId} className="sr-only">
              Due
            </label>
            <select id={dueId} className="input start-due" value={due} onChange={(e) => setDue(e.target.value as CaptureDue)} disabled={busy}>
              <option value="none">No date</option>
              <option value="today">Today</option>
              <option value="tomorrow">Tomorrow</option>
            </select>
          </>
        )}
        <Button type="submit" variant="primary" icon={kind === 'ask' ? ArrowRight : Plus} busy={busy} disabled={!value || busy}>
          {kind === 'note' ? 'Save note' : kind === 'task' ? 'Add task' : 'Open in Assistant'}
        </Button>
      </div>
      <p className={cx('start-status', saved && 'ok', error && 'bad')} role="status">
        {error ? (
          error
        ) : saved ? (
          <>
            {saved.text}{' '}
            <button type="button" className="linkbtn" onClick={() => go(saved.view, saved.params)}>
              Open it
            </button>
          </>
        ) : busy ? (
          'Saving on this computer…'
        ) : (
          'Saved on this computer only. Nothing is sent anywhere.'
        )}
      </p>
    </form>
  );
}

export function Home({ go }: { go: Go }) {
  const { state, settings, system, systemError, cloudConfigured, api, mutate } = useReady();
  const check = useModelCheck();
  const { state: companionState } = useCompanion();
  const [displayName] = useShellPref<string>(SHELL_PREF.displayName, '');
  // The calendar day is read once per mount and refreshed when the window comes back; it is never computed inside the pure helpers.
  const [today, setToday] = useState(() => localDateKey());
  const [hour, setHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const refresh = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setToday(localDateKey());
      setHour(new Date().getHours());
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const online = settings.mode === 'online';
  const readiness = modelReadiness({ settings, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });
  const triage = useMemo(() => triageTasks(state.tasks, today), [state.tasks, today]);
  const upcoming = useMemo(() => [...triage.overdue, ...triage.today, ...triage.week, ...triage.later, ...triage.undated].slice(0, 5), [triage]);
  const recent = useMemo(() => recentItems(state), [state]);
  const [first, ...more] = recent;
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

  const FirstIcon = first ? KIND_ICON[first.kind] : NoteIcon;
  return (
    <div className="page today">
      <header className="today-hero">
        <div className="today-hello">
          <h1 className="display">{greeting(hour, displayName.trim())}</h1>
          <p className="today-line">{todayLine(today, triage.today.length, triage.overdue.length)}</p>
        </div>
        <div className="today-companion" aria-live="polite">
          <CompanionOrb size={112} />
          <span className="sub">{stateLabel(companionState)}</span>
        </div>
      </header>

      <StartBar today={today} go={go} />

      {readiness.level !== 'ready' && (
        <section className={cx('today-ai', readiness.level === 'blocked' ? 'is-blocked' : 'is-unknown')} aria-label="Assistant readiness">
          <span className={cx('dot', readiness.level === 'blocked' ? 'dot-warn' : '')} aria-hidden />
          <div className="grow">
            <strong>{readiness.title}</strong>
            <p className="field-hint">{firstSentence(readiness.detail)} Notes, tasks and search keep working without it.</p>
          </div>
          <Button size="sm" variant="primary" onClick={() => go('assistant', { setup: '1' })}>
            {online ? 'Fix online setup' : 'Set up AI'}
          </Button>
          <Button size="sm" variant="quiet" busy={check.checking} onClick={() => void check.recheck()}>
            Check again
          </Button>
        </section>
      )}

      <div className="today-grid">
        <section className="today-col" aria-labelledby="today-continue">
          <h2 id="today-continue">Continue</h2>
          {first ? (
            <button type="button" className="today-continue" onClick={() => go(first.view, first.params)}>
              <span className="today-continue-icon" aria-hidden="true">
                <FirstIcon size={20} />
              </span>
              <span className="grow">
                <span className="sub">
                  {KIND_NAME[first.kind]} · {first.when}
                </span>
                <strong>{first.title}</strong>
                <span className="today-continue-detail">{first.detail}</span>
              </span>
              <ArrowRight size={18} aria-hidden />
            </button>
          ) : (
            <div className="today-empty">
              <p>
                <strong>Nothing to continue yet.</strong> Write a note or add a task above and it appears here.
              </p>
            </div>
          )}
          {more.length > 0 && (
            <>
              <h3 className="today-sub">Recently saved</h3>
              <ul className="today-list">
                {more.slice(0, 4).map((r) => {
                  const Icon = KIND_ICON[r.kind];
                  return (
                    <li key={r.key}>
                      <button type="button" className="today-row" onClick={() => go(r.view, r.params)}>
                        <Icon size={18} aria-hidden />
                        <span className="grow">
                          <strong>{r.title}</strong>
                          <span className="sub">{r.detail}</span>
                        </span>
                        <span className="sub today-when">{r.when}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>

        <section className="today-col" aria-labelledby="today-up">
          <div className="section-head">
            <h2 id="today-up">Up next</h2>
            {triage.open > 0 && (
              <button type="button" className="linkbtn" onClick={() => go('tasks')}>
                All {triage.open} open
              </button>
            )}
          </div>
          {upcoming.length === 0 ? (
            <div className="today-empty">
              <p>
                <strong>{triage.done > 0 ? 'Everything is done.' : 'No tasks yet.'}</strong> Choose Task above to add one with a due date.
              </p>
            </div>
          ) : (
            <ul className="today-list">
              {upcoming.map((t) => {
                const bucket = dueBucket(t, today);
                return (
                  <li key={t.id} className="today-task">
                    <input
                      type="checkbox"
                      className="check"
                      checked={false}
                      disabled={pendingTask !== null}
                      aria-label={`Mark “${truncate(t.title, 60)}” done`}
                      onChange={() => void completeTask(t)}
                    />
                    <button type="button" className="today-task-title" onClick={() => go('tasks')}>
                      {t.title}
                    </button>
                    {pendingTask === t.id ? <Spinner /> : <span className={cx('today-due', bucket === 'overdue' && 'is-overdue', bucket === 'today' && 'is-today')}>{dueLabel(t, today)}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {taskError && (
            <p className="field-error" role="alert">
              {taskError}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
