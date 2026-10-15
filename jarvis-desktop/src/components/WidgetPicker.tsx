import { useId, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp } from '@phosphor-icons/react';
import { Badge, Button, IconButton, Panel } from '../ui/primitives';
import {
  addWidget,
  GRID_COLUMNS,
  moveWidget,
  packLayout,
  removeWidget,
  resetLayout,
  setWidgetWidth,
  WIDGET_DEFS,
  widgetDef,
  type EditResult,
  type WidgetDef,
  type WidgetLayout,
} from '../ui/widgets';

export type WidgetPickerProps = {
  layout: WidgetLayout;
  /** Called only with a layout that passed the widget rules. A refused edit changes nothing. */
  onLayoutChange: (next: WidgetLayout) => void;
  onClose?: () => void;
};

/**
 * Accessible editor for the dashboard layout: a checkbox per widget, a width choice, earlier/later
 * buttons and a text preview. All rules live in src/ui/widgets.ts; this component only calls them.
 * Controls are native, so keyboard use and labels come from the browser. Results are announced in a
 * polite status region.
 */
export function WidgetPicker({ layout, onLayoutChange, onClose }: WidgetPickerProps) {
  const [status, setStatus] = useState('');
  const { items, rows } = packLayout(layout);

  const apply = (edit: EditResult) => {
    setStatus(edit.message);
    if (edit.ok) onLayoutChange(edit.layout);
  };

  return (
    <Panel
      title="Dashboard widgets"
      eyebrow="Layout"
      className="widget-picker"
      actions={onClose ? <Button size="sm" variant="quiet" onClick={onClose}>Close</Button> : undefined}
    >
      <p className="field-hint">
        Choose which widgets show, their width and their order. Widgets only show data already saved in this app.
      </p>
      <ul className="widget-list" aria-label="Widgets">
        {WIDGET_DEFS.map((def) => (
          <WidgetRow
            key={def.id}
            def={def}
            layout={layout}
            onToggle={(on) => apply(on ? addWidget(layout, def.id) : removeWidget(layout, def.id))}
            onWidth={(width) => apply(setWidgetWidth(layout, def.id, width))}
            onMove={(direction) => apply(moveWidget(layout, def.id, direction))}
          />
        ))}
      </ul>
      <div className="widget-preview-head">
        <p className="field-hint">
          {items.length === 0 ? 'Preview: no widgets are shown.' : `Preview: ${items.length} ${items.length === 1 ? 'widget' : 'widgets'} in ${rows} ${rows === 1 ? 'row' : 'rows'}.`}
        </p>
      </div>
      <div
        className="widget-preview"
        aria-hidden="true"
        style={{ display: 'grid', gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))`, gridAutoRows: '24px', gap: 4 }}
      >
        {items.map((item) => {
          const style: CSSProperties = { gridColumn: `${item.x + 1} / span ${item.width}`, gridRow: `${item.y + 1} / span ${item.rows}` };
          return (
            <div key={item.kind} className="widget-preview-cell" style={style}>
              {widgetDef(item.kind)?.name}
            </div>
          );
        })}
      </div>
      <div className="widget-actions">
        <Button size="sm" variant="ghost" onClick={() => apply(resetLayout())}>
          Reset to default
        </Button>
      </div>
      <p role="status" className="field-hint">
        {status}
      </p>
    </Panel>
  );
}

type RowProps = {
  def: WidgetDef;
  layout: WidgetLayout;
  onToggle: (on: boolean) => void;
  onWidth: (width: number) => void;
  onMove: (direction: -1 | 1) => void;
};

function WidgetRow({ def, layout, onToggle, onWidth, onMove }: RowProps) {
  const id = useId();
  const descId = `${id}-d`;
  const widthId = `${id}-w`;
  const index = layout.widgets.findIndex((w) => w.kind === def.id);
  const placed = index >= 0 ? layout.widgets[index] : undefined;

  return (
    <li className="widget-row">
      <label className="widget-toggle">
        <input type="checkbox" checked={!!placed} onChange={(e) => onToggle(e.target.checked)} aria-describedby={descId} />
        <span className="widget-name">{def.name}</span>
      </label>
      <Badge tone={placed ? 'ok' : 'muted'}>{placed ? `On, ${placed.width} of ${GRID_COLUMNS} columns` : 'Hidden'}</Badge>
      <p id={descId} className="field-hint">
        {`${def.blurb} Source: ${def.source.toLowerCase()}.`}
      </p>
      {placed && (
        <div className="widget-controls">
          <label htmlFor={widthId} className="widget-width">
            Width
          </label>
          <select id={widthId} value={placed.width} onChange={(e) => onWidth(Number(e.target.value))}>
            {def.widths.map((w) => (
              <option key={w} value={w}>
                {`${w} of ${GRID_COLUMNS} columns`}
              </option>
            ))}
          </select>
          <IconButton icon={ArrowUp} label={`Move ${def.name} earlier`} disabled={index === 0} onClick={() => onMove(-1)} />
          <IconButton icon={ArrowDown} label={`Move ${def.name} later`} disabled={index === layout.widgets.length - 1} onClick={() => onMove(1)} />
        </div>
      )}
    </li>
  );
}
