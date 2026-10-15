// Calendar import review: previews .ics text with src/ui/calendar-import.ts, shows conflicts and duplicates, and lets
// the user pick events. Nothing is stored here. After an explicit confirmation the host's onImport callback receives a
// normalized request; the host passes request.ics to the main process, which parses and stores it again itself.
// This view reads no files, opens no network connection and changes no system schedule or reminder.
import { useEffect, useMemo, useState } from 'react';
import { CalendarCheck, Warning } from '@phosphor-icons/react';
import type { CalendarEvent } from '../../electron/services/calendar';
import {
  CANDIDATE_NOTE_LABELS, IMPORT_LIMITS, IMPORT_SKIP_LABELS, buildImportRequest, defaultSelection, formatWhen, parseIcsForImport, reviewSelection,
  type CalendarImportRequest, type ImportCandidate, type ImportPreview, type SelectionReview,
} from '../ui/calendar-import';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Field, Notice, Panel } from '../ui/primitives';
import { errMsg, truncate } from '../ui/util';

/** Store counts the host reports back (same shape as the calendar import route). */
export interface CalendarImportOutcome { added: number; dropped: number; total: number }

export interface CalendarImportSource { name: string; text: string }

export interface CalendarImportProps {
  /** Events already stored, used for duplicate and conflict checks only. */
  existing: readonly CalendarEvent[];
  /** Text the host already has (for example from a file input). Changing it starts a new preview. */
  source?: CalendarImportSource | null;
  /** Called once per confirmed import. The host forwards request.ics to its import route. */
  onImport(request: CalendarImportRequest): Promise<CalendarImportOutcome>;
  onClose?(): void;
  /** Reference time for the recurrence window; defaults to the time the preview is built. */
  now?: Date | number;
  /** Zone for display, all-day and floating times; defaults to the system zone. */
  timeZone?: string;
  /** Show the paste box. Default true. */
  allowPaste?: boolean;
}

export const MAX_REVIEW_ROWS = 200;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const PREVIEW_ERRORS: Record<NonNullable<ImportPreview['error']>, string> = {
  'too-large': `This calendar is larger than ${IMPORT_LIMITS.bytes / 1_000_000} MB, so it was not read.`,
  'not-calendar': 'This text does not contain a calendar. It has no BEGIN:VCALENDAR line.',
};

/** Outcome text after the host reports the import. */
export function outcomeMessage(r: CalendarImportOutcome): string {
  const parts = [`Imported ${plural(r.added, 'new event')}; ${plural(r.total, 'event')} stored on this device.`];
  if (r.dropped > 0) parts.push(`${plural(r.dropped, 'event')} over the store limit ${r.dropped === 1 ? 'was' : 'were'} not kept.`);
  return parts.join(' ');
}

/** Lines shown in the confirmation dialog, so the user sees exactly what the import does. */
export function confirmationLines(review: SelectionReview): string[] {
  const lines = [`${plural(review.selected.length, 'event')} will be added to the calendar stored on this device.`];
  if (review.conflictCount) lines.push(`${plural(review.conflictCount, 'selected event')} overlap${review.conflictCount === 1 ? 's' : ''} other events. They are imported as they are; nothing is moved.`);
  if (review.replaceCount) lines.push(`${plural(review.replaceCount, 'event')} already stored will be replaced by the imported copy.`);
  lines.push('No calendar account, reminder, routine or system setting is changed.');
  return lines;
}

function CandidateRow({ c, checked, review, timeZone, disabled, onToggle }: { c: ImportCandidate; checked: boolean; review: SelectionReview; timeZone?: string; disabled: boolean; onToggle(): void }) {
  const id = `cal-import-${c.key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}-${c.sortMs}`;
  const conflicts = review.conflicts.get(c.key) ?? [];
  const duplicate = review.duplicates.has(c.key);
  const notes = c.notes.filter((n) => n !== 'recurring-instance');
  return (
    <li className="list-row">
      <input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={onToggle} />
      <label htmlFor={id} className="grow stack tight">
        <span><strong>{c.event.title}</strong>{c.series && <span className="muted"> · repeats</span>}</span>
        <span className="muted">{formatWhen(c.event, timeZone)}{c.event.location ? ` · ${truncate(c.event.location, 80)}` : ''}</span>
        {c.sourceZone && c.sourceZone !== 'UTC' && <span className="field-hint">Time zone in file: {truncate(c.sourceZone, 60)}</span>}
        {notes.length > 0 && <span className="field-hint">{notes.map((n) => CANDIDATE_NOTE_LABELS[n]).join(' · ')}</span>}
        {conflicts.length > 0 && (
          <span className="field-hint">
            Overlaps: {conflicts.map((r) => `${truncate(r.title, 50)} (${r.source === 'stored' ? 'already in calendar' : 'in this import'})`).join(', ')}
          </span>
        )}
      </label>
      {duplicate && <Badge tone="info" title="Importing replaces the stored copy">Already stored</Badge>}
      {conflicts.length > 0 && <Badge tone="warn">Conflict</Badge>}
    </li>
  );
}

export function CalendarImport({ existing, source = null, onImport, onClose, now, timeZone, allowPaste = true }: CalendarImportProps) {
  const [active, setActive] = useState<CalendarImportSource | null>(source);
  const [paste, setPaste] = useState('');
  const [sel, setSel] = useState<{ preview: ImportPreview | null; keys: Set<string> }>({ preview: null, keys: new Set() });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  useEffect(() => { setActive(source); }, [source]);

  const preview = useMemo(
    () => (active ? parseIcsForImport(active.text, { now: now ?? Date.now() }) : null),
    // `now` is read when a new text arrives; a ticking clock must not re-expand the preview.
    [active],
  );
  const keys = useMemo(() => (preview && sel.preview === preview ? sel.keys : preview ? defaultSelection(preview, existing) : new Set<string>()), [preview, sel, existing]);
  const review = useMemo(() => (preview ? reviewSelection(preview, keys, existing, timeZone) : null), [preview, keys, existing, timeZone]);
  const setKeys = (next: Set<string>) => setSel({ preview, keys: next });

  const startPreview = () => {
    setMsg(null);
    setActive({ name: 'Pasted calendar', text: paste });
  };

  const discard = () => {
    setActive(null);
    setConfirmOpen(false);
    onClose?.();
  };

  const runImport = async () => {
    if (!preview || !active) return;
    const built = buildImportRequest(preview, keys, active.name, new Date());
    if (!built.ok) {
      setConfirmOpen(false);
      setMsg({ tone: 'danger', text: built.reason === 'too-large' ? 'The selected events are too large to import at once. Select fewer events.' : 'Select at least one event to import.' });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const outcome = await onImport(built.request);
      setConfirmOpen(false);
      setActive(null);
      setPaste('');
      setMsg({ tone: 'info', text: outcomeMessage(outcome) });
    } catch (e) {
      setConfirmOpen(false);
      setMsg({ tone: 'danger', text: errMsg(e, 'The import did not finish. Nothing was changed by this preview.') });
    } finally {
      setBusy(false);
    }
  };

  const candidates = preview?.candidates ?? [];
  const selectedCount = review?.selected.length ?? 0;
  const windowText = preview
    ? `Repeating events are listed from ${new Date(preview.window.fromMs).toISOString().slice(0, 10)} to ${new Date(preview.window.toMs).toISOString().slice(0, 10)}, up to ${IMPORT_LIMITS.instancesPerSeries} occurrences each.`
    : '';

  return (
    <Panel title="Review a calendar before importing" eyebrow="Calendar import">
      <div className="stack">
        <div role="status" aria-live="polite" className="stack">
          {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        </div>
        {allowPaste && (
          <div className="stack tight">
            <Field label="Paste iCalendar (.ics) text" hint="Checked on this device only. Nothing is imported until you confirm.">
              {(id, describedBy) => (
                <textarea id={id} className="input" rows={4} spellCheck={false} value={paste} maxLength={IMPORT_LIMITS.bytes} aria-describedby={describedBy} disabled={busy} onChange={(e) => setPaste(e.target.value)} placeholder="BEGIN:VCALENDAR…" />
              )}
            </Field>
            <div className="row wrap">
              <Button disabled={busy || !paste.trim()} onClick={startPreview}>Preview pasted text</Button>
            </div>
          </div>
        )}
        {preview?.error && <Notice tone="danger" title={`${active?.name ?? 'Calendar'} was not read`}>{PREVIEW_ERRORS[preview.error]}</Notice>}
        {preview && !preview.error && review && (
          <div className="stack" aria-label={`Preview of ${active?.name ?? 'calendar'}`} role="group">
            <div className="row wrap">
              <Badge tone="accent">{plural(candidates.length, 'event')} found</Badge>
              <Badge tone="ok">{selectedCount} selected</Badge>
              {review.conflictCount > 0 && <Badge tone="warn">{plural(review.conflictCount, 'conflict')}</Badge>}
              {review.duplicates.size > 0 && <Badge tone="info">{review.duplicates.size} already stored</Badge>}
              {preview.skipped.length > 0 && <Badge tone="muted">{preview.skipped.reduce((n, s) => n + s.count, 0)} skipped</Badge>}
            </div>
            <p className="field-hint">{windowText} All-day and free events are not checked for conflicts.</p>
            {preview.skipped.length > 0 && (
              <div className="stack tight">
                <h3 className="field-hint">Skipped, not imported</h3>
                <ul className="list" aria-label="Skipped items">
                  {preview.skipped.map((s) => (
                    <li key={s.code} className="list-row"><span className="grow">{IMPORT_SKIP_LABELS[s.code]}</span><Badge>{s.count}</Badge></li>
                  ))}
                </ul>
              </div>
            )}
            {candidates.length === 0 ? (
              <p className="muted">No events can be imported from this calendar.</p>
            ) : (
              <>
                <div className="row wrap">
                  <Button size="sm" disabled={busy} onClick={() => setKeys(new Set(candidates.map((c) => c.key)))}>Select all</Button>
                  <Button size="sm" disabled={busy} onClick={() => setKeys(new Set())}>Select none</Button>
                  <Button size="sm" disabled={busy} onClick={() => setKeys(new Set([...keys].filter((k) => !review.conflicts.has(k))))}>Unselect conflicts</Button>
                </div>
                <ul className="list" aria-label="Events in this calendar">
                  {candidates.slice(0, MAX_REVIEW_ROWS).map((c) => (
                    <CandidateRow key={c.key} c={c} checked={keys.has(c.key)} review={review} timeZone={timeZone} disabled={busy} onToggle={() => {
                      const next = new Set(keys);
                      if (next.has(c.key)) next.delete(c.key); else next.add(c.key);
                      setKeys(next);
                    }} />
                  ))}
                </ul>
                {candidates.length > MAX_REVIEW_ROWS && <p className="field-hint">Showing the first {MAX_REVIEW_ROWS} of {candidates.length} events. The selection buttons apply to all of them.</p>}
              </>
            )}
            <div className="row wrap">
              <Button variant="primary" icon={CalendarCheck} disabled={busy || selectedCount === 0} onClick={() => setConfirmOpen(true)}>
                {selectedCount === 0 ? 'Select events to import' : `Import ${plural(selectedCount, 'event')}…`}
              </Button>
              <Button disabled={busy} onClick={discard}>Discard preview</Button>
            </div>
          </div>
        )}
        {!preview && onClose && <div className="row wrap"><Button onClick={onClose}>Close</Button></div>}
      </div>
      <ConfirmDialog
        open={confirmOpen && !!review}
        title={`Import ${plural(selectedCount, 'event')}?`}
        confirmLabel="Import events"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void runImport()}
      >
        <div className="stack tight">
          {review && confirmationLines(review).map((line) => <p key={line}>{line}</p>)}
          {review && review.conflictCount > 0 && <p className="field-hint"><Warning size={14} aria-hidden /> Use “Unselect conflicts” first to leave overlapping events out.</p>}
        </div>
      </ConfirmDialog>
    </Panel>
  );
}
