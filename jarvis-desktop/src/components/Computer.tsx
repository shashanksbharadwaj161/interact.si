import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Lightning, MagnifyingGlass, ShieldCheck, ShieldWarning, WarningCircle } from '@phosphor-icons/react';
import type { ActionPreview, ActionRequest, ApiFeature, ApiFeatureId, IntentCandidate, JarvisAPI, OcrStatus, OcrResult } from '../shared/contracts';
import { ocrBridge } from '../ui/bridges';
import { Dialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, KV, Notice, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { cx, errMsg, relTime, safeJson, truncate } from '../ui/util';

import { actionOutcome, buildAction, listedWindows, type ActionForm, type ListedWindow } from '../ui/action-result';
import { explainNotRun, notRunCause, usePreviewExpired } from './Assistant';
import { usePref } from '../ui/prefs';
import { WORKER_ROLES } from '../ui/worker-roles';
import { ACTION_SCOPES, KNOWN_SCOPES, MANUAL_ROLE, SCOPE_POLICY_PREF_KEY, effectivePolicy, evaluateActionScope, normalizeScopePref, requiredScopeFor, type ScopePref } from '../ui/tool-scope-policy';

type ActionType = ActionRequest['type'];
type Risk = 'low' | 'medium' | 'high';

const TYPES: Record<ActionType, { label: string; risk: Risk; does: string; scope: string; needs: string }> = {
  'list-windows': { label: 'List windows', risk: 'low', does: 'Reads the titles and process names of open windows.', scope: 'Read-only. Does not change, focus or close anything. Window titles can contain private information such as document names.', needs: 'No target.' },
  'open-url': { label: 'Open URL', risk: 'low', does: 'Opens an http or https address in the default browser.', scope: 'Hands the address to Windows. The page itself is not read or controlled.', needs: 'A web address.' },
  launch: { label: 'Launch app', risk: 'medium', does: 'Starts an application.', scope: 'Starts a program with your user rights. It should be on your approved apps list; the preview tells you if it is not.', needs: 'App name or full path.' },
  focus: { label: 'Focus window', risk: 'medium', does: 'Brings an existing window to the front.', scope: 'Changes which window is active. It does not read the window contents.', needs: 'Part of a window title or a process name.' },
  'move-window': { label: 'Move / resize window', risk: 'medium', does: 'Repositions and resizes one window.', scope: 'Changes window geometry only, in screen pixels.', needs: 'Window target plus x, y, width and height.' },
  'type-text': { label: 'Type text', risk: 'high', does: 'Sends keystrokes as if you typed them.', scope: 'The backend focuses and rechecks the exact approved window before typing. Never use this for passwords or secrets. Command windows can execute typed text.', needs: 'The complete text and an explicit target window.' },
  click: { label: 'Click', risk: 'high', does: 'Clicks at a screen position.', scope: 'A click can press anything under that point, including buttons that send, delete or purchase. Positions change when windows move.', needs: 'An explicit target window and screen x and y in pixels inside that window.' },
};

type Form = ActionForm;
const blank = (): Form => ({ type: 'list-windows', target: '', text: '', x: '', y: '', width: '', height: '' });

/** Fills the action form from a planned request. The user still previews and approves; nothing runs from here. */
export function formFromRequest(r: ActionRequest): ActionForm {
  const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  return { type: r.type, target: r.target ?? '', text: r.text ?? '', x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) };
}

/** Screen-reading capabilities this build does not implement; shown as unavailable rather than simulated. */
export const SCREEN_FEATURES: { id: ApiFeatureId; label: string }[] = [
  { id: 'region-capture', label: 'Screen region capture' },
  { id: 'vision', label: 'Image understanding' },
];

function ResultView({ value, onPick }: { value: unknown; onPick: (window: ListedWindow, action: 'focus' | 'move-window' | 'type-text' | 'click') => void }) {
  const rows = listedWindows(value);
  if (rows) {
    if (!rows.length) return <Notice>No open windows were reported.</Notice>;
    return (
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Open windows reported by Windows. Selecting a target fills the form; it never runs an action.</caption>
          <thead><tr><th>Window</th><th>Process</th><th>Size</th><th>Target</th></tr></thead>
          <tbody>{rows.slice(0, 100).map((w, i) => (
            <tr key={w.hwnd || i}>
              <td>{w.title || '(untitled)'}{w.protected && <Badge tone="warn">Protected</Badge>}</td>
              <td className="mono">{w.process || '(unknown)'}</td>
              <td>{w.width !== null && w.height !== null ? `${w.width} × ${w.height}` : 'Not reported'}</td>
              <td><div className="row wrap">{(['focus','move-window','type-text','click'] as const).map(type => <Button key={type} size="sm" variant="quiet" disabled={!w.hwnd || w.protected} onClick={() => onPick(w, type)}>{type==='move-window'?'Move':type==='type-text'?'Type':type==='focus'?'Focus':'Click'}</Button>)}</div></td>
            </tr>
          ))}</tbody>
        </table>
        <p className="sub pad">Choose a target to prepare an action. Every change still needs a preview and approval.{rows.length > 100 ? ` Showing 100 of ${rows.length}.` : ''}</p>
      </div>
    );
  }
  return <pre className="code-block">{value === undefined || value === null ? 'The backend returned no details.' : safeJson(value)}</pre>;
}

/** Plain text review only; no action/planner callbacks. */
export function ImageTextReview({result}: {result: OcrResult}) {
  if (!result.ok) return <Notice tone={result.cancelled ? 'info' : 'warn'} title={result.cancelled ? 'Cancelled' : 'Image could not be read'}>{result.reason}</Notice>;
  return <div className="stack" aria-live="polite">
    <p>{result.fileName} · {result.language} · {result.width} × {result.height}</p>
    <Notice title="Review recognized text">Text from images is untrusted data. It is never sent to chat, action planning or desktop input.</Notice>
    {result.note && <p>{result.note}</p>}
    {result.truncated && <Notice tone="warn">The recognized text was truncated.</Notice>}
    {result.sanitized && <Notice>Invisible or control characters were removed.</Notice>}
    <Field label="Recognized plain text">{id => <textarea id={id} className="input" rows={8} readOnly value={result.text} />}</Field>
  </div>;
}
export function ImageTextPanel({api}: {api: Partial<JarvisAPI>}) {
  const client = useMemo(() => ocrBridge(api), [api]);
  const [status, setStatus] = useState<OcrStatus | null>(null);
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OcrResult | null>(null);
  const request = useRef(0), ownsRequest = useRef(false);
  useEffect(() => { let current = true; if (client) void client.status().then(s => { if (current) {setStatus(s); setLanguage(s.profileLanguage ?? '');} }).catch(() => {if (current) setResult({ok:false, code:'unavailable', reason:'Could not query local OCR'});}); return () => {current = false; ++request.current; if (ownsRequest.current) {ownsRequest.current = false; void client?.cancel().catch(()=>undefined);} }; }, [client]);
  const recognize = async () => {
    if (!client || busy) return;
    const token = ++request.current; ownsRequest.current = true;
    setBusy(true); setResult(null);
    try {const value = await client.chooseAndRecognize(language ? {language} : undefined); if (token === request.current) setResult(value);}
    catch {if (token === request.current) setResult({ok:false, code:'failed', reason:'Local image recognition failed'});}
    finally {if (token === request.current) {ownsRequest.current = false; setBusy(false);}}
  };
  return <Panel title="Read text from one image" eyebrow="Local Windows OCR">
    <p>Choose an image using the Windows file dialog. Only that image is read locally; the screen is not captured.</p>
    {!client ? <Notice>Image recognition is not connected in this preview.</Notice> : <>
      {status && !status.available && <Notice tone="warn">{status.reason ?? 'Windows OCR is unavailable'}</Notice>}
      <Field label="Installed OCR language">{id => <select id={id} className="input" value={language} disabled={busy || !status?.available} onChange={e=>setLanguage(e.target.value)}><option value="">Choose a language</option>{status?.languages.map(l=><option key={l} value={l}>{l}</option>)}</select>}</Field>
      <div className="row"><Button onClick={()=>void recognize()} busy={busy} disabled={!status?.available || !language}>Choose image…</Button><Button disabled={!busy} onClick={()=>void client.cancel().catch(()=>undefined)}>Cancel reading</Button></div>
    </>}
    {result && <ImageTextReview result={result} />}
  </Panel>;
}

export function Computer() {
  const { api, state, settings, toast, isPreview, run, system, systemLoading, systemError, refreshSystem } = useReady();
  const [form, setForm] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [previewing, setPreviewing] = useState(false);
  const [prev, setPrev] = useState<{ preview: ActionPreview; action: ActionRequest } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [executing, setExecuting] = useState<'approve' | 'reject' | null>(null);
  const [result, setResult] = useState<{ kind: 'ran' | 'not-run' | 'rejected' | 'unconfirmed' | 'failed'; value?: unknown; message?: string; summary: string } | null>(null);

  const [command, setCommand] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planNote, setPlanNote] = useState<{ tone: 'info' | 'warn' | 'danger'; title: string; text: string; candidates?: IntentCandidate[] } | null>(null);
  const [features, setFeatures] = useState<ApiFeature[] | null>(null);

  useEffect(() => {
    let live = true;
    api.getApiInfo?.().then((info) => { if (live) setFeatures(info.features); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);

  const desktop = system?.capabilities.find(c => c.id === 'ui-automation');
  const desktopReady = desktop?.available === true && !systemError;
  const desktopReason = systemError || desktop?.reason || (systemLoading ? 'Checking Windows desktop control…' : 'Windows desktop control has not been checked.');
  const needsDesktop = !['launch','open-url'].includes(form.type);
  const meta = TYPES[form.type];
  const live = useMemo(() => buildAction(form), [form]);
  const expired = usePreviewExpired(prev?.preview.id);
  const stale = prev !== null && (!live.action || JSON.stringify(live.action) !== JSON.stringify(prev.action));
  const [scopePrefRaw, setScopePrefRaw] = usePref<unknown>(SCOPE_POLICY_PREF_KEY, null);
  const scopePref = useMemo(() => normalizeScopePref(scopePrefRaw), [scopePrefRaw]);
  const [hostsDraft, setHostsDraft] = useState(() => scopePref.allowedHosts.join(', '));
  const policy = useMemo(() => effectivePolicy(scopePref, settings), [scopePref, settings]);
  const saveScopePref = (p: Partial<ScopePref>) => setScopePrefRaw(normalizeScopePref({ ...scopePref, ...p }));
  const formScope = requiredScopeFor({ type: form.type });
  const scopeCheck = live.action ? evaluateActionScope(live.action, policy) : policy.scopes.includes(formScope) ? null : { allowed: false, scope: formScope, reasons: [`Missing scope ${formScope}.`] };
  // Opt-in: until a scope source is chosen and saved, the pre-check is off and Preview behaves as before.
  const scopeOn = scopePrefRaw !== null && scopePrefRaw !== undefined;
  const scopeDenied = scopeOn && scopeCheck !== null && !scopeCheck.allowed;
  const patch = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    setErrors({});
  };

  const activity = useMemo(() => [...state.activity].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8), [state.activity]);

  const doPreview = async () => {
    if (needsDesktop && !desktopReady) return setPreviewError(desktopReason);
    const built = buildAction(form);
    if (!built.action) return setErrors(built.errors);
    if (scopeOn && !evaluateActionScope(built.action, policy).allowed) return;
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
      setResult({ ...actionOutcome(out, approved), summary });
      setPrev(null);
      setReview(false);
      await run(async () => undefined);
    } catch (e) {
      const message = errMsg(e, 'The action failed.');
      // An unknown/expired/used preview is refused before anything starts: a definite "not run".
      setResult(!approved ? { kind: 'rejected', summary } : notRunCause(message) === 'expired' ? { kind: 'not-run', message, summary } : { kind: 'failed', message, summary });
      setPrev(null);
      setReview(false);
      toast('error', message);
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

  const fillFrom = (request: ActionRequest) => {
    setForm(formFromRequest(request));
    setErrors({});
    setPrev(null); setPreviewError(null); setResult(null);
  };

  const planFromCommand = async () => {
    const text = command.trim();
    if (!text || !api.planIntent) return;
    setPlanning(true);
    try {
      const plan = await api.planIntent(text);
      if (plan.status === 'ready') {
        fillFrom(plan.request);
        setPlanNote({ tone: 'info', title: 'Form filled', text: `${plan.summary}. Review the fields, then preview.` });
      } else if (plan.status === 'clarify') {
        setPlanNote({ tone: 'warn', title: plan.summary, text: plan.question, candidates: plan.candidates });
      } else {
        setPlanNote({ tone: 'danger', title: plan.summary, text: plan.reason });
      }
    } catch (e) {
      setPlanNote({ tone: 'danger', title: 'Could not plan the command', text: errMsg(e) });
    } finally {
      setPlanning(false);
    }
  };

  const pickWindow = (window: ListedWindow, type: 'focus' | 'move-window' | 'type-text' | 'click') => {
    if (!window.hwnd || window.protected) return;
    patch({ type, target: `hwnd:${window.hwnd}`, ...(type==='move-window' ? {x:String(window.x ?? 0), y:String(window.y ?? 0), width:String(window.width ?? 800), height:String(window.height ?? 600)} : {}) });
    setPrev(null);setPreviewError(null);
    toast('info', `Target selected: ${window.title || window.process}. Preview before running.`);
  };
  const p = prev?.preview;

  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Work" title="Computer" subtitle="Ask the backend to preview an action. Nothing runs until you read the preview and approve it." />

      {needsDesktop&&!desktopReady&&<Notice tone="warn" title="Desktop control unavailable">{desktopReason}<div className="row"><Button size="sm" busy={systemLoading} onClick={()=>void refreshSystem()}>Check again</Button><a className="btn btn-ghost btn-sm" href="#/status">System status</a></div></Notice>}
      <div className="computer-grid">
        <div className="stack">
          <Panel title="1 · Describe the action" eyebrow="Request">
            {api.planIntent && (
              <form className="stack" onSubmit={(e) => { e.preventDefault(); void planFromCommand(); }}>
                <Field label="Fill from a command (optional)" hint='For example: focus "Untitled - Notepad", or move "Notes" to 0,0 size 800x600. This only fills the form.'>
                  {(id, d) => (
                    <div className="row">
                      <input id={id} aria-describedby={d} className="input grow" value={command} maxLength={2200} spellCheck={false} onChange={(e) => setCommand(e.target.value)} />
                      <Button type="submit" icon={Lightning} busy={planning} disabled={!command.trim() || executing !== null}>Fill form</Button>
                    </div>
                  )}
                </Field>
                {planNote && (
                  <div aria-live="polite">
                    <Notice tone={planNote.tone} title={planNote.title}>
                      {planNote.text}
                      {planNote.candidates && planNote.candidates.length > 0 && (
                        <div className="row wrap">{planNote.candidates.map((c, i) => <Button key={i} size="sm" variant="quiet" onClick={() => { fillFrom(c.request); setPlanNote({ tone: 'info', title: 'Form filled', text: `${c.label}. Review the fields, then preview.` }); }}>{truncate(c.label, 80)}</Button>)}</div>
                      )}
                    </Notice>
                  </div>
                )}
              </form>
            )}
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

            <fieldset className="stack" aria-label="Action scope (renderer pre-check)">
              <legend><strong>Action scope (renderer pre-check)</strong></legend>
              <p className="field-hint">This is a renderer-side pre-check. The main process still previews, requires approval and enforces its own limits.</p>
              <Field label="Scope source" hint="Off keeps Preview as before. Worker roles describe task records; they grant no computer-action scopes. Choose Manual to tick scopes.">
                {(id, d) => (
                  <select id={id} aria-describedby={d} className="input" value={scopeOn ? scopePref.roleId : 'off'} onChange={(e) => e.target.value === 'off' ? setScopePrefRaw(null) : saveScopePref({ roleId: e.target.value })}>
                    <option value="off">Off (no pre-check)</option>
                    <option value={MANUAL_ROLE}>Manual</option>
                    {WORKER_ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                  </select>
                )}
              </Field>
              <div className="row wrap" role="group" aria-label="Scopes">
                {KNOWN_SCOPES.map((s) => (
                  <label key={s} className="row">
                    <input type="checkbox" checked={scopeOn && policy.scopes.includes(s)} disabled={!scopeOn || scopePref.roleId !== MANUAL_ROLE} onChange={(e) => saveScopePref({ scopes: e.target.checked ? [...scopePref.scopes, s] : scopePref.scopes.filter((x) => x !== s) })} />
                    <span className={ACTION_SCOPES.includes(s) ? 'mono' : 'mono sub'}>{s}</span>
                  </label>
                ))}
              </div>
              <Field label="Allowed hosts (comma separated)" hint="Exact host, or .example.com for that domain and its subdomains.">
                {(id, d) => <input id={id} aria-describedby={d} className="input" value={hostsDraft} disabled={!scopeOn} spellCheck={false} maxLength={4000} onChange={(e) => { setHostsDraft(e.target.value); saveScopePref({ allowedHosts: e.target.value.split(',') }); }} />}
              </Field>
              <Field label="Max text chars" hint="1 to 20000.">
                {(id, d) => <input id={id} aria-describedby={d} className="input" inputMode="numeric" value={String(scopePref.maxTextChars)} disabled={!scopeOn} onChange={(e) => saveScopePref({ maxTextChars: Number(e.target.value) })} />}
              </Field>
              <div aria-live="polite">
                {!scopeOn ? (
                  <p className="sub">Pre-check is off. Choose Manual or a role to check actions against a scope policy.</p>
                ) : scopeDenied && scopeCheck ? (
                  <Notice tone="warn" title={`Scope ${scopeCheck.scope || '(unknown)'}: denied by policy`}>
                    <ul>{scopeCheck.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </Notice>
                ) : scopeCheck ? (
                  <p className="sub">Scope {scopeCheck.scope}: within policy</p>
                ) : (
                  <p className="sub">Scope {formScope}: granted; complete the request to check its details.</p>
                )}
              </div>
            </fieldset>

            {form.type !== 'list-windows' && (
              <Field label={form.type === 'open-url' ? 'Web address' : form.type === 'launch' ? 'App name or path' : form.type === 'type-text' || form.type === 'click' ? 'Target window (required)' : 'Window title or process'} error={errors.target}>
                {(id, d) => (
                  <div className="row">
                    <input id={id} aria-describedby={d} className="input grow" value={form.target} maxLength={500} spellCheck={false} onChange={(e) => patch({ target: e.target.value })} placeholder={form.type === 'open-url' ? 'https://example.com' : form.type === 'launch' ? 'notepad.exe' : 'e.g. hwnd:12345 or Notepad'} />
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
              <Button variant="primary" icon={MagnifyingGlass} busy={previewing} disabled={needsDesktop&&!desktopReady || executing !== null || scopeDenied} onClick={() => void doPreview()}>
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
                  <KV k="Approval">{p.requiresApproval ? 'Required' : 'Not required — read-only action'}</KV>
                  {p.reason && <KV k="Reason">{p.reason}</KV>}
                  <KV k="Request"><code>{truncate(JSON.stringify(prev.action), 200)}</code></KV>
                </dl>
                {stale && <Notice tone="warn" title="The form changed after this preview">Preview again before approving.</Notice>}
                {expired && !stale && <Notice tone="warn" title="This preview has expired">The backend only accepts a preview for one minute. Preview again before approving.</Notice>}
                {!p.allowed && <Notice tone="danger" title="Blocked">This action cannot run. {p.reason ?? 'The backend gave no reason.'} Adjust the request, or review Settings → Access.</Notice>}
                <div className="row">
                  <Button variant="primary" icon={ShieldCheck} disabled={!p.allowed || stale || expired || executing !== null || needsDesktop&&!desktopReady} onClick={() => p.requiresApproval ? setReview(true) : void decide(true)}>
                    {p.requiresApproval ? 'Review & approve…' : 'Read windows'}
                  </Button>
                  <Button variant="quiet" disabled={executing !== null} onClick={() => void decide(false)}>
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </Panel>

          {result && (
            <Panel title="3 · Outcome" eyebrow={result.kind === 'ran' ? 'Done' : result.kind === 'not-run' ? 'Not run' : result.kind === 'unconfirmed' ? 'Not confirmed' : result.kind === 'rejected' ? 'Rejected' : 'Failed'}>
              <div aria-live="polite" className="stack">
                <p><strong>{result.summary}</strong></p>
                {result.kind === 'ran' && <ResultView value={result.value} onPick={pickWindow} />}
                {result.kind === 'rejected' && <Notice>You rejected this action. Nothing ran.</Notice>}
                {(result.kind === 'not-run' || result.kind === 'unconfirmed') && <Notice tone="warn" title={result.kind === 'not-run'?'Not run':'Execution not confirmed'}>{result.kind === 'not-run' ? (explainNotRun(result.message) ?? result.message) : result.message}{result.kind === 'not-run' && explainNotRun(result.message) && <span className="sub"> Backend said: {result.message}</span>}</Notice>}
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
          <ImageTextPanel api={api} />
          <Panel title="Screen reading" eyebrow="Capabilities">
            <dl className="kv-list">
              {SCREEN_FEATURES.map((f) => {
                const info = features?.find((x) => x.id === f.id);
                return (
                  <KV key={f.id} k={f.label}>
                    {info?.available ? <Badge tone="ok">Available</Badge> : <Badge tone="muted">Unavailable</Badge>} <span className="sub">{info?.reason ?? 'Not implemented in this build.'}</span>
                  </KV>
                );
              })}
            </dl>
            <p className="field-hint">Desktop Companion does not capture or read your screen. Actions use window titles, process names and positions only.</p>
          </Panel>
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
        description="Approving here opens a Windows confirmation with the full details. Cancel is its default; nothing runs unless you choose Continue there."
        dismissible={executing === null}
        footer={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setReview(false)} disabled={executing !== null}>Go back</Button>
            <Button variant="quiet" busy={executing === 'reject'} disabled={executing === 'approve'} onClick={() => void decide(false)}>Reject</Button>
            <Button variant={meta.risk === 'high' ? 'danger' : 'primary'} icon={ShieldCheck} busy={executing === 'approve'} disabled={executing === 'reject' || expired} onClick={() => void decide(true)}>
              {executing === 'approve' ? 'Waiting for Windows confirmation…' : 'Approve & continue to Windows'}
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
            <dl className="kv-list"><KV k="Resolved target">{prev.preview.summary}</KV>{prev.action.target&&<KV k="Requested target"><code>{prev.action.target}</code></KV>}</dl>
            {prev.action.type==='type-text'&&<><Field label={`Complete text to type · ${prev.action.text?.length || 0} characters`} hint="Read the complete text, including line breaks, before approving.">{id=><textarea id={id} className="input" rows={6} readOnly value={prev.action.text || ''}/>}</Field>{/cmd|powershell|pwsh|terminal|conhost|bash|wsl|mintty|shell/i.test(prev.preview.summary+' '+prev.action.target)&&<Notice tone="warn" title="Command window">Typed text can be interpreted as a command. Newline command input is blocked by the backend.</Notice>}</>}
            <details><summary>Complete action data</summary><pre className="code-block">{JSON.stringify(prev.action, null, 2)}</pre></details>
          </div>
        )}
      </Dialog>
    </div>
  );
}
