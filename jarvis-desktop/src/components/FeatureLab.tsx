import { useMemo, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { Badge, Empty, Notice, PageHeader, Panel, Segmented } from '../ui/primitives';
import { ROADMAP, STATUS_BLURB, STATUS_LABEL, type RoadmapStatus } from '../ui/roadmap';
import { useReady } from '../ui/store';
import { cx } from '../ui/util';

type Filter = 'all' | RoadmapStatus;
const TONE: Record<RoadmapStatus, 'accent' | 'muted' | 'warn'> = { ui: 'accent', planned: 'muted', research: 'warn' };

export function FeatureLab() {
  const { system } = useReady();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const c: Record<RoadmapStatus, number> = { ui: 0, planned: 0, research: 0 };
    ROADMAP.forEach((cat) => cat.items.forEach((i) => (c[i.status] += 1)));
    return c;
  }, []);
  const total = counts.ui + counts.planned + counts.research;

  const cats = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ROADMAP.map((cat) => ({
      ...cat,
      items: cat.items.filter((i) => (filter === 'all' || i.status === filter) && (!q || i.name.toLowerCase().includes(q) || String(i.id) === q || (i.note ?? '').toLowerCase().includes(q))),
    })).filter((c) => c.items.length > 0);
  }, [filter, query]);

  const live = system?.capabilities ?? [];

  return (
    <div className="page">
      <PageHeader eyebrow="System" title="Feature Lab" subtitle="The roadmap, with what exists and what does not. Nothing here is marked as working unless there is a screen for it." />

      <Notice title="How to read this">
        “Interface built” means a screen exists. It does not guarantee the underlying engine (model, speech, native control) is installed; the live capability report below is the source of truth. Everything else is plan or research.
      </Notice>

      <section className="stat-row" aria-label="Status totals">
        {(Object.keys(STATUS_LABEL) as RoadmapStatus[]).map((s) => (
          <button key={s} type="button" className={cx('stat', filter === s && 'on')} aria-pressed={filter === s} onClick={() => setFilter(filter === s ? 'all' : s)}>
            <span className="stat-n">{counts[s]}</span>
            <span className="stat-l">{STATUS_LABEL[s]}</span>
          </button>
        ))}
        <div className="stat static">
          <span className="stat-n">{total}</span>
          <span className="stat-l">Roadmap scopes</span>
        </div>
      </section>
      <p className="field-hint">{filter === 'all' ? 'Select a count to filter.' : STATUS_BLURB[filter]}</p>

      <Panel title="Live capability report" eyebrow="From the backend">
        {live.length === 0 ? (
          <p className="field-hint">No capabilities reported.</p>
        ) : (
          <ul className="chips">
            {live.map((c) => (
              <li key={c.id}>
                <span className={cx('chip static', c.available ? 'ok' : 'off')} title={c.reason}>
                  {c.available ? 'Available' : 'Unavailable'} · {c.name}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="search search-wide">
        <MagnifyingGlass size={16} aria-hidden />
        <label htmlFor="lab-search" className="sr-only">Search roadmap</label>
        <input id="lab-search" type="search" className="input" placeholder="Search the roadmap by name or number" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented<Filter>
          label="Status filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ui', label: STATUS_LABEL.ui },
            { value: 'planned', label: STATUS_LABEL.planned },
            { value: 'research', label: STATUS_LABEL.research },
          ]}
        />
      </div>

      {cats.length === 0 ? (
        <Empty title="No roadmap items match">Clear the search or filter.</Empty>
      ) : (
        <div className="lab-grid">
          {cats.map((cat) => (
            <Panel key={cat.name} title={cat.name} eyebrow={`${cat.items.length} scope${cat.items.length === 1 ? '' : 's'}`}>
              <ul className="lab-list">
                {cat.items.map((i) => (
                  <li key={i.id}>
                    <span className="lab-id">{i.id}</span>
                    <span className="lab-name">
                      {i.name}
                      {i.note && <span className="sub">{i.note}</span>}
                    </span>
                    <span className="lab-badges">
                      <Badge tone={TONE[i.status]}>{STATUS_LABEL[i.status]}</Badge>
                      <Badge>{i.tier}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
