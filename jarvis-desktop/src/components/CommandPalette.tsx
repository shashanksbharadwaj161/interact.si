import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowRight, ChatCircleDots, CheckSquare, MagnifyingGlass, Note, NotePencil, Plus } from '@phosphor-icons/react';
import type { AppState } from '../shared/contracts';
import { AREAS, VIEWS, VIEW_FOR_CATEGORY, areaOf, type NavIcon, type ViewId } from '../ui/nav';
import { CATEGORY_LABELS, navResult, searchState } from '../../electron/services/search';
import type { ProductivityState } from '../../electron/services/store';
import { cx, truncate } from '../ui/util';

/**
 * Ctrl+K quick search. Typing searches saved notes, tasks, setups and checkpoints first (the same local search as the
 * Search screen, chat is left out unless you open full search), then lists matching screens and a few real actions.
 * Nothing is sent anywhere; choosing a result only navigates.
 */
export type PaletteItem = { key: string; group: 'Saved' | 'Actions' | 'Screens'; label: string; detail?: string; icon: NavIcon; go: { view: ViewId; params?: Record<string, string> } };

export function paletteItems(query: string, state: AppState | null, productivity?: ProductivityState | null): PaletteItem[] {
  const q = query.trim();
  const lower = q.toLowerCase();
  const items: PaletteItem[] = [];
  if (q && state) {
    const results = searchState(state, q, { limit: 6, productivity: productivity ?? undefined });
    for (const r of results) {
      const nav = navResult(r, productivity);
      if (!nav) continue;
      items.push({ key: `s-${r.category}-${r.id}`, group: 'Saved', label: r.title || 'Untitled', detail: `${CATEGORY_LABELS[r.category]}${r.snippet ? ` · ${truncate(r.snippet, 80)}` : ''}`, icon: r.category === 'task' ? (CheckSquare as NavIcon) : r.category === 'note' ? (Note as NavIcon) : (MagnifyingGlass as NavIcon), go: { view: VIEW_FOR_CATEGORY[nav.category], params: { item: nav.id } } });
    }
    items.push({ key: 'a-search', group: 'Actions', label: `Search everything for “${truncate(q, 40)}”`, detail: 'Opens Search with filters and chat history', icon: MagnifyingGlass as NavIcon, go: { view: 'search', params: { q } } });
    items.push({ key: 'a-ask', group: 'Actions', label: `Ask the assistant: “${truncate(q, 40)}”`, detail: 'Puts this in the message box. Nothing is sent until you press Send.', icon: ChatCircleDots as NavIcon, go: { view: 'assistant', params: { draft: q.slice(0, 200) } } });
    items.push({ key: 'a-note', group: 'Actions', label: `New note titled “${truncate(q, 40)}”`, detail: 'Opens Notes with the title filled in', icon: NotePencil as NavIcon, go: { view: 'notes', params: { new: q.slice(0, 120) } } });
  } else {
    items.push({ key: 'a-note', group: 'Actions', label: 'New note', icon: NotePencil as NavIcon, go: { view: 'notes', params: { new: '' } } });
    items.push({ key: 'a-task', group: 'Actions', label: 'New task', icon: Plus as NavIcon, go: { view: 'tasks' } });
    items.push({ key: 'a-ask', group: 'Actions', label: 'Ask the assistant', icon: ChatCircleDots as NavIcon, go: { view: 'assistant' } });
  }
  const screens = VIEWS.filter((v) => !q || v.label.toLowerCase().includes(lower) || v.blurb.toLowerCase().includes(lower) || v.group.toLowerCase().includes(lower));
  const order = new Map(AREAS.flatMap((a, ai) => a.views.map((id, vi) => [id, ai * 100 + vi] as const)));
  screens.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const v of screens.slice(0, q ? 8 : 23)) items.push({ key: `v-${v.id}`, group: 'Screens', label: v.label, detail: `${areaOf(v.id).label}${v.advanced ? ' · Advanced' : ''} · ${v.blurb}`, icon: v.icon, go: { view: v.id } });
  return items;
}

export function CommandPalette({ open, onClose, onGo, state, productivity }: { open: boolean; onClose: () => void; onGo: (view: ViewId, params?: Record<string, string>) => void; state: AppState | null; productivity?: ProductivityState | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const items = useMemo(() => paletteItems(query, state, productivity), [query, state, productivity]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery('');
      setActive(0);
      d.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const choose = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    onGo(i.go.view, i.go.params);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(items[active]);
    }
  };

  useEffect(() => {
    ref.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let lastGroup = '';
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Quick search"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => {
        opener.current?.focus?.();
        if (open) onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open && (
        <div className="palette-card">
          <div className="palette-search">
            <MagnifyingGlass size={18} aria-hidden />
            <input
              ref={inputRef}
              className="palette-input"
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-list"
              aria-activedescendant={items[active] ? `palette-${items[active].key}` : undefined}
              aria-label="Search saved items and screens"
              placeholder="Search notes, tasks, setups or screens"
              value={query}
              maxLength={200}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
            />
            <kbd>Esc</kbd>
          </div>
          <ul id="palette-list" className="palette-list" role="listbox" aria-label="Results">
            {items.map((it, i) => {
              const head = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              return (
                <li key={it.key} role="presentation">
                  {head && <p className="palette-group" role="presentation">{head}</p>}
                  <div
                    id={`palette-${it.key}`}
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    className={cx('palette-item', i === active && 'on')}
                    onMouseMove={() => setActive(i)}
                    onClick={() => choose(it)}
                  >
                    <it.icon size={18} aria-hidden />
                    <span className="palette-text">
                      <strong>{it.label}</strong>
                      {it.detail && <span className="sub">{it.detail}</span>}
                    </span>
                    {i === active && <ArrowRight size={16} aria-hidden />}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="palette-foot sub">Searches what is saved on this computer. Nothing is sent anywhere.</p>
        </div>
      )}
    </dialog>
  );
}
