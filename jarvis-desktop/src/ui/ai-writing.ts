// AI writing actions (rewrite / summarize / translate) for the user's selected text. Pure and DOM-free:
// - buildWritingRequest assembles the exact prompt the user reviews; nothing here decides to send;
// - runWritingAction sends exactly request.prompt through the existing guarded chat bridge (the main process picks the
//   local model or the stored cloud key from settings.mode; the renderer never sees a key) and never throws for expected failures.
import { TONE_PROFILES, TARGET_LANGUAGES, extractProtectedTokens, targetLanguageByCode, toneProfileById, type ToneProfile } from './tone-profiles';

export const WRITING_AI_LIMITS = Object.freeze({
  /** Selected (or explicitly chosen whole) text included in one request; longer text is cut with a warning. */
  selectionChars: 12000,
  /** The assembled prompt; stays under the chat route's 16 KiB input limit. */
  promptChars: 15000,
  /** Reply text kept for insertion. */
  replyChars: 20000,
  /** Protected items listed in the prompt. */
  protectedTokens: 40,
  /** A request with no final answer after this long is stopped and reported as incomplete. */
  timeoutMs: 180000,
});

export type WritingAction = 'rewrite' | 'summarize' | 'translate';
export const WRITING_ACTIONS: readonly Readonly<{ id: WritingAction; label: string }>[] = Object.freeze([
  Object.freeze({ id: 'rewrite' as const, label: 'Rewrite' }),
  Object.freeze({ id: 'summarize' as const, label: 'Summarize' }),
  Object.freeze({ id: 'translate' as const, label: 'Translate' }),
]);

export type WritingRequestInput = { action: WritingAction; text: string; toneProfileId?: string; targetLanguage?: string };

export type WritingRequest = Readonly<{
  action: WritingAction;
  /** The exact text that is passed to chat(). */
  prompt: string;
  /** Characters of the user's text included in the prompt (after any cut). */
  sentChars: number;
  /** Characters of the user's text before any cut. */
  inputChars: number;
  promptChars: number;
  /** Identical to prompt: shown under "What will be sent". */
  preview: string;
  truncated: boolean;
  /** The user's text exactly as included in the prompt. */
  original: string;
  profileId: string | null;
  languageCode: string | null;
  warnings: readonly string[];
}>;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const normalize = (s: string) => String(s ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '');

const isAction = (v: unknown): v is WritingAction => v === 'rewrite' || v === 'summarize' || v === 'translate';

/** Deterministic; never calls anything. Throws a descriptive Error when the request cannot be built (empty text, unknown action/profile/language). */
export function buildWritingRequest(input: WritingRequestInput): WritingRequest {
  const action = input?.action;
  if (!isAction(action)) throw new Error(`Unknown writing action "${String(action)}". Choose rewrite, summarize or translate.`);
  const warnings: string[] = [];
  let profile: ToneProfile | null = null;
  if (input.toneProfileId !== undefined && input.toneProfileId !== '') {
    profile = toneProfileById(input.toneProfileId) ?? null;
    if (!profile) throw new Error(`Unknown tone profile "${String(input.toneProfileId)}". Choose one of: ${TONE_PROFILES.map((p) => p.id).join(', ')}.`);
  } else if (action === 'rewrite') {
    profile = TONE_PROFILES[0];
  }
  const langCode = input.targetLanguage ?? 'keep';
  const language = targetLanguageByCode(langCode);
  if (!language) throw new Error(`Unknown target language "${String(langCode)}". Choose one of: ${TARGET_LANGUAGES.map((l) => l.code).join(', ')}.`);
  if (action === 'translate' && language.code === 'keep') throw new Error('Choose a target language to translate into.');

  const full = normalize(input.text);
  if (!full.trim()) throw new Error('Nothing is selected. Select some text first.');
  const truncated = full.length > WRITING_AI_LIMITS.selectionChars;
  const original = truncated ? full.slice(0, WRITING_AI_LIMITS.selectionChars) : full;
  if (truncated) warnings.push(`The text is ${full.length.toLocaleString('en-US')} characters; only the first ${WRITING_AI_LIMITS.selectionChars.toLocaleString('en-US')} are sent and the model will not see the rest.`);
  if (action === 'rewrite' && profile && original.length > profile.maxChars) warnings.push(`The text is longer than ${profile.label} allows (${profile.maxChars} characters); the model is asked to shorten it.`);

  const forApp = profile ? ` for ${profile.label.toLowerCase()} (${profile.targetApp})` : '';
  const inLang = language.code === 'keep' ? ' Keep it in its original language.' : ` Write it in ${language.label} (${language.code}).`;
  let task: string;
  if (action === 'rewrite') task = `Task: Rewrite the text below${forApp}.${inLang}`;
  else if (action === 'summarize') task = `Task: Summarize the text below${forApp} in a few short sentences or bullet points, keeping the key facts.${inLang}`;
  else task = `Task: Translate the text below into ${language.label} (${language.code})${profile ? ` and adapt it${forApp}` : ''}. Keep the meaning, names, numbers, lists and line breaks.`;

  const constraints = [
    '- Keep every fact, name and number; do not add new claims.',
    '- Keep URLs, email addresses, numbers with units, `code` spans, {{placeholders}} and %s-style markers exactly as written.',
  ];
  if (profile && action !== 'summarize') {
    constraints.push(`- Stay under ${profile.maxChars} characters.`);
    constraints.push(`- ${profile.keepLineBreaks ? 'Keep the existing line breaks.' : 'Line breaks may be merged.'}`);
  }
  constraints.push(`- Reply with the ${action === 'rewrite' ? 'rewritten text' : action === 'summarize' ? 'summary' : 'translation'} only: no preamble, no explanation, no quotes or code fences.`);

  const parts = [task];
  if (profile) parts.push(`Style rules:\n${profile.rules.map((r) => `- ${r}`).join('\n')}`);
  parts.push(`Constraints:\n${constraints.join('\n')}`);
  if (action !== 'summarize') {
    const tokens = extractProtectedTokens(original).slice(0, WRITING_AI_LIMITS.protectedTokens);
    if (tokens.length) parts.push(`Must appear unchanged:\n${tokens.map((t) => `- ${t.value}`).join('\n')}`);
  }
  parts.push(`Text (${original.length} characters):\n"""\n${original}\n"""`);
  const prompt = parts.join('\n\n');
  if (prompt.length > WRITING_AI_LIMITS.promptChars) throw new Error(`The prompt is ${prompt.length} characters; the limit is ${WRITING_AI_LIMITS.promptChars}. Select less text.`);
  return Object.freeze({
    action, prompt, preview: prompt, sentChars: original.length, inputChars: full.length, promptChars: prompt.length, truncated, original,
    profileId: profile?.id ?? null, languageCode: language.code === 'keep' ? null : language.code, warnings: Object.freeze(warnings),
  });
}

/* ---------- Destination ---------- */

export type WritingDestination = Readonly<{ mode: 'offline' | 'online'; label: 'local model' | 'Anthropic cloud (stored key)'; requiresConfirmation: boolean }>;

/** Where chat() sends the prompt for a given settings.mode. Anything but 'online' is the local model. */
export function describeDestination(mode: 'offline' | 'online'): WritingDestination {
  return mode === 'online'
    ? Object.freeze({ mode: 'online' as const, label: 'Anthropic cloud (stored key)' as const, requiresConfirmation: true })
    : Object.freeze({ mode: 'offline' as const, label: 'local model' as const, requiresConfirmation: false });
}

/* ---------- Reply cleanup ---------- */

const PREAMBLE = /^(?:(?:sure|certainly|of course|okay|ok|absolutely)[!,.]?\s+)?here(?:'s|’s|\s+is|\s+are)\b[^\n:]{0,80}:[ \t]*\n?/i;

function cleanUncapped(raw: unknown): string {
  let s = normalize(typeof raw === 'string' ? raw : '').trim();
  for (let i = 0; i < 2; i++) {
    s = s.replace(PREAMBLE, '').trim();
    const fence = s.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
    if (fence) s = fence[1].trim();
    const quotes = s.match(/^"""\n?([\s\S]*?)\n?"""$/);
    if (quotes) s = quotes[1].trim();
  }
  return s;
}

/** Strips a "Here is…:" preamble, an outer code fence or triple quotes, and caps the length. Pure. */
export function cleanWritingReply(raw: unknown): string {
  const s = cleanUncapped(raw);
  return s.length > WRITING_AI_LIMITS.replyChars ? s.slice(0, WRITING_AI_LIMITS.replyChars) : s;
}

/* ---------- Running ---------- */

export type WritingOutcome = 'complete' | 'truncated' | 'cancelled' | 'incomplete' | 'failed';
export type WritingResult = { outcome: WritingOutcome; text: string; source: 'local' | 'cloud' | 'system'; error?: string };

type Msg = { text: string; source: 'local' | 'cloud' | 'system' };
type StreamStart = { streamId: string; generation: number; route: 'local' | 'cloud' };
type StreamEvent =
  | { type: 'status' }
  | { type: 'delta'; text: string }
  | { type: 'done'; outcome: WritingOutcome; reply?: Msg | null }
  | { type: 'lost'; reason: string };

export type WritingChatApi = {
  chat(text: string): Promise<Msg>;
  chatStreamStart?(text: string): Promise<StreamStart>;
  onChatStream?(start: StreamStart, handler: (event: any) => void): () => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  chatStreamCancel?(streamId: string): Promise<boolean>;
};

export type WritingRunOptions = { onDelta?: (delta: string, soFar: string) => void; signal?: AbortSignal; timeoutMs?: number };

const message = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : typeof e === 'string' && e ? e : fallback);

function finish(outcome: WritingOutcome, raw: string, source: WritingResult['source'], error?: string): WritingResult {
  const full = cleanUncapped(raw);
  const capped = full.length > WRITING_AI_LIMITS.replyChars;
  const text = capped ? full.slice(0, WRITING_AI_LIMITS.replyChars) : full;
  const out: WritingResult = { outcome: outcome === 'complete' && capped ? 'truncated' : outcome, text, source };
  if (error) out.error = error;
  return out;
}

/** Sends exactly request.prompt. Prefers the stream API (cancellable), otherwise chat(). Resolves with an outcome; never throws for expected failures. */
export async function runWritingAction(api: WritingChatApi, request: Pick<WritingRequest, 'prompt'>, opts: WritingRunOptions = {}): Promise<WritingResult> {
  const { signal, onDelta } = opts;
  const timeoutMs = opts.timeoutMs ?? WRITING_AI_LIMITS.timeoutMs;
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) return { outcome: 'failed', text: '', source: 'system', error: 'There is no prompt to send.' };
  if (signal?.aborted) return { outcome: 'cancelled', text: '', source: 'system', error: 'Cancelled before sending.' };

  if (typeof api.chatStreamStart === 'function' && typeof api.onChatStream === 'function') {
    let start: StreamStart;
    try {
      start = await api.chatStreamStart(request.prompt);
    } catch (e) {
      return { outcome: 'failed', text: '', source: 'system', error: message(e, 'The assistant could not start a reply.') };
    }
    const cancelStream = () => { if (api.chatStreamCancel) void api.chatStreamCancel(start.streamId).catch(() => undefined); };
    let collected = '';
    return new Promise<WritingResult>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (r: WritingResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try { unsubscribe?.(); } catch { /* already gone */ }
        resolve(r);
      };
      const onAbort = () => { cancelStream(); settle(finish('cancelled', collected, start.route, 'Stopped by you; the partial text is kept.')); };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { cancelStream(); settle(finish('incomplete', collected, start.route, `No final reply after ${Math.round(timeoutMs / 1000)} seconds; stopped.`)); }, timeoutMs);
      try {
        unsubscribe = api.onChatStream!(start, (ev: StreamEvent) => {
          if (settled || !ev || typeof ev !== 'object') return;
          if (ev.type === 'delta' && typeof ev.text === 'string') {
            if (collected.length < WRITING_AI_LIMITS.replyChars + 1000) collected += ev.text;
            try { onDelta?.(ev.text, collected); } catch { /* UI callback errors do not stop the run */ }
          } else if (ev.type === 'done') {
            const raw = typeof ev.reply?.text === 'string' && ev.reply.text ? ev.reply.text : collected;
            const source = ev.reply?.source ?? start.route;
            if (ev.outcome === 'failed' || source === 'system') settle({ outcome: 'failed', text: '', source: 'system', error: ev.reply?.text || 'The assistant produced no reply.' });
            else settle(finish(ev.outcome ?? 'complete', raw, source, ev.outcome === 'incomplete' ? 'The connection ended early; the reply is incomplete.' : undefined));
          } else if (ev.type === 'lost') {
            settle(finish('incomplete', collected, start.route, `The connection to the assistant was lost (${String(ev.reason)}).`));
          }
        });
        if (settled) { try { unsubscribe?.(); } catch { /* ignore */ } }
      } catch (e) {
        cancelStream();
        settle({ outcome: 'failed', text: '', source: 'system', error: message(e, 'The assistant stream could not be read.') });
      }
    });
  }

  // One-shot fallback: chat() cannot be stopped mid-request, so cancel/timeout stop waiting and say so honestly.
  return new Promise<WritingResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (r: WritingResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => settle({ outcome: 'cancelled', text: '', source: 'system', error: 'Stopped waiting. This bridge cannot stop a running reply, so it may still appear in the Assistant conversation history.' });
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => settle({ outcome: 'incomplete', text: '', source: 'system', error: `No reply after ${Math.round(timeoutMs / 1000)} seconds.` }), timeoutMs);
    Promise.resolve()
      .then(() => api.chat(request.prompt))
      .then((reply) => {
        if (!reply || typeof reply.text !== 'string') return settle({ outcome: 'failed', text: '', source: 'system', error: 'The assistant produced no reply.' });
        if (reply.source === 'system') return settle({ outcome: 'failed', text: '', source: 'system', error: reply.text || 'The assistant produced no reply.' });
        const r = finish('complete', reply.text, reply.source === 'cloud' ? 'cloud' : 'local');
        settle(r.text ? r : { ...r, outcome: 'failed', error: 'The assistant returned an empty reply.' });
      }, (e) => settle({ outcome: 'failed', text: '', source: 'system', error: message(e, 'The assistant could not reply.') }));
  });
}
