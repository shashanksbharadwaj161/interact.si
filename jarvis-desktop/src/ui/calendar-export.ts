// Calendar export: turns stored events into one RFC 5545 .ics text for a preview before anything is written.
// Pure and DOM-free: no clock, randomness, storage, file, network or Electron access. The caller passes `now`
// (used only for DTSTAMP), so the same input and `now` always give byte-identical output.
// Invalid or unbounded events are skipped with an exact reason; nothing here throws on bad input.
import type { CalendarEvent } from '../../electron/services/calendar';

/** Hard bounds for one export. */
export const EXPORT_LIMITS = Object.freeze({
  events: 5_000,
  summaryChars: 500,
  descriptionChars: 5_000,
  /** Location and UID share a smaller bound so one field cannot dominate a line. */
  locationChars: 1_000,
  uidChars: 255,
  /** Total UTF-8 size of the .ics text, CRLF line endings included. */
  bytes: 2 * 1024 * 1024,
});

export const EXPORT_MIN_YEAR = 1900;
export const EXPORT_MAX_YEAR = 2100;
export const DEFAULT_PRODID = '-//Desktop Companion//Calendar Export//EN';

export type ExportSkipReason =
  | 'not-an-event'
  | 'missing-id'
  | 'id-too-long'
  | 'invalid-start'
  | 'invalid-end'
  | 'date-out-of-range'
  | 'end-before-start'
  | 'mixed-all-day'
  | 'duplicate'
  | 'over-event-limit'
  | 'over-size-limit';

export const EXPORT_SKIP_LABELS: Readonly<Record<ExportSkipReason, string>> = Object.freeze({
  'not-an-event': 'Not a readable event',
  'missing-id': 'Event without an id',
  'id-too-long': `Event id longer than ${EXPORT_LIMITS.uidChars} characters`,
  'invalid-start': 'Missing or unreadable start',
  'invalid-end': 'Unreadable end',
  'date-out-of-range': `Date outside ${EXPORT_MIN_YEAR}–${EXPORT_MAX_YEAR}`,
  'end-before-start': 'Ends before it starts',
  'mixed-all-day': 'All-day start with a timed end (or the reverse)',
  duplicate: 'Repeated copy of the same event',
  'over-event-limit': `Over the ${EXPORT_LIMITS.events}-event export limit`,
  'over-size-limit': `Over the ${EXPORT_LIMITS.bytes / (1024 * 1024)} MB export size limit`,
});

export interface ExportSkip { id: string; index: number; reason: ExportSkipReason }

export interface IcsExport {
  /** The exact .ics text that would be written: CRLF line endings, folded at 75 octets. */
  text: string;
  /** Events written as VEVENTs. */
  count: number;
  skipped: readonly ExportSkip[];
  /** True when a limit cut something: a text field was shortened or events were dropped for count or size. */
  truncated: boolean;
  /** UTF-8 size of `text`. */
  bytes: number;
  /** Date span of the exported events ('YYYY-MM-DD'; UTC date for timed events), or null when nothing was exported. */
  firstDate: string | null;
  lastDate: string | null;
}

export interface ExportOptions {
  prodId?: string;
  /** DTSTAMP instant. Defaults to the Unix epoch so output stays deterministic when omitted. */
  now?: Date | number;
}

export interface ExportSummary {
  count: number;
  firstDate: string | null;
  lastDate: string | null;
  skipped: readonly { reason: ExportSkipReason; label: string; count: number }[];
  skippedTotal: number;
  truncated: boolean;
  bytes: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** UTF-8 octets of one code point. */
const octets = (cp: number) => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

export function utf8Bytes(s: string): number {
  let n = 0;
  for (const ch of s) n += octets(ch.codePointAt(0) ?? 0);
  return n;
}

/** Folds one content line so no physical line exceeds 75 octets. Continuation lines start with one space (counted). */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = octets(ch.codePointAt(0) ?? 0);
    const limit = out.length ? 74 : 75;
    if (bytes + n > limit) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** Removes control and bidi-override characters; newlines are kept as \n so they can be escaped. */
function clean(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newline. */
export function escapeIcsText(value: string): string {
  return clean(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/** Shortens to `max` code points without splitting a surrogate pair. */
function limitChars(value: string, max: number): { text: string; cut: boolean } {
  if (value.length <= max) return { text: value, cut: false };
  const chars = Array.from(value);
  return chars.length <= max ? { text: value, cut: false } : { text: chars.slice(0, max).join(''), cut: true };
}

const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

type Moment =
  | { kind: 'date'; y: number; mo: number; d: number; key: string; ms: number }
  | { kind: 'utc'; ms: number; key: string }
  | { kind: 'floating'; ms: number; key: string; basic: string };

type MomentError = 'bad' | 'range';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const FLOAT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?$/;

function validYmd(y: number, mo: number, d: number): MomentError | null {
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return 'bad';
  return y < EXPORT_MIN_YEAR || y > EXPORT_MAX_YEAR ? 'range' : null;
}

/** Reads a store date value. All-day values must be 'YYYY-MM-DD'; timed values need a zone unless floating. */
function readMoment(value: unknown, allDay: boolean, floating: boolean): Moment | MomentError {
  if (typeof value !== 'string' || value.length > 40) return 'bad';
  const v = value.trim();
  if (allDay) {
    const m = DATE_RE.exec(v);
    if (!m) return 'bad';
    const [y, mo, d] = m.slice(1).map(Number);
    const err = validYmd(y, mo, d);
    if (err) return err;
    return { kind: 'date', y, mo, d, key: `${m[1]}-${m[2]}-${m[3]}`, ms: Date.UTC(y, mo - 1, d) };
  }
  const m = (floating ? FLOAT_RE : UTC_RE).exec(v);
  if (!m) return 'bad';
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const err = validYmd(y, mo, d);
  if (err) return err;
  if (h > 23 || mi > 59 || s > 60) return 'bad';
  const wall = Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59));
  if (floating) {
    return { kind: 'floating', ms: wall, key: `${m[1]}-${m[2]}-${m[3]}`, basic: `${m[1]}${m[2]}${m[3]}T${pad(h)}${pad(mi)}${pad(Math.min(s, 59))}` };
  }
  const zone = m[7];
  const off = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 18 || Number(zone.slice(4, 6)) > 59)) return 'bad';
  const ms = wall - off;
  const t = new Date(ms);
  const uy = t.getUTCFullYear();
  if (uy < EXPORT_MIN_YEAR || uy > EXPORT_MAX_YEAR) return 'range';
  return { kind: 'utc', ms, key: `${uy}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` };
}

/** 'YYYYMMDDTHHMMSSZ' for a UTC instant. */
export function utcStamp(ms: number): string {
  const t = new Date(ms);
  return `${pad(t.getUTCFullYear(), 4)}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}

function timeLine(key: 'DTSTART' | 'DTEND', m: Moment): string {
  if (m.kind === 'date') return `${key};VALUE=DATE:${pad(m.y, 4)}${pad(m.mo)}${pad(m.d)}`;
  // Floating times have no zone; writing them with Z would shift them, so they stay floating (RFC 5545 form 1).
  if (m.kind === 'floating') return `${key}:${m.basic}`;
  return `${key}:${utcStamp(m.ms)}`;
}

function stampOf(now: ExportOptions['now']): string {
  const ms = typeof now === 'number' ? now : now instanceof Date ? now.getTime() : 0;
  return utcStamp(Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : 0);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * Serializes events as one VCALENDAR. Input order is kept. Never throws: unusable events land in `skipped`.
 * The result object and its skipped list are frozen.
 */
export function eventsToIcs(events: readonly CalendarEvent[] | readonly unknown[], options: ExportOptions = {}): IcsExport {
  const list: readonly unknown[] = Array.isArray(events) ? events : [];
  const prodId = escapeIcsText(limitChars(clean(str(options.prodId)).replace(/\n/g, ' ').trim(), 200).text) || DEFAULT_PRODID;
  const dtstamp = stampOf(options.now);
  const head = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodId}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'].map(foldLine);
  const tail = 'END:VCALENDAR';
  let bytes = utf8Bytes(head.join('\r\n')) + 2 + utf8Bytes(tail) + 2;
  const blocks: string[] = [];
  const skipped: ExportSkip[] = [];
  const seen = new Set<string>();
  let truncated = false;
  let sizeFull = false;
  let first: string | null = null;
  let last: string | null = null;

  list.forEach((raw, index) => {
    const skip = (reason: ExportSkipReason, id = '') => { skipped.push(Object.freeze({ id: id.slice(0, EXPORT_LIMITS.uidChars), index, reason })); };
    if (!isObj(raw)) return skip('not-an-event');
    const id = str(raw.id).trim();
    if (!id) return skip('missing-id');
    if (id.length > EXPORT_LIMITS.uidChars) return skip('id-too-long', id);
    if (blocks.length >= EXPORT_LIMITS.events) { truncated = true; return skip('over-event-limit', id); }
    if (sizeFull) return skip('over-size-limit', id);
    const allDay = raw.allDay === true;
    const floating = !allDay && raw.floating === true;
    const start = readMoment(raw.start, allDay, floating);
    if (start === 'bad') return skip('invalid-start', id);
    if (start === 'range') return skip('date-out-of-range', id);
    let end: Moment | null = null;
    if (raw.end !== null && raw.end !== undefined && raw.end !== '') {
      if (typeof raw.end === 'string' && allDay !== DATE_RE.test(raw.end.trim())) return skip('mixed-all-day', id);
      const e = readMoment(raw.end, allDay, floating);
      if (e === 'bad') return skip('invalid-end', id);
      if (e === 'range') return skip('date-out-of-range', id);
      if (e.ms < start.ms) return skip('end-before-start', id);
      // DTEND must be after DTSTART; a zero-length event is written without one.
      end = e.ms > start.ms ? e : null;
    }
    const dupKey = `${id}\u0000${start.kind}\u0000${start.ms}`;
    if (seen.has(dupKey)) return skip('duplicate', id);

    const summary = limitChars(str(raw.title), EXPORT_LIMITS.summaryChars);
    const description = limitChars(str(raw.description), EXPORT_LIMITS.descriptionChars);
    const location = limitChars(str(raw.location), EXPORT_LIMITS.locationChars);
    const lines = ['BEGIN:VEVENT', `UID:${escapeIcsText(id)}`, `DTSTAMP:${dtstamp}`, timeLine('DTSTART', start)];
    if (end) lines.push(timeLine('DTEND', end));
    lines.push(`SUMMARY:${escapeIcsText(summary.text)}`);
    if (description.text) lines.push(`DESCRIPTION:${escapeIcsText(description.text)}`);
    if (location.text) lines.push(`LOCATION:${escapeIcsText(location.text)}`);
    lines.push('END:VEVENT');
    const block = lines.map(foldLine).join('\r\n');
    const size = utf8Bytes(block) + 2;
    if (bytes + size > EXPORT_LIMITS.bytes) { sizeFull = true; truncated = true; return skip('over-size-limit', id); }
    if (summary.cut || description.cut || location.cut) truncated = true;
    seen.add(dupKey);
    bytes += size;
    blocks.push(block);
    if (first === null || start.key < first) first = start.key;
    if (last === null || start.key > last) last = start.key;
  });

  const text = [...head, ...blocks, tail].join('\r\n') + '\r\n';
  return Object.freeze({ text, count: blocks.length, skipped: Object.freeze(skipped), truncated, bytes: utf8Bytes(text), firstDate: first, lastDate: last });
}

/** Preview summary: exported count, date span and skipped reasons with counts (in first-seen order). */
export function summarizeExport(events: readonly CalendarEvent[] | readonly unknown[], prepared?: IcsExport): ExportSummary {
  const r = prepared ?? eventsToIcs(events);
  const counts = new Map<ExportSkipReason, number>();
  for (const s of r.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const skipped = Object.freeze([...counts].map(([reason, count]) => Object.freeze({ reason, label: EXPORT_SKIP_LABELS[reason], count })));
  return Object.freeze({ count: r.count, firstDate: r.firstDate, lastDate: r.lastDate, skipped, skippedTotal: r.skipped.length, truncated: r.truncated, bytes: r.bytes });
}

/** Human size for the preview, e.g. "812 B", "14.2 KB", "1.9 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

/** Download name for the export, from a 'YYYY-MM-DD' day key supplied by the caller. */
export function exportFileName(dayKey: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? `calendar-${dayKey}.ics` : 'calendar.ics';
}
