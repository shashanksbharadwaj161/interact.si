// Offline, deterministic intent planner. Turns one typed command (or a local model's JSON plan) into a single
// ActionRequest candidate for previewAction. Pure: never executes, never fetches, never touches the filesystem,
// never builds a shell command. A 'ready' plan is only a preview candidate; authorization stays with the action service.
// Routine planners (planRoutineLines, parseModelRoutine) return several such candidates for the routine editor.
import type {ActionRequest} from '../../src/shared/contracts';
import {describeTypedText, validateActionRequest, validateOpenUrl} from './policy';
import {LIMITS, ValidationError} from './validation';

export const MAX_COMMAND_CHARS = LIMITS.typeChars + 200;
export const MAX_MODEL_PLAN_CHARS = 8 * 1024;
export const MAX_CANDIDATES = 8;
const MAX_WINDOWS_CONSIDERED = 200;
const MAX_TARGET_CHARS = 260;

export type PlannedType = 'list-windows' | 'focus' | 'move-window' | 'type-text' | 'open-url' | 'launch';
export const PLANNED_TYPES: readonly PlannedType[] = ['list-windows', 'focus', 'move-window', 'type-text', 'open-url', 'launch'];
export type IntentField = 'target' | 'text' | 'x' | 'y' | 'width' | 'height' | 'url' | 'command';
export type IntentSource = 'rules' | 'model';
export type IntentCandidate = {label: string; request: ActionRequest};
/** Snapshot of visible windows the caller may pass so an ambiguous target becomes a clarification. Optional. */
export type IntentWindow = {hwnd: number; title: string; process: string};

export type IntentPlan =
  | {status: 'ready'; source: IntentSource; request: ActionRequest; summary: string; previewOnly: true}
  | {status: 'clarify'; source: IntentSource; summary: string; question: string; missing: IntentField[]; candidates?: IntentCandidate[]}
  | {status: 'blocked'; source: IntentSource; summary: string; reason: string};

export interface PlanOptions { windows?: readonly unknown[] }

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
// Bidirectional overrides/isolates and marks can make text read differently from what is typed or targeted.
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/;
// Zero-width characters are allowed in typed text (emoji sequences) but not in targets, where they hide look-alikes.
const INVISIBLE_RE = /[​-‍⁠﻿]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const PRONOUN_RE = /^(it|that|this|them|those|these|there|here|the window|this window|that window|that one|this one|same|again)$/i;
const SCRIPT_EXT_RE = /\.(bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|scr|com|msi|msp|lnk|reg|cpl|pif|url|inf|jar)$/i;
const RUNNABLE_WITH_ARGS_RE = /\.(exe|bat|cmd|com|ps1|vbs|js|msi|scr|lnk)\s+\S/i;
const SHELL_META_RE = /[&|<>^%`$;!*?\[\]{}=]/;

const blocked = (source: IntentSource, summary: string, reason: string): IntentPlan => ({status: 'blocked', source, summary, reason});
const clarify = (source: IntentSource, summary: string, question: string, missing: IntentField[], candidates?: IntentCandidate[]): IntentPlan =>
  candidates?.length ? {status: 'clarify', source, summary, question, missing, candidates: candidates.slice(0, MAX_CANDIDATES)} : {status: 'clarify', source, summary, question, missing};

/** Returns a reason when a string must not be used as a target, URL or typed text. */
function unsafeChars(s: string, allowInvisible: boolean): string | null {
  if (LONE_SURROGATE_RE.test(s)) return 'contains malformed Unicode';
  if (CONTROL_RE.test(s)) return 'contains line breaks or control characters';
  if (BIDI_RE.test(s)) return 'contains bidirectional control characters that can disguise text';
  if (!allowInvisible && INVISIBLE_RE.test(s)) return 'contains invisible characters';
  return null;
}

/** Strict integer: ASCII digits only, optional minus. Rejects 1e3, 0x10, 1.5, full-width or other script digits. */
function parseInteger(raw: string, min: number, max: number): number | null {
  if (!/^-?[0-9]{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

type Quoted = {skeleton: string; quotes: string[]} | {error: string};
const QUOTE_PAIRS: Record<string, string> = {'"': '"', '“': '”', '„': '”', '‘': '’', '«': '»', "'": "'"};

/**
 * Replaces each quoted segment with a placeholder token `\u0001<n>\u0001` so grammar matching never looks inside
 * quotes. A single quote only opens at a word start, so apostrophes in words ("don't") stay literal.
 */
function extractQuotes(input: string): Quoted {
  const quotes: string[] = [];
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const close = QUOTE_PAIRS[ch];
    if (!close || (ch === "'" && i > 0 && !/\s/.test(input[i - 1]))) { out += ch; continue; }
    const end = input.indexOf(close, i + 1);
    if (end < 0) return {error: 'A quote is not closed'};
    if (quotes.length >= 4) return {error: 'Too many quoted parts'};
    out += `\u0001${quotes.length}\u0001`;
    quotes.push(input.slice(i + 1, end));
    i = end;
  }
  return {skeleton: out, quotes};
}

const PLACEHOLDER_RE = /^\u0001(\d)\u0001$/;
/** Resolves a target phrase: a lone placeholder yields the quoted text; quotes mixed with words are refused. */
function resolvePhrase(phrase: string, quotes: string[]): {value: string; quoted: boolean} | null {
  const p = phrase.trim();
  const m = PLACEHOLDER_RE.exec(p);
  if (m) return {value: quotes[Number(m[1])].trim(), quoted: true};
  if (p.includes('\u0001')) return null;
  return {value: p, quoted: false};
}

/** Sanitizes a caller-provided window snapshot: integer handles, bounded strings, at most 200 entries. */
function sanitizeWindows(raw: readonly unknown[] | undefined): IntentWindow[] {
  if (!Array.isArray(raw)) return [];
  const list: IntentWindow[] = [];
  for (const v of raw.slice(0, MAX_WINDOWS_CONSIDERED)) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    if (typeof o.hwnd !== 'number' || !Number.isSafeInteger(o.hwnd) || o.hwnd <= 0) continue;
    if (typeof o.title !== 'string' || typeof o.process !== 'string') continue;
    list.push({hwnd: o.hwnd, title: o.title.slice(0, 300), process: o.process.slice(0, 100)});
  }
  return list;
}

function ready(source: IntentSource, req: ActionRequest, summary: string): IntentPlan {
  try {
    // Same shape check as the IPC boundary, so a candidate never carries fields previewAction would refuse.
    return {status: 'ready', source, request: validateActionRequest(req), summary, previewOnly: true};
  } catch (e) {
    return blocked(source, summary, e instanceof ValidationError ? e.message : 'The planned action is invalid');
  }
}

/** Refuses launch targets that look like a shell command, a script, arguments, a URL or a network path. */
function launchProblem(source: IntentSource, t: string): IntentPlan | null {
  const summary = `Launch "${clip(t)}"`;
  if (!t) return clarify(source, 'Launch an app', 'Which approved app or file should be launched?', ['target']);
  if (PRONOUN_RE.test(t)) return clarify(source, 'Launch an app', `"${clip(t, 30)}" is ambiguous. Name the app or file explicitly.`, ['target']);
  const bad = unsafeChars(t, false);
  if (bad) return blocked(source, summary, `The target ${bad}`);
  if (t.length > MAX_TARGET_CHARS) return blocked(source, summary, `The target is too long (max ${MAX_TARGET_CHARS})`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) return clarify(source, summary, 'That looks like a link. Use "open https://..." to open links.', ['url']);
  if (/^[\\/]{2}/.test(t)) return blocked(source, summary, 'Network and device paths are not launched from commands');
  if (SHELL_META_RE.test(t)) return blocked(source, summary, 'Shell operators and wildcards are not allowed; only a single app or file can be launched');
  if (RUNNABLE_WITH_ARGS_RE.test(t) || /\s[-/][A-Za-z?]/.test(t) || t.startsWith('-')) return blocked(source, summary, 'Command-line arguments are not allowed; launch the app by itself');
  if (SCRIPT_EXT_RE.test(t)) return blocked(source, summary, 'Scripts, installers and shortcuts are not launched from commands');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(t)) return blocked(source, summary, 'Relative ".." paths are not allowed');
  return null;
}
type WindowResolution = {ok: true; target: string; label: string} | {ok: false; plan: IntentPlan};

/** Explicit window target only. With a window snapshot, an ambiguous or unknown name becomes a clarification. */
function resolveWindow(source: IntentSource, raw: string | undefined, verb: string, windows: IntentWindow[], rebuild: (target: string) => ActionRequest): WindowResolution {
  const t = (raw ?? '').trim();
  const summary = `${verb} a window`;
  const ask = (q: string, candidates?: IntentCandidate[]): WindowResolution => ({ok: false, plan: clarify(source, summary, q, ['target'], candidates)});
  if (!t) return ask('Which window? Name it (title or process) or use hwnd:<number> from list windows.');
  if (PRONOUN_RE.test(t)) return ask(`"${clip(t, 30)}" is ambiguous. Name the window explicitly or use hwnd:<number>.`);
  const bad = unsafeChars(t, false);
  if (bad) return {ok: false, plan: blocked(source, summary, `The window name ${bad}`)};
  if (t.length > MAX_TARGET_CHARS) return {ok: false, plan: blocked(source, summary, `The window name is too long (max ${MAX_TARGET_CHARS})`)};
  const h = /^hwnd:(\d{1,15})$/i.exec(t);
  if (h) {
    const hwnd = Number(h[1]);
    if (hwnd <= 0) return {ok: false, plan: blocked(source, summary, 'The window handle is not valid')};
    const win = windows.find((w) => w.hwnd === hwnd);
    return {ok: true, target: `hwnd:${hwnd}`, label: win ? `"${clip(win.title)}" (${clip(win.process, 40)})` : `window hwnd:${hwnd}`};
  }
  if (/^hwnd:/i.test(t)) return {ok: false, plan: blocked(source, summary, 'The window handle is not valid')};
  if (!windows.length) return {ok: true, target: t, label: `the window matching "${clip(t)}"`};
  // Same matching rule as policy.selectWindow, so the preview selects the same window.
  const lower = t.toLowerCase();
  const hits = windows.filter((w) => w.title.toLowerCase().includes(lower) || w.process.toLowerCase() === lower);
  if (!hits.length) return ask(`No visible window matches "${clip(t, 60)}". Which window did you mean?`);
  if (hits.length > 1) {
    return ask(`${hits.length} windows match "${clip(t, 60)}". Which one?`,
      hits.slice(0, MAX_CANDIDATES).map((w) => ({label: `${clip(w.title)} (${clip(w.process, 40)})`, request: rebuild(`hwnd:${w.hwnd}`)})));
  }
  return {ok: true, target: `hwnd:${hits[0].hwnd}`, label: `"${clip(hits[0].title)}" (${clip(hits[0].process, 40)})`};
}
const RECT_KEYS = ['x', 'y', 'width', 'height'] as const;

function finalizeMove(source: IntentSource, req: ActionRequest, windows: IntentWindow[]): IntentPlan {
  const rect: Partial<Record<(typeof RECT_KEYS)[number], number>> = {};
  for (const k of RECT_KEYS) if (req[k] !== undefined) rect[k] = req[k];
  const r = resolveWindow(source, req.target, 'Move', windows, (target) => ({type: 'move-window', target, ...rect}));
  if (!r.ok) return r.plan;
  const summary = `Move ${r.label}`;
  const missing = RECT_KEYS.filter((k) => rect[k] === undefined);
  if (missing.length) return clarify(source, summary, 'Give the position and size, for example "move notepad to 100,100 size 800x600".', [...missing]);
  for (const k of ['x', 'y'] as const) if (!Number.isInteger(rect[k]) || Math.abs(rect[k]!) > 100000) return blocked(source, summary, `${k} must be a whole number between -100000 and 100000`);
  for (const k of ['width', 'height'] as const) if (!Number.isInteger(rect[k]) || rect[k]! < 1 || rect[k]! > 100000) return blocked(source, summary, `${k} must be a whole number between 1 and 100000`);
  return ready(source, {type: 'move-window', target: r.target, ...rect}, `${summary} to ${rect.x},${rect.y} size ${rect.width}×${rect.height} (clamped to visible screens)`);
}

function finalizeType(source: IntentSource, req: ActionRequest, windows: IntentWindow[]): IntentPlan {
  const text = req.text ?? '';
  if (!text) return clarify(source, 'Type text', 'What should be typed? Put the exact text in quotes, for example: type "hello" into notepad', ['text']);
  const bad = unsafeChars(text, true);
  if (bad) return blocked(source, 'Type text', `The text ${bad}`);
  if (text.length > LIMITS.typeChars) return blocked(source, 'Type text', `The text is too long (max ${LIMITS.typeChars})`);
  const r = resolveWindow(source, req.target, 'Type into', windows, (target) => ({type: 'type-text', target, text}));
  return r.ok ? ready(source, {type: 'type-text', target: r.target, text}, `Type "${describeTypedText(text, 120)}" into ${r.label}`) : r.plan;
}

function finalizeUrl(source: IntentSource, raw: string | undefined): IntentPlan {
  const t = (raw ?? '').trim();
  if (!t) return clarify(source, 'Open a link', 'Which link? Give the full address, starting with https://', ['url']);
  const summary = `Open "${clip(t)}"`;
  const bad = unsafeChars(t, false);
  if (bad) return blocked(source, summary, `The link ${bad}`);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) return clarify(source, summary, `Include the scheme, for example https://${clip(t, 60)}`, ['url']);
  const u = validateOpenUrl(t);
  if (!u.ok) return blocked(source, summary, u.reason);
  return ready(source, {type: 'open-url', target: u.url}, `Open ${clip(u.url, 120)} in the default browser`);
}

/** Shared by the rule planner and the model parser: validates one request and writes the summary from its own fields. */
function finalize(source: IntentSource, req: ActionRequest, windows: IntentWindow[]): IntentPlan {
  switch (req.type) {
    case 'list-windows': return ready(source, {type: 'list-windows'}, 'List visible windows (titles, process names and positions only)');
    case 'open-url': return finalizeUrl(source, req.target);
    case 'launch': {
      const t = (req.target ?? '').trim();
      return launchProblem(source, t) ?? ready(source, {type: 'launch', target: t}, `Launch "${clip(t, 120)}" (only if it is an approved app or inside an allowed folder)`);
    }
    case 'focus': {
      const r = resolveWindow(source, req.target, 'Focus', windows, (target) => ({type: 'focus', target}));
      return r.ok ? ready(source, {type: 'focus', target: r.target}, `Bring ${r.label} to the foreground`) : r.plan;
    }
    case 'move-window': return finalizeMove(source, req, windows);
    case 'type-text': return finalizeType(source, req, windows);
    default: return blocked(source, `Blocked ${String(req.type).slice(0, 30)}`, 'This action cannot be planned from a command');
  }
}
export const SUPPORTED_COMMANDS = [
  'list windows',
  'focus <window>',
  'move <window> to <x>,<y> size <width>x<height>',
  'type "<text>" into <window>',
  'open <https://address>',
  'launch <approved app or file>',
];
const UNKNOWN_REASON = `Not a supported command, so nothing will run. Try: ${SUPPORTED_COMMANDS.join('; ')}`;
const URL_TOKEN_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:)\S*/gi;
const CHAIN_RE = /[;&|`]|\b(?:then|afterwards|after that)\b|\band\s+(?:also\s+)?(?:launch|start|run|open|type|write|focus|switch|move|click|close|kill|delete|remove|execute)\b/i;
const COORDS_RE = /^\(?\s*([^\s,()]+)\s*,\s*([^\s,()]+)\s*\)?(?:\s+(?:(?:with\s+)?size\s+)?([^\s,x×]+)\s*[x×]\s*([^\s,x×]+))?$/i;

/**
 * Rule planner for one typed command. The verb must come first (an optional leading "please" is ignored), only one
 * action is planned, quoted text is never interpreted, and anything unrecognized is blocked rather than guessed.
 */
export function planIntent(input: unknown, opts: PlanOptions = {}): IntentPlan {
  const src: IntentSource = 'rules';
  if (typeof input !== 'string') return blocked(src, 'Blocked command', 'The command must be text');
  if (input.length > MAX_COMMAND_CHARS) return blocked(src, 'Blocked command', `The command is too long (max ${MAX_COMMAND_CHARS})`);
  const trimmed = input.trim();
  if (!trimmed) return clarify(src, 'No command', 'What should Desktop Companion do?', ['command']);
  const bad = unsafeChars(trimmed, true);
  if (bad) return blocked(src, 'Blocked command', `The command ${bad}; send one single-line command`);
  const q = extractQuotes(trimmed);
  if ('error' in q) return clarify(src, 'Incomplete command', `${q.error}. Put the exact text between matching quotes.`, ['text']);
  const s = q.skeleton.replace(/\s+/g, ' ').replace(/[.?]+$/, '').replace(/^please\s+/i, '').trim();
  if (CHAIN_RE.test(s.replace(URL_TOKEN_RE, 'URL'))) return blocked(src, 'Blocked command', 'Only one action per command; send each step separately so each one gets its own preview');
  const windows = sanitizeWindows(opts.windows);
  const phrase = (p: string) => resolvePhrase(p, q.quotes);
  let m: RegExpExecArray | null;

  if (/^(?:list|show|display)(?: all| the| my)?(?: open| visible)? windows$/i.test(s) || /^what windows are open$/i.test(s)) return finalize(src, {type: 'list-windows'}, windows);
  if (/^(?:double[- ]?|right[- ]?)?(?:click|tap)\b/i.test(s)) return blocked(src, 'Click', 'Clicking is not planned from text commands; use the Computer screen to preview a click');

  if ((m = /^(?:focus(?: on)?|switch to|activate|bring)\s+(.+?)(?:\s+to\s+(?:the\s+)?(?:front|foreground))?$/i.exec(s))) {
    const t = phrase(m[1]);
    return t ? finalize(src, {type: 'focus', target: t.value}, windows) : clarify(src, 'Focus a window', 'Quote the whole window name, for example: focus "Untitled - Notepad"', ['target']);
  }
  if ((m = /^(?:move|place|put)\s+(.+?)\s+to\s+(.+)$/i.exec(s))) {
    const t = phrase(m[1]);
    if (!t) return clarify(src, 'Move a window', 'Quote the whole window name, for example: move "Untitled - Notepad" to 0,0 size 800x600', ['target']);
    const c = COORDS_RE.exec(m[2]);
    if (!c) return clarify(src, `Move "${clip(t.value)}"`, 'Give the position and size, for example "to 100,100 size 800x600".', ['x', 'y', 'width', 'height']);
    const req: ActionRequest = {type: 'move-window', target: t.value};
    const fields = [['x', c[1], -100000], ['y', c[2], -100000], ['width', c[3], 1], ['height', c[4], 1]] as const;
    for (const [k, raw, min] of fields) {
      if (raw === undefined) continue;
      const n = parseInteger(raw, min, 100000);
      if (n === null) return blocked(src, `Move "${clip(t.value)}"`, `${k} must be a whole number written with digits 0-9 (between ${min} and 100000)`);
      req[k] = n;
    }
    return finalize(src, req, windows);
  }
  if ((m = /^(?:type|write|enter)\s+(.+?)(?:\s+(?:into|in|to|on)\s+(.+))?$/i.exec(s))) {
    const text = PLACEHOLDER_RE.exec(m[1].trim());
    if (!text) return clarify(src, 'Type text', 'Put the exact text in quotes, for example: type "hello" into notepad', ['text']);
    const t = m[2] === undefined ? {value: ''} : phrase(m[2]);
    if (!t) return clarify(src, 'Type text', 'Quote the whole window name, for example: type "hello" into "Untitled - Notepad"', ['target']);
    return finalize(src, {type: 'type-text', text: q.quotes[Number(text[1])], target: t.value}, windows);
  }
  if ((m = /^(?:open|go to|visit|browse to|navigate to)\s+(.+)$/i.exec(s))) return planOpen(phrase(m[1]), windows);
  if ((m = /^(?:launch|start|run)\s+(.+)$/i.exec(s))) {
    const t = phrase(m[1]);
    return t ? finalize(src, {type: 'launch', target: t.value}, windows) : clarify(src, 'Launch an app', 'Quote the whole path, for example: launch "C:\\Tools\\App\\app.exe"', ['target']);
  }
  return blocked(src, 'Unknown command', UNKNOWN_REASON);
}

/** "open X": links go to open-url; a bare name is never guessed into a launch, it becomes a clarification. */
function planOpen(t: {value: string; quoted: boolean} | null, windows: IntentWindow[]): IntentPlan {
  const src: IntentSource = 'rules';
  if (!t || !t.value) return clarify(src, 'Open', 'What should be opened? Give a full link such as https://example.com', ['url']);
  const v = t.value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[a-z]:[\\/]/i.test(v)) return finalize(src, {type: 'open-url', target: v}, windows);
  if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(\/\S*)?$/u.test(v) && !/\.(exe|txt|md|pdf|docx?|xlsx?|pptx?|png|jpe?g)$/i.test(v)) return finalize(src, {type: 'open-url', target: v}, windows);
  const launch: ActionRequest = {type: 'launch', target: v};
  const problem = launchProblem(src, v);
  if (problem) return problem;
  return clarify(src, `Open "${clip(v)}"`, `Did you mean to launch "${clip(v, 60)}"? Choose the launch below or say "launch ${clip(v, 60)}".`, ['command'], [{label: `Launch "${clip(v)}"`, request: launch}]);
}
const MODEL_FIELDS: Record<PlannedType, readonly string[]> = {
  'list-windows': [],
  focus: ['target'],
  'move-window': ['target', 'x', 'y', 'width', 'height'],
  'type-text': ['target', 'text'],
  'open-url': ['target'],
  launch: ['target'],
};

/**
 * Parses a local model's JSON plan: exactly one flat object {"type", ...fields} for a known planned action, with an
 * optional "summary" that is checked and discarded (the summary shown is always rebuilt from the fields). Tool calls,
 * commands, arrays, unknown or inapplicable fields, and wrongly typed values are blocked. The result goes through the
 * same checks as typed commands and, when ready, is only a preview candidate, never an authorization.
 */
export function parseModelPlan(raw: unknown, opts: PlanOptions = {}): IntentPlan {
  const src: IntentSource = 'model';
  const deny = (reason: string) => blocked(src, 'Blocked model plan', reason);
  const value = parseModelJson(raw);
  if ('error' in value) return deny(value.error);
  if (Array.isArray(value.json)) return deny('The model plan must contain exactly one action');
  return modelObjectPlan(value.json, sanitizeWindows(opts.windows));
}

/** Strict JSON text (optionally inside one ```json fence), bounded in size. Never evaluates anything. */
function parseModelJson(raw: unknown): {json: unknown} | {error: string} {
  if (typeof raw !== 'string') return {error: 'The model plan must be JSON text'};
  if (raw.length > MAX_MODEL_PLAN_CHARS) return {error: `The model plan is too long (max ${MAX_MODEL_PLAN_CHARS})`};
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  try { return {json: JSON.parse(fenced ? fenced[1] : raw)}; } catch { return {error: 'The model plan is not valid JSON'}; }
}

const safeKey = (k: string) => clip(k.replace(/[^ -~]/g, '?'), 30);

/** One flat model action object → plan. Shared by single plans and routine plans. */
function modelObjectPlan(value: unknown, windows: IntentWindow[]): IntentPlan {
  const src: IntentSource = 'model';
  const deny = (reason: string) => blocked(src, 'Blocked model plan', reason);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return deny('The model plan must be a JSON object');
  const o = value as Record<string, unknown>;
  if (o.type === 'click') return deny('Clicking is not planned from model output');
  if (typeof o.type !== 'string' || !(PLANNED_TYPES as readonly string[]).includes(o.type)) return deny(`Unsupported action type; allowed: ${PLANNED_TYPES.join(', ')}`);
  const type = o.type as PlannedType;
  const allowed = MODEL_FIELDS[type];
  for (const k of Object.keys(o)) {
    if (k === 'type' || k === 'summary') continue;
    if (!allowed.includes(k)) return deny(`Field "${safeKey(k)}" is not allowed for ${type}; tools, commands and extra fields are refused`);
  }
  if (o.summary !== undefined && (typeof o.summary !== 'string' || o.summary.length > 300)) return deny('summary must be a short string');
  const req: ActionRequest = {type};
  for (const k of ['target', 'text'] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'string') return deny(`${k} must be a string`);
    req[k] = o[k] as string;
  }
  for (const k of RECT_KEYS) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) return deny(`${k} must be a number`);
    req[k] = o[k] as number;
  }
  return finalize(src, req, windows);
}

// ---------------------------------------------------------------------------------------------------------------
// Routine step candidates. Several validated, single-action steps proposed for the routine editor. Still preview
// candidates only: nothing here schedules, saves or runs anything, and each step is executed later through its own
// ActionService preview and trusted native confirmation.

export const MAX_ROUTINE_STEPS = 20;
export const MAX_WAIT_SECONDS = 300;

export type RoutineStepCandidate =
  | {kind: 'action'; request: ActionRequest; summary: string}
  | {kind: 'wait'; seconds: number; summary: string};

export type RoutinePlan =
  | {status: 'ready'; source: IntentSource; name?: string; steps: RoutineStepCandidate[]; previewOnly: true}
  | {status: 'clarify' | 'blocked'; source: IntentSource; step: number | null; summary: string; reason: string; plan?: IntentPlan};

const routineStop = (source: IntentSource, step: number | null, reason: string, plan?: IntentPlan, status: 'clarify' | 'blocked' = 'blocked'): RoutinePlan =>
  plan ? {status, source, step, summary: plan.summary, reason, plan} : {status, source, step, summary: step === null ? 'Blocked routine' : `Step ${step}`, reason};

const waitCandidate = (seconds: number): RoutineStepCandidate => ({kind: 'wait', seconds, summary: `Wait ${seconds} second${seconds === 1 ? '' : 's'}`});

/** Turns a step plan into a candidate, or the stop result naming which step needs attention. */
function stepFromPlan(source: IntentSource, index: number, plan: IntentPlan): RoutineStepCandidate | RoutinePlan {
  if (plan.status === 'ready') return {kind: 'action', request: plan.request, summary: plan.summary};
  if (plan.status === 'clarify') return routineStop(source, index, `Step ${index}: ${plan.question}`, plan, 'clarify');
  return routineStop(source, index, `Step ${index}: ${plan.reason}`, plan);
}

/**
 * Re-checks one stored or edited routine step request with the same rules as typed commands. Used by the routine
 * engine before saving, so a stored step can never hold a click, a shell string or fields previewAction refuses.
 */
export function checkPlannedRequest(raw: unknown, opts: PlanOptions = {}): IntentPlan {
  const src: IntentSource = 'rules';
  let req: ActionRequest;
  try { req = validateActionRequest(raw); } catch (e) { return blocked(src, 'Blocked step', e instanceof ValidationError ? e.message : 'The step is invalid'); }
  if (req.type === 'click') return blocked(src, 'Click', 'Clicking is not available in routines (experimental input gate G4)');
  return finalize(src, req, sanitizeWindows(opts.windows));
}

const WAIT_RE = /^(?:wait|pause|sleep)(?: for)? ([0-9]{1,3}) ?(?:s|sec|secs|seconds?)$/i;

/**
 * Rule planner for a short list of commands, one per line (blank lines and lines starting with # are ignored).
 * Each line is planned by planIntent, so chaining inside a line is still refused. "wait 5 seconds" adds a pause.
 */
export function planRoutineLines(input: unknown, opts: PlanOptions = {}): RoutinePlan {
  const src: IntentSource = 'rules';
  if (typeof input !== 'string') return routineStop(src, null, 'The steps must be text');
  if (input.length > MAX_ROUTINE_STEPS * MAX_COMMAND_CHARS) return routineStop(src, null, 'The step list is too long');
  const lines = input.split(/\r\n|\r|\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return routineStop(src, null, 'Write at least one command, one per line', undefined, 'clarify');
  if (lines.length > MAX_ROUTINE_STEPS) return routineStop(src, null, `A routine can have at most ${MAX_ROUTINE_STEPS} steps`);
  const steps: RoutineStepCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const w = WAIT_RE.exec(lines[i].replace(/[.]+$/, ''));
    if (w) {
      const n = Number(w[1]);
      if (n < 1 || n > MAX_WAIT_SECONDS) return routineStop(src, i + 1, `Step ${i + 1}: a wait must be 1–${MAX_WAIT_SECONDS} seconds`);
      steps.push(waitCandidate(n));
      continue;
    }
    const r = stepFromPlan(src, i + 1, planIntent(lines[i], opts));
    if ('status' in r) return r;
    steps.push(r);
  }
  return {status: 'ready', source: src, steps, previewOnly: true};
}

/**
 * Parses a local model's routine proposal: exactly {"name"?: string, "steps": [ ... ]} where each step is either a
 * flat action object accepted by parseModelPlan or {"type":"wait","seconds":n}. Schedules, tools, shell commands,
 * recordings and any other field are refused; the user sets schedules in the editor. Candidates only.
 */
export function parseModelRoutine(raw: unknown, opts: PlanOptions = {}): RoutinePlan {
  const src: IntentSource = 'model';
  const value = parseModelJson(raw);
  if ('error' in value) return routineStop(src, null, value.error);
  const json = value.json;
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return routineStop(src, null, 'The routine must be a JSON object with a "steps" list');
  const o = json as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'name' && k !== 'steps') return routineStop(src, null, `Field "${safeKey(k)}" is not allowed; schedules, tools and commands are set only by you in the editor`);
  let name: string | undefined;
  if (o.name !== undefined) {
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 80) return routineStop(src, null, 'name must be a short string (max 80)');
    const bad = unsafeChars(o.name, false);
    if (bad) return routineStop(src, null, `The name ${bad}`);
    name = o.name.trim();
  }
  if (!Array.isArray(o.steps) || !o.steps.length) return routineStop(src, null, 'steps must be a non-empty list');
  if (o.steps.length > MAX_ROUTINE_STEPS) return routineStop(src, null, `A routine can have at most ${MAX_ROUTINE_STEPS} steps`);
  const windows = sanitizeWindows(opts.windows);
  const steps: RoutineStepCandidate[] = [];
  for (let i = 0; i < o.steps.length; i++) {
    const s = o.steps[i] as Record<string, unknown> | null;
    if (s && typeof s === 'object' && !Array.isArray(s) && s.type === 'wait') {
      const extra = Object.keys(s).find((k) => k !== 'type' && k !== 'seconds');
      if (extra) return routineStop(src, i + 1, `Step ${i + 1}: field "${safeKey(extra)}" is not allowed for wait`);
      if (typeof s.seconds !== 'number' || !Number.isInteger(s.seconds) || s.seconds < 1 || s.seconds > MAX_WAIT_SECONDS) return routineStop(src, i + 1, `Step ${i + 1}: seconds must be a whole number from 1 to ${MAX_WAIT_SECONDS}`);
      steps.push(waitCandidate(s.seconds));
      continue;
    }
    const r = stepFromPlan(src, i + 1, modelObjectPlan(s, windows));
    if ('status' in r) return r;
    steps.push(r);
  }
  return name === undefined ? {status: 'ready', source: src, steps, previewOnly: true} : {status: 'ready', source: src, name, steps, previewOnly: true};
}
