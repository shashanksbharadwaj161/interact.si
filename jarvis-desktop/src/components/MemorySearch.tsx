import { useDeferredValue, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChatCircleDots, CheckSquare, Cube, MagnifyingGlass, Note } from '@phosphor-icons/react';
import type { AppState } from '../shared/contracts';
import { CATEGORY_LABELS, SEARCH_LIMITS, groupResults, parseQuery, searchState, type SearchCategory, type SearchResult } from '../../electron/services/search';
import { Badge, Empty, Field, Switch } from '../ui/primitives';

const ICONS = { note: Note, task: CheckSquare, capsule: Cube, chat: ChatCircleDots } satisfies Record<SearchCategory, unknown>;

/**
 * Local, read-only search across saved notes, tasks, capsules and (only when switched on) chat history.
 * Selecting a result calls onNavigate; the caller decides which view to open.
 */
export function MemorySearch({ state, onNavigate, initialQuery = '', limit }: { state: AppState; onNavigate: (result: SearchResult) => void; initialQuery?: string; limit?: number }) {
  const [query, setQuery] = useState(initialQuery.slice(0, SEARCH_LIMITS.queryChars));
  const [includeChat, setIncludeChat] = useState(false);
  const deferred = useDeferredValue(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const statusId = useId();

  const hasTerms = useMemo(() => parseQuery(deferred).length > 0, [deferred]);
  const results = useMemo(() => searchState(state, deferred, { includeChat, limit }), [state, deferred, includeChat, limit]);
  const groups = useMemo(() => groupResults(results), [results]);

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
                  {g.results.map((r) => (
                    <li key={`${r.category}:${r.id}`}>
                      <button type="button" data-result className="select-item" onClick={() => onNavigate(r)}>
                        <span className="row">
                          <Icon size={14} aria-hidden />
                          <strong>{r.title}</strong>
                          {r.relevance >= 0.9 && <Badge tone="accent">Best match</Badge>}
                        </span>
                        {r.snippet && <span className="sub">{r.snippet}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
