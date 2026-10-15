import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Broom, ChatCircleDots, Lightning, MagnifyingGlass, Microphone, PaperPlaneRight, ShieldCheck, SpeakerHigh, Stop } from '@phosphor-icons/react';
import type { ActionPreview, ActionRequest, ApiFeature, ChatMessage, ChatStreamEvent, ChatStreamRoute, IntentPlan, JarvisAPI } from '../shared/contracts';
import { Avatar } from './Avatar';
import { AvatarStudio } from './AvatarStudio';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Notice, PageHeader, Panel, Segmented, Spinner, Switch } from '../ui/primitives';
import { ClipRecorder, MAX_CLIP_MS, bindLevel, createMicConsent, defaultConsentStorage, micErrorMessage, micSupport, remainingMs } from '../ui/audio';
import { actionOutcome, listedWindows, type ActionOutcome } from '../ui/action-result';
import { hostVoiceLevel, useCompanion } from '../ui/companion';
import { usePref } from '../ui/prefs';
import { useReady } from '../ui/store';
import { cx, errMsg, fmtTime, truncate } from '../ui/util';

type RecPhase = 'idle' | 'starting' | 'recording' | 'transcribing';
type ComposerMode = 'chat' | 'command';
const HOLD_MS = 400;
const MAX_CHARS = 4000;
/** Mirrors the backend planner limit (typed text limit + 200). */
export const MAX_COMMAND_CHARS = 2200;

const sourceLabel = (s: ChatMessage['source']) => (s === 'local' ? 'Local model' : s === 'cloud' ? 'Cloud model' : 'System');

/**
 * What a stored chat message is. The backend never rejects a chat for a provider problem: it stores a 'system' note
 * ("Local model unavailable: …", "Stopped by you. …", "The connection ended …") so the UI types them by their text.
 */
export type ReplyKind = 'answer' | 'stopped' | 'incomplete' | 'unavailable' | 'note';
export function classifyReply(m: Pick<ChatMessage, 'role' | 'source' | 'text'>): ReplyKind {
  if (m.role !== 'assistant' || m.source !== 'system') return 'answer';
  if (/^Stopped( by you| because [^.]+)?\./.test(m.text)) return 'stopped';
  if (/^The connection ended before the reply was finished\./.test(m.text)) return 'incomplete';
  if (/^The reply above was cut at /.test(m.text)) return 'incomplete';
  if (/^(Local|Cloud) model unavailable: /.test(m.text)) return 'unavailable';
  return 'note';
}
/** A streamed reply while it is being generated. Display only: the stored chat (reloaded at the end) is the record. */
export type LiveReply = { streamId: string; generation: number; route: ChatStreamRoute; status: 'connecting' | 'streaming' | 'stopping'; text: string };
export const MAX_LIVE_CHARS = 60_000;
export type StreamFinal = Extract<ChatStreamEvent, { type: 'done' | 'lost' }>;

/**
 * Folds one stream event into the live reply. Events from another stream or an older generation are ignored, so a late
 * event from a previous message can never write into the current one. 'done'/'lost' end the live reply.
 */
export function applyStreamEvent(live: LiveReply | null, ev: ChatStreamEvent): { live: LiveReply | null; final?: StreamFinal } {
  if (!live || ev.streamId !== live.streamId || ev.generation !== live.generation) return { live };
  switch (ev.type) {
    case 'status': return { live: live.status === 'stopping' ? live : { ...live, status: ev.status } };
    case 'delta': return { live: { ...live, status: live.status === 'stopping' ? 'stopping' : 'streaming', text: (live.text + ev.text).slice(0, MAX_LIVE_CHARS) } };
    default: return { live: null, final: ev };
  }
}

/** What the composer should say about a finished stream. Null means nothing to report beyond the stored messages. */
export function streamFinalNotice(final: StreamFinal): { tone: 'warn' | 'danger'; text: string } | null {
  if (final.type === 'lost') return { tone: 'danger', text: `The live reply was interrupted (${final.reason}). The conversation below shows what was saved.` };
  if (final.outcome === 'truncated') return { tone: 'warn', text: 'The reply reached the length limit of this app and was cut off. The model may have had more to say.' };
  return null;
}

/** Ids of partial replies that a following 'stopped'/'incomplete' note says are cut off. */
export function incompleteReplyIds(chat: Pick<ChatMessage, 'id' | 'role' | 'source' | 'text'>[]): Set<string> {
  const ids = new Set<string>();
  chat.forEach((m, i) => {
    const kind = classifyReply(m), prev = chat[i - 1];
    if ((kind === 'stopped' || kind === 'incomplete') && prev && classifyReply(prev) === 'answer' && prev.role === 'assistant') ids.add(prev.id);
  });
  return ids;
}
/** Which model route a 'model unavailable' note is about, and the provider/network reason it gives. */
export function unavailableDetail(text: string): { route: 'Local' | 'Cloud'; reason: string } | null {
  const m = /^(Local|Cloud) model unavailable: ([\s\S]*?)\. No reply was generated/.exec(text);
  return m ? { route: m[1] as 'Local' | 'Cloud', reason: m[2] } : null;
}
/* ---------------------------------------------------------------------------------------------------------------------
 * Conversation UX helpers (pure, unit-tested). None of them talks to a backend or sends anything.
 * ------------------------------------------------------------------------------------------------------------------- */

/** Stored messages longer than this are shown collapsed; the full text is one click away and is never altered or dropped. */
export const MESSAGE_PREVIEW_CHARS = 6_000;
/** While a reply streams, only its latest part is rendered so a long draft cannot make typing and scrolling heavy. */
export const LIVE_VIEW_CHARS = 8_000;
/** Number of most recent messages rendered at once; earlier ones stay saved and can be revealed. */
export const MAX_RENDERED_MESSAGES = 200;
/** A stop request that the backend has not confirmed after this long is reported as unconfirmed and can be repeated. */
export const STOP_CONFIRM_MS = 8_000;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** First `limit` UTF-16 units of the text without splitting a surrogate pair. Text within the limit is returned unchanged. */
export function headOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = limit > 0 && isHigh(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return text.slice(0, end);
}
/** Last `limit` UTF-16 units of the text without splitting a surrogate pair. */
export function tailOf(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const start = isLow(text.charCodeAt(text.length - limit)) ? text.length - limit + 1 : text.length - limit;
  return text.slice(start);
}

const CITATION_BLOCK = /\n[ \t]*(?:\*\*|#+ )?(?:Sources?|References?|Citations?)\**[ \t]*:/gi;
/** Longest trailing citation block (from a "Sources:" / "References:" / "Citations:" line to the end) that is kept visible when a message is folded. */
export const CITATION_TAIL_CHARS = 2_000;
/**
 * What to render for one stored message: the whole text, or its beginning plus how much is folded away. A trailing
 * "Sources:"-style block is kept visible even when the middle is folded, so citations are never the part that is hidden.
 */
export function boundMessage(text: string, expanded: boolean, limit = MESSAGE_PREVIEW_CHARS): { shown: string; tail: string; hidden: number; total: number } {
  if (expanded || text.length <= limit) return { shown: text, tail: '', hidden: 0, total: text.length };
  const shown = headOf(text, limit);
  let tail = '';
  for (const m of text.matchAll(CITATION_BLOCK)) {
    const at = m.index + 1; // skip the newline
    if (at >= shown.length && text.length - at <= CITATION_TAIL_CHARS) { tail = text.slice(at); break; }
  }
  return { shown, tail, hidden: text.length - shown.length - tail.length, total: text.length };
}
/** What to render for a live draft: only the latest part, plus how much of its start is not drawn. */
export function boundDraft(text: string, limit = LIVE_VIEW_CHARS): { shown: string; hidden: number; total: number } {
  const shown = tailOf(text, limit);
  return { shown, hidden: text.length - shown.length, total: text.length };
}
/** The most recent messages to render. `revealed` shows everything; otherwise at most `max` are drawn. */
export function windowMessages<T>(chat: T[], revealed: boolean, max = MAX_RENDERED_MESSAGES): { visible: T[]; hidden: number } {
  if (revealed || chat.length <= max) return { visible: chat, hidden: 0 };
  return { visible: chat.slice(chat.length - max), hidden: chat.length - max };
}

/** Whether the log is close enough to its end that new text should keep it pinned there (the user has not scrolled up to read). */
export function isNearBottom(el: Pick<HTMLElement, 'scrollTop' | 'clientHeight' | 'scrollHeight'>, slack = 48): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= slack;
}

const isLoopbackHost = (h: string) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
/** Host part of a configured endpoint, or null when it is not a parseable URL. */
export function endpointHost(endpoint: string | undefined): string | null {
  try { return endpoint ? new URL(endpoint).hostname.toLowerCase() : null; } catch { return null; }
}

export type RouteState = { tone: 'ok' | 'warn' | 'danger'; route: 'Local model' | 'Cloud model'; model: string; where: string; privacy: string; key: string | null; ready: boolean; blocker?: string };
/**
 * The visible route / key / privacy summary for the chat composer. Derived only from the settings and the backend's own
 * capability answer; it never implies a fallback to the other route, because the backend has none.
 */
export function routeState(i: { online: boolean; model: string | undefined; endpoint: string | undefined; configured: boolean; reason: string; cloudConfigured: boolean | null }): RouteState {
  const model = i.model?.trim() || 'not set';
  if (i.online) {
    const key = i.cloudConfigured === null ? 'API key: not checked yet' : i.cloudConfigured ? 'API key: saved on this computer (never shown here)' : 'API key: not saved';
    return {
      tone: i.configured ? 'warn' : 'danger', route: 'Cloud model', model, where: 'api.anthropic.com', key, ready: i.configured,
      privacy: 'Each message you send, plus the earlier conversation the backend includes for context, leaves this computer for your cloud provider using your own key. Nothing is sent until you press Send.',
      ...(i.configured ? {} : { blocker: i.reason }),
    };
  }
  const host = endpointHost(i.endpoint);
  const local = host !== null && isLoopbackHost(host);
  return {
    tone: i.configured ? (local || host === null ? 'ok' : 'warn') : 'danger', route: 'Local model', model, where: i.endpoint?.trim() || 'endpoint not set', key: null, ready: i.configured,
    privacy: host === null ? 'Messages go only to the local model endpoint in Settings. No cloud model is used and none is tried if it fails.'
      : local ? 'Messages stay on this computer: they go only to your local model. No cloud model is used and none is tried if it fails.'
        : `The configured endpoint is ${host}, which is not this computer. Messages go there, and nowhere else. No cloud model is used.`,
    ...(i.configured ? {} : { blocker: i.reason }),
  };
}

/** What Send/Plan is blocked by, in priority order, as words for the user. Null means a click would be accepted. */
export function sendBlocker(i: { mode: ComposerMode; text: string; locked: boolean; pending: boolean; live: boolean; settling: boolean; transcribing: boolean; configured: boolean; routeReason: string; plannerReady: boolean; stepBusy: boolean }): string | null {
  if (!i.text.trim()) return 'Type a message first.';
  if (i.transcribing) return 'Wait for the transcript to finish.';
  if (i.mode === 'command') return i.stepBusy ? 'A command is being planned or approved.' : i.plannerReady ? null : PLANNER_UNAVAILABLE;
  if (i.locked || i.pending || i.live) return 'A reply is in progress. Stop it or wait for it to finish before sending another message.';
  if (i.settling) return 'Saving the last reply…';
  if (!i.configured) return i.routeReason;
  return null;
}

/**
 * The text of the user message that a trailing failure note belongs to, so the user can send it again deliberately.
 * Only 'unavailable', 'incomplete' and generic notes qualify; a reply the user stopped is not offered a retry.
 */
export function retryCandidate(chat: Pick<ChatMessage, 'role' | 'source' | 'text'>[]): { text: string; why: string } | null {
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m.role === 'user') return null;
    const kind = classifyReply(m);
    if (kind === 'answer' && m.role === 'assistant') {
      // A partial answer followed by a cut-off note: keep walking to the note, then to its user message.
      continue;
    }
    if (kind === 'stopped') return null;
    if (kind === 'unavailable' || kind === 'incomplete' || kind === 'note') {
      for (let j = i - 1; j >= 0; j--) {
        if (chat[j].role === 'user') return chat[j].text.length > 0 && chat[j].text.length <= MAX_CHARS ? { text: chat[j].text, why: kind === 'incomplete' ? 'the reply was cut off' : 'no reply was generated' } : null;
      }
      return null;
    }
  }
  return null;
}

/** One short sentence for screen readers when the reply state changes. It is announced on changes only, never per streamed word. */
export function liveAnnouncement(prev: LiveReply['status'] | null, next: LiveReply['status'] | null, final?: StreamFinal | null): string {
  if (next === 'connecting' && prev === null) return 'Message sent. Waiting for the model.';
  if (next === 'streaming' && prev !== 'streaming') return 'The reply is being written.';
  if (next === 'stopping') return 'Stopping the reply.';
  if (next === null && final) {
    if (final.type === 'lost') return 'The live reply was interrupted.';
    return final.outcome === 'complete' ? 'Reply finished.' : final.outcome === 'cancelled' ? 'Reply stopped.' : final.outcome === 'truncated' ? 'Reply cut off at the length limit.' : final.outcome === 'incomplete' ? 'Reply ended early.' : 'The model did not answer.';
  }
  return '';
}

/** Why the backend did not run an approved action. Typed from the backend's refusal text; unknown text stays untyped. */
export type NotRunCause = 'declined' | 'expired' | 'paused' | 'rate-limit' | 'safe-launch';
export function notRunCause(message: string | undefined): NotRunCause | undefined {
  const t = message ?? '';
  if (/native confirmation declined/i.test(t)) return 'declined';
  if (/unknown, expired or was already used|approved too quickly/i.test(t)) return 'expired';
  if (/confirmations are paused/i.test(t)) return 'paused';
  if (/rate limit/i.test(t)) return 'rate-limit';
  if (/safe launch/i.test(t)) return 'safe-launch';
  return undefined;
}
const notRunExplanation: Record<NotRunCause, string> = {
  declined: 'The Windows confirmation was cancelled, closed or could not be shown. Nothing ran.',
  expired: 'This preview is no longer valid (previews are single-use and expire after one minute). Nothing ran. Preview the action again.',
  paused: 'Windows confirmations are paused for a short time after repeated cancellations. Nothing ran.',
  'rate-limit': 'Too many actions were approved in the last minute. Nothing ran. Wait, then preview again.',
  'safe-launch': 'Desktop Companion started in safe launch mode, so actions are disabled. Nothing ran.',
};
export const explainNotRun = (message: string | undefined): string | undefined => { const c = notRunCause(message); return c ? notRunExplanation[c] : undefined; };

/** Previews are valid for 60 s on the backend (PREVIEW_TTL_MS); the UI stops offering approval a second early. */
export const PREVIEW_VALID_MS = 59_000;
/** True once the preview with this id is old enough that the backend will refuse it. */
export function usePreviewExpired(id: string | undefined): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!id) return;
    const t = setTimeout(() => setExpired(true), PREVIEW_VALID_MS);
    return () => clearTimeout(t);
  }, [id]);
  return expired;
}

/**
 * One command's trip through intent → preview → native approval → outcome. Ephemeral: not stored in the chat history.
 * Each helper performs exactly one backend call; none of them chains into the next step on its own.
 */
export type CommandStep = {
  command: string;
  plan?: IntentPlan;
  request?: ActionRequest;
  preview?: ActionPreview;
  outcome?: ActionOutcome & { summary: string; cause?: NotRunCause };
  error?: string;
};

export const PLANNER_UNAVAILABLE = 'Command planning is not available here: this window has no backend planner (for example the browser preview). Use the Computer screen instead.';

/** Plans one command. Never previews or runs anything. */
export async function planCommand(api: JarvisAPI, command: string, useLocalModel: boolean): Promise<CommandStep> {
  const text = command.trim();
  if (!api.planIntent) return { command: text, error: PLANNER_UNAVAILABLE };
  try {
    const plan = await api.planIntent(text, useLocalModel ? { useLocalModel: true } : undefined);
    return { command: text, plan };
  } catch (e) {
    return { command: text, error: errMsg(e, 'The command could not be planned.') };
  }
}

/** Requests that a plan can offer for preview: the ready request, or the clarification's candidates. */
export function planChoices(plan: IntentPlan | undefined): { label: string; request: ActionRequest }[] {
  if (!plan) return [];
  if (plan.status === 'ready') return [{ label: plan.summary, request: plan.request }];
  if (plan.status === 'clarify') return plan.candidates ?? [];
  return [];
}

/** Asks the backend what the request would do. Preview sends no input and runs nothing. */
export async function previewCommand(api: JarvisAPI, step: CommandStep, request: ActionRequest): Promise<CommandStep> {
  const base = { command: step.command, plan: step.plan, request };
  try {
    return { ...base, preview: await api.previewAction(request) };
  } catch (e) {
    return { ...base, error: errMsg(e, 'The action could not be previewed.') };
  }
}

/**
 * Sends the user's decision. `approved` is only a request: for any action that changes something the backend shows its own
 * Windows confirmation (Cancel is the default) and runs nothing unless the user chooses Continue there.
 */
export async function decideCommand(api: JarvisAPI, step: CommandStep, approved: boolean): Promise<CommandStep> {
  const p = step.preview;
  if (!p) return step;
  const base = { command: step.command, plan: step.plan, request: step.request };
  if (approved && !p.allowed) return { ...step, error: p.reason ?? 'The backend blocked this action.' };
  try {
    const out = await api.executeAction(p.id, approved);
    const outcome = actionOutcome(out, approved);
    return { ...base, outcome: { ...outcome, summary: p.summary, ...(outcome.kind === 'not-run' ? { cause: notRunCause(outcome.message) } : {}) } };
  } catch (e) {
    if (!approved) return { ...base, outcome: { kind: 'rejected', message: 'You rejected this action. Nothing ran.', summary: p.summary } };
    const message = errMsg(e, 'The action reported an error.');
    // An unknown/expired/used preview is refused before anything starts, so it is a definite "not run", not "unconfirmed".
    if (notRunCause(message) === 'expired') return { ...base, outcome: { kind: 'not-run', message, cause: 'expired', summary: p.summary } };
    return { ...base, outcome: { kind: 'unconfirmed', message: `${message} Check recent activity before trying again.`, summary: p.summary } };
  }
}

const outcomeTitle: Record<ActionOutcome['kind'], string> = { ran: 'Done', 'not-run': 'Not run', rejected: 'Rejected', unconfirmed: 'Not confirmed' };

export function CommandFlow({ step, busy, onPreview, onDecide, onDismiss }: {
  step: CommandStep;
  busy: 'plan' | 'preview' | 'approve' | 'reject' | null;
  onPreview: (request: ActionRequest) => void;
  onDecide: (approved: boolean) => void;
  onDismiss: () => void;
}) {
  const { plan, preview: p, outcome } = step;
  const expired = usePreviewExpired(p && !outcome ? p.id : undefined);
  const choices = planChoices(plan);
  const windows = outcome?.kind === 'ran' ? listedWindows(outcome.value) : null;
  return (
    <section className="chat-error stack" aria-label="Desktop action" aria-live="polite">
      <div className="row wrap">
        <Badge tone="accent">Command</Badge>
        <code>{truncate(step.command, 160)}</code>
        {plan && <Badge tone="muted">{plan.source === 'model' ? 'Interpreted by local model' : 'Rule planner'}</Badge>}
        <Button size="sm" variant="quiet" disabled={busy !== null} onClick={onDismiss}>Dismiss</Button>
      </div>
      {busy === 'plan' && <p className="sub"><Spinner size={14} /> Planning… nothing runs at this step.</p>}
      {step.error && <Notice tone="danger" title="Not run">{step.error}</Notice>}
      {plan?.status === 'blocked' && !p && !outcome && <Notice tone="warn" title={plan.summary}>{plan.reason}</Notice>}
      {plan?.status === 'clarify' && !p && !outcome && <Notice title={plan.summary}>{plan.question}</Notice>}
      {!p && !outcome && choices.length > 0 && (
        <div className="row wrap">
          {choices.map((c, i) => (
            <Button key={i} size="sm" variant={plan?.status === 'ready' ? 'primary' : 'ghost'} icon={MagnifyingGlass} busy={busy === 'preview'} disabled={busy !== null} onClick={() => onPreview(c.request)}>
              Preview: {truncate(c.label, 90)}
            </Button>
          ))}
          <span className="sub">Preview asks the backend what would happen. It does not run anything.</span>
        </div>
      )}
      {p && !outcome && (
        <div className="stack">
          <p><strong>{p.summary}</strong> {p.allowed ? <Badge tone="ok">Allowed</Badge> : <Badge tone="danger">Blocked</Badge>}</p>
          {p.reason && <p className="field-hint">{p.reason}</p>}
          {step.request?.type === 'type-text' && <p className="field-hint">Text to type ({step.request.text?.length ?? 0} characters): <code>{truncate(step.request.text ?? '', 200)}</code></p>}
          {p.allowed && p.requiresApproval && <p className="field-hint">Approving opens a Windows confirmation from Desktop Companion with the complete details. Cancel is the default; nothing runs unless you choose Continue there. A preview is valid for one minute.</p>}
          {busy === 'approve' && p.requiresApproval && <p className="sub" role="status"><Spinner size={14} /> Waiting for your answer in the Windows confirmation window. Nothing runs until you choose Continue there.</p>}
          {expired && busy === null && <Notice tone="warn" title="This preview has expired">The backend only accepts a preview for one minute. Nothing ran.{step.request && <div className="row"><Button size="sm" icon={MagnifyingGlass} onClick={() => step.request && onPreview(step.request)}>Preview again</Button></div>}</Notice>}
          <div className="row">
            <Button variant="primary" icon={ShieldCheck} busy={busy === 'approve'} disabled={!p.allowed || expired || busy !== null} onClick={() => onDecide(true)}>
              {p.requiresApproval ? 'Approve…' : 'Read windows'}
            </Button>
            <Button variant="quiet" busy={busy === 'reject'} disabled={busy !== null} onClick={() => onDecide(false)}>Reject</Button>
          </div>
        </div>
      )}
      {outcome && (
        <Notice tone={outcome.kind === 'ran' ? 'info' : outcome.kind === 'rejected' ? 'info' : 'warn'} title={`${outcomeTitle[outcome.kind]}: ${truncate(outcome.summary, 120)}`}>
          {outcome.kind === 'ran' ? (windows ? `${windows.length} open window${windows.length === 1 ? '' : 's'} reported.` : 'The backend confirmed the action ran.') : (explainNotRun(outcome.message) ?? outcome.message)}
          {outcome.kind === 'not-run' && explainNotRun(outcome.message) && <span className="sub"> Backend said: {outcome.message}</span>}
          {windows && windows.length > 0 && (
            <ul className="chips-col">{windows.slice(0, 12).map((w, i) => <li key={w.hwnd ?? i}>{w.title || '(untitled)'} <span className="sub mono">{w.process}{w.hwnd ? ` · hwnd:${w.hwnd}` : ''}</span></li>)}</ul>
          )}
        </Notice>
      )}
    </section>
  );
}

/** One stored message's text. Long messages are folded to their beginning; the full text is a click away and is never changed. */
export function MessageText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const b = boundMessage(text, open);
  return (
    <>
      <p>{b.shown}{b.hidden > 0 ? '…' : ''}</p>
      {b.hidden > 0 && b.tail && <><p className="sub">{b.hidden.toLocaleString()} characters folded. The sources at the end are kept visible.</p><p>{b.tail}</p></>}
      {text.length > MESSAGE_PREVIEW_CHARS && (
        <div className="row">
          <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Show less' : `Show all ${b.total.toLocaleString()} characters`}</Button>
        </div>
      )}
    </>
  );
}

/** Whole seconds since this element appeared. Real elapsed time only; it says nothing about what the model is doing. */
function Waited() {
  const [t0] = useState(() => Date.now());
  const [now, setNow] = useState(t0);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []);
  return <span className="sub"> · {Math.max(0, Math.floor((now - t0) / 1000))} s</span>;
}

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
  const { api, state, settings, cloudConfigured, run, toast, reload, system, systemLoading, systemError, refreshSystem } = useReady();
  const companion = useCompanion();
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [live, setLive] = useState<LiveReply | null>(null);
  const [streamNote, setStreamNote] = useState<{ tone: 'warn' | 'danger'; text: string } | null>(null);
  const liveRef = useRef<LiveReply | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const streamMounted = useRef(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const [phase, setPhase] = useState<RecPhase>('idle');
  const [level, setLevel] = useState(0);
  /** In-app microphone consent: separate from the Windows permission, off until the user turns it on here, never granted on load. */
  const consent = useMemo(() => createMicConsent(defaultConsentStorage()), []);
  const [micAllowed, setMicAllowedState] = useState(() => consent.granted());
  const support = useMemo(() => micSupport(), []);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [avatarPreview, setAvatarPreview] = useState(false);
  const [voiceNote, setVoiceNote] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(null);
  const [autoSpeak, setAutoSpeak] = usePref('autoSpeak', false);
  const [speakText, setSpeakText] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [mode, setMode] = useState<ComposerMode>('chat');
  const [modelAssist, setModelAssist] = usePref('intentModelAssist', false);
  const [step, setStep] = useState<CommandStep | null>(null);
  const [stepBusy, setStepBusy] = useState<'plan' | 'preview' | 'approve' | 'reject' | null>(null);
  const [features, setFeatures] = useState<ApiFeature[] | null>(null);
  /** Taken synchronously on the first accepted send so a second Enter/click in the same tick cannot start another request. */
  const sendLock = useRef(false);
  const streamSeq = useRef(0);
  const stickToEnd = useRef(true);
  const [settling, setSettling] = useState(false);
  const [stopSlow, setStopSlow] = useState(false);
  const [stopAttempt, setStopAttempt] = useState(0);
  const [showEarlier, setShowEarlier] = useState(false);
  const [announce, setAnnounce] = useState({ n: 0, text: '' });
  const say = (text: string) => { if (text) setAnnounce((a) => ({ n: a.n + 1, text: a.n % 2 ? text : text + '\u00a0' })); };

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

  // Follow new text only while the reader is at the end; scrolling up to read stops the log from jumping away.
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToEnd.current) el.scrollTop = el.scrollHeight;
  }, [state.chat.length, pending, live?.text.length]);

  // A stop request the backend never confirms must not leave the reply stuck: say so after a bounded wait and allow another try.
  useEffect(() => {
    setStopSlow(false);
    if (live?.status !== 'stopping') return;
    const t = window.setTimeout(() => setStopSlow(true), STOP_CONFIRM_MS);
    return () => window.clearTimeout(t);
  }, [live?.status, stopAttempt]);

  // Leaving the Assistant stops a reply in flight: the backend saves what arrived and nothing is generated unseen.
  useEffect(() => { streamMounted.current = true; return () => {
    streamMounted.current = false;
    unsubRef.current?.();
    unsubRef.current = null;
    const l = liveRef.current;
    liveRef.current = null;
    if (l) void api.chatStreamCancel?.(l.streamId).catch(() => undefined);
  }; }, [api]);

  useEffect(
    () => () => {
      const r = recorder.current;
      recorder.current = null;
      r?.cancel();
      companion.set('idle');
      companion.setSource('none');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    let live = true;
    api.getApiInfo?.().then((info) => { if (live) setFeatures(info.features); }).catch(() => undefined);
    return () => { live = false; };
  }, [api]);
  // Report what the backend says; streaming is only used when the bridge exposes it and the backend reports it available.
  const streaming = features?.find((f) => f.id === 'chat-streaming'), cancelFeat = features?.find((f) => f.id === 'chat-cancel');

  const online = settings.mode === 'online';
  const incomplete = useMemo(() => incompleteReplyIds(state.chat), [state.chat]);
  const capability = (id: string) => system?.capabilities.find(c => c.id === id);
  const route = capability(online ? 'cloud' : 'local-llm');
  const configured = route?.available === true && !systemError;
  const tts = capability('tts'), stt = capability('stt');
  const ttsReady = tts?.available === true && !systemError;
  const sttReady = stt?.available === true && !systemError;
  const unavailable = (reason?: string) => systemError || reason || (systemLoading ? 'Checking system capability…' : 'Capability has not been checked.');
  const routeReason = unavailable(route?.reason);
  const rs = routeState({ online, model: online ? settings.cloudModel : settings.localModel, endpoint: settings.localEndpoint, configured, reason: routeReason, cloudConfigured });
  const retry = useMemo(() => retryCandidate(state.chat), [state.chat]);
  const chatWindow = useMemo(() => windowMessages(state.chat, showEarlier), [state.chat, showEarlier]);
  const replyBusy = pending !== null || live !== null || settling;
  const ttsReason = unavailable(tts?.reason), sttReason = unavailable(stt?.reason);

  const speak = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t) return;
      if (!ttsReady) {setVoiceNote({tone:'warn', text:ttsReason});return;}
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
    [api, companion, ttsReady, ttsReason],
  );

  const plannerReady = typeof api.planIntent === 'function';
  const localRoute = capability('local-llm');
  const modelAssistReady = plannerReady && localRoute?.available === true && !systemError;

  const runCommand = async () => {
    const text = input.trim();
    if (!text || stepBusy !== null || phase === 'transcribing') return;
    if (text.length > MAX_COMMAND_CHARS) { setStep({ command: truncate(text, 160), error: `Commands are limited to ${MAX_COMMAND_CHARS} characters.` }); return; }
    setStep({ command: text });
    setStepBusy('plan');
    companion.set('thinking');
    const next = await planCommand(api, text, modelAssist && modelAssistReady);
    setStep(next);
    setStepBusy(null);
    if (next.error || next.plan?.status === 'blocked') companion.set('alert', 3000);
    else companion.set('idle');
    if (!next.error) setInput('');
  };

  const previewStep = async (request: ActionRequest) => {
    if (!step || stepBusy !== null) return;
    setStepBusy('preview');
    setStep(await previewCommand(api, step, request));
    setStepBusy(null);
  };

  const decideStep = async (approved: boolean) => {
    if (!step?.preview || stepBusy !== null) return;
    setStepBusy(approved ? 'approve' : 'reject');
    const next = await decideCommand(api, step, approved);
    setStep(next);
    setStepBusy(null);
    if (next.outcome?.kind === 'ran') companion.set('idle');
    else if (next.outcome && next.outcome.kind !== 'rejected') companion.set('alert', 3000);
    await reload().catch(() => undefined);
  };

  const send = async () => {
    if (mode === 'command') return runCommand();
    return sendChat(input.trim(), true);
  };

  /** Retry is an explicit click that sends the earlier message again through the same route; the composer draft is left alone. */
  const sendAgain = () => { if (retry) void sendChat(retry.text, false); };

  const sendChat = async (text: string, fromComposer: boolean) => {
    if (!text || sendLock.current || pending !== null || live !== null || settling || phase === 'transcribing') return;
    if (!configured) {setSendError(routeReason);return;}
    sendLock.current = true;
    if (streaming?.available === true && api.chatStreamStart && api.onChatStream && api.chatStreamCancel) return sendStreamed(text, fromComposer);
    if (fromComposer) setInput('');
    setPending(text);
    setSendError(null);
    setStreamNote(null);
    companion.set('thinking');
    try {
      const reply = await api.chat(text);
      await reload().catch(() => undefined);
      if(reply.source==='system'){companion.set('alert',4000);void refreshSystem();}
      else {companion.set('idle');if(autoSpeak&&ttsReady)void speak(reply.text);}
    } catch (e) {
      setSendError(errMsg(e, 'The assistant could not answer.'));
      companion.set('alert', 4000);
      const fresh = await api.getState().catch(() => null);
      if (fresh) await reload().catch(() => undefined);
      const last = fresh?.chat[fresh.chat.length - 1];
      if (fromComposer && !(last && last.role === 'user' && last.text === text)) setInput(text);
    } finally {
      setPending(null);
      sendLock.current = false;
    }
  };

  const setLiveBoth = (l: LiveReply | null) => { liveRef.current = l; setLive(l); };

  const finishStream = async (final: StreamFinal, seq: number) => {
    unsubRef.current?.();
    unsubRef.current = null;
    setLiveBoth(null);
    setSettling(true);
    await reload().catch(() => undefined);
    // Unmounted, or a newer stream owns the screen: this older result must not write notices, companion state or the lock.
    if (!streamMounted.current || seq !== streamSeq.current) return;
    setSettling(false);
    sendLock.current = false;
    setStreamNote(streamFinalNotice(final));
    if (final.type === 'lost' || final.outcome === 'failed' || final.outcome === 'incomplete') {
      companion.set('alert', 4000);
      if (final.type === 'done' && final.outcome === 'failed') void refreshSystem();
      return;
    }
    companion.set('idle');
    if (final.outcome === 'complete' && autoSpeak && ttsReady) void speak(final.reply.text);
  };

  const sendStreamed = async (text: string, fromComposer: boolean) => {
    const seq = ++streamSeq.current;
    setPending(text);
    if (fromComposer) setInput('');
    setSendError(null);
    setStreamNote(null);
    companion.set('thinking');
    let start;
    try {
      start = await api.chatStreamStart!(text);
    } catch (e) {
      if (!streamMounted.current) return;
      // Refused before anything was sent (busy, invalid, or the message could not be saved): give the text back.
      sendLock.current = false;
      setSendError(errMsg(e, 'The assistant could not start a reply.'));
      companion.set('alert', 4000);
      if (fromComposer) setInput(text);
      await reload().catch(() => undefined);
      return;
    } finally {
      if (streamMounted.current) setPending(null);
    }
    if (!streamMounted.current) {
      await api.chatStreamCancel!(start.streamId).catch(() => undefined);
      return;
    }
    setLiveBoth({ streamId: start.streamId, generation: start.generation, route: start.route, status: 'connecting', text: '' });
    void reload().catch(() => undefined);
    say(liveAnnouncement(null, 'connecting'));
    unsubRef.current = api.onChatStream!(start, (ev) => {
      if (seq !== streamSeq.current) return;
      const before = liveRef.current?.status ?? null;
      const r = applyStreamEvent(liveRef.current, ev);
      if (r.live !== liveRef.current) setLiveBoth(r.live);
      say(liveAnnouncement(before, r.live?.status ?? null, r.final));
      if (r.final) void finishStream(r.final, seq);
    });
  };

  const stopStream = async () => {
    const l = liveRef.current;
    if (!l || (l.status === 'stopping' && !stopSlow)) return;
    const before = l.status === 'stopping' ? 'streaming' : l.status;
    setStopAttempt((n) => n + 1);
    setLiveBoth({ ...l, status: 'stopping' });
    say(liveAnnouncement(before, 'stopping'));
    try {
      await api.chatStreamCancel!(l.streamId);
    } catch (e) {
      setSendError(errMsg(e, 'The reply could not be stopped.'));
      const cur = liveRef.current;
      // The stop did not go through, so the reply is still running: give the Stop button back instead of freezing it.
      if (cur && cur.streamId === l.streamId && cur.status === 'stopping') setLiveBoth({ ...cur, status: before });
    }
  };

  const startRec = async () => {
    if (phaseRef.current !== 'idle') return;
    if (!sttReady) {setVoiceNote({tone:'warn', text:sttReason});return;}
    if (!support.supported) {setVoiceNote({tone:'warn', text:support.reason ?? 'Microphone capture is not available in this window.'});return;}
    if (!consent.granted()) {setVoiceNote({tone:'warn', text:'Turn on "Allow the microphone" below first. Nothing was recorded.'});return;}
    pendingStop.current = false;
    setVoiceNote(null);
    setPhaseBoth('starting');
    const r = new ClipRecorder({ consent });
    recorder.current = r;
    // The real analyser level drives both the local meter and the shared companion/avatar amplitude, only while this recorder is the live one.
    bindLevel(r, () => recorder.current, (l) => {
      const q = Math.round(l * 20) / 20;
      setLevel(q);
      companion.setLevel(q);
    });
    r.onLimit = () => void stopRec();
    r.onDeviceLost = () => {
      setVoiceNote({ tone: 'warn', text: 'The microphone was disconnected. Whatever was captured is being transcribed.' });
      void stopRec();
    };
    const t0 = performance.now();
    try {
      await r.start();
    } catch (e) {
      if (recorder.current !== r) return;
      recorder.current = null;
      setPhaseBoth('idle');
      setLevel(0);
      companion.setSource('none');
      setVoiceNote({ tone: 'warn', text: micErrorMessage(e) });
      return;
    }
    if (recorder.current !== r || !consent.granted()) { r.cancel(); return; }
    setPhaseBoth('recording');
    setElapsedMs(0);
    companion.set('listening');
    companion.setSource('microphone');
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
    companion.setSource('none');
    try {
      const clip = await r.stop();
      if (recorder.current !== r || !consent.granted()) return;
      const out = await api.transcribe(clip.wav);
      if (recorder.current !== r || !consent.granted()) return;
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
      if (recorder.current !== r) return;
      setVoiceNote({ tone: 'warn', text: errMsg(e, 'Transcription failed.') });
      companion.set('alert', 3000);
    } finally {
      if (recorder.current === r) {
        recorder.current = null;
        setPhaseBoth('idle');
        setLevel(0);
      }
    }
  };

  const cancelRec = () => {
    if (phaseRef.current !== 'idle') {
      recorder.current?.cancel();
      recorder.current = null;
      setPhaseBoth('idle');
      setLevel(0);
      companion.set('idle');
      companion.setSource('none');
      setVoiceNote({ tone: 'info', text: 'Recording cancelled. Any pending transcript will be discarded.' });
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

  const setMicAllowed = (v: boolean) => {
    if (v) consent.grant();
    else {
      cancelRec();
      consent.revoke();
    }
    setMicAllowedState(v);
  };

  // Elapsed time while recording, for the remaining-seconds hint. The recorder enforces the limit itself.
  useEffect(() => {
    if (phase !== 'recording') return;
    const t0 = performance.now();
    const id = window.setInterval(() => setElapsedMs(performance.now() - t0), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  const micBlocked = !support.supported ? support.reason ?? 'Microphone capture is not available in this window.' : !micAllowed ? 'Turn on "Allow the microphone" in the Push to talk panel first.' : null;
  const blocker = sendBlocker({ mode, text: input, locked: sendLock.current, pending: pending !== null, live: live !== null, settling, transcribing: phase === 'transcribing', configured, routeReason, plannerReady, stepBusy: stepBusy !== null });
  const recLabel = phase === 'recording' ? 'Recording — release to stop' : phase === 'starting' ? 'Starting microphone…' : phase === 'transcribing' ? 'Transcribing…' : 'Hold to talk';

  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="Cockpit"
        title="Assistant"
        subtitle={online ? 'Online mode: messages go to your cloud model with your own key.' : 'Offline mode: messages go only to your local model endpoint.'}
        actions={
          <Button icon={Broom} onClick={() => setConfirmClear(true)} disabled={state.chat.length === 0 || replyBusy} title={replyBusy ? 'Stop the reply or wait for it to finish first.' : undefined}>
            Clear conversation
          </Button>
        }
      />

      <div className="assist-grid">
        <section className="chat panel" aria-label="Conversation">
          <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Messages" aria-relevant="additions" tabIndex={0} onScroll={(e) => { stickToEnd.current = isNearBottom(e.currentTarget); }}>
            {state.chat.length === 0 && pending === null && live === null ? (
              <Empty icon={ChatCircleDots} title="No messages yet">
                {configured
                  ? `Your next message goes to ${online ? `the cloud model “${settings.cloudModel}”` : `the local model “${settings.localModel}”`}. Replies are generated by that model, not scripted.`
                  : online
                    ? `Cloud chat unavailable: ${routeReason.replace(/[.]+$/, "")}. Check Settings or System status.`
                    : `Ollama (local) unavailable: ${routeReason.replace(/[.]+$/, "")}. Check System status, then check again.`}
              </Empty>
            ) : (
              <>
                {chatWindow.hidden > 0 && (
                  <div className="row wrap">
                    <span className="sub">{chatWindow.hidden} earlier message{chatWindow.hidden === 1 ? ' is' : 's are'} saved but not drawn, to keep this window responsive.</span>
                    <Button size="sm" variant="quiet" onClick={() => setShowEarlier(true)}>Show earlier messages</Button>
                  </div>
                )}
                {chatWindow.visible.map((m) => {
                  const kind = classifyReply(m);
                  if (kind !== 'answer') {
                    const unavail = kind === 'unavailable' ? unavailableDetail(m.text) : null;
                    return (
                      <div key={m.id} className="chat-error">
                        <Notice tone={kind === 'stopped' ? 'info' : kind === 'incomplete' ? 'warn' : 'danger'} title={kind === 'stopped' ? 'You stopped this reply' : kind === 'incomplete' ? 'The reply was cut off' : unavail ? `${unavail.route} model unavailable` : 'The model did not answer'}>
                          {m.text}
                          {(kind === 'unavailable' || kind === 'note') && <div className="row wrap"><a className="btn btn-ghost btn-sm" href="#/status">Open System status</a><Button size="sm" busy={systemLoading} onClick={() => void refreshSystem()}>Check again</Button></div>}
                        </Notice>
                      </div>
                    );
                  }
                  return (
                    <article key={m.id} className={cx('msg', `msg-${m.role}`)}>
                      <header>
                        <span className="msg-who">{m.role === 'user' ? 'You' : 'Assistant'}</span>
                        {m.role === 'assistant' && <Badge tone={m.source === 'cloud' ? 'warn' : m.source === 'local' ? 'accent' : 'muted'}>{sourceLabel(m.source)}</Badge>}
                        {incomplete.has(m.id) && <Badge tone="warn">Incomplete</Badge>}
                        <time dateTime={m.createdAt}>{fmtTime(m.createdAt)}</time>
                        {m.role === 'assistant' && (
                          <button type="button" className="iconbtn" aria-label="Read this reply aloud" disabled={speaking || !ttsReady} title={ttsReady ? 'Read aloud' : ttsReason} onClick={() => void speak(m.text)}>
                            <SpeakerHigh size={14} aria-hidden />
                          </button>
                        )}
                      </header>
                      <MessageText text={m.text} />
                    </article>
                  );
                })}
                {live !== null && (
                  <article className="msg msg-assistant msg-pending" aria-busy="true">
                    <header>
                      <span className="msg-who">Assistant</span>
                      <Badge tone={live.route === 'cloud' ? 'warn' : 'accent'}>{live.route === 'cloud' ? 'Cloud model' : 'Local model'}</Badge>
                      <span className="sub">{live.status === 'connecting' ? 'connecting…' : live.status === 'stopping' ? 'stopping…' : 'writing…'}</span>
                      <Waited />
                    </header>
                    {live.text ? (() => {
                      const d = boundDraft(live.text);
                      return (
                        <>
                          {d.hidden > 0 && <p className="field-hint">Showing the latest {d.shown.length.toLocaleString()} of {d.total.toLocaleString()} characters. The whole reply is saved when it finishes.</p>}
                          <p>{d.hidden > 0 ? '…' : ''}{d.shown}</p>
                        </>
                      );
                    })() : (
                      <div className="typing" role="status" aria-label="Waiting for the model">
                        <i /><i /><i />
                        <span>Waiting for {live.route === 'cloud' ? 'cloud' : 'local'} model…</span>
                      </div>
                    )}
                    <div className="row">
                      <Button size="sm" variant="quiet" icon={Stop} aria-keyshortcuts="Escape" busy={live.status === 'stopping' && !stopSlow} disabled={live.status === 'stopping' && !stopSlow} onClick={() => void stopStream()}>{stopSlow ? 'Stop again' : 'Stop'}</Button>
                      <span className="sub">{live.status === 'stopping' ? 'Stop requested. What has arrived is saved.' : 'Esc in the message box also stops the reply.'}</span>
                    </div>
                    {stopSlow && <Notice tone="warn" title="The stop is not confirmed yet">The backend has not reported that the reply ended. It may still be running. You can press Stop again; nothing else is sent meanwhile.</Notice>}
                  </article>
                )}
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
                      <span>Waiting for {online ? 'cloud' : 'local'} model…{cancelFeat?.available === false ? ' The reply arrives complete and cannot be stopped once sent.' : ''}<Waited /></span>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {streamNote && (
            <div className="chat-error">
              <Notice tone={streamNote.tone} title={streamNote.tone === 'danger' ? 'Live reply interrupted' : 'Reply cut off'}>{streamNote.text}</Notice>
            </div>
          )}

          {sendError && (
            <div className="chat-error">
              <Notice tone="danger" title="The message was not answered">{sendError}</Notice>
            </div>
          )}

          {retry && !replyBusy && mode === 'chat' && (
            <div className="chat-error">
              <Notice tone="info" title="Send the last message again?">
                {`No reply was kept because ${retry.why}. Retrying adds your message to the conversation a second time and sends it to the ${rs.route.toLowerCase()} (${rs.model}). Nothing is sent unless you press Retry.`}
                <div className="row wrap">
                  <Button size="sm" icon={PaperPlaneRight} disabled={!configured} onClick={sendAgain}>Retry</Button>
                  {!configured && <span className="sub">Unavailable: {routeReason}</span>}
                </div>
              </Notice>
            </div>
          )}

          {step && <CommandFlow step={step} busy={stepBusy} onPreview={(r) => void previewStep(r)} onDecide={(a) => void decideStep(a)} onDismiss={() => setStep(null)} />}

          <div className="row wrap pad">
            <Segmented<ComposerMode>
              label="What the message box does"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'chat', label: 'Chat', icon: ChatCircleDots, hint: 'Send a message to the model' },
                { value: 'command', label: 'Desktop command', icon: Lightning, hint: 'Plan one desktop action; you preview and approve before anything runs' },
              ]}
            />
            {mode === 'command' && <span className="sub">{plannerReady ? 'One action per command. You preview it, then approve it in a Windows confirmation.' : PLANNER_UNAVAILABLE}</span>}
          </div>

          <div className="chat-error" aria-label="Where this message goes" role="group">
            <div className="row wrap">
              <Badge tone={rs.tone === 'danger' ? 'danger' : rs.tone === 'warn' ? 'warn' : 'ok'}>{mode === 'command' ? 'Desktop command' : rs.route}</Badge>
              {mode === 'chat' ? <span className="mono">{rs.model}</span> : <span className="sub">{modelAssist && modelAssistReady ? 'Rule planner, then the local model if unrecognized' : 'Offline rule planner only'}</span>}
              {mode === 'chat' && <span className="sub mono">{rs.where}</span>}
              {mode === 'chat' && rs.key && <Badge tone={cloudConfigured ? 'ok' : 'warn'}>{rs.key}</Badge>}
              <Badge tone={rs.ready ? 'ok' : 'danger'}>{rs.ready ? 'Ready' : 'Unavailable'}</Badge>
            </div>
            <p className="field-hint" id="route-privacy">{mode === 'command' ? 'A command is planned here on this computer. It is not sent to a chat model, and nothing runs until you approve it in the Windows confirmation.' : rs.privacy}</p>
            {mode === 'chat' && !rs.ready && <p className="field-hint">Sending is off: {rs.blocker}</p>}
          </div>

          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce.text}</div>

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
              maxLength={mode === 'command' ? MAX_COMMAND_CHARS : MAX_CHARS}
              placeholder={mode === 'command' ? 'One desktop action, e.g. list windows · focus "Untitled - Notepad" · open https://example.com' : 'Type a message. Enter sends, Shift+Enter adds a line.'}
              value={input}
              aria-describedby="route-privacy"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                } else if (e.key === 'Escape' && liveRef.current && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void stopStream();
                }
              }}
            />
            <div className="composer-actions">
              <button
                type="button"
                className={cx('ptt', phase !== 'idle' && `ptt-${phase}`)}
                aria-pressed={phase === 'recording'}
                aria-label={recLabel}
                title={micBlocked ?? 'Hold to record, or tap once to start and tap again to stop. Esc cancels.'}
                disabled={phase === 'transcribing' || replyBusy || (phase === 'idle' && (!sttReady || micBlocked !== null))}
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
              {mode === 'chat' && blocker && input.trim() && <span className="sub" id="send-blocker">{blocker}</span>}
              <span className="counter" aria-hidden={input.length < 3500}>
                {input.length >= 3500 ? `${input.length}/${MAX_CHARS}` : ''}
              </span>
              {mode === 'command' ? (
                <Button type="submit" variant="primary" icon={Lightning} busy={stepBusy === 'plan'} disabled={!input.trim() || stepBusy !== null || phase === 'transcribing' || !plannerReady}>
                  Plan
                </Button>
              ) : (
                <Button type="submit" variant="primary" icon={PaperPlaneRight} busy={pending !== null || settling} aria-describedby={blocker ? 'send-blocker' : undefined} disabled={blocker !== null}>
                  {live !== null ? 'Replying…' : settling ? 'Saving…' : 'Send'}
                </Button>
              )}
            </div>
          </form>
        </section>

        <div className="stack">
          <Panel title="Companion" eyebrow="State" className="panel-companion">
            <div className="companion-mini">
              <Avatar state={companion.state} size={104} level={level} />
              <p className="field-hint">Shows what this window is doing: recording, waiting for a reply, speaking aloud, or an error.</p>
            </div>
            <Button size="sm" aria-expanded={avatarPreview} aria-controls="assistant-avatar-preview" onClick={() => setAvatarPreview((v) => !v)}>{avatarPreview ? 'Close avatar preview' : 'Open avatar preview'}</Button>
          </Panel>
          {avatarPreview && <section id="assistant-avatar-preview" aria-label="Live avatar preview">
            <p className="field-hint">Live microphone amplitude while you record here. Timelines stay still in this compact preview; use Avatar Studio for animation editing. With no recording attached, its slider is a labelled simulation.</p>
            <AvatarStudio reducedMotion={true} voiceLevel={hostVoiceLevel(companion)} voiceSourceLabel="Assistant microphone" />
          </section>}

          <Panel title="Push to talk" eyebrow="Basic · Windows Speech">
            {!sttReady&&<Notice tone="warn" title="Speech recognition unavailable">{sttReason}<div className="row"><Button size="sm" busy={systemLoading} onClick={()=>void refreshSystem()}>Check again</Button><a className="btn btn-ghost btn-sm" href="#/status">System status</a></div></Notice>}
            {!support.supported && <Notice tone="warn" title="Microphone unavailable">{support.reason}</Notice>}
            <Switch
              label="Allow the microphone in Desktop Companion"
              description={micAllowed ? 'On: the microphone opens only while you hold or tap the talk button and is released as soon as you stop or cancel. Turning this off cancels any recording and forgets the permission.' : 'Off: the talk button stays disabled and this window never opens the microphone. This is separate from the Windows microphone permission.'}
              checked={micAllowed}
              disabled={!support.supported}
              onChange={setMicAllowed}
            />
            <LevelMeter level={level} active={phase === 'recording'} />
            {phase === 'recording' && (
              <p className="field-hint" aria-live="polite">
                Recording: {Math.ceil(remainingMs(elapsedMs) / 1000)} s left before it stops on its own. Esc cancels.
              </p>
            )}
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
              Voice: <strong>{settings.voice || 'backend default'}</strong> (change in Settings). Playback uses the Windows speech engine when its capability check passes. There is no stop control yet.
            </p>
            {!ttsReady&&<Notice tone="warn" title="Read aloud unavailable">{ttsReason}<div className="row"><Button size="sm" busy={systemLoading} onClick={()=>void refreshSystem()}>Check again</Button><a className="btn btn-ghost btn-sm" href="#/status">System status</a></div></Notice>}
            <Switch label="Read replies aloud automatically" checked={autoSpeak} disabled={!ttsReady} onChange={setAutoSpeak} />
            <div className="field">
              <label htmlFor="speak-text">Speak this text</label>
              <textarea id="speak-text" className="input" rows={2} maxLength={2000} value={speakText} onChange={(e) => setSpeakText(e.target.value)} placeholder="Type something to hear it" />
            </div>
            <Button icon={SpeakerHigh} busy={speaking} disabled={!speakText.trim() || !ttsReady} onClick={() => void speak(speakText)}>
              Speak
            </Button>
          </Panel>

          <Panel title="Desktop commands" eyebrow="Plan · preview · approve">
            {!plannerReady && <Notice tone="warn" title="Planner unavailable">{PLANNER_UNAVAILABLE}</Notice>}
            <p className="field-hint">
              Switch the message box to Desktop command. The offline rule planner turns one command into one proposed action. You preview it, then approve it in a Windows confirmation that defaults to Cancel. Nothing types, clicks or launches on its own.
            </p>
            <Switch
              label="Ask the local model when a command is not recognized"
              description={modelAssistReady ? `Uses only “${settings.localModel}” on ${settings.localEndpoint}. Never the cloud. Its plan is checked by the same rules.` : `Unavailable: ${unavailable(localRoute?.reason)}`}
              checked={modelAssist && modelAssistReady}
              disabled={!modelAssistReady}
              onChange={setModelAssist}
            />
          </Panel>

          <Panel title="Model route" eyebrow="Backend capability">
            <Notice tone={configured?'info':'warn'} title={configured?'Available':'Unavailable'}>{route?.reason || routeReason}</Notice>
            <div className="row wrap"><Button size="sm" busy={systemLoading} onClick={()=>void refreshSystem()}>Check again</Button><a className="btn btn-ghost btn-sm" href="#/status">System status</a></div>
            <dl className="kv-list">
              <div className="kv"><dt>Mode</dt><dd>{online ? 'Online' : 'Offline'}</dd></div>
              <div className="kv"><dt>{online ? 'Cloud model' : 'Local model'}</dt><dd>{(online ? settings.cloudModel : settings.localModel) || 'not set'}</dd></div>
              {!online && <div className="kv"><dt>Endpoint</dt><dd className="mono">{settings.localEndpoint || 'not set'}</dd></div>}
              <div className="kv"><dt>Streaming</dt><dd>{streaming ? (streaming.available ? 'Available' : 'Not available') : 'unknown'}{streaming?.reason ? <span className="sub"> · {streaming.reason}</span> : null}</dd></div>
              <div className="kv"><dt>Stop a reply</dt><dd>{cancelFeat ? (cancelFeat.available ? 'Available' : 'Not available') : 'unknown'}{cancelFeat?.reason ? <span className="sub"> · {cancelFeat.reason}</span> : null}</dd></div>
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
