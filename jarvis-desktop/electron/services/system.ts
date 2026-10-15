// SystemInfo, honest capability reporting and measured resource usage. Probes are cached for 30 s.
// Nothing here is estimated or invented: every number comes from the operating system or the running process, and
// anything the platform cannot measure from the main process is reported as unavailable with a reason.
import * as os from 'node:os';
import type {Capability, Settings, SystemInfo} from '../../src/shared/contracts';
import type {NativeAdapter} from '../native/adapter';
import type {GuardedFetch} from './netGuard';
import type {Secrets} from './secrets';
import type {Speech} from './speech';
import {probeLocalModel} from './chat';

/** Per-process figures from Electron's app.getAppMetrics(), reduced to what is shown. Injected; never invented. */
export interface AppProcessMetric {
  pid: number;
  type: string;
  /** Percent of one CPU core since the previous call, as reported by Electron. */
  cpuPercent: number;
  /** Working set size in KiB, as reported by Electron. */
  workingSetKB: number;
}

/** Battery state reported by a host reader. level is a fraction from 0 to 1, as the Battery Status API uses. */
export interface BatteryReading {
  charging: boolean;
  level: number;
}

export interface OsLike {
  platform(): string;
  arch(): string;
  totalmem(): number;
  freemem(): number;
  uptime(): number;
  cpus(): {model: string; speed: number; times: {user: number; nice: number; sys: number; idle: number; irq: number}}[];
}

export interface ProcessLike {
  memoryUsage(): {rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number};
  cpuUsage(): {user: number; system: number};
  uptime(): number;
}

export interface SystemDeps {
  settings: () => Settings;
  fetch: GuardedFetch;
  speech: Pick<Speech, 'capabilities'>;
  secrets: Pick<Secrets, 'available' | 'configured'>;
  native: Pick<NativeAdapter, 'listWindows'>;
  /** Optional local OCR service. Absent means no OCR helper is wired into this build; its own probe decides availability. */
  ocr?: {capability(): Promise<Capability>};
  safeLaunch: () => boolean;
  platform?: string;
  now?: () => number;
  os?: OsLike;
  proc?: ProcessLike;
  /** Optional Electron metrics source (app.getAppMetrics). Absent in tests and non-Electron hosts. */
  appMetrics?: () => AppProcessMetric[];
  /** Optional battery reader supplied by the host. Null or a throw means unmeasured; nothing is estimated. */
  battery?: () => BatteryReading | null;
}

export interface ResourceSnapshot {
  at: string;
  memory: {totalBytes: number; freeBytes: number; usedBytes: number; usedPercent: number};
  processMemory: {rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; externalBytes: number};
  /** Whole-machine CPU busy percent between two samples of os.cpus(); null for the first call (no interval yet). */
  cpuBusyPercent: number | null;
  /** This process's CPU time since the previous snapshot as percent of one core; null for the first call. */
  processCpuPercent: number | null;
  logicalCores: number;
  osUptimeSeconds: number;
  processUptimeSeconds: number;
  /** One entry per Electron process when the host supplies metrics; empty otherwise. */
  appProcesses: AppProcessMetric[];
  /** Battery state from the host reader, or null when it is not measured (see unavailable). */
  battery: BatteryReading | null;
  /** Things that cannot be measured from here, each with the reason. Never filled with estimates. */
  unavailable: {id: string; reason: string}[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export class System {
  private cache: {at: number; caps: Capability[]; key: string} | null = null;
  private inflight: {key: string; promise: Promise<Capability[]>} | null = null;
  private lastCpu: {idle: number; total: number} | null = null;
  private lastProc: {cpu: number; at: number} | null = null;
  constructor(private d: SystemDeps) {}

  private get hostOs(): OsLike { return this.d.os ?? os; }
  private get hostProc(): ProcessLike { return this.d.proc ?? process; }

  private async compute(): Promise<Capability[]> {
    const s = this.d.settings();
    const platform = this.d.platform ?? process.platform;
    const [local, speech, secure, configured] = await Promise.all([
      probeLocalModel(this.d.fetch, s),
      this.d.speech.capabilities(),
      this.d.secrets.available(),
      this.d.secrets.configured(),
    ]);
    let ui: Capability;
    if (platform !== 'win32') ui = {id: 'ui-automation', name: 'Windows desktop control', available: false, reason: 'Requires Windows'};
    else if (this.d.safeLaunch()) ui = {id: 'ui-automation', name: 'Windows desktop control', available: false, reason: 'Safe launch is active'};
    else {
      try { await this.d.native.listWindows(); ui = {id: 'ui-automation', name: 'Windows desktop control', available: true, reason: 'Every action needs a preview and your approval'}; }
      catch (e) { ui = {id: 'ui-automation', name: 'Windows desktop control', available: false, reason: `PowerShell helper failed: ${(e as Error).message}`}; }
    }
    const cloud: Capability = s.mode !== 'online'
      ? {id: 'cloud', name: 'Cloud chat (optional)', available: false, reason: 'Offline mode'}
      : !configured
        ? {id: 'cloud', name: 'Cloud chat (optional)', available: false, reason: 'No API key'}
        : {id: 'cloud', name: 'Cloud chat (optional)', available: true, reason: 'Online mode: chat messages are sent to the cloud provider'};
    let ocr: Capability = {id: 'ocr', name: 'Image text recognition (Windows, local)', available: false, reason: 'No OCR helper is connected in this build'};
    if (this.d.ocr) {
      try { ocr = await this.d.ocr.capability(); }
      catch (e) { ocr = {id: 'ocr', name: 'Image text recognition (Windows, local)', available: false, reason: `OCR helper failed: ${(e as Error).message}`}; }
    }
    return [
      local, ...speech, ui, cloud,
      {id: 'secure-storage', name: 'Protected key storage (Windows user encryption)', available: secure.available, ...(secure.reason ? {reason: secure.reason} : {})},
      ocr,
      {id: 'vision', name: 'Vision models', available: false, reason: 'Not implemented'},
    ];
  }

  private cacheKey(): string {
    const s = this.d.settings();
    return `${s.mode}|${s.localEndpoint}|${s.localModel}|${this.d.safeLaunch() ? 'safe' : 'normal'}`;
  }

  async capabilities(): Promise<Capability[]> {
    const now = (this.d.now ?? Date.now)();
    const key = this.cacheKey();
    if (this.cache && this.cache.key === key && now - this.cache.at < 30_000) return this.cache.caps;
    // Concurrent callers share one probe instead of each spawning helpers and local requests.
    if (this.inflight && this.inflight.key === key) return this.inflight.promise;
    const promise: Promise<Capability[]> = this.compute().then((caps) => {
      if (this.inflight?.promise === promise) this.cache = {at: now, caps, key};
      return caps;
    }).finally(() => { if (this.inflight?.promise === promise) this.inflight = null; });
    this.inflight = {key, promise};
    return promise;
  }

  invalidate(): void { this.cache = null; this.inflight = null; }

  async info(): Promise<SystemInfo> {
    const o = this.hostOs;
    const cpus = o.cpus();
    return {
      platform: o.platform(),
      arch: o.arch(),
      ramGB: Math.round((o.totalmem() / 1024 ** 3) * 10) / 10,
      cpu: cpus[0]?.model?.trim() ?? 'Unknown CPU',
      capabilities: await this.capabilities(),
    };
  }

  /** Measured resource usage. CPU percentages are deltas between calls, so the first call reports null for them. */
  resources(): ResourceSnapshot {
    const o = this.hostOs;
    const p = this.hostProc;
    const nowMs = (this.d.now ?? Date.now)();
    const total = o.totalmem();
    const free = Math.min(o.freemem(), total);
    const cpus = o.cpus();
    let idle = 0, sum = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      sum += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    let cpuBusy: number | null = null;
    if (this.lastCpu && sum > this.lastCpu.total) {
      cpuBusy = round1(Math.min(100, Math.max(0, (1 - (idle - this.lastCpu.idle) / (sum - this.lastCpu.total)) * 100)));
    }
    this.lastCpu = {idle, total: sum};
    const cu = p.cpuUsage();
    const cpuMicros = cu.user + cu.system;
    let procCpu: number | null = null;
    if (this.lastProc && nowMs > this.lastProc.at) {
      procCpu = round1(Math.max(0, ((cpuMicros - this.lastProc.cpu) / 1000 / (nowMs - this.lastProc.at)) * 100));
    }
    this.lastProc = {cpu: cpuMicros, at: nowMs};
    const mem = p.memoryUsage();
    let appProcesses: AppProcessMetric[] = [];
    try { appProcesses = this.d.appMetrics?.() ?? []; } catch { appProcesses = []; }
    const battery = this.readBattery();
    return {
      at: new Date(nowMs).toISOString(),
      memory: {totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercent: total > 0 ? round1(((total - free) / total) * 100) : 0},
      processMemory: {rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal, externalBytes: mem.external},
      cpuBusyPercent: cpuBusy,
      processCpuPercent: procCpu,
      logicalCores: cpus.length,
      osUptimeSeconds: Math.round(o.uptime()),
      processUptimeSeconds: Math.round(p.uptime()),
      appProcesses,
      battery,
      unavailable: [
        {id: 'gpu', reason: 'GPU utilization and memory are not measured by this app'},
        {id: 'temperature', reason: 'Hardware temperatures are not available without a driver-level sensor reader'},
        ...(battery ? [] : [{id: 'battery', reason: this.d.battery ? 'Battery reader returned no valid reading' : 'Battery state is not read by this app'}]),
        ...(this.d.appMetrics ? [] : [{id: 'app-processes', reason: 'Per-process Electron metrics are not connected'}]),
      ],
    };
  }

  /** Reads the injected battery reader. Anything that is not a finite level in 0..1 with a boolean charging flag is unmeasured. */
  private readBattery(): BatteryReading | null {
    if (!this.d.battery) return null;
    let r: BatteryReading | null;
    try { r = this.d.battery(); } catch { return null; }
    if (!r || typeof r.charging !== 'boolean' || !Number.isFinite(r.level) || r.level < 0 || r.level > 1) return null;
    return {charging: r.charging, level: r.level};
  }
}
