/**
 * Resource policy: bounded refresh and idle backoff, plus low-memory, battery and motion-quality suggestions.
 *
 * Pure, DOM-free and deterministic so it can be unit tested in Node. It only reads telemetry the host has already
 * measured (ResourceSnapshot from electron/services/system.ts). It never probes the device and never guesses how fast
 * the machine is. Missing telemetry is unknown, not zero, and unknown samples never count toward a suggestion.
 * A suggestion names a proposed change; nothing is applied until the user confirms it.
 */
import type {BatteryReading} from '../../electron/services/system';
import type {BatterySource} from '../shared/contracts';

export const REFRESH_MS = {active: 5_000, min: 2_000, max: 300_000} as const;

/** Idle backoff: the refresh delay doubles once per full idle minute, and failures add doublings the same way. */
export const IDLE_STEP_SECONDS = 60;
/** Upper bound on doublings, so 5 s grows to at most the 300 s cap. */
export const MAX_BACKOFF_STEPS = 6;

export const POLICY_THRESHOLDS = {
  /** Used memory percent at or above which low memory is suggested. */
  lowMemoryUsedPercent: 90,
  /** Whole-machine CPU busy percent at or above which lighter motion quality is suggested. */
  busyCpuPercent: 85,
  /** Battery level (0 to 1) at or below which battery-aware motion is suggested, while not charging. */
  batteryLevel: 0.2,
  /** Consecutive measured samples over a threshold before a suggestion appears. One spike never changes advice. */
  sustainSamples: 3,
} as const;

export interface RefreshState {
  /** Seconds since the last user input or visible change. Negative or non-finite values count as 0. */
  idleSeconds: number;
  /** Consecutive failed refreshes such as a helper error or timeout. Negative or non-finite values count as 0. */
  failures: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nonNegative = (n: number) => (finite(n) && n > 0 ? n : 0);

/**
 * Delay before the next refresh. It is never below REFRESH_MS.min or above REFRESH_MS.max, and it never shrinks as
 * idle time or failures grow. Calling it with no state gives the active interval.
 */
export function refreshDelayMs(state: Partial<RefreshState> = {}): number {
  const idleSteps = Math.floor(nonNegative(state.idleSeconds ?? 0) / IDLE_STEP_SECONDS);
  const failureSteps = Math.floor(nonNegative(state.failures ?? 0));
  const steps = Math.min(MAX_BACKOFF_STEPS, idleSteps + failureSteps);
  return Math.min(REFRESH_MS.max, Math.max(REFRESH_MS.min, REFRESH_MS.active * 2 ** steps));
}

/**
 * Telemetry from the host. Every field is optional and null-able: absent or null means the host did not measure it.
 * A ResourceSnapshot from electron/services/system.ts can be passed directly.
 */
export interface ResourceTelemetry {
  memory?: {usedPercent: number} | null;
  cpuBusyPercent?: number | null;
  battery?: BatteryReading | null;
}

/** Settings the user already has, so a suggestion is not repeated once it is in effect. */
export interface PolicyCurrent {
  batteryMotionOn?: boolean;
  avatarQuality?: string;
  modelProfile?: string;
}

export type SuggestionId = 'low-memory' | 'battery-motion' | 'motion-quality';

/** The change a suggestion proposes. The host applies it only after the user confirms. */
export type SuggestionProposal =
  | {kind: 'model-profile'; value: 'low-memory'}
  | {kind: 'shell-pref'; key: 'motion.onBattery'; value: true}
  | {kind: 'avatar-quality'; key: 'avatar.quality'; value: 'battery'};

export interface Suggestion {
  id: SuggestionId;
  message: string;
  proposal: SuggestionProposal;
  /** Always true. The policy never changes a setting by itself. */
  requiresConfirmation: true;
}

const PROPOSALS: Record<SuggestionId, SuggestionProposal> = {
  'low-memory': {kind: 'model-profile', value: 'low-memory'},
  'battery-motion': {kind: 'shell-pref', key: 'motion.onBattery', value: true},
  'motion-quality': {kind: 'avatar-quality', key: 'avatar.quality', value: 'battery'},
};

const SUGGESTION_IDS: SuggestionId[] = ['low-memory', 'battery-motion', 'motion-quality'];

/** Null means unknown: the sample does not count toward a suggestion and resets its streak. */
function conditions(t: ResourceTelemetry, current: PolicyCurrent, th: typeof POLICY_THRESHOLDS): Record<SuggestionId, boolean | null> {
  const used = t.memory?.usedPercent;
  const cpu = t.cpuBusyPercent;
  const battery = t.battery;
  return {
    'low-memory': finite(used) && current.modelProfile !== 'low-memory' ? used >= th.lowMemoryUsedPercent : null,
    'battery-motion': battery && !current.batteryMotionOn
      ? !battery.charging && finite(battery.level) && battery.level <= th.batteryLevel
      : null,
    'motion-quality': finite(cpu) && current.avatarQuality !== 'battery' ? cpu >= th.busyCpuPercent : null,
  };
}

function messageFor(id: SuggestionId, t: ResourceTelemetry, th: typeof POLICY_THRESHOLDS): string {
  if (id === 'low-memory') {
    return `Memory has been over ${th.lowMemoryUsedPercent}% used (${Math.round(t.memory?.usedPercent ?? 0)}% now). `
      + 'The Low memory model profile keeps less in RAM. Apply it in Models if you want it.';
  }
  if (id === 'battery-motion') {
    return `The battery is at ${Math.round((t.battery?.level ?? 0) * 100)}% and not charging. `
      + 'Turn on battery-aware motion in Settings to reduce animation.';
  }
  return `The processor has been busy (${Math.round(t.cpuBusyPercent ?? 0)}% now). `
    + 'Switch the avatar to Battery quality (24 frames per second) if you want it lighter.';
}

/**
 * Stateful policy: call observe() once per measured snapshot. A suggestion appears only after the same condition has
 * held for `sustainSamples` consecutive measured samples. It stays in the list while the condition holds, so the UI
 * should show each id once.
 */
export function createResourcePolicy(thresholds: typeof POLICY_THRESHOLDS = POLICY_THRESHOLDS) {
  const streaks: Record<SuggestionId, number> = {'low-memory': 0, 'battery-motion': 0, 'motion-quality': 0};
  return {
    observe(telemetry: ResourceTelemetry, current: PolicyCurrent = {}): Suggestion[] {
      const c = conditions(telemetry, current, thresholds);
      const out: Suggestion[] = [];
      for (const id of SUGGESTION_IDS) {
        // The streak is capped at the threshold so it cannot grow without bound while a condition holds.
        streaks[id] = c[id] === true ? Math.min(thresholds.sustainSamples, streaks[id] + 1) : 0;
        if (c[id] === true && streaks[id] >= thresholds.sustainSamples) {
          out.push({id, message: messageFor(id, telemetry, thresholds), proposal: {...PROPOSALS[id]}, requiresConfirmation: true});
        }
      }
      return out;
    },
    reset(): void {
      for (const id of SUGGESTION_IDS) streaks[id] = 0;
    },
  };
}

export type ResourcePolicy = ReturnType<typeof createResourcePolicy>;

// ---------- Battery source fallback: Battery Status API -> host bridge -> unmeasured ----------

/** Longest a single battery reader may take before it is treated as unavailable. */
export const BATTERY_READ_TIMEOUT_MS = 2_000;

/** A battery/power state with an honest source label. level and charging are null unless the source measured them. */
export interface ResolvedBattery {
  source: BatterySource;
  onBattery: boolean | null;
  charging: boolean | null;
  level: number | null;
  measuredAt: string;
}

/**
 * Readers are injected (this module never touches DOM or Electron globals). browser is the Battery Status API reader
 * built by navigatorBatteryReader in src/ui/bridges.ts, which labels its own result; host is the read-only host bridge.
 */
export interface BatteryReaders {
  browser?: (() => Promise<unknown>) | null;
  host?: (() => Promise<unknown>) | null;
  timeoutMs?: number;
  now?: () => number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isoAt = (now: () => number) => new Date(now()).toISOString();

export function unmeasuredBattery(now: () => number = Date.now): ResolvedBattery {
  return {source: 'unmeasured', onBattery: null, charging: null, level: null, measuredAt: isoAt(now)};
}

/** Battery Status API reading -> ResolvedBattery, or null when it is not a real measurement. */
export function normalizeBrowserBattery(v: unknown, now: () => number = Date.now): ResolvedBattery | null {
  if (!isObj(v) || typeof v.charging !== 'boolean') return null;
  const source = v.source;
  if (typeof source !== 'string' || !source || source === 'host' || source === 'unmeasured') return null;
  const level = finite(v.level) && v.level >= 0 && v.level <= 1 ? v.level : null;
  return {source: source as BatterySource, onBattery: !v.charging, charging: v.charging, level, measuredAt: isoAt(now)};
}

/** Host bridge reading -> ResolvedBattery, or null when the host reported unmeasured or something malformed. Never a level. */
export function normalizeHostBattery(v: unknown, now: () => number = Date.now): ResolvedBattery | null {
  if (!isObj(v) || v.source !== 'host' || typeof v.onBattery !== 'boolean') return null;
  const at = typeof v.measuredAt === 'string' && v.measuredAt.length <= 40 && Number.isFinite(Date.parse(v.measuredAt)) ? v.measuredAt : isoAt(now);
  return {source: 'host', onBattery: v.onBattery, charging: null, level: null, measuredAt: at};
}

async function attempt(reader: (() => Promise<unknown>) | null | undefined, ms: number): Promise<unknown> {
  if (typeof reader !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(reader),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Battery read timed out')), ms); }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fallback order: the Battery Status API reader first, then the host bridge, then unmeasured. A reader that is absent,
 * rejects, times out or returns something malformed is skipped. Never throws and never invents a value.
 */
export async function resolveBatteryStatus(readers: BatteryReaders = {}): Promise<ResolvedBattery> {
  const now = readers.now ?? Date.now;
  const ms = finite(readers.timeoutMs) && readers.timeoutMs > 0 ? readers.timeoutMs : BATTERY_READ_TIMEOUT_MS;
  const fromBrowser = normalizeBrowserBattery(await attempt(readers.browser, ms), now);
  if (fromBrowser) return fromBrowser;
  const fromHost = normalizeHostBattery(await attempt(readers.host, ms), now);
  if (fromHost) return fromHost;
  return unmeasuredBattery(now);
}

/**
 * Applies a host on-battery/on-ac change. A Battery Status API reading stays in charge (it has more detail); otherwise a
 * valid host event replaces the current state. A malformed event leaves the current state unchanged.
 */
export function applyHostBatteryEvent(current: ResolvedBattery | null, event: unknown, now: () => number = Date.now): ResolvedBattery | null {
  if (current && current.source !== 'host' && current.source !== 'unmeasured') return current;
  return normalizeHostBattery(event, now) ?? current;
}

/** Telemetry for createResourcePolicy: only a source that measured both level and charging counts; host-only is unknown. */
export function batteryTelemetry(b: ResolvedBattery | null): BatteryReading | null {
  if (!b || typeof b.charging !== 'boolean' || !finite(b.level)) return null;
  return {charging: b.charging, level: b.level};
}

/** Battery-saver motion applies only when the user turned it on and some source says the machine runs on battery. */
export function batterySaverMotionActive(b: ResolvedBattery | null, batteryMotionOn: boolean): boolean {
  return batteryMotionOn === true && b?.onBattery === true;
}

/** Plain label with the source named honestly, for example "Battery: on battery (host)" or "Battery: unmeasured". */
export function batteryLabel(b: ResolvedBattery | null): string {
  if (!b || b.source === 'unmeasured' || b.onBattery === null) return 'Battery: unmeasured';
  const state = b.onBattery ? 'on battery' : 'on AC power';
  const level = finite(b.level) ? `, ${Math.round(b.level * 100)}%` : '';
  return `Battery: ${state}${level} (${b.source})`;
}
