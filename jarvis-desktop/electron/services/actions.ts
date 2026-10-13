// previewAction / executeAction. Previews never execute. Execution needs a live, single-use, approved preview,
// re-evaluates policy, and for window-scoped actions re-verifies the exact window and process that were approved.
import * as nodePath from 'node:path';
import type {ActionPreview, ActionRequest, Settings} from '../../src/shared/contracts';
import type {NativeAdapter, WindowInfo} from '../native/adapter';
import {FsLike, normalizeAbsolutePath, realFs} from './paths';
import {Authorization, LaunchPlan, authorizeTarget, checkWindowPolicy, selectWindow, validateActionRequest} from './policy';

const w = nodePath.win32;

export const PREVIEW_TTL_MS = 60_000;
export const MAX_ACTIONS_PER_MINUTE = 30;
const MAX_PREVIEWS = 100;

export interface ShellAdapter {
  openExternal(url: string): Promise<void>;
  /** Returns '' on success or an error message, like Electron's shell.openPath. */
  openPath(p: string): Promise<string>;
  spawnApp(exePath: string): Promise<void>;
}

export interface ActionDeps {
  settings: () => Settings;
  activity: (kind: string, summary: string, details?: string) => Promise<unknown>;
  native: NativeAdapter;
  shell: ShellAdapter;
  fs?: FsLike;
  selfPids: () => number[];
  safeLaunch: () => boolean;
  now?: () => number;
  newId: () => string;
  resolveExecutable?: (entry: string) => Promise<string | null>;
  confirm?: (summary: string, detail: string) => Promise<boolean>;
}

type WindowTarget = {hwnd: number; pid: number; process: string; title: string};
type Plan =
  | Exclude<LaunchPlan, {kind: 'launch-app'}>
  | {kind: 'launch-app'; entry: string; exe: string}
  | {kind: 'list-windows'}
  | {kind: 'focus'; win: WindowTarget}
  | {kind: 'move-window'; win: WindowTarget; x: number; y: number; width: number; height: number}
  | {kind: 'type-text'; win: WindowTarget; text: string}
  | {kind: 'click'; win: WindowTarget; x: number; y: number};

interface Evaluation { allowed: boolean; reason?: string; summary: string; requiresApproval: boolean; plan?: Plan }
interface Entry { req: ActionRequest; ev: Evaluation; expiresAt: number }

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const label = (t: WindowTarget) => `"${clip(t.title)}" (${t.process})`;

/** Resolves an approved-app entry to an executable on disk. Never searches the current directory. */
export async function resolveExecutable(entry: string, env: NodeJS.ProcessEnv = process.env, fs: Pick<FsLike, 'stat'> & Partial<Pick<FsLike, 'realpath'>> = realFs): Promise<string | null> {
  const isFile = async (p: string) => { try { return (await fs.stat(p)).isFile(); } catch { return false; } };
  const canonical = async (p: string) => {
    try {
      const resolved = fs.realpath ? await fs.realpath(p) : p;
      const normalized = normalizeAbsolutePath(resolved);
      return 'error' in normalized || !/\.exe$/i.test(normalized.path) ? null : normalized.path;
    } catch { return null; }
  };
  if (!/^[A-Za-z0-9._ -]+\.exe$/i.test(entry)) {
    const n = normalizeAbsolutePath(entry);
    if ('error' in n || !/\.exe$/i.test(n.path)) return null;
    return (await isFile(n.path)) ? canonical(n.path) : null;
  }
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const dirs = [w.join(root, 'System32'), root, env.ProgramFiles ?? '', env['ProgramFiles(x86)'] ?? '']
    .filter((d) => d && w.isAbsolute(d) && !/(^|[\\/])\.\.([\\/]|$)/.test(d));
  for (const d of dirs) {
    const cand = w.join(d, entry);
    if (await isFile(cand)) return canonical(cand);
  }
  return null;
}

export class ActionService {
  private registry = new Map<string, Entry>();
  private executed: number[] = [];
  private fs: FsLike;
  private now: () => number;

  constructor(private d: ActionDeps) {
    this.fs = d.fs ?? realFs;
    this.now = d.now ?? Date.now;
  }

  private prune() {
    const t = this.now();
    for (const [id, e] of this.registry) if (e.expiresAt <= t) this.registry.delete(id);
    while (this.registry.size > MAX_PREVIEWS) this.registry.delete(this.registry.keys().next().value as string);
  }

  /** Builds the decision for a request using live settings and (for window actions) live window data. */
  private async evaluate(req: ActionRequest): Promise<Evaluation> {
    const deny = (summary: string, reason: string, requiresApproval = true): Evaluation => ({allowed: false, reason, summary, requiresApproval});
    if (this.d.safeLaunch()) return deny(`Blocked ${req.type}`, 'Safe launch is active: actions are disabled until Jarvis is restarted normally');
    const s = this.d.settings();
    switch (req.type) {
      case 'list-windows':
        return {allowed: true, summary: 'List visible windows (titles, process names, positions; no contents)', requiresApproval: false, plan: {kind: 'list-windows'}};
      case 'open-url': {
        const a = await authorizeTarget('url', req.target ?? '', s, this.fs);
        if (!a.ok) return deny('Open a link', a.reason);
        if (a.plan.kind !== 'open-url') return deny('Open a link', 'Invalid URL plan');
        const note = s.mode === 'offline' ? ' (opens in your default browser, which uses the network)' : '';
        return {allowed: true, summary: `Open ${clip(a.plan.kind === 'open-url' ? a.plan.url : '', 120)}${note}`, requiresApproval: true, plan: a.plan};
      }
      case 'launch': {
        const a = await authorizeTarget('any', req.target ?? '', s, this.fs);
        if (!a.ok) return deny(`Launch "${clip(req.target ?? '', 80)}"`, a.reason);
        const plan = await this.bindLaunch(a.plan);
        if (!plan) return deny('Start approved app', 'The approved app could not be found on this computer');
        return {allowed: true, summary: plan.kind === 'launch-app' ? `Start approved app ${plan.exe}` : this.launchSummary(a), requiresApproval: true, plan};
      }
      default:
        return this.evaluateWindowAction(req);
    }
  }

  private launchSummary(a: Extract<Authorization, {ok: true}>): string {
    const p = a.plan;
    if (p.kind === 'launch-app') return `Start approved app ${clip(p.entry, 120)}`;
    if (p.kind === 'launch-path') return `Open ${p.isDirectory ? 'folder' : 'file'} ${clip(p.path, 120)} with its default handler`;
    return `Open ${p.url}`;
  }

  private async evaluateWindowAction(req: ActionRequest): Promise<Evaluation> {
    const type = req.type;
    const deny = (summary: string, reason: string): Evaluation => ({allowed: false, reason, summary, requiresApproval: true});
    let windows: WindowInfo[];
    try { windows = await this.d.native.listWindows(); } catch (e) { return deny(`Blocked ${type}`, `Windows could not be enumerated: ${(e as Error).message}`); }
    const sel = selectWindow(req.target, windows, type === 'type-text' || type === 'click');
    if (!sel.ok) return deny(`Blocked ${type}`, sel.reason);
    return this.finishWindowEvaluation(req, sel.window);
  }

  private finishWindowEvaluation(req: ActionRequest, win: WindowInfo): Evaluation {
    const type = req.type;
    const t: WindowTarget = {hwnd: win.hwnd, pid: win.pid, process: win.process, title: win.title};
    const deny = (summary: string, reason: string): Evaluation => ({allowed: false, reason, summary, requiresApproval: true});
    switch (type) {
      case 'focus': {
        const summary = `Bring ${label(t)} to the foreground`;
        const why = checkWindowPolicy(win, type, this.d.selfPids());
        return why ? deny(summary, why) : {allowed: true, summary, requiresApproval: true, plan: {kind: 'focus', win: t}};
      }
      case 'move-window': {
        if (req.x === undefined || req.y === undefined || req.width === undefined || req.height === undefined) return deny(`Move ${label(t)}`, 'x, y, width and height are required');
        const summary = `Move ${label(t)} to ${req.x},${req.y} size ${req.width}×${req.height} (clamped to visible screens)`;
        const why = checkWindowPolicy(win, type, this.d.selfPids());
        return why ? deny(summary, why) : {allowed: true, summary, requiresApproval: true, plan: {kind: 'move-window', win: t, x: req.x, y: req.y, width: req.width, height: req.height}};
      }
      case 'type-text': {
        const text = req.text ?? '';
        const summary = `Type into ${label(t)}: ${clip(text.replace(/\r\n|\r|\n/g, '⏎').replace(/\t/g, '⇥'), 200)}`;
        if (!text) return deny(summary, 'text is required');
        if (/[\r\n]/.test(text) && (/^(cmd|powershell|pwsh|windowsterminal|openconsole|conhost|wt|bash|wsl|mintty)(\.exe)?$/i.test(win.process) || (/^explorer(\.exe)?$/i.test(win.process) && /^run$/i.test(win.title)))) return deny(summary, 'Newline input into command windows is blocked');
        // Preview does not send input. Foreground is enforced after trusted confirmation and exact-target focus.
        const why = checkWindowPolicy({...win, foreground: true}, type, this.d.selfPids());
        return why ? deny(summary, why) : {allowed: true, summary, requiresApproval: true, plan: {kind: 'type-text', win: t, text}};
      }
      case 'click': {
        if (req.x === undefined || req.y === undefined) return deny(`Click in ${label(t)}`, 'x and y screen coordinates are required');
        const summary = `Left-click at ${req.x},${req.y} inside ${label(t)}`;
        const why = checkWindowPolicy({...win, foreground: true}, type, this.d.selfPids());
        if (why) return deny(summary, why);
        if (req.x < win.x || req.x >= win.x + win.width || req.y < win.y || req.y >= win.y + win.height) return deny(summary, 'The point is outside the target window');
        return {allowed: true, summary, requiresApproval: true, plan: {kind: 'click', win: t, x: req.x, y: req.y}};
      }
      default:
        return deny(`Blocked ${type}`, 'Unsupported action');
    }
  }

  async preview(raw: unknown): Promise<ActionPreview> {
    const req = validateActionRequest(raw);
    const ev = await this.evaluate(req);
    this.prune();
    const id = this.d.newId();
    this.registry.set(id, {req, ev, expiresAt: this.now() + PREVIEW_TTL_MS});
    if (!ev.allowed) await this.d.activity('action', `Denied: ${ev.summary}`, ev.reason);
    const p: ActionPreview = {id, summary: ev.summary, requiresApproval: ev.requiresApproval, allowed: ev.allowed};
    if (ev.reason) p.reason = ev.reason;
    return p;
  }

  private rateLimited(): boolean {
    const t = this.now();
    this.executed = this.executed.filter((x) => t - x < 60_000);
    if (this.executed.length >= MAX_ACTIONS_PER_MINUTE) return true;
    this.executed.push(t);
    return false;
  }

  /** Shared limiter for capsule item launches and window moves. */
  claimAction(): boolean { return !this.rateLimited(); }

  private async bindLaunch(plan: LaunchPlan): Promise<Plan | null> {
    if (plan.kind !== 'launch-app') return plan;
    const resolved = await (this.d.resolveExecutable ?? ((e) => resolveExecutable(e)))(plan.entry);
    if (!resolved) return null;
    const normalized = normalizeAbsolutePath(resolved);
    if ('error' in normalized || !/\.exe$/i.test(normalized.path)) return null;
    return {kind: 'launch-app', entry: plan.entry, exe: normalized.path};
  }

  private detail(plan: Plan): string {
    if (plan.kind === 'type-text') return `Window: ${plan.win.title}\nProcess: ${plan.win.process}, PID ${plan.win.pid}\nFull text (line breaks shown as ⏎, tabs as ⇥):\n${plan.text.replace(/\r\n|\r|\n/g, '⏎\n').replace(/\t/g, '⇥')}`;
    return JSON.stringify(plan, null, 2);
  }

  /** Re-checks the live state against what was approved. Returns a denial reason or null. */
  private async revalidate(entry: Entry): Promise<{reason?: string; plan?: Plan}> {
    const plan = entry.ev.plan!;
    if (this.d.safeLaunch()) return {reason: 'Safe launch is active'};
    switch (plan.kind) {
      case 'list-windows': return {plan};
      case 'open-url': case 'launch-app': case 'launch-path': {
        const again = await this.evaluate(entry.req);
        if (!again.allowed || !again.plan) return {reason: `Policy changed since the preview: ${again.reason ?? 'not allowed'}`};
        const a = again.plan, b = plan;
        const same = a.kind === b.kind && JSON.stringify(a) === JSON.stringify(b);
        return same ? {plan: a} : {reason: 'The target changed since the preview'};
      }
      default: {
        let windows: WindowInfo[];
        try { windows = await this.d.native.listWindows(); } catch (e) { return {reason: `Windows could not be enumerated: ${(e as Error).message}`}; }
        const win = windows.find((x) => x.hwnd === plan.win.hwnd);
        if (!win) return {reason: 'The approved window no longer exists (stale preview)'};
        if (win.pid !== plan.win.pid || win.process.toLowerCase() !== plan.win.process.toLowerCase()) return {reason: 'The approved window now belongs to a different process (stale preview)'};
        const req: ActionRequest = {...entry.req, target: `hwnd:${win.hwnd}`};
        const again = this.finishWindowEvaluation(req, win);
        if (!again.allowed) return {reason: again.reason};
        return {plan: again.plan};
      }
    }
  }

  async execute(previewId: unknown, approved: unknown): Promise<unknown> {
    if (typeof previewId !== 'string' || previewId.length > 100) throw new Error('Preview id is invalid');
    if (typeof approved !== 'boolean') throw new Error('approved must be true or false');
    this.prune();
    const entry = this.registry.get(previewId);
    if (!entry) throw new Error('This preview is unknown, expired or was already used. Request a new preview.');
    this.registry.delete(previewId); // single use, even when denied
    const summary = entry.ev.summary;
    if (!approved) {
      await this.d.activity('action', `Declined: ${summary}`);
      return {executed: false, reason: 'Not approved'};
    }
    if (!entry.ev.allowed || !entry.ev.plan) {
      await this.d.activity('action', `Denied: ${summary}`, entry.ev.reason);
      return {executed: false, reason: entry.ev.reason ?? 'Not allowed'};
    }
    if (this.rateLimited()) {
      await this.d.activity('action', `Rate limited: ${summary}`, `More than ${MAX_ACTIONS_PER_MINUTE} actions in one minute`);
      return {executed: false, reason: `Rate limit reached (${MAX_ACTIONS_PER_MINUTE} actions per minute)`};
    }
    if (entry.ev.requiresApproval && !(await this.d.confirm?.(summary, this.detail(entry.ev.plan)))) {
      await this.d.activity('action', `Declined in native confirmation: ${summary}`);
      return {executed: false, reason: 'Native confirmation declined or unavailable'};
    }
    const check = await this.revalidate(entry);
    if (!check.plan) {
      await this.d.activity('action', `Refused: ${summary}`, check.reason);
      return {executed: false, reason: check.reason ?? 'Not allowed'};
    }
    try {
      // The native confirmation takes focus. Restore only the exact approved window,
      // then re-check its identity and foreground state before native input.
      if (check.plan.kind === 'type-text' || check.plan.kind === 'click') {
        const target = check.plan.win;
        const focus = await this.d.native.focusWindow({hwnd: target.hwnd, pid: target.pid});
        if (!focus.focused) throw new Error('Windows did not allow the approved target to take focus');
        const win = (await this.d.native.listWindows()).find((v) => v.hwnd === target.hwnd);
        if (!win || win.pid !== target.pid || win.process.toLowerCase() !== target.process.toLowerCase() || !win.foreground || win.minimized || win.elevated !== 0 || this.d.selfPids().includes(win.pid)) throw new Error('The approved target changed or could not be safely focused');
        if (this.d.safeLaunch()) throw new Error('Safe launch is active');
      }
      const result = await this.perform(check.plan);
      await this.d.activity('action', `Executed: ${summary}`, 'ok');
      return {executed: true, ...result};
    } catch (e) {
      const reason = (e as Error).message.slice(0, 300);
      await this.d.activity('action', `Failed: ${summary}`, reason);
      return {executed: false, reason};
    }
  }

  private async perform(plan: Plan): Promise<Record<string, unknown>> {
    const n = this.d.native;
    switch (plan.kind) {
      case 'list-windows': {
        const ws = await n.listWindows();
        return {windows: ws.map((x) => ({hwnd: x.hwnd, title: x.title, process: x.process, pid: x.pid, x: x.x, y: x.y, width: x.width, height: x.height, minimized: x.minimized, maximized: x.maximized, foreground: x.foreground, protected: x.elevated !== 0}))};
      }
      case 'open-url': await this.d.shell.openExternal(plan.url); return {};
      case 'launch-app': {
        await this.d.shell.spawnApp(plan.exe);
        return {};
      }
      case 'launch-path': {
        const err = await this.d.shell.openPath(plan.path);
        if (err) throw new Error(err);
        return {};
      }
      case 'focus': {
        const r = await n.focusWindow({hwnd: plan.win.hwnd, pid: plan.win.pid});
        if (!r.focused) throw new Error('Windows did not allow the window to take focus');
        return {focused: true};
      }
      case 'move-window': {
        const r = await n.moveWindow({hwnd: plan.win.hwnd, pid: plan.win.pid}, {x: plan.x, y: plan.y, width: plan.width, height: plan.height});
        return {rect: {x: r.x, y: r.y, width: r.width, height: r.height}, clamped: r.clamped};
      }
      case 'type-text': {
        const r = await n.typeText({hwnd: plan.win.hwnd, pid: plan.win.pid}, plan.text);
        return {typed: r.typed};
      }
      case 'click':
        await n.click({hwnd: plan.win.hwnd, pid: plan.win.pid}, plan.x, plan.y);
        return {};
    }
  }

  /** Prepares an exact target for the single trusted capsule confirmation. */
  async prepareItem(kind: 'file' | 'folder' | 'url' | 'app', target: string): Promise<{ok: true; detail: string; run: () => Promise<{ok: true} | {ok: false; reason: string}>} | {ok: false; reason: string}> {
    if (this.d.safeLaunch()) return {ok: false, reason: 'Safe launch is active'};
    const a = await authorizeTarget(kind, target, this.d.settings(), this.fs);
    if (!a.ok) return a;
    const plan = await this.bindLaunch(a.plan);
    if (!plan) return {ok: false, reason: 'The approved app could not be found'};
    return {ok: true, detail: this.detail(plan), run: async () => {
      if (this.d.safeLaunch()) return {ok: false, reason: 'Safe launch is active'};
      const again = await authorizeTarget(kind, target, this.d.settings(), this.fs);
      const fresh = again.ok ? await this.bindLaunch(again.plan) : null;
      if (!fresh || JSON.stringify(fresh) !== JSON.stringify(plan)) return {ok: false, reason: 'Target or permissions changed since confirmation'};
      if (!this.claimAction()) return {ok: false, reason: 'Action rate limit reached'};
      try { await this.perform(plan); return {ok: true}; }
      catch (e) { return {ok: false, reason: (e as Error).message.slice(0, 300)}; }
    }};
  }

  async openItem(kind: 'file' | 'folder' | 'url' | 'app', target: string): Promise<{ok: true} | {ok: false; reason: string}> {
    const item = await this.prepareItem(kind, target);
    if (!item.ok) return item;
    if (!(await this.d.confirm?.('Open capsule item', item.detail))) return {ok: false, reason: 'Native confirmation declined or unavailable'};
    return item.run();
  }

  get pendingPreviews(): number { return this.registry.size; }
}
