// Open-at-login and global-hotkey helpers (roadmap 9). No Electron import: the Electron objects are injected so tests never
// touch the real login items or global shortcuts. Nothing here runs unless main.ts calls it for an explicit user choice;
// the Settings contract has no launch-at-login field yet, so the app does not register itself for startup today.

/** Argument the app adds to its login item so it starts in the tray instead of stealing focus. */
export const HIDDEN_ARG = '--hidden';

export interface LoginItemApi {
  getLoginItemSettings(opts?: {path?: string; args?: string[]}): {openAtLogin: boolean};
  setLoginItemSettings(s: {openAtLogin: boolean; path?: string; args?: string[]}): void;
}

export interface LoginItemResult { ok: boolean; enabled: boolean; reason?: string }

/** Only a packaged build may register itself: an unpackaged `electron.exe` login item would launch a bare Electron shell. */
export function applyLoginItem(api: LoginItemApi, opts: {enabled: boolean; packaged: boolean; platform: string; execPath: string}): LoginItemResult {
  if (opts.platform !== 'win32') return {ok: false, enabled: false, reason: 'Open at login is only supported on Windows.'};
  if (!opts.packaged) return {ok: false, enabled: false, reason: 'Open at login is only available in the installed app.'};
  const target = {path: opts.execPath, args: [HIDDEN_ARG]};
  try {
    api.setLoginItemSettings({openAtLogin: opts.enabled, ...target});
    const actual = api.getLoginItemSettings(target).openAtLogin;
    return actual === opts.enabled ? {ok: true, enabled: actual} : {ok: false, enabled: actual, reason: 'Windows did not apply the startup setting (it may be managed by policy).'};
  } catch (e) {
    return {ok: false, enabled: false, reason: `Could not change the startup setting: ${(e as Error).message}`.slice(0, 200)};
  }
}

export interface ShortcutApi {
  register(accelerator: string, cb: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

/** Accepts modifier+key combinations only. A bare key or Shift-only chord would steal normal typing system-wide. */
export function validateAccelerator(raw: string): {ok: true; accelerator: string} | {ok: false; reason: string} {
  if (typeof raw !== 'string' || raw.length > 40) return {ok: false, reason: 'Shortcut is too long.'};
  const parts = raw.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p)) return {ok: false, reason: 'Shortcut needs a modifier and a key, for example Ctrl+Alt+J.'};
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());
  const known = new Set(['ctrl', 'control', 'commandorcontrol', 'cmdorctrl', 'alt', 'shift', 'super', 'meta', 'win']);
  if (!mods.every((m) => known.has(m))) return {ok: false, reason: 'Unknown modifier in shortcut.'};
  if (!mods.some((m) => m !== 'shift')) return {ok: false, reason: 'Shortcut needs Ctrl, Alt or Win as well as Shift.'};
  if (!/^([A-Za-z0-9]|F([1-9]|1\d|2[0-4])|Space)$/.test(key)) return {ok: false, reason: 'Unsupported key in shortcut.'};
  return {ok: true, accelerator: parts.join('+')};
}

export interface HotkeyResult { registered: string | null; reason?: string }

/** Registers the first accelerator that is valid and free. Never throws; a conflict is reported, not hidden. */
export function registerHotkey(api: ShortcutApi, candidates: readonly string[], onPress: () => void): HotkeyResult {
  const problems: string[] = [];
  for (const c of candidates) {
    const v = validateAccelerator(c);
    if (!v.ok) { problems.push(`${c}: ${v.reason}`); continue; }
    try {
      if (api.register(v.accelerator, onPress)) return {registered: v.accelerator, reason: problems.length ? `Fell back from an unavailable shortcut (${problems.join('; ')}).` : undefined};
      problems.push(`${c}: already in use by another app`);
    } catch (e) { problems.push(`${c}: ${(e as Error).message}`); }
  }
  return {registered: null, reason: `No global shortcut could be registered (${problems.join('; ') || 'none configured'}).`};
}

/** Wraps a toggle so key auto-repeat or a double press cannot flicker the window. */
export function debounced(fn: () => void, ms: number, now: () => number = Date.now): () => void {
  let last = Number.NEGATIVE_INFINITY;
  return () => { const t = now(); if (t - last < ms) return; last = t; fn(); };
}
