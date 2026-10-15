import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowsClockwise, FileText, FloppyDisk, NotePencil, Plus, Trash } from '@phosphor-icons/react';
import type { JarvisAPI, Note } from '../shared/contracts';
import { Badge, Button, Empty, LoadingBlock, Notice, PageHeader, Panel } from '../ui/primitives';
import { useStore } from '../ui/store';
import { UNAVAILABLE_SOURCES, WRITING_SHORTCUTS, fmtWhen, matchShortcut, useReducedMotion } from '../ui/workbench';
import { PROMPT_LIMITS } from '../ui/prompt-tools';
import { PromptTools, type PromptToolsInput } from './PromptTools';

const SCRATCH = '__scratch__';
const TITLE_MAX = 200;
const BODY_MAX = 50000;

/* ---------- Approved document import (captain API v2.4) ----------
 * Structural copy of the captain's documents bridge so this file typechecks in a worktree without it. On integration the
 * captain may replace `localDocumentsBridge` with `documentsBridge` from '../ui/bridges' and `DocumentPreview` with
 * `ApprovedDocumentPreview` from '../shared/contracts'; the shapes are identical. The renderer never sees a path. */
export type DocumentPreview =
  | { status: 'cancelled' }
  | { status: 'unsupported'; name: string; format: string; reason: string }
  | { status: 'ready'; token: string; name: string; format: 'text' | 'markdown'; bytes: number; chars: number; lines: number; text: string; suggestedTitle: string };
export type DocumentsBridgeLike = {
  choose(): Promise<DocumentPreview>;
  saveAsNote(token: string, options?: { title?: string; tags?: string[] }): Promise<{ saved: true; title: string }>;
  discard(token: string): Promise<boolean>;
};
type DocumentMethods = { documentsChoose?(): Promise<DocumentPreview>; documentsSave?(token: string, options?: { title?: string; tags?: string[] }): Promise<{ saved: true; title: string }>; documentsDiscard?(token: string): Promise<boolean> };
export function localDocumentsBridge(api: JarvisAPI): DocumentsBridgeLike | null {
  const a = api as JarvisAPI & DocumentMethods;
  if (typeof a.documentsChoose !== 'function' || typeof a.documentsSave !== 'function' || typeof a.documentsDiscard !== 'function') return null;
  return { choose: () => a.documentsChoose!(), saveAsNote: (token, options) => (options === undefined ? a.documentsSave!(token) : a.documentsSave!(token, options)), discard: (token) => a.documentsDiscard!(token) };
}

/**
 * Import a .txt or .md file as a note. The main process opens the dialog and returns a preview; the text is shown as plain
 * text only and nothing is stored until Save. `initialPreview` lets tests and deep links start from a known state.
 */
export function DocumentImport({ docs, onSaved, initialPreview = null }: { docs: DocumentsBridgeLike | null; onSaved: (result: { title: string; text: string }) => void | Promise<void>; initialPreview?: DocumentPreview | null }) {
  const [preview, setPreview] = useState<DocumentPreview | null>(initialPreview);
  const [title, setTitle] = useState(initialPreview?.status === 'ready' ? initialPreview.suggestedTitle.slice(0, TITLE_MAX) : '');
  const [busy, setBusy] = useState<'choose' | 'save' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const ids = { title: useId(), text: useId() };
  if (!docs) {
    return (
      <Panel title="Import .txt / .md" eyebrow="Document import is not connected" as="div">
        <p className="sub">This build has no approved document import. Paste text into the scratch pad instead.</p>
      </Panel>
    );
  }
  const fail = (e: unknown, fallback: string) => setError(e instanceof Error && e.message ? e.message : fallback);
  const choose = async () => {
    setBusy('choose'); setError(null); setSaved(null);
    try {
      const p = await docs.choose();
      setPreview(p);
      if (p.status === 'ready') setTitle(p.suggestedTitle.slice(0, TITLE_MAX));
    } catch (e) { fail(e, 'The document could not be read.'); } finally { setBusy(null); }
  };
  const save = async () => {
    if (preview?.status !== 'ready' || busy) return;
    setBusy('save'); setError(null);
    try {
      const r = await docs.saveAsNote(preview.token, { title: title.trim().slice(0, TITLE_MAX) || preview.suggestedTitle });
      setSaved(r.title);
      const text = preview.text;
      setPreview(null);
      await onSaved({ title: r.title, text });
    } catch (e) { fail(e, 'The note could not be saved.'); } finally { setBusy(null); }
  };
  const discard = async () => {
    if (preview?.status !== 'ready' || busy) return;
    setBusy('discard'); setError(null);
    try { await docs.discard(preview.token); } catch (e) { fail(e, 'The preview could not be discarded.'); } finally { setPreview(null); setBusy(null); }
  };
  return (
    <Panel title="Import .txt / .md" eyebrow="Plain text and Markdown files" as="div" actions={<Button size="sm" icon={FileText} onClick={() => void choose()} busy={busy === 'choose'} disabled={busy !== null}>Choose file…</Button>}>
      <p className="sub">The file is read once and shown here as plain text; nothing is stored until you press Save. Files up to 100 KB; PDF and Word are not supported.</p>
      {error && <Notice tone="danger" title="Import failed">{error}</Notice>}
      {saved && !preview && <p className="sub" role="status">Saved as note “{saved}”.</p>}
      {preview?.status === 'cancelled' && <p className="sub" role="status">No document chosen.</p>}
      {preview?.status === 'unsupported' && <Notice tone="warn" title={`Not supported: ${preview.name}`}>{preview.reason}</Notice>}
      {preview?.status === 'ready' && (
        <div className="stack tight">
          <p className="sub"><Badge tone="info">{preview.format}</Badge> {preview.name} · {preview.chars.toLocaleString()} characters · {preview.lines.toLocaleString()} lines · {preview.bytes.toLocaleString()} bytes</p>
          <label htmlFor={ids.title} className="sr-only">Note title</label>
          <input id={ids.title} className="input" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder="Title" disabled={busy !== null} />
          <label htmlFor={ids.text} className="sr-only">Document text</label>
          <textarea id={ids.text} className="input mono" rows={10} readOnly value={preview.text} />
          <div className="row">
            <Button variant="primary" icon={FloppyDisk} onClick={() => void save()} busy={busy === 'save'} disabled={busy !== null}>Save as note</Button>
            <Button icon={Trash} onClick={() => void discard()} busy={busy === 'discard'} disabled={busy !== null}>Discard</Button>
            <span className="sub">Tagged “imported”. Previews expire after 10 minutes.</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

type Draft = { id: string; title: string; body: string; tags: string[] };
const fromNote = (n: Note): Draft => ({ id: n.id, title: n.title, body: n.body, tags: n.tags });
const scratch = (): Draft => ({ id: SCRATCH, title: 'Scratch pad', body: '', tags: [] });

/**
 * Writing workbench: your notes (first scope) or an unsaved scratch pad on the left and in the editor, the bounded draft
 * tools on the right. Only saved notes are app-owned sources; the scratch pad is plain text that lives in this screen until
 * you save it as a note. PDF, Word and screen text are listed as unavailable rather than half-supported.
 */
export function WritingWorkbench({ initialNoteId }: { initialNoteId?: string } = {}) {
  const { status, loadError, reload, state, settings, api, mutate, toast } = useStore();
  const notes = useMemo(() => [...(state?.notes ?? [])].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), [state]);
  const [draft, setDraft] = useState<Draft>(() => scratch());
  const [selection, setSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const ids = { title: useId(), body: useId(), filter: useId() };
  const reduced = useReducedMotion(settings?.reduceMotion ?? false);

  // Load the requested note once the state is in; later state refreshes do not overwrite unsaved edits.
  useEffect(() => {
    if (!state || loadedFor === (initialNoteId ?? '')) return;
    const n = initialNoteId ? state.notes.find((x) => x.id === initialNoteId) : undefined;
    if (n) setDraft(fromNote(n));
    setLoadedFor(initialNoteId ?? '');
  }, [state, initialNoteId, loadedFor]);

  const saved = draft.id !== SCRATCH ? notes.find((n) => n.id === draft.id) : undefined;
  const deleted = draft.id !== SCRATCH && Boolean(state) && !saved;
  const dirty = draft.id === SCRATCH ? draft.body.trim().length > 0 || draft.title !== 'Scratch pad' : !saved || saved.title !== draft.title || saved.body !== draft.body;
  const shown = notes.filter((n) => !filter.trim() || `${n.title} ${n.body}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const selectedText = selection.end > selection.start ? draft.body.slice(selection.start, selection.end) : '';
  const toolsInput: PromptToolsInput = useMemo(() => ({ text: draft.body, selection: selectedText || undefined, ...(saved ? { noteId: saved.id, noteTitle: saved.title } : {}) }), [draft.body, selectedText, saved]);

  const open = (n: Note) => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setDraft(fromNote(n)); setSelection({ start: 0, end: 0 }); setPendingDelete(false); };
  const newNote = () => { if (dirty && !window.confirm('Discard unsaved changes?')) return; setDraft(scratch()); setSelection({ start: 0, end: 0 }); setPendingDelete(false); editorRef.current?.focus(); };
  const save = async () => {
    if (saving || !dirty) return;
    const title = draft.title.trim() === 'Scratch pad' && draft.id === SCRATCH ? '' : draft.title.trim();
    if (!title && !draft.body.trim()) { toast('info', 'Nothing to save yet.'); return; }
    setSaving(true);
    try {
      const payload: Partial<Note> = { ...(draft.id !== SCRATCH ? { id: draft.id } : {}), title: title || draft.body.trim().split('\n')[0].slice(0, 60), body: draft.body, tags: draft.tags };
      const ok = await mutate(() => api.saveNote(payload), draft.id === SCRATCH ? 'Saved as a note.' : 'Note saved.');
      if (ok && draft.id === SCRATCH) {
        // The new id is whichever note the store now holds with this body and title; fall back to staying on the scratch pad.
        const fresh = await api.getState().catch(() => null);
        const created = fresh?.notes.find((n) => n.body === draft.body && n.title === payload.title);
        if (created) setDraft(fromNote(created));
      }
    } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!saved) return;
    if (!pendingDelete) return setPendingDelete(true);
    setPendingDelete(false);
    if (await mutate(() => api.deleteNote(saved.id), 'Note deleted.')) setDraft(scratch());
  };
  const insert = (text: string, mode: 'append' | 'replace-selection') => {
    if (mode === 'replace-selection' && selection.end > selection.start) {
      const body = `${draft.body.slice(0, selection.start)}${text}${draft.body.slice(selection.end)}`.slice(0, BODY_MAX);
      setDraft({ ...draft, body });
      setSelection({ start: selection.start, end: selection.start + text.length });
    } else {
      setDraft({ ...draft, body: `${draft.body}${draft.body.trim() ? '\n\n' : ''}${text}`.slice(0, BODY_MAX) });
    }
    editorRef.current?.focus();
  };
  const openImported = async ({ title, text }: { title: string; text: string }) => {
    await reload().catch(() => undefined);
    const fresh = await api.getState().catch(() => null);
    const created = fresh?.notes.filter((n) => n.title === title && n.body === text).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    if (created) { setDraft(fromNote(created)); setSelection({ start: 0, end: 0 }); setPendingDelete(false); toast('ok', `Imported “${title}”.`); }
    else toast('info', `Imported “${title}”; find it in the notes list.`);
  };
  const trackSelection = () => { const el = editorRef.current; if (el) setSelection({ start: el.selectionStart, end: el.selectionEnd }); };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const hit = matchShortcut(WRITING_SHORTCUTS, e);
    if (!hit) return;
    e.preventDefault();
    if (hit === 'save') void save();
    else if (hit === 'new-note') newNote();
    else if (hit === 'focus-editor') editorRef.current?.focus();
    else if (hit === 'focus-tools') toolsRef.current?.querySelector<HTMLElement>('select, input, textarea, button')?.focus();
  };

  return (
    <div className="page page-wide" onKeyDown={onKeyDown} data-motion={reduced ? 'reduced' : 'full'}>
      <PageHeader eyebrow="Workspace" title="Writing" subtitle="Write in your notes, then translate, clean up, explain or diagnose with the assistant. Every prompt is shown before you send it." actions={<Button icon={Plus} onClick={newNote}>New note</Button>} />
      {status === 'loading' && <LoadingBlock label="Loading your notes…" />}
      {status === 'error' && <Notice tone="danger" title="The app data could not be loaded" action={<Button icon={ArrowsClockwise} onClick={() => void reload()}>Try again</Button>}>{loadError ?? 'The app did not respond.'}</Notice>}
      {status === 'ready' && state && (
        <div className="split">
          <aside className="split-list panel">
            <div className="search">
              <label htmlFor={ids.filter} className="sr-only">Filter notes</label>
              <input id={ids.filter} className="input" value={filter} onChange={(e) => setFilter(e.target.value.slice(0, 80))} placeholder="Filter notes" />
            </div>
            {notes.length === 0 ? (
              <Empty icon={NotePencil} title="No notes yet">Type in the scratch pad and save it; it becomes your first note and the first source the tools can cite.</Empty>
            ) : (
              <ul className="select-list" aria-label="Notes">
                <li><button type="button" className={draft.id === SCRATCH ? 'select-item on' : 'select-item'} aria-current={draft.id === SCRATCH} onClick={newNote}>Scratch pad <span className="sub">· not saved</span></button></li>
                {shown.map((n) => (
                  <li key={n.id}><button type="button" className={draft.id === n.id ? 'select-item on' : 'select-item'} aria-current={draft.id === n.id} onClick={() => open(n)}>{n.title || 'Untitled note'} <span className="sub">· {n.updatedAt.slice(0, 10)}</span></button></li>
                ))}
                {shown.length === 0 && <li className="sub pad">No note matches.</li>}
              </ul>
            )}
            <DocumentImport docs={localDocumentsBridge(api)} onSaved={openImported} />
            <Panel title="Keyboard" eyebrow="On this screen" as="div">
              <ul className="list compact">{WRITING_SHORTCUTS.map((s) => <li key={s.id} className="list-row"><span className="grow">{s.label}</span><kbd className="mono">{s.chord}</kbd></li>)}</ul>
            </Panel>
          </aside>
          <section className="split-detail stack">
            {deleted && <Notice tone="warn" title="This note was deleted elsewhere" action={<Button onClick={() => void save()}>Save as new note</Button>}>Your text is still here; save it to keep it, or start a new note.</Notice>}
            <div className="row">
              <label htmlFor={ids.title} className="sr-only">Title</label>
              <input id={ids.title} className="input input-title grow" value={draft.title} maxLength={TITLE_MAX} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Title" />
              {draft.id === SCRATCH ? <Badge tone="warn">not saved</Badge> : dirty ? <Badge tone="warn">unsaved changes</Badge> : <Badge tone="ok">saved {saved ? fmtWhen(saved.updatedAt) : ''}</Badge>}
            </div>
            <label htmlFor={ids.body} className="sr-only">Note text</label>
            <textarea ref={editorRef} id={ids.body} className="input note-body" rows={18} value={draft.body} maxLength={BODY_MAX} onChange={(e) => { setDraft({ ...draft, body: e.target.value }); trackSelection(); }} onSelect={trackSelection} onKeyUp={trackSelection} onMouseUp={trackSelection} placeholder="Write here. Select a passage to explain it, or paste error output to diagnose it." />
            <p className="field-hint" role="status">{draft.body.length.toLocaleString()} characters{selectedText ? ` · ${selectedText.length.toLocaleString()} selected` : ''}{draft.body.length > PROMPT_LIMITS.inputChars ? ` · the tools see the first ${PROMPT_LIMITS.inputChars.toLocaleString()}` : ''}</p>
            <div className="row">
              <Button variant="primary" icon={FloppyDisk} onClick={() => void save()} disabled={!dirty} busy={saving}>{draft.id === SCRATCH ? 'Save as note' : 'Save'}</Button>
              {saved && <Button variant={pendingDelete ? 'danger' : 'ghost'} icon={Trash} onClick={() => void remove()}>{pendingDelete ? 'Confirm delete' : 'Delete note'}</Button>}
              {pendingDelete && <Button onClick={() => setPendingDelete(false)}>Keep</Button>}
            </div>
            <Notice tone="info" title="Sources this workspace cannot read">
              <ul className="list compact">{UNAVAILABLE_SOURCES.map((u) => <li key={u.id} className="list-row"><span className="grow"><strong>{u.label}</strong> · {u.reason}</span></li>)}</ul>
            </Notice>
          </section>
          <aside className="split-detail" ref={toolsRef} aria-label="Draft tools">
            <PromptTools input={toolsInput} onInsert={insert} />
          </aside>
        </div>
      )}
    </div>
  );
}
