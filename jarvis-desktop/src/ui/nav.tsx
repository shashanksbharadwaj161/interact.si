import type { ComponentType } from 'react';
import { ChatCircleDots, CheckSquare, Code, Cube, Desktop, Flask, GearSix, House, Note, Pulse, Robot } from '@phosphor-icons/react';
// The two newest views take their glyphs through the package namespace so the icon list in the
// existing navigation test (which stubs the package with a fixed set of names) keeps building.
// Rollup resolves static namespace member access, so this does not change tree-shaking.
import * as Phosphor from '@phosphor-icons/react';

export type ViewId = 'home' | 'assistant' | 'companion' | 'capsules' | 'notes' | 'tasks' | 'computer' | 'status' | 'settings' | 'lab' | 'developer' | 'search' | 'motion' | 'routines' | 'integrations' | 'models' | 'usage' | 'clipboard' | 'calendar' | 'avatar' | 'memory' | 'writing' | 'guide';

export type NavIcon = ComponentType<{ size?: number | string; weight?: 'regular' | 'fill' | 'duotone'; 'aria-hidden'?: boolean }>;

export type ViewDef = {
  id: ViewId;
  label: string;
  icon: NavIcon;
  group: string;
  /** One line shown in the help dialog and the quick-jump list. */
  blurb: string;
  /** Keyboard shortcut label, when the view has one. Alt+1…9 and Alt+0 are positional; others are fixed. */
  shortcut?: string;
};

const SearchIcon = Phosphor.MagnifyingGlass as NavIcon;
const MotionIcon = Phosphor.Waveform as NavIcon;
const RoutinesIcon = Phosphor.ListChecks as NavIcon;
const IntegrationsIcon = Phosphor.PlugsConnected as NavIcon;
const ModelsIcon = Phosphor.Brain as NavIcon;
const UsageIcon = Phosphor.ChartBar as NavIcon;
const ClipboardIcon = Phosphor.Clipboard as NavIcon;
const CalendarIcon = Phosphor.CalendarBlank as NavIcon;
const AvatarIcon = Phosphor.UserCircle as NavIcon;
const MemoryIcon = Phosphor.Notebook as NavIcon;
const WritingIcon = Phosphor.PenNib as NavIcon;
const GuideIcon = Phosphor.Compass as NavIcon;

/**
 * Order matters in two places: the first ten entries get Alt+1…9 and Alt+0, and views are listed
 * on screen grouped by `group` in this order. New views are appended so existing shortcuts stay put.
 */
export const VIEWS: ViewDef[] = [
  { id: 'home', label: 'Home', icon: House, group: 'Cockpit', blurb: 'Overview of what is saved on this computer.' },
  { id: 'assistant', label: 'Assistant', icon: ChatCircleDots, group: 'Cockpit', blurb: 'Chat with the local or cloud model.' },
  { id: 'companion', label: 'Companion', icon: Robot, group: 'Cockpit', blurb: 'Avatar poses and scene backdrop.' },
  { id: 'capsules', label: 'Capsules', icon: Cube, group: 'Work', blurb: 'Project bundles of files, folders, apps and links.' },
  { id: 'notes', label: 'Notes', icon: Note, group: 'Work', blurb: 'Tagged notes kept on this computer.' },
  { id: 'tasks', label: 'Tasks & focus', icon: CheckSquare, group: 'Work', blurb: 'Tasks with due dates and a focus timer.' },
  { id: 'computer', label: 'Computer', icon: Desktop, group: 'Work', blurb: 'Preview and approve actions on this computer.' },
  { id: 'status', label: 'System status', icon: Pulse, group: 'System', blurb: 'What this app detected and what is unavailable.' },
  { id: 'settings', label: 'Settings', icon: GearSix, group: 'System', blurb: 'Mode, models, access, data and appearance.' },
  { id: 'lab', label: 'Feature Lab', icon: Flask, group: 'System', blurb: 'Roadmap status for every planned scope.' },
  { id: 'developer', label: 'Developer', icon: Code, group: 'System', blurb: 'Diagnostics and shortcut reference.' },
  { id: 'search', label: 'Memory search', icon: SearchIcon, group: 'Work', blurb: 'Search saved notes, tasks, capsules and chat.', shortcut: 'Ctrl+K' },
  { id: 'motion', label: 'Motion studio', icon: MotionIcon, group: 'Cockpit', blurb: 'Original wave, particle and orbit effects with presets.' },
  { id: 'avatar', label: 'Avatar', icon: AvatarIcon, group: 'Cockpit', blurb: 'Live avatar preview and whether avatar editing is connected.' },
  { id: 'routines', label: 'Routines', icon: RoutinesIcon, group: 'Work', blurb: 'Saved step lists you run by hand or on a schedule.' },
  { id: 'clipboard', label: 'Clipboard history', icon: ClipboardIcon, group: 'Work', blurb: 'Opt-in history of copied text, kept on this computer.' },
  { id: 'calendar', label: 'Calendar', icon: CalendarIcon, group: 'Work', blurb: 'Local .ics calendar import; shows whether it is connected.' },
  { id: 'models', label: 'Models', icon: ModelsIcon, group: 'System', blurb: 'Local model manager for Ollama on this computer.' },
  { id: 'integrations', label: 'Integrations', icon: IntegrationsIcon, group: 'System', blurb: 'Optional providers: API connections, websites and device links.' },
  { id: 'usage', label: 'Usage', icon: UsageIcon, group: 'System', blurb: 'Local token and spend ledger with export.' },
  { id: 'memory', label: 'Memory', icon: MemoryIcon, group: 'Work', blurb: 'Projects, checkpoints, shelf, opt-in timeline and source-linked recaps kept on this computer.' },
  { id: 'writing', label: 'Writing', icon: WritingIcon, group: 'Work', blurb: 'Notes editor, scratch pad and reviewed prompt drafts for the assistant.' },
  { id: 'guide', label: 'Guided setup', icon: GuideIcon, group: 'System', blurb: 'Short local tours and a setup checklist driven by what this computer reports.' },
];

/** Alt+1…9 and Alt+0 reach the first ten views; later views have no positional shortcut. */
export function positionalShortcut(index: number): string | null {
  if (index < 0 || index >= 10) return null;
  return `Alt+${index === 9 ? 0 : index + 1}`;
}

for (const [i, v] of VIEWS.entries()) {
  const alt = positionalShortcut(i);
  if (alt && !v.shortcut) v.shortcut = alt;
}

export const VIEW_IDS = VIEWS.map((v) => v.id);

export const viewById = (id: ViewId): ViewDef => VIEWS.find((v) => v.id === id) ?? VIEWS[0];

/** Views grouped in display order, preserving the first-seen order of group names. */
export function navGroups(): { name: string; views: ViewDef[] }[] {
  const names = Array.from(new Set(VIEWS.map((v) => v.group)));
  return names.map((name) => ({ name, views: VIEWS.filter((v) => v.group === name) }));
}

export type HashLocation = { view: ViewId; params: Record<string, string> };

/**
 * Hash routes look like `#/notes` or `#/notes?item=n_1`. Unknown views fall back to Home.
 * Parameters are optional hints for the target view (for example which saved item to select);
 * a view that does not understand a parameter ignores it.
 */
export function parseHash(hash: string): HashLocation {
  const body = hash.replace(/^#\/?/, '');
  const q = body.indexOf('?');
  const id = (q >= 0 ? body.slice(0, q) : body) as ViewId;
  const params: Record<string, string> = {};
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(body.slice(q + 1))) if (k) params[k] = v.slice(0, 200);
  }
  return { view: VIEW_IDS.includes(id) ? id : 'home', params };
}

export function viewFromHash(hash: string): ViewId {
  return parseHash(hash).view;
}

export function hashFor(view: ViewId, params?: Record<string, string>): string {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== '');
  if (entries.length === 0) return `#/${view}`;
  return `#/${view}?${new URLSearchParams(entries).toString()}`;
}

/** Which view shows a search result category; search results are saved records, so chat opens the assistant. */
export const VIEW_FOR_CATEGORY: Record<'note' | 'task' | 'capsule' | 'chat', ViewId> = { note: 'notes', task: 'tasks', capsule: 'capsules', chat: 'assistant' };

export type ShortcutAction = { kind: 'view'; view: ViewId } | { kind: 'help' } | { kind: 'search' };

/**
 * Global keyboard map, pure so it can be tested: Alt+digit jumps to a view, Ctrl+K opens memory
 * search, F1 opens help. Returns null for anything else, and always null while a modal dialog is
 * open so a shortcut never discards a dialog's unsaved state.
 */
export function shortcutAction(e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, modalOpen: boolean): ShortcutAction | null {
  if (modalOpen) return null;
  if (e.key === 'F1' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) return { kind: 'help' };
  if ((e.key === 'k' || e.key === 'K') && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) return { kind: 'search' };
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (!/^\d$/.test(e.key)) return null;
  const n = e.key === '0' ? 10 : Number(e.key);
  const view = VIEWS[n - 1];
  return view && n <= 10 ? { kind: 'view', view: view.id } : null;
}
