import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, Bell, BellSlash, CalendarBlank, Check, CheckSquare, MagnifyingGlass, Pause, PencilSimple, Play, Plus, Target, Timer, Trash } from '@phosphor-icons/react';
import type { Task } from '../shared/contracts';
import { SNOOZE_PRESETS, focusSummary, observeFocus, reminderStatus, snoozeUntil, type FocusObservation, type SnoozePreset } from '../../electron/services/search';
import type { ExternalDoc } from '../../electron/services/search';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, IconButton, PageHeader, Panel, Notice } from '../ui/primitives';
import { useFocus } from '../ui/focus';
import { useReady, useStore } from '../ui/store';
import { cx, dueBucket, dueKey, fmtClock, fmtDateTime, fmtDueKey, fmtTime, localDateKey, truncate, type DueBucket } from '../ui/util';

const GROUPS: { id: DueBucket | 'done'; title: string }[] = [
  { id: 'overdue', title: 'Overdue' },
  { id: 'today', title: 'Due today' },
  { id: 'upcoming', title: 'Upcoming' },
  { id: 'none', title: 'No date' },
  { id: 'done', title: 'Completed' },
];

export type TaskFilter = 'all' | 'open' | 'overdue' | 'today' | 'upcoming' | 'none' | 'done';

export const TASK_FILTERS: { id: TaskFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Due today' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'none', label: 'No date' },
  { id: 'done', label: 'Completed' },
];

/** The group a task belongs to. A completed task is never overdue, whatever its date says. */
export function taskGroup(t: Task, today: string): DueBucket | 'done' {
  return t.done ? 'done' : dueBucket(t, today);
}

export function taskMatches(t: Task, filter: TaskFilter, query: string, today: string): boolean {
  const g = taskGroup(t, today);
  if (filter === 'open' ? g === 'done' : filter !== 'all' && g !== filter) return false;
  const q = query.trim().toLowerCase();
  return !q || t.title.toLowerCase().includes(q);
}

export function filterCounts(tasks: Task[], today: string): Record<TaskFilter, number> {
  const c: Record<TaskFilter, number> = { all: tasks.length, open: 0, overdue: 0, today: 0, upcoming: 0, none: 0, done: 0 };
  for (const t of tasks) {
    const g = taskGroup(t, today);
    c[g]++;
    if (g !== 'done') c.open++;
  }
  return c;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD). Computed in UTC so DST never shifts the answer. */
export function daysBetween(from: string, to: string): number {
  const ms = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Plain-language due status taken from the stored due date and today's date only. A completed task reports no deadline. */
export function dueSummary(t: Task, today: string): string {
  const k = dueKey(t);
  if (!k) return 'No due date';
  if (t.done) return `Was due ${fmtDueKey(k)}`;
  const n = daysBetween(today, k);
  if (n === 0) return `Due today (${fmtDueKey(k)})`;
  const days = (x: number) => `${x} day${x === 1 ? '' : 's'}`;
  return n < 0 ? `Overdue by ${days(-n)} (due ${fmtDueKey(k)})` : `Due in ${days(n)} (${fmtDueKey(k)})`;
}

/** Sorts each group: dated tasks by due date then creation time, completed tasks newest-created first. No manual order exists or is stored. */
export function groupTasks(tasks: Task[], today: string): Record<DueBucket | 'done', Task[]> {
  const g: Record<DueBucket | 'done', Task[]> = { overdue: [], today: [], upcoming: [], none: [], done: [] };
  for (const t of tasks) g[taskGroup(t, today)].push(t);
  const byDue = (a: Task, b: Task) => (dueKey(a) ?? '9999').localeCompare(dueKey(b) ?? '9999') || a.createdAt.localeCompare(b.createdAt);
  (['overdue', 'today', 'upcoming', 'none'] as const).forEach((k) => g[k].sort(byDue));
  g.done.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return g;
}

/** Local date key that follows the clock: refreshes at the next local midnight and when the window becomes visible again. */
function useToday(): string {
  const [today, setToday] = useState(() => localDateKey());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => setToday(localDateKey());
    const arm = () => {
      const n = new Date();
      const ms = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime() - n.getTime() + 1000;
      timer = setTimeout(() => { refresh(); arm(); }, Math.min(Math.max(ms, 1000), 2_147_000_000));
    };
    arm();
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return today;
}

const GROUP_LABEL: Record<DueBucket | 'done', string> = { overdue: 'Overdue', today: 'Due today', upcoming: 'Upcoming', none: 'Open, no date', done: 'Completed' };

function FocusPanel({ tasks, recording }: { tasks: Task[]; recording: boolean }) {
  const f = useFocus();
  const [minutes, setMinutes] = useState('25');
  const [taskId, setTaskId] = useState('');
  const mins = Number(minutes);
  const valid = Number.isFinite(mins) && mins >= 1 && mins <= 180;
  const R = 52;
  const C = 2 * Math.PI * R;
  const frac = f.durationSec > 0 ? f.remainingSec / f.durationSec : 0;
  const open = tasks.filter((t) => !t.done);

  return (
    <Panel title="Focus timer" eyebrow="Session" actions={<Timer size={18} aria-hidden />}>
      <div className="focus">
        <div className={cx('ring', f.phase)} role="timer" aria-live="off" aria-label={`Focus timer, ${fmtClock(f.remainingSec)} remaining, ${f.phase}`}>
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r={R} className="ring-bg" />
            <circle cx="60" cy="60" r={R} className="ring-fg" strokeDasharray={C} strokeDashoffset={C * (1 - (f.phase === 'idle' ? 1 : frac))} transform="rotate(-90 60 60)" />
          </svg>
          <span className="ring-time">{fmtClock(f.phase === 'idle' ? mins * 60 || f.durationSec : f.remainingSec)}</span>
          <span className="ring-state">{f.phase === 'done' ? 'Finished' : f.phase === 'running' ? 'Focusing' : f.phase === 'paused' ? 'Paused' : 'Ready'}</span>
        </div>

        {(f.phase === 'idle' || f.phase === 'done') && (
          <div className="stack tight">
            <div className="chips" role="group" aria-label="Duration presets">
              {[15, 25, 50].map((m) => (
                <button key={m} type="button" className={cx('chip', Number(minutes) === m && 'on')} aria-pressed={Number(minutes) === m} onClick={() => setMinutes(String(m))}>
                  {m} min
                </button>
              ))}
            </div>
            <Field label="Minutes (1–180)" error={valid ? null : 'Enter a whole number from 1 to 180.'}>
              {(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/[^\d]/g, '').slice(0, 3))} />}
            </Field>
            <Field label="Working on (optional)">
              {(id) => (
                <select id={id} className="input" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                  <option value="">No specific task</option>
                  {open.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              )}
            </Field>
            <Button
              variant="primary"
              icon={Play}
              disabled={!valid}
              onClick={() => {
                const t = open.find((x) => x.id === taskId);
                f.start(mins, t ? { id: t.id, title: t.title } : null);
              }}
            >
              Start focus
            </Button>
          </div>
        )}

        {(f.phase === 'running' || f.phase === 'paused') && (
          <div className="stack tight">
            {f.taskTitle && <p className="focus-task"><Target size={14} aria-hidden /> {f.taskTitle}</p>}
            <div className="row">
              {f.phase === 'running' ? <Button icon={Pause} onClick={f.pause}>Pause</Button> : <Button variant="primary" icon={Play} onClick={f.resume}>Resume</Button>}
              <Button variant="quiet" onClick={f.reset}>Stop and reset</Button>
            </div>
          </div>
        )}
      </div>
      <p className="field-hint">The timer runs in this app and keeps counting while you switch screens. {recording ? 'Finished and stopped sessions of a minute or more are saved on this device and listed below.' : 'Finished sessions are not saved anywhere because local storage for them is not connected.'}</p>
    </Panel>
  );
}

export function Tasks() {
  const { state, api, mutate, toast, productivityApi } = useReady();
  const focus = useFocus();
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [edit, setEdit] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDue, setEditDue] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [del, setDel] = useState<Task | null>(null);
  const [clearDone, setClearDone] = useState(false);
  const checkboxes = useRef(new Map<string, HTMLInputElement>());
  const addInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string|null>(null);
  const [clearResult, setClearResult] = useState<string|null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const today = useToday();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const grouped = useMemo(() => groupTasks(state.tasks, today), [state.tasks, today]);
  const counts = useMemo(() => filterCounts(state.tasks, today), [state.tasks, today]);
  const visible = useMemo(() => groupTasks(state.tasks.filter((t) => taskMatches(t, filter, query, today)), today), [state.tasks, filter, query, today]);
  const visibleOrder = useMemo(() => GROUPS.flatMap((g) => visible[g.id]), [visible]);
  const visibleCount = visibleOrder.length;
  const selected = state.tasks.find((t) => t.id === selectedId) ?? null;
  const selectedGroup = selected ? taskGroup(selected, today) : null;

  useEffect(()=>{
    const id = pendingFocus.current;
    if (!id || busyId || edit || del || clearDone) return;
    const handle = requestAnimationFrame(()=>{
      // Restore the same task after it moves groups, unless the user moved focus elsewhere.
      if (document.activeElement===document.body || document.activeElement instanceof HTMLDialogElement || document.activeElement===checkboxes.current.get(id)) {
        (checkboxes.current.get(id) || rowButtons.current.get(id) || addInput.current)?.focus({preventScroll:true});
      }
      pendingFocus.current=null;
    });
    return ()=>cancelAnimationFrame(handle);
  },[state.tasks,busyId,edit,del,clearDone]);

  const doneCount = grouped.done.length;
  const total = state.tasks.length;

  const add = async () => {
    const t = title.trim();
    if (!t) return setAddError('Describe the task first.');
    setAdding(true);
    const ok = await mutate(() => api.saveTask({ title: t, done: false, ...(due ? { due } : {}) }));
    setAdding(false);
    if (ok) {
      setTitle('');
      setDue('');
      setAddError(null);
    }
  };

  const toggle = async (t: Task) => {
    if (busyId) return;
    if (document.activeElement===checkboxes.current.get(t.id)) pendingFocus.current=t.id;
    setBusyId(t.id);
    await mutate(() => api.saveTask({ id: t.id, done: !t.done }));
    setBusyId(null);
  };

  const openEdit = (t: Task) => {
    setEdit(t);
    setEditTitle(t.title);
    setEditDue(dueKey(t) ?? '');
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!edit) return;
    const t = editTitle.trim();
    if (!t) return setEditError('A task needs a title.');
    setSaving(true);
    const ok = await mutate(() => api.saveTask({ id: edit.id, title: t, due: editDue }), 'Task updated.');
    setSaving(false);
    if (ok) {pendingFocus.current=edit.id;setEdit(null);}
  };

  const doDelete = async () => {
    if (!del) return;
    setSaving(true);
    const ok = await mutate(() => api.deleteTask(del.id), 'Task deleted.');
    setSaving(false);
    if (ok) {
      pendingFocus.current=del.id;
      if (selectedId === del.id) {
        // Move the selection to the neighbouring visible task so keyboard users keep their place.
        const i = visibleOrder.findIndex((t) => t.id === del.id);
        const next = visibleOrder[i + 1] ?? visibleOrder[i - 1];
        setSelectedId(next?.id ?? null);
        pendingFocus.current = next?.id ?? null;
      }
      setDel(null);
    }
  };

  const doClearDone = async () => {
    setSaving(true);setClearResult(null);
    const tasks=[...grouped.done];let deleted=0;
    for (const t of tasks) {
      // Each delete returns persisted state; stop at the first failure and report partial work.
      if (!(await mutate(() => api.deleteTask(t.id)))) break;
      deleted++;
    }
    setSaving(false);
    const message=`Deleted ${deleted} of ${tasks.length} completed tasks.`;
    setClearResult(message);
    if (deleted===tasks.length) {pendingFocus.current=tasks[0]?.id || 'add';setClearDone(false);toast('ok',message);}
    else toast('error',message+' Remaining tasks were kept.');
  };

  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Work" title="Tasks" subtitle={total ? `${doneCount} of ${total} done.` : 'A checklist with due dates, plus a focus timer.'} />

      <div className="tasks-grid">
        <div className="stack">
          <Panel title="Add a task" eyebrow="Checklist">
            <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <Field label="Task" error={addError} className="grow">
                {(id, d) => <input id={id} aria-describedby={d} ref={addInput} className="input" value={title} maxLength={200} placeholder="What needs doing?" onChange={(e) => { setTitle(e.target.value); setAddError(null); }} />}
              </Field>
              <Field label="Due (optional)">
                {(id) => <input id={id} type="date" className="input" value={due} onChange={(e) => setDue(e.target.value)} />}
              </Field>
              <div className="row align-end">
                <Button type="submit" variant="primary" icon={Plus} busy={adding}>Add</Button>
              </div>
            </form>
          </Panel>

          {total === 0 ? (
            <Panel>
              <Empty icon={CheckSquare} title="No tasks yet">Add a task above. Dated tasks are grouped as overdue, due today and upcoming, and also appear on Home.</Empty>
            </Panel>
          ) : (
            <>
              <Panel title="Find tasks" eyebrow="Queue">
                <div className="stack tight">
                  <div className="chips" role="group" aria-label="Filter tasks by status">
                    {TASK_FILTERS.map((f) => (
                      <button key={f.id} type="button" className={cx('chip', filter === f.id && 'on')} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                        {f.label} · {counts[f.id]}
                      </button>
                    ))}
                  </div>
                  <Field label="Search task titles">
                    {(id) => (
                      <div className="row">
                        <MagnifyingGlass size={16} aria-hidden />
                        <input id={id} type="search" className="input grow" value={query} maxLength={100} placeholder="Type part of a title" onChange={(e) => setQuery(e.target.value)} />
                      </div>
                    )}
                  </Field>
                  <p className="field-hint" role="status">
                    Showing {visibleCount} of {total} task{total === 1 ? '' : 's'}. Tasks are ordered by due date; there is no manual order. With a task title focused, Up and Down arrows move between tasks and Enter selects it.
                  </p>
                </div>
              </Panel>
              {visibleCount === 0 && (
                <Panel>
                  <Empty icon={MagnifyingGlass} title="No tasks match" action={<Button onClick={() => { setFilter('all'); setQuery(''); }}>Show all tasks</Button>}>
                    Nothing matches this status{query.trim() ? ' and search' : ''}.
                  </Empty>
                </Panel>
              )}
              {GROUPS.map((g) =>
                visible[g.id].length === 0 ? null : (
                  <Panel
                    key={g.id}
                    title={`${g.title} · ${visible[g.id].length}`}
                    className={cx('task-group', `task-${g.id}`)}
                    actions={g.id === 'done' ? <Button size="sm" variant="quiet" icon={Trash} onClick={() => {setClearResult(null);setClearDone(true);}}>Clear completed</Button> : undefined}
                  >
                    <ul className="list" aria-label={g.title}>
                      {visible[g.id].map((t) => {
                        const k = dueKey(t);
                        const focusing = focus.taskId === t.id && (focus.phase === 'running' || focus.phase === 'paused');
                        const isSel = selectedId === t.id;
                        return (
                          <li key={t.id} className={cx('list-row', t.done && 'is-done')} style={isSel ? { boxShadow: 'inset 3px 0 0 var(--accent)', background: 'var(--accent-soft)' } : undefined}>
                            <input ref={element=>{if(element)checkboxes.current.set(t.id,element);else checkboxes.current.delete(t.id);}} type="checkbox" className="check" checked={t.done} disabled={busyId !== null} aria-label={`${t.done ? 'Reopen' : 'Complete'} “${t.title}”`} onChange={() => void toggle(t)} />
                            <button
                              type="button"
                              ref={(element) => { if (element) rowButtons.current.set(t.id, element); else rowButtons.current.delete(t.id); }}
                              className="grow task-title"
                              style={{ background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer', minWidth: 0 }}
                              aria-current={isSel ? 'true' : undefined}
                              aria-label={`${isSel ? 'Selected: ' : 'Show details for '}“${t.title}”`}
                              onClick={() => setSelectedId(t.id)}
                              onKeyDown={(e) => {
                                const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
                                if (!step) return;
                                e.preventDefault();
                                const i = visibleOrder.findIndex((x) => x.id === t.id);
                                const next = visibleOrder[i + step];
                                if (!next) return;
                                setSelectedId(next.id);
                                rowButtons.current.get(next.id)?.focus();
                              }}
                            >
                              {t.title}
                            </button>
                            {focusing && <Badge tone="accent">Focusing</Badge>}
                            {k && !t.done && <Badge tone={g.id === 'overdue' ? 'danger' : g.id === 'today' ? 'warn' : 'muted'}>{g.id === 'overdue' ? `Overdue · ${fmtDueKey(k)}` : fmtDueKey(k)}</Badge>}
                            <ReminderControls task={t} />
                            {!t.done && focus.phase !== 'running' && focus.phase !== 'paused' && (
                              <IconButton icon={Play} label={`Focus on “${t.title}” for 25 minutes`} onClick={() => focus.start(25, { id: t.id, title: t.title })} />
                            )}
                            <IconButton icon={PencilSimple} label={`Edit “${t.title}”`} onClick={() => openEdit(t)} />
                            <IconButton icon={Trash} label={`Delete “${t.title}”`} onClick={() => setDel(t)} />
                          </li>
                        );
                      })}
                    </ul>
                  </Panel>
                )
              )}
            </>
          )}
        </div>

        <div className="stack">
          {selected && (
            <Panel title="Task details" eyebrow="Selected">
              <div className="stack tight">
                <h3 className="task-title" style={{ margin: 0, overflowWrap: 'anywhere' }}>{selected.title}</h3>
                <p>
                  <Badge tone={selectedGroup === 'done' ? 'ok' : selectedGroup === 'overdue' ? 'danger' : selectedGroup === 'today' ? 'warn' : 'muted'}>
                    {GROUP_LABEL[selectedGroup ?? 'none']}
                  </Badge>
                </p>
                <dl className="stack tight" style={{ margin: 0 }}>
                  <div><dt className="sub">Due</dt><dd style={{ margin: 0 }}>{dueSummary(selected, today)}</dd></div>
                  <div><dt className="sub">Created</dt><dd style={{ margin: 0 }}>{fmtDateTime(selected.createdAt)}</dd></div>
                  {selected.done && <div><dt className="sub">Completed</dt><dd style={{ margin: 0 }}>Completion time is not recorded for tasks.</dd></div>}
                </dl>
                {!taskMatches(selected, filter, query, today) && <p className="field-hint">This task is hidden by the current filter or search.</p>}
                <div className="row wrap">
                  <Button variant="primary" icon={selected.done ? ArrowCounterClockwise : Check} busy={busyId === selected.id} disabled={busyId !== null} onClick={() => void toggle(selected)}>
                    {selected.done ? 'Reopen task' : 'Mark complete'}
                  </Button>
                  <Button icon={PencilSimple} onClick={() => openEdit(selected)}>Edit</Button>
                  <Button variant="quiet" icon={Trash} onClick={() => setDel(selected)}>Delete</Button>
                  <Button variant="quiet" onClick={() => setSelectedId(null)}>Close details</Button>
                </div>
              </div>
            </Panel>
          )}
          <FocusPanel tasks={state.tasks} recording={productivityApi !== null} />
          <FocusHistory />
          <CalendarToday />
        </div>
      </div>
      <FocusRecorder />

      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title="Edit task"
        dismissible={!saving}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)} disabled={saving}>Cancel</Button>
            <Button variant="primary" busy={saving} onClick={() => void saveEdit()}>Save task</Button>
          </>
        }
      >
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
          <Field label="Title" error={editError}>
            {(id, d) => <input id={id} aria-describedby={d} data-autofocus className="input" value={editTitle} maxLength={200} onChange={(e) => { setEditTitle(e.target.value); setEditError(null); }} />}
          </Field>
          <Field label="Due date">
            {(id) => (
              <div className="row">
                <input id={id} type="date" className="input" value={editDue} onChange={(e) => setEditDue(e.target.value)} />
                {editDue && <Button size="sm" variant="quiet" onClick={() => setEditDue('')}>Clear date</Button>}
              </div>
            )}
          </Field>
          <button type="submit" hidden />
        </form>
      </Dialog>

      <ConfirmDialog open={del !== null} title="Delete this task?" confirmLabel="Delete task" danger busy={saving} onCancel={() => setDel(null)} onConfirm={() => void doDelete()}>
        <p>“{del?.title}” will be removed.</p>
      </ConfirmDialog>
      <ConfirmDialog open={clearDone} title="Clear completed tasks?" confirmLabel={`Delete ${doneCount}`} danger busy={saving} onCancel={() => setClearDone(false)} onConfirm={() => void doClearDone()}>
        <p>{doneCount} completed task{doneCount === 1 ? '' : 's'} will be permanently removed.</p>
        {clearResult&&<Notice tone="warn">{clearResult} Remaining tasks were kept; retry affects only those still listed.</Notice>}
      </ConfirmDialog>
    </div>
  );
}

/**
 * Saves focus sessions to the productivity store. It watches the timer, so it must be mounted for as long as the app
 * runs to see sessions that finish while another screen is open: mount it once at app level (Tasks mounts it too,
 * which is harmless because the store ignores a session whose start time it already holds). It records only what it
 * observed: a start that happened before it mounted is reconstructed from the remaining time, never guessed.
 */
export function FocusRecorder() {
  const f = useFocus();
  const { productivityApi, applyProductivity } = useStore();
  const seen = useRef<FocusObservation | null>(null);

  useEffect(() => {
    const { next, record } = observeFocus(seen.current, { phase: f.phase, durationSec: f.durationSec, remainingSec: f.remainingSec, taskId: f.taskId, taskTitle: f.taskTitle }, Date.now());
    seen.current = next;
    if (record && productivityApi) void applyProductivity(record);
  }, [f.phase, f.durationSec, f.remainingSec, f.taskId, f.taskTitle, productivityApi, applyProductivity]);

  return null;
}

function FocusHistory() {
  const { productivityApi, productivity, applyProductivity } = useReady();
  const sessions = productivity?.focus ?? [];
  const day = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }, []);
  if (!productivityApi || !productivity) return null;
  const today = focusSummary(sessions, day);
  const week = focusSummary(sessions, day - 6 * 86_400_000);
  const min = (sec: number) => `${Math.round(sec / 60)} min`;
  return (
    <Panel title="Focus history" eyebrow="Saved on this device">
      {sessions.length === 0 ? (
        <p className="field-hint">No sessions saved yet. Sessions of a minute or more appear here when they finish or are stopped.</p>
      ) : (
        <>
          <p role="status">Today: {today.sessions} session{today.sessions === 1 ? '' : 's'}, {min(today.totalSec)}. Last 7 days: {week.sessions}, {min(week.totalSec)} ({week.completed} completed).</p>
          <ul className="list compact" aria-label="Recent focus sessions">
            {[...sessions].reverse().slice(0, 8).map((s) => (
              <li key={s.id} className="list-row">
                <span className="grow">
                  {min(s.actualSec)} of {min(s.plannedSec)}{s.taskTitle ? ` · ${truncate(s.taskTitle, 40)}` : ''}
                  <span className="sub block">{fmtDateTime(s.endedAt)}</span>
                </span>
                <Badge tone={s.outcome === 'completed' ? 'ok' : 'muted'}>{s.outcome === 'completed' ? 'Completed' : 'Stopped'}</Badge>
                <IconButton icon={Trash} label={`Delete focus session from ${fmtDateTime(s.endedAt)}`} onClick={() => void applyProductivity({ op: 'focus.delete', id: s.id }, 'Session deleted.')} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

const PRESET_LABEL: Record<SnoozePreset, string> = { '10m': '10 min', '1h': '1 hour', tomorrow: 'Tomorrow 9:00' };

/** Snooze and dismiss for a task's due reminder. Hidden unless the productivity store is connected. */
function ReminderControls({ task }: { task: Task }) {
  const { productivityApi, productivity, applyProductivity } = useReady();
  if (!productivityApi || !productivity || task.done || !task.due) return null;
  const st = reminderStatus(task, productivity.reminders, Date.now());
  if (st.state === 'none') return null;
  const due = task.due;
  if (st.state === 'snoozed' || st.state === 'dismissed') {
    return (
      <>
        <Badge tone="muted">{st.state === 'snoozed' && st.until ? `Snoozed until ${fmtTime(st.until)}` : 'Reminder off'}</Badge>
        <IconButton icon={Bell} label={`Turn reminder back on for “${task.title}”`} onClick={() => void applyProductivity({ op: 'reminder.clear', taskId: task.id, due })} />
      </>
    );
  }
  return (
    <>
      {st.state === 'due' && (
        <span className="row" role="group" aria-label={`Snooze “${task.title}”`}>
          {SNOOZE_PRESETS.map((p) => (
            <Button key={p} size="sm" variant="quiet" onClick={() => void applyProductivity({ op: 'reminder.snooze', taskId: task.id, due, until: snoozeUntil(p, Date.now()) }, `Snoozed for ${PRESET_LABEL[p]}.`)}>
              {PRESET_LABEL[p]}
            </Button>
          ))}
        </span>
      )}
      <IconButton icon={BellSlash} label={`Turn off the reminder for “${task.title}”`} onClick={() => void applyProductivity({ op: 'reminder.dismiss', taskId: task.id, due }, 'Reminder turned off.')} />
    </>
  );
}

/** Today's calendar events from the calendar module, when one is connected through productivity.signals(). */
function CalendarToday() {
  const { productivityApi } = useReady();
  const [events, setEvents] = useState<ExternalDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signals = productivityApi?.signals;
  useEffect(() => {
    if (!signals) return undefined;
    let live = true;
    signals()
      .then((all) => { if (live) setEvents(all.filter((e) => e.source === 'calendar')); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Calendar events could not be loaded.'); });
    return () => { live = false; };
  }, [signals]);
  if (!signals) return null;
  const key = localDateKey();
  const today = (events ?? []).filter((e) => e.at && localDateKey(new Date(e.at)) === key).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  return (
    <Panel title="Today's calendar" eyebrow="Local calendar" actions={<CalendarBlank size={18} aria-hidden />}>
      {error ? <Notice tone="warn">{error}</Notice> : events === null ? <p className="field-hint">Loading…</p> : today.length === 0 ? <p className="field-hint">No events today in the connected calendar.</p> : (
        <ul className="list compact">
          {today.map((e) => (
            <li key={e.id} className="list-row"><span className="mono">{fmtTime(e.at)}</span><span className="grow">{truncate(e.title, 60)}</span></li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
