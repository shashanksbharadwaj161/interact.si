import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ClipboardText, Trash } from '@phosphor-icons/react';
import type { ClipboardEntryView, ClipboardStatus } from '../../electron/services/clipboard';
import type { ClipboardClient } from '../ui/bridges';
import { filterEntries, focusAfterRemoval, groupByDay, historyKeyboardTarget } from '../ui/clipboard-history';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, IconButton, KV, LoadingBlock, Notice, Panel, Switch } from '../ui/primitives';
import { errMsg, fmtDateTime } from '../ui/util';

export type ClipboardOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Wraps each bridge call so the panel shows one readable error and never assumes success. Turning history on can fail
 * when the native confirmation is declined; that is reported as-is, not retried.
 */
export function clipboardActions(client: ClipboardClient) {
  const attempt = async <T,>(op: () => Promise<T>): Promise<ClipboardOutcome<T>> => {
    try {
      return { ok: true, value: await op() };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  };
  return {
    load: () => attempt(async () => ({ status: await client.status(), entries: await client.list() })),
    setEnabled: (on: boolean) => attempt(() => client.setEnabled(on)),
    remove: (id: string) => attempt(() => client.remove(id)),
    purge: () => attempt(() => client.purge()),
  };
}

/** Human duration for the retention setting, for example "24 hours" or "30 days". */
export function retentionLabel(ms: number): string {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const MINUTE = 60_000;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (ms >= DAY && ms % DAY === 0) return unit(ms / DAY, 'day');
  if (ms >= HOUR && ms % HOUR === 0) return unit(ms / HOUR, 'hour');
  return unit(Math.max(1, Math.round(ms / MINUTE)), 'minute');
}

function capturedLabel(ts: number): string {
  return Number.isFinite(ts) ? fmtDateTime(new Date(ts).toISOString()) : 'unknown time';
}

export interface ClipboardProps {
  /** Bridge from src/ui/bridges.ts (clipboardBridge). Null when the build exposes no clipboard methods. */
  client: ClipboardClient | null;
  /** Called with the backend's status after every successful read or change, so the shell can mirror it (for example in a badge). */
  onStatus?: (status: ClipboardStatus) => void;
  /** Preloaded state. When given, the panel shows it at once and skips the initial load. */
  initial?: { status: ClipboardStatus; entries: ClipboardEntryView[] };
}

type Message = { tone: 'info' | 'warn' | 'danger'; text: string };

/**
 * Opt-in clipboard history. Off by default: turning it on asks the native main process for confirmation, and turning it
 * off clears every stored entry. Entries are shown as previews only; the panel has no control that writes to the system
 * clipboard (the listed ClipboardEntryView carries only a truncated `preview`, not the full stored text, so there is no
 * "copy again" control). Stored previews can be searched, are grouped by day, and the rows support roving-tabindex
 * keyboard navigation (ArrowUp/ArrowDown/Home/End) with Delete removing the focused row. Every change re-reads status
 * and entries from the backend, so the panel never shows state it did not get back.
 */
export function Clipboard({ client, onStatus, initial }: ClipboardProps) {
  const [status, setStatus] = useState<ClipboardStatus | null>(initial?.status ?? null);
  const [entries, setEntries] = useState<ClipboardEntryView[]>(initial?.entries ?? []);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'toggle' | 'remove' | 'clear' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [query, setQuery] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const pendingFocus = useRef<number | null>(null);

  const visible = filterEntries(entries, query);
  const groups = groupByDay(visible);
  const ordered = groups.flatMap((g) => g.entries);
  const activeId = ordered.some((e) => e.id === focusedId) ? focusedId : (ordered[0]?.id ?? null);
  const orderedKey = ordered.map((e) => e.id).join('\n');

  const focusRow = (id: string) => {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  };

  // After a keyboard Delete, move focus to the nearest remaining row once the reloaded list renders.
  useEffect(() => {
    if (pendingFocus.current === null || busy !== null) return;
    const target = focusAfterRemoval(pendingFocus.current, ordered.length);
    pendingFocus.current = null;
    if (target !== null) focusRow(ordered[target].id);
  }, [orderedKey, busy]);

  const reload = async (c: ClipboardClient) => {
    const r = await clipboardActions(c).load();
    if (r.ok) {
      setStatus(r.value.status);
      setEntries(r.value.entries);
      setLoadError(null);
      onStatus?.(r.value.status);
    } else {
      setLoadError(r.error);
    }
  };

  // Loads once per connection. The bridge object is rebuilt on each render, so it is not a dependency.
  const connected = client !== null;
  useEffect(() => {
    if (!client || initial) return;
    void reload(client);
  }, [connected]);

  const toggle = async (on: boolean) => {
    if (!client || busy) return;
    setBusy('toggle');
    setMessage(null);
    const r = await clipboardActions(client).setEnabled(on);
    if (!r.ok) setMessage({ tone: 'warn', text: on ? `Clipboard history stayed off. ${r.error}` : `Clipboard history could not be turned off. ${r.error}` });
    else if (!on) setMessage({ tone: 'info', text: 'Clipboard history is off and every stored entry was cleared.' });
    await reload(client);
    setBusy(null);
  };

  const remove = async (entry: ClipboardEntryView) => {
    if (!client || busy) return;
    setBusy('remove');
    setMessage(null);
    const r = await clipboardActions(client).remove(entry.id);
    if (!r.ok) setMessage({ tone: 'danger', text: r.error });
    else setMessage({ tone: 'info', text: r.value ? 'Entry removed.' : 'That entry was already gone.' });
    await reload(client);
    setBusy(null);
  };

  const clearAll = async () => {
    if (!client || busy) return;
    setConfirmClear(false);
    setBusy('clear');
    setMessage(null);
    const r = await clipboardActions(client).purge();
    if (!r.ok) setMessage({ tone: 'danger', text: r.error });
    else setMessage({ tone: 'info', text: 'All clipboard history entries were cleared.' });
    await reload(client);
    setBusy(null);
  };

  const onRowKeyDown = (ev: KeyboardEvent<HTMLLIElement>, entry: ClipboardEntryView, index: number) => {
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === 'Delete') {
      ev.preventDefault();
      if (busy) return;
      pendingFocus.current = index;
      void remove(entry);
      return;
    }
    const next = historyKeyboardTarget(ev.key, index, ordered.length);
    if (next === null) return;
    ev.preventDefault();
    focusRow(ordered[next].id);
  };

  if (!client) {
    return (
      <Panel title="Clipboard history" eyebrow="Privacy">
        <Notice tone="warn" title="Clipboard history is not connected">
          This build exposes no clipboard methods, so history cannot be turned on or viewed. Nothing is read from the clipboard.
        </Notice>
      </Panel>
    );
  }

  const enabled = status?.enabled === true;
  const controlsBusy = busy !== null;

  return (
    <div className="stack">
      <Panel title="Clipboard history" eyebrow="Privacy" actions={status && <Badge tone={enabled ? 'warn' : 'muted'}>{enabled ? 'On' : 'Off'}</Badge>}>
        {status === null ? (
          loadError ? (
            <Notice tone="danger" title="Clipboard history could not be read">
              {loadError}
            </Notice>
          ) : (
            <LoadingBlock label="Reading clipboard history settings…" />
          )
        ) : (
          <div className="stack">
            <Switch
              checked={enabled}
              disabled={controlsBusy}
              onChange={(on) => void toggle(on)}
              label="Keep clipboard history"
              description="Off by default. Turning it on asks for confirmation in a Windows dialog. Turning it off clears every stored entry."
            />
            <dl className="kv-list">
              <KV k="Storage">{status.persisted ? 'Saved on this computer' : 'Memory only'}</KV>
              <KV k="Kept for">{retentionLabel(status.retentionMs)}</KV>
              <KV k="Entries">{`${status.count} of ${status.maxEntries} at most`}</KV>
              <KV k="Size limit">{`${status.maxChars} characters per entry`}</KV>
            </dl>
            <Notice tone="info" title="Secrets can still be stored">
              Text that looks like a password, key or token is skipped. That check is a heuristic and can miss secrets, so do not rely on it.
            </Notice>
            {status.warning && <Notice tone="warn">{status.warning}</Notice>}
            {status.lastError && <Notice tone="danger">{status.lastError}</Notice>}
            {loadError && <Notice tone="danger">{loadError}</Notice>}
            {message && <Notice tone={message.tone}>{message.text}</Notice>}
          </div>
        )}
      </Panel>

      {status !== null && (
        <Panel
          title="Stored entries"
          actions={
            <Button size="sm" variant="danger" icon={Trash} disabled={entries.length === 0 || controlsBusy} onClick={() => setConfirmClear(true)}>
              Clear all
            </Button>
          }
        >
          {entries.length === 0 ? (
            <Empty icon={ClipboardText} title={enabled ? 'Nothing stored yet' : 'History is off'}>
              {enabled ? 'Text you copy appears here. Text that looks like a secret is never stored.' : 'Nothing is recorded while history is off.'}
            </Empty>
          ) : (
            <div className="stack">
              <input
                type="search"
                className="input"
                aria-label="Search clipboard history"
                placeholder="Search clipboard history"
                value={query}
                maxLength={200}
                onChange={(ev) => setQuery(ev.target.value)}
              />
              <p className="field-hint" role="status" aria-live="polite">
                {`${visible.length} of ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} match`}
              </p>
              <p className="field-hint">Use the arrow keys, Home and End to move between entries. Press Delete to remove the focused entry.</p>
              {ordered.length === 0 ? (
                <Empty icon={ClipboardText} title="No matching entries">
                  No stored preview contains every word you searched for.
                </Empty>
              ) : (
                <ul className="stack tight" aria-label="Clipboard history entries">
                  {groups.map((g) => (
                    <li key={g.key} className="stack tight">
                      <h3 id={`clipboard-day-${g.key}`} className="eyebrow">
                        {g.label}
                      </h3>
                      <ul className="stack tight" aria-labelledby={`clipboard-day-${g.key}`}>
                        {g.entries.map((e) => {
                          const index = ordered.indexOf(e);
                          return (
                            <li
                              key={e.id}
                              ref={(el) => {
                                if (el) rowRefs.current.set(e.id, el);
                                else rowRefs.current.delete(e.id);
                              }}
                              className="list-row"
                              tabIndex={e.id === activeId ? 0 : -1}
                              aria-label={`Clipboard entry: ${e.preview}`}
                              onFocus={(ev) => {
                                if (ev.target === ev.currentTarget) setFocusedId(e.id);
                              }}
                              onKeyDown={(ev) => onRowKeyDown(ev, e, index)}
                            >
                              <ClipboardText size={16} aria-hidden />
                              <div className="grow">
                                <p>{e.preview}</p>
                                <p className="field-hint">{`Copied ${capturedLabel(e.capturedAt)} · ${e.copies} ${e.copies === 1 ? 'time' : 'times'}`}</p>
                              </div>
                              <IconButton icon={Trash} label={`Remove entry copied ${capturedLabel(e.capturedAt)}`} disabled={controlsBusy} onClick={() => void remove(e)} />
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Panel>
      )}

      <ConfirmDialog
        open={confirmClear}
        title="Clear clipboard history?"
        danger
        confirmLabel="Clear all"
        busy={busy === 'clear'}
        onConfirm={() => void clearAll()}
        onCancel={() => setConfirmClear(false)}
      >
        {`This removes all ${entries.length} stored ${entries.length === 1 ? 'entry' : 'entries'}. It does not change whether history is on.`}
      </ConfirmDialog>
    </div>
  );
}
