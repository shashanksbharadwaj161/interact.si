// Calendar: imports local .ics files and lists the events stored on this device (electron/services/calendar.ts).
// The preview uses the same pure parser in the renderer and touches nothing. Import and clear go through the injected
// client: the main process parses and stores the file again, so the preview is never trusted for storage.
// No calendar account is read. Recurring events are skipped and counted, never expanded.
import { Suspense, useEffect, useId, useMemo, useState, type ComponentType } from 'react';
import { CalendarBlank, CalendarX, FileArrowUp } from '@phosphor-icons/react';
import { MAX_EVENTS, MAX_ICS_BYTES, parseIcs, type CalendarEvent, type IcsParseResult, type SkipCode } from '../../electron/services/calendar';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, Notice, PageHeader, Panel } from '../ui/primitives';
import { errMsg, fmtDateTime, fmtDueKey, fmtTime, localDateKey, truncate } from '../ui/util';

/** Main-process client. The captain wires it to the calendar IPC; this view never imports Node or Electron. */
export interface CalendarClient {
  /** Stored events. Order is not relied on; the view sorts them. */
  list(): Promise<CalendarEvent[]>;
  /** Parses the .ics text in the main process, merges it into the store and reports the counts. */
  importIcs(text: string): Promise<CalendarImportResult>;
  /** Removes every imported event. The .ics files on disk are not changed. */
  clear(): Promise<void>;
  /** Optional: main-process open dialog; the file is read and parsed in main and no path is returned. */
  importFile?(): Promise<CalendarFileImport>;
  /** Optional: main-process save dialog writing every stored event as one .ics file. */
  exportIcs?(): Promise<{ saved: boolean; events: number }>;
}

export type CalendarFileImport = CalendarImportResult & { imported: boolean; error?: 'too-large' | 'not-calendar' };

/** Outcome text for a dialog import. null means the dialog was cancelled. */
export function fileImportMessage(r: CalendarFileImport): { tone: 'info' | 'danger'; text: string } | null {
  if (r.error) return { tone: 'danger', text: r.error === 'too-large' ? `That file is larger than ${MAX_ICS_BYTES / 1_000_000} MB.` : 'That file is not an iCalendar (.ics) file.' };
  if (!r.imported) return null;
  const parts = [`Imported ${plural(r.added, 'new event')}; ${plural(r.total, 'event')} stored.`];
  if (r.dropped > 0) parts.push(`${plural(r.dropped, 'event')} over the store limit ${r.dropped === 1 ? 'was' : 'were'} not kept.`);
  return { tone: 'info', text: parts.join(' ') };
}

export interface CalendarImportResult {
  /** Events not previously stored. */
  added: number;
  /** Events over the store limit, which were not kept. */
  dropped: number;
  /** Events stored after the import. */
  total: number;
}

/** A parsed file waiting for confirmation. `text` is what gets imported, so the user imports what they previewed. */
export interface CalendarPreview {
  name: string;
  text: string;
  events: CalendarEvent[];
  skipped: IcsParseResult['skipped'];
  error: string | null;
}

/**
 * Detailed import review supplied by the host (App passes the lazily loaded CalendarImport). It receives the chosen file's
 * text, shows time zones, recurrence, duplicates and conflicts, and calls onImport with only the confirmed selection,
 * normalized without recurrence rules. Without it the basic preview below is used.
 */
export type CalendarReviewView = ComponentType<{
  existing: readonly CalendarEvent[];
  source: { name: string; text: string } | null;
  allowPaste?: boolean;
  onImport(request: { ics: string }): Promise<CalendarImportResult>;
  onClose?(): void;
}>;

export const MAX_LIST_ROWS = 200;
export const MAX_PREVIEW_ROWS = 50;

const IMPORT_ERRORS: Record<NonNullable<IcsParseResult['error']>, string> = {
  'too-large': `This file is larger than ${MAX_ICS_BYTES / 1_000_000} MB, so it was not read.`,
  'not-calendar': 'This file does not contain a calendar. It has no BEGIN:VCALENDAR line.',
};

const SKIP_LABELS: Record<SkipCode, string> = {
  'missing-start': 'Event without a start date',
  'bad-date': 'Invalid date or time',
  'date-out-of-range': 'Year outside 1900–2100',
  'unsupported-timezone': 'Time zone other than UTC (not supported)',
  'unsupported-recurrence': 'Repeating event (recurrence is not expanded)',
  'line-too-long': 'Line too long',
  'too-many-events': `Over the ${MAX_EVENTS}-event limit`,
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Start as epoch ms for ordering within a day. Floating and all-day values compare as written. */
function instant(e: CalendarEvent): number {
  const t = e.allDay ? Date.parse(e.start) : new Date(e.start).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Local calendar day. All-day and floating values keep the date they were written with. */
export function dayKey(e: Pick<CalendarEvent, 'start' | 'allDay' | 'floating'>): string {
  return e.allDay || e.floating ? e.start.slice(0, 10) : localDateKey(new Date(e.start));
}

/** Chronological order: day, then all-day before timed, then start time, then title. */
export function compareEvents(a: CalendarEvent, b: CalendarEvent): number {
  const da = dayKey(a);
  const db = dayKey(b);
  if (da !== db) return da < db ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  return instant(a) - instant(b) || a.title.localeCompare(b.title);
}

export function sortEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events].sort(compareEvents);
}

/** Sorted events grouped by local day. Input order does not matter. */
export function groupByDay(events: readonly CalendarEvent[]): { key: string; events: CalendarEvent[] }[] {
  const groups: { key: string; events: CalendarEvent[] }[] = [];
  for (const e of sortEvents(events)) {
    const key = dayKey(e);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.events.push(e);
    else groups.push({ key, events: [e] });
  }
  return groups;
}

/** Human time for one event. Times with a zone are shown in local time; floating times are shown as written. */
export function whenLabel(e: CalendarEvent): string {
  if (e.allDay) return 'All day';
  const start = fmtTime(e.start);
  if (!e.end) return start;
  const end = fmtTime(e.end);
  const endDay = e.floating ? e.end.slice(0, 10) : localDateKey(new Date(e.end));
  return endDay === dayKey(e) ? `${start} – ${end}` : `${fmtDateTime(e.start)} – ${fmtDateTime(e.end)}`;
}

/** Preview for already-read text. Errors come back as a message, never as a throw. */
export function previewText(name: string, text: string): CalendarPreview {
  const parsed = parseIcs(text);
  return {
    name,
    text,
    events: sortEvents(parsed.events),
    skipped: parsed.skipped,
    error: parsed.error ? IMPORT_ERRORS[parsed.error] : null,
  };
}

/** Preview for a picked file. Oversized files are refused before they are read. */
export async function readPreview(file: { name: string; size: number; text(): Promise<string> }): Promise<CalendarPreview> {
  const failed = (error: string): CalendarPreview => ({ name: file.name, text: '', events: [], skipped: [], error });
  if (file.size > MAX_ICS_BYTES) return failed(IMPORT_ERRORS['too-large']);
  let text: string;
  try {
    text = await file.text();
  } catch {
    return failed('The file could not be read.');
  }
  return previewText(file.name, text);
}

/** Import the previewed text. Refuses without calling the client when the preview is an error or has no events. */
export async function importPreview(client: CalendarClient, preview: CalendarPreview): Promise<string> {
  if (preview.error) throw new Error(preview.error);
  if (preview.events.length === 0) throw new Error('No events to import.');
  const r = await client.importIcs(preview.text);
  const updated = preview.events.length - r.added;
  const parts = [`Imported ${plural(r.added, 'new event')}.`];
  if (updated > 0) parts.push(`${plural(updated, 'matching event')} ${updated === 1 ? 'was' : 'were'} updated.`);
  if (r.dropped > 0) parts.push(`${plural(r.dropped, 'event')} over the store limit ${r.dropped === 1 ? 'was' : 'were'} not kept.`);
  return parts.join(' ');
}

function DayGroup({ day, events }: { day: string; events: CalendarEvent[] }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="stack tight">
      <h3 id={id} className="field-hint">{fmtDueKey(day)}</h3>
      <ul className="list">
        {events.map((e, i) => (
          <li key={`${e.id}\u0000${e.start}\u0000${i}`} className="list-row">
            <span className="grow stack tight">
              <strong>{e.title}</strong>
              <span className="muted">{whenLabel(e)}{e.location ? ` · ${e.location}` : ''}</span>
              {e.description && <span className="field-hint">{truncate(e.description, 160)}</span>}
              {e.url && <span className="field-hint">Link (not opened): {truncate(e.url, 120)}</span>}
            </span>
            {e.floating && <Badge tone="muted" title="The file gave no time zone, so the time is shown as written.">Floating time</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Stored events, grouped by day. Shows at most MAX_LIST_ROWS and says so. */
export function EventList({ events, loadError, onClear }: { events: CalendarEvent[] | null; loadError?: string | null; onClear: () => void }) {
  const groups = useMemo(() => groupByDay(events ? sortEvents(events).slice(0, MAX_LIST_ROWS) : []), [events]);
  return (
    <Panel title="Imported events" eyebrow="Stored on this device" actions={events && events.length > 0 ? <Button size="sm" variant="danger" icon={CalendarX} onClick={onClear}>Clear events</Button> : undefined}>
      {events === null ? (
        <p className="muted">{loadError ? 'Events are not available right now.' : 'Loading…'}</p>
      ) : events.length === 0 ? (
        <Empty icon={CalendarBlank} title="No events imported yet">Choose an .ics file above to preview its events before importing.</Empty>
      ) : (
        <div className="stack">
          <p className="field-hint">
            {plural(events.length, 'event')}, sorted by date.{events.length > MAX_LIST_ROWS ? ` Showing the first ${MAX_LIST_ROWS}.` : ''}
          </p>
          {groups.map((g) => <DayGroup key={g.key} day={g.key} events={g.events} />)}
        </div>
      )}
    </Panel>
  );
}

/** What a parsed file contains and whether it can be imported. */
export function PreviewPanel({ preview, busy, onImport, onDiscard }: { preview: CalendarPreview; busy: boolean; onImport: () => void; onDiscard: () => void }) {
  const count = preview.events.length;
  const canImport = !preview.error && count > 0 && !busy;
  return (
    <Panel title={`Preview: ${preview.name}`} eyebrow="Not imported yet">
      <div className="stack">
        {preview.error ? (
          <Notice tone="danger" title="Nothing imported">{preview.error}</Notice>
        ) : count === 0 ? (
          <Notice tone="warn" title="No events found">This file has no events that can be imported.</Notice>
        ) : (
          <p>{plural(count, 'event')} can be imported{preview.events.length > MAX_PREVIEW_ROWS ? `. The first ${MAX_PREVIEW_ROWS} are listed below` : ''}.</p>
        )}
        {preview.skipped.length > 0 && (
          <div className="stack tight">
            <strong>Skipped</strong>
            <ul className="list">
              {preview.skipped.map((s) => (
                <li key={s.code} className="list-row">
                  <span className="grow">{SKIP_LABELS[s.code]}</span>
                  <Badge tone="warn">{s.count}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!preview.error && count > 0 && (
          <ul className="list" aria-label="Events in this file">
            {preview.events.slice(0, MAX_PREVIEW_ROWS).map((e, i) => (
              <li key={`${e.id}\u0000${e.start}\u0000${i}`} className="list-row">
                <span className="grow"><strong>{e.title}</strong> <span className="muted">· {fmtDueKey(dayKey(e))} · {whenLabel(e)}</span></span>
              </li>
            ))}
          </ul>
        )}
        <div className="row wrap">
          <Button variant="primary" icon={FileArrowUp} busy={busy} disabled={!canImport} onClick={onImport}>
            {count > 0 && !preview.error ? `Import ${plural(count, 'event')}` : 'Import'}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={onDiscard}>Discard preview</Button>
        </div>
      </div>
    </Panel>
  );
}

/** Calendar view. Pass `api` from the shell; without it the view says the calendar is not connected. */
export function Calendar({ api, initialEvents, Review }: { api?: CalendarClient | null; initialEvents?: CalendarEvent[]; Review?: CalendarReviewView }) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(initialEvents ? sortEvents(initialEvents) : null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalendarPreview | null>(null);
  /** A chosen file's text, open in the detailed review (time zones, recurrence, duplicates) until imported or closed. */
  const [review, setReview] = useState<{ name: string; text: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  const reload = async (client: CalendarClient) => setEvents(sortEvents(await client.list()));

  useEffect(() => {
    if (!api) return;
    let live = true;
    reload(api).catch((e: unknown) => { if (live) setLoadError(errMsg(e)); });
    return () => { live = false; };
  }, [api]);

  if (!api) {
    return (
      <div className="page page-wide">
        <PageHeader eyebrow="Local" title="Calendar" />
        <Notice tone="warn" title="Calendar is not connected">
          The local .ics module is ready, but this build has no calendar store or import route, so files cannot be imported or shown. No calendar account is read.
        </Notice>
      </div>
    );
  }

  const chooseFile = async (file: File | undefined, input: HTMLInputElement) => {
    if (!file) return;
    setMsg(null);
    setReading(true);
    try {
      // Read and size errors keep the basic preview; a readable file opens the detailed review when the host provides one.
      const p = await readPreview(file);
      const detailed = Review && !p.error;
      setPreview(detailed ? null : p);
      setReview(detailed ? { name: p.name, text: p.text } : null);
    } finally {
      setReading(false);
      input.value = '';
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setBusy(true);
    setMsg(null);
    try {
      const text = await importPreview(api, preview);
      setPreview(null);
      setMsg({ tone: 'info', text });
      await reload(api);
    } catch (e) {
      setMsg({ tone: 'danger', text: errMsg(e, 'The import did not finish.') });
    } finally {
      setBusy(false);
    }
  };

  /** The review sends only the selected events, normalized without recurrence rules; main parses and stores them again. */
  const runReviewedImport = async (request: { ics: string }): Promise<CalendarImportResult> => {
    const r = await api.importIcs(request.ics);
    await reload(api).catch((e: unknown) => setLoadError(errMsg(e)));
    return { added: r.added, dropped: r.dropped, total: r.total };
  };

  const runFileImport = async () => {
    if (!api.importFile) return;
    setBusy(true);
    setMsg(null);
    try {
      const m = fileImportMessage(await api.importFile());
      if (m) setMsg(m);
      await reload(api);
    } catch (e) {
      setMsg({ tone: 'danger', text: errMsg(e, 'The file could not be imported.') });
    } finally {
      setBusy(false);
    }
  };

  const runExport = async () => {
    if (!api.exportIcs) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.exportIcs();
      if (r.saved) setMsg({ tone: 'info', text: `Saved ${plural(r.events, 'event')} to the chosen .ics file.` });
    } catch (e) {
      setMsg({ tone: 'danger', text: errMsg(e, 'The calendar could not be exported.') });
    } finally {
      setBusy(false);
    }
  };

  const runClear = async () => {
    setClearOpen(false);
    setBusy(true);
    setMsg(null);
    try {
      await api.clear();
      setMsg({ tone: 'info', text: 'Imported events were cleared. Your .ics files were not changed.' });
      await reload(api);
    } catch (e) {
      setMsg({ tone: 'danger', text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Local" title="Calendar" subtitle={Review ? 'Import .ics files and browse their events on this device. A chosen file opens a review that expands supported recurring events inside a set window; the file dialog import skips recurring events and counts them.' : 'Import .ics files and browse their events on this device. Recurring events are skipped and counted, not expanded.'} />
      <div className="stack">
        <div role="status" aria-live="polite" className="stack">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
          {loadError && <Notice tone="danger" title="Events could not be loaded">{loadError}</Notice>}
        </div>
        <Panel title="Import an .ics file" eyebrow="Local file">
          <Field label="Calendar file (.ics)" hint={`Read on this device only, up to ${MAX_ICS_BYTES / 1_000_000} MB. Nothing is sent anywhere.`}>
            {(id, describedBy) => (
              <input
                id={id}
                type="file"
                className="input"
                accept=".ics,text/calendar"
                aria-describedby={describedBy}
                disabled={busy || reading}
                onChange={(e) => void chooseFile(e.target.files?.[0], e.target)}
              />
            )}
          </Field>
          {reading && <p className="muted" role="status">Reading file…</p>}
          {(api.importFile || api.exportIcs) && (
            <div className="row wrap">
              {api.importFile && <Button icon={FileArrowUp} disabled={busy || reading} onClick={() => void runFileImport()}>Import with file dialog</Button>}
              {api.exportIcs && <Button disabled={busy || reading || !events?.length} onClick={() => void runExport()}>Export all as .ics</Button>}
            </div>
          )}
          {(api.importFile || api.exportIcs) && <p className="field-hint">The system dialog runs in the app itself. Files reached through shortcut links, junctions or network locations are refused.</p>}
        </Panel>
        {review && Review && (
          <Suspense fallback={<p className="muted" role="status">Opening the import review…</p>}>
            <Review existing={events ?? []} source={review} allowPaste={false} onImport={runReviewedImport} onClose={() => setReview(null)} />
          </Suspense>
        )}
        {preview && <PreviewPanel preview={preview} busy={busy} onImport={() => void runImport()} onDiscard={() => setPreview(null)} />}
        <EventList events={events} loadError={loadError} onClear={() => setClearOpen(true)} />
      </div>
      <ConfirmDialog
        open={clearOpen}
        title="Clear all imported events?"
        confirmLabel="Clear events"
        danger
        busy={busy}
        onCancel={() => setClearOpen(false)}
        onConfirm={() => void runClear()}
      >
        Removes every imported event from this device. The .ics files you imported are not changed.
      </ConfirmDialog>
    </div>
  );
}
