import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AppWindow, ArrowDown, ArrowUp, BookmarkSimple, CheckCircle, Copy, Cube, DownloadSimple, Export, Eye, File as FileIcon, FloppyDisk, FolderOpen, Link as LinkIcon, MagnifyingGlass, PencilSimple, Play, Plus, Trash, UploadSimple, WarningCircle } from '@phosphor-icons/react';
import type { Capsule } from '../shared/contracts';
import type { ReferenceKind } from '../../electron/services/store';
import type { PackImport, PathMapping, RestorePreview } from '../../electron/services/capsules';
import { buildResumeRecap, draftWorklog } from '../../electron/services/search';
import { SceneBackdrop } from './SceneBackdrop';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, IconButton, Notice, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { SCENES, isKnownScene, sceneName } from '../ui/scenes';
import { cx, fmtDateTime, parseHttpUrl, relTime, truncate } from '../ui/util';
import { parseBrowserRefs, splitAgainstCapsule, toCapsuleItems, type BrowserRef, type BrowserRefsResult } from '../ui/browser-refs';
import { buildProjectMap, mapKeyboardTarget, type MapNode, type ProjectMap } from '../ui/project-map';
import { FileShelf } from './FileShelf';
// src/styles/project-map.css holds the .project-map* rules. It is not imported here because existing test bundles of
// this file have no CSS loader; the SVG below carries presentation attributes so it renders without the stylesheet.

type Kind = Capsule['items'][number]['kind'];
type Item = Capsule['items'][number];
type Draft = { id?: string; name: string; description: string; scene: string; items: Item[] };
type Outcome = { id: string; opened: string[]; failed: { target: string; reason: string }[] };

const KIND_META: Record<Kind, { label: string; icon: typeof FileIcon; placeholder: string }> = {
  file: { label: 'File', icon: FileIcon, placeholder: 'C:\\Users\\you\\Documents\\plan.docx' },
  folder: { label: 'Folder', icon: FolderOpen, placeholder: 'C:\\Users\\you\\Projects\\site' },
  app: { label: 'App', icon: AppWindow, placeholder: 'notepad.exe or full path' },
  url: { label: 'URL', icon: LinkIcon, placeholder: 'https://example.com' },
};

const MAX_ITEMS = 40;
const blank = (): Draft => ({ name: '', description: '', scene: 'deep-space', items: [] });
const fromCapsule = (c: Capsule): Draft => ({ id: c.id, name: c.name, description: c.description, scene: c.scene, items: c.items.map((i) => ({ ...i })) });

function defaultLabel(kind: Kind, target: string): string {
  if (kind === 'url') {
    const u = parseHttpUrl(target);
    return u ? u.hostname : target;
  }
  const parts = target.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? target;
}

/** `initialItem` is the route's item parameter: the capsule to open first. An unknown id leaves the default. */
export function Capsules({ initialItem }: { initialItem?: string } = {}) {
  const { state, api, mutate, run, toast, isPreview } = useReady();
  const start = state.capsules.find((c) => c.id === initialItem) ?? state.capsules[0] ?? null;
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | 'new' | null>(start?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(() => (start ? fromCapsule(start) : null));
  const [saving, setSaving] = useState(false);
  const [pendingSelect, setPendingSelect] = useState<string | 'new' | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const [kind, setKind] = useState<Kind>('url');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  const [itemError, setItemError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const current = state.capsules.find((c) => c.id === selected) ?? null;
  const base = useMemo(() => (selected === 'new' ? blank() : current ? fromCapsule(current) : null), [selected, current]);
  const dirty = Boolean(draft && base && JSON.stringify(draft) !== JSON.stringify(base));

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...state.capsules]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.items.some((i) => i.label.toLowerCase().includes(q) || i.target.toLowerCase().includes(q)));
  }, [state.capsules, query]);

  const open = (id: string | 'new' | null) => {
    setSelected(id);
    setNameError(null);
    setItemError(null);
    setTarget('');
    setLabel('');
    if (id === 'new') setDraft(blank());
    else {
      const c = state.capsules.find((x) => x.id === id);
      setDraft(c ? fromCapsule(c) : null);
    }
  };
  const requestOpen = (id: string | 'new' | null) => {
    if (id === selected) return;
    if (dirty) setPendingSelect(id);
    else open(id);
  };
  // A later deep link to another capsule while this page is open (the hash changes without a remount).
  useEffect(() => {
    if (initialItem && state.capsules.some((c) => c.id === initialItem)) requestOpen(initialItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialItem]);

  const patch = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const addItem = () => {
    if (!draft) return;
    const t = target.trim();
    if (!t) return setItemError('Enter a target or use Browse.');
    if (t.length > 500) return setItemError('That target is too long (500 characters maximum).');
    if (kind === 'url' && !parseHttpUrl(t)) return setItemError('URLs must start with http:// or https://.');
    if (draft.items.length >= MAX_ITEMS) return setItemError(`A capsule holds at most ${MAX_ITEMS} items.`);
    if (draft.items.some((i) => i.kind === kind && i.target.toLowerCase() === t.toLowerCase())) return setItemError('That item is already in this capsule.');
    patch({ items: [...draft.items, { kind, target: t, label: (label.trim() || defaultLabel(kind, t)).slice(0, 80) }] });
    setTarget('');
    setLabel('');
    setItemError(null);
  };

  const browse = async () => {
    try {
      const p = await api.pickPath(kind === 'folder' ? 'folder' : 'file');
      if (p) {
        setTarget(p);
        setItemError(null);
      } else if (isPreview) toast('info', 'File pickers are unavailable in browser preview. Type a path instead.');
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'The picker failed.');
    }
  };

  const move = (i: number, d: -1 | 1) => {
    if (!draft) return;
    const items = [...draft.items];
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    patch({ items });
  };

  const save = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) return setNameError('Give the capsule a name.');
    setNameError(null);
    setSaving(true);
    const before = new Set(state.capsules.map((c) => c.id));
    const payload: Partial<Capsule> = { name, description: draft.description.trim(), scene: draft.scene, items: draft.items };
    if (draft.id) {
      payload.id = draft.id;
      if (current?.windows) payload.windows = current.windows;
    }
    const ok = await mutate(() => api.saveCapsule(payload), 'Capsule saved.');
    setSaving(false);
    if (ok && !draft.id) {
      const fresh = await api.getState().catch(() => null);
      const created = fresh?.capsules.find((c) => !before.has(c.id) && c.name === name);
      if (created) {
        setSelected(created.id);
        setDraft(fromCapsule(created));
      }
    } else if (ok) {
      setDraft((d) => (d ? { ...d, name, description: d.description.trim() } : d));
    }
  };

  const doDelete = async () => {
    if (!draft?.id) return;
    setSaving(true);
    const ok = await mutate(() => api.deleteCapsule(draft.id as string), 'Capsule deleted.');
    setSaving(false);
    if (ok) {
      setConfirmDelete(false);
      setOutcome(null);
      setSelected(null);
      setDraft(null);
    }
  };

  const doRestore = async () => {
    if (!draft?.id) return;
    setRestoring(true);
    const r = await run(() => api.restoreCapsule(draft.id as string));
    setRestoring(false);
    setConfirmRestore(false);
    if (r) {
      setOutcome({ id: draft.id, opened: r.opened ?? [], failed: r.failed ?? [] });
      if ((r.failed?.length ?? 0) === 0) toast('ok', `Opened ${r.opened?.length ?? 0} item(s).`);
    }
  };

  const savedItems = current?.items ?? [];

  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow="Work"
        title="Capsules"
        subtitle="A capsule bundles the files, folders, apps and links for one project so they can be reopened together."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => requestOpen('new')}>
            New capsule
          </Button>
        }
      />

      <div className="split">
        <aside className="split-list panel" aria-label="Capsule list">
          <div className="search">
            <MagnifyingGlass size={16} aria-hidden />
            <label htmlFor="cap-search" className="sr-only">Search capsules</label>
            <input id="cap-search" className="input" type="search" placeholder="Search capsules" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {state.capsules.length === 0 && selected !== 'new' ? (
            <Empty icon={Cube} title="No capsules yet" action={<Button icon={Plus} variant="primary" onClick={() => requestOpen('new')}>Create the first one</Button>}>
              Start with a project folder and the app or link you always open with it.
            </Empty>
          ) : (
            <ul className="select-list">
              {selected === 'new' && (
                <li>
                  <button className="select-item on" aria-current="true" onClick={() => undefined}>
                    <strong>New capsule</strong>
                    <span className="sub">Unsaved</span>
                  </button>
                </li>
              )}
              {list.map((c) => (
                <li key={c.id}>
                  <button className={cx('select-item', selected === c.id && 'on')} aria-current={selected === c.id ? 'true' : undefined} onClick={() => requestOpen(c.id)}>
                    <strong>{c.name}</strong>
                    <span className="sub">
                      {c.items.length} item{c.items.length === 1 ? '' : 's'} · {relTime(c.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
              {list.length === 0 && query && <li className="sub pad">No capsule matches “{truncate(query, 30)}”.</li>}
            </ul>
          )}
        </aside>

        <div className="split-detail">
          {!draft ? (
            <Panel>
              <Empty icon={Cube} title="Select or create a capsule">Choose one on the left to edit its items or restore it.</Empty>
            </Panel>
          ) : (
            <div className="stack">
              <Panel
                title={draft.id ? 'Edit capsule' : 'New capsule'}
                eyebrow={dirty ? 'Unsaved changes' : 'Details'}
                actions={
                  <>
                    {draft.id && (
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => setConfirmDelete(true)}>
                        Delete
                      </Button>
                    )}
                    <Button size="sm" variant="primary" icon={FloppyDisk} busy={saving} disabled={!dirty} onClick={() => void save()}>
                      Save
                    </Button>
                  </>
                }
              >
                <div className="grid2">
                  <Field label="Name" error={nameError}>
                    {(id, d) => <input id={id} aria-describedby={d} className="input" value={draft.name} maxLength={80} onChange={(e) => { patch({ name: e.target.value }); setNameError(null); }} />}
                  </Field>
                  <Field label="Scene" hint="Visual backdrop tied to this capsule.">
                    {(id) => (
                      <select id={id} className="input" value={draft.scene} onChange={(e) => patch({ scene: e.target.value })}>
                        {!isKnownScene(draft.scene) && <option value={draft.scene}>{draft.scene || 'None'} (custom)</option>}
                        {SCENES.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
                <Field label="Description">
                  {(id) => <textarea id={id} className="input" rows={2} maxLength={400} value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="What is this project or session?" />}
                </Field>
                <div className="capsule-scene-strip">
                  <SceneBackdrop scene={draft.scene} />
                  <span>{sceneName(draft.scene)}</span>
                </div>
              </Panel>

              <Panel title="Items" eyebrow={`${draft.items.length} of ${MAX_ITEMS}`}>
                {draft.items.length === 0 ? (
                  <Empty title="Nothing in this capsule yet">Add a file, folder, app or link below.</Empty>
                ) : (
                  <ol className="item-list">
                    {draft.items.map((it, i) => {
                      const M = KIND_META[it.kind];
                      return (
                        <li key={`${it.kind}:${it.target}`} className="item-row">
                          <M.icon size={18} aria-hidden />
                          <div className="item-main">
                            <input className="input input-bare" aria-label={`Label for ${it.target}`} value={it.label} maxLength={80} onChange={(e) => patch({ items: draft.items.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                            <code title={it.target}>{it.target}</code>
                          </div>
                          <Badge>{M.label}</Badge>
                          <IconButton icon={ArrowUp} label={`Move ${it.label} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                          <IconButton icon={ArrowDown} label={`Move ${it.label} down`} disabled={i === draft.items.length - 1} onClick={() => move(i, 1)} />
                          <IconButton icon={Trash} label={`Remove ${it.label}`} onClick={() => patch({ items: draft.items.filter((_, j) => j !== i) })} />
                        </li>
                      );
                    })}
                  </ol>
                )}

                <form className="add-item" onSubmit={(e) => { e.preventDefault(); addItem(); }}>
                  <Field label="Type">
                    {(id) => (
                      <select id={id} className="input" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setItemError(null); }}>
                        {(Object.keys(KIND_META) as Kind[]).map((k) => (
                          <option key={k} value={k}>{KIND_META[k].label}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label={kind === 'url' ? 'Address' : kind === 'app' ? 'App name or path' : 'Path'} error={itemError} className="grow">
                    {(id, d) => <input id={id} aria-describedby={d} className="input" value={target} maxLength={500} placeholder={KIND_META[kind].placeholder} onChange={(e) => { setTarget(e.target.value); setItemError(null); }} spellCheck={false} />}
                  </Field>
                  <Field label="Label (optional)">
                    {(id) => <input id={id} className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />}
                  </Field>
                  <div className="row align-end">
                    {kind !== 'url' && (
                      <Button icon={FolderOpen} onClick={() => void browse()}>
                        Browse…
                      </Button>
                    )}
                    <Button type="submit" icon={Plus}>
                      Add item
                    </Button>
                  </div>
                </form>
                {kind === 'app' && <p className="field-hint">Apps are launched by name or path when you restore. Launching may also be limited by your approved apps list.</p>}
              </Panel>

              {draft.id && current && <ProjectMemory capsule={current} />}

              {draft.id && current && <BrowserRefsImport key={current.id} capsule={current} dirty={dirty} onSaved={(c) => setDraft(fromCapsule(c))} />}

              {draft.id && (
                <Panel title="Restore" eyebrow="Reopen everything">
                  <p className="field-hint">
                    Opens the {savedItems.length} saved item{savedItems.length === 1 ? '' : 's'} on this computer, one by one, and reports what opened and what failed. Unsaved edits are not used.
                  </p>
                  {current?.windows && current.windows.length > 0 && (
                    <p className="field-hint">This capsule has {current.windows.length} saved window position{current.windows.length === 1 ? '' : 's'}; whether they are re-applied is up to the backend.</p>
                  )}
                  <div className="row">
                    <Button variant="primary" icon={Play} disabled={dirty || savedItems.length === 0} title={dirty ? 'Save your changes first' : undefined} onClick={() => setConfirmRestore(true)}>
                      Restore capsule…
                    </Button>
                    {dirty && <span className="sub">Save changes first.</span>}
                  </div>
                  {outcome && outcome.id === draft.id && (
                    <div className="outcome" aria-live="polite">
                      <h3>Last restore</h3>
                      {outcome.opened.length === 0 && outcome.failed.length === 0 && <p className="field-hint">The backend reported no items.</p>}
                      {outcome.opened.length > 0 && (
                        <ul className="list compact">
                          {outcome.opened.map((o) => (
                            <li key={o} className="list-row ok-row">
                              <CheckCircle size={15} aria-hidden />
                              <span className="grow mono">{truncate(o, 90)}</span>
                              <Badge tone="ok">Opened</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                      {outcome.failed.length > 0 && (
                        <ul className="list compact">
                          {outcome.failed.map((f) => (
                            <li key={f.target} className="list-row fail-row">
                              <WarningCircle size={15} aria-hidden />
                              <span className="grow">
                                <span className="mono">{truncate(f.target, 90)}</span>
                                <span className="sub">{truncate(f.reason, 200)}</span>
                              </span>
                              <Badge tone="danger">Failed</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </Panel>
              )}
              {draft.id && current && <RestoreTools capsule={current} dirty={dirty} />}
              {!draft.id && <Notice>Save the capsule to enable restore.</Notice>}
            </div>
          )}
        </div>
      </div>

      <FileShelf />

      <ConfirmDialog
        open={pendingSelect !== undefined}
        title="Discard unsaved changes?"
        confirmLabel="Discard"
        danger
        onCancel={() => setPendingSelect(undefined)}
        onConfirm={() => {
          const t = pendingSelect;
          setPendingSelect(undefined);
          if (t !== undefined) open(t);
        }}
      >
        <p>This capsule has edits that were not saved.</p>
      </ConfirmDialog>

      <ProjectMapPanel selectedId={typeof selected === 'string' && selected !== 'new' ? selected : null} onSelect={requestOpen} />

      <ConfirmDialog open={confirmDelete} title={`Delete “${truncate(draft?.name ?? '', 40)}”?`} confirmLabel="Delete capsule" danger busy={saving} onCancel={() => setConfirmDelete(false)} onConfirm={() => void doDelete()}>
        <p>The capsule and its list of items are removed. The files, folders and apps themselves are not touched.</p>
      </ConfirmDialog>

      <ConfirmDialog open={confirmRestore} title="Restore this capsule?" confirmLabel="Open items" busy={restoring} onCancel={() => setConfirmRestore(false)} onConfirm={() => void doRestore()}>
        <p>These items will be opened on this computer:</p>
        <ul className="list compact">
          {savedItems.slice(0, 12).map((i) => (
            <li key={`${i.kind}:${i.target}`} className="list-row">
              <Badge>{KIND_META[i.kind].label}</Badge>
              <span className="grow mono">{truncate(i.target, 70)}</span>
            </li>
          ))}
          {savedItems.length > 12 && <li className="sub pad">…and {savedItems.length - 12} more</li>}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

// ---- Browser bookmarks / tabs import (scope 47): pasted text only ---------------------------------------------

export const BROWSER_IMPORT_NOTE = 'This build reads only text you paste. It does not read browser profiles or live tabs; no browser extension is included.';

export function BrowserRefsImport({ capsule, dirty, onSaved }: { capsule: Capsule; dirty: boolean; onSaved: (c: Capsule) => void }) {
  const { api, mutate } = useReady();
  const [text, setText] = useState('');
  const [result, setResult] = useState<BrowserRefsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [checked, setChecked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const split = useMemo(() => (result ? splitAgainstCapsule(result.items, capsule.items) : null), [result, capsule.items]);
  const present = useMemo(() => new Set((split?.alreadyPresent ?? []).map((i) => i.target)), [split]);
  const visible = useMemo(() => (result ? result.items.filter((i) => !folder || i.folder === folder || (i.folder ?? '').startsWith(`${folder}/`)) : []), [result, folder]);
  const selectedItems: BrowserRef[] = useMemo(() => (split ? split.fresh.filter((i) => checked.includes(i.target)) : []), [split, checked]);
  const room = Math.max(0, MAX_ITEMS - capsule.items.length);
  const overCapacity = selectedItems.length > room;

  const parse = () => {
    try {
      const r = parseBrowserRefs(text);
      setResult(r);
      setError(null);
      setFolder('');
      const s = splitAgainstCapsule(r.items, capsule.items);
      setChecked(s.fresh.map((i) => i.target));
    } catch (e) {
      setResult(null);
      setChecked([]);
      setError(e instanceof Error ? e.message : 'The text could not be parsed.');
    }
  };

  const add = async () => {
    if (!selectedItems.length || overCapacity || dirty) return;
    setSaving(true);
    let updated: Capsule | undefined;
    const ok = await mutate(async () => {
      const next = await api.saveCapsule({ id: capsule.id, items: [...capsule.items, ...toCapsuleItems(selectedItems)] });
      updated = next.capsules.find((c) => c.id === capsule.id);
      return next;
    }, `Added ${selectedItems.length} link(s) to ${capsule.name}.`);
    setSaving(false);
    if (ok) {
      if (updated) onSaved(updated);
      setResult(null);
      setChecked([]);
      setText('');
    }
  };

  const reasons = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of result?.skipped ?? []) m.set(s.reason, (m.get(s.reason) ?? 0) + 1);
    return [...m.entries()];
  }, [result]);

  return (
    <Panel title="Import browser bookmarks or tabs (paste, offline)" eyebrow="Adds links to this capsule">
      <p className="field-hint">{BROWSER_IMPORT_NOTE}</p>
      <Field label="Bookmarks or tab list" hint="Paste a bookmark HTML export, a JSON array of {title, url}, Markdown [title](url) links, or one 'title<TAB>url', 'url' or 'title - url' per line. Only http and https links are kept.">
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={5} value={text} spellCheck={false} onChange={(e) => { setText(e.target.value); setError(null); }} />}
      </Field>
      <div className="row">
        <Button icon={MagnifyingGlass} disabled={!text.trim()} onClick={parse}>Parse</Button>
        {result && <Button onClick={() => { setResult(null); setChecked([]); }}>Discard</Button>}
      </div>
      {error && <Notice tone="warn">{error}</Notice>}
      {result && split && (
        <div className="stack tight" aria-live="polite">
          <p className="field-hint">
            Detected format: <strong>{result.detected}</strong> · kept {result.items.length} · skipped {result.skipped.length} · already in this capsule {split.alreadyPresent.length}
            {result.truncated && ' · truncated: only the first 500 links were kept'}
          </p>
          {reasons.length > 0 && (
            <ul className="list compact" aria-label="Skipped reasons">
              {reasons.map(([reason, n]) => (
                <li key={reason} className="list-row"><span className="grow sub">{reason}</span><Badge tone="muted">{n}</Badge></li>
              ))}
            </ul>
          )}
          {result.folders.length > 0 && (
            <Field label="Folder">
              {(id) => (
                <select id={id} className="input" value={folder} onChange={(e) => setFolder(e.target.value)}>
                  <option value="">All folders</option>
                  {result.folders.map((f) => <option key={f} value={f}>{truncate(f, 80)}</option>)}
                </select>
              )}
            </Field>
          )}
          {visible.length > 0 && (
            <fieldset className="stack tight">
              <legend>Links</legend>
              <div className="row">
                <Button size="sm" onClick={() => setChecked([...new Set([...checked, ...visible.filter((i) => !present.has(i.target)).map((i) => i.target)])])}>Select shown</Button>
                <Button size="sm" onClick={() => setChecked(checked.filter((t) => !visible.some((i) => i.target === t)))}>Clear shown</Button>
              </div>
              <ul className="list compact" aria-label="Parsed links">
                {visible.map((i) => {
                  const dup = present.has(i.target);
                  return (
                    <li key={i.target} className="list-row">
                      <label className="row grow">
                        <input type="checkbox" disabled={dup} checked={!dup && checked.includes(i.target)} onChange={(e) => setChecked(e.target.checked ? [...checked, i.target] : checked.filter((t) => t !== i.target))} />
                        <span className="grow"><strong>{truncate(i.label, 80)}</strong><code className="sub block" title={i.target}>{truncate(i.target, 90)}</code>{i.folder && <span className="sub block">{truncate(i.folder, 80)}</span>}</span>
                      </label>
                      {dup && <Badge tone="muted">Already in capsule</Badge>}
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
          {overCapacity && <Notice tone="warn">A capsule holds at most {MAX_ITEMS} items; this one has room for {room} more. Untick some links.</Notice>}
          <div className="row">
            <Button variant="primary" icon={Plus} busy={saving} disabled={selectedItems.length === 0 || overCapacity || dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => void add()}>
              Add {selectedItems.length} links to {truncate(capsule.name, 40)}
            </Button>
            {dirty && <span className="sub">Save changes first.</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ---- Project map (goal 50): real capsules, checkpoints and tasks as lanes; static SVG, no animation ------------

const MAP_W = 720;
const MAP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function ProjectMapPanel({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const { state, productivity } = useReady();
  const checkpoints = productivity?.checkpoints ?? [];
  const laneCount = Math.min(state.capsules.length, 100);
  const height = Math.max(96, laneCount * 56 + 32);
  const built = useMemo((): { map: ProjectMap | null; error: string | null } => {
    try {
      return { map: buildProjectMap({ capsules: state.capsules, checkpoints, tasks: state.tasks }, { width: MAP_W, height, selectedCapsuleId: selectedId ?? undefined }), error: null };
    } catch (e) {
      return { map: null, error: e instanceof Error ? e.message : 'The project map could not be built.' };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.capsules, state.tasks, productivity, height, selectedId]);
  const map = built.map;
  const allNodes = useMemo(() => (map ? map.lanes.flatMap((l) => l.nodes) : []), [map]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const refs = useRef(new Map<string, SVGGElement>());
  const activeId = focusId && allNodes.some((n) => n.id === focusId) ? focusId : (allNodes[0]?.id ?? null);
  const pos = useMemo(() => new Map(allNodes.map((n) => [n.id, n])), [allNodes]);

  const activate = (n: MapNode) => {
    setFocusId(n.id);
    if (n.kind === 'capsule') onSelect(n.id.slice('capsule:'.length));
    else if (n.kind === 'checkpoint') {
      const cp = checkpoints.find((c) => `checkpoint:${c.id}` === n.id);
      setDetail(cp ? `${cp.title} · ${cp.createdAt} · ${n.refs} ref${n.refs === 1 ? '' : 's'}` : null);
    }
  };
  const onKey = (e: ReactKeyboardEvent<SVGGElement>, n: MapNode) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate(n);
      return;
    }
    if (!map || !MAP_KEYS.has(e.key)) return;
    e.preventDefault();
    const next = mapKeyboardTarget(map, n.id, e.key);
    if (next) {
      setFocusId(next);
      refs.current.get(next)?.focus();
    }
  };

  return (
    <Panel title="Project map" eyebrow="From saved capsules and checkpoints">
      {built.error ? (
        <Notice tone="warn">{built.error}</Notice>
      ) : !map || map.lanes.length === 0 ? (
        <p className="field-hint project-map-empty">No capsules yet, so there is nothing to map. Create a capsule and save checkpoints to see its history here.</p>
      ) : (
        <div className="project-map">
          <p className="field-hint">
            One lane per capsule. Checkpoints sit on a shared timeline{map.timeRange ? ` (${map.timeRange.since} → ${map.timeRange.until})` : ''}; undated checkpoints and linked tasks are in the right-hand column. Use the arrow keys, Home and End to move; Enter opens a capsule or shows checkpoint details.
          </p>
          <svg className="project-map-svg" role="group" aria-label="Project map" viewBox={`0 0 ${MAP_W} ${height}`} width="100%" preserveAspectRatio="xMinYMin meet">
            {map.lanes.map((l) => (
              <g key={l.capsuleId} className="project-map-lane" aria-hidden="true">
                <line x1={0} x2={MAP_W} y1={l.y} y2={l.y} stroke="currentColor" strokeOpacity={0.15} />
              </g>
            ))}
            {map.edges.map((e) => {
              const a = pos.get(e.from), b = pos.get(e.to);
              return a && b ? <line key={`${e.kind}:${e.from}:${e.to}`} aria-hidden="true" className={cx('project-map-edge', `project-map-edge-${e.kind}`)} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="currentColor" strokeOpacity={e.kind === 'timeline' ? 0.55 : 0.35} strokeDasharray={e.kind === 'reference' ? '4 3' : undefined} /> : null;
            })}
            {allNodes.map((n) => (
              <g
                key={n.id}
                ref={(el) => { if (el) refs.current.set(n.id, el); else refs.current.delete(n.id); }}
                className={cx('project-map-node', `project-map-node-${n.kind}`, n.kind === 'capsule' && `capsule:${selectedId}` === n.id && 'project-map-node-selected')}
                tabIndex={n.id === activeId ? 0 : -1}
                role="button"
                aria-label={`${n.kind}: ${n.label}${n.at ? `, ${n.at}` : n.kind === 'checkpoint' ? ', undated' : ''}`}
                onFocus={() => setFocusId(n.id)}
                onClick={() => activate(n)}
                onKeyDown={(e) => onKey(e, n)}
                fill="currentColor"
              >
                {n.kind === 'capsule' ? <rect x={n.x - 8} y={n.y - 8} width={16} height={16} rx={3} /> : n.kind === 'checkpoint' ? <circle cx={n.x} cy={n.y} r={6} /> : <rect x={n.x - 5} y={n.y - 5} width={10} height={10} />}
                {n.kind === 'capsule' && <text x={n.x + 14} y={n.y - 12}>{truncate(n.label, 24)}</text>}
                <title>{n.label}</title>
              </g>
            ))}
          </svg>
          {detail && <p className="project-map-detail" aria-live="polite">{detail}</p>}
          {(map.truncated.capsules > 0 || map.truncated.nodes > 0) && (
            <p className="field-hint project-map-truncated">Not shown: {map.truncated.capsules} capsule(s) and {map.truncated.nodes} node(s) over the map limits.</p>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- Project memory: goals, references, checkpoints, resume recap -----------------------------------------------

/** Adapter scopes that are not implemented. Shown so the limits are visible instead of implied. */
export const CAPSULE_ADAPTER_STATUS = [
  { id: 'browser', scope: 47, name: 'Browser profile and tab adapters', state: 'Partial', note: 'Saved web addresses open in your default browser. Open tabs and browser profiles are not read or restored.' },
  { id: 'deep-state', scope: 49, name: 'Deep app-state restoration', state: 'Not available', note: 'Only items and window positions are restored. Documents, cursor position and in-app state are not captured; no adapter exists and this experiment has no written gate yet.' },
  { id: 'spatial-map', scope: 50, name: 'Spatial project map with historical branches', state: 'Not available', note: 'Experimental and ungated; nothing is drawn or recorded for it.' },
] as const;

function Unavailable() {
  return <Notice tone="warn" title="Local productivity storage is not connected">Goals, references, checkpoints and the recap need the sidecar store, which this build has not connected. Nothing is saved for them.</Notice>;
}

export function ProjectMemory({ capsule }: { capsule: Capsule }) {
  const { state, api, productivity, productivityApi, applyProductivity, toast } = useReady();
  const meta = productivity?.capsuleMeta[capsule.id];
  const goals = meta?.goals ?? [];
  const refs = meta?.references ?? [];
  const checkpoints = useMemo(() => (productivity?.checkpoints ?? []).filter((c) => c.capsuleId === capsule.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [productivity, capsule.id]);
  const recap = useMemo(() => buildResumeRecap(state, productivity ?? undefined, capsule.id), [state, productivity, capsule.id]);
  const [goalText, setGoalText] = useState('');
  const [refKind, setRefKind] = useState<ReferenceKind>('url');
  const [refTarget, setRefTarget] = useState('');
  const [refLabel, setRefLabel] = useState('');
  const [cpTitle, setCpTitle] = useState('');
  const [cpNote, setCpNote] = useState('');
  const [editCp, setEditCp] = useState<{ id: string; title: string; note: string } | null>(null);

  type GoalIn = { id?: string; text: string; done?: boolean };
  type RefIn = { id?: string; kind: ReferenceKind; target: string; label?: string; note?: string };
  const saveMeta = (g: GoalIn[], r: RefIn[], ok?: string) =>
    applyProductivity({ op: 'capsule.setMeta', capsuleId: capsule.id, goals: g.map(({ id, text, done }) => ({ id, text, done })), references: r.map(({ id, kind, target, label, note }) => ({ id, kind, target, label, ...(note ? { note } : {}) })) }, ok);

  const addGoal = async () => {
    const t = goalText.trim();
    if (!t) return;
    if (await saveMeta([...goals, { text: t, done: false }], refs)) setGoalText('');
  };
  const addRef = async () => {
    const t = refTarget.trim();
    if (!t) return;
    if (await saveMeta(goals, [...refs, { kind: refKind, target: t, label: refLabel.trim() }])) {
      setRefTarget('');
      setRefLabel('');
    }
  };
  const browse = async () => {
    try {
      const p = await api.pickPath(refKind === 'folder' ? 'folder' : 'file');
      if (p) setRefTarget(p);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'The picker failed.');
    }
  };
  const addCheckpoint = async () => {
    const t = cpTitle.trim();
    if (!t) return;
    if (await applyProductivity({ op: 'checkpoint.add', title: t, note: cpNote.trim(), capsuleId: capsule.id, refs: [{ kind: 'capsule', id: capsule.id }] }, 'Checkpoint saved.')) {
      setCpTitle('');
      setCpNote('');
    }
  };
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draftWorklog(recap, { withSources: false }));
      toast('ok', 'Worklog draft copied. Review it before sharing.');
    } catch {
      toast('error', 'Copying was blocked. Select the recap text and copy it manually.');
    }
  };
  const refName = (r: (typeof refs)[number]) => {
    if (r.kind === 'note') return state.notes.find((n) => n.id === r.target)?.title ?? '(deleted note)';
    if (r.kind === 'task') return state.tasks.find((t) => t.id === r.target)?.title ?? '(deleted task)';
    return r.label || r.target;
  };

  return (
    <>
      <Panel title="Resume recap" eyebrow="From saved records" actions={<Button size="sm" icon={Copy} onClick={() => void copyDraft()}>Copy worklog draft</Button>}>
        {recap.empty ? (
          <p className="field-hint">Nothing recorded for this capsule yet. Add goals, a checkpoint or references, or focus on a task, and they will be listed here with their sources.</p>
        ) : (
          <ul className="list compact" aria-label="Resume recap">
            {recap.lines.map((l, i) => (
              <li key={`${l.source.kind}:${l.source.id}:${i}`} className="list-row">
                <span className="grow">{l.text}</span>
                <Badge title={`Source: ${l.source.kind} ${l.source.id}`}>{l.source.kind}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="field-hint">Every line comes from something you saved here; no model writes it. The worklog copy is labelled as a draft.</p>
      </Panel>

      {!productivityApi || !productivity ? (
        <Unavailable />
      ) : (
        <>
          <Panel title="Goals" eyebrow={`${goals.filter((g) => !g.done).length} open`}>
            {goals.length === 0 ? <p className="field-hint">No goals yet. Write what this project should achieve next.</p> : (
              <ul className="list compact">
                {goals.map((g) => (
                  <li key={g.id} className="list-row">
                    <input type="checkbox" id={`goal-${g.id}`} checked={g.done} onChange={() => void saveMeta(goals.map((x) => (x.id === g.id ? { ...x, done: !x.done } : x)), refs)} />
                    <label htmlFor={`goal-${g.id}`} className={cx('grow', g.done && 'sub')}>{g.text}</label>
                    <IconButton icon={Trash} label={`Remove goal ${truncate(g.text, 30)}`} onClick={() => void saveMeta(goals.filter((x) => x.id !== g.id), refs)} />
                  </li>
                ))}
              </ul>
            )}
            <form className="add-item" onSubmit={(e) => { e.preventDefault(); void addGoal(); }}>
              <Field label="New goal" className="grow">{(id) => <input id={id} className="input" value={goalText} maxLength={200} onChange={(e) => setGoalText(e.target.value)} />}</Field>
              <div className="row align-end"><Button type="submit" icon={Plus} disabled={!goalText.trim()}>Add goal</Button></div>
            </form>
          </Panel>

          <Panel title="References" eyebrow="Not opened by restore">
            <p className="field-hint">References are pointers kept with the project: files, folders and links are never read or opened from here, and notes and tasks link to your saved ones.</p>
            {refs.length > 0 && (
              <ul className="list compact">
                {refs.map((r) => (
                  <li key={r.id} className="list-row">
                    <Badge>{r.kind}</Badge>
                    <span className="grow"><strong>{truncate(refName(r), 70)}</strong>{r.kind !== 'note' && r.kind !== 'task' && <code className="sub" title={r.target}> {truncate(r.target, 70)}</code>}</span>
                    <IconButton icon={Trash} label={`Remove reference ${truncate(refName(r), 30)}`} onClick={() => void saveMeta(goals, refs.filter((x) => x.id !== r.id))} />
                  </li>
                ))}
              </ul>
            )}
            <form className="add-item" onSubmit={(e) => { e.preventDefault(); void addRef(); }}>
              <Field label="Type">
                {(id) => (
                  <select id={id} className="input" value={refKind} onChange={(e) => { setRefKind(e.target.value as ReferenceKind); setRefTarget(''); }}>
                    <option value="url">Link</option><option value="file">File</option><option value="folder">Folder</option><option value="note">Note</option><option value="task">Task</option>
                  </select>
                )}
              </Field>
              <Field label={refKind === 'note' ? 'Note' : refKind === 'task' ? 'Task' : refKind === 'url' ? 'Address' : 'Path'} className="grow">
                {(id) =>
                  refKind === 'note' || refKind === 'task' ? (
                    <select id={id} className="input" value={refTarget} onChange={(e) => setRefTarget(e.target.value)}>
                      <option value="">Choose…</option>
                      {(refKind === 'note' ? state.notes.map((n) => ({ id: n.id, t: n.title })) : state.tasks.map((t) => ({ id: t.id, t: t.title }))).map((o) => <option key={o.id} value={o.id}>{truncate(o.t, 60)}</option>)}
                    </select>
                  ) : (
                    <input id={id} className="input" value={refTarget} maxLength={520} spellCheck={false} onChange={(e) => setRefTarget(e.target.value)} />
                  )
                }
              </Field>
              <Field label="Label (optional)">{(id) => <input id={id} className="input" value={refLabel} maxLength={120} onChange={(e) => setRefLabel(e.target.value)} />}</Field>
              <div className="row align-end">
                {(refKind === 'file' || refKind === 'folder') && <Button icon={FolderOpen} onClick={() => void browse()}>Browse…</Button>}
                <Button type="submit" icon={Plus} disabled={!refTarget.trim()}>Add reference</Button>
              </div>
            </form>
          </Panel>

          <Panel title="Checkpoints" eyebrow={`${checkpoints.length} saved`}>
            <form className="add-item" onSubmit={(e) => { e.preventDefault(); void addCheckpoint(); }}>
              <Field label="Checkpoint title" className="grow">{(id) => <input id={id} className="input" value={cpTitle} maxLength={120} placeholder="Where things stand" onChange={(e) => setCpTitle(e.target.value)} />}</Field>
              <Field label="Note (optional)" className="grow">{(id) => <textarea id={id} className="input" rows={2} maxLength={4000} value={cpNote} onChange={(e) => setCpNote(e.target.value)} />}</Field>
              <div className="row align-end"><Button type="submit" variant="primary" icon={BookmarkSimple} disabled={!cpTitle.trim()}>Save checkpoint</Button></div>
            </form>
            {checkpoints.length === 0 ? <p className="field-hint">A checkpoint is a note to your future self about this project, saved only when you press the button.</p> : (
              <ul className="list compact">
                {checkpoints.map((c) => (
                  <li key={c.id} className="list-row">
                    {editCp?.id === c.id ? (
                      <div className="grow stack tight">
                        <input className="input" aria-label="Checkpoint title" value={editCp.title} maxLength={120} onChange={(e) => setEditCp({ ...editCp, title: e.target.value })} />
                        <textarea className="input" aria-label="Checkpoint note" rows={2} maxLength={4000} value={editCp.note} onChange={(e) => setEditCp({ ...editCp, note: e.target.value })} />
                        <div className="row">
                          <Button size="sm" variant="primary" onClick={async () => { if (editCp.title.trim() && (await applyProductivity({ op: 'checkpoint.update', id: c.id, title: editCp.title.trim(), note: editCp.note.trim() }, 'Checkpoint updated.'))) setEditCp(null); }}>Save</Button>
                          <Button size="sm" onClick={() => setEditCp(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <span className="grow"><strong>{c.title}</strong><span className="sub"> {fmtDateTime(c.createdAt)}</span>{c.note && <span className="sub block">{truncate(c.note, 200)}</span>}</span>
                        <IconButton icon={PencilSimple} label={`Edit checkpoint ${truncate(c.title, 30)}`} onClick={() => setEditCp({ id: c.id, title: c.title, note: c.note })} />
                        <IconButton icon={Trash} label={`Delete checkpoint ${truncate(c.title, 30)}`} onClick={() => void applyProductivity({ op: 'checkpoint.delete', id: c.id }, 'Checkpoint deleted.')} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

// ---- Restore preview, window geometry, portable packs ---------------------------------------------------------

type PackState = { raw: string; parsed: PackImport; mappings: PathMapping[] };

export function RestoreTools({ capsule, dirty }: { capsule: Capsule; dirty: boolean }) {
  const { api, productivityApi, applyProductivity, refreshProductivity, mutate, toast } = useReady();
  const cap = productivityApi?.capsule;
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wins, setWins] = useState<{ hwnd: number; title: string; process: string }[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [rootPath, setRootPath] = useState('');
  const [pack, setPack] = useState<PackState | null>(null);

  const guard = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try { await fn(); } catch (e) { toast('error', e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(null); }
  };
  const pickFolder = async (): Promise<string | null> => {
    try { return await api.pickPath('folder'); } catch (e) { toast('error', e instanceof Error ? e.message : 'The picker failed.'); return null; }
  };

  const doPreview = () => guard('preview', async () => { setPreview(await (cap as NonNullable<typeof cap>).previewRestore(capsule.id)); });
  const listWins = () => guard('list', async () => { setWins(await (cap?.listWindows as NonNullable<typeof cap>['listWindows'] as () => Promise<{ hwnd: number; title: string; process: string }[]>)()); setPicked([]); });
  const capture = () => guard('capture', async () => {
    const r = await (cap?.captureGeometry as NonNullable<NonNullable<typeof cap>['captureGeometry']>)(capsule.id, picked);
    toast(r.skipped.length ? 'info' : 'ok', `Saved ${r.saved} window position(s)${r.skipped.length ? `; skipped ${r.skipped.length}: ${truncate(r.skipped.map((s) => `${s.process || 'window'} (${s.reason})`).join('; '), 160)}` : ''}.`);
    setWins(null);
    await mutate(() => api.getState());
    await refreshProductivity();
  });
  const doExport = () => guard('export', async () => {
    const r = await (cap?.exportPack as NonNullable<NonNullable<typeof cap>['exportPack']>)(capsule.id, rootPath ? [{ name: 'project', path: rootPath }] : []);
    toast(r.saved ? 'ok' : 'info', r.saved ? `Pack saved.${r.unmapped.length ? ` ${r.unmapped.length} path(s) outside the project folder keep their full path, which may include your user name.` : ''}` : 'Export cancelled.');
  });
  const readPack = () => guard('import', async () => {
    const raw = await (cap?.readPack as NonNullable<NonNullable<typeof cap>['readPack']>)();
    if (!raw) return;
    setPack({ raw, mappings: [], parsed: await (cap?.parsePack as NonNullable<NonNullable<typeof cap>['parsePack']>)(raw, []) });
  });
  const remap = (mappings: PathMapping[]) => guard('import', async () => {
    if (!pack) return;
    setPack({ raw: pack.raw, mappings, parsed: await (cap?.parsePack as NonNullable<NonNullable<typeof cap>['parsePack']>)(pack.raw, mappings.filter((m) => m.from.trim() && m.to.trim())) });
  });
  const saveImported = () => guard('save', async () => {
    if (!pack) return;
    let saved = 0;
    for (const c of pack.parsed.capsules) {
      const before = new Set((await api.getState()).capsules.map((x) => x.id));
      const next = await api.saveCapsule({ name: c.name, description: c.description, scene: c.scene, items: c.items, ...(c.windows ? { windows: c.windows } : {}) });
      const created = next.capsules.find((x) => !before.has(x.id));
      if (created && (c.goals.length || c.references.length)) {
        await applyProductivity({ op: 'capsule.setMeta', capsuleId: created.id, goals: c.goals.map((text) => ({ text })), references: c.references });
      }
      saved++;
    }
    setPack(null);
    await mutate(() => api.getState(), `Imported ${saved} capsule(s). Review each item before restoring.`);
    await refreshProductivity();
  });

  return (
    <>
      <Panel title="Preview and window positions" eyebrow="Reads only">
        {!cap ? (
          <p className="field-hint">Restore preview and window capture are not connected in this build. Restore still shows every item for confirmation before anything opens.</p>
        ) : (
          <div className="stack tight">
            <div className="row">
              <Button icon={Eye} busy={busy === 'preview'} disabled={dirty} title={dirty ? 'Save your changes first' : undefined} onClick={() => void doPreview()}>Preview restore</Button>
              {cap.listWindows && cap.captureGeometry && <Button icon={AppWindow} busy={busy === 'list'} onClick={() => void listWins()}>Choose windows to save…</Button>}
            </div>
            {preview && preview.capsule === capsule.name && (
              <div aria-live="polite">
                <ul className="list compact" aria-label="Items that restore would open">
                  {preview.items.map((i) => (
                    <li key={`${i.kind}:${i.target}`} className={cx('list-row', i.ok ? 'ok-row' : 'fail-row')}>
                      {i.ok ? <CheckCircle size={15} aria-hidden /> : <WarningCircle size={15} aria-hidden />}
                      <span className="grow"><span className="mono">{truncate(i.target, 80)}</span><span className="sub block">{truncate(i.detail, 200)}</span></span>
                      <Badge tone={i.ok ? 'ok' : 'danger'}>{i.ok ? 'Allowed' : 'Blocked'}</Badge>
                    </li>
                  ))}
                </ul>
                {preview.windowsError && <Notice tone="warn">Windows could not be listed: {preview.windowsError}</Notice>}
                {preview.windows.length > 0 && (
                  <ul className="list compact" aria-label="Window positions that restore would apply">
                    {preview.windows.map((w, i) => (
                      <li key={i} className="list-row">
                        <span className="grow">{w.saved.process} {w.saved.title && `“${truncate(w.saved.title, 40)}”`} → {w.saved.x},{w.saved.y} {w.saved.width}×{w.saved.height}{w.offscreen && ' (outside every known display)'}<span className="sub block">{w.reason ?? `Would move "${truncate(w.window?.title ?? '', 40)}"`}</span></span>
                        <Badge tone={w.status === 'match' ? 'ok' : w.status === 'blocked' ? 'danger' : 'muted'}>{w.status === 'match' ? 'Match' : w.status === 'blocked' ? 'Blocked' : 'Not open'}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="field-hint">This is a dry run: nothing was opened or moved. Restoring still needs your confirmation.</p>
              </div>
            )}
            {wins && (
              <fieldset className="stack tight">
                <legend>Windows open now</legend>
                {wins.length === 0 && <p className="field-hint">No restorable windows were found.</p>}
                {wins.slice(0, 60).map((w) => (
                  <label key={w.hwnd} className="row">
                    <input type="checkbox" checked={picked.includes(w.hwnd)} onChange={(e) => setPicked(e.target.checked ? [...picked, w.hwnd] : picked.filter((h) => h !== w.hwnd))} />
                    <span>{w.process} — {truncate(w.title || '(untitled)', 60)}</span>
                  </label>
                ))}
                <div className="row">
                  <Button variant="primary" icon={FloppyDisk} busy={busy === 'capture'} disabled={picked.length === 0} onClick={() => void capture()}>Save positions of {picked.length} window(s)</Button>
                  <Button onClick={() => setWins(null)}>Cancel</Button>
                </div>
                <p className="field-hint">Only the window titles, programs and rectangles of the windows you tick are saved. Minimized, maximized and protected windows are skipped.</p>
              </fieldset>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Share as a pack" eyebrow="Portable export">
        {!cap?.exportPack || !cap.readPack || !cap.parsePack ? (
          <p className="field-hint">Pack export and import are not connected in this build.</p>
        ) : (
          <div className="stack tight">
            <Field label="Project folder to make portable (optional)" hint="Paths inside this folder are exported relative to it so they can be re-mapped on another PC. Paths outside it keep their full path.">
              {(id) => (
                <span className="row">
                  <input id={id} className="input" value={rootPath} spellCheck={false} onChange={(e) => setRootPath(e.target.value)} />
                  <Button icon={FolderOpen} onClick={async () => { const p = await pickFolder(); if (p) setRootPath(p); }}>Browse…</Button>
                </span>
              )}
            </Field>
            <div className="row">
              <Button icon={Export} busy={busy === 'export'} disabled={dirty} onClick={() => void doExport()}>Export pack…</Button>
              <Button icon={DownloadSimple} busy={busy === 'import'} onClick={() => void readPack()}>Import pack…</Button>
            </div>
            {pack && (
              <div className="stack tight" aria-live="polite">
                <h3>Import preview</h3>
                <ul className="list compact">
                  {pack.parsed.capsules.map((c, i) => <li key={i} className="list-row"><strong className="grow">{c.name}</strong><span className="sub">{c.items.length} item(s), {c.goals.length} goal(s), {c.windows?.length ?? 0} window(s)</span></li>)}
                </ul>
                {pack.parsed.roots.length > 0 && (
                  <>
                    <p className="field-hint">This pack uses project folders that must be chosen on this PC.</p>
                    {pack.parsed.roots.map((name) => {
                      const from = `{ROOT:${name}}`;
                      const cur = pack.mappings.find((m) => m.from === from)?.to ?? '';
                      return (
                        <Field key={name} label={`Folder for “${name}”`}>
                          {(id) => (
                            <span className="row">
                              <input id={id} className="input" value={cur} spellCheck={false} onChange={(e) => void remap([...pack.mappings.filter((m) => m.from !== from), { from, to: e.target.value }])} />
                              <Button icon={FolderOpen} onClick={async () => { const p = await pickFolder(); if (p) void remap([...pack.mappings.filter((m) => m.from !== from), { from, to: p }]); }}>Browse…</Button>
                            </span>
                          )}
                        </Field>
                      );
                    })}
                  </>
                )}
                <Field label="Re-map an old folder (optional)" hint="Replace the start of full paths from the pack, for example C:\Users\old\Projects → D:\Work.">
                  {(id) => (
                    <span className="row">
                      <input id={id} className="input" placeholder="Old folder" spellCheck={false} onBlur={(e) => { const v = e.target.value.trim(); if (v) void remap([...pack.mappings.filter((m) => m.from !== v), { from: v, to: pack.mappings.find((m) => m.from === v)?.to ?? '' }]); }} />
                    </span>
                  )}
                </Field>
                {pack.mappings.filter((m) => !m.from.startsWith('{ROOT:')).map((m) => (
                  <Field key={m.from} label={`New folder for ${truncate(m.from, 40)}`}>
                    {(id) => (
                      <span className="row">
                        <input id={id} className="input" value={m.to} spellCheck={false} onChange={(e) => void remap(pack.mappings.map((x) => (x.from === m.from ? { ...x, to: e.target.value } : x)))} />
                        <Button icon={FolderOpen} onClick={async () => { const p = await pickFolder(); if (p) void remap(pack.mappings.map((x) => (x.from === m.from ? { ...x, to: p } : x))); }}>Browse…</Button>
                      </span>
                    )}
                  </Field>
                ))}
                {pack.parsed.skipped.length > 0 && (
                  <Notice tone="warn" title={`${pack.parsed.skipped.length} item(s) will not be imported`}>
                    <ul className="list compact">{pack.parsed.skipped.slice(0, 8).map((s, i) => <li key={i} className="list-row"><span className="grow mono">{truncate(s.target, 60)}</span><span className="sub">{truncate(s.reason, 120)}</span></li>)}</ul>
                  </Notice>
                )}
                {pack.parsed.notes.map((n) => <p key={n} className="field-hint">{n}</p>)}
                <div className="row">
                  <Button variant="primary" icon={UploadSimple} busy={busy === 'save'} disabled={pack.parsed.capsules.length === 0} onClick={() => void saveImported()}>Add {pack.parsed.capsules.length} capsule(s)</Button>
                  <Button onClick={() => setPack(null)}>Discard</Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Adapters" eyebrow="What is and is not supported">
        <ul className="list compact">
          {CAPSULE_ADAPTER_STATUS.map((a) => (
            <li key={a.id} className="list-row">
              <span className="grow"><strong>{a.name}</strong> <span className="sub">(scope {a.scope})</span><span className="sub block">{a.note}</span></span>
              <Badge tone={a.state === 'Partial' ? 'warn' : 'muted'}>{a.state}</Badge>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
