import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PaperPlaneTilt, Stop, Copy, ArrowLineDown, Trash, Warning } from '@phosphor-icons/react';
import type { ActionPreview, ApiFeature } from '../shared/contracts';
import { Badge, Button, Field, Notice, Panel } from '../ui/primitives';
import { useStore } from '../ui/store';
import { useReducedMotion } from '../ui/workbench';
import {
  IDLE_REPLY, LANGUAGE_SUGGESTIONS, PROMPT_LIMITS, TOOLS, buildPrompt, collectSources, createDraftSender, describeRoute, errorText, listSourceCandidates, toolById,
  type DraftSender, type PromptInput, type ReplyState, type SourcePick, type ToolId,
} from '../ui/prompt-tools';
import { diagnoseErrorText, diagnosisActionToRequest, type Diagnosis, type ProposedAction } from '../ui/error-diagnosis';

/** One proposed path action going through previewAction → explicit Confirm → executeAction(previewId, true). */
type DiagActionState = { actionId: string; status: 'previewing' | 'ready' | 'denied' | 'executing' | 'done' | 'failed'; preview?: ActionPreview; message?: string };
import { usePref } from '../ui/prefs';
import {
  DEFAULT_TONE_CHOICE, TARGET_LANGUAGES, TONE_PROFILES, TONE_PROFILE_PREF_KEY, buildTonePrompt, checkRewrite, normalizeToneChoice,
  type ToneChoice, type TonePrompt, type ToneProfile,
} from '../ui/tone-profiles';
import {
  EXPLAIN_LIMITS, EXPLAIN_MODES, EXPLAIN_QUESTION_CHARS, approveDocument, buildExplainPrompt, chunkDocument, fingerprintText, isApprovalCurrent, scanSensitive,
  EXPLAIN_AI_LIMITS, EXPLAIN_DEPTHS, buildExplainRequest, describeDestination as describeExplainDestination, runDocumentExplain,
  type DocumentApproval, type SensitiveScan, type ExplainChatApi, type ExplainDepth, type ExplainRequest, type ExplainResult,
} from '../ui/document-explain';
import {
  WRITING_ACTIONS, WRITING_AI_LIMITS, buildWritingRequest, describeDestination, runWritingAction,
  type WritingAction, type WritingChatApi, type WritingRequest, type WritingResult,
} from '../ui/ai-writing';

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
  const [diagnosis, setDiagnosisRaw] = useState<Diagnosis | null>(null);
  const [diagAction, setDiagAction] = useState<DiagActionState | null>(null);
  const setDiagnosis = (d: Diagnosis | null) => { setDiagnosisRaw(d); setDiagAction(null); };
  const reduced = useReducedMotion(settings?.reduceMotion ?? false);
  const tool = toolById(toolId) ?? TOOLS[0];
  const toneIds = { prompt: useId() };
  const [toneRaw, setToneRaw] = usePref<ToneChoice>(TONE_PROFILE_PREF_KEY, { ...DEFAULT_TONE_CHOICE });
  const toneChoice = normalizeToneChoice(toneRaw);
  const [toneReply, setToneReply] = useState<ReplyState>(IDLE_REPLY);
  const [toneSent, setToneSent] = useState<{ original: string; profile: ToneProfile; source: 'text' | 'selection' } | null>(null);
  const docIds = { title: useId(), text: useId(), prompt: useId() };
  const [docTitle, setDocTitle] = useState('');
  const [docText, setDocText] = useState('');
  const [docScan, setDocScan] = useState<{ scan: SensitiveScan; fingerprint: string } | null>(null);
  const [docApproval, setDocApproval] = useState<DocumentApproval | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [docMode, setDocMode] = useState<string>(EXPLAIN_MODES[0].id);
  const [docQuestion, setDocQuestion] = useState('');
  const [docChunk, setDocChunk] = useState(0);
  const [docReply, setDocReply] = useState<ReplyState>(IDLE_REPLY);
  const docBusy = docReply.status === 'sending' || docReply.status === 'streaming' || docReply.status === 'stopping';
  const aiIds = { prompt: useId(), whole: useId() };
  const [aiAction, setAiAction] = useState<WritingAction>('rewrite');
  const [aiWhole, setAiWhole] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiPartial, setAiPartial] = useState('');
  const [aiResult, setAiResult] = useState<(WritingResult & { from: 'selection' | 'text' }) | null>(null);
  const [aiKeyMissing, setAiKeyMissing] = useState(false);
  const aiAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { aiAbortRef.current?.abort(); }, []);
  const exIds = { prompt: useId() };
  const [exDepth, setExDepth] = useState<ExplainDepth>('summary');
  const [exQuestion, setExQuestion] = useState('');
  const [exBusy, setExBusy] = useState(false);
  const [exPartial, setExPartial] = useState('');
  const [exResult, setExResult] = useState<ExplainResult | null>(null);
  const [exKeyMissing, setExKeyMissing] = useState(false);
  const exAbortRef = useRef<AbortController | null>(null);
  const exRunningRef = useRef(false);
  useEffect(() => () => { exAbortRef.current?.abort(); }, []);

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
    if (!tone.ok || busy || toneBusy || docBusy || aiBusy || !routeReady) return;
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

  // Run with AI: only the user's selection (or, on explicit toggle, the bounded whole draft) goes through the guarded chat route.
  const aiMode: 'offline' | 'online' = settings?.mode === 'online' ? 'online' : 'offline';
  const aiDest = describeDestination(aiMode);
  const aiFrom: 'selection' | 'text' = aiWhole ? 'text' : 'selection';
  const aiSourceText = aiWhole ? input.text : (input.selection ?? '');
  const aiRequest = useMemo((): { ok: true; value: WritingRequest } | { ok: false; error: string } => {
    if (!aiSourceText.trim()) return { ok: false, error: aiWhole ? 'The draft is empty.' : 'Select some text in the editor first, or tick “Use the whole draft”.' };
    try {
      const lang = toneChoice.language === 'keep' ? undefined : toneChoice.language;
      return { ok: true, value: buildWritingRequest({ action: aiAction, text: aiSourceText, toneProfileId: toneChoice.profileId, targetLanguage: lang }) };
    } catch (e) {
      return { ok: false, error: errorText(e, 'The request could not be built.') };
    }
  }, [aiSourceText, aiWhole, aiAction, toneChoice.profileId, toneChoice.language]);
  const aiKeyBlocked = aiMode === 'online' && (aiKeyMissing || cloudConfigured === false);
  const aiRun = async () => {
    if (!aiRequest.ok || aiBusy || busy || toneBusy || docBusy || settings === null) return;
    setAiKeyMissing(false);
    setAiResult(null);
    if (aiMode === 'online') {
      try {
        const status = await api.cloudKeyStatus();
        if (!status.configured) { setAiKeyMissing(true); return; }
      } catch (e) {
        setAiResult({ outcome: 'failed', text: '', source: 'system', error: `Could not check the cloud key status; nothing was sent. ${errorText(e, '')}`.trim(), from: aiFrom });
        return;
      }
    }
    const ac = new AbortController();
    aiAbortRef.current = ac;
    const from = aiFrom;
    const chatApi: WritingChatApi = streamingOn ? api : { chat: (text: string) => api.chat(text) };
    setAiBusy(true);
    setAiPartial('');
    try {
      const result = await runWritingAction(chatApi, aiRequest.value, { signal: ac.signal, onDelta: (_d, soFar) => setAiPartial(soFar.slice(0, WRITING_AI_LIMITS.replyChars)) });
      if (aiAbortRef.current === ac || ac.signal.aborted) setAiResult({ ...result, from });
    } finally {
      if (aiAbortRef.current === ac) aiAbortRef.current = null;
      setAiBusy(false);
      void reload().catch(() => undefined);
    }
  };
  const aiCancel = () => { aiAbortRef.current?.abort(); };

  const send = async () => {
    if (!promptOk || busy || toneBusy || docBusy || !routeReady) return;
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
  const docCurrent = docApproval !== null && isApprovalCurrent(docApproval, docText);
  const docStale = docApproval !== null && !docCurrent;
  const docChunks = useMemo(() => {
    if (!docCurrent) return [];
    try { return chunkDocument(docText); } catch { return []; }
  }, [docCurrent, docText]);
  const docPrompt = useMemo((): { ok: true; text: string } | { ok: false; error: string } => {
    if (!docApproval || !docCurrent) return { ok: false, error: 'Approve the document first.' };
    try {
      return { ok: true, text: buildExplainPrompt({ approval: docApproval, text: docText, chunk: docChunk, mode: docMode, question: docQuestion }) };
    } catch (e) {
      return { ok: false, error: errorText(e, 'The explain prompt could not be built.') };
    }
  }, [docApproval, docCurrent, docText, docChunk, docMode, docQuestion]);
  const docEditText = (value: string) => {
    // Paste only: normalise line endings and drop control characters the chat route would refuse.
    // eslint-disable-next-line no-control-regex
    setDocText(value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''));
    setDocScan(null);
    setDocError(null);
  };
  const docRunScan = () => {
    setDocError(null);
    try {
      chunkDocument(docText);
      setDocScan({ scan: scanSensitive(docText), fingerprint: fingerprintText(docText) });
    } catch (e) {
      setDocScan(null);
      setDocError(errorText(e, 'The document could not be scanned.'));
    }
  };
  const docApprove = () => {
    if (!docScan || docScan.fingerprint !== fingerprintText(docText)) { setDocScan(null); return; }
    try {
      setDocApproval(approveDocument({ title: docTitle, text: docText, now: Date.now() }));
      setDocChunk(0);
      setDocScan(null);
      setDocError(null);
    } catch (e) {
      setDocError(errorText(e, 'The document could not be approved.'));
    }
  };
  const docSend = async () => {
    if (!docPrompt.ok || !docCurrent || busy || toneBusy || docBusy || !routeReady) return;
    const sender = createDraftSender(api, { streaming: streamingOn });
    senderRef.current = sender;
    try {
      await sender.send(docPrompt.text, setDocReply);
    } catch (e) {
      setDocReply({ ...IDLE_REPLY, status: 'error', error: errorText(e, 'The assistant could not reply.') });
    } finally {
      senderRef.current = null;
      void reload().catch(() => undefined);
    }
  };

  // Explain with AI: only the editor selection (or, when nothing is selected, the note body) passed in as `input` is sent.
  const exMode: 'offline' | 'online' = settings?.mode === 'online' ? 'online' : 'offline';
  const exDest = describeExplainDestination(exMode);
  const exRequest = useMemo((): { ok: true; value: ExplainRequest } | { ok: false; error: string } => {
    try {
      return { ok: true, value: buildExplainRequest(input.text, { depth: exDepth, question: exQuestion, noteTitle: input.noteTitle ?? null, selection: input.selection ?? null }) };
    } catch (e) {
      return { ok: false, error: errorText(e, 'The explanation request could not be built.') };
    }
  }, [input.text, input.selection, input.noteTitle, exDepth, exQuestion]);
  const exKeyBlocked = exMode === 'online' && (exKeyMissing || cloudConfigured === false);
  const exRun = async () => {
    if (!exRequest.ok || exRunningRef.current || exBusy || busy || toneBusy || docBusy || aiBusy || settings === null) return;
    exRunningRef.current = true;
    const request = exRequest.value;
    setExKeyMissing(false);
    setExResult(null);
    setExPartial('');
    setExBusy(true);
    const ac = new AbortController();
    exAbortRef.current = ac;
    try {
      if (exDest.requiresConfirmation && typeof api.cloudKeyStatus === 'function') {
        try {
          const status = await api.cloudKeyStatus();
          if (!status.configured) { setExKeyMissing(true); return; }
        } catch (e) {
          setExResult({ status: 'failed', text: '', source: 'system', reason: `Could not check the cloud key status; nothing was sent. ${errorText(e, '')}`.trim() });
          return;
        }
        if (ac.signal.aborted) { setExResult({ status: 'cancelled', text: '', source: 'system', reason: 'Cancelled before sending.' }); return; }
      }
      const chatApi: ExplainChatApi = streamingOn ? api : { chat: (text: string) => api.chat(text) };
      const result = await runDocumentExplain(chatApi, request, { signal: ac.signal, onDelta: (_d, soFar) => setExPartial(soFar.slice(0, EXPLAIN_AI_LIMITS.replyChars)) });
      setExResult(result);
      void reload().catch(() => undefined);
    } finally {
      if (exAbortRef.current === ac) exAbortRef.current = null;
      exRunningRef.current = false;
      setExBusy(false);
    }
  };
  const exCancel = () => { exAbortRef.current?.abort(); };

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
  // Diagnosis path actions: the main process checks the exact path against the allowed folders; nothing opens until the
  // user presses Confirm here (and answers the app's native confirmation). The browser preview bridge has no previewAction.
  const canPreviewActions = typeof api.previewAction === 'function' && typeof api.executeAction === 'function';
  const diagActionBusy = diagAction?.status === 'previewing' || diagAction?.status === 'executing';
  const previewDiagAction = async (a: ProposedAction) => {
    const req = diagnosisActionToRequest(a);
    if (!req || !canPreviewActions || diagActionBusy) return;
    setDiagAction({ actionId: a.id, status: 'previewing' });
    try {
      const p = await api.previewAction(req);
      setDiagAction(p.allowed ? { actionId: a.id, status: 'ready', preview: p } : { actionId: a.id, status: 'denied', preview: p, message: p.reason ?? 'Not allowed.' });
    } catch (e) {
      setDiagAction({ actionId: a.id, status: 'failed', message: errorText(e, 'The preview could not be created.') });
    }
  };
  const confirmDiagAction = async () => {
    const cur = diagAction;
    if (!cur?.preview || cur.status !== 'ready') return;
    setDiagAction({ ...cur, status: 'executing' });
    try {
      const r = (await api.executeAction(cur.preview.id, true)) as { executed?: boolean; reason?: string } | null;
      if (r && r.executed === true) setDiagAction({ ...cur, status: 'done', message: 'Done.' });
      else setDiagAction({ ...cur, status: 'failed', message: r?.reason ?? 'The action did not run.' });
    } catch (e) {
      setDiagAction({ ...cur, status: 'failed', message: errorText(e, 'The action failed.') });
    } finally {
      void reload().catch(() => undefined);
    }
  };
  const cancelDiagAction = async () => {
    const cur = diagAction;
    setDiagAction(null);
    // Discard the single-use preview so it can never be executed later.
    if (cur?.preview && cur.status === 'ready') { try { await api.executeAction(cur.preview.id, false); } catch { /* preview already gone */ } }
  };
  // Same hash route format as nav.tsx hashFor('settings'); the app shell switches views on hash changes.
  const openSettingsView = () => { window.location.hash = '#/settings'; };
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
          <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void send()} disabled={!promptOk || busy || toneBusy || docBusy || !routeReady} busy={reply.status === 'sending'}>Send to assistant</Button>
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
            <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void toneSend()} disabled={!tone.ok || busy || toneBusy || docBusy || !routeReady} busy={toneReply.status === 'sending'}>Send to assistant</Button>
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
          <div data-ai-writing className="stack">
            <h3>Run with AI</h3>
            <p className="sub">Rewrite, summarize or translate only the text you selected, using the target app and language above. You see exactly what will be sent; nothing is sent until you press the button. No clipboard, screen or other window content is read.</p>
            <Field label="Action">
              {(id) => (
                <select id={id} className="input" value={aiAction} onChange={(e) => setAiAction(e.target.value as WritingAction)} disabled={aiBusy}>
                  {WRITING_ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                </select>
              )}
            </Field>
            <label htmlFor={aiIds.whole} className="row">
              <input id={aiIds.whole} type="checkbox" checked={aiWhole} onChange={(e) => setAiWhole(e.target.checked)} disabled={aiBusy} />
              <span>Use the whole draft instead of the selection (first {WRITING_AI_LIMITS.selectionChars.toLocaleString()} characters)</span>
            </label>
            {aiRequest.ok ? (
              <div data-ai-preview>
                <p className="sub"><strong>What will be sent</strong> to the {aiDest.label}: {aiRequest.value.sentChars.toLocaleString()} characters of your {aiFrom === 'selection' ? 'selection' : 'draft'} · {aiRequest.value.promptChars.toLocaleString()} characters in total.</p>
                {aiRequest.value.warnings.map((w) => <p key={w} className="sub" role="status"><Warning aria-hidden size={14} /> {w}</p>)}
                <label htmlFor={aiIds.prompt} className="sr-only">Exact text that will be sent</label>
                <textarea id={aiIds.prompt} className="input mono" rows={8} value={aiRequest.value.preview} readOnly spellCheck={false} />
              </div>
            ) : (
              <p className="sub" role="status">{aiRequest.error}</p>
            )}
            {aiKeyBlocked && <Notice tone="warn" title="No cloud key">Add your key in Settings, or switch to offline mode. Nothing was sent.</Notice>}
            <p className="field-hint">The exchange is recorded in the Assistant conversation history because it goes through chat; recent chat history is sent along as context.</p>
            <div className="row">
              {aiMode === 'online' ? (
                <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void aiRun()} disabled={!aiRequest.ok || aiBusy || busy || toneBusy || docBusy || settings === null || cloudConfigured === false} busy={aiBusy}>Send to Anthropic cloud</Button>
              ) : (
                <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void aiRun()} disabled={!aiRequest.ok || aiBusy || busy || toneBusy || docBusy || settings === null} busy={aiBusy}>Run locally</Button>
              )}
              {aiBusy && <Button icon={Stop} onClick={aiCancel}>Cancel</Button>}
            </div>
            <div role="status" aria-live="polite" aria-busy={aiBusy}>
              {aiBusy && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{aiPartial || 'Working…'}</pre>}
              {!aiBusy && aiResult && (
                <>
                  {aiResult.error && <Notice tone={aiResult.outcome === 'cancelled' ? 'warn' : 'danger'} title={aiResult.outcome === 'cancelled' ? 'Cancelled' : 'No usable reply'}>{aiResult.error}</Notice>}
                  {aiResult.text && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{aiResult.text}</pre>}
                  <p className="field-hint">{OUTCOME_TEXT[aiResult.outcome] ?? ''}{aiResult.source !== 'system' ? ` From the ${aiResult.source === 'cloud' ? 'Anthropic cloud' : 'local model'}.` : ''}</p>
                </>
              )}
            </div>
            {!aiBusy && aiResult?.text && (
              <div className="row">
                {onInsert && aiResult.from === 'selection' && input.selection && <Button icon={ArrowLineDown} onClick={() => onInsert(aiResult.text, 'replace-selection')}>Replace selection</Button>}
                {onInsert && <Button onClick={() => onInsert(aiResult.text, 'append')}>Append</Button>}
                <Button icon={Copy} onClick={() => void copy(aiResult.text, 'Result')}>Copy result</Button>
                <Button variant="quiet" onClick={() => setAiResult(null)}>Discard</Button>
              </div>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="Explain an approved document" eyebrow="Pasted text only" actions={docReply.status !== 'idle' && !docBusy ? <Button size="sm" variant="quiet" onClick={() => setDocReply(IDLE_REPLY)}>Clear</Button> : null}>
        <div data-document-explain className="stack">
          <p className="sub">Only text you paste and approve here is sent; this build does not open files or read other windows.</p>
          <p className="sub">Paste a document, press Scan and approve, review what the scan found, then approve. Each part is sent only when you press its Send button. Editing the text afterwards cancels the approval.</p>
          <label htmlFor={docIds.title}>Document title</label>
          <input id={docIds.title} className="input" value={docTitle} maxLength={EXPLAIN_LIMITS.titleChars} onChange={(e) => { setDocTitle(e.target.value); setDocScan(null); }} disabled={docBusy} placeholder="e.g. Lease agreement" />
          <label htmlFor={docIds.text}>Document text (paste)</label>
          <textarea id={docIds.text} className="input mono" rows={8} value={docText} onChange={(e) => docEditText(e.target.value)} disabled={docBusy} spellCheck={false} />
          <p className="field-hint">{docText.length.toLocaleString()} / {EXPLAIN_LIMITS.documentChars.toLocaleString()} characters · up to {EXPLAIN_LIMITS.maxChunks} parts of {EXPLAIN_LIMITS.chunkChars.toLocaleString()} characters</p>
          <div className="row">
            <Button onClick={docRunScan} disabled={docBusy || !docText.trim() || !docTitle.trim()}>Scan and approve</Button>
          </div>
          {docError && <Notice tone="danger" title="Not approved">{docError}</Notice>}
          {docScan && (
            <div role="status" aria-live="polite" data-document-scan>
              <p className="sub">
                Scan found {docScan.scan.counts.email} email address{docScan.scan.counts.email === 1 ? '' : 'es'}, {docScan.scan.counts.url} link{docScan.scan.counts.url === 1 ? '' : 's'}, {docScan.scan.counts.secret} key or token{docScan.scan.counts.secret === 1 ? '' : 's'} and {docScan.scan.counts.longNumber} long number{docScan.scan.counts.longNumber === 1 ? '' : 's'}. {docScan.scan.total > 0 ? 'These will be sent as written if you approve.' : 'Nothing sensitive was detected by these simple checks.'}
              </p>
              {docScan.scan.samples.length > 0 && (
                <ul className="list compact" aria-label="Masked samples">
                  {docScan.scan.samples.map((s) => <li key={`${s.kind}:${s.index}`} className="list-row mono"><Badge tone="warn">{s.kind}</Badge> {s.masked}</li>)}
                </ul>
              )}
              <div className="row">
                <Button variant="primary" onClick={docApprove}>Approve this text</Button>
                <Button variant="quiet" onClick={() => setDocScan(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {docApproval && (
            <p className="sub" role="status" data-document-approval={docCurrent ? 'current' : 'stale'}>
              {docCurrent
                ? <>Approved “{docApproval.title}” · <span className="mono">{docApproval.fingerprint}</span> · {docApproval.chars.toLocaleString()} characters · {docApproval.chunkCount} part{docApproval.chunkCount === 1 ? '' : 's'} · {docApproval.approvedAt}</>
                : <><Warning aria-hidden size={14} /> The text changed after approval, so the approval no longer applies and sending is disabled. Scan and approve it again.</>}
            </p>
          )}
          <Field label="Explain as">
            {(id) => (
              <select id={id} className="input" value={docMode} onChange={(e) => setDocMode(e.target.value)} disabled={docBusy}>
                {EXPLAIN_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Question (optional)" hint={`Up to ${EXPLAIN_QUESTION_CHARS} characters.`}>
            {(id) => <input id={id} className="input" value={docQuestion} maxLength={EXPLAIN_QUESTION_CHARS} onChange={(e) => setDocQuestion(e.target.value)} disabled={docBusy} />}
          </Field>
          <Field label="Part">
            {(id) => (
              <select id={id} className="input" value={docChunk} onChange={(e) => setDocChunk(Number(e.target.value))} disabled={docBusy || docChunks.length === 0}>
                {docChunks.length === 0 && <option value={0}>Approve the document first</option>}
                {docChunks.map((c) => <option key={c.index} value={c.index}>Part {c.index + 1} of {docChunks.length} ({(c.end - c.start).toLocaleString()} characters)</option>)}
              </select>
            )}
          </Field>
          {docPrompt.ok ? (
            <>
              <label htmlFor={docIds.prompt} className="sr-only">Explain prompt text</label>
              <textarea id={docIds.prompt} className="input mono" rows={6} value={docPrompt.text} readOnly spellCheck={false} />
              <p className="field-hint">{docPrompt.text.length.toLocaleString()} characters in the exact prompt</p>
            </>
          ) : (
            docApproval && <p className="sub" role="status">{docPrompt.error}</p>
          )}
          <p className="sub">{route.text}</p>
          <div className="row">
            <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void docSend()} disabled={!docCurrent || !docPrompt.ok || busy || toneBusy || docBusy || !routeReady} busy={docReply.status === 'sending'}>Send part {docChunk + 1}</Button>
            {docBusy && streamingOn && <Button icon={Stop} onClick={() => void stop()} disabled={docReply.status === 'stopping' || docReply.status === 'sending'}>{docReply.status === 'stopping' ? 'Stopping…' : 'Stop'}</Button>}
          </div>
          <div role="status" aria-live="polite" aria-busy={docBusy}>
            {docReply.status === 'sending' && <p className="sub">Sending…</p>}
            {docReply.status === 'error' && <Notice tone="danger" title="No reply">{docReply.error}</Notice>}
            {(docReply.status === 'streaming' || docReply.status === 'stopping' || docReply.status === 'done') && (
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{docReply.text}</pre>
            )}
            {docReply.status === 'done' && <p className="field-hint">{OUTCOME_TEXT[docReply.outcome ?? 'complete']}</p>}
          </div>
          {docReply.status === 'done' && docReply.text && (
            <div className="row">
              <Button icon={Copy} onClick={() => void copy(docReply.text, 'Reply')}>Copy reply</Button>
            </div>
          )}
          <div data-document-explain-ai className="stack">
            <h3>Explain with AI</h3>
            <p className="sub">Explains only the text you selected in the editor, or the whole note when nothing is selected (first {EXPLAIN_AI_LIMITS.documentChars.toLocaleString()} characters). No clipboard, screen, file or other window content is read, and nothing is sent until you press the button.</p>
            <Field label="Depth">
              {(id) => (
                <select id={id} className="input" value={exDepth} onChange={(e) => setExDepth(e.target.value as ExplainDepth)} disabled={exBusy}>
                  {EXPLAIN_DEPTHS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              )}
            </Field>
            <Field label="Question for the explanation (optional)" hint={`Up to ${EXPLAIN_QUESTION_CHARS} characters.`}>
              {(id) => <input id={id} className="input" value={exQuestion} maxLength={EXPLAIN_QUESTION_CHARS} onChange={(e) => setExQuestion(e.target.value)} disabled={exBusy} />}
            </Field>
            {exRequest.ok ? (
              <div data-explain-preview>
                <p className="sub"><strong>What will be sent</strong> to the {exDest.label}: {exRequest.value.sentChars.toLocaleString()} characters of your {exRequest.value.source === 'selection' ? 'selection' : 'note'} · {exRequest.value.prompt.length.toLocaleString()} characters in total.</p>
                {exRequest.value.warnings.map((w) => <p key={w} className="sub" role="status"><Warning aria-hidden size={14} /> {w}</p>)}
                <label htmlFor={exIds.prompt} className="sr-only">Exact explanation prompt that will be sent</label>
                <textarea id={exIds.prompt} className="input mono" rows={8} value={exRequest.value.preview} readOnly spellCheck={false} />
              </div>
            ) : (
              <p className="sub" role="status">{exRequest.error}</p>
            )}
            {exKeyBlocked && <Notice tone="warn" title="No cloud key">Add your key in Settings, or switch to offline mode. Nothing was sent.</Notice>}
            <p className="field-hint">The exchange is recorded in the Assistant conversation history because it goes through chat.</p>
            <div className="row">
              {exDest.requiresConfirmation ? (
                <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void exRun()} disabled={!exRequest.ok || exBusy || busy || toneBusy || docBusy || aiBusy || settings === null || cloudConfigured === false} busy={exBusy}>
                  {`Send ${exRequest.ok ? exRequest.value.prompt.length.toLocaleString() : 0} characters to Anthropic cloud`}
                </Button>
              ) : (
                <Button variant="primary" icon={PaperPlaneTilt} onClick={() => void exRun()} disabled={!exRequest.ok || exBusy || busy || toneBusy || docBusy || aiBusy || settings === null} busy={exBusy}>Explain locally</Button>
              )}
              {exBusy && <Button icon={Stop} onClick={exCancel}>Cancel</Button>}
            </div>
            <div role="status" aria-live="polite" aria-busy={exBusy}>
              {exBusy && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{exPartial || 'Working…'}</pre>}
              {!exBusy && exResult && (
                <>
                  {exResult.reason && <Notice tone={exResult.status === 'cancelled' ? 'warn' : 'danger'} title={exResult.status === 'cancelled' ? 'Cancelled' : exResult.status === 'failed' ? 'Explanation failed' : 'Explanation incomplete'}>{exResult.reason}</Notice>}
                  {exResult.text && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }} data-explain-output>{exResult.text}</pre>}
                  <p className="field-hint">{OUTCOME_TEXT[exResult.status] ?? ''}{exResult.source !== 'system' ? ` From the ${exResult.source === 'cloud' ? 'Anthropic cloud' : 'local model'}.` : ''}</p>
                </>
              )}
            </div>
            {!exBusy && exResult?.text && (
              <div className="row">
                {onInsert && <Button icon={ArrowLineDown} onClick={() => onInsert(exResult.text, 'append')}>Insert into editor</Button>}
                <Button icon={Copy} onClick={() => void copy(exResult.text, 'Explanation')}>Copy</Button>
                <Button variant="quiet" onClick={() => setExResult(null)}>Discard</Button>
              </div>
            )}
          </div>
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
                        : a.kind === 'open-settings'
                          ? <Button size="sm" onClick={openSettingsView} aria-label={`${a.label}: go to Settings`}>Open Settings</Button>
                          : canPreviewActions && diagnosisActionToRequest(a)
                            ? <Button size="sm" onClick={() => void previewDiagAction(a)} disabled={diagActionBusy || diagAction?.status === 'ready'} busy={diagAction?.actionId === a.id && diagAction.status === 'previewing'} aria-label={`${a.label}: preview`}>Preview</Button>
                            : <Button size="sm" disabled aria-label={`${a.label}: not available in this build`}>Not available in this build</Button>}
                      {diagAction?.actionId === a.id && (
                        <div className="stack" data-diagnosis-action={diagAction.status} role="status" aria-live="polite">
                          {diagAction.status === 'previewing' && <p className="sub">Checking the path…</p>}
                          {diagAction.preview && diagAction.status !== 'denied' && <p className="sub"><strong>{diagAction.preview.summary}</strong></p>}
                          {diagAction.status === 'ready' && (
                            <>
                              <p className="field-hint">Nothing has opened yet. Confirm to continue; the app may also ask in a system dialog.</p>
                              <div className="row">
                                <Button size="sm" variant="primary" onClick={() => void confirmDiagAction()}>Confirm</Button>
                                <Button size="sm" variant="quiet" onClick={() => void cancelDiagAction()}>Cancel</Button>
                              </div>
                            </>
                          )}
                          {diagAction.status === 'executing' && <p className="sub">Opening…</p>}
                          {diagAction.status === 'done' && <p className="sub">{diagAction.message}</p>}
                          {diagAction.status === 'denied' && <Notice tone="warn" title="Not allowed" action={<Button size="sm" variant="quiet" onClick={() => setDiagAction(null)}>Dismiss</Button>}>{diagAction.message}</Notice>}
                          {diagAction.status === 'failed' && <Notice tone="danger" title="Did not open" action={<Button size="sm" variant="quiet" onClick={() => setDiagAction(null)}>Dismiss</Button>}>{diagAction.message}</Notice>}
                        </div>
                      )}
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
