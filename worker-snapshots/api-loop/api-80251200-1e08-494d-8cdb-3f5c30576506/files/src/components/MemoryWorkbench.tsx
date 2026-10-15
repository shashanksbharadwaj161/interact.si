import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowsClockwise, Copy, Flag, FolderOpen, Link, PushPin, Trash, Warning } from '@phosphor-icons/react';
import type { Capsule } from '../shared/contracts';
import type { Checkpoint, EvidenceRef } from '../../electron/services/store';
import { PRODUCTIVITY_LIMITS, exportPortable, parsePortable, type PortableImport } from '../../electron/services/portable';
import { buildDailyRecap, draftWorklogVerified, filterRecap, resolveEvidence, type EvidenceKind, type ResolvedEvidence } from '../../electron/services/search';
import { Badge, Button, Empty, Field, LoadingBlock, Notice, PageHeader, Panel, Segmented } from '../ui/primitives';
import { useStore } from '../ui/store';
import { ProjectMemory } from './Capsules';
import { MemoryControls } from './MemorySearch';
import { listSourceCandidates } from '../ui/prompt-tools';
import { buildWorklogDraft, type WorklogDraft, type WorklogFormat } from '../ui/worklog-draft';
import { ADAPTER_LIMITS, buildCheckpointDrafts, groupSessionsDetailed, parseGitLog, toCheckpointOp, type GroupedSessions, type ParsedGitLog } from '../ui/coding-session-adapter';
import {
  EMPTY_CHECKPOINT_FILTER, MEMORY_SHORTCUTS, UNAVAILABLE_SOURCES, checkpointEvidence, filterCheckpoints, fmtDuration, fmtWhen, groupTimeline, isFiltered, localDayKey, matchShortcut, useReducedMotion, workbenchStatus,
  type CheckpointFilter,
} from '../ui/workbench';

type Section = 'overview' | 'projects' | 'checkpoints' | 'shelf' | 'timeline' | 'recap' | 'privacy' | 'portability';
const SECTIONS: { value: Section; label: string }[] = [
  { value: 'overview', label: 'Overview' }, { value: 'projects', label: 'Projects' }, { value: 'checkpoints', label: 'Checkpoints' }, { value: 'shelf', label: 'Shelf' },
  { value: 'timeline', label: 'Timeline' }, { value: 'recap', label: 'Recap' }, { value: 'privacy', label: 'Privacy' }, { value: 'portability', label: 'Portability' },
];
const KINDS: { kind: EvidenceKind; label: string }[] = [
  { kind: 'focus', label: 'Focus' }, { kind: 'checkpoint', label: 'Checkpoints' }, { kind: 'note', label: 'Notes' }, { kind: 'task', label: 'Tasks' }, { kind: 'activity', label: 'Capsule activity' }, { kind: 'session', label: 'Timeline' },
];

/**
 * Memory workbench: one place for project goals, checkpoints, the file shelf, the opt-in timeline, evidence-backed recaps,
 * retention/forgetting and bounded portability. Reads and writes only through the existing productivity sidecar API.
 */
export function MemoryWorkbench({ initialSection = 'overview' }: { initialSection?: Section } = {}) {
  const ctx = useStore();
  const { status, loadError, reload, productivityApi, productivity, productivityError, refreshProductivity, settings } = ctx;
  const [section, setSection] = useState<Section>(initialSection);
  const [retrying, setRetrying] = useState(false);
  const reduced = useReducedMotion(settings?.reduceMotion ?? false);
  const pageRef = useRef<HTMLDivElement>(null);
  const screen = workbenchStatus({ status, loadError, productivityApi, productivity, productivityError });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const hit = matchShortcut(MEMORY_SHORTCUTS, e);
    if (!hit) return;
    const i = SECTIONS.findIndex((s) => s.value === section);
    if (hit === 'section-next') { e.preventDefault(); setSection(SECTIONS[(i + 1) % SECTIONS.length].value); }
    else if (hit === 'section-prev') { e.preventDefault(); setSection(SECTIONS[(i - 1 + SECTIONS.length) % SECTIONS.length].value); }
    else if (hit === 'new-checkpoint') { e.preventDefault(); setSection('checkpoints'); queueMicrotask(() => pageRef.current?.querySelector<HTMLInputElement>('[data-cp-title]')?.focus()); }
    else if (hit === 'focus-filter') { e.preventDefault(); setSection('checkpoints'); queueMicrotask(() => pageRef.current?.querySelector<HTMLInputElement>('[data-cp-filter]')?.focus()); }
  };
  const retry = async () => { setRetrying(true); try { await refreshProductivity(); } finally { setRetrying(false); } };

  return (
    <div className="page page-wide" ref={pageRef} onKeyDown={onKeyDown} data-motion={reduced ? 'reduced' : 'full'}>
      <PageHeader eyebrow="Workspace" title="Memory" subtitle="Project goals, checkpoints, shelf, recaps and what this app keeps about your work. Stored on this computer only." />
      {screen.kind === 'loading' && <LoadingBlock label="Loading your workspace…" />}
      {screen.kind === 'app-error' && (
        <Notice tone="danger" title="The app data could not be loaded" action={<Button icon={ArrowsClockwise} onClick={() => void reload()}>Try again</Button>}>{screen.message}</Notice>
      )}
      {screen.kind === 'disconnected' && (
        <div className="stack">
          <Notice tone="warn" title="Local memory storage is not connected">{screen.message}</Notice>
          <MemoryControls />
        </div>
      )}
      {screen.kind === 'memory-error' && (
        <Notice tone="danger" title="The memory file could not be read" action={<Button icon={ArrowsClockwise} busy={retrying} onClick={() => void retry()}>Reload memory</Button>}>
          {screen.message} Notes, tasks and capsules are unaffected. If the file was damaged, the app keeps a copy beside it and offers the last good version on reload.
        </Notice>
      )}
      {screen.kind === 'ready' && ctx.state && productivity && (
        <>
          <Segmented<Section> label="Memory section" value={section} onChange={setSection} options={SECTIONS} />
          {section === 'overview' && <Overview go={setSection} />}
          {section === 'projects' && <Projects />}
          {section === 'checkpoints' && <><Checkpoints /><CodingSessionImport /></>}
          {section === 'shelf' && <Shelf />}
          {section === 'timeline' && <Timeline />}
          {section === 'recap' && <><RecapSection /><StandupDraft /></>}
          {section === 'privacy' && <MemoryControls />}
          {section === 'portability' && <Portability />}
        </>
      )}
    </div>
  );
}

function Overview({ go }: { go: (s: Section) => void }) {
  const { state, productivity } = useStore();
  if (!state || !productivity) return null;
  const today = localDayKey(new Date());
  const recap = buildDailyRecap(state, productivity, today);
  const stale = productivity.checkpoints.reduce((n, c) => n + c.refs.filter((r) => resolveEvidence(r, state, productivity).status !== 'ok').length, 0);
  return (
    <div className="stack">
      <div className="grid2">
        <Panel title="What is here" eyebrow="Counts">
          <ul className="list compact">
            <li className="list-row"><span className="grow">Capsules with goals or references</span><Badge>{Object.keys(productivity.capsuleMeta).length}</Badge></li>
            <li className="list-row"><span className="grow">Checkpoints</span><Badge>{productivity.checkpoints.length}</Badge></li>
            <li className="list-row"><span className="grow">Shelf items</span><Badge>{productivity.shelf.length}</Badge></li>
            <li className="list-row"><span className="grow">Focus sessions</span><Badge>{productivity.focus.length}</Badge></li>
            <li className="list-row"><span className="grow">Application timeline</span><Badge tone={productivity.policy.timelineEnabled ? 'ok' : 'muted'}>{productivity.policy.timelineEnabled ? `on · ${productivity.timeline.length} entries` : 'off'}</Badge></li>
          </ul>
          {stale > 0 && <p className="sub"><Warning aria-hidden size={14} /> {stale} checkpoint reference(s) point at deleted records. <Button size="sm" onClick={() => go('checkpoints')}>Review</Button></p>}
        </Panel>
        <Panel title="Today so far" eyebrow={today}>
          {recap.empty ? <p className="sub">Nothing recorded today yet. Checkpoints, saved notes, new tasks and focus sessions show up here.</p> : (
            <ul className="list compact">{recap.lines.slice(0, 6).map((l, i) => <li key={i} className="list-row"><span className="grow">{l.text}</span></li>)}</ul>
          )}
          <Button size="sm" onClick={() => go('recap')}>Open recap</Button>
        </Panel>
      </div>
      <Panel title="Keyboard" eyebrow="On this screen">
        <ul className="list compact">{MEMORY_SHORTCUTS.map((s) => <li key={s.id} className="list-row"><span className="grow">{s.label}</span><kbd className="mono">{s.chord}</kbd></li>)}</ul>
      </Panel>
      <Notice tone="info" title="Not read by this workspace">
        <ul className="list compact">{UNAVAILABLE_SOURCES.map((u) => <li key={u.id} className="list-row"><span className="grow"><strong>{u.label}</strong> · {u.reason}</span></li>)}</ul>
      </Notice>
    </div>
  );
}

function EvidenceChips({ items, onDrop }: { items: ResolvedEvidence[]; onDrop?: (ref: EvidenceRef) => void }) {
  if (!items.length) return null;
  return (
    <ul className="chips" aria-label="Evidence">
      {items.map((r) => (
        <li key={`${r.kind}:${r.id}`} className="chip">
          <Badge tone={r.status === 'ok' ? 'info' : 'warn'} title={`${r.kind}:${r.id}`}>{r.kind}</Badge> {r.title}
          {r.status !== 'ok' && onDrop && <button type="button" className="chip-x" aria-label={`Drop missing ${r.kind} reference`} onClick={() => onDrop({ kind: r.kind, id: r.id })}>×</button>}
        </li>
      ))}
    </ul>
  );
}

function Projects() {
  const { state, productivity, applyProductivity } = useStore();
  const [capsuleId, setCapsuleId] = useState('');
  if (!state || !productivity) return null;
  const capsule: Capsule | undefined = state.capsules.find((c) => c.id === capsuleId) ?? state.capsules[0];
  if (!capsule) return <Empty icon={FolderOpen} title="No capsules yet">Create a capsule on the Capsules screen; its goals, references and checkpoints then live here.</Empty>;
  const meta = productivity.capsuleMeta[capsule.id];
  const staleRefs = (meta?.references ?? []).filter((r) => (r.kind === 'note' && !state.notes.some((n) => n.id === r.target)) || (r.kind === 'task' && !state.tasks.some((t) => t.id === r.target)));
  const dropStale = () => {
    if (!meta) return;
    const keep = meta.references.filter((r) => !staleRefs.includes(r));
    void applyProductivity({ op: 'capsule.setMeta', capsuleId: capsule.id, goals: meta.goals.map(({ id, text, done }) => ({ id, text, done })), references: keep.map(({ id, kind, target, label, note }) => ({ id, kind, target, label, ...(note ? { note } : {}) })) }, `Removed ${staleRefs.length} stale reference(s).`);
  };
  return (
    <div className="stack">
      <Field label="Project (capsule)">
        {(id) => <select id={id} className="input" value={capsule.id} onChange={(e) => setCapsuleId(e.target.value)}>{state.capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      </Field>
      {staleRefs.length > 0 && (
        <Notice tone="warn" title={`${staleRefs.length} reference(s) point at deleted notes or tasks`} action={<Button size="sm" icon={Trash} onClick={dropStale}>Remove them</Button>}>
          They stay listed as deleted until you remove them; nothing is guessed in their place.
        </Notice>
      )}
      <ProjectMemory capsule={capsule} />
    </div>
  );
}

function Checkpoints() {
  const { state, productivity, applyProductivity, toast } = useStore();
  const [filter, setFilter] = useState<CheckpointFilter>(EMPTY_CHECKPOINT_FILTER);
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [capsuleId, setCapsuleId] = useState('');
  const [refs, setRefs] = useState<EvidenceRef[]>([]);
  const [edit, setEdit] = useState<{ id: string; title: string; note: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const listId = useId();
  if (!state || !productivity) return null;
  const shown = filterCheckpoints(productivity.checkpoints, filter);
  const candidates = listSourceCandidates(state, productivity);
  const add = async () => {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      const allRefs: EvidenceRef[] = capsuleId ? [{ kind: 'capsule', id: capsuleId }, ...refs] : refs;
      if (await applyProductivity({ op: 'checkpoint.add', title: t, note: note.trim(), ...(capsuleId ? { capsuleId } : {}), refs: allRefs.slice(0, PRODUCTIVITY_LIMITS.checkpointRefs) }, 'Checkpoint saved.')) { setTitle(''); setNote(''); setRefs([]); }
    } finally { setSaving(false); }
  };
  const saveEdit = async () => {
    if (!edit) return;
    if (await applyProductivity({ op: 'checkpoint.update', id: edit.id, title: edit.title.trim(), note: edit.note.trim() }, 'Checkpoint updated; its original time is kept.')) setEdit(null);
  };
  const remove = async (c: Checkpoint) => {
    if (pendingDelete !== c.id) return setPendingDelete(c.id);
    setPendingDelete(null);
    await applyProductivity({ op: 'checkpoint.delete', id: c.id }, 'Checkpoint deleted.');
  };
  const dropRef = (c: Checkpoint, ref: EvidenceRef) => {
    // Replaces only the evidence list; title, note and the original time are untouched.
    void applyProductivity({ op: 'checkpoint.update', id: c.id, refs: c.refs.filter((r) => !(r.kind === ref.kind && r.id === ref.id)) }, `Dropped the missing ${ref.kind} reference.`);
  };
  const addRef = (value: string) => {
    const [kind, id] = value.split(':', 2) as [EvidenceRef['kind'], string];
    if (!kind || !id || refs.some((r) => r.kind === kind && r.id === id) || refs.length >= PRODUCTIVITY_LIMITS.checkpointRefs - 1) return;
    setRefs([...refs, { kind, id }]);
  };
  return (
    <div className="split">
      <aside className="split-list panel">
        <h3 className="eyebrow">New checkpoint</h3>
        <Field label="Title">{(id) => <input id={id} data-cp-title className="input" value={title} maxLength={PRODUCTIVITY_LIMITS.checkpointTitle} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />}</Field>
        <Field label="Note" hint="What was done, what is next.">{(id) => <textarea id={id} className="input" rows={4} value={note} maxLength={PRODUCTIVITY_LIMITS.checkpointNote} onChange={(e) => setNote(e.target.value)} />}</Field>
        <Field label="Project">{(id) => <select id={id} className="input" value={capsuleId} onChange={(e) => setCapsuleId(e.target.value)}><option value="">No project</option>{state.capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
        <Field label="Evidence" hint="Link the notes, tasks or earlier checkpoints this is based on.">
          {(id) => <select id={id} className="input" value="" onChange={(e) => addRef(e.target.value)} disabled={!candidates.length}><option value="">{candidates.length ? 'Add a record…' : 'No records to link'}</option>{candidates.map((c) => <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>{c.title} — {c.hint}</option>)}</select>}
        </Field>
        <EvidenceChips items={refs.map((r) => resolveEvidence(r, state, productivity))} />
        {refs.length > 0 && <Button size="sm" variant="quiet" onClick={() => setRefs([])}>Clear evidence</Button>}
        <Button variant="primary" icon={Flag} onClick={() => void add()} disabled={!title.trim()} busy={saving}>Save checkpoint</Button>
      </aside>
      <section className="split-detail stack">
        <div className="row align-end">
          <Field label="Filter" className="grow">{(id) => <input id={id} data-cp-filter className="input" value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value.slice(0, 120) })} placeholder="Words in title or note" />}</Field>
          <Field label="Project">{(id) => <select id={id} className="input" value={filter.capsuleId} onChange={(e) => setFilter({ ...filter, capsuleId: e.target.value })}><option value="">Any</option><option value="none">No project</option>{state.capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
          <Field label="From">{(id) => <input id={id} type="date" className="input narrow" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} />}</Field>
          <Field label="To">{(id) => <input id={id} type="date" className="input narrow" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} />}</Field>
          {isFiltered(filter) && <Button onClick={() => setFilter(EMPTY_CHECKPOINT_FILTER)}>Clear</Button>}
        </div>
        <p className="sub" role="status" aria-live="polite">{productivity.checkpoints.length === 0 ? 'No checkpoints yet.' : isFiltered(filter) ? `${shown.length} of ${productivity.checkpoints.length} checkpoints match.` : `${shown.length} checkpoints, newest first.`}</p>
        {productivity.checkpoints.length === 0 ? (
          <Empty icon={Flag} title="Record where you stopped">A checkpoint is a dated note of what was done and what is next. The time is recorded once and never changed by later edits.</Empty>
        ) : shown.length === 0 ? (
          <Empty title="Nothing matches this filter" action={<Button onClick={() => setFilter(EMPTY_CHECKPOINT_FILTER)}>Clear filter</Button>} />
        ) : (
          <ul className="list" id={listId} aria-label="Checkpoints">
            {shown.map((c) => {
              const capsule = c.capsuleId ? state.capsules.find((x) => x.id === c.capsuleId) : undefined;
              const evidence = checkpointEvidence(c, state, productivity).filter((r) => !(r.kind === 'capsule' && r.id === c.capsuleId));
              const editing = edit?.id === c.id;
              return (
                <li key={c.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                  <div className="grow stack tight">
                    {editing ? (
                      <>
                        <input className="input" aria-label="Checkpoint title" value={edit.title} maxLength={PRODUCTIVITY_LIMITS.checkpointTitle} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                        <textarea className="input" aria-label="Checkpoint note" rows={3} value={edit.note} maxLength={PRODUCTIVITY_LIMITS.checkpointNote} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
                        <span className="row"><Button variant="primary" size="sm" onClick={() => void saveEdit()} disabled={!edit.title.trim()}>Save</Button><Button size="sm" onClick={() => setEdit(null)}>Cancel</Button></span>
                      </>
                    ) : (
                      <>
                        <strong>{c.title}</strong>
                        <span className="sub"><time dateTime={c.createdAt}>{fmtWhen(c.createdAt)}</time>{capsule ? ` · ${capsule.name}` : c.capsuleId ? ' · deleted capsule' : ''} <span className="mono">[checkpoint:{c.id}]</span></span>
                        {c.note && <p className="sub block" style={{ whiteSpace: 'pre-wrap' }}>{c.note}</p>}
                        <EvidenceChips items={evidence} onDrop={(r) => dropRef(c, r)} />
                      </>
                    )}
                  </div>
                  {!editing && (
                    <span className="row">
                      <Button size="sm" onClick={() => { setPendingDelete(null); setEdit({ id: c.id, title: c.title, note: c.note }); }} aria-label={`Edit checkpoint ${c.title}`}>Edit</Button>
                      <Button size="sm" variant={pendingDelete === c.id ? 'danger' : 'ghost'} icon={Trash} onClick={() => void remove(c)} aria-label={`Delete checkpoint ${c.title}`}>{pendingDelete === c.id ? 'Confirm delete' : 'Delete'}</Button>
                      {pendingDelete === c.id && <Button size="sm" onClick={() => setPendingDelete(null)}>Keep</Button>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Goal 38: offline coding-session adapter. Parses pasted git log text into sessions and writes the selected ones through
 * the existing `checkpoint.add` operation, one call per draft. Nothing here runs git or reads a repository.
 */
function CodingSessionImport() {
  const { state, productivity, applyProductivity, toast } = useStore();
  const [text, setText] = useState('');
  const [gap, setGap] = useState(String(ADAPTER_LIMITS.gapMinutes));
  const [capsuleId, setCapsuleId] = useState('');
  const [parsed, setParsed] = useState<ParsedGitLog | null>(null);
  const [grouped, setGrouped] = useState<GroupedSessions | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!state || !productivity) return null;
  const parse = () => {
    try {
      const p = parseGitLog(text);
      const g = groupSessionsDetailed(p.commits, { gapMinutes: Number(gap) });
      setParsed(p); setGrouped(g); setSelected(new Set(g.sessions.map((s) => s.id))); setError(null);
    } catch (e) {
      setParsed(null); setGrouped(null); setSelected(new Set()); setError(e instanceof Error ? e.message : 'The text could not be parsed.');
    }
  };
  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };
  const create = async () => {
    if (!grouped || saving) return;
    const chosen = grouped.sessions.filter((s) => selected.has(s.id));
    if (!chosen.length) return;
    setSaving(true);
    try {
      const drafts = buildCheckpointDrafts(chosen, { capsuleId: capsuleId || undefined, now: new Date().toISOString() });
      let ok = 0;
      for (const d of drafts) if (await applyProductivity(toCheckpointOp(d))) ok++;
      toast(ok === drafts.length ? 'ok' : 'error', `Created ${ok} of ${drafts.length} checkpoint(s) from pasted git history.`);
      if (ok === drafts.length) setSelected(new Set());
    } catch (e) {
      toast('error', e instanceof Error ? e.message : 'Checkpoints could not be created.');
    } finally { setSaving(false); }
  };
  const count = grouped ? grouped.sessions.filter((s) => selected.has(s.id)).length : 0;
  return (
    <Panel title="Import coding sessions (git log, offline)" eyebrow="Checkpoints from pasted history">
      <p className="sub">Parsed from pasted text only; this build does not run git or read repositories.</p>
      <Field label="Pasted git log" hint={`Default git log, --oneline, or --format=%H%x09%an%x09%aI%x09%s. Up to ${ADAPTER_LIMITS.inputChars} characters.`}>
        {(id, d) => <textarea id={id} aria-describedby={d} className="input mono" rows={6} value={text} maxLength={ADAPTER_LIMITS.inputChars} onChange={(e) => setText(e.target.value)} />}
      </Field>
      <div className="row align-end">
        <Field label="Gap between sessions (minutes)">{(id) => <input id={id} type="number" className="input narrow" min={1} max={ADAPTER_LIMITS.maxGapMinutes} value={gap} onChange={(e) => setGap(e.target.value)} />}</Field>
        <Field label="Project">{(id) => <select id={id} className="input" value={capsuleId} onChange={(e) => setCapsuleId(e.target.value)}><option value="">No project</option>{state.capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
        <Button onClick={parse} disabled={!text.trim()}>Parse</Button>
      </div>
      {error && <Notice tone="warn" title="Nothing parsed">{error}</Notice>}
      {parsed && grouped && (
        <div className="stack">
          <p className="sub" role="status" aria-live="polite">
            Layout: {parsed.layout} · {parsed.commits.length} commit(s) · {parsed.skippedLines} skipped line(s){parsed.truncated ? ` · truncated at ${ADAPTER_LIMITS.commits} commits` : ''} · {grouped.totalSessions} session(s){grouped.truncated ? ` (showing the first ${grouped.sessions.length})` : ''}
          </p>
          <ul className="list" aria-label="Coding sessions">
            {grouped.sessions.map((s) => (
              <li key={s.id} className="list-row">
                <label className="grow">
                  <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)} /> <strong>{s.title}</strong>
                  <span className="sub"> · {s.commitCount} commit(s) · {s.undated ? 'undated' : `${fmtWhen(s.startedAt as string)} – ${fmtWhen(s.endedAt as string)}`}</span>
                </label>
              </li>
            ))}
          </ul>
          <Button variant="primary" icon={Flag} onClick={() => void create()} disabled={!count} busy={saving}>{`Create ${count} checkpoint${count === 1 ? '' : 's'}`}</Button>
        </div>
      )}
    </Panel>
  );
}

function Shelf() {
  const { state, api, productivity, applyProductivity, toast } = useStore();
  const [kind, setKind] = useState<'file' | 'folder' | 'url'>('file');
  const [target, setTarget] = useState('');
  const [label, setLabel] = useState('');
  if (!state || !productivity) return null;
  const browse = async () => {
    try { const p = await api.pickPath(kind === 'folder' ? 'folder' : 'file'); if (p) setTarget(p); } catch (e) { toast('error', e instanceof Error ? e.message : 'The picker failed.'); }
  };
  const add = async () => {
    const t = target.trim();
    if (!t) return;
    if (await applyProductivity({ op: 'shelf.add', kind, target: t, label: label.trim() }, 'Added to the shelf.')) { setTarget(''); setLabel(''); }
  };
  const items = [...productivity.shelf].sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.addedAt < b.addedAt ? 1 : -1));
  return (
    <div className="stack">
      <Panel title="Add to shelf" eyebrow="Files, folders and links you keep coming back to">
        <div className="row align-end">
          <Field label="Kind">{(id) => <select id={id} className="input narrow" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="file">File</option><option value="folder">Folder</option><option value="url">Link</option></select>}</Field>
          <Field label={kind === 'url' ? 'https:// address' : 'Path'} className="grow">{(id) => <input id={id} className="input" value={target} onChange={(e) => setTarget(e.target.value)} />}</Field>
          {kind !== 'url' && <Button icon={FolderOpen} onClick={() => void browse()}>Browse…</Button>}
          <Field label="Label">{(id) => <input id={id} className="input" value={label} maxLength={PRODUCTIVITY_LIMITS.labelChars} onChange={(e) => setLabel(e.target.value)} />}</Field>
          <Button variant="primary" onClick={() => void add()} disabled={!target.trim()}>Add</Button>
        </div>
        <p className="field-hint">The shelf stores the path or address only. Nothing is opened, copied or watched.</p>
      </Panel>
      {items.length === 0 ? <Empty icon={Link} title="The shelf is empty">Add the files, folders and links you keep returning to. Pinned items stay on top.</Empty> : (
        <ul className="list" aria-label="Shelf">
          {items.map((s) => (
            <li key={s.id} className="list-row">
              <span className="grow"><Badge>{s.kind}</Badge> <strong>{s.label || s.target}</strong>{s.label && <span className="sub mono"> {s.target}</span>}<span className="sub"> · added {fmtWhen(s.addedAt)}</span></span>
              <Button size="sm" icon={PushPin} variant={s.pinned ? 'primary' : 'ghost'} aria-pressed={s.pinned} onClick={() => void applyProductivity({ op: 'shelf.pin', id: s.id, pinned: !s.pinned })}>{s.pinned ? 'Pinned' : 'Pin'}</Button>
              <Button size="sm" icon={Trash} onClick={() => void applyProductivity({ op: 'shelf.remove', id: s.id }, 'Removed from the shelf.')} aria-label={`Remove ${s.label || s.target}`}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      {productivity.recents.length > 0 && (
        <Panel title="Recently opened" eyebrow="Recorded by capsule restores">
          <ul className="list compact">{productivity.recents.map((r) => <li key={r.id} className="list-row"><span className="grow"><Badge>{r.kind}</Badge> {r.label || r.target} <span className="sub">· {r.count}× · last {fmtWhen(r.openedAt)}</span></span><Button size="sm" onClick={() => void applyProductivity({ op: 'recent.remove', id: r.id })} aria-label={`Forget recent ${r.label || r.target}`}>Forget</Button></li>)}</ul>
        </Panel>
      )}
    </div>
  );
}

function Timeline() {
  const { productivity, applyProductivity } = useStore();
  if (!productivity) return null;
  const policy = productivity.policy;
  const days = groupTimeline(productivity.timeline);
  return (
    <div className="stack">
      <Notice tone="info" title={policy.timelineEnabled ? 'Application timeline is on' : 'Application timeline is off'}>
        {policy.timelineEnabled
          ? `Entries arrive only from modules that report an application session while this is on; this screen records nothing by itself. Window titles are ${policy.timelineTitles ? 'kept' : 'not kept'}. Entries older than ${policy.retainDays.timeline || '∞'} days are removed.`
          : 'Nothing is recorded. Turn it on under Privacy if you want a local record of which applications you used and when.'}
      </Notice>
      {days.length === 0 ? <Empty title="No timeline entries">{policy.timelineEnabled ? 'No module has reported an application session yet.' : 'The timeline is off.'}</Empty> : days.map((d) => (
        <Panel key={d.day} title={d.day} eyebrow={fmtDuration(d.totalSec)}>
          <ul className="list compact">
            {d.entries.map((e) => (
              <li key={e.id} className="list-row">
                <span className="grow"><strong>{e.app}</strong>{e.title ? <span className="sub"> · {e.title}</span> : null}<span className="sub"> · {fmtWhen(e.at)}{e.endedAt ? ` → ${fmtDuration(Math.max(0, (Date.parse(e.endedAt) - Date.parse(e.at)) / 1000))}` : ' (open)'}</span></span>
                <Button size="sm" icon={Trash} onClick={() => void applyProductivity({ op: 'timeline.delete', id: e.id }, 'Entry deleted.')} aria-label={`Delete timeline entry ${e.app}`}>Delete</Button>
              </li>
            ))}
          </ul>
        </Panel>
      ))}
    </div>
  );
}

function RecapSection() {
  const { state, productivity, toast } = useStore();
  const [day, setDay] = useState(() => localDayKey(new Date()));
  const [kinds, setKinds] = useState<EvidenceKind[]>([]);
  const [query, setQuery] = useState('');
  const [withSources, setWithSources] = useState(true);
  const [text, setText] = useState<string | null>(null);
  const recap = useMemo(() => (state ? filterRecap(buildDailyRecap(state, productivity ?? undefined, day), { kinds, query }) : null), [state, productivity, day, kinds, query]);
  const generated = useMemo(() => (state && recap ? draftWorklogVerified(recap, state, productivity, { withSources }) : null), [state, productivity, recap, withSources]);
  useEffect(() => { setText(null); }, [day, kinds, query, withSources]);
  if (!state || !productivity || !recap || !generated) return null;
  const draft = text ?? generated.text;
  const copy = async () => { try { await navigator.clipboard.writeText(draft); toast('ok', 'Draft copied. Review it before sharing.'); } catch { toast('error', 'Copying was blocked. Select the text and copy it manually.'); } };
  const toggleKind = (k: EvidenceKind) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  return (
    <div className="grid2">
      <Panel title="Daily recap" eyebrow="Evidence only">
        <div className="row align-end">
          <Field label="Day">{(id) => <input id={id} type="date" className="input narrow" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
          <Field label="Filter" className="grow">{(id) => <input id={id} className="input" value={query} onChange={(e) => setQuery(e.target.value.slice(0, 120))} placeholder="Words in a line" />}</Field>
        </div>
        <div className="chips" role="group" aria-label="Evidence kinds">
          {KINDS.map((k) => <button key={k.kind} type="button" className={kinds.includes(k.kind) ? 'chip on' : 'chip'} aria-pressed={kinds.includes(k.kind)} onClick={() => toggleKind(k.kind)}>{k.label}</button>)}
        </div>
        {recap.empty ? <Empty title="Nothing recorded">{kinds.length || query ? 'No line matches the filter.' : `No focus sessions, checkpoints, saved notes, new tasks or capsule activity on ${day}.`}</Empty> : (
          <ul className="list compact" aria-label="Recap lines">
            {recap.lines.map((l, i) => { const r = resolveEvidence(l.source, state, productivity); return <li key={i} className="list-row"><span className="grow">{l.text}</span><Badge tone={r.status === 'ok' ? 'info' : 'warn'} title={`${l.source.kind}:${l.source.id}`}>{r.status === 'ok' ? l.source.kind : 'source gone'}</Badge></li>; })}
          </ul>
        )}
      </Panel>
      <Panel title="Worklog draft" eyebrow="Plain text, yours to edit" actions={<Button size="sm" icon={Copy} onClick={() => void copy()}>Copy</Button>}>
        <label className="row"><input type="checkbox" checked={withSources} onChange={(e) => setWithSources(e.target.checked)} /> Include record ids</label>
        {generated.stale > 0 && <p className="sub"><Warning aria-hidden size={14} /> {generated.stale} line(s) cite records that were deleted since; they are marked in the draft.</p>}
        <textarea className="input mono" rows={14} aria-label="Worklog draft" value={draft} onChange={(e) => setText(e.target.value.slice(0, 20000))} />
        {text !== null && <Button size="sm" variant="quiet" onClick={() => setText(null)}>Reset to generated</Button>}
        <p className="field-hint">Assembled from local records; no model is involved. The draft is not stored anywhere until you paste it.</p>
      </Panel>
    </div>
  );
}

type DraftWindow = 'today' | '24h' | '7d';
const DRAFT_WINDOWS: { value: DraftWindow; label: string }[] = [{ value: 'today', label: 'Today' }, { value: '24h', label: 'Last 24h' }, { value: '7d', label: 'Last 7 days' }];
const DRAFT_FORMATS: { value: WorklogFormat; label: string }[] = [{ value: 'standup', label: 'Standup' }, { value: 'worklog', label: 'Worklog' }];

function StandupDraft() {
  const { state, productivity, toast } = useStore();
  const [win, setWin] = useState<DraftWindow>('today');
  const [format, setFormat] = useState<WorklogFormat>('standup');
  const [capsuleId, setCapsuleId] = useState('');
  const [draft, setDraft] = useState<WorklogDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!state || !productivity) return null;
  const generate = () => {
    const now = new Date();
    const since = win === 'today' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getTime() - (win === '24h' ? 1 : 7) * 86_400_000);
    try {
      setDraft(buildWorklogDraft({ checkpoints: productivity.checkpoints, tasks: state.tasks, notes: state.notes, focusSessions: productivity.focus }, { since: since.toISOString(), until: new Date(now.getTime() + 1).toISOString(), now: now.toISOString(), format, ...(capsuleId ? { capsuleId } : {}) }));
      setError(null);
    } catch (e) { setDraft(null); setError(e instanceof Error ? e.message : 'The draft could not be built.'); }
  };
  const copy = async () => {
    if (!draft || draft.empty) return;
    if (!navigator.clipboard?.writeText) { toast('error', 'Copying is not available here. Select the text and copy it manually.'); return; }
    try { await navigator.clipboard.writeText(draft.text); toast('ok', 'Draft copied. Review it before sharing.'); } catch { toast('error', 'Copying was blocked. Select the text and copy it manually.'); }
  };
  return (
    <Panel title="Draft standup" eyebrow="From local records only">
      <div className="row align-end">
        <Field label="Window">{(id) => <select id={id} className="input narrow" value={win} onChange={(e) => { setWin(e.target.value as DraftWindow); setDraft(null); }}>{DRAFT_WINDOWS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</select>}</Field>
        <Field label="Project">{(id) => <select id={id} className="input" value={capsuleId} onChange={(e) => { setCapsuleId(e.target.value); setDraft(null); }}><option value="">All</option>{state.capsules.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}</Field>
        <Segmented<WorklogFormat> label="Draft format" value={format} onChange={(f) => { setFormat(f); setDraft(null); }} options={DRAFT_FORMATS} />
        <Button variant="primary" onClick={generate}>Draft standup</Button>
      </div>
      {error && <Notice tone="danger" title="Cannot draft">{error}</Notice>}
      {draft?.empty && <p className="sub" role="status">Nothing recorded in this window. Checkpoints, tasks, saved notes and focus sessions show up here; nothing is invented.</p>}
      {draft && !draft.empty && (
        <>
          <textarea className="input mono" rows={12} readOnly aria-label="Standup draft" value={draft.text} />
          <div className="row"><Button size="sm" icon={Copy} onClick={() => void copy()}>Copy draft</Button><span className="sub">{draft.evidence.length} line(s), each citing a record</span></div>
        </>
      )}
    </Panel>
  );
}

function Portability() {
  const { state, productivity, productivityApi, refreshProductivity, toast } = useStore();
  const [exported, setExported] = useState<string | null>(null);
  const [raw, setRaw] = useState('');
  const [plan, setPlan] = useState<PortableImport | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!state || !productivity || !productivityApi) return null;
  const doExport = () => setExported(JSON.stringify(exportPortable(productivity, state.capsules), null, 1));
  const copy = async () => { if (!exported) return; try { await navigator.clipboard.writeText(exported); toast('ok', 'Export copied.'); } catch { toast('error', 'Copying was blocked. Select the text and copy it manually.'); } };
  const preview = () => { setResult(null); setPlan(parsePortable(raw, { prod: productivity, capsules: state.capsules, noteIds: state.notes.map((n) => n.id), taskIds: state.tasks.map((t) => t.id) })); };
  const apply = async () => {
    if (!plan?.ok || !plan.ops.length || applying) return;
    setApplying(true);
    let done = 0;
    try {
      for (const op of plan.ops) { await productivityApi.apply(op); done++; }
      setResult(`Imported ${plan.counts.checkpoints} checkpoint(s), ${plan.counts.goals} goal(s), ${plan.counts.references} reference(s) and ${plan.counts.shelf} shelf item(s).`);
      setPlan(null); setRaw('');
    } catch (e) {
      setResult(`Stopped after ${done} of ${plan.ops.length} records: ${e instanceof Error ? e.message : 'the store refused a record'}. Records already imported are kept; preview again to retry the rest.`);
    } finally {
      setApplying(false);
      await refreshProductivity();
    }
  };
  return (
    <div className="grid2">
      <Panel title="Export" eyebrow="Checkpoints, goals, references, shelf" actions={<Button size="sm" onClick={doExport}>Generate</Button>}>
        <p className="sub">A bounded JSON text you can paste into this app on another computer. Focus history, the timeline, reminders and recents stay local. Paths and links are included as written.</p>
        {exported !== null && (
          <>
            <textarea className="input mono" rows={10} readOnly value={exported} aria-label="Exported memory" onFocus={(e) => e.currentTarget.select()} />
            <div className="row"><Button icon={Copy} onClick={() => void copy()}>Copy</Button><span className="sub">{exported.length.toLocaleString()} characters</span></div>
          </>
        )}
      </Panel>
      <Panel title="Import" eyebrow="Preview first, then apply">
        <textarea className="input mono" rows={8} value={raw} onChange={(e) => { setRaw(e.target.value); setPlan(null); setResult(null); }} aria-label="Paste exported memory" placeholder="Paste an export here" />
        <div className="row"><Button onClick={preview} disabled={!raw.trim()}>Preview</Button>{plan?.ok && plan.ops.length > 0 && <Button variant="primary" busy={applying} onClick={() => void apply()}>Apply {plan.ops.length} record(s)</Button>}</div>
        {plan && !plan.ok && <Notice tone="danger" title="Cannot import">{plan.problems[0]}</Notice>}
        {plan?.ok && (
          <div className="stack tight" role="status">
            <p className="sub">{plan.ops.length ? `Would add ${plan.counts.checkpoints} checkpoint(s) with their original times, ${plan.counts.goals} goal(s), ${plan.counts.references} reference(s), ${plan.counts.shelf} shelf item(s).` : 'Nothing new to import: everything in this text is already here or was skipped.'}{plan.exportedAt ? ` Exported ${fmtWhen(plan.exportedAt)}.` : ''}</p>
            {plan.problems.length > 0 && <details><summary>{plan.problems.length} note(s)</summary><ul className="list compact">{plan.problems.map((p, i) => <li key={i} className="list-row"><span className="grow">{p}</span></li>)}</ul></details>}
          </div>
        )}
        {result && <Notice tone={result.startsWith('Imported') ? 'info' : 'warn'}>{result}</Notice>}
      </Panel>
    </div>
  );
}
