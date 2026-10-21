import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Plus } from '@phosphor-icons/react';
import type { ActionPreview, ActionRequest } from '../shared/contracts';
import { Button, Empty, Notice, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { usePref } from '../ui/prefs';
import { cx, relTime, truncate } from '../ui/util';
import * as shelfModel from '../ui/file-shelf';
import { isPreviewBridge } from '../preview';
import { actionOutcome } from '../ui/action-result';

/* ---------- File shelf: pinned files, folders and links; opening always goes through preview → Confirm → execute ---------- */

type ShelfEdit = { id: string; label: string; note: string; tags: string };
type ShelfPending = { item: shelfModel.ShelfItem; preview: ActionPreview };

function shelfRequest(item: shelfModel.ShelfItem): ActionRequest {
  return item.kind === 'url' ? { type: 'open-url', target: item.target } : { type: 'launch', target: item.target };
}

export function FileShelf() {
  const { api } = useReady();
  const [rawShelf, setRawShelf] = usePref<unknown>(shelfModel.SHELF_PREF_KEY, shelfModel.emptyShelf());
  const shelf = useMemo(() => shelfModel.normalizeShelf(rawShelf), [rawShelf]);
  const [query, setQuery] = useState('');
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<ShelfEdit | null>(null);
  const [pending, setPending] = useState<ShelfPending | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);
  const queryId = useId();
  const typedId = useId();
  const preview = isPreviewBridge();
  const canPick = !preview && typeof api.pickPath === 'function';
  const canOpen = !preview && typeof api.previewAction === 'function' && typeof api.executeAction === 'function';
  const filtered = useMemo(() => shelfModel.filterShelf(shelf, query), [shelf, query]);
  const groups = useMemo(() => shelfModel.groupByKind(filtered), [filtered]);
  const recent = useMemo(() => shelfModel.recentItems(shelf, 8), [shelf]);

  const save = (next: shelfModel.Shelf) => setRawShelf(next);
  const report = (ok: string | null, err: string | null) => {
    setMessage(ok);
    setError(err);
  };

  const add = (kind: shelfModel.ShelfKind, target: string): boolean => {
    try {
      const r = shelfModel.addShelfItem(shelf, { kind, target });
      if (r.duplicate) {
        report(`“${truncate(r.item.label, 50)}” is already on the shelf.`, null);
      } else {
        save(r.shelf);
        report(`Added “${truncate(r.item.label, 50)}”.`, null);
      }
      return true;
    } catch (e) {
      report(null, e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  const pick = async (kind: 'file' | 'folder') => {
    if (!canPick || busyRef.current) return;
    busyRef.current = true;
    setBusy(`pick-${kind}`);
    try {
      const chosen = await api.pickPath(kind);
      if (chosen) add(kind, chosen);
      else report('Nothing was chosen.', null);
    } catch (e) {
      report(null, `The ${kind} picker failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const addTyped = (e: FormEvent) => {
    e.preventDefault();
    const text = typed.trim();
    if (!text) return;
    if (add(shelfModel.guessKind(text), text)) setTyped('');
  };

  const startEdit = (item: shelfModel.ShelfItem) => setEdit({ id: item.id, label: item.label, note: item.note, tags: item.tags.join(', ') });
  const saveEdit = () => {
    if (!edit) return;
    try {
      save(shelfModel.updateShelfItem(shelf, edit.id, { label: edit.label, note: edit.note, tags: shelfModel.parseTagText(edit.tags) }));
      setEdit(null);
      report('Changes saved.', null);
    } catch (e) {
      report(null, e instanceof Error ? e.message : String(e));
    }
  };
  const editKeys = (e: { key: string; preventDefault: () => void }) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEdit(null);
    }
  };

  const remove = (item: shelfModel.ShelfItem) => {
    try {
      save(shelfModel.removeShelfItem(shelf, item.id));
      if (pending?.item.id === item.id) setPending(null);
      if (edit?.id === item.id) setEdit(null);
      report(`Removed “${truncate(item.label, 50)}” from the shelf. The ${item.kind} itself was not touched.`, null);
    } catch (e) {
      report(null, e instanceof Error ? e.message : String(e));
    }
  };

  // Step 1: ask the backend for a preview. Nothing runs here.
  const requestOpen = async (item: shelfModel.ShelfItem) => {
    if (!canOpen || busyRef.current) return;
    busyRef.current = true;
    setBusy(item.id);
    setPending(null);
    report(null, null);
    try {
      const p = await api.previewAction(shelfRequest(item));
      setPending({ item, preview: p });
    } catch (e) {
      report(null, `Could not prepare “${truncate(item.label, 50)}”: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // Step 2: only after an explicit Confirm click on an allowed preview.
  const confirmOpen = async () => {
    if (!pending || !pending.preview.allowed || busyRef.current) return;
    const { item, preview: p } = pending;
    busyRef.current = true;
    setBusy(item.id);
    try {
      const outcome = actionOutcome(await api.executeAction(p.id, true), true);
      setPending(null);
      if (outcome.kind === 'ran') {
        save(shelfModel.recordOpened(shelf, item.id));
        report(`Opened “${truncate(item.label, 50)}”.`, null);
      } else {
        report(null, outcome.message ?? 'The item was not opened.');
      }
    } catch (e) {
      setPending(null);
      report(null, `“${truncate(item.label, 50)}” was not opened: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const cancelOpen = () => {
    setPending(null);
    report('Cancelled. Nothing was opened.', null);
  };

  const unavailable = preview ? 'Unavailable in browser preview (no Electron backend).' : 'Unavailable: this bridge does not provide it.';

  const renderItem = (item: shelfModel.ShelfItem) => {
    const editing = edit?.id === item.id;
    const isPending = pending?.item.id === item.id;
    return (
      <li key={item.id} className={cx('file-shelf-item', isPending && 'is-pending')} data-shelf-item={item.id}>
        {editing && edit ? (
          <div className="file-shelf-edit" role="group" aria-label={`Edit ${item.label}`}>
            <label className="ph-label">
              Label
              <input className="input" value={edit.label} maxLength={shelfModel.SHELF_LIMITS.label} autoFocus onChange={(e) => setEdit({ ...edit, label: e.target.value })} onKeyDown={editKeys} />
            </label>
            <label className="ph-label">
              Note
              <input className="input" value={edit.note} maxLength={shelfModel.SHELF_LIMITS.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} onKeyDown={editKeys} />
            </label>
            <label className="ph-label">
              Tags <span className="sub">comma separated</span>
              <input className="input" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} onKeyDown={editKeys} />
            </label>
            <div className="file-shelf-row">
              <Button size="sm" variant="primary" onClick={saveEdit}>
                Save
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <span className="field-hint">Enter saves, Escape cancels.</span>
            </div>
          </div>
        ) : (
          <div className="file-shelf-main">
            <span className="file-shelf-text">
              <strong>{item.label}</strong>
              <span className="sub file-shelf-target" title={item.target}>
                {item.target}
              </span>
              {item.note && <span className="sub">{item.note}</span>}
              {item.tags.length > 0 && <span className="sub">{item.tags.map((t) => `#${t}`).join(' ')}</span>}
            </span>
            <span className="file-shelf-actions">
              <Button size="sm" disabled={!canOpen || busy !== null} busy={busy === item.id} aria-label={`Open ${item.label}`} onClick={() => void requestOpen(item)}>
                Open
              </Button>
              <Button size="sm" variant="quiet" aria-label={`Edit ${item.label}`} onClick={() => startEdit(item)}>
                Edit
              </Button>
              <Button size="sm" variant="quiet" aria-label={`Remove ${item.label}`} onClick={() => remove(item)}>
                Remove
              </Button>
            </span>
          </div>
        )}
        {isPending && pending && (
          <div className="file-shelf-confirm" role="alertdialog" aria-label={`Confirm opening ${item.label}`}>
            <p>
              <strong>{pending.preview.summary}</strong>
            </p>
            {pending.preview.reason && <p className="field-hint">{pending.preview.reason}</p>}
            {pending.preview.allowed ? (
              <div className="file-shelf-row">
                <Button size="sm" variant="primary" autoFocus busy={busy === item.id} disabled={busy !== null} onClick={() => void confirmOpen()}>
                  Confirm
                </Button>
                <Button size="sm" variant="quiet" disabled={busy !== null} onClick={cancelOpen}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="file-shelf-row">
                <span className="field-hint">Not allowed{pending.preview.reason ? '' : ' by the app’s safety rules'}. Nothing was opened.</span>
                <Button size="sm" variant="quiet" onClick={() => setPending(null)}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <Panel title="File shelf" eyebrow="Pinned files, folders and links" className="file-shelf">
      <div className="file-shelf-add">
        <div className="file-shelf-row">
          <Button size="sm" icon={Plus} disabled={!canPick || busy !== null} busy={busy === 'pick-file'} onClick={() => void pick('file')}>
            Add file…
          </Button>
          <Button size="sm" icon={Plus} disabled={!canPick || busy !== null} busy={busy === 'pick-folder'} onClick={() => void pick('folder')}>
            Add folder…
          </Button>
          {!canPick && <span className="field-hint">File and folder pickers: {unavailable}</span>}
        </div>
        <form className="file-shelf-row" onSubmit={addTyped}>
          <label htmlFor={typedId} className="ph-label">
            Path or link
          </label>
          <input id={typedId} className="input grow" value={typed} maxLength={shelfModel.SHELF_LIMITS.target} placeholder={'C:\\Projects\\notes.txt or https://example.com'} onChange={(e) => setTyped(e.target.value)} />
          <Button size="sm" type="submit" disabled={!typed.trim()}>
            Add
          </Button>
        </form>
      </div>
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
      {error && (
        <Notice tone="danger" title="File shelf">
          {error}
        </Notice>
      )}
      {!canOpen && <p className="field-hint">Open: {unavailable}</p>}
      {recent.length > 0 && (
        <section className="file-shelf-recent" aria-label="Recently opened">
          <h3 className="widget-name">Recently opened</h3>
          <ul className="chips">
            {recent.map((r) => (
              <li key={r.id}>
                <button type="button" className="chip" disabled={!canOpen || busy !== null} onClick={() => void requestOpen(r)} title={r.target}>
                  {truncate(r.label, 30)}
                  {r.lastOpenedAt && <span className="sub"> · {relTime(r.lastOpenedAt)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {shelf.items.length === 0 ? (
        <Empty title="The shelf is empty">Pin files, folders or http(s) links you return to often. Opening one always asks you to confirm first.</Empty>
      ) : (
        <>
          <label htmlFor={queryId} className="ph-label">
            Search the shelf
          </label>
          <input id={queryId} type="search" className="input" value={query} placeholder="Label, path, tag…" onChange={(e) => setQuery(e.target.value)} />
          {groups.length === 0 && <p className="field-hint">No shelf items match “{truncate(query, 40)}”.</p>}
          {groups.map((g) => (
            <section key={g.kind} className="file-shelf-group" aria-label={g.title}>
              <h3 className="widget-name">
                {g.title} <span className="sub">{g.items.length}</span>
              </h3>
              <ul className="file-shelf-list">{g.items.map(renderItem)}</ul>
            </section>
          ))}
          <p className="field-hint">
            {shelf.items.length} of {shelfModel.SHELF_LIMITS.items} items. Kept in this window’s preferences; the files themselves are never read or changed by the shelf.
          </p>
        </>
      )}
    </Panel>
  );
}

/* ---------- Dashboard summaries (saved layout, picker, read-only data) ---------- */
