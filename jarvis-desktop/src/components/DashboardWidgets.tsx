import { useId, useState, type CSSProperties } from 'react';
import { SquaresFour } from '@phosphor-icons/react';
import { WidgetPicker } from './WidgetPicker';
import { Button, Empty, Notice, Panel } from '../ui/primitives';
import { usePref } from '../ui/prefs';
import * as dashboard from '../ui/widgets';

/**
 * Summary cards placed on the same 12-column grid that the picker previews. The layout is read from
 * the saved preference on every render and validated there; a saved value that does not pass is shown
 * as the default and the reason is reported above the grid. Card text comes from summarizeWidget, so a
 * source that has not loaded shows as 'Not loaded' instead of a made-up number.
 * `startEditing` only sets the first render; Home leaves the picker closed until the user opens it.
 */
export function DashboardWidgets({ source, startEditing = false }: { source: dashboard.WidgetSource; startEditing?: boolean }) {
  const [stored, setStored] = usePref<unknown>(dashboard.LAYOUT_PREF_KEY, null);
  const [editing, setEditing] = useState(startEditing);
  const pickerId = useId();
  const { layout, issues } = typeof stored === 'string' ? dashboard.parseLayout(stored) : dashboard.normalizeLayout(stored);
  const { items } = dashboard.packLayout(layout);
  const isDefault = dashboard.serializeLayout(layout) === dashboard.serializeLayout(dashboard.defaultLayout());
  const save = (next: dashboard.WidgetLayout) => setStored(dashboard.serializeLayout(next));

  return (
    <>
      <Panel
        title="At a glance"
        eyebrow="Dashboard widgets"
        actions={
          <Button size="sm" variant="quiet" icon={SquaresFour} aria-expanded={editing} aria-controls={editing ? pickerId : undefined} onClick={() => setEditing((open) => !open)}>
            {editing ? 'Done with widgets' : 'Choose widgets'}
          </Button>
        }
      >
        {issues.length > 0 && (
          <Notice tone="warn" title="Saved widget layout was adjusted">
            {issues.join(' ')}
          </Notice>
        )}
        {items.length === 0 ? (
          <Empty icon={SquaresFour} title="No widgets are shown">
            Choose widgets to see summaries of your saved tasks, notes and capsules here.
          </Empty>
        ) : (
          <div className="dash-wrap">
          <div className="dash-grid">
            {items.map((item) => {
              const def = dashboard.widgetDef(item.kind);
              if (!def) return null;
              const summary = dashboard.summarizeWidget(item.kind, source);
              const titleId = `${pickerId}-${item.kind}`;
              return (
                <section
                  key={item.kind}
                  className="panel dash-card"
                  data-dash-widget={item.kind}
                  aria-labelledby={titleId}
                  style={dashboard.widgetPlacement(item) as CSSProperties}
                >
                  <h3 id={titleId} className="widget-name">
                    {def.name}
                  </h3>
                  <p className="big-line">{summary.value}</p>
                  <p className="field-hint">{summary.detail}</p>
                </section>
              );
            })}
          </div>
          </div>
        )}
        <p className="field-hint">
          {isDefault
            ? 'Showing the default layout: every widget, in its standard order and width.'
            : 'Showing a customised layout. Choose widgets to change it or to go back to the default.'}
        </p>
      </Panel>
      {editing && (
        <div id={pickerId}>
          <WidgetPicker layout={layout} onLayoutChange={save} onClose={() => setEditing(false)} />
        </div>
      )}
    </>
  );
}
