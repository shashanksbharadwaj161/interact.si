import { useState } from 'react';
import { ArrowSquareOut, Copy } from '@phosphor-icons/react';
import { VIEWS } from '../ui/nav';
import { Button, Empty, Field, KV, Notice, PageHeader, Panel } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { fmtDateTime, isLoopbackHost, parseHttpUrl, truncate } from '../ui/util';
import {
  TASK_BOARD_LIMITS,
  TASK_BOARD_PREF_KEY,
  TASK_STATUSES,
  STOP_REASONS,
  createTask,
  deriveWorkerStatus,
  parseBoard,
  summarizeBoard,
  transitionTask,
  type BoardTask,
  type StopReason,
  type TaskStatus,
} from '../ui/task-board';
import {
  DEFAULT_TASK_BUDGET,
  TASK_BUDGET_BOUNDS,
  TASK_BUDGET_PREF_KEY,
  evaluateStart,
  findOverdue,
  normalizeTaskBudget,
  parseSpendLedger,
  recordSpend,
  sumSpendForDay,
  type TaskBudget,
} from '../ui/task-budget';

const BOARD_ROLES = ['planner', 'worker', 'reviewer', 'verifier'] as const;
const BOARD_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] as const;
const FAIL_REASONS: StopReason[] = STOP_REASONS.filter((r) => r !== 'completed' && r !== 'user-cancelled');
const CANCEL_REASONS: StopReason[] = STOP_REASONS.filter((r) => r !== 'completed');

const BUDGET_FIELDS: { key: keyof TaskBudget; label: string; step: string }[] = [
  { key: 'maxConcurrentRunning', label: 'Max running at once', step: '1' },
  { key: 'maxTasksPerDay', label: 'Max tasks started per day', step: '1' },
  { key: 'maxWallClockMinutesPerTask', label: 'Max wall-clock minutes per task', step: '1' },
  { key: 'maxEstimatedCostUsdPerDay', label: 'Max recorded spend per day (USD, 0 = none allowed)', step: '0.01' },
];
const budgetDrafts = (b: TaskBudget) => Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, String(b[f.key])])) as Record<keyof TaskBudget, string>;

/** Budget prefs plus the current start check. Evaluated on render only; nothing runs on a timer. */
function useTaskBudget(tasks: BoardTask[]) {
  const [rawBudget, setRawBudget] = usePref<unknown>(TASK_BUDGET_PREF_KEY, DEFAULT_TASK_BUDGET);
  const [rawLedger, setRawLedger] = usePref<unknown>('developer.taskSpend', []);
  const budget = normalizeTaskBudget(rawBudget);
  const ledger = parseSpendLedger(rawLedger);
  const startCheck = evaluateStart(tasks, budget, { now: Date.now(), ledger });
  return { budget, setBudget: (b: unknown) => setRawBudget(normalizeTaskBudget(b)), ledger, setLedger: (l: unknown) => setRawLedger(parseSpendLedger(l)), startCheck };
}

function TaskBudgetGroup({
  tasks,
  setTasks,
  toast,
  state,
}: {
  tasks: BoardTask[];
  setTasks: (t: BoardTask[]) => void;
  toast: (tone: 'ok' | 'error', msg: string) => void;
  state: ReturnType<typeof useTaskBudget>;
}) {
  const { budget, setBudget, ledger, setLedger, startCheck } = state;
  const [drafts, setDrafts] = useState(() => budgetDrafts(budget));
  const [spendAmount, setSpendAmount] = useState('');
  const [spendTask, setSpendTask] = useState('manual');
  const now = Date.now();
  const overdue = findOverdue(tasks, budget, now);
  const spentToday = sumSpendForDay(ledger, now);

  const save = () => {
    const next = normalizeTaskBudget(Object.fromEntries(BUDGET_FIELDS.map((f) => [f.key, drafts[f.key]])));
    setBudget(next);
    setDrafts(budgetDrafts(next));
    toast('ok', 'Task budget saved.');
  };

  const stopOverdue = () => {
    const listed = new Set(overdue.map((o) => o.task.id));
    const due = new Set(findOverdue(tasks, budget, Date.now()).map((o) => o.task.id).filter((id) => listed.has(id)));
    try {
      const at = Date.now();
      setTasks(tasks.map((t) => (due.has(t.id) ? transitionTask(t, 'stopped', { now: at, stopReason: 'timeout' }) : t)));
      toast('ok', `Stopped ${due.size} overdue task${due.size === 1 ? '' : 's'} with stop reason timeout.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const addSpend = () => {
    try {
      if (!spendAmount.trim()) throw new Error('Enter a spend amount in USD.');
      setLedger(recordSpend(ledger, { taskId: spendTask, usd: Number(spendAmount), at: Date.now() }));
      setSpendAmount('');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="stack" aria-label="Task budget">
      <h3>Task budget</h3>
      <p className="field-hint">Limits apply to Start and Resume on this board. Spend is only what you record by hand; nothing is calculated or fetched.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="row">
          {BUDGET_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={`${TASK_BUDGET_BOUNDS[f.key].min} to ${TASK_BUDGET_BOUNDS[f.key].max}. Saved: ${budget[f.key]}.`}>
              {(id, d) => (
                <input
                  id={id}
                  aria-describedby={d}
                  className="input mono"
                  type="number"
                  min={TASK_BUDGET_BOUNDS[f.key].min}
                  max={TASK_BUDGET_BOUNDS[f.key].max}
                  step={f.step}
                  value={drafts[f.key]}
                  onChange={(e) => setDrafts({ ...drafts, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        <div className="row">
          <Button type="submit">Save budget</Button>
        </div>
      </form>
      <p className="sub" data-start-check={startCheck.reason}>
        Start check: {startCheck.allowed ? 'allowed' : 'blocked'} ({startCheck.reason}). {startCheck.detail}
      </p>

      <h4>Overdue running tasks</h4>
      {overdue.length === 0 ? (
        <p className="sub">No running task is over {budget.maxWallClockMinutesPerTask} minutes of wall-clock time.</p>
      ) : (
        <ul className="stack">
          {overdue.map((o) => (
            <li key={o.task.id} className="sub mono">
              {o.task.title} · {o.task.id} · running {o.elapsedMinutes} min, limit {o.limitMinutes} min
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <Button size="sm" variant="danger" disabled={overdue.length === 0} onClick={stopOverdue}>Stop overdue</Button>
        <span className="sub">Stops only the tasks listed above, with stop reason timeout.</span>
      </div>

      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          addSpend();
        }}
      >
        <Field label="Record spend (USD)" hint={`Recorded today: ${spentToday.toFixed(2)} USD across ${ledger.length} ledger entries (newest 500 kept).`}>
          {(id, d) => <input id={id} aria-describedby={d} className="input mono" type="number" min={0} step="0.01" value={spendAmount} onChange={(e) => setSpendAmount(e.target.value)} />}
        </Field>
        <Field label="For task">
          {(id) => (
            <select id={id} className="input mono" value={spendTask} onChange={(e) => setSpendTask(e.target.value)}>
              <option value="manual">manual</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.id} · {truncate(t.title, 40)}</option>)}
            </select>
          )}
        </Field>
        <Button type="submit" disabled={!spendAmount.trim()}>Record spend</Button>
      </form>
    </section>
  );
}

function TaskRow({ task, onMove, startBlocked }: { task: BoardTask; onMove: (t: BoardTask, next: TaskStatus, reason?: StopReason) => void; startBlocked?: string }) {
  const [failReason, setFailReason] = useState<StopReason>('error');
  const [cancelReason, setCancelReason] = useState<StopReason>('user-cancelled');
  const s = task.status;
  return (
    <li className="stack" data-task-id={task.id}>
      <div className="row">
        <strong>{task.title}</strong>
        <span className="tl-kind">{s}</span>
        <span className="sub mono">{task.role}{task.model ? ` · ${task.model}` : ''}</span>
      </div>
      <span className="sub mono">
        created {task.createdAt}
        {task.startedAt ? ` · started ${task.startedAt}` : ''}
        {task.endedAt ? ` · ended ${task.endedAt}` : ''}
        {task.stopReason ? ` · stop reason: ${task.stopReason}` : ''}
      </span>
      <div className="row">
        {s === 'queued' && <Button size="sm" disabled={!!startBlocked} onClick={() => onMove(task, 'running')}>Start</Button>}
        {s === 'running' && <Button size="sm" onClick={() => onMove(task, 'paused')}>Pause</Button>}
        {s === 'paused' && <Button size="sm" disabled={!!startBlocked} onClick={() => onMove(task, 'running')}>Resume</Button>}
        {startBlocked && (s === 'queued' || s === 'paused') && <span className="sub">{startBlocked}</span>}
        {s === 'running' && <Button size="sm" onClick={() => onMove(task, 'done', 'completed')}>Mark done</Button>}
        {s === 'running' && (
          <>
            <select className="input" aria-label={`Failure reason for ${task.title}`} value={failReason} onChange={(e) => setFailReason(e.target.value as StopReason)}>
              {FAIL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button size="sm" variant="danger" onClick={() => onMove(task, 'failed', failReason)}>Mark failed</Button>
          </>
        )}
        {(s === 'queued' || s === 'running' || s === 'paused') && (
          <>
            <select className="input" aria-label={`Cancel reason for ${task.title}`} value={cancelReason} onChange={(e) => setCancelReason(e.target.value as StopReason)}>
              {CANCEL_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <Button size="sm" variant="quiet" onClick={() => onMove(task, 'cancelled', cancelReason)}>Cancel</Button>
          </>
        )}
      </div>
    </li>
  );
}

function TaskBoardPanel({ toast }: { toast: (tone: 'ok' | 'error', msg: string) => void }) {
  const [rawBoard, setRawBoard] = usePref<unknown>(TASK_BOARD_PREF_KEY, []);
  const tasks = parseBoard(rawBoard);
  const [title, setTitle] = useState('');
  const [role, setRole] = useState<string>(BOARD_ROLES[1]);
  const [model, setModel] = useState<string>(BOARD_MODELS[1]);
  const workers = deriveWorkerStatus(tasks);
  const summary = summarizeBoard(tasks);
  const full = tasks.length >= TASK_BOARD_LIMITS.tasks;
  const budgetState = useTaskBudget(tasks);
  const startBlocked = budgetState.startCheck.allowed ? undefined : budgetState.startCheck.detail;

  const add = () => {
    try {
      const ids = new Set(tasks.map((t) => t.id));
      const counter = { next: tasks.length };
      let task = createTask({ title, role, model }, Date.now(), counter);
      while (ids.has(task.id)) task = { ...task, id: task.id.replace(/-\d+$/, `-${counter.next++}`) };
      setRawBoard([...tasks, task]);
      setTitle('');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const move = (task: BoardTask, next: TaskStatus, stopReason?: StopReason) => {
    try {
      if (next === 'running' && startBlocked) throw new Error(startBlocked);
      const updated = transitionTask(task, next, { now: Date.now(), stopReason });
      setRawBoard(tasks.map((t) => (t.id === task.id ? updated : t)));
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Panel title="Task board" eyebrow="Agent Control Room · development tooling">
      <p className="field-hint">Tasks and worker states here come only from what you record. Nothing runs, calls a model or contacts a network from this board.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Task title" hint={`Up to ${TASK_BOARD_LIMITS.titleChars} characters.`}>
          {(id, d) => <input id={id} aria-describedby={d} className="input" value={title} maxLength={TASK_BOARD_LIMITS.titleChars} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <div className="row">
          <Field label="Role">
            {(id) => (
              <select id={id} className="input" value={role} onChange={(e) => setRole(e.target.value)}>
                {BOARD_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
          </Field>
          <Field label="Model">
            {(id) => (
              <select id={id} className="input mono" value={model} onChange={(e) => setModel(e.target.value)}>
                {BOARD_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </Field>
        </div>
        <div className="row">
          <Button type="submit" disabled={!title.trim() || full}>Add queued task</Button>
          {full && <span className="sub">Board holds at most {TASK_BOARD_LIMITS.tasks} tasks.</span>}
        </div>
      </form>

      <dl className="kv-list">
        <KV k="Total">{summary.total}</KV>
        <KV k="By status">{TASK_STATUSES.map((s) => `${s} ${summary.byStatus[s]}`).join(' · ')}</KV>
        <KV k="Stop reasons">{STOP_REASONS.map((r) => `${r} ${summary.byStopReason[r]}`).join(' · ')}</KV>
      </dl>

      <TaskBudgetGroup tasks={tasks} setTasks={setRawBoard} toast={toast} state={budgetState} />

      <h3>Workers</h3>
      {workers.length === 0 ? (
        <Empty title="No workers yet">Workers appear once tasks are added.</Empty>
      ) : (
        <ul className="stack">
          {workers.map((w) => (
            <li key={w.id} className="row">
              <span className="mono">{w.role}{w.model ? ` · ${w.model}` : ''}</span>
              <span className="tl-kind">{w.state}</span>
              {w.currentTaskId && <span className="sub mono">task {w.currentTaskId}</span>}
              <span className="sub">completed {w.completed} · failed {w.failed}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Tasks</h3>
      {tasks.length === 0 ? (
        <Empty title="No tasks recorded">Add a queued task above.</Empty>
      ) : (
        <ol className="stack">
          {[...tasks].reverse().slice(0, 50).map((t) => <TaskRow key={t.id} task={t} onMove={move} startBlocked={startBlocked} />)}
        </ol>
      )}
    </Panel>
  );
}

export function Developer() {
  const { state, settings, system, isPreview, toast, cloudConfigured } = useReady();
  const [saved, setSaved] = usePref('controlRoomUrl', '');
  const [url, setUrl] = useState(saved);
  const parsed = parseHttpUrl(url);
  const error = !url.trim() ? null : !parsed ? 'Enter a full http:// address.' : !isLoopbackHost(parsed.hostname) ? 'Only addresses on this computer (localhost or 127.0.0.1) are accepted.' : null;
  const valid = parsed !== null && error === null;
  const activity = [...state.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);

  const copy = async () => {
    const report = {
      app: 'Desktop Companion UI',
      runtime: isPreview ? 'browser preview (no backend)' : 'electron',
      platform: system?.platform ?? 'unknown',
      arch: system?.arch ?? 'unknown',
      ramGB: system?.ramGB ?? 0,
      mode: settings.mode,
      theme: settings.theme,
      reduceMotion: settings.reduceMotion,
      cloudKeyConfigured: cloudConfigured,
      counts: { capsules: state.capsules.length, notes: state.notes.length, tasks: state.tasks.length, chat: state.chat.length },
      allowedRoots: settings.allowedRoots.length,
      approvedApps: settings.approvedApps.length,
      capabilities: system?.capabilities.map((c) => ({ id: c.id, available: c.available, reason: c.reason })) ?? [],
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast('ok', 'Diagnostics copied. They contain no paths, notes or keys.');
    } catch {
      toast('error', 'Clipboard access was blocked.');
    }
  };

  return (
    <div className="page">
      <PageHeader eyebrow="System" title="Developer" subtitle="Diagnostics, shortcuts and a link out to the local Control Room." />

      <div className="two-col">
        <div className="stack">
          <Panel title="Control Room" eyebrow="External link">
            <p className="field-hint">
              Control Room is a separate local tool. This app does not start it, embed it or send it any data. Enter the address it serves on this computer, and the link below opens it in your default browser when you click it.
            </p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) {
                  setSaved(url.trim());
                  toast('ok', 'Address remembered in this app’s display preferences.');
                }
              }}
            >
              <Field label="Control Room address" error={error} hint="Remembered locally as a display preference. Must be localhost or 127.0.0.1.">
                {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={url} spellCheck={false} maxLength={200} placeholder="http://127.0.0.1:PORT" onChange={(e) => setUrl(e.target.value)} />}
              </Field>
              <div className="row">
                <Button type="submit" disabled={!valid || url.trim() === saved}>Remember address</Button>
                {valid && parsed ? (
                  <a className="btn btn-primary" href={parsed.href} target="_blank" rel="noopener noreferrer">
                    <ArrowSquareOut size={16} aria-hidden />
                    <span>Open Control Room</span>
                  </a>
                ) : (
                  <span className="sub">Enter a valid local address to enable the link.</span>
                )}
              </div>
            </form>
          </Panel>

          <TaskBoardPanel toast={toast} />

          <Panel title="Runtime" eyebrow="This window">
            <dl className="kv-list">
              <KV k="Backend">{isPreview ? 'None (browser preview bridge)' : 'Electron preload API (window.jarvis)'}</KV>
              <KV k="Platform">{system ? `${system.platform} ${system.arch}` : 'unknown'}</KV>
              <KV k="Theme">{settings.theme}</KV>
              <KV k="Records">{state.capsules.length} capsules · {state.notes.length} notes · {state.tasks.length} tasks · {state.chat.length} messages</KV>
            </dl>
            <Button icon={Copy} onClick={() => void copy()}>Copy diagnostics</Button>
          </Panel>

          <Panel title="Keyboard" eyebrow="Shortcuts">
            <dl className="kv-list">
              {VIEWS.slice(0, 10).map((v, i) => (
                <div key={v.id} className="kv">
                  <dt>{v.label}</dt>
                  <dd><kbd>Alt</kbd> + <kbd>{i === 9 ? 0 : i + 1}</kbd></dd>
                </div>
              ))}
              <div className="kv"><dt>Save note</dt><dd><kbd>Ctrl</kbd> + <kbd>S</kbd></dd></div>
              <div className="kv"><dt>Cancel recording</dt><dd><kbd>Esc</kbd></dd></div>
            </dl>
          </Panel>
        </div>

        <Panel title="Activity log" eyebrow={`Latest ${activity.length}`}>
          {activity.length === 0 ? (
            <Empty title="No activity recorded">Entries arrive from the backend as things happen.</Empty>
          ) : (
            <ol className="timeline">
              {activity.map((a) => (
                <li key={a.id} title={a.details}>
                  <span className="tl-kind">{a.kind}</span>
                  <span>
                    {truncate(a.summary, 140)}
                    {a.details && <span className="sub">{truncate(a.details, 200)}</span>}
                  </span>
                  <time dateTime={a.at}>{fmtDateTime(a.at)}</time>
                </li>
              ))}
            </ol>
          )}
          <Notice>Logs come from the backend and are shown as received.</Notice>
        </Panel>
      </div>
    </div>
  );
}
