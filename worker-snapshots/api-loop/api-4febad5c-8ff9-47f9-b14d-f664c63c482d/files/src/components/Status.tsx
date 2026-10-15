import { ArrowClockwise } from '@phosphor-icons/react';
import { CapabilityRow, SystemFacts } from './shared';
import { Badge, Button, Empty, LoadingBlock, Notice, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { useState } from 'react';
import { buildCompatReport, classifyCompatibility, compareHardware, HARDWARE_NOTE, normalizeSystemInfo, tierExplanation, tierLabel } from '../ui/compat-tiers';

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
