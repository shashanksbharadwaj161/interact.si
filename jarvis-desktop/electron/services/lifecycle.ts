// Crash recovery marker. A `.running` file exists while the app runs and is removed on clean quit.
// Two consecutive unclean starts enter safe launch (no actions, no tray hotkey/auto features).
import * as nodeFs from 'node:fs';
import {promises as fsp} from 'node:fs';
import * as path from 'node:path';

export interface LaunchFs {
  read(p: string): Promise<string | null>;
  write(p: string, data: string): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
}

export const nodeLaunchFs: LaunchFs = {
  read: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  write: async (p, d) => { await fsp.mkdir(path.dirname(p), {recursive: true}); await fsp.writeFile(p, d, 'utf8'); },
  remove: async (p) => { await fsp.rm(p, {force: true}); },
  exists: async (p) => { try { await fsp.access(p); return true; } catch { return false; } },
};

export class LaunchGuard {
  private running: string;
  private counter: string;
  safe = false;
  uncleanStarts = 0;

  constructor(dir: string, private fs: LaunchFs = nodeLaunchFs) {
    this.running = path.join(dir, '.running');
    this.counter = path.join(dir, '.unclean');
  }

  /** Set when the marker files could not be written (read-only or full profile); crash tracking is then off for this run. */
  trackingError: string | null = null;

  async begin(): Promise<{safe: boolean; uncleanStarts: number}> {
    // A garbage or negative counter must not push the app into safe launch or crash boot.
    const raw = Number((await this.fs.read(this.counter)) ?? '0');
    const prev = Number.isInteger(raw) && raw > 0 && raw < 1000 ? raw : 0;
    const wasRunning = await this.fs.exists(this.running);
    this.uncleanStarts = wasRunning ? prev + 1 : 0;
    this.safe = this.uncleanStarts >= 2;
    try {
      await this.fs.write(this.counter, String(this.uncleanStarts));
      await this.fs.write(this.running, String(Date.now()));
    } catch (e) {
      // The app can still run from a profile it cannot write to (the store reports its own read-only state).
      this.trackingError = String((e as Error).message ?? e).slice(0, 160);
    }
    return {safe: this.safe, uncleanStarts: this.uncleanStarts};
  }

  /** Called on clean quit and when the user chooses to open normally. Never throws: quitting must not be blocked. */
  async end(): Promise<void> {
    try {
      // Counter first: an interruption between the two steps still leaves the marker, i.e. one unclean start, not two.
      await this.fs.write(this.counter, '0');
      await this.fs.remove(this.running);
    } catch (e) {
      this.trackingError = String((e as Error).message ?? e).slice(0, 160);
    }
  }

  /** Synchronous variant for Windows logoff/shutdown, where the process may be killed right after the session-end event. */
  endSync(): void {
    try {
      nodeFs.mkdirSync(path.dirname(this.running), {recursive: true});
      nodeFs.writeFileSync(this.counter, '0', 'utf8');
      nodeFs.rmSync(this.running, {force: true});
    } catch { /* best effort */ }
  }
}

/**
 * Keeps Electron's default user-data folder name stable across the rename to "Desktop Companion": use the legacy "Jarvis Desktop"
 * folder only when it exists and nothing chose a different folder first (tests, --user-data-dir, a smoke script's setPath).
 * Returns the directory to use, or null to leave Electron's current choice alone.
 */
export function resolveUserDataDir(o: {appData: string; current: string; appName: string; legacyName?: string; legacyExists: boolean}): string | null {
  const norm = (p: string) => path.win32.resolve(p).toLowerCase();
  const legacy = path.win32.join(o.appData, o.legacyName ?? 'Jarvis Desktop');
  const defaultDir = path.win32.join(o.appData, o.appName);
  if (norm(o.current) !== norm(defaultDir)) return null;
  if (norm(legacy) === norm(o.current) || !o.legacyExists) return null;
  return legacy;
}

export interface IdleDeps {
  /** Fires once when the window has been hidden for `hiddenMs`; the owner releases caches there. */
  onIdle(): void;
  onActive?(): void;
  hiddenMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** Resource idle behaviour: no polling. One unref'd timer starts when the window hides and is cancelled when it shows or on dispose. */
export class IdleGovernor {
  private timer: unknown = null;
  private idle = false;
  private disposed = false;
  private setTimer: NonNullable<IdleDeps['setTimer']>;
  private clearTimer: NonNullable<IdleDeps['clearTimer']>;

  constructor(private d: IdleDeps) {
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get isIdle(): boolean { return this.idle; }
  get armed(): boolean { return this.timer !== null; }

  hidden(): void {
    if (this.disposed || this.idle || this.timer !== null) return;
    const h = this.setTimer(() => {
      this.timer = null;
      this.idle = true;
      try { this.d.onIdle(); } catch { /* releasing caches is best effort */ }
    }, this.d.hiddenMs ?? 5 * 60_000);
    if (h && typeof h === 'object' && typeof (h as {unref?: () => void}).unref === 'function') (h as {unref: () => void}).unref();
    this.timer = h;
  }

  shown(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    if (this.idle && !this.disposed) {
      this.idle = false;
      try { this.d.onActive?.(); } catch { /* ignore */ }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
  }
}

export interface ProcessMetric { pid: number; type?: string; cpu?: {percentCPUUsage?: number}; memory?: {workingSetSize?: number; privateBytes?: number} }

/** Summarises Electron's app metrics (workingSetSize is in KB) for idle-footprint evidence (acceptance M5). Pure. */
export function summarizeMetrics(metrics: readonly ProcessMetric[]): {processes: number; workingSetMb: number; cpuPercent: number} {
  let kb = 0, cpu = 0;
  for (const m of metrics) { kb += m.memory?.workingSetSize ?? 0; cpu += m.cpu?.percentCPUUsage ?? 0; }
  return {processes: metrics.length, workingSetMb: Math.round(kb / 1024), cpuPercent: Math.round(cpu * 100) / 100};
}
