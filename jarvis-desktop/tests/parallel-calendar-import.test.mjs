// Calendar import review tests: bounded .ics parsing, all-day/zone/DST conversion, bounded recurrence, hostile input,
// conflicts, selection and the request handed to the host. Bundles the real module, the real store parser and the real
// component in memory and renders with react-dom/server. No file, network, account, storage or desktop access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'parallel-calendar-import-entry.ts',
    loader: 'tsx',
    contents: `
      export * as ci from './src/ui/calendar-import.ts';
      export * as store from './electron/services/calendar.ts';
      export * as ui from './src/components/CalendarImport.tsx';
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
const { ci, store, ui, createElement, renderToStaticMarkup } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const NOW = Date.UTC(2026, 9, 15, 12); // 15 Oct 2026
const cal = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const parse = (text, opts = {}) => ci.parseIcsForImport(text, { now: NOW, ...opts });
const skipCount = (p, code) => p.skipped.find((s) => s.code === code)?.count ?? 0;
const starts = (p) => p.candidates.map((c) => c.event.start);

const US_EASTERN_VTZ = (id) => [
  'BEGIN:VTIMEZONE', `TZID:${id}`,
  'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'END:VTIMEZONE',
];

test('UTC, floating and multi-day all-day events normalize to the store shapes', () => {
  const p = parse(cal(
    ev('UID:a', 'SUMMARY:Standup', 'DTSTART:20261020T090000Z', 'DTEND:20261020T091500Z'),
    ev('UID:b', 'SUMMARY:Trip', 'DTSTART;VALUE=DATE:20261101', 'DTEND;VALUE=DATE:20261104'),
    ev('UID:c', 'SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261225'),
    ev('UID:d', 'SUMMARY:Local', 'DTSTART:20261021T080000', 'DURATION:PT30M'),
  ));
  assert.equal(p.error, undefined);
  const by = Object.fromEntries(p.candidates.map((c) => [c.event.id, c]));
  assert.deepEqual([by.a.event.start, by.a.event.end, by.a.event.allDay], ['2026-10-20T09:00:00.000Z', '2026-10-20T09:15:00.000Z', false]);
  assert.deepEqual([by.b.event.start, by.b.event.end, by.b.event.allDay], ['2026-11-01', '2026-11-04', true]);
  assert.equal(by.c.event.end, '2026-12-26');
  assert.ok(by.c.notes.includes('end-defaulted'));
  assert.deepEqual([by.d.event.start, by.d.event.end, by.d.event.floating], ['2026-10-21T08:00:00', '2026-10-21T08:30:00', true]);
  assert.ok(by.d.notes.includes('floating-time') && by.d.notes.includes('end-from-duration'));
  assert.equal(ci.formatWhen(by.b.event, 'UTC'), 'Sun, Nov 1, 2026 – Tue, Nov 3, 2026 (all day)');
  assert.deepEqual(starts(p), ['2026-10-20T09:00:00.000Z', '2026-10-21T08:00:00', '2026-11-01', '2026-12-25']);
});

test('IANA zones convert with the right offset on each side of daylight saving', () => {
  const p = parse(cal(
    ev('UID:s', 'DTSTART;TZID=America/New_York:20260701T090000', 'DTEND;TZID=America/New_York:20260701T100000'),
    ev('UID:w', 'DTSTART;TZID=America/New_York:20260115T090000'),
    ev('UID:k', 'DTSTART;TZID=Asia/Kolkata:20261020T093000'),
    ev('UID:m', 'DTSTART;TZID=/mozilla.org/20050126_1/Europe/Paris:20260701T120000'),
  ));
  const by = Object.fromEntries(p.candidates.map((c) => [c.event.id, c.event]));
  assert.equal(by.s.start, '2026-07-01T13:00:00.000Z');
  assert.equal(by.s.end, '2026-07-01T14:00:00.000Z');
  assert.equal(by.w.start, '2026-01-15T14:00:00.000Z');
  assert.equal(by.k.start, '2026-10-20T04:00:00.000Z');
  assert.equal(by.m.start, '2026-07-01T10:00:00.000Z');
  assert.equal(ci.formatWhen(by.s, 'America/New_York'), 'Wed, Jul 1, 2026, 9:00 AM – 10:00 AM EDT');
});

test('a start inside the spring-forward gap moves forward; a repeated autumn time uses the first occurrence', () => {
  const p = parse(cal(
    ev('UID:gap', 'DTSTART;TZID=America/New_York:20260308T023000'),
    ev('UID:amb', 'DTSTART;TZID=America/New_York:20261101T013000'),
  ));
  const by = Object.fromEntries(p.candidates.map((c) => [c.event.id, c]));
  assert.equal(by.gap.event.start, '2026-03-08T07:30:00.000Z'); // 03:30 EDT, as RFC 5545 specifies
  assert.ok(by.gap.notes.includes('dst-gap-shifted'));
  assert.equal(by.amb.event.start, '2026-11-01T05:30:00.000Z'); // 01:30 EDT, not EST
  assert.ok(by.amb.notes.includes('dst-ambiguous-earlier'));
});

test('weekly recurrence keeps local time across the DST change and a nominal DURATION day stays a calendar day', () => {
  const p = parse(cal(
    ev('UID:wk', 'SUMMARY:Sync', 'DTSTART;TZID=America/New_York:20261026T090000', 'DTEND;TZID=America/New_York:20261026T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ev('UID:dur', 'DTSTART;TZID=America/New_York:20270313T100000', 'DURATION:P1D'),
  ), { horizonDays: 400 });
  const wk = p.candidates.filter((c) => c.event.id === 'wk');
  assert.deepEqual(wk.map((c) => c.event.start), ['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z']);
  assert.deepEqual(wk.map((c) => c.event.end), ['2026-10-26T14:00:00.000Z', '2026-11-02T15:00:00.000Z', '2026-11-09T15:00:00.000Z']);
  assert.deepEqual(wk.map((c) => c.series.index), [0, 1, 2]);
  assert.ok(wk.every((c) => c.notes.includes('recurring-instance')));
  const dur = p.candidates.find((c) => c.event.id === 'dur').event;
  // US DST starts 14 Mar 2027: one nominal day later is 10:00 EDT = 14:00Z, a 23-hour span.
  assert.equal(dur.start, '2027-03-13T15:00:00.000Z');
  assert.equal(dur.end, '2027-03-14T14:00:00.000Z');
});

test('VTIMEZONE rules, Windows names and fixed offsets resolve; unknown zones are skipped, never guessed', () => {
  const p = parse(cal(
    US_EASTERN_VTZ('Custom Eastern'),
    ['BEGIN:VTIMEZONE', 'TZID:Office Time', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0530', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE'],
    ev('UID:v1', 'DTSTART;TZID=Custom Eastern:20260701T090000'),
    ev('UID:v2', 'DTSTART;TZID=Custom Eastern:20261201T090000'),
    ev('UID:v3', 'DTSTART;TZID=Custom Eastern:20260308T023000'),
    ev('UID:off', 'DTSTART;TZID=Office Time:20261020T100000'),
    ev('UID:win', 'DTSTART;TZID=W. Europe Standard Time:20260115T090000'),
    ev('UID:bad', 'DTSTART;TZID=Mars/Olympus_Mons:20261020T100000'),
  ));
  const by = Object.fromEntries(p.candidates.map((c) => [c.event.id, c]));
  assert.equal(by.v1.event.start, '2026-07-01T13:00:00.000Z');
  assert.equal(by.v2.event.start, '2026-12-01T14:00:00.000Z');
  assert.equal(by.v3.event.start, '2026-03-08T07:30:00.000Z');
  assert.ok(by.v1.notes.includes('vtimezone-rules') && by.v3.notes.includes('dst-gap-shifted'));
  assert.equal(by.off.event.start, '2026-10-20T04:30:00.000Z');
  assert.equal(by.win.event.start, '2026-01-15T08:00:00.000Z');
  assert.ok(by.win.notes.includes('windows-zone'));
  assert.equal(by.bad, undefined);
  assert.equal(skipCount(p, 'unsupported-timezone'), 1);
});

test('open-ended recurrence is fast-forwarded into the window and capped per series', () => {
  const p = parse(cal(ev('UID:daily', 'DTSTART:19900101T080000Z', 'RRULE:FREQ=DAILY')));
  assert.equal(p.candidates.length, 31 + 365);
  assert.ok(p.candidates[0].sortMs >= p.window.fromMs && p.candidates.at(-1).sortMs < p.window.toMs);
  assert.ok(p.candidates.every((c) => !c.notes.includes('recurrence-truncated')));
  const long = parse(cal(ev('UID:daily', 'DTSTART:19900101T080000Z', 'RRULE:FREQ=DAILY')), { horizonDays: 1098 });
  assert.equal(long.candidates.length, ci.IMPORT_LIMITS.instancesPerSeries);
  assert.ok(long.candidates.every((c) => c.notes.includes('recurrence-truncated')));
  const old = parse(cal(ev('UID:old', 'DTSTART:20000101T080000Z', 'RRULE:FREQ=WEEKLY;COUNT=5')));
  assert.equal(old.candidates.length, 0);
  assert.equal(skipCount(old, 'recurrence-outside-window'), 1);
});

test('monthly, yearly, UNTIL, EXDATE and overrides follow RFC 5545 within the supported subset', () => {
  const p = parse(cal(
    ev('UID:lastfri', 'DTSTART:20261030T150000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4'),
    ev('UID:d31', 'DTSTART;VALUE=DATE:20261031', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31;COUNT=3'),
    ev('UID:leap', 'DTSTART;VALUE=DATE:20240229', 'RRULE:FREQ=YEARLY'),
    ev('UID:until', 'DTSTART:20261019T100000Z', 'RRULE:FREQ=DAILY;UNTIL=20261021T100000Z', 'EXDATE:20261020T100000Z'),
    ev('UID:ovr', 'SUMMARY:Weekly', 'DTSTART:20261019T100000Z', 'RRULE:FREQ=WEEKLY;COUNT=3'),
    ev('UID:ovr', 'SUMMARY:Moved', 'RECURRENCE-ID:20261026T100000Z', 'DTSTART:20261027T110000Z'),
    ev('UID:ovr', 'RECURRENCE-ID:20261102T100000Z', 'DTSTART:20261102T100000Z', 'STATUS:CANCELLED'),
  ), { horizonDays: 1098 });
  const of = (id) => p.candidates.filter((c) => c.event.id === id);
  assert.deepEqual(of('lastfri').map((c) => c.event.start.slice(0, 10)), ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29']);
  assert.deepEqual(of('d31').map((c) => c.event.start), ['2026-10-31', '2026-12-31', '2027-01-31']);
  assert.deepEqual(of('leap').map((c) => c.event.start), ['2028-02-29']);
  assert.deepEqual(of('until').map((c) => c.event.start), ['2026-10-19T10:00:00.000Z', '2026-10-21T10:00:00.000Z']);
  assert.deepEqual(of('ovr').map((c) => [c.event.title, c.event.start]), [['Weekly', '2026-10-19T10:00:00.000Z'], ['Moved', '2026-10-27T11:00:00.000Z']]);
  assert.ok(of('ovr')[1].notes.includes('override'));
});

test('unsupported recurrence is skipped and counted, never partially imported', () => {
  const p = parse(cal(
    ev('UID:h', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=HOURLY;COUNT=3'),
    ev('UID:sp', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1'),
    ev('UID:cu', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261030T000000Z'),
    ev('UID:r2', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'RRULE:FREQ=WEEKLY;COUNT=2'),
    ev('UID:per', 'DTSTART:20261020T100000Z', 'RDATE;VALUE=PERIOD:20261021T100000Z/PT1H'),
    ev('UID:rng', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261020T100000Z', 'DTSTART:20261020T120000Z'),
    ev('UID:ok', 'DTSTART:20261020T100000Z', 'RDATE:20261022T100000Z,20261024T100000Z'),
  ));
  assert.deepEqual(p.candidates.map((c) => c.event.id), ['ok', 'ok', 'ok']);
  assert.equal(skipCount(p, 'unsupported-recurrence'), 6);
});

test('hostile input: prototype names, oversized and malformed records are rejected without side effects', () => {
  const huge = 'X'.repeat(ci.IMPORT_LIMITS.bytes + 1);
  assert.equal(parse(huge).error, 'too-large');
  assert.equal(parse('hello world').error, 'not-calendar');
  const folded = ['DESCRIPTION:a', ...Array.from({ length: 200 }, () => ' ' + 'b'.repeat(70))];
  const p = parse(cal(
    ev('UID:p1', 'DTSTART:20261020T100000Z', '__proto__:polluted'),
    ev('UID:p2', 'DTSTART;__proto__=x:20261020T100000Z'),
    ev('UID:p3', 'DTSTART:20261020T100000Z', 'BEGIN:constructor', 'END:constructor'),
    ev('UID:many', 'DTSTART:20261020T100000Z', ...Array.from({ length: 300 }, (_, i) => `X-F${i}:1`)),
    ev('UID:long', 'DTSTART:20261020T100000Z', ...folded),
    ev('UID:bad', 'DTSTART:20261340T100000Z'),
    ev('UID:old', 'DTSTART:18000101T100000Z'),
    ev('UID:rev', 'DTSTART:20261020T100000Z', 'DTEND:20261020T090000Z'),
    ev('UID:mix', 'DTSTART;VALUE=DATE:20261020', 'DTEND:20261021T090000Z'),
    ev('UID:gone', 'DTSTART:20261020T100000Z', 'STATUS:CANCELLED'),
    ev('UID:ok', 'SUMMARY:Re‮view', 'DTSTART:20261020T100000Z', 'URL:javascript:alert(1)', 'LOCATION:Room\u0007 4'),
    'BEGIN:VTODO', 'SUMMARY:task', 'END:VTODO',
    'END:VEVENT',
  ));
  assert.deepEqual(p.candidates.map((c) => c.event.id), ['ok']);
  assert.equal(p.candidates[0].event.title, 'Review');
  assert.equal(p.candidates[0].event.location, 'Room 4');
  assert.equal(p.candidates[0].event.url, null);
  assert.equal(skipCount(p, 'unsafe-name'), 3);
  assert.equal(skipCount(p, 'too-many-properties'), 1);
  assert.equal(skipCount(p, 'line-too-long'), 1);
  assert.equal(skipCount(p, 'bad-date'), 1);
  assert.equal(skipCount(p, 'date-out-of-range'), 1);
  assert.equal(skipCount(p, 'bad-range'), 2);
  assert.equal(skipCount(p, 'cancelled'), 1);
  assert.equal(skipCount(p, 'unsupported-component'), 1);
  assert.equal(skipCount(p, 'unbalanced-component'), 1);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.x, undefined);
  // A long run of nested BEGIN lines is cut off instead of growing the stack without bound.
  const deep = parse(cal(Array.from({ length: 40 }, () => 'BEGIN:VEVENT')));
  assert.ok(skipCount(deep, 'nesting-too-deep') > 0);
  assert.equal(deep.candidates.length, 0);
});

test('event count is capped and repeated copies in one file are reported', () => {
  const many = Array.from({ length: ci.IMPORT_LIMITS.events + 5 }, (_, i) => ev(`UID:e${i}`, `DTSTART:20261020T${String(i % 24).padStart(2, '0')}0000Z`));
  const p = parse(cal(...many));
  assert.equal(p.candidates.length, ci.IMPORT_LIMITS.events);
  assert.equal(skipCount(p, 'too-many-events'), 5);
  const dup = parse(cal(ev('UID:x', 'DTSTART:20261020T100000Z'), ev('UID:x', 'DTSTART:20261020T100000Z')));
  assert.equal(dup.candidates.length, 1);
  assert.equal(skipCount(dup, 'duplicate-in-file'), 1);
});

test('conflicts consider stored and selected events, ignore all-day/free time, and back-to-back is not a conflict', () => {
  const stored = [
    { id: 'm', title: 'Dentist', start: '2026-10-20T10:30:00.000Z', end: '2026-10-20T11:30:00.000Z', allDay: false, floating: false, location: '', description: '', url: null },
    { id: 'dup', title: 'Kept', start: '2026-10-22T09:00:00.000Z', end: '2026-10-22T10:00:00.000Z', allDay: false, floating: false, location: '', description: '', url: null },
  ];
  const p = parse(cal(
    ev('UID:a', 'SUMMARY:Review', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z'),
    ev('UID:b', 'SUMMARY:Lunch', 'DTSTART:20261020T113000Z', 'DTEND:20261020T123000Z'),
    ev('UID:c', 'SUMMARY:Overlap', 'DTSTART:20261020T120000Z', 'DTEND:20261020T130000Z'),
    ev('UID:d', 'SUMMARY:Day off', 'DTSTART;VALUE=DATE:20261020'),
    ev('UID:f', 'SUMMARY:Focus', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z', 'TRANSP:TRANSPARENT'),
    ev('UID:l', 'SUMMARY:Local', 'DTSTART:20261020T063000', 'DTEND:20261020T073000'),
    ev('UID:dup', 'SUMMARY:Kept', 'DTSTART:20261022T090000Z', 'DTEND:20261022T100000Z'),
  ));
  const sel = ci.defaultSelection(p, stored);
  const dupKey = store.eventKey(stored[1]);
  assert.ok(!sel.has(dupKey) && sel.size === 6);
  const r = ci.reviewSelection(p, sel, stored, 'America/New_York');
  const keyOf = (id) => p.candidates.find((c) => c.event.id === id).key;
  assert.deepEqual(r.conflicts.get(keyOf('a')).map((x) => [x.title, x.source]), [['Dentist', 'stored'], ['Local', 'import']]);
  assert.deepEqual(r.conflicts.get(keyOf('c')).map((x) => [x.title, x.source]), [['Lunch', 'import']]);
  assert.deepEqual(r.conflicts.get(keyOf('b')).map((x) => [x.title, x.source]), [['Overlap', 'import']]);
  // Floating 06:30–07:30 New York time is 10:30–11:30Z, so it overlaps Review and Dentist in that zone only.
  assert.deepEqual(r.conflicts.get(keyOf('l')).map((x) => x.title).sort(), ['Dentist', 'Review']);
  assert.equal(r.conflicts.has(keyOf('d')), false);
  assert.equal(r.conflicts.has(keyOf('f')), false);
  assert.equal(r.duplicates.has(dupKey), true);
  assert.equal(r.replaceCount, 0);
  const without = new Set([...sel].filter((k) => k !== keyOf('c')));
  const r2 = ci.reviewSelection(p, without, stored, 'America/New_York');
  assert.equal(r2.conflicts.has(keyOf('b')), false);
  assert.equal(r2.conflicts.has(keyOf('c')), true); // still shown on the unselected row, as a warning
  assert.equal(r2.conflictCount, 2);
  const inUtc = ci.reviewSelection(p, sel, stored, 'UTC');
  assert.equal(inUtc.conflicts.has(keyOf('l')), false);
});

test('the import request contains only selected events and round-trips through the store parser unchanged', () => {
  const p = parse(cal(
    ev('UID:z', 'SUMMARY:Zoned, with comma', 'DTSTART;TZID=Europe/Berlin:20261020T090000', 'DTEND;TZID=Europe/Berlin:20261020T100000', 'DESCRIPTION:Line 1\\nLine 2'),
    ev('UID:r', 'SUMMARY:Repeat', 'DTSTART;TZID=America/New_York:20261026T090000', 'RRULE:FREQ=WEEKLY;COUNT=2'),
    ev('UID:a', 'SUMMARY:All day', 'DTSTART;VALUE=DATE:20261030'),
    ev('UID:f', 'SUMMARY:Floating', 'DTSTART:20261031T080000', 'DTEND:20261031T090000', 'URL:https://example.org/x'),
    ev('UID:skip', 'SUMMARY:Unselected', 'DTSTART:20261101T080000Z'),
  ));
  assert.deepEqual(ci.buildImportRequest(p, new Set(), 'x.ics', new Date(NOW)), { ok: false, reason: 'nothing-selected' });
  const keys = new Set(p.candidates.filter((c) => c.event.id !== 'skip').map((c) => c.key));
  const built = ci.buildImportRequest(p, keys, 'work.ics', new Date(NOW));
  assert.equal(built.ok, true);
  assert.equal(built.request.sourceName, 'work.ics');
  assert.equal(built.request.events.length, 5);
  assert.ok(!/RRULE|TZID/.test(built.request.ics));
  const reparsed = store.parseIcs(built.request.ics);
  assert.deepEqual(reparsed.skipped, []);
  assert.deepEqual(reparsed.events, built.request.events);
  assert.ok(reparsed.events.some((e) => e.id === 'r' && e.start === '2026-11-02T14:00:00.000Z'));
});

test('component renders the preview, conflicts, skipped reasons and selection without importing anything', () => {
  let calls = 0;
  const stored = [{ id: 'm', title: 'Dentist', start: '2026-10-20T10:30:00.000Z', end: '2026-10-20T11:30:00.000Z', allDay: false, floating: false, location: '', description: '', url: null }];
  const text = cal(
    ev('UID:a', 'SUMMARY:Review', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z'),
    ev('UID:m', 'SUMMARY:Dentist', 'DTSTART:20261020T103000Z', 'DTEND:20261020T113000Z'),
    ev('UID:h', 'DTSTART:20261020T100000Z', 'RRULE:FREQ=HOURLY'),
    ev('UID:g', 'SUMMARY:Gap', 'DTSTART;TZID=America/New_York:20270314T023000'),
  );
  const html = renderToStaticMarkup(createElement(ui.CalendarImport, {
    existing: stored, source: { name: 'work.ics', text }, now: NOW, timeZone: 'UTC',
    onImport: async () => { calls++; return { added: 0, dropped: 0, total: 0 }; },
  }));
  assert.equal(calls, 0);
  assert.match(html, /3 events found/);
  assert.match(html, /2 selected/);
  assert.match(html, /1 already stored/);
  assert.match(html, /1 conflict</);
  assert.match(html, /Overlaps: Dentist \(already in calendar\)/);
  assert.match(html, /Recurring events with rules this app does not expand/);
  assert.match(html, /moved forward/);
  assert.match(html, /Time zone in file: America\/New_York/);
  assert.match(html, /Import 2 events…/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
  assert.equal((html.match(/checked=""/g) ?? []).length, 2);
  assert.match(html, /Paste iCalendar/);
  const bad = renderToStaticMarkup(createElement(ui.CalendarImport, { existing: [], source: { name: 'notes.txt', text: 'hello' }, onImport: async () => ({ added: 0, dropped: 0, total: 0 }), allowPaste: false }));
  assert.match(bad, /notes\.txt was not read/);
  assert.doesNotMatch(bad, /Paste iCalendar/);
});

test('confirmation and outcome copy state exactly what changes', () => {
  const p = parse(cal(ev('UID:a', 'DTSTART:20261020T100000Z', 'DTEND:20261020T110000Z'), ev('UID:b', 'DTSTART:20261020T103000Z', 'DTEND:20261020T113000Z')));
  const stored = [{ ...p.candidates[0].event }];
  const keys = new Set(p.candidates.map((c) => c.key));
  const lines = ui.confirmationLines(ci.reviewSelection(p, keys, stored, 'UTC'));
  assert.equal(lines[0], '2 events will be added to the calendar stored on this device.');
  assert.match(lines[1], /2 selected events overlap other events/);
  assert.match(lines[2], /1 event already stored will be replaced/);
  assert.match(lines.at(-1), /No calendar account, reminder, routine or system setting is changed/);
  assert.equal(ui.outcomeMessage({ added: 2, dropped: 1, total: 2000 }), 'Imported 2 new events; 2000 events stored on this device. 1 event over the store limit was not kept.');
});

test('duration parser accepts RFC forms and rejects negative, empty or excessive values', () => {
  assert.deepEqual(ci.parseDuration('P1W'), { days: 7, ms: 0 });
  assert.deepEqual(ci.parseDuration('P1DT2H30M'), { days: 1, ms: 9_000_000 });
  assert.deepEqual(ci.parseDuration('PT45S'), { days: 0, ms: 45_000 });
  for (const bad of ['-PT1H', 'P', 'PT', 'P1Y', 'P400D', 'P1H', '']) assert.equal(ci.parseDuration(bad), null, bad);
});

test('worst-case recurring input stays bounded in output and time', () => {
  const evs = [];
  for (let i = 0; i < ci.IMPORT_LIMITS.events; i++) {
    evs.push(ev(`UID:e${i}`, `DTSTART;TZID=America/New_York:19000101T0900${String(i % 60).padStart(2, '0')}`, i % 2 ? 'RRULE:FREQ=DAILY' : 'RRULE:FREQ=DAILY;COUNT=999999999'));
  }
  const t0 = performance.now();
  const p = parse(cal(...evs), { horizonDays: 1098 });
  const parseMs = performance.now() - t0;
  assert.equal(p.candidates.length, ci.IMPORT_LIMITS.events);
  assert.ok(skipCount(p, 'too-many-events') > 0);
  const t1 = performance.now();
  const r = ci.reviewSelection(p, new Set(p.candidates.map((c) => c.key)), p.candidates.map((c) => c.event), 'America/New_York');
  const reviewMs = performance.now() - t1;
  assert.ok(r.selected.length === ci.IMPORT_LIMITS.events);
  console.log(`# worst-case parse ${Math.round(parseMs)} ms, review ${Math.round(reviewMs)} ms`);
  assert.ok(parseMs < 15_000 && reviewMs < 15_000, `parse ${parseMs} ms, review ${reviewMs} ms`);
});
