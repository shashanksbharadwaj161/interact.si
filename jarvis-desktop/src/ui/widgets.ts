/**
 * Dashboard widget registry, layout rules and read-only summaries (roadmap 68, layout editor).
 *
 * Pure, DOM-free module so it can be unit tested in Node. The picker in src/components/WidgetPicker.tsx
 * only renders what these functions return.
 * A widget shows data that is already in app state (tasks, notes, capsules, activity, settings and the
 * last capability list). Nothing here touches the network, the disk or the desktop. When a source is
 * missing a widget reports 'unavailable'; it never invents a value.
 * A layout is an ordered list of widget kinds with a column span. Positions come from packLayout, so a
 * layout cannot overlap or leave the grid. Saved layouts are validated again on every read.
 */
import type { Activity, Capability, Capsule, Note, Settings, Task } from '../shared/contracts';
import { dueBucket, localDateKey, truncate } from './util';

export const GRID_COLUMNS = 12;
export const LAYOUT_VERSION = 1 as const;
/** Upper bound on saved layout text read back from preferences. */
export const MAX_LAYOUT_JSON = 4096;
/** Key under the shared non-sensitive UI preference prefix (see src/ui/prefs.ts). */
export const LAYOUT_PREF_KEY = 'dashboard.widgets';

export const WIDGET_KINDS = ['tasks', 'notes', 'capsules', 'activity', 'mode', 'system'] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export type WidgetDef = {
  id: WidgetKind;
  name: string;
  blurb: string;
  /** Column spans the user may choose. Always contains defaultWidth. */
  widths: readonly number[];
  defaultWidth: number;
  /** Fixed card height in grid rows, so every layout stays predictable. */
  rows: number;
  /** Where the summary comes from. Shown in the picker so the user knows what a widget reads. */
  source: string;
};

export const WIDGET_DEFS: readonly WidgetDef[] = [
  { id: 'tasks', name: 'Tasks', blurb: 'Open tasks, with a count of what is due today or overdue.', widths: [4, 6, 12], defaultWidth: 6, rows: 2, source: 'Saved tasks' },
  { id: 'notes', name: 'Notes', blurb: 'How many notes you have and the most recently edited one.', widths: [4, 6, 12], defaultWidth: 6, rows: 2, source: 'Saved notes' },
  { id: 'capsules', name: 'Capsules', blurb: 'How many project capsules you have and the latest one.', widths: [4, 6, 12], defaultWidth: 6, rows: 2, source: 'Saved capsules' },
  { id: 'activity', name: 'Recent activity', blurb: 'The newest entry in the activity log.', widths: [6, 12], defaultWidth: 6, rows: 3, source: 'Activity log' },
  { id: 'mode', name: 'Mode', blurb: 'Offline or online setting and the local model name. It does not test the model.', widths: [4, 6], defaultWidth: 6, rows: 2, source: 'Saved settings' },
  { id: 'system', name: 'Capabilities', blurb: 'How many capabilities the last system check reported as available.', widths: [4, 6, 12], defaultWidth: 6, rows: 2, source: 'System check' },
];

/** One widget per kind, so the kind is the id and the layout can never hold duplicates. */
export const MAX_WIDGETS = WIDGET_KINDS.length;

export type WidgetPlacement = { kind: WidgetKind; width: number };
export type WidgetLayout = { version: typeof LAYOUT_VERSION; widgets: WidgetPlacement[] };
export type PlacedWidget = WidgetPlacement & { x: number; y: number; rows: number };

export type LayoutResult = { layout: WidgetLayout; issues: string[] };
export type EditResult = { layout: WidgetLayout; ok: boolean; message: string };

const MAX_ISSUES = 5;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isWidgetKind = (v: unknown): v is WidgetKind => typeof v === 'string' && (WIDGET_KINDS as readonly string[]).includes(v);

export function widgetDef(kind: WidgetKind): WidgetDef | undefined {
  return WIDGET_DEFS.find((d) => d.id === kind);
}

/** The built-in dashboard: every widget, registry order, default widths. */
export function defaultLayout(): WidgetLayout {
  return { version: LAYOUT_VERSION, widgets: WIDGET_DEFS.map((d) => ({ kind: d.id, width: d.defaultWidth })) };
}

/**
 * Coerce anything (preferences, an older or corrupt save) into a valid layout.
 * Unknown fields are dropped. Problems are returned as short user-readable issues, never thrown.
 */
export function normalizeLayout(input: unknown): LayoutResult {
  if (input === undefined || input === null) return { layout: defaultLayout(), issues: [] };
  if (!isRecord(input) || input.version !== LAYOUT_VERSION || !Array.isArray(input.widgets)) {
    return { layout: defaultLayout(), issues: ['Saved layout was not recognised; the default layout is shown.'] };
  }
  const issues: string[] = [];
  const widgets: WidgetPlacement[] = [];
  const seen = new Set<WidgetKind>();
  // Read a bounded number of entries so a corrupt or hostile list cannot grow the work.
  const entries = input.widgets.slice(0, MAX_WIDGETS * 2);
  if (input.widgets.length > entries.length) issues.push('Extra widget entries were ignored.');
  for (const entry of entries) {
    if (widgets.length >= MAX_WIDGETS) break;
    if (!isRecord(entry) || !isWidgetKind(entry.kind)) {
      issues.push('An unknown widget was removed.');
      continue;
    }
    const def = widgetDef(entry.kind) as WidgetDef;
    if (seen.has(def.id)) {
      issues.push(`A duplicate ${def.name} widget was removed.`);
      continue;
    }
    seen.add(def.id);
    let width = def.defaultWidth;
    if (entry.width !== undefined) {
      if (typeof entry.width === 'number' && def.widths.includes(entry.width)) width = entry.width;
      else issues.push(`${def.name} had a width that is not allowed; its default width is used.`);
    }
    widgets.push({ kind: def.id, width });
  }
  return { layout: { version: LAYOUT_VERSION, widgets }, issues: issues.slice(0, MAX_ISSUES) };
}

/** Parse stored layout text. Oversized, unreadable or missing text falls back to the default layout. */
export function parseLayout(raw: string | null | undefined): LayoutResult {
  if (raw === undefined || raw === null || raw === '') return { layout: defaultLayout(), issues: [] };
  if (raw.length > MAX_LAYOUT_JSON) return { layout: defaultLayout(), issues: ['Saved layout is too large; the default layout is shown.'] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { layout: defaultLayout(), issues: ['Saved layout could not be read; the default layout is shown.'] };
  }
  return normalizeLayout(parsed);
}

/** Text to store under LAYOUT_PREF_KEY. Always writes a validated layout. */
export function serializeLayout(layout: WidgetLayout): string {
  return JSON.stringify(normalizeLayout(layout).layout);
}

const ok = (layout: WidgetLayout, message: string): EditResult => ({ layout, ok: true, message });
const fail = (layout: WidgetLayout, message: string): EditResult => ({ layout, ok: false, message });

/** Adds a widget at the end with its default width. Refuses duplicates and unknown kinds. */
export function addWidget(layout: WidgetLayout, kind: WidgetKind): EditResult {
  const def = widgetDef(kind);
  if (!def) return fail(layout, 'That widget does not exist.');
  if (layout.widgets.some((w) => w.kind === kind)) return fail(layout, `Already on the dashboard: ${def.name}.`);
  if (layout.widgets.length >= MAX_WIDGETS) return fail(layout, 'The dashboard already has the maximum number of widgets.');
  return ok({ version: LAYOUT_VERSION, widgets: [...layout.widgets, { kind, width: def.defaultWidth }] }, `Added ${def.name}.`);
}

export function removeWidget(layout: WidgetLayout, kind: WidgetKind): EditResult {
  const def = widgetDef(kind);
  if (!def || !layout.widgets.some((w) => w.kind === kind)) return fail(layout, `Not on the dashboard: ${def?.name ?? 'that widget'}.`);
  return ok({ version: LAYOUT_VERSION, widgets: layout.widgets.filter((w) => w.kind !== kind) }, `Removed ${def.name}.`);
}

export function setWidgetWidth(layout: WidgetLayout, kind: WidgetKind, width: number): EditResult {
  const def = widgetDef(kind);
  if (!def || !layout.widgets.some((w) => w.kind === kind)) return fail(layout, `Not on the dashboard: ${def?.name ?? 'that widget'}.`);
  if (!def.widths.includes(width)) return fail(layout, `${def.name} can be ${def.widths.join(', ')} columns wide.`);
  return ok({ version: LAYOUT_VERSION, widgets: layout.widgets.map((w) => (w.kind === kind ? { kind, width } : w)) }, `Set ${def.name} to ${width} columns.`);
}

/** Swaps a widget with its neighbour in the given direction. */
export function moveWidget(layout: WidgetLayout, kind: WidgetKind, direction: -1 | 1): EditResult {
  const def = widgetDef(kind);
  const index = layout.widgets.findIndex((w) => w.kind === kind);
  if (!def || index < 0) return fail(layout, `Not on the dashboard: ${def?.name ?? 'that widget'}.`);
  const target = index + direction;
  if (target < 0 || target >= layout.widgets.length) {
    return fail(layout, `Already ${direction < 0 ? 'first' : 'last'}: ${def.name}.`);
  }
  const widgets = [...layout.widgets];
  [widgets[index], widgets[target]] = [widgets[target], widgets[index]];
  return ok({ version: LAYOUT_VERSION, widgets }, `Moved ${def.name} ${direction < 0 ? 'earlier' : 'later'}.`);
}

export function resetLayout(): EditResult {
  return ok(defaultLayout(), 'Reset to the default layout.');
}

/**
 * Computes grid positions in order, filling each row left to right and starting a new row when a
 * widget does not fit. Rows are as tall as their tallest widget. Input is validated first, so the
 * result always fits GRID_COLUMNS and never overlaps.
 */
export function packLayout(layout: WidgetLayout): { items: PlacedWidget[]; rows: number } {
  const { layout: safe } = normalizeLayout(layout);
  const items: PlacedWidget[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const p of safe.widgets) {
    const rows = (widgetDef(p.kind) as WidgetDef).rows;
    if (x + p.width > GRID_COLUMNS) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    items.push({ ...p, x, y, rows });
    x += p.width;
    rowHeight = Math.max(rowHeight, rows);
  }
  return { items, rows: y + rowHeight };
}

/**
 * CSS custom properties for a packed widget: its exact 12-column position, a two-up span used by medium containers
 * (half-or-less widgets share a row, wider ones take it whole) and its row span. A narrow container stacks every
 * widget in one column in reading order (see .dash-card in views.css), so saved layouts never overflow small windows.
 */
export function widgetPlacement(item: PlacedWidget): Record<'--dash-col' | '--dash-row' | '--dash-mid' | '--dash-rows', string> {
  const half = GRID_COLUMNS / 2;
  return {
    '--dash-col': `${item.x + 1} / span ${item.width}`,
    '--dash-row': `${item.y + 1} / span ${item.rows}`,
    '--dash-mid': `span ${item.width > half ? GRID_COLUMNS : half}`,
    '--dash-rows': `span ${item.rows}`,
  };
}

/** What the app already knows. Omit a field (or pass null) when it has not been loaded. */
export type WidgetSource = {
  settings?: Pick<Settings, 'onboarded' | 'mode' | 'localModel'>;
  tasks?: Task[];
  notes?: Note[];
  capsules?: Capsule[];
  activity?: Activity[];
  capabilities?: Capability[] | null;
};

export type WidgetSummary = { state: 'ready' | 'empty' | 'unavailable'; value: string; detail: string };

const NOT_LOADED = (detail: string): WidgetSummary => ({ state: 'unavailable', value: 'Not loaded', detail });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Returns the item with the latest timestamp. Unparseable timestamps sort first. */
function newest<T>(items: readonly T[], at: (item: T) => string | undefined): T | undefined {
  let best: T | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const t = Date.parse(at(item) ?? '');
    const v = Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
    if (best === undefined || v > bestAt) {
      best = item;
      bestAt = v;
    }
  }
  return best;
}

/** Read-only text for a widget, built only from `src`. `today` is injectable for tests. */
export function summarizeWidget(kind: WidgetKind, src: WidgetSource, today = localDateKey()): WidgetSummary {
  switch (kind) {
    case 'tasks': {
      if (!src.tasks) return NOT_LOADED('Tasks have not been loaded yet.');
      if (src.tasks.length === 0) return { state: 'empty', value: 'No tasks yet', detail: 'Add a task to see it here.' };
      const open = src.tasks.filter((t) => !t.done);
      const due = open.filter((t) => {
        const b = dueBucket(t, today);
        return b === 'overdue' || b === 'today';
      }).length;
      return { state: 'ready', value: `${open.length} open`, detail: due ? `${due} due today or overdue` : 'Nothing due today or overdue' };
    }
    case 'notes': {
      if (!src.notes) return NOT_LOADED('Notes have not been loaded yet.');
      if (src.notes.length === 0) return { state: 'empty', value: 'No notes yet', detail: 'Write a note to see it here.' };
      const latest = newest(src.notes, (n) => n.updatedAt);
      return {
        state: 'ready',
        value: plural(src.notes.length, 'note', 'notes'),
        detail: `Latest: ${truncate(latest?.title.trim() || 'Untitled note', 60)}`,
      };
    }
    case 'capsules': {
      if (!src.capsules) return NOT_LOADED('Capsules have not been loaded yet.');
      if (src.capsules.length === 0) return { state: 'empty', value: 'No capsules yet', detail: 'Save a capsule to see it here.' };
      const latest = newest(src.capsules, (c) => c.updatedAt);
      return {
        state: 'ready',
        value: plural(src.capsules.length, 'capsule', 'capsules'),
        detail: `Latest: ${truncate(latest?.name.trim() || 'Untitled capsule', 60)}`,
      };
    }
    case 'activity': {
      if (!src.activity) return NOT_LOADED('The activity log has not been loaded yet.');
      if (src.activity.length === 0) return { state: 'empty', value: 'No activity yet', detail: 'Actions and events will be listed here.' };
      const latest = newest(src.activity, (a) => a.at);
      return {
        state: 'ready',
        value: plural(src.activity.length, 'entry', 'entries'),
        detail: truncate(latest?.summary.trim() || 'Untitled event', 80),
      };
    }
    case 'mode': {
      if (!src.settings) return NOT_LOADED('Settings have not been loaded yet.');
      const s = src.settings;
      return {
        state: 'ready',
        value: s.mode === 'online' ? 'Online mode' : 'Offline mode',
        detail: s.onboarded ? `Local model setting: ${truncate(s.localModel || 'not set', 40)}. Not checked here.` : 'Setup is not finished.',
      };
    }
    case 'system': {
      if (!src.capabilities) return NOT_LOADED('Run a system check to see capabilities.');
      if (src.capabilities.length === 0) return { state: 'empty', value: 'None reported', detail: 'The system check listed no capabilities.' };
      const available = src.capabilities.filter((c) => c.available).length;
      const total = src.capabilities.length;
      return {
        state: 'ready',
        value: `${available} of ${total} available`,
        detail: total - available ? `${total - available} unavailable. System status lists the reasons.` : 'Everything reported is available.',
      };
    }
    default:
      return NOT_LOADED('Unknown widget.');
  }
}
