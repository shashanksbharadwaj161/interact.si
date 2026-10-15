// App-specific writing tone and translation. Pure, DOM-free and deterministic:
// - builds a prompt the user reviews before the existing Send path submits it (no model or network call here);
// - checks a returned rewrite against the original with simple rules (protected tokens kept, length, line breaks).
import { PROMPT_LIMITS } from './prompt-tools';

export type ToneTargetApp = 'email' | 'team-chat' | 'issue-tracker' | 'code-comment' | 'documentation' | 'social-post';

export type ToneProfile = Readonly<{
  id: string;
  label: string;
  targetApp: ToneTargetApp;
  /** Shown to the user and embedded verbatim in the prompt. */
  rules: readonly string[];
  maxChars: number;
  keepLineBreaks: boolean;
}>;

const profile = (p: { id: string; label: string; targetApp: ToneTargetApp; rules: string[]; maxChars: number; keepLineBreaks: boolean }): ToneProfile =>
  Object.freeze({ ...p, rules: Object.freeze([...p.rules]) });

export const TONE_PROFILES: readonly ToneProfile[] = Object.freeze([
  profile({
    id: 'email', label: 'Email', targetApp: 'email', maxChars: 4000, keepLineBreaks: true,
    rules: ['Use a polite, clear and professional tone.', 'Keep the greeting and sign-off if the text has them; do not invent new ones.', 'Put the main request or point in the first two sentences.'],
  }),
  profile({
    id: 'team-chat', label: 'Team chat', targetApp: 'team-chat', maxChars: 1200, keepLineBreaks: false,
    rules: ['Use a friendly, direct and short tone.', 'Prefer one or two short paragraphs; no formal greeting or sign-off.', 'Do not add emoji unless the text already has them.'],
  }),
  profile({
    id: 'issue-tracker', label: 'Issue tracker', targetApp: 'issue-tracker', maxChars: 4000, keepLineBreaks: true,
    rules: ['Use a neutral, factual tone.', 'Keep steps, expected and actual results as separate lines.', 'Do not guess at causes that the text does not state.'],
  }),
  profile({
    id: 'code-comment', label: 'Code comment', targetApp: 'code-comment', maxChars: 600, keepLineBreaks: true,
    rules: ['Be terse and technical; describe why, not what the code obviously does.', 'Keep identifiers, code spans and format markers exactly as written.', 'Do not add comment markers such as // or #.'],
  }),
  profile({
    id: 'documentation', label: 'Documentation', targetApp: 'documentation', maxChars: 6000, keepLineBreaks: true,
    rules: ['Use clear, plain language in the present tense.', 'Keep headings, lists and line breaks in place.', 'Define a term the first time it appears only if the text already explains it.'],
  }),
  profile({
    id: 'social-post', label: 'Social post', targetApp: 'social-post', maxChars: 280, keepLineBreaks: false,
    rules: ['Use an engaging but honest tone; no exaggerated claims.', 'Stay within 280 characters.', 'Do not add hashtags or mentions that are not in the text.'],
  }),
]);

export type TargetLanguage = Readonly<{ code: string; label: string }>;

/** ISO 639-1 codes, plus 'keep' meaning the text stays in its original language. */
export const TARGET_LANGUAGES: readonly TargetLanguage[] = Object.freeze([
  { code: 'keep', label: 'Keep original language' },
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'Hindi' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'ru', label: 'Russian' },
].map((l) => Object.freeze(l)));

export const TONE_PROFILE_PREF_KEY = 'writing.toneProfile';

export type ToneChoice = { profileId: string; language: string };
export const DEFAULT_TONE_CHOICE: Readonly<ToneChoice> = Object.freeze({ profileId: 'email', language: 'keep' });

export const toneProfileById = (id: string): ToneProfile | undefined => TONE_PROFILES.find((p) => p.id === id);
export const targetLanguageByCode = (code: string): TargetLanguage | undefined => TARGET_LANGUAGES.find((l) => l.code === code);

/** Accepts anything (e.g. a stored preference) and returns a valid choice; unknown parts fall back to defaults. */
export function normalizeToneChoice(input: unknown): ToneChoice {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const profileId = typeof obj.profileId === 'string' && toneProfileById(obj.profileId) ? obj.profileId : DEFAULT_TONE_CHOICE.profileId;
  const language = typeof obj.language === 'string' && targetLanguageByCode(obj.language) ? obj.language : DEFAULT_TONE_CHOICE.language;
  return { profileId, language };
}

/* ---------- Protected tokens ---------- */

export type ProtectedTokenKind = 'url' | 'email' | 'code' | 'placeholder' | 'format' | 'number';
export type ProtectedToken = { kind: ProtectedTokenKind; value: string };

const UNIT = '(?:%|(?:ms|sec|secs|s|min|mins|h|hr|hrs|days?|kb|mb|gb|tb|kib|mib|gib|px|em|rem|pt|km|cm|mm|m|kg|mg|g|lbs?|oz|°[CF]|usd|eur|gbp|inr|jpy)(?![\\p{L}\\d]))';
const PATTERNS: { kind: ProtectedTokenKind; re: RegExp }[] = [
  { kind: 'code', re: /`[^`\n]+`/g },
  { kind: 'url', re: /\bhttps?:\/\/[^\s<>"'`]+/gi },
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { kind: 'placeholder', re: /\{\{\s*[^{}\s][^{}]*\}\}/g },
  { kind: 'format', re: /%(?:\d+\$)?[-+0#]*\d*(?:\.\d+)?[sdifxXoeEgGcu@](?![A-Za-z])/g },
  { kind: 'number', re: new RegExp(`(?<![\\p{L}\\d.,])(?:[$€£₹]\\d+(?:[.,]\\d+)*|\\d+(?:[.,]\\d+)*\\s?${UNIT})`, 'giu') },
];

/** URLs, email addresses, numbers with units, inline `code` spans, {{placeholders}} and %s-style markers, in order of appearance, without duplicates. */
export function extractProtectedTokens(text: string): ProtectedToken[] {
  const found: { kind: ProtectedTokenKind; value: string; index: number }[] = [];
  const src = String(text ?? '');
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      let value = m[0];
      if (kind === 'url') value = value.replace(/[.,;:!?)\]]+$/, '');
      if (!value) continue;
      found.push({ kind, value, index: m.index ?? 0 });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: ProtectedToken[] = [];
  for (const f of found) {
    if (seen.has(f.value)) continue;
    seen.add(f.value);
    out.push({ kind: f.kind, value: f.value });
  }
  return out;
}

/* ---------- Prompt ---------- */

export type TonePrompt = {
  prompt: string;
  profile: ToneProfile;
  language: TargetLanguage;
  chars: number;
  /** The exact text to be rewritten (the selection when one was given). */
  original: string;
  source: 'text' | 'selection';
  tokens: ProtectedToken[];
};

/** Deterministic; never calls anything. Throws a descriptive Error when the prompt cannot be built. */
export function buildTonePrompt(text: string, opts: { profileId: string; language: string; selection?: string }): TonePrompt {
  const profile = toneProfileById(opts?.profileId);
  if (!profile) throw new Error(`Unknown tone profile "${String(opts?.profileId)}". Choose one of: ${TONE_PROFILES.map((p) => p.id).join(', ')}.`);
  const language = targetLanguageByCode(opts?.language);
  if (!language) throw new Error(`Unknown target language "${String(opts?.language)}". Choose one of: ${TARGET_LANGUAGES.map((l) => l.code).join(', ')}.`);
  const selection = typeof opts.selection === 'string' && opts.selection.trim() ? opts.selection : '';
  const source: 'text' | 'selection' = selection ? 'selection' : 'text';
  const original = selection || String(text ?? '');
  if (!original.trim()) throw new Error('The text is empty. Type or select some text first.');
  const limit = source === 'selection' ? PROMPT_LIMITS.selectionChars : PROMPT_LIMITS.inputChars;
  if (original.length > limit) throw new Error(`The ${source === 'selection' ? 'selection' : 'text'} is ${original.length} characters; the limit is ${limit}. Shorten it first.`);

  const tokens = extractProtectedTokens(original);
  const task = language.code === 'keep'
    ? `Task: Rewrite the text below for ${profile.label.toLowerCase()} (${profile.targetApp}). Keep it in its original language.`
    : `Task: Translate the text below into ${language.label} (${language.code}) and rewrite it for ${profile.label.toLowerCase()} (${profile.targetApp}).`;
  const parts = [
    task,
    `Style rules:\n${profile.rules.map((r) => `- ${r}`).join('\n')}`,
    `Constraints:\n- Keep every fact, name and number; do not add new claims.\n- Stay under ${profile.maxChars} characters.\n- ${profile.keepLineBreaks ? 'Keep the existing line breaks.' : 'Line breaks may be merged.'}\n- Keep URLs, email addresses, numbers with units, \`code\` spans, {{placeholders}} and %s-style markers exactly as written.\n- Reply with the rewritten text only.`,
  ];
  if (tokens.length) parts.push(`Must appear unchanged:\n${tokens.map((t) => `- ${t.value}`).join('\n')}`);
  parts.push(`Text (${original.length} characters):\n"""\n${original}\n"""`);
  const prompt = parts.join('\n\n');
  if (prompt.length > PROMPT_LIMITS.promptChars) throw new Error(`The prompt is ${prompt.length} characters; the limit is ${PROMPT_LIMITS.promptChars}. Shorten the text.`);
  return { prompt, profile, language, chars: prompt.length, original, source, tokens };
}

/* ---------- Rewrite check ---------- */

export const LENGTH_RATIO_BOUNDS = Object.freeze({ min: 0.3, max: 3.0 });

export type RewriteCheck = { ok: boolean; problems: string[]; missingTokens: string[]; lengthRatio: number };

const lineBreaks = (s: string) => (s.replace(/\r\n/g, '\n').trim().match(/\n/g) ?? []).length;
const compact = (s: string) => s.replace(/\s+/g, '');

/** Compares a rewrite with its original. Pure; reports problems, never edits the text. */
export function checkRewrite(original: string, rewritten: string, profile: ToneProfile): RewriteCheck {
  const orig = String(original ?? '');
  const out = String(rewritten ?? '');
  const problems: string[] = [];
  const missingTokens: string[] = [];
  const origLen = orig.trim().length;
  const outLen = out.trim().length;
  const lengthRatio = origLen === 0 ? 0 : Math.round((outLen / origLen) * 100) / 100;
  if (!outLen) {
    problems.push('The rewrite is empty.');
    return { ok: false, problems, missingTokens, lengthRatio };
  }
  const outCompact = compact(out);
  for (const t of extractProtectedTokens(orig)) {
    const kept = t.kind === 'number' ? outCompact.includes(compact(t.value)) : out.includes(t.value);
    if (!kept) missingTokens.push(t.value);
  }
  if (missingTokens.length) problems.push(`${missingTokens.length} protected item${missingTokens.length === 1 ? ' was' : 's were'} dropped or changed: ${missingTokens.join(', ')}`);
  if (lengthRatio < LENGTH_RATIO_BOUNDS.min || lengthRatio > LENGTH_RATIO_BOUNDS.max) problems.push(`Length ratio ${lengthRatio.toFixed(2)} is outside ${LENGTH_RATIO_BOUNDS.min}–${LENGTH_RATIO_BOUNDS.max.toFixed(1)}.`);
  if (profile && out.length > profile.maxChars) problems.push(`The rewrite is ${out.length} characters; ${profile.label} allows ${profile.maxChars}.`);
  if (profile?.keepLineBreaks) {
    const before = lineBreaks(orig);
    const after = lineBreaks(out);
    if (after < before) problems.push(`Line breaks were lost (${before} in the original, ${after} in the rewrite).`);
  }
  return { ok: problems.length === 0, problems, missingTokens, lengthRatio };
}
