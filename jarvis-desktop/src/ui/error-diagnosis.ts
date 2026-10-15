// Offline, rule-based error diagnosis. Pure: no model call, no file access, no execution. Paths found in the text are
// reported as strings only (never resolved or followed), and every proposed action is a preview that the user must
// confirm through an existing app flow. No action ever carries a shell command.

export type Confidence = 'high' | 'medium' | 'low';
export type DiagnosisMatch = { code: string; title: string; explanation: string; confidence: Confidence };
export const ACTION_KINDS = ['open-path', 'reveal-folder', 'copy-text', 'open-settings'] as const;
export type ProposedActionKind = (typeof ACTION_KINDS)[number];
export type ProposedAction = { id: string; kind: ProposedActionKind; label: string; target: string; requiresConfirmation: true };
export type SourceLocation = { path: string; line: number; column: number | null };
export type Diagnosis = {
  matches: DiagnosisMatch[];
  paths: string[];
  /** Stack-trace style file:line[:col] references, in the order found. */
  locations: SourceLocation[];
  proposedActions: ProposedAction[];
  truncated: boolean;
  summary: string;
};

export const DIAGNOSIS_LIMITS = { inputChars: 20_000, paths: 20, locations: 20, pathActions: 3, actions: 12, copyChars: 2_000, pathChars: 400 } as const;
export const NO_PATTERN_TEXT = 'No known pattern recognized. This checker only knows a small set of common errors, so it cannot say what went wrong here. The text was not sent anywhere.';

type Draft = { kind: ProposedActionKind; label: string; target: string };
type Rule = { code: string; title: string; confidence: Confidence; re: RegExp; explain: (m: RegExpMatchArray) => string; actions?: (m: RegExpMatchArray) => Draft[] };

const SETTINGS_FOLDERS: Draft = { kind: 'open-settings', label: 'Review allowed folders in Settings', target: 'settings:allowed-folders' };
const copy = (label: string, target: string): Draft => ({ kind: 'copy-text', label, target });

const RULES: Rule[] = [
  { code: 'ENOENT', title: 'File or folder not found', confidence: 'high', re: /\bENOENT\b/,
    explain: () => 'The program tried to open a file or folder that does not exist (ENOENT). Check that any path listed below is spelled correctly and that the file was created, not moved or deleted.' },
  { code: 'EACCES', title: 'Permission denied', confidence: 'high', re: /\bEACCES\b/,
    explain: () => 'The operating system refused access to a file, folder or port (EACCES). The current user may lack permission, or the item may be read-only.',
    actions: () => [SETTINGS_FOLDERS] },
  { code: 'EPERM', title: 'Operation not permitted', confidence: 'high', re: /\bEPERM\b/,
    explain: () => 'The operation was not permitted (EPERM). On Windows this often means the file is locked by another program, is read-only, or is being scanned by security software.',
    actions: () => [SETTINGS_FOLDERS] },
  { code: 'EADDRINUSE', title: 'Address already in use', confidence: 'high', re: /\bEADDRINUSE\b(?:[^\n]*?:(\d{1,5})\b)?/,
    explain: (m) => `Another program is already listening on ${m[1] ? `port ${m[1]}` : 'the requested port'} (EADDRINUSE). Close the other program or configure a different port.`,
    actions: (m) => (m[1] ? [copy(`Copy port number ${m[1]}`, m[1])] : []) },
  { code: 'ECONNREFUSED', title: 'Connection refused', confidence: 'high', re: /\bECONNREFUSED\b(?:\s+([\w.\-:[\]]{1,100}))?/,
    explain: (m) => `Nothing accepted the connection${m[1] ? ` at ${m[1]}` : ''} (ECONNREFUSED). The service may not be running yet, or the address or port may be wrong.`,
    actions: (m) => (m[1] ? [copy('Copy the refused address', m[1])] : []) },
  { code: 'CANNOT_FIND_MODULE', title: 'Module not found', confidence: 'high', re: /Cannot find (?:module|package) ['"]([^'"\r\n]{1,300})['"]/,
    explain: (m) => `Node could not resolve the module "${m[1]}". It may not be installed, the import path may be misspelled, or the build output may be missing.`,
    actions: (m) => [copy('Copy module name', m[1])] },
  { code: 'HEAP_OUT_OF_MEMORY', title: 'JavaScript heap out of memory', confidence: 'high', re: /JavaScript heap out of memory|Reached heap limit/i,
    explain: () => 'The Node/JavaScript process used up its memory limit and was stopped. The input may be too large, or the program may be holding on to data it no longer needs.' },
  { code: 'ACCESS_DENIED', title: 'Access is denied (Windows)', confidence: 'high', re: /Access is denied/i,
    explain: () => 'Windows refused access. The item may be protected, in use by another program, or need permissions the current user does not have.',
    actions: () => [SETTINGS_FOLDERS] },
  { code: 'PY_MODULE_NOT_FOUND', title: 'Python module not found', confidence: 'high', re: /ModuleNotFoundError: No module named ['"]([^'"\r\n]{1,200})['"]/,
    explain: (m) => `Python could not import "${m[1]}". It may not be installed in the Python environment that ran the script.`,
    actions: (m) => [copy('Copy module name', m[1])] },
  { code: 'PY_TRACEBACK', title: 'Python traceback', confidence: 'medium', re: /Traceback \(most recent call last\):?/,
    explain: () => 'This is a Python traceback. The last line names the exception that stopped the program; the "File …, line …" entries above it show where it happened, most recent last.' },
  { code: 'PORT_IN_USE', title: 'Port already in use', confidence: 'medium', re: /\bport\s+:?(\d{1,5})\s+(?:is\s+)?already\s+in\s+use/i,
    explain: (m) => `Port ${m[1]} is already taken by another program. Close that program or choose a different port.`,
    actions: (m) => [copy(`Copy port number ${m[1]}`, m[1])] },
];

const HRESULTS: Record<string, string> = {
  '0x80070005': 'E_ACCESSDENIED: access is denied.',
  '0x80070002': 'The system cannot find the file specified.',
  '0x80070003': 'The system cannot find the path specified.',
  '0x80070020': 'The file is being used by another process.',
  '0x80004005': 'E_FAIL: unspecified failure; look for a more specific message nearby.',
  '0x8007000e': 'E_OUTOFMEMORY: not enough memory.',
  '0x80070057': 'E_INVALIDARG: an argument was invalid.',
};

function hresultMatches(text: string): DiagnosisMatch[] {
  const seen = new Set<string>();
  const out: DiagnosisMatch[] = [];
  for (const m of text.matchAll(/\b0x8[0-9a-f]{7}\b/gi)) {
    const code = m[0].toLowerCase();
    if (seen.has(code) || out.length >= 3) continue;
    seen.add(code);
    const known = HRESULTS[code];
    out.push({
      code: `HRESULT_${code}`,
      title: `Windows error code ${code}`,
      explanation: known ? `Windows HRESULT ${code}: ${known}` : `Windows HRESULT ${code} signals a failure. This checker does not know this specific code; search for it together with the program name.`,
      confidence: known ? 'high' : 'low',
    });
  }
  return out;
}

const WIN_PATH = String.raw`[A-Za-z]:\\(?:[^\\/:*?"<>|\s()'\`,;]+\\)*[^\\/:*?"<>|\s()'\`,;]*`;
const POSIX_PATH = String.raw`\/(?:[\w.@+~-]+\/)+[\w.@+~-]+`;

function cleanPath(p: string): string {
  return p.replace(/[.,;]+$/, '').slice(0, DIAGNOSIS_LIMITS.pathChars);
}
function num(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 && n < 10_000_000 ? n : null;
}

/** Finds paths and file:line[:col] references as plain strings. Nothing is resolved, opened or checked on disk. */
export function extractPaths(text: string): { paths: string[]; locations: SourceLocation[] } {
  const paths: string[] = [];
  const locations: SourceLocation[] = [];
  let work = text;
  const add = (raw: string, line?: string, col?: string) => {
    const p = cleanPath(raw.trim());
    if (p.length < 3) return;
    if (!paths.includes(p) && paths.length < DIAGNOSIS_LIMITS.paths) paths.push(p);
    const l = num(line);
    if (l !== null && locations.length < DIAGNOSIS_LIMITS.locations && !locations.some((x) => x.path === p && x.line === l && x.column === num(col))) {
      locations.push({ path: p, line: l, column: num(col) });
    }
  };
  const mask = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    work = work.replace(re, (...args) => {
      const whole = args[0] as string;
      fn(args.slice(0, -2) as unknown as RegExpMatchArray);
      return ' '.repeat(whole.length);
    });
  };
  // Forms that can contain spaces: "(C:\Program Files\x.js:1:2)", Python 'File "…", line N', and quoted paths.
  mask(new RegExp(String.raw`\(((?:[A-Za-z]:\\|\/)[^()\r\n"]{1,400}?):(\d+)(?::(\d+))?\)`, 'g'), (m) => add(m[1], m[2], m[3]));
  mask(/File "([^"\r\n]{1,400})", line (\d+)/g, (m) => add(m[1], m[2]));
  mask(/['"]((?:[A-Za-z]:\\|\/)[^'"\r\n]{1,400})['"]/g, (m) => add(m[1]));
  // Bare paths without spaces, with optional :line:col.
  mask(new RegExp(String.raw`(?<![\w\\])(${WIN_PATH})(?::(\d+))?(?::(\d+))?`, 'g'), (m) => add(m[1], m[2], m[3]));
  mask(new RegExp(String.raw`(?<=^|[\s(\[='"\`,])(${POSIX_PATH})(?::(\d+))?(?::(\d+))?`, 'gm'), (m) => add(m[1], m[2], m[3]));
  return { paths, locations };
}

function parentFolder(p: string): string {
  const win = /^[A-Za-z]:\\/.test(p);
  const sep = win ? '\\' : '/';
  const trimmed = p.length > (win ? 3 : 1) && p.endsWith(sep) ? p.slice(0, -1) : p;
  const i = trimmed.lastIndexOf(sep);
  if (win) return i <= 2 ? trimmed.slice(0, 2) + '\\' : trimmed.slice(0, i);
  return i <= 0 ? '/' : trimmed.slice(0, i);
}
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function finalize(drafts: Draft[]): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const d of drafts) {
    if (!(ACTION_KINDS as readonly string[]).includes(d.kind) || !d.target) continue;
    if (out.some((a) => a.kind === d.kind && a.target === d.target)) continue;
    if (out.length >= DIAGNOSIS_LIMITS.actions) break;
    out.push({ id: `action-${out.length + 1}`, kind: d.kind, label: d.label, target: d.target, requiresConfirmation: true });
  }
  return out;
}

/** The desktop action a proposed path action maps to. Same shape as ActionRequest in src/shared/contracts.ts. */
export type DiagnosisActionRequest = { type: 'open-path' | 'reveal-folder'; target: string };

/**
 * Maps a proposed open-path / reveal-folder action to the exact ActionRequest for previewAction (target unchanged).
 * Returns null for renderer-only actions (copy-text, open-settings) and for anything without a target. The request is
 * only ever a preview candidate: the main process checks it and the user must confirm before anything opens.
 */
export function diagnosisActionToRequest(action: Pick<ProposedAction, 'kind' | 'target'> | null | undefined): DiagnosisActionRequest | null {
  if (!action || typeof action.target !== 'string' || !action.target) return null;
  if (action.kind === 'open-path' || action.kind === 'reveal-folder') return { type: action.kind, target: action.target };
  return null;
}

export function diagnoseErrorText(text: string): Diagnosis {
  const raw = typeof text === 'string' ? text : '';
  const truncated = raw.length > DIAGNOSIS_LIMITS.inputChars;
  const input = truncated ? raw.slice(0, DIAGNOSIS_LIMITS.inputChars) : raw;
  const trimmed = input.trim();
  if (!trimmed) return { matches: [], paths: [], locations: [], proposedActions: [], truncated, summary: 'Paste an error message to diagnose.' };

  const { paths, locations } = extractPaths(input);
  const copyAll = copy('Copy the error text', trimmed.slice(0, DIAGNOSIS_LIMITS.copyChars));
  const matches: DiagnosisMatch[] = [];
  const extra: Draft[] = [];
  for (const rule of RULES) {
    const m = input.match(rule.re);
    if (!m) continue;
    matches.push({ code: rule.code, title: rule.title, explanation: rule.explain(m), confidence: rule.confidence });
    if (rule.actions) extra.push(...rule.actions(m));
  }
  matches.push(...hresultMatches(input));
  if (matches.some((m) => m.code === 'HRESULT_0x80070005')) extra.push(SETTINGS_FOLDERS);

  if (matches.length === 0) {
    return { matches, paths, locations, proposedActions: finalize([copyAll]), truncated, summary: NO_PATTERN_TEXT };
  }
  const pathDrafts: Draft[] = [];
  for (const p of paths.slice(0, DIAGNOSIS_LIMITS.pathActions)) {
    pathDrafts.push({ kind: 'open-path', label: `Open ${baseName(p)}`, target: p });
    pathDrafts.push({ kind: 'reveal-folder', label: `Show folder of ${baseName(p)}`, target: parentFolder(p) });
  }
  const summary = `Recognized ${matches.length} known pattern${matches.length === 1 ? '' : 's'}${truncated ? ` in the first ${DIAGNOSIS_LIMITS.inputChars.toLocaleString('en-US')} characters` : ''}. These are rule-based guesses; nothing was run.`;
  return { matches, paths, locations, proposedActions: finalize([...pathDrafts, ...extra, copyAll]), truncated, summary };
}
