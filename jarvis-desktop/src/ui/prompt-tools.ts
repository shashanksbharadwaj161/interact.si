// Bounded writing draft tools. Everything here is deterministic text assembly plus a small sender:
// - the user picks a tool and app-owned sources, sees the exact prompt, and only an explicit Send calls the assistant;
// - nothing is sent automatically, no model output is invented, and the reply is whatever the existing route returned;
// - sources are cited by their real record ids ([note:…], [task:…], [checkpoint:…]); missing records are reported, not faked.
import type { AppState, ChatStreamEvent, ChatStreamOutcome, ChatStreamRoute, JarvisAPI } from '../shared/contracts';
import type { ProductivityState } from '../../electron/services/store';
import { sanitizeText } from '../../electron/services/search';

export const PROMPT_LIMITS = {
  /** Draft text (note body, pasted text or error output) included in a prompt. */
  inputChars: 6000,
  /** A selected passage. */
  selectionChars: 2000,
  /** Each attached source record. */
  sourceChars: 1500,
  sources: 4,
  /** The assembled prompt; Send is refused above this. */
  promptChars: 12000,
  /** Streamed reply text kept in the panel; anything longer is cut and flagged (the chat history keeps the full stored reply). */
  replyChars: 20000,
  languageChars: 40,
} as const;

export type ToolId = 'translate' | 'tone' | 'explain' | 'diagnose';
export type ToolOption = { key: string; label: string; values: readonly { value: string; label: string }[] };
export type ToolDef = {
  id: ToolId;
  label: string;
  description: string;
  /** 'text': the draft body. 'selection': a selected passage of a note (falls back to the whole body with a warning). 'error': pasted error output. */
  input: 'text' | 'selection' | 'error';
  options: readonly ToolOption[];
};

export const TONES = [
  { value: 'neutral', label: 'Neutral and clear' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'formal', label: 'Formal' },
  { value: 'concise', label: 'Shorter, same meaning' },
] as const;

export const LANGUAGE_SUGGESTIONS = ['English', 'Hindi', 'Spanish', 'French', 'German', 'Japanese', 'Portuguese'] as const;

export const TOOLS: readonly ToolDef[] = [
  { id: 'translate', label: 'Translate', description: 'Translate the draft into another language, keeping names and formatting.', input: 'text', options: [] },
  { id: 'tone', label: 'Tone cleanup', description: 'Rewrite the draft in a chosen tone without changing what it says.', input: 'text', options: [{ key: 'tone', label: 'Tone', values: TONES }] },
  { id: 'explain', label: 'Explain selection', description: 'Explain the selected passage of the current note in plain language.', input: 'selection', options: [] },
  { id: 'diagnose', label: 'Diagnose error', description: 'Read pasted error output and suggest likely causes and checks.', input: 'error', options: [] },
];

export const toolById = (id: string): ToolDef | undefined => TOOLS.find((t) => t.id === id);

/* ---------- Sources ---------- */

export type SourceKind = 'note' | 'task' | 'checkpoint';
export type SourcePick = { kind: SourceKind; id: string };
export type PromptSource = { kind: SourceKind; id: string; title: string; text: string; truncated: boolean };

/** Records the user may attach: only what this app owns. Each candidate carries its id so citations are real. */
export function listSourceCandidates(state: AppState, prod: ProductivityState | null, exclude?: SourcePick): { kind: SourceKind; id: string; title: string; hint: string }[] {
  const out: { kind: SourceKind; id: string; title: string; hint: string }[] = [];
  for (const n of state.notes) out.push({ kind: 'note', id: n.id, title: n.title || 'Untitled note', hint: `note · ${n.updatedAt.slice(0, 10)}` });
  for (const t of state.tasks) out.push({ kind: 'task', id: t.id, title: t.title, hint: `task · ${t.done ? 'done' : 'open'}` });
  for (const c of prod?.checkpoints ?? []) out.push({ kind: 'checkpoint', id: c.id, title: c.title, hint: `checkpoint · ${c.createdAt.slice(0, 10)}` });
  return out.filter((c) => !(exclude && c.kind === exclude.kind && c.id === exclude.id));
}

const cut = (s: string, n: number): { text: string; truncated: boolean } => (s.length > n ? { text: `${s.slice(0, n).trimEnd()}\n[… cut at ${n} characters]`, truncated: true } : { text: s, truncated: false });
const clean = (s: string) => s.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();

/** Resolves picks against the current records. Deleted records come back in `missing` so the UI can say so and drop them. */
export function collectSources(picks: readonly SourcePick[], state: AppState, prod: ProductivityState | null): { sources: PromptSource[]; missing: SourcePick[] } {
  const sources: PromptSource[] = [];
  const missing: SourcePick[] = [];
  for (const p of picks.slice(0, PROMPT_LIMITS.sources)) {
    let title = '';
    let body = '';
    let found = false;
    if (p.kind === 'note') { const n = state.notes.find((x) => x.id === p.id); if (n) { found = true; title = n.title || 'Untitled note'; body = n.body; } }
    else if (p.kind === 'task') { const t = state.tasks.find((x) => x.id === p.id); if (t) { found = true; title = t.title; body = `Status: ${t.done ? 'done' : 'open'}${t.due ? `\nDue: ${t.due}` : ''}`; } }
    else if (p.kind === 'checkpoint') { const c = prod?.checkpoints.find((x) => x.id === p.id); if (c) { found = true; title = c.title; body = `Recorded: ${c.createdAt}\n${c.note}`; } }
    if (!found) { missing.push(p); continue; }
    const b = cut(clean(body), PROMPT_LIMITS.sourceChars);
    sources.push({ kind: p.kind, id: p.id, title: sanitizeText(title).slice(0, 120), text: b.text, truncated: b.truncated });
  }
  return { sources, missing };
}

/* ---------- Prompt assembly ---------- */

export type PromptInput = {
  /** Draft body, pasted text or error output. */
  text: string;
  /** The selected passage, when the editor had one. */
  selection?: string;
  /** The note the draft came from, cited as [note:id] when present. */
  noteId?: string;
  noteTitle?: string;
  options: Record<string, string>;
};

export type PromptDraft = {
  tool: ToolId;
  /** The exact text that Send would submit. Empty when ok is false. */
  text: string;
  chars: number;
  ok: boolean;
  reason?: string;
  warnings: string[];
  citations: { kind: SourceKind | 'note'; id: string }[];
  truncated: boolean;
};

const RULES = 'Rules: use only the text and sources below; do not invent facts, files or records. If something is missing, say so. Cite a source by its tag (for example [note:abc]) when you use it.';

function validLanguage(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s || s.length > PROMPT_LIMITS.languageChars || !/^[\p{L}][\p{L}\s()'-]*$/u.test(s)) return null;
  return s;
}

/** Builds the prompt for one tool. Deterministic for the same input; never calls anything. */
export function buildPrompt(toolId: ToolId, input: PromptInput, sources: readonly PromptSource[]): PromptDraft {
  const tool = toolById(toolId);
  const base: PromptDraft = { tool: toolId, text: '', chars: 0, ok: false, warnings: [], citations: [], truncated: false };
  if (!tool) return { ...base, reason: 'Unknown tool.' };
  const refuse = (reason: string): PromptDraft => ({ ...base, reason });

  const body = clean(input.text);
  const selection = clean(input.selection ?? '');
  let subject: { label: string; text: string; truncated: boolean };
  if (tool.input === 'selection') {
    if (selection) {
      const s = cut(selection, PROMPT_LIMITS.selectionChars);
      subject = { label: 'Selected passage', text: s.text, truncated: s.truncated };
    } else if (body) {
      const s = cut(body, PROMPT_LIMITS.inputChars);
      subject = { label: 'Whole note (nothing was selected)', text: s.text, truncated: s.truncated };
      base.warnings.push('Nothing is selected in the editor, so the whole note is used.');
    } else return refuse('Select a passage in the note, or type some text, first.');
  } else {
    if (!body) return refuse(tool.input === 'error' ? 'Paste the error output first.' : 'The draft is empty.');
    const s = cut(body, PROMPT_LIMITS.inputChars);
    subject = { label: tool.input === 'error' ? 'Error output' : 'Draft', text: s.text, truncated: s.truncated };
  }
  if (subject.truncated) base.warnings.push(`The ${subject.label.toLowerCase()} was cut at its limit; the model will not see the rest.`);

  let task: string;
  switch (tool.id) {
    case 'translate': {
      const lang = validLanguage(input.options.language);
      if (!lang) return refuse('Enter the target language (letters only, up to 40 characters).');
      task = `Translate the draft below into ${lang}. Keep the meaning, names, numbers, lists and line breaks. Reply with the translation only.`;
      break;
    }
    case 'tone': {
      const tone = TONES.find((t) => t.value === (input.options.tone ?? 'neutral'));
      if (!tone) return refuse('Choose a tone.');
      task = `Rewrite the draft below in this tone: ${tone.label.toLowerCase()}. Keep every fact, name and number; do not add new claims. Reply with the rewritten text only.`;
      break;
    }
    case 'explain':
      task = 'Explain the passage below in plain language: what it says, any terms worth defining, and anything unclear or contradictory. Keep the explanation short.';
      break;
    case 'diagnose':
      task = 'The text below is error output. Say what it most likely means, the two or three most likely causes, and what to check first. Do not guess at files, commands or settings that are not mentioned; if you cannot tell, say what information would help.';
      break;
  }

  const parts: string[] = [`Task: ${task}`, RULES];
  const origin = input.noteId ? ` from app note [note:${input.noteId}]${input.noteTitle ? ` "${sanitizeText(input.noteTitle).slice(0, 80)}"` : ''}` : '';
  if (input.noteId) base.citations.push({ kind: 'note', id: input.noteId });
  parts.push(`${subject.label}${origin} (${subject.text.length} characters):\n"""\n${subject.text}\n"""`);
  if (sources.length) {
    parts.push('Sources chosen by the user (records saved in this app):');
    for (const s of sources.slice(0, PROMPT_LIMITS.sources)) {
      parts.push(`[${s.kind}:${s.id}] ${s.title}\n"""\n${s.text}\n"""`);
      base.citations.push({ kind: s.kind, id: s.id });
      if (s.truncated) base.warnings.push(`Source "${s.title}" was cut at ${PROMPT_LIMITS.sourceChars} characters.`);
    }
  }
  const text = parts.join('\n\n');
  if (text.length > PROMPT_LIMITS.promptChars) return { ...base, text, chars: text.length, reason: `The prompt is ${text.length.toLocaleString()} characters; the limit is ${PROMPT_LIMITS.promptChars.toLocaleString()}. Remove a source or shorten the draft.` };
  return { ...base, text, chars: text.length, ok: true, truncated: subject.truncated || sources.some((s) => s.truncated) };
}

/* ---------- Sending ---------- */

export type ReplyState = {
  status: 'idle' | 'sending' | 'streaming' | 'stopping' | 'done' | 'error';
  route?: ChatStreamRoute;
  text: string;
  outcome?: ChatStreamOutcome;
  error?: string;
  /** True when the panel stopped keeping text at PROMPT_LIMITS.replyChars. */
  cut: boolean;
  /** 'stream' when events arrive as generated, 'single' for the one-shot chat call. */
  transport?: 'stream' | 'single';
};

export const IDLE_REPLY: ReplyState = { status: 'idle', text: '', cut: false };

const keepBounded = (prev: ReplyState, add: string): Pick<ReplyState, 'text' | 'cut'> => {
  if (prev.cut) return { text: prev.text, cut: true };
  const next = prev.text + add;
  return next.length > PROMPT_LIMITS.replyChars ? { text: next.slice(0, PROMPT_LIMITS.replyChars), cut: true } : { text: next, cut: false };
};

/** Folds one stream event into the panel state. Pure; the stored chat remains the source of truth for the full reply. */
export function reduceReply(prev: ReplyState, ev: ChatStreamEvent): ReplyState {
  switch (ev.type) {
    case 'status': return { ...prev, status: prev.status === 'stopping' ? 'stopping' : 'streaming' };
    case 'delta': return { ...prev, status: prev.status === 'stopping' ? 'stopping' : 'streaming', ...keepBounded(prev, ev.text) };
    case 'done': {
      const full = ev.reply?.text ?? prev.text;
      const bounded = full.length > PROMPT_LIMITS.replyChars ? { text: full.slice(0, PROMPT_LIMITS.replyChars), cut: true } : { text: full, cut: false };
      return ev.outcome === 'failed'
        ? { ...prev, status: 'error', outcome: ev.outcome, error: 'The assistant produced no reply.', ...bounded }
        : { ...prev, status: 'done', outcome: ev.outcome, ...bounded };
    }
    case 'lost': return { ...prev, status: 'error', error: `The connection to the assistant was lost (${ev.reason}). Check the chat history for anything that was stored.` };
    default: return prev;
  }
}

export const errorText = (e: unknown, fallback: string): string => (e instanceof Error && e.message ? e.message : typeof e === 'string' && e ? e : fallback);

export type DraftSender = {
  /** Sends exactly `text` through the existing assistant route. Resolves when the reply is final. Never called by anything but the Send button. */
  send(text: string, onState: (s: ReplyState) => void): Promise<void>;
  /** Stops a streaming reply when the bridge supports it. */
  cancel(): Promise<void>;
  readonly canCancel: boolean;
};

/** Uses the streaming route when the bridge has it (replies appear as generated and can be stopped), otherwise the one-shot chat call. */
export function createDraftSender(api: Pick<JarvisAPI, 'chat' | 'chatStreamStart' | 'onChatStream' | 'chatStreamCancel'>, opts: { streaming?: boolean } = {}): DraftSender {
  const streaming = opts.streaming !== false && Boolean(api.chatStreamStart && api.onChatStream);
  let active: { streamId: string; unsubscribe: () => void } | null = null;
  let state: ReplyState = IDLE_REPLY;
  return {
    get canCancel() { return streaming && Boolean(api.chatStreamCancel); },
    async send(text, onState) {
      if (active || state.status === 'sending' || state.status === 'streaming') throw new Error('A reply is already in progress.');
      const emit = (s: ReplyState) => { state = s; onState(s); };
      emit({ ...IDLE_REPLY, status: 'sending', transport: streaming ? 'stream' : 'single' });
      if (!streaming) {
        try {
          const reply = await api.chat(text);
          const cut = reply.text.length > PROMPT_LIMITS.replyChars;
          emit({ status: 'done', text: cut ? reply.text.slice(0, PROMPT_LIMITS.replyChars) : reply.text, cut, route: reply.source === 'cloud' ? 'cloud' : 'local', outcome: 'complete', transport: 'single' });
        } catch (e) {
          emit({ ...IDLE_REPLY, status: 'error', error: errorText(e, 'The assistant could not reply.'), transport: 'single' });
        }
        return;
      }
      let start;
      try {
        start = await api.chatStreamStart!(text);
      } catch (e) {
        emit({ ...IDLE_REPLY, status: 'error', error: errorText(e, 'The assistant could not start a reply.'), transport: 'stream' });
        return;
      }
      emit({ ...state, route: start.route });
      await new Promise<void>((resolve) => {
        const unsubscribe = api.onChatStream!(start, (ev) => {
          const next = reduceReply(state, ev);
          emit(next);
          if (next.status === 'done' || next.status === 'error') {
            active?.unsubscribe();
            active = null;
            resolve();
          }
        });
        active = { streamId: start.streamId, unsubscribe };
      });
    },
    async cancel() {
      if (!active || !api.chatStreamCancel) return;
      state = { ...state, status: 'stopping' };
      await api.chatStreamCancel(active.streamId);
    },
  };
}

/**
 * Where a Send would go, from the user's settings and the known key status; the stream start reports the route actually taken.
 * Online mode never falls back to the local model: without a key the backend refuses, and with an unknown key status the
 * prompt may reach the cloud provider, so neither case is described as staying on this computer.
 */
export function describeRoute(settings: { mode: 'offline' | 'online' } | null, cloudConfigured: boolean | null): { route: ChatStreamRoute | 'refused' | 'unknown'; text: string } {
  if (settings?.mode === 'online') {
    if (cloudConfigured === true) return { route: 'cloud', text: 'Online mode with your key: this prompt leaves the computer and goes to your cloud model.' };
    if (cloudConfigured === false) return { route: 'refused', text: 'Online mode without a cloud key: the assistant will refuse this prompt and nothing is sent. Add a key in Settings or switch to offline mode.' };
    return { route: 'unknown', text: 'Online mode, key status unknown: this prompt may go to the cloud provider. Sending is disabled until key status is known; check Settings or switch to offline mode.' };
  }
  return { route: 'local', text: 'Offline mode: the local model answers; nothing leaves the computer.' };
}
