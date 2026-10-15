// Clipboard history UI tests: panel states, opt-in and default-off rendering, secret-risk notice, list/remove/clear actions,
// declined native confirmation, and the bridge wiring. Renders the real TSX with react-dom/server. Actions run through the
// REAL ClipboardHistory service behind an in-memory client adapter with a fake reader, so the system clipboard is never
// read or written and no desktop input happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

// Icon package is replaced with inert placeholders. Names come from the real imports of the files this bundle uses.
const iconNames = new Set();
for (const f of ['src/components/Clipboard.tsx', 'src/ui/primitives.tsx', 'src/ui/Dialog.tsx']) {
  const text = await read(f);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
      if (name) iconNames.add(name);
    }
  }
}

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'clipboard-ui-entry.ts',
    loader: 'ts',
    contents: `
      export * as clip from './src/components/Clipboard.tsx';
      export { clipboardBridge, CLIPBOARD_METHODS } from './src/ui/bridges.ts';
      export { ClipboardHistory, CLIPBOARD_LIMITS } from './electron/services/clipboard.ts';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'icon-stub',
      setup(bld) {
        bld.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { clip, clipboardBridge, CLIPBOARD_METHODS, ClipboardHistory, createElement: h, renderToStaticMarkup: render } = mod;
const { Clipboard, clipboardActions, retentionLabel } = clip;

// ---------- fixtures and fakes ----------

const T0 = 1_000_000_000_000;
const DAY = 86_400_000;
const html = (el) => render(el);

const offStatus = (over = {}) => ({ enabled: false, persisted: false, count: 0, maxEntries: 50, retentionMs: DAY, maxChars: 5000, ...over });
const onStatus = (over = {}) => offStatus({ enabled: true, ...over });

/** Fake reader: `set()` changes what the "clipboard" holds; `reads` counts how often the service looked at it. */
function fakeReader(initial = '') {
  const r = {
    text: initial,
    reads: 0,
    set(t) { r.text = t; },
    readText: async () => { r.reads++; return r.text; },
  };
  return r;
}

let idSeq = 0;
const newId = () => `id-${++idSeq}`;

/** The real service behind the ClipboardClient interface the bridge exposes. */
function serviceClient(history) {
  return {
    status: async () => history.status(),
    setEnabled: (on) => history.setEnabled(on),
    list: async () => history.list(),
    get: async (id) => history.get(id),
    remove: (id) => history.remove(id),
    purge: async () => { await history.purge(); return history.status(); },
  };
}

// ---------- rendering ----------

test('not connected: says the build has no clipboard bridge and renders no controls', () => {
  const markup = html(h(Clipboard, { client: null }));
  assert.match(markup, /Clipboard history is not connected/);
  assert.match(markup, /Nothing is read from the clipboard/);
  assert.doesNotMatch(markup, /role="switch"/);
  assert.doesNotMatch(markup, /<button/);
});

test('off by default: switch unchecked, badge Off, memory-only storage, clear-all disabled, empty state explains nothing is recorded', () => {
  const markup = html(h(Clipboard, { client: serviceClient(new ClipboardHistory({ reader: fakeReader() })), initial: { status: offStatus(), entries: [] } }));
  assert.match(markup, /role="switch" aria-checked="false"/);
  assert.match(markup, />Off</);
  assert.match(markup, /Memory only/);
  assert.match(markup, /Kept for<\/dt><dd[^>]*>1 day</);
  assert.match(markup, /Off by default\. Turning it on asks for confirmation in a Windows dialog/);
  assert.match(markup, /History is off/);
  assert.match(markup, /Nothing is recorded while history is off/);
  const clearAll = markup.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Clear all/);
  assert.ok(clearAll, 'Clear all button is rendered');
  assert.match(clearAll[0], /disabled=""/);
});

test('on with entries: switch checked, previews are escaped text, one remove control per entry, copy counts shown', () => {
  const entries = [
    { id: 'a', preview: '<b>x</b> & more', capturedAt: T0, copies: 3 },
    { id: 'b', preview: 'second note', capturedAt: T0 - 60_000, copies: 1 },
  ];
  const markup = html(h(Clipboard, { client: serviceClient(new ClipboardHistory({ reader: fakeReader() })), initial: { status: onStatus({ count: 2 }), entries } }));
  assert.match(markup, /role="switch" aria-checked="true"/);
  assert.match(markup, />On</);
  assert.match(markup, /&lt;b&gt;x&lt;\/b&gt; &amp; more/);
  assert.doesNotMatch(markup, /<b>x<\/b>/);
  assert.match(markup, /second note/);
  assert.match(markup, /· 3 times</);
  assert.match(markup, /· 1 time</);
  assert.equal(markup.match(/aria-label="Remove entry copied/g)?.length, 2);
  assert.match(markup, /2 of 50 at most/);
  assert.doesNotMatch(markup, /History is off/);
});

test('secret-risk notice is always visible and states that the check is a heuristic', () => {
  for (const initial of [
    { status: offStatus(), entries: [] },
    { status: onStatus({ count: 1 }), entries: [{ id: 'a', preview: 'hi', capturedAt: T0, copies: 1 }] },
  ]) {
    const markup = html(h(Clipboard, { client: serviceClient(new ClipboardHistory({ reader: fakeReader() })), initial }));
    assert.match(markup, /Secrets can still be stored/);
    assert.match(markup, /heuristic/);
  }
});

test('service warnings and errors are shown as notices, not hidden', () => {
  const status = onStatus({ warning: 'Clipboard history file was not valid JSON and was ignored.', lastError: 'Clipboard read failed: boom' });
  const markup = html(h(Clipboard, { client: serviceClient(new ClipboardHistory({ reader: fakeReader() })), initial: { status, entries: [] } }));
  assert.match(markup, /Clipboard history file was not valid JSON/);
  assert.match(markup, /Clipboard read failed: boom/);
});

test('before the first read, shows a loading state and no invented settings', () => {
  const markup = html(h(Clipboard, { client: serviceClient(new ClipboardHistory({ reader: fakeReader() })) }));
  assert.match(markup, /Reading clipboard history settings/);
  assert.doesNotMatch(markup, /role="switch"/);
  assert.doesNotMatch(markup, /Memory only/);
});

test('the panel offers no copy-to-system or paste control and never mentions one as done', () => {
  const markup = html(h(Clipboard, { client: serviceClient(new ClipboardHistory({ reader: fakeReader() })), initial: { status: onStatus({ count: 1 }), entries: [{ id: 'a', preview: 'x', capturedAt: T0, copies: 1 }] } }));
  assert.doesNotMatch(markup, />\s*Copy\s*</);
  assert.doesNotMatch(markup, /aria-label="Copy/);
  assert.doesNotMatch(markup, /Paste/);
  assert.doesNotMatch(markup, /copied to (the )?(system|windows|clipboard)/i);
});

// ---------- labels ----------

test('retention is described in whole days, hours or minutes', () => {
  assert.equal(retentionLabel(DAY), '1 day');
  assert.equal(retentionLabel(30 * DAY), '30 days');
  assert.equal(retentionLabel(2 * 3_600_000), '2 hours');
  assert.equal(retentionLabel(3_600_000), '1 hour');
  assert.equal(retentionLabel(120_000), '2 minutes');
  assert.equal(retentionLabel(60_000), '1 minute');
  assert.equal(retentionLabel(90_000), '2 minutes');
});

// ---------- actions through the real service ----------

test('turn on, copy, list, remove and clear go through the real service, and only capture reads the clipboard', async () => {
  let now = T0;
  const reader = fakeReader();
  const history = new ClipboardHistory({ reader, now: () => now, newId });
  const actions = clipboardActions(serviceClient(history));

  const first = await actions.load();
  assert.equal(first.ok, true);
  assert.equal(first.value.status.enabled, false);
  assert.deepEqual(first.value.entries, []);
  assert.equal(reader.reads, 0, 'loading never reads the clipboard');

  const on = await actions.setEnabled(true);
  assert.equal(on.ok, true);
  assert.equal(on.value.enabled, true);

  reader.set('first note');
  assert.equal(await history.capture(), 'added');
  now += 1000;
  reader.set('second note');
  assert.equal(await history.capture(), 'added');
  assert.equal(reader.reads, 2, 'only the explicit capture calls read the clipboard');

  const listed = await actions.load();
  assert.deepEqual(listed.value.entries.map((e) => e.preview), ['second note', 'first note'], 'newest first');
  assert.equal(listed.value.status.count, 2);

  const removed = await actions.remove(listed.value.entries[0].id);
  assert.deepEqual(removed, { ok: true, value: true });
  const again = await actions.remove(listed.value.entries[0].id);
  assert.deepEqual(again, { ok: true, value: false }, 'removing a missing entry is reported, not treated as success');

  const cleared = await actions.purge();
  assert.equal(cleared.ok, true);
  assert.equal(cleared.value.count, 0);
  assert.equal(cleared.value.enabled, true, 'clear-all empties entries but keeps history on');

  const off = await actions.setEnabled(false);
  assert.equal(off.value.enabled, false);
  assert.equal(reader.reads, 2, 'turning off does not read the clipboard');
});

test('a declined native confirmation is reported as-is and history stays off', async () => {
  const history = new ClipboardHistory({ reader: fakeReader() });
  const client = {
    ...serviceClient(history),
    setEnabled: async () => {
      throw new Error("Error invoking remote method 'clipboardSetEnabled': ValidationError: Native confirmation declined or unavailable");
    },
  };
  const r = await clipboardActions(client).setEnabled(true);
  assert.equal(r.ok, false);
  assert.match(r.error, /Native confirmation declined or unavailable/);
  assert.doesNotMatch(r.error, /Error invoking remote method/);
  assert.equal(history.status().enabled, false);
});

test('a failing bridge call becomes a readable error and never shows invented settings', async () => {
  const client = { ...serviceClient(new ClipboardHistory({ reader: fakeReader() })), status: async () => { throw new Error('boom'); } };
  const r = await clipboardActions(client).load();
  assert.deepEqual(r, { ok: false, error: 'boom' });
});

// ---------- wiring the shell relies on ----------

test('clipboardBridge returns null unless every clipboard method exists, and forwards calls when they do', async () => {
  assert.equal(clipboardBridge({}), null);
  assert.equal(clipboardBridge({ clipboardStatus: async () => offStatus() }), null, 'partial bridge is not connected');

  const calls = [];
  const api = Object.fromEntries(CLIPBOARD_METHODS.map((name) => [name, async (...args) => { calls.push([name, ...args]); return name === 'clipboardList' ? [] : offStatus(); }]));
  const client = clipboardBridge(api);
  assert.ok(client);
  await client.setEnabled(true);
  await client.list();
  await client.remove('x');
  assert.deepEqual(calls, [['clipboardSetEnabled', true], ['clipboardList'], ['clipboardRemove', 'x']]);
});

// ---------- source guards ----------

test('the component source never touches the system clipboard or the Electron main process', async () => {
  const src = await read('src/components/Clipboard.tsx');
  assert.doesNotMatch(src, /navigator\.clipboard|writeText|readText|clipboard\.write|clipboard\.read/);
  assert.doesNotMatch(src, /from 'electron'/);
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
});

test('the component publishes its props and client helpers for the shell', async () => {
  const src = await read('src/components/Clipboard.tsx');
  assert.match(src, /export interface ClipboardProps/);
  assert.match(src, /export function Clipboard\(/);
  assert.match(src, /export function clipboardActions\(/);
  assert.match(src, /export function retentionLabel\(/);
});
