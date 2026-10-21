// Semantic UI Automation slice for the attached app window: snapshot sanitising (same process only, bounded, password
// values never kept, unlabelled or ambiguous elements refused), refs valid only in a current snapshot, the trusted
// confirmation with Cancel as default, revalidation after Continue, Stop, performed versus verified receipts, and the
// whole loop through the backend with scripted Claude turns. Fake desktop only: no PowerShell, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, rm, readFile} from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root, sourcefile: 'companion-uia-entry.ts', loader: 'ts',
    contents: `
      export { createBackend } from './electron/backend.ts';
      export { UiaControl, sanitizeSnapshot, parseRawNode, verifyReadback, UIA_LIMITS } from './electron/services/uia.ts';
      export { createAgentTools } from './electron/services/agent-tools.ts';
      export { SCRIPTS, SCRIPT_HELPERS } from './electron/native/runner.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const TARGET = {hwnd: 501, pid: 77, process: 'calc.exe', title: 'Calculator'};
const WIN = {hwnd: 501, pid: 77, process: 'calc.exe', title: 'Calculator', elevated: 0, minimized: false, foreground: false, x: 0, y: 0, width: 300, height: 400, maximized: false};
const node = (rid, o = {}) => ({rid, prid: '', type: 'Button', name: `Button ${rid}`, aid: `id${rid.replace(/\./g, '')}`, pid: 77, enabled: true, offscreen: false, password: false, focusable: true, focused: false, patterns: ['Invoke'], ...o});
const NODES = [
  node('1', {type: 'Window', name: 'Calculator', aid: '', patterns: [], focusable: false}),
  node('1.1', {prid: '1', name: 'Seven', aid: 'num7Button'}),
  node('1.2', {prid: '1', type: 'CheckBox', name: 'Always on top', aid: 'pin', patterns: ['Toggle'], toggle: 'Off'}),
  node('1.3', {prid: '1', type: 'Edit', name: 'Password', aid: 'pw', password: true, patterns: ['Value'], value: 'hunter2'}),
  node('1.4', {prid: '1', name: 'Disabled', enabled: false}),
  node('1.5', {prid: '1', name: '', aid: ''}),
  node('1.6', {prid: '1', name: 'OK', aid: ''}),
  node('1.7', {prid: '1', name: 'OK', aid: ''}),
  node('1.8', {prid: '1', name: 'Other app', pid: 999}),
  node('1.9', {prid: '1', type: 'ListItem', name: 'History item', aid: 'h1', patterns: ['ScrollItem', 'SelectionItem'], offscreen: true}),
  node('1.10', {prid: '1', type: 'MenuItem', name: 'View‮ evil', aid: 'menu', patterns: ['ExpandCollapse'], expand: 'Collapsed'}),
  {rid: 'not a rid', type: 'Button', pid: 77},
];

function fakeDesktop(o = {}) {
  const calls = {inspect: 0, act: [], list: 0};
  let windows = [WIN];
  const native = {
    inspect: async (w, opts, signal) => { calls.inspect++; assert.deepEqual(w, {hwnd: 501, pid: 77}); assert.ok(opts.maxNodes <= 150); return o.inspect ? o.inspect(signal) : {nodes: NODES, truncated: false}; },
    act: async (w, req, signal) => { calls.act.push(req); return o.act ? o.act(req, signal) : {performed: true, readback: {exists: true}}; },
  };
  let now = 1_000;
  let ids = 0;
  const ctl = new m.UiaControl({native, listWindows: async () => { calls.list++; return o.listWindows ? o.listWindows() : windows; }, now: () => now, newId: () => `snap${++ids}`});
  return {ctl, calls, setWindows: (w) => { windows = w; }, tick: (ms) => { now += ms; }};
}
const sig = () => new AbortController().signal;
const yes = async () => true;

/* ---------- Snapshot ---------- */

test('snapshot: same process only, bounded, refs and parents, password values never kept, refusals named', async () => {
  const d = fakeDesktop();
  const r = await d.ctl.inspect(TARGET, sig());
  assert.equal(r.ok, true);
  const els = r.snapshot.elements;
  const by = (name) => els.find((e) => e.name === name);
  assert.ok(!els.some((e) => e.name === 'Other app'), 'elements of another process are dropped');
  assert.equal(els.length, 10, 'the malformed node is dropped, not repaired');
  assert.deepEqual(by('Seven'), {ref: 'e2', role: 'Button', name: 'Seven', automationId: 'num7Button', parent: 'e1', enabled: true, offscreen: false, actions: ['invoke', 'focus']});
  assert.equal(by('Password').refused, 'password field');
  assert.equal(by('Password').state, undefined, 'no password value in the snapshot');
  assert.ok(!JSON.stringify(r.snapshot).includes('hunter2'));
  assert.equal(by('Disabled').refused, 'disabled');
  assert.equal(els.find((e) => e.ref === 'e6').refused, 'unlabelled');
  assert.match(els.find((e) => e.ref === 'e7').refused, /ambiguous/);
  assert.deepEqual(by('History item').actions, ['scroll_into_view'], 'offscreen elements can only be scrolled into view');
  assert.deepEqual(by('Always on top').state, {toggle: 'Off'});
  const menu = els.find((e) => e.automationId === 'menu');
  assert.equal(menu.name, 'View evil', 'direction overrides and control characters are removed');
  assert.deepEqual(menu.actions, ['expand', 'focus']);
  assert.equal(r.snapshot.expiresAt - r.snapshot.takenAt, m.UIA_LIMITS.ttlMs);
});

test('snapshot: the element limit truncates; duplicate runtime ids keep the first', () => {
  const many = Array.from({length: 400}, (_, i) => node(`2.${i}`, {name: `n${i}`, aid: `a${i}`}));
  const s = m.sanitizeSnapshot([...many.slice(0, 2), many[0], ...many.slice(2)], TARGET, {id: 's', now: 0});
  assert.equal(s.snapshot.truncated, true);
  assert.ok(s.snapshot.elements.length <= m.UIA_LIMITS.maxElements);
  assert.equal(new Set(s.snapshot.elements.map((e) => e.name)).size, s.snapshot.elements.length);
});

test('inspect refuses a gone, replaced, elevated or minimized window before reading it', async () => {
  for (const [w, re] of [[[], /gone/], [[{...WIN, pid: 5}], /different program/], [[{...WIN, elevated: 1}], /administrator/], [[{...WIN, elevated: -1}], /protected/], [[{...WIN, minimized: true}], /minimized/]]) {
    const d = fakeDesktop();
    d.setWindows(w);
    const r = await d.ctl.inspect(TARGET, sig());
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
    assert.equal(d.calls.inspect, 0);
  }
});

/* ---------- Preview and act ---------- */

test('refs work only in the current, unexpired snapshot of the same window, and only for listed actions', async () => {
  const d = fakeDesktop();
  const {snapshot} = await d.ctl.inspect(TARGET, sig());
  assert.match(d.ctl.preview(TARGET, 'snap999', 'e2', 'invoke').reason, /not current/);
  assert.match(d.ctl.preview(TARGET, snapshot.id, 'e99', 'invoke').reason, /no element e99/);
  assert.match(d.ctl.preview(TARGET, snapshot.id, 'e4', 'focus').reason, /password field/);
  assert.match(d.ctl.preview(TARGET, snapshot.id, 'e2', 'toggle').reason, /does not offer toggle/);
  assert.match(d.ctl.preview({...TARGET, hwnd: 9}, snapshot.id, 'e2', 'invoke').reason, /different window/);
  const ok = d.ctl.preview(TARGET, snapshot.id, 'e2', 'invoke');
  assert.equal(ok.summary, 'Press “Seven” (button) in calc?');
  assert.match(ok.detail, /App: calc\.exe \(process 77\)\nWindow: Calculator\nElement: Button “Seven”, id num7Button\nEffect: Press “Seven” \(button\)\./);
  assert.match(ok.detail, /Cancel is the default/);
  d.tick(m.UIA_LIMITS.ttlMs);
  assert.match(d.ctl.preview(TARGET, snapshot.id, 'e2', 'invoke').reason, /expired/);
});

test('Cancel, a failed confirmation, Stop or a removed window during the confirmation do nothing', async () => {
  for (const kind of ['cancel', 'throw', 'stop', 'removed']) {
    const d = fakeDesktop();
    const {snapshot} = await d.ctl.inspect(TARGET, sig());
    const ctl = new AbortController();
    let attached = true;
    const opened = [];
    const r = await d.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {
      signal: ctl.signal, current: () => attached, onConfirm: (o) => opened.push(o),
      confirm: async () => { if (kind === 'throw') throw new Error('no window'); if (kind === 'stop') ctl.abort(); if (kind === 'removed') attached = false; return kind !== 'cancel'; },
    });
    assert.equal(r.performed, false, kind);
    assert.equal(d.calls.act.length, 0, kind);
    assert.deepEqual(opened, [true, false]);
    if (kind === 'cancel' || kind === 'throw') assert.equal(r.declined, true);
  }
});

test('after Continue the window is checked again: a changed process, elevation or a closed window stops the action', async () => {
  for (const after of [[], [{...WIN, pid: 12}], [{...WIN, elevated: 1}], [{...WIN, minimized: true}]]) {
    const d = fakeDesktop();
    const {snapshot} = await d.ctl.inspect(TARGET, sig());
    const r = await d.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: sig(), current: () => true, confirm: async () => { d.setWindows(after); return true; }});
    assert.equal(r.performed, false);
    assert.equal(d.calls.act.length, 0);
  }
  const d = fakeDesktop();
  const {snapshot} = await d.ctl.inspect(TARGET, sig());
  const r = await d.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: sig(), current: () => true, confirm: async () => { d.tick(m.UIA_LIMITS.ttlMs + 1); return true; }});
  assert.match(r.reason, /expired/, 'a snapshot that expired while the dialog was open is not used');
});

test('performed is not verified: invoke is reported unverified; toggle counts only when the read-back changed', async () => {
  const d = fakeDesktop({act: (req) => (req.action === 'toggle' ? {performed: true, readback: {exists: true, toggle: 'On'}} : {performed: true, readback: {exists: true}})});
  let {snapshot} = await d.ctl.inspect(TARGET, sig());
  const press = await d.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: sig(), current: () => true, confirm: yes});
  assert.deepEqual([press.performed, press.verified], [true, false]);
  assert.match(press.summary, /Not independently verified/);
  assert.deepEqual(d.calls.act[0], {rid: '1.1', expect: {type: 'Button', name: 'Seven', aid: 'num7Button'}, action: 'invoke'});
  const again = await d.ctl.perform(TARGET, snapshot.id, 'e3', 'toggle', {signal: sig(), current: () => true, confirm: yes});
  assert.equal(again.performed, false);
  assert.match(again.reason, /Inspect it again/, 'any action makes the snapshot stale');
  ({snapshot} = await d.ctl.inspect(TARGET, sig()));
  const pin = await d.ctl.perform(TARGET, snapshot.id, 'e3', 'toggle', {signal: sig(), current: () => true, confirm: yes});
  assert.deepEqual([pin.performed, pin.verified], [true, true]);
  assert.equal(m.verifyReadback('toggle', {toggle: 'Off'}, {exists: true, toggle: 'Off'}), false);
  assert.equal(m.verifyReadback('focus', {}, {exists: false, focused: true}), false);
  assert.equal(m.verifyReadback('expand', {}, {exists: true, expand: 'Expanded'}), true);
});

test('a helper refusal is not done; a helper that fails, times out or is stopped after dispatch is an uncertain effect', async () => {
  const d = fakeDesktop({act: () => ({performed: false, reason: 'The element changed since the app was inspected'})});
  let {snapshot} = await d.ctl.inspect(TARGET, sig());
  const r = await d.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: sig(), current: () => true, confirm: yes});
  assert.deepEqual([r.performed, r.reason], [false, 'The element changed since the app was inspected']);
  const ctl = new AbortController();
  const d2 = fakeDesktop({act: async (req, signal) => { ctl.abort(); assert.equal(signal, ctl.signal); throw new Error('Native helper was cancelled'); }});
  ({snapshot} = await d2.ctl.inspect(TARGET, sig()));
  const s = await d2.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: ctl.signal, current: () => true, confirm: yes});
  assert.equal(s.performed, 'uncertain', 'Invoke may already have happened');
  assert.match(s.reason, /Stopped while the action was running/);
  assert.match(s.summary, /Unknown whether it happened\. Check calc before trying again/);
  assert.match(s.note, /Do not retry automatically/);
  const d3 = fakeDesktop({act: async () => { throw new Error('Native helper timed out after 20000 ms'); }});
  ({snapshot} = await d3.ctl.inspect(TARGET, sig()));
  const t = await d3.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: sig(), current: () => true, confirm: yes});
  assert.equal(t.performed, 'uncertain');
  assert.match(t.reason, /did not report back.*timed out/);
  assert.equal(d3.calls.act.length, 1, 'no automatic retry');
  const again = await d3.ctl.perform(TARGET, snapshot.id, 'e2', 'invoke', {signal: sig(), current: () => true, confirm: yes});
  assert.equal(again.performed, false, 'the snapshot is stale after an uncertain action: inspect before retrying');
  assert.equal(d3.calls.act.length, 1);
});

test('act_in_app reports an uncertain effect as failed, unverified and not retryable', async () => {
  const tools = m.createAgentTools({snapshot: () => ({}), saveTask: async () => ({}), confirm: yes, today: () => '', app: {target: TARGET, inspect: async () => ({ok: false, reason: 'x'}), act: async () => ({performed: 'uncertain', summary: 'Unknown whether it happened. Check calc before trying again', reason: 'Stopped while the action was running', note: 'Do not retry automatically; ask the person to look at the app.'})}});
  const r = await tools.find((t) => t.def.name === 'act_in_app').run({snapshot: 's1', ref: 'e2', action: 'invoke'}, {signal: sig(), setPhase: () => {}});
  assert.deepEqual([r.ok, r.phase, r.verified], [false, 'failed', false]);
  assert.equal(JSON.parse(r.content).performed, 'unknown');
  assert.match(JSON.parse(r.content).note, /Do not retry automatically/);
});

test('toggle is verified only from a known before-state to a different known after-state', () => {
  assert.equal(m.verifyReadback('toggle', {}, {exists: true, toggle: 'Off'}), false, 'unknown before + Off after proves nothing');
  assert.equal(m.verifyReadback('toggle', {toggle: 'Off'}, {exists: true}), false);
  assert.equal(m.verifyReadback('toggle', {toggle: 'Off'}, {exists: true, toggle: 'Sideways'}), false);
  assert.equal(m.verifyReadback('toggle', {toggle: 'Off'}, {exists: true, toggle: 'On'}), true);
  assert.equal(m.verifyReadback('toggle', {toggle: 'On'}, {exists: true, toggle: 'Indeterminate'}), true);
});

test('elements with the same role, label and automation id are ambiguous and refused, whatever the id', () => {
  const s = m.sanitizeSnapshot([node('3.1', {name: 'Delete', aid: 'rowDelete'}), node('3.2', {name: 'Delete', aid: 'rowDelete'}), node('3.3', {name: 'Delete', aid: 'other'}), node('3.4', {type: 'MenuItem', name: 'Delete', aid: 'rowDelete'})], TARGET, {id: 's', now: 0});
  const [a, b, c, d] = s.snapshot.elements;
  assert.match(a.refused, /ambiguous/);
  assert.match(b.refused, /ambiguous/);
  assert.deepEqual([a.actions, b.actions], [[], []]);
  assert.equal(c.refused, undefined, 'a different automation id tells them apart');
  assert.equal(d.refused, undefined, 'a different role tells them apart');
});

/* ---------- Tools ---------- */

test('act_in_app accepts only a snapshot id, a ref and a named action: no coordinates, indexes, commands or extra keys', () => {
  const tools = m.createAgentTools({snapshot: () => ({}), saveTask: async () => ({}), confirm: yes, today: () => '2026-10-21', app: {target: TARGET, inspect: async () => ({ok: false, reason: 'x'}), act: async () => ({performed: false, reason: 'x'})}});
  const act = tools.find((t) => t.def.name === 'act_in_app');
  assert.ok(tools.some((t) => t.def.name === 'inspect_app'));
  assert.equal(act.validate({snapshot: 's1', ref: 'e7', action: 'invoke'}).ok, true);
  for (const bad of [{snapshot: 's1', ref: 'e7', action: 'invoke', x: 10, y: 20}, {snapshot: 's1', ref: '7', action: 'invoke'}, {snapshot: 's1', ref: 'e7', action: 'run'}, {snapshot: 's1', ref: 'e7', action: 'type'}, {snapshot: 's 1', ref: 'e7', action: 'invoke'}, {snapshot: 's1', ref: 'e0', action: 'invoke'}]) {
    assert.equal(act.validate(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(tools.find((t) => t.def.name === 'inspect_app').validate({anything: 1}).ok, false);
  assert.ok(!m.createAgentTools({snapshot: () => ({}), saveTask: async () => ({}), confirm: yes, today: () => ''}).some((t) => /app$/.test(t.def.name)), 'no attached window, no app tools');
});

test('the UIA helpers are registered with their shared module, and contain no shell, script or keystroke path', async () => {
  assert.ok(m.SCRIPTS.includes('uia-inspect') && m.SCRIPTS.includes('uia-act'));
  assert.deepEqual(m.SCRIPT_HELPERS['uia-act'], ['uia-common.ps1']);
  for (const f of ['uia-inspect.ps1', 'uia-act.ps1', 'uia-common.ps1']) {
    const src = await readFile(path.join(root, 'native', f), 'utf8');
    assert.doesNotMatch(src, /Invoke-Expression|\biex\b|Start-Process|SendKeys|SendInput|\[Jarvis\.Win32\]::Click|cmd\.exe|-EncodedCommand/i, f);
  }
  const act = await readFile(path.join(root, 'native', 'uia-act.ps1'), 'utf8');
  assert.match(act, /password field/);
  assert.match(act, /changed since the app was inspected/);
  assert.match(act, /More than one element matches/);
});

/* ---------- Backend journey ---------- */

const KEY = 'sk-ant-test-0123456789abcdefghijklmnopqrstuvwxyz';
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
  decryptString: (buf) => { const s = buf.toString('utf8'); return [...s.slice(4)].reverse().join(''); },
};
const ev = (type, data = {}) => `event: ${type}\ndata: ${JSON.stringify({type, ...data})}\n\n`;
function sseFor(content, stop) {
  let o = ev('message_start', {message: {id: 'msg', type: 'message', role: 'assistant', content: [], usage: {input_tokens: 5, output_tokens: 0}}});
  content.forEach((b, index) => {
    if (b.type === 'text') o += ev('content_block_start', {index, content_block: {type: 'text', text: ''}}) + ev('content_block_delta', {index, delta: {type: 'text_delta', text: b.text}});
    else o += ev('content_block_start', {index, content_block: {type: 'tool_use', id: b.id, name: b.name, input: {}}}) + ev('content_block_delta', {index, delta: {type: 'input_json_delta', partial_json: JSON.stringify(b.input)}});
    o += ev('content_block_stop', {index});
  });
  return o + ev('message_delta', {delta: {stop_reason: stop}, usage: {output_tokens: 3}}) + ev('message_stop');
}

test('backend journey: Claude inspects the attached app, asks to press one control, the person confirms, the receipt is honest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-uia-'));
  const acts = [];
  const bodies = [];
  let setup = true;
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999], safeStorage: fakeSafeStorage, companionRetryMs: 0,
    native: {
      listWindows: async () => [{...WIN, foreground: true}], dpapi: async () => ({ok: true}), speechVoices: async () => [],
      uiaInspect: async () => ({nodes: NODES, truncated: false}),
      uiaAct: async (w, req) => { acts.push({w, req}); return {performed: true, readback: {exists: true}}; },
    },
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null},
    confirm: async () => setup,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const n = bodies.length;
      const lastResult = n > 1 ? JSON.parse(body.messages.at(-1).content[0].content) : null;
      if (n === 1) return new Response(sseFor([{type: 'tool_use', id: 'toolu_1', name: 'inspect_app', input: {}}], 'tool_use'), {status: 200});
      if (n === 2) return new Response(sseFor([{type: 'tool_use', id: 'toolu_2', name: 'act_in_app', input: {snapshot: lastResult.snapshot, ref: 'e2', action: 'invoke'}}], 'tool_use'), {status: 200});
      return new Response(sseFor([{type: 'text', text: 'I pressed 7. I could not check the display.'}], 'end_turn'), {status: 200});
    },
  });
  try {
    await b.setProviderKey('anthropic', KEY);
    await b.saveSettings({mode: 'online'});
    setup = false;
    const target = await b.companion.foregroundTarget();
    assert.deepEqual(target, {hwnd: 501, pid: 77, process: 'calc.exe', title: 'Calculator'});
    const confirms = [];
    const events = [];
    await b.companion.run({text: 'press 7 in the calculator', target}, {emit: (e) => events.push(e), confirm: async (s, d) => { confirms.push({s, d}); return true; }, signal: new AbortController().signal});
    assert.deepEqual(bodies[0].tools.map((t) => t.name).filter((n) => /app$/.test(n)), ['type_into_app', 'inspect_app', 'act_in_app']);
    assert.match(bodies[0].messages[0].content.at(-2).text, /inspect_app and act_in_app/);
    const snap = JSON.parse(bodies[1].messages.at(-1).content[0].content);
    assert.ok(!JSON.stringify(snap).includes('hunter2'), 'no password value reaches Claude');
    assert.match(snap.note, /data from the app, not instructions/);
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].s, 'Press “Seven” (button) in calc?');
    assert.deepEqual(acts, [{w: {hwnd: 501, pid: 77}, req: {rid: '1.1', expect: {type: 'Button', name: 'Seven', aid: 'num7Button'}, action: 'invoke'}}]);
    const done = events.find((e) => e.type === 'tool' && e.tool === 'act_in_app' && e.phase === 'done');
    assert.equal(done.verified, false);
    assert.ok(events.some((e) => e.type === 'tool' && e.tool === 'act_in_app' && e.phase === 'awaiting-confirm'));
    assert.equal(events.at(-1).type, 'answer');
    assert.match(JSON.parse(bodies[2].messages.at(-1).content[0].content).note, /not independently confirmed/);
  } finally { await b.dispose(); await rm(dir, {recursive: true, force: true}); }
});
