// Final integration glue: every IPC method is mounted (backend handler + preload binding), the real Calendar and
// Clipboard components are reachable from the shell with their bridges, Calendar's main-process dialog routes render
// and report outcomes, and dashboard widgets reflow for narrow containers. Real TypeScript/TSX bundled in memory and
// rendered with react-dom/server; the backend uses namespaced temp folders and injected dialogs. No network or input.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

async function bundle(contents) {
  const out = await build({stdin: {contents, resolveDir: root, loader: 'tsx', sourcefile: 'final-integration-ui-entry.tsx'}, bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent', external: ['react', 'react-dom'], loader: {'.css': 'empty'}});
  const mod = {exports: {}};
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}

const M = await bundle(`
  export {createBackend} from './electron/backend';
  export {METHODS} from './electron/channels';
  export {calendarBridge, clipboardBridge} from './src/ui/bridges';
  export {Calendar, fileImportMessage} from './src/components/Calendar';
  export {Clipboard} from './src/components/Clipboard';
  export {packLayout, defaultLayout, widgetPlacement, GRID_COLUMNS} from './src/ui/widgets';
  export {createElement} from 'react';
  export {renderToStaticMarkup} from 'react-dom/server';
`);
const {createBackend, METHODS, calendarBridge, clipboardBridge, Calendar, fileImportMessage, Clipboard, packLayout, defaultLayout, widgetPlacement, GRID_COLUMNS, createElement, renderToStaticMarkup} = M;

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261014T010000Z', 'SUMMARY:Stand-up', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

async function backend(dialogs = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-final-ui-'));
  const b = await createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    native: {listWindows: async () => [], focusWindow: async () => ({focused: false}), typeText: async () => { throw new Error('no input'); }, moveWindow: async () => { throw new Error('no input'); }, dpapi: async () => ({ok: true})},
    shell: {spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {}},
    confirm: async () => false,
    dialogs: {openImport: async () => null, pick: async () => null, saveExport: async () => null, ...dialogs},
    fetchImpl: async () => { throw new Error('no network in tests'); },
    now: () => new Date('2026-10-14T00:30:00Z'),
  });
  return {b, dir, async close() { await b.dispose(); await rm(dir, {recursive: true, force: true}); }};
}

test('every declared IPC method has a backend handler and a preload binding', async () => {
  const f = await backend();
  try {
    const preload = await readFile(path.join(root, 'electron', 'preload.ts'), 'utf8');
    const missing = METHODS.filter((m) => typeof f.b[m] !== 'function');
    assert.deepEqual(missing, [], 'declared but not mounted in the backend');
    const unbound = METHODS.filter((m) => !preload.includes(`call('${m}'`));
    assert.deepEqual(unbound, [], 'declared but not exposed by preload');
  } finally { await f.close(); }
});

test('the shell mounts the real Calendar, Clipboard and Avatar Studio instead of placeholder notices', async () => {
  const app = await readFile(path.join(root, 'src', 'components', 'App.tsx'), 'utf8');
  for (const [name, from] of [['AvatarStudio', './AvatarStudio'], ['Calendar', './Calendar'], ['Clipboard', './Clipboard']]) {
    assert.ok(app.includes(`const ${name} = lazy(() => import('${from}').then((m) => ({ default: m.${name} })));`), `${name} loads its real local module and named export`);
    assert.match(app, new RegExp(`<${name}\\b`), `${name} is rendered`);
  }
  assert.doesNotMatch(app, /Calendar is not connected|Avatar editing is not connected|<Button disabled>Edit avatar/, 'placeholder notices are gone');
  assert.match(app, /calendarBridge\(api\)/);
  assert.match(app, /clipboardBridge\(api\)/);
});

test('main wires typed dialogs, the clipboard reader (never in test mode) and app metrics into the backend', async () => {
  const main = await readFile(path.join(root, 'electron', 'main.ts'), 'utf8');
  for (const m of ['async openFile(', 'async saveFile(', 'async saveUsageExport(']) assert.ok(main.includes(m), m);
  assert.match(main, /const clipboardReader: ClipboardReader \| undefined = TEST_MODE \? undefined :/);
  assert.match(main, /clipboard: clipboardReader,\s*\n\s*appMetrics,/);
});

test('the calendar bridge drives a real backend through the dialog import and export', async () => {
  const f = await backend();
  let open = null, save = null;
  const g = await backend({openFile: async () => open, saveFile: async () => save});
  try {
    const api = calendarBridge(g.b);
    assert.equal(typeof api.importFile, 'function');
    assert.equal(typeof api.exportIcs, 'function');
    assert.equal(fileImportMessage(await api.importFile()), null, 'a cancelled dialog shows nothing');
    open = path.join(g.dir, 'cal.ics');
    await writeFile(open, '﻿' + ICS);
    assert.deepEqual(fileImportMessage(await api.importFile()), {tone: 'info', text: 'Imported 1 new event; 1 event stored.'});
    await writeFile(open, 'not a calendar');
    assert.equal(fileImportMessage(await api.importFile()).tone, 'danger');
    save = path.join(g.dir, 'out');
    assert.deepEqual(await api.exportIcs(), {saved: true, events: 1});
    assert.match(await readFile(`${save}.ics`, 'utf8'), /SUMMARY:Stand-up/);
    assert.equal(fileImportMessage({imported: false, added: 0, dropped: 0, total: 0, error: 'too-large'}).tone, 'danger');
    assert.match(fileImportMessage({imported: true, added: 2, dropped: 3, total: 5}).text, /3 events over the store limit were not kept/);
  } finally { await f.close(); await g.close(); }
});

test('Calendar renders dialog routes only when the client provides them; no client shows the honest notice', () => {
  const base = {list: async () => [], importIcs: async () => ({added: 0, dropped: 0, total: 0}), clear: async () => {}};
  const withDialogs = renderToStaticMarkup(createElement(Calendar, {api: {...base, importFile: async () => ({imported: false, added: 0, dropped: 0, total: 0}), exportIcs: async () => ({saved: false, events: 0})}, initialEvents: []}));
  assert.match(withDialogs, /Import with file dialog/);
  assert.match(withDialogs, /Export all as \.ics/);
  assert.match(withDialogs, /junctions or network locations are refused/);
  const plain = renderToStaticMarkup(createElement(Calendar, {api: base, initialEvents: []}));
  assert.doesNotMatch(plain, /Import with file dialog/);
  assert.match(renderToStaticMarkup(createElement(Calendar, {api: null})), /Calendar is not connected/);
});

test('Clipboard renders from a real backend bridge and stays off by default', async () => {
  const f = await backend();
  try {
    const client = clipboardBridge(f.b);
    assert.ok(client, 'the clipboard bridge is complete');
    const status = await client.status();
    assert.equal(status.enabled, false);
    const html = renderToStaticMarkup(createElement(Clipboard, {client, initial: {status, entries: []}}));
    assert.match(html, /not connected in this build|no clipboard reader/i, 'without a host reader the panel says so');
  } finally { await f.close(); }
});

test('dashboard widgets carry exact, two-up and stacked placements; CSS reflows by container width', async () => {
  const {items} = packLayout(defaultLayout());
  for (const item of items) {
    const p = widgetPlacement(item);
    assert.equal(p['--dash-col'], `${item.x + 1} / span ${item.width}`);
    assert.equal(p['--dash-mid'], item.width > GRID_COLUMNS / 2 ? 'span 12' : 'span 6');
    assert.equal(p['--dash-rows'], `span ${item.rows}`);
    assert.ok(item.x + item.width <= GRID_COLUMNS);
  }
  const css = await readFile(path.join(root, 'src', 'styles', 'views.css'), 'utf8');
  assert.match(css, /\.dash-wrap \{\s*container-type: inline-size;/);
  assert.match(css, /@container \(max-width: 760px\) \{\s*\.dash-card \{\s*grid-column: var\(--dash-mid/);
  assert.match(css, /@container \(max-width: 480px\) \{\s*\.dash-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  const home = await readFile(path.join(root, 'src', 'components', 'Home.tsx'), 'utf8');
  assert.doesNotMatch(home, /gridTemplateColumns:|gridColumn: `/, 'no inline grid styles that CSS cannot override');
});
