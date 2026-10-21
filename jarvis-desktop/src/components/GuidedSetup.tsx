import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, Check, Compass, Keyboard, SkipForward } from '@phosphor-icons/react';
import { Badge, Button, Empty, KV, Notice, PageHeader, Panel } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import { cx } from '../ui/util';
import {
  GUIDANCE_PREF_KEY,
  ROUTE_EXPLAINER,
  STATUS_LABEL,
  STATUS_TONE,
  buildGuideItems,
  clampStep,
  describeAge,
  exportGuidancePrefs,
  listKeyTarget,
  normalizeGuidancePrefs,
  parseGuidanceImport,
  progressLabel,
  reduceGuidancePrefs,
  selectTopic,
  statusFreshness,
  summarizeGuide,
  tourFor,
  visibleItems,
  type Freshness,
  type GuideAction,
  type GuideEvent,
  type GuideItem,
  type GuideSummary,
  type GuideTarget,
  type GuideTopicId,
  type GuidanceInput,
} from '../ui/guidance';

/**
 * Guided setup and help: a local quick-start checklist with short tours. Statuses come only from the props; the
 * component never probes, downloads, records, changes settings or sends anything. onNavigate and onAction run only
 * from a click or key press on their buttons. The only thing saved is the checklist preference (src/ui/guidance.ts).
 */
export type GuidedSetupProps = {
  status: GuidanceInput;
  /** True while the host is re-running the status checks it started from onAction({type:'recheck'}). */
  checking?: boolean;
  reducedMotion: boolean;
  onNavigate: (target: GuideTarget) => void;
  onAction: (action: GuideAction) => void;
  /** Topic to open first, e.g. from a "Help" link on another screen. */
  initialTopic?: GuideTopicId;
  /** Clock for tests; defaults to Date.now(). */
  now?: number;
};

/** Everything the view renders. The view itself has no hooks, so it can be rendered and exercised directly. */
export type GuidedSetupViewProps = {
  items: GuideItem[];
  visible: GuideItem[];
  summary: GuideSummary;
  selected: GuideTopicId | null;
  step: number;
  freshness: Freshness;
  checkedLabel: string;
  statusError: string | null;
  checking: boolean;
  reducedMotion: boolean;
  hideFinished: boolean;
  storedProblems: string[];
  exportText: string;
  importText: string;
  importMessage: { tone: 'info' | 'danger'; text: string } | null;
  onSelect: (id: GuideTopicId) => void;
  onStep: (step: number) => void;
  onEvent: (event: GuideEvent) => void;
  onNavigate: (target: GuideTarget) => void;
  onAction: (action: GuideAction) => void;
  onImportText: (text: string) => void;
  onImport: () => void;
  onDismissStoredProblems: () => void;
};

function FreshnessNotice({ freshness, checkedLabel, statusError, checking, onAction }: Pick<GuidedSetupViewProps, 'freshness' | 'checkedLabel' | 'statusError' | 'checking' | 'onAction'>) {
  if (freshness === 'fresh') return null;
  const recheck = (
    <Button size="sm" icon={ArrowClockwise} busy={checking} onClick={() => onAction({ type: 'recheck' })}>
      Re-check
    </Button>
  );
  if (freshness === 'error') {
    return (
      <Notice tone="danger" title="Status check failed" action={recheck}>
        {statusError} Features that depend on this check show “Not checked” until it succeeds.
      </Notice>
    );
  }
  if (freshness === 'stale') {
    return (
      <Notice tone="warn" title="Statuses are out of date" action={recheck}>
        Last checked {checkedLabel}. Out-of-date results are not used to mark anything available.
      </Notice>
    );
  }
  return (
    <Notice tone="info" title="Statuses not checked yet" action={recheck}>
      Dictation, streaming and local models show “Not checked” until the app checks this computer. Checking only asks the app; nothing is installed or turned on.
    </Notice>
  );
}

/** Roving focus for the topic list: arrows, Home and End move between topics and open the focused one. */
function onTopicListKey(e: KeyboardEvent<HTMLUListElement>, visible: GuideItem[], onSelect: (id: GuideTopicId) => void, reducedMotion: boolean) {
  const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-guide-topic]'));
  const index = buttons.findIndex((b) => b === e.target);
  if (index < 0) return;
  const next = listKeyTarget(e.key, index, buttons.length);
  if (next === null) return;
  e.preventDefault();
  buttons[next].focus();
  buttons[next].scrollIntoView?.({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  onSelect(visible[next].id);
}

function TopicDetail({ item, step, onStep, onEvent, onNavigate }: { item: GuideItem; step: number; onStep: (n: number) => void; onEvent: (e: GuideEvent) => void; onNavigate: (t: GuideTarget) => void }) {
  const tour = tourFor(item.id);
  const at = clampStep(step, tour.length);
  const current = tour[at];
  return (
    <Panel title={item.title} eyebrow="Topic" actions={<Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge>}>
      <div className="stack">
        <p>{item.summary}</p>
        <p className="field-hint" data-guide-reason>
          {item.reason}
        </p>
        {item.markIgnored && (
          <Notice tone="warn" title="Earlier “done” mark not counted">
            You marked this done before, but it is not usable right now, so it is not counted.
          </Notice>
        )}
        {item.facts.length > 0 && (
          <div className="kv-list">
            {item.facts.map((f) => (
              <KV key={f.label} k={f.label}>
                {f.value}
              </KV>
            ))}
          </div>
        )}
        {current && (
          <section aria-label={`${item.title} tour`} aria-live="polite">
            <p className="eyebrow">
              Tour step {at + 1} of {tour.length}
            </p>
            <h3 className="h3">{current.title}</h3>
            <p>{current.body}</p>
            <div className="row">
              <Button size="sm" icon={ArrowLeft} disabled={at === 0} onClick={() => onStep(at - 1)}>
                Previous step
              </Button>
              <Button size="sm" icon={ArrowRight} disabled={at >= tour.length - 1} onClick={() => onStep(at + 1)}>
                Next step
              </Button>
            </div>
          </section>
        )}
        <div className="row" aria-label={`${item.title} links`}>
          {item.links.map((l) => (
            <Button key={l.label} size="sm" icon={ArrowSquareOut} onClick={() => onNavigate(l.target)}>
              {l.label}
            </Button>
          ))}
        </div>
        <div className="row">
          {/* A disabled control keeps its name, and the reason above says why it cannot be marked yet. */}
          <Button size="sm" variant="primary" icon={Check} disabled={!item.canMarkDone} onClick={() => onEvent({ type: 'mark-done', item })}>
            Mark done
          </Button>
          {item.mark ? (
            <Button size="sm" variant="quiet" onClick={() => onEvent({ type: 'clear-mark', topic: item.id })}>
              {item.mark === 'skipped' ? 'Stop skipping' : 'Clear my done mark'}
            </Button>
          ) : item.status !== 'done' ? (
            <Button size="sm" variant="quiet" icon={SkipForward} onClick={() => onEvent({ type: 'skip', topic: item.id })}>
              Skip for now
            </Button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

export function GuidedSetupView(p: GuidedSetupViewProps) {
  const item = p.items.find((i) => i.id === p.selected) ?? null;
  const pct = p.summary.applicable > 0 ? Math.round((p.summary.done / p.summary.applicable) * 100) : 0;
  return (
    <div className="page guide" data-reduced-motion={p.reducedMotion ? 'true' : 'false'}>
      <PageHeader
        eyebrow="Help"
        title="Help & setup"
        subtitle="Short local tours for the main features. Statuses come from this computer; nothing here runs, downloads or turns on by itself."
        actions={
          <div className="page-actions">
            <Button icon={ArrowClockwise} busy={p.checking} onClick={() => p.onAction({ type: 'recheck' })}>
              Re-check statuses
            </Button>
            <Button icon={Keyboard} onClick={() => p.onAction({ type: 'open-shortcuts' })}>
              Keyboard shortcuts
            </Button>
            <Button icon={Compass} onClick={() => p.onAction({ type: 'open-onboarding' })}>
              Run full setup again
            </Button>
          </div>
        }
      />

      <FreshnessNotice freshness={p.freshness} checkedLabel={p.checkedLabel} statusError={p.statusError} checking={p.checking} onAction={p.onAction} />

      {p.storedProblems.length > 0 && (
        <Notice
          tone="warn"
          title="Saved checklist preferences were partly invalid"
          action={
            <Button size="sm" onClick={p.onDismissStoredProblems}>
              Save cleaned copy
            </Button>
          }
        >
          {p.storedProblems[0]} Invalid parts are ignored{p.storedProblems.length > 1 ? ` (${p.storedProblems.length} problems)` : ''}.
        </Notice>
      )}

      <Panel title="Progress" eyebrow={p.freshness === 'fresh' ? `Checked ${p.checkedLabel}` : 'Status'}>
        <div className="stack">
          <progress max={Math.max(1, p.summary.applicable)} value={p.summary.done} aria-label={`Setup progress, ${pct} percent`} />
          <p data-guide-progress>{progressLabel(p.summary)}</p>
          <label className="row">
            <input type="checkbox" checked={p.hideFinished} onChange={(e) => p.onEvent({ type: 'set-hide-finished', value: e.target.checked })} />
            <span>Hide done and skipped topics</span>
          </label>
        </div>
      </Panel>

      <div className="split">
        <div className="split-list">
          {p.visible.length === 0 ? (
            <Empty
              icon={Check}
              title="Nothing left to show"
              action={
                <Button size="sm" onClick={() => p.onEvent({ type: 'set-hide-finished', value: false })}>
                  Show all topics
                </Button>
              }
            >
              Every topic is done or skipped. Show all topics to revisit a tour.
            </Empty>
          ) : (
            <ul className="select-list" aria-label="Guide topics" onKeyDown={(e) => onTopicListKey(e, p.visible, p.onSelect, p.reducedMotion)}>
              {p.visible.map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    className={cx('select-item', i.id === p.selected && 'on')}
                    data-guide-topic={i.id}
                    aria-current={i.id === p.selected ? 'true' : undefined}
                    tabIndex={i.id === p.selected ? 0 : -1}
                    onClick={() => p.onSelect(i.id)}
                  >
                    <span>{i.title}</span> <Badge tone={STATUS_TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="split-detail">
          {item ? (
            <TopicDetail item={item} step={p.step} onStep={p.onStep} onEvent={p.onEvent} onNavigate={p.onNavigate} />
          ) : (
            <Empty icon={Compass} title="No topic selected">
              Choose a topic from the list to see its tour.
            </Empty>
          )}
        </div>
      </div>

      <Panel title="Where your requests go" eyebrow="Local, model and cloud">
        <ul className="help-list">
          {ROUTE_EXPLAINER.map((r) => (
            <li key={r.id}>
              <strong>{r.title}.</strong> {r.body}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Checklist backup" eyebrow="Only your checklist marks">
        <div className="stack">
          <p className="field-hint">Copy this text to keep your checklist marks, or paste it on another install. It contains no notes, keys or settings.</p>
          <label className="field" htmlFor="guide-export">
            <span>Current checklist preferences</span>
            <textarea id="guide-export" className="input mono" readOnly rows={5} value={p.exportText} />
          </label>
          <label className="field" htmlFor="guide-import">
            <span>Paste preferences to import</span>
            <textarea
              id="guide-import"
              className="input mono"
              rows={4}
              maxLength={4096}
              value={p.importText}
              aria-describedby={p.importMessage ? 'guide-import-message' : undefined}
              onChange={(e) => p.onImportText(e.target.value)}
            />
          </label>
          {p.importMessage && (
            <p id="guide-import-message" className={p.importMessage.tone === 'danger' ? 'field-error' : 'field-hint'} role={p.importMessage.tone === 'danger' ? 'alert' : 'status'}>
              {p.importMessage.text}
            </p>
          )}
          <div className="row">
            <Button size="sm" disabled={!p.importText.trim()} onClick={p.onImport}>
              Import checklist
            </Button>
            <Button size="sm" variant="quiet" onClick={() => p.onEvent({ type: 'reset' })}>
              Reset checklist
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** Mountable guided setup. Persists only the validated checklist preference under GUIDANCE_PREF_KEY. */
export function GuidedSetup({ status, checking = false, reducedMotion, onNavigate, onAction, initialTopic, now }: GuidedSetupProps) {
  const [rawPrefs, setRawPrefs] = usePref<unknown>(GUIDANCE_PREF_KEY, null);
  const { prefs, problems } = useMemo(() => normalizeGuidancePrefs(rawPrefs), [rawPrefs]);
  const [wanted, setWanted] = useState<GuideTopicId | null>(initialTopic ?? prefs.lastTopic);
  const [step, setStep] = useState(0);
  const [importText, setImportText] = useState('');
  const [importMessage, setImportMessage] = useState<GuidedSetupViewProps['importMessage']>(null);
  // Re-render once a minute so "checked 5 minutes ago" and the out-of-date notice stay true while the page is open.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    const id = window.setInterval(() => setTick(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [now]);
  const clock = now ?? tick;

  const items = useMemo(() => buildGuideItems(status, prefs, clock), [status, prefs, clock]);
  const visible = visibleItems(items, prefs.hideFinished);
  const selected = selectTopic(visible, wanted);
  const summary = summarizeGuide(items);

  const save = (next: typeof prefs) => {
    if (next !== prefs) setRawPrefs(next);
  };
  const select = (id: GuideTopicId) => {
    if (id !== selected) setStep(0);
    setWanted(id);
    save(reduceGuidancePrefs(prefs, { type: 'select', topic: id }));
  };

  return (
    <GuidedSetupView
      items={items}
      visible={visible}
      summary={summary}
      selected={selected}
      step={step}
      freshness={statusFreshness(status, clock)}
      checkedLabel={describeAge(status.checkedAt, clock)}
      statusError={status.capabilitiesError ?? null}
      checking={checking}
      reducedMotion={reducedMotion}
      hideFinished={prefs.hideFinished}
      storedProblems={problems}
      exportText={exportGuidancePrefs(prefs)}
      importText={importText}
      importMessage={importMessage}
      onSelect={select}
      onStep={(n) => setStep(clampStep(n, selected ? tourFor(selected).length : 0))}
      onEvent={(e) => save(reduceGuidancePrefs(prefs, e))}
      onNavigate={onNavigate}
      onAction={onAction}
      onImportText={(t) => {
        setImportText(t);
        setImportMessage(null);
      }}
      onImport={() => {
        const r = parseGuidanceImport(importText);
        if (!r.ok) {
          setImportMessage({ tone: 'danger', text: r.error });
          return;
        }
        setRawPrefs(r.prefs);
        setImportText('');
        setImportMessage({ tone: 'info', text: 'Checklist preferences imported.' });
      }}
      onDismissStoredProblems={() => setRawPrefs(prefs)}
    />
  );
}
