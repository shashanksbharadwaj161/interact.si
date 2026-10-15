import { DownloadSimple } from '@phosphor-icons/react';
import type { BillingStatus, UsageReport } from '../../electron/services/usage';
import { Badge, Button, Empty, Notice, Panel } from '../ui/primitives';

export type UsagePerformanceRow = { tokensPerSecond: number | null; at: string; model: string; outputTokens: number };

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const count = new Intl.NumberFormat('en-US');

/** Unknown is shown as "Unknown", never as zero. */
export function fmtMoney(v: number | null): string {
  return v === null ? 'Unknown' : money.format(v);
}

export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  const text = mins < 60 ? `${mins} min` : mins < 60 * 48 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / (60 * 24))} days`;
  return ms < 0 ? `${text} ago` : text;
}

function billingBadge(status: BillingStatus, ageMs: number | null) {
  if (status === 'observed') return <Badge tone="ok">Observed {ageMs !== null ? `${fmtDuration(ageMs)} ago` : ''}</Badge>;
  if (status === 'stale') return <Badge tone="warn">Stale snapshot</Badge>;
  if (status === 'unsupported') return <Badge tone="muted">No billing adapter</Badge>;
  return <Badge tone="muted">Unknown: no snapshot</Badge>;
}

export function UsagePanel({
  report,
  performance = [],
  onExport,
  exporting = false,
}: {
  report: UsageReport | null;
  performance?: UsagePerformanceRow[];
  onExport?: (format: 'csv' | 'json') => void;
  exporting?: boolean;
}) {
  if (!report) {
    return <Empty title="Usage is not loaded yet">The usage ledger has not returned data. Nothing is estimated until it does.</Empty>;
  }

  const hasEvents = report.totals.events > 0;
  const budget = report.budget;

  return (
    <div className="usage-panel">
      <Panel title="Summary" eyebrow="Local ledger" actions={onExport && (
        <>
          <Button icon={DownloadSimple} busy={exporting} onClick={() => onExport('csv')}>Export CSV</Button>
          <Button icon={DownloadSimple} busy={exporting} onClick={() => onExport('json')}>Export JSON</Button>
        </>
      )}>
        <dl className="usage-kv">
          <div><dt>Estimated spend</dt><dd>{fmtMoney(report.estimatedSpend)}</dd></div>
          <div><dt>Reserved, not yet settled</dt><dd>{fmtMoney(report.reservedSpend)}</dd></div>
          <div><dt>Input tokens</dt><dd>{count.format(report.totals.inputTokens)}</dd></div>
          <div><dt>Output tokens</dt><dd>{count.format(report.totals.outputTokens)}</dd></div>
          <div><dt>Events</dt><dd>{count.format(report.totals.events)}</dd></div>
        </dl>
        {report.unpricedEvents > 0 && (
          <Notice tone="warn" title="Spend is partial">
            {report.unpricedEvents} cloud {report.unpricedEvents === 1 ? 'event has' : 'events have'} no price in your table, so the estimate excludes {report.unpricedEvents === 1 ? 'it' : 'them'}.
          </Notice>
        )}
        <p className="usage-note">{report.disclaimer}</p>
      </Panel>

      {budget && (
        <Panel title="Budget" eyebrow={budget.period === 'day' ? 'Today (UTC)' : 'This month (UTC)'}>
          <div
            className="usage-meter"
            role="progressbar"
            aria-label="Budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, Math.round(budget.fractionUsed * 100))}
          >
            <span style={{ width: `${Math.min(100, budget.fractionUsed * 100)}%` }} />
          </div>
          <p>
            {fmtMoney(budget.conservativeTotal)} of {fmtMoney(budget.amount)} used, counting reservations.{' '}
            {budget.remaining >= 0 ? `${fmtMoney(budget.remaining)} remaining.` : `${fmtMoney(-budget.remaining)} over.`}
          </p>
          <p>
            Pace:{' '}
            {budget.pace === 'insufficient-data' && 'too early in the period to project.'}
            {budget.pace === 'on-track' && <Badge tone="ok">On track, projected {fmtMoney(budget.projected)}</Badge>}
            {budget.pace === 'over-pace' && <Badge tone="danger">Over pace, projected {fmtMoney(budget.projected)}</Badge>}
          </p>
          <ul className="usage-alerts">
            {budget.alerts.map((a) => (
              <li key={a.threshold}>
                {Math.round(a.threshold * 100)}% threshold: {a.reached ? <Badge tone="warn">Reached</Badge> : 'not reached'}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Provider billing" eyebrow="Observed, separate from estimates">
        {report.billing.length === 0 ? (
          <p className="usage-note">No cloud provider has been used, so there is no billing to observe.</p>
        ) : (
          <table className="usage-table">
            <thead><tr><th scope="col">Provider</th><th scope="col">Status</th><th scope="col">Balance</th><th scope="col">Reset</th></tr></thead>
            <tbody>
              {report.billing.map((b) => (
                <tr key={b.provider}>
                  <th scope="row">{b.provider}</th>
                  <td>{billingBadge(b.status, b.ageMs)}</td>
                  <td>{fmtMoney(b.balance)}</td>
                  <td>
                    {b.resetsAt === null ? 'Not reported' : b.resetDue ? <Badge tone="warn">Reset passed, refresh needed</Badge> : `In ${fmtDuration(b.resetInMs ?? 0)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="By model" eyebrow="Tokens and estimates">
        {!hasEvents ? (
          <Empty title="No usage recorded yet">Local and cloud calls appear here once they complete.</Empty>
        ) : (
          <table className="usage-table">
            <thead><tr><th scope="col">Model</th><th scope="col">Runtime</th><th scope="col">Events</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Estimate</th></tr></thead>
            <tbody>
              {report.byModel.map((m) => (
                <tr key={`${m.runtime}/${m.provider}/${m.model}`}>
                  <th scope="row">{m.model}</th>
                  <td>{m.runtime === 'local' ? 'Local' : m.provider}</td>
                  <td>{count.format(m.events)}</td>
                  <td>{count.format(m.inputTokens)}</td>
                  <td>{count.format(m.outputTokens)}</td>
                  <td>{m.runtime === 'local' ? 'Not charged' : fmtMoney(m.estimatedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Attribution" eyebrow="Project and worker">
        {report.attribution.length === 0 ? (
          <p className="usage-note">Nothing to attribute yet.</p>
        ) : (
          <table className="usage-table">
            <thead><tr><th scope="col">Project</th><th scope="col">Worker</th><th scope="col">Events</th><th scope="col">Estimate</th></tr></thead>
            <tbody>
              {report.attribution.map((a) => (
                <tr key={`${a.project ?? ''}/${a.worker ?? ''}`}>
                  <th scope="row">{a.project ?? 'Unassigned'}</th>
                  <td>{a.worker ?? 'Unassigned'}</td>
                  <td>{count.format(a.events)}</td>
                  <td>{fmtMoney(a.estimatedCost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {report.reservations.length > 0 && (
        <Panel title="Unsettled reservations" eyebrow="Kept until the call settles">
          <p className="usage-note">These calls were reserved at their maximum cost and have not reported back. They stay in the total until settled.</p>
          <ul className="usage-list">
            {report.reservations.map((r) => (
              <li key={r.id}>{r.model} ({r.provider}), started {fmtDuration(-r.ageMs)}, maximum {fmtMoney(r.maxCost)}</li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Local performance" eyebrow="Recent generations">
        {performance.length === 0 ? (
          <p className="usage-note">No local generation timing has been recorded yet.</p>
        ) : (
          <ul className="usage-list">
            {performance.slice(0, 10).map((p) => (
              <li key={`${p.at}/${p.model}`}>
                {p.model}: {p.tokensPerSecond === null ? 'timing unavailable' : `${p.tokensPerSecond.toFixed(1)} tokens/s`} over {count.format(p.outputTokens)} output tokens
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
