import { useCallback, useEffect, useRef, useState } from 'react';
import { Broom, Microphone, PaperPlaneRight, SpeakerHigh, Stop } from '@phosphor-icons/react';
import type { ChatMessage } from '../shared/contracts';
import { Avatar } from './Avatar';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Notice, PageHeader, Panel, Spinner, Switch } from '../ui/primitives';
import { ClipRecorder, MAX_CLIP_MS, micErrorMessage } from '../ui/audio';
import { useCompanion } from '../ui/companion';
import { usePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { cx, errMsg, fmtTime } from '../ui/util';

type RecPhase = 'idle' | 'starting' | 'recording' | 'transcribing';
const HOLD_MS = 400;
const MAX_CHARS = 4000;

const sourceLabel = (s: ChatMessage['source']) => (s === 'local' ? 'Local model' : s === 'cloud' ? 'Cloud model' : 'System');

function LevelMeter({ level, active }: { level: number; active: boolean }) {
  return (
    <div className={cx('meter', active && 'on')} aria-hidden="true">
      {Array.from({ length: 14 }, (_, i) => (
        <i key={i} className={active && level * 14 > i ? 'lit' : ''} style={{ height: `${30 + ((i * 37) % 50)}%` }} />
      ))}
    </div>
  );
}

export function Assistant() {
  const { api, state, settings, cloudConfigured, run, toast, reload } = useReady();
  const companion = useCompanion();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [level, setLevel] = useState(0);
  const [voiceNote, setVoiceNote] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [autoSpeak, setAutoSpeak] = usePref('autoSpeak', false);
  const [speakText, setSpeakText] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const recorder = useRef<ClipRecorder | null>(null);
  const phaseRef = useRef<RecPhase>('idle');
  const pressAt = useRef(0);
  const pendingStop = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const setPhaseBoth = (p: RecPhase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.chat.length, pending]);

  useEffect(
    () => () => {
      recorder.current?.cancel();
      companion.set('idle');
      companion.setLevel(0);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const online = settings.mode === 'online';
  const configured = online ? Boolean(settings.cloudModel) && cloudConfigured === true : Boolean(settings.localModel && settings.localEndpoint);

  const speak = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      setSpeaking(true);
      companion.set('speaking');
      try {
        const r = await api.speak(t.slice(0, 2000));
        if (!r.ok) {
          setVoiceNote({ tone: 'warn', text: r.reason ?? 'Speech playback is not available.' });
          companion.set('idle');
        } else {
          setVoiceNote(null);
          companion.set('idle');
        }
      } catch (e) {
        setVoiceNote({ tone: 'danger', text: errMsg(e) });
        companion.set('alert', 3000);
      } finally {
        setSpeaking(false);
      }
    },
    [api, companion],
  );

  const send = async () => {
    const text = input.trim();
    if (!text || pending !== null || phase === 'transcribing') return;
    setInput('');
    setPending(text);
    setSendError(null);
    companion.set('thinking');
    try {
      const reply = await api.chat(text);
      await reload().catch(() => undefined);
      companion.set('idle');
      if (autoSpeak) void speak(reply.text);
    } catch (e) {
      setSendError(errMsg(e, 'The assistant could not answer.'));
      companion.set('alert', 4000);
      const fresh = await api.getState().catch(() => null);
      if (fresh) await reload().catch(() => undefined);
      const last = fresh?.chat[fresh.chat.length - 1];
      if (!(last && last.role === 'user' && last.text === text)) setInput(text);
    } finally {
      setPending(null);
    }
  };

  const startRec = async () => {
    if (phaseRef.current !== 'idle') return;
    pendingStop.current = false;
    setVoiceNote(null);
    setPhaseBoth('starting');
    const r = new ClipRecorder();
    recorder.current = r;
    r.onLevel = (l) => {
      const q = Math.round(l * 20) / 20;
      setLevel(q);
      companion.setLevel(q);
    };
    r.onLimit = () => void stopRec();
    const t0 = performance.now();
    try {
      await r.start();
    } catch (e) {
      recorder.current = null;
      setPhaseBoth('idle');
      setVoiceNote({ tone: 'warn', text: micErrorMessage(e) });
      return;
    }
    setPhaseBoth('recording');
    companion.set('listening');
    // A release during a long permission prompt is not a deliberate "stop": stay recording until the next tap.
    if (pendingStop.current && performance.now() - t0 < 1000) void stopRec();
  };

  const stopRec = async () => {
    if (phaseRef.current === 'starting') {
      pendingStop.current = true;
      return;
    }
    const r = recorder.current;
    if (phaseRef.current !== 'recording' || !r) return;
    setPhaseBoth('transcribing');
    companion.set('thinking');
    companion.setLevel(0);
    try {
      const clip = await r.stop();
      const out = await api.transcribe(clip.wav);
      if (out.text.trim()) {
        setInput((prev) => (prev.trim() ? `${prev.trim()} ${out.text.trim()}` : out.text.trim()).slice(0, MAX_CHARS));
        setVoiceNote({ tone: 'info', text: 'Transcript added to the message box. Review it, then send.' });
        inputRef.current?.focus();
        companion.set('idle');
      } else {
        setVoiceNote({ tone: 'warn', text: out.reason ?? 'No speech was recognized.' });
        companion.set('idle');
      }
    } catch (e) {
      setVoiceNote({ tone: 'warn', text: errMsg(e, 'Transcription failed.') });
      companion.set('alert', 3000);
    } finally {
      recorder.current = null;
      setPhaseBoth('idle');
      setLevel(0);
    }
  };

  const cancelRec = () => {
    if (phaseRef.current === 'recording' || phaseRef.current === 'starting') {
      recorder.current?.cancel();
      recorder.current = null;
      setPhaseBoth('idle');
      companion.set('idle');
      setVoiceNote({ tone: 'info', text: 'Recording cancelled. Nothing was sent.' });
    }
  };

  const press = () => {
    if (phaseRef.current === 'recording') {
      void stopRec();
      return;
    }
    pressAt.current = performance.now();
    void startRec();
  };
  const release = () => {
    if (phaseRef.current === 'idle' || phaseRef.current === 'transcribing') return;
    if (performance.now() - pressAt.current > HOLD_MS) void stopRec();
  };

  const doClear = async () => {
    setClearing(true);
    const ok = await run(() => api.clearChat(), 'Conversation cleared.');
    setClearing(false);
    if (ok !== undefined) setConfirmClear(false);
  };

  const recLabel = phase === 'recording' ? 'Recording — release to stop' : phase === 'starting' ? 'Starting microphone…' : phase === 'transcribing' ? 'Transcribing…' : 'Hold to talk';

  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="Cockpit"
        title="Assistant"
        subtitle={online ? 'Online mode: messages go to your cloud model with your own key.' : 'Offline mode: messages go only to your local model endpoint.'}
        actions={
          <Button icon={Broom} onClick={() => setConfirmClear(true)} disabled={state.chat.length === 0}>
            Clear conversation
          </Button>
        }
      />

      <div className="assist-grid">
        <section className="chat panel" aria-label="Conversation">
          <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0}>
            {state.chat.length === 0 && pending === null ? (
              <Empty icon={SpeakerHigh} title="No messages yet">
                {configured
                  ? `Your next message goes to ${online ? `the cloud model “${settings.cloudModel}”` : `the local model “${settings.localModel}”`}. Replies are generated by that model, not scripted.`
                  : online
                    ? 'Online mode needs a cloud model name and a saved key (Settings). There is no fallback to a local model.'
                    : 'Set a local model endpoint and name in Settings. Until a model is reachable, sending will show an error rather than an answer.'}
              </Empty>
            ) : (
              <>
                {state.chat.map((m) => (
                  <article key={m.id} className={cx('msg', `msg-${m.role}`, m.source === 'system' && 'msg-system')}>
                    <header>
                      <span className="msg-who">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                      {m.role === 'assistant' && <Badge tone={m.source === 'cloud' ? 'warn' : m.source === 'local' ? 'accent' : 'muted'}>{sourceLabel(m.source)}</Badge>}
                      <time dateTime={m.createdAt}>{fmtTime(m.createdAt)}</time>
                      {m.role === 'assistant' && (
                        <button type="button" className="iconbtn" aria-label="Read this reply aloud" title="Read aloud" disabled={speaking} onClick={() => void speak(m.text)}>
                          <SpeakerHigh size={14} aria-hidden />
                        </button>
                      )}
                    </header>
                    <p>{m.text}</p>
                  </article>
                ))}
                {pending !== null && (
                  <>
                    <article className="msg msg-user msg-pending">
                      <header>
                        <span className="msg-who">You</span>
                        <span className="sub">sending…</span>
                      </header>
                      <p>{pending}</p>
                    </article>
                    <div className="typing" role="status" aria-label="Waiting for the model">
                      <i /><i /><i />
                      <span>Waiting for {online ? 'cloud' : 'local'} model…</span>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {sendError && (
            <div className="chat-error">
              <Notice tone="danger" title="The message was not answered">{sendError} No other model was tried.</Notice>
            </div>
          )}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <label htmlFor="chat-input" className="sr-only">
              Message
            </label>
            <textarea
              id="chat-input"
              ref={inputRef}
              className="input"
              rows={2}
              maxLength={MAX_CHARS}
              placeholder="Type a message. Enter sends, Shift+Enter adds a line."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-actions">
              <button
                type="button"
                className={cx('ptt', phase !== 'idle' && `ptt-${phase}`)}
                aria-pressed={phase === 'recording'}
                aria-label={recLabel}
                title="Hold to record, or tap once to start and tap again to stop. Esc cancels."
                disabled={phase === 'transcribing' || pending !== null}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  press();
                }}
                onPointerUp={release}
                onPointerCancel={cancelRec}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') cancelRec();
                  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                    e.preventDefault();
                    press();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    release();
                  }
                }}
                onClick={(e) => {
                  if (e.detail === 0) press();
                }}
              >
                {phase === 'transcribing' || phase === 'starting' ? <Spinner size={16} /> : phase === 'recording' ? <Stop size={16} weight="fill" aria-hidden /> : <Microphone size={16} aria-hidden />}
                <span>{phase === 'recording' ? 'Release' : phase === 'transcribing' ? 'Transcribing' : 'Push to talk'}</span>
              </button>
              <span className="counter" aria-hidden={input.length < 3500}>
                {input.length >= 3500 ? `${input.length}/${MAX_CHARS}` : ''}
              </span>
              <Button type="submit" variant="primary" icon={PaperPlaneRight} disabled={!input.trim() || pending !== null || phase === 'transcribing'}>
                Send
              </Button>
            </div>
          </form>
        </section>

        <div className="stack">
          <Panel title="Companion" eyebrow="State" className="panel-companion">
            <div className="companion-mini">
              <Avatar state={companion.state} size={104} level={level} />
              <p className="field-hint">Shows what this window is doing: recording, waiting for a reply, speaking aloud, or an error.</p>
            </div>
          </Panel>

          <Panel title="Push to talk" eyebrow="Voice input">
            <LevelMeter level={level} active={phase === 'recording'} />
            <p className="field-hint">
              Records up to {MAX_CLIP_MS / 1000} s from the default microphone as 16 kHz mono WAV and sends it to the backend’s speech recognizer. The text lands in the message box for you to review; nothing is sent automatically.
            </p>
            {voiceNote && (
              <div aria-live="polite">
                <Notice tone={voiceNote.tone}>{voiceNote.text}</Notice>
              </div>
            )}
          </Panel>

          <Panel title="Read aloud" eyebrow="Local speech">
            <p className="field-hint">
              Voice: <strong>{settings.voice || 'backend default'}</strong> (change in Settings). Playback is handled by the backend; if no speech engine is installed it will say so. There is no stop control yet.
            </p>
            <Switch label="Read replies aloud automatically" checked={autoSpeak} onChange={setAutoSpeak} />
            <div className="field">
              <label htmlFor="speak-text">Speak this text</label>
              <textarea id="speak-text" className="input" rows={2} maxLength={2000} value={speakText} onChange={(e) => setSpeakText(e.target.value)} placeholder="Type something to hear it" />
            </div>
            <Button icon={SpeakerHigh} busy={speaking} disabled={!speakText.trim()} onClick={() => void speak(speakText)}>
              Speak
            </Button>
          </Panel>

          <Panel title="Model route" eyebrow="No hidden fallback">
            <dl className="kv-list">
              <div className="kv"><dt>Mode</dt><dd>{online ? 'Online' : 'Offline'}</dd></div>
              <div className="kv"><dt>{online ? 'Cloud model' : 'Local model'}</dt><dd>{(online ? settings.cloudModel : settings.localModel) || 'not set'}</dd></div>
              {!online && <div className="kv"><dt>Endpoint</dt><dd className="mono">{settings.localEndpoint || 'not set'}</dd></div>}
              {online && <div className="kv"><dt>API key</dt><dd>{cloudConfigured === null ? 'unknown' : cloudConfigured ? 'saved' : 'not saved'}</dd></div>}
            </dl>
          </Panel>
        </div>
      </div>

      <ConfirmDialog open={confirmClear} title="Clear the conversation?" confirmLabel="Clear" danger busy={clearing} onCancel={() => setConfirmClear(false)} onConfirm={() => void doClear()}>
        <p>All {state.chat.length} saved messages are deleted from this computer. Notes, tasks and capsules are not affected.</p>
      </ConfirmDialog>
    </div>
  );
}
