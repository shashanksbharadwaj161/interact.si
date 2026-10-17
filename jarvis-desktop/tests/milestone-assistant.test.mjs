// Milestone: Assistant and Computer flows checked against the real merged backend (createBackend) with injected
// native/shell/fetch/confirm mocks. No real desktop input, no network, no Electron. The renderer helpers are bundled
// in memory; CommandFlow is rendered to static markup (no DOM needed) to check what the user is actually told.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import { phosphorIconNames } from './helpers/icon-stub.mjs';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function bundle(contents, extra = {}) {
  const out = await build({stdin: {contents, resolveDir: root, loader: 'ts', sourcefile: 'milestone-assistant-entry.ts'}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['react', 'react-dom', 'react-dom/server'], ...extra});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles.find((f) => !f.path.endsWith('.css')).text)(require, mod, mod.exports);
  return mod.exports;
}

// Icons render as nothing; the names come from the real phosphor imports in src/.
const ICONS = await phosphorIconNames(root);
const backendMod = await bundle(`export {createBackend} from './electron/backend';`);
const ui = await bundle(`
  export {planCommand, previewCommand, decideCommand, classifyReply, incompleteReplyIds, unavailableDetail, notRunCause, explainNotRun, CommandFlow, PREVIEW_VALID_MS} from './src/components/Assistant';
  export {formFromRequest} from './src/components/Computer';
`, {
  jsx: 'automatic',
  loader: {'.css': 'empty'},
  plugins: [{name: 'icon-stub', setup(b) {
    b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
    b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: ICONS.map((n) => `export const ${n} = () => null;`).join(String.fromCharCode(10)), loader: 'js'}));
  }}],
});
const {renderToStaticMarkup} = require('react-dom/server');
const {createElement} = require('react');

const {createBackend} = backendMod;
const WIN = {hwnd: 12, pid: 23, process: 'notepad.exe', title: 'Note', x: 0, y: 0, width: 500, height: 500, foreground: true, minimized: false, maximized: false, elevated: 0};

async function fixture({confirm, fetchImpl} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-milestone-assistant-'));
  const log = {typed: [], focused: [], confirms: []};
  let decision = false;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {listWindows: async () => [WIN], focusWindow: async (t) => { log.focused.push(t); return {focused: true}; }, typeText: async (...a) => { log.typed.push(a); return {typed: 1}; }, moveWindow: async () => ({}), dpapi: async () => ({ok: true})},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    confirm: confirm ?? (async (summary, detail) => { log.confirms.push({summary, detail}); return decision; }),
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    fetchImpl: async (url, init) => { if (!fetchImpl) throw Object.assign(new Error('fetch failed'), {cause: {code: 'ECONNREFUSED'}}); return fetchImpl(String(url), init); },
  });
  return {b, log, setDecision: (v) => { decision = v; }, async close() { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}

const render = (step, busy = null) => renderToStaticMarkup(createElement(ui.CommandFlow, {step, busy, onPreview() {}, onDecide() {}, onDismiss() {}}));

// ---------- chat: model unavailable / provider errors are typed, honest and never answered by another model ----------

test('local model down: backend stores a typed system note, UI classifies it, nothing falls back to the cloud', async () => {
  const f = await fixture();
  try {
    const reply = await f.b.chat('hello there');
    assert.equal(reply.source, 'system');
    assert.equal(ui.classifyReply(reply), 'unavailable');
    const d = ui.unavailableDetail(reply.text);
    assert.equal(d.route, 'Local');
    assert.match(d.reason, /Ollama is not running/);
    assert.match(reply.text, /no other model was tried/i);
    const chat = (await f.b.getState()).chat;
    assert.deepEqual(chat.map((m) => m.role), ['user', 'assistant']);
    assert.equal(ui.classifyReply(chat[0]), 'answer', 'a user message is never typed as a system note');
    const cap = (await f.b.getSystemInfo()).capabilities.find((c) => c.id === 'local-llm');
    assert.equal(cap.available, false, 'the route capability the Assistant gates Send on is unavailable too');
    assert.ok(cap.reason);
  } finally { await f.close(); }
});

test('online mode without a key: typed as cloud unavailable, message not sent', async () => {
  const f = await fixture();
  try {
    f.setDecision(true); // changing the AI connection needs the trusted native confirmation
    await f.b.saveSettings({mode: 'online'});
    const reply = await f.b.chat('hi');
    assert.equal(ui.classifyReply(reply), 'unavailable');
    assert.equal(ui.unavailableDetail(reply.text).route, 'Cloud');
    assert.match(reply.text, /Your message was not sent\./);
    assert.equal((await f.b.getSystemInfo()).capabilities.find((c) => c.id === 'cloud').available, false);
  } finally { await f.close(); }
});

test('a local provider HTTP error is a typed unavailable note carrying the provider reason', async () => {
  const f = await fixture({fetchImpl: async () => new Response('boom', {status: 500})});
  try {
    const reply = await f.b.chat('hi');
    assert.equal(ui.classifyReply(reply), 'unavailable');
    assert.match(ui.unavailableDetail(reply.text).reason, /HTTP 500/);
  } finally { await f.close(); }
});

test('classifyReply recognises the backend cancellation and incomplete notes; partial replies are flagged', () => {
  const stopped = {id: 's', role: 'assistant', source: 'system', text: 'Stopped by you. The reply above is incomplete. Your message was not sent to any cloud provider.'};
  const cut = {id: 'c', role: 'assistant', source: 'system', text: 'The connection ended before the reply was finished. The reply above is incomplete and no other model was tried. Your message was not sent to any cloud provider.'};
  const noReply = {id: 'n', role: 'assistant', source: 'system', text: 'Stopped by you. No reply was generated. Your message was not sent to any cloud provider.'};
  const other = {id: 'o', role: 'assistant', source: 'system', text: 'Something else'};
  assert.deepEqual([stopped, cut, noReply, other].map(ui.classifyReply), ['stopped', 'incomplete', 'stopped', 'note']);
  assert.equal(ui.classifyReply({id: 'a', role: 'assistant', source: 'local', text: 'Stopped by you. is a phrase a model may write'}), 'answer', 'a model reply is never typed from its text');
  const user = {id: 'u', role: 'user', source: 'local', text: 'q'};
  const partial = {id: 'p', role: 'assistant', source: 'local', text: 'Once upon'};
  assert.deepEqual([...ui.incompleteReplyIds([user, partial, stopped, {...user, id: 'u2'}, noReply])], ['p']);
  assert.equal(ui.incompleteReplyIds([user, noReply]).size, 0, 'no partial reply, nothing to flag');
  assert.equal(ui.unavailableDetail('Stopped by you.'), null);
});

// ---------- intent → preview → trusted native confirm → typed outcome, against the real backend ----------

test('intent preview uses the backend: preview sends no input; a cancelled native confirm is a typed not-run; approval runs once', async () => {
  const f = await fixture();
  try {
    const api = f.b;
    const planned = await ui.planCommand(api, 'type "hello there" into "Note"', false);
    assert.equal(planned.plan.status, 'ready');
    const [choice] = [{request: planned.plan.request}];
    const previewed = await ui.previewCommand(api, planned, choice.request);
    assert.equal(previewed.preview.allowed, true);
    assert.deepEqual([f.log.typed.length, f.log.focused.length, f.log.confirms.length], [0, 0, 0], 'planning and preview never type, focus or ask');

    f.setDecision(false);
    const declined = await ui.decideCommand(api, previewed, true);
    assert.equal(declined.outcome.kind, 'not-run');
    assert.equal(declined.outcome.cause, 'declined');
    assert.match(declined.outcome.message, /Native confirmation declined/, 'backend wording is preserved');
    assert.match(ui.explainNotRun(declined.outcome.message), /Nothing ran/);
    assert.equal(f.log.typed.length, 0);
    assert.match(f.log.confirms[0].detail, /hello there/, 'the trusted dialog got the full text');
    assert.match(render(declined), /Nothing ran/);
    assert.match(render(declined), /Backend said: Native confirmation declined or unavailable/);

    // The previous preview was single use: executing it again is a definite "not run: expired", not "unconfirmed".
    const reused = await ui.decideCommand(api, previewed, true);
    assert.equal(reused.outcome.kind, 'not-run');
    assert.equal(reused.outcome.cause, 'expired');

    f.setDecision(true);
    const again = await ui.previewCommand(api, planned, choice.request);
    const ran = await ui.decideCommand(api, again, true);
    assert.equal(ran.outcome.kind, 'ran');
    assert.equal(f.log.typed.length, 1);
    assert.deepEqual(f.log.focused, [{hwnd: 12, pid: 23}]);
  } finally { await f.close(); }
});

test('a renderer "approved" without a trusted confirm callback runs nothing and is typed as declined', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-milestone-assistant-'));
  let typed = 0;
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [],
    native: {listWindows: async () => [WIN], focusWindow: async () => ({focused: true}), typeText: async () => { typed++; return {typed: 1}; }, moveWindow: async () => ({}), dpapi: async () => ({ok: true})},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
  });
  try {
    const planned = await ui.planCommand(b, 'type "x" into "Note"', false);
    const previewed = await ui.previewCommand(b, planned, planned.plan.request);
    const out = await ui.decideCommand(b, previewed, true);
    assert.equal(out.outcome.kind, 'not-run');
    assert.equal(out.outcome.cause, 'declined');
    assert.equal(typed, 0);
  } finally { await b.dispose(); await rm(dir, {recursive: true, force: true}); }
});

test('repeated cancellations pause confirmations; the UI types that cause and nothing runs', async () => {
  const f = await fixture();
  try {
    f.setDecision(false);
    let last;
    for (let i = 0; i < 4; i++) {
      const planned = await ui.planCommand(f.b, 'type "x" into "Note"', false);
      const previewed = await ui.previewCommand(f.b, planned, planned.plan.request);
      last = await ui.decideCommand(f.b, previewed, true);
    }
    assert.equal(last.outcome.kind, 'not-run');
    assert.equal(last.outcome.cause, 'paused');
    assert.equal(f.log.typed.length, 0);
  } finally { await f.close(); }
});

test('rejecting never opens the native dialog; a blocked preview is never sent for execution', async () => {
  const f = await fixture();
  try {
    const planned = await ui.planCommand(f.b, 'type "x" into "Note"', false);
    const previewed = await ui.previewCommand(f.b, planned, planned.plan.request);
    const rejected = await ui.decideCommand(f.b, previewed, false);
    assert.equal(rejected.outcome.kind, 'rejected');
    assert.equal(f.log.confirms.length, 0);
    const blocked = await ui.previewCommand(f.b, {command: 'launch'}, {type: 'launch', target: 'C:\\Windows\\System32\\cmd.exe'});
    assert.equal(blocked.preview.allowed, false);
    const out = await ui.decideCommand(f.b, blocked, true);
    assert.equal(out.error, blocked.preview.reason);
    assert.equal(out.outcome, undefined);
    assert.equal(f.log.confirms.length, 0);
  } finally { await f.close(); }
});

test('notRunCause only types known backend refusals; unknown text and thrown errors stay honest', async () => {
  assert.equal(ui.notRunCause('Preview already used'), undefined);
  assert.equal(ui.notRunCause('This preview is unknown, expired or was already used. Request a new preview.'), 'expired');
  assert.equal(ui.notRunCause('Rate limit reached (30 actions per minute)'), 'rate-limit');
  assert.equal(ui.notRunCause('Safe launch is active: actions are disabled'), 'safe-launch');
  assert.equal(ui.explainNotRun('Not approved'), undefined);
  const api = {previewAction: async () => ({id: 'p', summary: 'Focus', requiresApproval: true, allowed: true}), executeAction: async () => { throw new Error('This preview is unknown, expired or was already used. Request a new preview.'); }};
  const previewed = await ui.previewCommand(api, {command: 'x'}, {type: 'focus', target: 'hwnd:12'});
  assert.equal((await ui.decideCommand(api, previewed, true)).outcome.cause, 'expired');
  const odd = {...api, executeAction: async () => { throw new Error('Preview already used'); }};
  assert.equal((await ui.decideCommand(odd, previewed, true)).outcome.kind, 'unconfirmed');
  const oops = {...api, executeAction: async () => 'ok'};
  assert.equal((await ui.decideCommand(oops, previewed, true)).outcome.kind, 'unconfirmed', 'a resolved IPC promise alone is not success');
});

// ---------- what the user is told ----------

test('CommandFlow tells the user the Windows confirmation decides, shows waiting state, and states the one-minute validity', () => {
  const step = {command: 'type hi', request: {type: 'type-text', target: 'hwnd:12', text: 'hi'}, preview: {id: 'p', summary: 'Type 2 characters into "Untitled - Notepad"', requiresApproval: true, allowed: true}};
  const idle = render(step);
  assert.match(idle, /Windows confirmation/);
  assert.match(idle, /Cancel is the default/);
  assert.match(idle, /valid for one minute/);
  assert.doesNotMatch(idle, /Waiting for your answer/);
  const waiting = render(step, 'approve');
  assert.match(waiting, /Waiting for your answer in the Windows confirmation window/);
  const unconfirmed = render({...step, preview: undefined, outcome: {kind: 'unconfirmed', message: 'x', summary: 's'}});
  assert.match(unconfirmed, /Not confirmed/);
  assert.ok(ui.PREVIEW_VALID_MS < 60_000, 'the UI stops offering approval before the backend TTL');
});

test('model-unavailable and provider-error command planning is reported, not simulated', async () => {
  const noPlanner = await ui.planCommand({}, 'list windows', false);
  assert.match(noPlanner.error, /not available/);
  const thrown = await ui.planCommand({planIntent: async () => { throw new Error('Ollama did not answer in time'); }}, 'do something odd', true);
  assert.equal(thrown.plan, undefined);
  assert.match(thrown.error, /did not answer in time/);
  assert.match(render(thrown), /Not run/);
  // Local model assist while Ollama is down: the real planner answers 'clarify'/'blocked', never a made-up action.
  const f = await fixture();
  try {
    const step = await ui.planCommand(f.b, 'summon a unicorn please', true);
    assert.ok(step.error || ['clarify', 'blocked'].includes(step.plan.status), 'no ready action invented without a model');
    if (step.plan) assert.notEqual(step.plan.status, 'ready');
  } finally { await f.close(); }
});

test('Computer: plan fills the form only, with every field the user will preview', () => {
  const req = {type: 'type-text', target: 'hwnd:12', text: 'hello'};
  assert.deepEqual(ui.formFromRequest(req), {type: 'type-text', target: 'hwnd:12', text: 'hello', x: '', y: '', width: '', height: ''});
});
