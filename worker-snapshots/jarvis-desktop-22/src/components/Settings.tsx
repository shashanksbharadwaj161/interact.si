import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, DownloadSimple, Export, FloppyDisk, Key, Trash, UploadSimple, WifiHigh, WifiSlash } from '@phosphor-icons/react';
import type { Mode, Settings as SettingsT } from '../shared/contracts';
import { PathListEditor } from './shared';
import { ModelReadinessNotice, cloudModelError, localEndpointError, localModelError, modelReadiness, useModelCheck } from './Onboarding';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Field, Notice, PageHeader, Panel, Segmented, Switch } from '../ui/primitives';
import { useReady } from '../ui/store';
import { cx, errMsg } from '../ui/util';

type Tab = 'general' | 'models' | 'access' | 'data';
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'models', label: 'Mode & models' },
  { id: 'access', label: 'Access' },
  { id: 'data', label: 'Data' },
];

const DRAFT_KEYS = ['mode', 'localEndpoint', 'localModel', 'cloudModel', 'voice', 'allowedRoots', 'approvedApps', 'retainDays', 'startInTray'] as const;
type DraftKey = (typeof DRAFT_KEYS)[number];
type Draft = Pick<SettingsT, DraftKey>;
const pick = (s: SettingsT): Draft => ({ mode: s.mode, localEndpoint: s.localEndpoint, localModel: s.localModel, cloudModel: s.cloudModel, voice: s.voice, allowedRoots: [...s.allowedRoots], approvedApps: [...s.approvedApps], retainDays: s.retainDays, startInTray: s.startInTray });

export function Settings() {
  const { settings, state, api, mutate, run, toast, cloudConfigured, refreshCloud, refreshSystem, system, systemError, isPreview } = useReady();
  const check = useModelCheck();
  const [tab, setTab] = useState<Tab>('general');
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

  const set = <K extends DraftKey>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const endpointError = localEndpointError(draft.localEndpoint);
  const modelError = localModelError(draft.localModel);
  const cloudError = cloudModelError(draft.cloudModel);
  const retainNum = Number(retain);
  const retainError = /^\d+$/.test(retain) && retainNum >= 1 && retainNum <= 3650 ? null : 'Whole number of days from 1 to 3650.';
  const invalid = Boolean(endpointError || modelError || cloudError || retainError);
  // The backend probes the saved settings, so readiness always describes what is saved, not the unsaved draft.
  const readiness = modelReadiness({ settings, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });

  const doSave = async () => {
    setSaving(true);
    const ok = await mutate(() => api.saveSettings({ ...draft, localEndpoint: draft.localEndpoint.trim(), localModel: draft.localModel.trim(), cloudModel: draft.cloudModel.trim(), voice: draft.voice.trim(), retainDays: retainNum }), 'Settings saved.');
    setSaving(false);
    setConfirmOnline(false);
    if (ok) {
      void refreshSystem();
      void refreshCloud();
    }
    return ok;
  };
  const requestSave = () => {
    if (invalid) {
      toast('error', 'Fix the highlighted fields first.');
      return;
    }
    if (draft.mode === 'online' && settings.mode === 'offline') setConfirmOnline(true);
    else void doSave();
  };

  const saveKey = async () => {
    const k = key.trim();
    if (k.length < 8) return setKeyError('That does not look like a full API key.');
    if (k.length > 400) return setKeyError('That key is too long.');
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

  return (
    <div className="page">
      <PageHeader eyebrow="System" title="Settings" subtitle="Appearance applies immediately. Everything else is saved with the Save button." />

      <div role="tablist" aria-label="Settings sections" className="tabs">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={cx('tab', tab === t.id && 'on')}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const n = TABS[(i + step + TABS.length) % TABS.length];
              setTab(n.id);
              document.getElementById(`tab-${n.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="stack tab-body">
        {tab === 'general' && (
          <>
            <Panel title="Appearance" eyebrow="Applies immediately">
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
              <Switch label="Reduce motion" description="Turns off avatar, scene and panel animation. The Windows reduced-motion setting is also respected." checked={settings.reduceMotion} onChange={(v) => void mutate(() => api.saveSettings({ reduceMotion: v }))} />
            </Panel>
            <Panel title="Startup" eyebrow="Needs Save">
              <Switch label="Start in the system tray" description="Open minimised to the tray instead of showing the window." checked={draft.startInTray} onChange={(v) => set('startInTray', v)} />
            </Panel>
            <Panel title="Voice" eyebrow="Needs Save">
              <Field label="Voice name" hint="Used by Windows speech. Leave empty for the default voice. Available voices depend on what is installed.">
                {(id, d) => <input id={id} aria-describedby={d} className="input" value={draft.voice} maxLength={120} onChange={(e) => set('voice', e.target.value)} />}
              </Field>
            </Panel>
          </>
        )}

        {tab === 'models' && (
          <>
            <Panel title="Mode" eyebrow="Needs Save">
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
            </Panel>

            <ModelReadinessNotice readiness={readiness} checking={check.checking} onRecheck={() => void check.recheck()} />
            {dirty && <p className="field-hint">This check uses your saved settings. Save your changes to check the new ones.</p>}

            <Panel title="Local model" eyebrow="Offline route">
              <p className="field-hint">Desktop Companion does not include a model. Offline chat needs Ollama running on this computer. Install it, start it, then install a model once with “ollama pull” followed by the model name.</p>
              <div className="grid2">
                <Field label="Endpoint" error={endpointError} hint="Must start with http:// and point at this computer (127.0.0.1, localhost or [::1]).">
                  {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localEndpoint} maxLength={200} spellCheck={false} onChange={(e) => set('localEndpoint', e.target.value)} />}
                </Field>
                <Field label="Model name" error={modelError} hint="The name Ollama knows the model by, for example llama3.2:3b.">
                  {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localModel} maxLength={120} spellCheck={false} onChange={(e) => set('localModel', e.target.value)} />}
                </Field>
              </div>
            </Panel>

            <Panel title="Cloud model" eyebrow="Online route">
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
                  Stored with Windows protection, never in this window’s storage and never shown again. Saving replaces any existing key. Online mode without a key cannot send.
                </p>
                <form
                  className="row wrap"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveKey();
                  }}
                >
                  <Field label="New key" error={keyError} className="grow">
                    {(id, d) => <input id={id} aria-describedby={d} className="input mono" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={400} onChange={(e) => { setKey(e.target.value); setKeyError(null); }} placeholder={isPreview ? 'Unavailable in browser preview' : 'Paste your key'} />}
                  </Field>
                  <div className="row align-end">
                    <Button type="submit" icon={FloppyDisk} busy={keyBusy} disabled={!key.trim()}>Save key</Button>
                    <Button variant="danger" icon={Trash} disabled={keyBusy || cloudConfigured !== true} onClick={() => setConfirmKeyDelete(true)}>Delete key</Button>
                  </div>
                </form>
              </div>
            </Panel>
          </>
        )}

        {tab === 'access' && (
          <>
            <Panel title="Allowed folders" eyebrow="Files · needs Save">
              <p className="field-hint">Folders Desktop Companion may work inside when asked. Anything outside is out of scope.</p>
              <PathListEditor kind="folder" items={draft.allowedRoots} onChange={(v) => set('allowedRoots', v)} />
            </Panel>
            <Panel title="Approved apps" eyebrow="Launching · needs Save">
              <p className="field-hint">Applications Desktop Companion may launch. Windows asks you to confirm each one you add. Each launch still shows a preview and waits for your approval on the Computer screen.</p>
              <PathListEditor kind="app" items={draft.approvedApps} onChange={(v) => set('approvedApps', v)} />
            </Panel>
          </>
        )}

        {tab === 'data' && (
          <>
            <Panel title="Retention" eyebrow="Needs Save">
              <Field label="Keep history for (days)" error={retainError} hint="How long this app keeps chat and activity history.">
                {(id, d) => <input id={id} aria-describedby={d} className="input narrow" inputMode="numeric" value={retain} onChange={(e) => { const v = e.target.value.replace(/[^\d]/g, '').slice(0, 4); setRetain(v); if (/^\d+$/.test(v)) set('retainDays', Number(v)); }} />}
              </Field>
              <div className="row">
                <Button variant="danger" icon={Trash} disabled={state.chat.length === 0} onClick={() => setConfirmClear(true)}>Clear conversation now ({state.chat.length})</Button>
              </div>
            </Panel>
            <Panel title="Backup" eyebrow="Export & import">
              <p className="field-hint">Export writes your data to a file you choose. Import loads a backup you choose and may replace your current capsules, notes, tasks and settings.</p>
              <div className="row">
                <Button icon={DownloadSimple} busy={exporting} onClick={() => void doExport()}>Export…</Button>
                <Button icon={UploadSimple} onClick={() => setConfirmImport(true)}>Import…</Button>
              </div>
              {exportNote && <p className="field-hint" role="status"><Export size={14} aria-hidden /> {exportNote}</p>}
              {isPreview && <p className="field-hint">Export and import are unavailable in browser preview.</p>}
            </Panel>
          </>
        )}
      </div>

      {dirty && (
        <div className="savebar" role="region" aria-label="Unsaved settings">
          <span>You have unsaved changes{invalid ? ' with errors' : ''}.</span>
          <Button icon={ArrowCounterClockwise} onClick={() => { setDraft(baseline); setRetain(String(baseline.retainDays)); }} disabled={saving}>Revert</Button>
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
