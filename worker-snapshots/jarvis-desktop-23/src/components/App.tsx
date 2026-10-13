import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Info, WarningCircle, WifiHigh, WifiSlash, X } from '@phosphor-icons/react';
import { Avatar } from './Avatar';
import { SceneBackdrop } from './SceneBackdrop';
import { Onboarding } from './Onboarding';
import { Home } from './Home';
import { Assistant } from './Assistant';
import { Companion } from './Companion';
import { Capsules } from './Capsules';
import { Notes } from './Notes';
import { Tasks } from './Tasks';
import { Computer } from './Computer';
import { Status } from './Status';
import { Settings } from './Settings';
import { FeatureLab } from './FeatureLab';
import { Developer } from './Developer';
import { ConfirmDialog } from '../ui/Dialog';
import { Button, LoadingBlock, Notice } from '../ui/primitives';
import { VIEWS, viewFromHash, type ViewId } from '../ui/nav';
import { useStore } from '../ui/store';
import { usePref } from '../ui/prefs';
import { DEFAULT_SCENE } from '../ui/scenes';
import { CompanionProvider, useCompanion } from '../ui/companion';
import { resetPreviewData, seedPreviewDemo } from '../preview';
import { cx } from '../ui/util';

function useReducedMotion(pref: boolean): boolean {
  const [os, setOs] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return undefined;
    const on = () => setOs(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return pref || os;
}

function useThemeSync(): void {
  const { settings } = useStore();
  const reduced = useReducedMotion(settings?.reduceMotion ?? false);
  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'graphite';
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  }, [settings?.theme, reduced]);
}

function useView(): [ViewId, (v: ViewId) => void] {
  const [view, setView] = useState<ViewId>(() => viewFromHash(window.location.hash));
  useEffect(() => {
    const on = () => setView(viewFromHash(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((v: ViewId) => {
    if (window.location.hash !== `#/${v}`) window.location.hash = `/${v}`;
    else setView(v);
  }, []);
  return [view, go];
}

function Toasts() {
  const { toasts, dismissToast } = useStore();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.kind}`)} role={t.kind === 'error' ? 'alert' : 'status'}>
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

function SidebarStatus() {
  const { settings, cloudConfigured } = useStore();
  const { state } = useCompanion();
  if (!settings) return null;
  const online = settings.mode === 'online';
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
        {online && <span className="dock-line">{cloudConfigured === null ? 'Key status unknown' : cloudConfigured ? 'Key saved' : 'No key saved'}</span>}
        <span className="dock-line dock-state">Companion: {state}</span>
      </div>
    </div>
  );
}

function Shell() {
  const { settings, isPreview } = useStore();
  const [view, go] = useView();
  const [scene] = usePref('scene', DEFAULT_SCENE);
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
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const n = e.key === '0' ? 10 : Number(e.key);
      if (n >= 1 && n <= VIEWS.length) {
        e.preventDefault();
        go(VIEWS[n - 1].id);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [go]);

  let body: ReactNode;
  switch (view) {
    case 'assistant':
      body = <Assistant />;
      break;
    case 'companion':
      body = <Companion />;
      break;
    case 'capsules':
      body = <Capsules />;
      break;
    case 'notes':
      body = <Notes />;
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
      body = <Settings />;
      break;
    case 'lab':
      body = <FeatureLab />;
      break;
    case 'developer':
      body = <Developer />;
      break;
    default:
      body = <Home go={go} />;
  }

  const groups = Array.from(new Set(VIEWS.map((v) => v.group)));

  return (
    <div className="app">
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); mainRef.current?.focus(); }}>
        Skip to content
      </a>
      <SceneBackdrop scene={scene} className="app-scene" />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
          </span>
          <div className="brand-text">
            <strong>JARVIS</strong>
            <span>Desktop companion</span>
          </div>
        </div>
        <nav aria-label="Primary" className="nav">
          {groups.map((g) => (
            <div className="nav-group" key={g}>
              <p className="nav-label">{g}</p>
              {VIEWS.filter((v) => v.group === g).map((v) => {
                const idx = VIEWS.indexOf(v) + 1;
                return (
                  <a
                    key={v.id}
                    href={`#/${v.id}`}
                    className={cx('nav-item', view === v.id && 'active')}
                    aria-current={view === v.id ? 'page' : undefined}
                    title={`${v.label} (Alt+${idx === 10 ? 0 : idx})`}
                    onClick={(e) => {
                      e.preventDefault();
                      go(v.id);
                    }}
                  >
                    <v.icon size={18} weight={view === v.id ? 'fill' : 'regular'} aria-hidden />
                    <span>{v.label}</span>
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <SidebarStatus />
      </aside>
      <div className="stage">
        {isPreview && <PreviewBanner />}
        <main id="main" ref={mainRef} tabIndex={-1} className="main" aria-label={VIEWS.find((v) => v.id === view)?.label}>
          <div key={view} className="view">
            {body}
          </div>
        </main>
      </div>
      <Toasts />
    </div>
  );
}

function Gate() {
  const { status, loadError, reload, settings, isPreview } = useStore();
  useThemeSync();
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
            {loadError ?? 'The backend did not respond.'}
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
  return <Shell />;
}

export function App() {
  return (
    <CompanionProvider>
      <Gate />
    </CompanionProvider>
  );
}
