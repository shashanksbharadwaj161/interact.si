// Bounded PowerShell runner. execFile only (no shell), JSON on stdin, one JSON line on stdout.
import {execFile, type ChildProcess} from 'node:child_process';
import * as path from 'node:path';
import {promises as fsp} from 'node:fs';
import {toUnpackedPath} from '../services/paths';
import {IntegrityError, SHARED_HELPERS, getNativeIntegrity, verifyFiles, type IntegrityConfig, type ReadFileFn} from './integrity';

export const SCRIPTS = [
  'list-windows', 'focus-window', 'move-window', 'type-text', 'click', 'speak', 'transcribe', 'probe-speech', 'dpapi', 'OcrLocal',
  'uia-inspect', 'uia-act',
] as const;
export type ScriptName = (typeof SCRIPTS)[number];
/** Extra modules a helper dot-sources besides common.ps1; verified together with it before every spawn. */
export const SCRIPT_HELPERS: Partial<Record<ScriptName, readonly string[]>> = {'uia-inspect': ['uia-common.ps1'], 'uia-act': ['uia-common.ps1']};

export interface RunOptions { timeoutMs?: number; maxStdoutBytes?: number; signal?: AbortSignal }

export class NativeError extends Error {
  constructor(message: string, readonly kind: 'timeout' | 'cancelled' | 'output-too-large' | 'exit' | 'bad-output' | 'unavailable' | 'integrity' = 'exit') { super(message); }
}

export type ExecFileFn = typeof execFile;

export interface RunnerOptions {
  /** Directory holding the .ps1 files. asar paths are mapped to app.asar.unpacked. */
  nativeDir: string;
  powershellPath?: string;
  execFileImpl?: ExecFileFn;
  concurrency?: number;
  /** Helper integrity check. Defaults to the manifest main.ts configured; tests pass their own. */
  integrity?: IntegrityConfig;
  /** Test seam for reading helper bytes. */
  readFileImpl?: ReadFileFn;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_STDOUT = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;

/** Helpers whose stdin carries secrets or user text. Their stderr is never surfaced: PowerShell errors can echo input values. */
const SENSITIVE_INPUT: ReadonlySet<ScriptName> = new Set<ScriptName>(['dpapi', 'type-text', 'speak']);

export function defaultPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Builds the exact argv; exported so tests can assert there is no interpolation of user input. */
export function buildArgs(scriptFile: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile];
}

export class NativeRunner {
  private nativeDir: string;
  private ps: string;
  private exec: ExecFileFn;
  private limit: number;
  private integrity?: IntegrityConfig;
  private readFile: ReadFileFn;
  private active = 0;
  private waiting: Array<() => void> = [];
  private children = new Set<ChildProcess>();

  constructor(opts: RunnerOptions) {
    this.nativeDir = toUnpackedPath(opts.nativeDir);
    this.ps = opts.powershellPath ?? defaultPowerShellPath();
    this.exec = opts.execFileImpl ?? execFile;
    this.limit = opts.concurrency ?? 2;
    this.integrity = opts.integrity;
    this.readFile = opts.readFileImpl ?? ((f) => fsp.readFile(f));
  }

  /** Hashes the script and its shared module against the build-time manifest; throws NativeError('integrity') on any mismatch. */
  private async verify(script: ScriptName): Promise<void> {
    const cfg = this.integrity ?? getNativeIntegrity();
    if (!cfg.manifest) {
      if (cfg.required) throw new NativeError('Native helpers are disabled: the integrity manifest is missing', 'integrity');
      return;
    }
    try {
      await verifyFiles(cfg.manifest, [`${script}.ps1`, ...SHARED_HELPERS, ...(SCRIPT_HELPERS[script] ?? [])], (n) => path.win32.join(this.nativeDir, n), this.readFile);
    } catch (e) {
      if (e instanceof IntegrityError) throw new NativeError(e.message, 'integrity');
      throw e;
    }
  }

  get runningChildren(): number { return this.children.size; }

  scriptPath(name: ScriptName): string {
    if (!(SCRIPTS as readonly string[]).includes(name)) throw new NativeError(`Unknown native script "${name}"`, 'unavailable');
    return path.win32.join(this.nativeDir, `${name}.ps1`);
  }

  killAll(): void {
    for (const c of this.children) { try { c.kill(); } catch { /* ignore */ } }
    this.children.clear();
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return; }
    await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }

  async run<T = unknown>(script: ScriptName, input: unknown, opts: RunOptions = {}): Promise<T> {
    const file = this.scriptPath(script);
    const json = JSON.stringify(input ?? {});
    if (Buffer.byteLength(json) > MAX_INPUT_BYTES) throw new NativeError('Native helper input is too large', 'bad-output');
    const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBuffer = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
    if (opts.signal?.aborted) throw new NativeError('Native helper was cancelled', 'cancelled');
    await this.verify(script);
    await this.acquire();
    try {
      // Cancelled while waiting for a free slot: never start the helper.
      if (opts.signal?.aborted) throw new NativeError('Native helper was cancelled', 'cancelled');
      return await new Promise<T>((resolve, reject) => {
        let child: ChildProcess;
        const abort = () => { try { child?.kill(); } catch { /* ignore */ } };
        try {
          child = this.exec(this.ps, buildArgs(file), {timeout, maxBuffer, windowsHide: true, encoding: 'utf8', shell: false, killSignal: 'SIGKILL'}, (err, stdout, stderr) => {
            this.children.delete(child);
            opts.signal?.removeEventListener('abort', abort);
            if (opts.signal?.aborted) return reject(new NativeError('Native helper was cancelled', 'cancelled'));
            if (err) {
              const e = err as NodeJS.ErrnoException & {killed?: boolean; code?: string | number};
              if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new NativeError('Native helper produced too much output', 'output-too-large'));
              if (e.killed) return reject(new NativeError('Native helper timed out', 'timeout'));
              if (e.code === 'ENOENT') return reject(new NativeError('Windows PowerShell is not available', 'unavailable'));
              return reject(new NativeError(`Native helper failed (exit ${String(e.code ?? 'unknown')})${stderr && !SENSITIVE_INPUT.has(script) ? ': ' + String(stderr).split(/\r?\n/)[0].slice(0, 160) : ''}`));
            }
            const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const last = lines[lines.length - 1];
            if (!last) return reject(new NativeError('Native helper returned no output', 'bad-output'));
            try { resolve(JSON.parse(last) as T); } catch { reject(new NativeError('Native helper returned invalid output', 'bad-output')); }
          });
        } catch (e) {
          return reject(new NativeError((e as Error).message, 'unavailable'));
        }
        this.children.add(child);
        child.stdin?.on('error', () => undefined);
        if (opts.signal) {
          if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort, {once: true});
        }
        child.stdin?.end(json, 'utf8');
      });
    } finally {
      this.release();
    }
  }
}
