// Chat routing: local Ollama (loopback only) by default; cloud only when mode is explicitly 'online' AND a key is stored.
// There is never a silent fallback in either direction. Failures become honest 'system' messages.
import type {Capability, ChatMessage, Settings} from '../../src/shared/contracts';
import type {GuardedFetch} from './netGuard';
import {NetworkDenied} from './netGuard';
import type {Store} from './store';
import type {Secrets} from './secrets';
import {validateChatText} from './validation';

const HISTORY_CHARS = 8000;
const REPLY_CAP = 60_000;
export const ANTHROPIC_VERSION = '2023-06-01';
/** How long Ollama keeps the model in memory after a reply. Short on purpose: frees RAM/VRAM soon after chatting stops. */
export const LOCAL_KEEP_ALIVE = '2m';

type Turn = {role: 'user' | 'assistant'; content: string};

export function buildHistory(chat: ChatMessage[], newUserText: string): Turn[] {
  const turns: Turn[] = [];
  let budget = HISTORY_CHARS - newUserText.length;
  for (let i = chat.length - 1; i >= 0 && budget > 0; i--) {
    const m = chat[i];
    if (m.source === 'system') continue;
    budget -= m.text.length;
    if (budget < 0) break;
    turns.unshift({role: m.role, content: m.text});
  }
  turns.push({role: 'user', content: newUserText});
  // Anthropic needs strictly alternating roles starting with user; merge neighbours and drop a leading assistant turn.
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged[merged.length - 1];
    if (last && last.role === t.role) last.content += '\n\n' + t.content;
    else merged.push({...t});
  }
  while (merged.length && merged[0].role !== 'user') merged.shift();
  return merged;
}

async function errorText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as {error?: string | {message?: string}};
    const e = typeof j.error === 'string' ? j.error : j.error?.message;
    return e ? String(e).slice(0, 160) : '';
  } catch { return ''; }
}

/** Guidance shown when the configured model is not installed. Installing a model needs a one-time download that this app never does. */
export function missingModelHelp(model: string): string {
  return `Model "${model}" is not installed in Ollama. Install it once with "ollama pull ${model}" (that download needs internet; Desktop Companion never downloads models) or choose an installed model in Settings`;
}

export async function ollamaChat(guardedFetch: GuardedFetch, settings: Settings, history: Turn[]): Promise<string> {
  const res = await guardedFetch(`${settings.localEndpoint}/api/chat`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: settings.localModel, messages: history, stream: false, keep_alive: LOCAL_KEEP_ALIVE}),
    timeoutMs: 120_000,
  }, 'ollama');
  if (!res.ok) {
    const detail = await errorText(res);
    throw new Error(res.status === 404 ? missingModelHelp(settings.localModel) : `Ollama returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const j = (await res.json()) as {message?: {content?: string}};
  const text = j.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Ollama returned an empty reply');
  return text.slice(0, REPLY_CAP);
}

export async function cloudChat(guardedFetch: GuardedFetch, settings: Settings, key: string, history: Turn[], origin = 'https://api.anthropic.com'): Promise<string> {
  const res = await guardedFetch(`${origin}/v1/messages`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION},
    body: JSON.stringify({model: settings.cloudModel, max_tokens: 1024, messages: history}),
    timeoutMs: 120_000,
  }, 'cloud-chat');
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('The cloud provider rejected the API key');
    const detail = await errorText(res);
    throw new Error(`Cloud provider returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const j = (await res.json()) as {content?: {type: string; text?: string}[]};
  const text = (j.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
  if (!text.trim()) throw new Error('The cloud provider returned an empty reply');
  return text.slice(0, REPLY_CAP);
}

export interface ChatDeps {
  store: Store;
  secrets: Pick<Secrets, 'configured' | 'reveal'>;
  fetch: GuardedFetch;
  cloudOrigin?: string;
}

function describe(e: unknown, where: 'local' | 'cloud', settings: Settings): string {
  if (e instanceof NetworkDenied) return `Blocked: ${e.message}`;
  const err = e as Error & {name?: string; cause?: {code?: string}};
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return where === 'local' ? 'Ollama did not answer in time' : 'The cloud provider did not answer in time';
  if (err?.cause?.code === 'ECONNREFUSED' || /fetch failed/i.test(err?.message ?? '')) {
    return where === 'local' ? `Ollama is not running at ${settings.localEndpoint}. Start Ollama, then try again` : 'Could not reach the cloud provider';
  }
  return String(err?.message ?? 'Unknown error').slice(0, 300);
}

export async function sendChat(deps: ChatDeps, rawText: unknown): Promise<ChatMessage> {
  const text = validateChatText(rawText);
  const state = deps.store.snapshot();
  const settings = state.settings;
  const now = () => deps.store.nowIso();
  // Online mode is the user's explicit opt-in to the cloud. Without a stored key it fails honestly; it never falls back to local.
  const routeSource: 'local' | 'cloud' = settings.mode === 'online' ? 'cloud' : 'local';
  const userMsg: ChatMessage = {id: deps.store.id(), role: 'user', text, createdAt: now(), source: routeSource};
  const history = buildHistory(state.chat, text);
  await deps.store.mutate((d) => { d.chat.push(userMsg); });
  let reply: ChatMessage;
  try {
    let out: string;
    if (routeSource === 'cloud') {
      if (!(await deps.secrets.configured())) throw new Error('No cloud API key is configured. Add a key in Settings or switch to offline mode');
      const key = await deps.secrets.reveal();
      if (!key) throw new Error('The stored API key could not be decrypted; set it again in Settings');
      out = await cloudChat(deps.fetch, settings, key, history, deps.cloudOrigin);
    } else {
      out = await ollamaChat(deps.fetch, settings, history);
    }
    reply = {id: deps.store.id(), role: 'assistant', text: out, createdAt: now(), source: routeSource};
  } catch (e) {
    const reason = describe(e, routeSource, settings);
    reply = {id: deps.store.id(), role: 'assistant', text: `${routeSource === 'cloud' ? 'Cloud' : 'Local'} model unavailable: ${reason}. No reply was generated and nothing was sent elsewhere.`, createdAt: now(), source: 'system'};
  }
  await deps.store.mutate((d) => { d.chat.push(reply); });
  return reply;
}

/** Capability probe for the local model: GET /api/tags with a short timeout. */
export async function probeLocalModel(guardedFetch: GuardedFetch, settings: Settings): Promise<Capability> {
  const base = {id: 'local-llm', name: 'Local model (Ollama)'};
  try {
    const res = await guardedFetch(`${settings.localEndpoint}/api/tags`, {timeoutMs: 1500}, 'ollama');
    if (!res.ok) return {...base, available: false, reason: `Ollama returned HTTP ${res.status}`};
    const j = (await res.json()) as {models?: {name?: string; model?: string}[]};
    const names = (j.models ?? []).map((m) => String(m.name ?? m.model ?? ''));
    const want = settings.localModel.includes(':') ? settings.localModel : `${settings.localModel}:latest`;
    if (!names.includes(want) && !names.includes(settings.localModel)) {
      return {...base, available: false, reason: `Ollama is running but model "${settings.localModel}" is not installed. Install it once with "ollama pull ${settings.localModel}"`};
    }
    return {...base, available: true};
  } catch (e) {
    if (e instanceof NetworkDenied) return {...base, available: false, reason: `Endpoint blocked: ${e.message}`};
    return {...base, available: false, reason: `Ollama is not running at ${settings.localEndpoint}`};
  }
}
