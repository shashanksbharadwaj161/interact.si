/**
 * Optional Windows customization catalog, presets and preference export (roadmap scopes 71-80).
 *
 * Pure, DOM-free module so it can be unit tested in Node. Nothing here installs a tool, injects code,
 * writes the registry or changes a Windows setting. Profiles are original descriptions of tool
 * categories. No third-party project is named until its licence, version and reversal steps are verified
 * (gate G5 in docs/feature-matrix.md). The component in src/components/Customization.tsx only renders
 * what these functions return.
 */
import { ROADMAP, type RoadmapItem } from './roadmap';
import type { SystemInfo } from '../shared/contracts';

export type ModTouch = 'taskbar' | 'start' | 'explorer' | 'notifications';
export type Risk = 'low' | 'medium' | 'high';
/** 'unverified' is the only state shipped. A profile links out only after a person records 'verified-permissive'. */
export type LicenceState = 'unverified' | 'verified-permissive';
export type Compatibility = 'compatible' | 'incompatible' | 'unknown';

export type ModProfile = {
  id: string;
  name: string;
  purpose: string;
  touches: ModTouch[];
  risk: Risk;
  /** How the change is reversed outside this app. The app never runs the tool itself. */
  reversal: string;
  /** Windows builds the profile was tested on. null means nothing has been tested. */
  testedBuilds: { min: number; max: number } | null;
  /** CPU architectures the profile was tested on. null means nothing has been tested. */
  testedArches: string[] | null;
  licence: LicenceState;
  /** Project page. Used only when licence is 'verified-permissive' and the URL is https. */
  homepage: string | null;
  /** Tool version that was checked by hand. null until a specific release is verified. */
  verifiedVersion: string | null;
};

/** The fields of SystemInfo that compatibility needs, plus a build number this app does not report yet. */
export type CompatEnvironment = Pick<SystemInfo, 'platform' | 'arch'> & { windowsBuild?: number | null };

export type CompatResult = { status: Compatibility; reasons: string[] };

/** Rules a profile must meet before it can show a project link. Shown to the user on the catalog screen. */
export const LISTING_RULES: string[] = [
  'The licence is checked by a person and recorded. Unknown licences are never shown as safe.',
  'The tool version is pinned and recorded. Newer releases need a new check.',
  'The tested Windows builds and CPU architectures are recorded. Anything else is reported as unknown.',
  'The reversal steps are written down and do not need this app.',
  'No third-party code is bundled. GPL and AGPL code is never copied into this app.',
];

export const CATALOG: ModProfile[] = [
  {
    id: 'taskbar-alignment',
    name: 'Taskbar alignment profile',
    purpose: 'Describes an external tool that moves taskbar items or changes how they group. You install and run that tool yourself.',
    touches: ['taskbar'],
    risk: 'medium',
    reversal: 'Use the tool’s own revert option or uninstall it, then restart Explorer.',
    testedBuilds: null,
    testedArches: null,
    licence: 'unverified',
    homepage: null,
    verifiedVersion: null,
  },
  {
    id: 'start-menu-layout',
    name: 'Start menu layout profile',
    purpose: 'Describes an external tool that changes Start menu sections and layout. You install and run that tool yourself.',
    touches: ['start'],
    risk: 'medium',
    reversal: 'Use the tool’s own revert option or uninstall it, then restart Explorer.',
    testedBuilds: null,
    testedArches: null,
    licence: 'unverified',
    homepage: null,
    verifiedVersion: null,
  },
  {
    id: 'explorer-defaults',
    name: 'File Explorer defaults profile',
    purpose: 'Describes an external tool that changes File Explorer defaults such as file extensions and the opening folder.',
    touches: ['explorer'],
    risk: 'low',
    reversal: 'Change the option back in File Explorer’s view settings or uninstall the tool, then restart Explorer.',
    testedBuilds: null,
    testedArches: null,
    licence: 'unverified',
    homepage: null,
    verifiedVersion: null,
  },
  {
    id: 'notification-tidy',
    name: 'Notification tidy profile',
    purpose: 'Describes an external tool that groups or quiets notifications. You install and run that tool yourself.',
    touches: ['notifications'],
    risk: 'low',
    reversal: 'Use the tool’s own revert option or uninstall it. Notification settings in Windows are unchanged by this app.',
    testedBuilds: null,
    testedArches: null,
    licence: 'unverified',
    homepage: null,
    verifiedVersion: null,
  },
];

/** A single Windows setting a preference can describe. `supported` is false until a verified, reversible adapter exists. */
export type CustomEffect = { id: string; touches: ModTouch; label: string; supported: boolean; reason: string };

const NOT_BUILT = 'Not built in this app. It stays off until a verified, reversible adapter exists (gate G5).';

export const EFFECTS: CustomEffect[] = [
  { id: 'taskbar.align-left', touches: 'taskbar', label: 'Align taskbar items to the left', supported: false, reason: NOT_BUILT },
  { id: 'taskbar.hide-search', touches: 'taskbar', label: 'Hide the search box on the taskbar', supported: false, reason: NOT_BUILT },
  { id: 'start.hide-recommended', touches: 'start', label: 'Hide the recommended section in Start', supported: false, reason: NOT_BUILT },
  { id: 'explorer.show-extensions', touches: 'explorer', label: 'Show file name extensions', supported: false, reason: NOT_BUILT },
  { id: 'notifications.group-by-app', touches: 'notifications', label: 'Group notifications by app', supported: false, reason: NOT_BUILT },
];

export type CustomPreset = { id: string; name: string; scope: number | null; blurb: string; effects: string[] };

export const PRESETS: CustomPreset[] = [
  { id: 'none', name: 'None', scope: null, blurb: 'Every effect off.', effects: [] },
  {
    id: 'taskbar-start-calm',
    name: 'Calm taskbar and Start',
    scope: 73,
    blurb: 'Taskbar alignment, the search box and Start recommendations.',
    effects: ['taskbar.align-left', 'taskbar.hide-search', 'start.hide-recommended'],
  },
  {
    id: 'explorer-notify-tidy',
    name: 'Tidy Explorer and notifications',
    scope: 74,
    blurb: 'File extensions in Explorer and grouped notifications.',
    effects: ['explorer.show-extensions', 'notifications.group-by-app'],
  },
];

export const DEFAULT_PRESET_ID = 'none';

/** Roadmap rows 71-80 from the shared roadmap, so names and tiers stay in one place. */
export const CUSTOMIZATION_SCOPES: RoadmapItem[] = (ROADMAP.find((c) => c.name === 'Windows customization')?.items ?? []).filter(
  (i) => i.id >= 71 && i.id <= 80,
);

export const PREFS_SCHEMA_VERSION = 1;
export const EXPORT_FORMAT = 'jarvis-customization';
/** Exports and parsed text larger than this are refused. Preferences are a few hundred bytes. */
export const MAX_EXPORT_CHARS = 64 * 1024;

export type CustomizationPrefs = { schemaVersion: typeof PREFS_SCHEMA_VERSION; presetId: string; effects: Record<string, boolean> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pure gate for the "project page" link. Only verified, permissive, https pages pass. */
export function projectLink(profile: ModProfile): string | null {
  if (profile.licence !== 'verified-permissive' || !profile.homepage) return null;
  try {
    return new URL(profile.homepage).protocol === 'https:' ? profile.homepage : null;
  } catch {
    return null;
  }
}

/**
 * Compatibility of one profile with the reported system. Incompatible outranks unknown, and unknown
 * means a fact is missing: nothing is assumed to pass.
 */
export function checkCompatibility(profile: ModProfile, env: CompatEnvironment | null | undefined): CompatResult {
  if (!env) return { status: 'unknown', reasons: ['System information is not loaded yet.'] };
  if (env.platform !== 'win32') return { status: 'incompatible', reasons: [`Windows only. This system reports “${env.platform}”.`] };

  const blocking: string[] = [];
  const open: string[] = [];

  if (!profile.testedBuilds) open.push('No Windows build range has been tested for this profile.');
  else if (env.windowsBuild == null) open.push('This app does not report the Windows build number.');
  else if (env.windowsBuild < profile.testedBuilds.min || env.windowsBuild > profile.testedBuilds.max)
    blocking.push(`Windows build ${env.windowsBuild} is outside the tested range ${profile.testedBuilds.min}–${profile.testedBuilds.max}.`);

  if (!profile.testedArches) open.push('No CPU architecture has been tested for this profile.');
  else if (!env.arch) open.push('The CPU architecture was not reported.');
  else if (!profile.testedArches.includes(env.arch)) blocking.push(`${env.arch} is not in the tested list: ${profile.testedArches.join(', ')}.`);

  if (profile.verifiedVersion === null) open.push('The tool version has not been verified.');

  return {
    status: blocking.length ? 'incompatible' : open.length ? 'unknown' : 'compatible',
    reasons: [...blocking, ...open],
  };
}

/** Coerces untrusted input into a valid preference object. Unknown keys are dropped, and only a literal `true` counts. */
export function normalizePrefs(raw: unknown, effects: CustomEffect[] = EFFECTS, presets: CustomPreset[] = PRESETS): CustomizationPrefs {
  const src = isRecord(raw) && raw.schemaVersion === PREFS_SCHEMA_VERSION ? raw : {};
  const presetId = typeof src.presetId === 'string' && presets.some((p) => p.id === src.presetId) ? src.presetId : DEFAULT_PRESET_ID;
  const requested = isRecord(src.effects) ? src.effects : {};
  const map: Record<string, boolean> = {};
  for (const e of effects) map[e.id] = e.supported && requested[e.id] === true;
  return { schemaVersion: PREFS_SCHEMA_VERSION, presetId, effects: map };
}

/** Turns one effect on or off. Unknown or unsupported effects return the prefs unchanged. */
export function setEffect(prefs: CustomizationPrefs, id: string, on: boolean, effects: CustomEffect[] = EFFECTS): CustomizationPrefs {
  const e = effects.find((x) => x.id === id);
  if (!e || !e.supported) return prefs;
  return { ...prefs, effects: { ...prefs.effects, [id]: on } };
}

/** Selects a preset: exactly its supported effects are on, everything else is off. */
export function applyPreset(presetId: string, effects: CustomEffect[] = EFFECTS, presets: CustomPreset[] = PRESETS): CustomizationPrefs {
  const preset = presets.find((p) => p.id === presetId) ?? presets.find((p) => p.id === DEFAULT_PRESET_ID) ?? presets[0];
  const chosen = new Set(preset?.effects ?? []);
  const map: Record<string, boolean> = {};
  for (const e of effects) map[e.id] = e.supported && chosen.has(e.id);
  return { schemaVersion: PREFS_SCHEMA_VERSION, presetId: preset?.id ?? DEFAULT_PRESET_ID, effects: map };
}

export type PreviewLine = { id: string; label: string; touches: ModTouch; state: 'off' | 'unsupported' | 'preview'; text: string };
export type Preview = { lines: PreviewLine[]; previewCount: number; unsupportedCount: number; total: number; headline: string; changesWindows: false };

/**
 * What the saved preferences would describe. This screen never applies an effect, so `changesWindows` is always false.
 * Effects that are not built are shown as off with the reason.
 */
export function previewPrefs(prefs: CustomizationPrefs, effects: CustomEffect[] = EFFECTS): Preview {
  const normalized = normalizePrefs(prefs, effects);
  const lines: PreviewLine[] = effects.map((e) => {
    const base = { id: e.id, label: e.label, touches: e.touches };
    if (!e.supported) return { ...base, state: 'unsupported', text: `Off. ${e.reason}` };
    if (normalized.effects[e.id]) return { ...base, state: 'preview', text: 'Previewed only. This screen does not change Windows.' };
    return { ...base, state: 'off', text: 'Off.' };
  });
  const previewCount = lines.filter((l) => l.state === 'preview').length;
  const unsupportedCount = lines.filter((l) => l.state === 'unsupported').length;
  const total = lines.length;
  const headline =
    previewCount === 0
      ? `No setting in this build would change Windows. ${unsupportedCount} of ${total} effects are not built.`
      : `${previewCount} of ${total} selected effects are previewed. This screen does not apply them.`;
  return { lines, previewCount, unsupportedCount, total, headline, changesWindows: false };
}

/** Serialises validated preferences for saving or sharing. Output never claims a Windows change. */
export function exportPrefs(prefs: CustomizationPrefs, effects: CustomEffect[] = EFFECTS): string {
  const n = normalizePrefs(prefs, effects);
  return JSON.stringify({ format: EXPORT_FORMAT, schemaVersion: PREFS_SCHEMA_VERSION, appliesToWindows: false, presetId: n.presetId, effects: n.effects }, null, 2);
}

/** Reads text produced by exportPrefs. Returns null for anything else, including oversized input. */
export function parseExport(text: unknown, effects: CustomEffect[] = EFFECTS, presets: CustomPreset[] = PRESETS): CustomizationPrefs | null {
  if (typeof text !== 'string' || text.length > MAX_EXPORT_CHARS) return null;
  try {
    const obj: unknown = JSON.parse(text);
    if (!isRecord(obj) || obj.format !== EXPORT_FORMAT) return null;
    return normalizePrefs(obj, effects, presets);
  } catch {
    return null;
  }
}
