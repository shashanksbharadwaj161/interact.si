// SystemInfo and honest capability reporting. Probes are cached for 30 s.
import * as os from 'node:os';
import type {Capability, Settings, SystemInfo} from '../../src/shared/contracts';
import type {NativeAdapter} from '../native/adapter';
import type {GuardedFetch} from './netGuard';
import type {Secrets} from './secrets';
import type {Speech} from './speech';
import {probeLocalModel} from './chat';

export interface SystemDeps {
  settings: () => Settings;
  fetch: GuardedFetch;
  speech: Pick<Speech, 'capabilities'>;
  secrets: Pick<Secrets, 'available' | 'configured'>;
  native: Pick<NativeAdapter, 'listWindows'>;
  safeLaunch: () => boolean;
  platform?: string;
  now?: () => number;
}

export class System {
  private cache: {at: number; caps: Capability[]; key: string} | null = null;
  constructor(private d: SystemDeps) {}

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
    return [
      local, ...speech, ui, cloud,
      {id: 'secure-storage', name: 'Protected key storage (Windows DPAPI)', available: secure.available, ...(secure.reason ? {reason: secure.reason} : {})},
      {id: 'ocr', name: 'Screen reading / OCR', available: false, reason: 'Not implemented'},
      {id: 'vision', name: 'Vision models', available: false, reason: 'Not implemented'},
    ];
  }

  async capabilities(): Promise<Capability[]> {
    const now = (this.d.now ?? Date.now)();
    const s = this.d.settings();
    const key = `${s.mode}|${s.localEndpoint}|${s.localModel}`;
    if (this.cache && this.cache.key === key && now - this.cache.at < 30_000) return this.cache.caps;
    const caps = await this.compute();
    this.cache = {at: now, caps, key};
    return caps;
  }

  invalidate(): void { this.cache = null; }

  async info(): Promise<SystemInfo> {
    const cpus = os.cpus();
    return {
      platform: os.platform(),
      arch: os.arch(),
      ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      cpu: cpus[0]?.model?.trim() ?? 'Unknown CPU',
      capabilities: await this.capabilities(),
    };
  }
}
