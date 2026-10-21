import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChatCircleDots, CheckSquare, Cube, Note as NoteIcon, NotePencil, Plus } from '@phosphor-icons/react';
import type { Capsule, ChatMessage, Note, Task } from '../shared/contracts';
import { CompanionPet } from './CompanionPet';
import { SHELL_PREF, useShellPref } from './Settings';
import { Button, Spinner } from '../ui/primitives';
import { useReady } from '../ui/store';
import { type ViewId } from '../ui/nav';
import { cx, dueBucket, dueKey, fmtDueKey, localDateKey, relTime, truncate } from '../ui/util';
import { modelReadiness, useModelCheck } from './Onboarding';
import '../styles/today.css';

/* ---------- Pure model (tested): reads saved data and takes the day as a parameter ---------- */

/** Time-of-day greeting; the name is optional and already normalised by Settings. */
export function greeting(hour: number, name: string): string {
  const part = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}.` : `${part}.`;
}

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
    ...input.capsules.map((c): RecentItem => ({ key: `c-${c.id}`, kind: 'capsule', title: c.name || 'Untitled capsule', detail: c.description || `${c.items.length} ${c.items.length === 1 ? 'item' : 'items'}`, at: c.updatedAt, when: when(c.updatedAt), view: 'capsules', params: { item: c.id } })),
  ];
  const last = input.chat[input.chat.length - 1];
  if (last) items.push({ key: `m-${last.id}`, kind: 'chat', title: 'Conversation', detail: truncate(last.text.replace(/\s+/g, ' '), 110), at: last.createdAt, when: when(last.createdAt), view: 'assistant' });
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The reason only; the full setup guidance lives in the AI setup flow. */
export const firstSentence = (s: string): string => (/^[\s\S]*?[.!?](?=\s|$)/.exec(s.trim())?.[0] ?? s).trim();

const KIND_ICON = { note: NoteIcon, capsule: Cube, chat: ChatCircleDots } as const;
const KIND_NAME = { note: 'Note', capsule: 'Capsule', chat: 'Assistant' } as const;

/** What is due, in words. Only real counts; nothing is said when nothing is due. */
function dueLine(dueToday: number, overdue: number): string {
  const parts: string[] = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (dueToday) parts.push(`${dueToday} due today`);
  return parts.length ? parts.join(' · ') : 'Nothing is due today.';
}

/** Local date and time for the hero readout, refreshed each minute while the window is visible. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'hidden') setNow(new Date());
    };
    const id = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  return now;
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
  const clock = useClock();
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
    <div className="page today enter">
      <header className="today-hero">
        <div className="today-hello">
          <p className="hud today-clock">
            <time dateTime={clock.toISOString()}>{new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(clock)}</time>
            <span aria-hidden="true">/</span>
            <span>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(clock)}</span>
          </p>
          <h1 className="display">{greeting(hour, displayName.trim())}</h1>
          <p className="today-line">{dueLine(triage.today.length, triage.overdue.length)}</p>
          {(triage.open > 0 || state.notes.length > 0 || state.capsules.length > 0) && (
            <dl className="readouts" aria-label="Saved on this computer">
              <div>
                <dt>Open tasks</dt>
                <dd>{triage.open}</dd>
              </div>
              <div>
                <dt>Notes</dt>
                <dd>{state.notes.length}</dd>
              </div>
              <div>
                <dt>Capsules</dt>
                <dd>{state.capsules.length}</dd>
              </div>
            </dl>
          )}
        </div>
        <button type="button" className="home-pet" onClick={() => go('assistant')} aria-label="Talk to your companion"><CompanionPet decorative /><span>What’s on your mind?</span></button>
      </header>

      <StartBar today={today} go={go} />

      {readiness.level !== 'ready' && (
        <section className={cx('today-ai', readiness.level === 'blocked' ? 'is-blocked' : 'is-unknown')} aria-label="Assistant readiness">
          <span className={cx('dot', readiness.level === 'blocked' ? 'dot-warn' : '')} aria-hidden />
          <div className="grow">
            <strong>{readiness.title}</strong>
            <p className="field-hint">{firstSentence(readiness.detail)}{online ? ' Notes, tasks and search keep working without it.' : ''}</p>
          </div>
          <Button size="sm" variant="primary" onClick={() => go('assistant', { setup: '1' })}>
            {online ? 'Fix AI setup' : 'Connect Claude'}
          </Button>
          {online && (
            <Button size="sm" variant="quiet" busy={check.checking} onClick={() => void check.recheck()}>
              Check again
            </Button>
          )}
        </section>
      )}

      <div className="today-grid">
        <section className="today-col" aria-labelledby="today-continue">
          <div className="section-head">
            <h2 id="today-continue">Continue</h2>
          </div>
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
