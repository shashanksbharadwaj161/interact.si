// Settings: grouped searchable preferences, honest connection and key status, validation and recovery,
// trusted-confirmation preview, masked key handling and keyboard support.
// The real Settings.tsx is bundled in memory and rendered with react-dom/server against a fixture store.
// No window, Electron, network, microphone or desktop input is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(path.join(root, p), 'utf8');

// Icons are inert placeholders; names come from the real imports so the stub cannot drift.
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

const prefs = new Map();
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (prefs.has(k) ? prefs.get(k) : null), setItem: (k, v) => void prefs.set(k, String(v)), removeItem: (k) => void prefs.delete(k) },
});

// The store module is replaced by a fixture the tests swap per render. Everything else is the real source.
globalThis.__fixture = null;
const storeStub = `
  const get = () => globalThis.__fixture;
  export const useReady = () => get();
  export const useStore = () => get();
  export const useOptionalStore = () => get();
`;

const bundle = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'settings-test-entry.ts',
    loader: 'ts',
    contents: `
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
      name: 'stubs',
      setup(bld) {
        bld.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';') }));
        bld.onResolve({ filter: /\.css$/ }, () => ({ path: 'style', namespace: 'css-stub' }));
        bld.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: '' }));
        bld.onResolve({ filter: /(^|\/)store$/ }, (a) => (/ui\/store$|^\.\/store$/.test(a.path) && !a.resolveDir.includes('services') ? { path: 'store', namespace: 'store-stub' } : undefined));
        bld.onLoad({ filter: /.*/, namespace: 'store-stub' }, () => ({ contents: storeStub, loader: 'js' }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { settings: S, createElement: h, renderToStaticMarkup: render } = mod;

/* ---------- Fixtures ---------- */

const baseSettings = { onboarded: true, mode: 'offline', theme: 'graphite', reduceMotion: false, startInTray: false, localModel: 'llama3.2:3b', localEndpoint: 'http://127.0.0.1:11434', cloudModel: 'cloud-model-x', voice: '', allowedRoots: [], approvedApps: [], retainDays: 30 };
const caps = (available, reason) => [{ id: 'local-llm', name: 'Local model', available, ...(reason ? { reason } : {}) }];

function fixture(over = {}) {
  const calls = { saveSettings: [], setCloudKey: [], toasts: [] };
  const f = {
    settings: { ...baseSettings, ...(over.settings ?? {}) },
    state: { chat: [], settings: baseSettings, capsules: [], notes: [], tasks: [], activity: [] },
    api: { saveSettings: async (p) => void calls.saveSettings.push(p), setCloudKey: async (k) => void calls.setCloudKey.push(k), deleteCloudKey: async () => undefined, exportData: async () => ({}), importData: async () => ({}), clearChat: async () => undefined },
    mutate: async () => true,
    run: async () => undefined,
    toast: (kind, text) => calls.toasts.push([kind, text]),
    cloudConfigured: over.cloudConfigured === undefined ? true : over.cloudConfigured,
    refreshCloud: async () => undefined,
    refreshSystem: async () => undefined,
    system: over.system === undefined ? { platform: 'win32', arch: 'x64', ramGB: 16, cpu: 'x', capabilities: caps(true) } : over.system,
    systemError: over.systemError ?? null,
    systemLoading: false,
    isPreview: false,
  };
  f.calls = calls;
  return f;
}
const renderSettings = (over, props = {}) => {
  globalThis.__fixture = fixture(over);
  return render(h(S.Settings, props));
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

/* ---------- Grouping and search ---------- */

test('every group has a blurb and every section sits in a known group', () => {
  const tabs = S.SETTINGS_TABS.map((t) => t.id);
  assert.deepEqual(Object.keys(S.SETTINGS_TAB_BLURBS).sort(), [...tabs].sort());
  for (const id of tabs) assert.ok(S.SETTINGS_TAB_BLURBS[id].length > 20, id);
  for (const e of S.SETTINGS_INDEX) assert.ok(tabs.includes(e.tab), e.id);
  assert.ok(S.SETTINGS_INDEX.some((e) => e.id === 'status' && e.tab === 'models'));
});

test('search ranks title matches first and keeps screen order for ties', () => {
  const ids = (q) => S.searchSettings(q).map((e) => e.id);
  assert.equal(ids('cloud')[0], 'cloud-model', 'title match beats a keyword match on another section');
  assert.ok(ids('cloud').includes('status'));
  assert.ok(ids('cloud').indexOf('cloud-model') < ids('cloud').indexOf('mode'));
  assert.deepEqual(ids('connection status'), ['status']);
  assert.deepEqual(ids('x'.repeat(500)), [], 'long queries are bounded and match nothing');
  assert.ok(ids('KEY').includes('cloud-model'), 'case-insensitive');
});

test('the initial query opens a flat result list with live-region text, and each tab shows its blurb', () => {
  const found = renderSettings({}, { initialQuery: 'api key' });
  assert.match(found, /id="settings-results"/);
  assert.match(found, /role="status"[^>]*>[^<]*1 matching section\./);
  assert.match(found, /Cloud model/);
  assert.doesNotMatch(found, /id="settings-appearance"/, 'only matching sections render while searching');
  assert.doesNotMatch(found, /role="tablist"/);

  const none = renderSettings({}, { initialQuery: 'zzzqq' });
  assert.match(none, /No section matches/);
  assert.match(none, /No matching sections\./);

  const general = renderSettings({});
  assert.match(general, /role="tablist"/);
  assert.match(general, /id="blurb-general"/);
  assert.match(text(general), new RegExp(S.SETTINGS_TAB_BLURBS.general.slice(0, 30)));
});

/* ---------- Honest connection status ---------- */

const ready = { route: 'local', level: 'ready', title: 'Local model is ready', detail: 'ok' };
const blocked = { route: 'cloud', level: 'blocked', title: 'Online mode has no API key', detail: 'none' };

test('connection status describes the saved route and never promises a fallback', () => {
  const offline = S.connectionStatus({ savedMode: 'offline', draftMode: 'offline', local: ready, cloud: blocked, cloudConfigured: false });
  assert.equal(offline.find((r) => r.id === 'route').value, 'Offline (this computer)');
  assert.match(offline.find((r) => r.id === 'route').note, /no automatic fallback to the cloud/i);
  assert.equal(offline.find((r) => r.id === 'local').tone, 'ok');
  assert.equal(offline.find((r) => r.id === 'cloud').tone, 'warn');
  assert.equal(offline.find((r) => r.id === 'key').value, 'Not saved');
  assert.ok(!offline.some((r) => r.id === 'pending-mode'));

  const online = S.connectionStatus({ savedMode: 'online', draftMode: 'online', local: ready, cloud: { ...blocked, level: 'ready', title: 'Online mode is set up' }, cloudConfigured: true });
  assert.equal(online.find((r) => r.id === 'route').value, 'Online (cloud)');
  assert.match(online.find((r) => r.id === 'route').note, /no automatic fallback to the local model/i);
  assert.equal(online.find((r) => r.id === 'key').value, 'Saved');
  assert.doesNotMatch(JSON.stringify(online), /sk-|bearer/i);
});

test('unsaved mode changes and unknown key status are labelled instead of assumed', () => {
  const rows = S.connectionStatus({ savedMode: 'offline', draftMode: 'online', local: { ...ready, level: 'unknown' }, cloud: { ...blocked, level: 'unknown' }, cloudConfigured: null });
  const pending = rows.find((r) => r.id === 'pending-mode');
  assert.equal(pending.value, 'Online');
  assert.match(pending.note, /keeps using the saved mode until you press Save/i);
  assert.equal(rows.find((r) => r.id === 'key').value, 'Status unknown');
  assert.equal(rows.find((r) => r.id === 'key').tone, 'muted');
  assert.equal(rows.find((r) => r.id === 'local').value, 'Unknown');
});

test('the rendered status panel reflects local readiness from the live check, not from filled-in fields', () => {
  const up = text(renderSettings({ system: { platform: 'win32', arch: 'x64', ramGB: 8, cpu: 'x', capabilities: caps(true) } }, { initialQuery: 'connection status' }));
  assert.match(up, /Local model is ready/);
  assert.match(up, /Offline \(this computer\)/);
  assert.match(up, /Nothing is sent to a provider to produce it/);

  const down = text(renderSettings({ system: { platform: 'win32', arch: 'x64', ramGB: 8, cpu: 'x', capabilities: caps(false, 'Ollama did not respond') } }, { initialQuery: 'connection status' }));
  assert.match(down, /Local model is not available/);
  assert.doesNotMatch(down, /Local model is ready/);

  const noKey = text(renderSettings({ cloudConfigured: false, settings: { mode: 'online' } }, { initialQuery: 'connection status' }));
  assert.match(noKey, /Online \(cloud\)/);
  assert.match(noKey, /Online mode has no API key/);
  assert.match(noKey, /No key is stored, so online chat cannot send/);
});

/* ---------- Validation and recovery ---------- */

test('issues name every blocking problem and the section that holds it', () => {
  assert.deepEqual(S.settingsIssues({ localEndpoint: 'http://127.0.0.1:11434', localModel: 'm', cloudModel: 'c-1' }, '30'), []);
  const bad = S.settingsIssues({ localEndpoint: 'https://example.com', localModel: '', cloudModel: 'bad name!' }, '0');
  assert.deepEqual(bad.map((i) => [i.sectionId, i.label]), [['local-model', 'Local endpoint'], ['local-model', 'Local model name'], ['cloud-model', 'Cloud model name'], ['retention', 'Keep history for']]);
  for (const i of bad) assert.ok(i.message.length > 10 && i.tab);
  assert.equal(S.retainDaysError('3650'), null);
  assert.ok(S.retainDaysError('3651'));
  assert.ok(S.retainDaysError(''));
  assert.ok(S.retainDaysError('1.5'));
  assert.ok(S.retainDaysError('-3'));
});

test('a remote endpoint cannot be saved from Settings', () => {
  const [issue] = S.settingsIssues({ localEndpoint: 'http://203.0.113.5:11434', localModel: 'm', cloudModel: 'c' }, '30');
  assert.equal(issue.sectionId, 'local-model');
  assert.match(issue.message, /this computer/i);
});

test('a pristine screen shows no save bar, problem list or confirmation preview', () => {
  const html = renderSettings({});
  assert.doesNotMatch(html, /aria-label="Unsaved settings"/);
  assert.doesNotMatch(html, /aria-label="Before you save"/);
});

/* ---------- Trusted confirmation preview ---------- */

test('the preview lists exactly what the main process will ask Windows to confirm', () => {
  const saved = { mode: 'offline', localEndpoint: 'http://127.0.0.1:11434', allowedRoots: ['C:\\Docs'], approvedApps: ['C:\\a.exe'] };
  assert.deepEqual(S.nativeConfirmationChanges(saved, saved), []);
  const draft = { mode: 'online', localEndpoint: 'http://localhost:11434', allowedRoots: ['C:\\Docs', 'D:\\Work'], approvedApps: ['C:\\a.exe', 'C:\\b.exe'] };
  assert.deepEqual(S.nativeConfirmationChanges(saved, draft), ['Approve app: C:\\b.exe', 'Allow folder: D:\\Work', 'Turn on online mode', 'Change the local model address to http://localhost:11434']);
  // Removing access and going back offline are not confirmed, matching the main process rule.
  assert.deepEqual(S.nativeConfirmationChanges({ ...saved, mode: 'online' }, { ...saved, mode: 'offline', allowedRoots: [], approvedApps: [] }), []);
  assert.deepEqual(S.nativeConfirmationChanges(saved, { ...saved, localEndpoint: ' http://127.0.0.1:11434 ' }), [], 'whitespace alone is not a change');
});

test('the preview mirrors the confirmation rule in the main process source', async () => {
  const backend = await read('electron/backend.ts');
  for (const re of [/approvedApps\.filter\(\(v\) => !before\.approvedApps\.includes\(v\)\)/, /allowedRoots\.filter\(\(v\) => !before\.allowedRoots\.includes\(v\)\)/, /before\.mode !== 'online' && proposed\.mode === 'online'/, /before\.localEndpoint !== proposed\.localEndpoint/]) {
    assert.match(backend, re, 'the main process rule changed; update nativeConfirmationChanges');
  }
});

test('confirmation is never decided in the renderer', async () => {
  const src = await read('src/components/Settings.tsx');
  assert.doesNotMatch(src, /confirm\s*:\s*(true|async|\()/, 'no renderer-supplied confirmation value');
  assert.doesNotMatch(src, /\bconfirmed\b|skipConfirm|trusted\s*:/i);
  const saves = [...src.matchAll(/api\.saveSettings\(([^)]*\))/g)].map((m) => m[1]);
  assert.ok(saves.length >= 3);
  for (const call of saves) assert.doesNotMatch(call, /confirm/i);
});

/* ---------- Key handling ---------- */

test('API key text is checked before it is sent and is never echoed back', () => {
  assert.ok(S.apiKeyProblem(''));
  assert.ok(S.apiKeyProblem('short'));
  assert.ok(S.apiKeyProblem('x'.repeat(401)));
  assert.match(S.apiKeyProblem('sk-abc def-12345'), /no spaces/i);
  assert.match(S.apiKeyProblem('sk-abcdefgh\n12345'), /no spaces|line breaks/i);
  assert.equal(S.apiKeyProblem('  sk-test-1234567890  '), null, 'surrounding whitespace from pasting is trimmed');
  for (const k of ['sk-test-1234567890', 'x'.repeat(8)]) assert.doesNotMatch(S.apiKeyProblem(k + ' bad') ?? '', new RegExp(k));
});

test('the key box is masked, empty on first render and never carries the saved key', () => {
  const saved = renderSettings({ cloudConfigured: true }, { initialQuery: 'api key' });
  assert.match(saved, /type="password"/);
  assert.match(saved, /autoComplete="off"|autocomplete="off"/i);
  assert.match(saved, /placeholder="A key is saved\. Paste a new one to replace it"/);
  assert.doesNotMatch(saved, /<input[^>]*type="password"[^>]*value="[^"]+"/);
  assert.match(text(saved), /Saved/);
  assert.match(text(saved), /cannot be revealed or copied back out here/);

  const none = renderSettings({ cloudConfigured: false }, { initialQuery: 'api key' });
  assert.match(none, /placeholder="Paste your key"/);
  assert.match(text(none), /Not saved/);
  assert.match(none, /<button[^>]*disabled=""[^>]*><span>Delete key<\/span>|<button[^>]*disabled=""[^>]*>[^<]*<span>Delete key/);

  const unknown = renderSettings({ cloudConfigured: null }, { initialQuery: 'api key' });
  assert.match(text(unknown), /Status unknown/);
});

test('the pasted key stays in memory only: no storage, no logging, cleared on hide, on leave and on success', async () => {
  const src = (await read('src/components/Settings.tsx')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /\b(setPref|writePref)\(\s*['"`][^)]*key/i, 'no preference write mentions a key');
  assert.doesNotMatch(src, /localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.doesNotMatch(src, /console\.\w+\(/);
  assert.doesNotMatch(src, /toast\([^)]*\bkey\b\s*[,)+]/, 'no toast interpolates the key value');
  assert.match(src, /document\.addEventListener\('visibilitychange'/);
  assert.match(src, /document\.removeEventListener\('visibilitychange'[\s\S]*setKey\(''\)/, 'unmount drops the key');
  assert.match(src, /if \(!cloudVisible\) \{\s*setKey\(''\)/, 'hiding the section drops the key');
  assert.match(src, /await api\.setCloudKey\(k\);\s*setKey\(''\)/, 'a successful save clears the field');
  assert.match(src, /type="password"/);
  assert.doesNotMatch(src, /type="text"[^>]*value=\{key\}/);
});

test('saving a key sends it once through the existing bridge and nothing leaks into settings', async () => {
  const src = await read('src/components/Settings.tsx');
  assert.equal((src.match(/api\.setCloudKey\(/g) ?? []).length, 1);
  assert.doesNotMatch(src, /saveSettings\([^)]*\bkey\b/, 'the key is never part of a settings patch');
  assert.doesNotMatch(src, /DRAFT_KEYS = \[[^\]]*key/i);
});

/* ---------- Honest copy, accessibility and motion ---------- */

test('visible copy avoids the working name, dashes and internal wording, and never promises auto requests', async () => {
  const src = (await read('src/components/Settings.tsx')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /jarvis/i);
  assert.doesNotMatch(src, /[—–]/);
  assert.doesNotMatch(src, /\bthe backend\b/i);
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|navigator\.sendBeacon/, 'Settings makes no requests of its own');
  assert.doesNotMatch(src, /automatically (switch|fall)/i);
});

test('the screen is operable by keyboard and announces results', async () => {
  const src = await read('src/components/Settings.tsx');
  assert.match(src, /role="tablist"/);
  assert.match(src, /e\.key === 'ArrowRight'/);
  assert.match(src, /e\.key === 'Home'/);
  assert.match(src, /e\.key === 'Enter' && searching && matches\.length > 0/);
  assert.match(src, /e\.key === 'Escape' && query/);
  assert.match(src, /e\.key\.toLowerCase\(\) === 's' && !anyDialog/, 'Ctrl+S saves only while no dialog is open');
  assert.match(src, /behavior: 'auto'/, 'jumping to a section never animates scrolling');
  const html = renderSettings({}, { initialQuery: 'theme' });
  assert.match(html, /role="search"/);
  assert.match(html, /aria-controls="settings-results"/);
  assert.match(html, /aria-label="Matching sections"/);
  const keys = text(renderSettings({}, { initialQuery: 'keyboard' }));
  assert.match(keys, /Save changes Ctrl \+ S when there are unsaved changes/);
  assert.match(keys, /Enter opens the first match/);
});

test('only the first tab stop is on the selected tab and panels are labelled by their tab', () => {
  const html = renderSettings({});
  assert.equal((html.match(/role="tab"/g) ?? []).length, S.SETTINGS_TABS.length);
  assert.equal((html.match(/tabindex="-1"[^>]*role="tab"|role="tab"[^>]*tabindex="-1"/g) ?? []).length, S.SETTINGS_TABS.length - 1, 'roving tabindex: every other tab is out of the tab order');
  assert.match(html, /role="tabpanel"[^>]*aria-labelledby="tab-general"|aria-labelledby="tab-general"[^>]*role="tabpanel"/);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
});

test('reduced motion still holds: the highlight outline is a transition the global rules shorten', async () => {
  const css = await read('src/styles/views.css');
  assert.match(css, /\.settings-section \{[^}]*transition: outline-color/s);
  const a11y = await read('src/styles/accessibility.css');
  assert.match(a11y, /prefers-reduced-motion: reduce[\s\S]*transition-duration: 0\.01ms !important/);
  assert.match(a11y, /:root\[data-motion='reduced'\] \*/);
  const src = await read('src/components/Settings.tsx');
  assert.doesNotMatch(src, /behavior: 'smooth'/);
  assert.doesNotMatch(src, /setInterval|animate\(/, 'Settings starts no animation loop of its own');
});

/* ---------- Rendered recovery states ---------- */

const issue = (over = {}) => ({ sectionId: 'local-model', tab: 'models', label: 'Local endpoint', message: 'Only this computer is allowed here.', ...over });
const summaryProps = (props) => ({ issues: [], confirmations: [], saveFailed: false, saving: false, onRetry() {}, onJump() {}, ...props });
const summaryHtml = (props) => render(h(S.PreSaveSummary, summaryProps(props)));
const summary = (props) => text(summaryHtml(props));

test('the before-you-save summary is silent when there is nothing to say', () => {
  assert.equal(summaryHtml({}), '');
});

test('blocking problems are listed as buttons that name the field and say what is wrong', () => {
  const props = { issues: [issue(), issue({ sectionId: 'retention', tab: 'data', label: 'Keep history for', message: 'Whole number of days from 1 to 3650.' })] };
  const html = summaryHtml(props);
  assert.match(html, /aria-label="Problems to fix"/);
  assert.equal((html.match(/<button type="button" class="chip"/g) ?? []).length, 2);
  const t = summary(props);
  assert.match(t, /Fix 2 problems before saving/);
  assert.match(t, /Local endpoint Only this computer is allowed here\./);
  assert.match(t, /Keep history for Whole number of days/);
  assert.match(summary({ issues: [issue()] }), /Fix one problem before saving/);
  assert.doesNotMatch(summary({ ...props, confirmations: ['Turn on online mode'] }), /Windows will ask you to confirm/, 'confirmations wait until the problems are fixed');
});

test('a failed or declined save says the edits are kept and offers a retry', () => {
  const html = summaryHtml({ saveFailed: true });
  assert.match(html, /role="alert"/);
  const t = summary({ saveFailed: true });
  assert.match(t, /Your changes were not saved/);
  assert.match(t, /Try again/);
  assert.match(t, /edits are still here and nothing was changed/);
  assert.match(t, /cancelled the Windows confirmation/);
  assert.match(summaryHtml({ saveFailed: true, saving: true }), /aria-busy="true"/, 'retry shows busy while saving');
});

test('permission changes are previewed as a Windows confirmation, never as something the app approves itself', () => {
  const t = summary({ confirmations: ['Approve app: C:\\b.exe', 'Turn on online mode'] });
  assert.match(t, /Windows will ask you to confirm these changes/);
  assert.match(t, /Approve app: C:\\b\.exe\. Turn on online mode\./);
  assert.match(t, /choosing No leaves everything as it was/);
});

test('retry and jump are wired to the right handlers', () => {
  // No DOM here, so walk the returned element tree and call the click handlers directly.
  const calls = [];
  const tree = S.PreSaveSummary(summaryProps({ issues: [issue()], saveFailed: true, onRetry: () => calls.push('retry'), onJump: (target) => calls.push(target) }));
  const handlers = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const p = n.props ?? {};
    if (typeof p.onClick === 'function') handlers.push(p.onClick);
    if (p.action) walk(p.action);
    walk(p.children);
  };
  walk(tree);
  assert.equal(handlers.length, 2, 'one retry button and one jump button');
  for (const fn of handlers) fn();
  assert.ok(calls.includes('retry'));
  assert.deepEqual(calls.find((c) => typeof c === 'object'), { id: 'local-model', tab: 'models' });
});

test('settings already saved with a bad endpoint show the field error and a blocked local status', () => {
  const html = renderSettings({ settings: { localEndpoint: 'https://example.com' }, system: { platform: 'win32', arch: 'x64', ramGB: 8, cpu: 'x', capabilities: caps(true) } }, { initialQuery: 'local' });
  assert.match(html, /role="alert"/);
  assert.match(text(html), /Start the address with http:\/\//);
  assert.match(text(html), /The local model settings are incomplete/, 'status does not claim a ready model for settings that cannot work');
});

test('existing exports used by the shell are preserved', () => {
  for (const name of ['Settings', 'PreSaveSummary', 'SHELL_PREF', 'useShellPref', 'MAX_DISPLAY_NAME', 'normalizeDisplayName', 'SETTINGS_TABS', 'SETTINGS_INDEX', 'searchSettings']) assert.ok(name in S, name);
});
