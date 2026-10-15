import { Component, Suspense, lazy, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwise, ArrowsOut, Check, Info, Question, WarningCircle, WifiHigh, WifiSlash, X } from '@phosphor-icons/react';
import { Avatar, AVATAR_STATES } from './Avatar';
import { SceneBackdrop } from './SceneBackdrop';
import { Onboarding, modelReadiness, safeLaunchReason } from './Onboarding';
import { GUIDE_TOPIC_IDS, type GuidanceInput, type GuideTopicId } from '../ui/guidance';
import type { ApiFeature } from '../shared/contracts';
import { Home } from './Home';
import { Settings, useShellPref, SHELL_PREF } from './Settings';
import { MemorySearch } from './MemorySearch';
import { ConfirmDialog, Dialog } from '../ui/Dialog';
import { Button, LoadingBlock, Notice, PageHeader, Segmented } from '../ui/primitives';
import { VIEWS, VIEW_FOR_CATEGORY, hashFor, navGroups, parseHash, shortcutAction, viewById, type HashLocation, type ViewId } from '../ui/nav';
import { useStore, useReady } from '../ui/store';
import { usePref } from '../ui/prefs';
import { DEFAULT_SCENE } from '../ui/scenes';
import { CompanionProvider, useCompanion, hostVoiceLevel } from '../ui/companion';
import { resetPreviewData, seedPreviewDemo } from '../preview';
import { calendarBridge, clipboardBridge, integrationsBridge, modelsBridge, routinesBridge, usageBridge } from '../ui/bridges';
import type { UsageSummary } from '../shared/contracts';
import { cx, errMsg } from '../ui/util';

const Assistant = lazy(() => import('./Assistant').then((m) => ({ default: m.Assistant })));
const Companion = lazy(() => import('./Companion').then((m) => ({ default: m.Companion })));
const Capsules = lazy(() => import('./Capsules').then((m) => ({ default: m.Capsules })));
const Notes = lazy(() => import('./Notes').then((m) => ({ default: m.Notes })));
const Tasks = lazy(() => import('./Tasks').then((m) => ({ default: m.Tasks })));
const Computer = lazy(() => import('./Computer').then((m) => ({ default: m.Computer })));
const Status = lazy(() => import('./Status').then((m) => ({ default: m.Status })));
const FeatureLab = lazy(() => import('./FeatureLab').then((m) => ({ default: m.FeatureLab })));
const Developer = lazy(() => import('./Developer').then((m) => ({ default: m.Developer })));
const MotionStudio = lazy(() => import('./MotionStudio').then((m) => ({ default: m.MotionStudio })));
const Scene3D = lazy(() => import('./Scene3D').then((m) => ({ default: m.Scene3D })));
const Routines = lazy(() => import('./Routines').then((m) => ({ default: m.Routines })));
const Integrations = lazy(() => import('./Integrations').then((m) => ({ default: m.Integrations })));
const Models = lazy(() => import('./Models').then((m) => ({ default: m.Models })));
const UsagePanel = lazy(() => import('./UsagePanel').then((m) => ({ default: m.UsagePanel })));
const AvatarStudio = lazy(() => import('./AvatarStudio').then((m) => ({ default: m.AvatarStudio })));
const Calendar = lazy(() => import('./Calendar').then((m) => ({ default: m.Calendar })));
// Detailed .ics review (time zones, recurrence, duplicates); its own chunk, loaded only when a file is chosen.
const CalendarImport = lazy(() => import('./CalendarImport').then((m) => ({ default: m.CalendarImport })));
const Clipboard = lazy(() => import('./Clipboard').then((m) => ({ default: m.Clipboard })));
// Workspace screens (memory and writing workbenches). Loaded on first visit like every other secondary screen.
const MemoryWorkbench = lazy(() => import('./MemoryWorkbench').then((m) => ({ default: m.MemoryWorkbench })));
const GuidedSetup = lazy(() => import('./GuidedSetup').then((m) => ({ default: m.GuidedSetup })));
const WritingWorkbench = lazy(() => import('./WritingWorkbench').then((m) => ({ default: m.WritingWorkbench })));

/* ---------- Motion, theme and text size ---------- */

export type BatterySnapshot = { charging: boolean; level: number };

/** Battery-aware motion: only when the preference is on, the battery is known, not charging and low. */
export function batteryWantsReducedMotion(battery: BatterySnapshot | null, enabled: boolean, threshold = 0.2): boolean {
  if (!enabled || !battery) return false;
  if (battery.charging) return false;
  return Number.isFinite(battery.level) && battery.level <= threshold;
}

type BatteryLike = { charging: boolean; level: number; addEventListener: (t: string, h: () => void) => void; removeEventListener: (t: string, h: () => void) => void };

/** Reads the Battery Status API when Chromium exposes it; null when unavailable (desktop without a battery, or unsupported). */
function useBattery(enabled: boolean): BatterySnapshot | null {
  const [snap, setSnap] = useState<BatterySnapshot | null>(null);
  useEffect(() => {
    if (!enabled) {
      setSnap(null);
      return undefined;
    }
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    if (typeof nav.getBattery !== 'function') return undefined;
    let b: BatteryLike | null = null;
    let cancelled = false;
    const read = () => b && setSnap({ charging: b.charging, level: b.level });
    nav
      .getBattery()
      .then((m) => {
        if (cancelled) return;
        b = m;
        read();
        m.addEventListener('levelchange', read);
        m.addEventListener('chargingchange', read);
      })
      .catch(() => setSnap(null));
    return () => {
      cancelled = true;
      b?.removeEventListener('levelchange', read);
      b?.removeEventListener('chargingchange', read);
    };
  }, [enabled]);
  return snap;
}

export type MotionState = { reduced: boolean; source: 'setting' | 'windows' | 'battery' | null };

function useReducedMotion(pref: boolean): MotionState {
  const [os, setOs] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [onBattery] = useShellPref(SHELL_PREF.motionOnBattery, false);
  const battery = useBattery(onBattery);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setOs(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  if (pref) return { reduced: true, source: 'setting' };
  if (os) return { reduced: true, source: 'windows' };
  if (batteryWantsReducedMotion(battery, onBattery)) return { reduced: true, source: 'battery' };
  return { reduced: false, source: null };
}

function useThemeSync(): MotionState {
  const { settings } = useStore();
  const motion = useReducedMotion(settings?.reduceMotion ?? false);
  const [textSize] = useShellPref(SHELL_PREF.textSize, 'normal');
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'graphite';
    document.documentElement.dataset.motion = motion.reduced ? 'reduced' : 'full';
    document.documentElement.dataset.text = textSize === 'large' ? 'large' : 'normal';
  }, [settings?.theme, motion.reduced, textSize]);
  return motion;
}

/* ---------- Hash routing ---------- */

export type Go = (v: ViewId, params?: Record<string, string>) => void;

/**
 * Host for Guided setup: passes only what the app already knows (system capabilities, API features, settings, key yes/no,
 * counts). Re-check re-runs the same calls the Settings re-check uses; nothing else is probed.
 */
function GuideView({ go, motion, topic, onShortcuts }: { go: Go; motion: MotionState; topic?: string; onShortcuts: () => void }) {
  const { api, state, settings, system, systemError, cloudConfigured, refreshSystem, refreshCloud } = useStore();
  const [features, setFeatures] = useState<ApiFeature[] | null>(null);
  const [featuresError, setFeaturesError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const loadFeatures = useCallback(async () => {
    if (typeof api.getApiInfo !== 'function') { setFeatures([]); return; }
    try { setFeatures((await api.getApiInfo()).features); setFeaturesError(null); } catch (e) { setFeaturesError(e instanceof Error ? e.message : String(e)); }
  }, [api]);
  useEffect(() => { void loadFeatures().then(() => setCheckedAt(Date.now())); }, [loadFeatures]);
  const recheck = async () => {
    setChecking(true);
    try { await Promise.all([refreshSystem(), refreshCloud(), loadFeatures()]); setCheckedAt(Date.now()); } finally { setChecking(false); }
  };
  const status: GuidanceInput = {
    capabilities: system?.capabilities ?? null,
    capabilitiesError: systemError ?? featuresError,
    apiFeatures: features,
    settings: settings ?? null,
    cloudKeyConfigured: cloudConfigured,
    counts: state ? { notes: state.notes.length, tasks: state.tasks.length, capsules: state.capsules.length } : null,
    systemReducedMotion: motion.source === 'windows' ? true : null,
    checkedAt,
  };
  return (
    <GuidedSetup
      status={status}
      checking={checking}
      reducedMotion={motion.reduced}
      initialTopic={(GUIDE_TOPIC_IDS as readonly string[]).includes(topic ?? '') ? (topic as GuideTopicId) : undefined}
      onNavigate={(t) => go(t.view, t.params)}
      onAction={(a) => { if (a.type === 'recheck') void recheck(); else if (a.type === 'open-shortcuts') onShortcuts(); else go('settings'); }}
    />
  );
}

const MEMORY_SECTIONS = ['overview', 'projects', 'checkpoints', 'shelf', 'timeline', 'recap', 'privacy', 'portability'] as const;
type MemorySection = (typeof MEMORY_SECTIONS)[number];

function useView(): [HashLocation, Go] {
  const [loc, setLoc] = useState<HashLocation>(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setLoc(parseHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback<Go>((v, params) => {
    const next = hashFor(v, params);
    if (window.location.hash !== next) window.location.hash = next.slice(1);
    else setLoc(parseHash(next));
  }, []);
  return [loc, go];
}

/** True while any modal dialog is open; global shortcuts stay quiet so they cannot discard its state. */
export function modalIsOpen(doc: Pick<Document, 'querySelector'>): boolean {
  return Boolean(doc.querySelector('dialog[open]'));
}

/* ---------- Toasts ---------- */

function Toasts() {
  const { toasts, dismissToast } = useStore();
  const [quiet] = useShellPref(SHELL_PREF.quietToasts, false);
  // Quiet mode keeps errors and information; routine success messages are not announced.
  const shown = quiet ? toasts.filter((t) => t.kind !== 'ok') : toasts;
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {shown.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`)} role={t.kind === 'error' ? 'alert' : undefined}>
          {t.kind === 'ok' ? <Check size={16} aria-hidden /> : t.kind === 'error' ? <WarningCircle size={16} aria-hidden /> : <Info size={16} aria-hidden />}
          <span>{t.text}</span>
          <button type="button" className="iconbtn" aria-label="Dismiss message" onClick={() => dismissToast(t.id)}>
            <X size={14} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------- Banners ---------- */

function PreviewBanner() {
  const { api, reload, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="preview-banner" role="note">
      <strong>Browser preview</strong>
      <span>
        This is not the Electron app. AI, voice, native actions, file pickers and cloud keys are unavailable. Records you add are demo data kept in this browser only.
      </span>
      <Button
        size="sm"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await seedPreviewDemo(api);
            await reload();
            toast('ok', 'Added labelled demo records.');
          } catch {
            toast('error', 'Could not add demo records.');
          } finally {
            setBusy(false);
          }
        }}
      >
        Add demo records
      </Button>
      <Button size="sm" variant="quiet" onClick={() => setConfirm(true)}>
        Reset demo data
      </Button>
      <ConfirmDialog
        open={confirm}
        title="Reset demo data?"
        confirmLabel="Reset and reload"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          resetPreviewData();
          window.location.reload();
        }}
      >
        <p>This clears everything the browser preview stored, including onboarding state. It does not affect the Electron app.</p>
      </ConfirmDialog>
    </div>
  );
}

/** Pure banner so the copy and controls can be rendered in tests without the store. */
export function SafeLaunchBanner({ reason, checking, onStatus, onRecheck }: { reason: string; checking?: boolean; onStatus?: () => void; onRecheck?: () => void }) {
  return (
    <div className="recovery-banner" role="note" aria-label="Safe launch">
      <strong>Safe launch</strong>
      <span>
        The last two sessions did not close cleanly, so actions that control Windows are turned off. Notes, tasks, capsules and settings still work. To leave safe launch, quit the app completely and open it again. ({reason})
      </span>
      {onStatus && (
        <Button size="sm" onClick={onStatus}>
          System status
        </Button>
      )}
      {onRecheck && (
        <Button size="sm" variant="quiet" busy={checking} onClick={onRecheck}>
          Check again
        </Button>
      )}
    </div>
  );
}

/** Safe launch is only reported through the desktop-control capability, so the banner follows that. */
function RecoveryBanner() {
  const { system, refreshSystem, systemLoading } = useStore();
  const reason = safeLaunchReason(system?.capabilities);
  if (!reason) return null;
  // Navigates through the hash so the banner needs no router prop; the shell's hashchange listener does the rest.
  const openStatus = () => {
    window.location.hash = hashFor('status').slice(1);
  };
  return <SafeLaunchBanner reason={reason} checking={systemLoading} onStatus={openStatus} onRecheck={() => void refreshSystem()} />;
}

/** Shown when the capability check itself failed, so readiness and safe-launch state are unknown rather than fine. */
export function CheckFailedBanner({ error, checking, onRetry, onDismiss }: { error: string; checking?: boolean; onRetry: () => void; onDismiss: () => void }) {
  return (
    <div className="check-banner" role="status" aria-label="Capability check failed">
      <strong>Check failed</strong>
      <span>This app could not find out what this computer supports, so model readiness and safe-launch state are unknown. {error}</span>
      <Button size="sm" busy={checking} onClick={onRetry}>
        Try again
      </Button>
      <button type="button" className="iconbtn" aria-label="Hide this message until the next check" onClick={onDismiss}>
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

function SystemCheckBanner() {
  const { systemError, systemLoading, refreshSystem } = useStore();
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (!systemError || hiddenFor === systemError) return null;
  return <CheckFailedBanner error={systemError} checking={systemLoading} onRetry={() => void refreshSystem()} onDismiss={() => setHiddenFor(systemError)} />;
}

/* ---------- Help ---------- */

const GENERAL_KEYS: { keys: string[]; what: string }[] = [
  { keys: ['F1'], what: 'Open this help' },
  { keys: ['Esc'], what: 'Close a dialog or cancel a recording' },
  { keys: ['Ctrl', 'S'], what: 'Save the note you are editing' },
  { keys: ['Tab'], what: 'Move between controls; Skip to content is the first stop' },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((k, i) => (
        <Fragment key={k}>
          {i > 0 && ' + '}
          <kbd>{k}</kbd>
        </Fragment>
      ))}
    </>
  );
}

/** Pure help body: shortcuts, where things are, and where to look when something is off. */
export function HelpContent({ go }: { go: Go }) {
  return (
    <div className="help">
      <section className="help-col" aria-labelledby="help-keys">
        <h3 id="help-keys">Keyboard</h3>
        <dl className="kv-list">
          {VIEWS.filter((v) => v.shortcut).map((v) => (
            <div key={v.id} className="kv">
              <dt>{v.label}</dt>
              <dd>
                <Keys keys={v.shortcut!.split('+')} />
              </dd>
            </div>
          ))}
          {GENERAL_KEYS.map((g) => (
            <div key={g.what} className="kv">
              <dt>{g.what}</dt>
              <dd>
                <Keys keys={g.keys} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="field-hint">Shortcuts pause while a dialog is open. Alt shortcuts follow the order in the sidebar.</p>
      </section>
      <section className="help-col" aria-labelledby="help-where">
        <h3 id="help-where">Where things are</h3>
        <ul className="help-list">
          {VIEWS.map((v) => (
            <li key={v.id}>
              <button type="button" className="help-link" onClick={() => go(v.id)}>
                <v.icon size={15} aria-hidden />
                <span>
                  <strong>{v.label}</strong>
                  <span className="sub">{v.blurb}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <h3>When something is off</h3>
        <p className="field-hint">
          System status lists what this app detected and why a feature is unavailable. Developer has a copyable diagnostics block. Settings shows whether the model is ready using a live check, and the Home screen repeats that result.
        </p>
      </section>
    </div>
  );
}

function HelpDialog({ open, onClose, go }: { open: boolean; onClose: () => void; go: Go }) {
  return (
    <Dialog open={open} onClose={onClose} title="Help" description="Everything here runs on this computer. Nothing in this dialog sends data anywhere." size="lg">
      <HelpContent
        go={(v, p) => {
          onClose();
          go(v, p);
        }}
      />
    </Dialog>
  );
}

/* ---------- Sidebar ---------- */

function SidebarStatus() {
  const { settings, cloudConfigured, system, systemError } = useStore();
  const { state } = useCompanion();
  if (!settings) return null;
  const online = settings.mode === 'online';
  const readiness = modelReadiness({ settings, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });
  const stateLabel = AVATAR_STATES.find((s) => s.id === state)?.label ?? state;
  return (
    <div className="dock-status">
      <Avatar state={state} size={64} />
      <div className="dock-lines">
        <span className={cx('mode-pill', online ? 'online' : 'offline')}>
          {online ? <WifiHigh size={13} aria-hidden /> : <WifiSlash size={13} aria-hidden />}
          {online ? 'Online mode' : 'Offline mode'}
        </span>
        <span className="dock-line" title={online ? settings.cloudModel : settings.localModel}>
          {online ? settings.cloudModel || 'No cloud model set' : settings.localModel || 'No local model set'}
        </span>
        <span className="dock-line">{readiness.level === 'ready' ? 'Model ready' : readiness.level === 'blocked' ? 'Model not ready' : 'Model not checked'}</span>
        {online && <span className="dock-line">{cloudConfigured === null ? 'Key status unknown' : cloudConfigured ? 'Key saved' : 'No key saved'}</span>}
        <span className="dock-line dock-state">Companion: {stateLabel}</span>
      </div>
    </div>
  );
}

/* ---------- Views that only need a page frame around a shared module ---------- */

function SearchView({ go, focusOnMount }: { go: Go; focusOnMount: boolean }) {
  const { state } = useReady();
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) wrap.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [focusOnMount]);
  return (
    <div className="page" ref={wrap}>
      <PageHeader eyebrow="Work" title="Memory search" subtitle="Find anything already saved here. Choosing a result opens the screen that holds it." />
      <MemorySearch state={state} onNavigate={(r) => go(VIEW_FOR_CATEGORY[r.category], { item: r.id })} />
    </div>
  );
}

function MotionView({ motion }: { motion: MotionState }) {
  const [studio, setStudio] = useState<'motion' | 'scene3d'>('motion');
  const why = motion.source === 'setting' ? 'your Reduce motion setting' : motion.source === 'windows' ? 'the Windows reduced-motion setting' : motion.source === 'battery' ? 'the battery rule in Settings' : null;
  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Cockpit" title="Motion studio" subtitle="Original wave, particle and orbit effects drawn on a canvas in this window. Presets are kept in this app only." />
      {why && (
        <Notice title="Playback is paused by reduced motion">
          Animation is off because of {why}. You can still change settings and save presets; the stage shows a single still frame.
        </Notice>
      )}
      <Segmented label="Studio" value={studio} onChange={setStudio} options={[{ value: 'motion', label: '2D motion' }, { value: 'scene3d', label: '3D scene' }]} />
      {studio === 'motion' ? <MotionStudio reducedMotion={motion.reduced} /> : <Scene3D reducedMotion={motion.reduced} />}
    </div>
  );
}

/* ---------- Module views: each takes its client from a bridge adapter and says so when the backend lacks it ---------- */

function RoutinesView() {
  const { api } = useStore();
  const client = useMemo(() => routinesBridge(api), [api]);
  return <Routines api={client ?? undefined} />;
}

function IntegrationsView() {
  const { api } = useStore();
  const bridge = useMemo(() => integrationsBridge(api), [api]);
  return <Integrations bridge={bridge ?? undefined} />;
}

function ModelsPage() {
  const { api, settings, mutate } = useReady();
  const client = useMemo(() => modelsBridge(api), [api]);
  // The main process confirms an AI connection change itself; the renderer only sends the patch.
  const chooseModel = async (patch: { localModel: string }) => {
    await mutate(() => api.saveSettings(patch), 'Local model saved.');
  };
  return <Models client={client} currentModel={settings.localModel} onUseModel={chooseModel} />;
}

function UsageView() {
  const { api, toast } = useReady();
  const client = useMemo(() => usageBridge(api), [api]);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const refresh = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    try {
      setData(await client.report());
      setError(null);
    } catch (e) {
      setError(errMsg(e, 'The usage ledger could not be read.'));
    } finally {
      setBusy(false);
    }
  }, [client]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const exportAs = async (format: 'csv' | 'json') => {
    if (!client) return;
    setExporting(true);
    try {
      const r = await client.exportAs(format);
      if (r.path) toast('ok', `Exported ${r.rows} ${r.rows === 1 ? 'row' : 'rows'}${r.truncated ? ' (truncated to the export limit)' : ''}.`);
      else toast('info', 'Export cancelled.');
    } catch (e) {
      toast('error', errMsg(e, 'Export failed.'));
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="Local ledger"
        title="Usage"
        subtitle="Tokens and estimated spend recorded on this computer. Nothing is estimated unless the ledger has data."
        actions={
          <Button icon={ArrowClockwise} busy={busy} disabled={!client} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />
      {!client && (
        <Notice tone="warn" title="Usage ledger is not connected">
          This build does not expose the usage ledger, so there is nothing to show or export.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" title="Could not read usage">
          {error}
        </Notice>
      )}
      {client && <UsagePanel report={data?.report ?? null} performance={data?.performance} onExport={(f) => void exportAs(f)} exporting={exporting} />}
    </div>
  );
}

function ClipboardView() {
  const { api } = useReady();
  const client = useMemo(() => clipboardBridge(api), [api]);
  return (
    <div className="page">
      <PageHeader eyebrow="Work" title="Clipboard history" subtitle="Off by default. When on, recent copied text is kept in memory on this computer only, with secrets filtered on a best-effort basis." />
      <Clipboard client={client} />
    </div>
  );
}

/** Local .ics calendar through the validated calendar IPC. The renderer never receives a file path. */
function CalendarView() {
  const { api } = useReady();
  const client = useMemo(() => calendarBridge(api), [api]);
  return <Calendar api={client} Review={CalendarImport} />;
}

/** Avatar Studio edits the original procedural avatar; the voice level is only passed while a real microphone meter reports one. */
function AvatarView({ go, reducedMotion }: { go: Go; reducedMotion: boolean }) {
  const live = useCompanion();
  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Cockpit" title="Avatar" subtitle="Shape, colours, expressions and motion of the original, procedurally drawn avatar. Saved on this computer." />
      <AvatarStudio reducedMotion={reducedMotion} voiceLevel={hostVoiceLevel(live)} />
      <div className="row wrap">
        <Button onClick={() => go('companion')}>Open Companion poses</Button>
      </div>
    </div>
  );
}

/* ---------- Shell ---------- */

/** A cold route keeps the navigation available while its bundled local module opens. */
export function RouteLoading({ label }: { label: string }) {
  return <section className="page" aria-busy="true" aria-label={`${label} loading`}>
    <LoadingBlock label={`Opening ${label}…`} />
    <p className="field-hint">Loading this screen from the app installed on this computer.</p>
  </section>;
}

/** Import or render failures stay inside the selected screen; navigation and the app shell still work. */
export class RouteBoundary extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="page" aria-label={`${this.props.label} unavailable`}>
      <Notice tone="danger" title={`${this.props.label} could not open`}>
        This screen could not load. Choose another screen using the sidebar, or reload the app to try again. Unsaved edits in this window may be lost on reload.
      </Notice>
      <Button onClick={() => window.location.reload()}>Reload app</Button>
    </section>;
  }
}

function Shell({ motion }: { motion: MotionState }) {
  const { settings, isPreview } = useStore();
  const [loc, go] = useView();
  const view = loc.view;
  const [scene] = usePref('scene', DEFAULT_SCENE);
  const [help, setHelp] = useState(false);
  const [searchFocusKey, setSearchFocusKey] = useState(0);
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    mainRef.current?.scrollTo?.({ top: 0 });
  }, [view]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const action = shortcutAction(e, modalIsOpen(document));
      if (!action) return;
      e.preventDefault();
      if (action.kind === 'view') go(action.view);
      else if (action.kind === 'help') setHelp(true);
      else {
        setSearchFocusKey((k) => k + 1);
        go('search');
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [go]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void document.documentElement.requestFullscreen?.();
  };

  let body: ReactNode;
  switch (view) {
    case 'assistant':
      body = <Assistant />;
      break;
    case 'companion':
      body = <Companion />;
      break;
    case 'capsules':
      body = <Capsules initialItem={loc.params.item} />;
      break;
    case 'notes':
      body = <Notes initialItem={loc.params.item} />;
      break;
    case 'tasks':
      body = <Tasks />;
      break;
    case 'computer':
      body = <Computer />;
      break;
    case 'status':
      body = <Status />;
      break;
    case 'settings':
      body = <Settings initialQuery={loc.params.q} />;
      break;
    case 'lab':
      body = <FeatureLab />;
      break;
    case 'developer':
      body = <Developer />;
      break;
    case 'search':
      body = <SearchView go={go} focusOnMount={searchFocusKey > 0} />;
      break;
    case 'motion':
      body = <MotionView motion={motion} />;
      break;
    case 'avatar':
      body = <AvatarView go={go} reducedMotion={motion.reduced} />;
      break;
    case 'routines':
      body = <RoutinesView />;
      break;
    case 'integrations':
      body = <IntegrationsView />;
      break;
    case 'models':
      body = <ModelsPage />;
      break;
    case 'usage':
      body = <UsageView />;
      break;
    case 'clipboard':
      body = <ClipboardView />;
      break;
    case 'calendar':
      body = <CalendarView />;
      break;
    case 'memory':
      body = <MemoryWorkbench key={loc.params.section ?? ''} initialSection={MEMORY_SECTIONS.includes(loc.params.section as MemorySection) ? (loc.params.section as MemorySection) : undefined} />;
      break;
    case 'writing':
      body = <WritingWorkbench key={loc.params.item ?? ''} initialNoteId={loc.params.item} />;
      break;
    case 'guide':
      body = <GuideView go={go} motion={motion} topic={loc.params.topic} onShortcuts={() => setHelp(true)} />;
      break;
    default:
      body = <Home go={go} />;
  }

  const current = viewById(view);

  return (
    <div className="app">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Skip to content
      </a>
      {/* Keyed on the scene so a change cross-fades; the fade is opacity only and is removed under reduced motion. */}
      <div key={scene} className="scene-layer" aria-hidden="true">
        <SceneBackdrop scene={scene} className="app-scene" />
      </div>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
          </span>
          <div className="brand-text">
            <strong>Desktop Companion</strong>
            <span>{settings?.mode === 'online' ? 'Online by choice' : 'Offline first'}</span>
          </div>
        </div>
        <nav aria-label="Primary" className="nav">
          {navGroups().map((g) => (
            <div className="nav-group" key={g.name}>
              <p className="nav-label">{g.name}</p>
              {g.views.map((v) => (
                <a
                  key={v.id}
                  href={hashFor(v.id)}
                  className={cx('nav-item', view === v.id && 'active')}
                  aria-current={view === v.id ? 'page' : undefined}
                  aria-label={v.label}
                  aria-keyshortcuts={v.shortcut ? v.shortcut.replace(/^Ctrl/, 'Control') : undefined}
                  title={v.shortcut ? `${v.label} (${v.shortcut})` : v.label}
                  onClick={(e) => {
                    e.preventDefault();
                    go(v.id);
                  }}
                >
                  <v.icon size={18} weight={view === v.id ? 'fill' : 'regular'} aria-hidden />
                  <span>{v.label}</span>
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="dock-tools">
          <button type="button" className="iconbtn" aria-label="Help and keyboard shortcuts (F1)" title="Help (F1)" aria-keyshortcuts="F1" onClick={() => setHelp(true)}>
            <Question size={16} aria-hidden />
          </button>
          <button type="button" className="iconbtn" aria-label="Toggle fullscreen" title="Toggle fullscreen" onClick={toggleFullscreen}>
            <ArrowsOut size={16} aria-hidden />
          </button>
          {motion.reduced && (
            <span className="dock-motion" title={motion.source === 'battery' ? 'Reduced motion: low battery' : motion.source === 'windows' ? 'Reduced motion: Windows setting' : 'Reduced motion: app setting'}>
              Reduced motion
            </span>
          )}
        </div>
        <SidebarStatus />
      </aside>
      <div className="stage">
        {isPreview && <PreviewBanner />}
        <RecoveryBanner />
        <SystemCheckBanner />
        <main id="main" ref={mainRef} tabIndex={-1} className="main" aria-label={current.label}>
          <div key={view} className="view">
            <RouteBoundary key={view} label={current.label}>
              <Suspense fallback={<RouteLoading label={current.label} />}>{body}</Suspense>
            </RouteBoundary>
          </div>
        </main>
      </div>
      <HelpDialog open={help} onClose={() => setHelp(false)} go={go} />
      <Toasts />
    </div>
  );
}

function Gate() {
  const { status, loadError, reload, settings, isPreview } = useStore();
  const motion = useThemeSync();
  if (status === 'loading') {
    return (
      <div className="boot">
        <LoadingBlock label="Loading saved data…" />
      </div>
    );
  }
  if (status === 'error' || !settings) {
    return (
      <div className="boot">
        <div className="boot-card">
          <Notice tone="danger" title="Saved data could not be loaded">
            {loadError ?? 'The app did not respond.'}
          </Notice>
          <Button variant="primary" onClick={() => reload().catch(() => undefined)}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!settings.onboarded) {
    return (
      <div className="onboard-wrap">
        {isPreview && <PreviewBanner />}
        <Onboarding />
        <Toasts />
      </div>
    );
  }
  return <Shell motion={motion} />;
}

export function App() {
  return (
    <CompanionProvider>
      <Gate />
    </CompanionProvider>
  );
}
