import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, Cube, DownloadSimple, Eject, FolderOpen, ShieldCheck, Stop } from '@phosphor-icons/react';
// Types only: the service module pulls in main-process code and must never be bundled into the window.
import type { HealthState, ModelJob, ModelsClient, ModelsOverview, PackValidation, ResourceProfileId } from '../../electron/services/models';
import { Badge, Button, Empty, Field, LoadingBlock, Notice, PageHeader, Panel, Segmented, type Tone } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { DOWNLOAD_MANIFEST_MAX_CHARS, normalizeAllowedHosts, parseDownloadManifest, parseHostsInput, planDownload, type ParseResult, type PlanEntry } from '../ui/download-manifest';
import type { ModelPin, PinVerifyResult } from '../shared/contracts';
import { modelPinsBridge, type ModelPinsClient } from '../ui/bridges';
import { describePinStatus, digestPrefix, findPin, isPinMismatch } from '../ui/model-pins';
import { DATASET_LIMITS, buildExamples, buildManifest, datasetStats, parseTranscript, scanExamples, splitDataset, toJsonl, type BuildResult, type ScanResult, type SplitResult, type TranscriptParseResult } from '../ui/finetune-dataset';

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
  /** Version pins (window.jarvisModelPins); absent in the browser preview and in older callers. */
  pins?: ModelPinsClient | null;
  pinList?: ModelPin[];
  /** Model name -> reason text when a switch to it was refused by its pin. */
  pinBlocked?: Record<string, string>;
  onPinsChanged?: () => void;
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

export const FINETUNE_DATASET_NOTE = 'This build builds and checks a dataset file only; no training or upload is started.';

/** Save text as a local file through a temporary Blob URL that is revoked right after the click. */
function downloadTextFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface FinetuneParsed { parsed: TranscriptParseResult; built: BuildResult; scan: ScanResult }

/** Offline fine-tuning dataset builder (goal 20, export only). Nothing here trains, uploads or calls a model. */
export function FinetuneDatasetPanel() {
  const [text, setText] = useState('');
  const [ratioText, setRatioText] = useState('0.1');
  const [seed, setSeed] = useState('1');
  const [data, setData] = useState<FinetuneParsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const parse = () => {
    setStatus(null);
    try {
      const parsed = parseTranscript(text);
      const built = buildExamples(parsed.examples, { dedupe: true, maxTurnChars: DATASET_LIMITS.turnChars });
      setData({ parsed, built, scan: scanExamples(built.examples) });
      setError(null);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : 'Could not parse the transcript.');
    }
  };
  const split = useMemo<{ ok: true; value: SplitResult } | { ok: false; message: string } | null>(() => {
    if (!data) return null;
    const ratio = Number(ratioText.trim());
    try {
      if (!ratioText.trim()) throw new RangeError('Validation ratio must be a number from 0 to 0.5.');
      return { ok: true, value: splitDataset(data.built.examples, ratio, seed) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Invalid validation ratio.' };
    }
  }, [data, ratioText, seed]);
  const stats = data ? datasetStats(data.built.examples) : null;
  const copyManifest = async () => {
    if (!split || !split.ok) return;
    const json = JSON.stringify(buildManifest(split.value, new Date().toISOString()), null, 2);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is not available here.');
      await navigator.clipboard.writeText(json);
      setStatus('Manifest JSON copied.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Could not copy the manifest.');
    }
  };
  const reasonCounts = data ? Object.entries(data.parsed.skipped.reduce<Record<string, number>>((acc, s) => { acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc; }, {})) : [];
  return (
    <Panel title="Fine-tuning dataset (offline, export only)" eyebrow="Personal fine-tuning experiments">
      <p className="field-hint">{FINETUNE_DATASET_NOTE}</p>
      <Field label="Transcript" hint={`Lines start with User:/Me: or Assistant:/AI:. A blank line separates conversations. At most ${DATASET_LIMITS.inputChars} characters.`}>
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={8} spellCheck={false} maxLength={DATASET_LIMITS.inputChars + 1} value={text} onChange={(e) => { setText(e.target.value); setData(null); setError(null); setStatus(null); }} />}
      </Field>
      <Button icon={ShieldCheck} disabled={!text.trim()} onClick={parse}>Parse</Button>
      {error && <Notice tone="danger" title="Transcript rejected">{error}</Notice>}
      {data && stats && (
        <>
          <Notice tone="info" title="Parsed locally">
            {stats.examples} example(s), {stats.turns} turn(s) kept from {data.built.counts.input} parsed. {data.parsed.skipped.length} line(s) skipped.
            {data.parsed.truncated ? ` Truncated: only the first ${DATASET_LIMITS.examples} examples were kept.` : ' Not truncated.'}
            {` Duplicates removed: ${data.built.counts.duplicates}. Long turns cut to ${DATASET_LIMITS.turnChars} characters: ${data.built.counts.truncatedTurns}. Dropped for turns under ${DATASET_LIMITS.minTurnChars} characters: ${data.built.counts.droppedShort}.`}
          </Notice>
          <p className="field-hint">Characters per example: min {stats.minChars}, mean {stats.meanChars}, max {stats.maxChars}. About {stats.approxTokens} {stats.approxTokensLabel}.</p>
          {reasonCounts.length > 0 && <ul className="field-hint">{reasonCounts.map(([r, n]) => <li key={r}>{r}: {n}</li>)}</ul>}
          {data.scan.total > 0 ? (
            <Notice tone="warn" title="Possible personal data or secrets">
              Emails: {data.scan.emails}, URLs: {data.scan.urls}, secrets: {data.scan.secrets}, 16+ digit numbers: {data.scan.longDigits}. Review before exporting.
              <ul>{data.scan.samples.map((s, i) => <li key={i}><code>{s.exampleId}</code> {s.kind}: <code>{s.masked}</code></li>)}</ul>
            </Notice>
          ) : <p className="field-hint">Scan found no emails, URLs, secrets or long digit runs.</p>}
          <div className="row">
            <Field label="Validation ratio" hint="0 to 0.5. The split is deterministic for the same content and seed.">
              {(id, d) => <input id={id} aria-describedby={d} className="input mono" inputMode="decimal" maxLength={10} value={ratioText} onChange={(e) => setRatioText(e.target.value)} />}
            </Field>
            <Field label="Seed">
              {(id, d) => <input id={id} aria-describedby={d} className="input mono" maxLength={40} value={seed} onChange={(e) => setSeed(e.target.value)} />}
            </Field>
          </div>
          {split && (split.ok ? (
            <>
              <p className="field-hint">Split: {split.value.train.length} train, {split.value.validation.length} validation (ratio {split.value.ratio}, seed "{split.value.seed}").</p>
              <div className="row">
                <Button icon={DownloadSimple} disabled={split.value.train.length === 0} onClick={() => downloadTextFile('train.jsonl', toJsonl(split.value.train))}>Download train.jsonl</Button>
                <Button icon={DownloadSimple} disabled={split.value.validation.length === 0} onClick={() => downloadTextFile('validation.jsonl', toJsonl(split.value.validation))}>Download validation.jsonl</Button>
                <Button onClick={() => void copyManifest()}>Copy manifest JSON</Button>
              </div>
            </>
          ) : <Notice tone="danger" title="Invalid validation ratio">{split.message}</Notice>)}
          {status && <p className="field-hint" role="status">{status}</p>}
        </>
      )}
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
                        {p.pins && <ModelPinSection modelId={m.name} client={p.pins} pin={findPin(p.pinList ?? [], m.name) ?? findPin(p.pinList ?? [], m.name.replace(/:latest$/, ''))} disabled={p.preview} blocked={p.pinBlocked?.[m.name] ?? null} onChanged={() => p.onPinsChanged?.()} />}
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
      <FinetuneDatasetPanel />
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
  // Version pins: read from window.jarvisModelPins (absent in the browser preview, so the section is not shown there).
  const pinClient = useMemo(() => modelPinsBridge(typeof window !== 'undefined' ? window.jarvisModelPins : null), []);
  const [pinList, setPinList] = useState<ModelPin[]>([]);
  const [pinBlocked, setPinBlocked] = useState<Record<string, string>>({});
  // Pin sections are shown only after the main process answered a list call; otherwise the reason is shown instead.
  const [pinsReady, setPinsReady] = useState(false);
  const refreshPins = useCallback(async () => {
    if (!pinClient) return;
    try {
      const next = await pinClient.list();
      if (alive.current) { setPinList(next); setPinsReady(true); }
    } catch (e) {
      if (alive.current) {
        setPinsReady(false);
        setNotice(`Version pins are not available: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    }
  }, [pinClient]);
  useEffect(() => { void refreshPins(); }, [refreshPins]);

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
      pins={client && pinsReady ? pinClient : null} pinList={pinList} pinBlocked={pinBlocked}
      onPinsChanged={() => { setPinBlocked({}); void refreshPins(); }}
      onPackDir={(v) => { setPackDir(v); setPackCheck(null); }}
      onPullName={setPullName}
      onRefresh={() => void refresh()}
      onSelect={(name) => void act(`select:${name}`, async () => {
        const r = await client!.select(name, { warm: false, unloadOthers: true });
        if (!r.ok) {
          if ('blocked' in r && r.blocked === true) {
            setPinBlocked((cur) => ({ ...cur, [name]: r.reason }));
            return `Switch refused. ${r.reason}`;
          }
          return r.reason;
        }
        setPinBlocked((cur) => { const next = { ...cur }; delete next[name]; return next; });
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

/** Shown wherever pin status text appears: a pin is a file-integrity check, not a hardware acceptance result. */
export const PIN_SIZING_NOTE = 'Reference-laptop (G2) sizing gate: unverified. A matching pin only shows the file is unchanged; it says nothing about speed or memory fit.';

/**
 * Links src/styles/model-pins.css once. It is referenced with `new URL(..., import.meta.url)` (Vite emits it as an asset)
 * instead of a bare `import '...css'`, because the in-memory esbuild bundles used by the test suite cannot take a CSS
 * import without an output path. Styles are cosmetic: if linking fails the section still works unstyled.
 */
export function useModelPinStyles() {
  useEffect(() => {
    try {
      if (typeof document === 'undefined' || document.querySelector('link[data-model-pins-css]')) return;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = new URL('../styles/model-pins.css', import.meta.url).href;
      link.setAttribute('data-model-pins-css', '');
      document.head.appendChild(link);
    } catch { /* unstyled fallback */ }
  }, []);
}

const PIN_TONE: Record<PinVerifyResult['status'], Tone> = { match: 'ok', 'size-mismatch': 'danger', 'digest-mismatch': 'danger', unpinned: 'muted' };

/**
 * Version pin section for one local model (goal 17). Hashing happens in the main process on files it already knows;
 * the renderer never sends a path. Every failure is shown as returned, never replaced with a success message.
 */
export function ModelPinSection({ modelId, client, pin, disabled, blocked, onChanged }: { modelId: string; client: ModelPinsClient; pin: ModelPin | null; disabled: boolean; blocked?: string | null; onChanged: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'verifying' | 'pinning' | 'unpinning' | 'repinning'>('idle');
  const [result, setResult] = useState<PinVerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useModelPinStyles();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setResult(null); }, [pin?.digest, pin?.sizeBytes]);
  const run = async (next: typeof phase, fn: () => Promise<void>) => {
    setPhase(next);
    setError(null);
    try { await fn(); } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'The pin action failed');
    } finally {
      if (alive.current) setPhase('idle');
    }
  };
  const verify = () => void run('verifying', async () => { const r = await client.verify(modelId); if (alive.current) setResult(r); });
  const cancel = () => { void client.cancelVerify(modelId).catch(() => false); };
  const pinNow = () => void run('pinning', async () => {
    const r = await client.pinCurrent(modelId);
    if (!r.ok) throw new Error(`Could not pin: ${r.reason}`);
    onChanged();
  });
  const unpin = () => void run('unpinning', async () => { await client.unpin(modelId); if (alive.current) setResult(null); onChanged(); });
  const repin = () => void run('repinning', async () => {
    const r = await client.acknowledgeRepin(modelId);
    if (!r.ok) throw new Error(`Could not re-pin: ${r.reason}`);
    if (alive.current) setResult(null);
    onChanged();
  });
  const working = phase !== 'idle';
  const status = result?.status ?? (pin ? null : 'unpinned');
  const mismatch = result ? isPinMismatch(result.status) : false;
  return (
    <section className="model-pin" aria-label={`Version pin for ${modelId}`} data-pin-status={status ?? 'pinned-unchecked'}>
      <div className="model-pin-head">
        <strong>Version pin</strong>
        <Badge tone={phase === 'verifying' ? 'info' : status ? PIN_TONE[status] : 'info'}>{phase === 'verifying' ? 'Verifying…' : status ? describePinStatus(status) : 'Pinned, not checked yet'}</Badge>
      </div>
      {phase === 'verifying' && (
        <p className="model-pin-line" role="status">Hashing the local model file… <Button size="sm" icon={Stop} onClick={cancel}>Cancel</Button></p>
      )}
      {!pin && phase !== 'verifying' && <p className="field-hint">Not pinned. Pin the current file to be warned, and to have switching refused, when it no longer matches.</p>}
      {pin && !result && phase !== 'verifying' && (
        <p className="field-hint">Pinned sha256 <code className="model-pin-digest">{digestPrefix(pin.digest)}…</code> · {formatBytes(pin.sizeBytes)} · {pin.pinnedAt.slice(0, 10)}. Use Verify to check the file on disk now.</p>
      )}
      {result && result.status === 'match' && result.observed && (
        <p className="field-hint model-pin-match">Matches sha256 <code className="model-pin-digest">{digestPrefix(result.observed.digest)}…</code> · {formatBytes(result.observed.sizeBytes)}.</p>
      )}
      {result && mismatch && (
        <div className="model-pin-mismatch" role="alert">
          <p><strong>{describePinStatus(result.status)}.</strong> {result.detail}</p>
          <p className="field-hint">Switching to this model is refused until you review the file and re-pin it, or unpin it.</p>
          <Button size="sm" icon={ArrowClockwise} disabled={disabled || working} busy={phase === 'repinning'} onClick={repin}>Re-pin after review</Button>
        </div>
      )}
      {blocked && <p className="model-pin-blocked" role="alert">Switch refused: {blocked}</p>}
      <div className="row model-pin-actions">
        {pin && <Button size="sm" icon={ShieldCheck} disabled={disabled || working} onClick={verify}>Verify</Button>}
        {!pin && <Button size="sm" icon={ShieldCheck} disabled={disabled || working} busy={phase === 'pinning'} onClick={pinNow}>Pin current file</Button>}
        {pin && <Button size="sm" icon={Eject} disabled={disabled || working} busy={phase === 'unpinning'} onClick={unpin}>Unpin</Button>}
      </div>
      {error && <p className="model-pin-error" role="alert">{error}</p>}
      <p className="field-hint model-pin-gate">{PIN_SIZING_NOTE}</p>
    </section>
  );
}
