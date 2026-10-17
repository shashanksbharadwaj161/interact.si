// Shell runtime contracts: the real App, router and views are bundled in memory and rendered with
// react-dom/server against a fixture store. Covers every route, deep links, the gate and banner states,
// the capability states each route reports, and an accessible-name audit of every button and field.
// Seam: effects do not run during server rendering, so AppProvider cannot seed state. The store context
// is exported in memory at bundle time only (src/ui/store.tsx on disk is unchanged). No DOM library is in
// the lockfile, so clicks and keyboard focus are not simulated; see docs/autopilot-shell-runtime.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PassThrough } from 'node:stream';

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
    for (const m of text.matchAll(/\bPhosphor\.([A-Z]\w*)/g)) iconNames.add(m[1]);
  }
}

// Browser globals read at render time: the hash router, preferences and the window itself.
const store = new Map();
globalThis.window = globalThis;
globalThis.location = { hash: '' };
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) },
});

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'shell-runtime-entry.ts',
    loader: 'ts',
    contents: `
      export * as nav from './src/ui/nav.tsx';
      export { App } from './src/components/App.tsx';
      export { FocusProvider } from './src/ui/focus.tsx';
      export { TestStoreContext } from './src/ui/store.tsx';
      export * as bridges from './src/ui/bridges.ts';
      export { createElement } from 'react';
      export { renderToStaticMarkup, renderToPipeableStream } from 'react-dom/server';
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
      // Test-only seam: the context object is exported from the bundled copy of store.tsx. The file on disk is not edited.
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
const { nav, bridges, App, FocusProvider, TestStoreContext, createElement: h, renderToStaticMarkup: render, renderToPipeableStream } = mod;

/* ---------- Fixtures ---------- */

const STAMP = '2026-10-14T08:00:00.000Z';
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
const state = {
  settings: settings(),
  capsules: [
    { id: 'c_1', name: 'Cap one', description: '', scene: 'deep-space', createdAt: STAMP, updatedAt: STAMP, items: [] },
    { id: 'c_2', name: 'Cap two', description: '', scene: 'deep-space', createdAt: STAMP, updatedAt: STAMP, items: [] },
  ],
  notes: [
    { id: 'n_1', title: 'First note', body: 'alpha', tags: [], updatedAt: STAMP },
    { id: 'n_2', title: 'Second note', body: 'beta', tags: [], updatedAt: STAMP },
  ],
  tasks: [
    { id: 't_1', title: 'Task one', done: false, createdAt: STAMP },
    { id: 't_2', title: 'Task two', done: false, createdAt: STAMP },
  ],
  chat: [],
  activity: [],
};

const CAPABILITY_NAMES = {
  'local-llm': 'Local model',
  cloud: 'Cloud model',
  tts: 'Read aloud',
  stt: 'Speech recognition',
  'ui-automation': 'Windows desktop control',
  'secure-storage': 'Secure key storage',
};
/** Every capability the shell reads, marked available or not. Unavailable entries carry a reason, as the system service does. */
const capabilities = (available, reasons = {}) =>
  Object.keys(CAPABILITY_NAMES).map((id) =>
    available.includes(id) ? { id, name: CAPABILITY_NAMES[id], available: true } : { id, name: CAPABILITY_NAMES[id], available: false, reason: reasons[id] ?? `${id} reason` },
  );
const systemInfo = (capabilitiesList) => ({ platform: 'win32', arch: 'x64', ramGB: 16, cpu: 'Test CPU', capabilities: capabilitiesList });
const ALL_BUT_SECURE_STORAGE = ['local-llm', 'cloud', 'tts', 'stt', 'ui-automation'];

/**
 * An api with every bridge method the module views need, built from the real method lists so the fixture cannot drift
 * from src/ui/bridges.ts. Server rendering runs no effects, so none of these is called; one that is fails loudly.
 */
const connectedApi = (omit = []) =>
  Object.fromEntries(
    [...bridges.ROUTINE_METHODS, ...bridges.MODEL_METHODS, ...bridges.INTEGRATION_BRIDGE_METHODS, ...bridges.USAGE_METHODS, ...bridges.CLIPBOARD_METHODS]
      .filter((m) => !omit.includes(m))
      .map((m) => [m, async () => { throw new Error(`${m} called while rendering`); }]),
  );

/** Capability states the shell can be in. "unchecked" is the state before the first system check completes. */
const STATES = {
  unchecked: { system: null },
  unavailable: { system: systemInfo(capabilities([])) },
  available: { system: systemInfo(capabilities(ALL_BUT_SECURE_STORAGE)) },
  // Every module bridge present: the accessible-name audits below then cover the connected controls too.
  connected: { system: systemInfo(capabilities(ALL_BUT_SECURE_STORAGE)), api: connectedApi() },
};

/**
 * Fixture store with the same shape as the real one. The api object has no methods on purpose: any
 * bridge call made while rendering throws, so a route that reaches for the bridge fails loudly.
 */
function makeStore(o = {}) {
  return {
    api: o.api ?? {},
    isPreview: o.isPreview ?? false,
    status: o.status ?? 'ready',
    loadError: o.loadError ?? null,
    state: o.state ?? state,
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

/** Renders the whole app at a hash. Providers match src/main.tsx: the store wraps the focus provider. */
function page(hash, o = {}) {
  globalThis.location = { hash };
  return render(h(TestStoreContext.Provider, { value: makeStore(o) }, h(FocusProvider, null, h(App))));
}

/* ---------- Markup helpers (rendered output, not source text) ---------- */

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
const visibleText = (s) => decode(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

function attrsOf(src) {
  const attrs = {};
  for (const m of src.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = decode(m[2] ?? '');
  return attrs;
}

/** Elements with inner markup, such as buttons. Returns attributes and inner HTML. */
function elements(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map((m) => ({ attrs: attrsOf(m[1]), inner: m[2] }));
}

/** Void form controls: their accessible name comes from attributes, a <label for> or a wrapping <label>. */
const fields = (html) => [...html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)].map((m) => ({ tag: m[1], attrs: attrsOf(m[2]), raw: m[0] })).filter((f) => f.attrs.type !== 'hidden');

function labelFor(html, id) {
  if (!id) return '';
  const m = new RegExp(`<label\\b[^>]*\\bfor="${escapeRe(id)}"[^>]*>([\\s\\S]*?)<\\/label>`).exec(html);
  return m ? visibleText(m[1]) : '';
}

const nameOfButton = (html, b) => b.attrs['aria-label'] || visibleText(b.inner) || labelFor(html, b.attrs.id) || b.attrs.title || '';
const wrappingLabel = (html, f) => visibleText(elements(html, 'label').find((l) => !l.attrs.for && l.inner.includes(f.raw))?.inner ?? '');
const nameOfField = (html, f) => f.attrs['aria-label'] || labelFor(html, f.attrs.id) || wrappingLabel(html, f) || '';
const mainLabel = (html) => decode((html.match(/<main\b[^>]*aria-label="([^"]*)"/) ?? [])[1] ?? '');
const headingOf = (html) => visibleText(elements(html, 'h1')[0]?.inner ?? '');
const currentNavItems = (html) => elements(html, 'a').filter((a) => a.attrs['aria-current'] === 'page').map((a) => a.attrs['aria-label']);

const H1 = {
  home: /^Good (morning|afternoon|evening|night)\.$/,
  assistant: 'Assistant',
  companion: 'Small companion. Quite a character.',
  capsules: 'Capsules',
  notes: 'Notes',
  tasks: 'Tasks',
  computer: 'Desktop actions',
  status: 'System status',
  settings: 'Settings',
  lab: 'Roadmap',
  developer: 'Developer',
  search: 'Search',
  motion: 'Motion studio',
  avatar: 'Character editor',
  routines: 'Automations',
  integrations: 'Connections',
  models: 'Local models',
  usage: 'Usage',
  clipboard: 'Clipboard',
  calendar: 'Calendar',
  // Workspace screens integrated 15 Oct 2026 (captain).
  memory: 'Memory',
  writing: 'Writing',
  guide: 'Help & setup',
};

/* ---------- Routes ---------- */

// A cold lazy route renders the real, named loading state first. Streaming SSR then waits for actual
// bundled imports, so the existing route/capability/a11y assertions continue to inspect screen content.
const coldMotion = page('#/motion', { system: STATES.available.system });
test('a cold local screen announces its loading state without removing navigation', () => {
  assert.match(coldMotion, /aria-busy="true"/);
  assert.match(coldMotion, /Opening Motion studio/);
  assert.match(coldMotion, /role="status"/);
  assert.deepEqual(currentNavItems(coldMotion), ['Motion studio']);
});
for (const v of nav.VIEWS) {
  globalThis.location = { hash: nav.hashFor(v.id) };
  await new Promise((resolve, reject) => {
    const sink = new PassThrough();
    sink.resume();
    sink.on('end', resolve);
    sink.on('error', reject);
    const stream = renderToPipeableStream(
      h(TestStoreContext.Provider, { value: makeStore(STATES.connected) }, h(FocusProvider, null, h(App))),
      { onAllReady() { stream.pipe(sink); }, onError: reject },
    );
  });
}

test('every navigable view renders its own page with one current nav item and a heading', () => {
  assert.deepEqual(Object.keys(H1).sort(), nav.VIEW_IDS.slice().sort(), 'the heading table covers exactly the navigable views');
  for (const v of nav.VIEWS) {
    const html = page(nav.hashFor(v.id), { system: STATES.available.system });
    assert.equal(mainLabel(html), v.label, `${v.id} main is labelled with the view name`);
    assert.deepEqual(currentNavItems(html), [v.label], `${v.id} marks exactly its own nav item as the current page`);
    const heading = headingOf(html);
    const expected = H1[v.id];
    if (expected instanceof RegExp) assert.match(heading, expected, v.id);
    else assert.equal(heading, expected, v.id);
  }
});

test('the empty hash and unknown view names fall back to Home', () => {
  for (const hash of ['', '#', '#/nope', '#/nope?item=x']) {
    const html = page(hash, { system: STATES.available.system });
    assert.equal(mainLabel(html), 'Today', JSON.stringify(hash));
    assert.deepEqual(currentNavItems(html), ['Today']);
  }
});

test('every shortcut the nav displays opens the view it names, through the same key handler', () => {
  // The rail shows areas and each area shows its own tabs, so a shortcut link appears on the pages of its area.
  // Collect every displayed shortcut across all pages; one view must always show the same shortcut.
  const seen = new Map();
  for (const v of nav.VIEWS) {
    const html = page(nav.hashFor(v.id), { system: STATES.available.system });
    for (const link of elements(html, 'a').filter((a) => a.attrs['aria-keyshortcuts'])) {
      const prev = seen.get(link.attrs['aria-label']);
      if (prev) assert.equal(prev.attrs['aria-keyshortcuts'], link.attrs['aria-keyshortcuts'], `${link.attrs['aria-label']} shows one shortcut everywhere`);
      seen.set(link.attrs['aria-label'], link);
    }
  }
  const shortcutViews = nav.VIEWS.filter((v) => v.shortcut && !v.shortcut.startsWith('Ctrl+'));
  assert.equal(shortcutViews.length, 10, 'Alt+1…9 and Alt+0');
  for (const v of shortcutViews) {
    const link = seen.get(v.label);
    assert.ok(link, `${v.id} nav link carries its shortcut on at least one page`);
    const parts = link.attrs['aria-keyshortcuts'].split('+');
    const key = parts.at(-1);
    const event = { key, altKey: parts.includes('Alt'), ctrlKey: parts.includes('Control'), metaKey: false, shiftKey: false };
    assert.deepEqual(nav.shortcutAction(event, false), { kind: 'view', view: v.id }, `${link.attrs['aria-keyshortcuts']} opens ${v.id}`);
    assert.equal(link.attrs.title, `${v.label} (${v.shortcut})`, `${v.id} tooltip shows the same shortcut`);
  }
  assert.deepEqual(nav.shortcutAction({ key: 'k', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }, false), { kind: 'search' }, 'Ctrl+K opens quick search');
  const home = page('#/home', { system: STATES.available.system });
  assert.match(home, /<button[^>]*aria-keyshortcuts="Control\+K"/, 'the rail search button names Ctrl+K');
});

test('the route parameters the shell emits survive the hash round trip for every view', () => {
  const samples = [{}, { item: 'n_2' }, { q: 'api key' }, { item: 'n 1&x=2' }];
  for (const v of nav.VIEW_IDS) {
    for (const params of samples) {
      const parsed = nav.parseHash(nav.hashFor(v, params));
      assert.equal(parsed.view, v);
      assert.deepEqual(parsed.params, params);
    }
  }
});

test('the settings deep link prefills the search box with the q parameter', () => {
  const html = page('#/settings?q=api%20key', { system: STATES.available.system });
  const search = fields(html).find((f) => f.attrs.placeholder === 'Search settings');
  assert.ok(search, 'search field renders');
  assert.equal(search.attrs.value, 'api key');
});

// Home, Memory search and recent lists navigate with { item: id }; Notes and Capsules open that record.
test('a note deep link selects the note it names', () => {
  const html = page('#/notes?item=n_2', { system: STATES.available.system });
  const selected = elements(html, 'button').filter((b) => b.attrs['aria-current'] === 'true');
  assert.ok(selected.some((b) => visibleText(b.inner).includes('Second note')), 'Second note is the selected item');
});

test('a capsule deep link selects the capsule it names', () => {
  const html = page('#/capsules?item=c_2', { system: STATES.available.system });
  const selected = elements(html, 'button').filter((b) => b.attrs['aria-current'] === 'true');
  assert.ok(selected.some((b) => visibleText(b.inner).includes('Cap two')), 'Cap two is the selected capsule');
  assert.ok(!selected.some((b) => visibleText(b.inner).includes('Cap one')), 'only the named capsule is selected');
});

test('a deep link to a record that does not exist keeps the default selection instead of an empty page', () => {
  for (const [hash, name] of [['#/notes?item=n_gone', 'First note'], ['#/capsules?item=c_gone', 'Cap one']]) {
    const html = page(hash, { system: STATES.available.system });
    const selected = elements(html, 'button').filter((b) => b.attrs['aria-current'] === 'true');
    assert.ok(selected.some((b) => visibleText(b.inner).includes(name)), `${hash} selects ${name}`);
  }
});

// Each module view takes its client from a bridge adapter in src/ui/bridges.ts. Without the methods it says so.
const NOT_CONNECTED = {
  routines: /Routines are not connected/,
  usage: /Usage ledger is not connected/,
  clipboard: /Clipboard history is not connected/,
  calendar: /Calendar is not connected/,
};

test('the routines, integrations, models, usage, clipboard, calendar and avatar pages are reachable and titled', () => {
  for (const [id, title] of [['routines', 'Automations'], ['integrations', 'Connections'], ['models', 'Local models'], ['usage', 'Usage'], ['clipboard', 'Clipboard'], ['calendar', 'Calendar'], ['avatar', 'Character editor']]) {
    for (const o of [STATES.available, STATES.connected]) {
      const html = page(`#/${id}`, o);
      assert.equal(headingOf(html), title, id);
      assert.deepEqual(currentNavItems(html), [nav.viewById(id).label], `${id} is the one current nav item`);
    }
  }
});

test('without the backend methods each module page says it is not connected and offers no live action', () => {
  for (const [id, pattern] of Object.entries(NOT_CONNECTED)) {
    assert.match(page(`#/${id}`, { system: STATES.available.system }), pattern, id);
  }
  const disabled = (html, name) => {
    const b = elements(html, 'button').find((x) => visibleText(x.inner) === name);
    assert.ok(b, `${name} renders`);
    return 'disabled' in b.attrs;
  };
  const calendar = page('#/calendar', STATES.available);
  assert.deepEqual(fields(elements(calendar, 'main')[0]?.inner ?? ''), [], 'without the calendar methods no import control is offered');
  assert.doesNotMatch(calendar, /Import with file dialog|Export all as \.ics/);
  // Avatar Studio needs no backend: it edits a locally saved avatar pack and says the voice level is only simulated.
  const avatar = page('#/avatar', STATES.available);
  assert.match(avatar, /class="avatar-studio"/);
  // Semantic check: the page must say no audio source is attached, that the level is simulated, and that it is not a microphone reading.
  assert.match(avatar, /No audio source is attached[^<]*simulates a level/, 'avatar states the level is simulated without an audio source');
  assert.match(avatar, /not a microphone reading/i, 'avatar states the level is not a microphone reading');
  assert.match(avatar, /Simulated level \(preview only\)/, 'the level slider is labelled as preview only');
  assert.ok(disabled(page('#/usage', STATES.available), 'Refresh'), 'usage refresh is disabled');
  const clip = page('#/clipboard', STATES.available);
  assert.ok(fields(elements(clip, 'main')[0]?.inner ?? '').every((f) => 'disabled' in f.attrs), 'the clipboard switch is disabled');
  const models = page('#/models', STATES.available);
  assert.match(models, /Browser preview/, 'models states there is no backend');
  assert.ok(disabled(models, 'Refresh'), 'models refresh is disabled');
});

test('with the backend methods the module pages connect, and a single missing method disconnects that page only', () => {
  const connected = (id) => page(`#/${id}`, STATES.connected);
  for (const id of ['routines', 'usage', 'clipboard']) assert.doesNotMatch(connected(id), NOT_CONNECTED[id], `${id} connects`);
  assert.doesNotMatch(connected('models'), /Browser preview/);
  assert.match(connected('models'), /Checking Ollama/, 'models waits for its first overview');
  assert.match(connected('usage'), /Usage is not loaded yet/, 'usage shows nothing until the ledger answers');
  // The switch stays disabled until the first status read returns (effects do not run here), so it is never offered on a guess.
  assert.ok(fields(elements(connected('clipboard'), 'main')[0]?.inner ?? '').every((f) => 'disabled' in f.attrs), 'clipboard waits for its status');
  const partial = (omit) => ({ system: STATES.available.system, api: connectedApi([omit]) });
  assert.match(page('#/routines', partial('routinesUndo')), NOT_CONNECTED.routines, 'routines need every method');
  assert.match(page('#/usage', partial('usageExport')), NOT_CONNECTED.usage);
  assert.match(page('#/clipboard', partial('clipboardPurge')), NOT_CONNECTED.clipboard);
  assert.match(page('#/models', partial('modelsCancelJob')), /Browser preview/);
  assert.doesNotMatch(page('#/usage', partial('routinesUndo')), NOT_CONNECTED.usage, 'unrelated methods do not matter');
});

/* ---------- Gate ---------- */

test('while saved data loads the shell shows a status line and no navigation', () => {
  const html = page('#/home', { status: 'loading' });
  assert.match(html, /Loading saved data…/);
  assert.doesNotMatch(html, /aria-label="Primary"/);
  assert.doesNotMatch(html, /<main\b/);
});

test('when saved data fails to load the gate offers a retry and no navigation', () => {
  const html = page('#/home', { status: 'error', loadError: 'The data file is locked.' });
  assert.match(html, /role="alert"/);
  assert.match(html, /Saved data could not be loaded/);
  assert.match(html, /The data file is locked\./);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /aria-label="Primary"/);
});

test('before onboarding finishes the shell is not shown at all', () => {
  const html = page('#/computer', { settings: settings({ onboarded: false }), state: { ...state, settings: settings({ onboarded: false }) } });
  assert.doesNotMatch(html, /aria-label="Primary"/, 'no navigation until onboarding is done');
  assert.doesNotMatch(html, /<main\b/);
});

/* ---------- Banners on every route ---------- */

test('a failed capability check is visible on every route with a retry and a dismiss control', () => {
  for (const v of nav.VIEWS) {
    const html = page(nav.hashFor(v.id), { systemError: 'System information is unavailable.' });
    assert.match(html, /aria-label="Capability check failed"/, v.id);
    assert.match(html, /System information is unavailable\./, v.id);
    assert.match(html, /Try again/, v.id);
    assert.match(html, /aria-label="Hide this message until the next check"/, v.id);
  }
});

test('a safe-launch capability state shows the recovery banner on every route, naming the status page', () => {
  const reason = 'Safe launch is active after repeated crashes.';
  // Safe launch is an unavailable desktop-control capability whose reason says so; every other capability is fine.
  const system = systemInfo(capabilities(ALL_BUT_SECURE_STORAGE.filter((id) => id !== 'ui-automation'), { 'ui-automation': reason }));
  for (const v of nav.VIEWS) {
    const html = page(nav.hashFor(v.id), { system });
    assert.match(html, /Safe launch is active after repeated crashes\./, v.id);
    assert.match(html, /System status/, `${v.id} banner offers the status page`);
    assert.match(html, /Check again/, v.id);
  }
});

test('preview mode says plainly that this is not the desktop app on every route', () => {
  for (const v of nav.VIEWS) {
    const html = page(nav.hashFor(v.id), { isPreview: true, system: STATES.available.system });
    assert.match(html, /This is not the Electron app\./, v.id);
  }
});

/* ---------- Capability states: each route reports what it knows ---------- */

test('before the first check the assistant says so and does not claim to be available', () => {
  const html = page('#/assistant', STATES.unchecked);
  assert.match(html, /Capability has not been checked\./);
  assert.match(html, /<strong>Unavailable<\/strong>/);
  assert.doesNotMatch(html, /<strong>Available<\/strong>/);
});

// Assistant.tsx writes `${reason}. Check System status…`, so a reason that already ends in a full stop doubles it.
test('an unavailable reason that already ends in a full stop is not followed by a second one', () => {
  const system = systemInfo(capabilities(ALL_BUT_SECURE_STORAGE.filter((id) => id !== 'local-llm'), { 'local-llm': 'Offline model is not installed.' }));
  const html = page('#/assistant', { system });
  assert.doesNotMatch(visibleText(html), /\.\./);
});

test('an unavailable capability shows its reason on the assistant and does not hide it', () => {
  const html = page('#/assistant', STATES.unavailable);
  assert.match(html, /AI is not connected\. Connect Claude/, 'offline without an answering legacy model says what to do');
  assert.doesNotMatch(html, /local-llm reason/, 'a legacy local-model failure is not the advice in a Claude-first app');
  assert.match(html, /tts reason/);
  assert.match(html, /stt reason/);
  assert.match(html, /<strong>Unavailable<\/strong>/);
});

test('an available local model is reported as available on the assistant', () => {
  const html = page('#/assistant', STATES.available);
  assert.match(html, /<strong>Available<\/strong>/);
  assert.doesNotMatch(html, /local-llm reason/);
});

test('system status shows one badge per capability with the truth for each state', () => {
  const badges = (html) => elements(html, 'span').filter((s) => /\bbadge\b/.test(s.attrs.class ?? '')).map((s) => visibleText(s.inner));
  const unavailable = page('#/status', STATES.unavailable);
  assert.equal(badges(unavailable).filter((t) => t === 'Unavailable').length, Object.keys(CAPABILITY_NAMES).length, 'every capability is unavailable');
  assert.match(unavailable, /local-llm reason/, 'the reason for each capability is shown');

  const mixed = page('#/status', STATES.available);
  assert.equal(badges(mixed).filter((t) => t === 'Available').length, ALL_BUT_SECURE_STORAGE.length);
  assert.equal(badges(mixed).filter((t) => t === 'Unavailable').length, 1, 'secure storage stays unavailable');
  assert.match(mixed, /secure-storage reason/);
});

test('the computer page explains why it cannot preview and disables Preview until desktop control is confirmed', () => {
  const blocked = page('#/computer', STATES.unavailable);
  assert.match(blocked, /Desktop control unavailable/);
  assert.match(blocked, /ui-automation reason/);
  const preview = elements(blocked, 'button').find((b) => visibleText(b.inner) === 'Preview action');
  assert.ok(preview, 'Preview action renders');
  assert.ok('disabled' in preview.attrs, 'Preview is disabled while desktop control is unavailable');

  const ready = page('#/computer', STATES.available);
  assert.doesNotMatch(ready, /Desktop control unavailable/);
  const enabled = elements(ready, 'button').find((b) => visibleText(b.inner) === 'Preview action');
  assert.ok(enabled && !('disabled' in enabled.attrs), 'Preview is enabled once desktop control is available');
});

test('home lists what is unavailable with its reason, and is silent about it when everything is available', () => {
  const blocked = page('#/home', STATES.unavailable);
  assert.match(blocked, /AI is not connected/);
  assert.match(blocked, /Connect Claude/);
  assert.doesNotMatch(blocked, /local-llm reason/);
  assert.doesNotMatch(page('#/home', STATES.available), /AI is not connected/, 'an answering legacy model needs no setup prompt');
});

/* ---------- Accessible names ---------- */

// The audits count what they inspected, so a markup change that hides every control cannot pass silently.
test('every button on every route has an accessible name in every capability state', () => {
  const problems = [];
  let inspected = 0;
  let disabled = 0;
  for (const [label, o] of Object.entries(STATES)) {
    for (const v of nav.VIEWS) {
      const html = page(nav.hashFor(v.id), o);
      for (const b of elements(html, 'button')) {
        inspected += 1;
        if ('disabled' in b.attrs) disabled += 1;
        if (!nameOfButton(html, b)) problems.push(`${label}/${v.id}: ${b.attrs.class ?? 'unclassed button'}${'disabled' in b.attrs ? ' (disabled)' : ''}`);
      }
    }
  }
  assert.ok(inspected > 100, `saw ${inspected} buttons`);
  assert.ok(disabled > 10, `saw ${disabled} disabled buttons, including the capability-gated ones`);
  assert.deepEqual(problems, []);
});

test('every disabled button has an accessible name, so its state can be announced', () => {
  const problems = [];
  let disabled = 0;
  for (const [label, o] of Object.entries(STATES)) {
    for (const v of nav.VIEWS) {
      const html = page(nav.hashFor(v.id), o);
      for (const b of elements(html, 'button')) {
        if (!('disabled' in b.attrs)) continue;
        disabled += 1;
        if (!nameOfButton(html, b)) problems.push(`${label}/${v.id}`);
      }
    }
  }
  assert.ok(disabled > 10, `saw ${disabled} disabled buttons`);
  assert.deepEqual(problems, []);
});

test('every visible field on every route has a label or aria-label', () => {
  const problems = [];
  let inspected = 0;
  for (const [label, o] of Object.entries(STATES)) {
    for (const v of nav.VIEWS) {
      const html = page(nav.hashFor(v.id), o);
      for (const f of fields(html)) {
        inspected += 1;
        if (!nameOfField(html, f)) problems.push(`${label}/${v.id}: ${f.tag} ${f.attrs.placeholder ?? f.attrs.class ?? ''}`);
      }
    }
  }
  assert.ok(inspected > 20, `saw ${inspected} fields`);
  assert.deepEqual(problems, []);
});
