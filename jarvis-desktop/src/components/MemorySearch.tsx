import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChatCircleDots, CheckSquare, Cube, Info, MagnifyingGlass, Note } from '@phosphor-icons/react';
import type { AppState } from '../shared/contracts';
import { relTime } from '../ui/util';
import type { ProductivityState } from '../../electron/services/store';
import { CATEGORY_LABELS, SEARCH_LIMITS, groupResults, parseQuery, navResult, previewRetention, searchState, type ExternalDoc, type NavResult, type SearchCategory, type SearchResult } from '../../electron/services/search';
import { Badge, Button, Empty, Field, Notice, Panel, Switch } from '../ui/primitives';
import { useOptionalStore, useReady } from '../ui/store';

const ICONS = { note: Note, task: CheckSquare, capsule: Cube, checkpoint: Cube, reference: Note, history: Info, external: MagnifyingGlass, chat: ChatCircleDots } satisfies Record<SearchCategory, unknown>;
/**
 * Where a result comes from, built only from stored records: its kind, the capsule or tags it belongs to and when it was
 * saved. Nothing is inferred; a record that cannot be found adds nothing rather than a guess.
 */
export function describeSource(r: SearchResult, state: AppState, productivity?: ProductivityState | null, external: ExternalDoc[] = []): string {
  const parts: string[] = [];
  if (r.category === 'note') {
    const n = state.notes.find((x) => x.id === r.id);
    parts.push('Note');
    if (n?.tags.length) parts.push(n.tags.slice(0, 4).map((t) => `#${t}`).join(' '));
    if (n) parts.push(`updated ${relTime(n.updatedAt)}`);
    const refs = productivity ? state.capsules.filter((c) => productivity.capsuleMeta[c.id]?.references.some((x) => x.kind === 'note' && x.target === r.id)) : [];
    if (refs.length) parts.push(`in capsule ${refs.slice(0, 2).map((c) => c.name).join(', ')}`);
  } else if (r.category === 'task') {
    const t = state.tasks.find((x) => x.id === r.id);
    parts.push(t ? (t.done ? 'Task (done)' : 'Task (open)') : 'Task');
    if (t?.due) parts.push(`due ${t.due.slice(0, 10)}`);
  } else if (r.category === 'capsule') {
    const c = state.capsules.find((x) => x.id === r.id);
    parts.push('Capsule');
    if (c) parts.push(`updated ${relTime(c.updatedAt)}`);
  } else if (r.category === 'checkpoint') {
    const cp = productivity?.checkpoints.find((x) => x.id === r.id);
    const cap = cp?.capsuleId ? state.capsules.find((x) => x.id === cp.capsuleId) : undefined;
    parts.push(cap ? `Checkpoint in capsule ${cap.name}` : 'Checkpoint');
    if (cp) parts.push(relTime(cp.createdAt));
  } else if (r.category === 'chat') {
    const m = state.chat.find((x) => x.id === r.id);
    parts.push(m ? `Chat message (${m.source})` : 'Chat message');
    if (m) parts.push(relTime(m.createdAt));
  } else if (r.category === 'history') parts.push('Activity log');
  else if (r.category === 'reference') parts.push('File shelf');
  else {
    const doc = external.find((x) => x.id === r.id);
    parts.push(doc?.source ?? 'Other source');
    if (doc?.at) parts.push(relTime(doc.at));
  }
  return parts.join(' · ');
}

const RANGES = [
  { value: 'any', label: 'Any time', days: 0 },
  { value: '7', label: 'Last 7 days', days: 7 },
  { value: '30', label: 'Last 30 days', days: 30 },
] as const;

/**
 * Local, read-only search across saved notes, tasks, capsules and (only when switched on) chat history.
 * Selecting a result calls onNavigate with a contract-shaped result (note, task, capsule or chat); the caller decides
 * which view to open. Results with no screen of their own (shelf items, activity history, other modules) are listed
 * without a link instead of pretending to navigate.
 */
export function MemorySearch({ state, onNavigate, initialQuery = '', limit, productivity: productivityProp, external: externalProp }: { state: AppState; onNavigate: (result: NavResult) => void; initialQuery?: string; limit?: number; productivity?: ProductivityState | null; external?: ExternalDoc[] }) {
  // Without AppProvider the component works from props alone. Callers that pass nothing (Home, the Search view) still get checkpoints, goals and the shelf from the app store,
  // and records other modules chose to share (productivityApi.signals); a caller can override either.
  const ctx = useOptionalStore();
  const productivity = productivityProp === undefined ? ctx?.productivity ?? null : productivityProp;
  const signals = ctx?.productivityApi?.signals;
  const [shared, setShared] = useState<ExternalDoc[]>([]);
  useEffect(() => {
    if (externalProp !== undefined || !signals) return;
    let live = true;
    signals().then((docs) => { if (live) setShared(Array.isArray(docs) ? docs : []); }, () => { if (live) setShared([]); });
    return () => { live = false; };
  }, [externalProp, signals]);
  const external = externalProp ?? shared;
  const [query, setQuery] = useState(initialQuery.slice(0, SEARCH_LIMITS.queryChars));
  const [includeChat, setIncludeChat] = useState(false);
  const [includeHistory, setIncludeHistory] = useState(false);
  const [scope, setScope] = useState('');
  const [tag, setTag] = useState('');
  const [range, setRange] = useState<(typeof RANGES)[number]['value']>('any');
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const statusId = useId();

  const hasTerms = useMemo(() => parseQuery(deferred).length > 0, [deferred]);
  const results = useMemo(() => {
    const days = RANGES.find((r) => r.value === range)?.days ?? 0;
    return searchState(state, deferred, {
      includeChat,
      includeHistory,
      limit,
      productivity: productivity ?? undefined,
      external,
      capsuleId: scope || undefined,
      tag: tag || undefined,
      since: days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined,
    });
  }, [state, deferred, includeChat, includeHistory, limit, productivity, external, scope, tag, range]);
  const groups = useMemo(() => groupResults(results), [results]);
  const noteTags = useMemo(() => [...new Set(state.notes.flatMap((n) => n.tags))].sort().slice(0, 100), [state.notes]);
  const filtered = Boolean(scope || tag || range !== 'any');
  const clearFilters = () => {
    setScope('');
    setTag('');
    setRange('any');
  };

  const resultButtons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-result]') ?? []);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && results.length) {
      e.preventDefault();
      resultButtons()[0]?.focus();
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  };

  // Arrow keys move through every result in display order, across groups.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const btns = resultButtons();
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
    if (next < 0) inputRef.current?.focus();
    else btns[next]?.focus();
  };

  const status = !hasTerms ? (deferred.trim() ? 'Type letters or numbers to search.' : '') : results.length === 0 ? 'No matches.' : `${results.length} result${results.length === 1 ? '' : 's'}${results.length >= (limit ?? SEARCH_LIMITS.defaultResults) ? ' (showing the best matches only)' : ''}.`;

  return (
    <section className="stack" aria-label="Search saved items">
      <div role="search" className="stack tight">
        <Field label="Search notes, tasks and capsules" hint="Runs on this device over items already saved in Desktop Companion. Nothing is sent to a model or the internet, and files on disk are not scanned.">
          {(id, d) => (
            <input
              ref={inputRef}
              id={id}
              type="search"
              className="input"
              aria-describedby={[d, statusId].filter(Boolean).join(' ')}
              aria-controls={`${statusId}-results`}
              autoComplete="off"
              spellCheck={false}
              maxLength={SEARCH_LIMITS.queryChars}
              placeholder="Words from a title, tag or note"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
            />
          )}
        </Field>
        <Switch checked={includeChat} onChange={setIncludeChat} label="Include chat history" description="Off by default. When on, past chat messages stored on this device are searched too." />
        <Switch checked={includeHistory} onChange={setIncludeHistory} label="Include activity history" description="Off by default. When on, the activity log (restores, imports, reminders) is searched too." />
        <details className="stack tight">
          <summary>Filters{filtered ? ' (active)' : ''}</summary>
          <Field label="Project" hint="Limit results to one capsule, its checkpoints and the notes and tasks it references.">
            {(id) => (
              <select id={id} className="input" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="">All projects</option>
                {state.capsules.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Note tag" hint="Only notes with this tag; other kinds of result are hidden while a tag is set.">
            {(id) => (
              <>
                <input id={id} className="input" maxLength={32} list={`${statusId}-tags`} placeholder={noteTags.length ? `for example ${noteTags[0]}` : 'No notes have tags yet'} value={tag} onChange={(e) => setTag(e.target.value.replace(/^#/, '').toLowerCase())} />
                <datalist id={`${statusId}-tags`}>{noteTags.map((t) => <option key={t} value={t} />)}</datalist>
              </>
            )}
          </Field>
          <Field label="Updated">
            {(id) => (
              <select id={id} className="input" value={range} onChange={(e) => setRange(e.target.value as typeof range)}>
                {RANGES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {filtered && <Button size="sm" onClick={clearFilters}>Clear filters</Button>}
        </details>
      </div>

      <p id={statusId} className="sub" role="status" aria-live="polite">
        {status}
      </p>

      <div id={`${statusId}-results`} ref={listRef} onKeyDown={onListKey}>
        {!hasTerms ? (
          <Empty icon={MagnifyingGlass} title="Search what you have saved">
            Matching ignores letter case and accents. Up and Down arrows move between results; Escape returns to the search field.
          </Empty>
        ) : groups.length === 0 ? (
          <Empty icon={MagnifyingGlass} title="No matches">
            {includeChat ? 'Try fewer or shorter words.' : 'Try fewer or shorter words, or include chat history.'}
            {filtered && ' A filter is active; clear it to search everything.'}
            {filtered && <><br /><Button size="sm" onClick={clearFilters}>Clear filters</Button></>}
          </Empty>
        ) : (
          groups.map((g) => {
            const Icon = ICONS[g.category];
            const headingId = `${statusId}-${g.category}`;
            return (
              <section key={g.category} aria-labelledby={headingId} className="stack tight">
                <h3 id={headingId} className="eyebrow">
                  {CATEGORY_LABELS[g.category]} <span className="sub">({g.results.length})</span>
                </h3>
                <ul className="select-list" aria-labelledby={headingId}>
                  {g.results.map((r) => {
                    const target = navResult(r, productivity);
                    const body = (
                      <>
                        <span className="row">
                          <Icon size={14} aria-hidden />
                          <strong>{r.title}</strong>
                          {r.relevance >= 0.9 && <Badge tone="accent">Best match</Badge>}
                        </span>
                        {r.snippet && <span className="sub">{r.snippet}</span>}
                        <span className="sub" data-source>{describeSource(r, state, productivity, external)}</span>
                      </>
                    );
                    return (
                      <li key={`${r.category}:${r.id}`}>
                        {target ? (
                          <button type="button" data-result className="select-item" onClick={() => onNavigate(target)}>
                            {body}
                          </button>
                        ) : (
                          <div className="select-item" data-nolink>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}

const SCOPE_LABELS: Record<string, string> = {
  checkpoints: 'checkpoints',
  focus: 'focus history',
  timeline: 'application timeline',
  reminders: 'reminder states',
  associations: 'session associations',
  shelf: 'file shelf',
  recents: 'recent items',
};

/**
 * Retention and forgetting controls for the local sidecar data plus chat/activity history. Every forget action needs
 * a second, explicit click; nothing here reads files, and screen/audio capture is shown as unavailable.
 */
export function MemoryControls() {
  const { state, api, productivity, productivityApi, productivityError, applyProductivity, run } = useReady();
  const [pending, setPending] = useState<string | null>(null);
  const [days, setDays] = useState<Record<string, string>>({});
  const preview = useMemo(() => previewRetention(state, productivity ?? undefined, Date.now()), [state, productivity]);

  if (!productivityApi || !productivity) {
    return (
      <Notice tone="warn" title="Local productivity storage is not connected">
        {productivityError ?? 'This build has no sidecar store for checkpoints, focus history, shelf or timeline, so those controls are hidden. Chat history can still be cleared below.'}
        <div className="row">
          <Button variant="danger" onClick={() => (pending === 'chat' ? (setPending(null), void run(() => api.clearChat(), 'Chat history cleared.')) : setPending('chat'))}>
            {pending === 'chat' ? 'Confirm: clear all chat' : 'Clear chat history…'}
          </Button>
          {pending === 'chat' && <Button onClick={() => setPending(null)}>Cancel</Button>}
        </div>
      </Notice>
    );
  }

  const policy = productivity.policy;
  const forget = (scope: string) => {
    if (pending !== scope) return setPending(scope);
    setPending(null);
    if (scope === 'activity' || scope === 'chat') {
      void run(async () => {
        if (!productivityApi.forgetHistory) throw new Error('Forgetting history is not connected in this build.');
        const r = await productivityApi.forgetHistory(scope === 'chat' ? { chat: true } : { activity: true });
        return r;
      }, scope === 'chat' ? 'Chat history forgotten.' : 'Activity history forgotten.');
    } else {
      void applyProductivity({ op: 'forget', scope: scope as 'all' }, scope === 'all' ? 'All local productivity data forgotten.' : `Forgot ${SCOPE_LABELS[scope] ?? scope}.`);
    }
  };
  const forgetButton = (scope: string, label: string) => (
    <span className="row">
      <Button variant={pending === scope ? 'danger' : 'ghost'} onClick={() => forget(scope)}>
        {pending === scope ? `Confirm: forget ${label}` : `Forget ${label}…`}
      </Button>
      {pending === scope && <Button onClick={() => setPending(null)}>Cancel</Button>}
    </span>
  );
  const setRetain = (k: 'focus' | 'timeline' | 'checkpoints' | 'reminders') => {
    const raw = days[k];
    if (raw === undefined || !/^\d{1,4}$/.test(raw)) return;
    void applyProductivity({ op: 'policy.set', retainDays: { [k]: Number(raw) } }, 'Retention saved.');
  };
  const total = Object.values(preview).reduce((n, v) => n + v, 0);

  return (
    <div className="stack">
      <Panel title="Application timeline" eyebrow="Opt-in">
        <Switch
          checked={policy.timelineEnabled}
          onChange={(v) => void applyProductivity({ op: 'policy.set', timelineEnabled: v }, v ? 'Application timeline enabled.' : 'Application timeline disabled.')}
          label="Record which applications I use"
          description="Off by default. Stores application names and times only, on this device. Nothing is recorded unless another module reports a session while this is on."
        />
        <Switch
          checked={policy.timelineTitles}
          disabled={!policy.timelineEnabled}
          onChange={(v) => void applyProductivity({ op: 'policy.set', timelineTitles: v }, 'Saved.')}
          label="Also keep window titles"
          description="Titles can contain private text. Off by default."
        />
      </Panel>

      <Panel title="Retention" eyebrow="Memory">
        <p className="sub">Chat and activity history use the retention period in Settings ({state.settings.retainDays} days). Notes, tasks and capsules are never removed automatically. 0 days keeps an item until you forget it.</p>
        {(['focus', 'timeline', 'checkpoints', 'reminders'] as const).map((k) => (
          <Field key={k} label={`Keep ${k === 'focus' ? 'focus sessions' : k === 'timeline' ? 'timeline entries' : k === 'checkpoints' ? 'checkpoints' : 'reminder states'} (days)`}>
            {(id) => (
              <span className="row">
                <input id={id} className="input narrow" inputMode="numeric" value={days[k] ?? String(policy.retainDays[k])} onChange={(e) => setDays({ ...days, [k]: e.target.value.replace(/[^\d]/g, '').slice(0, 4) })} />
                <Button onClick={() => setRetain(k)} disabled={days[k] === undefined || days[k] === String(policy.retainDays[k])}>Save</Button>
              </span>
            )}
          </Field>
        ))}
        <p className="sub" role="status">{total ? `With these settings, ${total} saved record(s) are due to be removed (chat ${preview.chat}, activity ${preview.activity}, focus ${preview.focus}, checkpoints ${preview.checkpoints}, reminders ${preview.reminders}, timeline ${preview.timeline}).` : 'Nothing is currently past its retention period.'}</p>
      </Panel>

      <Panel title="Forget" eyebrow="Delete on request">
        <p className="sub">Each button asks for a second click. Forgetting cannot be undone; automatic backups of the main data file may still hold older chat and activity until they rotate out.</p>
        <div className="stack tight">
          <span key="chat">{forgetButton("chat", "chat history")}</span>
          <span key="activity">{forgetButton("activity", "activity history")}</span>
          <span key="focus">{forgetButton("focus", "focus history")}</span>
          <span key="checkpoints">{forgetButton("checkpoints", "checkpoints")}</span>
          <span key="timeline">{forgetButton("timeline", "application timeline")}</span>
          <span key="reminders">{forgetButton("reminders", "reminder states")}</span>
          <span key="shelf">{forgetButton("shelf", "file shelf")}</span>
          <span key="recents">{forgetButton("recents", "recent items")}</span>
          <span key="all">{forgetButton("all", "everything above plus capsule goals and references")}</span>
        </div>
      </Panel>

      <Notice tone="info" title="Not available: screen history and meeting capture">
        Continuous screen history and meeting or system-audio capture (roadmap items 39 and 40) are gated experiments. Nothing is captured, recorded or transcribed by this app, and these controls will stay off until a consent, storage and licensing design is approved.
      </Notice>
    </div>
  );
}
