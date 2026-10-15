// Home dashboard summaries and the mounted WidgetPicker. The real Home.tsx, WidgetPicker.tsx and
// src/ui/widgets.ts are bundled in memory and server-rendered with react-dom/server against a fixture
// store. Saved layouts are seeded through the same localStorage keys the app uses. Clicks are not
// simulated (no DOM library is in the lockfile), so the picker is opened through the startEditing seam
// and its edit rules are covered by the pure functions in tests/autopilot-widgets.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Inert icon placeholders, collected from the real imports so the stub cannot drift from the source.
const iconNames = new Set();
for (const dir of ['src/components', 'src/ui']) {
  for (const f of await readdir(path.join(root, dir))) {
    if (!/\.tsx?$/.test(f)) continue;
    const text = await readFile(path.join(root, dir, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (name) iconNames.add(name);
      }
    }
  }
}

// Browser globals read at render time: preferences in localStorage and the window object.
const prefs = new Map();
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (prefs.has(k) ? prefs.get(k) : null), setItem: (k, v) => void prefs.set(k, String(v)), removeItem: (k) => void prefs.delete(k) },
});
const PREF_KEY = 'jarvis.ui.dashboard.widgets';

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'home-widgets-test-entry.ts',
    loader: 'ts',
    contents: `
      export { Home, DashboardWidgets } from './src/components/Home.tsx';
      export { WidgetPicker } from './src/components/WidgetPicker.tsx';
      export * as dashboard from './src/ui/widgets.ts';
      export { TestStoreContext } from './src/ui/store.tsx';
      export { CompanionProvider } from './src/ui/companion.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  banner: { js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      // The context object is exported from the bundled copy of store.tsx only. The file on disk is not edited.
      name: 'store-context-seam',
      setup(bld) {
        bld.onLoad({ filter: /\.tsx$/ }, async (args) => {
          if (!args.path.endsWith(`${path.sep}store.tsx`) && !args.path.endsWith('/store.tsx')) return undefined;
          const text = await readFile(args.path, 'utf8');
          return { contents: `${text}\nexport { Ctx as TestStoreContext };\n`, loader: 'tsx' };
        });
      },
    },
    {
      name: 'icon-stub',
      setup(bld) {
        bld.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
      },
    },
    {
      name: 'css-stub',
      setup(bld) {
        bld.onResolve({ filter: /\.css$/ }, () => ({ path: 'style', namespace: 'css-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '' }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { Home, DashboardWidgets, WidgetPicker, dashboard: d, TestStoreContext, CompanionProvider, createElement: h, renderToStaticMarkup: render } = mod;

/* ---------- Fixtures ---------- */

const STAMP = '2026-10-10T09:00:00.000Z';
const settings = (over = {}) => ({
  onboarded: true,
  mode: 'offline',
  theme: 'graphite',
  reduceMotion: false,
  startInTray: false,
  localModel: 'qwen3.5:2b',
  localEndpoint: 'http://127.0.0.1:11434',
  cloudModel: 'example-cloud-model',
  voice: '',
  allowedRoots: [],
  approvedApps: [],
  retainDays: 30,
  ...over,
});
const baseState = () => ({
  settings: settings(),
  capsules: [{ id: 'c_1', name: 'Thesis', description: '', scene: 'deep-space', createdAt: STAMP, updatedAt: STAMP, items: [] }],
  notes: [
    { id: 'n_1', title: 'First note', body: 'alpha', tags: [], updatedAt: STAMP },
    { id: 'n_2', title: 'Second note', body: 'beta', tags: [], updatedAt: STAMP },
  ],
  tasks: [
    { id: 't_1', title: 'Task one', done: false, createdAt: STAMP },
    { id: 't_2', title: 'Task two', done: false, createdAt: STAMP },
    { id: 't_3', title: 'Task three', done: true, createdAt: STAMP },
  ],
  chat: [],
  activity: [],
});
const CAPABILITY_NAMES = { 'local-llm': 'Local model', cloud: 'Cloud model', tts: 'Read aloud', stt: 'Speech recognition', 'ui-automation': 'Windows desktop control', 'secure-storage': 'Secure key storage' };
const capabilities = (available) =>
  Object.keys(CAPABILITY_NAMES).map((id) => (available.includes(id) ? { id, name: CAPABILITY_NAMES[id], available: true } : { id, name: CAPABILITY_NAMES[id], available: false, reason: 'not here' }));
const ALL_BUT_SECURE_STORAGE = ['local-llm', 'cloud', 'tts', 'stt', 'ui-automation'];

/** Fixture store with the same shape as the real one. Bridge methods are absent, so any bridge call fails loudly. */
function makeStore(o = {}) {
  const state = o.state ?? baseState();
  return {
    api: {},
    isPreview: false,
    status: 'ready',
    loadError: null,
    state,
    settings: o.settings ?? state.settings,
    system: o.system ?? null,
    systemError: o.systemError ?? null,
    systemLoading: false,
    cloudConfigured: false,
    toasts: [],
    toast() {},
    dismissToast() {},
    reload: async () => {},
    refreshSystem: async () => {},
    refreshCloud: async () => {},
    mutate: async () => false,
    run: async () => undefined,
  };
}

/** Seeds the preference the way the app stores it: the layout text, JSON-encoded by the preference writer. */
const seed = (value) => prefs.set(PREF_KEY, JSON.stringify(value));

/** Server-renders Home, or DashboardWidgets alone, inside the same providers the app uses. */
function renderWith(el, storeOpts = {}) {
  return render(h(TestStoreContext.Provider, { value: makeStore(storeOpts) }, h(CompanionProvider, null, el)));
}
const home = () => renderWith(h(Home, { go: () => {} }));
const dashboardOnly = (props = {}, storeOpts = {}) => renderWith(h(DashboardWidgets, { source: sourceFrom(storeOpts), ...props }), storeOpts);

/** The same source Home builds: only data the store already holds. */
function sourceFrom(o = {}) {
  const store = makeStore(o);
  return {
    settings: store.settings,
    tasks: store.state.tasks,
    notes: store.state.notes,
    capsules: store.state.capsules,
    activity: store.state.activity,
    capabilities: o.system?.capabilities ?? null,
  };
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const visibleText = (s) => decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

/** Each summary card in the order it was rendered, with its inline grid placement. */
const cards = (html) => [...html.matchAll(/<section[^>]*\sdata-dash-widget="(\w+)"[^>]*\sstyle="([^"]*)"/g)].map((m) => ({ kind: m[1], style: m[2] }));
/** Visible text of one summary card, from its opening tag to its closing tag. */
function cardText(html, kind) {
  const start = html.indexOf(`data-dash-widget="${kind}"`);
  assert.notEqual(start, -1, `${kind} card is rendered`);
  const end = html.indexOf('</section>', start);
  return visibleText(html.slice(start, end));
}

/* ---------- Defaults and actual state ---------- */

test('with nothing saved, every widget shows in registry order with real counts and the default is labelled', () => {
  const html = home();
  assert.deepEqual(
    cards(html).map((c) => c.kind),
    ['tasks', 'notes', 'capsules', 'activity', 'mode', 'system'],
  );
  assert.match(html, /Showing the default layout: every widget, in its standard order and width\./);
  assert.doesNotMatch(html, /Saved widget layout was adjusted/);
});

test('default summaries are computed from the saved data and never invent a value', () => {
  const html = home();
  // Two open tasks and one done task: the done one is not counted. None has a due date.
  assert.match(cardText(html, 'tasks'), /2 open Nothing due today or overdue/);
  // Equal timestamps keep the first note as the latest, so the detail is deterministic.
  assert.match(cardText(html, 'notes'), /2 notes Latest: First note/);
  assert.match(cardText(html, 'capsules'), /1 capsule Latest: Thesis/);
  assert.match(cardText(html, 'activity'), /No activity yet Actions and events will be listed here\./);
  assert.match(cardText(html, 'mode'), /Offline mode Local model setting: qwen3\.5:2b\. Not checked here\./);
  // No system check has completed yet, so the capability count is not known and must say so.
  assert.match(cardText(html, 'system'), /Not loaded Run a system check to see capabilities\./);
});

test('the capability summary counts only what the last system check reported', () => {
  const system = { platform: 'win32', arch: 'x64', ramGB: 16, cpu: 'Test CPU', capabilities: capabilities(ALL_BUT_SECURE_STORAGE) };
  const html = renderWith(h(Home, { go: () => {} }), { system });
  assert.match(cardText(html, 'system'), /5 of 6 available 1 unavailable\. System status lists the reasons\./);
});

test('empty sources show their empty state, not a zero dressed up as data', () => {
  const state = { ...baseState(), tasks: [], notes: [], capsules: [] };
  const html = renderWith(h(DashboardWidgets, { source: sourceFrom({ state }) }), { state });
  assert.match(cardText(html, 'tasks'), /No tasks yet/);
  assert.match(cardText(html, 'notes'), /No notes yet/);
  assert.match(cardText(html, 'capsules'), /No capsules yet/);
});

test('the picker stays closed on first render and the toggle reports that with aria-expanded', () => {
  const html = dashboardOnly();
  assert.doesNotMatch(html, /class="panel widget-picker"/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>[^<]*<span>Choose widgets<\/span>/);
  assert.doesNotMatch(html, /aria-controls=/);
});

/* ---------- Saved layout ---------- */

test('a valid saved layout sets the order, widths and grid placement of the cards', () => {
  seed({ version: 1, widgets: [{ kind: 'notes', width: 12 }, { kind: 'tasks', width: 4 }, { kind: 'mode', width: 6 }] });
  const html = home();
  const placed = cards(html);
  assert.deepEqual(placed.map((c) => c.kind), ['notes', 'tasks', 'mode']);
  assert.match(placed[0].style, /--dash-col:1 \/ span 12/);
  assert.match(placed[0].style, /--dash-row:1 \/ span 2/);
  // Tasks does not fit beside a full-width note, so it starts a new row.
  assert.match(placed[1].style, /--dash-col:1 \/ span 4/);
  assert.match(placed[1].style, /--dash-row:3 \/ span 2/);
  // Mode fits beside tasks in the same row.
  assert.match(placed[2].style, /--dash-col:5 \/ span 6/);
  assert.match(placed[2].style, /--dash-row:3 \/ span 2/);
  assert.doesNotMatch(html, /data-dash-widget="capsules"/, 'widgets not in the saved layout are not shown');
  assert.match(html, /Showing a customised layout\./);
  assert.doesNotMatch(html, /Saved widget layout was adjusted/);
});

test('a saved layout that is stored as a plain object is validated the same way', () => {
  // Not written by this app's writer, so it is checked as untrusted input: unknown kind, a width that
  // is not allowed for Mode, and a duplicate entry.
  prefs.set(PREF_KEY, JSON.stringify({ version: 1, widgets: [{ kind: 'bogus' }, { kind: 'mode', width: 5 }, { kind: 'mode', width: 6 }] }));
  const html = home();
  assert.deepEqual(cards(html).map((c) => c.kind), ['mode']);
  assert.match(html, /Saved widget layout was adjusted/);
  const text = visibleText(html.slice(html.indexOf('Saved widget layout was adjusted')));
  assert.match(text, /An unknown widget was removed\./);
  assert.match(text, /Mode had a width that is not allowed; its default width is used\./);
  assert.match(text, /A duplicate Mode widget was removed\./);
});

test('unreadable or oversized saved text falls back to the default layout and says why', () => {
  prefs.set(PREF_KEY, JSON.stringify('{not json'));
  let html = home();
  assert.deepEqual(cards(html).map((c) => c.kind), ['tasks', 'notes', 'capsules', 'activity', 'mode', 'system']);
  assert.match(html, /Saved layout could not be read; the default layout is shown\./);

  prefs.set(PREF_KEY, JSON.stringify('x'.repeat(5000)));
  html = home();
  assert.equal(cards(html).length, 6);
  assert.match(html, /Saved layout is too large; the default layout is shown\./);
});

test('a saved value of an unexpected type is treated as no layout, not as a crash', () => {
  prefs.set(PREF_KEY, JSON.stringify(42));
  const html = home();
  assert.equal(cards(html).length, 6);
  assert.match(html, /Showing the default layout/);
});

test('an empty saved layout shows the empty state and still offers to choose widgets', () => {
  seed({ version: 1, widgets: [] });
  const html = home();
  assert.equal(cards(html).length, 0);
  assert.match(html, /No widgets are shown/);
  assert.match(html, /Choose widgets/);
});

/* ---------- Picker mounted in Home ---------- */

test('opening the picker mounts the existing WidgetPicker with the saved layout checked and labelled', () => {
  seed({ version: 1, widgets: [{ kind: 'tasks', width: 6 }, { kind: 'capsules', width: 4 }] });
  const html = dashboardOnly({ startEditing: true });
  assert.match(html, /class="panel widget-picker"/);
  const pickerId = (html.match(/<div id="([^"]+)"><section class="panel widget-picker"/) ?? [])[1];
  assert.ok(pickerId, 'picker wrapper has an id');
  assert.match(html, new RegExp(`<button[^>]*aria-expanded="true"[^>]*aria-controls="${pickerId.replace(/[:]/g, '\\:')}"`));

  // Each picker row: checked state and placement text come from the saved layout.
  const rows = html.split('<li class="widget-row">').slice(1);
  const byName = Object.fromEntries(rows.map((r) => [visibleText(r.match(/<span class="widget-name">([^<]*)<\/span>/)[0]), r]));
  assert.match(byName.Tasks, /<input[^>]*type="checkbox"[^>]*checked=""/);
  assert.match(byName.Tasks, /On, 6 of 12 columns/);
  assert.match(byName.Capsules, /<input[^>]*type="checkbox"[^>]*checked=""/);
  assert.match(byName.Capsules, /On, 4 of 12 columns/);
  assert.doesNotMatch(byName.Notes, /checked=""/);
  assert.match(byName.Notes, /Hidden/);
});

test('the mounted picker offers only the widths the widget allows, and a reset control', () => {
  seed({ version: 1, widgets: [{ kind: 'tasks', width: 6 }] });
  const html = dashboardOnly({ startEditing: true });
  assert.match(html, /Reset to default/);
  // Tasks allows 4, 6 and 12 columns. Mode allows only 4 and 6, and its width list is not shown while it is hidden.
  assert.match(html, /<select[^>]*><option value="4">4 of 12 columns<\/option><option value="6"[^>]*>6 of 12 columns<\/option><option value="12">12 of 12 columns<\/option><\/select>/);
  assert.equal((html.match(/<select\b/g) ?? []).length, 1, 'only placed widgets get a width choice');
});

test('every control in the dashboard has an accessible name', () => {
  seed({ version: 1, widgets: [{ kind: 'tasks', width: 6 }, { kind: 'notes', width: 12 }] });
  const html = dashboardOnly({ startEditing: true });
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length >= 6, 'toggle, close, reset and the move controls are rendered');
  for (const [, attrs, inner] of buttons) {
    const named = /\baria-label="[^"]+"/.test(attrs) || visibleText(inner).length > 0;
    assert.ok(named, `button without a name: ${attrs}`);
  }
  // Every select is labelled by a label element that points at it.
  for (const [, id] of html.matchAll(/<select id="([^"]+)"/g)) {
    assert.match(html, new RegExp(`<label[^>]*for="${id.replace(/[:]/g, '\\:')}"`), `select ${id} is labelled`);
  }
  // Layout changes are announced in a polite status region.
  assert.match(html, /<p role="status"/);
});

/* ---------- Source guards ---------- */

test('the summary path has no randomness or timing noise in what it shows', async () => {
  const text = await readFile(path.join(root, 'src/components/Home.tsx'), 'utf8');
  const start = text.indexOf('export function DashboardWidgets');
  const end = text.indexOf('export function Home(');
  assert.ok(start > 0 && end > start, 'DashboardWidgets sits before Home');
  assert.doesNotMatch(text.slice(start, end), /Math\.random|performance\.now|Date\.now/);
});

test('the widget registry the picker shows is the one the summaries read', () => {
  const kinds = d.WIDGET_KINDS;
  assert.deepEqual(d.WIDGET_DEFS.map((w) => w.id), [...kinds]);
  for (const kind of kinds) assert.ok(d.widgetDef(kind), kind);
  assert.equal(d.LAYOUT_PREF_KEY, 'dashboard.widgets');
});

test('the standalone picker and the mounted picker agree on the default layout', () => {
  const standalone = render(h(WidgetPicker, { layout: d.defaultLayout(), onLayoutChange: () => {} }));
  const mounted = dashboardOnly({ startEditing: true });
  for (const def of d.WIDGET_DEFS) assert.match(standalone, new RegExp(`<span class="widget-name">${def.name}</span>`));
  for (const def of d.WIDGET_DEFS) assert.match(mounted, new RegExp(`<span class="widget-name">${def.name}</span>`));
});
