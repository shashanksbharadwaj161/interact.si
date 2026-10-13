import { useMemo, useState } from 'react';
import { FolderOpen, MagnifyingGlass, ShieldCheck, ShieldWarning, WarningCircle } from '@phosphor-icons/react';
import type { ActionPreview, ActionRequest } from '../shared/contracts';
import { Dialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, KV, Notice, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { cx, errMsg, parseHttpUrl, relTime, safeJson, truncate } from '../ui/util';

type ActionType = ActionRequest['type'];
type Risk = 'low' | 'medium' | 'high';

const TYPES: Record<ActionType, { label: string; risk: Risk; does: string; scope: string; needs: string }> = {
  'list-windows': { label: 'List windows', risk: 'low', does: 'Reads the titles and process names of open windows.', scope: 'Read-only. Does not change, focus or close anything. Window titles can contain private information such as document names.', needs: 'No target.' },
  'open-url': { label: 'Open URL', risk: 'low', does: 'Opens an http or https address in the default browser.', scope: 'Hands the address to Windows. The page itself is not read or controlled.', needs: 'A web address.' },
  launch: { label: 'Launch app', risk: 'medium', does: 'Starts an application.', scope: 'Starts a program with your user rights. It should be on your approved apps list; the preview tells you if it is not.', needs: 'App name or full path.' },
  focus: { label: 'Focus window', risk: 'medium', does: 'Brings an existing window to the front.', scope: 'Changes which window is active. It does not read the window contents.', needs: 'Part of a window title or a process name.' },
  'move-window': { label: 'Move / resize window', risk: 'medium', does: 'Repositions and resizes one window.', scope: 'Changes window geometry only, in screen pixels.', needs: 'Window target plus x, y, width and height.' },
  'type-text': { label: 'Type text', risk: 'high', does: 'Sends keystrokes as if you typed them.', scope: 'Text goes to whichever window has focus when it runs, which may not be the one you meant. Never use this for passwords or secrets.', needs: 'The text to type and, optionally, a window to focus first.' },
  click: { label: 'Click', risk: 'high', does: 'Clicks at a screen position.', scope: 'A click can press anything under that point, including buttons that send, delete or purchase. Positions change when windows move.', needs: 'Screen x and y in pixels.' },
};

type Form = { type: ActionType; target: string; text: string; x: string; y: string; width: string; height: string };
const blank = (): Form => ({ type: 'list-windows', target: '', text: '', x: '', y: '', width: '', height: '' });

function intIn(v: string, lo: number, hi: number): number | null {
  if (!/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= lo && n <= hi ? n : null;
}

function buildAction(f: Form): { action?: ActionRequest; errors: Record<string, string> } {
  const e: Record<string, string> = {};
  const a: ActionRequest = { type: f.type };
  const t = f.target.trim();
  if (f.type === 'launch' || f.type === 'focus' || f.type === 'move-window') {
    if (!t) e.target = f.type === 'launch' ? 'Enter an app name or path.' : 'Enter a window title or process name.';
    a.target = t.slice(0, 500);
  }
  if (f.type === 'open-url') {
    if (!parseHttpUrl(t)) e.target = 'Enter a full http:// or https:// address.';
    a.target = t;
  }
  if (f.type === 'type-text') {
    if (!f.text) e.text = 'Enter the text to type.';
    if (t) a.target = t;
    a.text = f.text.slice(0, 2000);
  }
  if (f.type === 'click' || f.type === 'move-window') {
    const x = intIn(f.x, -32000, 32000);
    const y = intIn(f.y, -32000, 32000);
    if (x === null) e.x = 'Whole number, in pixels.';
    if (y === null) e.y = 'Whole number, in pixels.';
    if (x !== null) a.x = x;
    if (y !== null) a.y = y;
    if (f.type === 'click' && t) a.target = t;
  }
  if (f.type === 'move-window') {
    const w = intIn(f.width, 1, 20000);
    const h = intIn(f.height, 1, 20000);
    if (w === null) e.width = 'Whole number from 1.';
    if (h === null) e.height = 'Whole number from 1.';
    if (w !== null) a.width = w;
    if (h !== null) a.height = h;
  }
  return Object.keys(e).length ? { errors: e } : { action: a, errors: e };
}

function ResultView({ value }: { value: unknown }) {
  const rows = Array.isArray(value) && value.length > 0 && value.every((r) => r && typeof r === 'object' && ('title' in r || 'process' in r)) ? (value as Record<string, unknown>[]) : null;
  if (rows) {
    return (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr><th>Window</th><th>Process</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 100).map((r, i) => (
              <tr key={i}>
                <td>{truncate(String(r.title ?? ''), 80) || '(untitled)'}</td>
                <td className="mono">{truncate(String(r.process ?? ''), 40)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 100 && <p className="sub pad">Showing 100 of {rows.length}.</p>}
      </div>
    );
  }
  return <pre className="code-block">{value === undefined || value === null ? 'The backend returned no details.' : safeJson(value)}</pre>;
}

export function Computer() {
  const { api, state, settings, toast, isPreview, run } = useReady();
  const [form, setForm] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [prev, setPrev] = useState<{ preview: ActionPreview; action: ActionRequest } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [executing, setExecuting] = useState<'approve' | 'reject' | null>(null);
  const [result, setResult] = useState<{ kind: 'ran' | 'rejected' | 'failed'; value?: unknown; message?: string; summary: string } | null>(null);

  const meta = TYPES[form.type];
  const live = useMemo(() => buildAction(form), [form]);
  const stale = prev !== null && live.action !== undefined && JSON.stringify(live.action) !== JSON.stringify(prev.action);
  const patch = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    setErrors({});
  };

  const activity = useMemo(() => [...state.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8), [state.activity]);

  const doPreview = async () => {
    const built = buildAction(form);
    if (!built.action) return setErrors(built.errors);
    setPreviewing(true);
    setPreviewError(null);
    setResult(null);
    try {
      const preview = await api.previewAction(built.action);
      setPrev({ preview, action: built.action });
    } catch (e) {
      setPrev(null);
      setPreviewError(errMsg(e, 'The action could not be previewed.'));
    } finally {
      setPreviewing(false);
    }
  };

  const decide = async (approved: boolean) => {
    if (!prev) return;
    setExecuting(approved ? 'approve' : 'reject');
    const summary = prev.preview.summary;
    try {
      const out = await api.executeAction(prev.preview.id, approved);
      setResult(approved ? { kind: 'ran', value: out, summary } : { kind: 'rejected', summary });
      setPrev(null);
      setReview(false);
      await run(async () => undefined);
    } catch (e) {
      setResult({ kind: 'failed', message: errMsg(e, 'The action failed.'), summary });
      setReview(false);
      toast('error', errMsg(e));
    } finally {
      setExecuting(null);
    }
  };

  const browse = async (kind: 'file' | 'folder') => {
    try {
      const p = await api.pickPath(kind);
      if (p) patch({ target: p });
      else if (isPreview) toast('info', 'File pickers are unavailable in browser preview.');
    } catch (e) {
      toast('error', errMsg(e));
    }
  };

  const p = prev?.preview;

  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Work" title="Computer" subtitle="Ask the backend to preview an action. Nothing runs until you read the preview and approve it." />

      <div className="computer-grid">
        <div className="stack">
          <Panel title="1 · Describe the action" eyebrow="Request">
            <Field label="Action">
              {(id) => (
                <select id={id} className="input" value={form.type} onChange={(e) => { patch({ type: e.target.value as ActionType }); setPrev(null); setResult(null); setPreviewError(null); }}>
                  {(Object.keys(TYPES) as ActionType[]).map((t) => (
                    <option key={t} value={t}>{TYPES[t].label}</option>
                  ))}
                </select>
              )}
            </Field>

            <div className={cx('scope-card', `risk-${meta.risk}`)}>
              <div className="scope-head">
                {meta.risk === 'high' ? <ShieldWarning size={18} weight="duotone" aria-hidden /> : <ShieldCheck size={18} weight="duotone" aria-hidden />}
                <strong>{meta.label}</strong>
                <Badge tone={meta.risk === 'high' ? 'danger' : meta.risk === 'medium' ? 'warn' : 'ok'}>{meta.risk === 'high' ? 'High impact' : meta.risk === 'medium' ? 'Changes windows or starts programs' : 'Low impact'}</Badge>
              </div>
              <p>{meta.does}</p>
              <p className="field-hint"><strong>Scope:</strong> {meta.scope}</p>
              <p className="field-hint"><strong>Needs:</strong> {meta.needs}</p>
            </div>

            {form.type !== 'list-windows' && (
              <Field label={form.type === 'open-url' ? 'Web address' : form.type === 'launch' ? 'App name or path' : form.type === 'type-text' || form.type === 'click' ? 'Window (optional)' : 'Window title or process'} error={errors.target}>
                {(id, d) => (
                  <div className="row">
                    <input id={id} aria-describedby={d} className="input grow" value={form.target} maxLength={500} spellCheck={false} onChange={(e) => patch({ target: e.target.value })} placeholder={form.type === 'open-url' ? 'https://example.com' : form.type === 'launch' ? 'notepad.exe' : 'e.g. Notepad'} />
                    {form.type === 'launch' && <Button icon={FolderOpen} onClick={() => void browse('file')}>Browse…</Button>}
                  </div>
                )}
              </Field>
            )}
            {form.type === 'type-text' && (
              <Field label="Text to type" error={errors.text} hint={`${form.text.length} / 2000`}>
                {(id, d) => <textarea id={id} aria-describedby={d} className="input" rows={3} maxLength={2000} value={form.text} onChange={(e) => patch({ text: e.target.value })} />}
              </Field>
            )}
            {(form.type === 'click' || form.type === 'move-window') && (
              <div className="grid4">
                <Field label="X" error={errors.x}>{(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={form.x} onChange={(e) => patch({ x: e.target.value })} />}</Field>
                <Field label="Y" error={errors.y}>{(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={form.y} onChange={(e) => patch({ y: e.target.value })} />}</Field>
                {form.type === 'move-window' && (
                  <>
                    <Field label="Width" error={errors.width}>{(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={form.width} onChange={(e) => patch({ width: e.target.value })} />}</Field>
                    <Field label="Height" error={errors.height}>{(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={form.height} onChange={(e) => patch({ height: e.target.value })} />}</Field>
                  </>
                )}
              </div>
            )}

            <div className="row">
              <Button variant="primary" icon={MagnifyingGlass} busy={previewing} onClick={() => void doPreview()}>
                Preview action
              </Button>
              <span className="sub">Preview asks the backend what would happen. It does not run anything.</span>
            </div>
          </Panel>

          <Panel title="2 · Review the preview" eyebrow="Backend response">
            {previewError && <Notice tone="danger" title="Preview failed">{previewError}</Notice>}
            {!p && !previewError && <Empty title="No preview yet">Fill in the request and choose Preview action.</Empty>}
            {p && prev && (
              <div className="stack" aria-live="polite">
                <dl className="kv-list">
                  <KV k="Summary">{p.summary}</KV>
                  <KV k="Allowed">{p.allowed ? <Badge tone="ok">Allowed</Badge> : <Badge tone="danger">Blocked</Badge>}</KV>
                  <KV k="Approval">{p.requiresApproval ? 'Required' : 'Not required by the backend (this screen still asks)'}</KV>
                  {p.reason && <KV k="Reason">{p.reason}</KV>}
                  <KV k="Request"><code>{truncate(JSON.stringify(prev.action), 200)}</code></KV>
                </dl>
                {stale && <Notice tone="warn" title="The form changed after this preview">Preview again before approving.</Notice>}
                {!p.allowed && <Notice tone="danger" title="Blocked">This action cannot run. {p.reason ?? 'The backend gave no reason.'} Adjust the request, or review Settings → Access.</Notice>}
                <div className="row">
                  <Button variant="primary" icon={ShieldCheck} disabled={!p.allowed || stale} onClick={() => setReview(true)}>
                    Review &amp; approve…
                  </Button>
                  <Button variant="quiet" disabled={executing !== null} onClick={() => void decide(false)}>
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </Panel>

          {result && (
            <Panel title="3 · Outcome" eyebrow={result.kind === 'ran' ? 'Executed' : result.kind === 'rejected' ? 'Rejected' : 'Failed'}>
              <div aria-live="polite" className="stack">
                <p><strong>{result.summary}</strong></p>
                {result.kind === 'ran' && <ResultView value={result.value} />}
                {result.kind === 'rejected' && <Notice>You rejected this action. Nothing ran.</Notice>}
                {result.kind === 'failed' && <Notice tone="danger" title="The action did not complete">{result.message}</Notice>}
              </div>
            </Panel>
          )}
        </div>

        <div className="stack">
          <Panel title="What is in scope" eyebrow="Your permissions">
            <dl className="kv-list">
              <KV k="Approved apps">{settings.approvedApps.length ? `${settings.approvedApps.length} listed` : 'none'}</KV>
              <KV k="Allowed folders">{settings.allowedRoots.length ? `${settings.allowedRoots.length} listed` : 'none'}</KV>
            </dl>
            {settings.approvedApps.length > 0 && <ul className="chips-col">{settings.approvedApps.slice(0, 6).map((a) => <li key={a} className="path-item"><code title={a}>{a}</code></li>)}</ul>}
            <p className="field-hint">Edit these lists in Settings → Access. The backend enforces them and explains refusals in the preview.</p>
            <a className="btn btn-ghost btn-sm" href="#/settings">Open Settings</a>
          </Panel>
          <Notice>To reopen a project’s files, folders and links together, use Capsules instead.</Notice>
          <Panel title="Recent activity" eyebrow="Live">
            {activity.length === 0 ? (
              <Empty title="Nothing recorded yet">Executed and rejected actions appear here when the backend reports them.</Empty>
            ) : (
              <ol className="timeline">
                {activity.map((a) => (
                  <li key={a.id}>
                    <span className="tl-kind">{a.kind}</span>
                    <span>{truncate(a.summary, 110)}</span>
                    <time dateTime={a.at}>{relTime(a.at)}</time>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>

      <Dialog
        open={review && prev !== null}
        onClose={() => setReview(false)}
        title="Approve this action?"
        description="This runs on your computer as you, right after you approve."
        dismissible={executing === null}
        footer={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setReview(false)} disabled={executing !== null}>Go back</Button>
            <Button variant="quiet" busy={executing === 'reject'} disabled={executing === 'approve'} onClick={() => void decide(false)}>Reject</Button>
            <Button variant={meta.risk === 'high' ? 'danger' : 'primary'} icon={ShieldCheck} busy={executing === 'approve'} disabled={executing === 'reject'} onClick={() => void decide(true)}>
              Approve &amp; run
            </Button>
          </>
        }
      >
        {prev && (
          <div className="stack">
            <p><strong>{prev.preview.summary}</strong></p>
            <div className={cx('scope-card', `risk-${TYPES[prev.action.type].risk}`)}>
              <div className="scope-head"><WarningCircle size={16} aria-hidden /><strong>{TYPES[prev.action.type].label}</strong></div>
              <p className="field-hint">{TYPES[prev.action.type].scope}</p>
            </div>
            <pre className="code-block">{safeJson(prev.action, 800)}</pre>
          </div>
        )}
      </Dialog>
    </div>
  );
}
