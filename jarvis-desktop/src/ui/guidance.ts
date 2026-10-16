import type { ApiFeature, ApiFeatureId, Capability, Settings } from '../shared/contracts';
import type { ViewId } from './nav';

/**
 * Guided setup and in-app help: pure state selection for the local quick-start checklist.
 *
 * Every status comes from what the host passes in (capabilities, API features, settings, counts). Nothing here probes,
 * downloads, opens the microphone, changes a permission or sends anything. A topic whose feature is unavailable, blocked
 * or not yet checked is never counted as done, and a manual "done" mark cannot pass it either. Status data older than
 * STALE_AFTER_MS is not trusted to claim that a feature is available.
 *
 * The only persisted data is the non-sensitive checklist preference (GuidancePrefs), validated on every read and import.
 */

export const GUIDE_TOPIC_IDS = ['notes', 'tasks', 'capsules', 'dictation', 'streaming', 'local-models', 'privacy', 'motion'] as const;
export type GuideTopicId = (typeof GUIDE_TOPIC_IDS)[number];

/**
 * done: finished (real evidence, or marked done by you while the feature is usable). todo: usable, not finished.
 * blocked: the feature exists but something you control is missing. unavailable: this computer or build cannot do it.
 * unknown: not checked yet, the check failed or the result is out of date. skipped: you chose to skip it.
 */
export type GuideStatus = 'done' | 'todo' | 'blocked' | 'unavailable' | 'unknown' | 'skipped';

export type GuideTarget = { view: ViewId; params?: Record<string, string> };
export type GuideLink = { label: string; target: GuideTarget };

/** Requests the host may handle. They are only emitted from an explicit click; the host decides what to do. */
export type GuideAction = { type: 'recheck' } | { type: 'open-onboarding' } | { type: 'open-shortcuts' };

export type GuidanceCounts = { notes: number; tasks: number; capsules: number };

export type GuidanceInput = {
  /** getSystemInfo().capabilities; null until the first answer. */
  capabilities: Capability[] | null;
  /** Message from a failed getSystemInfo / getApiInfo call. */
  capabilitiesError?: string | null;
  /** getApiInfo().features; null while unknown. Pass [] when the bridge has no getApiInfo (every feature then reads as not reported). */
  apiFeatures: ApiFeature[] | null;
  settings: Pick<Settings, 'mode' | 'reduceMotion' | 'localModel' | 'cloudModel' | 'allowedRoots' | 'approvedApps'> | null;
  /** cloudKeyStatus().configured; null while unknown. Only the yes/no answer, never the key. */
  cloudKeyConfigured: boolean | null;
  /** Saved item counts from app state; null until state loads. */
  counts: GuidanceCounts | null;
  /** prefers-reduced-motion from the system; null when unknown. */
  systemReducedMotion?: boolean | null;
  /** Whether a WebGL2 context can be created for the 3D studio; null when unknown. */
  webgl2?: boolean | null;
  /** Epoch ms when capabilities/API features were last fetched; null if never. */
  checkedAt: number | null;
};

export type GuideFact = { label: string; value: string };

export type GuideItem = {
  id: GuideTopicId;
  title: string;
  summary: string;
  status: GuideStatus;
  /** Why the item has this status, in plain words. */
  reason: string;
  facts: GuideFact[];
  links: GuideLink[];
  /** Mark done is only offered when the feature is usable now and real evidence has not already finished it. */
  canMarkDone: boolean;
  /** Your own mark from the saved checklist, if any. */
  mark: GuideMark | null;
  /** You marked it done earlier but it is not usable now, so the mark is not counted. */
  markIgnored: boolean;
};

export type GuideTourStep = { title: string; body: string };

type TopicDef = { id: GuideTopicId; title: string; summary: string; links: GuideLink[]; tour: GuideTourStep[] };

/** Status checks older than this are treated as out of date. */
export const STALE_AFTER_MS = 10 * 60 * 1000;
/** A checkedAt this far in the future means the clock moved; the result is not trusted. */
const FUTURE_TOLERANCE_MS = 60 * 1000;

const TOPICS: Record<GuideTopicId, TopicDef> = {
  notes: {
    id: 'notes',
    title: 'Notes',
    summary: 'Write tagged notes that stay in this app’s data folder on this computer.',
    links: [{ label: 'Open Notes', target: { view: 'notes' } }],
    tour: [
      { title: 'Create a note', body: 'Open Notes and choose New note. A title is enough to start; the body can be empty.' },
      { title: 'Tag it', body: 'Add a few tags so related notes are easy to filter. Tags are plain words, saved with the note.' },
      { title: 'Find it later', body: 'Memory search looks through note titles, bodies and tags on this computer. It does not send them anywhere.' },
    ],
  },
  tasks: {
    id: 'tasks',
    title: 'Tasks and focus',
    summary: 'Keep a short task list with due dates and run a focus timer.',
    links: [{ label: 'Open Tasks', target: { view: 'tasks' } }],
    tour: [
      { title: 'Add a task', body: 'Open Tasks & focus and type a task. A due date is optional; overdue tasks are highlighted.' },
      { title: 'Focus on one thing', body: 'Start the focus timer for a work session. It runs inside this app and keeps counting while you switch screens.' },
      { title: 'Finish it', body: 'Tick the task when it is done. Completed tasks stay listed until you choose Clear completed and confirm.' },
    ],
  },
  capsules: {
    id: 'capsules',
    title: 'Capsules',
    summary: 'Bundle the files, folders, apps and links for one project so you can reopen them together.',
    links: [{ label: 'Open Capsules', target: { view: 'capsules' } }],
    tour: [
      { title: 'Make a capsule', body: 'Open Capsules, name a project and add the files, folders, links and apps it uses.' },
      { title: 'Preview before restoring', body: 'Restoring shows what will open first. Apps and files only open after you confirm in the app’s own dialog.' },
      { title: 'Allowed folders and apps', body: 'Capsules can only open items inside the folders and apps you allowed in Settings › Access.' },
    ],
  },
  dictation: {
    id: 'dictation',
    title: 'Dictation',
    summary: 'Hold push-to-talk in the Assistant to turn speech into text with Windows speech recognition.',
    links: [
      { label: 'Open Assistant', target: { view: 'assistant' } },
      { label: 'Voice settings', target: { view: 'settings', params: { q: 'voice' } } },
    ],
    tour: [
      { title: 'Push to talk', body: 'In the Assistant, hold Push to talk while you speak and release it to stop. The app asks for your consent before using the microphone, and it is only on while you hold the button.' },
      { title: 'Review the text', body: 'The recognized text goes into the message box first. Edit it, then send it yourself. Nothing is sent automatically.' },
      { title: 'If it fails', body: 'When no speech is recognized or transcription fails, a notice says so and whatever you already typed stays in the box, so you can retry or type instead.' },
    ],
  },
  streaming: {
    id: 'streaming',
    title: 'Streaming replies',
    summary: 'See replies appear as they are written, and stop a reply at any time.',
    links: [
      { label: 'Open Assistant', target: { view: 'assistant' } },
      { label: 'Connect Claude', target: { view: 'settings', params: { q: 'claude' } } },
    ],
    tour: [
      { title: 'Send a message', body: 'Replies stream in as the model writes them. Only one reply streams at a time.' },
      { title: 'Stop when you like', body: 'Choose Stop to end a reply. Any partial text is kept once and marked incomplete.' },
      { title: 'Where it runs', body: 'Online mode streams from Claude (or the provider you chose) with your own key. In offline mode AI requests are off. A failure shows an error; it never switches route on its own.' },
    ],
  },
  'local-models': {
    id: 'local-models',
    title: 'Legacy local model',
    summary: 'Only for setups from earlier versions that answer through a local Ollama server. Claude does not need it.',
    links: [
      { label: 'Open Local models', target: { view: 'models' } },
      { label: 'Legacy local model settings', target: { view: 'settings', params: { q: 'legacy' } } },
    ],
    tour: [
      { title: 'Only if you used it before', body: 'Earlier versions could answer through Ollama, a separate program on this computer. If you never set it up, skip this topic.' },
      { title: 'Choose a model', body: 'Local models lists what Ollama already has. Downloads only start when you choose one there and confirm; this guide never downloads anything.' },
      { title: 'Check again', body: 'After starting Ollama or adding a model, choose Re-check here or in Settings to update the status.' },
    ],
  },
  privacy: {
    id: 'privacy',
    title: 'Privacy and access',
    summary: 'Review where answers come from and what the app may open on this computer.',
    links: [
      { label: 'Mode settings', target: { view: 'settings', params: { q: 'mode' } } },
      { label: 'Allowed folders', target: { view: 'settings', params: { q: 'folders' } } },
      { label: 'Retention', target: { view: 'settings', params: { q: 'retention' } } },
    ],
    tour: [
      { title: 'Offline by default', body: 'In offline mode AI requests are off and nothing is sent anywhere. Notes, tasks, capsules and this checklist are always stored on this computer.' },
      { title: 'Online is your choice', body: 'Online mode sends your messages to Claude, or the provider you set up, using your own API key, only when you send them.' },
      { title: 'Access you grant', body: 'The app can only open folders and apps you list in Settings › Access, and desktop actions always ask first.' },
      { title: 'History you keep', body: 'Retention controls how long chat and activity history is kept. You can export or clear it in Settings › Data.' },
    ],
  },
  motion: {
    id: 'motion',
    title: 'Motion and 3D',
    summary: 'Set how much animation you want, then explore the motion and 3D studios.',
    links: [
      { label: 'Motion settings', target: { view: 'settings', params: { q: 'motion' } } },
      { label: 'Open Motion studio', target: { view: 'motion' } },
      { label: 'Open Avatar', target: { view: 'avatar' } },
    ],
    tour: [
      { title: 'Reduce motion', body: 'Turn on Reduce motion in Settings › Accessibility, or follow the Windows setting. Animations then stop or become still frames.' },
      { title: 'Motion studio', body: 'Effects are generated in the app from numeric presets. Nothing is downloaded and playback can be paused or scrubbed.' },
      { title: '3D needs WebGL2', body: 'The 3D studio draws with WebGL2. Without it you get a flat still preview instead.' },
    ],
  },
};

export function topicDef(id: GuideTopicId): Readonly<TopicDef> {
  return TOPICS[id];
}

export function isTopicId(v: unknown): v is GuideTopicId {
  return typeof v === 'string' && (GUIDE_TOPIC_IDS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ freshness ------------------------------------------------------------------ */

export type Freshness = 'fresh' | 'stale' | 'unchecked' | 'error';

export function statusFreshness(input: Pick<GuidanceInput, 'checkedAt' | 'capabilitiesError'>, now: number): Freshness {
  if (input.capabilitiesError) return 'error';
  const at = input.checkedAt;
  if (at === null || !Number.isFinite(at)) return 'unchecked';
  if (at > now + FUTURE_TOLERANCE_MS || now - at > STALE_AFTER_MS) return 'stale';
  return 'fresh';
}

/** "just now", "4 minutes ago", "2 hours ago". Used for the last-checked line. */
export function describeAge(checkedAt: number | null, now: number): string {
  if (checkedAt === null || !Number.isFinite(checkedAt)) return 'never';
  const ms = now - checkedAt;
  if (ms < -FUTURE_TOLERANCE_MS) return 'at an unknown time (clock changed)';
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  return `${d} days ago`;
}

/* ------------------------------------------------------------------ availability ------------------------------------------------------------------ */

type Avail = { state: 'available' | 'unavailable' | 'unknown'; reason: string };

function unknownReason(freshness: Freshness, error?: string | null): string {
  if (freshness === 'error') return `The status check failed: ${error}. Choose Re-check.`;
  if (freshness === 'stale') return 'The last status check is out of date. Choose Re-check.';
  return 'Not checked yet. Choose Re-check.';
}

function capability(input: GuidanceInput, freshness: Freshness, id: string, name: string): Avail {
  if (freshness !== 'fresh' || !input.capabilities) return { state: 'unknown', reason: unknownReason(freshness, input.capabilitiesError) };
  const cap = input.capabilities.find((c) => c.id === id);
  if (!cap) return { state: 'unavailable', reason: `${name} is not reported by this computer.` };
  if (cap.available) return { state: 'available', reason: cap.reason ?? `${name} is available.` };
  return { state: 'unavailable', reason: cap.reason ?? `${name} is not available.` };
}

function feature(input: GuidanceInput, freshness: Freshness, id: ApiFeatureId, name: string): Avail {
  if (freshness !== 'fresh' || !input.apiFeatures) return { state: 'unknown', reason: unknownReason(freshness, input.capabilitiesError) };
  const f = input.apiFeatures.find((x) => x.id === id);
  if (!f) return { state: 'unavailable', reason: `${name} is not supported by this build.` };
  if (f.available) return { state: 'available', reason: `${name} is supported.` };
  return { state: 'unavailable', reason: f.reason ?? `${name} is not available.` };
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function saved(input: GuidanceInput, key: keyof GuidanceCounts, one: string, many: string): { status: GuideStatus; reason: string; facts: GuideFact[] } {
  if (!input.counts) return { status: 'unknown', reason: 'Saved items have not loaded yet.', facts: [] };
  const n = Math.max(0, Math.floor(Number(input.counts[key]) || 0));
  if (n > 0) return { status: 'done', reason: `You have ${count(n, one, many)} saved on this computer.`, facts: [{ label: 'Saved', value: count(n, one, many) }] };
  return { status: 'todo', reason: `No ${many} yet. Follow the tour to make your first one.`, facts: [{ label: 'Saved', value: `0 ${many}` }] };
}

type Base = { status: GuideStatus; reason: string; facts: GuideFact[] };

function fromAvail(a: Avail, ready: Omit<Base, 'facts'> & { facts?: GuideFact[] }): Base {
  if (a.state === 'unknown') return { status: 'unknown', reason: a.reason, facts: [] };
  if (a.state === 'unavailable') return { status: 'unavailable', reason: a.reason, facts: [] };
  return { facts: [], ...ready };
}

function routeReadiness(input: GuidanceInput, freshness: Freshness): { ok: boolean; status: GuideStatus; reason: string; route: string } {
  const s = input.settings;
  if (!s) return { ok: false, status: 'unknown', reason: 'Settings have not loaded yet.', route: 'unknown' };
  if (s.mode === 'online') {
    if (!s.cloudModel.trim()) return { ok: false, status: 'blocked', reason: 'Online mode has no model chosen. Choose one in Settings › AI.', route: 'Cloud API (online)' };
    if (input.cloudKeyConfigured === false) return { ok: false, status: 'blocked', reason: 'Online mode has no saved API key, so chat sends nothing. Save your key in Settings › AI.', route: 'Cloud API (online)' };
    if (input.cloudKeyConfigured === null) return { ok: false, status: 'unknown', reason: 'Whether an API key is saved is not known yet. Choose Re-check.', route: 'Cloud API (online)' };
    return { ok: true, status: 'todo', reason: `Online mode is set up with “${s.cloudModel}”. Whether the provider answers is only known when you send a message.`, route: 'Cloud API (online)' };
  }
  const llm = capability(input, freshness, 'local-llm', 'The local model');
  if (llm.state === 'unknown') return { ok: false, status: 'unknown', reason: llm.reason, route: 'AI off (offline)' };
  if (llm.state === 'unavailable') return { ok: false, status: 'blocked', reason: 'AI is not connected. Connect Claude in Settings › AI, then send a message in the Assistant to see a reply stream in.', route: 'AI off (offline)' };
  return { ok: true, status: 'todo', reason: 'The legacy local model is answering. Send a message in the Assistant to see a reply stream in.', route: 'Legacy local model (offline)' };
}

const yesNo = (v: boolean | null | undefined, yes: string, no: string) => (v === true ? yes : v === false ? no : 'Unknown');

function baseFor(id: GuideTopicId, input: GuidanceInput, freshness: Freshness): Base {
  switch (id) {
    case 'notes':
      return saved(input, 'notes', 'note', 'notes');
    case 'tasks':
      return saved(input, 'tasks', 'task', 'tasks');
    case 'capsules':
      return saved(input, 'capsules', 'capsule', 'capsules');
    case 'dictation': {
      const stt = capability(input, freshness, 'stt', 'Speech recognition');
      return fromAvail(stt, { status: 'todo', reason: 'Windows speech recognition is available. Try push-to-talk in the Assistant.', facts: [{ label: 'Microphone', value: 'Only on while you hold push-to-talk' }] });
    }
    case 'streaming': {
      const f = feature(input, freshness, 'chat-streaming', 'Streaming chat');
      if (f.state !== 'available') return fromAvail(f, { status: 'todo', reason: '' });
      const cancel = feature(input, freshness, 'chat-cancel', 'Stopping a reply');
      const r = routeReadiness(input, freshness);
      const facts = [
        { label: 'Route', value: r.route },
        { label: 'Stop button', value: cancel.state === 'available' ? 'Supported' : 'Not supported by this build' },
      ];
      return { status: r.status, reason: r.reason, facts };
    }
    case 'local-models': {
      const f = feature(input, freshness, 'local-models', 'Local model listing');
      if (f.state === 'unavailable') return { status: 'unavailable', reason: f.reason, facts: [] };
      const llm = capability(input, freshness, 'local-llm', 'The local model');
      const facts = input.settings ? [{ label: 'Model name', value: input.settings.localModel || 'Not set' }] : [];
      if (llm.state === 'unknown') return { status: 'unknown', reason: llm.reason, facts };
      // Not part of a new setup: a local model that is not answering is reported, not presented as a step to finish.
      if (llm.state === 'unavailable') return { status: 'unavailable', reason: `Not answering (${llm.reason.replace(/[.\s]+$/, '')}). Only needed for setups from earlier versions; Claude does not need it. Nothing is downloaded automatically.`, facts };
      return { status: 'done', reason: llm.reason, facts };
    }
    case 'privacy': {
      const s = input.settings;
      if (!s) return { status: 'unknown', reason: 'Settings have not loaded yet.', facts: [] };
      const facts: GuideFact[] = [
        { label: 'Mode', value: s.mode === 'online' ? 'Online: chat uses your own API key' : 'Offline: chat stays on this computer' },
        { label: 'Cloud API key', value: yesNo(input.cloudKeyConfigured, 'Saved (protected by Windows)', 'Not saved') },
        { label: 'Allowed folders', value: String(s.allowedRoots.length) },
        { label: 'Approved apps', value: String(s.approvedApps.length) },
      ];
      return { status: 'todo', reason: 'Review the settings below, then mark this done.', facts };
    }
    case 'motion': {
      const app = input.settings?.reduceMotion;
      const sys = input.systemReducedMotion;
      const effective = app === true || sys === true ? 'Reduced' : app === false && sys === false ? 'Full' : 'Unknown';
      const facts: GuideFact[] = [
        { label: 'App setting', value: yesNo(app, 'Reduce motion on', 'Reduce motion off') },
        { label: 'Windows setting', value: yesNo(sys, 'Reduce motion on', 'Reduce motion off') },
        { label: 'Animations now', value: effective },
        { label: '3D studio', value: yesNo(input.webgl2, 'WebGL2 available', 'Still preview only (no WebGL2)') },
      ];
      return { status: 'todo', reason: 'Choose the amount of motion you are comfortable with, then mark this done.', facts };
    }
  }
}

/* ------------------------------------------------------------------ checklist ------------------------------------------------------------------ */

export function buildGuideItems(input: GuidanceInput, prefs: GuidancePrefs, now: number): GuideItem[] {
  const freshness = statusFreshness(input, now);
  return GUIDE_TOPIC_IDS.map((id) => {
    const def = TOPICS[id];
    const base = baseFor(id, input, freshness);
    const mark = prefs.marked[id];
    let status = base.status;
    let markIgnored = false;
    if (base.status === 'todo' && mark === 'done') status = 'done';
    else if (base.status !== 'done' && mark === 'skipped') status = 'skipped';
    else if (mark === 'done' && base.status !== 'done') markIgnored = true;
    return {
      id,
      title: def.title,
      summary: def.summary,
      status,
      reason: base.reason,
      facts: base.facts,
      links: def.links,
      canMarkDone: base.status === 'todo' && mark !== 'done',
      mark: mark ?? null,
      markIgnored,
    };
  });
}

export type GuideSummary = {
  done: number;
  /** Items that count toward progress: not unavailable and not skipped. */
  applicable: number;
  unavailable: number;
  skipped: number;
  blocked: number;
  unknown: number;
  /** The first item still worth doing (todo, then blocked), or null. */
  next: GuideTopicId | null;
};

export function summarizeGuide(items: GuideItem[]): GuideSummary {
  const n = (s: GuideStatus) => items.filter((i) => i.status === s).length;
  const next = items.find((i) => i.status === 'todo') ?? items.find((i) => i.status === 'blocked');
  return {
    done: n('done'),
    applicable: items.length - n('unavailable') - n('skipped'),
    unavailable: n('unavailable'),
    skipped: n('skipped'),
    blocked: n('blocked'),
    unknown: n('unknown'),
    next: next?.id ?? null,
  };
}

export function progressLabel(s: GuideSummary): string {
  const parts = [`${s.done} of ${s.applicable} done`];
  if (s.blocked) parts.push(`${s.blocked} need${s.blocked === 1 ? 's' : ''} attention`);
  if (s.unknown) parts.push(`${s.unknown} not checked`);
  if (s.unavailable) parts.push(`${s.unavailable} not available here`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  return parts.join(' · ');
}

export const STATUS_LABEL: Record<GuideStatus, string> = {
  done: 'Done',
  todo: 'To do',
  blocked: 'Needs attention',
  unavailable: 'Not available',
  unknown: 'Not checked',
  skipped: 'Skipped',
};

export const STATUS_TONE: Record<GuideStatus, 'ok' | 'info' | 'warn' | 'muted' | 'danger'> = {
  done: 'ok',
  todo: 'info',
  blocked: 'warn',
  unavailable: 'muted',
  unknown: 'muted',
  skipped: 'muted',
};

export function tourFor(id: GuideTopicId): readonly GuideTourStep[] {
  return TOPICS[id].tour;
}

/** Keeps a tour position inside 0..length-1 (0 for an empty tour or a non-number). */
export function clampStep(step: number, length: number): number {
  if (!Number.isFinite(step) || length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(step)));
}

/** Arrow-key movement inside the topic list. Returns the new index, or null when the key is not a list key. */
export function listKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const i = clampStep(index, count);
  if (key === 'ArrowDown') return (i + 1) % count;
  if (key === 'ArrowUp') return (i - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/* ------------------------------------------------------------------ preferences ------------------------------------------------------------------ */

export type GuideMark = 'done' | 'skipped';
export type GuidancePrefs = { v: 1; marked: Partial<Record<GuideTopicId, GuideMark>>; lastTopic: GuideTopicId | null; hideFinished: boolean };

/** Preference key for src/ui/prefs.ts (saved as jarvis.ui.guidance.v1). */
export const GUIDANCE_PREF_KEY = 'guidance.v1';
export const DEFAULT_GUIDANCE_PREFS: GuidancePrefs = Object.freeze({ v: 1, marked: Object.freeze({}), lastTopic: null, hideFinished: false }) as GuidancePrefs;
/** Imported preference text larger than this is refused before parsing. */
export const MAX_IMPORT_CHARS = 2048;

const PREF_KEYS = new Set(['v', 'marked', 'lastTopic', 'hideFinished']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Strict reader for stored or imported preferences. Unknown keys, unknown topics and wrong types are dropped and listed
 * in problems; the result is always a valid GuidancePrefs. Only known topic ids are copied, so no prototype key survives.
 */
export function normalizeGuidancePrefs(raw: unknown): { prefs: GuidancePrefs; problems: string[] } {
  if (raw === null || raw === undefined) return { prefs: { ...DEFAULT_GUIDANCE_PREFS, marked: {} }, problems: [] };
  const problems: string[] = [];
  if (!isPlainObject(raw)) return { prefs: { ...DEFAULT_GUIDANCE_PREFS, marked: {} }, problems: ['Preferences must be a JSON object.'] };
  for (const k of Object.keys(raw)) if (!PREF_KEYS.has(k)) problems.push(`Unknown field “${k.slice(0, 40)}”.`);
  if (raw.v !== 1) problems.push('Unsupported preference version.');
  const marked: Partial<Record<GuideTopicId, GuideMark>> = {};
  if (raw.marked !== undefined) {
    if (!isPlainObject(raw.marked)) problems.push('“marked” must be an object.');
    else {
      for (const [k, val] of Object.entries(raw.marked)) {
        if (!isTopicId(k)) problems.push(`Unknown topic “${k.slice(0, 40)}”.`);
        else if (val !== 'done' && val !== 'skipped') problems.push(`Topic “${k}” has an invalid mark.`);
        else marked[k] = val;
      }
    }
  }
  let lastTopic: GuideTopicId | null = null;
  if (raw.lastTopic !== undefined && raw.lastTopic !== null) {
    if (isTopicId(raw.lastTopic)) lastTopic = raw.lastTopic;
    else problems.push('“lastTopic” is not a known topic.');
  }
  let hideFinished = false;
  if (raw.hideFinished !== undefined) {
    if (typeof raw.hideFinished === 'boolean') hideFinished = raw.hideFinished;
    else problems.push('“hideFinished” must be true or false.');
  }
  return { prefs: { v: 1, marked, lastTopic, hideFinished }, problems };
}

export type ImportResult = { ok: true; prefs: GuidancePrefs } | { ok: false; error: string };

/** Imports pasted preference text. Unlike stored data, an import with any problem is refused as a whole. */
export function parseGuidanceImport(text: string): ImportResult {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Paste exported checklist preferences first.' };
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, error: `That text is too long (limit ${MAX_IMPORT_CHARS} characters).` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That text is not valid JSON.' };
  }
  if (raw === null) return { ok: false, error: 'Preferences must be a JSON object.' };
  const { prefs, problems } = normalizeGuidancePrefs(raw);
  if (problems.length) return { ok: false, error: `Not imported: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}` };
  return { ok: true, prefs };
}

export function exportGuidancePrefs(prefs: GuidancePrefs): string {
  const marked: Record<string, GuideMark> = {};
  for (const id of GUIDE_TOPIC_IDS) if (prefs.marked[id]) marked[id] = prefs.marked[id] as GuideMark;
  return JSON.stringify({ v: 1, marked, lastTopic: prefs.lastTopic, hideFinished: prefs.hideFinished }, null, 2);
}

export type GuideEvent =
  | { type: 'mark-done'; item: GuideItem }
  | { type: 'skip'; topic: GuideTopicId }
  | { type: 'clear-mark'; topic: GuideTopicId }
  | { type: 'select'; topic: GuideTopicId }
  | { type: 'set-hide-finished'; value: boolean }
  | { type: 'reset' };

/** Preference transitions. Mark done is refused (prefs returned unchanged) unless the item allows it right now. */
export function reduceGuidancePrefs(prefs: GuidancePrefs, event: GuideEvent): GuidancePrefs {
  switch (event.type) {
    case 'mark-done':
      if (!event.item.canMarkDone) return prefs;
      return { ...prefs, marked: { ...prefs.marked, [event.item.id]: 'done' } };
    case 'skip':
      if (!isTopicId(event.topic)) return prefs;
      return { ...prefs, marked: { ...prefs.marked, [event.topic]: 'skipped' } };
    case 'clear-mark': {
      if (!prefs.marked[event.topic]) return prefs;
      const marked = { ...prefs.marked };
      delete marked[event.topic];
      return { ...prefs, marked };
    }
    case 'select':
      return isTopicId(event.topic) && prefs.lastTopic !== event.topic ? { ...prefs, lastTopic: event.topic } : prefs;
    case 'set-hide-finished':
      return prefs.hideFinished === event.value ? prefs : { ...prefs, hideFinished: event.value === true };
    case 'reset':
      return { ...DEFAULT_GUIDANCE_PREFS, marked: {} };
  }
}

/** Items shown in the list: finished and skipped ones are hidden only when you ask for that. */
export function visibleItems(items: GuideItem[], hideFinished: boolean): GuideItem[] {
  return hideFinished ? items.filter((i) => i.status !== 'done' && i.status !== 'skipped') : items;
}

/** Which topic to show: the requested one if visible, else the first visible, else null (empty list). */
export function selectTopic(visible: GuideItem[], wanted: GuideTopicId | null): GuideTopicId | null {
  if (wanted && visible.some((i) => i.id === wanted)) return wanted;
  return visible[0]?.id ?? null;
}

/* ------------------------------------------------------------------ explainer ------------------------------------------------------------------ */

/** Plain-language comparison of the three places work can happen. Shown with the checklist and used by the privacy topic. */
export const ROUTE_EXPLAINER: readonly { id: 'on-device' | 'local-model' | 'cloud-api'; title: string; body: string }[] = [
  {
    id: 'on-device',
    title: 'On this computer, always',
    body: 'Notes, tasks, capsules, settings and this checklist are stored in the app’s own data folder. They work with no internet and no model.',
  },
  {
    id: 'cloud-api',
    title: 'Claude and other providers (online mode, your key)',
    body: 'Chat goes to Claude, or the provider you chose, with the API key you saved, and only when you send a message. Your provider may charge for it. If the key is missing or the call fails, chat shows an error; it never falls back silently.',
  },
  {
    id: 'local-model',
    title: 'Legacy local model (offline mode)',
    body: 'Only for setups from earlier versions: chat goes to Ollama running on this computer at a localhost address, and messages do not leave the computer. If it is not running, chat shows an error.',
  },
];
