import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, Cube, DownloadSimple, Eject, FolderOpen, ShieldCheck, Stop } from '@phosphor-icons/react';
// Types only: the service module pulls in main-process code and must never be bundled into the window.
import type { HealthState, ModelJob, ModelsClient, ModelsOverview, PackValidation, ResourceProfileId } from '../../electron/services/models';
import { Badge, Button, Empty, Field, LoadingBlock, Notice, PageHeader, Panel, Segmented, type Tone } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { DOWNLOAD_MANIFEST_MAX_CHARS, normalizeAllowedHosts, parseDownloadManifest, parseHostsInput, planDownload, type ParseResult, type PlanEntry } from '../ui/download-manifest';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

const HEALTH: Record<HealthState, { tone: Tone; label: string }> = {
  ready: { tone: 'ok', label: 'Ready' },
  'model-missing': { tone: 'warn', label: 'Model not installed' },
  'server-down': { tone: 'warn', label: 'Ollama not running' },
  blocked: { tone: 'danger', label: 'Endpoint blocked' },
  error: { tone: 'danger', label: 'Error' },
};

export interface ModelsViewProps {
  overview: ModelsOverview | null;
  error: string | null;
  loading: boolean;
  /** Name of the model the app is configured to chat with. */
  currentModel: string;
  /** Key of the action in flight (for example "select:name"), or null. */
  busy: string | null;
  notice: string | null;
  packDir: string;
  packCheck: PackValidation | null;
  pullName: string;
  canBrowse: boolean;
  /** True when there is no backend (browser preview): every action is disabled. */
  preview: boolean;
  onPackDir: (v: string) => void;
  onPullName: (v: string) => void;
  onRefresh: () => void;
  onSelect: (name: string) => void;
  onUnload: (name?: string) => void;
  onProfile: (id: ResourceProfileId) => void;
  onBrowse: () => void;
  onValidate: () => void;
  onImport: () => void;
  onPull: () => void;
  onCancel: (id: string) => void;
}

function JobRow({ job, onCancel }: { job: ModelJob; onCancel: (id: string) => void }) {
  const tone: Tone = job.state === 'done' ? 'ok' : job.state === 'failed' ? 'danger' : job.state === 'cancelled' ? 'muted' : 'info';
  return (
    <li className="cap-row">
      <Badge tone={tone}>{job.state}</Badge>
      <div>
        <strong>{job.kind === 'pull' ? 'Download' : 'Import'}: {job.model}</strong>
        <p className="field-hint">{job.error ?? job.status}</p>
        {job.state === 'running' && <progress aria-label={`${job.model} progress`} max={100} {...(job.progress === null ? {} : { value: Math.round(job.progress * 100) })} />}
      </div>
      {job.state === 'running' && <Button size="sm" icon={Stop} onClick={() => onCancel(job.id)}>Cancel</Button>}
    </li>
  );
}

const PLAN_TONE: Record<PlanEntry['status'], Tone> = { 'ready-to-request': 'ok', 'blocked-offline': 'muted', 'blocked-host': 'warn', invalid: 'danger' };

/**
 * Offline manifest verifier (feature 107). Parses pasted JSON and shows the plan; it never fetches anything.
 * `onlineEnabled` comes from the app's existing online/offline download state.
 */
export function ManifestVerifyPanel({ onlineEnabled }: { onlineEnabled: boolean }) {
  const [text, setText] = useState('');
  const [storedHosts, setStoredHosts] = usePref<unknown>('models.downloadHosts', []);
  const hosts = normalizeAllowedHosts(storedHosts);
  const [hostsText, setHostsText] = useState(() => hosts.join(', '));
  const [result, setResult] = useState<{ parsed: ParseResult; plan: PlanEntry[] } | null>(null);
  const validate = () => {
    const allowed = parseHostsInput(hostsText);
    setStoredHosts(allowed);
    const parsed = parseDownloadManifest(text, allowed);
    setResult({ parsed, plan: parsed.ok ? planDownload(parsed.manifest, { onlineEnabled, allowedHosts: allowed }) : [] });
  };
  return (
    <Panel title="Verify download manifest (offline)" eyebrow="Optional model and update downloads">
      <p className="field-hint">This build verifies manifests only; no download is started.</p>
      <p className="field-hint">Online downloads: {onlineEnabled ? 'enabled by online mode (still not acted on by this verifier)' : 'off (offline mode)'}.</p>
      <Field label="Manifest JSON" hint={`Paste a manifest, at most ${DOWNLOAD_MANIFEST_MAX_CHARS} characters.`}>
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={6} spellCheck={false} maxLength={DOWNLOAD_MANIFEST_MAX_CHARS + 1} value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} />}
      </Field>
      <Field label="Allowed hosts" hint="Comma-separated exact host names, for example models.example.org. Empty rejects every URL.">
        {(id, d) => <input id={id} aria-describedby={d} className="input mono" spellCheck={false} maxLength={2000} value={hostsText} onChange={(e) => { setHostsText(e.target.value); setResult(null); }} />}
      </Field>
      <Button icon={ShieldCheck} disabled={!text.trim()} onClick={validate}>Validate</Button>
      {result && (result.parsed.ok ? (
        <>
          <Notice tone="info" title="Manifest is valid">{result.parsed.manifest.items.length} item(s). Nothing was downloaded.</Notice>
          {result.parsed.warnings.length > 0 && <Notice tone="warn" title="Warnings"><ul>{result.parsed.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul></Notice>}
          <ul className="cap-list">
            {result.plan.map((e, i) => (
              <li key={`${e.id}-${i}`} className="cap-row">
                <Badge tone={PLAN_TONE[e.status]}>{e.status}</Badge>
                <div><strong>{e.id}</strong><p className="field-hint">{e.reason}</p></div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <Notice tone="danger" title="Manifest rejected"><ul>{result.parsed.errors.slice(0, 20).map((e, i) => <li key={i}><code>{e.path}</code>: {e.message}</li>)}</ul></Notice>
      ))}
    </Panel>
  );
}

/** Presentation only; Models() below owns the state. Rendered directly in tests. */
export function ModelsView(p: ModelsViewProps) {
  const o = p.overview;
  const disabled = p.preview || p.busy !== null;
  const h = o?.health;
  return (
    <div className="page">
      <PageHeader
        eyebrow="Local AI"
        title="Models"
        subtitle="Everything here talks to Ollama on this computer. Nothing is downloaded unless you start a download in online mode."
        actions={<Button icon={ArrowClockwise} busy={p.loading} disabled={p.preview} onClick={p.onRefresh}>Refresh</Button>}
      />
      {p.preview && <Notice tone="warn" title="Browser preview">There is no backend here, so nothing about local models can be read or changed. Open the Electron app.</Notice>}
      {p.error && <Notice tone="danger" title="Could not read model status">{p.error}</Notice>}
      {p.notice && <Notice tone="info">{p.notice}</Notice>}
      {!o && !p.error && !p.preview && <LoadingBlock label="Checking Ollama…" />}

      {o && h && (
        <div className="two-col">
          <div className="stack">
            <Panel title="Runtime" eyebrow="Ollama on loopback">
              <ul className="cap-list">
                <li className="cap-row">
                  <Badge tone={HEALTH[h.state].tone}>{HEALTH[h.state].label}</Badge>
                  <div>
                    <strong>{h.endpoint}</strong>
                    <p className="field-hint">
                      {h.version ? `Ollama ${h.version}. ` : ''}{h.latencyMs !== null ? `Answered in ${h.latencyMs} ms. ` : ''}Configured model: {h.configuredModel || 'none'}.
                      {h.reason ? ` ${h.reason}` : ''}
                    </p>
                    {h.notes.map((n) => <p key={n} className="field-hint">{n}</p>)}
                  </div>
                </li>
              </ul>
              <h3>Loaded in memory</h3>
              {h.loaded.length === 0 ? (
                <p className="field-hint">No model is loaded right now.</p>
              ) : (
                <ul className="cap-list">
                  {h.loaded.map((m) => (
                    <li key={m.name} className="cap-row">
                      <Badge tone="info">{formatBytes(m.sizeBytes)}</Badge>
                      <div>
                        <strong>{m.name}</strong>
                        <p className="field-hint">{m.vramBytes > 0 ? `${formatBytes(m.vramBytes)} on the graphics card. ` : 'Running on the processor. '}{m.expiresAt ? 'Unloads automatically later.' : ''}</p>
                      </div>
                      <Button size="sm" icon={Eject} disabled={disabled} onClick={() => p.onUnload(m.name)}>Unload</Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Installed models" eyebrow="From Ollama">
              {o.installedError && <Notice tone="warn" title="List unavailable">{o.installedError}</Notice>}
              {!o.installedError && o.installed.length === 0 && <Empty icon={Cube} title="No models installed">Import a model pack below, or install one in Ollama yourself.</Empty>}
              <ul className="cap-list">
                {o.installed.map((m) => {
                  const current = m.name === p.currentModel || m.name === `${p.currentModel}:latest`;
                  return (
                    <li key={m.name} className="cap-row">
                      <Badge tone={current ? 'ok' : 'muted'}>{current ? 'In use' : formatBytes(m.sizeBytes)}</Badge>
                      <div>
                        <strong>{m.name}</strong>
                        <p className="field-hint">{[m.family, m.parameterSize, m.quantization].filter(Boolean).join(' · ') || 'No details reported'}{current ? ` · ${formatBytes(m.sizeBytes)}` : ''}</p>
                      </div>
                      {!current && <Button size="sm" disabled={disabled} busy={p.busy === `select:${m.name}`} onClick={() => p.onSelect(m.name)}>Use this model</Button>}
                    </li>
                  );
                })}
              </ul>
            </Panel>

            <Panel title="Resource profile" eyebrow="Memory use">
              <Segmented
                label="Resource profile"
                value={o.activeProfile}
                onChange={p.onProfile}
                options={o.profiles.map((r) => ({ value: r.id, label: r.label, hint: r.description }))}
              />
              <p className="field-hint">{o.profiles.find((r) => r.id === o.activeProfile)?.description}</p>
              <p className="field-hint">Suggestion for this computer: {o.profiles.find((r) => r.id === o.recommendedProfile.id)?.label}. {o.recommendedProfile.reason} Applies to the next local message.</p>
            </Panel>
          </div>

          <div className="stack">
            <Panel title="Import a model pack" eyebrow="Offline">
              <p className="field-hint">A model pack is a folder with a modelpack.json and the .gguf files it lists. Sizes and SHA-256 checksums are verified before anything is sent to Ollama. No internet is used.</p>
              <Field label="Pack folder">
                {(id, d) => (
                  <div className="row">
                    <input id={id} aria-describedby={d} className="input mono" value={p.packDir} spellCheck={false} maxLength={400} disabled={p.preview} onChange={(e) => p.onPackDir(e.target.value)} placeholder="C:\Models\my-pack" />
                    {p.canBrowse && <Button icon={FolderOpen} disabled={disabled} onClick={p.onBrowse}>Browse</Button>}
                  </div>
                )}
              </Field>
              <div className="row">
                <Button icon={ShieldCheck} disabled={disabled || !p.packDir.trim()} busy={p.busy === 'validate'} onClick={p.onValidate}>Verify pack</Button>
                <Button variant="primary" icon={DownloadSimple} disabled={disabled || !p.packCheck?.ok} busy={p.busy === 'import'} onClick={p.onImport}>Import into Ollama</Button>
              </div>
              {p.packCheck && (p.packCheck.ok
                ? <Notice tone="info" title="Pack verified">{p.packCheck.manifest?.name}: {p.packCheck.manifest?.files.length} file(s), {formatBytes(p.packCheck.totalBytes)}. Importing asks for your confirmation.</Notice>
                : <Notice tone="danger" title="Pack rejected"><ul>{p.packCheck.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul></Notice>)}
            </Panel>

            <Panel title="Download a model" eyebrow="Online only">
              {o.downloads.allowed ? (
                <>
                  <p className="field-hint">Ollama downloads the model from the internet after you confirm. Cancel any time; partial downloads can resume.</p>
                  <Field label="Model name" hint="For example name:tag">
                    {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={p.pullName} spellCheck={false} maxLength={200} onChange={(e) => p.onPullName(e.target.value)} />}
                  </Field>
                  <Button variant="primary" icon={DownloadSimple} disabled={disabled || !p.pullName.trim()} busy={p.busy === 'pull'} onClick={p.onPull}>Start download</Button>
                </>
              ) : (
                <Notice tone="info" title="Downloads are off">{o.downloads.reason}</Notice>
              )}
            </Panel>

            <Panel title="Jobs" eyebrow="Import and download">
              {o.jobs.length === 0 ? <p className="field-hint">No jobs yet.</p> : <ul className="cap-list">{o.jobs.map((j) => <JobRow key={j.id} job={j} onCancel={p.onCancel} />)}</ul>}
            </Panel>

            <Panel title="Other local AI abilities" eyebrow="Reported, not assumed">
              <ul className="cap-list">
                {o.capabilities.map((c) => (
                  <li key={c.id} className="cap-row">
                    <Badge tone={c.available ? 'ok' : 'warn'}>{c.available ? 'Available' : 'Unavailable'}</Badge>
                    <div>
                      <strong>{c.name}</strong>
                      {c.reason && <p className="field-hint">{c.reason}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}
      <ManifestVerifyPanel onlineEnabled={o?.downloads.allowed === true} />
    </div>
  );
}

/**
 * Local model manager. `client` is the IPC bridge for ModelsClient (null in a browser preview).
 * `onUseModel` saves the settings patch; the host decides how (the AI connection change needs its trusted confirmation).
 */
export function Models({ client, currentModel, onUseModel }: { client: ModelsClient | null; currentModel: string; onUseModel: (patch: { localModel: string }) => Promise<void> }) {
  const [overview, setOverview] = useState<ModelsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [packDir, setPackDir] = useState('');
  const [packCheck, setPackCheck] = useState<PackValidation | null>(null);
  const [pullName, setPullName] = useState('');
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      const next = await client.overview();
      if (alive.current) { setOverview(next); setError(null); }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh, currentModel]);

  // Poll only while a job runs.
  const running = overview?.jobs.some((j) => j.state === 'running') ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => { void refresh(); }, 1500);
    return () => window.clearInterval(t);
  }, [running, refresh]);

  const act = async (key: string, fn: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const msg = await fn();
      if (alive.current && msg) setNotice(msg);
    } catch (e) {
      if (alive.current) setNotice(e instanceof Error ? e.message : 'The action failed');
    } finally {
      if (alive.current) setBusy(null);
      void refresh();
    }
  };

  return (
    <ModelsView
      overview={overview} error={error} loading={loading} currentModel={currentModel} busy={busy} notice={notice}
      packDir={packDir} packCheck={packCheck} pullName={pullName} canBrowse={Boolean(client?.pickPackFolder)} preview={!client}
      onPackDir={(v) => { setPackDir(v); setPackCheck(null); }}
      onPullName={setPullName}
      onRefresh={() => void refresh()}
      onSelect={(name) => void act(`select:${name}`, async () => {
        const r = await client!.select(name, { warm: false, unloadOthers: true });
        if (!r.ok) return r.reason;
        await onUseModel(r.patch);
        return `Now using ${r.patch.localModel}.`;
      })}
      onUnload={(name) => void act('unload', async () => {
        const r = await client!.unload(name);
        return r.ok ? `Unloaded ${r.unloaded.join(', ') || 'nothing'}.` : r.reason;
      })}
      onProfile={(id) => void act('profile', async () => { await client!.setProfile(id); return null; })}
      onBrowse={() => void act('browse', async () => {
        const dir = await client!.pickPackFolder?.();
        if (dir) { setPackDir(dir); setPackCheck(null); }
        return null;
      })}
      onValidate={() => void act('validate', async () => { setPackCheck(await client!.validatePack(packDir)); return null; })}
      onImport={() => void act('import', async () => {
        const r = await client!.startImport(packDir);
        return r.ok ? 'Import started.' : r.reason;
      })}
      onPull={() => void act('pull', async () => {
        const r = await client!.startPull(pullName);
        return r.ok ? 'Download started.' : r.reason;
      })}
      onCancel={(id) => void act('cancel', async () => ((await client!.cancelJob(id)) ? 'Cancelling…' : 'That job is no longer running.'))}
    />
  );
}
