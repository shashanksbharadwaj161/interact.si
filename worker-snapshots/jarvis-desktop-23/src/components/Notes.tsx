import { useMemo, useState } from 'react';
import { FloppyDisk, MagnifyingGlass, Note as NoteIcon, Plus, Tag, Trash, X } from '@phosphor-icons/react';
import type { Note } from '../shared/contracts';
import { ConfirmDialog } from '../ui/Dialog';
import { Button, Empty, Field, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { cx, fmtDateTime, normalizeTag, relTime, truncate } from '../ui/util';

type Draft = { id?: string; title: string; body: string; tags: string[] };
const blank = (): Draft => ({ title: '', body: '', tags: [] });
const fromNote = (n: Note): Draft => ({ id: n.id, title: n.title, body: n.body, tags: [...n.tags] });
const MAX_TAGS = 12;

export function Notes() {
  const { state, api, mutate } = useReady();
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | 'new' | null>(state.notes[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(() => (state.notes[0] ? fromNote(state.notes[0]) : null));
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [discardTo, setDiscardTo] = useState<string | 'new' | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const current = state.notes.find((n) => n.id === selected) ?? null;
  const base = useMemo(() => (selected === 'new' ? blank() : current ? fromNote(current) : null), [selected, current]);
  const dirty = Boolean(draft && base && JSON.stringify(draft) !== JSON.stringify(base));

  const allTags = useMemo(() => {
    const m = new Map<string, number>();
    state.notes.forEach((n) => n.tags.forEach((t) => m.set(t, (m.get(t) ?? 0) + 1)));
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [state.notes]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...state.notes]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((n) => (!tagFilter || n.tags.includes(tagFilter)) && (!q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || n.tags.some((t) => t.includes(q.replace(/^#/, '')))));
  }, [state.notes, query, tagFilter]);

  const open = (id: string | 'new' | null) => {
    setSelected(id);
    setTagInput('');
    if (id === 'new') setDraft(blank());
    else {
      const n = state.notes.find((x) => x.id === id);
      setDraft(n ? fromNote(n) : null);
    }
  };
  const requestOpen = (id: string | 'new' | null) => {
    if (id === selected) return;
    if (dirty) setDiscardTo(id);
    else open(id);
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
    if (!draft || !dirty) return;
    const pendingTag = normalizeTag(tagInput);
    const tags = pendingTag && !draft.tags.includes(pendingTag) && draft.tags.length < MAX_TAGS ? [...draft.tags, pendingTag] : draft.tags;
    const title = draft.title.trim() || 'Untitled';
    setSaving(true);
    const before = new Set(state.notes.map((n) => n.id));
    const payload: Partial<Note> = { title, body: draft.body, tags };
    if (draft.id) payload.id = draft.id;
    const ok = await mutate(() => api.saveNote(payload), 'Note saved.');
    setSaving(false);
    if (!ok) return;
    setTagInput('');
    if (!draft.id) {
      const fresh = await api.getState().catch(() => null);
      const created = fresh?.notes.find((n) => !before.has(n.id));
      if (created) {
        setSelected(created.id);
        setDraft(fromNote(created));
        return;
      }
    }
    setDraft({ ...draft, title, tags });
  };

  const doDelete = async () => {
    if (!draft?.id) return;
    setSaving(true);
    const ok = await mutate(() => api.deleteNote(draft.id as string), 'Note deleted.');
    setSaving(false);
    if (ok) {
      setConfirmDelete(false);
      setSelected(null);
      setDraft(null);
    }
  };

  return (
    <div className="page page-wide">
      <PageHeader eyebrow="Work" title="Notes" subtitle="Plain-text notes with tags, stored on this computer." actions={<Button variant="primary" icon={Plus} onClick={() => requestOpen('new')}>New note</Button>} />

      <div className="split">
        <aside className="split-list panel" aria-label="Note list">
          <div className="search">
            <MagnifyingGlass size={16} aria-hidden />
            <label htmlFor="note-search" className="sr-only">Search notes</label>
            <input id="note-search" type="search" className="input" placeholder="Search text or #tag" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {allTags.length > 0 && (
            <div className="chips" role="group" aria-label="Filter by tag">
              {allTags.slice(0, 16).map(([t, n]) => (
                <button key={t} type="button" className={cx('chip', tagFilter === t && 'on')} aria-pressed={tagFilter === t} onClick={() => setTagFilter(tagFilter === t ? null : t)}>
                  #{t} <span className="sub">{n}</span>
                </button>
              ))}
            </div>
          )}
          {state.notes.length === 0 && selected !== 'new' ? (
            <Empty icon={NoteIcon} title="No notes yet" action={<Button variant="primary" icon={Plus} onClick={() => requestOpen('new')}>Write the first note</Button>}>
              Jot down decisions, commands and references.
            </Empty>
          ) : (
            <ul className="select-list" aria-live="polite">
              {selected === 'new' && (
                <li>
                  <button className="select-item on" aria-current="true">
                    <strong>New note</strong>
                    <span className="sub">Unsaved</span>
                  </button>
                </li>
              )}
              {list.map((n) => (
                <li key={n.id}>
                  <button className={cx('select-item', selected === n.id && 'on')} aria-current={selected === n.id ? 'true' : undefined} onClick={() => requestOpen(n.id)}>
                    <strong>{n.title || 'Untitled'}</strong>
                    <span className="sub">{truncate(n.body.replace(/\s+/g, ' '), 70) || 'Empty note'}</span>
                    <span className="sub">{relTime(n.updatedAt)}{n.tags.length ? ` · ${n.tags.map((t) => `#${t}`).join(' ')}` : ''}</span>
                  </button>
                </li>
              ))}
              {list.length === 0 && state.notes.length > 0 && <li className="sub pad">No notes match this search.</li>}
            </ul>
          )}
        </aside>

        <div className="split-detail">
          {!draft ? (
            <Panel>
              <Empty icon={NoteIcon} title="Select or create a note">Pick a note on the left to read and edit it.</Empty>
            </Panel>
          ) : (
            <Panel
              title={draft.id ? 'Edit note' : 'New note'}
              eyebrow={dirty ? 'Unsaved changes' : current ? `Saved ${fmtDateTime(current.updatedAt)}` : 'Draft'}
              actions={
                <>
                  {draft.id && <Button size="sm" variant="danger" icon={Trash} onClick={() => setConfirmDelete(true)}>Delete</Button>}
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
                <Field label="Title">
                  {(id) => <input id={id} className="input input-title" value={draft.title} maxLength={120} placeholder="Untitled" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />}
                </Field>
                <Field label="Body" hint={`${draft.body.length.toLocaleString()} / 20,000 characters · Ctrl+S saves`}>
                  {(id, d) => <textarea id={id} aria-describedby={d} className="input note-body" rows={14} maxLength={20000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}
                </Field>
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
                    </div>
                  )}
                </Field>
              </div>
            </Panel>
          )}
        </div>
      </div>

      <ConfirmDialog open={discardTo !== undefined} title="Discard unsaved changes?" confirmLabel="Discard" danger onCancel={() => setDiscardTo(undefined)} onConfirm={() => { const t = discardTo; setDiscardTo(undefined); if (t !== undefined) open(t); }}>
        <p>This note has edits that were not saved.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete} title={`Delete “${truncate(draft?.title || 'Untitled', 40)}”?`} confirmLabel="Delete note" danger busy={saving} onCancel={() => setConfirmDelete(false)} onConfirm={() => void doDelete()}>
        <p>The note is permanently removed from this computer.</p>
      </ConfirmDialog>
    </div>
  );
}
