// Home cockpit (parallel home module): the pure cockpit model, the server-rendered screen against a
// fixture store, the ambient backdrop policy, and source/style guards for the owned files.
// The real Home.tsx and SceneBackdrop.tsx are bundled in memory with esbuild and rendered with
// react-dom/server, the same way tests/milestone-home-widgets.test.mjs does it. Clicks are not simulated
// (no DOM library is in the lockfile); every decision that drives the markup is a pure function tested here.
import test, { mock } from 'node:test';
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
// Renderer date defaults must use the same clock as the fixed fixture records.
mock.timers.enable({ apis: ['Date'], now: NOW });
test.after(() => mock.timers.reset());
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
/** Markup of one Today section, from its opening tag to the next section or the end. */
function section(html, label) {
  const start = html.search(new RegExp(`<(section|form)[^>]*aria-(label|labelledby)="${label}"`));
  assert.notEqual(start, -1, `${label} is rendered`);
  const next = html.indexOf('<section', start + 10);
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

/* ---------- Rendered Today ---------- */

test('Today greets by the time of day, says what is due in words and shows only real counts', () => {
  const html = renderHome({ state: baseState({ tasks: [task('a', 'Write the abstract', '2026-10-01'), task('b', 'Call the lab', TODAY), task('c', 'Done one', TODAY, { done: true })] }) });
  assert.match(html, /<h1 class="display">Good afternoon\.<\/h1>/);
  assert.match(html, /<p class="today-line">1 overdue · 1 due today<\/p>/);
  const readouts = /<dl class="readouts"[\s\S]*?<\/dl>/.exec(html)?.[0] ?? '';
  assert.match(readouts, /<dt>Open tasks<\/dt><dd>2<\/dd>/);
  assert.match(readouts, /<dt>Notes<\/dt><dd>2<\/dd>/);
  assert.match(readouts, /<dt>Capsules<\/dt><dd>1<\/dd>/);

  const empty = renderHome({ state: baseState({ tasks: [], notes: [], capsules: [] }) });
  assert.match(empty, /Nothing is due today\./);
  assert.doesNotMatch(empty, /class="readouts"/, 'no row of zeros when nothing is saved');
});

test('the start bar has a labelled input, three kinds, a disabled submit while empty, and the local-only hint', () => {
  const start = section(renderHome(), 'Start something');
  assert.match(start, /role="radiogroup" aria-label="What to start"/);
  assert.match(start, /role="radio" aria-checked="true"[^>]*>(?:<[^>]*>)*Note/);
  assert.match(start, /role="radio" aria-checked="false"[^>]*>(?:<[^>]*>)*Task/);
  assert.match(start, /role="radio" aria-checked="false"[^>]*>(?:<[^>]*>)*Ask/);
  const inputId = /<input id="([^"]+)"/.exec(start)?.[1];
  assert.ok(inputId, 'the input has an id');
  assert.match(start, new RegExp(`<label for="${inputId.replace(/[:]/g, '\\:')}"[^>]*>New note title</label>`), 'the input is labelled');
  assert.match(start, /<button[^>]*type="submit"[^>]*disabled=""/);
  assert.match(start, /role="status">Saved on this computer only\. Nothing is sent anywhere\.<\/p>/);
});

test('up next lists open tasks by due date, each with a checkbox and a relative due label, and caps the list', () => {
  const html = renderHome({ state: baseState({ tasks: [task('d', 'Far', '2026-12-01'), task('a', 'Late', '2026-10-01'), task('b', 'Now', TODAY), task('c', 'Soon', '2026-10-17'), task('e', 'Undated'), task('f', 'Sixth')] }) });
  const up = section(html, 'today-up');
  const names = [...up.matchAll(/aria-label="Mark “([^”]+)” done"/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Late', 'Now', 'Soon', 'Far', 'Undated'], 'overdue, today, this week, later, then undated; five at most');
  assert.match(up, /today-due is-overdue">Overdue since /);
  assert.match(up, /today-due is-today">Today</);
  assert.match(up, /today-due">In 2 days</);
  assert.match(up, />All 6 open</, 'the full list is one click away');
});

test('empty sections say what to do next', () => {
  const html = renderHome({ state: baseState({ tasks: [], notes: [], capsules: [], chat: [] }) });
  assert.match(section(html, 'today-continue'), /Nothing to continue yet\.[\s\S]*Write a note or add a task above/);
  assert.match(section(html, 'today-up'), /No tasks yet\.[\s\S]*Choose Task above/);
  const allDone = renderHome({ state: baseState({ tasks: [task('x', 'Old', undefined, { done: true })] }) });
  assert.match(section(allDone, 'today-up'), /Everything is done\./);
});

test('continue opens the newest saved record and the rest are listed with their kind', () => {
  const html = renderHome();
  const cont = section(html, 'today-continue');
  assert.match(cont, /class="today-continue"[\s\S]*Note · [\s\S]*<strong>First note<\/strong>/, 'the newest note is first');
  assert.match(cont, /Recently saved/);
  assert.match(cont, /<strong>Second note<\/strong>/);
  assert.match(cont, /<strong>Thesis<\/strong>/);
});

test('the AI row appears only when chat cannot answer, and points to Claude, not a local model', () => {
  const legacy = renderHome({ system: { capabilities: allCaps } });
  assert.doesNotMatch(legacy, /aria-label="Assistant readiness"/, 'an answering legacy model needs no prompt');
  const off = renderHome({ system: { capabilities: someCaps.map((c) => (c.id === 'local-llm' ? { ...c, available: false, reason: 'Ollama is not running' } : c)) } });
  const row = section(off, 'Assistant readiness');
  assert.match(row, /AI is not connected/);
  assert.match(row, /<span>Connect Claude<\/span>/);
  assert.doesNotMatch(row, /Ollama|Check again/);
  const noKey = renderHome({ settings: settings({ mode: 'online' }), cloudConfigured: false, system: { capabilities: allCaps } });
  const keyRow = section(noKey, 'Assistant readiness');
  assert.match(keyRow, /No API key is saved/);
  assert.match(keyRow, /<span>Fix AI setup<\/span>/);
  assert.match(keyRow, /<span>Check again<\/span>/);
});

test('every control on Today has an accessible name', () => {
  const html = renderHome({ system: { capabilities: someCaps }, state: baseState({ tasks: [task('a', 'Late', '2026-10-01')] }) });
  let buttons = 0;
  for (const [, attrs, inner] of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    buttons += 1;
    const labelled = /\baria-labelledby="([^"]+)"/.exec(attrs)?.[1];
    const resolved = labelled && labelled.split(/\s+/).every((id) => new RegExp(`id="${id}"`).test(html));
    assert.ok(/\baria-label="[^"]+"/.test(attrs) || resolved || text(inner).length > 0, `button without a name: ${attrs}`);
  }
  assert.ok(buttons >= 6, 'the audit inspected the real controls');
  for (const [, attrs] of html.matchAll(/<input\b([^>]*)>/g)) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const named = /\baria-label="[^"]+"/.test(attrs) || (id && new RegExp(`<label for="${id.replace(/[:]/g, '\\:')}"`).test(html));
    assert.ok(named, `input without a name: ${attrs}`);
  }
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

test('the backdrop stylesheet gates drift motion on the ambient attribute, reduced motion and the root attribute, and uses compositor-only properties', async () => {
  const css = await read('src/styles/scenes.css');
  assert.match(css, /\.scene\[data-ambient='on'\] \.scene-drift \{\s*animation: scene-drift 48s ease-in-out infinite;/);
  assert.match(css, /\.scene\[data-ambient='paused'\] \.scene-drift \{[^}]*animation-play-state: paused;/);
  assert.match(css, /\.scene\[data-ambient='off'\] \.scene-drift \{[^}]*animation: none;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.scene-drift \{[^}]*animation: none !important;/);
  assert.match(css, /:root\[data-motion='reduced'\] \.scene-drift \{[^}]*animation: none !important;/);
  const keyframes = /@keyframes scene-drift \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
  assert.ok(keyframes.length > 0, 'drift keyframes exist');
  const props = new Set([...keyframes.matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]));
  assert.deepEqual([...props].sort(), ['opacity', 'transform'], 'keyframes only animate opacity and transform');
});

test('the Today stylesheet takes colours from tokens and drops the core on narrow windows', async () => {
  const css = await read('src/styles/today.css');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'colours come from tokens, not hard-coded hex');
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*\.today-core \{\s*display: none;/);
  assert.match(await read('src/components/Home.tsx'), /import '\.\.\/styles\/today\.css';/);
});

test('owned files avoid the working name, em and en dashes, and the pure model stays free of timing noise', async () => {
  for (const f of ['src/components/Home.tsx', 'src/components/SceneBackdrop.tsx', 'src/styles/today.css', 'tests/parallel-home.test.mjs']) {
    const t = await read(f);
    assert.doesNotMatch(t, new RegExp('jar' + 'vis', 'i'), f);
    assert.doesNotMatch(t, new RegExp('[\\u2014\\u2013]'), `${f} uses em or en dashes`);
  }
  const homeSrc = await read('src/components/Home.tsx');
  const pure = homeSrc.slice(homeSrc.indexOf('/* ---------- Pure model'), homeSrc.indexOf('/* ---------- Today'));
  assert.ok(pure.length > 1000, 'the pure model section exists');
  assert.doesNotMatch(pure, /Date\.now|new Date\(\)|Math\.random|localStorage|navigator\./, 'pure helpers take time as a parameter and touch no browser state');
  assert.doesNotMatch(homeSrc, /getBattery|fetch\(/, 'Today probes nothing');
  assert.equal([...homeSrc.matchAll(/setInterval\(/g)].length, 1, 'one timer: the clock readout');
  assert.match(homeSrc, /if \(document\.visibilityState !== 'hidden'\) setNow\(new Date\(\)\)/, 'the clock does not tick while the window is hidden');
});
