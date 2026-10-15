import { ArrowClockwise } from '@phosphor-icons/react';
import { CapabilityRow, SystemFacts } from './shared';
import { Badge, Button, Empty, Field, LoadingBlock, Notice, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { useEffect, useState } from 'react';
import { hostBatteryBridge, navigatorBatteryReader } from '../ui/bridges';
import { applyHostBatteryEvent, batteryLabel, batterySaverMotionActive, resolveBatteryStatus, unmeasuredBattery, type ResolvedBattery } from '../ui/resource-policy';
import { buildCompatReport, classifyCompatibility, compareHardware, HARDWARE_NOTE, normalizeSystemInfo, tierExplanation, tierLabel } from '../ui/compat-tiers';
import { usePref } from '../ui/prefs';
import { normalizeInstallLedger, normalizeTrustedKeys, parseUpdateManifest, planRollback, planUpdate, recordInstall, verifyManifestSignature, type RollbackPlan, type SignatureResult, type UpdatePlan } from '../ui/update-manifest';

const UPDATE_PANEL_NOTE = 'This build verifies signatures and plans only. It does not download, install or roll back anything.';

/** Offline signed-update verification: parses a pasted manifest, verifies its signature against locally trusted keys and plans. Never downloads, installs or rolls back. */
function UpdateManifestPanel() {
  const [installedVersion, setInstalledVersion] = usePref<string>('updates.installedVersion', '');
  const [trustedKeys, setTrustedKeys] = usePref<unknown[]>('updates.trustedKeys', []);
  const [ledgerRaw, setLedgerRaw] = usePref<unknown[]>('updates.installLedger', []);
  const [keysText, setKeysText] = useState(() => JSON.stringify(Array.isArray(trustedKeys) ? trustedKeys : [], null, 2));
  const [keysErrors, setKeysErrors] = useState<string[]>([]);
  const [manifestText, setManifestText] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [sig, setSig] = useState<SignatureResult | null>(null);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [recVersion, setRecVersion] = useState('');
  const [recAt, setRecAt] = useState(() => new Date().toISOString());
  const [recSha, setRecSha] = useState('');
  const [recErrors, setRecErrors] = useState<string[]>([]);
  const [rollback, setRollback] = useState<RollbackPlan | null>(null);
  const ledger = normalizeInstallLedger(ledgerRaw);

  const saveKeys = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keysText);
    } catch {
      setKeysErrors(['$: invalid JSON']);
      return;
    }
    const { keys, errors: errs } = normalizeTrustedKeys(parsed);
    setKeysErrors(errs);
    if (errs.length === 0) setTrustedKeys(keys);
  };

  const verify = async () => {
    setBusy(true);
    setSig(null);
    setPlan(null);
    try {
      const parsed = parseUpdateManifest(manifestText);
      setErrors(parsed.errors);
      setWarnings(parsed.warnings);
      if (!parsed.ok) return;
      const result = await verifyManifestSignature(parsed.manifest, trustedKeys);
      setSig(result);
      setPlan(planUpdate(parsed.manifest, installedVersion.trim(), result));
    } finally {
      setBusy(false);
    }
  };

  const record = () => {
    const res = recordInstall(ledger, { version: recVersion.trim(), installedAt: recAt.trim(), installerSha256: recSha.trim(), source: 'manual' });
    setRecErrors(res.errors);
    if (res.ok) {
      setLedgerRaw(res.ledger);
      setRecVersion('');
      setRecSha('');
    }
  };

  return (
    <Panel title="Update manifest verification (offline)" eyebrow="Signatures and plans only">
      <div className="stack">
        <Notice tone="info">{UPDATE_PANEL_NOTE}</Notice>
        <Field label="Installed version" hint="Strict semver, for example 1.4.0.">
          {(id, d) => <input id={id} aria-describedby={d} value={installedVersion} onChange={(e) => setInstalledVersion(e.target.value)} />}
        </Field>
        <Field label="Trusted keys (JSON)" hint='Array of {"keyId": "...", "publicKeyJwk": {...}} public ECDSA P-256 keys.' error={keysErrors.length ? keysErrors.join(' ') : null}>
          {(id, d) => <textarea id={id} aria-describedby={d} rows={4} value={keysText} onChange={(e) => setKeysText(e.target.value)} />}
        </Field>
        <div><Button size="sm" onClick={saveKeys}>Save trusted keys</Button></div>
        <Field label="Update manifest (paste JSON)">
          {(id, d) => <textarea id={id} aria-describedby={d} rows={6} value={manifestText} onChange={(e) => setManifestText(e.target.value)} />}
        </Field>
        <div><Button variant="primary" busy={busy} onClick={() => void verify()}>Verify</Button></div>
        {errors.length > 0 && (
          <div role="alert"><strong>Errors</strong><ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div>
        )}
        {warnings.length > 0 && (
          <div><strong>Warnings</strong><ul className="field-hint">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
        )}
        {sig && <p role="status"><Badge tone={sig.ok ? 'ok' : 'danger'}>Signature: {sig.reason}</Badge> {sig.keyId ? `Key ${sig.keyId}` : ''}</p>}
        {plan && (
          <div className="stack">
            <p><Badge tone={plan.status === 'update-available' ? 'info' : plan.status === 'up-to-date' ? 'ok' : 'warn'}>Plan: {plan.status}</Badge> {plan.message}</p>
            {plan.release && (
              <>
                <p className="field-hint">Release {plan.release.version} · {plan.release.installer.fileName} · {plan.release.installer.sizeBytes} bytes · SHA-256 {plan.installerSha256}</p>
                <pre style={{ whiteSpace: 'pre-wrap' }}>{plan.release.notes}</pre>
              </>
            )}
            <p className="field-hint">{plan.note}</p>
          </div>
        )}

        <h3 className="h3">Installed versions</h3>
        {ledger.length === 0 ? <p className="field-hint">No installed versions recorded.</p> : (
          <ul>{ledger.map((e, i) => <li key={`${e.version}-${e.installedAt}-${i}`}>{e.version} · {e.installedAt} · {e.installerSha256}</li>)}</ul>
        )}
        <Field label="Version installed">
          {(id, d) => <input id={id} aria-describedby={d} value={recVersion} onChange={(e) => setRecVersion(e.target.value)} />}
        </Field>
        <Field label="Installed at (ISO 8601)">
          {(id, d) => <input id={id} aria-describedby={d} value={recAt} onChange={(e) => setRecAt(e.target.value)} />}
        </Field>
        <Field label="Installer SHA-256" error={recErrors.length ? recErrors.join(' ') : null}>
          {(id, d) => <input id={id} aria-describedby={d} value={recSha} onChange={(e) => setRecSha(e.target.value)} />}
        </Field>
        <div className="row">
          <Button size="sm" onClick={record}>Record installed version</Button>
          <Button size="sm" onClick={() => setRollback(planRollback(ledger, installedVersion.trim()))}>Plan rollback</Button>
        </div>
        {rollback && (
          <div className="stack" role="status">
            <p><Badge tone={rollback.possible ? 'info' : 'warn'}>{rollback.possible ? 'Rollback possible' : 'Rollback not possible'}</Badge> {rollback.reason}</p>
            {rollback.steps.length > 0 && <ol>{rollback.steps.map((s) => <li key={s.order}>{s.text} (requires confirmation)</li>)}</ol>}
            <p className="field-hint">Applied: no.</p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Battery state with an honest source label. Fallback order: navigator.getBattery -> host bridge (Electron powerMonitor,
 * on battery / on AC only, no percentage) -> unmeasured. Rejections and timeouts fall back; nothing throws during render.
 */
function BatteryPanel() {
  const [batteryMotionOn] = usePref<boolean>('motion.onBattery', false);
  const [battery, setBattery] = useState<ResolvedBattery | null>(null);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    try {
      const host = hostBatteryBridge(typeof window !== 'undefined' ? window.jarvisHost : null);
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { getBattery?: unknown }) : undefined;
      const browser = navigatorBatteryReader(nav?.getBattery, nav);
      void resolveBatteryStatus({ browser, host: host ? () => host.read() : null }).then(
        (r) => { if (alive) setBattery((cur) => (cur && cur.source === 'host' && r.source === 'unmeasured' ? cur : r)); },
        () => { if (alive) setBattery(unmeasuredBattery()); },
      );
      if (host?.subscribe) off = host.subscribe((s) => { if (alive) setBattery((cur) => applyHostBatteryEvent(cur, s)); });
    } catch {
      setBattery(unmeasuredBattery());
    }
    return () => {
      alive = false;
      try { off?.(); } catch { /* already detached */ }
    };
  }, []);
  const saver = batterySaverMotionActive(battery, batteryMotionOn);
  return (
    <Panel title="Battery" eyebrow="Measured, never estimated">
      <div className="stack">
        <p role="status">{battery ? batteryLabel(battery) : 'Battery: reading…'}</p>
        <p className="field-hint">
          {battery?.source === 'host' ? 'Reported by the desktop host (on battery or on AC only; the host gives no percentage).' : battery?.source === 'unmeasured' ? 'Neither navigator.getBattery nor the desktop host could report the battery state.' : battery ? 'Reported by the browser battery API.' : 'Checking navigator.getBattery, then the desktop host.'}
        </p>
        <p className="field-hint">Battery-aware motion: {batteryMotionOn ? (saver ? 'on, reducing animation now' : 'on, waiting for battery power') : 'off'}.</p>
      </div>
    </Panel>
  );
}

/** Feeds only what the existing hardware payload reports (platform, arch, RAM). Disk, cores and OS build are not in that payload, so they stay null and show as "not reported". */
function CompatTierPanel({ system }: { system: { platform: string; arch: string; ramGB: number } | null }) {
  const [copyState, setCopyState] = useState<string | null>(null);
  const raw = system ? { platform: system.platform, arch: system.arch, totalMemGb: system.ramGB } : {};
  const info = normalizeSystemInfo(raw);
  const result = classifyCompatibility(info);
  const rows = compareHardware(info);
  const tone = result.tier === 'validated' ? 'ok' : result.tier === 'unsupported' ? 'danger' : result.tier === 'expected' ? 'info' : 'warn';
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(buildCompatReport(info));
      setCopyState('Report copied.');
    } catch {
      setCopyState('Could not copy the report.');
    }
  };
  return (
    <Panel title="Compatibility tier" eyebrow="Evidence, not promises" actions={<Button size="sm" onClick={() => void copy()}>Copy report</Button>}>
      <div className="stack">
        <p><Badge tone={tone}>{tierLabel(result.tier)}</Badge> {tierExplanation(result.tier)}</p>
        <ol className="field-hint">{result.reasons.map((r, i) => <li key={i}>{r}</li>)}</ol>
        <table>
          <thead><tr><th scope="col">Resource</th><th scope="col">This computer</th><th scope="col">Minimum</th><th scope="col">Recommended</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.label}</th>
                <td>{r.value === null ? 'not reported' : `${r.value} ${r.unit}`}</td>
                <td>{r.minimum} {r.unit}: {r.minimumStatus}</td>
                <td>{r.recommended} {r.unit}: {r.recommendedStatus}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="field-hint">{HARDWARE_NOTE}</p>
        {copyState && <p className="field-hint" role="status">{copyState}</p>}
      </div>
    </Panel>
  );
}

export function Status() {
  const { system, systemError, systemLoading, refreshSystem, refreshCloud, settings, cloudConfigured, isPreview } = useReady();
  const online = settings.mode === 'online';
  const available = system?.capabilities.filter((c) => c.available) ?? [];
  const missing = system?.capabilities.filter((c) => !c.available) ?? [];

  return (
    <div className="page">
      <PageHeader
        eyebrow="System"
        title="System status"
        subtitle="Capabilities are reported by the backend. This screen never marks something available on its own."
        actions={
          <Button
            icon={ArrowClockwise}
            busy={systemLoading}
            onClick={() => {
              void refreshSystem();
              void refreshCloud();
            }}
          >
            Refresh
          </Button>
        }
      />

      {isPreview && <Notice tone="warn" title="Browser preview">There is no backend here, so every native capability is shown as unavailable. Open the Electron app to see real status.</Notice>}

      <div className="two-col">
        <div className="stack">
          <Panel title="This computer" eyebrow="Hardware">
            {system ? <SystemFacts system={system} /> : systemLoading ? <LoadingBlock label="Reading system information…" /> : <Notice tone="warn" title="Unavailable">{systemError ?? 'No data returned.'}</Notice>}
          </Panel>

          <CompatTierPanel system={system ?? null} />

          <BatteryPanel />

          <UpdateManifestPanel />

          <Panel title="Configured routes" eyebrow="Settings, not probes">
            <ul className="cap-list">
              <li className="cap-row">
                <Badge tone={settings.localModel && settings.localEndpoint ? 'info' : 'warn'}>{settings.localModel && settings.localEndpoint ? 'Configured' : 'Not set'}</Badge>
                <div>
                  <strong>Local model {online ? '(inactive in online mode)' : '(active route)'}</strong>
                  <p className="field-hint">{settings.localModel ? `${settings.localModel} at ${settings.localEndpoint}` : 'No model name set.'} Whether it is reachable is only known when you send a message.</p>
                </div>
              </li>
              <li className="cap-row">
                <Badge tone={cloudConfigured ? 'info' : 'warn'}>{cloudConfigured === null ? 'Unknown' : cloudConfigured ? 'Key saved' : 'No key'}</Badge>
                <div>
                  <strong>Cloud model {online ? '(active route)' : '(inactive in offline mode)'}</strong>
                  <p className="field-hint">{settings.cloudModel ? `Model: ${settings.cloudModel}.` : 'No cloud model name set.'} The key itself is never readable here.</p>
                </div>
              </li>
            </ul>
          </Panel>
        </div>

        <Panel title="Capabilities" eyebrow={system ? `${available.length} of ${system.capabilities.length} available` : 'Backend report'}>
          {!system ? (
            systemLoading ? <LoadingBlock /> : <Empty title="No capability report">{systemError ?? 'The backend did not return one.'}</Empty>
          ) : system.capabilities.length === 0 ? (
            <Empty title="The backend reported no capabilities" />
          ) : (
            <div className="stack">
              {missing.length > 0 && (
                <>
                  <h3 className="h3">Unavailable ({missing.length})</h3>
                  <ul className="cap-list">{missing.map((c) => <CapabilityRow key={c.id} c={c} />)}</ul>
                </>
              )}
              {available.length > 0 && (
                <>
                  <h3 className="h3">Available ({available.length})</h3>
                  <ul className="cap-list">{available.map((c) => <CapabilityRow key={c.id} c={c} />)}</ul>
                </>
              )}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
