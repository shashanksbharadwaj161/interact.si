// UI shell: navigation and hash routing, global shortcuts, safe-launch and check-failed banners, help,
// Home widget layout, searchable Settings, shell preferences. Bundles the real TypeScript in memory and
// renders pure components with react-dom/server. No window, Electron, network or desktop input is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

// The icon package is replaced with inert placeholders. Names are collected from the real imports,
// including namespace member access (Phosphor.Name), so the stub cannot drift from the source.
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
    for (const m of text.matchAll(/\bPhosphor\.([A-Z]\w*)/g)) iconNames.add(m[1]);
  }
}

// Minimal browser globals for modules that read preferences at import time.
const store = new Map();
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) },
});

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'shell-test-entry.ts',
    loader: 'ts',
    contents: `
      export * as nav from './src/ui/nav.tsx';
      export * as app from './src/components/App.tsx';
      export * as home from './src/components/Home.tsx';
      export * as settings from './src/components/Settings.tsx';
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
      name: 'icon-stub',
      setup(bld) {
        bld.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
      },
    },
    {
      // Components that import their own stylesheet (MotionStudio) only need the import to resolve.
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
const { nav, app, home, settings, createElement: h, renderToStaticMarkup: render } = mod;

/* ---------- Navigation ---------- */

test('every view has a unique id, a group, a blurb and an icon, and the new views are placed in their groups', () => {
  assert.equal(new Set(nav.VIEWS.map((v) => v.id)).size, nav.VIEWS.length);
  for (const v of nav.VIEWS) {
    assert.ok(v.label && v.group && v.blurb, v.id);
    assert.equal(typeof v.icon, 'function', `${v.id} icon`);
  }
  const groups = nav.navGroups();
  assert.deepEqual(groups.map((g) => g.name), ['Cockpit', 'Work', 'System']);
  assert.ok(groups[1].views.some((v) => v.id === 'search'), 'memory search sits with Work');
  assert.ok(groups[0].views.some((v) => v.id === 'motion'), 'motion studio sits with Cockpit');
  assert.equal(groups.flatMap((g) => g.views).length, nav.VIEWS.length, 'grouping shows every view once');
});

test('the first ten views keep Alt+1…9 and Alt+0; memory search has Ctrl+K; the rest have no shortcut', () => {
  const expected = ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6', 'Alt+7', 'Alt+8', 'Alt+9', 'Alt+0'];
  nav.VIEWS.slice(0, 10).forEach((v, i) => assert.equal(v.shortcut, expected[i], v.id));
  assert.equal(nav.viewById('search').shortcut, 'Ctrl+K');
  assert.equal(nav.viewById('motion').shortcut, undefined);
  assert.equal(nav.viewById('developer').shortcut, undefined);
  assert.equal(nav.positionalShortcut(10), null);
  assert.equal(nav.positionalShortcut(-1), null);
});

test('hash routes carry optional parameters and unknown views fall back to Home', () => {
  assert.deepEqual(nav.parseHash('#/notes?item=n_1'), { view: 'notes', params: { item: 'n_1' } });
  assert.deepEqual(nav.parseHash('#/settings?q=api%20key'), { view: 'settings', params: { q: 'api key' } });
  assert.deepEqual(nav.parseHash('#computer'), { view: 'computer', params: {} });
  assert.deepEqual(nav.parseHash('#/nope?item=x'), { view: 'home', params: { item: 'x' } });
  assert.deepEqual(nav.parseHash(''), { view: 'home', params: {} });
  assert.equal(nav.parseHash(`#/notes?item=${'x'.repeat(500)}`).params.item.length, 200, 'parameters are bounded');
  assert.equal(nav.viewFromHash('#/search'), 'search');
  assert.equal(nav.viewFromHash('#/motion'), 'motion');

  assert.equal(nav.hashFor('home'), '#/home');
  assert.equal(nav.hashFor('notes', { item: 'n 1' }), '#/notes?item=n+1');
  assert.equal(nav.hashFor('notes', { item: '' }), '#/notes', 'empty values are dropped');
  const loc = nav.parseHash(nav.hashFor('capsules', { item: 'c_9', extra: 'a&b' }));
  assert.deepEqual(loc, { view: 'capsules', params: { item: 'c_9', extra: 'a&b' } });
});

test('search result categories map to existing views', () => {
  for (const [cat, view] of Object.entries(nav.VIEW_FOR_CATEGORY)) assert.ok(nav.VIEW_IDS.includes(view), `${cat} -> ${view}`);
  assert.deepEqual(Object.keys(nav.VIEW_FOR_CATEGORY).sort(), ['capsule', 'chat', 'note', 'task']);
});

const key = (k, mods = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

test('global shortcuts: Alt+digit, Ctrl+K and F1, and nothing at all while a dialog is open', () => {
  assert.deepEqual(nav.shortcutAction(key('1', { altKey: true }), false), { kind: 'view', view: 'home' });
  assert.deepEqual(nav.shortcutAction(key('0', { altKey: true }), false), { kind: 'view', view: nav.VIEWS[9].id });
  assert.deepEqual(nav.shortcutAction(key('k', { ctrlKey: true }), false), { kind: 'search' });
  assert.deepEqual(nav.shortcutAction(key('K', { ctrlKey: true }), false), { kind: 'search' });
  assert.deepEqual(nav.shortcutAction(key('F1'), false), { kind: 'help' });
  assert.equal(nav.shortcutAction(key('1', { altKey: true, shiftKey: true }), false), null);
  assert.equal(nav.shortcutAction(key('1', { altKey: true, ctrlKey: true }), false), null);
  assert.equal(nav.shortcutAction(key('k', { ctrlKey: true, shiftKey: true }), false), null);
  assert.equal(nav.shortcutAction(key('a', { altKey: true }), false), null);
  assert.equal(nav.shortcutAction(key('1'), false), null);
  for (const e of [key('1', { altKey: true }), key('k', { ctrlKey: true }), key('F1')]) assert.equal(nav.shortcutAction(e, true), null, 'quiet while a dialog is open');
});

test('modalIsOpen looks for an open native dialog', () => {
  assert.equal(app.modalIsOpen({ querySelector: (s) => (s === 'dialog[open]' ? {} : null) }), true);
  assert.equal(app.modalIsOpen({ querySelector: () => null }), false);
});

/* ---------- Motion ---------- */

test('battery-aware reduced motion only triggers when enabled, known, discharging and low', () => {
  assert.equal(app.batteryWantsReducedMotion(null, true), false);
  assert.equal(app.batteryWantsReducedMotion({ charging: false, level: 0.1 }, false), false);
  assert.equal(app.batteryWantsReducedMotion({ charging: true, level: 0.1 }, true), false);
  assert.equal(app.batteryWantsReducedMotion({ charging: false, level: 0.5 }, true), false);
  assert.equal(app.batteryWantsReducedMotion({ charging: false, level: 0.2 }, true), true);
  assert.equal(app.batteryWantsReducedMotion({ charging: false, level: 0.05 }, true), true);
  assert.equal(app.batteryWantsReducedMotion({ charging: false, level: Number.NaN }, true), false);
});

/* ---------- Banners and help ---------- */

test('the safe-launch banner names the reason and offers status and re-check without faking recovery', () => {
  const html = render(h(app.SafeLaunchBanner, { reason: 'Safe launch is active', onStatus: () => undefined, onRecheck: () => undefined }));
  assert.match(html, /role="note"/);
  assert.match(html, /Safe launch is active/);
  assert.match(html, /quit the app completely and open it again/);
  assert.match(html, /System status/);
  assert.match(html, /Check again/);
  const bare = render(h(app.SafeLaunchBanner, { reason: 'x' }));
  assert.doesNotMatch(bare, /System status|Check again/, 'no buttons without handlers');
});

test('the check-failed banner reports unknown state and offers a retry', () => {
  const html = render(h(app.CheckFailedBanner, { error: 'System information is unavailable.', onRetry: () => undefined, onDismiss: () => undefined }));
  assert.match(html, /role="status"/);
  assert.match(html, /unknown/);
  assert.match(html, /System information is unavailable\./);
  assert.match(html, /Try again/);
  assert.match(html, /Hide this message/);
});

test('help lists every view, every shortcut and the keys the shell actually handles', () => {
  const html = render(h(app.HelpContent, { go: () => undefined }));
  for (const v of nav.VIEWS) assert.match(html, new RegExp(v.label.replace(/[&]/g, '&amp;')), v.id);
  for (const v of nav.VIEWS.filter((x) => x.shortcut)) for (const k of v.shortcut.split('+')) assert.match(html, new RegExp(`<kbd>${k}</kbd>`));
  assert.match(html, /<kbd>F1<\/kbd>/);
  assert.match(html, /<kbd>Ctrl<\/kbd> \+ <kbd>K<\/kbd>/);
  assert.match(html, /pause while a dialog is open/);
  assert.doesNotMatch(html, /Alt\+11/);
});

/* ---------- Home widgets ---------- */

test('home layout normalisation drops unknown ids, removes duplicates and appends missing widgets', () => {
  const ids = home.WIDGETS.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(home.normalizeLayout(undefined), home.DEFAULT_LAYOUT);
  assert.deepEqual(home.normalizeLayout('junk'), home.DEFAULT_LAYOUT);
  const l = home.normalizeLayout({ order: ['notes', 'bogus', 'notes', 'due'], hidden: ['activity', 'nope', 'activity'] });
  assert.deepEqual(l.order.slice(0, 2), ['notes', 'due']);
  assert.equal(l.order.length, ids.length);
  assert.deepEqual([...l.order].sort(), [...ids].sort());
  assert.deepEqual(l.hidden, ['activity']);
});

test('moving widgets respects the edges and keeps hidden widgets in place', () => {
  const base = home.normalizeLayout({ order: ['totals', 'due', 'notes', 'capsules'], hidden: ['due'] });
  assert.equal(home.moveWidget(base, 'totals', -1), base, 'first visible cannot move earlier');
  const moved = home.moveWidget(base, 'totals', 1);
  assert.deepEqual(moved.order.slice(0, 3), ['notes', 'due', 'totals'], 'swaps with the next visible widget, hidden one stays');
  assert.deepEqual(moved.hidden, ['due']);
  assert.equal(home.moveWidget(base, 'due', 1), base, 'hidden widgets do not move');
  const last = base.order.filter((w) => !base.hidden.includes(w)).at(-1);
  assert.equal(home.moveWidget(base, last, 1), base, 'last visible cannot move later');
});

test('hiding and showing widgets is idempotent and the default check is exact', () => {
  assert.ok(home.layoutIsDefault(home.DEFAULT_LAYOUT));
  const hidden = home.setWidgetHidden(home.DEFAULT_LAYOUT, 'activity', true);
  assert.deepEqual(hidden.hidden, ['activity']);
  assert.deepEqual(home.setWidgetHidden(hidden, 'activity', true).hidden, ['activity']);
  assert.ok(!home.layoutIsDefault(hidden));
  assert.deepEqual(home.setWidgetHidden(hidden, 'activity', false), home.DEFAULT_LAYOUT);
  assert.ok(!home.layoutIsDefault(home.moveWidget(home.DEFAULT_LAYOUT, 'totals', 1)));
});

test('the greeting follows the hour and only names a person when a name is set', () => {
  assert.equal(home.greeting(3, ''), 'Good night.');
  assert.equal(home.greeting(9, 'Sam'), 'Good morning, Sam.');
  assert.equal(home.greeting(13, ''), 'Good afternoon.');
  assert.equal(home.greeting(21, 'Ira'), 'Good evening, Ira.');
});

/* ---------- Settings ---------- */

test('the settings index is consistent and search matches titles, tab names and keywords', () => {
  const ids = settings.SETTINGS_INDEX.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const tabs = new Set(settings.SETTINGS_TABS.map((t) => t.id));
  for (const e of settings.SETTINGS_INDEX) assert.ok(tabs.has(e.tab), `${e.id} tab`);
  for (const t of tabs) assert.ok(settings.SETTINGS_INDEX.some((e) => e.tab === t), `${t} has at least one section`);

  const idsOf = (q) => settings.searchSettings(q).map((e) => e.id);
  assert.deepEqual(idsOf(''), []);
  assert.deepEqual(idsOf('   '), []);
  assert.deepEqual(idsOf('zzzz'), []);
  assert.ok(idsOf('theme').includes('appearance'));
  assert.ok(idsOf('API key').includes('cloud-model'));
  assert.ok(idsOf('reduce motion').includes('motion'), 'all words must match');
  assert.ok(!idsOf('reduce folders').length, 'words from different sections do not match');
  assert.ok(idsOf('data').includes('backup'), 'the tab name counts');
  assert.ok(idsOf('OLLAMA').includes('local-model'), 'case-insensitive');
  assert.ok(idsOf('tray').includes('startup'));
});

test('display names are trimmed, collapsed and bounded', () => {
  assert.equal(settings.normalizeDisplayName('  Sam   Lee  '), 'Sam Lee');
  assert.equal(settings.normalizeDisplayName(42), '');
  assert.equal(settings.normalizeDisplayName('x'.repeat(100)).length, settings.MAX_DISPLAY_NAME);
});

test('shell preference keys are distinct and do not clash with other preference keys in the source', async () => {
  const values = Object.values(settings.SHELL_PREF);
  assert.equal(new Set(values).size, values.length);
  const src = await read('src/components/MotionStudio.tsx');
  for (const v of values) assert.doesNotMatch(src, new RegExp(`'${v.replace(/\./g, '\\.')}'`));
});

/* ---------- Source and style checks ---------- */

const OWNED = ['src/components/App.tsx', 'src/components/Home.tsx', 'src/components/Settings.tsx', 'src/components/Onboarding.tsx', 'src/ui/nav.tsx', 'src/styles/shell.css', 'src/styles/views.css'];

test('owned files do not use the working name or em dashes in user-facing text', async () => {
  for (const f of OWNED) {
    const text = await read(f);
    assert.doesNotMatch(text, /jarvis/i, f);
    assert.doesNotMatch(text, /[—–]/, `${f} uses em or en dashes`);
  }
});

test('the shell wires the shared modules and keeps the compact sidebar and banners accessible', async () => {
  const appSrc = await read('src/components/App.tsx');
  assert.match(appSrc, /import\('\.\/MotionStudio'\)/);
  assert.match(appSrc, /from '\.\/MemorySearch'/);
  assert.match(appSrc, /case 'search':/);
  assert.match(appSrc, /case 'motion':/);
  assert.match(appSrc, /aria-label=\{v\.label\}/);
  assert.match(appSrc, /<RecoveryBanner \/>/);
  assert.match(appSrc, /<SystemCheckBanner \/>/);
  assert.match(appSrc, /modalIsOpen\(document\)/, 'shortcuts check for an open dialog');
  assert.match(appSrc, /reducedMotion=\{motion\.reduced\}/, 'motion studio follows the shell motion state');
  const shell = await read('src/styles/shell.css');
  assert.match(shell, /\[data-text="large"\]/);
  assert.match(shell, /\.scene-layer \{[^}]*animation:[^}]*\}/s, 'scene cross-fade is a CSS animation the reduced-motion rules remove');
});

test('onboarding can check a draft model before finishing and still blocks bad settings', async () => {
  const src = await read('src/components/Onboarding.tsx');
  assert.match(src, /Save and check now/);
  assert.match(src, /saveSettings\(\{ localEndpoint: draft\.localEndpoint\.trim\(\), localModel: draft\.localModel\.trim\(\) \}\)/, 'the check saves only the model fields, never onboarded');
  assert.match(src, /const canNext = step !== 2 \|\| !\(endpointError \|\| modelError \|\| cloudError\)/);
  assert.match(src, /Ready to answer/);
});
