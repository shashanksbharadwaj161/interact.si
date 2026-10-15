import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowSquareOut, ClipboardText, Copy, Key, LinkBreak, PlugsConnected, Power, ShieldCheck, Trash } from '@phosphor-icons/react';
import type { ActionPreview, ActionRequest, Mode } from '../shared/contracts';
import { actionOutcome } from '../ui/action-result';
import {
  AVAILABILITY_LABEL, INTEGRATIONS, findIntegration, formatIssueDraft, handoffAction, inspectLink, isCheckable, keyPageAction, keyWarnings, needsOptIn, setupChecklist,
  type CheckResult, type ConnectionState, type EgressPreview, type IntegrationDefinition, type IntegrationView, type IntegrationsBridge, type UsageEntry,
} from '../ui/integration-catalog';
import { Badge, Button, Empty, Field, Notice, PageHeader, Panel, Segmented, type Tone } from '../ui/primitives';
import { useReady } from '../ui/store';
import { errMsg } from '../ui/util';

export type IntegrationFilter = 'all' | 'websites' | 'api' | 'device' | 'unavailable';

const FILTER_TEST: Record<IntegrationFilter, (d: IntegrationDefinition) => boolean> = {
  all: () => true,
  websites: (d) => d.availability === 'handoff',
  api: (d) => d.availability === 'byok' || d.availability === 'keyless',
  device: (d) => d.availability === 'local',
  unavailable: (d) => d.availability === 'setup-required' || d.availability === 'not-built' || d.availability === 'gated',
};

export function filterIntegrations(filter: IntegrationFilter, defs: readonly IntegrationDefinition[] = INTEGRATIONS, family: ProviderFamily | 'all' = 'all'): IntegrationDefinition[] {
  return defs.filter((d) => FILTER_TEST[filter](d) && (family === 'all' || familyOf(d) === family));
}

// ---------- provider families: one place per requested provider, each way of reaching it kept separate ----------

export type ProviderFamily = 'claude' | 'chatgpt' | 'spotify' | 'browser' | 'local' | 'other';
/** How an item reaches its provider. A website or app launch never implies an API or account connection. */
export type ConnectionMethod = 'provider-api' | 'website' | 'app-launch' | 'on-device' | 'unavailable';

const FAMILY_BY_ID: Record<string, ProviderFamily> = {
  anthropic: 'claude', 'claude-web': 'claude',
  openai: 'chatgpt', 'chatgpt-web': 'chatgpt',
  'spotify-web': 'spotify', 'spotify-api': 'spotify',
  browser: 'browser',
  ollama: 'local',
};

export const FAMILY_INFO: Record<ProviderFamily, { label: string; note: string; app?: { exe: string; label: string } }> = {
  claude: { label: 'Claude', note: 'Chat inside this app uses your own Anthropic API key. A Claude.ai plan is a separate website login.' },
  chatgpt: { label: 'ChatGPT', note: 'Only a connection check with your own OpenAI API key exists; chat through OpenAI is not built. ChatGPT itself is a website.' },
  spotify: { label: 'Spotify', note: 'Opening a link or starting the Spotify app is not an account connection. Playback control needs a Spotify sign-in that does not exist yet.', app: { exe: 'Spotify.exe', label: 'Start the Spotify app' } },
  browser: { label: 'Browser', note: 'Links open in your default browser after approval. Tabs, history and pages are never read.' },
  local: { label: 'Local model', note: 'Runs on this computer through Ollama. Works offline; nothing leaves the device.' },
  other: { label: 'Other', note: 'Roadmap connectors, feeds and local tools.' },
};

export const FAMILY_ORDER: readonly ProviderFamily[] = ['local', 'claude', 'chatgpt', 'spotify', 'browser', 'other'];

export function familyOf(d: IntegrationDefinition): ProviderFamily {
  return FAMILY_BY_ID[d.id] ?? 'other';
}

export function methodOf(d: IntegrationDefinition): ConnectionMethod {
  switch (d.availability) {
    case 'byok': case 'keyless': return 'provider-api';
    case 'handoff': return 'website';
    case 'local': return 'on-device';
    default: return 'unavailable';
  }
}

export const METHOD_LABEL: Record<ConnectionMethod, string> = {
  'provider-api': 'Provider API',
  website: 'Website',
  'app-launch': 'App launch',
  'on-device': 'On this device',
  unavailable: 'Not available',
};

export type FamilyRow = { method: ConnectionMethod; id: string; name: string; tone: Tone; text: string };

/** Every way of reaching one provider, each with its own honest status. Pure; used by the overview and tests. */
export function familyRows(family: ProviderFamily, views: Record<string, IntegrationView>, mode: Mode, defs: readonly IntegrationDefinition[] = INTEGRATIONS): FamilyRow[] {
  const rows: FamilyRow[] = defs.filter((d) => familyOf(d) === family).map((d) => {
    const s = stateText(d, views[d.id], mode);
    return { method: methodOf(d), id: d.id, name: d.name, tone: s.tone, text: s.text };
  });
  const app = FAMILY_INFO[family].app;
  if (app) rows.push({ method: 'app-launch', id: `${family}-app`, name: app.label, tone: 'info', text: `Starts ${app.exe} only if it is in Approved apps, after your approval. Not an account connection.` });
  return rows;
}

/** Honest one-line status. Without a backend view, nothing is claimed beyond the definition itself. */
export function stateText(d: IntegrationDefinition, v: IntegrationView | undefined, mode: Mode): { tone: Tone; text: string } {
  const s: ConnectionState | undefined = v?.state;
  if (d.availability === 'handoff') return { tone: 'info', text: 'Opens in your browser after approval. Not an API or account connection.' };
  if (d.availability === 'gated') return { tone: 'warn', text: 'Experimental and off.' };
  if (d.availability === 'setup-required') return { tone: 'muted', text: 'Not usable yet: setup is missing.' };
  if (d.availability === 'not-built') return { tone: 'muted', text: 'Not built.' };
  if (!d.check) return { tone: 'ok', text: 'Runs on this device. Nothing is sent.' };
  if (!v) return { tone: 'muted', text: d.check.online && mode === 'offline' ? 'Needs online mode.' : 'Connection status is unknown: checks are not wired in this build.' };
  switch (s) {
    case 'turned-off': return { tone: 'muted', text: 'Off. Nothing is sent until you turn it on.' };
    case 'offline': return { tone: 'muted', text: 'Needs online mode. Nothing is sent while offline.' };
    case 'needs-key': return { tone: 'warn', text: `Add your ${d.key?.label ?? 'key'} to check the connection.` };
    case 'connected': return { tone: 'ok', text: `Connection check passed${v.lastCheck?.at ? ` at ${new Date(v.lastCheck.at).toLocaleTimeString()}` : ''}.` };
    case 'check-failed': return { tone: 'danger', text: v.lastCheck?.reason ?? 'The last connection check failed.' };
    case 'ready-to-check':
      if (v.lastCheck) return { tone: 'warn', text: `The check from ${new Date(v.lastCheck.at).toLocaleTimeString()} (${v.lastCheck.ok ? 'passed' : 'failed'}) is out of date: it is too old or the address changed. Check again to confirm.` };
      return { tone: 'muted', text: 'Not checked in this session.' };
    default: return { tone: 'muted', text: 'Not checked in this session.' };
  }
}

type Handoff = { request: ActionRequest; preview: ActionPreview };
export type IntegrationsPanelProps = {
  mode: Mode;
  bridge?: IntegrationsBridge;
  previewAction: (a: ActionRequest) => Promise<ActionPreview>;
  executeAction: (id: string, approved: boolean) => Promise<unknown>;
  notify: (kind: 'ok' | 'error' | 'info', text: string) => void;
};

/** Store-connected page. The captain passes the IPC bridge once integration channels are wired. */
export function Integrations({ bridge }: { bridge?: IntegrationsBridge }) {
  const { api, settings, toast } = useReady();
  return <IntegrationsPanel mode={settings.mode} bridge={bridge} previewAction={(a) => api.previewAction(a)} executeAction={(id, ok) => api.executeAction(id, ok)} notify={toast} />;
}

export function IntegrationsPanel({ mode, bridge, previewAction, executeAction, notify }: IntegrationsPanelProps) {
  const [filter, setFilter] = useState<IntegrationFilter>('all');
  const [family, setFamily] = useState<ProviderFamily | 'all'>('all');
  const [views, setViews] = useState<Record<string, IntegrationView>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setRefreshing(true);
    try {
      const list = await bridge.list();
      setViews(Object.fromEntries(list.map((v) => [v.id, v])));
      setLoadError(null);
      setLoadedAt(new Date().toISOString());
    } catch (e) {
      // Keep the last good statuses on screen, but say they may be out of date.
      setLoadError(errMsg(e, 'Integration status could not be loaded.'));
    } finally {
      setRefreshing(false);
    }
  }, [bridge]);
  useEffect(() => { void refresh(); }, [refresh, mode]);

  const shown = useMemo(() => filterIntegrations(filter, INTEGRATIONS, family), [filter, family]);

  return (
    <div className="page">
      <PageHeader eyebrow="Connections" title="Integrations" subtitle="Optional providers and shortcuts. Each item says whether it is a real API connection, a website you open, or not available yet." />

      <Notice title="Websites are not integrations">
        Opening Claude, ChatGPT or Spotify only hands a link to your browser after you approve it. There is no OAuth or account sign-in: the app does not read the page or control playback. API connections use a developer key you own (a subscription is not a key), stay off until you turn them on, and run only in online mode after a confirmation that lists what leaves this computer.
      </Notice>
      {mode === 'offline' && <Notice tone="info" title="Offline mode">No provider is contacted. Only the local model check (loopback) can run.</Notice>}
      {!bridge && <Notice tone="warn" title="Connection checks are not wired in this build">Keys and checks are unavailable here. Website handoffs still go through the normal approval flow.</Notice>}
      {loadError && <Notice tone="danger" title="Status unavailable">{loadError}{Object.keys(views).length ? ' Statuses below are from the last successful load and may be out of date.' : ''}</Notice>}

      <ProviderOverview views={views} mode={mode} selected={family} onSelect={setFamily} />

      {bridge && (
        <div className="row wrap">
          <Button size="sm" onClick={() => void refresh()} busy={refreshing}>Refresh status</Button>
          <span className="field-hint">{loadedAt ? `Status read at ${new Date(loadedAt).toLocaleTimeString()}. Connection results older than 30 minutes need a new check.` : 'Status not read yet.'}</span>
        </div>
      )}

      <Segmented<ProviderFamily | 'all'>
        label="Provider"
        value={family}
        onChange={setFamily}
        options={[{ value: 'all', label: 'All' }, ...FAMILY_ORDER.map((f) => ({ value: f, label: FAMILY_INFO[f].label }))]}
      />
      <Segmented<IntegrationFilter>
        label="Show"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'api', label: 'API' },
          { value: 'websites', label: 'Websites' },
          { value: 'device', label: 'On device' },
          { value: 'unavailable', label: 'Not available' },
        ]}
      />

      {shown.length === 0 ? <Empty title="Nothing in this group" /> : (
        <div className="stack">
          {shown.map((d) => (
            <IntegrationCard key={d.id} d={d} view={views[d.id]} mode={mode} bridge={bridge} onChanged={refresh} previewAction={previewAction} executeAction={executeAction} notify={notify} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One line per provider and per way of reaching it, so a website or app launch is never mistaken for an API connection. */
export function ProviderOverview({ views, mode, selected, onSelect }: { views: Record<string, IntegrationView>; mode: Mode; selected: ProviderFamily | 'all'; onSelect: (f: ProviderFamily | 'all') => void }) {
  return (
    <Panel title="Providers at a glance" eyebrow="Each way of connecting has its own status">
      <div className="stack tight">
        {FAMILY_ORDER.filter((f) => f !== 'other').map((f) => (
          <div key={f} className="stack tight" role="group" aria-label={`${FAMILY_INFO[f].label} connection methods`}>
            <div className="row wrap">
              <strong>{FAMILY_INFO[f].label}</strong>
              <Button size="sm" variant="quiet" aria-pressed={selected === f} onClick={() => onSelect(selected === f ? 'all' : f)}>{selected === f ? 'Show all' : 'Show only these'}</Button>
            </div>
            <p className="field-hint">{FAMILY_INFO[f].note}</p>
            <ul className="field-hint">
              {familyRows(f, views, mode).map((r) => (
                <li key={r.id}><Badge tone={r.method === 'unavailable' ? 'muted' : 'accent'}>{METHOD_LABEL[r.method]}</Badge> {r.name}: <Badge tone={r.tone}>{toneWord(r.tone)}</Badge> {r.text}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function toneWord(t: Tone): string {
  return t === 'ok' ? 'Ready' : t === 'danger' ? 'Problem' : t === 'warn' ? 'Attention' : t === 'info' ? 'Handoff' : 'Info';
}

/** Real check of the app-launch route: asks the existing action flow whether the exe is approved and present. */
function AppLaunchControls({ app, previewAction, executeAction, notify }: { app: { exe: string; label: string } } & Pick<IntegrationsPanelProps, 'previewAction' | 'executeAction' | 'notify'>) {
  return (
    <div className="stack tight">
      <strong className="field-hint">App launch</strong>
      <p className="field-hint">Starts {app.exe} through Computer actions. It works only after you add {app.exe} to Approved apps in Settings, and it does not sign in or connect an account.</p>
      <ApprovedLink label={app.label} doneVerb="Started" copyable={false} build={() => ({ ok: true, action: { type: 'launch', target: app.exe } })} previewAction={previewAction} executeAction={executeAction} notify={notify} />
    </div>
  );
}

export function IntegrationCard({ d, view, mode, bridge, onChanged, previewAction, executeAction, notify }: { d: IntegrationDefinition; view?: IntegrationView; onChanged: () => Promise<void> } & IntegrationsPanelProps) {
  const st = stateText(d, view, mode);
  return (
    <Panel title={d.name} eyebrow={`${d.provider}${d.scope ? ` · Roadmap ${d.scope}` : ' · No roadmap scope yet'}`} actions={<Badge tone={d.availability === 'handoff' ? 'info' : d.availability === 'gated' ? 'warn' : isCheckable(d) || d.availability === 'local' ? 'accent' : 'muted'}>{AVAILABILITY_LABEL[d.availability]}</Badge>}>
      <div className="stack tight">
        <p>{d.summary}</p>
        {d.notThis && <p className="field-hint">{d.notThis}</p>}
        <p><Badge tone={st.tone}>Status</Badge> <span role="status">{st.text}</span></p>
        {view?.lastCheck?.detail && <p className="field-hint">{view.lastCheck.detail}</p>}
        {view?.lastCheck && !view.lastCheck.ok && view.lastCheck.hint && <p className="field-hint">Next step: {view.lastCheck.hint}</p>}
        {!view?.lastCheck && view?.previousCheck && <p className="field-hint">Earlier session: the check {view.previousCheck.ok ? 'passed' : `failed${view.previousCheck.reason ? ` (${view.previousCheck.reason})` : ''}`} on {new Date(view.previousCheck.at).toLocaleString()}. Check again to confirm it still works.</p>}
        {d.related?.map((r) => <p key={r.id} className="field-hint"><strong>Not the same as {findIntegration(r.id)?.name ?? r.id}.</strong> {r.why}</p>)}
        <Facts title="What leaves this computer" items={d.dataLeaves.length ? d.dataLeaves : ['Nothing']} />
        {d.blockers.length > 0 && <Facts title="Blocked by" items={d.blockers} />}
        {bridge && d.check?.online && isCheckable(d) ? <SetupProgress d={d} view={view} mode={mode} /> : d.setup.length > 0 && <Facts title="Setup" items={d.setup} ordered />}
        {d.availability === 'handoff' && <HandoffControls d={d} previewAction={previewAction} executeAction={executeAction} notify={notify} />}
        {d.availability === 'handoff' && FAMILY_INFO[familyOf(d)].app && <AppLaunchControls app={FAMILY_INFO[familyOf(d)].app!} previewAction={previewAction} executeAction={executeAction} notify={notify} />}
        {bridge && isCheckable(d) && <ApiControls d={d} view={view} bridge={bridge} onChanged={onChanged} notify={notify} previewAction={previewAction} executeAction={executeAction} />}
        {d.id === 'issue-draft' && <IssueDraft notify={notify} />}
        {d.id === 'data-preview' && bridge && <UsageHistory bridge={bridge} />}
      </div>
    </Panel>
  );
}

function Facts({ title, items, ordered }: { title: string; items: string[]; ordered?: boolean }) {
  const List = ordered ? 'ol' : 'ul';
  return (
    <div>
      <strong className="field-hint">{title}</strong>
      <List className="field-hint">{items.map((x) => <li key={x}>{x}</li>)}</List>
    </div>
  );
}

function SetupProgress({ d, view, mode }: { d: IntegrationDefinition; view?: IntegrationView; mode: Mode }) {
  const steps = setupChecklist(d, view, mode);
  const next = steps.find((x) => !x.done);
  return (
    <div>
      <strong className="field-hint">Setup progress</strong>
      <ol className="field-hint" aria-label={`${d.name} setup progress`}>
        {steps.map((x) => <li key={x.id}>{x.done ? 'Done' : x.id === next?.id ? 'Next' : 'To do'}: {x.label}</li>)}
      </ol>
    </div>
  );
}

type LinkBuild = { ok: true; action: ActionRequest & { target: string } } | { ok: false; reason: string };

/**
 * Shared approved-link flow: build the link, preview it through the existing action approval, show what the user is about
 * to open (host and any warnings), then open only after "Approve and open". "Copy link" is the manual route: nothing is
 * opened, so a different browser or profile can be used by pasting it there.
 */
function ApprovedLink({ label, build, primary, copyable = true, doneVerb = 'Opened', previewAction, executeAction, notify }: { label: string; build: () => LinkBuild; primary?: boolean; copyable?: boolean; doneVerb?: string } & Pick<IntegrationsPanelProps, 'previewAction' | 'executeAction' | 'notify'>) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);

  const prepare = async () => {
    const built = build();
    if (!built.ok) return setError(built.reason);
    setError(null);
    setBusy(true);
    try {
      setPending({ request: built.action, preview: await previewAction(built.action) });
    } catch (e) {
      setError(errMsg(e, 'The link could not be previewed.'));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    const built = build();
    if (!built.ok) return setError(built.reason);
    setError(null);
    try { await navigator.clipboard.writeText(built.action.target); notify('ok', 'Link copied. Nothing was opened.'); } catch { notify('error', 'Clipboard is unavailable. Nothing was copied.'); }
  };
  const decide = async (approved: boolean) => {
    if (!pending) return;
    setBusy(true);
    try {
      const out = actionOutcome(await executeAction(pending.preview.id, approved), approved);
      notify(out.kind === 'ran' ? 'ok' : 'info', out.kind === 'ran' ? `${doneVerb} ${pending.request.target}` : out.message ?? 'Nothing opened.');
    } catch (e) {
      notify('error', errMsg(e));
    } finally {
      setPending(null);
      setBusy(false);
    }
  };
  const look = pending ? inspectLink(pending.request.target ?? '') : null;

  return (
    <div className="stack tight">
      {error && <p className="field-error" role="alert">{error}</p>}
      {!pending ? (
        <div className="row wrap">
          <Button icon={ArrowSquareOut} variant={primary ? 'primary' : undefined} onClick={prepare} busy={busy}>{label}</Button>
          {copyable && <Button icon={Copy} variant="quiet" onClick={copy}>Copy link</Button>}
        </div>
      ) : (
        <div className="stack tight">
          <p><strong>{pending.preview.summary}</strong>{pending.preview.allowed ? '' : ` — ${pending.preview.reason ?? 'Not allowed'}`}</p>
          {look && look.notes.length > 0 && <ul className="field-hint" aria-label="Link warnings">{look.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <div className="row">
            {pending.preview.allowed && <Button variant="primary" onClick={() => decide(true)} busy={busy}>{doneVerb === 'Opened' ? 'Approve and open' : 'Approve and start'}</Button>}
            <Button variant="quiet" onClick={() => decide(false)} disabled={busy}>{pending.preview.allowed ? 'Cancel' : 'Close'}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function HandoffControls({ d, previewAction, executeAction, notify }: { d: IntegrationDefinition } & Pick<IntegrationsPanelProps, 'previewAction' | 'executeAction' | 'notify'>) {
  const [url, setUrl] = useState('');
  const field = d.handoff?.userLink ?? (d.handoff ? undefined : { label: 'Link to open', placeholder: 'https://', hosts: [] as readonly string[] });
  const pasted = !!field && url.trim() !== '';
  return (
    <div className="stack tight">
      {field && (
        <Field label={field.label} hint={field.hosts.length ? `Only ${field.hosts.join(', ')} links are accepted.` : 'http or https only'}>
          {(id, describedBy) => <input id={id} aria-describedby={describedBy} className="input" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={field.placeholder} />}
        </Field>
      )}
      <ApprovedLink label={d.handoff ? (pasted ? 'Open pasted link' : d.handoff.label) : 'Preview link'} primary build={() => handoffAction(d, url)} previewAction={previewAction} executeAction={executeAction} notify={notify} />
    </div>
  );
}

function ApiControls({ d, view, bridge, onChanged, notify, previewAction, executeAction }: { d: IntegrationDefinition; view?: IntegrationView; bridge: IntegrationsBridge; onChanged: () => Promise<void> } & Pick<IntegrationsPanelProps, 'previewAction' | 'executeAction' | 'notify'>) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<null | 'key' | 'remove' | 'preview' | 'check' | 'toggle' | 'disconnect'>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [preview, setPreview] = useState<EgressPreview | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  const act = async (kind: NonNullable<typeof busy>, op: () => Promise<void>) => {
    setBusy(kind);
    try { await op(); } catch (e) { notify('error', errMsg(e)); } finally { setBusy(null); }
  };
  const saveKey = () => act('key', async () => {
    const value = key;
    setKey(''); // the key is not kept in renderer state after submission
    const r = await bridge.setKey(d.id, value);
    notify(r.warning ? 'info' : 'ok', r.warning ?? 'Key stored and protected.');
    await onChanged();
  });

  const optIn = needsOptIn(d);
  const on = view?.enabled === true;
  const storage = view?.choiceStorage;
  const blockedOff = optIn && !on;
  const warnings = d.key ? keyWarnings(d, key) : [];
  const canDisconnect = !!d.key && optIn && view?.keyConfigured === true;
  const disconnect = () => act('disconnect', async () => {
    // The key goes first: if turning off then fails, no secret is left behind and the refreshed page shows what remains.
    try {
      if (view?.keyConfigured) await bridge.removeKey(d.id);
      if (on) await bridge.setEnabled(d.id, false);
      setResult(null);
      setPreview(null);
      notify('ok', `${d.name} disconnected: the key was removed and it is turned off.`);
    } finally {
      setConfirmDisconnect(false);
      await onChanged();
    }
  });

  return (
    <div className="stack tight">
      {optIn && (
        <div className="row wrap">
          <Button icon={Power} variant={on ? 'quiet' : 'primary'} aria-pressed={on} busy={busy === 'toggle'} disabled={storage === 'not-connected'}
            onClick={() => act('toggle', async () => { await bridge.setEnabled(d.id, !on); setResult(null); notify('ok', on ? `${d.name} turned off.` : `${d.name} turned on. Checks still ask before sending.`); await onChanged(); })}>
            {on ? 'Turn off' : 'Turn on'}
          </Button>
          {storage === 'not-connected' && <span className="field-hint">Choices cannot be saved in this build, so this stays off.</span>}
          {storage === 'unreadable' && <span className="field-error" role="alert">Saved choices could not be read; everything stays off.</span>}
        </div>
      )}
      {d.key && (
        <div className="row wrap align-end">
          <Field label={d.key.label} hint={view?.keyConfigured ? 'A key is stored. Enter a new one to replace it.' : `Create your own in ${d.key.where}. It is protected with Windows DPAPI and never shown again.`}>
            {(id, describedBy) => <input id={id} aria-describedby={describedBy} className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />}
          </Field>
          <Button icon={Key} onClick={saveKey} disabled={!key.trim()} busy={busy === 'key'}>Store key</Button>
          {view?.keyConfigured && <Button icon={Trash} variant="danger" busy={busy === 'remove'} onClick={() => act('remove', async () => { await bridge.removeKey(d.id); setResult(null); notify('ok', 'Key removed.'); await onChanged(); })}>Remove key</Button>}
        </div>
      )}
      {warnings.length > 0 && <ul className="field-hint" aria-label="Key warnings">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
      {d.key?.pageUrl && !view?.keyConfigured && (
        <ApprovedLink label={`Open the ${d.key.label} page`} build={() => keyPageAction(d)} previewAction={previewAction} executeAction={executeAction} notify={notify} />
      )}
      {canDisconnect && (!confirmDisconnect ? (
        <div className="row"><Button icon={LinkBreak} variant="quiet" onClick={() => setConfirmDisconnect(true)}>Disconnect</Button></div>
      ) : (
        <div className="stack tight" role="group" aria-label="Confirm disconnect">
          <p>Remove the stored key and turn off {d.name}? You can set it up again later; the key itself cannot be recovered from this app.</p>
          <div className="row">
            <Button icon={LinkBreak} variant="danger" busy={busy === 'disconnect'} onClick={disconnect}>Remove key and turn off</Button>
            <Button variant="quiet" onClick={() => setConfirmDisconnect(false)} disabled={busy === 'disconnect'}>Keep connected</Button>
          </div>
        </div>
      ))}
      <div className="row wrap">
        <Button icon={ShieldCheck} busy={busy === 'preview'} onClick={() => act('preview', async () => setPreview(await bridge.preview(d.id)))}>Preview what is sent</Button>
        <Button icon={PlugsConnected} variant="primary" busy={busy === 'check'} disabled={blockedOff} onClick={() => act('check', async () => { setResult(await bridge.check(d.id)); await onChanged(); })}>Check connection</Button>
      </div>
      {preview && (
        <dl className="kv-list" aria-label="Data preview">
          <div className="kv"><dt>Destination</dt><dd>{preview.destination}{preview.path}</dd></div>
          <div className="kv"><dt>Request</dt><dd>{preview.method || 'None'}{preview.headerNames.length ? ` · headers: ${preview.headerNames.join(', ')}` : ''}</dd></div>
          <div className="kv"><dt>Key</dt><dd>{preview.keySent ? `Sent in ${preview.keyHeader}; the value is never shown or logged` : 'Not sent'}</dd></div>
          <div className="kv"><dt>Response</dt><dd>{preview.response}</dd></div>
          <div className="kv"><dt>Can run now</dt><dd>{preview.allowed ? 'Yes, after your confirmation' : preview.reason}</dd></div>
        </dl>
      )}
      {result && <p role="status" className={result.ok ? 'field-hint' : 'field-error'}>{result.ok ? (result.detail ?? 'Connection check passed.') : result.reason}{!result.ok && result.hint ? ` ${result.hint}` : ''}</p>}
    </div>
  );
}

function IssueDraft({ notify }: { notify: IntegrationsPanelProps['notify'] }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [out, setOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const build = () => {
    try { setOut(formatIssueDraft({ title, body })); setError(null); } catch (e) { setOut(null); setError(errMsg(e)); }
  };
  const copy = async () => {
    if (!out) return;
    try { await navigator.clipboard.writeText(out); notify('ok', 'Draft copied.'); } catch { notify('error', 'Clipboard is unavailable. Select the text and copy it.'); }
  };
  return (
    <div className="stack tight">
      <Field label="Issue title" error={error}>{(id, describedBy) => <input id={id} aria-describedby={describedBy} className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="Description">{(id) => <textarea id={id} className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
      <div className="row">
        <Button icon={ClipboardText} onClick={build}>Format draft</Button>
        {out && <Button onClick={copy}>Copy</Button>}
      </div>
      {out && <pre className="field-hint" aria-label="Formatted draft">{out}</pre>}
    </div>
  );
}

function UsageHistory({ bridge }: { bridge: IntegrationsBridge }) {
  const [rows, setRows] = useState<UsageEntry[] | null>(null);
  const load = useCallback(async () => { try { setRows(await bridge.usage()); } catch { setRows([]); } }, [bridge]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="stack tight">
      <div className="row">
        <Button size="sm" onClick={load}>Refresh</Button>
        <Button size="sm" variant="quiet" onClick={async () => { await bridge.clearUsage(); await load(); }}>Clear history</Button>
      </div>
      {!rows || rows.length === 0 ? <p className="field-hint">No provider requests in this session.</p> : (
        <ul className="field-hint" aria-label="Provider request history">
          {rows.map((r, i) => <li key={`${r.at}-${i}`}>{new Date(r.at).toLocaleString()} · {r.id} · {r.origin} · {r.ok ? 'ok' : 'failed'}{r.status ? ` (HTTP ${r.status})` : ''}{r.reason ? ` · ${r.reason}` : ''}</li>)}
        </ul>
      )}
    </div>
  );
}
