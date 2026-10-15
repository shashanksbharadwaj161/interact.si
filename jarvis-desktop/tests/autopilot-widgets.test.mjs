import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the pure widget module and the picker component in memory (no files are written).
// The picker is server-rendered with react-dom/server, so no DOM is needed. Edit wiring is covered
// by the pure edit functions plus the markup assertions; a live click test needs a DOM and is not run here.
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'widgets-test-entry.ts',
    loader: 'ts',
    contents: `
      export * as widgets from './src/ui/widgets.ts';
      export { WidgetPicker } from './src/components/WidgetPicker.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // react-dom/server is CommonJS and calls require(); give the bundle a real require for Node builtins.
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      // Icons are not needed to check markup and attributes; inert placeholders keep the bundle small.
      name: 'icon-stub',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({
          contents: ['ArrowDown', 'ArrowUp', 'CircleNotch', 'Info', 'Warning', 'WarningCircle'].map((n) => `export const ${n} = () => null;`).join('\n'),
        }));
      },
    },
  ],
  logLevel: 'silent',
});
const code = out.outputFiles[0].text;
const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const { widgets: w, WidgetPicker, createElement, renderToStaticMarkup } = mod;
const render = (props) => renderToStaticMarkup(createElement(WidgetPicker, props));

const TODAY = '2026-10-14';
const kinds = (layout) => layout.widgets.map((p) => p.kind);

test('module source is pure: no DOM, storage, network or Electron references', async () => {
  const text = await readFile(path.join(root, 'src/ui/widgets.ts'), 'utf8');
  assert.ok(!/\bdocument\b|\bwindow\b|localStorage|\bfetch\(|XMLHttpRequest|from ['"]electron['"]|from ['"]react['"]/.test(text));
});

test('registry is consistent: unique ids, defaults allowed, sane sizes and rows', () => {
  assert.deepEqual([...w.WIDGET_KINDS], w.WIDGET_DEFS.map((d) => d.id));
  assert.equal(new Set(w.WIDGET_KINDS).size, w.WIDGET_KINDS.length);
  assert.equal(w.MAX_WIDGETS, w.WIDGET_KINDS.length);
  for (const d of w.WIDGET_DEFS) {
    assert.ok(d.name.length > 0 && d.name.length <= 24, d.name);
    assert.ok(d.blurb.length > 0 && d.blurb.length <= 140, d.id);
    assert.ok(d.source.length > 0, d.id);
    assert.ok(d.widths.includes(d.defaultWidth), `${d.id} default width must be allowed`);
    assert.deepEqual([...d.widths], [...new Set(d.widths)].sort((a, b) => a - b), `${d.id} widths sorted and unique`);
    for (const x of d.widths) assert.ok(Number.isInteger(x) && x >= 1 && x <= w.GRID_COLUMNS, `${d.id} width ${x}`);
    assert.ok(Number.isInteger(d.rows) && d.rows >= 1 && d.rows <= 6, `${d.id} rows`);
  }
});

test('default layout is valid, uses every widget once and round-trips unchanged', () => {
  const d = w.defaultLayout();
  assert.deepEqual(d.widgets.map((p) => p.kind).sort(), [...w.WIDGET_KINDS].sort());
  const { layout, issues } = w.normalizeLayout(d);
  assert.deepEqual(issues, []);
  assert.deepEqual(layout, d);
  // Fresh object each call, so callers cannot mutate a shared default.
  assert.notEqual(w.defaultLayout(), w.defaultLayout());
});

test('normalizeLayout: missing input gives the default silently; wrong shapes give the default with one issue', () => {
  assert.deepEqual(w.normalizeLayout(undefined), { layout: w.defaultLayout(), issues: [] });
  assert.deepEqual(w.normalizeLayout(null), { layout: w.defaultLayout(), issues: [] });
  for (const bad of ['text', 42, [], { widgets: [] }, { version: 2, widgets: [] }, { version: 1, widgets: 'x' }]) {
    const r = w.normalizeLayout(bad);
    assert.deepEqual(r.layout, w.defaultLayout(), JSON.stringify(bad));
    assert.equal(r.issues.length, 1, JSON.stringify(bad));
  }
});

test('normalizeLayout drops unknown kinds, duplicates and extra fields, and reports each', () => {
  const r = w.normalizeLayout({
    version: 1,
    widgets: [
      { kind: 'notes', width: 6, x: 99, onclick: 'alert(1)' },
      { kind: 'weather', width: 6 },
      { kind: 'notes', width: 4 },
      null,
      { kind: 'tasks' },
    ],
  });
  assert.deepEqual(r.layout.widgets, [
    { kind: 'notes', width: 6 },
    { kind: 'tasks', width: w.widgetDef('tasks').defaultWidth },
  ]);
  assert.ok(r.issues.some((m) => /unknown/.test(m)));
  assert.ok(r.issues.some((m) => /duplicate Notes/.test(m)));
  assert.ok(r.layout.widgets.every((p) => Object.keys(p).sort().join() === 'kind,width'));
});

test('normalizeLayout replaces disallowed widths with the default and says so', () => {
  const r = w.normalizeLayout({ version: 1, widgets: [{ kind: 'activity', width: 4 }, { kind: 'mode', width: '6' }, { kind: 'mode', width: 6 }] });
  assert.deepEqual(r.layout.widgets, [
    { kind: 'activity', width: w.widgetDef('activity').defaultWidth },
    { kind: 'mode', width: 6 },
  ]);
  assert.equal(r.issues.filter((m) => /width/.test(m)).length, 2);
});

test('normalizeLayout bounds the work and the number of widgets and issues kept', () => {
  const flood = Array.from({ length: 5000 }, (_, i) => ({ kind: i % 2 ? 'tasks' : 'notes', width: 6 }));
  const r = w.normalizeLayout({ version: 1, widgets: flood });
  assert.deepEqual(kinds(r.layout), ['notes', 'tasks']);
  assert.ok(r.issues.length <= 5);
  const unknown = w.normalizeLayout({ version: 1, widgets: Array.from({ length: 500 }, () => ({ kind: 'nope' })) });
  assert.deepEqual(unknown.layout.widgets, []);
  assert.ok(unknown.issues.length <= 5);
});

test('prototype-style keys in saved JSON are ignored, not merged into the layout', () => {
  const raw = '{"version":1,"__proto__":{"polluted":true},"widgets":[{"kind":"notes","width":6,"__proto__":{"x":1}}]}';
  const r = w.parseLayout(raw);
  assert.deepEqual(r.layout.widgets, [{ kind: 'notes', width: 6 }]);
  assert.equal({}.polluted, undefined);
});

test('parseLayout: empty, oversized and unreadable text fall back to the default with a clear issue', () => {
  assert.deepEqual(w.parseLayout(null), { layout: w.defaultLayout(), issues: [] });
  assert.deepEqual(w.parseLayout(''), { layout: w.defaultLayout(), issues: [] });
  const big = w.parseLayout('x'.repeat(w.MAX_LAYOUT_JSON + 1));
  assert.deepEqual(big.layout, w.defaultLayout());
  assert.match(big.issues[0], /too large/);
  const broken = w.parseLayout('{"version":1,');
  assert.deepEqual(broken.layout, w.defaultLayout());
  assert.match(broken.issues[0], /could not be read/);
});

test('serializeLayout output parses back to the same layout and invalid input is stored in validated form', () => {
  const layout = { version: 1, widgets: [{ kind: 'system', width: 12 }, { kind: 'tasks', width: 4 }] };
  const text = w.serializeLayout(layout);
  assert.equal(typeof text, 'string');
  assert.ok(text.length <= w.MAX_LAYOUT_JSON);
  assert.deepEqual(w.parseLayout(text).layout, layout);
  assert.deepEqual(JSON.parse(w.serializeLayout({ version: 1, widgets: [{ kind: 'bogus', width: 6 }] })), { version: 1, widgets: [] });
});

test('addWidget appends with the default width and refuses duplicates and unknown kinds without changing the input', () => {
  const base = { version: 1, widgets: [{ kind: 'tasks', width: 4 }] };
  const snapshot = JSON.stringify(base);
  const added = w.addWidget(base, 'notes');
  assert.equal(added.ok, true);
  assert.deepEqual(added.layout.widgets, [{ kind: 'tasks', width: 4 }, { kind: 'notes', width: w.widgetDef('notes').defaultWidth }]);
  assert.equal(added.message, 'Added Notes.');

  const dup = w.addWidget(base, 'tasks');
  assert.equal(dup.ok, false);
  assert.equal(dup.layout, base);
  assert.equal(dup.message, 'Already on the dashboard: Tasks.');

  const unknown = w.addWidget(base, 'weather');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.layout, base);
  assert.equal(JSON.stringify(base), snapshot, 'input is never mutated');
});

test('addWidget refuses to exceed the widget limit', () => {
  const full = { version: 1, widgets: w.WIDGET_KINDS.map((kind) => ({ kind, width: w.widgetDef(kind).defaultWidth })) };
  const extra = w.addWidget(full, 'tasks');
  assert.equal(extra.ok, false);
  assert.equal(extra.layout.widgets.length, w.MAX_WIDGETS);
});

test('removeWidget removes exactly one kind and refuses missing ones', () => {
  const base = w.defaultLayout();
  const removed = w.removeWidget(base, 'notes');
  assert.equal(removed.ok, true);
  assert.deepEqual(kinds(removed.layout), kinds(base).filter((k) => k !== 'notes'));
  const missing = w.removeWidget(removed.layout, 'notes');
  assert.equal(missing.ok, false);
  assert.equal(missing.layout, removed.layout);
});

test('setWidgetWidth accepts only allowed widths for that kind', () => {
  const base = { version: 1, widgets: [{ kind: 'activity', width: 6 }] };
  const ok = w.setWidgetWidth(base, 'activity', 12);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.layout.widgets, [{ kind: 'activity', width: 12 }]);
  const bad = w.setWidgetWidth(base, 'activity', 4);
  assert.equal(bad.ok, false);
  assert.equal(bad.layout, base);
  assert.match(bad.message, /6, 12/);
  const absent = w.setWidgetWidth(base, 'mode', 4);
  assert.equal(absent.ok, false);
  assert.equal(absent.message, 'Not on the dashboard: Mode.');
});

test('moveWidget swaps neighbours and refuses to move past either end', () => {
  const base = { version: 1, widgets: [{ kind: 'tasks', width: 6 }, { kind: 'notes', width: 6 }, { kind: 'mode', width: 6 }] };
  const later = w.moveWidget(base, 'tasks', 1);
  assert.equal(later.ok, true);
  assert.deepEqual(kinds(later.layout), ['notes', 'tasks', 'mode']);
  const earlier = w.moveWidget(later.layout, 'mode', -1);
  assert.deepEqual(kinds(earlier.layout), ['notes', 'mode', 'tasks']);
  const first = w.moveWidget(base, 'tasks', -1);
  assert.equal(first.ok, false);
  assert.equal(first.layout, base);
  assert.equal(first.message, 'Already first: Tasks.');
  const last = w.moveWidget(base, 'mode', 1);
  assert.equal(last.ok, false);
  assert.equal(last.message, 'Already last: Mode.');
});

test('resetLayout returns the default layout', () => {
  const r = w.resetLayout();
  assert.equal(r.ok, true);
  assert.deepEqual(r.layout, w.defaultLayout());
});

test('packLayout places widgets left to right and wraps when a span does not fit', () => {
  const layout = {
    version: 1,
    widgets: [
      { kind: 'tasks', width: 4 }, // 2 rows tall
      { kind: 'notes', width: 6 }, // 2 rows tall
      { kind: 'capsules', width: 4 }, // 4 + 6 + 4 > 12, so it wraps to a new row
      { kind: 'mode', width: 4 },
    ],
  };
  const { items, rows } = w.packLayout(layout);
  assert.deepEqual(items.map((i) => [i.kind, i.x, i.y]), [
    ['tasks', 0, 0],
    ['notes', 4, 0],
    ['capsules', 0, 2],
    ['mode', 4, 2],
  ]);
  assert.equal(rows, 4);
});

test('packLayout row height is the tallest widget in that row', () => {
  const { items, rows } = w.packLayout({ version: 1, widgets: [{ kind: 'activity', width: 6 }, { kind: 'mode', width: 6 }, { kind: 'tasks', width: 12 }] });
  assert.deepEqual(items.map((i) => i.y), [0, 0, 3]);
  assert.equal(rows, 3 + 2);
});

test('packLayout never overlaps and never leaves the grid, across many random edits', () => {
  // Deterministic LCG so a failure can be reproduced.
  let seed = 20261014;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  let layout = w.defaultLayout();
  for (let step = 0; step < 400; step += 1) {
    const kind = w.WIDGET_KINDS[rnd(w.WIDGET_KINDS.length)];
    const op = rnd(5);
    let r;
    if (op === 0) r = w.addWidget(layout, kind);
    else if (op === 1) r = w.removeWidget(layout, kind);
    else if (op === 2) r = w.setWidgetWidth(layout, kind, w.widgetDef(kind).widths[rnd(w.widgetDef(kind).widths.length)]);
    else if (op === 3) r = w.moveWidget(layout, kind, rnd(2) ? 1 : -1);
    else r = w.resetLayout();
    if (r.ok) layout = r.layout;
    else assert.equal(r.layout, layout, 'refused edits keep the same layout');

    const { items, rows } = w.packLayout(layout);
    const cells = new Set();
    for (const it of items) {
      assert.ok(it.x >= 0 && it.x + it.width <= w.GRID_COLUMNS, `in bounds at step ${step}`);
      for (let dy = 0; dy < it.rows; dy += 1) {
        for (let dx = 0; dx < it.width; dx += 1) {
          const key = `${it.x + dx},${it.y + dy}`;
          assert.ok(!cells.has(key), `no overlap at step ${step}`);
          cells.add(key);
        }
      }
      assert.ok(it.y + it.rows <= rows);
    }
  }
});

test('summarizeWidget tasks: counts open tasks and due-today-or-overdue, ignoring done ones', () => {
  const tasks = [
    { id: '1', title: 'a', done: false, due: '2026-10-13', createdAt: '' }, // overdue
    { id: '2', title: 'b', done: false, due: '2026-10-14', createdAt: '' }, // today
    { id: '3', title: 'c', done: false, due: '2026-10-20', createdAt: '' }, // upcoming
    { id: '4', title: 'd', done: false, createdAt: '' }, // no date
    { id: '5', title: 'e', done: true, due: '2026-10-01', createdAt: '' }, // done, excluded
  ];
  assert.deepEqual(w.summarizeWidget('tasks', { tasks }, TODAY), { state: 'ready', value: '4 open', detail: '2 due today or overdue' });
  assert.equal(w.summarizeWidget('tasks', { tasks: [] }, TODAY).state, 'empty');
  assert.equal(w.summarizeWidget('tasks', { tasks: [{ id: '6', title: 'x', done: true, createdAt: '' }] }, TODAY).detail, 'Nothing due today or overdue');
});

test('summarizeWidget notes and capsules: count plus the most recently updated name, with a fallback', () => {
  const notes = [
    { id: '1', title: 'Older', body: '', tags: [], updatedAt: '2026-10-01T10:00:00.000Z' },
    { id: '2', title: '  ', body: '', tags: [], updatedAt: '2026-10-10T10:00:00.000Z' },
  ];
  assert.deepEqual(w.summarizeWidget('notes', { notes }, TODAY), { state: 'ready', value: '2 notes', detail: 'Latest: Untitled note' });
  const one = w.summarizeWidget('notes', { notes: [notes[0]] }, TODAY);
  assert.equal(one.value, '1 note');
  assert.equal(one.detail, 'Latest: Older');
  assert.equal(w.summarizeWidget('notes', { notes: [] }, TODAY).state, 'empty');

  const capsules = [{ id: 'c', name: 'Thesis', description: '', scene: 'graphite', createdAt: '', updatedAt: '2026-10-02T00:00:00.000Z', items: [] }];
  assert.deepEqual(w.summarizeWidget('capsules', { capsules }, TODAY), { state: 'ready', value: '1 capsule', detail: 'Latest: Thesis' });
});

test('summarizeWidget activity: newest entry by timestamp, bounded text', () => {
  const activity = [
    { id: 'a', at: '2026-10-01T09:00:00.000Z', kind: 'x', summary: 'Earlier' },
    { id: 'b', at: '2026-10-03T09:00:00.000Z', kind: 'x', summary: 'x'.repeat(200) },
  ];
  const s = w.summarizeWidget('activity', { activity }, TODAY);
  assert.equal(s.state, 'ready');
  assert.equal(s.value, '2 entries');
  assert.equal(s.detail.length, 80);
  assert.ok(s.detail.endsWith('…'));
  assert.equal(w.summarizeWidget('activity', { activity: [] }, TODAY).state, 'empty');
});

test('summarizeWidget mode: reports the saved setting and says the model was not checked', () => {
  const settings = { onboarded: true, mode: 'offline', localModel: 'qwen3.5:2b' };
  assert.deepEqual(w.summarizeWidget('mode', { settings }, TODAY), {
    state: 'ready',
    value: 'Offline mode',
    detail: 'Local model setting: qwen3.5:2b. Not checked here.',
  });
  const online = w.summarizeWidget('mode', { settings: { onboarded: false, mode: 'online', localModel: '' } }, TODAY);
  assert.equal(online.value, 'Online mode');
  assert.equal(online.detail, 'Setup is not finished.');
});

test('summarizeWidget system: counts available capabilities from the last check only', () => {
  const capabilities = [
    { id: 'tts', name: 'Speech', available: true },
    { id: 'ocr', name: 'OCR', available: false, reason: 'Not implemented' },
    { id: 'cloud', name: 'Cloud', available: false, reason: 'Off' },
  ];
  assert.deepEqual(w.summarizeWidget('system', { capabilities }, TODAY), {
    state: 'ready',
    value: '1 of 3 available',
    detail: '2 unavailable. System status lists the reasons.',
  });
  assert.equal(w.summarizeWidget('system', { capabilities: [] }, TODAY).state, 'empty');
});

test('summarizeWidget never invents data: a missing source is reported as not loaded', () => {
  for (const kind of w.WIDGET_KINDS) {
    const s = w.summarizeWidget(kind, {}, TODAY);
    assert.equal(s.state, 'unavailable', kind);
    assert.equal(s.value, 'Not loaded', kind);
    assert.ok(s.detail.length > 0, kind);
  }
  assert.equal(w.summarizeWidget('system', { capabilities: null }, TODAY).state, 'unavailable');
});

test('picker markup: one labelled checkbox per widget, state shown in text, and a polite status region', () => {
  const layout = { version: 1, widgets: [{ kind: 'tasks', width: 6 }, { kind: 'mode', width: 4 }] };
  const html = render({ layout, onLayoutChange: () => {} });
  assert.match(html, /Dashboard widgets/);
  const checkboxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
  assert.equal(checkboxes.length, w.WIDGET_KINDS.length);
  assert.equal(checkboxes.filter((c) => /checked/.test(c)).length, 2);
  for (const def of w.WIDGET_DEFS) assert.match(html, new RegExp(`<span class="widget-name">${def.name}</span>`));
  assert.match(html, /On, 6 of 12 columns/);
  assert.match(html, /Hidden/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-hidden="true"/);
});

test('picker markup: controls exist only for placed widgets, and edge moves are disabled', () => {
  const layout = { version: 1, widgets: [{ kind: 'tasks', width: 6 }, { kind: 'notes', width: 6 }] };
  const html = render({ layout, onLayoutChange: () => {} });
  assert.match(html, /aria-label="Move Tasks earlier"[^>]*disabled/);
  assert.match(html, /aria-label="Move Notes later"[^>]*disabled/);
  assert.match(html, /aria-label="Move Tasks later"(?![^>]*disabled)/);
  assert.doesNotMatch(html, /aria-label="Move Mode earlier"/);
  assert.doesNotMatch(html, /aria-label="Move Notes earlier"[^>]*disabled/);
  // Width choices are offered only for placed widgets and come from the registry.
  assert.equal((html.match(/<select/g) ?? []).length, 2);
  assert.match(html, /<option value="4">4 of 12 columns<\/option>/);
});

test('picker markup: preview lists placed widgets with explicit grid spans and nothing else', () => {
  const layout = { version: 1, widgets: [{ kind: 'tasks', width: 4 }, { kind: 'notes', width: 6 }] };
  const html = render({ layout, onLayoutChange: () => {} });
  assert.match(html, /grid-column:1 \/ span 4/);
  assert.match(html, /grid-column:5 \/ span 6/);
  assert.match(html, /Preview: 2 widgets in 2 rows\./);
  const empty = render({ layout: { version: 1, widgets: [] }, onLayoutChange: () => {} });
  assert.match(empty, /Preview: no widgets are shown\./);
});

test('picker markup: close action only when a handler is supplied', () => {
  const layout = w.defaultLayout();
  assert.doesNotMatch(render({ layout, onLayoutChange: () => {} }), />Close</);
  assert.match(render({ layout, onLayoutChange: () => {}, onClose: () => {} }), />Close</);
});
