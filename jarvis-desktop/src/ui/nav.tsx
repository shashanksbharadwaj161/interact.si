import type { ComponentType } from 'react';
import { ChatCircleDots, CheckSquare, Code, Cube, Desktop, Flask, GearSix, House, Note, Pulse } from '@phosphor-icons/react';
// The newer glyphs are taken through the package namespace so the icon list in the existing navigation test (which
// stubs the package with a fixed set of names) keeps building. Rollup resolves static namespace access, so this does not
// change tree-shaking.
import * as Phosphor from '@phosphor-icons/react';

export type ViewId = 'home' | 'assistant' | 'companion' | 'capsules' | 'notes' | 'tasks' | 'computer' | 'status' | 'settings' | 'lab' | 'developer' | 'search' | 'motion' | 'routines' | 'integrations' | 'models' | 'usage' | 'clipboard' | 'calendar' | 'avatar' | 'memory' | 'writing' | 'guide';

export type NavIcon = ComponentType<{ size?: number | string; weight?: 'regular' | 'fill' | 'duotone' | 'bold'; 'aria-hidden'?: boolean }>;

/** The six places in the rail, plus Settings in the rail footer. Every view belongs to exactly one area. */
export type AreaId = 'today' | 'assistant' | 'workspace' | 'memory' | 'automations' | 'studio' | 'settings';

export type ViewDef = {
  id: ViewId;
  label: string;
  icon: NavIcon;
  /** Display name of the area this view sits in (kept as `group` for older callers). */
  group: string;
  area: AreaId;
  /** One line shown in help, the quick-jump palette and empty states. */
  blurb: string;
  /** Keyboard shortcut label, when the view has one. Alt+1…9 and Alt+0 are positional; others are fixed. */
  shortcut?: string;
  /** Shown under "Advanced" in its area: diagnostics and developer tools. */
  advanced?: boolean;
};

export type AreaDef = { id: AreaId; label: string; icon: NavIcon; blurb: string; views: ViewId[]; footer?: boolean };

const SearchIcon = Phosphor.MagnifyingGlass as NavIcon;
const MotionIcon = Phosphor.Waveform as NavIcon;
const RoutinesIcon = Phosphor.ListChecks as NavIcon;
const IntegrationsIcon = Phosphor.PlugsConnected as NavIcon;
const ModelsIcon = Phosphor.Cpu as NavIcon;
const UsageIcon = Phosphor.ChartBar as NavIcon;
const ClipboardIcon = Phosphor.Clipboard as NavIcon;
const CalendarIcon = Phosphor.CalendarBlank as NavIcon;
const AvatarIcon = Phosphor.UserCircle as NavIcon;
const MemoryIcon = Phosphor.Notebook as NavIcon;
const WritingIcon = Phosphor.PenNib as NavIcon;
const GuideIcon = Phosphor.Compass as NavIcon;
const WorkspaceIcon = Phosphor.Stack as NavIcon;
const AutomationsIcon = Phosphor.Repeat as NavIcon;
const StudioIcon = Phosphor.Sparkle as NavIcon;
const ArchiveIcon = Phosphor.Archive as NavIcon;
const CompanionIcon = Phosphor.Circle as NavIcon;

export const AREAS: AreaDef[] = [
  { id: 'today', label: 'Today', icon: House, blurb: 'Start something or pick up where you left off.', views: ['home'] },
  { id: 'assistant', label: 'Assistant', icon: ChatCircleDots, blurb: 'Ask, talk and review actions on this computer.', views: ['assistant', 'computer'] },
  { id: 'workspace', label: 'Workspace', icon: WorkspaceIcon, blurb: 'Notes, writing, tasks, calendar, setups and clipboard.', views: ['notes', 'writing', 'tasks', 'calendar', 'capsules', 'clipboard'] },
  { id: 'memory', label: 'Memory', icon: ArchiveIcon, blurb: 'Search everything saved here and choose what is remembered.', views: ['search', 'memory'] },
  { id: 'automations', label: 'Automations', icon: AutomationsIcon, blurb: 'Routines you run by hand or on a schedule.', views: ['routines'] },
  { id: 'studio', label: 'Studio', icon: StudioIcon, blurb: 'Choose how your companion looks and moves.', views: ['companion', 'avatar', 'motion'] },
  { id: 'settings', label: 'Settings', icon: GearSix, blurb: 'Preferences, AI, connections, help and diagnostics.', views: ['settings', 'integrations', 'models', 'usage', 'guide', 'status', 'developer', 'lab'], footer: true },
];

const AREA_OF = new Map<ViewId, AreaDef>(AREAS.flatMap((a) => a.views.map((v) => [v, a] as const)));

type Base = Omit<ViewDef, 'group' | 'area'>;
const view = (v: Base): ViewDef => {
  const a = AREA_OF.get(v.id) as AreaDef;
  return { ...v, area: a.id, group: a.label };
};

/**
 * Order matters: the first ten entries get Alt+1…9 and Alt+0 and that order never changes, so existing shortcuts and
 * deep links keep working. Screens are listed on screen by area, not by this order.
 */
export const VIEWS: ViewDef[] = [
  view({ id: 'home', label: 'Today', icon: House, blurb: 'Start something useful or continue recent work.' }),
  view({ id: 'assistant', label: 'Assistant', icon: ChatCircleDots, blurb: 'Chat with your local or cloud model, or speak to it.' }),
  view({ id: 'companion', label: 'Companion', icon: CompanionIcon, blurb: 'Choose the companion shown across the app.' }),
  view({ id: 'capsules', label: 'Setups', icon: Cube, blurb: 'Files, folders, apps and links you open together.' }),
  view({ id: 'notes', label: 'Notes', icon: Note, blurb: 'Notes with tags, kept on this computer.' }),
  view({ id: 'tasks', label: 'Tasks', icon: CheckSquare, blurb: 'To-dos with due dates and a focus timer.' }),
  view({ id: 'computer', label: 'Desktop actions', icon: Desktop, blurb: 'Preview an action on this computer, then approve it.' }),
  view({ id: 'status', label: 'System status', icon: Pulse, blurb: 'What this computer supports and why something is unavailable.', advanced: true }),
  view({ id: 'settings', label: 'Settings', icon: GearSix, blurb: 'Appearance, AI, privacy, data and startup.' }),
  view({ id: 'lab', label: 'Roadmap', icon: Flask, blurb: 'Which planned features are built, partial or not started.', advanced: true }),
  view({ id: 'developer', label: 'Developer', icon: Code, blurb: 'Diagnostics, logs and the shortcut reference.', advanced: true }),
  view({ id: 'search', label: 'Search', icon: SearchIcon, blurb: 'Find anything saved: notes, tasks, setups and chat.', shortcut: 'Ctrl+K' }),
  view({ id: 'motion', label: 'Motion studio', icon: MotionIcon, blurb: 'Original wave, particle and 3D scenes with presets.' }),
  view({ id: 'avatar', label: 'Character editor', icon: AvatarIcon, blurb: 'Edit the classic character pack: shape, expressions and timelines.' }),
  view({ id: 'routines', label: 'Automations', icon: RoutinesIcon, blurb: 'Saved steps you review and run by hand or on a schedule.' }),
  view({ id: 'clipboard', label: 'Clipboard', icon: ClipboardIcon, blurb: 'Opt-in history of copied text, kept on this computer.' }),
  view({ id: 'calendar', label: 'Calendar', icon: CalendarIcon, blurb: 'Events imported from a local .ics file.' }),
  view({ id: 'models', label: 'Local models', icon: ModelsIcon, blurb: 'Models installed in Ollama on this computer.' }),
  view({ id: 'integrations', label: 'Connections', icon: IntegrationsIcon, blurb: 'AI providers, accounts and devices you connect yourself.' }),
  view({ id: 'usage', label: 'Usage', icon: UsageIcon, blurb: 'Tokens and estimated spend recorded on this computer.' }),
  view({ id: 'memory', label: 'Memory', icon: MemoryIcon, blurb: 'Projects, checkpoints, the shelf and opt-in history.' }),
  view({ id: 'writing', label: 'Writing', icon: WritingIcon, blurb: 'Longer drafts, a scratch pad and reviewed prompts.' }),
  view({ id: 'guide', label: 'Help & setup', icon: GuideIcon, blurb: 'Short tours and a checklist based on what this computer reports.' }),
];

export const areaById = (id: AreaId): AreaDef => AREAS.find((a) => a.id === id) ?? AREAS[0];
export const areaOf = (v: ViewId): AreaDef => AREA_OF.get(v) ?? AREAS[0];
/** The screen an area opens on when chosen in the rail. */
export const areaHome = (a: AreaDef): ViewId => a.views[0];

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

/** Views grouped by area in rail order; inside an area, in that area's own order. */
export function navGroups(): { name: string; views: ViewDef[] }[] {
  return AREAS.map((a) => ({ name: a.label, views: a.views.map((id) => viewById(id)) }));
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
 * Global keyboard map, pure so it can be tested: Alt+digit jumps to a view, Ctrl+K opens search (the quick-search
 * palette searches saved memory first and also lists every screen), F1 opens help. Returns null for anything else, and always null while a modal dialog is
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
