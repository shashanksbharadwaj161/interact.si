/**
 * Optional providers and connectors (roadmap 101–110, plus the requested Spotify / browser / ChatGPT / Claude).
 *
 * Pure data and pure helpers: no React, no DOM, no network, no secrets. Shared by the renderer
 * (src/components/Integrations.tsx) and the main-process service (electron/services/integrations.ts).
 *
 * Honesty rules encoded here:
 *  - A "handoff" only opens a consumer website in the default browser through the existing approved
 *    `open-url` action. It is NOT an integration: no OAuth, no sign-in, nothing is read back and no account is touched.
 *  - An "api" integration talks to a provider's documented developer API with a key the user owns.
 *    A ChatGPT or Claude consumer subscription is not an API key, and the reverse is also true.
 *  - No OAuth flow exists. Anything that needs OAuth, an owner-registered client, a provider choice, or unvalidated
 *    licensing is `setup-required` or `gated`, with the blockers listed. No status is invented.
 *  - Every item that can contact a provider is off until the user turns it on (saved durably by the main process),
 *    and each request still needs online mode and the trusted confirmation.
 */

export type IntegrationKind = 'local-model' | 'ai-provider' | 'handoff' | 'connector' | 'feed' | 'download' | 'privacy' | 'sync' | 'marketplace';

/**
 * Build availability of the definition itself (not of the user's connection).
 *  - local       : works on this device without any network.
 *  - byok        : real developer-API client exists; needs online mode and the user's own key.
 *  - keyless     : real public API client exists; needs online mode, no account or key.
 *  - handoff     : opens a website/app only. Not an integration.
 *  - setup-required : needs OAuth / an owner-registered client / a provider decision. Not usable yet.
 *  - not-built   : roadmap scope with no code path.
 *  - gated       : experimental; disabled until its gate (security review, licensing) passes.
 */
export type IntegrationAvailability = 'local' | 'byok' | 'keyless' | 'handoff' | 'setup-required' | 'not-built' | 'gated';

export type AuthScheme = 'none' | 'x-api-key' | 'bearer';

/** A connection check: one small, documented, read-only request. Responses are never shown or stored. */
export interface ApiCheck {
  /** Exact origin the request goes to. netGuard must allow this origin for `purpose`. */
  origin: string;
  path: string;
  method: 'GET';
  /** Purpose label handed to the guarded fetch. */
  purpose: string;
  auth: AuthScheme;
  /** Non-secret headers sent with the check (the key header is added separately and never logged). */
  headers?: Record<string, string>;
  /** Requires online mode. The local model check is loopback-only and works offline. */
  online: boolean;
}

export interface KeySpec {
  /** Opaque key slot name used by the key adapter. Never the key itself. */
  slot: string;
  label: string;
  /** Header that carries the key in requests. Shown in previews; the value never is. */
  header: string;
  /** Optional format hint (prefix). Used to warn, not to accept or reject. */
  prefixHint?: string;
  where: string;
  /** https page where the user creates the key. Opened only through the approved `open-url` flow; nothing is sent to it. */
  pageUrl?: string;
}

export interface HandoffSpec {
  /** https URL handed to the existing `open-url` action. */
  url: string;
  label: string;
  /** Optional: a link the user pastes, limited to these exact hosts (for example a Spotify track link). */
  userLink?: { label: string; hosts: readonly string[]; placeholder: string };
}

/** Points at a sibling item the user may confuse this one with (consumer subscription vs developer API). */
export interface RelatedIntegration { id: string; why: string }

export interface IntegrationDefinition {
  id: string;
  name: string;
  provider: string;
  kind: IntegrationKind;
  /** Roadmap scope number from docs/product-roadmap.md, or null when the request has no scope yet. */
  scope: number | null;
  tier: 'First' | 'Expansion' | 'Experimental' | 'Requested';
  availability: IntegrationAvailability;
  summary: string;
  /** What this definition explicitly is not, so the UI never over-claims. */
  notThis?: string;
  check?: ApiCheck;
  key?: KeySpec;
  handoff?: HandoffSpec;
  /** Plain list of what would leave the device when the feature is used. Empty for local-only. */
  dataLeaves: string[];
  related?: RelatedIntegration[];
  /** Concrete reasons the feature cannot be used yet. Empty when nothing blocks it. */
  blockers: string[];
  setup: string[];
}

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
export const OPENAI_API_ORIGIN = 'https://api.openai.com';
export const OPEN_METEO_ORIGIN = 'https://api.open-meteo.com';
export const GITHUB_API_ORIGIN = 'https://api.github.com';

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    id: 'ollama', name: 'Local model (Ollama)', provider: 'Ollama on this computer', kind: 'local-model', scope: 11, tier: 'First', availability: 'local',
    summary: 'Checks that a loopback Ollama server answers and lists installed models. Nothing leaves the device.',
    notThis: 'The app does not install Ollama or download models.',
    check: { origin: 'http://127.0.0.1:11434', path: '/api/tags', method: 'GET', purpose: 'ollama', auth: 'none', online: false },
    dataLeaves: [], blockers: [],
    setup: ['Install and start Ollama yourself.', 'Pull a model, then set its name in Settings.'],
  },
  {
    id: 'anthropic', name: 'Claude API (Anthropic)', provider: 'Anthropic', kind: 'ai-provider', scope: 101, tier: 'Expansion', availability: 'byok',
    summary: 'Uses your own Anthropic API key. The connection check lists models and sends no chat content.',
    notThis: 'A Claude.ai subscription is not an API key. Use the Claude website handoff for that.',
    check: { origin: ANTHROPIC_API_ORIGIN, path: '/v1/models', method: 'GET', purpose: 'provider-check', auth: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' }, online: true },
    key: { slot: 'anthropic', label: 'Anthropic API key', header: 'x-api-key', prefixHint: 'sk-ant-', where: 'Anthropic Console → API keys', pageUrl: 'https://console.anthropic.com/settings/keys' },
    dataLeaves: ['Your API key, in the x-api-key header', 'Your IP address and request time (seen by Anthropic)'],
    related: [{ id: 'claude-web', why: 'A Claude.ai subscription does not include an API key. The website item only opens claude.ai in your browser.' }],
    blockers: [],
    setup: ['Turn it on.', 'Switch to online mode.', 'Paste your Anthropic API key. It is protected with Windows DPAPI.', 'Run the connection check.'],
  },
  {
    id: 'openai', name: 'OpenAI API (ChatGPT models)', provider: 'OpenAI', kind: 'ai-provider', scope: 102, tier: 'Expansion', availability: 'byok',
    summary: 'Connection check against the OpenAI developer API with your own key. Chat through OpenAI is not wired yet.',
    notThis: 'A ChatGPT Plus/Pro subscription is not an API key, and this does not log in to chatgpt.com.',
    check: { origin: OPENAI_API_ORIGIN, path: '/v1/models', method: 'GET', purpose: 'provider-check', auth: 'bearer', online: true },
    key: { slot: 'openai', label: 'OpenAI API key', header: 'authorization', prefixHint: 'sk-', where: 'OpenAI Platform → API keys', pageUrl: 'https://platform.openai.com/api-keys' },
    dataLeaves: ['Your API key, in the Authorization header', 'Your IP address and request time (seen by OpenAI)'],
    related: [{ id: 'chatgpt-web', why: 'A ChatGPT Plus/Pro subscription does not include an API key. The website item only opens chatgpt.com in your browser.' }],
    blockers: ['Chat routing to OpenAI is not built; only the connection check exists.'],
    setup: ['Turn it on.', 'Switch to online mode.', 'Paste your OpenAI API key.', 'Run the connection check.'],
  },
  {
    id: 'claude-web', name: 'Claude website', provider: 'Anthropic', kind: 'handoff', scope: null, tier: 'Requested', availability: 'handoff',
    summary: 'Opens claude.ai in your default browser after you approve it.',
    notThis: 'Not an integration and not an account connection: no OAuth or sign-in. The app does not read the page or send anything to it.',
    handoff: { url: 'https://claude.ai/', label: 'Open claude.ai' },
    related: [{ id: 'anthropic', why: 'To use Claude inside this app you need an Anthropic API key (pay-as-you-go), which is separate from a Claude.ai plan.' }],
    dataLeaves: ['Your browser contacts claude.ai directly; the app sends nothing'], blockers: [],
    setup: ['Approve the link to open claude.ai in your default browser.', 'Sign in there yourself. The app never sees your account or conversations.'],
  },
  {
    id: 'chatgpt-web', name: 'ChatGPT website', provider: 'OpenAI', kind: 'handoff', scope: null, tier: 'Requested', availability: 'handoff',
    summary: 'Opens chatgpt.com in your default browser after you approve it.',
    notThis: 'Not an integration and not an account connection: no OAuth or sign-in. The app does not read the page or send anything to it.',
    handoff: { url: 'https://chatgpt.com/', label: 'Open chatgpt.com' },
    related: [{ id: 'openai', why: 'To use OpenAI models inside this app you need an OpenAI API key (pay-as-you-go), which is separate from a ChatGPT plan.' }],
    dataLeaves: ['Your browser contacts chatgpt.com directly; the app sends nothing'], blockers: [],
    setup: ['Approve the link to open chatgpt.com in your default browser.', 'Sign in there yourself. The app never sees your account or conversations.'],
  },
  {
    id: 'spotify-web', name: 'Spotify', provider: 'Spotify', kind: 'handoff', scope: null, tier: 'Requested', availability: 'handoff',
    summary: 'Opens the Spotify web player after you approve it. The Spotify app may take over the link if installed.',
    notThis: 'Not an integration and not an account connection: no OAuth or sign-in. No playback control, now-playing, or library access.',
    handoff: { url: 'https://open.spotify.com/', label: 'Open Spotify', userLink: { label: 'Spotify link (optional)', hosts: ['open.spotify.com'], placeholder: 'https://open.spotify.com/track/…' } },
    related: [{ id: 'spotify-api', why: 'Playback control and now-playing need a Spotify Web API connection, which does not exist yet.' }],
    dataLeaves: ['Your browser contacts open.spotify.com directly; the app sends nothing'], blockers: [],
    setup: ['Optionally paste a link from the Spotify app (Share → Copy link). Only open.spotify.com links are accepted.', 'Approve it to open that link. Windows decides whether the Spotify app or your browser handles it.', 'To start the Spotify desktop app instead, add Spotify.exe to Approved apps and use Computer → Launch.'],
  },
  {
    id: 'spotify-api', name: 'Spotify playback control', provider: 'Spotify', kind: 'connector', scope: null, tier: 'Requested', availability: 'setup-required',
    summary: 'Play/pause and now-playing through the Spotify Web API.',
    dataLeaves: ['OAuth token and playback commands, sent to api.spotify.com'],
    related: [{ id: 'spotify-web', why: 'The Spotify item opens the web player or a link you paste. It cannot control playback or read what is playing.' }],
    blockers: ['No roadmap scope covers Spotify yet.', 'Needs an OAuth (PKCE) client registered by the app owner and Spotify API terms review.', 'Playback control requires a Spotify Premium account.', 'The app has no sign-in flow, token storage or api.spotify.com network allowance; none are enabled.'],
    setup: [],
  },
  {
    id: 'browser', name: 'Default browser', provider: 'Your browser', kind: 'handoff', scope: 81, tier: 'Requested', availability: 'handoff',
    summary: 'Opens an http(s) link you enter in your default browser after approval.',
    notThis: 'Manual handoff only. There is no browser extension and no automation: tabs, profiles, history and page content are not read or controlled (roadmap 47 and 88 are planned).',
    dataLeaves: ['Your browser fetches the page directly; the app sends nothing'], blockers: [],
    setup: ['Enter an http or https link and approve it to open it in your default browser.', 'To use a different browser or profile, use "Copy link" and paste it there yourself.'],
  },
  {
    id: 'web-research', name: 'Web research with cited sources', provider: 'Not chosen', kind: 'connector', scope: 103, tier: 'Expansion', availability: 'not-built',
    summary: 'Search the web and answer with citations.',
    dataLeaves: ['Search queries, sent to the chosen search provider'],
    blockers: ['No search provider has been chosen or reviewed.', 'Citation rendering is not built.'], setup: [],
  },
  {
    id: 'calendar', name: 'Calendar accounts', provider: 'Google / Microsoft', kind: 'connector', scope: 104, tier: 'Expansion', availability: 'setup-required',
    summary: 'Read upcoming events from a calendar account.',
    dataLeaves: ['OAuth token, sent to the calendar provider', 'Event titles and times, received from the provider'],
    blockers: ['Needs OAuth clients registered by the app owner for each provider.', 'No account was or will be contacted during development.'], setup: [],
  },
  {
    id: 'issue-draft', name: 'Issue draft export', provider: 'This device', kind: 'connector', scope: 105, tier: 'Expansion', availability: 'local',
    summary: 'Formats an issue draft as Markdown you can copy. Nothing is posted.',
    dataLeaves: [], blockers: [], setup: [],
  },
  {
    id: 'issue-post', name: 'Issue posting (GitHub)', provider: 'GitHub', kind: 'connector', scope: 105, tier: 'Expansion', availability: 'byok',
    summary: 'Connection check with your own fine-grained token. Posting an issue is not built yet.',
    notThis: 'The check reads only your account login status code; nothing is posted.',
    check: { origin: GITHUB_API_ORIGIN, path: '/user', method: 'GET', purpose: 'provider-check', auth: 'bearer', headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }, online: true },
    key: { slot: 'github', label: 'GitHub fine-grained token', header: 'authorization', prefixHint: 'github_pat_', where: 'GitHub → Settings → Developer settings → Fine-grained tokens', pageUrl: 'https://github.com/settings/personal-access-tokens/new' },
    dataLeaves: ['Your token, in the Authorization header', 'Your IP address and request time (seen by GitHub)'],
    blockers: ['Approved posting (preview, trusted confirmation, then POST) is not built.'],
    setup: ['Turn it on.', 'Switch to online mode.', 'Create a fine-grained token limited to one repository with Issues: read and write.', 'Run the connection check.'],
  },
  {
    id: 'weather', name: 'Weather widget (Open-Meteo)', provider: 'Open-Meteo', kind: 'feed', scope: 106, tier: 'Expansion', availability: 'keyless',
    summary: 'Public weather API that needs no account or key. Only the connection check is built; the widget is not.',
    check: { origin: OPEN_METEO_ORIGIN, path: '/v1/forecast?latitude=0&longitude=0&current=temperature_2m', method: 'GET', purpose: 'provider-check', auth: 'none', online: true },
    dataLeaves: ['Your IP address and request time (seen by Open-Meteo)', 'The check sends fixed coordinates 0,0, not your location'],
    blockers: ['The weather widget itself is not built.'], setup: ['Turn it on.', 'Switch to online mode.', 'Run the connection check.'],
  },
  {
    id: 'news', name: 'News feed widget', provider: 'Not chosen', kind: 'feed', scope: 106, tier: 'Expansion', availability: 'not-built',
    summary: 'Headlines from a news source.', dataLeaves: ['Feed requests, sent to the chosen source'],
    blockers: ['No news source or licence has been chosen.'], setup: [],
  },
  {
    id: 'downloads', name: 'Model and update downloads', provider: 'Not chosen', kind: 'download', scope: 107, tier: 'Expansion', availability: 'not-built',
    summary: 'Optional, user-started model and app update downloads.',
    notThis: 'The app never downloads anything today.',
    dataLeaves: ['Download requests, sent to the chosen host'],
    blockers: ['No signed update channel or model source exists.', 'Needs hash/signature verification before anything is installed.'], setup: [],
  },
  {
    id: 'data-preview', name: 'Data previews and usage history', provider: 'This device', kind: 'privacy', scope: 108, tier: 'Expansion', availability: 'local',
    summary: 'Shows exactly what a request would send before it runs, and keeps a local history of provider requests (no content, no keys).',
    dataLeaves: [], blockers: [], setup: [],
  },
  {
    id: 'sync', name: 'Encrypted cross-device sync', provider: 'Not chosen', kind: 'sync', scope: 109, tier: 'Experimental', availability: 'gated',
    summary: 'End-to-end encrypted sync between your devices.',
    dataLeaves: ['Encrypted copies of your data, stored by a sync host'],
    blockers: ['Experimental: needs a cryptography and threat-model review before any code ships.', 'No sync host chosen.'], setup: [],
  },
  {
    id: 'marketplace', name: 'Community scene/widget marketplace', provider: 'Not chosen', kind: 'marketplace', scope: 110, tier: 'Experimental', availability: 'gated',
    summary: 'Share and install community scenes and widgets.',
    dataLeaves: ['Uploaded scenes, sent to a marketplace host'],
    blockers: ['Experimental: needs moderation, signing and licence review.', 'Installing third-party widgets needs a sandbox that does not exist.'], setup: [],
  },
];

export const AVAILABILITY_LABEL: Record<IntegrationAvailability, string> = {
  local: 'On this device',
  byok: 'Your key',
  keyless: 'Public API',
  handoff: 'Opens website',
  'setup-required': 'Setup required',
  'not-built': 'Not built',
  gated: 'Experimental, off',
};

export function findIntegration(id: string): IntegrationDefinition | undefined {
  return INTEGRATIONS.find((d) => d.id === id);
}

/** Integrations that can make a request (have a check) and are not gated. */
export function isCheckable(d: IntegrationDefinition): boolean {
  return !!d.check && (d.availability === 'local' || d.availability === 'byok' || d.availability === 'keyless');
}

/** True for items that can contact a provider: they stay off until the user turns them on. */
export function needsOptIn(d: IntegrationDefinition): boolean {
  return isCheckable(d) && !!d.check?.online;
}

/** Every origin + path + query the service may request. netGuard's PROVIDER_CHECKS must match the online ones exactly. */
export function egressRequirements(defs: readonly IntegrationDefinition[] = INTEGRATIONS): { id: string; origin: string; path: string; query: string; purpose: string; online: boolean; key: boolean; credentialHeader?: string }[] {
  return defs.filter((d) => d.check && isCheckable(d)).map((d) => {
    const c = d.check!;
    const q = c.path.indexOf('?');
    return {
      id: d.id, origin: c.origin, path: q < 0 ? c.path : c.path.slice(0, q), query: q < 0 ? '' : c.path.slice(q), purpose: c.purpose, online: c.online, key: !!d.key,
      ...(d.key ? { credentialHeader: d.key.header.toLowerCase() } : {}),
    };
  });
}

/** Validates a handoff URL: https (or http for the free-form browser entry), no credentials, no control characters. */
export function validateHandoffUrl(raw: string, allowHttp = false): { ok: true; url: string } | { ok: false; reason: string } {
  const s = (raw ?? '').trim();
  if (!s) return { ok: false, reason: 'Enter a link' };
  if (s.length > 2048) return { ok: false, reason: 'Link is too long' };
  if (/[\u0000-\u001f\u007f\s]/.test(s)) return { ok: false, reason: 'Link contains spaces or control characters' };
  let u: URL;
  try { u = new URL(s); } catch { return { ok: false, reason: 'Not a valid link' }; }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return { ok: false, reason: allowHttp ? 'Only http and https links can be opened' : 'Only https links can be opened' };
  if (u.username || u.password) return { ok: false, reason: 'Links with a user name or password are not allowed' };
  if (!u.hostname) return { ok: false, reason: 'Link has no host' };
  return { ok: true, url: u.href };
}

type OpenUrlAction = { type: 'open-url'; target: string };

/**
 * The existing approved-action request for a handoff. The renderer passes it to previewAction; nothing opens without approval.
 * A definition with `userLink` accepts a pasted link only on its listed hosts; the free-form browser accepts any http(s) link.
 */
export function handoffAction(d: IntegrationDefinition, userUrl?: string): { ok: true; action: OpenUrlAction } | { ok: false; reason: string } {
  if (d.availability !== 'handoff') return { ok: false, reason: `${d.name} is not a website handoff` };
  const pasted = (userUrl ?? '').trim();
  if (d.handoff?.userLink && pasted) {
    const v = validateHandoffUrl(pasted);
    if (!v.ok) return v;
    const hosts = d.handoff.userLink.hosts;
    if (!hosts.includes(new URL(v.url).hostname.toLowerCase())) return { ok: false, reason: `Only links on ${hosts.join(', ')} can be opened here` };
    return { ok: true, action: { type: 'open-url', target: v.url } };
  }
  const v = d.handoff ? validateHandoffUrl(d.handoff.url) : validateHandoffUrl(userUrl ?? '', true);
  if (!v.ok) return v;
  return { ok: true, action: { type: 'open-url', target: v.url } };
}

/** The approved-action request that opens the page where the user creates their own key. Nothing is sent to it. */
export function keyPageAction(d: IntegrationDefinition): { ok: true; action: OpenUrlAction } | { ok: false; reason: string } {
  if (!d.key?.pageUrl) return { ok: false, reason: `${d.name} has no key page` };
  const v = validateHandoffUrl(d.key.pageUrl);
  return v.ok ? { ok: true, action: { type: 'open-url', target: v.url } } : v;
}

/** Plain-language checks on a link before the user approves it. Pure; the link is never fetched. */
export function inspectLink(url: string): { host: string; notes: string[] } {
  let u: URL;
  try { u = new URL(url); } catch { return { host: '', notes: ['The link could not be read.'] }; }
  const notes: string[] = [];
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:') notes.push('This link is not encrypted (http). Anyone on your network can see the page you open.');
  if (host.split('.').some((l) => l.startsWith('xn--'))) notes.push(`The address uses an international (punycode) name, which can imitate another site. Check the host: ${host}`);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) notes.push('The address is a number, not a site name.');
  if (u.port) notes.push(`The link uses a non-standard port (${u.port}).`);
  if (u.search || u.hash) notes.push('The link carries extra data after the address (query or fragment). The site will receive it.');
  return { host, notes };
}

// ---------- key hygiene (warn, never block: the user's key is theirs) ----------

/** Well-known key prefixes. A key that starts with another provider's prefix is almost certainly pasted into the wrong place. */
const KEY_OWNERS: readonly { prefix: string; owner: string; slot: string }[] = [
  { prefix: 'sk-ant-', owner: 'an Anthropic key', slot: 'anthropic' },
  { prefix: 'github_pat_', owner: 'a GitHub token', slot: 'github' },
  { prefix: 'ghp_', owner: 'a GitHub token', slot: 'github' },
];

/** Warnings for a pasted key. Never includes the key itself. */
export function keyWarnings(d: IntegrationDefinition, raw: string): string[] {
  const spec = d.key;
  const k = (raw ?? '').trim();
  if (!spec || !k) return [];
  const out: string[] = [];
  if (/^bearer\s/i.test(k)) out.push('Paste only the key, without the word "Bearer".');
  if (/^[A-Za-z][A-Za-z0-9_]*\s*=/.test(k)) out.push('Paste only the key value, not a NAME=value line.');
  if (/^["'`]|["'`]$/.test(k)) out.push('Remove the quotes around the key.');
  if (/\s/.test(k)) out.push('The key contains spaces or line breaks; keys never do.');
  const other = KEY_OWNERS.find((o) => k.startsWith(o.prefix) && o.slot !== spec.slot);
  if (other) out.push(`This looks like ${other.owner}, not a ${spec.label}.`);
  else if (spec.prefixHint && !k.startsWith(spec.prefixHint)) out.push(`This does not look like a ${spec.label} (they usually start with ${spec.prefixHint})`);
  return out;
}

// ---------- setup progress (what is done, what is next) ----------

export interface SetupStep { id: 'turn-on' | 'online' | 'key' | 'check'; label: string; done: boolean }

/**
 * The real state of the setup steps for a checkable item, derived from the backend view and the mode.
 * Returns [] for items with no API connection. Without a view, only what the mode proves is marked done.
 */
export function setupChecklist(d: IntegrationDefinition, view: IntegrationView | undefined, mode: 'offline' | 'online'): SetupStep[] {
  if (!isCheckable(d) || !d.check) return [];
  const steps: SetupStep[] = [];
  if (needsOptIn(d)) steps.push({ id: 'turn-on', label: `Turn on ${d.name}`, done: view?.enabled === true });
  if (d.check.online) steps.push({ id: 'online', label: 'Switch to online mode', done: mode === 'online' });
  if (d.key) steps.push({ id: 'key', label: `Store your ${d.key.label}`, done: view?.keyConfigured === true });
  steps.push({ id: 'check', label: 'Run the connection check', done: view?.state === 'connected' });
  return steps;
}

// ---------- 105: local issue draft export (no network) ----------

export interface IssueDraftInput { title: string; body?: string; steps?: string[]; expected?: string; actual?: string; labels?: string[] }

const oneLine = (s: string, max: number) => s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/** Formats an issue as Markdown for copying. Pure; never posts. Throws on a missing title. */
export function formatIssueDraft(input: IssueDraftInput): string {
  const title = oneLine(input.title ?? '', 200);
  if (!title) throw new Error('An issue needs a title');
  const out = [`# ${title}`, ''];
  const body = (input.body ?? '').trim().slice(0, 20_000);
  if (body) out.push(body, '');
  const steps = (input.steps ?? []).map((s) => oneLine(s, 500)).filter(Boolean).slice(0, 50);
  if (steps.length) out.push('## Steps to reproduce', '', ...steps.map((s, i) => `${i + 1}. ${s}`), '');
  if (input.expected?.trim()) out.push('## Expected', '', input.expected.trim().slice(0, 5000), '');
  if (input.actual?.trim()) out.push('## Actual', '', input.actual.trim().slice(0, 5000), '');
  const labels = [...new Set((input.labels ?? []).map((l) => oneLine(l, 50)).filter(Boolean))].slice(0, 20);
  if (labels.length) out.push(`Labels: ${labels.join(', ')}`, '');
  return out.join('\n').trimEnd() + '\n';
}

// ---------- renderer-safe bridge types (no secret ever travels main → renderer) ----------

export type ConnectionState =
  | 'local-ready'      // local definition; nothing to connect
  | 'turned-off'       // can contact a provider, but the user has not turned it on
  | 'handoff'          // website/app handoff only
  | 'gated' | 'setup-required' | 'not-built'
  | 'offline'          // needs online mode
  | 'needs-key'        // online, key missing
  | 'ready-to-check'   // can run a check; none run this session
  | 'connected'        // last check in this session succeeded
  | 'check-failed';    // last check in this session failed

export interface CheckResult {
  id: string; ok: boolean; at: string; status?: number; reason?: string; detail?: string;
  /** One plain next step for a failed check. Fixed text written by the service; never contains request data. */
  hint?: string;
}

/** Where on/off choices live: a durable main-process store, no store wired, or a store that failed to read. */
export type ChoiceStorage = 'saved' | 'not-connected' | 'unreadable';

export interface IntegrationView {
  id: string;
  state: ConnectionState;
  keyConfigured: boolean;
  /** User opt-in for items that contact a provider (always false for others). */
  enabled: boolean;
  choiceStorage: ChoiceStorage;
  lastCheck?: CheckResult;
  /** Outcome of the last check in an earlier session (saved by the main process). Shown as history, never as "connected". */
  previousCheck?: Pick<CheckResult, 'id' | 'ok' | 'at' | 'status' | 'reason'>;
}

/** Shown before any request. Lists every header name and field that leaves; never a value of a secret. */
export interface EgressPreview {
  id: string;
  allowed: boolean;
  reason?: string;
  destination: string;
  method: string;
  path: string;
  headerNames: string[];
  keySent: boolean;
  keyHeader?: string;
  bodyBytes: number;
  dataLeaves: string[];
  response: string;
}

export interface UsageEntry { id: string; at: string; op: 'check'; origin: string; ok: boolean; status?: number; reason?: string }

/** What the captain exposes to the renderer over IPC. Every method validates in the main process. */
export interface IntegrationsBridge {
  list(): Promise<IntegrationView[]>;
  preview(id: string): Promise<EgressPreview>;
  /** Main process shows a trusted confirmation (Cancel default) before sending. */
  check(id: string): Promise<CheckResult>;
  /** One-way: the key goes renderer → main, is protected, and is never returned. Main confirms first. */
  setKey(id: string, key: string): Promise<{ configured: boolean; warning?: string }>;
  removeKey(id: string): Promise<{ configured: boolean }>;
  /** Turns a provider item on/off. Main saves it durably first and refuses when no store is wired. */
  setEnabled(id: string, enabled: boolean): Promise<IntegrationView>;
  usage(): Promise<UsageEntry[]>;
  clearUsage(): Promise<void>;
}
