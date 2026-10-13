import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Cpu, Lock, WifiHigh, WifiSlash } from '@phosphor-icons/react';
import type { Mode, Settings } from '../shared/contracts';
import { Avatar } from './Avatar';
import { SceneBackdrop } from './SceneBackdrop';
import { PathListEditor, SystemBlock } from './shared';
import { Button, Field, Notice, Panel, Segmented, Switch } from '../ui/primitives';
import { useReady } from '../ui/store';
import { isLoopbackHost, parseHttpUrl } from '../ui/util';

const STEPS = ['Mode & look', 'Permissions', 'Hardware & model', 'Review'] as const;

export function Onboarding() {
  const { settings, mutate, api } = useReady();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const endpoint = parseHttpUrl(draft.localEndpoint);
  const endpointError = draft.localEndpoint.trim() === '' ? null : endpoint ? null : 'Enter an http:// or https:// address.';
  const remote = endpoint && !isLoopbackHost(endpoint.hostname);

  const go = (n: number) => {
    setStep(n);
    requestAnimationFrame(() => headRef.current?.focus());
  };

  const finish = async () => {
    setSaving(true);
    const ok = await mutate(() => api.saveSettings({ ...draft, onboarded: true }), 'Setup saved.');
    setSaving(false);
    return ok;
  };

  const canNext = step !== 2 || !endpointError;

  return (
    <div className="onboard">
      <SceneBackdrop scene="deep-space" className="onboard-scene" />
      <div className="onboard-shell">
        <aside className="onboard-side">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <i />
            </span>
            <div className="brand-text">
              <strong>JARVIS</strong>
              <span>First-run setup</span>
            </div>
          </div>
          <Avatar state="idle" size={132} />
          <ol className="steps" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="step-dot">{i < step ? <Check size={12} weight="bold" aria-hidden /> : i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <p className="field-hint">Nothing is granted by default. You can change every choice later in Settings.</p>
        </aside>

        <section className="onboard-main" aria-labelledby="ob-title">
          <p className="eyebrow">
            Step {step + 1} of {STEPS.length}
          </p>
          <h1 id="ob-title" ref={headRef} tabIndex={-1}>
            {step === 0 && 'Choose how Jarvis may think'}
            {step === 1 && 'Decide what it may touch'}
            {step === 2 && 'Check this machine'}
            {step === 3 && 'Review and finish'}
          </h1>

          {step === 0 && (
            <div className="stack">
              <Segmented<Mode>
                label="Mode"
                value={draft.mode}
                onChange={(v) => set('mode', v)}
                options={[
                  { value: 'offline', label: 'Offline (default)', icon: WifiSlash },
                  { value: 'online', label: 'Online (optional)', icon: WifiHigh },
                ]}
              />
              {draft.mode === 'offline' ? (
                <Notice title="Offline mode">Chat uses only a model endpoint on this computer. If that model is not running you will see an error, and nothing is sent to the cloud.</Notice>
              ) : (
                <Notice tone="warn" title="Online mode needs a key you provide">
                  Chat goes to the cloud model you name in Settings, using your own API key (saved protected by the backend, never shown again). There is no automatic switching between local and cloud, and no key is requested here.
                </Notice>
              )}
              <Field label="Theme">
                {() => (
                  <Segmented
                    label="Theme"
                    value={draft.theme}
                    onChange={(v) => {
                      set('theme', v);
                      document.documentElement.dataset.theme = v;
                    }}
                    options={[
                      { value: 'graphite', label: 'Graphite' },
                      { value: 'nebula', label: 'Nebula' },
                      { value: 'paper', label: 'Paper (light)' },
                    ]}
                  />
                )}
              </Field>
              <Switch
                label="Reduce motion"
                description="Turns off ambient animation. The system reduced-motion setting is always respected too."
                checked={draft.reduceMotion}
                onChange={(v) => {
                  set('reduceMotion', v);
                  document.documentElement.dataset.motion = v ? 'reduced' : 'full';
                }}
              />
            </div>
          )}

          {step === 1 && (
            <div className="stack">
              <Notice title="Two lists, both empty until you add to them">
                The backend decides whether each action is allowed and tells you why when it is blocked. Even allowed actions on the Computer screen show a preview and wait for your explicit approval.
              </Notice>
              <Panel title="Allowed folders" eyebrow="Files">
                <p className="field-hint">Folders Jarvis may be asked to work inside. Files outside them are out of scope.</p>
                <PathListEditor kind="folder" items={draft.allowedRoots} onChange={(v) => set('allowedRoots', v)} />
              </Panel>
              <Panel title="Approved apps" eyebrow="Launching">
                <p className="field-hint">Applications Jarvis may launch for you after you approve the action.</p>
                <PathListEditor kind="app" items={draft.approvedApps} onChange={(v) => set('approvedApps', v)} />
              </Panel>
              <Switch label="Start in the system tray" description="Open minimised to the tray when Windows starts this app." checked={draft.startInTray} onChange={(v) => set('startInTray', v)} />
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <Panel title="Detected by the backend" eyebrow="Hardware" actions={<Cpu size={18} aria-hidden />}>
                <SystemBlock />
              </Panel>
              <Panel title="Local model" eyebrow="Offline chat">
                <p className="field-hint">Jarvis does not bundle a model. Point it at a local server you run yourself. The app does not test the connection here; the first chat message will show if it is unreachable.</p>
                <div className="grid2">
                  <Field label="Endpoint" error={endpointError}>
                    {(id, d) => <input id={id} aria-describedby={d} className="input" value={draft.localEndpoint} maxLength={200} onChange={(e) => set('localEndpoint', e.target.value)} spellCheck={false} />}
                  </Field>
                  <Field label="Model name">
                    {(id) => <input id={id} className="input" value={draft.localModel} maxLength={120} placeholder="name your server exposes" onChange={(e) => set('localModel', e.target.value)} spellCheck={false} />}
                  </Field>
                </div>
                {remote && <Notice tone="warn" title="This endpoint is not on this computer">Prompts sent in offline mode would leave this machine. Use 127.0.0.1 or localhost to stay local.</Notice>}
              </Panel>
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <Panel title="Your choices" eyebrow="Summary">
                <dl className="kv-list">
                  <div className="kv"><dt>Mode</dt><dd>{draft.mode === 'offline' ? 'Offline (local model only)' : 'Online (cloud with your own key)'}</dd></div>
                  <div className="kv"><dt>Theme</dt><dd>{draft.theme}{draft.reduceMotion ? ', reduced motion' : ''}</dd></div>
                  <div className="kv"><dt>Allowed folders</dt><dd>{draft.allowedRoots.length ? draft.allowedRoots.join(', ') : 'none'}</dd></div>
                  <div className="kv"><dt>Approved apps</dt><dd>{draft.approvedApps.length ? draft.approvedApps.join(', ') : 'none'}</dd></div>
                  <div className="kv"><dt>Local model</dt><dd>{draft.localModel || 'not set'} at {draft.localEndpoint || 'no endpoint'}</dd></div>
                </dl>
              </Panel>
              <Notice title="What happens next">
                Settings are saved by the backend. Skipping the model or permissions is fine; features that need them will tell you what is missing.
              </Notice>
            </div>
          )}

          <footer className="onboard-foot">
            <Button icon={ArrowLeft} onClick={() => go(step - 1)} disabled={step === 0 || saving}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" icon={ArrowRight} onClick={() => go(step + 1)} disabled={!canNext}>
                Next
              </Button>
            ) : (
              <Button variant="primary" icon={Lock} busy={saving} onClick={() => void finish()}>
                Finish setup
              </Button>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
