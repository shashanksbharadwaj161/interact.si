import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwise, Check, Key, Lightning, PaperPlaneRight, Plugs, Stop, WarningCircle } from '@phosphor-icons/react';
import { cloudProviderInfo, isCloudProvider, type CloudModelList, type CloudProvider, type CloudProviderStatus } from '../shared/contracts';
import { cloudProvidersBridge } from '../ui/bridges';
import { Badge, Button, Field, Notice } from '../ui/primitives';
import { useReady } from '../ui/store';
import { cx, errMsg, truncate } from '../ui/util';
import { cloudModelError } from './Onboarding';
import '../styles/ai-setup.css';

/**
 * Connect AI. Claude (Anthropic) is the primary path; OpenAI and OpenRouter remain available because the app already
 * supports them, and Gemini is listed honestly as not available in this version.
 *
 *   1 Key      the user's own API key, saved in the protected vault on this computer and never shown again
 *   2 Connect  online mode, which Windows asks the user to confirm; this is the consent for AI requests
 *   3 Model    chosen from the models the provider reports for that key (a custom id is under Advanced)
 *   4 Test     an explicit, streamed test message that can be stopped; it may use a few tokens
 *
 * Nothing is sent to a provider until the user acts, and readiness is never claimed because a field was filled in.
 * App files and settings stay on this computer; only messages the user sends go to the provider.
 */
export type AiSetupResult = 'cloud';

export const TEST_PROMPT = 'Reply with one short sentence so I know you are connected.';

type ProviderChoice = { id: CloudProvider | 'gemini'; name: string; note: string; available: boolean };
const OTHER_PROVIDERS: ProviderChoice[] = [
  { id: 'openai', name: 'OpenAI', note: 'GPT models through the OpenAI API. A ChatGPT Plus or Pro subscription is not an API key.', available: true },
  { id: 'openrouter', name: 'OpenRouter', note: 'Many vendors behind one OpenRouter key.', available: true },
  { id: 'gemini', name: 'Google Gemini', note: 'Not available in this version.', available: false },
];

type TestState = { phase: 'idle' | 'sending' | 'streaming' | 'done' | 'failed' | 'stopped'; text: string; reason?: string; streamId?: string };

/** One real streamed message, sent only on an explicit click, stoppable. The exchange is kept in the Assistant conversation. */
function TestMessage({ providerName, host }: { providerName: string; host: string }) {
  const { api, reload } = useReady();
  const [st, setSt] = useState<TestState>({ phase: 'idle', text: '' });
  const unsub = useRef<(() => void) | null>(null);
  useEffect(() => () => unsub.current?.(), []);
  const canStream = typeof api.chatStreamStart === 'function' && typeof api.onChatStream === 'function' && typeof api.chatStreamCancel === 'function';

  const send = async () => {
    setSt({ phase: 'sending', text: '' });
    if (!canStream) {
      try {
        const reply = await api.chat(TEST_PROMPT);
        setSt(reply.source === 'system' ? { phase: 'failed', text: '', reason: reply.text } : { phase: 'done', text: reply.text });
      } catch (e) {
        setSt({ phase: 'failed', text: '', reason: errMsg(e, 'The test message could not be sent.') });
      }
      await reload().catch(() => undefined);
      return;
    }
    try {
      const start = await api.chatStreamStart!(TEST_PROMPT);
      setSt({ phase: 'streaming', text: '', streamId: start.streamId });
      unsub.current = api.onChatStream!(start, (ev) => {
        if (ev.type === 'delta') setSt((s) => ({ ...s, phase: 'streaming', text: (s.text + ev.text).slice(0, 2000) }));
        else if (ev.type === 'lost') setSt((s) => ({ ...s, phase: 'failed', reason: `The live reply was interrupted (${ev.reason}).` }));
        else if (ev.type === 'done') {
          unsub.current?.();
          unsub.current = null;
          if (ev.outcome === 'complete' || ev.outcome === 'truncated') setSt((s) => ({ ...s, phase: 'done', text: ev.reply.text || s.text }));
          else if (ev.outcome === 'cancelled') setSt((s) => ({ ...s, phase: 'stopped' }));
          else setSt((s) => ({ ...s, phase: 'failed', reason: ev.reply?.text || 'The model did not answer.' }));
          void reload().catch(() => undefined);
        }
      });
    } catch (e) {
      setSt({ phase: 'failed', text: '', reason: errMsg(e, 'The test message could not be started.') });
    }
  };
  const stop = () => {
    if (st.streamId) void api.chatStreamCancel?.(st.streamId).catch(() => undefined);
  };
  const busy = st.phase === 'sending' || st.phase === 'streaming';
  return (
    <div className="ai-test">
      <p className="field-hint">
        Sends one short message to {providerName} ({host}) with your key and streams the reply here. It may use a small number of tokens that {providerName} bills to your account. The message and reply are kept in your Assistant conversation.
      </p>
      <div className="row wrap">
        <Button variant="primary" icon={PaperPlaneRight} busy={st.phase === 'sending'} disabled={busy} onClick={() => void send()}>
          {st.phase === 'done' || st.phase === 'failed' || st.phase === 'stopped' ? 'Send another test' : 'Send a test message'}
        </Button>
        {st.phase === 'streaming' && (
          <Button icon={Stop} onClick={stop}>
            Stop
          </Button>
        )}
      </div>
      {(st.phase === 'streaming' || st.text) && (
        <div className={cx('ai-stream', st.phase === 'streaming' && 'is-live')} aria-live="polite">
          <span className="hud">{st.phase === 'streaming' ? 'Receiving' : st.phase === 'stopped' ? 'Stopped' : 'Reply'}</span>
          <p>
            {st.text || 'Waiting for the first words…'}
            {st.phase === 'streaming' && <span className="caret" aria-hidden="true" />}
          </p>
        </div>
      )}
      {st.phase === 'done' && (
        <p className="ai-ok" role="status">
          <Check size={16} weight="bold" aria-hidden /> {providerName} answered. Chat is working.
        </p>
      )}
      {st.phase === 'stopped' && <Notice title="Test stopped">You stopped the reply. Whatever arrived was kept. Stopping works the same way in the Assistant.</Notice>}
      {st.phase === 'failed' && (
        <Notice tone="danger" title="The test did not get an answer">
          {truncate(st.reason ?? '', 400)}
        </Notice>
      )}
    </div>
  );
}

function Step({ n, title, state, children }: { n: number; title: string; state: 'todo' | 'active' | 'done'; children?: ReactNode }) {
  return (
    <li className={cx('ai-step', `is-${state}`)} aria-current={state === 'active' ? 'step' : undefined}>
      <span className="ai-step-mark" aria-hidden="true" data-n={state === 'done' ? '' : String(n)}>
        {state === 'done' && <Check size={13} weight="bold" />}
      </span>
      <div className="ai-step-body">
        <h3>{title}</h3>
        {state !== 'todo' && children}
      </div>
    </li>
  );
}

export function AiSetup({ onDone, onSkip }: { onDone: (r: AiSetupResult) => void; onSkip?: () => void }) {
  const { settings, mutate, api, refreshCloud, refreshSystem, isPreview } = useReady();
  const bridge = useMemo(() => cloudProvidersBridge(api), [api]);
  const [provider, setProvider] = useState<CloudProvider>(isCloudProvider(settings.cloudProvider) ? settings.cloudProvider : 'anthropic');
  const [others, setOthers] = useState(provider !== 'anthropic');
  const [status, setStatus] = useState<CloudProviderStatus[] | null>(null);
  const [key, setKey] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [models, setModels] = useState<CloudModelList | null>(null);
  const [checking, setChecking] = useState(false);
  const [chosen, setChosen] = useState('');
  const [custom, setCustom] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const info = cloudProviderInfo(provider);
  const st = status?.find((s) => s.provider === provider);
  const hasKey = st?.hasKey === true;
  const online = settings.mode === 'online' && (settings.cloudProvider ?? 'anthropic') === provider;
  const canList = typeof api.cloudModels === 'function';
  const customError = custom.trim() ? cloudModelError(custom) : null;

  useEffect(() => {
    let live = true;
    bridge
      .status()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [bridge]);

  const checkModels = async () => {
    if (!api.cloudModels) return;
    setChecking(true);
    try {
      const r = await api.cloudModels(provider);
      setModels(r);
      const current = settings.cloudProvider === provider ? settings.cloudModel : '';
      if (r.available) setChosen(r.models.some((m) => m.id === current) ? current : r.models[0]?.id ?? '');
    } catch (e) {
      setModels({ provider, available: false, models: [], reason: errMsg(e, 'The model list could not be read.'), checkedAt: new Date().toISOString() });
    } finally {
      setChecking(false);
    }
  };

  // Listing models contacts the provider, so it only runs after the user turned on online mode for this provider.
  useEffect(() => {
    if (online && hasKey && canList && !models && !checking) void checkModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, hasKey, provider]);

  const pickProvider = (p: CloudProvider) => {
    setProvider(p);
    setModels(null);
    setChosen('');
    setModelSaved(false);
    setKey('');
    setKeyError(null);
  };

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
      setModels(null);
    } catch (e) {
      setKeyError(errMsg(e, 'The key could not be saved.'));
    } finally {
      setKeyBusy(false);
    }
  };

  // Windows asks the user to confirm switching to online mode; nothing is saved if they decline.
  const connect = async () => {
    setConnecting(true);
    const ok = await mutate(() => api.saveSettings({ mode: 'online', cloudProvider: provider }), `AI requests now go to ${info.name} when you send them.`);
    setConnecting(false);
    if (ok) void refreshSystem();
  };

  const useModel = async (id: string) => {
    if (!id || cloudModelError(id)) return;
    setSavingModel(true);
    const ok = await mutate(() => api.saveSettings({ cloudModel: id }));
    setSavingModel(false);
    setModelSaved(ok);
    if (ok) void refreshSystem();
  };

  const keyState = hasKey ? 'done' : 'active';
  const connectState = !hasKey ? 'todo' : online ? 'done' : 'active';
  const modelState = !hasKey || !online ? 'todo' : modelSaved ? 'done' : 'active';
  const testState = modelSaved ? 'active' : 'todo';
  const target = advanced && custom.trim() ? custom.trim() : chosen;

  return (
    <div className="ai-setup">
      <div className="provider-list" role="radiogroup" aria-label="AI provider">
        <button type="button" role="radio" aria-checked={provider === 'anthropic'} className={cx('provider is-primary', provider === 'anthropic' && 'on')} onClick={() => pickProvider('anthropic')}>
          <span className="provider-mark" aria-hidden="true">
            <Lightning size={20} weight="fill" />
          </span>
          <span className="grow">
            <strong>Claude by Anthropic</strong>
            <span className="sub">Recommended. Uses your own Anthropic API key; Anthropic bills usage to your account.</span>
          </span>
          {status?.find((s) => s.provider === 'anthropic')?.hasKey ? <Badge tone="ok">Key saved</Badge> : null}
        </button>
        <details className="disclosure provider-others" open={others} onToggle={(e) => setOthers((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Other providers</summary>
          <div className="disclosure-body">
            {OTHER_PROVIDERS.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={provider === p.id}
                disabled={!p.available}
                className={cx('provider', provider === p.id && 'on')}
                onClick={() => {
                  if (p.available && isCloudProvider(p.id)) pickProvider(p.id);
                }}
              >
                <span className="grow">
                  <strong>{p.name}</strong>
                  <span className="sub">{p.note}</span>
                </span>
                {!p.available ? <Badge>Not available</Badge> : status?.find((s) => s.provider === p.id)?.hasKey ? <Badge tone="ok">Key saved</Badge> : null}
              </button>
            ))}
          </div>
        </details>
      </div>

      <ol className="ai-steps">
        <Step n={1} title={`Your ${info.name} API key`} state={keyState}>
          <p className="field-hint">
            Saved with Windows protection on this computer and never shown again. It is used only when you send a message.
            {provider === 'anthropic' ? ' You can create one in the Anthropic Console under API keys.' : ''}
          </p>
          {st?.keyChannel === 'unavailable' && <Notice tone="warn">{st.reason ?? 'Keys for this provider cannot be saved in this build.'}</Notice>}
          {isPreview && (
            <Notice title="Key entry is off in the browser preview">
              This page is running in a browser, not the desktop app. A key can only be saved in the desktop app, where Windows protection keeps it out of this window's storage. Nothing typed here is stored or sent, and no model list or test request is possible from the preview.
            </Notice>
          )}
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
                  placeholder={isPreview ? 'Unavailable in the browser preview' : hasKey ? 'Saved. Paste a new key to replace it' : 'Paste your key'}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setKeyError(null);
                  }}
                />
              )}
            </Field>
            <Button type="submit" icon={Key} busy={keyBusy} disabled={!key.trim() || isPreview}>
              {hasKey ? 'Replace key' : 'Save key'}
            </Button>
          </form>
        </Step>

        <Step n={2} title={`Allow AI requests to ${info.name}`} state={connectState}>
          <p className="field-hint">
            Your notes, tasks, files and settings stay on this computer. When you send a message, that message and the earlier conversation go to {info.name} ({info.host}). Nothing switches to another provider if it fails. Windows asks you to confirm.
          </p>
          {!online && (
            <Button variant="primary" icon={Plugs} busy={connecting} onClick={() => void connect()}>
              Turn on online mode
            </Button>
          )}
        </Step>

        <Step n={3} title="Choose a model" state={modelState}>
          {!canList ? (
            <Notice tone="warn">This window cannot ask {info.name} which models your key can use. Type a model id under Advanced.</Notice>
          ) : checking ? (
            <p className="sub" role="status">
              Asking {info.name} which models your key can use…
            </p>
          ) : models && !models.available ? (
            <Notice
              tone="warn"
              title="No model list"
              action={
                <Button size="sm" icon={ArrowClockwise} onClick={() => void checkModels()}>
                  Check again
                </Button>
              }
            >
              {models.reason}
            </Notice>
          ) : models ? (
            <div className="model-list" role="radiogroup" aria-label={`${info.name} models`}>
              {models.models.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={chosen === m.id} className={cx('model', chosen === m.id && 'on')} onClick={() => setChosen(m.id)}>
                  <strong>{m.name}</strong>
                  <span className="mono">{m.id}</span>
                </button>
              ))}
            </div>
          ) : null}
          <details className="disclosure" open={advanced} onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Advanced: type a model id</summary>
            <div className="disclosure-body">
              <Field label="Model id" error={customError} hint={`The exact id ${info.name} uses. The test message shows whether it works.`}>
                {(id, d) => <input id={id} aria-describedby={d} className="input mono" value={custom} maxLength={100} spellCheck={false} onChange={(e) => setCustom(e.target.value)} />}
              </Field>
            </div>
          </details>
          <div className="row wrap">
            <Button variant="primary" busy={savingModel} disabled={!target || Boolean(cloudModelError(target))} onClick={() => void useModel(target)}>
              Use this model
            </Button>
            {modelSaved && (
              <span className="sub" role="status">
                Using <span className="mono">{settings.cloudModel}</span>
              </span>
            )}
          </div>
        </Step>

        <Step n={4} title="Test the connection" state={testState}>
          <TestMessage providerName={info.name} host={info.host} />
          <div className="row wrap">
            <Button onClick={() => onDone('cloud')}>Open the Assistant</Button>
          </div>
        </Step>
      </ol>

      {onSkip && (
        <p className="field-hint ai-skip">
          <WarningCircle size={14} aria-hidden /> Without a key, chat stays off. Notes, tasks and search keep working on this computer.{' '}
          <button type="button" className="linkbtn" onClick={onSkip}>
            Continue without AI
          </button>
        </p>
      )}
    </div>
  );
}
