import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowLeft, Check, Copy, Cpu, Key, PaperPlaneRight, WarningCircle } from '@phosphor-icons/react';
import { CLOUD_PROVIDERS, cloudProviderInfo, effectiveCloudModel, isCloudProvider, type CloudProvider, type CloudProviderStatus } from '../shared/contracts';
import { cloudProvidersBridge } from '../ui/bridges';
import { Badge, Button, Field, Notice } from '../ui/primitives';
import { useReady } from '../ui/store';
import { cx, errMsg, truncate } from '../ui/util';
import { cloudModelError, localEndpointError, localModelError, modelReadiness, useModelCheck } from './Onboarding';
import '../styles/ai-setup.css';

/**
 * Connect AI, used by first-run setup and by the Assistant when chat cannot answer. Two routes:
 * a model on this computer (Ollama, checked live) or the user's own key for a cloud provider (saved in the protected
 * per-provider store, never shown again). Nothing is sent to a model until the user presses "Send a test message",
 * and that button says what it sends and that a cloud test may use tokens. AI is never called "ready" because a field
 * was filled in: readiness comes from the live check or the saved key, and the optional test reports what really happened.
 */
export type AiSetupResult = 'local' | 'cloud';
type Route = 'choose' | 'local' | 'cloud';

export const TEST_PROMPT = 'Reply with one short sentence so I know you are connected.';

/** A single real message, sent only on an explicit click. The reply or the failure note is stored in the conversation. */
function TestMessage({ route }: { route: 'local' | 'cloud' }) {
  const { api, reload, settings } = useReady();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const provider = cloudProviderInfo(settings.cloudProvider);
  const send = async () => {
    setBusy(true);
    setResult(null);
    try {
      const reply = await api.chat(TEST_PROMPT);
      setResult(reply.source === 'system' ? { ok: false, text: reply.text } : { ok: true, text: reply.text });
    } catch (e) {
      setResult({ ok: false, text: errMsg(e, 'The test message could not be sent.') });
    } finally {
      setBusy(false);
      await reload().catch(() => undefined);
    }
  };
  return (
    <div className="ai-test">
      <p className="field-hint">
        {route === 'cloud'
          ? `Optional. Sends one short message to ${provider.name} (${provider.host}) with your key. It may use a few tokens from your account. The message and reply are kept in your Assistant conversation.`
          : 'Optional. Sends one short message to the model on this computer. Nothing leaves this computer. The message and reply are kept in your Assistant conversation.'}
      </p>
      <div className="row wrap">
        <Button icon={PaperPlaneRight} busy={busy} onClick={() => void send()}>
          Send a test message
        </Button>
        {busy && <span className="sub">Waiting for the reply…</span>}
      </div>
      {result && (
        <Notice tone={result.ok ? 'info' : 'danger'} title={result.ok ? 'The model answered' : 'The test did not get an answer'}>
          {truncate(result.text, 400)}
        </Notice>
      )}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-line">
      <code>{text}</code>
      <button
        type="button"
        className="iconbtn"
        aria-label={copied ? 'Copied' : `Copy ${text}`}
        title="Copy"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
      </button>
    </span>
  );
}

function LocalRoute({ onDone, onSkip }: { onDone: (r: AiSetupResult) => void; onSkip?: () => void }) {
  const { settings, mutate, api, system, systemError, cloudConfigured, isPreview } = useReady();
  const check = useModelCheck();
  const [draft, setDraft] = useState({ localEndpoint: settings.localEndpoint || 'http://127.0.0.1:11434', localModel: settings.localModel || 'llama3.2:3b' });
  const [checkingDraft, setCheckingDraft] = useState(false);
  const [checked, setChecked] = useState(false);
  const [using, setUsing] = useState(false);
  const endpointError = localEndpointError(draft.localEndpoint);
  const modelError = localModelError(draft.localModel);
  const draftMatchesSaved = draft.localEndpoint.trim() === settings.localEndpoint && draft.localModel.trim() === settings.localModel;
  const readiness = modelReadiness({ settings: { ...settings, mode: 'offline' }, capabilities: system?.capabilities ?? null, systemError, cloudConfigured });

  // Saves only the endpoint and model (never "onboarded"), so the live check runs against what the user typed.
  // Windows may ask to confirm a changed model address.
  const saveAndCheck = async () => {
    if (endpointError || modelError) return;
    setCheckingDraft(true);
    const ok = await mutate(() => api.saveSettings({ localEndpoint: draft.localEndpoint.trim(), localModel: draft.localModel.trim() }));
    if (ok) await check.recheck();
    setCheckingDraft(false);
    setChecked(true);
  };
  const useLocal = async () => {
    setUsing(true);
    const ok = settings.mode === 'offline' ? true : await mutate(() => api.saveSettings({ mode: 'offline' }), 'Using the model on this computer.');
    setUsing(false);
    if (ok) onDone('local');
  };
  const ready = draftMatchesSaved && readiness.level === 'ready';
  const blocked = draftMatchesSaved && (checked || readiness.level === 'blocked') && readiness.level !== 'ready';

  return (
    <div className="stack">
      <p className="field-hint">
        Ollama is a free app that runs models on this computer. Desktop Companion does not include a model, so Ollama has to be installed and running. It only accepts an address on this computer.
      </p>
      <div className="grid2">
        <Field label="Address" error={endpointError} hint="Usually http://127.0.0.1:11434">
          {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localEndpoint} maxLength={200} spellCheck={false} onChange={(e) => setDraft({ ...draft, localEndpoint: e.target.value })} />}
        </Field>
        <Field label="Model name" error={modelError} hint="For example llama3.2:3b">
          {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={draft.localModel} maxLength={200} spellCheck={false} onChange={(e) => setDraft({ ...draft, localModel: e.target.value })} />}
        </Field>
      </div>
      <div className="row wrap">
        <Button variant={ready ? 'ghost' : 'primary'} icon={Cpu} busy={checkingDraft || (check.checking && !checkingDraft)} disabled={Boolean(endpointError || modelError) || isPreview} onClick={() => void saveAndCheck()}>
          Save and check now
        </Button>
        {isPreview && <span className="sub">Checking needs the desktop app; the browser preview cannot reach Ollama.</span>}
      </div>
      {draftMatchesSaved && (checked || readiness.level !== 'unknown') && (
        <div className={cx('ai-result', ready ? 'is-ok' : 'is-bad')} role="status">
          {ready ? <Check size={18} weight="bold" aria-hidden /> : <WarningCircle size={18} aria-hidden />}
          <div className="grow">
            <strong>{readiness.title}</strong>
            <p className="field-hint">{readiness.detail}</p>
          </div>
        </div>
      )}
      {blocked && (
        <div className="ai-recover">
          <strong>To fix it</strong>
          <ol>
            <li>Install Ollama from ollama.com and start it.</li>
            <li>
              Install the model once: <CopyLine text={`ollama pull ${draft.localModel.trim() || 'llama3.2:3b'}`} />
            </li>
            <li>Choose Save and check now again.</li>
          </ol>
          {onSkip && (
            <p className="field-hint">
              You can do this later. Notes, tasks and search work without AI.{' '}
              <button type="button" className="linkbtn" onClick={onSkip}>
                Continue without AI
              </button>
            </p>
          )}
        </div>
      )}
      {ready && (
        <>
          <TestMessage route="local" />
          <div className="row">
            <Button variant="primary" busy={using} onClick={() => void useLocal()}>
              Use this model
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function CloudRoute({ onDone }: { onDone: (r: AiSetupResult) => void }) {
  const { settings, mutate, api, refreshCloud, refreshSystem, isPreview } = useReady();
  const bridge = useMemo(() => cloudProvidersBridge(api), [api]);
  const [provider, setProvider] = useState<CloudProvider>(isCloudProvider(settings.cloudProvider) ? settings.cloudProvider : 'anthropic');
  const [status, setStatus] = useState<CloudProviderStatus[] | null>(null);
  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const groupId = useId();
  const info = cloudProviderInfo(provider);
  const hasKey = status?.find((s) => s.provider === provider)?.hasKey ?? null;
  const keyChannel = status?.find((s) => s.provider === provider)?.keyChannel;
  const model = advanced && customModel.trim() ? customModel.trim() : effectiveCloudModel(provider, settings.cloudProvider === provider ? settings.cloudModel : '');
  const modelError = advanced && customModel.trim() ? cloudModelError(customModel) : null;

  useEffect(() => {
    let live = true;
    bridge.status().then((s) => live && setStatus(s)).catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [bridge]);

  const saveKey = async () => {
    const k = key.trim();
    if (k.length < 8) return setKeyError('That does not look like a full API key.');
    if (k.length > 400) return setKeyError('That key is too long.');
    setKeyBusy(true);
    setKeyError(null);
    try {
      await bridge.setKey(provider, k);
      setKey('');
      setStatus(await bridge.status());
      await refreshCloud();
    } catch (e) {
      setKeyError(errMsg(e, 'The key could not be saved.'));
    } finally {
      setKeyBusy(false);
    }
  };

  // Windows asks the user to confirm switching to online mode; nothing is saved if they decline.
  const turnOn = async () => {
    if (modelError) return;
    setEnabling(true);
    const ok = await mutate(() => api.saveSettings({ mode: 'online', cloudProvider: provider, cloudModel: model }), `Online mode on with ${info.name}.`);
    setEnabling(false);
    if (ok) {
      setEnabled(true);
      void refreshSystem();
    }
  };

  return (
    <div className="stack">
      <div className="provider-list" role="radiogroup" aria-labelledby={groupId}>
        <span id={groupId} className="field-label">
          Provider
        </span>
        {CLOUD_PROVIDERS.map((p) => {
          const st = status?.find((s) => s.provider === p.id);
          return (
            <button key={p.id} type="button" role="radio" aria-checked={provider === p.id} className={cx('provider', provider === p.id && 'on')} disabled={enabled} onClick={() => setProvider(p.id)}>
              <span className="grow">
                <strong>{p.name}</strong>
                <span className="sub">{p.host}</span>
              </span>
              {st?.hasKey ? <Badge tone="ok">Key saved</Badge> : null}
            </button>
          );
        })}
      </div>

      <div className="key-box">
        <div className="row">
          <Key size={18} aria-hidden />
          <strong className="grow">Your {info.name} API key</strong>
          {hasKey === null ? <Badge>Not checked</Badge> : hasKey ? <Badge tone="ok">Saved</Badge> : <Badge tone="warn">Not saved</Badge>}
        </div>
        <p className="field-hint">Saved with Windows protection on this computer and never shown again. Saving a new key replaces the old one. It is used only when you send a message.</p>
        {keyChannel === 'unavailable' && <Notice tone="warn">{status?.find((s) => s.provider === provider)?.reason ?? 'Keys for this provider cannot be saved in this build.'}</Notice>}
        <form
          className="row wrap align-end"
          onSubmit={(e) => {
            e.preventDefault();
            void saveKey();
          }}
        >
          <Field label="API key" error={keyError} className="grow">
            {(id, d) => (
              <input
                id={id}
                aria-describedby={d}
                className="input mono"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                maxLength={400}
                disabled={isPreview}
                placeholder={isPreview ? 'Unavailable in the browser preview' : hasKey ? 'Paste a new key to replace the saved one' : 'Paste your key'}
                onChange={(e) => {
                  setKey(e.target.value);
                  setKeyError(null);
                }}
              />
            )}
          </Field>
          <Button type="submit" busy={keyBusy} disabled={!key.trim() || isPreview}>
            Save key
          </Button>
        </form>
      </div>

      <div className="stack tight">
        <p>
          Model: <strong className="mono">{model}</strong> <span className="sub">{advanced ? 'Custom name' : `${info.name}'s default in this app`}</span>
        </p>
        <details className="disclosure" open={advanced} onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Advanced: use a different model name</summary>
          <div className="disclosure-body">
            <Field label="Model name" error={modelError} hint={`The exact name ${info.name} uses for the model.`}>
              {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={customModel} maxLength={100} spellCheck={false} onChange={(e) => setCustomModel(e.target.value)} />}
            </Field>
          </div>
        </details>
      </div>

      {!enabled ? (
        <div className="stack tight">
          <div className="row wrap">
            <Button variant="primary" busy={enabling} disabled={hasKey !== true || Boolean(modelError)} onClick={() => void turnOn()}>
              Turn on online mode
            </Button>
            {hasKey !== true && <span className="sub">Save a key first.</span>}
          </div>
          <p className="field-hint">Windows asks you to confirm. Messages then go to {info.name} only when you press Send. If {info.name} fails, nothing switches to another provider.</p>
        </div>
      ) : (
        <>
          <TestMessage route="cloud" />
          <div className="row">
            <Button variant="primary" onClick={() => onDone('cloud')}>
              Open the Assistant
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function AiSetup({ onDone, onSkip, initialRoute = 'choose' }: { onDone: (r: AiSetupResult) => void; onSkip?: () => void; initialRoute?: Route }) {
  const [route, setRoute] = useState<Route>(initialRoute);
  if (route === 'choose') {
    return (
      <div className="stack">
        <div className="choice-list">
          <button type="button" className="choice" onClick={() => setRoute('local')}>
            <span className="choice-icon" aria-hidden="true">
              <Cpu size={22} />
            </span>
            <span className="grow">
              <strong>On this computer</strong>
              <span className="sub">Use Ollama. Free and private; needs a one-time model download in Ollama.</span>
            </span>
          </button>
          <button type="button" className="choice" onClick={() => setRoute('cloud')}>
            <span className="choice-icon" aria-hidden="true">
              <Key size={22} />
            </span>
            <span className="grow">
              <strong>With my own key</strong>
              <span className="sub">Anthropic, OpenAI or OpenRouter. Billed by the provider to your account.</span>
            </span>
          </button>
        </div>
        {onSkip && (
          <p className="field-hint">
            <button type="button" className="linkbtn" onClick={onSkip}>
              Not now
            </button>{' '}
            Notes, tasks and search work without AI.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="stack">
      <button type="button" className="linkbtn back-link" onClick={() => setRoute('choose')}>
        <ArrowLeft size={14} aria-hidden /> Choose another way
      </button>
      {route === 'local' ? <LocalRoute onDone={onDone} onSkip={onSkip} /> : <CloudRoute onDone={onDone} />}
    </div>
  );
}

