// Calendar import review: a bounded, pure .ics parser that builds a preview before anything is stored.
// Adds what the store parser (electron/services/calendar.ts) refuses: IANA/Windows/VTIMEZONE zones with DST rules,
// DURATION, and recurrence expanded inside an explicit window with hard caps. Unsupported rules are skipped and
// counted, never guessed. No network, file, storage or Electron access: the host supplies text and receives a request.
// Selected events are re-serialized with UTC times so the main process can parse and store them again itself.
import { MAX_ICS_BYTES, eventKey, toIcs, type CalendarEvent } from '../../electron/services/calendar';

/** Hard bounds. Every loop in this module is limited by one of these. */
export const IMPORT_LIMITS = Object.freeze({
  bytes: MAX_ICS_BYTES,
  lines: 50_000,
  lineChars: 4_096,
  propsPerComponent: 256,
  paramsPerProperty: 16,
  depth: 6,
  events: 2_000,
  timezones: 64,
  observances: 32,
  listValues: 200,
  instancesPerSeries: 400,
  recurrenceSteps: 5_000,
  maxEventDays: 366,
  textChars: 1_000,
  uidChars: 255,
  urlChars: 2_048,
});

export const MIN_IMPORT_YEAR = 1900;
export const MAX_IMPORT_YEAR = 2100;
const DAY = 86_400_000;
const HOUR = 3_600_000;

export type ImportSkipCode =
  | 'missing-start' | 'bad-date' | 'date-out-of-range' | 'bad-range' | 'cancelled'
  | 'unsupported-timezone' | 'unsupported-recurrence' | 'recurrence-outside-window' | 'unsupported-component'
  | 'line-too-long' | 'too-many-lines' | 'malformed-line' | 'too-many-properties' | 'unsafe-name'
  | 'nesting-too-deep' | 'unbalanced-component' | 'too-many-events' | 'too-many-timezones' | 'duplicate-in-file';

export const IMPORT_SKIP_LABELS: Record<ImportSkipCode, string> = {
  'missing-start': 'Events without a start time',
  'bad-date': 'Events with an unreadable date',
  'date-out-of-range': `Events outside ${MIN_IMPORT_YEAR}–${MAX_IMPORT_YEAR}`,
  'bad-range': 'Events that end before they start or last over a year',
  cancelled: 'Cancelled events',
  'unsupported-timezone': 'Events in a time zone this app cannot resolve',
  'unsupported-recurrence': 'Recurring events with rules this app does not expand',
  'recurrence-outside-window': 'Recurring events with no occurrence in the preview window',
  'unsupported-component': 'Tasks, journals and other non-event items',
  'line-too-long': 'Lines over the length limit',
  'too-many-lines': 'Lines beyond the line limit (not read)',
  'malformed-line': 'Unreadable lines',
  'too-many-properties': 'Items with too many fields',
  'unsafe-name': 'Items with reserved or unsafe field names',
  'nesting-too-deep': 'Items nested too deeply',
  'unbalanced-component': 'Items with mismatched BEGIN/END lines',
  'too-many-events': 'Events beyond the import limit',
  'too-many-timezones': 'Time zone definitions beyond the limit',
  'duplicate-in-file': 'Repeated copies of the same event in the file',
};

export type CandidateNote =
  | 'dst-gap-shifted' | 'dst-ambiguous-earlier' | 'end-from-duration' | 'end-defaulted' | 'floating-time'
  | 'windows-zone' | 'vtimezone-rules' | 'recurring-instance' | 'recurrence-truncated' | 'override' | 'free-time';

export const CANDIDATE_NOTE_LABELS: Record<CandidateNote, string> = {
  'dst-gap-shifted': 'Start fell in a daylight-saving gap and was moved forward',
  'dst-ambiguous-earlier': 'Start was in a repeated daylight-saving hour; the first one was used',
  'end-from-duration': 'End calculated from the event duration',
  'end-defaulted': 'No end given; all-day event lasts one day',
  'floating-time': 'No time zone given; shown in local time',
  'windows-zone': 'Windows time zone name mapped to its region',
  'vtimezone-rules': 'Time zone rules taken from the file',
  'recurring-instance': 'One occurrence of a repeating event',
  'recurrence-truncated': 'Repeating event cut off at the occurrence limit',
  override: 'Changed occurrence of a repeating event',
  'free-time': 'Marked as free time; not checked for conflicts',
};

export interface ImportCandidate {
  /** Unique within a preview and equal to the store key, so duplicates of stored events are detectable. */
  key: string;
  event: CalendarEvent;
  /** TZID as written in the file, or 'UTC' / null (floating or all-day). */
  sourceZone: string | null;
  /** Transparent (free) events are kept but excluded from conflict checks. */
  busy: boolean;
  series: { uid: string; index: number; rule: string } | null;
  notes: CandidateNote[];
  /** Start for sorting: the UTC instant, or the wall time read as UTC for all-day and floating events. */
  sortMs: number;
}

export interface ImportPreview {
  candidates: ImportCandidate[];
  skipped: { code: ImportSkipCode; count: number }[];
  error?: 'too-large' | 'not-calendar';
  window: { fromMs: number; toMs: number };
}

export interface ImportOptions {
  /** Reference instant for the recurrence window. Required so previews are reproducible. */
  now: Date | number;
  /** Days before `now` whose occurrences are still listed. Default 31, max 366. */
  lookbackDays?: number;
  /** Days after `now` to expand recurrences into. Default 365, max 1098. */
  horizonDays?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Content lines

interface Prop { name: string; params: Map<string, string>; value: string }
interface Comp { name: string; props: Prop[]; children: Comp[]; bad: ImportSkipCode | null }

const NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const RESERVED = new Set(['__PROTO__', 'CONSTRUCTOR', 'PROTOTYPE', '__DEFINEGETTER__', '__DEFINESETTER__', '__LOOKUPGETTER__', '__LOOKUPSETTER__']);

/** Parses one unfolded content line. Parameters go into a Map, so no name can reach an object prototype. */
export function parseContentLine(line: string): Prop | 'malformed' | 'unsafe' {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) { colon = i; break; }
  }
  if (colon <= 0) return 'malformed';
  const head: string[] = [];
  let cur = '';
  quoted = false;
  for (const c of line.slice(0, colon)) {
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) { head.push(cur); cur = ''; } else cur += c;
  }
  head.push(cur);
  const name = head[0].toUpperCase();
  if (RESERVED.has(name)) return 'unsafe';
  if (!NAME_RE.test(name) || head.length - 1 > IMPORT_LIMITS.paramsPerProperty) return 'malformed';
  const params = new Map<string, string>();
  for (const raw of head.slice(1)) {
    const eq = raw.indexOf('=');
    if (eq <= 0) return 'malformed';
    const key = raw.slice(0, eq).toUpperCase();
    if (RESERVED.has(key)) return 'unsafe';
    if (!NAME_RE.test(key)) return 'malformed';
    params.set(key, raw.slice(eq + 1).replace(/^"|"$/g, ''));
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** Reverses text escaping; strips control and bidirectional-override characters so previews cannot be spoofed. */
export function cleanText(value: string, max: number = IMPORT_LIMITS.textChars): string {
  return value
    .replace(/\\(.)/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max);
}

/** Builds the component tree. Bounded by line count, depth and properties per component; never throws. */
function readComponents(text: string, skip: (c: ImportSkipCode, n?: number) => void): { roots: Comp[]; sawCalendar: boolean } {
  const roots: Comp[] = [];
  const stack: Comp[] = [];
  let sawCalendar = false;
  let lineCount = 0;
  let pending: string | null = null;
  const handle = (line: string) => {
    if (line.length === 0) return;
    const top = stack[stack.length - 1];
    // A bad line inside an item rejects that item, so no event is imported with a field silently missing.
    // At calendar level only the line is dropped.
    const item = stack[0]?.name === 'VCALENDAR' ? stack[1] : top;
    const reject = (code: ImportSkipCode) => { if (item) item.bad ??= code; else skip(code); };
    if (line.length > IMPORT_LIMITS.lineChars) { reject('line-too-long'); return; }
    const p = parseContentLine(line);
    if (p === 'unsafe') { reject('unsafe-name'); return; }
    if (p === 'malformed') { skip('malformed-line'); return; }
    if (p.name === 'BEGIN') {
      const raw = p.value.trim().toUpperCase();
      if (stack.length >= IMPORT_LIMITS.depth * 4) { reject('nesting-too-deep'); return; }
      // Unsafe or over-limit components are still tracked on the stack so their END line matches, but never kept.
      const comp: Comp = { name: raw.slice(0, 64), props: [], children: [], bad: null };
      if (!NAME_RE.test(raw) || RESERVED.has(raw)) { reject('unsafe-name'); comp.bad = 'unsafe-name'; stack.push(comp); return; }
      if (raw === 'VCALENDAR') sawCalendar = true;
      if (stack.length >= IMPORT_LIMITS.depth) { comp.bad = 'nesting-too-deep'; reject('nesting-too-deep'); }
      const cap = top?.name === 'VCALENDAR' ? IMPORT_LIMITS.events + IMPORT_LIMITS.timezones : IMPORT_LIMITS.propsPerComponent;
      if (!top) roots.push(comp);
      else if (top.children.length < cap) top.children.push(comp);
      else reject(top.name === 'VCALENDAR' ? (raw === 'VTIMEZONE' ? 'too-many-timezones' : 'too-many-events') : 'too-many-properties');
      stack.push(comp);
      return;
    }
    if (p.name === 'END') {
      const name = p.value.trim().toUpperCase();
      const at = stack.map((c) => c.name).lastIndexOf(name);
      if (at < 0) { skip('unbalanced-component'); return; }
      if (at < stack.length - 1) { for (let i = stack.length - 1; i > at; i--) stack[i].bad ??= 'unbalanced-component'; if (at === 0 && stack[0].name === 'VCALENDAR') stack[1].bad ??= 'unbalanced-component'; }
      stack.length = at;
      return;
    }
    if (!top) return;
    if (top.props.length >= IMPORT_LIMITS.propsPerComponent) { reject('too-many-properties'); return; }
    top.props.push(p);
  };
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && pending !== null) {
      // Stop growing a folded line once it is already over the limit, so one huge line cannot use unbounded memory.
      if (pending.length <= IMPORT_LIMITS.lineChars) pending += raw.slice(1);
      continue;
    }
    if (pending !== null) handle(pending);
    if (++lineCount > IMPORT_LIMITS.lines) { skip('too-many-lines'); pending = null; break; }
    pending = raw;
  }
  if (pending !== null) handle(pending);
  for (const c of stack) c.bad ??= 'unbalanced-component';
  return { roots, sawCalendar };
}

// ---------------------------------------------------------------------------------------------------------------
// Time zones

/** A resolved zone. `offsetAt` returns the UTC offset in ms at a UTC instant. */
export interface Zone { id: string; kind: 'utc' | 'iana' | 'windows' | 'vtimezone'; offsetAt(utcMs: number): number }

export const UTC_ZONE: Zone = Object.freeze({ id: 'UTC', kind: 'utc' as const, offsetAt: () => 0 });

/** Common Windows zone names (as exported by Outlook) mapped to their CLDR region zone. */
const WINDOWS_ZONES: ReadonlyMap<string, string> = new Map([
  ['Pacific Standard Time', 'America/Los_Angeles'], ['Mountain Standard Time', 'America/Denver'],
  ['Central Standard Time', 'America/Chicago'], ['Eastern Standard Time', 'America/New_York'],
  ['Alaskan Standard Time', 'America/Anchorage'], ['Hawaiian Standard Time', 'Pacific/Honolulu'],
  ['Atlantic Standard Time', 'America/Halifax'], ['E. South America Standard Time', 'America/Sao_Paulo'],
  ['GMT Standard Time', 'Europe/London'], ['W. Europe Standard Time', 'Europe/Berlin'],
  ['Romance Standard Time', 'Europe/Paris'], ['Central Europe Standard Time', 'Europe/Budapest'],
  ['Russian Standard Time', 'Europe/Moscow'], ['Arabian Standard Time', 'Asia/Dubai'],
  ['India Standard Time', 'Asia/Kolkata'], ['China Standard Time', 'Asia/Shanghai'],
  ['Singapore Standard Time', 'Asia/Singapore'], ['Tokyo Standard Time', 'Asia/Tokyo'],
  ['Korea Standard Time', 'Asia/Seoul'], ['AUS Eastern Standard Time', 'Australia/Sydney'],
  ['New Zealand Standard Time', 'Pacific/Auckland'], ['UTC', 'UTC'],
]);

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (formatters.has(tz)) return formatters.get(tz) ?? null;
  let f: Intl.DateTimeFormat | null = null;
  try {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  } catch { f = null; }
  if (formatters.size >= 128) formatters.clear();
  formatters.set(tz, f);
  return f;
}

/** Zone backed by the runtime's IANA database, or null when the runtime does not know the name. */
export function ianaZone(tz: string, kind: 'iana' | 'windows' = 'iana'): Zone | null {
  if (!tz || tz.length > 128 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  const f = formatterFor(tz);
  if (!f) return null;
  return {
    id: tz,
    kind,
    offsetAt(utcMs) {
      const t = Math.floor(utcMs / 1000) * 1000;
      const n = new Map<string, number>();
      for (const part of f.formatToParts(new Date(t))) if (part.type !== 'literal') n.set(part.type, Number(part.value));
      const h = n.get('hour') ?? 0;
      return Date.UTC(n.get('year') ?? 1970, (n.get('month') ?? 1) - 1, n.get('day') ?? 1, h === 24 ? 0 : h, n.get('minute') ?? 0, n.get('second') ?? 0) - t;
    },
  };
}

export type WallResolution = { utc: number; note: 'dst-gap-shifted' | 'dst-ambiguous-earlier' | null };

/**
 * Converts a wall-clock time (encoded as if it were UTC) to an instant, following RFC 5545: a time inside a
 * spring-forward gap uses the offset from before the gap (so it moves forward), and a repeated time uses its first occurrence.
 */
export function wallToUtc(wall: number, zone: Zone): WallResolution {
  const before = zone.offsetAt(wall - DAY);
  const after = zone.offsetAt(wall + DAY);
  const valid = [...new Set([before, after])].map((o) => wall - o).filter((c) => zone.offsetAt(c) === wall - c).sort((a, b) => a - b);
  if (valid.length === 0) return { utc: wall - before, note: 'dst-gap-shifted' };
  return { utc: valid[0], note: valid.length > 1 ? 'dst-ambiguous-earlier' : null };
}

const dayNum = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / DAY;
const ymd = (day: number) => { const t = new Date(day * DAY); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), wd: t.getUTCDay() }; };
const daysInMonth = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Day number of the nth (1..5 or -1..-5) weekday in a month, or null when that month has no such day. */
function nthWeekday(y: number, mo: number, nth: number, wd: number): number | null {
  const len = daysInMonth(y, mo);
  const first = dayNum(y, mo, 1);
  const last = first + len - 1;
  const d = nth > 0 ? first + ((wd - ymd(first).wd + 7) % 7) + (nth - 1) * 7 : last - ((ymd(last).wd - wd + 7) % 7) + (nth + 1) * 7;
  return d >= first && d <= last ? d : null;
}

function parseOffset(v: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(v.trim());
  if (!m || Number(m[2]) > 18 || Number(m[3]) > 59) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * HOUR + Number(m[3]) * 60_000 + Number(m[4] ?? 0) * 1000);
}

function parseWallBasic(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 60) return null;
  return Date.UTC(y, mo - 1, d, h, mi, Math.min(s, 59));
}

interface Observance { startWall: number; from: number; to: number; rule: { month: number; nth: number; wd: number; until: number | null } | null }

/** Zone from a VTIMEZONE. Supports fixed observances and yearly "nth weekday of month" rules; anything else is null. */
function vtimezoneZone(comp: Comp): Zone | null {
  const id = cleanText(comp.props.find((p) => p.name === 'TZID')?.value ?? '', 128);
  if (comp.bad || comp.children.length > IMPORT_LIMITS.observances) return null;
  const obs: Observance[] = [];
  for (const child of comp.children) {
    if (child.bad || (child.name !== 'STANDARD' && child.name !== 'DAYLIGHT')) return null;
    const get = (n: string) => child.props.find((p) => p.name === n)?.value ?? '';
    const startWall = parseWallBasic(get('DTSTART'));
    const from = parseOffset(get('TZOFFSETFROM'));
    const to = parseOffset(get('TZOFFSETTO'));
    if (startWall === null || from === null || to === null || child.props.some((p) => p.name === 'RDATE')) return null;
    const rrules = child.props.filter((p) => p.name === 'RRULE');
    if (rrules.length > 1) return null;
    let rule: Observance['rule'] = null;
    if (rrules.length === 1) {
      const parts = ruleParts(rrules[0].value);
      if (!parts || parts.get('FREQ') !== 'YEARLY' || [...parts.keys()].some((k) => !['FREQ', 'BYMONTH', 'BYDAY', 'UNTIL'].includes(k))) return null;
      const month = Number(parts.get('BYMONTH'));
      const day = /^([+-]?[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.exec(parts.get('BYDAY') ?? '');
      if (!Number.isInteger(month) || month < 1 || month > 12 || !day) return null;
      const untilRaw = parts.get('UNTIL');
      const until = untilRaw ? (untilRaw.endsWith('Z') ? parseWallBasic(untilRaw.slice(0, -1)) : null) : null;
      if (untilRaw && until === null) return null;
      rule = { month, nth: Number(day[1]), wd: WEEKDAYS.indexOf(day[2]), until };
    }
    obs.push({ startWall, from, to, rule });
  }
  if (!id || obs.length === 0) return null;
  const earliest = obs.reduce((a, b) => (b.startWall < a.startWall ? b : a));
  return {
    id,
    kind: 'vtimezone',
    offsetAt(utcMs) {
      const year = new Date(utcMs).getUTCFullYear();
      let best = -Infinity;
      let offset = earliest.from;
      for (const o of obs) {
        const onsets: number[] = [];
        if (!o.rule) onsets.push(o.startWall - o.from);
        else {
          const tod = ((o.startWall % DAY) + DAY) % DAY;
          for (const y of [year - 1, year, year + 1]) {
            const d = nthWeekday(y, o.rule.month, o.rule.nth, o.rule.wd);
            if (d === null) continue;
            const wall = d * DAY + tod;
            const utc = wall - o.from;
            if (wall >= o.startWall && (o.rule.until === null || utc <= o.rule.until)) onsets.push(utc);
          }
        }
        for (const t of onsets) if (t <= utcMs && t > best) { best = t; offset = o.to; }
      }
      return offset;
    },
  };
}

/** Splits an RRULE value into a Map. Null when a part is malformed, repeated or reserved. */
function ruleParts(value: string): Map<string, string> | null {
  const parts = new Map<string, string>();
  for (const seg of value.trim().split(';')) {
    const eq = seg.indexOf('=');
    if (eq <= 0) return null;
    const k = seg.slice(0, eq).toUpperCase();
    if (!NAME_RE.test(k) || RESERVED.has(k) || parts.has(k) || parts.size >= 16) return null;
    parts.set(k, seg.slice(eq + 1).toUpperCase());
  }
  return parts;
}

/**
 * Resolves a TZID. Order: the runtime IANA database (most complete history), then the file's VTIMEZONE rules, then
 * the Windows name table. Vendor prefixes such as "/mozilla.org/20050126_1/Europe/Paris" are reduced to the region name.
 */
export function resolveZone(tzid: string, defined: ReadonlyMap<string, Comp> = new Map()): Zone | null {
  const id = tzid.trim();
  if (!id || id.length > 128) return null;
  if (/^(UTC|GMT|Etc\/UTC|Etc\/GMT|Z)$/i.test(id)) return UTC_ZONE;
  const tries = [id];
  if (id.startsWith('/')) { const segs = id.split('/').filter(Boolean).slice(-4); for (let i = 1; i < segs.length; i++) tries.push(segs.slice(i).join('/')); }
  for (const t of tries) { const z = ianaZone(t); if (z) return z; }
  const vt = defined.get(id);
  if (vt) { const z = vtimezoneZone(vt); if (z) return z; }
  const win = WINDOWS_ZONES.get(id);
  return win ? (win === 'UTC' ? UTC_ZONE : ianaZone(win, 'windows')) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Date and time values

/** A DTSTART-like value before resolution. Wall times are encoded as if they were UTC. */
export type TimeValue =
  | { kind: 'date'; day: number }
  | { kind: 'zoned'; wall: number; zone: Zone; tzid: string }
  | { kind: 'floating'; wall: number };

type TimeError = 'bad-date' | 'date-out-of-range' | 'unsupported-timezone';
type ZoneLookup = (tzid: string) => Zone | null;

const inYears = (y: number) => y >= MIN_IMPORT_YEAR && y <= MAX_IMPORT_YEAR;
const pad = (n: number) => String(n).padStart(2, '0');
export const dateKeyOf = (day: number) => { const t = ymd(day); return `${t.y}-${pad(t.mo)}-${pad(t.d)}`; };

/** Parses one DATE or DATE-TIME value with its parameters. */
export function parseTimeValue(value: string, params: ReadonlyMap<string, string>, zones: ZoneLookup): TimeValue | TimeError {
  const v = value.trim();
  const type = (params.get('VALUE') ?? '').toUpperCase();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d) {
    if (type && type !== 'DATE') return 'bad-date';
    const [y, mo, day] = d.slice(1).map(Number);
    if (!inYears(y)) return 'date-out-of-range';
    if (mo < 1 || mo > 12 || day < 1 || day > daysInMonth(y, mo)) return 'bad-date';
    return { kind: 'date', day: dayNum(y, mo, day) };
  }
  if (type && type !== 'DATE-TIME') return 'bad-date';
  const m = /^(\d{8}T\d{6})(Z?)$/.exec(v);
  if (!m) return 'bad-date';
  if (!inYears(Number(v.slice(0, 4)))) return 'date-out-of-range';
  const wall = parseWallBasic(m[1]);
  if (wall === null) return 'bad-date';
  if (m[2]) return { kind: 'zoned', wall, zone: UTC_ZONE, tzid: 'UTC' };
  const tzid = params.get('TZID');
  if (tzid === undefined) return { kind: 'floating', wall };
  const zone = zones(tzid);
  return zone ? { kind: 'zoned', wall, zone, tzid } : 'unsupported-timezone';
}

interface Resolved { iso: string; ms: number; note: WallResolution['note'] }

/** Turns a value into the store representation: date key, UTC ISO instant, or floating local ISO. */
export function resolveTime(t: TimeValue): Resolved {
  if (t.kind === 'date') return { iso: dateKeyOf(t.day), ms: t.day * DAY, note: null };
  if (t.kind === 'floating') return { iso: new Date(t.wall).toISOString().slice(0, 19), ms: t.wall, note: null };
  const r = wallToUtc(t.wall, t.zone);
  return { iso: new Date(r.utc).toISOString(), ms: r.utc, note: r.note };
}

/** Parses a non-negative RFC 5545 duration into nominal days and exact milliseconds. Null when invalid or negative. */
export function parseDuration(value: string): { days: number; ms: number } | null {
  const v = value.trim().toUpperCase().replace(/^\+/, '');
  const m = /^P(?:(\d{1,4})W|(\d{1,4}D)?(?:T(\d{1,6}H)?(\d{1,7}M)?(\d{1,8}S)?)?)$/.exec(v);
  if (!m || v === 'P' || v.endsWith('T')) return null;
  const num = (s: string | undefined) => (s ? parseInt(s, 10) : 0);
  const days = num(m[1]) * 7 + num(m[2]);
  const ms = num(m[3]) * HOUR + num(m[4]) * 60_000 + num(m[5]) * 1000;
  if (days + ms / DAY > IMPORT_LIMITS.maxEventDays) return null;
  return { days, ms };
}

/** How an occurrence's end is derived from its start. */
type EndSpec =
  | { type: 'none' }
  | { type: 'wall'; delta: number; zone: Zone | null }
  | { type: 'exact'; ms: number }
  | { type: 'duration'; days: number; ms: number };

/** End of one occurrence. Same-zone DTEND keeps wall-clock length, so a 9–10 meeting stays 9–10 across DST. */
function occurrenceEnd(start: TimeValue, startMs: number, spec: EndSpec): { iso: string; ms: number } | null {
  if (spec.type === 'none') return start.kind === 'date' ? { iso: dateKeyOf(start.day + 1), ms: (start.day + 1) * DAY } : null;
  if (start.kind === 'date') {
    const days = spec.type === 'wall' ? Math.round(spec.delta / DAY) : spec.type === 'duration' ? spec.days : 0;
    return { iso: dateKeyOf(start.day + days), ms: (start.day + days) * DAY };
  }
  if (spec.type === 'exact') return { iso: new Date(startMs + spec.ms).toISOString(), ms: startMs + spec.ms };
  if (start.kind === 'floating') {
    const w = start.wall + (spec.type === 'wall' ? spec.delta : spec.days * DAY + spec.ms);
    return { iso: new Date(w).toISOString().slice(0, 19), ms: w };
  }
  const ms = spec.type === 'wall'
    ? wallToUtc(start.wall + spec.delta, spec.zone ?? start.zone).utc
    : wallToUtc(start.wall + spec.days * DAY, start.zone).utc + spec.ms;
  return { iso: new Date(ms).toISOString(), ms };
}

// ---------------------------------------------------------------------------------------------------------------
// Recurrence rules

export interface RecurrenceRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: TimeValue | null;
  byDay: { nth: number; wd: number }[];
  byMonthDay: number[];
  byMonth: number[];
  wkst: number;
  text: string;
}

const RULE_KEYS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);

function intList(raw: string | undefined, max: number, allowNegative: boolean): number[] | null {
  if (raw === undefined) return [];
  const out: number[] = [];
  for (const s of raw.split(',').slice(0, 64)) {
    if (!/^[+-]?\d{1,2}$/.test(s)) return null;
    const n = Number(s);
    if (n === 0 || Math.abs(n) > max || (n < 0 && !allowNegative)) return null;
    out.push(n);
  }
  return out;
}

/**
 * Parses the subset of RRULE this module expands. Returns null for everything else (BYSETPOS, BYWEEKNO, BYYEARDAY,
 * BYHOUR/MINUTE/SECOND, sub-daily frequencies, COUNT with UNTIL, ordinal weekdays outside monthly/yearly-by-month rules).
 */
export function parseRecurrenceRule(value: string, zones: ZoneLookup): RecurrenceRule | null {
  const parts = ruleParts(value);
  if (!parts || [...parts.keys()].some((k) => !RULE_KEYS.has(k))) return null;
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  const intervalRaw = parts.get('INTERVAL') ?? '1';
  const interval = Number(intervalRaw);
  if (!/^\d{1,4}$/.test(intervalRaw) || interval < 1) return null;
  if (parts.has('COUNT') && parts.has('UNTIL')) return null;
  const countRaw = parts.get('COUNT');
  const count = countRaw === undefined ? null : Number(countRaw);
  if (countRaw !== undefined && (!/^\d{1,9}$/.test(countRaw) || count === 0)) return null;
  let until: TimeValue | null = null;
  const untilRaw = parts.get('UNTIL');
  if (untilRaw !== undefined) {
    const u = parseTimeValue(untilRaw, new Map(), zones);
    if (typeof u === 'string') return null;
    until = u;
  }
  const byDay: RecurrenceRule['byDay'] = [];
  for (const s of parts.has('BYDAY') ? (parts.get('BYDAY') ?? '').split(',').slice(0, 64) : []) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s);
    if (!m) return null;
    const nth = m[1] ? Number(m[1]) : 0;
    if (Math.abs(nth) > 5 || (m[1] && nth === 0)) return null;
    byDay.push({ nth, wd: WEEKDAYS.indexOf(m[2]) });
  }
  const byMonthDay = intList(parts.get('BYMONTHDAY'), 31, true);
  const byMonth = intList(parts.get('BYMONTH'), 12, false);
  if (!byMonthDay || !byMonth) return null;
  const wkst = parts.has('WKST') ? WEEKDAYS.indexOf(parts.get('WKST') ?? '') : 1;
  if (wkst < 0) return null;
  const ordinal = byDay.some((b) => b.nth !== 0);
  if ((freq === 'DAILY' || freq === 'WEEKLY') && (ordinal || byMonthDay.length)) return null;
  if (freq === 'MONTHLY' && byDay.length && byMonthDay.length) return null;
  if (freq === 'YEARLY' && byDay.length && (!byMonth.length || byMonthDay.length)) return null;
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, wkst, text: value.trim().slice(0, 200) };
}

/** Candidate days of period k, sorted and unique. Pure arithmetic on day numbers. */
function periodDays(rule: RecurrenceRule, k: number, startDay: number): number[] {
  const s = ymd(startDay);
  const monthDays = (y: number, mo: number): number[] => {
    const len = daysInMonth(y, mo);
    if (rule.byMonthDay.length) return rule.byMonthDay.map((md) => (md > 0 ? md : len + md + 1)).filter((md) => md >= 1 && md <= len).map((md) => dayNum(y, mo, md));
    if (rule.byDay.length) {
      const out: number[] = [];
      for (const b of rule.byDay) {
        if (b.nth) { const d = nthWeekday(y, mo, b.nth, b.wd); if (d !== null) out.push(d); }
        else for (let n = 1; n <= 5; n++) { const d = nthWeekday(y, mo, n, b.wd); if (d !== null) out.push(d); }
      }
      return out;
    }
    return s.d <= len ? [dayNum(y, mo, s.d)] : [];
  };
  let days: number[];
  if (rule.freq === 'DAILY') {
    const day = startDay + k * rule.interval;
    days = !rule.byDay.length || rule.byDay.some((b) => b.wd === ymd(day).wd) ? [day] : [];
  } else if (rule.freq === 'WEEKLY') {
    const weekStart = startDay - ((s.wd - rule.wkst + 7) % 7) + k * 7 * rule.interval;
    days = rule.byDay.length ? rule.byDay.map((b) => weekStart + ((b.wd - rule.wkst + 7) % 7)) : [startDay + k * 7 * rule.interval];
  } else if (rule.freq === 'MONTHLY') {
    const idx = s.y * 12 + (s.mo - 1) + k * rule.interval;
    const mo = (idx % 12) + 1;
    days = rule.byMonth.length && !rule.byMonth.includes(mo) ? [] : monthDays(Math.floor(idx / 12), mo);
  } else {
    const y = s.y + k * rule.interval;
    days = (rule.byMonth.length ? rule.byMonth : [s.mo]).flatMap((mo) => monthDays(y, mo));
  }
  if (rule.byMonth.length && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY')) days = days.filter((d) => rule.byMonth.includes(ymd(d).mo));
  return [...new Set(days)].sort((a, b) => a - b);
}

const dayOf = (t: TimeValue) => (t.kind === 'date' ? t.day : Math.floor(t.wall / DAY));
/** Wall time read as UTC: within 18 hours of the real instant, which is enough for coarse window checks. */
const approxMs = (t: TimeValue) => (t.kind === 'date' ? t.day * DAY : t.wall);
const withDay = (t: TimeValue, day: number): TimeValue => (t.kind === 'date' ? { kind: 'date', day } : { ...t, wall: day * DAY + (t.wall - dayOf(t) * DAY) });

/** Identity keys used to match EXDATE and RECURRENCE-ID values. The first key is the primary one. */
function occurrenceKeys(t: TimeValue): string[] {
  if (t.kind === 'date') return [`D${t.day}`];
  return [t.kind === 'floating' ? `F${t.wall}` : `U${wallToUtc(t.wall, t.zone).utc}`, `D${dayOf(t)}`];
}

function afterUntil(t: TimeValue, until: TimeValue): boolean {
  if (until.kind === 'date') return dayOf(t) > until.day;
  if (until.kind === 'floating' || t.kind !== 'zoned') return approxMs(t) > until.wall;
  const coarse = approxMs(t) - until.wall;
  if (Math.abs(coarse) > 2 * DAY) return coarse > 0;
  return wallToUtc(t.wall, t.zone).utc > wallToUtc(until.wall, until.zone).utc;
}

interface Window { fromMs: number; toMs: number }
/** Shared step allowance for one preview, so many long series cannot add up to unbounded work. */
interface Budget { steps: number }

/**
 * Occurrence starts of a series inside the window. DTSTART is always the first occurrence and counts toward COUNT.
 * Generation happens in wall time and each occurrence is resolved in its zone, so local times hold across DST.
 */
export function expandOccurrences(start: TimeValue, rule: RecurrenceRule | null, extra: readonly TimeValue[], excluded: ReadonlySet<string>, win: Window, budget: Budget = { steps: 200_000 }): { starts: TimeValue[]; truncated: boolean } {
  const raw: TimeValue[] = [start, ...extra];
  let truncated = false;
  if (rule) {
    const startDay = dayOf(start);
    const minLen = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[rule.freq] * rule.interval;
    const maxLen = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.freq] * rule.interval;
    const fromDay = Math.floor(win.fromMs / DAY) - 1;
    const toDay = Math.ceil(win.toMs / DAY) + 1;
    // Without COUNT nothing before the window matters, so skip whole periods instead of walking them.
    let k = rule.count === null ? Math.max(0, Math.floor((fromDay - startDay) / maxLen) - 1) : 0;
    let produced = 1;
    let kept = 0;
    let done = false;
    for (let steps = 0; !done; steps++, k++) {
      if (startDay + k * minLen > toDay) break;
      if (steps >= IMPORT_LIMITS.recurrenceSteps || budget.steps-- <= 0) { truncated = true; break; }
      for (const day of periodDays(rule, k, startDay)) {
        if (day <= startDay) continue;
        const t = withDay(start, day);
        if ((rule.until && afterUntil(t, rule.until)) || (rule.count !== null && produced >= rule.count) || day > toDay) { done = true; break; }
        produced++;
        if (day < fromDay) continue;
        if (++kept > IMPORT_LIMITS.instancesPerSeries * 2) { truncated = true; done = true; break; }
        raw.push(t);
      }
    }
  }
  const seen = new Set<string>();
  const starts: TimeValue[] = [];
  for (const t of raw.sort((a, b) => approxMs(a) - approxMs(b))) {
    const keys = occurrenceKeys(t);
    if (seen.has(keys[0]) || keys.some((k) => excluded.has(k))) continue;
    seen.add(keys[0]);
    const ms = resolveTime(t).ms;
    if (ms < win.fromMs || ms >= win.toMs) continue;
    if (starts.length >= IMPORT_LIMITS.instancesPerSeries) { truncated = true; break; }
    starts.push(t);
  }
  return { starts, truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// Preview

interface EventRecord {
  uid: string;
  title: string;
  location: string;
  description: string;
  url: string | null;
  start: TimeValue;
  end: EndSpec;
  endNote: CandidateNote | null;
  busy: boolean;
  cancelled: boolean;
  rule: RecurrenceRule | null | 'unsupported';
  rdates: TimeValue[];
  exdates: Set<string>;
  recurrenceId: string | null;
}

function safeUrl(value: string): string | null {
  const u = value.trim();
  return u.length <= IMPORT_LIMITS.urlChars && /^https?:\/\/[^\s"'<>\\]+$/i.test(u) ? u : null;
}

/** Collects DATE/DATE-TIME list values (RDATE, EXDATE). Null when a value is unreadable or a PERIOD. */
function listValues(props: Prop[], zones: ZoneLookup): TimeValue[] | null {
  const out: TimeValue[] = [];
  for (const p of props) {
    if ((p.params.get('VALUE') ?? '').toUpperCase() === 'PERIOD') return null;
    for (const v of p.value.split(',')) {
      if (out.length >= IMPORT_LIMITS.listValues) return null;
      const t = parseTimeValue(v, p.params, zones);
      if (typeof t === 'string') return null;
      out.push(t);
    }
  }
  return out;
}

function readEvent(comp: Comp, zones: ZoneLookup): EventRecord | ImportSkipCode {
  const get = (n: string) => comp.props.find((p) => p.name === n);
  const all = (n: string) => comp.props.filter((p) => p.name === n);
  const dtStart = get('DTSTART');
  if (!dtStart) return 'missing-start';
  const start = parseTimeValue(dtStart.value, dtStart.params, zones);
  if (typeof start === 'string') return start;
  const startMs = resolveTime(start).ms;
  let end: EndSpec = { type: 'none' };
  let endNote: CandidateNote | null = start.kind === 'date' ? 'end-defaulted' : null;
  const dtEnd = get('DTEND');
  const duration = get('DURATION');
  if (dtEnd) {
    const e = parseTimeValue(dtEnd.value, dtEnd.params, zones);
    if (typeof e === 'string') return e;
    if ((e.kind === 'date') !== (start.kind === 'date')) return 'bad-range';
    endNote = null;
    if (e.kind === 'date' && start.kind === 'date') end = { type: 'wall', delta: (e.day - start.day) * DAY, zone: null };
    else if (e.kind === 'floating' && start.kind === 'floating') end = { type: 'wall', delta: e.wall - start.wall, zone: null };
    else if (e.kind === 'zoned' && start.kind === 'zoned' && e.zone.id === start.zone.id) end = { type: 'wall', delta: e.wall - start.wall, zone: e.zone };
    else end = { type: 'exact', ms: resolveTime(e).ms - startMs };
  } else if (duration) {
    const d = parseDuration(duration.value);
    if (!d || (start.kind === 'date' && (d.ms !== 0 || d.days === 0))) return 'bad-range';
    end = { type: 'duration', ...d };
    endNote = 'end-from-duration';
  }
  const first = occurrenceEnd(start, startMs, end);
  if (first && (first.ms < startMs || (start.kind === 'date' && first.ms === startMs) || first.ms - startMs > IMPORT_LIMITS.maxEventDays * DAY)) return 'bad-range';
  const rrules = all('RRULE');
  const rule = rrules.length === 0 ? null : rrules.length > 1 ? 'unsupported' : parseRecurrenceRule(rrules[0].value, zones) ?? 'unsupported';
  const rdates = listValues(all('RDATE'), zones);
  const exdates = listValues(all('EXDATE'), zones);
  let recurrenceId: string | null = null;
  const rid = get('RECURRENCE-ID');
  if (rid) {
    const t = parseTimeValue(rid.value, rid.params, zones);
    if (typeof t === 'string' || rid.params.has('RANGE')) return 'unsupported-recurrence';
    recurrenceId = occurrenceKeys(t)[0];
  }
  return {
    uid: cleanText(get('UID')?.value ?? '', IMPORT_LIMITS.uidChars),
    title: cleanText(get('SUMMARY')?.value ?? '') || '(untitled)',
    location: cleanText(get('LOCATION')?.value ?? ''),
    description: cleanText(get('DESCRIPTION')?.value ?? ''),
    url: safeUrl(get('URL')?.value ?? ''),
    start,
    end,
    endNote,
    busy: (get('TRANSP')?.value ?? '').trim().toUpperCase() !== 'TRANSPARENT',
    cancelled: (get('STATUS')?.value ?? '').trim().toUpperCase() === 'CANCELLED',
    rule: rdates && exdates ? rule : 'unsupported',
    rdates: rdates ?? [],
    exdates: new Set((exdates ?? []).map((t) => occurrenceKeys(t)[0])),
    recurrenceId,
  };
}

/**
 * Builds the import preview. Never throws on malformed input and never stores anything. Recurring events are
 * expanded only inside [now - lookbackDays, now + horizonDays); single events are listed whatever their date.
 */
export function parseIcsForImport(text: string, options: ImportOptions): ImportPreview {
  const nowMs = typeof options.now === 'number' ? options.now : options.now.getTime();
  const look = Math.min(366, Math.max(0, Math.floor(options.lookbackDays ?? 31)));
  const horizon = Math.min(1098, Math.max(1, Math.floor(options.horizonDays ?? 365)));
  const window: Window = { fromMs: nowMs - look * DAY, toMs: nowMs + horizon * DAY };
  const counts = new Map<ImportSkipCode, number>();
  const skip = (code: ImportSkipCode, n = 1) => counts.set(code, (counts.get(code) ?? 0) + n);
  const candidates: ImportCandidate[] = [];
  const done = (error?: ImportPreview['error']): ImportPreview => ({
    candidates: candidates.sort((a, b) => a.sortMs - b.sortMs || a.event.title.localeCompare(b.event.title)),
    skipped: [...counts].map(([code, count]) => ({ code, count })),
    ...(error ? { error } : {}),
    window,
  });
  if (typeof text !== 'string' || !Number.isFinite(nowMs)) return done('not-calendar');
  if (text.length > IMPORT_LIMITS.bytes || new TextEncoder().encode(text).length > IMPORT_LIMITS.bytes) return done('too-large');
  const { roots, sawCalendar } = readComponents(text, skip);
  if (!sawCalendar) return done('not-calendar');

  const tzDefs = new Map<string, Comp>();
  const eventComps: Comp[] = [];
  for (const cal of roots) {
    if (cal.name !== 'VCALENDAR') continue;
    for (const child of cal.children) {
      if (child.name === 'VTIMEZONE') {
        const id = (child.props.find((p) => p.name === 'TZID')?.value ?? '').trim();
        if (tzDefs.size >= IMPORT_LIMITS.timezones) skip('too-many-timezones');
        else if (id && !child.bad) tzDefs.set(id, child);
      } else if (child.name === 'VEVENT') eventComps.push(child);
      else skip(child.bad ?? 'unsupported-component');
    }
  }
  const zoneCache = new Map<string, Zone | null>();
  const zones: ZoneLookup = (tzid) => {
    if (!zoneCache.has(tzid)) { if (zoneCache.size >= 256) return null; zoneCache.set(tzid, resolveZone(tzid, tzDefs)); }
    return zoneCache.get(tzid) ?? null;
  };

  const masters: EventRecord[] = [];
  const overrides = new Map<string, EventRecord[]>();
  for (const comp of eventComps) {
    if (comp.bad) { skip(comp.bad); continue; }
    const rec = readEvent(comp, zones);
    if (typeof rec === 'string') { skip(rec); continue; }
    if (rec.recurrenceId && rec.uid) { const list = overrides.get(rec.uid) ?? []; list.push(rec); overrides.set(rec.uid, list); }
    else masters.push(rec);
  }

  const keys = new Set<string>();
  const emit = (rec: EventRecord, start: TimeValue, series: ImportCandidate['series'], extra: CandidateNote[] = []) => {
    if (candidates.length >= IMPORT_LIMITS.events) { skip('too-many-events'); return; }
    const r = resolveTime(start);
    const end = occurrenceEnd(start, r.ms, rec.end);
    const notes = new Set<CandidateNote>(extra);
    if (r.note) notes.add(r.note);
    if (start.kind === 'floating') notes.add('floating-time');
    if (start.kind === 'zoned' && start.zone.kind === 'windows') notes.add('windows-zone');
    if (start.kind === 'zoned' && start.zone.kind === 'vtimezone') notes.add('vtimezone-rules');
    if (rec.endNote) notes.add(rec.endNote);
    if (series) notes.add('recurring-instance');
    if (!rec.busy) notes.add('free-time');
    const masterIso = resolveTime(rec.start).iso;
    const event: CalendarEvent = {
      id: rec.uid || `local:${masterIso}:${rec.title}`,
      title: rec.title,
      start: r.iso,
      end: end?.iso ?? null,
      allDay: start.kind === 'date',
      floating: start.kind === 'floating',
      location: rec.location,
      description: rec.description,
      url: rec.url,
    };
    const key = eventKey(event);
    if (keys.has(key)) { skip('duplicate-in-file'); return; }
    keys.add(key);
    candidates.push({ key, event, sourceZone: start.kind === 'zoned' ? start.tzid : null, busy: rec.busy, series, notes: [...notes], sortMs: r.ms });
  };

  const budget: Budget = { steps: 200_000 };
  const handled = new Set<string>();
  for (const m of masters) {
    const own = m.uid ? overrides.get(m.uid) ?? [] : [];
    if (m.uid) handled.add(m.uid);
    if (m.cancelled) { skip('cancelled'); continue; }
    if (candidates.length >= IMPORT_LIMITS.events) { skip('too-many-events'); continue; }
    if (m.rule === 'unsupported') { skip('unsupported-recurrence', 1 + own.length); continue; }
    if (!m.rule && m.rdates.length === 0) { emit(m, m.start, null); continue; }
    const { starts, truncated } = expandOccurrences(m.start, m.rule, m.rdates, m.exdates, window, budget);
    const byId = new Map(own.map((o) => [o.recurrenceId ?? '', o]));
    const used = new Set<EventRecord>();
    const ruleText = m.rule ? m.rule.text : 'RDATE';
    let emitted = 0;
    starts.forEach((s, index) => {
      const series = { uid: m.uid, index, rule: ruleText };
      const extra: CandidateNote[] = truncated ? ['recurrence-truncated'] : [];
      const o = occurrenceKeys(s).map((k) => byId.get(k)).find(Boolean);
      if (o) { used.add(o); if (!o.cancelled) { emit(o, o.start, series, [...extra, 'override']); emitted++; } return; }
      emit(m, s, series, extra);
      emitted++;
    });
    for (const o of own) {
      if (used.has(o) || o.cancelled) continue;
      const ms = resolveTime(o.start).ms;
      if (ms >= window.fromMs && ms < window.toMs) { emit(o, o.start, { uid: m.uid, index: -1, rule: ruleText }, ['override']); emitted++; }
    }
    if (emitted === 0 && starts.length === 0) skip('recurrence-outside-window');
  }
  for (const [uid, list] of overrides) {
    if (handled.has(uid)) continue;
    for (const o of list) { if (o.cancelled) skip('cancelled'); else emit(o, o.start, null, ['override']); }
  }
  return done();
}

// ---------------------------------------------------------------------------------------------------------------
// Review: duplicates, conflicts and the import request

export const MAX_CONFLICTS_LISTED = 5;

export interface ConflictRef { key: string; title: string; start: string; source: 'stored' | 'import' }

export interface SelectionReview {
  selected: ImportCandidate[];
  /** Conflicts per candidate key, with stored events and with other selected candidates. At most MAX_CONFLICTS_LISTED each. */
  conflicts: ReadonlyMap<string, ConflictRef[]>;
  /** Selected candidates that overlap something. */
  conflictCount: number;
  /** Candidate keys already in the store. Importing them replaces the stored copy. */
  duplicates: ReadonlySet<string>;
  replaceCount: number;
}

/** The zone used for all-day and floating times and for display. Falls back to UTC when the runtime has none. */
export function displayZone(timeZone?: string): Zone {
  const tz = timeZone ?? (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
  return tz === 'UTC' ? UTC_ZONE : ianaZone(tz) ?? UTC_ZONE;
}

/** Busy interval of a timed event in ms, or null for all-day events, which are not checked for conflicts. */
export function busySpan(e: CalendarEvent, zone: Zone): { start: number; end: number } | null {
  if (e.allDay) return null;
  const at = (iso: string) => (e.floating ? wallToUtc(Date.parse(`${iso}Z`), zone).utc : Date.parse(iso));
  const start = at(e.start);
  const end = e.end ? at(e.end) : start;
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end: Math.max(start, end) } : null;
}

/** Keys selected by default: everything not already stored. */
export function defaultSelection(preview: ImportPreview, existing: readonly CalendarEvent[]): Set<string> {
  const stored = new Set(existing.map(eventKey));
  return new Set(preview.candidates.filter((c) => !stored.has(c.key)).map((c) => c.key));
}

/**
 * Checks the current selection against stored events and against itself. Overlap is half-open, so back-to-back
 * events do not conflict and a zero-length event conflicts only when strictly inside another one.
 */
export function reviewSelection(preview: ImportPreview, selectedKeys: ReadonlySet<string>, existing: readonly CalendarEvent[], timeZone?: string): SelectionReview {
  const zone = displayZone(timeZone);
  const stored = new Set(existing.map(eventKey));
  type Item = { key: string; title: string; start: string; s: number; e: number; stored: boolean; selected: boolean };
  const items: Item[] = [];
  for (const ev of existing.slice(0, IMPORT_LIMITS.events)) {
    const span = busySpan(ev, zone);
    if (span) items.push({ key: eventKey(ev), title: ev.title, start: ev.start, s: span.start, e: span.end, stored: true, selected: false });
  }
  for (const c of preview.candidates) {
    const span = c.busy ? busySpan(c.event, zone) : null;
    if (span) items.push({ key: c.key, title: c.event.title, start: c.event.start, s: span.start, e: span.end, stored: false, selected: selectedKeys.has(c.key) });
  }
  items.sort((a, b) => a.s - b.s || a.e - b.e);
  const conflicts = new Map<string, ConflictRef[]>();
  const add = (to: Item, other: Item) => {
    if (to.stored || to.key === other.key || !(other.stored || other.selected)) return;
    const list = conflicts.get(to.key) ?? [];
    if (list.length < MAX_CONFLICTS_LISTED && !list.some((r) => r.key === other.key && r.source === (other.stored ? 'stored' : 'import'))) {
      list.push({ key: other.key, title: other.title, start: other.start, source: other.stored ? 'stored' : 'import' });
    }
    conflicts.set(to.key, list);
  };
  let active: Item[] = [];
  for (const it of items) {
    active = active.filter((a) => a.e > it.s);
    for (const a of active) if (it.s < a.e && a.s < it.e) { add(a, it); add(it, a); }
    active.push(it);
  }
  const selected = preview.candidates.filter((c) => selectedKeys.has(c.key));
  return {
    selected,
    conflicts,
    conflictCount: selected.filter((c) => conflicts.has(c.key)).length,
    duplicates: new Set(preview.candidates.filter((c) => stored.has(c.key)).map((c) => c.key)),
    replaceCount: selected.filter((c) => stored.has(c.key)).length,
  };
}

/** What the host receives after the user confirms. `ics` is what the main process parses and stores. */
export interface CalendarImportRequest {
  sourceName: string;
  events: CalendarEvent[];
  /** UTC/all-day/floating only, no recurrence rules, so the store parser accepts every event unchanged. */
  ics: string;
}

export type BuildRequestResult = { ok: true; request: CalendarImportRequest } | { ok: false; reason: 'nothing-selected' | 'too-large' };

/** Serializes the selected candidates. `stamp` becomes DTSTAMP so output is reproducible. */
export function buildImportRequest(preview: ImportPreview, selectedKeys: ReadonlySet<string>, sourceName: string, stamp: Date): BuildRequestResult {
  const events = preview.candidates.filter((c) => selectedKeys.has(c.key)).map((c) => c.event).slice(0, IMPORT_LIMITS.events);
  if (events.length === 0) return { ok: false, reason: 'nothing-selected' };
  const ics = toIcs(events, stamp);
  if (new TextEncoder().encode(ics).length > IMPORT_LIMITS.bytes) return { ok: false, reason: 'too-large' };
  return { ok: true, request: { sourceName: cleanText(sourceName, 200) || 'Pasted calendar', events, ics } };
}

/** Readable start/end in the display zone. All-day ranges show the inclusive last day. */
export function formatWhen(e: CalendarEvent, timeZone?: string, locale = 'en-US'): string {
  const tz = displayZone(timeZone).id;
  const dateFmt = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (e.allDay) {
    const s = Date.parse(`${e.start}T00:00:00Z`);
    const last = e.end ? Date.parse(`${e.end}T00:00:00Z`) - DAY : s;
    return last > s ? `${dateFmt.format(s)} – ${dateFmt.format(last)} (all day)` : `${dateFmt.format(s)} (all day)`;
  }
  const zoneOpt = e.floating ? 'UTC' : tz;
  const at = (iso: string) => Date.parse(e.floating ? `${iso}Z` : iso);
  const full = new Intl.DateTimeFormat(locale, { timeZone: zoneOpt, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const time = new Intl.DateTimeFormat(locale, { timeZone: zoneOpt, hour: 'numeric', minute: '2-digit', ...(e.floating ? {} : { timeZoneName: 'short' as const }) });
  const s = at(e.start);
  const suffix = e.floating ? ' (local time)' : '';
  if (!e.end || e.end === e.start) return `${full.format(s)}${e.floating ? suffix : ` ${time.formatToParts(s).find((p) => p.type === 'timeZoneName')?.value ?? ''}`.trimEnd()}`;
  const end = at(e.end);
  const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: zoneOpt }).format(s) === new Intl.DateTimeFormat('en-CA', { timeZone: zoneOpt }).format(end);
  return `${full.format(s)} – ${sameDay ? time.format(end) : `${full.format(end)}`}${suffix}`;
}
