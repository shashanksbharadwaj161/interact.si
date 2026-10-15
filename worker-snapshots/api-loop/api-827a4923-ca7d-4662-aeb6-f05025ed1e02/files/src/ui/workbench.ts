// Pure helpers for the memory workbench (src/components/MemoryWorkbench.tsx): screen status, checkpoint filtering,
// timeline grouping, keyboard labels and a reduced-motion hook. No I/O: everything here is testable in Node.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppState } from '../shared/contracts';
import type { Checkpoint, ProductivityState, TimelineEntry } from '../../electron/services/store';
import { dayRange, foldText, parseQuery, resolveEvidence, type ResolvedEvidence } from '../../electron/services/search';
import { MEDIA, matchesChord, resolveReducedMotion, type KeyEventLike } from './accessibility';
import { readPref, usePref, writePref } from './prefs';
import { sanitizeToneSettings, type ToneSettings } from './tone-profiles';

/* ---------- Screen status ---------- */

export type WorkbenchStatus =
  | { kind: 'loading' }
  | { kind: 'app-error'; message: string }
  | { kind: 'disconnected'; message: string }
  | { kind: 'memory-error'; message: string }
  | { kind: 'ready' };

/** Decides which top-level state a workbench screen shows. The app data loads first; the sidecar may be absent (browser preview) or failing (corrupt file). */
export function workbenchStatus(ctx: { status: 'loading' | 'ready' | 'error'; loadError: string | null; productivityApi: unknown | null; productivity: ProductivityState | null; productivityError: string | null }): WorkbenchStatus {
  if (ctx.status === 'loading') return { kind: 'loading' };
  if (ctx.status === 'error') return { kind: 'app-error', message: ctx.loadError ?? 'The app did not respond.' };
  if (!ctx.productivityApi) return { kind: 'disconnected', message: 'This build has no local memory store (checkpoints, shelf, timeline). Notes, tasks and capsules still work.' };
  if (ctx.productivityError && !ctx.productivity) return { kind: 'memory-error', message: ctx.productivityError };
  if (!ctx.productivity) return { kind: 'loading' };
  return { kind: 'ready' };
}

/* ---------- Checkpoints ---------- */

/** capsuleId: '' means any project, 'none' means checkpoints without a project. from/to are local YYYY-MM-DD keys (inclusive). */
export type CheckpointFilter = { query: string; capsuleId: string; from: string; to: string };
export const EMPTY_CHECKPOINT_FILTER: CheckpointFilter = { query: '', capsuleId: '', from: '', to: '' };

export function filterCheckpoints(checkpoints: readonly Checkpoint[], filter: CheckpointFilter): Checkpoint[] {
  const terms = parseQuery(filter.query);
  const from = filter.from ? dayRange(filter.from) : null;
  const to = filter.to ? dayRange(filter.to) : null;
  return checkpoints
    .filter((c) => {
      if (filter.capsuleId === 'none' ? c.capsuleId !== undefined : filter.capsuleId && c.capsuleId !== filter.capsuleId) return false;
      const t = Date.parse(c.createdAt);
      if (from && t < from.start) return false;
      if (to && t >= to.end) return false;
      if (terms.length) {
        const hay = foldText(`${c.title} ${c.note}`);
        if (!terms.every((w) => hay.includes(w))) return false;
      }
      return true;
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** True when the filter would change what is shown. */
export const isFiltered = (f: CheckpointFilter) => Boolean(f.query.trim() || f.capsuleId || f.from || f.to);

/** Every reference of a checkpoint checked against the current records: the UI shows missing ones as such and offers to drop them. */
export function checkpointEvidence(c: Checkpoint, state: AppState, prod: ProductivityState | null): ResolvedEvidence[] {
  return c.refs.map((r) => resolveEvidence(r, state, prod));
}

/** Local date key (YYYY-MM-DD) of an ISO instant, or '' when unparsable. */
export function localDayKey(iso: string | number | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Human time for lists: "14 Oct 2026, 09:30" in the user's locale, never a relative guess. */
export function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown time';
  return new Date(t).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/* ---------- Timeline ---------- */

export type TimelineDay = { day: string; entries: TimelineEntry[]; totalSec: number };

/** Groups opt-in timeline entries by local day, newest day first, newest entry first within the day. */
export function groupTimeline(entries: readonly TimelineEntry[], limitDays = 30): TimelineDay[] {
  const days = new Map<string, TimelineDay>();
  for (const e of entries) {
    const day = localDayKey(e.at);
    if (!day) continue;
    const g = days.get(day) ?? { day, entries: [], totalSec: 0 };
    g.entries.push(e);
    if (e.endedAt) g.totalSec += Math.max(0, (Date.parse(e.endedAt) - Date.parse(e.at)) / 1000);
    days.set(day, g);
  }
  return [...days.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, limitDays)
    .map((g) => ({ ...g, entries: [...g.entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)) }));
}

export const fmtDuration = (sec: number): string => (sec < 60 ? `${Math.round(sec)} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`);

/* ---------- Keyboard ---------- */

export type ShortcutDef = { id: string; chord: string; label: string };

/** Shortcuts handled inside the memory workbench page (not global app chords). Alt-based so they do not collide with text editing. */
export const MEMORY_SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'new-checkpoint', chord: 'Alt+N', label: 'New checkpoint' },
  { id: 'focus-filter', chord: 'Alt+F', label: 'Filter checkpoints' },
  { id: 'section-next', chord: 'Alt+]', label: 'Next section' },
  { id: 'section-prev', chord: 'Alt+[', label: 'Previous section' },
];

/** Shortcuts handled inside the writing workbench page. */
export const WRITING_SHORTCUTS: readonly ShortcutDef[] = [
  { id: 'save', chord: 'Ctrl+S', label: 'Save note' },
  { id: 'new-note', chord: 'Alt+N', label: 'New note' },
  { id: 'focus-editor', chord: 'Alt+E', label: 'Jump to editor' },
  { id: 'focus-tools', chord: 'Alt+T', label: 'Jump to draft tools' },
];

/** Returns the id of the first shortcut matching the key event, or null. Matching never prevents default by itself; the caller decides. */
export function matchShortcut(defs: readonly ShortcutDef[], e: KeyEventLike): string | null {
  for (const d of defs) if (matchesChord(d.chord, e)) return d.id;
  return null;
}

/* ---------- Motion ---------- */

/** Reduced motion is on when either Windows asks for it or the app setting does. Safe without matchMedia (tests, SSR). */
export function useReducedMotion(appReduced: boolean): boolean {
  const read = () => {
    const mm = typeof window !== 'undefined' ? window.matchMedia : undefined;
    const sys = mm ? Boolean(mm.call(window, MEDIA.reducedMotion).matches) : false;
    return resolveReducedMotion(sys, appReduced);
  };
  const [reduced, setReduced] = useState(read);
  useEffect(() => {
    setReduced(read());
    const mm = typeof window !== 'undefined' ? window.matchMedia : undefined;
    if (!mm) return;
    const q = mm.call(window, MEDIA.reducedMotion);
    const on = () => setReduced(read());
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appReduced]);
  return reduced;
}

/* ---------- Writing tone preferences ---------- */

/**
 * Tone profile choice, per-app tone rules and the translation target language, kept with the other UI-only, non-sensitive
 * preferences (src/ui/prefs.ts, localStorage under "jarvis.ui."). No draft text and no secrets are stored here; every read
 * is validated by sanitizeToneSettings so a damaged or hand-edited value falls back to defaults.
 */
export const TONE_SETTINGS_PREF = 'writing.tone';

export function loadToneSettings(): ToneSettings {
  return sanitizeToneSettings(readPref<unknown>(TONE_SETTINGS_PREF, null));
}

export function saveToneSettings(next: ToneSettings): ToneSettings {
  const clean = sanitizeToneSettings(next);
  writePref(TONE_SETTINGS_PREF, clean);
  return clean;
}

export function useToneSettings(): [ToneSettings, (next: ToneSettings) => void] {
  const [raw, setRaw] = usePref<unknown>(TONE_SETTINGS_PREF, null);
  const value = useMemo(() => sanitizeToneSettings(raw), [raw]);
  const set = useCallback((next: ToneSettings) => setRaw(sanitizeToneSettings(next)), [setRaw]);
  return [value, set];
}

/* ---------- Sources that this workspace cannot read ---------- */

export type UnavailableSource = { id: string; label: string; reason: string };

/** Listed in both workbenches so nobody expects these to work. They need owners outside this module (native capture, document parsers). */
export const UNAVAILABLE_SOURCES: readonly UnavailableSource[] = [
  { id: 'pdf', label: 'PDF documents', reason: 'No PDF text extraction is bundled. Paste the text you need into a note instead.' },
  { id: 'word', label: 'Word documents (.docx)', reason: 'No document parser is bundled. Paste the text you need into a note instead.' },
  { id: 'screen', label: 'Screen capture or window text', reason: 'This workspace never reads the screen. The separate capture module has its own consent gate and is not connected here.' },
  { id: 'web', label: 'Web pages', reason: 'No page fetching: the workspace reads only records saved in this app.' },
];
