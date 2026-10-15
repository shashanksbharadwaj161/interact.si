// Calendar .ics export slice: pure RFC 5545 serializer (src/ui/calendar-export.ts) and the Calendar view's export group.
// Bundles the real modules in memory (esbuild data-URL pattern) and renders with react-dom/server.
// No file, network, account, storage or desktop access.
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
    sourcefile: 'slice-calendar-export-entry.ts',
    loader: 'tsx',
    contents: `
      export * as ex from './src/ui/calendar-export.ts';
      export * as store from './electron/services/calendar.ts';
      export * as ci from './src/ui/calendar-import.ts';
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
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
});
const { ex, store, ci, ui, createElement, renderToStaticMarkup } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const ev = (o) => ({ id: 'e1', title: 'Event', start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T10:00:00.000Z', allDay: false, floating: false, location: '', description: '', url: null, ...o });
const lines = (text) => text.split('\r\n');
const unfolded = (text) => store.unfoldLines(text);
const prop = (text, name) => unfolded(text).filter((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
const octets = (s) => Buffer.byteLength(s, 'utf8');

test('module is pure: only type imports, no DOM, clock, randomness, storage or network', async () => {
  const src = await readFile(path.join(root, 'src/ui/calendar-export.ts'), 'utf8');
  const imports = [...src.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
  for (const i of imports) assert.match(i, /^import type .* from '(\.\.\/\.\.\/electron\/services\/calendar|\.\.\/shared\/contracts)';$/);
  assert.doesNotMatch(src, /\bdocument\b|\bwindow\b|localStorage|Date\.now|performance\.now|Math\.random|fetch\(|XMLHttpRequest|require\(|node:|https?:\/\//);
});

test('calendar envelope, CRLF endings and one VEVENT per event with required properties', () => {
  const r = ex.eventsToIcs([ev({ id: 'a' }), ev({ id: 'b', start: '2026-10-21T09:00:00.000Z', end: null })], { now: NOW });
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.skipped));
  assert.equal(r.count, 2);
  assert.ok(r.text.endsWith('END:VCALENDAR\r\n'));
  assert.doesNotMatch(r.text.replace(/\r\n/g, ''), /[\r\n]/, 'no bare CR or LF');
  const ls = lines(r.text);
  assert.deepEqual(ls.slice(0, 4), ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${ex.DEFAULT_PRODID}`, 'CALSCALE:GREGORIAN']);
  assert.equal(ls.filter((l) => l === 'BEGIN:VEVENT').length, 2);
  assert.equal(ls.filter((l) => l === 'END:VEVENT').length, 2);
  assert.deepEqual(prop(r.text, 'DTSTAMP'), ['DTSTAMP:20261015T120000Z', 'DTSTAMP:20261015T120000Z']);
  assert.deepEqual(prop(r.text, 'UID'), ['UID:a', 'UID:b']);
  assert.deepEqual(prop(r.text, 'DTEND'), ['DTEND:20261020T100000Z'], 'event without end has no DTEND');
  assert.equal(r.bytes, octets(r.text));
  const custom = ex.eventsToIcs([], { prodId: '-//Test, Inc//X//EN\r\nX-INJECT:1', now: NOW });
  assert.equal(prop(custom.text, 'PRODID')[0], 'PRODID:-//Test\\, Inc//X//EN X-INJECT:1');
  assert.equal(prop(custom.text, 'X-INJECT').length, 0, 'no header injection through prodId');
});

test('all-day events use VALUE=DATE; timed events are UTC Z, offsets are converted; floating stays unshifted', () => {
  const r = ex.eventsToIcs([
    ev({ id: 'd', start: '2026-12-24', end: '2026-12-26', allDay: true }),
    ev({ id: 'o', start: '2026-07-01T09:00:00-04:00', end: '2026-07-01T14:30:15+00:00' }),
    ev({ id: 'f', start: '2026-10-21T08:00:00', end: '2026-10-21T08:30:00', floating: true }),
  ], { now: NOW });
  assert.equal(r.count, 3);
  assert.deepEqual(prop(r.text, 'DTSTART'), ['DTSTART;VALUE=DATE:20261224', 'DTSTART:20260701T130000Z', 'DTSTART:20261021T080000']);
  assert.deepEqual(prop(r.text, 'DTEND'), ['DTEND;VALUE=DATE:20261226', 'DTEND:20260701T143015Z', 'DTEND:20261021T083000']);
  assert.equal(ex.utcStamp(Date.UTC(2026, 0, 2, 3, 4, 5)), '20260102T030405Z');
});

test('text escaping of backslash, semicolon, comma and newlines; control characters removed; empty fields omitted', () => {
  const r = ex.eventsToIcs([ev({ title: 'a\\b;c,d\ne\r\nf', description: 'x\u0007y\u202Ez', location: 'Room 1, Floor 2' })], { now: NOW });
  assert.equal(prop(r.text, 'SUMMARY')[0], 'SUMMARY:a\\\\b\\;c\\,d\\ne\\nf');
  assert.equal(prop(r.text, 'DESCRIPTION')[0], 'DESCRIPTION:xyz');
  assert.equal(prop(r.text, 'LOCATION')[0], 'LOCATION:Room 1\\, Floor 2');
  const bare = ex.eventsToIcs([ev({})], { now: NOW });
  assert.equal(prop(bare.text, 'DESCRIPTION').length, 0);
  assert.equal(prop(bare.text, 'LOCATION').length, 0);
});

test('lines fold at 75 octets without splitting multibyte characters and unfold to the original', () => {
  const title = 'Café 日本語 🎉 '.repeat(20);
  const r = ex.eventsToIcs([ev({ title })], { now: NOW });
  for (const l of lines(r.text)) assert.ok(octets(l) <= 75, `line over 75 octets: ${octets(l)}`);
  assert.ok(lines(r.text).some((l) => l.startsWith(' ')), 'long line was folded');
  assert.doesNotMatch(r.text, /\uFFFD/);
  assert.equal(prop(r.text, 'SUMMARY')[0], `SUMMARY:${title}`);
  const folded = ex.foldLine('X:' + 'é'.repeat(80));
  const parts = folded.split('\r\n');
  assert.equal(octets(parts[0]), 74, 'a 2-octet char that would cross 75 moves to the next line');
  for (const p of parts.slice(1)) assert.ok(p.startsWith(' ') && octets(p) <= 75);
});

test('UID is stable from the event id and independent of other fields or order', () => {
  const a = ex.eventsToIcs([ev({ id: 'uid-1@example', title: 'One' }), ev({ id: 'x;y,z', title: 'Two' })], { now: NOW });
  const b = ex.eventsToIcs([ev({ id: 'x;y,z', title: 'Changed' }), ev({ id: 'uid-1@example', title: 'Other' })], { now: NOW + 9e6 });
  assert.deepEqual(prop(a.text, 'UID'), ['UID:uid-1@example', 'UID:x\\;y\\,z']);
  assert.deepEqual(prop(b.text, 'UID').sort(), prop(a.text, 'UID').sort());
});

test('invalid and unbounded events are skipped with exact reasons and never throw', () => {
  const input = [
    null,
    'nope',
    ev({ id: '' }),
    ev({ id: 'x'.repeat(256) }),
    ev({ id: 's1', start: 'not-a-date' }),
    ev({ id: 's2', start: '2026-02-30T09:00:00Z', end: null }),
    ev({ id: 's3', start: '2026-10-20T09:00:00' }),
    ev({ id: 'e1b', end: 'garbage' }),
    ev({ id: 'r1', start: '1899-12-31T00:00:00Z', end: null }),
    ev({ id: 'r2', start: '2101-01-01', end: null, allDay: true }),
    ev({ id: 'b1', start: '2026-10-20T10:00:00Z', end: '2026-10-20T09:00:00Z' }),
    ev({ id: 'm1', start: '2026-10-20', end: '2026-10-21T00:00:00Z', allDay: true }),
    ev({ id: 'ok' }),
    ev({ id: 'ok' }),
  ];
  let r;
  assert.doesNotThrow(() => { r = ex.eventsToIcs(input, { now: NOW }); });
  assert.equal(r.count, 1);
  assert.deepEqual(r.skipped.map((s) => [s.index, s.reason]), [
    [0, 'not-an-event'], [1, 'not-an-event'], [2, 'missing-id'], [3, 'id-too-long'], [4, 'invalid-start'], [5, 'invalid-start'],
    [6, 'invalid-start'], [7, 'invalid-end'], [8, 'date-out-of-range'], [9, 'date-out-of-range'], [10, 'end-before-start'],
    [11, 'mixed-all-day'], [13, 'duplicate'],
  ]);
  assert.equal(r.skipped[4].id, 's1');
  assert.doesNotThrow(() => ex.eventsToIcs(undefined));
  assert.equal(ex.eventsToIcs('junk').count, 0);
  const zero = ex.eventsToIcs([ev({ end: '2026-10-20T09:00:00.000Z' })], { now: NOW });
  assert.equal(prop(zero.text, 'DTEND').length, 0, 'zero-length event is written without DTEND');
});

test('limits: summary and description are shortened, event count and total size are capped', () => {
  assert.deepEqual({ ...ex.EXPORT_LIMITS }, { events: 5000, summaryChars: 500, descriptionChars: 5000, locationChars: 1000, uidChars: 255, bytes: 2 * 1024 * 1024 });
  const long = ex.eventsToIcs([ev({ title: '😀'.repeat(600), description: 'd'.repeat(6000) })], { now: NOW });
  assert.equal(long.truncated, true);
  assert.equal(Array.from(prop(long.text, 'SUMMARY')[0].slice(8)).length, 500);
  assert.equal(prop(long.text, 'DESCRIPTION')[0].length, 'DESCRIPTION:'.length + 5000);
  assert.equal(ex.eventsToIcs([ev({})], { now: NOW }).truncated, false);

  const many = Array.from({ length: 5003 }, (_, i) => ev({ id: `n${i}` }));
  const capped = ex.eventsToIcs(many, { now: NOW });
  assert.equal(capped.count, 5000);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.skipped.map((s) => s.reason), ['over-event-limit', 'over-event-limit', 'over-event-limit']);

  const big = Array.from({ length: 1000 }, (_, i) => ev({ id: `b${i}`, description: 'x'.repeat(4000) }));
  const sized = ex.eventsToIcs(big, { now: NOW });
  assert.ok(sized.bytes <= ex.EXPORT_LIMITS.bytes, `${sized.bytes} within limit`);
  assert.ok(sized.count > 0 && sized.count < 1000);
  assert.equal(sized.truncated, true);
  assert.equal(sized.skipped.length, 1000 - sized.count);
  assert.ok(sized.skipped.every((s) => s.reason === 'over-size-limit'));
});

test('deterministic for the same input and now; DTSTAMP is the only now-dependent part', () => {
  const input = [ev({ id: 'a', title: 'Ünïcode, ok' }), ev({ id: 'b', start: '2026-11-01', end: null, allDay: true })];
  const a = ex.eventsToIcs(input, { now: NOW });
  const b = ex.eventsToIcs(structuredClone(input), { now: new Date(NOW) });
  assert.equal(a.text, b.text);
  const c = ex.eventsToIcs(input, { now: NOW + 3_600_000 });
  assert.notEqual(a.text, c.text);
  assert.equal(a.text.replace(/DTSTAMP:\S+/g, ''), c.text.replace(/DTSTAMP:\S+/g, ''));
  assert.equal(prop(ex.eventsToIcs(input).text, 'DTSTAMP')[0], 'DTSTAMP:19700101T000000Z', 'default now is the epoch, not the clock');
});

test('summarizeExport reports count, date span and grouped skipped reasons', () => {
  const s = ex.summarizeExport([
    ev({ id: 'late', start: '2026-12-31T23:30:00.000Z', end: null }),
    ev({ id: 'early', start: '2026-03-01', end: null, allDay: true }),
    ev({ id: 'bad1', start: 'x' }),
    ev({ id: 'bad2', start: 'y' }),
    null,
  ]);
  assert.ok(Object.isFrozen(s));
  assert.equal(s.count, 2);
  assert.equal(s.firstDate, '2026-03-01');
  assert.equal(s.lastDate, '2026-12-31');
  assert.equal(s.skippedTotal, 3);
  assert.deepEqual(s.skipped.map((x) => [x.reason, x.count]), [['invalid-start', 2], ['not-an-event', 1]]);
  assert.equal(s.skipped[0].label, ex.EXPORT_SKIP_LABELS['invalid-start']);
  assert.deepEqual([ex.summarizeExport([]).firstDate, ex.summarizeExport([]).count], [null, 0]);
  assert.equal(ex.formatBytes(512), '512 B');
  assert.equal(ex.formatBytes(2048), '2 KB');
  assert.equal(ex.exportFileName('2026-10-15'), 'calendar-2026-10-15.ics');
  assert.equal(ex.exportFileName('../x'), 'calendar.ics');
});

test('round-trips through the store parser and the import review parser', () => {
  const input = [
    ev({ id: 'rt-1', title: 'Plan; review, \\ ship\nnext', description: 'Line 1\nLine 2', location: 'Room, 3' }),
    ev({ id: 'rt-2', title: 'Holiday', start: '2026-12-25', end: '2026-12-26', allDay: true }),
    ev({ id: 'rt-3', title: 'Local lunch', start: '2026-10-21T12:00:00', end: '2026-10-21T13:00:00', floating: true }),
  ];
  const r = ex.eventsToIcs(input, { now: NOW });
  const parsed = store.parseIcs(r.text);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.skipped, []);
  const pick = (e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, floating: e.floating, location: e.location, description: e.description });
  assert.deepEqual(parsed.events.map(pick), input.map(pick));
  const review = ci.parseIcsForImport(r.text, { now: NOW });
  assert.equal(review.error, undefined);
  assert.deepEqual(review.candidates.map((c) => c.event.id).sort(), ['rt-1', 'rt-2', 'rt-3']);
});

test('ExportPanel renders the summary, skipped reasons, size and download; the app dialog button only when offered', () => {
  const events = [ev({ id: 'p1', start: '2026-10-20T09:00:00.000Z' }), ev({ id: 'p2', start: '2026-10-25', end: null, allDay: true }), ev({ id: 'bad', start: 'nope' })];
  const html = renderToStaticMarkup(createElement(ui.ExportPanel, { events, exporter: ex, busy: false }));
  assert.match(html, /Export calendar/);
  assert.match(html, /2 events from/);
  assert.match(html, /Estimated size: [\d.]+ (B|KB)/);
  assert.match(html, /Missing or unreadable start/);
  assert.match(html, />Preview \.ics</);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Download \.ics</);
  assert.doesNotMatch(html, /Save via app dialog/);
  assert.doesNotMatch(html, /<textarea/, 'preview text opens on request');
  const withDialog = renderToStaticMarkup(createElement(ui.ExportPanel, { events, exporter: ex, busy: false, onSaveViaApp: () => {} }));
  assert.match(withDialog, /Save via app dialog…/);
  const empty = renderToStaticMarkup(createElement(ui.ExportPanel, { events: [], exporter: ex, busy: false }));
  assert.match(empty, /No events can be exported yet/);
  assert.match(empty, /<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Download \.ics/s);
  const loading = renderToStaticMarkup(createElement(ui.ExportPanel, { events: null, exporter: null, busy: false }));
  assert.match(loading, /Loading…/);
});

test('Calendar.tsx wires the preview textarea, Blob download with revoke, and the optional exportIcs bridge', async () => {
  const src = await readFile(path.join(root, 'src/components/Calendar.tsx'), 'utf8');
  assert.match(src, /import\('\.\.\/ui\/calendar-export'\)/);
  assert.match(src, /eventsToIcs\(events, \{ now: new Date\(\) \}\)/);
  assert.match(src, /summarizeExport\(events, result\)/);
  assert.match(src, /<textarea id=\{textId\} className="input" readOnly/);
  assert.match(src, /value=\{prepared\.result\.text\}/);
  assert.match(src, /new Blob\(\[text\], \{ type: 'text\/calendar;charset=utf-8' \}\)/);
  assert.match(src, /URL\.createObjectURL/);
  assert.match(src, /URL\.revokeObjectURL\(url\)/);
  assert.match(src, /onSaveViaApp=\{api\.exportIcs \? \(\) => void runExport\(\) : undefined\}/);
  assert.match(src, /<ExportPanel/);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket/);
});
