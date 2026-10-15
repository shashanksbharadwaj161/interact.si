import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PaperPlaneTilt, Stop, Copy, ArrowLineDown, Trash, Warning } from '@phosphor-icons/react';
import type { ApiFeature } from '../shared/contracts';
import { Badge, Button, Field, Notice, Panel } from '../ui/primitives';
import { useStore } from '../ui/store';
import { useReducedMotion } from '../ui/workbench';
import {
  IDLE_REPLY, LANGUAGE_SUGGESTIONS, PROMPT_LIMITS, TOOLS, buildPrompt, collectSources, createDraftSender, describeRoute, errorText, listSourceCandidates, toolById,
  type DraftSender, type PromptInput, type ReplyState, type SourcePick, type ToolId,
} from '../ui/prompt-tools';
import { diagnoseErrorText, type Diagnosis, type ProposedAction } from '../ui/error-diagnosis';
import { usePref } from '../ui/prefs';
import {
  DEFAULT_TONE_CHOICE, TARGET_LANGUAGES, TONE_PROFILES, TONE_PROFILE_PREF_KEY, buildTonePrompt, checkRewrite, normalizeToneChoice,
  type ToneChoice, type TonePrompt, type ToneProfile,
} from '../ui/tone-profiles';

export type PromptToolsInput = Pick<PromptInput, 'text' | 'selection' | 'noteId' | 'noteTitle'>;

const OUTCOME_TEXT: Record<string, string> = {
  complete: 'Reply complete.',
  truncated: 'Reply cut at the app’s length cap; the model may have had more.',
  cancelled: 'Stopped by you; the partial text is kept.',
  incomplete: 'The connection ended early; the reply is incomplete.',
  failed: 'The assistant produced no reply.',
};

/**
 * Bounded draft tools for the writing workbench. The user picks a tool and app-owned sources, reads (or edits) the exact
 * prompt, and only the Send button submits it through the existing assistant route. The panel never sends by itself and
 * shows only what that route returned.
 */
export function PromptTools({ input, onInsert }: { input: PromptToolsInput; onInsert?: (text: string, mode: 'append' | 'replace-selection') => void }) {
  const { api, state, productivity, settings, cloudConfigured, toast, reload } = useStore();
  const ids = { tool: useId(), prompt: useId(), reply: useId() };
  const [toolId, setToolId] = useState<ToolId>('tone');
  const [options, setOptions] = useState<Record<string, string>>({ tone: 'neutral', language: '' });
  const [picks, setPicks] = useState<SourcePick[]>([]);
  const [edited, setEdited] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyState>(IDLE_REPLY);
  const [features, setFeatures] = useState<ApiFeature[] | null>(null);
  const senderRef = useRef<DraftSender | null>(null);
  const diagId = useId();
  const [errorInput, setErrorInput] = useState('');
  const [diagnosis, setDiagnosis] = useState<Diagnosis | null>(null);
  const reduced = useReducedMotion(settings?.reduceMotion ?? false);
  const tool = toolById(toolId) ?? TOOLS[0];
  const toneIds = { prompt: useId() };
  const [toneRaw, setToneRaw] = usePref<ToneChoice>(TONE_PROFILE_PREF_KEY, { ...DEFAULT_TONE_CHOICE });
  const toneChoice = normalizeToneChoice(toneRaw);
  const [toneReply, setToneReply] = useState<ReplyState>(IDLE_REPLY);
  const [toneSent, setToneSent] = useState<{ original: string; profile: ToneProfile; source: 'text' | 'selection' } | null>(null);

  useEffect(() => {
    let live = true;
    if (!api.getApiInfo) { setFeatures([]); return; }
    api.getApiInfo().then((info) => { if (live) setFeatures(info.features); }, () => { if (live) setFeatures([]); });
    return () => { live = false; };
  }, [api]);
  const streamingOn = features?.some((f) => f.id === 'chat-streaming' && f.available) === true;

  const candidates = useMemo(() => (state ? listSourceCandidates(state, productivity, input.noteId ? { kind: 'note', id: input.noteId } : undefined) : []), [state, productivity, input.noteId]);
  const { sources, missing } = useMemo(() => (state ? collectSources(picks, state, productivity) : { sources: [], missing: [] }), [picks, state, productivity]);
  const draft = useMemo(() => buildPrompt(toolId, { ...input, options }, sources), [toolId, input, options, sources]);
  const promptText = edited ?? draft.text;
  const promptOk = edited === null ? draft.ok : edited.trim().length > 0 && edited.length <= PROMPT_LIMITS.promptChars;
  const busy = reply.status === 'sending' || reply.status === 'streaming' || reply.status === 'stopping';
  const route = describeRoute(settings, cloudConfigured);
  const routeReady = settings !== null && (route.route === 'local' || route.route === 'cloud');

  const tone = useMemo((): { ok: true; value: TonePrompt } | { ok: false; error: string } => {
    try {
      return { ok: true, value: buildTonePrompt(input.text, { profileId: toneChoice.profileId, language: toneChoice.language, selection: input.selection }) };
    } catch (e) {
      return { ok: false, error: errorText(e, 'The tone prompt could not be built.') };
    }
  }, [input.text, input.selection, toneChoice.profileId, toneChoice.language]);
  const toneProfile = TONE_PROFILES.find((p) => p.id === toneChoice.profileId) ?? TONE_PROFILES[0];
  const toneBusy = toneReply.status === 'sending' || toneReply.status === 'streaming' || toneReply.status === 'stopping';
  const toneCheck = useMemo(
    () => (toneSent && toneReply.status === 'done' && toneReply.text ? checkRewrite(toneSent.original, toneReply.text, toneSent.profile) : null),
    [toneSent, toneReply.status, toneReply.text],
  );
  const toneSend = async () => {
    if (!tone.ok || busy || toneBusy || !routeReady) return;
    const snapshot = { original: tone.value.original, profile: tone.value.profile, source: tone.value.source };
    setToneSent(snapshot);
    const sender = createDraftSender(api, { streaming: streamingOn });
    senderRef.current = sender;
    try {
      await sender.send(tone.value.prompt, setToneReply);
    } catch (e) {
      setToneReply({ ...IDLE_REPLY, status: 'error', error: errorText(e, 'The assistant could not reply.') });
    } finally {
      senderRef.current = null;
      void reload().catch(() => undefined);
    }
  };

  const send = async () => {
    if (!promptOk || busy || toneBusy || !routeReady) return;
    const sender = createDraftSender(api, { streaming: streamingOn });
    senderRef.current = sender;
    try {
      await sender.send(promptText, setReply);
    } catch (e) {
      setReply({ ...IDLE_REPLY, status: 'error', error: errorText(e, 'The assistant could not reply.') });
    } finally {
      senderRef.current = null;
      void reload().catch(() => undefined);
    }
  };
  const stop = async () => {
    try { await senderRef.current?.cancel(); } catch (e) { toast('error', errorText(e, 'The reply could not be stopped.')); }
  };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast('ok', `${what} copied.`); } catch { toast('error', 'Copying was blocked. Select the text and copy it manually.'); }
  };
  const addPick = (value: string) => {
    const [kind, id] = value.split(':', 2) as [SourcePick['kind'], string];
    if (!kind || !id || picks.length >= PROMPT_LIMITS.sources || picks.some((p) => p.kind === kind && p.id === id)) return;
    setPicks([...picks, { kind, id }]);
    setEdited(null);
  };
  const removePick = (p: SourcePick) => { setPicks(picks.filter((x) => !(x.kind === p.kind && x.id === p.id))); setEdited(null); };
  const chooseTool = (id: ToolId) => { setToolId(id); setEdited(null); };

  return (
    <div className="stack" data-prompt-tools>
      <Panel title="Draft tools" eyebrow="Assistant">
        <p className="sub">Pick a tool and any sources, review the exact prompt, then press Send. Nothing is sent until you do, and the reply is shown exactly as the assistant returned it.</p>
        <Field label="Tool" hint={tool.description}>
          {(id) => (
            <select id={id} className="input" value={toolId} onChange={(e) => chooseTool(e.target.value as ToolId)} disabled={busy}>
              {TOOLS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          )}
        </Field>
        {tool.id === 'translate' && (
          <Field label="Target language" hint={`Letters only, up to ${PROMPT_LIMITS.languageChars} characters.`}>
            {(id) => (
              <>
                <input id={id} className="input" list={`${id}-langs`} value={options.language ?? ''} onChange={(e) => { setOptions({ ...options, language: e.target.value.slice(0, PROMPT_LIMITS.languageChars) }); setEdited(null); }} disabled={busy} placeholder="e.g. Hindi" />
                <datalist id={`${id}-langs`}>{LANGUAGE_SUGGESTIONS.map((l) => <option key={l} value={l} />)}</datalist>
              </>
            )}
          </Field>
        )}
        {tool.options.map((o) => (
          <Field key={o.key} label={o.label}>
            {(id) => (
              <select id={id} className="input" value={options[o.key] ?? o.values[0]?.value} onChange={(e) => { setOptions({ ...options, [o.key]: e.target.value }); setEdited(null); }} disabled={busy}>
                {o.values.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            )}
          </Field>
        ))}
        <Field label={`Sources (${picks.length}/${PROMPT_LIMITS.sources})`} hint="Only records saved in this app: notes, tasks and checkpoints. Each is cited by its real id.">
          {(id) => (
            <select id={id} className="input" value="" onChange={(e) => addPick(e.target.value)} disabled={busy || picks.length >= PROMPT_LIMITS.sources || candidates.length === 0}>
              <option value="">{candidates.length ? 'Add a source…' : 'No notes, tasks or checkpoints to attach'}</option>
              {candidates.map((c) => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.title} — {c.hint}</option>)}
            </select>
          )}
        </Field>
        {sources.length > 0 && (
          <ul className="list compact" aria-label="Attached sources">
            {sources.map((s) => (
              <li key={`${s.kind}:${s.id}`} className="list-row">
                <span className="grow"><Badge tone="info">{s.kind}</Badge> {s.title} <span className="sub mono">[{s.kind}:{s.id}]</span>{s.truncated && <Badge tone="warn">cut</Badge>}</span>
                <Button size="sm" icon={Trash} onClick={() => removePick(s)} disabled={busy} aria-label={`Remove source ${s.title}`}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && (
          <Notice tone="warn" title="Some chosen sources no longer exist" action={<Button size="sm" onClick={() => { setPicks(picks.filter((p) => !missing.some((m) => m.kind === p.kind && m.id === p.id))); setEdited(null); }}>Drop them</Button>}>
            {missing.map((m) => `${m.kind} ${m.id}`).join(', ')} were deleted after you picked them. They are not in the prompt.
          </Notice>
        )}
      </Panel>

      <Panel title="Exact prompt" eyebrow="Review before sending" actions={edited !== null ? <Button size="sm" onClick={() => setEdited(null)}>Reset to generated</Button> : null}>
        {draft.warnings.map((w) => <p key={w} className="sub" role="status"><Warning aria-hidden size={14} /> {w}</p>)}
        {!draft.ok && edited === null ? (
          <p className="sub" role="status">{draft.reason}</p>
        ) : (
          <>
            <label htmlFor={ids.prompt} className="sr-only">Prompt text</label>
            <textarea id={ids.prompt} className="input mono" rows={10} value={promptText} onChange={(e) => setEdited(e.target.value.slice(0, PROMPT_LIMITS.promptChars))} disabled={busy} spellCheck={false} />
            <p className="field-hint">{promptText.length.toLocaleString()} / {PROMPT_LIMITS.promptChars.toLocaleString()} characters{edited !== null ? ' · edited by you' : ''}{draft.citations.length ? ` · cites ${draft.citations.map((c) => `${c.kind}:${c.id}`).join(', ')}` : ''}</p>
          </>
        )}
        <p className="sub">{route.text}</p>
        <div className="row">
          <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void send()} disabled={!promptOk || busy || toneBusy || !routeReady} busy={reply.status === 'sending'}>Send to assistant</Button>
          {busy && streamingOn && <Button icon={Stop} onClick={() => void stop()} disabled={reply.status === 'stopping' || reply.status === 'sending'}>{reply.status === 'stopping' ? 'Stopping…' : 'Stop'}</Button>}
          <Button icon={Copy} onClick={() => void copy(promptText, 'Prompt')} disabled={!promptText}>Copy prompt</Button>
        </div>
      </Panel>

      <Panel title="Reply" eyebrow={reply.route ? (reply.route === 'cloud' ? 'From your cloud model' : 'From the local model') : 'Nothing sent yet'}>
        <div id={ids.reply} role="status" aria-live="polite" aria-busy={busy}>
          {reply.status === 'idle' && <p className="sub">The reply appears here. It is also stored in the chat history like any assistant message.</p>}
          {reply.status === 'sending' && <p className="sub">Sending…</p>}
          {reply.status === 'error' && <Notice tone="danger" title="No reply">{reply.error}</Notice>}
          {(reply.status === 'streaming' || reply.status === 'stopping' || reply.status === 'done') && (
            <>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{reply.text}{reply.status !== 'done' && <span aria-hidden data-cursor={reduced ? 'static' : 'blink'}>▍</span>}</pre>
              {reply.status === 'done' && <p className="field-hint">{OUTCOME_TEXT[reply.outcome ?? 'complete']}{reply.cut ? ' The panel shows the first part only; the full reply is in the chat history.' : ''}</p>}
            </>
          )}
        </div>
        {reply.status === 'done' && reply.text && (
          <div className="row">
            <Button icon={Copy} onClick={() => void copy(reply.text, 'Reply')}>Copy reply</Button>
            {onInsert && <Button icon={ArrowLineDown} onClick={() => onInsert(reply.text, 'append')}>Append to draft</Button>}
            {onInsert && input.selection && tool.id !== 'explain' && <Button onClick={() => onInsert(reply.text, 'replace-selection')}>Replace selection</Button>}
            <Button variant="quiet" onClick={() => setReply(IDLE_REPLY)}>Clear</Button>
          </div>
        )}
      </Panel>

      <Panel title="Tone and translation" eyebrow="App-specific writing" actions={toneReply.status !== 'idle' && !toneBusy ? <Button size="sm" variant="quiet" onClick={() => { setToneReply(IDLE_REPLY); setToneSent(null); }}>Clear</Button> : null}>
        <div data-tone-translate className="stack">
          <p className="sub">Pick where the text is going and an optional language. The exact prompt is shown below; nothing is sent until you press Send, and the reply is checked against your text before you insert it.</p>
          <Field label="Target app">
            {(id) => (
              <select id={id} className="input" value={toneChoice.profileId} onChange={(e) => setToneRaw(normalizeToneChoice({ ...toneChoice, profileId: e.target.value }))} disabled={toneBusy}>
                {TONE_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Language">
            {(id) => (
              <select id={id} className="input" value={toneChoice.language} onChange={(e) => setToneRaw(normalizeToneChoice({ ...toneChoice, language: e.target.value }))} disabled={toneBusy}>
                {TARGET_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.code === 'keep' ? l.label : `${l.label} (${l.code})`}</option>)}
              </select>
            )}
          </Field>
          <ul className="list compact" aria-label={`${toneProfile.label} rules`}>
            {toneProfile.rules.map((r) => <li key={r} className="list-row">{r}</li>)}
            <li className="list-row sub">At most {toneProfile.maxChars.toLocaleString()} characters · {toneProfile.keepLineBreaks ? 'line breaks kept' : 'line breaks may be merged'}</li>
          </ul>
          {tone.ok ? (
            <>
              <label htmlFor={toneIds.prompt} className="sr-only">Tone prompt text</label>
              <textarea id={toneIds.prompt} className="input mono" rows={8} value={tone.value.prompt} readOnly spellCheck={false} />
              <p className="field-hint">{tone.value.chars.toLocaleString()} / {PROMPT_LIMITS.promptChars.toLocaleString()} characters · uses the {tone.value.source === 'selection' ? 'selected passage' : 'whole draft'}</p>
            </>
          ) : (
            <p className="sub" role="status">{tone.error}</p>
          )}
          <p className="sub">{route.text}</p>
          <div className="row">
            <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void toneSend()} disabled={!tone.ok || busy || toneBusy || !routeReady} busy={toneReply.status === 'sending'}>Send to assistant</Button>
            {toneBusy && streamingOn && <Button icon={Stop} onClick={() => void stop()} disabled={toneReply.status === 'stopping' || toneReply.status === 'sending'}>{toneReply.status === 'stopping' ? 'Stopping…' : 'Stop'}</Button>}
            <Button icon={Copy} onClick={() => tone.ok && void copy(tone.value.prompt, 'Prompt')} disabled={!tone.ok}>Copy prompt</Button>
          </div>
          <div role="status" aria-live="polite" aria-busy={toneBusy}>
            {toneReply.status === 'sending' && <p className="sub">Sending…</p>}
            {toneReply.status === 'error' && <Notice tone="danger" title="No reply">{toneReply.error}</Notice>}
            {(toneReply.status === 'streaming' || toneReply.status === 'stopping' || toneReply.status === 'done') && (
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{toneReply.text}</pre>
            )}
            {toneReply.status === 'done' && <p className="field-hint">{OUTCOME_TEXT[toneReply.outcome ?? 'complete']}</p>}
            {toneCheck && (
              <div data-tone-check>
                <p className="sub">{toneCheck.ok ? `Check passed (length ratio ${toneCheck.lengthRatio.toFixed(2)}).` : `Check found ${toneCheck.problems.length} problem${toneCheck.problems.length === 1 ? '' : 's'} (length ratio ${toneCheck.lengthRatio.toFixed(2)}):`}</p>
                {toneCheck.problems.length > 0 && (
                  <ul className="list compact" aria-label="Rewrite check problems">
                    {toneCheck.problems.map((p) => <li key={p} className="list-row">{p}</li>)}
                  </ul>
                )}
                {toneCheck.missingTokens.length > 0 && (
                  <ul className="list compact" aria-label="Missing protected items">
                    {toneCheck.missingTokens.map((t) => <li key={t} className="list-row mono">{t}</li>)}
                  </ul>
                )}
              </div>
            )}
          </div>
          {toneReply.status === 'done' && toneReply.text && (
            <div className="row">
              <Button icon={Copy} onClick={() => void copy(toneReply.text, 'Reply')}>Copy reply</Button>
              {onInsert && (
                <Button icon={ArrowLineDown} onClick={() => onInsert(toneReply.text, toneSent?.source === 'selection' && input.selection ? 'replace-selection' : 'append')}>
                  {toneCheck && !toneCheck.ok ? `Check found ${toneCheck.problems.length} problem${toneCheck.problems.length === 1 ? '' : 's'} · ` : ''}{toneSent?.source === 'selection' && input.selection ? 'Replace selection' : 'Append to draft'}
                </Button>
              )}
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Diagnose error" eyebrow="Offline rules" actions={diagnosis ? <Button size="sm" variant="quiet" onClick={() => setDiagnosis(null)}>Clear</Button> : null}>
        <p className="sub">Paste an error message or stack trace. It is checked against a small set of built-in rules on this device: no model is asked, nothing is sent, and nothing is run. Paths are only listed, never opened automatically.</p>
        <label htmlFor={diagId} className="sr-only">Error text</label>
        <textarea id={diagId} className="input mono" rows={6} value={errorInput} onChange={(e) => setErrorInput(e.target.value)} spellCheck={false} placeholder="e.g. Error: Cannot find module 'left-pad'" />
        <div className="row">
          <Button variant="primary" onClick={() => setDiagnosis(diagnoseErrorText(errorInput))} disabled={!errorInput.trim()}>Diagnose</Button>
        </div>
        {diagnosis && (
          <div role="status" aria-live="polite" data-error-diagnosis>
            <p className="sub">{diagnosis.summary}</p>
            {diagnosis.truncated && <p className="sub"><Warning aria-hidden size={14} /> Only the first 20,000 characters were checked.</p>}
            {diagnosis.matches.length > 0 && (
              <ul className="list compact" aria-label="Diagnosis results">
                {diagnosis.matches.map((m) => (
                  <li key={m.code} className="list-row">
                    <span className="grow"><strong>{m.title}</strong> <Badge tone={m.confidence === 'high' ? 'ok' : m.confidence === 'medium' ? 'info' : 'warn'}>{m.confidence} confidence</Badge><br /><span className="sub">{m.explanation}</span></span>
                  </li>
                ))}
              </ul>
            )}
            {diagnosis.locations.length > 0 && (
              <ul className="list compact" aria-label="Referenced locations">
                {diagnosis.locations.map((l) => <li key={`${l.path}:${l.line}:${l.column ?? ''}`} className="list-row mono">{l.path}:{l.line}{l.column !== null ? `:${l.column}` : ''}</li>)}
              </ul>
            )}
            {diagnosis.proposedActions.length > 0 && (
              <>
                <h4>Proposed actions (preview)</h4>
                <ul className="list compact" aria-label="Proposed actions (preview)">
                  {diagnosis.proposedActions.map((a: ProposedAction) => (
                    <li key={a.id} className="list-row">
                      <span className="grow"><Badge tone="info">{a.kind}</Badge> {a.label} <span className="sub mono">{a.target}</span></span>
                      {a.kind === 'copy-text'
                        ? <Button size="sm" icon={Copy} onClick={() => void copy(a.target, 'Text')} aria-label={`${a.label}: ${a.target}`}>Copy</Button>
                        : <Button size="sm" disabled aria-label={`${a.label}: not available in this build`}>Not available in this build</Button>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
