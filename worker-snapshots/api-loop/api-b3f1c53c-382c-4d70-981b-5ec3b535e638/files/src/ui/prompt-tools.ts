// Bounded writing draft tools. Everything here is deterministic text assembly plus a small sender:
// - the user picks a tool and app-owned sources, sees the exact prompt, and only an explicit Send calls the assistant;
// - nothing is sent automatically, no model output is invented, and the reply is whatever the existing route returned;
// - sources are cited by their real record ids ([note:…], [task:…], [checkpoint:…]); missing records are reported, not faked.
import type { AppState, ChatStreamEvent, ChatStreamOutcome, ChatStreamRoute, JarvisAPI, Settings } from '../shared/contracts';
import type { ProductivityState } from '../../electron/services/store';
import { sanitizeText } from '../../electron/services/search';
import { readPref, writePref } from './prefs';

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

/* =====================================================================================================================
 * Translation and app-specific writing tone (feature 26).
 * Deterministic prompt builders, user-editable tone presets persisted in UI prefs, and a parser that strips model
 * preamble. Sending uses createDraftSender above (the existing chat / chatStream route and its cancel path).
 * =================================================================================================================== */

export const REWRITE_LIMITS = {
  /** Text sent for translation or tone rewriting. */
  inputChars: 6000,
  /** Target languages in one translation request. */
  targets: 5,
  customPresets: 12,
  presetLabelChars: 40,
  presetInstructionChars: 400,
} as const;

export type RewriteDraft = {
  /** The exact text Run would submit. Empty when ok is false. */
  text: string;
  chars: number;
  ok: boolean;
  reason?: string;
  warnings: string[];
  truncated: boolean;
};

const AUTO = 'auto' as const;
export type TranslationRequest = {
  /** 'auto' lets the model detect the source language; otherwise an explicit language name. */
  source: typeof AUTO | string;
  /** Target languages, in the order the sections should appear. */
  targets: readonly string[];
  /** Keep line breaks, lists, Markdown, code and links exactly. */
  keepFormatting: boolean;
};

/** Trimmed, validated, de-duplicated (case-insensitive, first spelling kept) targets, in the user's order. */
export function normalizeTargets(targets: readonly string[]): { targets: string[]; rejected: string[] } {
  const out: string[] = [];
  const rejected: string[] = [];
  for (const raw of targets) {
    const v = validLanguage(raw);
    if (!v) { if (String(raw ?? '').trim()) rejected.push(String(raw).trim().slice(0, PROMPT_LIMITS.languageChars)); continue; }
    const name = v.replace(/\s+/g, ' ');
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return { targets: out, rejected };
}

/** Heading line used to separate languages in a multi-target reply. */
export const sectionHeading = (language: string) => `=== ${language} ===`;

const NO_PREAMBLE = 'Reply with the result only: no introduction, notes, explanations or surrounding quotation marks.';

/** Builds the translation prompt. Deterministic for the same text and request; never calls anything. */
export function buildTranslationPrompt(text: string, req: TranslationRequest): RewriteDraft {
  const base: RewriteDraft = { text: '', chars: 0, ok: false, warnings: [], truncated: false };
  const body = clean(text);
  if (!body) return { ...base, reason: 'Enter or paste the text to translate.' };
  const { targets, rejected } = normalizeTargets(req.targets);
  if (rejected.length) return { ...base, reason: `Not a language name: ${rejected.join(', ')}. Use letters only, up to ${PROMPT_LIMITS.languageChars} characters.` };
  if (targets.length === 0) return { ...base, reason: 'Choose at least one target language.' };
  if (targets.length > REWRITE_LIMITS.targets) return { ...base, reason: `Choose at most ${REWRITE_LIMITS.targets} target languages.` };
  let source: string | null = null;
  if (req.source !== AUTO) {
    source = validLanguage(req.source);
    if (!source) return { ...base, reason: 'The source language must be "auto" or a language name.' };
    if (targets.length === 1 && targets[0].toLowerCase() === source.toLowerCase()) return { ...base, reason: 'The source and target language are the same.' };
  }
  const s = cut(body, REWRITE_LIMITS.inputChars);
  if (s.truncated) base.warnings.push(`The text was cut at ${REWRITE_LIMITS.inputChars.toLocaleString()} characters; the model will not see the rest.`);
  const from = source ? `from ${source}` : 'from the language it is written in (detect it)';
  const into = targets.length === 1 ? targets[0] : `each of these languages: ${targets.join(', ')}`;
  const format = req.keepFormatting
    ? 'Keep the formatting exactly: line breaks, blank lines, lists, Markdown, code blocks, inline code, links, names and numbers stay as they are; translate only the human-language text.'
    : 'You may reflow lines and drop decorative formatting, but keep names, numbers and links unchanged.';
  const output = targets.length === 1
    ? NO_PREAMBLE
    : `Write each translation under its own heading line, in this order, using exactly these headings: ${targets.map(sectionHeading).join(' ')}. ${NO_PREAMBLE}`;
  const prompt = [
    `Task: Translate the text below ${from} into ${into}. Keep the meaning; do not add, remove or explain anything.`,
    format,
    output,
    `Text (${s.text.length} characters):\n"""\n${s.text}\n"""`,
  ].join('\n\n');
  if (prompt.length > PROMPT_LIMITS.promptChars) return { ...base, reason: 'The prompt is too long; shorten the text.' };
  return { ...base, text: prompt, chars: prompt.length, ok: true, truncated: s.truncated };
}

/* ---------- Tone presets ---------- */

export const TONE_CONTEXTS = [
  { id: 'email', label: 'Email', describe: 'an email' },
  { id: 'chat', label: 'Team chat', describe: 'a team chat message' },
  { id: 'issue-tracker', label: 'Issue tracker', describe: 'an issue tracker ticket or comment' },
  { id: 'documentation', label: 'Documentation', describe: 'product or technical documentation' },
  { id: 'code-comment', label: 'Code comment', describe: 'a source code comment' },
] as const;
export type ToneContextId = (typeof TONE_CONTEXTS)[number]['id'];
export const toneContext = (id: string) => TONE_CONTEXTS.find((c) => c.id === id);

export type TonePreset = { id: string; label: string; context: ToneContextId; instructions: string; builtIn: boolean };
/** Persisted shape (UI prefs / localStorage key TONE_PRESETS_PREF_KEY). Built-in presets are never stored. */
export type TonePresetStore = { version: 1; presets: Omit<TonePreset, 'builtIn'>[] };

export const TONE_PRESETS_PREF_KEY = 'writing.tonePresets';
export const EMPTY_TONE_PRESETS: TonePresetStore = { version: 1, presets: [] };

export const BUILT_IN_TONE_PRESETS: readonly TonePreset[] = [
  { id: 'email', label: 'Email: clear and polite', context: 'email', builtIn: true, instructions: 'Clear, polite and complete. One idea per paragraph, a clear request or next step near the end. Keep a greeting or sign-off only if the text already has one.' },
  { id: 'chat', label: 'Team chat: short and friendly', context: 'chat', builtIn: true, instructions: 'Short and friendly. Plain sentences, no greeting or sign-off, a list only when there are several items.' },
  { id: 'issue-tracker', label: 'Issue tracker: factual', context: 'issue-tracker', builtIn: true, instructions: 'Factual and reproducible: a one-line summary, then steps, expected and actual result, and environment details if the text mentions them. No blame and no speculation.' },
  { id: 'documentation', label: 'Documentation: neutral and precise', context: 'documentation', builtIn: true, instructions: 'Neutral, present tense, addressed to the reader as "you". Precise terms and short paragraphs. Headings, code and commands stay unchanged.' },
  { id: 'code-comment', label: 'Code comment: terse', context: 'code-comment', builtIn: true, instructions: 'Terse and technical. Explain why, not what. One to three lines, no marketing words, identifiers kept exactly.' },
];

const PRESET_TEXT_OK = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

/** Validates one custom preset. Returns the cleaned preset or the reason it was refused. */
export function validateTonePreset(input: { id?: string; label?: unknown; context?: unknown; instructions?: unknown }): { ok: true; preset: Omit<TonePreset, 'builtIn'> } | { ok: false; reason: string } {
  const label = typeof input.label === 'string' ? input.label.replace(/\s+/g, ' ').trim() : '';
  const instructions = typeof input.instructions === 'string' ? input.instructions.replace(/\r\n?/g, '\n').trim() : '';
  const context = typeof input.context === 'string' ? toneContext(input.context)?.id : undefined;
  if (!label || label.length > REWRITE_LIMITS.presetLabelChars || !PRESET_TEXT_OK.test(label)) return { ok: false, reason: `Give the preset a name of 1 to ${REWRITE_LIMITS.presetLabelChars} characters.` };
  if (!context) return { ok: false, reason: 'Choose where the text will be used.' };
  if (!instructions || instructions.length > REWRITE_LIMITS.presetInstructionChars || !PRESET_TEXT_OK.test(instructions.replace(/\n/g, ' '))) return { ok: false, reason: `Describe the style in 1 to ${REWRITE_LIMITS.presetInstructionChars} characters.` };
  const id = typeof input.id === 'string' && /^custom-[a-z0-9-]{1,60}$/.test(input.id) ? input.id : '';
  return { ok: true, preset: { id, label, context, instructions } };
}

/** Reads whatever is stored and keeps only valid, unique custom presets. Anything malformed becomes the empty store. */
export function sanitizeTonePresets(raw: unknown): TonePresetStore {
  if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { presets?: unknown }).presets)) return { version: 1, presets: [] };
  const presets: Omit<TonePreset, 'builtIn'>[] = [];
  for (const p of (raw as { presets: unknown[] }).presets) {
    if (!p || typeof p !== 'object') continue;
    const v = validateTonePreset(p as Record<string, unknown>);
    if (!v.ok || !v.preset.id || presets.some((x) => x.id === v.preset.id)) continue;
    presets.push(v.preset);
    if (presets.length >= REWRITE_LIMITS.customPresets) break;
  }
  return { version: 1, presets };
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'preset';

/** Adds a new custom preset or replaces the one with the same id. Pure: returns a new store or the reason it was refused. */
export function upsertTonePreset(store: TonePresetStore, input: { id?: string; label: string; context: string; instructions: string }): { ok: true; store: TonePresetStore; id: string } | { ok: false; reason: string } {
  const v = validateTonePreset(input);
  if (!v.ok) return v;
  const current = sanitizeTonePresets(store).presets;
  const existing = v.preset.id ? current.findIndex((p) => p.id === v.preset.id) : -1;
  if (existing >= 0) {
    const presets = current.map((p, i) => (i === existing ? v.preset : p));
    return { ok: true, store: { version: 1, presets }, id: v.preset.id };
  }
  if (current.length >= REWRITE_LIMITS.customPresets) return { ok: false, reason: `You can keep up to ${REWRITE_LIMITS.customPresets} custom presets. Delete one first.` };
  const stem = `custom-${slug(v.preset.label)}`;
  let id = stem;
  for (let n = 2; current.some((p) => p.id === id); n++) id = `${stem}-${n}`;
  return { ok: true, store: { version: 1, presets: [...current, { ...v.preset, id }] }, id };
}

export function removeTonePreset(store: TonePresetStore, id: string): TonePresetStore {
  return { version: 1, presets: sanitizeTonePresets(store).presets.filter((p) => p.id !== id) };
}

/** Built-ins first, then the user's presets. */
export function allTonePresets(store: TonePresetStore): TonePreset[] {
  return [...BUILT_IN_TONE_PRESETS, ...sanitizeTonePresets(store).presets.map((p) => ({ ...p, builtIn: false }))];
}

type PrefIo = { read: <T>(key: string, fallback: T) => T; write: <T>(key: string, value: T) => void };
const defaultIo: PrefIo = { read: readPref, write: writePref };

/** Loads custom presets through the UI prefs store (localStorage). Unreadable or malformed data loads as empty. */
export function loadTonePresets(io: Pick<PrefIo, 'read'> = defaultIo): TonePresetStore {
  return sanitizeTonePresets(io.read<unknown>(TONE_PRESETS_PREF_KEY, EMPTY_TONE_PRESETS));
}
/** Saves custom presets (only the validated shape) through the UI prefs store. */
export function saveTonePresets(store: TonePresetStore, io: Pick<PrefIo, 'write'> = defaultIo): TonePresetStore {
  const clean = sanitizeTonePresets(store);
  io.write(TONE_PRESETS_PREF_KEY, clean);
  return clean;
}

/** Builds the tone rewrite prompt. Deterministic for the same text and preset; never calls anything. */
export function buildTonePrompt(text: string, preset: Pick<TonePreset, 'label' | 'context' | 'instructions'> | null | undefined): RewriteDraft {
  const base: RewriteDraft = { text: '', chars: 0, ok: false, warnings: [], truncated: false };
  const body = clean(text);
  if (!body) return { ...base, reason: 'Enter or paste the text to rewrite.' };
  if (!preset) return { ...base, reason: 'Choose a tone preset.' };
  const v = validateTonePreset(preset);
  if (!v.ok) return { ...base, reason: v.reason };
  const ctx = toneContext(v.preset.context)!;
  const s = cut(body, REWRITE_LIMITS.inputChars);
  if (s.truncated) base.warnings.push(`The text was cut at ${REWRITE_LIMITS.inputChars.toLocaleString()} characters; the model will not see the rest.`);
  const prompt = [
    `Task: Rewrite the text below so it reads well as ${ctx.describe} (preset: ${v.preset.label}).`,
    `Style: ${v.preset.instructions}`,
    'Rules: keep every fact, name, number, link and code identifier; do not add claims, greetings or sign-offs the text does not imply; keep the original language.',
    NO_PREAMBLE,
    `Text (${s.text.length} characters):\n"""\n${s.text}\n"""`,
  ].join('\n\n');
  if (prompt.length > PROMPT_LIMITS.promptChars) return { ...base, reason: 'The prompt is too long; shorten the text.' };
  return { ...base, text: prompt, chars: prompt.length, ok: true, truncated: s.truncated };
}

/* ---------- Result parsing ---------- */

const PREAMBLE_LINE = /^(?:(?:sure|certainly|of course|okay|ok|absolutely|great|got it)\b[^\n]{0,160}|(?:here(?:'s| is| are)|below is|below are)\b[^\n]{0,160}|(?:the |your )?(?:translation|translated text|rewritten text|rewrite|revised text|revised version|rewritten version)(?: (?:in|into) [\p{L} ]{1,40})?\s*:\s*)$/iu;
const CLOSING_LINE = /^(?:let me know\b|i hope\b|hope this helps\b|feel free\b|if you(?:'d| would) like\b|would you like\b)[^\n]{0,200}$/i;

/**
 * Removes model chatter around a rewrite: leading lines such as "Sure! Here is the translation:", closing offers such
 * as "Let me know if…", and one pair of quotes or code fences around the whole reply when the original text had none.
 * Never touches the middle of the text. Returns what was removed so the panel can say so.
 */
export function stripModelPreamble(reply: string, original = ''): { text: string; removed: string[] } {
  let text = reply.replace(/\r\n?/g, '\n').trim();
  const removed: string[] = [];
  for (let i = 0; i < 3; i++) {
    const nl = text.indexOf('\n');
    const first = (nl < 0 ? text : text.slice(0, nl)).trim();
    const rest = nl < 0 ? '' : text.slice(nl + 1).trim();
    if (!rest || !PREAMBLE_LINE.test(first)) break;
    removed.push(first);
    text = rest;
  }
  for (let i = 0; i < 2; i++) {
    const nl = text.lastIndexOf('\n');
    if (nl < 0) break;
    const last = text.slice(nl + 1).trim();
    if (!CLOSING_LINE.test(last)) break;
    removed.push(last);
    text = text.slice(0, nl).trim();
  }
  const orig = original.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence && !orig.startsWith('```') && !fence[1].includes('```')) { removed.push('code fence'); text = fence[1].trim(); }
  const quoted = /^(?:"""\n?([\s\S]*?)\n?"""|"([^"]*)"|“([^”]*)”)$/.exec(text);
  if (quoted && !/^["“]/.test(orig)) { removed.push('quotation marks'); text = (quoted[1] ?? quoted[2] ?? quoted[3] ?? '').trim(); }
  return { text, removed };
}

export type TranslationResult = { sections: { language: string; text: string }[]; missing: string[]; removed: string[] };

/** Splits a translation reply into one section per requested language, stripping preamble. */
export function parseTranslationResult(reply: string, targets: readonly string[], original = ''): TranslationResult {
  const wanted = normalizeTargets(targets).targets;
  if (wanted.length <= 1) {
    const r = stripModelPreamble(reply, original);
    return { sections: r.text ? [{ language: wanted[0] ?? '', text: r.text }] : [], missing: r.text ? [] : wanted, removed: r.removed };
  }
  const lines = reply.replace(/\r\n?/g, '\n').split('\n');
  const found = new Map<string, string[]>();
  const removed: string[] = [];
  let current: string | null = null;
  const before: string[] = [];
  for (const line of lines) {
    const h = /^\s*(?:={2,}|#{1,4})\s*\**([\p{L}][\p{L}\s()'-]{0,40}?)\**\s*:?\s*(?:={2,})?\s*$/u.exec(line);
    const lang = h ? wanted.find((w) => w.toLowerCase() === h[1].trim().toLowerCase()) : undefined;
    if (lang) { current = lang; if (!found.has(lang)) found.set(lang, []); continue; }
    if (current) found.get(current)!.push(line); else before.push(line);
  }
  if (before.join('').trim()) removed.push(before.join(' ').trim().slice(0, 160));
  const sections: { language: string; text: string }[] = [];
  for (const lang of wanted) {
    const body = found.get(lang);
    if (!body) continue;
    const r = stripModelPreamble(body.join('\n'), original);
    removed.push(...r.removed);
    if (r.text) sections.push({ language: lang, text: r.text });
  }
  return { sections, missing: wanted.filter((w) => !sections.some((s) => s.language === w)), removed };
}

/* ---------- Honest model status ---------- */

export type ModelStatus = { route: ChatStreamRoute | 'refused' | 'unknown'; ready: boolean; text: string };

const LOOPBACK = (h: string) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);

/**
 * Which model a Run would use, named explicitly. Offline: the configured local model only; no cloud is tried if it fails.
 * Online: only the cloud model the user enabled with their own key; without a known key Run stays disabled. Never claims
 * a fallback, because the backend has none.
 */
export function modelStatusLine(settings: Pick<Settings, 'mode' | 'localModel' | 'localEndpoint' | 'cloudModel'> | null, cloudConfigured: boolean | null): ModelStatus {
  if (!settings) return { route: 'unknown', ready: false, text: 'Settings are still loading; Run is disabled until the model route is known.' };
  if (settings.mode === 'online') {
    const model = settings.cloudModel?.trim() || 'not set';
    if (cloudConfigured === true) return { route: 'cloud', ready: true, text: `Online provider enabled by you: cloud model “${model}” runs this with your key. The text leaves this computer. The local model is not used.` };
    if (cloudConfigured === false) return { route: 'refused', ready: false, text: `Online mode without a cloud key: cloud model “${model}” cannot run and nothing is sent. The local model is not used instead; add a key in Settings or switch to offline mode.` };
    return { route: 'unknown', ready: false, text: `Online mode, key status unknown: Run is disabled until it is known. Cloud model “${model}” would run this; nothing falls back to another model.` };
  }
  const model = settings.localModel?.trim() || 'not set';
  let host: string | null = null;
  try { host = settings.localEndpoint ? new URL(settings.localEndpoint).hostname.toLowerCase() : null; } catch { host = null; }
  const where = host === null ? 'the local endpoint in Settings' : LOOPBACK(host) ? `this computer (${settings.localEndpoint})` : `${host}, which is not this computer`;
  return { route: 'local', ready: true, text: `Local model “${model}” on ${where} runs this. No cloud provider is used, and none is tried if the local model fails.` };
}
