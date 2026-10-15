import type { Settings } from '../shared/contracts';

/**
 * Named, switchable personal profiles (goal 7). Pure and DOM-free: the Settings screen stores the result through the
 * existing prefs.ts helpers under PROFILES_PREF_KEY and applies a profile with the existing saveSettings call.
 *
 * A profile captures ONLY non-sensitive presentation/comfort fields. It never captures mode, allowedRoots,
 * approvedApps, localEndpoint, cloudModel or any key/credential, so switching a profile can never widen access,
 * go online or change where data is sent. Everything stays on this computer.
 */

export const PROFILES_PREF_KEY = 'profiles.v1';

export const PROFILE_LIMITS = Object.freeze({ maxProfiles: 12, nameMin: 1, nameMax: 40, idMax: 80, textMax: 120, retainMin: 1, retainMax: 3650 });

/** The only Settings fields a profile may hold. */
export const PROFILE_FIELDS = Object.freeze(['theme', 'reduceMotion', 'voice', 'localModel', 'startInTray', 'retainDays'] as const);
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ProfileSettings = Pick<Settings, ProfileField>;

export type PersonalProfile = { id: string; name: string; createdAt: string; updatedAt: string; settings: ProfileSettings };
export type ProfilesState = { profiles: PersonalProfile[]; activeProfileId: string | null };

export const PROFILE_FIELD_LABELS: Readonly<Record<ProfileField, string>> = Object.freeze({
  theme: 'Theme',
  reduceMotion: 'Reduce motion',
  voice: 'Voice',
  localModel: 'Local model',
  startInTray: 'Start in tray',
  retainDays: 'Keep history (days)',
});

const THEMES: readonly Settings['theme'][] = ['graphite', 'nebula', 'paper'];

export const emptyProfiles = (): ProfilesState => ({ profiles: [], activeProfileId: null });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameKey = (name: string) => name.toLocaleLowerCase();

function toIso(now: unknown): string {
  const d = now instanceof Date ? now : typeof now === 'number' || typeof now === 'string' ? new Date(now) : null;
  if (!d || Number.isNaN(d.getTime())) throw new Error('Profile time must be a valid Date, timestamp or ISO string.');
  return d.toISOString();
}

/** Trims and collapses whitespace; throws a descriptive Error when the result is empty or too long. */
export function validateProfileName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Profile name must be text.');
  const n = name.replace(/\s+/g, ' ').trim();
  if (n.length < PROFILE_LIMITS.nameMin) throw new Error('Profile name cannot be empty.');
  if (n.length > PROFILE_LIMITS.nameMax) throw new Error(`Profile name must be at most ${PROFILE_LIMITS.nameMax} characters (got ${n.length}).`);
  return n;
}

function cleanText(v: unknown): string | null {
  return typeof v === 'string' ? v.trim().slice(0, PROFILE_LIMITS.textMax) : null;
}

function cleanRetain(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(PROFILE_LIMITS.retainMax, Math.max(PROFILE_LIMITS.retainMin, Math.round(v)));
}

/** Copies only the allowed fields, clamped. Returns null when any field is missing or malformed. */
function sanitizeSettings(raw: unknown): ProfileSettings | null {
  if (!isObj(raw)) return null;
  const theme = raw.theme;
  const voice = cleanText(raw.voice);
  const localModel = cleanText(raw.localModel);
  const retainDays = cleanRetain(raw.retainDays);
  if (typeof theme !== 'string' || !THEMES.includes(theme as Settings['theme'])) return null;
  if (typeof raw.reduceMotion !== 'boolean' || typeof raw.startInTray !== 'boolean') return null;
  if (voice === null || localModel === null || retainDays === null) return null;
  return { theme: theme as Settings['theme'], reduceMotion: raw.reduceMotion, voice, localModel, startInTray: raw.startInTray, retainDays };
}

/** The allowed fields of the given settings. Throws when the settings themselves are malformed. */
export function pickProfileSettings(settings: unknown): ProfileSettings {
  const s = sanitizeSettings(settings);
  if (!s) throw new Error('Settings are incomplete or malformed, so no profile can be captured.');
  return s;
}

/**
 * Reads whatever was stored (state object or bare array) and returns a clean state: malformed entries dropped,
 * names trimmed and clamped, duplicate ids and case-insensitive duplicate names dropped (first wins), at most
 * PROFILE_LIMITS.maxProfiles kept, and activeProfileId kept only when it names a surviving profile.
 */
export function normalizeProfiles(raw: unknown): ProfilesState {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.profiles) ? raw.profiles : [];
  const out: PersonalProfile[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const e of list) {
    if (out.length >= PROFILE_LIMITS.maxProfiles) break;
    if (!isObj(e)) continue;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id || id.length > PROFILE_LIMITS.idMax || ids.has(id)) continue;
    const name = typeof e.name === 'string' ? e.name.replace(/\s+/g, ' ').trim().slice(0, PROFILE_LIMITS.nameMax).trim() : '';
    if (!name || names.has(nameKey(name))) continue;
    if (typeof e.createdAt !== 'string' || Number.isNaN(Date.parse(e.createdAt))) continue;
    if (typeof e.updatedAt !== 'string' || Number.isNaN(Date.parse(e.updatedAt))) continue;
    const settings = sanitizeSettings(e.settings);
    if (!settings) continue;
    ids.add(id);
    names.add(nameKey(name));
    out.push({ id, name, createdAt: e.createdAt, updatedAt: e.updatedAt, settings });
  }
  const active = isObj(raw) && typeof raw.activeProfileId === 'string' && ids.has(raw.activeProfileId) ? raw.activeProfileId : null;
  return { profiles: out, activeProfileId: active };
}

let idSeq = 0;
const newId = (iso: string) => `profile-${Date.parse(iso).toString(36)}-${(++idSeq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A new profile holding only the allowed fields of settings. Does not check duplicates; upsertProfile does. */
export function captureProfile(name: string, settings: unknown, now: Date | number | string, id?: string): PersonalProfile {
  const n = validateProfileName(name);
  const iso = toIso(now);
  const s = pickProfileSettings(settings);
  const pid = id === undefined ? newId(iso) : typeof id === 'string' && id.trim() && id.trim().length <= PROFILE_LIMITS.idMax ? id.trim() : null;
  if (!pid) throw new Error('Profile id must be non-empty text.');
  return { id: pid, name: n, createdAt: iso, updatedAt: iso, settings: s };
}

function assertUniqueName(state: ProfilesState, name: string, exceptId: string | null) {
  const clash = state.profiles.find((p) => p.id !== exceptId && nameKey(p.name) === nameKey(name));
  if (clash) throw new Error(`A profile named "${clash.name}" already exists.`);
}

/** Adds a new profile or replaces the one with the same id (keeping its createdAt). */
export function upsertProfile(state: ProfilesState, profile: PersonalProfile): ProfilesState {
  const cur = normalizeProfiles(state);
  const name = validateProfileName(profile?.name);
  const settings = pickProfileSettings(profile?.settings);
  if (typeof profile.id !== 'string' || !profile.id) throw new Error('Profile id must be non-empty text.');
  const updatedAt = toIso(profile.updatedAt);
  assertUniqueName(cur, name, profile.id);
  const idx = cur.profiles.findIndex((p) => p.id === profile.id);
  if (idx >= 0) {
    const prev = cur.profiles[idx];
    const next = { ...prev, name, settings, updatedAt };
    return { ...cur, profiles: cur.profiles.map((p, i) => (i === idx ? next : p)) };
  }
  if (cur.profiles.length >= PROFILE_LIMITS.maxProfiles) throw new Error(`You can keep at most ${PROFILE_LIMITS.maxProfiles} profiles. Remove one first.`);
  return { ...cur, profiles: [...cur.profiles, { id: profile.id, name, createdAt: toIso(profile.createdAt), updatedAt, settings }] };
}

function findOrThrow(state: ProfilesState, id: string): PersonalProfile {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) throw new Error('That profile no longer exists.');
  return p;
}

export function renameProfile(state: ProfilesState, id: string, name: string, now: Date | number | string): ProfilesState {
  const cur = normalizeProfiles(state);
  const p = findOrThrow(cur, id);
  return upsertProfile(cur, { ...p, name: validateProfileName(name), updatedAt: toIso(now) });
}

/** Replaces a profile's captured fields with the allowed fields of the given settings. */
export function updateProfileSettings(state: ProfilesState, id: string, settings: unknown, now: Date | number | string): ProfilesState {
  const cur = normalizeProfiles(state);
  const p = findOrThrow(cur, id);
  return upsertProfile(cur, { ...p, settings: pickProfileSettings(settings), updatedAt: toIso(now) });
}

/** Removes a profile; clears activeProfileId when the active one was removed. Unknown ids leave the state unchanged. */
export function removeProfile(state: ProfilesState, id: string): ProfilesState {
  const cur = normalizeProfiles(state);
  return { profiles: cur.profiles.filter((p) => p.id !== id), activeProfileId: cur.activeProfileId === id ? null : cur.activeProfileId };
}

export function setActiveProfile(state: ProfilesState, id: string | null): ProfilesState {
  const cur = normalizeProfiles(state);
  if (id !== null) findOrThrow(cur, id);
  return { ...cur, activeProfileId: id };
}

/** A frozen saveSettings patch with exactly the captured fields and nothing else. */
export function applyProfile(profile: PersonalProfile): Readonly<Partial<Settings>> {
  const s = pickProfileSettings(profile?.settings);
  const patch: Partial<Settings> = {};
  for (const k of PROFILE_FIELDS) (patch as Record<string, unknown>)[k] = s[k];
  return Object.freeze(patch);
}

/** Captured fields whose value differs from the given settings, in PROFILE_FIELDS order. */
export function diffProfile(profile: PersonalProfile, settings: Partial<Settings>): ProfileField[] {
  return PROFILE_FIELDS.filter((k) => profile.settings[k] !== settings[k]);
}
