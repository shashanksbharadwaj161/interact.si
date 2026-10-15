import { useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, Cpu, Key, Lock, WifiHigh, WifiSlash } from '@phosphor-icons/react';
import type { Capability, Mode, Settings } from '../shared/contracts';
import { Avatar } from './Avatar';
import { SceneBackdrop } from './SceneBackdrop';
import { PathListEditor, SystemBlock } from './shared';
import { Badge, Button, Field, Notice, Panel, Segmented, Switch } from '../ui/primitives';
import { useReady, useStore } from '../ui/store';
import { errMsg, isLoopbackHost } from '../ui/util';

const STEPS = ['Mode & look', 'Permissions', 'Hardware & model', 'Review'] as const;

/* ---------- Shared rules and model readiness (also used by Settings and Home) ---------- */

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Mirrors the backend's validateLocalEndpoint exactly: http only, loopback host only, no credentials,
 * not empty, at most 200 characters. Returns a plain-language problem, or null when the backend accepts it.
 */
export function localEndpointError(value: string): string | null {
  const s = value.trim();
  if (!s) return 'Enter the address of the model server, for example http://127.0.0.1:11434.';
  if (s.length > 200) return 'That address is too long.';
  if (CONTROL_CHARS.test(s)) return 'The address contains characters that are not allowed.';
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return 'That is not a valid address. Use the form http://127.0.0.1:11434.';
  }
  if (u.protocol !== 'http:') return 'Start the address with http://. The model server must run on this computer, so https:// is not accepted.';
  if (!isLoopbackHost(u.hostname)) return 'Only this computer is allowed here. Use 127.0.0.1, localhost or [::1].';
  if (u.username || u.password) return 'Remove the user name and password from the address.';
  return null;
}

export function localModelError(value: string): string | null {
  const s = value.trim();
  if (!s) return 'Enter the model name, for example llama3.2:3b.';
  if (s.length > 200) return 'That name is too long.';
  if (CONTROL_CHARS.test(s)) return 'The name contains characters that are not allowed.';
  return null;
}

/** Mirrors the backend rule for cloudModel (required, up to 100 characters, letters, digits and . _ : -). */
export function cloudModelError(value: string): string | null {
  const s = value.trim();
  if (!s) return 'Enter the cloud model name.';
  if (s.length > 100) return 'That name is too long.';
  if (!/^[A-Za-z0-9._:-]+$/.test(s)) return 'Use only letters, digits and . _ : - in the model name.';
  return null;
}

export type ModelReadiness = {
  route: 'local' | 'cloud';
  /** ready: confirmed or configured; blocked: known not to work; unknown: not checked yet. */
  level: 'ready' | 'blocked' | 'unknown';
  title: string;
  detail: string;
};

type ReadinessInput = {
  settings: Pick<Settings, 'mode' | 'localEndpoint' | 'localModel' | 'cloudModel'>;
  /** From getSystemInfo; null until the first answer arrives. */
  capabilities: Capability[] | null;
  systemError?: string | null;
  cloudConfigured: boolean | null;
};

const OLLAMA_HINT = 'Offline chat needs Ollama running on this computer. Install it, start it, then install the model with “ollama pull” followed by the model name.';

/**
 * What the assistant can actually do right now. Offline readiness comes from the backend's live Ollama check
 * (capability "local-llm"), never from whether the settings fields are filled in. Online readiness is whether
 * a model name and a saved key exist; the cloud provider itself is only reached when a message is sent.
 */
export function modelReadiness(input: ReadinessInput): ModelReadiness {
  const { settings, capabilities, systemError, cloudConfigured } = input;
  if (settings.mode === 'online') {
    if (!settings.cloudModel.trim()) return { route: 'cloud', level: 'blocked', title: 'Online mode has no model name', detail: 'Enter a cloud model name in Settings before using chat in online mode.' };
    if (cloudConfigured === false) {
      return { route: 'cloud', level: 'blocked', title: 'Online mode has no API key', detail: 'Chat shows an error and sends nothing until you save a key. It does not switch to the local model.' };
    }
    if (cloudConfigured === null) return { route: 'cloud', level: 'unknown', title: 'Key status unknown', detail: 'The saved-key check did not answer. Check again, or open Settings.' };
    return { route: 'cloud', level: 'ready', title: 'Online mode is set up', detail: `Messages go to the cloud model “${settings.cloudModel}” with your saved key. Whether the provider is reachable is only known when a message is sent.` };
  }
  if (localEndpointError(settings.localEndpoint) || localModelError(settings.localModel)) {
    return { route: 'local', level: 'blocked', title: 'The local model settings are incomplete', detail: 'Fix the endpoint and model name in Settings.' };
  }
  if (systemError) return { route: 'local', level: 'unknown', title: 'The local model could not be checked', detail: systemError };
  const cap = capabilities?.find((c) => c.id === 'local-llm');
  if (!cap) return { route: 'local', level: 'unknown', title: 'Local model not checked yet', detail: 'Waiting for the check to finish.' };
  if (cap.available) return { route: 'local', level: 'ready', title: 'Local model is ready', detail: `Ollama is running and “${settings.localModel}” is installed. Replies are generated on this computer.` };
  const reason = cap.reason ?? 'Ollama did not respond.';
  return { route: 'local', level: 'blocked', title: 'Local model is not available', detail: /ollama pull/i.test(reason) ? reason : `${reason}. ${OLLAMA_HINT}` };
}

/** The backend reports safe launch only through the desktop-control capability. Returns its reason, or null. */
export function safeLaunchReason(capabilities: Capability[] | null | undefined): string | null {
  const cap = capabilities?.find((c) => c.id === 'ui-automation');
  return cap && !cap.available && /safe launch/i.test(cap.reason ?? '') ? (cap.reason as string) : null;
}

/** Re-runs the model check. The backend reuses a probe result for up to 30 seconds unless settings or the key change. */
export function useModelCheck() {
  const { refreshSystem, refreshCloud, systemLoading } = useStore();
  return { checking: systemLoading, recheck: () => Promise.all([refreshSystem(), refreshCloud()]).then(() => undefined) };
}

export function ModelReadinessNotice({ readiness, checking, onRecheck, action }: { readiness: ModelReadiness; checking?: boolean; onRecheck?: () => void; action?: ReactNode }) {
  return (
    <Notice
      tone={readiness.level === 'ready' ? 'info' : 'warn'}
      title={readiness.title}
      action={
        onRecheck || action ? (
          <div className="row">
            {action}
            {onRecheck && (
              <Button size="sm" busy={checking} onClick={onRecheck}>
                Check again
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {readiness.detail}
    </Notice>
  );
}

/* ---------- First-run setup ---------- */

export function Onboarding() {
  const { settings, mutate, api, system, systemError, cloudConfigured, refreshCloud, refreshSystem, isPreview } = useReady();
  const check = useModelCheck();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);
  const [finishFailed, setFinishFailed] = useState(false);
  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const endpointError = localEndpointError(draft.localEndpoint);
  const modelError = localModelError(draft.localModel);
  const cloudError = draft.mode === 'online' ? cloudModelError(draft.cloudModel) : null;
  const online = draft.mode === 'online';

  // The backend probes the saved settings, so the result only describes the draft while the two agree.
  const draftMatchesSaved = draft.mode === settings.mode && draft.localEndpoint.trim() === settings.localEndpoint && draft.localModel.trim() === settings.localModel;
  const readiness = modelReadiness({ settings: draft, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });

  const go = (n: number) => {
    setStep(n);
    requestAnimationFrame(() => headRef.current?.focus());
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
    } catch (e) {
      setKeyError(errMsg(e, 'The key could not be saved.'));
    } finally {
      setKeyBusy(false);
    }
  };

  const finish = async () => {
    if (endpointError || modelError || cloudError) {
      go(2);
      return;
    }
    setSaving(true);
    setFinishFailed(false);
    const ok = await mutate(
      () => api.saveSettings({ ...draft, localEndpoint: draft.localEndpoint.trim(), localModel: draft.localModel.trim(), cloudModel: draft.cloudModel.trim(), onboarded: true }),
      'Setup saved.',
    );
    setSaving(false);
    if (ok) {
      void refreshSystem();
      void refreshCloud();
    } else setFinishFailed(true);
  };

  // Saves only the local endpoint and model (not "onboarded"), so the live check can run against the draft
  // before setup finishes. Windows may ask to confirm a changed model address, as it does in Settings.
  const [checkingDraft, setCheckingDraft] = useState(false);
  const saveAndCheck = async () => {
    if (endpointError || modelError) return;
    setCheckingDraft(true);
    const ok = await mutate(() => api.saveSettings({ localEndpoint: draft.localEndpoint.trim(), localModel: draft.localModel.trim() }));
    if (ok) await check.recheck();
    setCheckingDraft(false);
  };

  const canNext = step !== 2 || !(endpointError || modelError || cloudError);

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
              <strong>Desktop Companion</strong>
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
          <p className="field-hint">Nothing is allowed by default. You can change every choice later in Settings.</p>
        </aside>

        <section className="onboard-main" aria-labelledby="ob-title">
          <p className="eyebrow">
            Step {step + 1} of {STEPS.length}
          </p>
          <h1 id="ob-title" ref={headRef} tabIndex={-1}>
            {step === 0 && 'Choose where answers come from'}
            {step === 1 && 'Decide what it may touch'}
            {step === 2 && 'Check this machine and set up the model'}
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
                <Notice title="Offline mode">
                  Chat uses a model that runs on this computer (Ollama). Nothing is sent to the cloud. If the model is not running, chat shows an error instead of answering. The next steps show whether it is ready.
                </Notice>
              ) : (
                <Notice tone="warn" title="Online mode sends your messages to a cloud provider">
                  You choose the cloud model and provide your own API key on the “Hardware &amp; model” step. If no key is saved, chat shows an error and sends nothing. It does not switch to the local model.
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
                description="Turns off ambient animation. The Windows reduced-motion setting is always respected too."
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
                Windows asks you to confirm each folder or app you add. Even allowed actions on the Computer screen show a preview and wait for your approval, and a blocked action tells you why.
              </Notice>
              <Panel title="Allowed folders" eyebrow="Files">
                <p className="field-hint">Folders Desktop Companion may be asked to work inside. Files outside them are out of scope.</p>
                <PathListEditor kind="folder" items={draft.allowedRoots} onChange={(v) => set('allowedRoots', v)} />
              </Panel>
              <Panel title="Approved apps" eyebrow="Launching">
                <p className="field-hint">Applications Desktop Companion may launch for you after you approve the action.</p>
                <PathListEditor kind="app" items={draft.approvedApps} onChange={(v) => set('approvedApps', v)} />
              </Panel>
              <Switch label="Start in the system tray" description="Open minimised to the tray when Windows starts this app." checked={draft.startInTray} onChange={(v) => set('startInTray', v)} />
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <Panel title="Detected on this computer" eyebrow="Hardware" actions={<Cpu size={18} aria-hidden />}>
                <SystemBlock />
              </Panel>
              <Panel title="Local model" eyebrow={online ? 'Offline route (not used in online mode)' : 'Offline chat'}>
                <p className="field-hint">
                  Desktop Companion does not include a model. Offline chat needs Ollama running on this computer (it only accepts addresses on this computer). Install Ollama, start it, then install a model once with “ollama pull” followed by the model name.
                </p>
                <div className="grid2">
                  <Field label="Endpoint" error={endpointError} hint="Usually http://127.0.0.1:11434">
                    {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localEndpoint} maxLength={200} onChange={(e) => set('localEndpoint', e.target.value)} spellCheck={false} />}
                  </Field>
                  <Field label="Model name" error={modelError} hint="For example llama3.2:3b">
                    {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localModel} maxLength={200} onChange={(e) => set('localModel', e.target.value)} spellCheck={false} />}
                  </Field>
                </div>
                {!online &&
                  (draftMatchesSaved ? (
                    <ModelReadinessNotice readiness={readiness} checking={check.checking} onRecheck={() => void check.recheck()} />
                  ) : (
                    <Notice
                      title="Not checked yet"
                      action={
                        <Button size="sm" busy={checkingDraft} disabled={Boolean(endpointError || modelError)} onClick={() => void saveAndCheck()}>
                          Save and check now
                        </Button>
                      }
                    >
                      The check uses saved settings. Save the endpoint and model now to see whether Ollama answers, or finish setup and the result then shows on Home.
                    </Notice>
                  ))}
              </Panel>
              {online && (
                <Panel title="Cloud model" eyebrow="Online route">
                  <Field label="Model name" error={cloudError} hint="The cloud provider's name for the model.">
                    {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.cloudModel} maxLength={100} spellCheck={false} onChange={(e) => set('cloudModel', e.target.value)} />}
                  </Field>
                  <div className="key-box">
                    <div className="key-head">
                      <Key size={18} aria-hidden />
                      <strong>API key</strong>
                      {cloudConfigured === null ? <Badge>Status unknown</Badge> : cloudConfigured ? <Badge tone="ok">Saved</Badge> : <Badge tone="warn">Not saved</Badge>}
                    </div>
                    <p className="field-hint">Saved with Windows protection and never shown again. Saving a new key replaces the old one. You can skip this and add it later in Settings; until then chat shows an error.</p>
                    <form
                      className="row wrap"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveKey();
                      }}
                    >
                      <Field label="API key" error={keyError} className="grow">
                        {(id, d) => <input id={id} aria-describedby={d} className="input mono" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={400} onChange={(e) => { setKey(e.target.value); setKeyError(null); }} placeholder={isPreview ? 'Unavailable in browser preview' : 'Paste your key'} />}
                      </Field>
                      <div className="row align-end">
                        <Button type="submit" busy={keyBusy} disabled={!key.trim()}>
                          Save key
                        </Button>
                      </div>
                    </form>
                  </div>
                </Panel>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <Panel title="Your choices" eyebrow="Summary">
                <dl className="kv-list">
                  <div className="kv"><dt>Mode</dt><dd>{online ? 'Online (cloud model with your own key)' : 'Offline (model on this computer only)'}</dd></div>
                  <div className="kv"><dt>Theme</dt><dd>{draft.theme}{draft.reduceMotion ? ', reduced motion' : ''}</dd></div>
                  <div className="kv"><dt>Allowed folders</dt><dd>{draft.allowedRoots.length ? draft.allowedRoots.join(', ') : 'none'}</dd></div>
                  <div className="kv"><dt>Approved apps</dt><dd>{draft.approvedApps.length ? draft.approvedApps.join(', ') : 'none'}</dd></div>
                  <div className="kv"><dt>{online ? 'Cloud model' : 'Local model'}</dt><dd>{online ? draft.cloudModel : `${draft.localModel} at ${draft.localEndpoint}`}</dd></div>
                  <div className="kv">
                    <dt>Ready to answer</dt>
                    <dd>
                      {online || draftMatchesSaved ? (
                        <>
                          <Badge tone={readiness.level === 'ready' ? 'ok' : readiness.level === 'blocked' ? 'warn' : 'muted'}>{readiness.level === 'ready' ? 'Yes' : readiness.level === 'blocked' ? 'Not yet' : 'Not checked'}</Badge> {readiness.title}
                        </>
                      ) : (
                        <>
                          <Badge>Not checked</Badge> The new endpoint and model are checked after you finish.
                        </>
                      )}
                    </dd>
                  </div>
                </dl>
              </Panel>
              {online && cloudConfigured !== true && (
                <Notice tone="warn" title="No API key is saved yet">
                  You can finish now. Chat shows an error and sends nothing until you add a key in Settings, under Mode &amp; models. It does not use the local model.
                </Notice>
              )}
              {finishFailed && (
                <Notice tone="danger" title="Setup was not saved" action={<Button size="sm" onClick={() => go(2)}>Review model settings</Button>}>
                  Windows asks you to confirm new folders, apps, online mode and a changed model address, and nothing is saved if you decline. A setting may also have been rejected; the message above names it. Try again when ready.
                </Notice>
              )}
              <Notice title="What happens next">
                Windows asks you to confirm any folders or apps you added, switching to online mode, or a changed model address. You can skip the model or permissions; features that need them will say what is missing.
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
