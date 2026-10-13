import { useMemo, useState } from 'react';
import { AppWindow, ArrowDown, ArrowUp, CheckCircle, Cube, File as FileIcon, FloppyDisk, FolderOpen, Link as LinkIcon, MagnifyingGlass, Play, Plus, Trash, WarningCircle } from '@phosphor-icons/react';
import type { Capsule } from '../shared/contracts';
import { SceneBackdrop } from './SceneBackdrop';
import { ConfirmDialog } from '../ui/Dialog';
import { Badge, Button, Empty, Field, IconButton, Notice, PageHeader, Panel } from '../ui/primitives';
import { useReady } from '../ui/store';
import { SCENES, isKnownScene, sceneName } from '../ui/scenes';
import { cx, parseHttpUrl, relTime, truncate } from '../ui/util';

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

export function Capsules() {
  const { state, api, mutate, run, toast, isPreview } = useReady();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | 'new' | null>(state.capsules[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(() => (state.capsules[0] ? fromCapsule(state.capsules[0]) : null));
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
              {!draft.id && <Notice>Save the capsule to enable restore.</Notice>}
            </div>
          )}
        </div>
      </div>

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
