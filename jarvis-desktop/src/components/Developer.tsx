import { useEffect, useMemo, useState } from 'react';
import { orbStats, type OrbStats } from '../ui/orb-engine';
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
import {
  AGENT_LOG_LIMITS,
  AGENT_LOG_PREF_KEY,
  LOG_LEVELS,
  appendEntry,
  exportLog,
  filterLog,
  normalizeLog,
  redactSecrets,
  summarizeTask,
  type LogLevel,
} from '../ui/agent-log';
import {
  AGENT_SESSION_PREF_KEY,
  SAVED_SESSIONS_CAP,
  SESSION_LIMITS,
  buildSession,
  diffSessions,
  normalizeSavedSessions,
  parseSession,
  planResume,
  serializeSession,
  upsertSession,
  type AgentSession,
  type ParsedSession,
  type ResumePlan,
  type SessionDiff,
} from '../ui/agent-session';
import {
  ROLE_PREF_KEY,
  TOOL_SCOPES,
  WORKER_ROLES,
  getRole,
  normalizeOverrides,
  recommendModel,
  validateAssignment,
  type RoleOverrides,
  type WorkerRoleId,
} from '../ui/worker-roles';
import {
  SKILLS_PREF_KEY,
  SKILL_LIMITS,
  normalizeSkills,
  removeSkill,
  suggestSkills,
  taskFromSkill,
  upsertSkill,
  type Skill,
  type SkillSuggestion,
  type SkillTaskInput,
} from '../ui/skill-suggestions';

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

/** Hand-recorded agent log for board tasks. Persisted via prefs; export is redacted and goes only to the clipboard. */
function AgentLogGroup({ tasks, toast, logPref }: { tasks: BoardTask[]; toast: (tone: 'ok' | 'error', msg: string) => void; logPref?: [unknown, (v: unknown) => void] }) {
  const ownLogPref = usePref<unknown>(AGENT_LOG_PREF_KEY, []);
  const [rawLog, setRawLog] = logPref ?? ownLogPref;
  const log = normalizeLog(rawLog);
  const [entryTaskRaw, setEntryTask] = useState('');
  const [level, setLevel] = useState<LogLevel>('info');
  const [message, setMessage] = useState('');
  const [data, setData] = useState('');
  const [filterTask, setFilterTask] = useState('');
  const [filterLevel, setFilterLevel] = useState<LogLevel | ''>('');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const entryTask = tasks.some((t) => t.id === entryTaskRaw) ? entryTaskRaw : tasks[tasks.length - 1]?.id ?? '';
  const focusTask = filterTask || entryTask;
  const summary = focusTask ? summarizeTask(log, focusTask) : null;
  const shown = filterLog(log, { taskId: filterTask, level: filterLevel, query }).slice(0, 100);
  const taskIds = [...new Set([...tasks.map((t) => t.id), ...log.map((e) => e.taskId)])];

  const add = () => {
    try {
      setRawLog(appendEntry(log, { taskId: entryTask, level, message, data: data || undefined }, Date.now()));
      setMessage('');
      setData('');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const exportJson = async () => {
    try {
      await navigator.clipboard.writeText(exportLog(log, { taskId: filterTask || undefined }));
      toast('ok', `Agent log copied as JSON with secrets redacted${filterTask ? ` (task ${filterTask})` : ''}.`);
    } catch {
      toast('error', 'Clipboard access was blocked.');
    }
  };

  const clearTask = () => {
    if (!focusTask) return;
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setRawLog(log.filter((e) => e.taskId !== focusTask));
    setConfirmClear(false);
    toast('ok', `Cleared the log for task ${focusTask}.`);
  };

  return (
    <section className="stack" aria-label="Agent log">
      <h3>Agent log</h3>
      <p className="field-hint">Entries are what you record here. Nothing is collected from agents, models or the network. Data shown below and exported is redacted.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="row">
          <Field label="Log task">
            {(id) => (
              <select id={id} className="input mono" value={entryTask} disabled={tasks.length === 0} onChange={(e) => setEntryTask(e.target.value)}>
                {tasks.map((t) => <option key={t.id} value={t.id}>{t.id} · {truncate(t.title, 40)}</option>)}
              </select>
            )}
          </Field>
          <Field label="Level">
            {(id) => (
              <select id={id} className="input" value={level} onChange={(e) => setLevel(e.target.value as LogLevel)}>
                {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Field label="Message" hint={`Up to ${AGENT_LOG_LIMITS.messageChars} characters.`}>
          {(id, d) => <input id={id} aria-describedby={d} className="input" value={message} maxLength={AGENT_LOG_LIMITS.messageChars} onChange={(e) => setMessage(e.target.value)} />}
        </Field>
        <Field label="Data (optional)" hint={`Longer text is cut at ${AGENT_LOG_LIMITS.dataChars} characters. Keeps the newest ${AGENT_LOG_LIMITS.entriesPerTask} entries per task, ${AGENT_LOG_LIMITS.totalEntries} total.`}>
          {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={3} value={data} onChange={(e) => setData(e.target.value)} />}
        </Field>
        <div className="row">
          <Button type="submit" disabled={!entryTask || !message.trim()}>Add entry</Button>
          {tasks.length === 0 && <span className="sub">Add a task to the board before logging.</span>}
        </div>
      </form>

      <div className="row">
        <Field label="Filter task">
          {(id) => (
            <select id={id} className="input mono" value={filterTask} onChange={(e) => { setFilterTask(e.target.value); setConfirmClear(false); }}>
              <option value="">All tasks</option>
              {taskIds.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
        </Field>
        <Field label="Filter level">
          {(id) => (
            <select id={id} className="input" value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as LogLevel | '')}>
              <option value="">All levels</option>
              {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
        </Field>
        <Field label="Filter text">
          {(id) => <input id={id} className="input" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} />}
        </Field>
      </div>

      {summary && (
        <p className="sub mono" data-log-summary={summary.taskId}>
          {summary.taskId}: {LOG_LEVELS.map((l) => `${l} ${summary.counts[l]}`).join(' · ')} · {summary.lastResult ? `last result ${summary.lastResult.at}: ${summary.lastResult.message}` : 'No result recorded'}
        </p>
      )}
      <div className="row">
        <Button size="sm" disabled={log.length === 0} onClick={() => void exportJson()}>Export JSON</Button>
        <Button size="sm" variant="danger" disabled={!focusTask || !log.some((e) => e.taskId === focusTask)} onClick={clearTask}>
          {confirmClear ? `Confirm clear ${focusTask}` : 'Clear task log'}
        </Button>
        {confirmClear && <Button size="sm" variant="quiet" onClick={() => setConfirmClear(false)}>Keep log</Button>}
      </div>

      {shown.length === 0 ? (
        <Empty title="No log entries">{log.length === 0 ? 'Add an entry above.' : 'No entries match the filters.'}</Empty>
      ) : (
        <ol className="stack">
          {shown.map((e) => (
            <li key={e.id} className="stack" data-log-id={e.id}>
              <div className="row">
                <span className="sub mono">{e.at}</span>
                <span className="tl-kind">{e.level}</span>
                <span className="sub mono">{e.taskId}</span>
              </div>
              <span>{e.message}</span>
              {e.data && <pre className="mono" style={{ maxHeight: '12rem', overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>{redactSecrets(e.data).text}</pre>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SessionDiffList({ diff }: { diff: SessionDiff }) {
  return (
    <dl className="kv-list" aria-label="Session differences">
      <KV k="Only on current board">{diff.onlyInCurrent.length ? diff.onlyInCurrent.join(', ') : 'none'}</KV>
      <KV k="Only in session">{diff.onlyInIncoming.length ? diff.onlyInIncoming.join(', ') : 'none'}</KV>
      <KV k="Status changed">{diff.statusChanged.length ? diff.statusChanged.map((c) => `${c.taskId}: ${c.from} -> ${c.to}`).join(', ') : 'none'}</KV>
    </dl>
  );
}

/** Saved snapshots of the manual board state. Persisted via prefs; resuming replaces prefs and never starts a worker. */
function SessionsGroup({
  tasks,
  setTasks,
  logPref,
  budgetState,
  toast,
}: {
  tasks: BoardTask[];
  setTasks: (t: BoardTask[]) => void;
  logPref: [unknown, (v: unknown) => void];
  budgetState: ReturnType<typeof useTaskBudget>;
  toast: (tone: 'ok' | 'error', msg: string) => void;
}) {
  const [rawSessions, setRawSessions] = usePref<unknown>(AGENT_SESSION_PREF_KEY, []);
  const sessions = useMemo(() => normalizeSavedSessions(rawSessions), [rawSessions]);
  const [rawLog, setRawLog] = logPref;
  const [name, setName] = useState('');
  const [paste, setPaste] = useState('');
  const [validated, setValidated] = useState<ParsedSession | null>(null);
  const [validateError, setValidateError] = useState('');
  const [confirmKey, setConfirmKey] = useState('');
  const [resumed, setResumed] = useState<(ResumePlan & { name: string }) | null>(null);

  const save = () => {
    try {
      const s = buildSession({ name, tasks, log: normalizeLog(rawLog), budget: budgetState.budget, spend: budgetState.ledger, now: Date.now() });
      serializeSession(s);
      setRawSessions(upsertSession(sessions, s));
      setName('');
      toast('ok', `Session "${s.name}" saved with ${s.counts.tasks} tasks and ${s.counts.log} log entries.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const exportJson = async (s: AgentSession) => {
    try {
      await navigator.clipboard.writeText(serializeSession(s));
      toast('ok', `Session "${s.name}" copied as JSON with log secrets redacted.`);
    } catch (e) {
      toast('error', e instanceof Error && e.message.startsWith('$') ? e.message : 'Clipboard access was blocked.');
    }
  };

  const validate = () => {
    setConfirmKey('');
    try {
      setValidated(parseSession(paste));
      setValidateError('');
    } catch (e) {
      setValidated(null);
      setValidateError(e instanceof Error ? e.message : String(e));
    }
  };

  const resume = (key: string, s: AgentSession) => {
    if (confirmKey !== key) {
      setConfirmKey(key);
      return;
    }
    try {
      const plan = planResume(s, Date.now());
      setTasks(plan.tasks);
      setRawLog(s.log);
      budgetState.setBudget(s.budget);
      budgetState.setLedger(s.spend);
      setResumed({ ...plan, name: s.name });
      setConfirmKey('');
      toast('ok', `Session "${s.name}" restored. No worker was started.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const resumeControls = (key: string, s: AgentSession) => (
    <>
      <div className="row">
        <Button size="sm" variant={confirmKey === key ? 'danger' : undefined} onClick={() => resume(key, s)}>
          {confirmKey === key ? `Confirm resume "${s.name}"` : 'Resume'}
        </Button>
        {confirmKey === key && <Button size="sm" variant="quiet" onClick={() => setConfirmKey('')}>Keep current board</Button>}
      </div>
      {confirmKey === key && (
        <>
          <p className="sub">Resuming replaces the current board, agent log, budget and spend ledger with this session. Changes:</p>
          <SessionDiffList diff={diffSessions({ tasks }, s)} />
        </>
      )}
    </>
  );

  return (
    <section className="stack" aria-label="Sessions">
      <h3>Sessions</h3>
      <p className="field-hint">
        Sessions record the manual board state: tasks, agent log (secrets redacted), budget and spend. Resuming never starts a worker; tasks that were running are set to paused with a note.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Session name" hint={`Up to ${SESSION_LIMITS.name} characters. Keeps the newest ${SAVED_SESSIONS_CAP}; a session with the same name is replaced.`}>
          {(id, d) => <input id={id} aria-describedby={d} className="input" value={name} maxLength={SESSION_LIMITS.name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Button type="submit" disabled={!name.trim()}>Save session</Button>
      </form>

      {sessions.length === 0 ? (
        <Empty title="No saved sessions">Save the current board above.</Empty>
      ) : (
        <ul className="stack">
          {sessions.map((s) => (
            <li key={s.name} className="stack" data-session-name={s.name}>
              <div className="row">
                <strong>{s.name}</strong>
                <span className="sub mono">{s.savedAt}</span>
                <span className="sub mono">
                  tasks {s.counts.tasks} · log {s.counts.log} · running {s.counts.running} · paused {s.counts.paused} · queued {s.counts.queued}
                </span>
                <Button size="sm" onClick={() => void exportJson(s)}>Export JSON</Button>
              </div>
              {resumeControls(`saved:${s.name}`, s)}
            </li>
          ))}
        </ul>
      )}

      <Field label="Paste session JSON" hint={`Up to ${SESSION_LIMITS.jsonChars} characters. Validate before resuming.`}>
        {(id, d) => (
          <textarea
            id={id}
            aria-describedby={d}
            className="input mono"
            rows={4}
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              setValidated(null);
              setValidateError('');
              setConfirmKey('');
            }}
          />
        )}
      </Field>
      <div className="row">
        <Button size="sm" disabled={!paste.trim()} onClick={validate}>Validate</Button>
      </div>
      {validateError && <p className="sub mono" role="alert">{validateError}</p>}
      {validated && (
        <div className="stack" data-session-validated={validated.session.name}>
          <p className="sub mono">
            Valid session "{validated.session.name}" saved {validated.session.savedAt}: tasks {validated.session.counts.tasks} · log {validated.session.counts.log} · dropped tasks {validated.dropped.tasks} · dropped log {validated.dropped.log} · dropped spend {validated.dropped.spend}
          </p>
          <SessionDiffList diff={diffSessions({ tasks }, validated.session)} />
          {resumeControls('pasted', validated.session)}
        </div>
      )}

      {resumed && (
        <div className="stack" aria-label="Resume result">
          <h4>Resumed "{resumed.name}"</h4>
          {resumed.actions.length === 0 ? (
            <p className="sub">No task changed status.</p>
          ) : (
            <ul className="stack">
              {resumed.actions.map((a) => (
                <li key={a.taskId} className="sub mono">{`${a.taskId}: ${a.from} -> ${a.to} · ${a.reason}`}</li>
              ))}
            </ul>
          )}
          {resumed.warnings.length > 0 && (
            <ul className="stack" role="alert">
              {resumed.warnings.map((w) => <li key={w} className="sub">{w}</li>)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

const SKILLS_NOTE = 'Skills are templates derived from manually recorded tasks and logs. Saving or queuing a skill never starts a worker.';

/** Suggested skills from done tasks on this board plus their info/result log entries. Saved via prefs; queuing only adds a queued task. */
function SkillSuggestionsGroup({
  tasks,
  logPref,
  onQueue,
  toast,
}: {
  tasks: BoardTask[];
  logPref: [unknown, (v: unknown) => void];
  onQueue: (input: SkillTaskInput) => boolean;
  toast: (tone: 'ok' | 'error', msg: string) => void;
}) {
  const [rawSkills, setRawSkills] = usePref<unknown>(SKILLS_PREF_KEY, []);
  const skills = useMemo(() => normalizeSkills(rawSkills), [rawSkills]);
  const [confirmRemove, setConfirmRemove] = useState('');
  let suggestions: SkillSuggestion[] = [];
  let suggestError = '';
  try {
    suggestions = suggestSkills(tasks, normalizeLog(logPref[0]), { now: Date.now() });
  } catch (e) {
    suggestError = e instanceof Error ? e.message : String(e);
  }

  const save = (s: SkillSuggestion) => {
    try {
      setRawSkills(upsertSkill(skills, s.skill));
      toast('ok', `Skill "${s.skill.name}" saved. No worker was started.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const queue = (skill: Skill) => {
    try {
      if (onQueue(taskFromSkill(skill))) toast('ok', `Queued a task from skill "${skill.name}". No worker was started.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const remove = (id: string) => {
    if (confirmRemove !== id) {
      setConfirmRemove(id);
      return;
    }
    setRawSkills(removeSkill(skills, id));
    setConfirmRemove('');
    toast('ok', 'Skill removed.');
  };

  return (
    <section className="stack" aria-label="Suggested skills">
      <h3>Suggested skills</h3>
      <p className="field-hint">{SKILLS_NOTE}</p>
      {suggestError && <p className="sub mono" role="alert">{suggestError}</p>}
      {suggestions.length === 0 ? (
        <p className="sub">
          No suggestions yet. A suggestion appears once at least {SKILL_LIMITS.minOccurrences} done tasks with the same role and a similar title are recorded.
        </p>
      ) : (
        <ul className="stack">
          {suggestions.map((s) => (
            <li key={s.key} className="stack" data-skill-key={s.key}>
              <div className="row">
                <strong>{s.skill.name}</strong>
                <span className="sub mono">{s.skill.role}{s.skill.model ? ` · ${s.skill.model}` : ''}</span>
                <span className="sub mono">occurrences {s.occurrences} · last completed {s.lastCompletedAt}</span>
                <Button size="sm" onClick={() => save(s)}>{skills.some((k) => k.id === s.skill.id) ? 'Save as skill (replace)' : 'Save as skill'}</Button>
              </div>
              <span className="sub mono">source tasks {s.sourceTaskIds.join(', ')}</span>
              <span className="sub mono">scopes {s.skill.scopes.length ? s.skill.scopes.join(', ') : 'none recorded'}</span>
              {s.skill.steps.length === 0 ? (
                <span className="sub">No info or result log entries recorded for these tasks.</span>
              ) : (
                <ol className="stack">
                  {s.skill.steps.map((step, i) => <li key={`${i}:${step}`} className="sub">{step}</li>)}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>Saved skills</h4>
      {skills.length === 0 ? (
        <p className="sub">No saved skills. Keeps the newest {SKILL_LIMITS.skills}.</p>
      ) : (
        <ul className="stack">
          {skills.map((k) => (
            <li key={k.id} className="stack" data-skill-id={k.id}>
              <div className="row">
                <strong>{k.name}</strong>
                <span className="sub mono">{k.role}{k.model ? ` · ${k.model}` : ''} · saved {k.createdAt} · {k.steps.length} steps</span>
              </div>
              <div className="row">
                <Button size="sm" onClick={() => queue(k)}>Queue task from skill</Button>
                <Button size="sm" variant="danger" onClick={() => remove(k.id)}>{confirmRemove === k.id ? `Confirm remove "${k.name}"` : 'Remove'}</Button>
                {confirmRemove === k.id && <Button size="sm" variant="quiet" onClick={() => setConfirmRemove('')}>Keep skill</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
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
      {task.note && <span className="sub mono">{task.note}</span>}
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
  const [rawOverrides, setRawOverrides] = usePref<unknown>(ROLE_PREF_KEY, {});
  const { overrides, warnings: overrideWarnings } = normalizeOverrides(rawOverrides);
  const [role, setRole] = useState<string>('implementer');
  const [model, setModel] = useState<string>(() => recommendModel('implementer', BOARD_MODELS, overrides).model ?? BOARD_MODELS[1]);
  const [scopes, setScopes] = useState<string[]>(() => [...(getRole('implementer')?.toolScopes ?? [])]);
  const [recReason, setRecReason] = useState<string>(() => recommendModel('implementer', BOARD_MODELS, overrides).reason);
  const roleDef = getRole(role);
  const assignment = validateAssignment({ roleId: role, model, scopes });
  const chooseRole = (next: string) => {
    setRole(next);
    const rec = recommendModel(next, BOARD_MODELS, overrides);
    if (rec.model) setModel(rec.model);
    setRecReason(rec.reason);
    setScopes([...(getRole(next)?.toolScopes ?? [])]);
  };
  const toggleScope = (s: string, on: boolean) => setScopes(on ? [...scopes.filter((x) => x !== s), s] : scopes.filter((x) => x !== s));
  const saveOverride = (roleId: WorkerRoleId, defaultModel: string) => {
    const next: Record<string, unknown> = { ...overrides };
    if (defaultModel) next[roleId] = { defaultModel };
    else delete next[roleId];
    setRawOverrides(normalizeOverrides(next).overrides as RoleOverrides);
  };
  const workers = deriveWorkerStatus(tasks);
  const summary = summarizeBoard(tasks);
  const full = tasks.length >= TASK_BOARD_LIMITS.tasks;
  const budgetState = useTaskBudget(tasks);
  const logPref = usePref<unknown>(AGENT_LOG_PREF_KEY, []);
  const startBlocked = budgetState.startCheck.allowed ? undefined : budgetState.startCheck.detail;

  const add = (from?: SkillTaskInput): boolean => {
    try {
      const src = from ?? { title, role, model, scopes };
      if (from && tasks.length >= TASK_BOARD_LIMITS.tasks) throw new Error(`Board holds at most ${TASK_BOARD_LIMITS.tasks} tasks.`);
      const check = validateAssignment({ roleId: src.role, model: src.model, scopes: src.scopes });
      if (!check.ok) throw new Error(check.problems.join(' '));
      const ids = new Set(tasks.map((t) => t.id));
      const counter = { next: tasks.length };
      let task = createTask({ title: src.title, role: src.role, model: src.model }, Date.now(), counter);
      while (ids.has(task.id)) task = { ...task, id: task.id.replace(/-\d+$/, `-${counter.next++}`) };
      const chosen = TOOL_SCOPES.filter((s) => src.scopes.includes(s));
      // Scopes are kept in the existing note field (persisted by parseBoard) plus an additive optional field.
      const withScopes: BoardTask & { scopes?: string[] } = { ...task, scopes: chosen, note: `Scopes: ${chosen.join(', ')}` };
      setRawBoard([...tasks, withScopes]);
      if (!from) setTitle('');
      return true;
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
      return false;
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
              <select id={id} className="input" value={role} onChange={(e) => chooseRole(e.target.value)}>
                {WORKER_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Model" hint={recReason}>
            {(id, d) => (
              <select id={id} aria-describedby={d} className="input mono" value={model} onChange={(e) => setModel(e.target.value)}>
                {BOARD_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
          </Field>
        </div>
        <p className="field-hint">Roles describe intended scope for a task record; this build does not launch workers.</p>
        {roleDef && (
          <dl className="kv-list" aria-label="Role details">
            <KV k="Purpose">{roleDef.purpose}</KV>
            <KV k="Tool scopes">{roleDef.toolScopes.join(', ')}</KV>
            <KV k="Allowed models">{roleDef.allowedModels.join(', ')}</KV>
          </dl>
        )}
        <fieldset className="row" aria-label="Task scopes">
          <legend className="sub">Scopes for this task</legend>
          {TOOL_SCOPES.map((s) => (
            <label key={s} className="row">
              <input type="checkbox" checked={scopes.includes(s)} onChange={(e) => toggleScope(s, e.target.checked)} />
              <span className="mono">{s}</span>
            </label>
          ))}
        </fieldset>
        {!assignment.ok && (
          <ul className="stack" role="alert" aria-label="Assignment problems">
            {assignment.problems.map((p) => <li key={p} className="sub">{p}</li>)}
          </ul>
        )}
        <div className="row">
          <Button type="submit" disabled={!title.trim() || full || !assignment.ok}>Add queued task</Button>
          {full && <span className="sub">Board holds at most {TASK_BOARD_LIMITS.tasks} tasks.</span>}
        </div>
      </form>

      <section className="stack" aria-label="Role defaults">
        <h3>Role defaults</h3>
        <p className="field-hint">Default model chosen when you pick a role above. Only models allowed for that role are kept.</p>
        <div className="row">
          {WORKER_ROLES.map((r) => (
            <Field key={r.id} label={`${r.label} default`}>
              {(id) => (
                <select id={id} className="input mono" value={overrides[r.id]?.defaultModel ?? ''} onChange={(e) => saveOverride(r.id, e.target.value)}>
                  <option value="">Built-in ({r.defaultModel})</option>
                  {r.allowedModels.filter((m) => (BOARD_MODELS as readonly string[]).includes(m)).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              )}
            </Field>
          ))}
        </div>
        {overrideWarnings.length > 0 && (
          <ul className="stack">
            {overrideWarnings.map((w) => <li key={w} className="sub">{w}</li>)}
          </ul>
        )}
      </section>

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

      <AgentLogGroup tasks={tasks} toast={toast} logPref={logPref} />

      <SessionsGroup tasks={tasks} setTasks={setRawBoard} logPref={logPref} budgetState={budgetState} toast={toast} />

      <SkillSuggestionsGroup tasks={tasks} logPref={logPref} onQueue={(input) => add(input)} toast={toast} />
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
              <KV k="Theme">{typeof document !== 'undefined' ? document.documentElement.dataset.theme ?? 'dark' : 'dark'} (saved setting from earlier versions: {settings.theme})</KV>
              <KV k="Records">{state.capsules.length} capsules · {state.notes.length} notes · {state.tasks.length} tasks · {state.chat.length} messages</KV>
            </dl>
            <Button icon={Copy} onClick={() => void copy()}>Copy diagnostics</Button>
          </Panel>

          <CompanionRendererPanel />

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

/**
 * Numbers from the one shared companion renderer, read when the panel opens and on Refresh (this page runs no timers).
 * These are the renderer's own counters; nothing here is estimated.
 */
function CompanionRendererPanel() {
  const [stats, setStats] = useState<OrbStats>(() => orbStats());
  // Read again after the first paint, once the shell's placements have registered.
  useEffect(() => setStats(orbStats()), []);
  const backend = stats.backend === 'webgl' ? 'WebGL (one shared context)' : stats.backend === 'canvas2d' ? 'Canvas 2D fallback' : 'Not drawing (no companion on screen)';
  return (
    <Panel title="Companion renderer" eyebrow="This window">
      <dl className="kv-list">
        <KV k="Drawing with">{backend}</KV>
        <KV k="Graphics adapter">{stats.renderer ?? 'Not reported'}</KV>
        <KV k="Placements">{stats.visible} visible of {stats.placements}</KV>
        <KV k="Quality">{stats.quality === 'full' ? 'Full' : `Reduced${stats.qualityReason ? `: ${stats.qualityReason}` : ''}`}</KV>
        <KV k="Animation">{stats.running ? 'Running' : 'Paused (hidden, still or idle)'}</KV>
        <KV k="Frames drawn">{stats.frames.toLocaleString()} · last {stats.lastFrameMs.toFixed(1)} ms</KV>
        <KV k="Context losses">{stats.contextLosses}</KV>
      </dl>
      <Button size="sm" onClick={() => setStats(orbStats())}>Refresh</Button>
    </Panel>
  );
}
