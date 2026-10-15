import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowCounterClockwise, Copy, DownloadSimple, FloppyDisk, MagnifyingGlass, Note as NoteIcon, Plus, Tag, Trash, UploadSimple, X } from '@phosphor-icons/react';
import { SNIPPET_TAG, filterSnippets, insertAtCursor, listSnippets, notesExportFileName, notesToJson, notesToMarkdown, parseNotesExport, snippetKeyboardTarget } from '../ui/note-snippets';
import type { Note } from '../shared/contracts';
import { ConfirmDialog } from '../ui/Dialog';
import { Button, Empty, Field, Notice, PageHeader, Panel } from '../ui/primitives';
import { parseQuery, searchState } from '../../electron/services/search';
import { useReady } from '../ui/store';
import { cx, errMsg, fmtDateTime, localDateKey, normalizeTag, relTime, truncate } from '../ui/util';

type Draft = { id?: string; title: string; body: string; tags: string[] };
const blank = (): Draft => ({ title: '', body: '', tags: [] });
const fromNote = (n: Note): Draft => ({ id: n.id, title: n.title, body: n.body, tags: [...n.tags] });
const MAX_TAGS = 12;
const MAX_BODY = 20000;
/** Notes drawn in the list at once; "Show more" adds another page, so thousands of notes never render together. */
export const NOTE_PAGE = 100;
const SNIPPET_SOURCE_CHARS = 400;
const SEARCH_HIT_LIMIT = 50;

export const sameDraft = (a: Draft, b: Draft): boolean => a.title === b.title && a.body === b.body && a.tags.length === b.tags.length && a.tags.every((t, i) => t === b.tags[i]);
/** One-line preview of a note. Only the start of the body is read, so a 20,000 character note costs the same as a short one. */
export const noteSnippet = (body: string): string => truncate(body.slice(0, SNIPPET_SOURCE_CHARS).replace(/\s+/g, ' ').trim(), 70);

/**
 * Unsaved drafts survive leaving the Notes page. They live in renderer memory only: never written to disk, never sent
 * anywhere, and gone when the app closes. Saving, discarding or deleting removes the entry.
 */
type CachedDraft = { draft: Draft; loadedAt?: string };
const draftCache = new Map<string, CachedDraft>();
const MAX_CACHED_DRAFTS = 20;
export const noteDrafts = {
  get: (key: string): CachedDraft | undefined => draftCache.get(key),
  set(key: string, value: CachedDraft) {
    draftCache.delete(key); // re-insert so the newest edit is last
    draftCache.set(key, value);
    while (draftCache.size > MAX_CACHED_DRAFTS) draftCache.delete(draftCache.keys().next().value as string);
  },
  clear: (key: string) => void draftCache.delete(key),
  /** The most recently edited unsaved draft, if any. */
  latest: (): string | undefined => [...draftCache.keys()].pop(),
  size: () => draftCache.size,
  reset: () => draftCache.clear(),
};

type Selection = string | 'new' | null;

/** `initialItem` is the route's item parameter: the note to open first. An unknown id keeps the first note selected. */
export function Notes({ initialItem }: { initialItem?: string } = {}) {
  const { state, api, mutate, toast, productivity } = useReady();
  // Starting point: the routed note, else an unsaved draft left behind earlier in this session, else the first note.
  const initial = useMemo(() => {
    const routed = state.notes.find((n) => n.id === initialItem);
    const key = routed ? routed.id : initialItem ? undefined : noteDrafts.latest();
    const cached = key ? noteDrafts.get(key) : undefined;
    if (cached && (key === 'new' || state.notes.some((n) => n.id === key))) return { selected: key as Selection, draft: cached.draft, loadedAt: cached.loadedAt, restored: true };
    const start = routed ?? state.notes[0] ?? null;
    return { selected: (start?.id ?? null) as Selection, draft: start ? fromNote(start) : null, loadedAt: start?.updatedAt, restored: false };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(initial.selected);
  const [draft, setDraft] = useState<Draft | null>(initial.draft);
  /** updatedAt of the saved note this draft was started from; used to notice edits made elsewhere. */
  const [loadedAt, setLoadedAt] = useState<string | undefined>(initial.loadedAt);
  const [restored, setRestored] = useState(initial.restored);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [discardTo, setDiscardTo] = useState<Selection | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [shown, setShown] = useState(NOTE_PAGE);
  const deferredQuery = useDeferredValue(query);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef<Draft | null>(draft);
  draftRef.current = draft;
  // Snippets, export and import (all local: downloads use Blob URLs, imports go through the normal save path).
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const snippetListRef = useRef<HTMLUListElement>(null);
  const [snippetOpen, setSnippetOpen] = useState(false);
  const [snippetQuery, setSnippetQuery] = useState('');
  const [snippetIndex, setSnippetIndex] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  const current = state.notes.find((n) => n.id === selected) ?? null;
  const base = useMemo(() => (selected === 'new' ? blank() : current ? fromNote(current) : null), [selected, current]);
  const dirty = Boolean(draft && base && !sameDraft(draft, base));
  /** The note this draft belongs to was deleted elsewhere: saving would create a new note instead. */
  const missing = Boolean(draft?.id && selected === draft.id && !current && !saving);
  const changedElsewhere = Boolean(dirty && current && loadedAt && current.updatedAt !== loadedAt);

  // Keep an unsaved draft in renderer memory so leaving the page does not lose it.
  useEffect(() => {
    if (!selected || !draft) return;
    if (dirty || missing) noteDrafts.set(selected, { draft, loadedAt });
    else noteDrafts.clear(selected);
  }, [selected, draft, dirty, missing, loadedAt]);

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    state.notes.forEach((n) => n.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [state.notes]);
  // A filter on a tag that no longer exists would hide every note with no chip left to undo it.
  useEffect(() => {
    if (tagFilter && !allTags.some(([t]) => t === tagFilter)) setTagFilter(null);
  }, [allTags, tagFilter]);

  // Lower-cased text is built once per change to the notes, not once per keystroke.
  const haystacks = useMemo(() => state.notes.map((n) => ({ n, hay: `${n.title}\n${n.body}\n${n.tags.join(' ')}`.toLowerCase() })), [state.notes]);

  // Ranked, accent- and case-insensitive search (the same engine as Memory search); punctuation-only queries fall back to a plain substring match.
  const hits = useMemo(() => {
    if (!parseQuery(deferredQuery).length) return null;
    return new Map(searchState(state, deferredQuery, { categories: ['note'], limit: SEARCH_HIT_LIMIT, productivity: productivity ?? undefined }).map((r, i) => [r.id, { snippet: r.snippet, rank: i }]));
  }, [state, deferredQuery, productivity]);

  const list = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase().replace(/^#/, '');
    const sorted = [...state.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter((n) => !tagFilter || n.tags.includes(tagFilter));
    if (hits) return sorted.filter((n) => hits.has(n.id)).sort((a, b) => (hits.get(a.id)?.rank ?? 0) - (hits.get(b.id)?.rank ?? 0));
    if (!q) return sorted;
    const ok = new Set(haystacks.filter((h) => h.hay.includes(q)).map((h) => h.n.id));
    return sorted.filter((n) => ok.has(n.id));
  }, [state.notes, deferredQuery, tagFilter, hits, haystacks]);
  useEffect(() => setShown(NOTE_PAGE), [deferredQuery, tagFilter]);
  const visible = list.slice(0, shown);
  const searching = deferredQuery.trim() !== '' || tagFilter !== null;

  const usedBy = useMemo(() => {
    if (!current || !productivity) return [];
    return state.capsules.filter((c) => productivity.capsuleMeta[c.id]?.references.some((r) => r.kind === 'note' && r.target === current.id));
  }, [current, productivity, state.capsules]);

  const copyBody = async () => {
    if (!draft?.body) return;
    try {
      await navigator.clipboard.writeText(draft.body);
      toast('ok', 'Note text copied.');
    } catch {
      toast('error', 'Copying was blocked. Select the text and copy it manually.');
    }
  };

  const open = (id: Selection) => {
    setSelected(id);
    setTagInput('');
    setSaveError(null);
    const cached = id ? noteDrafts.get(id) : undefined;
    const n = state.notes.find((x) => x.id === id);
    if (cached && (id === 'new' || n)) {
      setDraft(cached.draft);
      setLoadedAt(cached.loadedAt);
      setRestored(true);
      return;
    }
    setRestored(false);
    if (id === 'new') {
      setDraft(blank());
      setLoadedAt(undefined);
    } else {
      setDraft(n ? fromNote(n) : null);
      setLoadedAt(n?.updatedAt);
    }
  };
  const requestOpen = (id: Selection) => {
    if (id === selected) return;
    if (dirty) setDiscardTo(id);
    else open(id);
  };
  // A later deep link to another note while this page is open (the hash changes without a remount).
  useEffect(() => {
    if (initialItem && state.notes.some((n) => n.id === initialItem)) requestOpen(initialItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem]);

  const discard = (target: Selection | undefined) => {
    setDiscardTo(undefined);
    if (target === undefined) return;
    if (selected) noteDrafts.clear(selected);
    // Reloading the same note (the Revert button) must not restore the draft that was just thrown away.
    open(target);
  };

  const addTag = (raw: string) => {
    if (!draft) return;
    const tags = raw.split(',').map(normalizeTag).filter(Boolean);
    if (!tags.length) return;
    const next = [...draft.tags];
    tags.forEach((t) => {
      if (!next.includes(t) && next.length < MAX_TAGS) next.push(t);
    });
    setDraft({ ...draft, tags: next });
    setTagInput('');
  };

  const save = async () => {
    if (!draft || saving || (!dirty && !tagInput.trim())) return;
    const pendingTag = normalizeTag(tagInput);
    const tags = pendingTag && !draft.tags.includes(pendingTag) && draft.tags.length < MAX_TAGS ? [...draft.tags, pendingTag] : draft.tags;
    const title = draft.title.trim() || 'Untitled';
    const submitted: Draft = { ...draft, title, tags };
    setSaving(true);
    setSaveError(null);
    const before = new Set(state.notes.map((n) => n.id));
    const payload: Partial<Note> = { title, body: draft.body, tags };
    // A note deleted elsewhere is saved as a new note instead of failing on the missing id.
    if (draft.id && !missing) payload.id = draft.id;
    let ok = false;
    try {
      ok = await mutate(() => api.saveNote(payload), 'Note saved.');
    } catch (e) {
      toast('error', errMsg(e));
    }
    setSaving(false);
    if (!ok) {
      setSaveError('Not saved. Your text is still here; fix the problem or copy it before leaving.');
      return;
    }
    setTagInput('');
    const fresh = await api.getState().catch(() => null);
    const saved = fresh?.notes.find((n) => (draft.id && !missing ? n.id === draft.id : !before.has(n.id)));
    const key = selected;
    if (key) noteDrafts.clear(key);
    setRestored(false);
    if (!saved) {
      // The write succeeded but the saved copy could not be re-read; keep the submitted text as the draft.
      setDraft(submitted);
      setLoadedAt(undefined);
      return;
    }
    setSelected(saved.id);
    setLoadedAt(saved.updatedAt);
    // Text typed while the save was in flight stays; otherwise the draft shows what was actually stored.
    setDraft(draftRef.current && !sameDraft(draftRef.current, { ...draft }) ? { ...draftRef.current, id: saved.id } : fromNote(saved));
  };

  const doDelete = async () => {
    if (!draft?.id) return;
    const key = selected;
    setSaving(true);
    const ok = await mutate(() => api.deleteNote(draft.id as string), 'Note deleted.');
    setSaving(false);
    if (ok) {
      if (key) noteDrafts.clear(key);
      setConfirmDelete(false);
      setSelected(null);
      setDraft(null);
      setRestored(false);
      setSaveError(null);
    }
  };

  // Arrow keys move focus through the note list; Enter or Space opens the focused note (a normal button click).
  const buttons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-note]') ?? []);
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const btns = buttons();
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = Math.min(btns.length - 1, i + 1);
    else if (e.key === 'ArrowUp') next = i - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = btns.length - 1;
    else if (e.key === 'Escape') next = -1;
    if (next === null) return;
    e.preventDefault();
    if (next < 0) searchRef.current?.focus();
    else btns[next]?.focus();
  };

  const snippetData = useMemo(() => listSnippets(state.notes.filter((n) => n.id !== draft?.id)), [state.notes, draft?.id]);
  const snippetMatches = useMemo(() => filterSnippets(snippetData.snippets, snippetQuery), [snippetData, snippetQuery]);
  useEffect(() => setSnippetIndex(0), [snippetQuery, snippetOpen]);
  const isSnippet = Boolean(draft?.tags.includes(SNIPPET_TAG));

  const closeSnippets = () => {
    setSnippetOpen(false);
    setSnippetQuery('');
    setTimeout(() => bodyRef.current?.focus(), 0);
  };
  const insertSnippet = (snippetBody: string) => {
    if (!draft) return;
    const ta = bodyRef.current;
    const len = draft.body.length;
    const start = Math.min(len, Math.max(0, ta?.selectionStart ?? len));
    const end = Math.min(len, Math.max(start, ta?.selectionEnd ?? start));
    try {
      const r = insertAtCursor(draft.body, start, end, snippetBody, MAX_BODY);
      setDraft({ ...draft, body: r.body });
      if (r.truncated) toast('info', `The snippet was cut to stay within ${MAX_BODY.toLocaleString()} characters.`);
      setSnippetOpen(false);
      setSnippetQuery('');
      setTimeout(() => {
        bodyRef.current?.focus();
        bodyRef.current?.setSelectionRange(r.cursor, r.cursor);
      }, 0);
    } catch (e) {
      toast('error', errMsg(e));
    }
  };
  const onSnippetKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSnippets();
      return;
    }
    // From the search box only ArrowDown moves into the list (Home/End keep moving the text caret).
    const fromRow = (e.target as HTMLElement).hasAttribute?.('data-snippet');
    if (!fromRow && e.key !== 'ArrowDown') return;
    const target = fromRow ? snippetKeyboardTarget(e.key, snippetIndex, snippetMatches.length) : snippetMatches.length ? Math.min(snippetIndex, snippetMatches.length - 1) : null;
    if (target === null) return;
    e.preventDefault();
    setSnippetIndex(target);
    snippetListRef.current?.querySelectorAll<HTMLButtonElement>('button[data-snippet]')[target]?.focus();
  };
  const toggleSnippetTag = () => {
    if (!draft) return;
    if (isSnippet) setDraft({ ...draft, tags: draft.tags.filter((t) => t !== SNIPPET_TAG) });
    else addTag(SNIPPET_TAG);
  };

  const download = (text: string, ext: 'md' | 'json', type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = notesExportFileName(localDateKey(), ext);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };
  const exportMarkdown = () => download(notesToMarkdown(list, { now: new Date() }), 'md', 'text/markdown;charset=utf-8');
  const exportJson = () => download(notesToJson(state.notes, { now: new Date() }), 'json', 'application/json;charset=utf-8');
  const runImport = async () => {
    if (importBusy) return;
    setImportResult(null);
    let parsed: ReturnType<typeof parseNotesExport>;
    try {
      parsed = parseNotesExport(importText);
    } catch (e) {
      setImportResult({ tone: 'danger', text: `Nothing imported. ${errMsg(e)}` });
      return;
    }
    setImportBusy(true);
    let imported = 0;
    let failed = 0;
    for (const n of parsed.notes) {
      let ok = false;
      try {
        ok = await mutate(() => api.saveNote({ title: n.title, body: n.body, tags: n.tags }));
      } catch {
        ok = false;
      }
      if (ok) imported++;
      else failed++;
    }
    setImportBusy(false);
    const dropped = parsed.dropped + failed;
    const detail = parsed.errors.length ? ` First problem: ${parsed.errors[0]}.` : failed ? ` ${failed} could not be saved.` : '';
    setImportResult({ tone: imported || !dropped ? 'info' : 'danger', text: `Imported ${imported} note${imported === 1 ? '' : 's'}, dropped ${dropped}.${detail}` });
    if (imported) setImportText('');
  };

  const clearFilters = () => {
    setQuery('');
    setTagFilter(null);
  };
  const status = state.notes.length === 0 ? '' : searching ? `${list.length} of ${state.notes.length} note${state.notes.length === 1 ? '' : 's'} match${hits && list.length >= SEARCH_HIT_LIMIT ? ` (best ${SEARCH_HIT_LIMIT} shown)` : ''}.` : `${state.notes.length} note${state.notes.length === 1 ? '' : 's'}.`;
  const refCount = usedBy.length;

  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Work" title="Notes" subtitle="Plain-text notes with tags, stored on this computer." actions={
          <>
            <div className="menu-wrap" onKeyDown={(e) => { if (e.key === 'Escape' && exportOpen) { e.preventDefault(); setExportOpen(false); } }}>
              <Button icon={DownloadSimple} aria-haspopup="menu" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>Export</Button>
              {exportOpen && (
                <div className="menu" role="menu" aria-label="Export notes">
                  <button type="button" role="menuitem" className="btn btn-quiet btn-sm" disabled={list.length === 0} onClick={exportMarkdown}>Download Markdown (filtered list)</button>
                  <button type="button" role="menuitem" className="btn btn-quiet btn-sm" disabled={state.notes.length === 0} onClick={exportJson}>Download JSON (all notes)</button>
                </div>
              )}
            </div>
            <Button icon={UploadSimple} aria-expanded={importOpen} aria-controls="note-import-panel" onClick={() => setImportOpen(!importOpen)}>Import JSON</Button>
            <Button variant="primary" icon={Plus} onClick={() => requestOpen('new')}>New note</Button>
          </>
        } />
      {importOpen && (
        <div id="note-import-panel">
          <Panel title="Import notes from JSON" actions={<Button size="sm" icon={X} onClick={() => setImportOpen(false)}>Close</Button>}>
            <div className="stack">
              <p className="sub">Paste a desktop-companion-notes JSON export. Each valid note is saved as a new note; ids in the file are ignored and nothing is overwritten.</p>
              <Field label="Export JSON">
                {(id) => <textarea id={id} className="input" rows={6} maxLength={2000000} spellCheck={false} value={importText} onChange={(e) => setImportText(e.target.value)} />}
              </Field>
              <div role="status" aria-live="polite">{importResult && <Notice tone={importResult.tone}>{importResult.text}</Notice>}</div>
              <div>
                <Button variant="primary" busy={importBusy} disabled={!importText.trim()} onClick={() => void runImport()}>Import JSON</Button>
              </div>
            </div>
          </Panel>
        </div>
      )}

      <div className="split">
        <aside className="split-list panel" aria-label="Note list">
          <div className="search">
            <MagnifyingGlass size={16} aria-hidden />
            <label htmlFor="note-search" className="sr-only">Search notes</label>
            <input
              ref={searchRef}
              id="note-search"
              type="search"
              className="input"
              placeholder="Search text or #tag"
              maxLength={200}
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && buttons().length) {
                  e.preventDefault();
                  buttons()[0]?.focus();
                } else if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  setQuery('');
                }
              }}
            />
          </div>
          {allTags.length > 0 && (
            <div className="chips" role="group" aria-label="Filter by tag">
              {allTags.slice(0, 16).map(([t, n]) => (
                <button key={t} type="button" className={cx('chip', tagFilter === t && 'on')} aria-pressed={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? null : t)}>
                  #{t} <span className="sub">{n}</span>
                </button>
              ))}
              {tagFilter && !allTags.slice(0, 16).some(([t]) => t === tagFilter) && (
                <button type="button" className="chip on" aria-pressed="true" onClick={() => setTagFilter(null)}>#{tagFilter} <X size={11} aria-hidden /></button>
              )}
            </div>
          )}
          <p className="sub pad" role="status" aria-live="polite">{status}</p>
          {state.notes.length === 0 && selected !== 'new' ? (
            <Empty icon={NoteIcon} title="No notes yet" action={<Button variant="primary" icon={Plus} onClick={() => requestOpen('new')}>Write the first note</Button>}>
              Jot down decisions, commands and references. Notes stay on this computer and are only sent anywhere if you copy them yourself.
            </Empty>
          ) : (
            <ul className="select-list" ref={listRef} onKeyDown={onListKey} aria-label="Notes">
              {selected === 'new' && (
                <li>
                  <button className="select-item on" aria-current="true" data-note>
                    <strong>New note</strong>
                    <span className="sub">{dirty ? 'Unsaved draft' : 'Empty draft'}</span>
                  </button>
                </li>
              )}
              {visible.map((n) => (
                <li key={n.id}>
                  <button data-note className={cx('select-item', selected === n.id && 'on')} aria-current={selected === n.id ? 'true' : undefined} onClick={() => requestOpen(n.id)}>
                    <strong>{truncate(n.title || 'Untitled', 80)}{noteDrafts.get(n.id) && selected !== n.id ? ' (unsaved draft)' : ''}</strong>
                    <span className="sub">{(hits?.get(n.id)?.snippet ?? noteSnippet(n.body)) || 'Empty note'}</span>
                    <span className="sub">{relTime(n.updatedAt)}{n.tags.length ? ` · ${n.tags.map((t) => `#${t}`).join(' ')}` : ''}</span>
                  </button>
                </li>
              ))}
              {list.length > visible.length && (
                <li className="pad">
                  <Button size="sm" onClick={() => setShown(shown + NOTE_PAGE)}>Show {Math.min(NOTE_PAGE, list.length - visible.length)} more ({list.length - visible.length} not shown)</Button>
                </li>
              )}
              {list.length === 0 && state.notes.length > 0 && (
                <li className="pad">
                  <p className="sub">{tagFilter ? `No notes tagged #${tagFilter}${query.trim() ? ' match this search' : ''}.` : 'No notes match this search.'}</p>
                  {searching && <Button size="sm" onClick={clearFilters}>Clear search and tag filter</Button>}
                </li>
              )}
            </ul>
          )}
        </aside>

        <div className="split-detail">
          {!draft ? (
            <Panel>
              <Empty icon={NoteIcon} title="Select or create a note">Pick a note on the left to read and edit it, or press New note.</Empty>
            </Panel>
          ) : (
            <Panel
              title={draft.id && !missing ? 'Edit note' : 'New note'}
              eyebrow={dirty ? 'Unsaved changes' : current ? `Saved ${fmtDateTime(current.updatedAt)}` : 'Draft'}
              actions={
                <>
                  <Button size="sm" icon={Copy} disabled={!draft.body} onClick={() => void copyBody()}>Copy text</Button>
                  {dirty && <Button size="sm" icon={ArrowCounterClockwise} disabled={saving} onClick={() => setDiscardTo(selected)}>{selected === 'new' ? 'Clear draft' : 'Revert'}</Button>}
                  {draft.id && current && <Button size="sm" variant="danger" icon={Trash} disabled={saving} onClick={() => setConfirmDelete(true)}>Delete</Button>}
                  <Button size="sm" variant="primary" icon={FloppyDisk} busy={saving} disabled={!dirty && !tagInput.trim()} onClick={() => void save()}>Save</Button>
                </>
              }
            >
              <div
                className="stack"
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    void save();
                  }
                }}
              >
                {saveError && <Notice tone="danger" title="Save failed">{saveError}</Notice>}
                {restored && dirty && <Notice tone="info" title="Unsaved draft restored">This draft was kept in memory while you were on another page. It is not saved until you press Save, and it is lost if the app closes.</Notice>}
                {missing && <Notice tone="warn" title="This note no longer exists">It was deleted elsewhere. Your text is kept here; Save stores it as a new note.</Notice>}
                {changedElsewhere && <Notice tone="warn" title="This note changed after you started editing">Saving replaces the stored version ({fmtDateTime(current?.updatedAt)}) with your text. Use Revert to reload the stored version instead.</Notice>}
                <Field label="Title">
                  {(id) => <input id={id} className="input input-title" value={draft.title} maxLength={120} placeholder="Untitled" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}
                </Field>
                <Field label="Body" hint={draft.body.length >= MAX_BODY ? `Limit of ${MAX_BODY.toLocaleString()} characters reached; extra text is cut off. Ctrl+S saves.` : `${draft.body.length.toLocaleString()} / ${MAX_BODY.toLocaleString()} characters · Ctrl+S saves`}>
                  {(id, d) => <textarea ref={bodyRef} id={id} aria-describedby={d} className="input note-body" rows={14} maxLength={MAX_BODY} spellCheck value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}
                </Field>
                <div className="row">
                  <Button size="sm" icon={Plus} aria-expanded={snippetOpen} aria-controls="note-snippet-picker" onClick={() => (snippetOpen ? closeSnippets() : setSnippetOpen(true))}>Insert snippet</Button>
                  <Button size="sm" icon={Tag} aria-pressed={isSnippet} disabled={!isSnippet && draft.tags.length >= MAX_TAGS} title={!isSnippet && draft.tags.length >= MAX_TAGS ? `Tag limit of ${MAX_TAGS} reached` : undefined} onClick={toggleSnippetTag}>{isSnippet ? 'Unmark snippet' : 'Mark as snippet'}</Button>
                </div>
                {snippetOpen && (
                  <div id="note-snippet-picker" className="panel pad stack" onKeyDown={onSnippetKey}>
                    <input
                      type="search"
                      className="input"
                      aria-label="Search snippets"
                      placeholder="Search snippets"
                      maxLength={200}
                      autoComplete="off"
                      autoFocus
                      value={snippetQuery}
                      onChange={(e) => setSnippetQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && snippetMatches[snippetIndex]) {
                          e.preventDefault();
                          insertSnippet(snippetMatches[snippetIndex].body);
                        }
                      }}
                    />
                    {snippetData.snippets.length === 0 ? (
                      <p className="sub">No snippets yet. Any note tagged #snippet appears here, ready to insert at the cursor; use Mark as snippet on a note to add it.</p>
                    ) : snippetMatches.length === 0 ? (
                      <p className="sub">No snippets match this search.</p>
                    ) : (
                      <ul className="select-list" ref={snippetListRef} aria-label="Snippets">
                        {snippetMatches.map((s, i) => (
                          <li key={s.id}>
                            <button
                              type="button"
                              data-snippet
                              className={cx('select-item', i === snippetIndex && 'on')}
                              tabIndex={i === snippetIndex ? 0 : -1}
                              onFocus={() => setSnippetIndex(i)}
                              onClick={() => insertSnippet(s.body)}
                            >
                              <strong>{truncate(s.title || 'Untitled', 80)}</strong>
                              <span className="sub">{noteSnippet(s.body) || 'Empty note'}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {snippetData.truncated && <p className="sub">Showing the first 200 snippets by title.</p>}
                  </div>
                )}
                {refCount > 0 && <p className="field-hint">Referenced by capsule{refCount === 1 ? '' : 's'}: {usedBy.map((c) => c.name).join(', ')}.</p>}
                <Field label="Tags" hint={`Press Enter or comma to add. Up to ${MAX_TAGS} tags.`}>
                  {(id, d) => (
                    <div className="tag-editor">
                      {draft.tags.map((t) => (
                        <span key={t} className="chip on">
                          <Tag size={12} aria-hidden /> {t}
                          <button type="button" className="chip-x" aria-label={`Remove tag ${t}`} onClick={() => setDraft({ ...draft, tags: draft.tags.filter((x) => x !== t) })}>
                            <X size={11} aria-hidden />
                          </button>
                        </span>
                      ))}
                      <input
                        id={id}
                        aria-describedby={d}
                        className="input input-bare"
                        value={tagInput}
                        maxLength={24}
                        list="note-tag-suggestions"
                        placeholder={draft.tags.length >= MAX_TAGS ? 'Tag limit reached' : 'add tag'}
                        disabled={draft.tags.length >= MAX_TAGS}
                        onChange={(e) => (e.target.value.includes(',') ? addTag(e.target.value) : setTagInput(e.target.value))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            addTag(tagInput);
                          } else if (e.key === 'Backspace' && !tagInput && draft.tags.length) setDraft({ ...draft, tags: draft.tags.slice(0, -1) });
                        }}
                        onBlur={() => tagInput && addTag(tagInput)}
                      />
                      <datalist id="note-tag-suggestions">
                        {allTags.filter(([t]) => !draft.tags.includes(t)).slice(0, 30).map(([t]) => <option key={t} value={t} />)}
                      </datalist>
                    </div>
                  )}
                </Field>
              </div>
            </Panel>
          )}
        </div>
      </div>

      <ConfirmDialog open={discardTo !== undefined} title="Discard unsaved changes?" confirmLabel="Discard" danger onCancel={() => setDiscardTo(undefined)} onConfirm={() => discard(discardTo)}>
        <p>{draft?.id && !missing ? `Your edits to “${truncate(draft.title || 'Untitled', 40)}” were not saved and will be lost.` : 'This draft was not saved and will be lost.'}</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete} title={`Delete “${truncate(draft?.title || 'Untitled', 40)}”?`} confirmLabel="Delete note" danger busy={saving} onCancel={() => setConfirmDelete(false)} onConfirm={() => void doDelete()}>
        <p>
          This permanently removes the note{draft && draft.body ? ` (${draft.body.length.toLocaleString()} characters${draft.tags.length ? `, ${draft.tags.length} tag${draft.tags.length === 1 ? '' : 's'}` : ''})` : ''} from this computer. It cannot be undone; automatic backups of the data file may keep an older copy until they rotate out.
        </p>
        {refCount > 0 && <p>Capsule{refCount === 1 ? '' : 's'} {usedBy.map((c) => `“${c.name}”`).join(', ')} still reference{refCount === 1 ? 's' : ''} this note; the reference will show as missing.</p>}
      </ConfirmDialog>
    </div>
  );
}
