// Calendar view tests: .ics preview, import and clear flows, day grouping, accessibility markup and the
// "not connected" fallback. Bundles the real component and the real pure .ics module in memory and renders with
// react-dom/server. Uses in-memory File-like objects and a stub client only: no file, network, account or desktop access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'milestone-calendar-ui-entry.ts',
    loader: 'tsx',
    contents: `
      export * as calendar from './electron/services/calendar.ts';
      export * as ui from './src/components/Calendar.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  logLevel: 'silent',
  // React's server build needs Node built-ins; give the in-memory ESM bundle a real require.
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { calendar, ui, createElement, renderToStaticMarkup } = mod;

const wrap = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const render = (props) => renderToStaticMarkup(createElement(ui.Calendar, props));
const pad = (n) => String(n).padStart(2, '0');
/** Local day key computed independently of the view, so the expectation does not depend on the test machine's zone. */
const localKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// Floating and all-day values keep the day they are written with, so these expectations hold in every time zone.
const ORDER_ICS = wrap(
  ...vevent('UID:fri', 'DTSTART:20261016T090000', 'SUMMARY:Floating Fri'),
  ...vevent('UID:wed-late', 'DTSTART:20261014T180000', 'SUMMARY:Floating Wed late'),
  ...vevent('UID:holiday', 'DTSTART;VALUE=DATE:20261014', 'SUMMARY:Holiday Wed'),
  ...vevent('UID:wed-early', 'DTSTART:20261014T080000', 'SUMMARY:Floating Wed early'),
);

const stored = (overrides) => ({
  id: 'x', title: 'Event', start: '2026-10-14T08:00:00', end: null, allDay: false, floating: true,
  location: '', description: '', url: null, ...overrides,
});

const fakeFile = (name, text, size = Buffer.byteLength(text)) => ({
  name,
  size,
  text: async () => text,
});

test('previewText sorts by day, puts all-day before timed events, and ignores file order', () => {
  const p = ui.previewText('sample.ics', ORDER_ICS);
  assert.equal(p.error, null);
  assert.deepEqual(p.events.map((e) => e.title), ['Holiday Wed', 'Floating Wed early', 'Floating Wed late', 'Floating Fri']);
});

test('groupByDay groups by written day for all-day and floating events, in order', () => {
  const groups = ui.groupByDay(ui.previewText('sample.ics', ORDER_ICS).events);
  assert.deepEqual(groups.map((g) => g.key), ['2026-10-14', '2026-10-16']);
  assert.deepEqual(groups.map((g) => g.events.length), [3, 1]);
});

test('UTC events are grouped by their local day', () => {
  const iso = '2026-10-14T23:30:00.000Z';
  assert.equal(ui.dayKey({ start: iso, allDay: false, floating: false }), localKey(iso));
  const groups = ui.groupByDay([stored({ id: 'u', title: 'Late UTC', start: iso, floating: false })]);
  assert.equal(groups[0].key, localKey(iso));
});

test('whenLabel shows All day, a single time, and a time range', () => {
  assert.equal(ui.whenLabel(stored({ allDay: true, floating: false, start: '2026-10-14' })), 'All day');
  assert.match(ui.whenLabel(stored({ start: '2026-10-14T09:00:00' })), /9:00/);
  const range = ui.whenLabel(stored({ start: '2026-10-14T09:00:00', end: '2026-10-14T10:30:00' }));
  assert.match(range, /9:00/);
  assert.match(range, /10:30/);
  assert.match(range, /–/);
});

test('recurring, non-UTC and undated items are skipped and counted, never shown as events', () => {
  const ics = wrap(
    ...vevent('UID:r', 'DTSTART:20261014T090000Z', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Weekly'),
    ...vevent('UID:tz', 'DTSTART;TZID=Europe/Paris:20261014T090000', 'SUMMARY:Paris'),
    ...vevent('UID:none', 'SUMMARY:No start'),
    ...vevent('UID:ok', 'DTSTART:20261014T090000Z', 'SUMMARY:Kept'),
  );
  const p = ui.previewText('mixed.ics', ics);
  assert.deepEqual(p.events.map((e) => e.title), ['Kept']);
  const count = (code) => p.skipped.find((s) => s.code === code)?.count ?? 0;
  assert.equal(count('unsupported-recurrence'), 1);
  assert.equal(count('unsupported-timezone'), 1);
  assert.equal(count('missing-start'), 1);
});

test('text without a calendar block is reported as an error with no events', () => {
  const p = ui.previewText('notes.txt', 'Hello, this is not a calendar.');
  assert.equal(p.events.length, 0);
  assert.match(p.error, /does not contain a calendar/);
});

test('oversized files are refused before they are read', async () => {
  let read = false;
  const file = { name: 'huge.ics', size: calendar.MAX_ICS_BYTES + 1, text: async () => { read = true; return ORDER_ICS; } };
  const p = await ui.readPreview(file);
  assert.equal(read, false);
  assert.equal(p.text, '');
  assert.equal(p.events.length, 0);
  assert.match(p.error, /larger than 1 MB/);
});

test('a read failure becomes a preview error instead of an exception', async () => {
  const p = await ui.readPreview({ name: 'locked.ics', size: 10, text: async () => { throw new Error('EBUSY'); } });
  assert.equal(p.events.length, 0);
  assert.equal(p.error, 'The file could not be read.');
});

test('readPreview keeps the exact text it parsed so the import sends what was previewed', async () => {
  const p = await ui.readPreview(fakeFile('wed.ics', ORDER_ICS));
  assert.equal(p.name, 'wed.ics');
  assert.equal(p.text, ORDER_ICS);
  assert.equal(p.events.length, 4);
});

test('importPreview refuses an error preview or an empty one without calling the client', async () => {
  const calls = [];
  const client = { list: async () => [], importIcs: async (t) => { calls.push(t); return { added: 0, dropped: 0, total: 0 }; }, clear: async () => {} };
  await assert.rejects(ui.importPreview(client, ui.previewText('n.txt', 'nope')), /does not contain a calendar/);
  await assert.rejects(ui.importPreview(client, ui.previewText('e.ics', wrap())), /No events to import/);
  assert.deepEqual(calls, []);
});

test('importPreview sends the previewed text once and reports new and updated counts', async () => {
  const calls = [];
  const client = { list: async () => [], importIcs: async (t) => { calls.push(t); return { added: 2, dropped: 0, total: 5 }; }, clear: async () => {} };
  const message = await ui.importPreview(client, ui.previewText('wed.ics', ORDER_ICS));
  assert.deepEqual(calls, [ORDER_ICS]);
  assert.equal(message, 'Imported 2 new events. 2 matching events were updated.');
});

test('importPreview explains events dropped at the store limit, with singular wording', async () => {
  const client = { list: async () => [], importIcs: async () => ({ added: 1, dropped: 1, total: 2000 }), clear: async () => {} };
  const two = wrap(
    ...vevent('UID:a', 'DTSTART:20261014T080000', 'SUMMARY:A'),
    ...vevent('UID:b', 'DTSTART:20261014T090000', 'SUMMARY:B'),
  );
  const message = await ui.importPreview(client, ui.previewText('two.ics', two));
  assert.equal(message, 'Imported 1 new event. 1 matching event was updated. 1 event over the store limit was not kept.');
});

test('without a client the view says the calendar is not connected and offers no import controls', () => {
  const html = render({});
  assert.match(html, /Calendar is not connected/);
  assert.match(html, /No calendar account is read/);
  assert.doesNotMatch(html, /type="file"/);
  assert.doesNotMatch(html, /Import an \.ics file/);
});

test('the connected view has a labelled file input and a polite status region', () => {
  const html = render({ api: { list: async () => [], importIcs: async () => ({ added: 0, dropped: 0, total: 0 }), clear: async () => {} } });
  const input = /<input[^>]*type="file"[^>]*>/.exec(html)?.[0] ?? '';
  assert.match(input, /accept="\.ics,text\/calendar"/);
  const id = /id="([^"]+)"/.exec(input)?.[1];
  assert.ok(id, 'file input has an id');
  assert.match(html, new RegExp(`<label for="${id}">Calendar file \\(\\.ics\\)</label>`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Loading…/);
});

test('stored events render grouped by day, with all-day and floating labels', () => {
  const events = [
    stored({ id: '1', title: 'Standup', start: '2026-10-14T09:00:00', end: '2026-10-14T09:15:00' }),
    stored({ id: '2', title: 'Holiday', start: '2026-10-14', allDay: true, floating: false }),
    stored({ id: '3', title: 'Review', start: '2026-10-16T14:00:00' }),
  ];
  const html = render({ api: { list: async () => events, importIcs: async () => ({ added: 0, dropped: 0, total: 0 }), clear: async () => {} }, initialEvents: events });
  assert.equal((html.match(/role="group"/g) ?? []).length, 2);
  for (const id of [...html.matchAll(/role="group" aria-labelledby="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(html.includes(`id="${id}"`), `heading ${id} exists`);
  }
  assert.ok(html.indexOf('Holiday') < html.indexOf('Standup'), 'all-day event listed before the timed one on the same day');
  assert.ok(html.indexOf('Standup') < html.indexOf('Review'), 'days are in order');
  assert.match(html, /All day/);
  assert.match(html, /Floating time/);
  assert.match(html, /3 events, sorted by date/);
  assert.match(html, /Clear events/);
});

test('event text is escaped in the markup', () => {
  const events = [stored({ id: 'xss', title: '<img src=x onerror=alert(1)>', description: '<a href="javascript:1">x</a>' })];
  const html = render({ api: { list: async () => events, importIcs: async () => ({ added: 0, dropped: 0, total: 0 }), clear: async () => {} }, initialEvents: events });
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img /);
  assert.doesNotMatch(html, /<a href="javascript/);
});

test('the list shows at most 200 events and says so', () => {
  const events = Array.from({ length: 250 }, (_, i) => stored({ id: `e${i}`, title: `Item ${i}`, start: '2026-10-14T08:00:00' }));
  const html = render({ api: { list: async () => events, importIcs: async () => ({ added: 0, dropped: 0, total: 0 }), clear: async () => {} }, initialEvents: events });
  assert.equal((html.match(/class="list-row"/g) ?? []).length, ui.MAX_LIST_ROWS);
  assert.match(html, /Showing the first 200\./);
});

test('an unavailable event list says so instead of showing a loading message forever', () => {
  const html = renderToStaticMarkup(createElement(ui.EventList, { events: null, loadError: 'store offline', onClear: () => {} }));
  assert.match(html, /not available right now/);
  assert.doesNotMatch(html, /Loading…/);
});

test('an empty store shows the empty state and no clear button', () => {
  const html = renderToStaticMarkup(createElement(ui.EventList, { events: [], onClear: () => {} }));
  assert.match(html, /No events imported yet/);
  assert.doesNotMatch(html, /Clear events/);
});

test('an error preview shows the reason and disables import', () => {
  const preview = ui.previewText('notes.txt', 'plain text');
  const html = renderToStaticMarkup(createElement(ui.PreviewPanel, { preview, busy: false, onImport: () => {}, onDiscard: () => {} }));
  assert.match(html, /Nothing imported/);
  assert.match(html, /does not contain a calendar/);
  assert.match(html, /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Import(?:(?!<\/button>).)*<\/button>/s);
});

test('a valid preview lists skipped reasons and the events it will import', () => {
  const ics = wrap(
    ...vevent('UID:ok', 'DTSTART:20261014T090000Z', 'SUMMARY:Kept meeting'),
    ...vevent('UID:r', 'DTSTART:20261014T090000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily'),
  );
  const preview = ui.previewText('mixed.ics', ics);
  const html = renderToStaticMarkup(createElement(ui.PreviewPanel, { preview, busy: false, onImport: () => {}, onDiscard: () => {} }));
  assert.match(html, /Repeating event \(recurrence is not expanded\)/);
  assert.match(html, /Kept meeting/);
  assert.match(html, /Import 1 event</);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Import 1 event/s);
});

test('the view module imports only renderer-safe modules and no Node, Electron or network APIs', async () => {
  const src = await readFile(path.join(root, 'src/components/Calendar.tsx'), 'utf8');
  const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  const allowed = new Set(['react', '@phosphor-icons/react', '../../electron/services/calendar', '../ui/Dialog', '../ui/primitives', '../ui/util']);
  for (const s of specifiers) assert.ok(allowed.has(s), `unexpected import: ${s}`);
  assert.doesNotMatch(src, /node:|require\(|\bfs\b|process\.|window\.jarvis|globalThis|fetch\(|XMLHttpRequest|dangerouslySetInnerHTML/);
  // Event URLs are shown as text, never as links, so nothing from an .ics file becomes a navigation target.
  assert.doesNotMatch(src, /<a\s|href=/);
});
