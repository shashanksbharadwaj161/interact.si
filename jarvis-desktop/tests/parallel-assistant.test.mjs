// Assistant conversation UX: bounded rendering, visible route/key/privacy state, send gating, retry, stale-stream guards and
// accessible stop control. Pure helpers are tested directly; the real Assistant component is server-rendered against a fake
// store whose chat/stream methods THROW, so a provider request can never happen here. No DOM, network, Electron or desktop input.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { phosphorIconNames } from './helpers/icon-stub.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Icons render as nothing; the names come from the real phosphor imports in src/.
const ICONS = await phosphorIconNames(root);
const STORE_STUB = `
  export function useReady() { return globalThis.__fakeStore(); }
  export function useOptionalStore() { return null; }
  export function useStore() { return globalThis.__fakeStore(); }
`;

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'parallel-assistant-entry.tsx',
    loader: 'tsx',
    contents: `
      export * as A from './src/components/Assistant.tsx';
      export * as companion from './src/ui/companion.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  loader: { '.css': 'empty' },
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'stub' }));
      b.onResolve({ filter: /\/ui\/store$/ }, () => ({ path: 'store', namespace: 'stub' }));
      b.onLoad({ filter: /^icons$/, namespace: 'stub' }, () => ({ contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n'), loader: 'js' }));
      b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ contents: STORE_STUB, loader: 'js' }));
    },
  }],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { A, companion, createElement: h, renderToStaticMarkup } = mod;

let providerCalls = 0;
const forbidden = (name) => async () => { providerCalls++; throw new Error(`${name} must not be called by this test`); };
const msg = (id, role, text, source = role === 'user' ? 'local' : 'local') => ({ id, role, text, source, createdAt: '2026-10-15T10:00:00.000Z' });

function fakeStore({ chat = [], online = false, cloudConfigured = false, routeOk = true, reason, endpoint = 'http://127.0.0.1:11434', streaming = true, plannerReady = true } = {}) {
  const cap = (id, available, why) => ({ id, available, reason: why });
  globalThis.__fakeStore = () => ({
    api: {
      getApiInfo: async () => ({ features: [{ id: 'chat-streaming', available: streaming }, { id: 'chat-cancel', available: streaming }] }),
      chat: forbidden('chat'), chatStreamStart: forbidden('chatStreamStart'), chatStreamCancel: forbidden('chatStreamCancel'), onChatStream: forbidden('onChatStream'),
      ...(plannerReady ? { planIntent: forbidden('planIntent') } : {}),
    },
    state: { chat },
    settings: { mode: online ? 'online' : 'offline', localModel: 'qwen-test', localEndpoint: endpoint, cloudModel: 'claude-test', voice: '' },
    cloudConfigured, run: async () => undefined, toast: () => undefined, reload: async () => undefined,
    system: { capabilities: [cap(online ? 'cloud' : 'local-llm', routeOk, routeOk ? undefined : reason ?? 'Ollama is not running'), cap('local-llm', true), cap('tts', false, 'off'), cap('stt', false, 'off')] },
    systemLoading: false, systemError: null, refreshSystem: async () => undefined,
  });
}
function render(opts) {
  fakeStore(opts);
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const data = new Map();
  Object.defineProperty(globalThis, 'window', { value: { localStorage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }, addEventListener() {}, removeEventListener() {} }, configurable: true, writable: true });
  try { return renderToStaticMarkup(h(companion.CompanionProvider, null, h(A.Assistant))); } finally { if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window; }
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sendButton = (html) => /<button[^>]*type="submit"[^>]*>/.exec(html)?.[0] ?? '';

/* ------------------------------ bounded rendering ------------------------------ */

test('headOf/tailOf never split a surrogate pair and return short text unchanged', () => {
  const s = 'ab😀cd';
  assert.equal(A.headOf(s, 10), s);
  assert.equal(A.tailOf(s, 10), s);
  assert.equal(A.headOf(s, 3), 'ab', 'limit lands inside the emoji: the pair is dropped whole');
  assert.equal(A.headOf(s, 4), 'ab😀');
  assert.equal(A.tailOf(s, 3), 'cd'.length === 2 ? 'cd' : '', 'tail starting at the low surrogate drops the broken half');
  assert.equal(A.tailOf(s, 4), '😀cd');
  for (let n = 0; n <= s.length; n++) { for (const x of [A.headOf(s, n), A.tailOf(s, n)]) assert.doesNotMatch(x, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, `no lone surrogate at ${n}`); }
});

test('boundMessage folds only long messages, keeps the full text one step away and never alters it', () => {
  const short = 'x'.repeat(A.MESSAGE_PREVIEW_CHARS);
  assert.deepEqual(A.boundMessage(short, false), { shown: short, tail: '', hidden: 0, total: short.length });
  const long = 'y'.repeat(A.MESSAGE_PREVIEW_CHARS + 5000);
  const folded = A.boundMessage(long, false);
  assert.equal(folded.shown.length, A.MESSAGE_PREVIEW_CHARS);
  assert.equal(folded.hidden, 5000);
  assert.equal(folded.total, long.length);
  const open = A.boundMessage(long, true);
  assert.equal(open.shown, long, 'expanded view is the exact stored text');
  assert.equal(open.hidden, 0);
});

test('a trailing Sources block stays visible when a long message is folded', () => {
  const sources = '\nSources:\n[1] note:7f3a "Quarterly plan"\n[2] https://example.com/a?b=1&c=2';
  const long = 'z'.repeat(A.MESSAGE_PREVIEW_CHARS + 3000) + sources;
  const b = A.boundMessage(long, false);
  assert.equal(b.tail, sources.slice(1), 'tail is the Sources block without the leading newline');
  assert.match(b.tail, /\[1\] note:7f3a/);
  assert.match(b.tail, /\[2\] https:\/\/example\.com/);
  assert.equal(b.shown.length + b.hidden + b.tail.length, long.length, 'every character is either shown, in the tail, or counted as folded');
  // A "Sources:" mention that is inside the visible beginning, or a huge trailing block, is not special-cased.
  const early = 'Sources: none\n' + 'q'.repeat(A.MESSAGE_PREVIEW_CHARS + 10);
  assert.equal(A.boundMessage(early, false).tail, '');
  const huge = 'a'.repeat(A.MESSAGE_PREVIEW_CHARS + 10) + '\nSources:\n' + 'b'.repeat(A.CITATION_TAIL_CHARS + 50);
  assert.equal(A.boundMessage(huge, false).tail, '');
});

test('boundDraft draws only the latest part of a long live reply and says how much is not drawn', () => {
  const draft = 'a'.repeat(20_000) + 'THE-END';
  const d = A.boundDraft(draft);
  assert.equal(d.shown.length, A.LIVE_VIEW_CHARS);
  assert.ok(d.shown.endsWith('THE-END'));
  assert.equal(d.hidden, draft.length - A.LIVE_VIEW_CHARS);
  assert.deepEqual(A.boundDraft('short'), { shown: 'short', hidden: 0, total: 5 });
});

test('windowMessages draws the most recent messages and reveals the rest on request', () => {
  const chat = Array.from({ length: 250 }, (_, i) => i);
  const w = A.windowMessages(chat, false);
  assert.equal(w.visible.length, A.MAX_RENDERED_MESSAGES);
  assert.equal(w.hidden, 50);
  assert.equal(w.visible[0], 50);
  assert.equal(w.visible.at(-1), 249);
  assert.deepEqual(A.windowMessages(chat, true), { visible: chat, hidden: 0 });
  assert.equal(A.windowMessages(chat.slice(0, 10), false).hidden, 0);
});

test('the live draft cap still applies to the reducer and stale generations stay ignored', () => {
  const live = { streamId: 's', generation: 3, route: 'local', status: 'streaming', text: '' };
  const ev = (o) => ({ streamId: 's', generation: 3, seq: 0, ...o });
  const big = A.applyStreamEvent(live, ev({ type: 'delta', text: 'q'.repeat(A.MAX_LIVE_CHARS + 500) })).live;
  assert.equal(big.text.length, A.MAX_LIVE_CHARS);
  assert.equal(A.applyStreamEvent(big, { ...ev({ type: 'delta', text: 'late' }), generation: 2 }).live, big);
  assert.equal(A.applyStreamEvent(big, ev({ type: 'delta', text: 'x' })).live.text.length, A.MAX_LIVE_CHARS, 'further text cannot grow the draft past the cap');
});

test('isNearBottom follows new text only while the reader is at the end', () => {
  assert.equal(A.isNearBottom({ scrollTop: 952, clientHeight: 400, scrollHeight: 1400 }), true);
  assert.equal(A.isNearBottom({ scrollTop: 1000, clientHeight: 400, scrollHeight: 1400 }), true);
  assert.equal(A.isNearBottom({ scrollTop: 300, clientHeight: 400, scrollHeight: 1400 }), false, 'scrolled up to read: do not yank back');
});

/* ------------------------------ route / key / privacy state ------------------------------ */

test('routeState: loopback local model is described as staying on this computer, with no cloud fallback', () => {
  const r = A.routeState({ online: false, model: 'qwen', endpoint: 'http://127.0.0.1:11434', configured: true, reason: '', cloudConfigured: null });
  assert.equal(r.route, 'Local model');
  assert.equal(r.tone, 'ok');
  assert.equal(r.key, null);
  assert.match(r.privacy, /stay on this computer/);
  assert.match(r.privacy, /No cloud model is used and none is tried/);
  assert.equal(r.ready, true);
});

test('routeState: a non-loopback local endpoint is named and flagged, never called private', () => {
  const r = A.routeState({ online: false, model: 'm', endpoint: 'http://192.168.1.20:11434', configured: true, reason: '', cloudConfigured: null });
  assert.equal(r.tone, 'warn');
  assert.match(r.privacy, /192\.168\.1\.20/);
  assert.match(r.privacy, /not this computer/);
  assert.doesNotMatch(r.privacy, /stay on this computer/);
  assert.equal(A.routeState({ online: false, model: 'm', endpoint: 'http://localhost:11434', configured: true, reason: '', cloudConfigured: null }).tone, 'ok');
  assert.equal(A.routeState({ online: false, model: 'm', endpoint: 'http://[::1]:11434', configured: true, reason: '', cloudConfigured: null }).tone, 'ok');
});

test('routeState: cloud route states the destination, key state and that nothing is sent before Send', () => {
  const saved = A.routeState({ online: true, model: 'claude-x', endpoint: 'http://127.0.0.1:1', configured: true, reason: '', cloudConfigured: true });
  assert.equal(saved.route, 'Cloud model');
  assert.equal(saved.tone, 'warn', 'a message that leaves the computer is never shown as plain green');
  assert.match(saved.key, /saved/);
  assert.doesNotMatch(saved.key, /sk-|[A-Za-z0-9]{20,}/, 'the key state never contains key material');
  assert.match(saved.privacy, /leaves this computer/);
  assert.match(saved.privacy, /Nothing is sent until you press Send/);
  assert.equal(saved.where, 'api.anthropic.com');
  const none = A.routeState({ online: true, model: 'claude-x', endpoint: undefined, configured: false, reason: 'No API key saved', cloudConfigured: false });
  assert.equal(none.tone, 'danger');
  assert.equal(none.ready, false);
  assert.equal(none.blocker, 'No API key saved');
  assert.match(none.key, /not saved/);
  assert.match(A.routeState({ online: true, model: '', endpoint: undefined, configured: false, reason: 'x', cloudConfigured: null }).key, /not checked/);
  assert.equal(A.routeState({ online: true, model: ' ', endpoint: undefined, configured: false, reason: 'x', cloudConfigured: null }).model, 'not set');
});

test('endpointHost tolerates junk', () => {
  assert.equal(A.endpointHost('http://Example.COM:8/x'), 'example.com');
  assert.equal(A.endpointHost('not a url'), null);
  assert.equal(A.endpointHost(undefined), null);
});

/* ------------------------------ send gating, retry, announcements ------------------------------ */

const base = { mode: 'chat', text: 'hi', locked: false, pending: false, live: false, settling: false, transcribing: false, configured: true, routeReason: 'Ollama is not running', plannerReady: true, stepBusy: false };

test('sendBlocker names the reason in priority order and is null only when a click would be accepted', () => {
  assert.equal(A.sendBlocker(base), null);
  assert.match(A.sendBlocker({ ...base, text: '  ' }), /Type a message/);
  assert.match(A.sendBlocker({ ...base, transcribing: true }), /transcript/);
  for (const k of ['pending', 'live', 'locked']) assert.match(A.sendBlocker({ ...base, [k]: true }), /reply is in progress/, `${k} blocks a second send`);
  assert.match(A.sendBlocker({ ...base, settling: true }), /Saving the last reply/);
  assert.equal(A.sendBlocker({ ...base, configured: false }), 'Ollama is not running', 'the backend reason is shown, not a generic one');
  assert.equal(A.sendBlocker({ ...base, mode: 'command' }), null);
  assert.match(A.sendBlocker({ ...base, mode: 'command', stepBusy: true }), /command/);
  assert.equal(A.sendBlocker({ ...base, mode: 'command', plannerReady: false }), A.PLANNER_UNAVAILABLE);
  assert.equal(A.sendBlocker({ ...base, mode: 'command', pending: true }), null, 'a chat reply in flight does not block planning a desktop command');
});

test('retryCandidate offers the unanswered user message only for failures at the end of the chat, never after a user stop', () => {
  const u = msg('u1', 'user', 'what is on my list?');
  const sys = (id, text) => msg(id, 'assistant', text, 'system');
  assert.deepEqual(A.retryCandidate([u, sys('s', 'Local model unavailable: Ollama is not running. No reply was generated and no other model was tried.')]), { text: 'what is on my list?', why: 'no reply was generated' });
  assert.deepEqual(A.retryCandidate([u, msg('a', 'assistant', 'partial'), sys('s', 'The connection ended before the reply was finished. What arrived is saved above.')]), { text: 'what is on my list?', why: 'the reply was cut off' });
  assert.equal(A.retryCandidate([u, msg('a', 'assistant', 'partial'), sys('s', 'Stopped by you. The partial reply above is saved.')]), null, 'a reply the user stopped is not a failure to retry');
  assert.equal(A.retryCandidate([u, msg('a', 'assistant', 'a full answer')]), null);
  assert.equal(A.retryCandidate([u]), null, 'the message is still being answered or was just sent');
  assert.equal(A.retryCandidate([]), null);
  assert.equal(A.retryCandidate([sys('s', 'Cloud model unavailable: Could not reach the cloud provider. No reply was generated.')]), null, 'no user message to resend');
  assert.equal(A.retryCandidate([u, sys('s', 'Cloud model unavailable: x. No reply was generated.'), msg('u2', 'user', 'later')]), null, 'an older failure is not offered once the conversation moved on');
  assert.equal(A.retryCandidate([msg('u3', 'user', 'x'.repeat(4001)), sys('s', 'Local model unavailable: down. No reply was generated.')]), null, 'text over the composer limit is not resent');
});

test('liveAnnouncement speaks on state changes only', () => {
  assert.match(A.liveAnnouncement(null, 'connecting'), /Waiting for the model/);
  assert.match(A.liveAnnouncement('connecting', 'streaming'), /being written/);
  assert.equal(A.liveAnnouncement('streaming', 'streaming'), '', 'no announcement per streamed chunk');
  assert.match(A.liveAnnouncement('streaming', 'stopping'), /Stopping/);
  const done = (o) => ({ type: 'done', streamId: 's', generation: 1, seq: 9, outcome: o });
  assert.equal(A.liveAnnouncement('streaming', null, done('complete')), 'Reply finished.');
  assert.equal(A.liveAnnouncement('stopping', null, done('cancelled')), 'Reply stopped.');
  assert.match(A.liveAnnouncement('streaming', null, done('truncated')), /length limit/);
  assert.match(A.liveAnnouncement('streaming', null, done('failed')), /did not answer/);
  assert.match(A.liveAnnouncement('streaming', null, { type: 'lost', streamId: 's', generation: 1, seq: 1, reason: 'gone' }), /interrupted/);
});

/* ------------------------------ the real component (server-rendered) ------------------------------ */

test('Assistant: offline route strip shows model, endpoint and the local privacy statement; Send stays off with an empty box', () => {
  const html = render({});
  assert.match(html, /aria-label="Where this message goes"/);
  assert.match(html, /Local model/);
  assert.match(html, /qwen-test/);
  assert.match(html, /http:\/\/127\.0\.0\.1:11434/);
  assert.match(html, /Messages stay on this computer/);
  assert.match(html, /aria-describedby="route-privacy"/, 'the message box points at the privacy statement');
  assert.match(sendButton(html), /disabled/);
  assert.match(html, /role="status"[^>]*aria-live="polite"/, 'a polite status region exists for state announcements');
  assert.equal(providerCalls, 0);
});

test('Assistant: cloud mode without a key shows the key state, the destination and why sending is off, with no local fallback', () => {
  const html = render({ online: true, cloudConfigured: false, routeOk: false, reason: 'No API key is saved' });
  assert.match(html, /Cloud model/);
  assert.match(html, /claude-test/);
  assert.match(html, /api\.anthropic\.com/);
  assert.match(html, /API key: not saved/);
  assert.match(html, /Sending is off: No API key is saved/);
  assert.match(html, /leaves this computer/);
  assert.doesNotMatch(html, /Messages stay on this computer/);
  const strip = html.slice(html.indexOf('aria-label="Where this message goes"'), html.indexOf('class="sr-only"'));
  assert.ok(strip.length > 100);
  assert.doesNotMatch(strip, /qwen-test|127\.0\.0\.1|Local model/, 'the route strip never offers the local model as an alternative');
  assert.match(sendButton(html), /disabled/);
  const ok = render({ online: true, cloudConfigured: true });
  assert.match(ok, /API key: saved on this computer \(never shown here\)/);
  assert.match(ok, /Nothing is sent until you press Send/);
});

test('Assistant: a long stored message is folded with an accessible expander and its full text is not dropped from the DOM contract', () => {
  const body = 'BEGIN ' + 'w'.repeat(A.MESSAGE_PREVIEW_CHARS + 2000) + ' VERY-END';
  const html = render({ chat: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', body)] });
  assert.match(html, /BEGIN/);
  assert.doesNotMatch(html, /VERY-END/, 'the folded middle/end is not rendered by default');
  assert.ok(html.includes(`aria-expanded="false"><span>Show all ${body.length.toLocaleString()} characters`));
  assert.equal(A.boundMessage(body, true).shown, body, 'expanding yields every character');
});

test('Assistant: citations at the end of a long answer stay visible while the middle is folded', () => {
  const body = 'Answer ' + 'p'.repeat(A.MESSAGE_PREVIEW_CHARS + 1500) + '\nSources:\n[1] note:abc "Plan" <b>\n[2] https://example.com/x?a=1&b=2';
  const html = render({ chat: [msg('a1', 'assistant', body)] });
  assert.match(html, /Sources:/);
  assert.ok(html.includes(esc('[1] note:abc "Plan" <b>')), 'citation text is rendered verbatim and escaped, not parsed as markup');
  assert.ok(html.includes(esc('https://example.com/x?a=1&b=2')));
  assert.match(html, /The sources at the end are kept visible/);
});

test('Assistant: short answers with citations render untouched', () => {
  const body = 'Your list has two items [1][2].\n\nSources:\n[1] task:12\n[2] note:9';
  const html = render({ chat: [msg('a1', 'assistant', body)] });
  assert.ok(html.includes(esc(body)));
  assert.doesNotMatch(html, /Show all/);
});

test('Assistant: only the most recent messages are drawn when the chat is very long', () => {
  const chat = Array.from({ length: A.MAX_RENDERED_MESSAGES + 25 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', `message-number-${i}-end`));
  const html = render({ chat });
  assert.match(html, /25 earlier messages are saved but not drawn/);
  assert.match(html, /Show earlier messages/);
  assert.doesNotMatch(html, /message-number-0-end/);
  assert.doesNotMatch(html, /message-number-24-end/);
  assert.match(html, /message-number-25-end/);
  assert.match(html, new RegExp(`message-number-${chat.length - 1}-end`));
});

test('Assistant: a failed reply shows a typed note and an explicit Retry that says it re-sends and adds the message again', () => {
  const chat = [msg('u1', 'user', 'summarise my day'), msg('s1', 'assistant', 'Local model unavailable: Ollama is not running at http://127.0.0.1:11434. No reply was generated and no other model was tried.', 'system')];
  const html = render({ chat });
  assert.match(html, /Local model unavailable/);
  assert.match(html, /Send the last message again\?/);
  assert.match(html, /adds your message to the conversation a second time/);
  assert.match(html, /Nothing is sent unless you press Retry/);
  assert.match(html, /<button[^>]*>[^<]*(?:<[^>]*>)*Retry/);
  assert.equal(providerCalls, 0, 'rendering never sends');
  const down = render({ chat, routeOk: false, reason: 'Ollama is not running' });
  assert.match(down, /Unavailable: AI is not connected\. Connect Claude/, 'offline without an answering legacy model says what to do, not why a local model failed');
  assert.match(down, /<button[^>]*disabled[^>]*>[^<]*(?:<[^>]*>)*Retry/, 'Retry is disabled while the route is unavailable');
});

test('Assistant: no Retry offer after a user stop or after a normal answer', () => {
  const u = msg('u1', 'user', 'hello');
  assert.doesNotMatch(render({ chat: [u, msg('a1', 'assistant', 'partial'), msg('s1', 'assistant', 'Stopped by you. The partial reply above is saved.', 'system')] }), /Send the last message again/);
  assert.doesNotMatch(render({ chat: [u, msg('a1', 'assistant', 'hi there')] }), /Send the last message again/);
});

test('Assistant: Clear conversation and push-to-talk are available at rest; no provider request is made by rendering any state', () => {
  const html = render({ chat: [msg('u1', 'user', 'a')] });
  assert.doesNotMatch(/<button[^>]*>[^<]*(?:<[^>]*>)*Clear conversation/.exec(html)?.[0] ?? '', /disabled/);
  assert.equal(providerCalls, 0);
});

/* ------------------------------ wiring that needs a browser to exercise: checked in the source ------------------------------ */

const src = readFileSync(path.join(root, 'src/components/Assistant.tsx'), 'utf8');

test('wiring: one synchronous send lock, a stream sequence guard, Esc to stop and a stop watchdog are in place', () => {
  assert.match(src, /const sendLock = useRef\(false\)/);
  assert.match(src, /if \(!text \|\| sendLock\.current \|\| pending !== null \|\| live !== null \|\| settling/, 'a second send in the same tick is refused before any state update lands');
  assert.match(src, /sendLock\.current = true;\r?\n/);
  assert.equal((src.match(/sendLock\.current = false/g) ?? []).length >= 3, true, 'the lock is released on every exit path (error, finally, finish)');
  assert.match(src, /seq !== streamSeq\.current/, 'late events and late finishes from an older stream are dropped');
  assert.match(src, /e\.key === 'Escape' && liveRef\.current/);
  assert.match(src, /aria-keyshortcuts="Escape"/);
  assert.match(src, /STOP_CONFIRM_MS/);
  assert.match(src, /Stop again/);
  assert.match(src, /disabled=\{state\.chat\.length === 0 \|\| replyBusy\}/, 'the conversation cannot be cleared underneath a reply in flight');
});

test('wiring: the stream path only starts from an explicit send or Retry click, never from an effect', () => {
  const calls = [...src.matchAll(/chatStreamStart!?\(|api\.chat\(/g)].length;
  assert.equal(calls, 2, 'exactly the streamed and the non-streamed send call sites');
  assert.doesNotMatch(src, /useEffect\([^)]*\)\s*=>\s*\{[^}]*(?:sendChat|sendStreamed|sendAgain)\(/);
  assert.match(src, /const sendAgain = \(\) => \{ if \(retry\) void sendChat\(retry\.text, false\); \};/);
  assert.match(src, /fromComposer/);
});

test('wiring: no silent fallback between routes in the Assistant source', () => {
  assert.doesNotMatch(src, /settings\.mode\s*=(?!=)|saveSettings\(|mode:\s*'(?:offline|online)'/, 'the Assistant never switches mode itself');
});
