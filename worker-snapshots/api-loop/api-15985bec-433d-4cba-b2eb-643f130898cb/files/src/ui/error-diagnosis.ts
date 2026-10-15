// Error diagnosis (registry feature 28): a local, offline, rule-based first pass.
// It only reads the pasted text and returns proposals. Nothing here executes, opens, copies or contacts anything;
// proposals that map to an existing approved action type are routed by the UI into the normal
// preview → review → native confirmation flow, and everything else is shown as a manual step.
import type { ActionRequest } from '../shared/contracts';

export type DiagnosisConfidence = 'low' | 'medium' | 'high';
export type ProposedActionKind = 'open-path' | 'open-app' | 'copy-text' | 'show-docs-offline' | 'manual';

export interface ProposedAction {
  label: string;
  kind: ProposedActionKind;
  target?: string;
  requiresConfirmation: true;
  reversible: boolean;
  rationale: string;
}

export type DiagnosisCategory =
  | 'node-module-not-found'
  | 'npm-peer-deps'
  | 'port-in-use'
  | 'file-not-found'
  | 'permission-denied'
  | 'python-module-not-found'
  | 'python-indentation'
  | 'python-traceback'
  | 'git-merge-conflict'
  | 'git-detached-head'
  | 'git-push-rejected'
  | 'git-auth-failure'
  | 'powershell-execution-policy'
  | 'windows-hresult'
  | 'windows-win32-error'
  | 'windows-access-denied'
  | 'windows-file-in-use'
  | 'network-refused'
  | 'stack-trace'
  | 'unknown';

export interface StackFrame { file: string; line: number; column?: number }

export interface Diagnosis {
  category: DiagnosisCategory;
  confidence: DiagnosisConfidence;
  summary: string;
  matchedSignals: string[];
  likelyCauses: string[];
  proposedActions: ProposedAction[];
  unknown: boolean;
  /** Other categories that also matched, most specific first. */
  relatedCategories: DiagnosisCategory[];
  /** Top file:line frames found in the text (redacted). */
  frames: StackFrame[];
}

/** Input beyond this length is ignored so rules stay fast on huge pastes. */
export const MAX_DIAGNOSIS_INPUT = 50_000;
const MAX_SIGNAL = 160;
const MAX_TARGET = 500;

const REDACTED = '[REDACTED]';

/** Removes obvious secrets: bearer/basic tokens, credentials in URLs, key=value secrets and well-known token formats. */
export function redactSensitive(text: string): string {
  if (typeof text !== 'string' || !text) return '';
  return text
    // user:password@ in URLs (also user@ with a token-looking username)
    .replace(/\b([a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`)
    .replace(/\b(authorization)(\s*[:=]\s*)(?!\[REDACTED\]|Bearer|Basic|Token)[^\s,;]+/gi, `$1$2${REDACTED}`)
    .replace(/\b((?:[a-z0-9]+[_-])?(?:api[_-]?key|apikey|access[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|password|passwd|pwd|pass))(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, `$1$2${REDACTED}`)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

const clip = (s: string, n = MAX_SIGNAL) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const signal = (s: string) => clip(redactSensitive(s.replace(/\s+/g, ' ').trim()));

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/]|\/)/;
const isAbsolutePath = (p: string) => ABSOLUTE.test(p) && !/[\0<>|"?*]/.test(p.replace(/^[A-Za-z]:/, ''));
const stripFileUrl = (p: string) => p.replace(/^file:\/\/\/?(?=[A-Za-z]:)/i, '').replace(/^file:\/\//i, '');
function parentDir(p: string): string | null {
  const m = /^(.*)[\\/][^\\/]+[\\/]?$/.exec(p.replace(/[\\/]+$/, ''));
  if (!m) return null;
  const dir = m[1] || '/';
  return /^[A-Za-z]:$/.test(dir) ? dir + '\\' : dir;
}

/** Extracts the top file:line frames (Node, Python, generic), skipping runtime internals. Text order is preserved. */
export function extractFrames(text: string, limit = 5): StackFrame[] {
  const out: StackFrame[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: string, column?: string) => {
    const f = stripFileUrl(file.trim());
    if (!f || /^node:|^internal[\\/]|[\\/]node_modules[\\/]|^<|^\(/.test(f)) return;
    const n = Number(line);
    if (!Number.isSafeInteger(n) || n <= 0) return;
    const key = `${f}:${n}`;
    if (seen.has(key)) return;
    seen.add(key);
    const frame: StackFrame = { file: clip(redactSensitive(f), MAX_TARGET), line: n };
    const c = column === undefined ? NaN : Number(column);
    if (Number.isSafeInteger(c) && c > 0) frame.column = c;
    out.push(frame);
  };
  const src = text.slice(0, MAX_DIAGNOSIS_INPUT);
  for (const raw of src.split(/\r?\n/)) {
    if (out.length >= limit) break;
    const line = raw.trim();
    let m = /^File "([^"]{1,500})", line (\d{1,7})/.exec(line);
    if (m) { add(m[1], m[2]); continue; }
    m = /^at (?:.{0,300}? \()?((?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\s()]{1,500}?):(\d{1,7})(?::(\d{1,7}))?\)?$/.exec(line);
    if (m) { add(m[1], m[2], m[3]); continue; }
    m = /((?:[A-Za-z]:[\\/]|\/)?[\w.\-\\/ ]{0,400}?\.[A-Za-z][\w]{0,5}):(\d{1,7})(?::(\d{1,7}))?\b/.exec(line);
    if (m && !/^https?:/i.test(line.slice(Math.max(0, m.index - 8), m.index + 8))) add(m[1], m[2], m[3]);
  }
  return out.slice(0, limit);
}

type Action = Omit<ProposedAction, 'requiresConfirmation'>;
const act = (a: Action): ProposedAction => {
  const out: ProposedAction = { label: a.label, kind: a.kind, requiresConfirmation: true, reversible: a.reversible, rationale: a.rationale };
  if (a.target !== undefined) {
    const t = clip(redactSensitive(a.target).trim(), MAX_TARGET);
    if (t) out.target = t;
  }
  return out;
};
const manual = (label: string, rationale: string, reversible = true): ProposedAction => act({ label, kind: 'manual', reversible, rationale });
const copy = (label: string, text: string, rationale: string): ProposedAction => act({ label, kind: 'copy-text', target: text, reversible: true, rationale });
const docs = (label: string, target: string, rationale: string): ProposedAction => act({ label, kind: 'show-docs-offline', target, reversible: true, rationale });
const openPath = (label: string, path: string | null | undefined, rationale: string): ProposedAction[] =>
  path && isAbsolutePath(path) && path.length <= MAX_TARGET ? [act({ label, kind: 'open-path', target: path, reversible: true, rationale })] : [];
const openApp = (label: string, app: string, rationale: string): ProposedAction => act({ label, kind: 'open-app', target: app, reversible: true, rationale });

interface Match { signals: string[]; summary: string; causes: string[]; actions: ProposedAction[]; confidence: DiagnosisConfidence }
interface Rule { category: DiagnosisCategory; test: (text: string, frames: StackFrame[]) => Match | null }

const firstMatch = (text: string, patterns: RegExp[]): RegExpExecArray | null => {
  for (const p of patterns) { const m = p.exec(text); if (m) return m; }
  return null;
};
const quotedPathAfter = (text: string, code: string): string | null => {
  const m = new RegExp(`${code}[^\\n'"]{0,120}['"]([^'"\\n]{1,500})['"]`).exec(text);
  return m ? stripFileUrl(m[1]) : null;
};
const safeName = (s: string | undefined) => (s && /^[@\w./:\\-]{1,200}$/.test(s) ? s : undefined);

const WIN32: Record<number, { name: string; meaning: string }> = {
  2: { name: 'ERROR_FILE_NOT_FOUND', meaning: 'The system cannot find the file specified.' },
  3: { name: 'ERROR_PATH_NOT_FOUND', meaning: 'The system cannot find the path specified.' },
  5: { name: 'ERROR_ACCESS_DENIED', meaning: 'Access is denied.' },
  32: { name: 'ERROR_SHARING_VIOLATION', meaning: 'The file is being used by another process.' },
  183: { name: 'ERROR_ALREADY_EXISTS', meaning: 'Cannot create a file when that file already exists.' },
  1223: { name: 'ERROR_CANCELLED', meaning: 'The operation was cancelled by the user (for example a UAC prompt was declined).' },
  1314: { name: 'ERROR_PRIVILEGE_NOT_HELD', meaning: 'A required privilege is not held by the client.' },
};
const HRESULT: Record<string, string> = {
  '0X80004005': 'E_FAIL: unspecified failure.',
  '0X80004002': 'E_NOINTERFACE: the requested interface is not supported.',
  '0X8000FFFF': 'E_UNEXPECTED: catastrophic or unexpected failure.',
  '0X80070057': 'E_INVALIDARG: one or more arguments are invalid.',
  '0X8007000E': 'E_OUTOFMEMORY: not enough memory.',
};

function win32Advice(code: number, path: string | null): { causes: string[]; actions: ProposedAction[] } {
  switch (code) {
    case 2: case 3:
      return { causes: ['The file or folder path is wrong or no longer exists.', 'A relative path was resolved from an unexpected working directory.'], actions: [...openPath('Open the parent folder', path ? parentDir(path) : null, 'Check whether the expected file is there.'), manual('Check the path and working directory', 'Typos and relative paths are the usual cause.')] };
    case 5:
      return { causes: ['The account lacks permission for the file, folder or registry key.', 'Antivirus or a protected folder blocks the write.', 'The file is read-only or owned by another user.'], actions: [...openPath('Open the containing folder', path ? parentDir(path) : null, 'Inspect the file and its properties (Security tab).'), manual('Check file permissions and read-only state', 'Prefer fixing permissions on your own folders over running as administrator.', true)] };
    case 32:
      return { causes: ['Another process (editor, build watcher, antivirus, indexer) holds the file open.'], actions: [openApp('Open Resource Monitor to find the locking process', 'resmon.exe', 'The CPU tab → Associated Handles search shows which process has the file open.'), manual('Close the program using the file, then retry', 'Closing the holder releases the lock without data loss when you save first.')] };
    case 1223:
      return { causes: ['A UAC prompt or confirmation dialog was declined or closed.'], actions: [manual('Retry and accept the prompt only if you trust the operation', 'Error 1223 means the user cancelled; nothing is broken.')] };
    case 183:
      return { causes: ['The target file or folder already exists.'], actions: [manual('Choose another name or remove the existing item yourself', 'Removing files is not reversible from here.', false)] };
    case 1314:
      return { causes: ['The operation needs a privilege (for example creating symbolic links) that the account does not hold.'], actions: [manual('Enable Developer Mode or run with the needed privilege only if you trust the tool', 'Privilege changes affect the whole account.', true)] };
    default:
      return { causes: [], actions: [] };
  }
}

const RULES: Rule[] = [
  {
    category: 'powershell-execution-policy',
    test: (t) => {
      const m = firstMatch(t, [/running scripts is disabled on this system[^\n]*/i, /about_Execution_Policies[^\n]*/i, /PSSecurityException[^\n]*/i, /is not digitally signed[^\n]*/i]);
      if (!m) return null;
      return {
        signals: [m[0]], confidence: 'high',
        summary: 'PowerShell blocked a script because of the execution policy.',
        causes: ['The effective execution policy (Restricted or AllSigned) does not allow this script.', 'The script was downloaded and carries a Mark-of-the-Web zone identifier.'],
        actions: [
          copy('Copy a read-only command to inspect the policy', 'Get-ExecutionPolicy -List', 'Shows the policy at each scope without changing anything.'),
          docs('Read the execution policy help offline', 'Get-Help about_Execution_Policies', 'Built-in PowerShell help explains each policy and scope.'),
          manual('Only if you trust the script: allow signed or local scripts for your account', 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned changes a per-user setting and can be set back; never weaken it for scripts you do not trust.', true),
        ],
      };
    },
  },
  {
    category: 'node-module-not-found',
    test: (t) => {
      const m = firstMatch(t, [/ERR_MODULE_NOT_FOUND[^\n]*/, /Cannot find (?:module|package) ['"]([^'"\n]{1,300})['"][^\n]*/, /MODULE_NOT_FOUND[^\n]*/]);
      if (!m) return null;
      const name = /Cannot find (?:module|package) ['"]([^'"\n]{1,300})['"]/.exec(t)?.[1];
      const relative = !!name && /^(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/|file:)/.test(name);
      const pkg = name && !relative ? safeName(name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]) : undefined;
      const importer = /imported from ([^\n]{1,500})/.exec(t)?.[1]?.trim();
      return {
        signals: [m[0], ...(name && !m[0].includes(name) ? [`Cannot find module '${name}'`] : [])], confidence: 'high',
        summary: name ? `Node.js could not resolve the module "${redactSensitive(name)}".` : 'Node.js could not resolve an imported module.',
        causes: relative
          ? ['The relative import path is wrong or the file was moved.', 'ES modules require the full file extension (for example ./util.js).']
          : ['The dependency is not installed (node_modules missing or out of date).', 'The package name is misspelled or the import targets an unexported subpath.', 'The command runs from a different folder than the project.'],
        actions: [
          ...(pkg ? [copy('Copy a command to check whether the package is installed', `npm ls ${pkg}`, 'Read-only: lists the installed version, if any.')] : []),
          ...(relative ? openPath('Open the importing file\'s folder', importer ? parentDir(stripFileUrl(importer)) : null, 'Compare the import path with the files that exist.') : []),
          manual(relative ? 'Fix the import path and add the file extension' : 'Install dependencies with your package manager from the project folder', relative ? 'ESM resolution does not guess extensions or index files.' : 'Running npm install yourself restores node_modules; it uses the network.', true),
        ],
      };
    },
  },
  {
    category: 'npm-peer-deps',
    test: (t) => {
      const m = firstMatch(t, [/ERESOLVE[^\n]*/, /unable to resolve dependency tree[^\n]*/i, /Conflicting peer dependency[^\n]*/i, /Could not resolve dependency:[^\n]*/i, /peer dep(?:endency)?[^\n]*(?:conflict|missing|requires)[^\n]*/i]);
      if (!m) return null;
      const peer = /(?:Conflicting peer dependency|peer) ([@\w./-]{1,200})@/.exec(t)?.[1];
      return {
        signals: [m[0]], confidence: 'high',
        summary: 'npm could not build a dependency tree because of conflicting peer dependency versions.',
        causes: ['Two packages require incompatible versions of the same peer dependency.', 'A package has not yet declared support for the newer major version you installed.'],
        actions: [
          copy('Copy a command to see who requires the conflicting package', `npm ls ${safeName(peer) ?? '<package>'}`, 'Read-only: shows the dependency path.'),
          docs('Read npm install help offline', 'npm help install', 'npm ships its documentation locally.'),
          manual('Align the versions in package.json (upgrade or pin the conflicting package)', 'Fixing versions is preferable to --legacy-peer-deps, which only hides the conflict.', true),
        ],
      };
    },
  },
  {
    category: 'port-in-use',
    test: (t) => {
      const m = firstMatch(t, [/EADDRINUSE[^\n]*/, /address already in use[^\n]*/i, /Only one usage of each socket address[^\n]*/i]);
      if (!m) return null;
      const port = /(?:EADDRINUSE|in use)[^\n]*?:(\d{2,5})\b/i.exec(t)?.[1] ?? /\bport (\d{2,5})\b/i.exec(t)?.[1];
      return {
        signals: [m[0]], confidence: 'high',
        summary: port ? `Port ${port} is already in use by another process.` : 'The network port is already in use by another process.',
        causes: ['A previous instance of the server is still running.', 'Another application already listens on the same port.'],
        actions: [
          copy('Copy a read-only command to find the process on the port', port ? `netstat -ano | findstr :${port}` : 'netstat -ano', 'Lists listening sockets with their process ids; changes nothing.'),
          openApp('Open Resource Monitor (Network → Listening Ports)', 'resmon.exe', 'Shows which process owns the port.'),
          manual('Stop the old instance or start the server on a different port', 'Ending an unknown process can lose unsaved work; prefer changing the port.', true),
        ],
      };
    },
  },
  {
    category: 'git-merge-conflict',
    test: (t) => {
      const m = firstMatch(t, [/CONFLICT \([^)]{1,40}\):[^\n]*/, /Automatic merge failed[^\n]*/i, /fix conflicts and then commit[^\n]*/i, /^<{7} [^\n]*/m, /You have unmerged paths[^\n]*/i]);
      if (!m) return null;
      const files = [...t.matchAll(/Merge conflict in ([^\n]{1,300})/g)].map(x => x[1].trim()).slice(0, 5);
      return {
        signals: [m[0], ...files.map(f => `Merge conflict in ${f}`)].slice(0, 6), confidence: 'high',
        summary: files.length ? `Git stopped a merge with conflicts in ${files.length} file(s): ${files.map(f => redactSensitive(f)).join(', ')}.` : 'Git stopped a merge because of conflicting changes.',
        causes: ['The same lines were changed on both branches.'],
        actions: [
          copy('Copy a read-only command to list conflicted files', 'git status', 'Shows unmerged paths without changing anything.'),
          ...files.flatMap(f => openPath(`Open ${f}`, f, 'Resolve the <<<<<<< / ======= / >>>>>>> markers.')),
          manual('Resolve the markers, then git add the files and commit', 'Resolution stays local until you push.', true),
          manual('Or abandon the merge with git merge --abort', 'Returns to the pre-merge state; resolved edits are discarded.', false),
        ],
      };
    },
  },
  {
    category: 'git-detached-head',
    test: (t) => {
      const m = firstMatch(t, [/HEAD detached (?:at|from) [^\n]*/i, /You are in ['"]detached HEAD['"] state[^\n]*/i, /not currently on (?:a|any) branch[^\n]*/i]);
      if (!m) return null;
      return {
        signals: [m[0]], confidence: 'high',
        summary: 'The Git repository is in a detached HEAD state (not on a branch).',
        causes: ['A tag, commit or remote branch was checked out directly.', 'A rebase or bisect is in progress.'],
        actions: [
          copy('Copy a command to keep your work on a new branch', 'git switch -c <new-branch-name>', 'Creating a branch preserves any commits made while detached.'),
          copy('Copy a read-only command to see the current state', 'git status', 'Shows whether a rebase or bisect is in progress.'),
          manual('Or return to your branch with git switch <branch>', 'Commits made while detached become hard to find unless a branch points to them.', true),
        ],
      };
    },
  },
  {
    category: 'git-push-rejected',
    test: (t) => {
      const m = firstMatch(t, [/! \[rejected\][^\n]*/, /failed to push some refs[^\n]*/i, /Updates were rejected[^\n]*/i, /\(non-fast-forward\)[^\n]*/i, /\(fetch first\)[^\n]*/i]);
      if (!m) return null;
      if (/protected branch|pre-receive hook declined/i.test(t)) {
        return { signals: [m[0]], confidence: 'medium', summary: 'The remote rejected the push (protected branch or server hook).', causes: ['The branch is protected or a server-side hook declined the push.'], actions: [manual('Push to a feature branch and open a review instead', 'Protected branches usually require reviews.', true)] };
      }
      return {
        signals: [m[0]], confidence: 'high',
        summary: 'Git rejected the push because the remote branch has commits you do not have.',
        causes: ['Someone else pushed to the branch first.', 'Local history was rewritten (rebase/amend) after it was pushed.'],
        actions: [
          copy('Copy a command to integrate the remote changes', 'git pull --rebase', 'Replays your commits on top of the remote branch.'),
          manual('Resolve any conflicts, then push again', 'Keeps everyone\'s commits.', true),
          manual('Do not force-push a shared branch unless everyone agrees', 'A force push can permanently discard other people\'s commits on the remote.', false),
        ],
      };
    },
  },
  {
    category: 'git-auth-failure',
    test: (t) => {
      const m = firstMatch(t, [/Authentication failed for[^\n]*/i, /Permission denied \(publickey[^\n]*/i, /could not read Username for[^\n]*/i, /Invalid username or password[^\n]*/i, /Support for password authentication was removed[^\n]*/i, /The requested URL returned error: 40[13][^\n]*/i, /Host key verification failed[^\n]*/i]);
      if (!m) return null;
      const ssh = /publickey|Host key/i.test(m[0]);
      return {
        signals: [m[0]], confidence: 'high',
        summary: ssh ? 'Git could not authenticate to the remote over SSH.' : 'Git could not authenticate to the remote over HTTPS.',
        causes: ssh
          ? ['No SSH key is loaded or the key is not registered with the host.', 'The host key changed or is not yet trusted.']
          : ['Stored credentials are expired or wrong.', 'The host no longer accepts account passwords and needs a personal access token.', 'The account lacks access to the repository.'],
        actions: [
          copy('Copy a read-only command to check the remote URL', 'git remote -v', 'Confirms which host and protocol are used.'),
          manual(ssh ? 'Check that your SSH key is loaded and registered with the host' : 'Update the stored credential in Windows Credential Manager', 'Credentials are entered by you in the credential tool, never pasted here.', true),
          manual('Never paste tokens or passwords into this diagnosis box', 'Secrets are redacted from the result, but they should not be shared at all.', true),
        ],
      };
    },
  },
  {
    category: 'python-module-not-found',
    test: (t) => {
      const m = firstMatch(t, [/ModuleNotFoundError: No module named ['"]([^'"\n]{1,200})['"][^\n]*/, /ImportError: No module named ['"]?([\w.]{1,200})['"]?[^\n]*/]);
      if (!m) return null;
      const mod = safeName(m[1]?.split('.')[0]);
      return {
        signals: [m[0]], confidence: 'high',
        summary: mod ? `Python could not import the module "${mod}".` : 'Python could not import a module.',
        causes: ['The package is not installed in the interpreter that runs the script.', 'A virtual environment is not activated, or a different Python is on PATH.', 'The import name differs from the pip package name.'],
        actions: [
          copy('Copy a read-only command to see which interpreter runs', 'python -c "import sys; print(sys.executable)"', 'Confirms the interpreter and environment.'),
          ...(mod ? [copy('Copy a read-only command to look for the package', `python -m pip show ${mod}`, 'Reports whether it is installed in this interpreter.')] : []),
          manual('Activate the project virtual environment, then install the package yourself', 'Installing uses the network and changes the environment; do it deliberately.', true),
        ],
      };
    },
  },
  {
    category: 'python-indentation',
    test: (t) => {
      const m = firstMatch(t, [/IndentationError:[^\n]*/, /TabError:[^\n]*/]);
      if (!m) return null;
      const where = /File "([^"\n]{1,500})", line (\d{1,7})/.exec(t);
      return {
        signals: [m[0], ...(where ? [`File "${where[1]}", line ${where[2]}`] : [])], confidence: 'high',
        summary: where ? `Python found inconsistent indentation at line ${where[2]} of ${redactSensitive(where[1])}.` : 'Python found inconsistent indentation.',
        causes: ['Tabs and spaces are mixed.', 'A block is missing after a colon, or a line is indented one level too far.'],
        actions: [
          ...openPath('Open the file with the indentation error', where?.[1], `Go to line ${where?.[2] ?? '?'} and make the indentation consistent.`),
          manual('Convert tabs to spaces in your editor and re-indent the block', 'Editor reformatting is reversible with undo.', true),
        ],
      };
    },
  },
  {
    category: 'python-traceback',
    test: (t) => {
      const m = /Traceback \(most recent call last\):/.exec(t);
      if (!m) return null;
      const frames = [...t.matchAll(/File "([^"\n]{1,500})", line (\d{1,7})(?:, in ([^\n]{1,120}))?/g)];
      const last = frames[frames.length - 1];
      const exc = /^\s*([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning))(?::\s*([^\n]*))?\s*$/m.exec(t.slice(m.index));
      return {
        signals: [m[0], ...(exc ? [exc[0]] : []), ...(last ? [`File "${last[1]}", line ${last[2]}`] : [])], confidence: exc ? 'medium' : 'low',
        summary: `Python raised ${exc ? exc[1] : 'an exception'}${last ? ` in ${redactSensitive(last[1])} at line ${last[2]}` : ''}${exc?.[2] ? `: ${redactSensitive(clip(exc[2], 120))}` : ''}.`,
        causes: ['The innermost frame (last "File" line) is usually where the problem surfaced; earlier frames show how it was reached.'],
        actions: [
          ...openPath('Open the innermost file from the traceback', last?.[1], `Inspect line ${last?.[2] ?? '?'}.`),
          manual('Read the final exception line and the innermost frame of your own code', 'Frames inside site-packages are rarely the root cause.', true),
        ],
      };
    },
  },
  {
    category: 'windows-file-in-use',
    test: (t) => {
      const m = firstMatch(t, [/being used by another process[^\n]*/i, /The process cannot access the file[^\n]*/i, /\bfile (?:is )?(?:in use|locked)\b[^\n]*/i, /ERROR_SHARING_VIOLATION[^\n]*/, /\bEBUSY\b[^\n]*/]);
      if (!m) return null;
      const path = /['"]([A-Za-z]:\\[^'"\n]{1,400})['"]/.exec(t)?.[1] ?? null;
      const advice = win32Advice(32, path);
      return { signals: [m[0]], confidence: 'high', summary: 'A file is locked because another process is using it.', causes: advice.causes, actions: [...openPath('Open the folder containing the locked file', path ? parentDir(path) : null, 'Check which file is involved.'), ...advice.actions] };
    },
  },
  {
    category: 'permission-denied',
    test: (t) => {
      const m = firstMatch(t, [/\bEACCES\b[^\n]*/, /\bEPERM\b[^\n]*/, /PermissionError:[^\n]*/, /operation not permitted[^\n]*/i]);
      if (!m) return null;
      const code = /EPERM/.test(m[0]) ? 'EPERM' : 'EACCES';
      const path = quotedPathAfter(t, code) ?? /PermissionError:[^\n]*['"]([^'"\n]{1,500})['"]/.exec(t)?.[1] ?? null;
      return {
        signals: [m[0]], confidence: 'high',
        summary: path ? `Permission was denied for ${redactSensitive(path)}.` : 'The operating system denied permission for a file operation.',
        causes: ['The file or folder is read-only, owned by another account, or in a protected location.', 'On Windows, EPERM often means the file is locked by an editor, antivirus or a running process.', 'A global install targets a folder that needs administrator rights.'],
        actions: [
          ...openPath('Open the containing folder', path ? parentDir(path) : null, 'Check the file\'s properties and whether it is open elsewhere.'),
          openApp('Open Resource Monitor to look for a process holding the file', 'resmon.exe', 'Associated Handles search reveals locks.'),
          manual('Fix permissions on your own folders instead of running as administrator', 'Elevating hides the cause and widens what the tool can change.', true),
        ],
      };
    },
  },
  {
    category: 'file-not-found',
    test: (t) => {
      const m = firstMatch(t, [/\bENOENT\b[^\n]*/, /FileNotFoundError:[^\n]*/, /No such file or directory[^\n]*/i, /The system cannot find the (?:file|path) specified[^\n]*/i]);
      if (!m) return null;
      const path = quotedPathAfter(t, 'ENOENT') ?? /FileNotFoundError:[^\n]*['"]([^'"\n]{1,500})['"]/.exec(t)?.[1] ?? null;
      const advice = win32Advice(2, path);
      return { signals: [m[0]], confidence: 'high', summary: path ? `A file or folder was not found: ${redactSensitive(path)}.` : 'A file or folder was not found.', causes: advice.causes, actions: advice.actions };
    },
  },
  {
    category: 'windows-access-denied',
    test: (t) => {
      const m = firstMatch(t, [/Access is denied\.?[^\n]*/i, /Access to the path [^\n]* is denied[^\n]*/i, /UnauthorizedAccessException[^\n]*/, /ERROR_ACCESS_DENIED[^\n]*/]);
      if (!m) return null;
      const path = /['"]([A-Za-z]:\\[^'"\n]{1,400})['"]/.exec(t)?.[1] ?? null;
      const advice = win32Advice(5, path);
      return { signals: [m[0]], confidence: 'high', summary: 'Windows denied access to a file, folder or resource.', causes: advice.causes, actions: advice.actions };
    },
  },
  {
    category: 'windows-hresult',
    test: (t) => {
      const m = /\b0x8[0-9A-Fa-f]{7}\b/.exec(t);
      if (!m) return null;
      const code = m[0].toUpperCase();
      const facility = (parseInt(code.slice(2), 16) >>> 16) & 0x1fff;
      const win32 = facility === 7 ? parseInt(code.slice(6), 16) : null;
      const known = win32 !== null ? WIN32[win32] : undefined;
      const meaning = known ? `${known.name}: ${known.meaning}` : HRESULT[code];
      const advice = win32 !== null ? win32Advice(win32, null) : { causes: [], actions: [] };
      return {
        signals: [lineAround(t, m.index)], confidence: meaning ? 'high' : 'low',
        summary: meaning ? `Windows error ${m[0]} (${meaning})` : `Windows returned HRESULT ${m[0]}, which this offline list does not recognize.`,
        causes: advice.causes.length ? advice.causes : [win32 !== null ? `HRESULT wraps Win32 error ${win32}.` : 'Look up the exact HRESULT in the documentation of the component that reported it.'],
        actions: [...advice.actions, copy('Copy the error code', m[0], 'Search it in the local documentation or event log of the reporting component.')],
      };
    },
  },
  {
    category: 'windows-win32-error',
    test: (t) => {
      const m = /\b(?:win32\s+|system\s+|windows\s+)?error(?:\s+code)?\s*[:=#]?\s*(\d{1,5})\b/i.exec(t);
      const named = /\bERROR_(FILE_NOT_FOUND|PATH_NOT_FOUND|SHARING_VIOLATION|CANCELLED|ALREADY_EXISTS|PRIVILEGE_NOT_HELD)\b/.exec(t);
      const code = m && WIN32[Number(m[1])] ? Number(m[1]) : named ? Number(Object.entries(WIN32).find(([, v]) => v.name === `ERROR_${named[1]}`)?.[0]) : NaN;
      if (!Number.isFinite(code) || !WIN32[code]) return null;
      const advice = win32Advice(code, /['"]([A-Za-z]:\\[^'"\n]{1,400})['"]/.exec(t)?.[1] ?? null);
      return { signals: [lineAround(t, (m && WIN32[Number(m[1])] ? m : named)!.index)], confidence: 'medium', summary: `Win32 error ${code} (${WIN32[code].name}): ${WIN32[code].meaning}`, causes: advice.causes, actions: advice.actions };
    },
  },
  {
    category: 'network-refused',
    test: (t) => {
      const m = firstMatch(t, [/\bECONNREFUSED\b[^\n]*/, /actively refused it[^\n]*/i, /Connection refused[^\n]*/i, /\bECONNRESET\b[^\n]*/, /\bETIMEDOUT\b[^\n]*/, /\bENOTFOUND\b[^\n]*/, /\bEAI_AGAIN\b[^\n]*/, /getaddrinfo[^\n]*/i]);
      if (!m) return null;
      const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m[0]);
      const port = /(?:127\.0\.0\.1|localhost|::1|\d{1,3}(?:\.\d{1,3}){3})[:\]]?:?(\d{2,5})\b/.exec(t)?.[1];
      return {
        signals: [m[0]], confidence: 'medium',
        summary: dns ? 'A host name could not be resolved.' : port ? `The connection to port ${port} was refused or timed out.` : 'A network connection was refused or timed out.',
        causes: dns
          ? ['The host name is misspelled, or the computer is offline.', 'A proxy or VPN is required to resolve the host.']
          : ['The server is not running or listens on a different port or address (127.0.0.1 vs ::1).', 'A firewall blocks the connection.', 'The service is still starting.'],
        actions: [
          ...(port ? [copy('Copy a read-only command to see whether anything listens on the port', `netstat -ano | findstr :${port}`, 'Lists listening sockets; changes nothing.')] : []),
          manual(dns ? 'Check the host name and your network connection' : 'Start the server, or point the client at the correct host and port', 'Desktop Companion does not test the network for you.', true),
        ],
      };
    },
  },
  {
    category: 'stack-trace',
    test: (t, frames) => {
      const at = /^\s+at\s+\S[^\n]*/m.exec(t) ?? /Exception in thread[^\n]*/.exec(t) ?? /^\s*(?:[A-Z]\w*)?(?:Error|Exception)(?::[^\n]*)?$/m.exec(t);
      if (!frames.length || !at) return null;
      const top = frames[0];
      const head = /^\s*([A-Z]\w*(?:Error|Exception))(?::\s*([^\n]*))?$/m.exec(t);
      return {
        signals: [at[0], ...frames.slice(0, 3).map(f => `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}`)], confidence: 'medium',
        summary: `${head ? redactSensitive(clip(head[0].trim(), 140)) : 'An error with a stack trace'} — top frame ${top.file}:${top.line}.`,
        causes: ['The first frame in your own code is usually where to start reading.'],
        actions: [
          ...openPath('Open the file of the top frame', top.file, `Inspect line ${top.line}.`),
          copy('Copy the top frames', frames.map(f => `${f.file}:${f.line}${f.column ? `:${f.column}` : ''}`).join('\n'), 'Useful for a bug report or a search in your editor.'),
          manual('Read the error message and the first frame in your own code', 'Frames in node_modules or runtime internals are rarely the root cause.', true),
        ],
      };
    },
  },
];

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

const UNKNOWN_SUMMARY = 'No confident diagnosis. The text did not match any known error pattern.';

function unknownDiagnosis(frames: StackFrame[]): Diagnosis {
  return {
    category: 'unknown', confidence: 'low', unknown: true, summary: UNKNOWN_SUMMARY,
    matchedSignals: [], likelyCauses: ['The message may come from a tool this offline rule set does not cover.'],
    proposedActions: [
      manual('Find the first line that says error, failed or exception', 'Later lines are often consequences of the first failure.', true),
      manual('Check the documentation of the tool that printed the message', 'Tool-specific messages need tool-specific fixes.', true),
      manual('Paste a longer excerpt including the command you ran', 'More context gives the rules more to match.', true),
    ],
    relatedCategories: [], frames,
  };
}

/** Rule-based offline diagnosis. Pure: reads the text and returns proposals; never executes anything. */
export function diagnoseError(text: string): Diagnosis {
  const input = typeof text === 'string' ? text.slice(0, MAX_DIAGNOSIS_INPUT).replace(/\0/g, '') : '';
  const frames = extractFrames(input);
  if (!input.trim()) return unknownDiagnosis(frames);
  const hits: { category: DiagnosisCategory; match: Match }[] = [];
  for (const rule of RULES) {
    const match = rule.test(input, frames);
    if (match) hits.push({ category: rule.category, match });
  }
  if (!hits.length) return unknownDiagnosis(frames);
  const primary = hits[0];
  const signals: string[] = [], causes: string[] = [], actions: ProposedAction[] = [];
  const seenActions = new Set<string>();
  for (const h of hits.slice(0, 4)) {
    for (const s of h.match.signals) { const v = signal(s); if (v && !signals.includes(v)) signals.push(v); }
    for (const c of h.match.causes) if (!causes.includes(c)) causes.push(c);
    for (const a of h.match.actions) { const k = `${a.kind}|${a.label}|${a.target ?? ''}`; if (!seenActions.has(k)) { seenActions.add(k); actions.push(a); } }
  }
  return {
    category: primary.category,
    confidence: primary.match.confidence,
    summary: clip(redactSensitive(primary.match.summary), 400),
    matchedSignals: signals.slice(0, 12),
    likelyCauses: causes.slice(0, 10),
    proposedActions: actions.slice(0, 10),
    unknown: false,
    relatedCategories: hits.slice(1).map(h => h.category),
    frames,
  };
}

/**
 * Maps a proposal onto an existing approved action type. Only open-path / open-app with a target map, both to the
 * 'launch' action, which the backend previews against Settings → Access (allowed folders / approved apps) and
 * executes only after review and the native confirmation. Everything else is a manual step (null).
 */
export function actionRequestFor(action: ProposedAction): ActionRequest | null {
  if (action.requiresConfirmation !== true) return null;
  if (action.kind !== 'open-path' && action.kind !== 'open-app') return null;
  const target = (action.target ?? '').trim();
  if (!target || target.length > MAX_TARGET || target.includes(REDACTED) || /[\0\r\n]/.test(target)) return null;
  if (action.kind === 'open-path' && !isAbsolutePath(target)) return null;
  if (action.kind === 'open-app' && !/^[\w.-]{1,100}\.exe$/i.test(target)) return null;
  return { type: 'launch', target };
}

export const DIAGNOSIS_KIND_LABEL: Record<ProposedActionKind, string> = {
  'open-path': 'Open path',
  'open-app': 'Open app',
  'copy-text': 'Copy text',
  'show-docs-offline': 'Offline docs',
  manual: 'Manual step',
};
