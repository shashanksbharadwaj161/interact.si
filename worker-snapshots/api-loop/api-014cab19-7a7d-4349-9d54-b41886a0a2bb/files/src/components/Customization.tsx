import { DownloadSimple } from '@phosphor-icons/react';
import type { SystemInfo } from '../shared/contracts';
import {
  CATALOG,
  CUSTOMIZATION_SCOPES,
  DEFAULT_PRESET_ID,
  EFFECTS,
  LISTING_RULES,
  PRESETS,
  applyPreset,
  checkCompatibility,
  exportPrefs,
  normalizePrefs,
  previewPrefs,
  projectLink,
  setEffect,
  type Compatibility,
  type CustomizationPrefs,
  type ModProfile,
  type ModTouch,
} from '../ui/mod-catalog';
import { usePref } from '../ui/prefs';
import { useState } from 'react';
import {
  TASKBAR_PRESETS,
  TASKBAR_SETTINGS,
  TASKBAR_SNAPSHOT_PREF_KEY,
  buildPlan,
  captureSnapshot,
  normalizeManualValues,
  serializePlan,
  type TaskbarPlan,
} from '../ui/taskbar-presets';
import { Badge, Button, Field, KV, Notice, PageHeader, Panel, Segmented, Switch } from '../ui/primitives';

type Props = { system?: Pick<SystemInfo, 'platform' | 'arch'> | null };

const COMPAT_LABEL: Record<Compatibility, string> = { compatible: 'Compatible', incompatible: 'Not compatible', unknown: 'Needs check' };
const COMPAT_TONE: Record<Compatibility, 'ok' | 'danger' | 'warn'> = { compatible: 'ok', incompatible: 'danger', unknown: 'warn' };
const TOUCH_LABEL: Record<ModTouch, string> = { taskbar: 'Taskbar', start: 'Start menu', explorer: 'File Explorer', notifications: 'Notifications' };
const PREVIEW_TONE: Record<'off' | 'unsupported' | 'preview', 'muted' | 'info'> = { off: 'muted', unsupported: 'muted', preview: 'info' };
const PREVIEW_LABEL: Record<'off' | 'unsupported' | 'preview', string> = { off: 'Off', unsupported: 'Not built', preview: 'Preview' };
const EXPERIMENTAL_NOTE = 'Not built. Needs a feasibility and licence review (gate G5) before any work.';

function downloadText(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'customization-preferences.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function TaskbarPresetsPanel() {
  const [storedSnapshot, setStoredSnapshot] = usePref<unknown>(TASKBAR_SNAPSHOT_PREF_KEY, null);
  const manual = normalizeManualValues(storedSnapshot);
  const [presetId, setPresetId] = useState<string>(TASKBAR_PRESETS[0].id);
  const [plan, setPlan] = useState<TaskbarPlan | null>(null);
  const [planText, setPlanText] = useState('');
  const [status, setStatus] = useState('');

  const preview = () => {
    try {
      const snap = captureSnapshot(manual, Date.now());
      const next = buildPlan(snap, presetId, Date.now());
      setPlan(next);
      setPlanText(serializePlan(next));
      setStatus(next.applySteps.length ? `${next.applySteps.length} change(s) planned. Nothing was applied.` : 'Your values already match this preset. Nothing to change.');
    } catch (e) {
      setPlan(null);
      setPlanText('');
      setStatus(e instanceof Error ? e.message : 'Could not build the plan.');
    }
  };

  const copy = async () => {
    if (!planText) return;
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard) throw new Error('Clipboard not available');
      await navigator.clipboard.writeText(planText);
      setStatus('Plan JSON copied.');
    } catch {
      setStatus('Copy failed. Select the plan text and copy it yourself.');
    }
  };

  return (
    <Panel title="Taskbar and Start presets (preview only)" eyebrow="Roadmap 73 · Gate G5 unverified">
      <Notice tone="warn" title="Applying is not available">
        Applying is not available in this build pending licence/safety gate G5. This panel only previews a plan and its exact undo steps. It changes no Windows setting.
      </Notice>
      <Field label="Taskbar preset" hint={TASKBAR_PRESETS.find((p) => p.id === presetId)?.note}>
        {(id, describedBy) => (
          <select
            id={id}
            className="input"
            value={presetId}
            aria-describedby={describedBy}
            onChange={(e) => {
              setPresetId(e.target.value);
              setPlan(null);
              setPlanText('');
            }}
          >
            {TASKBAR_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <fieldset>
        <legend>Enter your current values manually — this build does not read the registry</legend>
        {TASKBAR_SETTINGS.map((s) => (
          <Field key={s.key} label={`${s.label} (${s.key})`} hint={s.description}>
            {(id, describedBy) => (
              <select
                id={id}
                className="input"
                value={manual[s.key]}
                aria-describedby={describedBy}
                onChange={(e) => {
                  setStoredSnapshot({ ...manual, [s.key]: Number(e.target.value) });
                  setPlan(null);
                  setPlanText('');
                }}
              >
                {s.allowed.map((v) => (
                  <option key={v} value={v}>
                    {v} — {s.valueLabels[v]}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
      </fieldset>
      <div className="row">
        <Button onClick={preview}>Preview plan</Button>
        <Button onClick={() => void copy()} disabled={!planText}>
          Copy plan JSON
        </Button>
      </div>
      <p className="field-hint" role="status">
        {status}
      </p>
      {plan && (
        <>
          <p className="field-hint">Apply steps</p>
          <ol aria-label="Apply steps">
            {plan.applySteps.map((s) => (
              <li key={`a-${s.key}`}>{s.label}</li>
            ))}
          </ol>
          <p className="field-hint">Undo steps</p>
          <ol aria-label="Undo steps">
            {plan.undoSteps.map((s) => (
              <li key={`u-${s.key}`}>{s.label}</li>
            ))}
          </ol>
          <p className="field-hint">
            {plan.explorerRestartRequired ? 'File Explorer would need to restart for some steps.' : 'No File Explorer restart expected.'} Requires confirmation. Not applied.
          </p>
        </>
      )}
    </Panel>
  );
}

export function Customization({ system }: Props) {
  const [stored, setStored] = usePref<CustomizationPrefs>('customization', applyPreset(DEFAULT_PRESET_ID));
  const prefs = normalizePrefs(stored);
  const preset = PRESETS.find((p) => p.id === prefs.presetId) ?? PRESETS[0];
  const preview = previewPrefs(prefs);
  const exported = exportPrefs(prefs);

  const env = system ? { platform: system.platform, arch: system.arch, windowsBuild: null } : null;
  const experimental = CUSTOMIZATION_SCOPES.filter((s) => s.tier === 'Experimental');

  return (
    <div className="page">
      <PageHeader
        eyebrow="Windows customization"
        title="Customization"
        subtitle="Optional external tools and preference previews. This screen installs nothing, injects nothing and changes no Windows setting."
      />

      <Notice title="What this screen does">
        Profiles describe tools you may install yourself. Presets and exports are saved only inside this app. Anything not built is shown as off with its reason. Licences and tool versions are not verified until someone checks them.
      </Notice>

      <Panel title="Your system" eyebrow="Compatibility inputs">
        <dl className="kv-list">
          <KV k="Platform">{system ? system.platform : 'Not loaded yet'}</KV>
          <KV k="CPU architecture">{system ? system.arch || 'Not reported' : 'Not loaded yet'}</KV>
          <KV k="Windows build">Not reported by this app</KV>
        </dl>
      </Panel>

      <Panel title="Curated catalog" eyebrow="Roadmap 71–72 · First">
        <ul className="lab-list">
          {CATALOG.map((p: ModProfile) => {
            const c = checkCompatibility(p, env);
            const link = projectLink(p);
            return (
              <li key={p.id}>
                <span className="lab-name">
                  {p.name}
                  <span className="sub">{p.purpose}</span>
                  <span className="sub">Touches: {p.touches.map((t) => TOUCH_LABEL[t]).join(', ')}. Reversal: {p.reversal}</span>
                  {c.reasons.map((r) => (
                    <span key={r} className="sub">
                      {r}
                    </span>
                  ))}
                  <span className="sub">{link ? `Project page: ${link}` : 'No project link. The licence has not been verified.'}</span>
                </span>
                <span className="lab-badges">
                  <Badge tone={COMPAT_TONE[c.status]} title={c.reasons.join(' ')}>
                    {COMPAT_LABEL[c.status]}
                  </Badge>
                  <Badge>{p.risk === 'low' ? 'Low risk' : p.risk === 'medium' ? 'Medium risk' : 'High risk'}</Badge>
                  <Badge tone="warn">Licence unverified</Badge>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="field-hint">Listing rules. A profile gets a project link only when every rule is met:</p>
        <ul>
          {LISTING_RULES.map((r) => (
            <li key={r} className="field-hint">
              {r}
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Taskbar, Start and Explorer presets" eyebrow="Roadmap 73–74 · Expansion">
        <Notice tone="warn" title="Preview only">
          Turning an effect on saves a preference. It does not change Windows. Effects that are not built stay off.
        </Notice>
        <Segmented<string>
          label="Preset"
          value={prefs.presetId}
          onChange={(id) => setStored(applyPreset(id))}
          options={PRESETS.map((p) => ({ value: p.id, label: p.name }))}
        />
        <p className="field-hint">{preset.blurb}</p>
        {EFFECTS.map((e) => (
          <Switch
            key={e.id}
            label={e.label}
            description={e.supported ? undefined : e.reason}
            checked={prefs.effects[e.id] === true}
            disabled={!e.supported}
            onChange={(on) => setStored(setEffect(prefs, e.id, on))}
          />
        ))}
        <p className="field-hint" role="status">
          {preview.headline}
        </p>
        <ul className="lab-list" aria-label="Preview of the selected preset">
          {preview.lines.map((l) => (
            <li key={l.id}>
              <span className="lab-name">
                {l.label}
                <span className="sub">
                  {TOUCH_LABEL[l.touches]}. {l.text}
                </span>
              </span>
              <span className="lab-badges">
                <Badge tone={PREVIEW_TONE[l.state]}>{PREVIEW_LABEL[l.state]}</Badge>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <TaskbarPresetsPanel />

      <Panel title="Save and export" eyebrow="Roadmap 75 · Expansion">
        <p className="field-hint">Preferences are kept in this app’s UI storage. Export writes them to a file you choose to save. The export never claims a Windows change.</p>
        <Field label="Export preview" hint="Validated JSON. Effects that are not built are always false.">
          {(id, describedBy) => <textarea id={id} className="input" readOnly rows={10} value={exported} aria-describedby={describedBy} spellCheck={false} />}
        </Field>
        <div className="row">
          <Button icon={DownloadSimple} onClick={() => downloadText(exported)}>
            Download JSON
          </Button>
          <Button disabled title="Not built. Restoring needs a validated file picker (roadmap 75).">
            Restore preferences
          </Button>
        </div>
        <p className="field-hint">Restore is not built yet. Importing a file would need the same validation as the export.</p>
      </Panel>

      <Panel title="Experimental scopes" eyebrow="Roadmap 76–80 · Experimental">
        <ul className="lab-list">
          {experimental.map((s) => (
            <li key={s.id}>
              <span className="lab-id">{s.id}</span>
              <span className="lab-name">
                {s.name}
                <span className="sub">{EXPERIMENTAL_NOTE}</span>
              </span>
              <span className="lab-badges">
                <Badge tone="warn">Experimental</Badge>
                <Badge>Not built</Badge>
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
