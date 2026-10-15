import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowCounterClockwise, DownloadSimple, Export, FloppyDisk, Key, MagnifyingGlass, Trash, UploadSimple, WifiHigh, WifiSlash, X } from '@phosphor-icons/react';
import type { Mode, Settings as SettingsT } from '../shared/contracts';
import { PathListEditor } from './shared';
import { ModelReadinessNotice, cloudModelError, localEndpointError, localModelError, modelReadiness, useModelCheck, type ModelReadiness } from './Onboarding';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Field, Notice, PageHeader, Panel, Segmented, Switch } from '../ui/primitives';
import { readPref, writePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { cx, errMsg } from '../ui/util';

/* ---------- Shell preferences (this window only, never secrets) ---------- */

/**
 * UI-only preferences the shell reads and Settings edits. They live in localStorage through prefs.ts.
 * The plain usePref hook only notices changes made by other windows, so this hook also announces a
 * change inside this window: the sidebar, toasts, Home and text size follow the moment it is saved.
 */
export const SHELL_PREF = {
  displayName: 'profile.displayName',
  textSize: 'text.size',
  motionOnBattery: 'motion.onBattery',
  quietToasts: 'toasts.quiet',
  homeLayout: 'home.layout',
} as const;

const PREF_EVENT = 'shell-pref-change';

export function useShellPref<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  useEffect(() => {
    const onLocal = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setValue(readPref(key, fallbackRef.current));
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key && e.key.endsWith(`.${key}`)) setValue(readPref(key, fallbackRef.current));
    };
    window.addEventListener(PREF_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PREF_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [key]);
  const set = useCallback(
    (v: T) => {
      writePref(key, v);
      setValue(v);
      window.dispatchEvent(new CustomEvent<string>(PREF_EVENT, { detail: key }));
    },
    [key],
  );
  return [value, set];
}

export const MAX_DISPLAY_NAME = 40;
export const normalizeDisplayName = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME) : '');

/* ---------- Searchable index ---------- */

export type SettingsTab = 'general' | 'models' | 'access' | 'data' | 'accessibility';
export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Mode & models' },
  { id: 'access', label: 'Access' },
  { id: 'data', label: 'Data' },
  { id: 'accessibility', label: 'Accessibility' },
];

/** One line under each group heading, so the grouping explains itself. */
export const SETTINGS_TAB_BLURBS: Record<SettingsTab, string> = {
  general: 'How the app looks and greets you. Appearance and notifications apply at once; startup and voice need Save.',
  models: 'Where chat runs, which model it uses and whether a key is saved. Mode and model fields need Save.',
  access: 'The folders and apps this assistant may use. Adding one asks for Windows confirmation when you Save.',
  data: 'How long history is kept, plus backup and restore.',
  accessibility: 'Motion, text size and keyboard help. These apply at once.',
};

export type SettingsEntry = { id: string; tab: SettingsTab; title: string; keywords: string[] };

/** Every panel on the Settings screen with the words people use for it. Searching matches title and keywords. */
export const SETTINGS_INDEX: SettingsEntry[] = [
  { id: 'appearance', tab: 'general', title: 'Appearance', keywords: ['theme', 'dark', 'light', 'graphite', 'nebula', 'paper', 'colour', 'color', 'look'] },
  { id: 'profile', tab: 'general', title: 'Profile', keywords: ['name', 'display name', 'greeting', 'who', 'personal'] },
  { id: 'startup', tab: 'general', title: 'Startup', keywords: ['tray', 'system tray', 'minimised', 'minimized', 'boot', 'launch', 'start'] },
  { id: 'notifications', tab: 'general', title: 'Notifications', keywords: ['toast', 'message', 'popup', 'quiet', 'alerts', 'sound'] },
  { id: 'voice', tab: 'general', title: 'Voice', keywords: ['speech', 'speak', 'tts', 'voice name', 'narrator'] },
  { id: 'status', tab: 'models', title: 'Connection status', keywords: ['summary', 'overview', 'route', 'local', 'cloud', 'key saved', 'unsaved', 'state', 'health'] },
  { id: 'mode', tab: 'models', title: 'Mode', keywords: ['offline', 'online', 'cloud', 'privacy', 'internet'] },
  { id: 'readiness', tab: 'models', title: 'Model readiness', keywords: ['ready', 'check', 'ollama', 'running', 'status'] },
  { id: 'local-model', tab: 'models', title: 'Local model', keywords: ['ollama', 'endpoint', 'localhost', '127.0.0.1', 'port', 'llama', 'model name'] },
  { id: 'cloud-model', tab: 'models', title: 'Cloud model', keywords: ['api key', 'key', 'token', 'provider', 'claude', 'anthropic', 'secret'] },
  { id: 'folders', tab: 'access', title: 'Allowed folders', keywords: ['files', 'directory', 'path', 'permission', 'scope', 'roots'] },
  { id: 'apps', tab: 'access', title: 'Approved apps', keywords: ['launch', 'program', 'exe', 'application', 'permission'] },
  { id: 'retention', tab: 'data', title: 'Retention', keywords: ['history', 'days', 'keep', 'delete', 'clear chat', 'conversation', 'privacy'] },
  { id: 'backup', tab: 'data', title: 'Backup', keywords: ['export', 'import', 'restore', 'file', 'copy', 'migrate'] },
  { id: 'motion', tab: 'accessibility', title: 'Motion', keywords: ['reduce motion', 'animation', 'battery', 'reduced', 'vestibular', 'power'] },
  { id: 'text-size', tab: 'accessibility', title: 'Text size', keywords: ['font', 'larger', 'zoom', 'readability', 'scale', 'big'] },
  { id: 'keyboard', tab: 'accessibility', title: 'Keyboard', keywords: ['shortcut', 'alt', 'ctrl', 'f1', 'help', 'focus'] },
];

const MAX_QUERY = 80;

/** Case-insensitive match on title, tab label and keywords; every word in the query must match somewhere. */
export function searchSettings(query: string, index: SettingsEntry[] = SETTINGS_INDEX): SettingsEntry[] {
  const words = query
    .toLowerCase()
    .slice(0, MAX_QUERY)
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const scored = index
    .map((e, order) => {
      const hay = [e.title, SETTINGS_TABS.find((t) => t.id === e.tab)?.label ?? '', ...e.keywords].join(' ').toLowerCase();
      const title = e.title.toLowerCase();
      return { e, order, hit: words.every((w) => hay.includes(w)), rank: words.filter((w) => title.includes(w)).length };
    })
    .filter((x) => x.hit);
  // Sections whose title matches come first; ties keep the order of the screen.
  return scored.sort((a, b) => b.rank - a.rank || a.order - b.order).map((x) => x.e);
}

/* ---------- Validation, confirmations and status (pure, so they can be tested) ---------- */

export type SettingsIssue = { sectionId: string; tab: SettingsTab; label: string; message: string };

const RETAIN_ERROR = 'Whole number of days from 1 to 3650.';
export const retainDaysError = (retain: string): string | null => (/^\d+$/.test(retain) && Number(retain) >= 1 && Number(retain) <= 3650 ? null : RETAIN_ERROR);

/** Every problem that blocks Save, with the section that holds it. */
export function settingsIssues(draft: Pick<SettingsT, 'localEndpoint' | 'localModel' | 'cloudModel'>, retain: string): SettingsIssue[] {
  const out: SettingsIssue[] = [];
  const endpoint = localEndpointError(draft.localEndpoint);
  const model = localModelError(draft.localModel);
  const cloud = cloudModelError(draft.cloudModel);
  const days = retainDaysError(retain);
  if (endpoint) out.push({ sectionId: 'local-model', tab: 'models', label: 'Local endpoint', message: endpoint });
  if (model) out.push({ sectionId: 'local-model', tab: 'models', label: 'Local model name', message: model });
  if (cloud) out.push({ sectionId: 'cloud-model', tab: 'models', label: 'Cloud model name', message: cloud });
  if (days) out.push({ sectionId: 'retention', tab: 'data', label: 'Keep history for', message: days });
  return out;
}

type PermissionFields = Pick<SettingsT, 'mode' | 'localEndpoint' | 'allowedRoots' | 'approvedApps'>;

/**
 * The changes Windows will ask you to confirm when you press Save. This mirrors the rule the main process applies
 * (new apps, new folders, going online, a different local endpoint) so the list is a preview, not the gate itself.
 */
export function nativeConfirmationChanges(saved: PermissionFields, draft: PermissionFields): string[] {
  return [
    ...draft.approvedApps.filter((v) => !saved.approvedApps.includes(v)).map((v) => `Approve app: ${v}`),
    ...draft.allowedRoots.filter((v) => !saved.allowedRoots.includes(v)).map((v) => `Allow folder: ${v}`),
    ...(saved.mode !== 'online' && draft.mode === 'online' ? ['Turn on online mode'] : []),
    ...(saved.localEndpoint.trim() !== draft.localEndpoint.trim() ? [`Change the local model address to ${draft.localEndpoint.trim()}`] : []),
  ];
}

/** Checks a pasted key before it leaves this window. Returns a message, or null when it may be sent to be stored. */
export function apiKeyProblem(raw: string): string | null {
  const k = raw.trim();
  if (k.length < 8) return 'That does not look like a full API key.';
  if (k.length > 400) return 'That key is too long.';
  if (/[\s\u0000-\u001f\u007f]/.test(k)) return 'A key has no spaces or line breaks. Paste only the key itself.';
  return null;
}

export type StatusRow = { id: string; label: string; value: string; tone: 'ok' | 'warn' | 'muted'; note: string };

/**
 * An honest summary of what chat will do. It describes the saved settings (what the app actually uses) and says
 * so when the draft differs. Nothing here contacts a provider; cloud reachability is only known when you send.
 */
export function connectionStatus(input: { savedMode: Mode; draftMode: Mode; local: ModelReadiness; cloud: ModelReadiness; cloudConfigured: boolean | null }): StatusRow[] {
  const { savedMode, draftMode, local, cloud, cloudConfigured } = input;
  const online = savedMode === 'online';
  const level = (l: ModelReadiness['level']): StatusRow['tone'] => (l === 'ready' ? 'ok' : l === 'blocked' ? 'warn' : 'muted');
  const rows: StatusRow[] = [
    {
      id: 'route',
      label: 'Chat route',
      value: online ? 'Online (cloud)' : 'Offline (this computer)',
      tone: online ? 'warn' : 'ok',
      note: online ? 'Each message you send goes to the cloud provider. There is no automatic fallback to the local model.' : 'Messages stay on this computer. There is no automatic fallback to the cloud.',
    },
  ];
  if (draftMode !== savedMode) rows.push({ id: 'pending-mode', label: 'Unsaved mode change', value: draftMode === 'online' ? 'Online' : 'Offline', tone: 'warn', note: 'Chat keeps using the saved mode until you press Save changes.' });
  rows.push({ id: 'local', label: 'Local model', value: local.level === 'ready' ? 'Ready' : local.level === 'blocked' ? 'Not available' : 'Unknown', tone: level(local.level), note: `${local.title}. ${local.detail}` });
  rows.push({ id: 'cloud', label: 'Cloud model', value: cloud.level === 'ready' ? 'Set up' : cloud.level === 'blocked' ? 'Not set up' : 'Unknown', tone: level(cloud.level), note: `${cloud.title}. ${cloud.detail}` });
  rows.push({
    id: 'key',
    label: 'API key',
    value: cloudConfigured === null ? 'Status unknown' : cloudConfigured ? 'Saved' : 'Not saved',
    tone: cloudConfigured ? 'ok' : cloudConfigured === null ? 'muted' : 'warn',
    note: cloudConfigured ? 'Stored with Windows protection. The key itself is never shown or kept in this window.' : cloudConfigured === null ? 'The saved-key check did not answer. Use Check again.' : 'No key is stored, so online chat cannot send.',
  });
  return rows;
}

/* ---------- Sections ---------- */

type SectionContext = { show: (id: string, tab: SettingsTab) => boolean; searching: boolean; highlight: string | null; register: (id: string, el: HTMLElement | null) => void };
type SectionProps = { id: string; panelTab: SettingsTab; title: string; eyebrow?: string; children: ReactNode; actions?: ReactNode };

/**
 * A Panel that search can find, focus and highlight. Defined at module level so React keeps the
 * same component identity between renders; the inputs inside keep focus while the user types.
 */
function SettingsSection({ id, panelTab, title, eyebrow, children, actions, ctx }: SectionProps & { ctx: SectionContext }) {
  if (!ctx.show(id, panelTab)) return null;
  const tabLabel = SETTINGS_TABS.find((t) => t.id === panelTab)?.label ?? '';
  return (
    <div id={`settings-${id}`} ref={(el) => ctx.register(id, el)} tabIndex={-1} className={cx('settings-section', ctx.highlight === id && 'is-highlighted')}>
      <Panel title={title} eyebrow={ctx.searching ? `${tabLabel}${eyebrow ? ` · ${eyebrow}` : ''}` : eyebrow} actions={actions}>
        {children}
      </Panel>
    </div>
  );
}

/* ---------- Before-you-save summary ---------- */

/**
 * Shown while there are unsaved edits: what failed last time, what blocks Save (each one jumps to its field),
 * and the permission changes Windows will ask you to confirm. Silent when there is nothing to say.
 */
export function PreSaveSummary({ issues, confirmations, saveFailed, saving, onRetry, onJump }: { issues: SettingsIssue[]; confirmations: string[]; saveFailed: boolean; saving: boolean; onRetry: () => void; onJump: (target: { id: string; tab: SettingsTab }) => void }) {
  const invalid = issues.length > 0;
  if (!saveFailed && !invalid && confirmations.length === 0) return null;
  return (
    <div className="stack tight" role="region" aria-label="Before you save">
      {saveFailed && (
        <Notice tone="danger" title="Your changes were not saved" action={<Button size="sm" busy={saving} onClick={onRetry}>Try again</Button>}>
          Your edits are still here and nothing was changed. If you cancelled the Windows confirmation, press Try again and choose Yes, or Revert to drop the edits.
        </Notice>
      )}
      {invalid && (
        <>
          <Notice tone="warn" title={issues.length === 1 ? 'Fix one problem before saving' : `Fix ${issues.length} problems before saving`}>
            Choose one to jump to it.
          </Notice>
          <ul className="chips" aria-label="Problems to fix">
            {issues.map((i) => (
              <li key={`${i.sectionId}-${i.label}`}>
                <button type="button" className="chip" onClick={() => onJump({ id: i.sectionId, tab: i.tab })}>
                  {i.label} <span className="sub">{i.message}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!invalid && confirmations.length > 0 && (
        <Notice title="Windows will ask you to confirm these changes">
          {confirmations.join('. ')}. Nothing changes until you choose Yes in the Windows dialog; choosing No leaves everything as it was.
        </Notice>
      )}
    </div>
  );
}

/* ---------- Draft handling ---------- */

const DRAFT_KEYS = ['mode', 'localEndpoint', 'localModel', 'cloudModel', 'voice', 'allowedRoots', 'approvedApps', 'retainDays', 'startInTray'] as const;
type DraftKey = (typeof DRAFT_KEYS)[number];
type Draft = Pick<SettingsT, DraftKey>;
const pick = (s: SettingsT): Draft => ({ mode: s.mode, localEndpoint: s.localEndpoint, localModel: s.localModel, cloudModel: s.cloudModel, voice: s.voice, allowedRoots: [...s.allowedRoots], approvedApps: [...s.approvedApps], retainDays: s.retainDays, startInTray: s.startInTray });

export function Settings({ initialQuery = '' }: { initialQuery?: string }) {
  const { settings, state, api, mutate, run, toast, cloudConfigured, refreshCloud, refreshSystem, system, systemError, isPreview } = useReady();
  const check = useModelCheck();
  const [tab, setTab] = useState<SettingsTab>('general');
  const [query, setQuery] = useState(initialQuery.slice(0, MAX_QUERY));
  const [draft, setDraft] = useState<Draft>(() => pick(settings));
  const [saving, setSaving] = useState(false);
  const [confirmOnline, setConfirmOnline] = useState(false);
  const [retain, setRetain] = useState(String(settings.retainDays));

  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [confirmKeyDelete, setConfirmKeyDelete] = useState(false);

  const [exportNote, setExportNote] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const [displayName, setDisplayName] = useShellPref<string>(SHELL_PREF.displayName, '');
  const [textSize, setTextSize] = useShellPref<'normal' | 'large'>(SHELL_PREF.textSize, 'normal');
  const [motionOnBattery, setMotionOnBattery] = useShellPref<boolean>(SHELL_PREF.motionOnBattery, false);
  const [quietToasts, setQuietToasts] = useShellPref<boolean>(SHELL_PREF.quietToasts, false);
  const [nameDraft, setNameDraft] = useState(displayName);
  const batterySupported = typeof (navigator as Navigator & { getBattery?: unknown }).getBattery === 'function';

  const baseline = useMemo(() => pick(settings), [settings]);
  const baselineKey = JSON.stringify(baseline);
  const prevBaseline = useRef(baselineKey);
  const draftKey = JSON.stringify(draft);
  const dirty = draftKey !== baselineKey;

  useEffect(() => {
    if (prevBaseline.current !== baselineKey) {
      if (draftKey === prevBaseline.current) {
        setDraft(baseline);
        setRetain(String(baseline.retainDays));
      }
      prevBaseline.current = baselineKey;
    }
  }, [baselineKey, baseline, draftKey]);

  const set = <K extends DraftKey>(k: K, v: Draft[K]) => {
    setSaveFailed(false);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const endpointError = localEndpointError(draft.localEndpoint);
  const modelError = localModelError(draft.localModel);
  const cloudError = cloudModelError(draft.cloudModel);
  const retainNum = Number(retain);
  const retainError = retainDaysError(retain);
  const issues = settingsIssues(draft, retain);
  const invalid = issues.length > 0;
  const confirmations = nativeConfirmationChanges(settings, draft);
  // The main process probes the saved settings, so readiness always describes what is saved, not the unsaved draft.
  const readiness = modelReadiness({ settings, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });
  const caps = system?.capabilities ?? null;
  const status = connectionStatus({
    savedMode: settings.mode,
    draftMode: draft.mode,
    local: modelReadiness({ settings: { ...settings, mode: 'offline' }, capabilities: caps, systemError, cloudConfigured }),
    cloud: modelReadiness({ settings: { ...settings, mode: 'online' }, capabilities: caps, systemError, cloudConfigured }),
    cloudConfigured,
  });

  const doSave = async () => {
    setSaving(true);
    setSaveFailed(false);
    const ok = await mutate(() => api.saveSettings({ ...draft, localEndpoint: draft.localEndpoint.trim(), localModel: draft.localModel.trim(), cloudModel: draft.cloudModel.trim(), voice: draft.voice.trim(), retainDays: retainNum }), 'Settings saved.');
    setSaving(false);
    setConfirmOnline(false);
    // Edits stay in the form when a save fails or the Windows confirmation is declined, so nothing is retyped.
    setSaveFailed(!ok);
    if (ok) {
      void refreshSystem();
      void refreshCloud();
    }
    return ok;
  };
  const requestSave = () => {
    if (invalid) {
      toast('error', `Fix ${issues.length === 1 ? 'the problem' : `the ${issues.length} problems`} listed above first.`);
      return;
    }
    if (draft.mode === 'online' && settings.mode === 'offline') setConfirmOnline(true);
    else void doSave();
  };

  const saveKey = async () => {
    const k = key.trim();
    const problem = apiKeyProblem(k);
    if (problem) return setKeyError(problem);
    setKeyBusy(true);
    setKeyError(null);
    try {
      await api.setCloudKey(k);
      setKey('');
      await refreshCloud();
      void refreshSystem();
      toast('ok', 'Key saved. It is stored with Windows protection and will not be shown again.');
    } catch (e) {
      setKeyError(errMsg(e, 'The key could not be saved.'));
    } finally {
      setKeyBusy(false);
    }
  };

  const deleteKey = async () => {
    setKeyBusy(true);
    try {
      await api.deleteCloudKey();
      toast('ok', 'Key deleted.');
      setConfirmKeyDelete(false);
      void refreshSystem();
    } catch (e) {
      toast('error', errMsg(e, 'The key could not be deleted.'));
    } finally {
      setKeyBusy(false);
      await refreshCloud();
    }
  };

  const doExport = async () => {
    setExporting(true);
    setExportNote(null);
    try {
      const r = await api.exportData();
      setExportNote(r.path ? `Exported to ${r.path}` : 'Export cancelled. Nothing was written.');
    } catch (e) {
      toast('error', errMsg(e, 'Export failed.'));
    } finally {
      setExporting(false);
    }
  };

  const doImport = async () => {
    setImporting(true);
    const ok = await mutate(() => api.importData(), 'Import finished.');
    setImporting(false);
    if (ok) setConfirmImport(false);
  };

  const online = draft.mode === 'online';

  /* ---------- Search ---------- */
  const searching = query.trim().length > 0;
  const matches = useMemo(() => searchSettings(query), [query]);
  const matchIds = useMemo(() => new Set(matches.map((m) => m.id)), [matches]);
  const panelRefs = useRef(new Map<string, HTMLElement>());
  const [highlight, setHighlight] = useState<string | null>(null);

  // While searching, every tab's matching panels are shown together; otherwise only the open tab.
  const show = (id: string, panelTab: SettingsTab) => (searching ? matchIds.has(id) : tab === panelTab);

  const jumpTo = (entry: { id: string; tab: SettingsTab }) => {
    setQuery('');
    setTab(entry.tab);
    setHighlight(entry.id);
    requestAnimationFrame(() => {
      const el = panelRefs.current.get(entry.id);
      // Instant scroll: the section is also outlined, so no animation is needed to see where focus went.
      el?.scrollIntoView({ block: 'start', behavior: 'auto' });
      el?.focus();
    });
  };

  // A pasted key lives only in this component's memory. It is dropped as soon as its section is hidden
  // (another tab, a search), when the window is hidden, and when Settings closes. It is never written to storage.
  const cloudVisible = show('cloud-model', 'models');
  useEffect(() => {
    if (!cloudVisible) {
      setKey('');
      setKeyError(null);
    }
  }, [cloudVisible]);
  useEffect(() => {
    const drop = () => {
      if (document.visibilityState === 'hidden') setKey('');
    };
    document.addEventListener('visibilitychange', drop);
    return () => {
      document.removeEventListener('visibilitychange', drop);
      setKey('');
    };
  }, []);

  const anyDialog = confirmOnline || confirmKeyDelete || confirmImport || confirmClear;
  const onPageKeyDown = (e: ReactKeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's' && !anyDialog) {
      e.preventDefault();
      if (dirty && !saving) requestSave();
    }
  };
  useEffect(() => {
    if (!highlight) return undefined;
    const h = window.setTimeout(() => setHighlight(null), 2400);
    return () => window.clearTimeout(h);
  }, [highlight]);

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) panelRefs.current.set(id, el);
    else panelRefs.current.delete(id);
  }, []);
  const sectionCtx: SectionContext = { show, searching, highlight, register };

  return (
    <div className="page" onKeyDown={onPageKeyDown}>
      <PageHeader eyebrow="System" title="Settings" subtitle="Appearance and accessibility apply immediately. Everything else is saved with the Save button (or Ctrl+S)." />

      <div className="settings-search" role="search">
        <Field label="Search settings" hint={searching ? `${matches.length} section${matches.length === 1 ? '' : 's'} match.` : 'Type a word such as “theme”, “key” or “folders” to jump to a section.'} className="grow">
          {(id, d) => (
            <div className="search-wide">
              <MagnifyingGlass size={16} aria-hidden />
              <input id={id} aria-describedby={d} className="input" value={query} maxLength={MAX_QUERY} placeholder="Search settings" onChange={(e) => setQuery(e.target.value)} aria-controls="settings-results" onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.preventDefault(); setQuery(''); } else if (e.key === 'Enter' && searching && matches.length > 0) { e.preventDefault(); jumpTo(matches[0]); } }} />
              {query && (
                <button type="button" className="iconbtn" aria-label="Clear search" onClick={() => setQuery('')}>
                  <X size={14} aria-hidden />
                </button>
              )}
            </div>
          )}
        </Field>
        <span className="sr-only" role="status" aria-live="polite">
          {searching ? (matches.length ? `${matches.length} matching section${matches.length === 1 ? '' : 's'}. Press Enter to open the first.` : 'No matching sections.') : ''}
        </span>
        {searching && matches.length > 0 && (
          <ul className="chips" aria-label="Matching sections">
            {matches.map((m) => (
              <li key={m.id}>
                <button type="button" className="chip" onClick={() => jumpTo(m)}>
                  {m.title} <span className="sub">{SETTINGS_TABS.find((t) => t.id === m.tab)?.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {searching && matches.length === 0 && (
          <p className="field-hint">
            No section matches “{query.trim()}”. Try a different word, or clear the search to browse the tabs.
          </p>
        )}
      </div>

      {!searching && (
        <div role="tablist" aria-label="Settings sections" className="tabs">
          {SETTINGS_TABS.map((t, i) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls={tab === t.id ? `panel-${t.id}` : undefined}
              tabIndex={tab === t.id ? 0 : -1}
              className={cx('tab', tab === t.id && 'on')}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -i : e.key === 'End' ? SETTINGS_TABS.length - 1 - i : 0;
                if (!step) return;
                e.preventDefault();
                const n = SETTINGS_TABS[(i + step + SETTINGS_TABS.length) % SETTINGS_TABS.length];
                setTab(n.id);
                document.getElementById(`tab-${n.id}`)?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {!searching && (
        <p className="field-hint" id={`blurb-${tab}`}>
          {SETTINGS_TAB_BLURBS[tab]}
        </p>
      )}

      {dirty && <PreSaveSummary issues={issues} confirmations={confirmations} saveFailed={saveFailed} saving={saving} onRetry={requestSave} onJump={jumpTo} />}

      <div role={searching ? 'region' : 'tabpanel'} id={searching ? 'settings-results' : `panel-${tab}`} aria-labelledby={searching ? undefined : `tab-${tab}`} aria-label={searching ? 'Matching settings' : undefined} className="stack tab-body">
        <SettingsSection ctx={sectionCtx} id="appearance" panelTab="general" title="Appearance" eyebrow="Applies immediately">
          <Field label="Theme">
            {() => (
              <Segmented<SettingsT['theme']>
                label="Theme"
                value={settings.theme}
                onChange={(v) => void mutate(() => api.saveSettings({ theme: v }))}
                options={[
                  { value: 'graphite', label: 'Graphite', hint: 'Dark graphite with cool blue and amber accents' },
                  { value: 'nebula', label: 'Nebula', hint: 'Deep indigo' },
                  { value: 'paper', label: 'Paper', hint: 'Light theme' },
                ]}
              />
            )}
          </Field>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="profile" panelTab="general" title="Profile" eyebrow="This window only">
          <form
            className="row wrap align-end"
            onSubmit={(e) => {
              e.preventDefault();
              const v = normalizeDisplayName(nameDraft);
              setNameDraft(v);
              setDisplayName(v);
              toast('ok', v ? `Home will greet ${v}.` : 'Display name cleared.');
            }}
          >
            <Field label="Display name" hint="Used only for the greeting on Home. Kept in this window’s preferences, not in your exported data." className="grow">
              {(id, d) => <input id={id} aria-describedby={d} className="input" value={nameDraft} maxLength={MAX_DISPLAY_NAME} autoComplete="off" onChange={(e) => setNameDraft(e.target.value)} />}
            </Field>
            <Button type="submit" icon={FloppyDisk} disabled={normalizeDisplayName(nameDraft) === displayName}>
              Save name
            </Button>
          </form>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="startup" panelTab="general" title="Startup" eyebrow="Needs Save">
          <Switch label="Start in the system tray" description="Open minimised to the tray instead of showing the window." checked={draft.startInTray} onChange={(v) => set('startInTray', v)} />
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="notifications" panelTab="general" title="Notifications" eyebrow="Applies immediately">
          <Switch label="Quiet success messages" description="Hides the small “saved” style messages in the corner. Errors and important information still show. Windows notifications are not used by this app." checked={quietToasts} onChange={setQuietToasts} />
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="voice" panelTab="general" title="Voice" eyebrow="Needs Save">
          <Field label="Voice name" hint="Used by Windows speech. Leave empty for the default voice. Available voices depend on what is installed.">
            {(id, d) => <input id={id} aria-describedby={d} className="input" value={draft.voice} maxLength={120} onChange={(e) => set('voice', e.target.value)} />}
          </Field>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="status" panelTab="models" title="Connection status" eyebrow="What is saved and in use">
          <dl className="kv-list">
            {status.map((r) => (
              <div className="kv" key={r.id}>
                <dt>{r.label}</dt>
                <dd>
                  <Badge tone={r.tone}>{r.value}</Badge> <span className="field-hint">{r.note}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p className="field-hint">This summary reads what is saved. Nothing is sent to a provider to produce it; the cloud provider is only contacted when you send a message in online mode.</p>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="mode" panelTab="models" title="Mode" eyebrow="Needs Save">
          <Segmented<Mode>
            label="Mode"
            value={draft.mode}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'offline', label: 'Offline', icon: WifiSlash },
              { value: 'online', label: 'Online', icon: WifiHigh },
            ]}
          />
          {online ? (
            <Notice tone="warn" title="Online sends your messages to a cloud provider">
              Chat uses the cloud model below with your own API key. With no saved key, chat shows an error and sends nothing. If a cloud request fails, the failure is shown, but the request may already have reached the provider. There is no automatic fallback to the local model or any other provider.
            </Notice>
          ) : (
            <Notice title="Offline keeps chat on this computer">Chat uses only the local endpoint below. If it is not running you get an error; it never falls back to the cloud.</Notice>
          )}
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="readiness" panelTab="models" title="Model readiness" eyebrow="Live check of saved settings">
          <ModelReadinessNotice readiness={readiness} checking={check.checking} onRecheck={() => void check.recheck()} />
          {dirty && <p className="field-hint">This check uses your saved settings. Save your changes to check the new ones.</p>}
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="local-model" panelTab="models" title="Local model" eyebrow="Offline route">
          <p className="field-hint">Desktop Companion does not include a model. Offline chat needs Ollama running on this computer. Install it, start it, then install a model once with “ollama pull” followed by the model name.</p>
          <div className="grid2">
            <Field label="Endpoint" error={endpointError} hint="Must start with http:// and point at this computer (127.0.0.1, localhost or [::1]).">
              {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localEndpoint} maxLength={200} spellCheck={false} onChange={(e) => set('localEndpoint', e.target.value)} />}
            </Field>
            <Field label="Model name" error={modelError} hint="The name Ollama knows the model by, for example llama3.2:3b.">
              {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localModel} maxLength={120} spellCheck={false} onChange={(e) => set('localModel', e.target.value)} />}
            </Field>
          </div>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="cloud-model" panelTab="models" title="Cloud model" eyebrow="Online route">
          <Field label="Model name" error={cloudError} hint="Used only in online mode.">
            {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.cloudModel} maxLength={120} spellCheck={false} onChange={(e) => set('cloudModel', e.target.value)} />}
          </Field>
          <div className="key-box">
            <div className="key-head">
              <Key size={18} aria-hidden />
              <strong>API key</strong>
              {cloudConfigured === null ? <Badge>Status unknown</Badge> : cloudConfigured ? <Badge tone="ok">Saved</Badge> : <Badge tone="warn">Not saved</Badge>}
            </div>
            <p className="field-hint">
              Stored with Windows protection, never in this window’s storage and never shown again, so it cannot be revealed or copied back out here. What you paste is held in memory only and cleared when you save, switch section, hide the window or leave Settings. Saving replaces any existing key. Online mode without a key cannot send.
            </p>
            <form
              className="row wrap"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <Field label="New key" error={keyError} className="grow">
                {(id, d) => <input id={id} aria-describedby={d} className="input mono" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={400} onChange={(e) => { setKey(e.target.value); setKeyError(null); }} placeholder={isPreview ? 'Unavailable in browser preview' : cloudConfigured ? 'A key is saved. Paste a new one to replace it' : 'Paste your key'} />}
              </Field>
              <div className="row align-end">
                <Button type="submit" icon={FloppyDisk} busy={keyBusy} disabled={!key.trim()}>Save key</Button>
                <Button variant="danger" icon={Trash} disabled={keyBusy || cloudConfigured !== true} onClick={() => setConfirmKeyDelete(true)}>Delete key</Button>
              </div>
            </form>
          </div>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="folders" panelTab="access" title="Allowed folders" eyebrow="Files · needs Save">
          <p className="field-hint">Folders Desktop Companion may work inside when asked. Anything outside is out of scope. Adding a folder asks for a Windows confirmation when you Save; removing one does not.</p>
          <PathListEditor kind="folder" items={draft.allowedRoots} onChange={(v) => set('allowedRoots', v)} />
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="apps" panelTab="access" title="Approved apps" eyebrow="Launching · needs Save">
          <p className="field-hint">Applications Desktop Companion may launch. Windows asks you to confirm each one you add. Each launch still shows a preview and waits for your approval on the Computer screen.</p>
          <PathListEditor kind="app" items={draft.approvedApps} onChange={(v) => set('approvedApps', v)} />
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="retention" panelTab="data" title="Retention" eyebrow="Needs Save">
          <Field label="Keep history for (days)" error={retainError} hint="How long this app keeps chat and activity history.">
            {(id, d) => <input id={id} aria-describedby={d} className="input narrow" inputMode="numeric" value={retain} onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, '').slice(0, 4); setRetain(v); if (/^\d+$/.test(v)) set('retainDays', Number(v)); }} />}
          </Field>
          <div className="row">
            <Button variant="danger" icon={Trash} disabled={state.chat.length === 0} onClick={() => setConfirmClear(true)}>Clear conversation now ({state.chat.length})</Button>
          </div>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="backup" panelTab="data" title="Backup" eyebrow="Export & import">
          <p className="field-hint">Export writes your data to a file you choose. Import loads a backup you choose and may replace your current capsules, notes, tasks and settings.</p>
          <div className="row">
            <Button icon={DownloadSimple} busy={exporting} onClick={() => void doExport()}>Export…</Button>
            <Button icon={UploadSimple} onClick={() => setConfirmImport(true)}>Import…</Button>
          </div>
          {exportNote && <p className="field-hint" role="status"><Export size={14} aria-hidden /> {exportNote}</p>}
          {isPreview && <p className="field-hint">Export and import are unavailable in browser preview.</p>}
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="motion" panelTab="accessibility" title="Motion" eyebrow="Applies immediately">
          <Switch label="Reduce motion" description="Turns off avatar, scene, panel and Motion studio animation. Saved with your settings. The Windows reduced-motion setting is also respected." checked={settings.reduceMotion} onChange={(v) => void mutate(() => api.saveSettings({ reduceMotion: v }))} />
          <Switch
            label="Reduce motion on low battery"
            description={batterySupported ? 'Pauses animation while this computer runs on battery at 20% or less. Kept in this window’s preferences.' : 'Battery level is not readable on this computer, so this rule has no effect here.'}
            checked={motionOnBattery}
            onChange={setMotionOnBattery}
            disabled={!batterySupported}
          />
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="text-size" panelTab="accessibility" title="Text size" eyebrow="Applies immediately">
          <Segmented<'normal' | 'large'>
            label="Text size"
            value={textSize}
            onChange={setTextSize}
            options={[
              { value: 'normal', label: 'Standard' },
              { value: 'large', label: 'Larger', hint: 'Scales the whole window up by about 15%' },
            ]}
          />
          <p className="field-hint">Windows display scaling still applies on top of this choice.</p>
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="keyboard" panelTab="accessibility" title="Keyboard" eyebrow="Reference">
          <p className="field-hint">The first ten screens in sidebar order can be reached with Alt+1 to Alt+9 and Alt+0; the rest are reached from the sidebar or by clicking. Memory search is Ctrl+K and help is F1. Shortcuts pause while a dialog is open. The full list is in Help.</p>
          <dl className="kv-list">
            <div className="kv"><dt>Help</dt><dd><kbd>F1</kbd></dd></div>
            <div className="kv"><dt>Memory search</dt><dd><kbd>Ctrl</kbd> + <kbd>K</kbd></dd></div>
            <div className="kv"><dt>Save changes</dt><dd><kbd>Ctrl</kbd> + <kbd>S</kbd> when there are unsaved changes</dd></div>
            <div className="kv"><dt>Search settings</dt><dd><kbd>Enter</kbd> opens the first match, <kbd>Esc</kbd> clears</dd></div>
            <div className="kv"><dt>Switch section</dt><dd><kbd>←</kbd> <kbd>→</kbd> <kbd>Home</kbd> <kbd>End</kbd> on the section tabs</dd></div>
            <div className="kv"><dt>Skip to content</dt><dd><kbd>Tab</kbd> from the top of the window</dd></div>
          </dl>
        </SettingsSection>
      </div>

      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved settings">
          <span>You have unsaved changes{invalid ? ' with ' + issues.length + (issues.length === 1 ? ' problem' : ' problems') : ''}.</span>
          <Button icon={ArrowCounterClockwise} onClick={() => { setDraft(baseline); setRetain(String(baseline.retainDays)); setSaveFailed(false); }} disabled={saving}>Revert</Button>
          <Button variant="primary" icon={FloppyDisk} busy={saving} onClick={requestSave}>Save changes</Button>
        </div>
      )}

      <ConfirmDialog open={confirmOnline} title="Switch to online mode?" confirmLabel="Save and go online" busy={saving} onCancel={() => setConfirmOnline(false)} onConfirm={() => void doSave()}>
        <p>Your chat messages will be sent to the cloud model “{draft.cloudModel || 'not set'}” using your API key. Windows will ask you to confirm this too. Offline mode stays available and there is no automatic switching between the two.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmKeyDelete} title="Delete the saved key?" confirmLabel="Delete key" danger busy={keyBusy} onCancel={() => setConfirmKeyDelete(false)} onConfirm={() => void deleteKey()}>
        <p>Online chat stops working until you save a key again. Offline mode is not affected.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmImport} title="Import a backup?" confirmLabel="Choose file and import" danger busy={importing} onCancel={() => setConfirmImport(false)} onConfirm={() => void doImport()}>
        <p>You will pick a backup file. Importing may replace your current capsules, notes, tasks and settings. Export first if you want a copy of what you have now.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmClear} title="Clear the conversation?" confirmLabel="Clear" danger onCancel={() => setConfirmClear(false)} onConfirm={async () => { await run(() => api.clearChat(), 'Conversation cleared.'); setConfirmClear(false); }}>
        <p>{state.chat.length} saved messages are deleted from this computer.</p>
      </ConfirmDialog>
    </div>
  );
}
