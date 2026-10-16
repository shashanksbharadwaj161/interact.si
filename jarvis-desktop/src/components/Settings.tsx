import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { ArrowCounterClockwise, DownloadSimple, Export, FloppyDisk, Key, MagnifyingGlass, Trash, UploadSimple, WifiHigh, WifiSlash, X } from '@phosphor-icons/react';
import type { CloudProvider, CloudProviderStatus, Mode, Settings as SettingsT } from '../shared/contracts';
import { CLOUD_PROVIDERS, DEFAULT_CLOUD_PROVIDER, cloudProviderInfo, effectiveCloudModel, isCloudProvider } from '../shared/contracts';
import '../styles/cloud-providers.css';
import { PathListEditor } from './shared';
import { ModelReadinessNotice, cloudModelError, localEndpointError, localModelError, modelReadiness, useModelCheck, type ModelReadiness } from './Onboarding';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Field, Notice, PageHeader, Panel, Segmented, Switch } from '../ui/primitives';
import { readPref, usePref, writePref } from '../ui/prefs';
import { LICENSE_OFFLINE_NOTE, LICENSE_PREF_KEY, LICENSE_TRUSTED_KEYS_PREF_KEY, describeLicense, evaluateLicense, normalizeTrustedKeys, parseLicense, verifyLicenseSignature, type LicenseEvaluation, type LicenseParseResult, type LicenseVerifyResult } from '../ui/license-file';
import { cloudProvidersBridge, productivityBridge } from '../ui/bridges';
import { BUNDLE_LIMITS, decryptBundle, encryptBundle, parseBundle, serializeBundle, summarizePlaintext, type BundleParseResult } from '../ui/encrypted-bundle';
import { PROFILES_PREF_KEY, PROFILE_FIELD_LABELS, PROFILE_LIMITS, applyProfile, captureProfile, diffProfile, normalizeProfiles, removeProfile, renameProfile, setActiveProfile, upsertProfile, updateProfileSettings, type ProfilesState } from '../ui/profiles';
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
  theme: 'appearance.theme',
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
  { id: 'personal-profiles', tab: 'general', title: 'Personal profiles', keywords: ['profile', 'profiles', 'switch profile', 'preset', 'named', 'personal', 'save current'] },
  { id: 'startup', tab: 'general', title: 'Startup', keywords: ['tray', 'system tray', 'minimised', 'minimized', 'boot', 'launch', 'start'] },
  { id: 'notifications', tab: 'general', title: 'Notifications', keywords: ['toast', 'message', 'popup', 'quiet', 'alerts', 'sound'] },
  { id: 'voice', tab: 'general', title: 'Voice', keywords: ['speech', 'speak', 'tts', 'voice name', 'narrator'] },
  { id: 'status', tab: 'models', title: 'Connection status', keywords: ['summary', 'overview', 'route', 'local', 'cloud', 'key saved', 'unsaved', 'state', 'health'] },
  { id: 'mode', tab: 'models', title: 'Mode', keywords: ['offline', 'online', 'cloud', 'privacy', 'internet'] },
  { id: 'readiness', tab: 'models', title: 'Model readiness', keywords: ['ready', 'check', 'ollama', 'running', 'status'] },
  { id: 'local-model', tab: 'models', title: 'Local model', keywords: ['ollama', 'endpoint', 'localhost', '127.0.0.1', 'port', 'llama', 'model name'] },
  { id: 'cloud-model', tab: 'models', title: 'Cloud model', keywords: ['api key', 'key', 'token', 'provider', 'claude', 'anthropic', 'secret', 'openai', 'openrouter', 'gpt'] },
  { id: 'folders', tab: 'access', title: 'Allowed folders', keywords: ['files', 'directory', 'path', 'permission', 'scope', 'roots'] },
  { id: 'apps', tab: 'access', title: 'Approved apps', keywords: ['launch', 'program', 'exe', 'application', 'permission'] },
  { id: 'retention', tab: 'data', title: 'Retention', keywords: ['history', 'days', 'keep', 'delete', 'clear chat', 'conversation', 'privacy'] },
  { id: 'backup', tab: 'data', title: 'Backup', keywords: ['export', 'import', 'restore', 'file', 'copy', 'migrate'] },
  { id: 'encrypted-bundle', tab: 'data', title: 'Encrypted transfer bundle', keywords: ['encrypt', 'encrypted', 'passphrase', 'transfer', 'bundle', 'sync', 'another computer', 'move', 'decrypt'] },
  { id: 'license', tab: 'data', title: 'License (offline verification)', keywords: ['license', 'licence', 'activation', 'serial', 'pro', 'edition', 'signature', 'verify', 'trusted key', 'expiry', 'expires'] },
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

/* ---------- Encrypted transfer bundle (goal 109, manual, no sync service) ---------- */

export const BUNDLE_NOTE = 'Bundles are encrypted locally with your passphrase and moved by you. This build has no sync account or server.';
export const BUNDLE_RESTORE_NOTE = 'Restore into this app uses the existing import flow; this build does not merge automatically.';
const BUNDLE_FILE_MAX_BYTES = 20_000_000;

/** Returns a message when the passphrase pair cannot be used to create a bundle, or null when it can. */
export function bundlePassphraseProblem(pass: string, repeat: string): string | null {
  if (pass.length < BUNDLE_LIMITS.passphraseMin) return `Use at least ${BUNDLE_LIMITS.passphraseMin} characters.`;
  if (pass !== repeat) return 'The two passphrases do not match.';
  return null;
}

type BundleSource = { get(): Promise<unknown> } | null;

/**
 * Creates and opens passphrase-encrypted bundles in this window. The data comes from the local productivity store
 * through the existing bridge; nothing here sends anything anywhere. Files are offered as a Blob download and read
 * back with FileReader, so no file path is ever used.
 */
export function EncryptedBundlePanel({ source, notify }: { source: BundleSource; notify: (kind: 'ok' | 'error' | 'info', text: string) => void }) {
  const [pass, setPass] = useState('');
  const [passRepeat, setPassRepeat] = useState('');
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [bundleJson, setBundleJson] = useState<string | null>(null);
  const [bundleUrl, setBundleUrl] = useState<string | null>(null);
  const [bundleName, setBundleName] = useState('desktop-companion-bundle.json');

  const [importText, setImportText] = useState('');
  const [importPass, setImportPass] = useState('');
  const [opening, setOpening] = useState(false);
  const [parsed, setParsed] = useState<BundleParseResult | null>(null);
  const [decryptReason, setDecryptReason] = useState<string | null>(null);
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  useEffect(() => () => { if (bundleUrl) URL.revokeObjectURL(bundleUrl); }, [bundleUrl]);

  const passProblem = pass || passRepeat ? bundlePassphraseProblem(pass, passRepeat) : null;
  const canCreate = !!source && !bundlePassphraseProblem(pass, passRepeat) && !creating;

  const create = async () => {
    if (!source) return;
    setCreating(true);
    setCreateError(null);
    try {
      const data = await source.get();
      const plaintext = JSON.stringify(data, null, 2);
      const envelope = await encryptBundle(plaintext ?? '', pass, { label: label.trim() || null });
      const json = serializeBundle(envelope);
      setBundleJson(json);
      setBundleName(`desktop-companion-bundle-${envelope.createdAt.slice(0, 10)}.json`);
      setBundleUrl(URL.createObjectURL(new Blob([json], { type: 'application/json' })));
      setPass('');
      setPassRepeat('');
      notify('ok', 'Encrypted bundle created. Download it or copy the JSON.');
    } catch (e) {
      setCreateError(errMsg(e, 'The bundle could not be created.'));
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('ok', `${what} copied.`);
    } catch {
      notify('error', `${what} could not be copied.`);
    }
  };

  const readFile = (file: File | undefined) => {
    setFileNote(null);
    if (!file) return;
    if (file.size > BUNDLE_FILE_MAX_BYTES) {
      setFileNote(`That file is ${file.size} bytes; the limit is ${BUNDLE_FILE_MAX_BYTES}.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImportText(typeof reader.result === 'string' ? reader.result : '');
      setParsed(null);
      setDecrypted(null);
      setDecryptReason(null);
      setFileNote(`Loaded ${file.name}.`);
    };
    reader.onerror = () => setFileNote('The file could not be read.');
    reader.readAsText(file);
  };

  const open = async () => {
    setOpening(true);
    setDecrypted(null);
    setDecryptReason(null);
    const p = parseBundle(importText.trim());
    setParsed(p);
    try {
      if (p.ok) {
        const r = await decryptBundle(p.envelope, importPass);
        if (r.ok) {
          setDecrypted(r.plaintext);
          setImportPass('');
        } else setDecryptReason(r.reason);
      }
    } finally {
      setOpening(false);
    }
  };

  const counts = decrypted ? summarizePlaintext(decrypted) : null;

  return (
    <div className="stack tight" data-testid="encrypted-bundle">
      <Notice title="Encrypted transfer bundle (manual, no sync service)">{BUNDLE_NOTE}</Notice>

      <h3>Create a bundle</h3>
      {!source && <p className="field-hint">Local notes, tasks and capsules are not connected in this window, so there is nothing to encrypt here.</p>}
      <div className="grid2">
        <Field label="Passphrase" hint={`At least ${BUNDLE_LIMITS.passphraseMin} characters. It is never stored; without it the bundle cannot be opened.`}>
          {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="new-password" spellCheck={false} value={pass} maxLength={1024} onChange={(e) => setPass(e.target.value)} />}
        </Field>
        <Field label="Repeat passphrase" error={passProblem}>
          {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="new-password" spellCheck={false} value={passRepeat} maxLength={1024} onChange={(e) => setPassRepeat(e.target.value)} />}
        </Field>
      </div>
      <Field label="Label (optional)" hint="Stored unencrypted next to the bundle, for example the computer it came from.">
        {(id, d) => <input id={id} aria-describedby={d} className="input" value={label} maxLength={120} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />}
      </Field>
      <div className="row wrap">
        <Button icon={Key} busy={creating} disabled={!canCreate} onClick={() => void create()}>Create encrypted bundle</Button>
        {bundleUrl && (
          <a className="btn btn-ghost" href={bundleUrl} download={bundleName}>
            <DownloadSimple size={16} aria-hidden /> <span>Download {bundleName}</span>
          </a>
        )}
        {bundleJson && <Button onClick={() => void copy(bundleJson, 'Bundle JSON')}>Copy JSON</Button>}
      </div>
      {createError && <p className="field-error" role="alert">{createError}</p>}

      <h3>Open a bundle</h3>
      <Field label="Bundle file" hint="Read inside this window. No file path is used.">
        {(id, d) => <input id={id} aria-describedby={d} type="file" accept="application/json,.json" onChange={(e) => readFile(e.target.files?.[0])} />}
      </Field>
      {fileNote && <p className="field-hint" role="status">{fileNote}</p>}
      <Field label="Or paste bundle JSON">
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={5} spellCheck={false} value={importText} onChange={(e) => { setImportText(e.target.value); setParsed(null); setDecrypted(null); setDecryptReason(null); }} />}
      </Field>
      <Field label="Bundle passphrase">
        {(id, d) => <input id={id} aria-describedby={d} className="input" type="password" autoComplete="off" spellCheck={false} value={importPass} maxLength={1024} onChange={(e) => setImportPass(e.target.value)} />}
      </Field>
      <div className="row wrap">
        <Button icon={UploadSimple} busy={opening} disabled={!importText.trim() || !importPass} onClick={() => void open()}>Decrypt and verify</Button>
      </div>
      {parsed && parsed.errors.length > 0 && (
        <ul className="field-error" role="alert" aria-label="Bundle problems">
          {parsed.errors.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
      {parsed && parsed.warnings.length > 0 && (
        <ul className="field-hint" aria-label="Bundle warnings">
          {parsed.warnings.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
      {parsed?.ok && (
        <dl className="kv-list">
          <div className="kv"><dt>Created</dt><dd>{parsed.envelope.createdAt}</dd></div>
          <div className="kv"><dt>Label</dt><dd>{parsed.envelope.label ?? 'None'}</dd></div>
        </dl>
      )}
      {decryptReason && <p className="field-error" role="alert">Decryption failed: {decryptReason}</p>}
      {decrypted !== null && (
        <div className="stack tight" role="status">
          <p className="field-hint">Decrypted and verified: {decrypted.length} characters.</p>
          {counts ? (
            <ul className="chips" aria-label="Bundle contents">
              {Object.entries(counts).map(([k, n]) => <li key={k} className="chip">{k}: {n}</li>)}
              {Object.keys(counts).length === 0 && <li className="chip">No lists found</li>}
            </ul>
          ) : (
            <p className="field-hint">The decrypted text is not a JSON object, so no counts are shown.</p>
          )}
          <div className="row wrap">
            <Button onClick={() => void copy(decrypted, 'Decrypted JSON')}>Copy decrypted JSON</Button>
          </div>
        </div>
      )}
      <p className="field-hint">{BUNDLE_RESTORE_NOTE}</p>
    </div>
  );
}

/* ---------- License (goal 119, offline verification only) ---------- */

type LicenseCheck = { parsed: LicenseParseResult; keyErrors: string[]; verify: LicenseVerifyResult | null; evaluation: LicenseEvaluation | null; error: string | null };

/**
 * Pasted license JSON and trusted public keys, verified in this window with crypto.subtle. No network call is made,
 * nothing is activated, and no existing feature is gated on the result.
 */
export function LicensePanel() {
  const [licenseText, setLicenseText] = usePref<string>(LICENSE_PREF_KEY, '');
  const [keysText, setKeysText] = usePref<string>(LICENSE_TRUSTED_KEYS_PREF_KEY, '');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<LicenseCheck | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const verify = async () => {
    setChecking(true);
    try {
      const parsed = parseLicense(typeof licenseText === 'string' ? licenseText.trim() : '');
      const { keys, errors: keyErrors } = normalizeTrustedKeys(typeof keysText === 'string' ? keysText.trim() : '');
      if (!parsed.ok) {
        setResult({ parsed, keyErrors, verify: null, evaluation: null, error: null });
        return;
      }
      const subtle = (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
      const v = await verifyLicenseSignature(parsed.license, keys, subtle);
      let evaluation: LicenseEvaluation | null = null;
      let error: string | null = null;
      try {
        evaluation = evaluateLicense(parsed.license, v, new Date());
      } catch (e) {
        error = errMsg(e, 'The license could not be evaluated.');
      }
      setResult({ parsed, keyErrors, verify: v, evaluation, error });
    } finally {
      setChecking(false);
    }
  };

  const remove = () => {
    setLicenseText('');
    setResult(null);
    setConfirmRemove(false);
  };

  const parsed = result?.parsed ?? null;
  const ev = result?.evaluation ?? null;
  const tone: 'ok' | 'warn' | 'danger' | 'muted' = ev ? (ev.status === 'valid' ? 'ok' : ev.status === 'expiring-soon' || ev.status === 'in-grace' ? 'warn' : 'danger') : 'muted';

  return (
    <div className="stack tight" data-testid="license-panel">
      <Notice title="Offline verification only">{LICENSE_OFFLINE_NOTE}</Notice>
      <Field label="License JSON" hint="Paste the license file contents. Kept in this window’s preferences. Nothing is sent anywhere.">
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={6} spellCheck={false} value={licenseText} onChange={(e) => { setLicenseText(e.target.value); setResult(null); setConfirmRemove(false); }} />}
      </Field>
      <Field label="Trusted public keys (JSON)" hint='An array of {"keyId", "publicKeyJwk"} with EC P-256 public keys only. Private keys are rejected.'>
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={4} spellCheck={false} value={keysText} onChange={(e) => { setKeysText(e.target.value); setResult(null); }} />}
      </Field>
      <div className="row wrap">
        <Button icon={Key} busy={checking} disabled={!licenseText.trim()} onClick={() => void verify()}>Verify license</Button>
        {!confirmRemove ? (
          <Button variant="danger" icon={Trash} disabled={!licenseText} onClick={() => setConfirmRemove(true)}>Remove license</Button>
        ) : (
          <>
            <Button variant="danger" icon={Trash} onClick={remove}>Confirm remove license</Button>
            <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </>
        )}
      </div>
      {confirmRemove && <p className="field-hint" role="status">Removing clears the pasted license from this window’s preferences. Trusted keys are kept. Press Confirm to remove it.</p>}
      {parsed && parsed.errors.length > 0 && (
        <ul className="field-error" role="alert" aria-label="License problems">
          {parsed.errors.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
      {parsed && parsed.warnings.length > 0 && (
        <ul className="field-hint" aria-label="License warnings">
          {parsed.warnings.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
      {result && result.keyErrors.length > 0 && (
        <ul className="field-error" aria-label="Trusted key problems">
          {result.keyErrors.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}
      {result?.error && <p className="field-error" role="alert">{result.error}</p>}
      {parsed?.ok && result?.verify && (
        <div className="stack tight" role="status">
          <p>
            Signature: <Badge tone={result.verify.ok ? 'ok' : 'warn'}>{result.verify.reason}</Badge>
            {ev && <> Status: <Badge tone={tone}>{ev.status}</Badge></>}
          </p>
          {ev && <p className="field-hint">{ev.explanation}</p>}
          <dl className="kv-list">
            {describeLicense(parsed.license).map((r) => (
              <div className="kv" key={r.label}><dt>{r.label}</dt><dd>{r.value}</dd></div>
            ))}
            <div className="kv"><dt>Days remaining</dt><dd>{ev ? (ev.daysRemaining === null ? 'Not applicable' : String(ev.daysRemaining)) : 'Not applicable'}</dd></div>
          </dl>
          {parsed.license.features.length > 0 && (
            <ul className="chips" aria-label="Licensed features">
              {parsed.license.features.map((f) => <li key={f} className="chip">{f}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Personal profiles (goal 7, offline, this window's preferences) ---------- */

export const PROFILES_NOTE = 'A profile stores theme, reduce motion, voice, local model, start in tray and history days. It never stores mode, folders, apps, the cloud model or any key, so switching cannot widen access or go online.';

/**
 * Named profiles kept with the existing prefs.ts helpers. Switching applies the captured fields through saveSettings
 * (the same call every other Settings control uses); the active marker moves only after that save succeeds.
 */
export function PersonalProfilesPanel({ settings, applyPatch, notify }: { settings: SettingsT; applyPatch: (patch: Partial<SettingsT>) => Promise<string | null>; notify: (kind: 'ok' | 'error' | 'info', text: string) => void }) {
  const [stored, setStored] = usePref<unknown>(PROFILES_PREF_KEY, null);
  const state = useMemo(() => normalizeProfiles(stored), [stored]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);

  const commit = (fn: (s: ProfilesState) => ProfilesState, ok?: string): boolean => {
    try {
      setStored(fn(state));
      setError(null);
      if (ok) notify('ok', ok);
      return true;
    } catch (e) {
      setError(errMsg(e, 'The profile change could not be made.'));
      return false;
    }
  };

  const saveCurrent = () => {
    if (commit((s) => upsertProfile(s, captureProfile(newName, settings, new Date())), `Profile “${newName.replace(/\s+/g, ' ').trim()}” saved.`)) setNewName('');
  };

  const switchTo = async (id: string) => {
    const p = state.profiles.find((x) => x.id === id);
    if (!p) return;
    setBusyId(id);
    setError(null);
    try {
      const failure = await applyPatch({ ...applyProfile(p) });
      if (failure) {
        // The previous active profile stays marked; nothing about the profile list changes.
        setError(`Could not switch to “${p.name}”: ${failure}`);
        return;
      }
      commit((s) => setActiveProfile(s, id), `Switched to “${p.name}”.`);
    } finally {
      setBusyId(null);
    }
  };

  const doRename = () => {
    if (renameId && commit((s) => renameProfile(s, renameId, renameDraft, new Date()), 'Profile renamed.')) setRenameId(null);
  };

  const removing = removeId ? state.profiles.find((p) => p.id === removeId) ?? null : null;
  const full = state.profiles.length >= PROFILE_LIMITS.maxProfiles;

  return (
    <div className="stack tight" data-testid="personal-profiles">
      <p className="field-hint">{PROFILES_NOTE} Profiles capture saved settings, not unsaved edits, and stay in this window’s preferences.</p>
      <form className="row wrap align-end" onSubmit={(e) => { e.preventDefault(); saveCurrent(); }}>
        <Field label="Profile name" hint={full ? `You have ${PROFILE_LIMITS.maxProfiles} profiles, the most allowed. Remove one first.` : `1 to ${PROFILE_LIMITS.nameMax} characters, unique.`} className="grow">
          {(id, d) => <input id={id} aria-describedby={d} className="input" value={newName} maxLength={PROFILE_LIMITS.nameMax + 20} autoComplete="off" onChange={(e) => { setNewName(e.target.value); setError(null); }} />}
        </Field>
        <Button type="submit" icon={FloppyDisk} disabled={!newName.trim() || full}>Save current as profile</Button>
      </form>
      {error && <p className="field-error" role="alert">{error}</p>}
      {state.profiles.length === 0 ? (
        <p className="field-hint">No profiles yet. Name one above to save the current settings.</p>
      ) : (
        <ul className="stack tight" aria-label="Personal profiles">
          {state.profiles.map((p) => {
            const active = state.activeProfileId === p.id;
            const diff = diffProfile(p, settings);
            return (
              <li key={p.id} className="stack tight" aria-current={active ? 'true' : undefined}>
                <div className="row wrap">
                  <strong>{p.name}</strong>
                  {active && <Badge tone="ok">Active</Badge>}
                  {diff.length > 0 ? (
                    <span className="field-hint">Differs from current settings: {diff.map((k) => PROFILE_FIELD_LABELS[k]).join(', ')}{active ? ' (unsaved changes)' : ''}</span>
                  ) : (
                    <span className="field-hint">Matches current settings</span>
                  )}
                </div>
                {renameId === p.id ? (
                  <form className="row wrap align-end" onSubmit={(e) => { e.preventDefault(); doRename(); }}>
                    <Field label={`New name for ${p.name}`} className="grow">
                      {(id, d) => <input id={id} aria-describedby={d} className="input" value={renameDraft} maxLength={PROFILE_LIMITS.nameMax + 20} autoComplete="off" onChange={(e) => setRenameDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRenameId(null); } }} />}
                    </Field>
                    <Button type="submit" size="sm" disabled={!renameDraft.trim()}>Save name</Button>
                    <Button size="sm" onClick={() => setRenameId(null)}>Cancel</Button>
                  </form>
                ) : (
                  <div className="row wrap">
                    <Button size="sm" variant={active ? 'ghost' : 'primary'} busy={busyId === p.id} disabled={busyId !== null || (active && diff.length === 0)} aria-label={`Switch to ${p.name}`} onClick={() => void switchTo(p.id)}>Switch</Button>
                    <Button size="sm" disabled={diff.length === 0} aria-label={`Update ${p.name} from current settings`} onClick={() => commit((s) => updateProfileSettings(s, p.id, settings, new Date()), `Profile “${p.name}” updated.`)}>Update from current</Button>
                    <Button size="sm" aria-label={`Rename ${p.name}`} onClick={() => { setRenameId(p.id); setRenameDraft(p.name); setError(null); }}>Rename</Button>
                    <Button size="sm" variant="danger" icon={Trash} aria-label={`Remove ${p.name}`} onClick={() => setRemoveId(p.id)}>Remove</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog open={!!removing} title={removing ? `Remove profile “${removing.name}”?` : 'Remove profile?'} confirmLabel="Remove profile" danger onCancel={() => setRemoveId(null)} onConfirm={() => { if (removing) commit((s) => removeProfile(s, removing.id), 'Profile removed.'); setRemoveId(null); }}>
        <p>Only the saved profile is removed. Your current settings stay as they are.</p>
      </ConfirmDialog>
    </div>
  );
}

/* ---------- Cloud providers (goal 102: optional providers, honest per-provider key status) ---------- */

export const CLOUD_PROVIDER_NOTE = 'Requests go only to the chosen provider, and only in online mode. Offline mode never contacts any provider, and there is no automatic switch to another provider or to the local model.';
export const PROVIDER_KEYS_NOTE = 'Each provider has its own key, stored with Windows protection on this computer. A stored key is never shown again; this screen only learns whether one is stored. No key is included with the app: use your own provider account.';

/** Badge text for one provider's key slot. Unknown or unconnected states are said plainly, never shown as stored. */
export function providerKeyLabel(s: CloudProviderStatus | undefined): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (!s || s.hasKey === null) return { text: 'Key status unknown', tone: 'muted' };
  if (s.keyChannel === 'unavailable') return { text: 'No key (not connected in this build)', tone: 'muted' };
  return s.hasKey ? { text: 'Key stored', tone: 'ok' } : { text: 'No key', tone: 'warn' };
}

export function CloudProvidersPanel({ api, provider, cloudModel, onSelect, notify, onKeysChanged, isPreview }: {
  api: Parameters<typeof cloudProvidersBridge>[0];
  provider: CloudProvider;
  cloudModel: string;
  onSelect: (p: CloudProvider) => void;
  notify: (kind: 'ok' | 'error' | 'info', text: string) => void;
  onKeysChanged?: () => void;
  isPreview?: boolean;
}) {
  const client = useMemo(() => cloudProvidersBridge(api), [api]);
  const [statuses, setStatuses] = useState<CloudProviderStatus[] | null>(null);
  const [keys, setKeys] = useState<Partial<Record<CloudProvider, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<CloudProvider, string>>>({});
  const [busy, setBusy] = useState<CloudProvider | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CloudProvider | null>(null);
  const refresh = useCallback(async () => {
    try { setStatuses(await client.status()); } catch { setStatuses(null); }
  }, [client]);
  useEffect(() => { void refresh(); }, [refresh]);
  // Pasted keys live only in this component's memory and are dropped when the window is hidden or the panel closes.
  useEffect(() => {
    const drop = () => { if (document.visibilityState === 'hidden') setKeys({}); };
    document.addEventListener('visibilitychange', drop);
    return () => { document.removeEventListener('visibilitychange', drop); setKeys({}); };
  }, []);

  const info = cloudProviderInfo(provider);
  const model = effectiveCloudModel(provider, cloudModel);
  const statusOf = (p: CloudProvider) => statuses?.find((s) => s.provider === p);

  const save = async (p: CloudProvider) => {
    const k = (keys[p] ?? '').trim();
    const problem = apiKeyProblem(k);
    if (problem) { setErrors((e) => ({ ...e, [p]: problem })); return; }
    setBusy(p);
    setErrors((e) => ({ ...e, [p]: undefined }));
    try {
      await client.setKey(p, k);
      setKeys((m) => ({ ...m, [p]: '' }));
      notify('ok', `${cloudProviderInfo(p).name} key stored. It will not be shown again.`);
      onKeysChanged?.();
    } catch (e) {
      setErrors((m) => ({ ...m, [p]: errMsg(e, 'The key could not be stored.') }));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const remove = async (p: CloudProvider) => {
    setBusy(p);
    try {
      await client.clearKey(p);
      notify('ok', `${cloudProviderInfo(p).name} key removed.`);
      onKeysChanged?.();
    } catch (e) {
      setErrors((m) => ({ ...m, [p]: errMsg(e, 'The key could not be removed.') }));
    } finally {
      setBusy(null);
      setConfirmRemove(null);
      await refresh();
    }
  };

  const active = providerKeyLabel(statusOf(provider));
  return (
    <div className="cloud-providers stack tight" data-testid="cloud-providers">
      <div className="field">
        <label htmlFor="cloud-provider-select">Cloud provider</label>
        <select id="cloud-provider-select" className="input" value={provider} onChange={(e) => { if (isCloudProvider(e.target.value)) onSelect(e.target.value); }}>
          {CLOUD_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <p className="field-hint" data-testid="cloud-provider-routing">{CLOUD_PROVIDER_NOTE} The chosen provider is {info.name} ({info.host}).</p>
      <dl className="kv-list">
        <div className="kv"><dt>Model used</dt><dd><span className="mono">{model}</span>{model !== cloudModel.trim() && <span className="field-hint"> The saved model name does not fit {info.name}, so its default model is used.</span>}</dd></div>
        <div className="kv"><dt>{info.name} key</dt><dd><Badge tone={active.tone}>{active.text}</Badge></dd></div>
      </dl>
      <p className="field-hint">{PROVIDER_KEYS_NOTE}</p>
      <ul className="cloud-provider-list" aria-label="Provider keys">
        {CLOUD_PROVIDERS.map((p) => {
          const s = statusOf(p.id);
          const label = providerKeyLabel(s);
          const inputId = `provider-key-${p.id}`;
          return (
            <li key={p.id} className={cx('cloud-provider-row', p.id === provider && 'is-active')}>
              <div className="cloud-provider-head">
                <Key size={16} aria-hidden />
                <strong>{p.name}</strong>
                {p.id === provider && <Badge tone="accent">Selected</Badge>}
                <Badge tone={label.tone}>{label.text}</Badge>
                <span className="sub mono">{p.host}</span>
              </div>
              <p className="field-hint">{p.capability} Default model: <span className="mono">{p.defaultModel}</span>.{s?.reason ? ` ${s.reason}` : ''}</p>
              <form className="row wrap align-end" onSubmit={(e) => { e.preventDefault(); void save(p.id); }}>
                <div className="field grow">
                  <label htmlFor={inputId}>New {p.name} key</label>
                  <input id={inputId} className="input mono" type="password" autoComplete="off" spellCheck={false} maxLength={400} value={keys[p.id] ?? ''} placeholder={isPreview ? 'Unavailable in browser preview' : s?.hasKey ? 'A key is stored. Paste a new one to replace it' : 'Paste your key'} onChange={(e) => { const v = e.target.value; setKeys((m) => ({ ...m, [p.id]: v })); setErrors((m) => ({ ...m, [p.id]: undefined })); }} />
                </div>
                <Button type="submit" size="sm" icon={FloppyDisk} busy={busy === p.id} disabled={busy !== null || !(keys[p.id] ?? '').trim()}>Save</Button>
                {confirmRemove === p.id ? (
                  <>
                    <Button size="sm" variant="danger" icon={Trash} busy={busy === p.id} onClick={() => void remove(p.id)}>Confirm remove</Button>
                    <Button size="sm" onClick={() => setConfirmRemove(null)}>Cancel</Button>
                  </>
                ) : (
                  <Button size="sm" variant="danger" icon={Trash} disabled={busy !== null || s?.hasKey !== true} onClick={() => setConfirmRemove(p.id)}>Remove</Button>
                )}
              </form>
              {errors[p.id] && <p className="field-error" role="alert">{errors[p.id]}</p>}
            </li>
          );
        })}
      </ul>
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
  const activeProvider: CloudProvider = isCloudProvider(settings.cloudProvider) ? settings.cloudProvider : DEFAULT_CLOUD_PROVIDER;
  const [confirmProvider, setConfirmProvider] = useState<CloudProvider | null>(null);
  const applyProvider = async (p: CloudProvider) => {
    await mutate(() => api.saveSettings({ cloudProvider: p }), `Cloud provider set to ${cloudProviderInfo(p).name}.`);
    setConfirmProvider(null);
    void refreshSystem();
  };
  // Changing providers online asks for consent before the backend's independent native permission check.
  const chooseProvider = (p: CloudProvider) => {
    if (p === activeProvider) return;
    if (settings.mode === 'online') setConfirmProvider(p);
    else void applyProvider(p);
  };

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
  /** Applies a profile patch with the shared saveSettings call. Resolves null on success, or the error text. */
  const applyProfilePatch = async (patch: Partial<SettingsT>): Promise<string | null> => {
    let failure: unknown = null;
    const ok = await mutate(async () => {
      try {
        return await api.saveSettings(patch);
      } catch (e) {
        failure = e;
        throw e;
      }
    });
    return ok ? null : errMsg(failure, 'The settings could not be saved.');
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
  // The existing Backup export writes a file from the main process and never hands JSON to this window,
  // so the bundle reads the local productivity store through the existing bridge instead.
  const bundleSource = useMemo(() => productivityBridge(api), [api]);

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

  const anyDialog = confirmOnline || confirmKeyDelete || confirmImport || confirmClear || confirmProvider !== null;
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

        <SettingsSection ctx={sectionCtx} id="personal-profiles" panelTab="general" title="Personal profiles" eyebrow="Switch applies immediately">
          <PersonalProfilesPanel settings={settings} applyPatch={applyProfilePatch} notify={toast} />
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
          <CloudProvidersPanel api={api} provider={activeProvider} cloudModel={settings.cloudModel} onSelect={chooseProvider} notify={toast} isPreview={isPreview} onKeysChanged={() => { void refreshCloud(); void refreshSystem(); }} />
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

        <SettingsSection ctx={sectionCtx} id="encrypted-bundle" panelTab="data" title="Encrypted transfer bundle (manual, no sync service)" eyebrow="Move data between computers yourself">
          <EncryptedBundlePanel source={bundleSource} notify={toast} />
        </SettingsSection>

        <SettingsSection ctx={sectionCtx} id="license" panelTab="data" title="License (offline verification)" eyebrow="No activation server">
          <LicensePanel />
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
      <ConfirmDialog open={confirmProvider !== null} title={confirmProvider ? `Send online chat to ${cloudProviderInfo(confirmProvider).name}?` : 'Change cloud provider?'} confirmLabel="Change provider" onCancel={() => setConfirmProvider(null)} onConfirm={() => { if (confirmProvider) void applyProvider(confirmProvider); }}>
        <p>{confirmProvider ? `From your next message, online chat goes only to ${cloudProviderInfo(confirmProvider).name} (${cloudProviderInfo(confirmProvider).host}) with that provider's own key. If no key is stored for it, chat shows an error and sends nothing. No other provider is tried.` : ''}</p>
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
