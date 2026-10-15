// Deterministic, local error diagnosis. Pasted error text is matched against a small rule library; nothing here calls a
// model, the network or the desktop. Every proposed action is data only:
// - backend actions ('open-path', 'open-app', 'open-url') carry the exact ActionRequest that previewAction receives, and
//   only run after previewAction -> the user's approval -> executeAction (which shows the native confirmation);
// - 'copy-command' carries command text that is shown in full and copied to the clipboard only after the user confirms.
//   Nothing is ever executed as a command by this app.
// Paths are only offered as their containing folder: opening a .js/.py/.cmd file with its default handler could run it.
// Open-URL actions are only proposed when online mode is on; in offline mode they are withheld and the result says so.
import type { ActionPreview, ActionRequest } from '../shared/contracts';
import { actionOutcome, type ActionOutcome } from './action-result';

export const DIAGNOSIS_LIMITS = {
  /** Characters of pasted text that the rules read. */
  inputChars: 20000,
  /** Characters of pasted text included in the "ask the assistant" prompt (keeps it inside the 4000-character message box). */
  askExcerptChars: 3000,
  /** Longest extracted path, command or URL. */
  fragmentChars: 500,
  summaryChars: 240,
} as const;

export type DiagnosisCategory =
  | 'missing-file' | 'permission' | 'port-in-use' | 'missing-module' | 'missing-program'
  | 'python' | 'windows-code' | 'http' | 'stack-trace' | 'unknown';

export type ProposedActionKind = 'open-path' | 'open-app' | 'open-url' | 'copy-command';

export type ProposedAction = {
  /** Stable within one result: `${ruleId}:${index}`. */
  id: string;
  kind: ProposedActionKind;
  label: string;
  /** One sentence on what the action does and what it does not do. */
  detail: string;
  /** 'backend': previewAction(request) then executeAction(id, approved). 'local': the exact text is shown and copied only after confirmation. */
  preview: 'backend' | 'local';
  /** Every proposed action needs an explicit confirmation before anything happens. */
  requiresConfirmation: true;
  /** Present for backend actions: exactly what previewAction receives. */
  request?: ActionRequest;
  /** Present for copy-command: the exact text copied. Single line, never run by this app. */
  command?: string;
};

export type Diagnosis = {
  matched: boolean;
  ruleId: string;
  category: DiagnosisCategory;
  title: string;
  summary: string;
  likelyCauses: string[];
  proposedActions: ProposedAction[];
  /** Honest side notes, for example that a link action was withheld because offline mode is on. */
  notes: string[];
  /** A prompt the user may put in the message box and send deliberately. Null when there is no text. */
  askPrompt: string | null;
};

export type DiagnoseOptions = { online: boolean };

/* ---------- small, safe extractors ---------- */

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const cleanInput = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
const oneLine = (s: string, n: number = DIAGNOSIS_LIMITS.summaryChars) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** A local Windows drive path (C:\… or C:/…), or null. UNC/network paths, relative paths and odd characters are refused. */
export function normalizeLocalPath(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let p = raw.trim();
  if (/^file:\/\/\//i.test(p)) {
    try { p = decodeURIComponent(p.replace(/^file:\/\/\//i, '')); } catch { return null; }
  }
  p = p.replace(/\\\\/g, '\\');
  if (!p || p.length > DIAGNOSIS_LIMITS.fragmentChars || CONTROL.test(p) || /["<>|?*]/.test(p.slice(2))) return null;
  if (!/^[A-Za-z]:[\\/]/.test(p)) return null;
  return p.replace(/\//g, '\\');
}

/** Containing folder of a local path; a drive root keeps its trailing backslash. */
export function parentFolder(path: string): string | null {
  const s = path.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 2) return null;
  const d = s.slice(0, i);
  return /^[A-Za-z]:$/.test(d) ? `${d}\\` : d;
}

const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

/** Safe http(s) URL without credentials, or null. */
function safeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.replace(/[),.;'"\]]+$/, ''));
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    return u.href.length <= DIAGNOSIS_LIMITS.fragmentChars ? u.href : null;
  } catch { return null; }
}

/** The path a Node fs error names: "…, open 'C:\x'" first, then util.inspect's "path: 'C:\\x'". */
function nodeErrorPath(text: string, code: string): string | null {
  const quoted = new RegExp(`${code}[^'\\n]*?'([^'\\n]{1,500})'`).exec(text);
  const fromQuoted = normalizeLocalPath(quoted?.[1]);
  if (fromQuoted) return fromQuoted;
  const inspected = /\bpath:\s*'([^'\n]{1,500})'/.exec(text);
  return normalizeLocalPath(inspected?.[1]);
}

/* ---------- action builders ---------- */

type Draft = Omit<ProposedAction, 'id' | 'requiresConfirmation'>;

const openFolder = (folder: string, why: string): Draft => ({
  kind: 'open-path', preview: 'backend', label: `Open folder ${folder}`,
  detail: `${why} Opens the folder in Explorer after you preview and approve it; the folder must be inside your allowed folders (Settings), and the preview says so if it is not.`,
  request: { type: 'launch', target: folder },
});
const openApp = (exe: string, name: string, why: string): Draft => ({
  kind: 'open-app', preview: 'backend', label: `Open ${name}`,
  detail: `${why} Starts ${exe} after you preview and approve it; it must be in your approved apps list (Settings), and the preview says so if it is not.`,
  request: { type: 'launch', target: exe },
});
const openUrl = (url: string, why: string): Draft => ({
  kind: 'open-url', preview: 'backend', label: `Open ${oneLine(url, 80)}`,
  detail: `${why} Opens the address in your default browser after you preview and approve it. Offered only because online mode is on.`,
  request: { type: 'open-url', target: url },
});
const copyCommand = (command: string, why: string): Draft => ({
  kind: 'copy-command', preview: 'local', label: `Copy command: ${oneLine(command, 80)}`,
  detail: `${why} Copies the text to the clipboard after you confirm. This app never runs it; read it before you run it yourself.`,
  command,
});

const safeCommand = (c: string) => c.length > 0 && c.length <= DIAGNOSIS_LIMITS.fragmentChars && !/[\r\n]/.test(c) && !CONTROL.test(c);

type RuleResult = { ruleId: string; category: DiagnosisCategory; title: string; summary: string; likelyCauses: string[]; actions: Draft[] };
type Rule = { id: string; match(text: string): RuleResult | null };

/* ---------- Windows error codes ---------- */

const HRESULTS: Record<string, { title: string; summary: string; causes: string[] }> = {
  '80070005': { title: 'Access denied (0x80070005)', summary: 'Windows refused access: the account or process does not have permission for the file, folder, registry key or service involved.', causes: ['The file or folder is protected or owned by another account.', 'The operation needs administrator rights.', 'Security software or a lock held by another program blocked the access.'] },
  '80070002': { title: 'File not found (0x80070002)', summary: 'Windows could not find a file the operation needed.', causes: ['The file was moved, renamed or deleted.', 'A setup or update left an incomplete copy.', 'The path in the configuration points at the wrong place.'] },
  '80070003': { title: 'Path not found (0x80070003)', summary: 'Windows could not find a folder in the path.', causes: ['A folder in the path does not exist.', 'A drive letter or network location is not available.', 'The path contains a typo.'] },
  '80070020': { title: 'File in use (0x80070020)', summary: 'Another process has the file open, so Windows refused to change it.', causes: ['An editor, antivirus scan or indexer holds the file open.', 'A previous run of the same program is still active.'] },
  '80070057': { title: 'Invalid parameter (0x80070057)', summary: 'A program passed a value Windows did not accept.', causes: ['A setting or argument has an invalid value.', 'A damaged configuration or profile file.'] },
  '8007000e': { title: 'Out of memory (0x8007000E)', summary: 'Windows could not allocate enough memory for the operation.', causes: ['Too many programs or a very large file are using memory.', 'A program is leaking memory.'] },
  '80070070': { title: 'Disk full (0x80070070)', summary: 'There is not enough free space on the disk for the operation.', causes: ['The target drive is full.', 'Temporary or update files are taking up the space.'] },
  '800704c7': { title: 'Operation cancelled (0x800704C7)', summary: 'The operation was cancelled before it finished, by a user, a program or Windows.', causes: ['Someone cancelled a dialog or prompt.', 'A background service stopped the operation.'] },
  '80070422': { title: 'Service disabled (0x80070422)', summary: 'A Windows service the operation needs is disabled.', causes: ['The service was turned off in Services.', 'A tuning tool or policy disabled it.'] },
  '80070643': { title: 'Installation failed (0x80070643)', summary: 'An installer reported a fatal error during installation.', causes: ['A previous version is partly installed.', 'A required component (for example .NET) is missing or damaged.'] },
};

const hresultRule: Rule = {
  id: 'windows-code',
  match(text) {
    const m = /\b0x(8007[0-9a-f]{4}|800f[0-9a-f]{4}|8024[0-9a-f]{4}|c00d[0-9a-f]{4})\b/i.exec(text);
    if (!m) return null;
    const hex = m[1].toLowerCase();
    const code = `0x${hex.toUpperCase()}`;
    const known = HRESULTS[hex];
    const actions: Draft[] = [copyCommand(`certutil -error ${code}`, 'Windows prints the official name and message for this code.')];
    if (hex.startsWith('8007')) {
      const win32 = parseInt(hex.slice(4), 16);
      actions.push(copyCommand(`net helpmsg ${win32}`, `The low part of the code is Windows error ${win32}; this prints its message.`));
    }
    const path = normalizeLocalPath(/([A-Za-z]:[\\/][^\s"'<>|?*]{1,400})/.exec(text)?.[1]);
    const folder = path ? parentFolder(path) : null;
    if (folder && (hex === '80070005' || hex === '80070002' || hex === '80070003' || hex === '80070020')) actions.push(openFolder(folder, `The error text mentions ${baseName(path!)}.`));
    actions.push(openApp('eventvwr.exe', 'Event Viewer', 'Windows logs often record which component reported the code.'));
    return {
      ruleId: known ? `windows-${hex}` : 'windows-code',
      category: 'windows-code',
      title: known?.title ?? `Windows error code ${code}`,
      summary: known?.summary ?? `Windows reported ${code}. The rules do not have a description for this code; the commands below print the official message.`,
      likelyCauses: known?.causes ?? ['The component named next to the code failed; its log usually says why.'],
      actions,
    };
  },
};

/* ---------- Node / npm ---------- */

const eaddrinuseRule: Rule = {
  id: 'node-eaddrinuse',
  match(text) {
    if (!/\bEADDRINUSE\b/.test(text)) return null;
    const port = /EADDRINUSE[^\n]*?:(\d{2,5})\b/.exec(text)?.[1] ?? /\bport:?\s*(\d{2,5})\b/i.exec(text)?.[1];
    const p = port && Number(port) > 0 && Number(port) < 65536 ? port : null;
    const actions: Draft[] = [];
    if (p) {
      actions.push(copyCommand(`netstat -ano | findstr :${p}`, `Lists connections on port ${p} with the process id (PID) that owns them.`));
      actions.push(copyCommand(`Get-NetTCPConnection -LocalPort ${p} | Select-Object LocalPort,State,OwningProcess`, 'The same check in PowerShell.'));
    }
    actions.push(openApp('resmon.exe', 'Resource Monitor', 'Its Network tab lists listening ports and the processes that hold them.'));
    return {
      ruleId: 'node-eaddrinuse', category: 'port-in-use',
      title: p ? `Port ${p} is already in use` : 'Port already in use',
      summary: `The program tried to listen on ${p ? `port ${p}` : 'a network port'} that another process is already using.`,
      likelyCauses: ['An earlier run of the same server is still running (for example in another terminal).', 'A different program uses the same port.', 'The port is set in an environment variable or config file that two programs share.'],
      actions,
    };
  },
};

const moduleRule: Rule = {
  id: 'node-module-not-found',
  match(text) {
    const m = /Cannot find (?:module|package) '([^'\n]{1,300})'/.exec(text);
    if (!m && !/\b(?:ERR_)?MODULE_NOT_FOUND\b/.test(text)) return null;
    const spec = m?.[1] ?? '';
    const local = /^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/|file:)/.test(spec);
    const builtin = spec.startsWith('node:');
    const pkg = !local && !builtin ? (/^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)/i.exec(spec)?.[1] ?? null) : null;
    const requirer = normalizeLocalPath(/Require stack:\s*\n\s*-\s*([^\n]+)/.exec(text)?.[1]) ?? normalizeLocalPath(/imported from\s+([^\n]+?)\s*$/m.exec(text)?.[1]);
    const actions: Draft[] = [];
    if (pkg) {
      actions.push(copyCommand(`npm ls ${pkg}`, `Shows whether ${pkg} is installed in this project and which version.`));
      actions.push(copyCommand(`npm install ${pkg}`, `Installs ${pkg} into the current project; run it in the project folder.`));
    }
    const folder = requirer ? parentFolder(requirer) : null;
    if (folder) actions.push(openFolder(folder, `The module was required from ${baseName(requirer!)}.`));
    return {
      ruleId: 'node-module-not-found', category: 'missing-module',
      title: spec ? `Node.js cannot find '${oneLine(spec, 80)}'` : 'Node.js module not found',
      summary: local ? `A local file required by the program does not exist at '${oneLine(spec, 120)}'.` : builtin ? `The built-in module '${spec}' is not available in this Node.js version.` : `The package ${pkg ? `'${pkg}'` : ''} is not installed where Node.js looks for it.`.replace(/  +/g, ' '),
      likelyCauses: local
        ? ['The path is misspelled or has the wrong case or extension.', 'A build step that creates the file has not run.', 'The program was started from a different folder than expected.']
        : builtin
          ? ['Node.js is older than the program expects.']
          : ['Dependencies were not installed (npm install was not run, or failed).', 'The command ran outside the project folder.', 'The package is missing from package.json or was removed.'],
      actions,
    };
  },
};

const eaccesRule: Rule = {
  id: 'node-eacces',
  match(text) {
    const code = /\b(EACCES|EPERM)\b/.exec(text)?.[1];
    if (!code) return null;
    const path = nodeErrorPath(text, code);
    const npm = /\bnpm (?:ERR!|error)/.test(text);
    const actions: Draft[] = [];
    const folder = path ? parentFolder(path) : null;
    if (folder) actions.push(openFolder(folder, `It contains ${baseName(path!)}, the item access was refused for.`));
    if (path) actions.push(copyCommand(`icacls "${path}"`, 'Prints who may read and write this item.'));
    if (npm) actions.push(copyCommand('npm config get prefix', 'Shows the folder npm installs global packages into; it must be writable by your account.'));
    return {
      ruleId: 'node-eacces', category: 'permission',
      title: code === 'EPERM' ? 'Operation not permitted (EPERM)' : 'Permission denied (EACCES)',
      summary: `The program was not allowed to ${code === 'EPERM' ? 'change' : 'access'} ${path ? `'${oneLine(path, 160)}'` : 'a file or folder'}.`,
      likelyCauses: ['The item belongs to another account or needs administrator rights.', 'Another program (editor, antivirus, indexer) holds the file open or locked.', npm ? 'npm is installing global packages into a protected folder.' : 'The file is read-only.'],
      actions,
    };
  },
};

const enoentRule: Rule = {
  id: 'node-enoent',
  match(text) {
    if (!/\bENOENT\b/.test(text)) return null;
    const spawn = /\bspawn\s+([\w.-]{1,64})\s+ENOENT\b/.exec(text)?.[1] ?? /syscall:\s*'spawn ([\w.-]{1,64})'/.exec(text)?.[1];
    if (spawn) {
      return {
        ruleId: 'node-spawn-enoent', category: 'missing-program',
        title: `Program '${spawn}' not found`,
        summary: `The program tried to start '${spawn}', but Windows could not find it.`,
        likelyCauses: [`${spawn} is not installed.`, `${spawn} is installed but its folder is not on PATH for this terminal.`, 'The terminal was opened before the installation; a new terminal picks up the new PATH.'],
        actions: [copyCommand(`where ${spawn}`, `Shows whether Windows can find ${spawn} on PATH, and where.`)],
      };
    }
    const path = nodeErrorPath(text, 'ENOENT');
    const pkgJson = path ? /(^|\\)package\.json$/i.test(path) : false;
    const folder = path ? parentFolder(path) : null;
    const actions: Draft[] = [];
    if (folder) {
      actions.push(openFolder(folder, `It is where ${baseName(path!)} was expected.`));
      actions.push(copyCommand(`dir "${folder}"`, 'Lists what is actually in that folder.'));
    }
    return {
      ruleId: 'node-enoent', category: 'missing-file',
      title: path ? `File not found: ${baseName(path)}` : 'File or folder not found (ENOENT)',
      summary: path ? `The program expected '${oneLine(path, 160)}' to exist, but it does not.` : 'The program expected a file or folder that does not exist.',
      likelyCauses: pkgJson
        ? ['npm ran outside the project folder (no package.json there).', 'The project was not cloned or extracted completely.']
        : ['The path is misspelled or relative to a different working folder.', 'A previous step that creates the file did not run or failed.', 'The file was moved, renamed or deleted.'],
      actions,
    };
  },
};

/* ---------- Python ---------- */

const pythonRule: Rule = {
  id: 'python-traceback',
  match(text) {
    const hasTb = /Traceback \(most recent call last\):/.test(text);
    const excs = [...text.matchAll(/^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning))(?::[ \t]*(.*))?$/gm)];
    if (!hasTb && !/^(ModuleNotFoundError|ImportError): No module named/m.test(text)) return null;
    const last = excs[excs.length - 1];
    const exc = last?.[1] ?? 'an exception';
    const msg = (last?.[2] ?? '').trim();
    const frames = [...text.matchAll(/File "([^"\n]{1,500})", line (\d+)(?:, in ([^\n]+))?/g)];
    const appFrames = frames.filter((f) => !/[\\/](site-packages|dist-packages|lib[\\/]python\d|Lib)[\\/]/i.test(f[1]));
    const frame = appFrames[appFrames.length - 1] ?? frames[frames.length - 1];
    const framePath = normalizeLocalPath(frame?.[1]);
    const where = frame ? ` (last frame: ${baseName(frame[1])}, line ${frame[2]})` : '';
    const actions: Draft[] = [];
    const frameFolder = framePath ? parentFolder(framePath) : null;
    const withFrame = () => { if (frameFolder) actions.push(openFolder(frameFolder, `It contains ${baseName(framePath!)}, where the error was raised. The script itself is not opened, because opening it could run it.`)); };

    const mod = /No module named '([A-Za-z_][\w]*)(?:\.[\w.]*)?'/.exec(text)?.[1];
    if ((exc === 'ModuleNotFoundError' || exc === 'ImportError') && mod) {
      actions.push(copyCommand(`python -m pip show ${mod}`, `Shows whether ${mod} is installed for this Python.`));
      actions.push(copyCommand(`python -m pip install ${mod}`, `Installs ${mod} for this Python. The package name on PyPI can differ from the import name; check before running.`));
      withFrame();
      return {
        ruleId: 'python-module-not-found', category: 'missing-module', title: `Python module '${mod}' not found`,
        summary: `Python could not import '${mod}'${where}.`,
        likelyCauses: ['The package is not installed for the Python that ran the script.', 'A virtual environment exists but is not activated.', 'The import name differs from the package name (for example cv2 comes from opencv-python).'],
        actions,
      };
    }
    const filePath = normalizeLocalPath(/(?:No such file or directory|Permission denied): '([^'\n]{1,500})'/.exec(msg)?.[1]);
    if (exc === 'FileNotFoundError' || exc === 'PermissionError') {
      const folder = filePath ? parentFolder(filePath) : null;
      if (folder) actions.push(openFolder(folder, `It is where ${baseName(filePath!)} was expected.`));
      if (filePath && exc === 'PermissionError') actions.push(copyCommand(`icacls "${filePath}"`, 'Prints who may read and write this item.'));
      withFrame();
      return {
        ruleId: exc === 'FileNotFoundError' ? 'python-file-not-found' : 'python-permission', category: exc === 'FileNotFoundError' ? 'missing-file' : 'permission',
        title: exc === 'FileNotFoundError' ? 'Python: file not found' : 'Python: permission denied',
        summary: `${exc}: ${oneLine(msg || 'no message', 160)}${where}.`,
        likelyCauses: exc === 'FileNotFoundError'
          ? ['The path is relative and the script ran from a different folder.', 'The file was not created by an earlier step.', 'A typo in the file name or extension.']
          : ['The file is open in another program or read-only.', 'The folder needs administrator rights.', 'The path points at a folder where a file was expected.'],
        actions,
      };
    }
    withFrame();
    return {
      ruleId: 'python-traceback', category: 'python', title: `Python ${exc}`,
      summary: `Python stopped with ${exc}${msg ? `: ${oneLine(msg, 160)}` : ''}${where}.`,
      likelyCauses: ['The last frame of the traceback is where the error surfaced; the cause is often a value passed in from an earlier frame.', 'Input data or configuration differs from what the code expects.'],
      actions,
    };
  },
};

/* ---------- HTTP ---------- */

const HTTP_TEXT: Record<number, { title: string; causes: string[] }> = {
  400: { title: 'Bad Request', causes: ['The request body or parameters are malformed or missing a required field.'] },
  401: { title: 'Unauthorized', causes: ['The credentials or token are missing, wrong or expired.'] },
  403: { title: 'Forbidden', causes: ['The account is known but not allowed to use this resource.', 'An IP, region or plan restriction applies.'] },
  404: { title: 'Not Found', causes: ['The address or resource id is wrong or no longer exists.', 'A wrong base URL or API version.'] },
  405: { title: 'Method Not Allowed', causes: ['The request used the wrong method (for example GET instead of POST).'] },
  408: { title: 'Request Timeout', causes: ['The request took too long to send; a slow or interrupted connection.'] },
  409: { title: 'Conflict', causes: ['The resource changed or already exists; retrying the same change conflicts.'] },
  413: { title: 'Payload Too Large', causes: ['The upload or request body exceeds the server limit.'] },
  415: { title: 'Unsupported Media Type', causes: ['The Content-Type header does not match what the server accepts.'] },
  422: { title: 'Unprocessable Content', causes: ['The request is well formed but a field value is invalid.'] },
  429: { title: 'Too Many Requests', causes: ['A rate limit was reached; wait before retrying.'] },
  500: { title: 'Internal Server Error', causes: ['The server failed while handling the request; the problem is on the server side.'] },
  501: { title: 'Not Implemented', causes: ['The server does not support this operation.'] },
  502: { title: 'Bad Gateway', causes: ['A proxy or gateway got an invalid answer from the server behind it.'] },
  503: { title: 'Service Unavailable', causes: ['The service is down, overloaded or under maintenance.'] },
  504: { title: 'Gateway Timeout', causes: ['A proxy or gateway did not get an answer from the server in time.'] },
};

const httpRule: Rule = {
  id: 'http-status',
  match(text) {
    const m = /\bHTTP\/(?:1\.[01]|2(?:\.0)?|3)\s+([1-5]\d\d)\b/i.exec(text)
      ?? /\b(?:Request failed with status code|returned HTTP|HTTP error|HTTPError:?|status(?:\s+code)?|statusCode|response code)\s*[:=]?\s*([1-5]\d\d)\b/i.exec(text)
      ?? /\b([45]\d\d)\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Method Not Allowed|Request Timeout|Conflict|Payload Too Large|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/.exec(text);
    if (!m) return null;
    const status = Number(m[1]);
    const known = HTTP_TEXT[status];
    const url = safeUrl(/\bhttps?:\/\/[^\s"'<>]+/i.exec(text)?.[0]);
    const actions: Draft[] = [];
    if (url) {
      actions.push(openUrl(url, 'Shows what the server returns for this address in a browser.'));
      actions.push(copyCommand(`curl -I "${url}"`, 'Prints only the response status and headers for this address.'));
    }
    const kind = status >= 500 ? 'server' : status >= 400 ? 'client' : status >= 300 ? 'redirect' : 'success';
    return {
      ruleId: 'http-status', category: 'http',
      title: `HTTP ${status}${known ? ` ${known.title}` : ''}`,
      summary: kind === 'server' ? `The server answered ${status}: it failed or is unavailable; the request may be fine.`
        : kind === 'client' ? `The server answered ${status}: it refused the request as sent.`
          : kind === 'redirect' ? `The server answered ${status}: a redirect. Follow the Location header; the client may not follow redirects.`
            : `The server answered ${status}, which is a success status; the problem is elsewhere in the output.`,
      likelyCauses: known?.causes ?? [kind === 'server' ? 'A server-side problem; check the service status.' : 'Check the request method, address, headers and body.'],
      actions,
    };
  },
};

/* ---------- generic stack traces ---------- */

const stackRule: Rule = {
  id: 'stack-trace',
  match(text) {
    const js = [...text.matchAll(/^\s*at\s+(.+)$/gm)];
    const cs = /^\s*at\s+.+\s+in\s+(.+):line\s+(\d+)/m.exec(text);
    if (js.length === 0 && !cs) return null;
    const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l && !/^at\s/.test(l)) ?? 'Error';
    let location: string | null = null;
    for (const f of js) {
      const loc = /\(?((?:file:\/\/\/)?[A-Za-z]:[\\/][^()]*?):(\d+)(?::\d+)?\)?\s*$/.exec(f[1]);
      if (!loc || /node_modules|[\\/]internal[\\/]/.test(loc[1])) continue;
      location = normalizeLocalPath(loc[1]);
      if (location) break;
    }
    if (!location && cs) location = normalizeLocalPath(cs[1]);
    const folder = location ? parentFolder(location) : null;
    return {
      ruleId: 'stack-trace', category: 'stack-trace',
      title: 'Stack trace',
      summary: `${oneLine(firstLine, 200)}${location ? ` (first app frame: ${baseName(location)})` : ''}`,
      likelyCauses: ['The first line is the error; the top frames show where it surfaced in your code.', 'Frames inside node_modules or the runtime usually point at how your code called them, not at a bug there.'],
      actions: folder ? [openFolder(folder, `It contains ${baseName(location!)}, the first frame from your code. The file itself is not opened, because opening a script could run it.`)] : [],
    };
  },
};

/** Rules in priority order: the most specific signal wins. */
export const DIAGNOSIS_RULES: readonly Rule[] = [pythonRule, moduleRule, eaddrinuseRule, eaccesRule, enoentRule, hresultRule, httpRule, stackRule];
export const RULE_IDS = DIAGNOSIS_RULES.map((r) => r.id);

/** Prompt the user can put in the message box and send deliberately. Deterministic for the same text. */
export function buildAskPrompt(text: string, matchedTitle?: string): string | null {
  const body = cleanInput(text).trim();
  if (!body) return null;
  const excerpt = body.length > DIAGNOSIS_LIMITS.askExcerptChars ? `${body.slice(0, DIAGNOSIS_LIMITS.askExcerptChars).trimEnd()}\n[… cut at ${DIAGNOSIS_LIMITS.askExcerptChars} characters]` : body;
  const context = matchedTitle ? `The app's local rules read it as: ${matchedTitle}.` : "The app's local rules did not recognise it.";
  return [
    `Task: The text below is error output. ${context} Say what it most likely means, the two or three most likely causes, and what to check first. Do not guess at files, commands or settings that are not mentioned; if you cannot tell, say what information would help.`,
    `Error output (${excerpt.length} characters):\n"""\n${excerpt}\n"""`,
  ].join('\n\n');
}

/** Parses pasted error text into a diagnosis. Pure and deterministic; calls nothing. */
export function diagnoseError(raw: string, opts: DiagnoseOptions): Diagnosis {
  const text = cleanInput(String(raw ?? '')).slice(0, DIAGNOSIS_LIMITS.inputChars);
  if (!text.trim()) {
    return { matched: false, ruleId: 'empty', category: 'unknown', title: 'Nothing to diagnose', summary: 'Paste the error output first.', likelyCauses: [], proposedActions: [], notes: [], askPrompt: null };
  }
  for (const rule of DIAGNOSIS_RULES) {
    const r = rule.match(text);
    if (!r) continue;
    const notes: string[] = [];
    const kept = r.actions.filter((a) => {
      if (a.kind === 'open-url' && !opts.online) { notes.push('A link to the address was not offered because offline mode is on. Switch to online mode in Settings to open links from here.'); return false; }
      if (a.kind === 'copy-command') return safeCommand(a.command ?? '');
      return Boolean(a.request?.target);
    });
    return {
      matched: true, ruleId: r.ruleId, category: r.category, title: r.title, summary: oneLine(r.summary, 400), likelyCauses: r.likelyCauses,
      proposedActions: kept.map((a, i) => ({ ...a, id: `${r.ruleId}:${i}`, requiresConfirmation: true as const })),
      notes, askPrompt: buildAskPrompt(text, r.title),
    };
  }
  return {
    matched: false, ruleId: 'no-match', category: 'unknown', title: 'No rule matched',
    summary: 'None of the local rules recognised this text, so no causes or actions are suggested. You can ask the assistant instead; the prompt is shown before anything is sent.',
    likelyCauses: [], proposedActions: [], notes: [], askPrompt: buildAskPrompt(text),
  };
}

/* ---------- preview -> confirm -> execute ---------- */

export type DiagnosisPreview =
  | { via: 'backend'; actionId: string; preview: ActionPreview }
  | { via: 'local'; actionId: string; summary: string; text: string; allowed: true }
  | { via: 'refused'; actionId: string; reason: string };

/** First step for any proposed action. Backend actions are only previewed (nothing runs); copy actions show their exact text. */
export async function previewProposedAction(api: { previewAction(a: ActionRequest): Promise<ActionPreview> }, action: ProposedAction, opts: DiagnoseOptions): Promise<DiagnosisPreview> {
  if (action.preview === 'local') {
    const text = action.command ?? '';
    if (action.kind !== 'copy-command' || !safeCommand(text)) return { via: 'refused', actionId: action.id, reason: 'This copy action has no valid text.' };
    return { via: 'local', actionId: action.id, summary: 'Copy this text to the clipboard. Nothing is run.', text, allowed: true };
  }
  if (!action.request) return { via: 'refused', actionId: action.id, reason: 'This action has no request to preview.' };
  if (action.kind === 'open-url' && !opts.online) return { via: 'refused', actionId: action.id, reason: 'Links are only opened from here in online mode. Nothing was previewed.' };
  return { via: 'backend', actionId: action.id, preview: await api.previewAction(action.request) };
}

/**
 * Second step, only after a preview. Backend: executeAction with the user's decision (the backend shows its own Windows
 * confirmation and re-checks policy). Local copy: writes to the clipboard only when approved.
 */
export async function decideProposedAction(
  api: { executeAction(id: string, approved: boolean): Promise<unknown> },
  preview: DiagnosisPreview,
  approved: boolean,
  clipboard: { writeText(text: string): Promise<void> } | null,
): Promise<ActionOutcome> {
  if (preview.via === 'refused') return { kind: 'not-run', message: preview.reason };
  if (preview.via === 'local') {
    if (!approved) return { kind: 'rejected', message: 'Not copied.' };
    if (!clipboard) return { kind: 'not-run', message: 'The clipboard is not available here. Select the text and copy it manually.' };
    try { await clipboard.writeText(preview.text); return { kind: 'ran', message: 'Copied to the clipboard. Nothing was run.' }; }
    catch { return { kind: 'not-run', message: 'Copying was blocked. Select the text and copy it manually.' }; }
  }
  if (approved && !preview.preview.allowed) return { kind: 'not-run', message: preview.preview.reason ?? 'The backend blocked this action.' };
  return actionOutcome(await api.executeAction(preview.preview.id, approved), approved);
}
