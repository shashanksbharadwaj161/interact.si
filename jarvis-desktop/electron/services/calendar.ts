// Local .ics import/export and event-store helpers. Pure functions: no filesystem, network, or Electron import.
// Nothing here fetches URLs. Event URLs are kept as text, and only http(s) links are retained.
// Unsupported features (non-UTC TZID, recurrence, floating times in exports) are skipped and counted, never guessed.

/** Largest accepted .ics payload in UTF-8 bytes. */
export const MAX_ICS_BYTES = 1_000_000;
/** Unfolded lines longer than this are dropped and counted. */
export const MAX_LINE_CHARS = 4_096;
/** Events kept per import or store. Extra VEVENT blocks are counted, not parsed. */
export const MAX_EVENTS = 2_000;
/** Maximum length of any text field after unescaping. */
export const MAX_TEXT_CHARS = 1_000;
/** DTSTART/DTEND years outside this range are skipped. */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;
const MAX_URL_CHARS = 2_048;
const DAY_MS = 86_400_000;
const UTC_TZIDS = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']);

export type SkipCode =
  | 'missing-start'
  | 'bad-date'
  | 'date-out-of-range'
  | 'unsupported-timezone'
  | 'unsupported-recurrence'
  | 'line-too-long'
  | 'too-many-events';

export interface CalendarEvent {
  /** UID from the file, or a synthetic id built from start and title when UID is missing. */
  id: string;
  title: string;
  /** 'YYYY-MM-DD' for all-day, 'YYYY-MM-DDTHH:mm:ss.sssZ' for UTC, 'YYYY-MM-DDTHH:mm:ss' for floating. */
  start: string;
  end: string | null;
  allDay: boolean;
  /** True when the file gave a local time with no zone. Such times are interpreted as UTC for range checks. */
  floating: boolean;
  location: string;
  description: string;
  url: string | null;
}

export interface IcsParseResult {
  events: CalendarEvent[];
  /** Skipped items grouped by reason. Counts only, so the result stays bounded. */
  skipped: {code: SkipCode; count: number}[];
  /** Set when the whole file is rejected before parsing. */
  error?: 'too-large' | 'not-calendar';
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Joins RFC 5545 folded lines (CRLF/LF followed by a space or tab). */
export function unfoldLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  return lines;
}

/** Splits one content line into name, parameters and value. The first colon outside quotes ends the name and parameters. */
export function parseProperty(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) { colon = i; break; }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return {name: name.toUpperCase(), params, value: line.slice(colon + 1)};
}

/** Reverses RFC 5545 text escaping and strips control characters. Newlines are kept. */
export function unescapeText(value: string): string {
  return value
    .replace(/\\(.)/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .slice(0, MAX_TEXT_CHARS);
}

/** Escapes text for export: backslash, semicolon, comma and newline. */
export function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function validDate(y: number, mo: number, d: number): boolean {
  if (y < MIN_YEAR || y > MAX_YEAR || mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

export type ParsedTime =
  | {ok: true; start: string; allDay: boolean; floating: boolean}
  | {ok: false; code: SkipCode};

/** Parses a DATE or DATE-TIME value using its parameters. Only UTC (Z or a UTC TZID) and floating times are accepted. */
export function parseIcsTime(value: string, params: Record<string, string>): ParsedTime {
  const v = value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d && (params.VALUE === 'DATE' || !v.includes('T'))) {
    const [y, mo, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (y < MIN_YEAR || y > MAX_YEAR) return {ok: false, code: 'date-out-of-range'};
    if (!validDate(y, mo, day)) return {ok: false, code: 'bad-date'};
    return {ok: true, start: `${y}-${pad(mo)}-${pad(day)}`, allDay: true, floating: false};
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!t) return {ok: false, code: 'bad-date'};
  const [y, mo, day, h, mi, s] = t.slice(1, 7).map(Number);
  if (!validDate(y, mo, day)) return {ok: false, code: y < MIN_YEAR || y > MAX_YEAR ? 'date-out-of-range' : 'bad-date'};
  if (h > 23 || mi > 59 || s > 60) return {ok: false, code: 'bad-date'};
  const base = `${y}-${pad(mo)}-${pad(day)}T${pad(h)}:${pad(mi)}:${pad(Math.min(s, 59))}`;
  if (t[7] === 'Z' || UTC_TZIDS.has(params.TZID ?? '')) {
    return {ok: true, start: new Date(`${base}Z`).toISOString(), allDay: false, floating: false};
  }
  if (params.TZID) return {ok: false, code: 'unsupported-timezone'};
  return {ok: true, start: base, allDay: false, floating: true};
}

function safeUrl(value: string): string | null {
  const u = value.trim();
  return u.length <= MAX_URL_CHARS && /^https?:\/\/\S+$/i.test(u) ? u : null;
}

const RECURRENCE_PROPS = ['RRULE', 'RDATE', 'EXDATE', 'RECURRENCE-ID'];

/** Builds an event from one VEVENT's properties. Returns the skip code instead of an event when unsupported. */
function buildEvent(props: Prop[]): CalendarEvent | SkipCode {
  const get = (n: string) => props.find((p) => p.name === n);
  if (props.some((p) => RECURRENCE_PROPS.includes(p.name))) return 'unsupported-recurrence';
  const dtStart = get('DTSTART');
  if (!dtStart) return 'missing-start';
  const start = parseIcsTime(dtStart.value, dtStart.params);
  if (!start.ok) return start.code;
  const dtEnd = get('DTEND');
  let end: string | null = null;
  if (dtEnd) {
    const e = parseIcsTime(dtEnd.value, dtEnd.params);
    if (!e.ok) return e.code;
    end = e.start;
  }
  const title = unescapeText(get('SUMMARY')?.value ?? '') || '(untitled)';
  const uid = unescapeText(get('UID')?.value ?? '');
  return {
    id: uid || `local:${start.start}:${title}`,
    title,
    start: start.start,
    end,
    allDay: start.allDay,
    floating: start.floating,
    location: unescapeText(get('LOCATION')?.value ?? ''),
    description: unescapeText(get('DESCRIPTION')?.value ?? ''),
    url: safeUrl(get('URL')?.value ?? ''),
  };
}

/** Parses an .ics document. Bounded in size, event count and line length; never throws on malformed input. */
export function parseIcs(text: string): IcsParseResult {
  if (new TextEncoder().encode(text).length > MAX_ICS_BYTES) return {events: [], skipped: [], error: 'too-large'};
  const skipped = new Map<SkipCode, number>();
  const skip = (code: SkipCode) => skipped.set(code, (skipped.get(code) ?? 0) + 1);
  const events: CalendarEvent[] = [];

  let inEvent = false;
  let alarmDepth = 0;
  let calendarSeen = false;
  let props: Prop[] = [];
  for (const line of unfoldLines(text)) {
    if (line.length > MAX_LINE_CHARS) { skip('line-too-long'); continue; }
    const p = parseProperty(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VCALENDAR') calendarSeen = true;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') { inEvent = true; props = []; continue; }
    if (p.name === 'BEGIN' && inEvent) { alarmDepth++; continue; }
    if (p.name === 'END' && p.value.toUpperCase() === 'VEVENT' && inEvent) {
      inEvent = false;
      if (events.length >= MAX_EVENTS) skip('too-many-events');
      else {
        const built = buildEvent(props);
        if (typeof built === 'string') skip(built);
        else events.push(built);
      }
      continue;
    }
    if (p.name === 'END' && alarmDepth > 0) { alarmDepth--; continue; }
    // Lines inside VALARM must not overwrite event fields.
    if (inEvent && alarmDepth === 0) props.push(p);
  }
  if (!calendarSeen) return {events: [], skipped: [], error: 'not-calendar'};
  return {events, skipped: [...skipped].map(([code, count]) => ({code, count}))};
}

/** Adds a 75-octet fold to one content line (continuation lines start with a space). */
function fold(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0;
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    const limit = out.length ? 74 : 75;
    if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Formats an event's start or end for export. Floating times stay floating so they are not shifted. */
function icsTime(iso: string, allDay: boolean, floating: boolean, key: 'DTSTART' | 'DTEND'): string {
  if (allDay) return `${key};VALUE=DATE:${iso.slice(0, 10).replace(/-/g, '')}`;
  const basic = iso.slice(0, 19).replace(/[-:]/g, '');
  return floating ? `${key}:${basic}` : `${key}:${basic}Z`;
}

/** Serializes events as a VCALENDAR with CRLF line endings. `stamp` is DTSTAMP, which keeps output deterministic in tests. */
export function toIcs(events: readonly CalendarEvent[], stamp: Date): string {
  const dt = stamp.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Desktop Companion//Local//EN', 'CALSCALE:GREGORIAN'];
  for (const e of events.slice(0, MAX_EVENTS)) {
    lines.push('BEGIN:VEVENT', `UID:${escapeText(e.id)}`, `DTSTAMP:${dt}`, icsTime(e.start, e.allDay, e.floating, 'DTSTART'));
    if (e.end) lines.push(icsTime(e.end, e.allDay, e.floating, 'DTEND'));
    lines.push(`SUMMARY:${escapeText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
    if (e.url && safeUrl(e.url)) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Start instant in ms. Floating and date-only values are read as UTC, so range checks are consistent. */
export function startMs(e: Pick<CalendarEvent, 'start' | 'floating'>): number {
  return Date.parse(e.floating ? `${e.start}Z` : e.start);
}

/**
 * Events overlapping the half-open range [fromMs, toMs). An event ending exactly at fromMs is excluded.
 * An event without an end is a point at its start, or lasts one day when all-day.
 */
export function eventsInRange(events: readonly CalendarEvent[], fromMs: number, toMs: number): CalendarEvent[] {
  return events.filter((e) => {
    const s = startMs(e);
    const last = e.end ? startMs({start: e.end, floating: e.floating}) : s + (e.allDay ? DAY_MS : 0);
    return s < toMs && (last > fromMs || s >= fromMs);
  });
}

/** Store key: an event is identified by UID plus start, so a recurring-looking reimport of one UID at a new time is kept. */
export const eventKey = (e: Pick<CalendarEvent, 'id' | 'start'>) => `${e.id}\u0000${e.start}`;

/** Merges incoming events into the store. Incoming wins on key match. Output is sorted by start and capped at MAX_EVENTS. */
export function mergeEvents(
  existing: readonly CalendarEvent[],
  incoming: readonly CalendarEvent[],
): {events: CalendarEvent[]; added: number; dropped: number} {
  const byKey = new Map<string, CalendarEvent>();
  for (const e of existing) byKey.set(eventKey(e), e);
  let added = 0;
  for (const e of incoming) {
    const k = eventKey(e);
    if (!byKey.has(k)) added++;
    byKey.set(k, e);
  }
  const sorted = [...byKey.values()].sort((a, b) => startMs(a) - startMs(b) || a.title.localeCompare(b.title));
  return {events: sorted.slice(0, MAX_EVENTS), added, dropped: Math.max(0, sorted.length - MAX_EVENTS)};
}
