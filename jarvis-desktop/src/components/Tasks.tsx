import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Pause, PencilSimple, Play, Plus, Target, Timer, Trash } from '@phosphor-icons/react';
import type { Task } from '../shared/contracts';
import { Dialog, ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, IconButton, PageHeader, Panel, Notice } from '../ui/primitives';
import { useFocus } from '../ui/focus';
import { useReady } from '../ui/store';
import { cx, dueBucket, dueKey, fmtClock, fmtDueKey, type DueBucket } from '../ui/util';

const GROUPS: { id: DueBucket | 'done'; title: string }[] = [
  { id: 'overdue', title: 'Overdue' },
  { id: 'today', title: 'Due today' },
  { id: 'upcoming', title: 'Upcoming' },
  { id: 'none', title: 'No date' },
  { id: 'done', title: 'Completed' },
];

function FocusPanel({ tasks }: { tasks: Task[] }) {
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
      <p className="field-hint">The timer runs in this app and keeps counting while you switch screens. Finished sessions are not saved anywhere yet.</p>
    </Panel>
  );
}

export function Tasks() {
  const { state, api, mutate, toast } = useReady();
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

  const grouped = useMemo(() => {
    const g: Record<string, Task[]> = { overdue: [], today: [], upcoming: [], none: [], done: [] };
    for (const t of state.tasks) g[t.done ? 'done' : dueBucket(t)].push(t);
    const byDue = (a: Task, b: Task) => (dueKey(a) ?? '9999').localeCompare(dueKey(b) ?? '9999') || a.createdAt.localeCompare(b.createdAt);
    (['overdue', 'today', 'upcoming', 'none'] as const).forEach((k) => g[k].sort(byDue));
    g.done.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return g;
  }, [state.tasks]);

  useEffect(()=>{
    const id = pendingFocus.current;
    if (!id || busyId || edit || del || clearDone) return;
    const handle = requestAnimationFrame(()=>{
      // Restore the same task after it moves groups, unless the user moved focus elsewhere.
      if (document.activeElement===document.body || document.activeElement instanceof HTMLDialogElement || document.activeElement===checkboxes.current.get(id)) {
        (checkboxes.current.get(id) || addInput.current)?.focus({preventScroll:true});
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
    if (ok) {pendingFocus.current=del.id;setDel(null);}
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
      <PageHeader eyebrow="Work" title="Tasks & focus" subtitle={total ? `${doneCount} of ${total} done.` : 'A checklist with due dates, plus a focus timer.'} />

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
            GROUPS.map((g) =>
              grouped[g.id].length === 0 ? null : (
                <Panel
                  key={g.id}
                  title={`${g.title} · ${grouped[g.id].length}`}
                  className={cx('task-group', `task-${g.id}`)}
                  actions={g.id === 'done' ? <Button size="sm" variant="quiet" icon={Trash} onClick={() => {setClearResult(null);setClearDone(true);}}>Clear completed</Button> : undefined}
                >
                  <ul className="list">
                    {grouped[g.id].map((t) => {
                      const k = dueKey(t);
                      const focusing = focus.taskId === t.id && (focus.phase === 'running' || focus.phase === 'paused');
                      return (
                        <li key={t.id} className={cx('list-row', t.done && 'is-done')}>
                          <input ref={element=>{if(element)checkboxes.current.set(t.id,element);else checkboxes.current.delete(t.id);}} type="checkbox" className="check" checked={t.done} disabled={busyId !== null} aria-label={`${t.done ? 'Reopen' : 'Complete'} “${t.title}”`} onChange={() => void toggle(t)} />
                          <span className="grow task-title">{t.title}</span>
                          {focusing && <Badge tone="accent">Focusing</Badge>}
                          {k && !t.done && <Badge tone={g.id === 'overdue' ? 'danger' : g.id === 'today' ? 'warn' : 'muted'}>{fmtDueKey(k)}</Badge>}
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
            )
          )}
        </div>

        <FocusPanel tasks={state.tasks} />
      </div>

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
