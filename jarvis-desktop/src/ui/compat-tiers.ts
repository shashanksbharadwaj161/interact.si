// Honest x64/ARM64 compatibility tiers (feature 118).
// Pure and DOM-free: no network, no host-platform module, no model calls. It only classifies
// system values that something else already reported; it never probes or invents them.

export type Arch = 'x64' | 'arm64' | 'ia32' | 'unknown';
export type CompatTier = 'validated' | 'expected' | 'untested' | 'unsupported';

export type SupportRow = {
  readonly platform: string; // 'win32' | 'darwin' | 'linux' | '*'
  readonly arch: Arch | '*';
  readonly minBuild: number | null;
  readonly tier: CompatTier;
  readonly evidence: string;
};

/** Minimum Windows build accepted as validated: Windows 10 22H2 (19045); Windows 11 builds are 22000+. */
export const VALIDATED_MIN_BUILD = 19045;
/** Windows 10 RTM. Anything older (Windows 8.1 and earlier) cannot run the app runtime at all. */
export const WINDOWS_10_FIRST_BUILD = 10240;

const MATRIX_ROWS: SupportRow[] = [
  { platform: 'win32', arch: 'x64', minBuild: VALIDATED_MIN_BUILD, tier: 'validated', evidence: 'Installer built and smoke-tested on Windows x64 (Windows 10 build 19045+ / Windows 11).' },
  { platform: 'win32', arch: 'arm64', minBuild: null, tier: 'untested', evidence: 'No ARM64 installer has been built or smoke-tested.' },
  { platform: 'win32', arch: 'ia32', minBuild: null, tier: 'unsupported', evidence: '32-bit Windows is not built or supported.' },
  { platform: 'darwin', arch: '*', minBuild: null, tier: 'unsupported', evidence: 'The installer is built for Windows only.' },
  { platform: 'linux', arch: '*', minBuild: null, tier: 'unsupported', evidence: 'The installer is built for Windows only.' },
];
export const SUPPORT_MATRIX: readonly SupportRow[] = Object.freeze(MATRIX_ROWS.map((r) => Object.freeze(r)));

export type HardwareSpec = { readonly ramGb: number; readonly freeDiskGb: number; readonly cpuCores: number };
export const MINIMUM_HARDWARE: HardwareSpec = Object.freeze({ ramGb: 8, freeDiskGb: 4, cpuCores: 4 });
export const RECOMMENDED_HARDWARE: HardwareSpec = Object.freeze({ ramGb: 16, freeDiskGb: 20, cpuCores: 8 });
export const HARDWARE_NOTE =
  'Minimum and recommended hardware are planning values, not laptop-by-laptop promises. Local model speed depends on the model you choose.';

export type SystemInfoInput = {
  platform: string | null;
  arch: Arch;
  osBuild: number | null;
  totalMemGb: number | null;
  freeDiskGb: number | null;
  cpuCores: number | null;
  gpu: string | null;
};

function safeGet(raw: unknown, key: string): unknown {
  if (raw === null || typeof raw !== 'object') return undefined;
  try {
    return (raw as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function firstDefined(raw: unknown, keys: string[]): unknown {
  for (const k of keys) {
    const v = safeGet(raw, k);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function toNumber(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) n = Number(v);
  return n !== null && Number.isFinite(n) ? n : null;
}

function toPositive(v: unknown): number | null {
  const n = toNumber(v);
  return n !== null && n > 0 ? n : null;
}

function toNonNegative(v: unknown): number | null {
  const n = toNumber(v);
  return n !== null && n >= 0 ? n : null;
}

function toCleanString(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

export function normalizeArch(v: unknown): Arch {
  const s = toCleanString(v, 32)?.toLowerCase();
  if (!s) return 'unknown';
  if (s === 'x64' || s === 'amd64' || s === 'x86_64' || s === 'x86-64') return 'x64';
  if (s === 'arm64' || s === 'aarch64') return 'arm64';
  if (s === 'ia32' || s === 'x86' || s === 'i386' || s === 'i686') return 'ia32';
  return 'unknown';
}

function normalizePlatform(v: unknown): string | null {
  const s = toCleanString(v, 32)?.toLowerCase();
  if (!s) return null;
  if (s === 'win32' || s === 'windows' || s === 'win64') return 'win32';
  if (s === 'darwin' || s === 'macos' || s === 'mac') return 'darwin';
  if (!/^[a-z0-9_-]+$/.test(s)) return null;
  return s;
}

function parseBuild(v: unknown): number | null {
  const direct = toNumber(v);
  if (direct !== null) return Number.isInteger(direct) && direct > 0 ? direct : null;
  const s = toCleanString(v, 64);
  if (!s) return null;
  // "10.0.19045" or "10.0.22631.3007" -> third component is the build.
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(s);
  if (!m) return null;
  const b = Number(m[3]);
  return Number.isInteger(b) && b > 0 ? b : null;
}

/** Coerces unknown input into SystemInfoInput. Bad values become null (arch becomes 'unknown'). Never throws. */
export function normalizeSystemInfo(raw: unknown): SystemInfoInput {
  const cores = toPositive(firstDefined(raw, ['cpuCores', 'cores']));
  return {
    platform: normalizePlatform(safeGet(raw, 'platform')),
    arch: normalizeArch(safeGet(raw, 'arch')),
    osBuild: parseBuild(firstDefined(raw, ['osBuild', 'osRelease'])),
    totalMemGb: toPositive(firstDefined(raw, ['totalMemGb', 'ramGb', 'ramGB'])),
    freeDiskGb: toNonNegative(safeGet(raw, 'freeDiskGb')),
    cpuCores: cores !== null && Number.isInteger(cores) ? cores : null,
    gpu: toCleanString(safeGet(raw, 'gpu')),
  };
}

export type HardwareKey = 'totalMemGb' | 'freeDiskGb' | 'cpuCores';
export type RowStatus = 'met' | 'not met' | 'not reported';
export type HardwareRow = {
  key: HardwareKey;
  label: string;
  unit: string;
  value: number | null;
  minimum: number;
  recommended: number;
  minimumStatus: RowStatus;
  recommendedStatus: RowStatus;
};

const HW: readonly { key: HardwareKey; spec: keyof HardwareSpec; label: string; unit: string }[] = [
  { key: 'totalMemGb', spec: 'ramGb', label: 'RAM', unit: 'GB' },
  { key: 'freeDiskGb', spec: 'freeDiskGb', label: 'Free disk', unit: 'GB' },
  { key: 'cpuCores', spec: 'cpuCores', label: 'CPU cores', unit: 'cores' },
];

const status = (value: number | null, need: number): RowStatus => (value === null ? 'not reported' : value >= need ? 'met' : 'not met');

export function compareHardware(info: SystemInfoInput): HardwareRow[] {
  return HW.map((h) => {
    const value = info[h.key];
    return {
      key: h.key,
      label: h.label,
      unit: h.unit,
      value,
      minimum: MINIMUM_HARDWARE[h.spec],
      recommended: RECOMMENDED_HARDWARE[h.spec],
      minimumStatus: status(value, MINIMUM_HARDWARE[h.spec]),
      recommendedStatus: status(value, RECOMMENDED_HARDWARE[h.spec]),
    };
  });
}

function aggregate(statuses: RowStatus[]): boolean | null {
  if (statuses.includes('not met')) return false;
  if (statuses.includes('not reported')) return null;
  return true;
}

export type CompatOptions = { validatedBuilds?: number };
export type CompatResult = {
  tier: CompatTier;
  arch: Arch;
  platform: string | null;
  reasons: string[];
  meetsMinimum: boolean | null;
  meetsRecommended: boolean | null;
  missing: string[];
};

const fmt = (n: number) => String(Math.round(n * 10) / 10);

export function findSupportRow(platform: string | null, arch: Arch): SupportRow | null {
  if (platform === null) return null;
  return SUPPORT_MATRIX.find((r) => r.platform === platform && (r.arch === '*' || r.arch === arch)) ?? null;
}

/**
 * Classifies a system against SUPPORT_MATRIX. Tier reflects platform/arch/OS-build evidence only;
 * hardware is reported separately through meetsMinimum/meetsRecommended. Accepts raw or normalized input.
 * options.validatedBuilds overrides the minimum Windows build treated as validated (default 19045).
 */
export function classifyCompatibility(input: unknown, options: CompatOptions = {}): CompatResult {
  const info = normalizeSystemInfo(input);
  const minBuildOpt = toPositive(safeGet(options, 'validatedBuilds'));
  const minBuild = minBuildOpt !== null && Number.isInteger(minBuildOpt) ? minBuildOpt : VALIDATED_MIN_BUILD;
  const reasons: string[] = [];
  const missing: string[] = [];
  const { platform, arch } = info;
  let tier: CompatTier;

  // 1. platform
  if (platform === null) {
    missing.push('platform');
    reasons.push('Platform not reported: there is no evidence either way.');
  } else if (platform === 'win32') {
    reasons.push('Platform win32 (Windows) is the platform the installer is built for.');
  } else {
    reasons.push(`Platform ${platform} is unsupported: the installer is built for Windows only.`);
  }

  // 2. arch
  if (arch === 'unknown') {
    missing.push('arch');
    reasons.push('Architecture not reported or not recognized: there is no evidence either way.');
  } else if (arch === 'x64') {
    reasons.push('Architecture x64 matches the installer that was built and smoke-tested.');
  } else if (arch === 'arm64') {
    reasons.push('Architecture arm64 is untested: no ARM64 installer has been built or smoke-tested.');
  } else {
    reasons.push('Architecture ia32 (32-bit) is unsupported: no 32-bit build exists.');
  }

  const row = findSupportRow(platform, arch);
  if (platform !== null && platform !== 'win32') tier = 'unsupported';
  else if (arch === 'ia32') tier = 'unsupported';
  else if (platform === null || arch === 'unknown') tier = 'untested';
  else tier = row ? row.tier : 'untested';

  // 3. OS build (Windows only)
  if (platform === 'win32') {
    if (info.osBuild === null) {
      missing.push('osBuild');
      reasons.push('Windows build not reported.');
      if (tier === 'validated') tier = 'expected';
    } else if (info.osBuild < WINDOWS_10_FIRST_BUILD) {
      reasons.push(`Windows build ${info.osBuild} is older than Windows 10 (build ${WINDOWS_10_FIRST_BUILD}) and is unsupported.`);
      tier = 'unsupported';
    } else if (info.osBuild < minBuild) {
      reasons.push(`Windows build ${info.osBuild} is older than the validated minimum build ${minBuild}.`);
      if (tier === 'validated') tier = 'untested';
    } else {
      reasons.push(`Windows build ${info.osBuild} is at or above the validated minimum build ${minBuild}.`);
    }
  }

  // 4. hardware minimums, in fixed order
  const rows = compareHardware(info);
  for (const r of rows) {
    if (r.value === null) {
      missing.push(r.key);
      reasons.push(`${r.label} not reported (minimum ${r.minimum} ${r.unit}).`);
    } else if (r.minimumStatus === 'not met') {
      reasons.push(`${r.label} ${fmt(r.value)} ${r.unit} is below the ${r.minimum} ${r.unit} minimum.`);
    } else {
      reasons.push(`${r.label} ${fmt(r.value)} ${r.unit} meets the ${r.minimum} ${r.unit} minimum.`);
    }
  }

  return {
    tier,
    arch,
    platform,
    reasons,
    meetsMinimum: aggregate(rows.map((r) => r.minimumStatus)),
    meetsRecommended: aggregate(rows.map((r) => r.recommendedStatus)),
    missing,
  };
}

export function tierLabel(tier: CompatTier): string {
  switch (tier) {
    case 'validated': return 'Validated';
    case 'expected': return 'Expected to work';
    case 'untested': return 'Untested';
    case 'unsupported': return 'Unsupported';
    default: return 'Unknown';
  }
}

export function tierExplanation(tier: CompatTier): string {
  switch (tier) {
    case 'validated':
      return 'This configuration matches one where the installer was built and smoke-tested.';
    case 'expected':
      return 'This should match the tested configuration, but some details were not reported, so it has not been confirmed.';
    case 'untested':
      return 'Untested means there is no evidence yet, not that it failed. It may work, but nobody has checked this configuration.';
    case 'unsupported':
      return 'No build exists for this configuration, or it is known not to run.';
    default:
      return 'Unknown tier.';
  }
}

const show = (v: number | string | null, unit = '') => (v === null ? 'not reported' : unit ? `${typeof v === 'number' ? fmt(v) : v} ${unit}` : String(v));
const yn = (v: boolean | null) => (v === null ? 'not reported' : v ? 'yes' : 'no');

/** Deterministic plain-text report for copying into diagnostics. Contains no timestamps or identifiers. */
export function buildCompatReport(input: unknown, options: CompatOptions = {}): string {
  const info = normalizeSystemInfo(input);
  const res = classifyCompatibility(info, options);
  const lines = [
    'Compatibility report',
    `Tier: ${tierLabel(res.tier)} (${res.tier})`,
    tierExplanation(res.tier),
    '',
    `Platform: ${show(res.platform)}`,
    `Architecture: ${res.arch === 'unknown' ? 'not reported' : res.arch}`,
    `Windows build: ${show(info.osBuild)}`,
    `GPU: ${show(info.gpu)}`,
    '',
    'Hardware (value | minimum | recommended):',
    ...compareHardware(info).map((r) => `- ${r.label}: ${show(r.value, r.unit)} | min ${r.minimum} ${r.unit}: ${r.minimumStatus} | rec ${r.recommended} ${r.unit}: ${r.recommendedStatus}`),
    `Meets minimum: ${yn(res.meetsMinimum)}`,
    `Meets recommended: ${yn(res.meetsRecommended)}`,
    `Missing: ${res.missing.length ? res.missing.join(', ') : 'none'}`,
    '',
    'Reasons:',
    ...res.reasons.map((r, i) => `${i + 1}. ${r}`),
    '',
    `Note: ${HARDWARE_NOTE}`,
  ];
  return lines.join('\n');
}
