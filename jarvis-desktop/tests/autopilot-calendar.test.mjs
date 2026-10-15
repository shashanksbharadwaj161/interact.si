// Local calendar (.ics) tests: unfolding, escaping, date handling, bounds, unsupported features, export and store helpers.
// Bundles the real TypeScript module in memory. No file, network or personal calendar access.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'calendar-entry.ts',
    loader: 'ts',
    contents: `export * as calendar from './electron/services/calendar.ts';`,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const url = `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`;
const { calendar: cal } = await import(url);

const wrap = (...body) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...body, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const skipCount = (r, code) => r.skipped.find((s) => s.code === code)?.count ?? 0;

test('unfoldLines joins continuation lines and keeps the leading character after the fold', () => {
  // Only the first whitespace character of a continuation is removed, so the second space is kept.
  assert.deepEqual(cal.unfoldLines('SUMMARY:Hello\r\n  world\r\n\tX\nNEXT:1'), ['SUMMARY:Hello worldX', 'NEXT:1']);
  // Only one leading whitespace character is removed, so a single space in a fold leaves no word break.
  assert.deepEqual(cal.unfoldLines('A:one\r\n two\r\nB:3'), ['A:onetwo', 'B:3']);
});

test('parseProperty handles quoted parameters that contain colons and semicolons', () => {
  const p = cal.parseProperty('DTSTART;TZID="Europe/Paris";VALUE=DATE-TIME:20261014T090000');
  assert.equal(p.name, 'DTSTART');
  assert.equal(p.params.TZID, 'Europe/Paris');
  assert.equal(p.value, '20261014T090000');
  assert.equal(cal.parseProperty('NO-COLON-HERE'), null);
});

test('unescapeText reverses RFC 5545 escapes and strips control characters', () => {
  assert.equal(cal.unescapeText('a\\, b\\; c\\\\ d\\nline\\Nnext'), 'a, b; c\\ d\nline\nnext');
  assert.equal(cal.unescapeText('bad\u0000\u0007\u001Bchars'), 'badchars');
  assert.equal(cal.unescapeText('x'.repeat(5000)).length, cal.MAX_TEXT_CHARS);
});

test('parses UTC, all-day and floating events with correct start values', () => {
  const ics = wrap(
    ...vevent('UID:utc-1', 'DTSTART:20261014T090000Z', 'DTEND:20261014T100000Z', 'SUMMARY:Standup'),
    ...vevent('UID:day-1', 'DTSTART;VALUE=DATE:20261015', 'SUMMARY:Holiday'),
    ...vevent('UID:float-1', 'DTSTART:20261016T120000', 'SUMMARY:Lunch'),
  );
  const r = cal.parseIcs(ics);
  assert.equal(r.error, undefined);
  assert.equal(r.events.length, 3);
  const [utc, day, float] = r.events;
  assert.equal(utc.start, '2026-10-14T09:00:00.000Z');
  assert.equal(utc.end, '2026-10-14T10:00:00.000Z');
  assert.equal(utc.allDay, false);
  assert.equal(utc.floating, false);
  assert.equal(day.start, '2026-10-15');
  assert.equal(day.allDay, true);
  assert.equal(float.start, '2026-10-16T12:00:00');
  assert.equal(float.floating, true);
});

test('UTC TZID values are accepted; other TZIDs are skipped with a clear code', () => {
  const ics = wrap(
    ...vevent('UID:a', 'DTSTART;TZID=UTC:20261014T090000', 'SUMMARY:A'),
    ...vevent('UID:b', 'DTSTART;TZID=Europe/Paris:20261014T090000', 'SUMMARY:B'),
  );
  const r = cal.parseIcs(ics);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].title, 'A');
  assert.equal(skipCount(r, 'unsupported-timezone'), 1);
});

test('recurring events (RRULE, RDATE, EXDATE, RECURRENCE-ID) are skipped and counted', () => {
  const ics = wrap(
    ...vevent('UID:r1', 'DTSTART:20261014T090000Z', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Daily'),
    ...vevent('UID:r2', 'DTSTART:20261014T090000Z', 'EXDATE:20261015T090000Z', 'SUMMARY:Ex'),
    ...vevent('UID:r3', 'DTSTART:20261014T090000Z', 'RECURRENCE-ID:20261014T090000Z', 'SUMMARY:Override'),
    ...vevent('UID:ok', 'DTSTART:20261014T090000Z', 'SUMMARY:Once'),
  );
  const r = cal.parseIcs(ics);
  assert.deepEqual(r.events.map((e) => e.title), ['Once']);
  assert.equal(skipCount(r, 'unsupported-recurrence'), 3);
});

test('events with missing or invalid dates are skipped; impossible calendar dates are rejected', () => {
  const ics = wrap(
    ...vevent('UID:none', 'SUMMARY:No start'),
    ...vevent('UID:feb30', 'DTSTART:20260230T090000Z'),
    ...vevent('UID:month13', 'DTSTART:20261301T090000Z'),
    ...vevent('UID:hour25', 'DTSTART:20261014T250000Z'),
    ...vevent('UID:junk', 'DTSTART:not-a-date'),
    ...vevent('UID:old', 'DTSTART:18991231T000000Z'),
    ...vevent('UID:future', 'DTSTART;VALUE=DATE:21010101'),
    ...vevent('UID:badend', 'DTSTART:20261014T090000Z', 'DTEND:20261014X'),
  );
  const r = cal.parseIcs(ics);
  assert.equal(r.events.length, 0);
  assert.equal(skipCount(r, 'missing-start'), 1);
  assert.equal(skipCount(r, 'bad-date'), 5);
  assert.equal(skipCount(r, 'date-out-of-range'), 2);
});

test('leap days are accepted only in leap years', () => {
  const ok = cal.parseIcs(wrap(...vevent('UID:l', 'DTSTART:20280229T000000Z')));
  assert.equal(ok.events[0].start, '2028-02-29T00:00:00.000Z');
  const bad = cal.parseIcs(wrap(...vevent('UID:l', 'DTSTART:20270229T000000Z')));
  assert.equal(bad.events.length, 0);
  assert.equal(skipCount(bad, 'bad-date'), 1);
});

test('only http(s) URLs are kept; javascript:, file: and oversized values never reach the event', () => {
  const ics = wrap(
    ...vevent('UID:js', 'DTSTART:20261014T090000Z', 'URL:javascript:alert(1)'),
    ...vevent('UID:file', 'DTSTART:20261014T090000Z', 'URL:file:///C:/secret.txt'),
    ...vevent('UID:ok', 'DTSTART:20261014T090000Z', 'URL:https://example.com/meet'),
    ...vevent('UID:long', 'DTSTART:20261014T090000Z', `URL:https://example.com/${'a'.repeat(3000)}`),
  );
  const r = cal.parseIcs(ics);
  const byId = Object.fromEntries(r.events.map((e) => [e.id, e.url]));
  assert.equal(byId.js, null);
  assert.equal(byId.file, null);
  assert.equal(byId.ok, 'https://example.com/meet');
  assert.equal(byId.long, null);
});

test('folded text is unfolded and escaped text is unescaped in SUMMARY and DESCRIPTION', () => {
  const ics = wrap(
    ...vevent(
      'UID:t1',
      'DTSTART:20261014T090000Z',
      'SUMMARY:Planning\\, review\\; Q4',
      'DESCRIPTION:First line\\nSecond\\, line with a very long continuation that',
      '  is folded across lines',
    ),
  );
  const e = cal.parseIcs(ics).events[0];
  assert.equal(e.title, 'Planning, review; Q4');
  assert.equal(e.description, 'First line\nSecond, line with a very long continuation that is folded across lines');
});

test('VALARM blocks do not overwrite event fields', () => {
  const ics = wrap(
    ...vevent(
      'UID:al',
      'DTSTART:20261014T090000Z',
      'SUMMARY:Real title',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'SUMMARY:Alarm text',
      'END:VALARM',
    ),
  );
  assert.equal(cal.parseIcs(ics).events[0].title, 'Real title');
});

test('rejects files that are too large or are not calendars, without parsing them', () => {
  const big = 'x'.repeat(cal.MAX_ICS_BYTES + 1);
  assert.deepEqual(cal.parseIcs(big), { events: [], skipped: [], error: 'too-large' });
  assert.deepEqual(cal.parseIcs('BEGIN:VCARD\r\nFN:Someone\r\nEND:VCARD'), { events: [], skipped: [], error: 'not-calendar' });
  assert.deepEqual(cal.parseIcs(''), { events: [], skipped: [], error: 'not-calendar' });
});

test('over-long lines are dropped and counted; the rest of the file still parses', () => {
  const ics = wrap(
    ...vevent('UID:big', 'DTSTART:20261014T090000Z', `SUMMARY:${'z'.repeat(cal.MAX_LINE_CHARS + 10)}`),
    ...vevent('UID:fine', 'DTSTART:20261014T090000Z', 'SUMMARY:Fine'),
  );
  const r = cal.parseIcs(ics);
  assert.equal(skipCount(r, 'line-too-long'), 1);
  assert.equal(r.events.find((e) => e.id === 'fine').title, 'Fine');
  assert.equal(r.events.find((e) => e.id === 'big').title, '(untitled)');
});

test('event count is capped; extra VEVENT blocks are counted, not parsed', () => {
  const blocks = [];
  for (let i = 0; i < cal.MAX_EVENTS + 25; i++) blocks.push(...vevent(`UID:${i}`, 'DTSTART:20261014T090000Z', 'SUMMARY:x'));
  const r = cal.parseIcs(wrap(...blocks));
  assert.equal(r.events.length, cal.MAX_EVENTS);
  assert.equal(skipCount(r, 'too-many-events'), 25);
});

test('missing UID gets a deterministic synthetic id', () => {
  const r = cal.parseIcs(wrap(...vevent('DTSTART:20261014T090000Z', 'SUMMARY:No uid')));
  assert.equal(r.events[0].id, 'local:2026-10-14T09:00:00.000Z:No uid');
});

test('toIcs escapes text, folds long lines at 75 octets and uses CRLF', () => {
  const event = {
    id: 'exp-1',
    title: 'A, B; C\\D',
    start: '2026-10-14T09:00:00.000Z',
    end: '2026-10-14T10:00:00.000Z',
    allDay: false,
    floating: false,
    location: '',
    description: 'Line one\nLine two ' + 'é'.repeat(60),
    url: 'https://example.com/x',
  };
  const text = cal.toIcs([event], new Date('2026-10-13T08:00:00.000Z'));
  assert.ok(text.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(text), 'every newline must be CRLF');
  assert.ok(text.includes('SUMMARY:A\\, B\\; C\\\\D\r\n'));
  assert.ok(text.includes('DTSTART:20261014T090000Z'));
  assert.ok(text.includes('DTSTAMP:20261013T080000Z'));
  assert.ok(text.includes('URL:https://example.com/x'));
  for (const line of text.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `line too long: ${line}`);
  }
});

test('export then import round-trips UTC, all-day, floating and escaped values', () => {
  const events = [
    { id: 'rt-1', title: 'Review; Q4, final', start: '2026-10-14T09:00:00.000Z', end: '2026-10-14T10:30:00.000Z', allDay: false, floating: false, location: 'Room 4', description: 'a\\b\nc', url: null },
    { id: 'rt-2', title: 'Holiday', start: '2026-10-15', end: null, allDay: true, floating: false, location: '', description: '', url: 'http://example.org' },
    { id: 'rt-3', title: 'Lunch', start: '2026-10-16T12:00:00', end: null, allDay: false, floating: true, location: '', description: '', url: null },
  ];
  const r = cal.parseIcs(cal.toIcs(events, new Date('2026-10-13T00:00:00Z')));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.events.map((e) => ({ ...e, description: e.description })), events.map((e) => ({ ...e, description: e.description })));
});

test('export drops unsafe URLs and caps the number of events written', () => {
  const ev = { id: 'u', title: 't', start: '2026-10-14T09:00:00.000Z', end: null, allDay: false, floating: false, location: '', description: '', url: 'javascript:alert(1)' };
  assert.ok(!cal.toIcs([ev], new Date(0)).includes('URL:'));
  const many = Array.from({ length: cal.MAX_EVENTS + 5 }, (_, i) => ({ ...ev, id: `m${i}` }));
  assert.equal(cal.toIcs(many, new Date(0)).split('BEGIN:VEVENT').length - 1, cal.MAX_EVENTS);
});

test('startMs reads floating and date-only values as UTC', () => {
  assert.equal(cal.startMs({ start: '2026-10-14', floating: false }), Date.UTC(2026, 9, 14));
  assert.equal(cal.startMs({ start: '2026-10-14T09:00:00', floating: true }), Date.UTC(2026, 9, 14, 9));
});

test('eventsInRange returns overlapping events and excludes those that end exactly at the range start', () => {
  const ev = (id, start, end = null, allDay = false) => ({ id, title: id, start, end, allDay, floating: false, location: '', description: '', url: null });
  const events = [
    ev('before', '2026-10-13T23:00:00.000Z', '2026-10-14T00:00:00.000Z'),
    ev('inside', '2026-10-14T09:00:00.000Z', '2026-10-14T10:00:00.000Z'),
    ev('spans', '2026-10-13T12:00:00.000Z', '2026-10-15T12:00:00.000Z'),
    ev('allday', '2026-10-14', null, true),
    ev('after', '2026-10-15T00:00:00.000Z'),
    ev('point', '2026-10-14T00:00:00.000Z'),
  ];
  const from = Date.UTC(2026, 9, 14);
  const to = Date.UTC(2026, 9, 15);
  assert.deepEqual(cal.eventsInRange(events, from, to).map((e) => e.id).sort(), ['allday', 'inside', 'point', 'spans']);
});

test('mergeEvents adds new events, replaces matching keys, sorts by start and caps the store', () => {
  const a = { id: 'x', title: 'Old', start: '2026-10-14T09:00:00.000Z', end: null, allDay: false, floating: false, location: '', description: '', url: null };
  const b = { ...a, title: 'New' };
  const c = { ...a, id: 'y', start: '2026-10-13T09:00:00.000Z', title: 'Earlier' };
  const merged = cal.mergeEvents([a], [b, c]);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.events.map((e) => e.title), ['Earlier', 'New']);
  const many = Array.from({ length: cal.MAX_EVENTS }, (_, i) => ({ ...a, id: `e${i}`, start: `2026-10-14T09:00:00.000Z` }));
  const capped = cal.mergeEvents(many, [{ ...a, id: 'extra' }]);
  assert.equal(capped.events.length, cal.MAX_EVENTS);
  assert.equal(capped.dropped, 1);
});

test('malicious and malformed input never throws', () => {
  const inputs = [
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:\r\nEND:VEVENT',
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261014T090000Z\r\nSUMMARY:\\',
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART;;;:::20261014T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
    'BEGIN:VCALENDAR\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nBEGIN:VALARM\r\nBEGIN:VALARM',
    '\u0000\u0000BEGIN:VCALENDAR',
  ];
  for (const s of inputs) assert.doesNotThrow(() => cal.parseIcs(s));
});
