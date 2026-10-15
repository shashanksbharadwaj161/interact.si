// Routines: visual editor, run controls and history for the local routine engine (electron/services/routines.ts).
// The API is injected by the captain (prop, or window.jarvis.routines once wired). Nothing here executes actions:
// every desktop step is previewed and confirmed natively by the main process when the routine runs.
import { useCallback, useEffect, useState } from 'react';
import { ArrowCounterClockwise, ArrowDown, ArrowUp, Clock, Pause, PencilSimple, Play, Plus, Stop, Trash, Lightning } from '@phosphor-icons/react';
import type { ActionRequest } from '../shared/contracts';
import type { RoutinePlan } from '../../electron/services/intent';
import type { Routine, RoutinesApi, RoutinesView, RoutineView, RunRecord, RunStatus, Schedule, ScheduleStatusKind, StepCondition, StepStatus } from '../../electron/services/routines';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, IconButton, Notice, PageHeader, Panel, Switch, type Tone } from '../ui/primitives';
import { cx, errMsg, fmtDateTime } from '../ui/util';

export type StepType = 'focus' | 'move-window' | 'type-text' | 'open-url' | 'launch' | 'list-windows';
export const STEP_TYPES: { value: StepType; label: string }[] = [
  { value: 'launch', label: 'Launch approved app or file' },
  { value: 'open-url', label: 'Open link' },
  { value: 'focus', label: 'Focus window' },
  { value: 'move-window', label: 'Move window' },
  { value: 'type-text', label: 'Type text into window' },
  { value: 'list-windows', label: 'List windows' },
];
export type CondKind = 'none' | 'prev-ok' | 'prev-failed' | 'window-present' | 'window-absent' | 'kept';
export type DraftStep = {
  key: string; id?: string; kind: 'action' | 'wait'; type: StepType; target: string; text: string;
  x: string; y: string; width: string; height: string; seconds: string;
  retries: number; retryDelaySeconds: number; onFailure: 'stop' | 'continue'; undoable: boolean; cond: CondKind; condMatch: string;
  /** Weekday/time condition set elsewhere; the editor keeps it unchanged instead of silently dropping it. */
  kept?: StepCondition;
};
export type ScheduleKind = Schedule['kind'];
export type Draft = { id?: string; name: string; enabled: boolean; schedule: ScheduleKind; at: string; time: string; days: number[]; minutes: string; steps: DraftStep[] };

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

export function blankStep(kind: 'action' | 'wait' = 'action', type: StepType = 'launch'): DraftStep {
  return { key: nextKey(), kind, type, target: '', text: '', x: '', y: '', width: '', height: '', seconds: '5', retries: 0, retryDelaySeconds: 5, onFailure: 'stop', undoable: false, cond: 'none', condMatch: '' };
}

export function blankDraft(): Draft {
  return { name: '', enabled: true, schedule: 'manual', at: '', time: '09:00', days: [1, 2, 3, 4, 5], minutes: '60', steps: [blankStep()] };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** ISO instant → value for <input type="datetime-local"> in local time. */
export function toLocalInput(isoValue: string): string {
  const d = new Date(isoValue);
  return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}

export function routineToDraft(r: Routine): Draft {
  const d: Draft = { ...blankDraft(), id: r.id, name: r.name, enabled: r.enabled, schedule: r.schedule.kind, steps: [] };
  if (r.schedule.kind === 'once') d.at = toLocalInput(r.schedule.at);
  if (r.schedule.kind === 'daily') { d.time = r.schedule.time; d.days = [...r.schedule.days]; }
  if (r.schedule.kind === 'interval') d.minutes = String(r.schedule.minutes);
  for (const s of r.steps) {
    const st = blankStep(s.kind);
    st.id = s.id;
    const c = s.condition;
    st.cond = !c ? 'none' : c.kind === 'previous' ? (c.is === 'succeeded' ? 'prev-ok' : 'prev-failed') : c.kind === 'window' ? (c.present ? 'window-present' : 'window-absent') : 'none';
    if (c?.kind === 'window') st.condMatch = c.match;
    if (c?.kind === 'weekday' || c?.kind === 'time') { st.cond = 'kept'; st.kept = c; }
    if (s.kind === 'wait') st.seconds = String(s.seconds);
    else {
      const q = s.request;
      Object.assign(st, { type: q.type as StepType, target: q.target ?? '', text: q.text ?? '', retries: s.retries, retryDelaySeconds: s.retryDelaySeconds, onFailure: s.onFailure, undoable: s.undoable });
      for (const k of ['x', 'y', 'width', 'height'] as const) st[k] = q[k] === undefined ? '' : String(q[k]);
    }
    d.steps.push(st);
  }
  return d;
}

const NEEDS_TARGET: StepType[] = ['focus', 'move-window', 'type-text', 'open-url', 'launch'];

/** Client-side checks for immediate feedback. The engine validates everything again before saving. */
export function draftIssues(d: Draft): string[] {
  const out: string[] = [];
  if (!d.name.trim()) out.push('Give the routine a name.');
  if (!d.steps.length) out.push('Add at least one step.');
  if (d.steps.length > 20) out.push('A routine can have at most 20 steps.');
  if (d.schedule === 'once' && !Number.isFinite(Date.parse(d.at))) out.push('Choose the date and time for the one-time run.');
  if (d.schedule === 'daily' && !d.days.length) out.push('Choose at least one weekday.');
  if (d.schedule === 'interval' && !(/^\d+$/.test(d.minutes) && +d.minutes >= 5 && +d.minutes <= 1440)) out.push('Repeat every 5 to 1440 minutes.');
  d.steps.forEach((s, i) => {
    const n = `Step ${i + 1}`;
    if (s.kind === 'wait') { if (!(/^\d+$/.test(s.seconds) && +s.seconds >= 1 && +s.seconds <= 300)) out.push(`${n}: wait 1 to 300 seconds.`); return; }
    if (NEEDS_TARGET.includes(s.type) && !s.target.trim()) out.push(`${n}: ${s.type === 'open-url' ? 'enter the link' : s.type === 'launch' ? 'choose the app or file' : 'name the window'}.`);
    if (s.type === 'type-text' && !s.text) out.push(`${n}: enter the text to type.`);
    if (s.type === 'move-window') for (const k of ['x', 'y', 'width', 'height'] as const) if (!/^-?\d+$/.test(s[k])) out.push(`${n}: ${k} must be a whole number.`);
    if ((s.cond === 'window-present' || s.cond === 'window-absent') && !s.condMatch.trim()) out.push(`${n}: name the window for the condition.`);
    if (i === 0 && (s.cond === 'prev-ok' || s.cond === 'prev-failed')) out.push('Step 1 cannot depend on a previous step.');
  });
  return out;
}

/** Draft → payload for RoutinesApi.save. */
export function draftToPayload(d: Draft): Record<string, unknown> {
  const schedule: Schedule =
    d.schedule === 'once' ? { kind: 'once', at: new Date(d.at).toISOString() }
    : d.schedule === 'daily' ? { kind: 'daily', time: d.time, days: [...d.days].sort() }
    : d.schedule === 'interval' ? { kind: 'interval', minutes: Number(d.minutes) }
    : { kind: 'manual' };
  const steps = d.steps.map((s) => {
    const base: Record<string, unknown> = s.id ? { id: s.id } : {};
    if (s.cond === 'prev-ok' || s.cond === 'prev-failed') base.condition = { kind: 'previous', is: s.cond === 'prev-ok' ? 'succeeded' : 'failed' };
    if (s.cond === 'window-present' || s.cond === 'window-absent') base.condition = { kind: 'window', match: s.condMatch.trim(), present: s.cond === 'window-present' };
    if (s.cond === 'kept' && s.kept) base.condition = s.kept;
    if (s.kind === 'wait') return { ...base, kind: 'wait', seconds: Number(s.seconds) };
    const request: ActionRequest = { type: s.type };
    if (NEEDS_TARGET.includes(s.type)) request.target = s.target.trim();
    if (s.type === 'type-text') request.text = s.text;
    if (s.type === 'move-window') for (const k of ['x', 'y', 'width', 'height'] as const) request[k] = Number(s[k]);
    return { ...base, kind: 'action', request, retries: s.retries, retryDelaySeconds: s.retryDelaySeconds, onFailure: s.onFailure, undoable: s.type === 'move-window' && s.undoable };
  });
  return { ...(d.id ? { id: d.id } : {}), name: d.name.trim(), enabled: d.enabled, schedule, steps };
}

/** Planner candidates → editor steps. Only 'ready' plans produce steps. */
export function candidatesToSteps(plan: RoutinePlan): DraftStep[] {
  if (plan.status !== 'ready') return [];
  return plan.steps.map((c) => {
    if (c.kind === 'wait') return { ...blankStep('wait'), seconds: String(c.seconds) };
    const s = blankStep('action', c.request.type as StepType);
    s.target = c.request.target ?? '';
    s.text = c.request.text ?? '';
    for (const k of ['x', 'y', 'width', 'height'] as const) s[k] = c.request[k] === undefined ? '' : String(c.request[k]);
    return s;
  });
}

export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'manual': return 'Manual only';
    case 'once': return `Once, ${fmtDateTime(s.at)}`;
    case 'interval': return `Every ${s.minutes} min`;
    case 'daily': return `${s.days.length === 7 ? 'Daily' : s.days.map((d) => DAY_NAMES[d]).join(', ')} at ${s.time}`;
  }
}

const dayList = (days: number[]) => (days.length === 7 ? 'every day' : days.map((d) => DAY_NAMES[d]).join(', '));
export function describeCondition(c: StepCondition): string {
  return c.kind === 'weekday' ? `Only on ${dayList(c.days)}` : c.kind === 'time' ? `Only between ${c.start} and ${c.end}` : 'Conditional';
}

/** Lossless payload for RoutinesApi.save from a stored routine (used for pause/resume of one schedule). */
export function routinePayload(r: Routine, enabled: boolean = r.enabled): Record<string, unknown> {
  return { id: r.id, name: r.name, enabled, schedule: r.schedule, steps: r.steps };
}

export const SCHEDULE_STATE_LABEL: Record<ScheduleStatusKind, string> = {
  manual: 'Manual', disabled: 'Schedule off', paused: 'Paused', running: 'Running', overdue: 'Overdue', completed: 'Done', scheduled: 'Scheduled',
};
export function scheduleTone(k: ScheduleStatusKind): Tone {
  return k === 'overdue' ? 'warn' : k === 'running' ? 'info' : k === 'scheduled' || k === 'completed' ? 'ok' : 'muted';
}

export type HistoryFilter = 'all' | 'problems' | 'scheduled';
const PROBLEM_STATUS: RunStatus[] = ['failed', 'partial', 'declined', 'cancelled', 'interrupted', 'missed', 'skipped'];
const RETRYABLE: RunStatus[] = ['failed', 'partial', 'declined', 'cancelled', 'interrupted'];
export function filterRuns(runs: RunRecord[], f: HistoryFilter): RunRecord[] {
  return f === 'problems' ? runs.filter((r) => PROBLEM_STATUS.includes(r.status)) : f === 'scheduled' ? runs.filter((r) => r.trigger === 'schedule' || r.slot !== undefined) : runs;
}
export function durationText(start?: string, end?: string): string {
  const a = Date.parse(start ?? ''), b = Date.parse(end ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
  const sec = Math.round((b - a) / 1000);
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}
const canRetry = (r: RunRecord) => RETRYABLE.includes(r.status) && r.steps.some((s) => s.status !== 'succeeded' && s.status !== 'skipped' || (s.status === 'skipped' && /^Stopped/.test(s.reason ?? '')));

export function statusTone(s: RunStatus | StepStatus): Tone {
  if (s === 'succeeded') return 'ok';
  if (s === 'partial' || s === 'paused' || s === 'skipped' || s === 'missed' || s === 'interrupted') return 'warn';
  if (s === 'failed' || s === 'blocked' || s === 'declined') return 'danger';
  if (s === 'running' || s === 'pending') return 'info';
  return 'muted';
}

const canUndo = (r: RunRecord) => r.steps.some((s) => s.status === 'succeeded' && s.undo && !s.undo.undone);

function resolveApi(api?: RoutinesApi): RoutinesApi | null {
  if (api) return api;
  const w = (globalThis as { jarvis?: { routines?: RoutinesApi } }).jarvis;
  return w?.routines ?? null;
}

function StepEditor({ s, i, count, onChange, onMove, onRemove }: { s: DraftStep; i: number; count: number; onChange: (p: Partial<DraftStep>) => void; onMove: (dir: -1 | 1) => void; onRemove: () => void }) {
  return (
    <li className="list-row routine-step">
      <div className="stack tight grow">
        <div className="row wrap">
          <strong>Step {i + 1}</strong>
          {s.kind === 'action' ? (
            <Field label="Action">{(id) => <select id={id} className="input" value={s.type} onChange={(e) => onChange({ type: e.target.value as StepType, undoable: false })}>{STEP_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>}</Field>
          ) : (
            <Field label="Wait (seconds, 1–300)">{(id) => <input id={id} className="input" inputMode="numeric" value={s.seconds} onChange={(e) => onChange({ seconds: e.target.value.replace(/[^\d]/g, '').slice(0, 3) })} />}</Field>
          )}
          <Field label="Run when">{(id) => (
            <select id={id} className="input" value={s.cond} onChange={(e) => onChange({ cond: e.target.value as CondKind })}>
              <option value="none">Always</option>
              {i > 0 && <option value="prev-ok">Previous step succeeded</option>}
              {i > 0 && <option value="prev-failed">Previous step failed</option>}
              <option value="window-present">A window is open</option>
              <option value="window-absent">A window is not open</option>
              {s.kept && <option value="kept">{describeCondition(s.kept)} (kept)</option>}
            </select>
          )}</Field>
          {(s.cond === 'window-present' || s.cond === 'window-absent') && <Field label="Window title or process">{(id) => <input id={id} className="input" value={s.condMatch} maxLength={260} onChange={(e) => onChange({ condMatch: e.target.value })} />}</Field>}
        </div>
        {s.kind === 'action' && (
          <div className="row wrap">
            {NEEDS_TARGET.includes(s.type) && (
              <Field label={s.type === 'open-url' ? 'Link (https://…)' : s.type === 'launch' ? 'Approved app or file path' : 'Window (title, process or hwnd:<n>)'} className="grow">
                {(id) => <input id={id} className="input" value={s.target} maxLength={260} onChange={(e) => onChange({ target: e.target.value })} />}
              </Field>
            )}
            {s.type === 'type-text' && <Field label="Text to type" className="grow">{(id) => <input id={id} className="input" value={s.text} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} />}</Field>}
            {s.type === 'move-window' && (['x', 'y', 'width', 'height'] as const).map((k) => (
              <Field key={k} label={k}>{(id) => <input id={id} className="input" inputMode="numeric" size={6} value={s[k]} onChange={(e) => onChange({ [k]: e.target.value.replace(/[^\d-]/g, '').slice(0, 7) })} />}</Field>
            ))}
            <Field label="Retries">{(id) => <select id={id} className="input" value={s.retries} onChange={(e) => onChange({ retries: Number(e.target.value) })}>{[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}</select>}</Field>
            <Field label="If it fails">{(id) => <select id={id} className="input" value={s.onFailure} onChange={(e) => onChange({ onFailure: e.target.value as 'stop' | 'continue' })}><option value="stop">Stop the routine</option><option value="continue">Continue</option></select>}</Field>
            {s.type === 'move-window' && <Switch checked={s.undoable} onChange={(v) => onChange({ undoable: v })} label="Undoable" description="Remembers the window's position so the move can be reversed." />}
          </div>
        )}
      </div>
      <div className="row">
        <IconButton icon={ArrowUp} label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => onMove(-1)} />
        <IconButton icon={ArrowDown} label={`Move step ${i + 1} down`} disabled={i === count - 1} onClick={() => onMove(1)} />
        <IconButton icon={Trash} label={`Remove step ${i + 1}`} onClick={onRemove} />
      </div>
    </li>
  );
}

function Editor({ api, initial, onSaved, onClose }: { api: RoutinesApi; initial: Draft; onSaved: (v: RoutinesView) => void; onClose: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [text, setText] = useState('');
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileText, setFileText] = useState('');
  const [importMsg, setImportMsg] = useState<{ tone: 'info' | 'warn' | 'danger'; title: string; lines: string[] } | null>(null);
  const issues = draftIssues(d);
  const setStep = (i: number, p: Partial<DraftStep>) => setD((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) }));
  const move = (i: number, dir: -1 | 1) => setD((x) => { const steps = [...x.steps]; [steps[i], steps[i + dir]] = [steps[i + dir], steps[i]]; return { ...x, steps }; });

  const addFromText = async () => {
    setPlanMsg(null);
    try {
      const plan = await api.planText(text);
      if (plan.status !== 'ready') { setPlanMsg(plan.reason); return; }
      setD((x) => ({ ...x, steps: [...x.steps.filter((s) => s.kind === 'wait' || s.target || s.type === 'list-windows'), ...candidatesToSteps(plan)].slice(0, 20) }));
      setPlanMsg(`Added ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}. Review them before saving.`);
      setText('');
    } catch (e) { setPlanMsg(errMsg(e)); }
  };
  // The engine validates the file (size, fields, step types, links). The result only fills this editor; nothing is saved or enabled.
  const checkFile = async () => {
    setImportMsg(null);
    try {
      const res = await api.importPreview!(fileText);
      if (res.status !== 'ready') { setImportMsg({ tone: 'danger', title: 'Not imported', lines: [res.reason] }); return; }
      const imported = routineToDraft({ id: 'import', createdAt: '', updatedAt: '', ...res.routine });
      setD((x) => ({ ...x, name: x.name.trim() ? x.name : imported.name, steps: imported.steps.map((st) => ({ ...st, id: undefined })) }));
      setImportMsg({ tone: 'info', title: `Loaded ${res.routine.steps.length} step${res.routine.steps.length === 1 ? '' : 's'} into the editor`, lines: res.warnings });
      setFileText('');
    } catch (e) { setImportMsg({ tone: 'danger', title: 'Not imported', lines: [errMsg(e)] }); }
  };
  const save = async () => {
    if (issues.length) return;
    setBusy(true); setError(null);
    try { onSaved(await api.save(draftToPayload(d))); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Panel title={d.id ? 'Edit routine' : 'New routine'} eyebrow="Editor">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="row wrap">
          <Field label="Name" className="grow">{(id) => <input id={id} className="input" value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
          <Switch checked={d.enabled} onChange={(v) => setD({ ...d, enabled: v })} label="Enabled" description="Disabled routines keep their steps but never run on schedule." />
        </div>
        <fieldset className="stack tight">
          <legend>Schedule</legend>
          <div className="chips" role="group" aria-label="Schedule type">
            {(['manual', 'once', 'daily', 'interval'] as const).map((k) => (
              <button key={k} type="button" className={cx('chip', d.schedule === k && 'on')} aria-pressed={d.schedule === k} onClick={() => setD({ ...d, schedule: k })}>{{ manual: 'Manual', once: 'Once', daily: 'Daily', interval: 'Repeat' }[k]}</button>
            ))}
          </div>
          {d.schedule === 'once' && <Field label="Date and time">{(id) => <input id={id} type="datetime-local" className="input" value={d.at} onChange={(e) => setD({ ...d, at: e.target.value })} />}</Field>}
          {d.schedule === 'daily' && (
            <div className="row wrap">
              <Field label="Time">{(id) => <input id={id} type="time" className="input" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} />}</Field>
              <div className="chips" role="group" aria-label="Weekdays">
                {DAY_NAMES.map((n, i) => <button key={n} type="button" className={cx('chip', d.days.includes(i) && 'on')} aria-pressed={d.days.includes(i)} onClick={() => setD({ ...d, days: d.days.includes(i) ? d.days.filter((x) => x !== i) : [...d.days, i] })}>{n}</button>)}
              </div>
            </div>
          )}
          {d.schedule === 'interval' && <Field label="Every (minutes, 5–1440)">{(id) => <input id={id} className="input" inputMode="numeric" value={d.minutes} onChange={(e) => setD({ ...d, minutes: e.target.value.replace(/[^\d]/g, '').slice(0, 4) })} />}</Field>}
          {d.schedule !== 'manual' && <p className="muted">At the scheduled time you are asked to confirm the run, and each desktop step asks again. Times missed while the app was closed are recorded, not run late.</p>}
        </fieldset>
        <ol className="list" aria-label="Steps">
          {d.steps.map((s, i) => <StepEditor key={s.key} s={s} i={i} count={d.steps.length} onChange={(p) => setStep(i, p)} onMove={(dir) => move(i, dir)} onRemove={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })} />)}
        </ol>
        <div className="row wrap">
          <Button icon={Plus} disabled={d.steps.length >= 20} onClick={() => setD({ ...d, steps: [...d.steps, blankStep()] })}>Add action</Button>
          <Button icon={Clock} disabled={d.steps.length >= 20} onClick={() => setD({ ...d, steps: [...d.steps, blankStep('wait')] })}>Add wait</Button>
        </div>
        <Field label="Add steps from commands (one per line)" hint='For example: open https://example.com · wait 5 seconds · focus "Inbox - Mail"'>
          {(id, desc) => <textarea id={id} aria-describedby={desc} className="input" rows={3} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />}
        </Field>
        <div className="row"><Button icon={Lightning} disabled={!text.trim()} onClick={() => void addFromText()}>Plan steps</Button></div>
        {planMsg && <p role="status" className="muted">{planMsg}</p>}
        {api.importPreview && (
          <details>
            <summary>Import from a routine file</summary>
            <div className="stack tight">
              <Field label="Routine file text" hint="Paste text exported from this app. Steps replace the ones above; schedules are never imported and the routine stays under your control.">
                {(id, desc) => <textarea id={id} aria-describedby={desc} className="input" rows={4} value={fileText} maxLength={65536} onChange={(e) => setFileText(e.target.value)} />}
              </Field>
              <div className="row"><Button disabled={!fileText.trim()} onClick={() => void checkFile()}>Check and load</Button></div>
              {importMsg && <Notice tone={importMsg.tone} title={importMsg.title}><ul>{importMsg.lines.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
            </div>
          </details>
        )}
        {issues.length > 0 && <Notice tone="warn" title="Before saving"><ul>{issues.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
        {error && <Notice tone="danger" title="Not saved">{error}</Notice>}
        <div className="row">
          <Button type="submit" variant="primary" busy={busy} disabled={issues.length > 0}>Save routine</Button>
          <Button variant="quiet" onClick={onClose}>Close editor</Button>
        </div>
      </form>
    </Panel>
  );
}

function RunCard({ r, active, onCancel, onUndo, onRetry }: { r: RunRecord; active: boolean; onCancel: () => void; onUndo: () => void; onRetry?: () => void }) {
  const done = r.steps.filter((s) => s.status === 'succeeded').length;
  const took = durationText(r.startedAt, r.endedAt);
  return (
    <li className="list-row">
      <details className="grow">
        <summary>
          <span>{r.routineName}</span> <Badge tone={statusTone(r.status)}>{r.status}</Badge> <span className="muted">{r.trigger === 'schedule' ? 'scheduled' : r.retryOf ? 'retry' : r.slot ? 'recovery' : 'manual'} · {fmtDateTime(r.startedAt || r.slot)}{r.steps.length ? ` · ${done}/${r.steps.length} steps` : ''}{took ? ` · ${took}` : ''}</span>
        </summary>
        {r.reason && <p className="muted">{r.reason}</p>}
        {r.status === 'paused' && <p className="muted">Waiting before the next step. Use Resume all to continue or Cancel to stop.</p>}
        <ol className="stack tight">
          {r.steps.map((s) => (
            <li key={s.stepId}>
              <Badge tone={statusTone(s.status)}>{s.status}</Badge> {s.summary ?? s.label}
              {s.attempts > 1 && <span className="muted"> · {s.attempts} attempts</span>}
              {s.reason && <span className="muted"> · {s.reason}</span>}
              {s.undo && <span className="muted"> · {s.undo.undone ? 'undone' : `undo: ${s.undo.summary}`}{s.undo.result && !s.undo.undone ? ` (${s.undo.result})` : ''}</span>}
            </li>
          ))}
        </ol>
      </details>
      {active && <Button size="sm" variant="danger" icon={Stop} onClick={onCancel}>Cancel</Button>}
      {!active && onRetry && canRetry(r) && <Button size="sm" icon={Play} onClick={onRetry}>Retry unfinished steps</Button>}
      {!active && canUndo(r) && <Button size="sm" icon={ArrowCounterClockwise} onClick={onUndo}>Undo moves</Button>}
    </li>
  );
}

export function Routines({ api: injected, initialView }: { api?: RoutinesApi; initialView?: RoutinesView }) {
  const api = resolveApi(injected);
  const [view, setView] = useState<RoutinesView | null>(initialView ?? null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [del, setDel] = useState<RoutineView | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [exported, setExported] = useState<{ name: string; text: string } | null>(null);

  const refresh = useCallback(async () => { if (api) try { setView(await api.list()); } catch (e) { setMsg({ tone: 'danger', text: errMsg(e) }); } }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  const active = view?.activeRunId ?? null;
  const activeRoutineId = active ? view?.runs.find((x) => x.id === active)?.routineId : undefined;
  const overdue = (view?.routines ?? []).filter((r) => r.scheduleStatus?.state === 'overdue');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [active, refresh]);

  const call = async <T,>(op: () => Promise<T>, ok?: string) => {
    setMsg(null);
    try { const r = await op(); if (ok) setMsg({ tone: 'info', text: ok }); await refresh(); return r; } catch (e) { setMsg({ tone: 'danger', text: errMsg(e) }); return undefined; }
  };

  if (!api) {
    return (
      <div className="page page-wide">
        <PageHeader eyebrow="Automation" title="Routines" />
        <Notice tone="warn" title="Routines are not connected">The routine engine is not available in this build, so routines cannot be created or run.</Notice>
      </div>
    );
  }

  const shownRuns = view ? filterRuns(view.runs, filter) : [];
  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Automation" title="Routines" subtitle="Saved step lists you run by hand or on a schedule. Every desktop step asks for confirmation before it runs."
        actions={<>
          {view?.paused ? <Button icon={Play} onClick={() => void call(() => api.resumeAll(), 'Routines resumed.')}>Resume all</Button> : <Button icon={Pause} onClick={() => void call(() => api.pauseAll(), 'All routines paused.')}>Pause all</Button>}
          <Button variant="primary" icon={Plus} onClick={() => setEditing(blankDraft())}>New routine</Button>
        </>} />
      <div className="stack">
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {view?.paused && <Notice tone="warn" title="Paused">No schedules run and a running routine waits before its next step. Times that pass while paused are skipped and listed as overdue.</Notice>}
        {view?.loadError && <Notice tone="warn" title="Some routines were not loaded">{view.loadError}</Notice>}
        {view?.saveError && <Notice tone="danger" title="Not saved to disk">{view.saveError}</Notice>}
        {overdue.map((r) => (
          <Notice key={r.id} tone="warn" title={`“${r.name}” is overdue`}>
            <p>It was due {fmtDateTime(r.scheduleStatus.overdueSlot)}: {r.scheduleStatus.overdueReason ?? 'it did not run'}. It is never run late on its own.</p>
            <div className="row">
              {api.recover && <Button size="sm" variant="primary" icon={Play} disabled={!!active || view?.paused} onClick={() => void call(() => api.recover!(r.id), `Started the overdue run of “${r.name}”. Confirm each step when asked.`)}>Run now…</Button>}
              {api.dismissOverdue && <Button size="sm" onClick={() => void call(async () => setView(await api.dismissOverdue!(r.id)), 'Overdue run dismissed.')}>Dismiss</Button>}
            </div>
          </Notice>
        ))}
        {editing && <Editor key={editing.id ?? 'new'} api={api} initial={editing} onClose={() => setEditing(null)} onSaved={(v) => { setView(v); setEditing(null); setMsg({ tone: 'info', text: 'Routine saved.' }); }} />}
        {exported && (
          <Panel title={`Routine file: ${exported.name}`} eyebrow="Export">
            <Field label="Copy this text" hint="Steps only. Schedules are never imported, and links, apps and windows are shown as written.">
              {(id, desc) => <textarea id={id} aria-describedby={desc} className="input" rows={6} readOnly value={exported.text} onFocus={(e) => e.currentTarget.select()} />}
            </Field>
            <div className="row"><Button variant="quiet" onClick={() => setExported(null)}>Close</Button></div>
          </Panel>
        )}
        <Panel title="Your routines" eyebrow="Library">
          {!view ? <p className="muted">Loading…</p> : view.routines.length === 0 ? (
            <Empty icon={Lightning} title="No routines yet">Create one with “New routine”. Steps can launch approved apps, open links, focus, move or type into windows, and wait.</Empty>
          ) : (
            <ul className="list">
              {view.routines.map((r) => {
                const ss = r.scheduleStatus;
                const scheduled = r.schedule.kind !== 'manual';
                return (
                  <li key={r.id} className="list-row">
                    <span className="grow"><strong>{r.name}</strong> <span className="muted">· {r.steps.length} step{r.steps.length === 1 ? '' : 's'} · {describeSchedule(r.schedule)}{r.nextDueAt ? ` · next ${fmtDateTime(r.nextDueAt)}` : ''}{ss?.lastRunAt ? ` · last run ${fmtDateTime(ss.lastRunAt)}${ss.lastResult ? ` (${ss.lastResult})` : ''}` : ''}{ss?.missedCount ? ` · ${ss.missedCount} missed` : ''}</span></span>
                    {scheduled && ss && <Badge tone={scheduleTone(ss.state)}>{SCHEDULE_STATE_LABEL[ss.state]}</Badge>}
                    {!r.enabled && <Badge tone="muted">Disabled</Badge>}
                    {scheduled && <Button size="sm" icon={r.enabled ? Pause : Play} disabled={activeRoutineId === r.id} onClick={() => void call(async () => setView(await api.save(routinePayload(r, !r.enabled))), r.enabled ? `Schedule for “${r.name}” turned off.` : `Schedule for “${r.name}” turned on. Times in the past are not run.`)}>{r.enabled ? 'Pause schedule' : 'Resume schedule'}</Button>}
                    <Button size="sm" variant="primary" icon={Play} disabled={!!active || view.paused} onClick={() => void call(() => api.start(r.id), `Started “${r.name}”. Confirm each step when asked.`)}>Run</Button>
                    {api.exportRoutine && <Button size="sm" onClick={() => void call(async () => setExported({ name: r.name, text: await api.exportRoutine!(r.id) }))}>Export</Button>}
                    <IconButton icon={PencilSimple} label={`Edit ${r.name}`} onClick={() => setEditing(routineToDraft(r))} />
                    <IconButton icon={Trash} label={`Delete ${r.name}`} disabled={activeRoutineId === r.id} onClick={() => setDel(r)} />
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
        <Panel title="Run history" eyebrow="Results">
          {!view?.runs.length ? <p className="muted">No runs yet. Results, partial failures and skipped steps appear here.</p> : (
            <div className="stack tight">
              <div className="chips" role="group" aria-label="Filter history">
                {(['all', 'problems', 'scheduled'] as const).map((k) => <button key={k} type="button" className={cx('chip', filter === k && 'on')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{{ all: 'All', problems: 'Needs attention', scheduled: 'Scheduled' }[k]}</button>)}
              </div>
              {shownRuns.length === 0 && <p className="muted">No runs match this filter.</p>}
              <ul className="list">
                {shownRuns.map((r) => <RunCard key={r.id} r={r} active={r.id === active}
                  onRetry={api.retry ? () => void call(() => api.retry!(r.id), `Retrying the unfinished steps of “${r.routineName}”. Confirm each step when asked.`) : undefined}
                  onCancel={() => void call(() => api.cancel(r.id), 'Cancelling after the current step.')}
                  onUndo={() => void call(async () => { const u = await api.undo(r.id); setMsg({ tone: u.failed ? 'danger' : 'info', text: u.reason ?? `${u.undone} move${u.undone === 1 ? '' : 's'} reversed${u.failed ? `, ${u.failed} not reversed` : ''}.` }); })} />)}
              </ul>
            </div>
          )}
        </Panel>
        <Panel title="Not available yet" eyebrow="Experimental">
          <ul className="list">
            {(view?.gates ?? []).map((g) => (
              <li key={g.id} className="list-row"><span className="grow"><strong>{g.name}</strong> <span className="muted">· {g.reason}</span></span><Badge tone="muted">Unavailable</Badge></li>
            ))}
          </ul>
        </Panel>
      </div>
      <ConfirmDialog open={del !== null} title={`Delete “${del?.name ?? ''}”?`} confirmLabel="Delete" danger onCancel={() => setDel(null)}
        onConfirm={() => { const r = del; setDel(null); if (r) void call(() => api.remove(r.id), 'Routine deleted.'); }}>
        The routine and its schedule are removed. Run history is kept.
      </ConfirmDialog>
    </div>
  );
}
