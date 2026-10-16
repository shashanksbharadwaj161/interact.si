import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CheckSquare, NotePencil, Sparkle } from '@phosphor-icons/react';
import type { Capability, Settings } from '../shared/contracts';
import { CoreFrame } from './CompanionOrb';
import { AiSetup, type AiSetupResult } from './AiSetup';
import { SHELL_PREF, useShellPref } from './Settings';
import { Button, Notice, Segmented, Switch } from '../ui/primitives';
import { useReady, useStore } from '../ui/store';
import { hashFor } from '../ui/nav';
import { THEME_CHOICES, normalizeThemeChoice, type ThemeChoice } from '../ui/theme';
import { cx, isLoopbackHost, relTime, truncate } from '../ui/util';
import '../styles/onboarding.css';

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

/**
 * What the assistant can actually do right now. AI is a cloud service the user connects with their own key (Claude
 * first). Online readiness is whether a model name and that provider's saved key exist; the provider itself is reached
 * only when a message is sent. Offline means AI is not connected, except for an earlier local-model setup that still
 * answers its live check: that keeps working and is labelled as the legacy local model.
 */
export function modelReadiness(input: ReadinessInput): ModelReadiness {
  const { settings, capabilities, systemError, cloudConfigured } = input;
  if (settings.mode === 'online') {
    if (!settings.cloudModel.trim()) return { route: 'cloud', level: 'blocked', title: 'No model is chosen', detail: 'Choose a model in Connect AI before chatting. Nothing is sent until then.' };
    if (cloudConfigured === false) {
      return { route: 'cloud', level: 'blocked', title: 'No API key is saved', detail: 'Chat shows an error and sends nothing until you save your key in Connect AI. It never switches to another provider.' };
    }
    if (cloudConfigured === null) return { route: 'cloud', level: 'unknown', title: 'Key status unknown', detail: 'The saved-key check did not answer. Check again, or open Connect AI.' };
    return { route: 'cloud', level: 'ready', title: 'AI is connected', detail: `Messages go to “${settings.cloudModel}” with your saved key when you send them. Whether the provider answers is shown in the conversation.` };
  }
  const local = capabilities?.find((c) => c.id === 'local-llm');
  if (!systemError && local?.available && settings.localModel.trim()) {
    return { route: 'local', level: 'ready', title: 'Legacy local model is answering', detail: `Replies come from “${settings.localModel}” on this computer, set up in an earlier version. Connect Claude for the full assistant.` };
  }
  return { route: 'cloud', level: 'blocked', title: 'AI is not connected', detail: 'Connect Claude with your own Anthropic API key to chat. Notes, tasks and search work on this computer without it.' };
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

type Phase = 'welcome' | 'first' | 'saved' | 'ai';
type FirstKind = 'note' | 'task';
type SavedRecord = { kind: FirstKind; id: string; title: string; body?: string; due?: string; at: string };

/**
 * First run. One welcoming scene and two paths:
 * Start locally saves a real note or task (no model, no account, nothing leaves the computer) and shows the record as it
 * was read back from storage. Connect AI runs the shared AI setup, which either reaches a working model or ends at one
 * concrete recovery step; local tools always stay available. Setup is marked finished only when the user continues.
 * Nothing is requested or probed beyond the capability check the app already runs on start.
 */
export function Onboarding() {
  const { settings, mutate, api, state } = useReady();
  const [phase, setPhase] = useState<Phase>('welcome');
  const [kind, setKind] = useState<FirstKind>('note');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedRecord | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishFailed, setFinishFailed] = useState(false);
  const [themeRaw, setThemeRaw] = useShellPref<string | null>(SHELL_PREF.theme, null);
  const theme = normalizeThemeChoice(themeRaw, settings.theme);
  const headRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    requestAnimationFrame(() => headRef.current?.focus());
  }, [phase]);

  const saveFirst = async (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    setSaveError(null);
    const before = new Set((kind === 'note' ? state.notes : state.tasks).map((x) => x.id));
    const ok = await mutate(() => (kind === 'note' ? api.saveNote({ title: t, body: body.trim(), tags: [] }) : api.saveTask({ title: t, done: false })));
    if (!ok) {
      setSaving(false);
      setSaveError('It was not saved. Nothing was changed; try again.');
      return;
    }
    // Show what storage now holds, not what was typed.
    const fresh = await api.getState().catch(() => null);
    setSaving(false);
    const list = fresh ? (kind === 'note' ? fresh.notes : fresh.tasks) : [];
    const rec = list.find((x) => !before.has(x.id));
    if (!rec) {
      setSaveError('It was saved, but it could not be read back. It will appear in the app.');
      return;
    }
    setSaved(kind === 'note' ? { kind, id: rec.id, title: rec.title, body: (rec as { body: string }).body, at: (rec as { updatedAt: string }).updatedAt } : { kind, id: rec.id, title: rec.title, due: (rec as { due?: string }).due, at: (rec as { createdAt: string }).createdAt });
    setPhase('saved');
  };

  // The only write that finishes setup. The destination is set first so the shell opens there.
  const finish = async (to: { view: 'home' | 'notes' | 'tasks' | 'assistant'; params?: Record<string, string> }) => {
    setFinishing(true);
    setFinishFailed(false);
    window.location.hash = hashFor(to.view, to.params).slice(1);
    const ok = await mutate(() => api.saveSettings({ onboarded: true }));
    setFinishing(false);
    if (!ok) setFinishFailed(true);
  };

  const prefs = (
    <div className="ob-prefs">
      <Segmented<ThemeChoice> label="Theme" value={theme} onChange={(v) => setThemeRaw(v)} options={THEME_CHOICES.map((c) => ({ value: c.value, label: c.label }))} />
      <Switch label="Reduce motion" description="A still core and simpler transitions." checked={settings.reduceMotion} onChange={(v) => void mutate(() => api.saveSettings({ reduceMotion: v }))} />
    </div>
  );

  return (
    <div className="onboard">
      <section className="ob-main" aria-labelledby="ob-title">
        <p className="ob-brand">
          <span className="brand-mark" aria-hidden="true" /> Desktop Companion
        </p>

        {phase === 'welcome' && (
          <div className="ob-step">
            <h1 id="ob-title" ref={headRef} tabIndex={-1} className="display">
              Your computer, <em>awake</em>.
            </h1>
            <p className="ob-lead">Keep notes, tasks and searches here, on this computer. Connect Claude when you want it to think with you.</p>
            <div className="ob-paths">
              <button type="button" className="ob-path is-primary" onClick={() => setPhase('first')}>
                <span className="ob-path-icon" aria-hidden="true">
                  <NotePencil size={22} />
                </span>
                <span className="grow">
                  <strong>Start locally</strong>
                  <span>Notes, tasks and search. No account, no download, nothing leaves this computer.</span>
                </span>
                <ArrowRight size={18} aria-hidden />
              </button>
              <button type="button" className="ob-path" onClick={() => setPhase('ai')}>
                <span className="ob-path-icon" aria-hidden="true">
                  <Sparkle size={22} />
                </span>
                <span className="grow">
                  <strong>Connect Claude</strong>
                  <span>Use your own Anthropic API key. Notes stay here; only messages you send go to Anthropic.</span>
                </span>
                <ArrowRight size={18} aria-hidden />
              </button>
            </div>
            <p className="field-hint">Nothing is allowed by default. Folders, apps, the microphone and clipboard history are only asked for when you use them.</p>
            {prefs}
          </div>
        )}

        {phase === 'first' && (
          <div className="ob-step">
            <button type="button" className="linkbtn back-link" onClick={() => setPhase('welcome')}>
              <ArrowLeft size={14} aria-hidden /> Back
            </button>
            <h1 id="ob-title" ref={headRef} tabIndex={-1}>
              What should we keep first?
            </h1>
            <form className="ob-first" onSubmit={(e) => void saveFirst(e)} aria-busy={saving}>
              <div className="start-kinds" role="radiogroup" aria-label="Note or task">
                {(
                  [
                    ['note', 'A note', NotePencil],
                    ['task', 'A task', CheckSquare],
                  ] as const
                ).map(([k, name, Icon]) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={cx('start-kind', kind === k && 'on')} onClick={() => setKind(k)}>
                    <Icon size={16} weight={kind === k ? 'fill' : 'regular'} aria-hidden />
                    {name}
                  </button>
                ))}
              </div>
              <label htmlFor={titleId} className="field-label">
                {kind === 'note' ? 'Title' : 'What needs doing?'}
              </label>
              <input id={titleId} className="input ob-input" value={title} maxLength={200} autoFocus placeholder={kind === 'note' ? 'For example: Ideas for the weekend' : 'For example: Call the bank about the card'} onChange={(e) => setTitle(e.target.value)} />
              {kind === 'note' && (
                <>
                  <label htmlFor={bodyId} className="field-label">
                    Note <span className="sub">optional</span>
                  </label>
                  <textarea id={bodyId} className="input" rows={4} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
                </>
              )}
              {saveError && (
                <Notice tone="danger" title="Not saved">
                  {saveError}
                </Notice>
              )}
              <div className="row wrap">
                <Button type="submit" variant="primary" size="lg" busy={saving} disabled={!title.trim()}>
                  {kind === 'note' ? 'Save note' : 'Add task'}
                </Button>
                <span className="sub">Saved on this computer only.</span>
              </div>
            </form>
          </div>
        )}

        {phase === 'saved' && saved && (
          <div className="ob-step">
            <h1 id="ob-title" ref={headRef} tabIndex={-1}>
              Saved. It’s yours.
            </h1>
            <article className="ob-record" aria-label={`Saved ${saved.kind}`}>
              <span className="ob-record-check" aria-hidden="true">
                <Check size={16} weight="bold" />
              </span>
              <div className="grow">
                <p className="sub">
                  {saved.kind === 'note' ? 'Note' : 'Task'} · saved {relTime(saved.at)} on this computer
                </p>
                <strong>{saved.title}</strong>
                {saved.body && <p className="ob-record-body">{truncate(saved.body, 220)}</p>}
              </div>
            </article>
            <p className="ob-lead">You can find it in Workspace, on Today, and in search with Ctrl+K.</p>
            {finishFailed && (
              <Notice tone="danger" title="Setup was not finished">
                The app could not save that setup is finished. Your {saved.kind} is saved. Try again.
              </Notice>
            )}
            <div className="row wrap">
              <Button variant="primary" size="lg" icon={ArrowRight} busy={finishing} onClick={() => void finish({ view: 'home' })}>
                Continue to Today
              </Button>
              <Button busy={finishing} onClick={() => void finish(saved.kind === 'note' ? { view: 'notes', params: { item: saved.id } } : { view: 'tasks' })}>
                Open the {saved.kind}
              </Button>
              <button type="button" className="linkbtn" onClick={() => setPhase('ai')}>
                Connect Claude too
              </button>
            </div>
          </div>
        )}

        {phase === 'ai' && (
          <div className="ob-step">
            <button type="button" className="linkbtn back-link" onClick={() => setPhase(saved ? 'saved' : 'welcome')}>
              <ArrowLeft size={14} aria-hidden /> Back
            </button>
            <h1 id="ob-title" ref={headRef} tabIndex={-1}>
              Connect Claude
            </h1>
            <p className="ob-lead">Four short steps. Nothing is sent to Anthropic until you allow it, and you can change this later in Settings.</p>
            <AiSetup onDone={(_r: AiSetupResult) => void finish({ view: 'assistant' })} onSkip={() => void finish({ view: 'home' })} />
            {finishFailed && (
              <Notice tone="danger" title="Setup was not finished">
                The app could not save that setup is finished. Try again.
              </Notice>
            )}
          </div>
        )}
      </section>

      <aside className="ob-stage" aria-label="Your companion">
        <CoreFrame size={320} label="Your companion" />
        <p className="sub">This is your companion's core. It shows what the app is really doing. You can change its form in Studio.</p>
      </aside>
    </div>
  );
}
