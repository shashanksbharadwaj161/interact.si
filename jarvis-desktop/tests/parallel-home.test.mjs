// Home cockpit (parallel home module): the pure cockpit model, the server-rendered screen against a
// fixture store, the ambient backdrop policy, and source/style guards for the owned files.
// The real Home.tsx and SceneBackdrop.tsx are bundled in memory with esbuild and rendered with
// react-dom/server, the same way tests/milestone-home-widgets.test.mjs does it. Clicks are not simulated
// (no DOM library is in the lockfile); every decision that drives the markup is a pure function tested here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

// Inert icon placeholders, collected from the real imports so the stub cannot drift from the source.
const iconNames = new Set();
for (const dir of ['src/components', 'src/ui']) {
  for (const f of await readdir(path.join(root, dir))) {
    if (!/\.tsx?$/.test(f)) continue;
    const text = await read(`${dir}/${f}`);
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (name) iconNames.add(name);
      }
    }
  }
}

const prefs = new Map();
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (prefs.has(k) ? prefs.get(k) : null), setItem: (k, v) => void prefs.set(k, String(v)), removeItem: (k) => void prefs.delete(k) },
});

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'parallel-home-test-entry.ts',
    loader: 'ts',
    contents: `
      export * as home from './src/components/Home.tsx';
      export { SceneBackdrop, ambientMode } from './src/components/SceneBackdrop.tsx';
      export { TestStoreContext } from './src/ui/store.tsx';
      export { CompanionProvider } from './src/ui/companion.tsx';
      export { localDateKey } from './src/ui/util.ts';
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
const { home, SceneBackdrop, ambientMode, TestStoreContext, CompanionProvider, localDateKey, createElement: h, renderToStaticMarkup: render } = mod;

/* ---------- Fixtures ---------- */

const TODAY = '2026-10-15';
const NOW = new Date('2026-10-15T12:00:00').getTime();
const STAMP = '2026-10-10T09:00:00.000Z';
const task = (id, title, due, over = {}) => ({ id, title, done: false, createdAt: STAMP, ...(due ? { due } : {}), ...over });
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
const baseState = (over = {}) => ({
  settings: settings(),
  capsules: [{ id: 'c_1', name: 'Thesis', description: '', scene: 'deep-space', createdAt: STAMP, updatedAt: STAMP, items: [{ kind: 'url', target: 'https://example.test', label: 'Site' }] }],
  notes: [
    { id: 'n_1', title: 'First note', body: 'alpha', tags: [], updatedAt: '2026-10-12T09:00:00.000Z' },
    { id: 'n_2', title: 'Second note', body: 'beta', tags: [], updatedAt: STAMP },
  ],
  tasks: [task('t_1', 'Task one'), task('t_2', 'Task two'), task('t_3', 'Task three', undefined, { done: true })],
  chat: [],
  activity: [],
  ...over,
});
const CAP = (id, name, available, reason) => ({ id, name, available, ...(reason ? { reason } : {}) });
const allCaps = [CAP('local-llm', 'Local model', true), CAP('cloud', 'Cloud model', true), CAP('tts', 'Read aloud', true), CAP('stt', 'Speech recognition', true), CAP('ui-automation', 'Windows desktop control', true), CAP('secure-storage', 'Secure key storage', true)];
const someCaps = allCaps.map((c) => (c.id === 'stt' || c.id === 'secure-storage' ? { ...c, available: false, reason: 'not here' } : c));

const cockpit = (over = {}) => ({
  tasks: [],
  notes: [],
  capsules: [],
  chat: [],
  activity: [],
  capabilities: allCaps,
  systemError: null,
  systemLoading: false,
  readiness: 'ready',
  mode: 'offline',
  today: TODAY,
  now: NOW,
  ...over,
});

function makeStore(o = {}) {
  const state = o.state ?? baseState();
  return {
    api: o.api ?? {},
    isPreview: false,
    status: 'ready',
    loadError: null,
    state,
    settings: o.settings ?? state.settings,
    system: o.system ?? null,
    systemError: o.systemError ?? null,
    systemLoading: o.systemLoading ?? false,
    cloudConfigured: o.cloudConfigured ?? false,
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
const renderHome = (storeOpts = {}) => render(h(TestStoreContext.Provider, { value: makeStore(storeOpts) }, h(CompanionProvider, null, h(home.Home, { go: () => {} }))));
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const text = (s) => decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
/** Markup of one home widget, by its data-widget id. */
function widget(html, id) {
  const start = html.indexOf(`data-widget="${id}"`);
  assert.notEqual(start, -1, `${id} widget is rendered`);
  const next = html.indexOf('data-widget="', start + 10);
  return html.slice(start, next === -1 ? undefined : next);
}

/* ---------- Pure model: triage and due phrasing ---------- */

test('triage buckets open tasks by due date and keeps done tasks out of every bucket', () => {
  const t = home.triageTasks(
    [task('a', 'Late', '2026-10-01'), task('b', 'Now', TODAY), task('c', 'Soon', '2026-10-20'), task('d', 'Later', '2026-11-30'), task('e', 'Someday'), task('f', 'Done', '2026-10-01', { done: true }), task('g', 'Later still', '2026-10-03')],
    TODAY,
  );
  assert.deepEqual(t.overdue.map((x) => x.id), ['a', 'g'], 'overdue sorted oldest first');
  assert.deepEqual(t.today.map((x) => x.id), ['b']);
  assert.deepEqual(t.week.map((x) => x.id), ['c']);
  assert.deepEqual(t.later.map((x) => x.id), ['d']);
  assert.deepEqual(t.undated.map((x) => x.id), ['e']);
  assert.equal(t.open, 6);
  assert.equal(t.done, 1);
});

test('due labels are relative to the supplied day and never read the clock', () => {
  assert.equal(home.dueLabel({ due: TODAY }, TODAY), 'Today');
  assert.equal(home.dueLabel({ due: '2026-10-16' }, TODAY), 'Tomorrow');
  assert.equal(home.dueLabel({ due: '2026-10-18' }, TODAY), 'In 3 days');
  assert.equal(home.dueLabel({ due: '2026-10-14' }, TODAY), 'Due yesterday');
  assert.match(home.dueLabel({ due: '2026-10-02' }, TODAY), /^Overdue since /);
  assert.equal(home.dueLabel({}, TODAY), 'No date');
  assert.equal(home.dayDiff('2026-10-15', '2026-10-22'), 7);
  assert.equal(home.dayDiff('2026-13-99', TODAY), null);
  assert.equal(home.captureDueKey('none', TODAY), '');
  assert.equal(home.captureDueKey('today', TODAY), TODAY);
  assert.equal(home.captureDueKey('tomorrow', TODAY), '2026-10-16');
  assert.equal(home.captureDueKey('tomorrow', '2026-12-31'), '2027-01-01');
  assert.equal(home.captureDueKey('tomorrow', 'nope'), '');
});

/* ---------- Pure model: status hierarchy ---------- */

test('status puts attention items first, notices next, and the all-clear only when nothing else applies', () => {
  const clear = home.statusHierarchy(cockpit());
  assert.deepEqual(clear.map((s) => s.id), ['all-clear']);
  assert.equal(clear[0].tier, 'ok');
  assert.equal(clear[0].detail, 'No open tasks and nothing needs attention.');

  const busy = home.statusHierarchy(
    cockpit({
      tasks: [task('a', 'Late', '2026-10-01'), task('b', 'Now', TODAY), task('c', 'Soon', '2026-10-20')],
      capabilities: someCaps,
      readiness: 'unknown',
      systemError: null,
    }),
  );
  assert.deepEqual(busy.map((s) => s.id), ['overdue', 'model-unknown', 'due-today', 'capabilities']);
  assert.deepEqual(busy.map((s) => s.tier), ['attention', 'notice', 'notice', 'notice']);
  assert.equal(busy[0].title, '1 task is overdue');
  assert.equal(busy[0].detail, 'Oldest: Late.');
  assert.equal(busy[3].title, '2 of 6 capabilities unavailable');
  assert.equal(busy[3].detail, 'Speech recognition, Secure key storage.');
  assert.ok(busy.every((s) => !s.id.includes('all-clear')));
});

test('a failed system check and a blocked model outrank overdue work, and an unchecked system is only a notice', () => {
  const s = home.statusHierarchy(cockpit({ systemError: 'bridge missing', readiness: 'blocked', mode: 'online', tasks: [task('a', 'Late', '2026-10-01')], capabilities: null }));
  assert.deepEqual(s.map((x) => x.id), ['system-error', 'model-blocked', 'overdue']);
  assert.equal(s[0].detail, 'bridge missing');
  assert.equal(s[1].detail, 'Online mode needs a model name and a saved key.');
  assert.deepEqual(s[1].params, { q: 'model' });

  const unchecked = home.statusHierarchy(cockpit({ capabilities: null }));
  assert.deepEqual(unchecked.map((x) => x.id), ['system-unchecked']);
  assert.equal(unchecked[0].tier, 'notice');
  const loading = home.statusHierarchy(cockpit({ capabilities: null, systemLoading: true }));
  assert.deepEqual(loading.map((x) => x.id), ['all-clear'], 'a check in flight is not reported as a problem');
});

test('the all-clear detail counts open work truthfully', () => {
  const s = home.statusHierarchy(cockpit({ tasks: [task('a', 'A'), task('b', 'B', '2026-11-01')] }));
  assert.equal(s[0].detail, '2 open tasks, none overdue or due today.');
});

/* ---------- Pure model: quick actions ---------- */

test('quick actions are navigation only, adapt to saved data, and never exceed six', () => {
  const empty = home.quickActions(cockpit());
  assert.deepEqual(empty.map((a) => a.id), ['ask', 'new-capsule', 'tasks', 'search']);
  assert.equal(empty[0].hint, 'Offline mode: answers come from the local model.');

  const full = home.quickActions(
    cockpit({
      chat: [{ id: 'm1', role: 'assistant', text: 'Here is   the plan', createdAt: '2026-10-15T11:30:00', source: 'local' }],
      capsules: [{ id: 'c_old', name: 'Old', description: '', scene: 'dusk', createdAt: STAMP, updatedAt: '2026-10-01T00:00:00.000Z', items: [] }, { id: 'c_new', name: 'A very long capsule name that gets cut', description: '', scene: 'dusk', createdAt: STAMP, updatedAt: '2026-10-14T00:00:00.000Z', items: [{ kind: 'file', target: 'x', label: 'x' }] }],
      notes: [{ id: 'n_1', title: '', body: '', tags: [], updatedAt: STAMP }],
      capabilities: someCaps,
      readiness: 'blocked',
    }),
  );
  assert.deepEqual(full.map((a) => a.id), ['setup-model', 'continue-chat', 'reopen-capsule', 'latest-note', 'tasks', 'review-capabilities']);
  assert.equal(full.length, 6, 'search is dropped once six actions exist');
  assert.equal(full[1].hint, 'Last message 30 min ago: Here is the plan');
  assert.deepEqual(full[2].params, { item: 'c_new' }, 'the newest capsule wins');
  assert.equal(full[2].hint, '1 item, changed 1 d ago.');
  assert.equal(full[3].label, 'Open Untitled');
  assert.equal(full[5].hint, '2 unavailable on this computer.');
  const views = new Set(['assistant', 'capsules', 'notes', 'tasks', 'status', 'search', 'settings']);
  for (const a of [...empty, ...full]) assert.ok(views.has(a.view), `${a.id} opens a known screen`);
});

/* ---------- Pure model: activity and capabilities ---------- */

test('activity is grouped by local day, newest first, capped, and kinds get readable labels', () => {
  const act = (id, at, kind = 'task') => ({ id, at, kind, summary: `did ${id}` });
  const groups = home.groupActivity([act('e', '2026-10-01T10:00:00'), act('a', '2026-10-15T09:00:00'), act('b', '2026-10-15T08:00:00'), act('c', '2026-10-14T23:00:00', 'launch-app'), act('d', '2026-10-13T12:00:00', 'ui.automation')], TODAY, 4);
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
      ['Earlier', ['d']],
    ],
  );
  assert.deepEqual(home.groupActivity([], TODAY), []);
  assert.equal(home.kindLabel('task'), 'Task');
  assert.equal(home.kindLabel('launch-app'), 'Launch app');
  assert.equal(home.kindLabel('ui.automation'), 'Ui automation');
  assert.equal(home.kindLabel(''), 'Event');
});

test('capability view distinguishes loading, failed, unchecked and loaded without inventing counts', () => {
  assert.deepEqual(home.capabilityView(null, null, true), { status: 'loading', available: 0, total: 0, unavailable: [] });
  assert.deepEqual(home.capabilityView(null, 'boom', false), { status: 'error', available: 0, total: 0, unavailable: [] });
  assert.deepEqual(home.capabilityView(null, null, false).status, 'unloaded');
  const v = home.capabilityView(someCaps, null, false);
  assert.equal(v.status, 'loaded');
  assert.equal(v.available, 4);
  assert.equal(v.total, 6);
  assert.deepEqual(v.unavailable.map((c) => c.id), ['stt', 'secure-storage']);
});

/* ---------- Layout registry keeps its contract ---------- */

test('the new cockpit panels are registered widgets and the layout helpers still round-trip', () => {
  const ids = home.WIDGETS.map((w) => w.id);
  for (const id of ['status', 'capture', 'actions', 'due', 'activity']) assert.ok(ids.includes(id), id);
  assert.equal(ids[0], 'status', 'status leads the default order');
  const l = home.normalizeLayout({ order: ['activity', 'status'], hidden: ['capture'] });
  assert.deepEqual(l.order.slice(0, 2), ['activity', 'status']);
  assert.equal(l.order.length, ids.length);
  assert.deepEqual(home.setWidgetHidden(home.DEFAULT_LAYOUT, 'capture', true).hidden, ['capture']);
});

/* ---------- Rendered screen ---------- */

test('the status strip shows the primary item, its action and the rest as links, with mode and model badges', () => {
  const html = renderHome({
    state: baseState({ tasks: [task('a', 'Write the abstract', '2026-10-01'), task('b', 'Call the lab', TODAY)] }),
    system: { capabilities: someCaps },
  });
  const strip = widget(html, 'status');
  assert.match(strip, /data-status-tier="attention"/);
  assert.match(strip, /Needs attention/);
  assert.match(strip, /<h2 class="ph-status-title">1 task is overdue<\/h2>/);
  assert.match(strip, /Oldest: Write the abstract\./);
  assert.match(strip, /<span>Open Tasks<\/span>/);
  assert.match(strip, /aria-label="Other status items"/);
  assert.match(strip, /1 task due today/);
  assert.match(strip, /2 of 6 capabilities unavailable/);
  assert.doesNotMatch(strip, /The model has not been checked/, 'the loaded local-llm capability is an affirmative backend check');
  assert.match(strip, /Offline mode/);
  assert.match(strip, /Model ready/);
});

test('all clear renders as the ok tier with no secondary list', () => {
  const html = renderHome({ state: baseState({ tasks: [] }), system: { capabilities: allCaps } });
  const strip = widget(html, 'status');
  assert.match(strip, /data-status-tier="ok"/);
  assert.match(strip, /All clear/);
  assert.doesNotMatch(strip, /Other status items/);
});

test('quick capture renders labelled fields, a disabled submit while empty, and the local-only hint', () => {
  const html = renderHome();
  const cap = widget(html, 'capture');
  assert.match(cap, /role="radiogroup" aria-label="What to capture"/);
  assert.match(cap, /role="radio" aria-checked="true"[^>]*>[^<]*Task/);
  assert.match(cap, /role="radio" aria-checked="false"[^>]*>[^<]*Note/);
  const inputId = /<input id="([^"]+)"/.exec(cap)?.[1];
  assert.ok(inputId, 'title input has an id');
  assert.match(cap, new RegExp(`<label for="${inputId.replace(/[:]/g, '\\:')}"`), 'title input is labelled');
  const selectId = /<select id="([^"]+)"/.exec(cap)?.[1];
  assert.ok(selectId, 'due select has an id');
  assert.match(cap, new RegExp(`<label for="${selectId.replace(/[:]/g, '\\:')}"`), 'due select is labelled');
  assert.match(cap, /<option value="none"[^>]*>No date<\/option><option value="today">Today<\/option><option value="tomorrow">Tomorrow<\/option>/);
  assert.match(cap, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(cap, /<p class="field-hint" role="status">Saved on this computer only\. Nothing is sent anywhere\.<\/p>/);
  assert.doesNotMatch(cap, /Not saved/);
});

test('quick actions render as buttons with a label and hint each, and say they only open screens', () => {
  const html = renderHome({ state: baseState({ chat: [{ id: 'm', role: 'user', text: 'hello', createdAt: STAMP, source: 'local' }] }) });
  const acts = widget(html, 'actions');
  const buttons = [...acts.matchAll(/<button type="button" class="ph-action" data-action="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(buttons, ['continue-chat', 'reopen-capsule', 'latest-note', 'tasks', 'search']);
  assert.match(acts, /<strong>Continue the conversation<\/strong>/);
  assert.match(acts, /<strong>Reopen Thesis<\/strong>/);
  assert.match(acts, /Nothing is sent or run until you act there\./);
});

test('due now lists overdue, today and this-week tasks with relative badges and a checkbox each', () => {
  const html = renderHome({ state: baseState({ tasks: [task('a', 'Late', '2026-10-01'), task('b', 'Now', TODAY), task('c', 'Soon', '2026-10-17'), task('d', 'Far', '2026-12-01'), task('e', 'Undated')] }) });
  const due = widget(html, 'due');
  const names = [...due.matchAll(/aria-label="Mark “([^”]+)” done"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Late', 'Now', 'Soon']);
  assert.match(due, /badge-danger">Overdue since /);
  assert.match(due, /badge-warn">Today</);
  assert.match(due, /badge-muted">In 2 days</);
  assert.doesNotMatch(due, /Far|Undated/, 'later and undated tasks stay in Tasks');
});

test('empty states offer a way forward and loading, failed and unchecked capability states are distinct', () => {
  const empty = renderHome({ state: baseState({ tasks: [], notes: [], capsules: [], activity: [] }) });
  assert.match(widget(empty, 'due'), /No open tasks[\s\S]*Add a task/);
  assert.match(widget(empty, 'capsules'), /No capsules yet[\s\S]*Create one/);
  assert.match(widget(empty, 'notes'), /No notes yet[\s\S]*Write one/);
  assert.match(widget(empty, 'activity'), /No activity recorded/);
  assert.match(widget(empty, 'capabilities'), /Not checked yet/);
  assert.match(widget(empty, 'companion'), /No chat yet\. The companion is idle\./);

  const loading = renderHome({ systemLoading: true });
  assert.match(widget(loading, 'capabilities'), /role="status">Checking what this computer supports…/);
  const failed = renderHome({ systemError: 'The bridge did not answer.' });
  assert.match(widget(failed, 'capabilities'), /The system check failed[\s\S]*The bridge did not answer\./);
  assert.match(widget(failed, 'status'), /data-status-tier="attention"[\s\S]*The system check failed/);
  const some = renderHome({ system: { capabilities: someCaps } });
  assert.match(widget(some, 'capabilities'), /<p class="big-line">4<span> of 6 available<\/span><\/p>/);
  assert.match(widget(some, 'capabilities'), /Speech recognition[\s\S]*not here/);
  const all = renderHome({ system: { capabilities: allCaps } });
  assert.match(widget(all, 'capabilities'), /Everything the app checks for is available here\./);
});

test('activity is grouped by day headings with readable kinds', () => {
  const today = `${localDateKey()}T08:00:00`;
  const html = renderHome({ state: baseState({ activity: [{ id: 'x', at: today, kind: 'launch-app', summary: 'Opened Notepad' }, { id: 'y', at: '2026-01-01T00:00:00', kind: 'task', summary: 'Added a task' }] }) });
  const act = widget(html, 'activity');
  assert.match(act, /<h3 class="ph-activity-day">Today<\/h3>/);
  assert.match(act, /<h3 class="ph-activity-day">Earlier<\/h3>/);
  assert.match(act, /<span class="tl-kind">Launch app<\/span>/);
  assert.match(act, /<span class="tl-kind">Task<\/span>/);
});

test('every control on Home has an accessible name and the page keeps the existing header actions', () => {
  const html = renderHome({ system: { capabilities: someCaps }, state: baseState({ tasks: [task('a', 'Late', '2026-10-01')] }) });
  for (const [, attrs, inner] of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    const labelled = /\baria-labelledby="([^"]+)"/.exec(attrs)?.[1];
    const resolved = labelled && labelled.split(/\s+/).every(id => new RegExp(`id="${id}"`).test(html));
    assert.ok(/\baria-label="[^"]+"/.test(attrs) || resolved || text(inner).length > 0, `button without a name: ${attrs}`);
  }
  for (const [, attrs] of html.matchAll(/<input\b([^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const named = /\baria-label="[^"]+"/.test(attrs) || (id && new RegExp(`<label for="${id.replace(/[:]/g, '\\:')}"`).test(html));
    assert.ok(named, `input without a name: ${attrs}`);
  }
  assert.match(html, /Ask the assistant/);
  assert.match(html, /New note/);
  assert.match(html, /aria-pressed="false"[^>]*>[^<]*<span>Arrange<\/span>/);
  assert.match(html, /Showing the default layout/, 'the dashboard summaries still render above the widgets');
});

/* ---------- Ambient backdrop ---------- */

test('ambient mode is off under reduced motion, paused while hidden, otherwise on', () => {
  assert.equal(home && ambientMode(true, false), 'off');
  assert.equal(ambientMode(true, true), 'off', 'reduced motion wins over visibility');
  assert.equal(ambientMode(false, true), 'paused');
  assert.equal(ambientMode(false, false), 'on');
});

test('the backdrop renders the drift layer with the ambient attribute and keeps every scene element', () => {
  const plain = render(h(SceneBackdrop, { scene: 'deep-space', className: 'app-scene' }));
  assert.match(plain, /^<div class="scene app-scene" data-scene="deep-space" data-ambient="on" aria-hidden="true">/);
  assert.match(plain, /<div class="scene-wash"><\/div><div class="scene-drift"><\/div>/);
  assert.match(plain, /scene-stars-a/);
  assert.match(plain, /<div class="scene-vignette">/);
  for (const [scene, marker] of [['orbit', 'scene-orbit'], ['aurora', 'scene-ribbon-c'], ['horizon', 'scene-grid'], ['dusk', 'scene-ridge-c']]) assert.match(render(h(SceneBackdrop, { scene })), new RegExp(marker), scene);
});

test('the backdrop source subscribes to visibility and the motion attribute and removes both on unmount', async () => {
  const src = await read('src/components/SceneBackdrop.tsx');
  assert.match(src, /addEventListener\('visibilitychange'/);
  assert.match(src, /removeEventListener\('visibilitychange'/);
  assert.match(src, /attributeFilter: \['data-motion'\]/);
  assert.match(src, /observer\?\.disconnect\(\)/);
  assert.doesNotMatch(src, /setInterval|requestAnimationFrame|Math\.random/, 'no timers or randomness: CSS does the motion');
  assert.doesNotMatch(src, /\.css'/, 'the backdrop is bundled by screens whose tests do not stub stylesheets');
});

/* ---------- Stylesheet guards ---------- */

test('the home stylesheet gates motion on the ambient attribute, reduced motion and the root attribute, and uses compositor-only properties', async () => {
  const css = await read('src/styles/parallel-home.css');
  assert.match(css, /\.scene\[data-ambient='on'\] \.scene-drift \{\s*animation: ph-drift 48s ease-in-out infinite;/);
  assert.match(css, /\.scene\[data-ambient='paused'\] \.scene-drift \{[^}]*animation-play-state: paused;/);
  assert.match(css, /\.scene\[data-ambient='off'\] \.scene-drift \{[^}]*animation: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.scene-drift \{[^}]*animation: none !important;/);
  assert.match(css, /:root\[data-motion='reduced'\] \.scene-drift \{[^}]*animation: none !important;/);
  const keyframes = /@keyframes ph-drift \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(keyframes.length > 0, 'drift keyframes exist');
  const props = new Set([...keyframes.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]));
  assert.deepEqual([...props].sort(), ['opacity', 'transform'], 'keyframes only animate opacity and transform');
  assert.match(css, /\.ph-action:focus-visible \{[^}]*outline: 2px solid var\(--focus\)/);
  assert.match(css, /\.ph-status-link:focus-visible \{[^}]*outline: 2px solid var\(--focus\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@container \(max-width: 640px\)/, 'the status strip reflows by container width');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, not hard-coded hex');
  assert.match(src(await read('src/components/Home.tsx')), /import '\.\.\/styles\/parallel-home\.css';/);
  function src(s) {
    return s;
  }
});

test('owned files avoid the working name, em and en dashes, and the summary path stays free of timing noise', async () => {
  for (const f of ['src/components/Home.tsx', 'src/components/SceneBackdrop.tsx', 'src/styles/parallel-home.css', 'tests/parallel-home.test.mjs']) {
    const t = await read(f);
    assert.doesNotMatch(t, new RegExp('jar' + 'vis', 'i'), f);
    assert.doesNotMatch(t, new RegExp('[\\u2014\\u2013]'), `${f} uses em or en dashes`);
  }
  const homeSrc = await read('src/components/Home.tsx');
  const pure = homeSrc.slice(homeSrc.indexOf('/* ---------- Cockpit model'), homeSrc.indexOf('/* ---------- Screen'));
  assert.ok(pure.length > 1000, 'the cockpit model section exists');
  assert.doesNotMatch(pure, /Date\.now|new Date\(\)|Math\.random|localStorage|navigator\./, 'pure helpers take time as a parameter and touch no browser state');
  assert.doesNotMatch(homeSrc, /getBattery|setInterval|fetch\(/, 'Home polls nothing and probes nothing');
});
