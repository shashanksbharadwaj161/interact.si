// UX backlog review: regression checks for findings in docs/backlog-ux-review.md.
// What this file can and cannot show:
// - Rendered markup comes from the real components via react-dom/server, bundled in memory with esbuild (nothing is written
//   to disk). That proves the markup a screen reader's tree is built from, not what any assistive technology announces.
// - Keyboard behaviour is checked through the pure shortcut functions in src/ui/nav.tsx. No key events are dispatched to a DOM.
// - Contrast is computed from the declared token values in src/styles/tokens.css. It is not a rendered-pixel measurement, and
//   it does not include translucent overlays or scene backdrops.
// - The offline check reads the esbuild import graph of the avatar and motion modules. It is not a network capture.
// Former TODO findings are now regression gates for corrected copy, focusability, toggle semantics and token contrast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');

// Globals the components read during render. Same stubs the existing UI tests use; nothing here touches real storage.
globalThis.window ??= globalThis;
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
}
if (!globalThis.localStorage) {
  const store = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
  });
}

// react-dom/server's CommonJS build needs real Node built-ins inside the in-memory bundle.
const requireBanner = `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});`;

async function loadBundle(entry) {
  const out = await build({ ...entry, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', banner: { js: requireBanner }, loader: { '.css': 'empty' }, jsx: 'automatic' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

// Probe entry. Each helper renders one real component with plain props. Elements are built here so React has one copy.
const probe = await loadBundle({
  stdin: {
    resolveDir: src,
    sourcefile: 'ux-review-probe.tsx',
    loader: 'tsx',
    contents: `
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch, Segmented, Button, IconButton, Field, Panel, Notice } from './ui/primitives';
import { Dialog } from './ui/Dialog';
import { MotionStudio } from './components/MotionStudio';
import { Avatar } from './components/Avatar';
const none = () => null;
export const markup = {
  switch: (p) => renderToStaticMarkup(h(Switch, { onChange: none, ...p })),
  segmented: (p) => renderToStaticMarkup(h(Segmented, { onChange: none, ...p })),
  button: (p, text) => renderToStaticMarkup(h(Button, p, text)),
  iconButton: (p) => renderToStaticMarkup(h(IconButton, { icon: none, ...p })),
  field: (p) => renderToStaticMarkup(h(Field, { label: p.label, hint: p.hint, error: p.error }, (id, describedBy) => h('input', { id, className: 'input', 'aria-describedby': describedBy }))),
  panel: (p, body) => renderToStaticMarkup(h(Panel, p, body)),
  notice: (p, body) => renderToStaticMarkup(h(Notice, p, body)),
  dialog: (p) => renderToStaticMarkup(h(Dialog, { onClose: none, ...p }, 'BODY')),
  motionStudio: (reducedMotion) => renderToStaticMarkup(h(MotionStudio, { reducedMotion })),
  avatar: (state) => renderToStaticMarkup(h(Avatar, { state })),
};
export * as nav from './ui/nav';
`,
  },
});
const { markup, nav } = probe;

test('Motion Lab exposes frame transport, six shapes, keyframes and local export controls', () => {
  const m = markup.motionStudio(true);
  for (const action of ['Previous frame', 'Next frame', 'Set keyframe at current frame', 'Export SVG frame', 'Export contact sheet', 'Export CSS tracks', 'Export lab JSON', 'Import lab']) {
    assert.match(m, new RegExp(`>${action}<`), action);
  }
  for (const shape of ['Aurora', 'Bloom', 'Lattice']) assert.ok(m.toLowerCase().includes(shape.toLowerCase()));
  assert.match(m, /type="file"[^>]*accept=".json,application\/json"/);
  assert.match(m, /No scripts are executed|No scripts|No audio is generated/);
});

/* ---------- helpers ---------- */

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const openTags = (m, tag) => [...m.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))].map((x) => x[0]);
const attr = (tagText, name) => {
  const hit = tagText.match(new RegExp(`\\s${name}="([^"]*)"`));
  return hit ? decode(hit[1]) : undefined;
};
const hasFlag = (tagText, name) => new RegExp(`\\s${name}(=""|\\s|>|/)`).test(tagText);
// Whole <button>…</button> elements whose visible text (tags removed) is exactly `text`.
const buttonsNamed = (m, text) => [...m.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((x) => x[0]).filter((b) => decode(b.replace(/<[^>]*>/g, '')).trim() === text);

/* ---------- primitives: names, states and relationships in rendered markup ---------- */

test('Switch is a named switch with state, description and disabled exposed in markup', () => {
  const m = markup.switch({ checked: true, label: 'Reduce motion', description: 'Turns off animation.' });
  const [btn] = openTags(m, 'button');
  assert.equal(attr(btn, 'role'), 'switch');
  assert.equal(attr(btn, 'aria-checked'), 'true');
  const labelId = attr(btn, 'aria-labelledby');
  assert.match(m, new RegExp(`<label[^>]*id="${escapeRe(labelId)}"[^>]*>Reduce motion</label>`), 'aria-labelledby points at the visible label');
  const descId = attr(btn, 'aria-describedby');
  assert.match(m, new RegExp(`<p[^>]*id="${escapeRe(descId)}"[^>]*>Turns off animation\\.</p>`), 'aria-describedby points at the description');
  assert.ok(!hasFlag(btn, 'disabled'));

  const off = markup.switch({ checked: false, label: 'Reduce motion', disabled: true });
  const [offBtn] = openTags(off, 'button');
  assert.equal(attr(offBtn, 'aria-checked'), 'false');
  assert.ok(hasFlag(offBtn, 'disabled'), 'disabled switch keeps its name and is disabled');
  assert.ok(attr(offBtn, 'aria-labelledby'));
});

test('Segmented is a radiogroup with one tabbable radio: the selected option', () => {
  const m = markup.segmented({
    value: 'b',
    label: 'Theme',
    options: [
      { value: 'a', label: 'Graphite' },
      { value: 'b', label: 'Nebula' },
      { value: 'c', label: 'Paper' },
    ],
  });
  assert.match(m, /role="radiogroup"[^>]*aria-label="Theme"/);
  const radios = openTags(m, 'button');
  assert.equal(radios.length, 3);
  assert.deepEqual(
    radios.map((r) => [attr(r, 'aria-checked'), attr(r, 'tabindex')]),
    [
      ['false', '-1'],
      ['true', '0'],
      ['false', '-1'],
    ],
  );
});

test('Segmented keeps one radio tabbable when the value is not one of its options', () => {
  const m = markup.segmented({
    value: 'removed',
    label: 'Theme',
    options: [
      { value: 'a', label: 'Graphite' },
      { value: 'b', label: 'Nebula' },
    ],
  });
  const tabbable = openTags(m, 'button').filter((r) => attr(r, 'tabindex') === '0');
  assert.equal(tabbable.length, 1);
});

test('Button marks a busy action as disabled and aria-busy, keeping its text as the name', () => {
  const busy = markup.button({ variant: 'primary', busy: true }, 'Save note');
  assert.match(busy, /<button[^>]*aria-busy="true"[^>]*>/);
  assert.ok(hasFlag(openTags(busy, 'button')[0], 'disabled'));
  assert.match(busy, /<span>Save note<\/span>/);
  assert.match(busy, /<svg[^>]*aria-hidden="true"/, 'the spinner is decorative');

  const idle = markup.button({ variant: 'primary' }, 'Save note');
  assert.ok(!hasFlag(openTags(idle, 'button')[0], 'disabled'));
  assert.equal(attr(openTags(idle, 'button')[0], 'aria-busy'), undefined);
});

test('IconButton is never unnamed: aria-label and title both come from its label', () => {
  const m = markup.iconButton({ label: 'Remove entry copied today' });
  const [btn] = openTags(m, 'button');
  assert.equal(attr(btn, 'aria-label'), 'Remove entry copied today');
  assert.equal(attr(btn, 'title'), 'Remove entry copied today');
});

test('Field ties its label and hint to the control by id', () => {
  const m = markup.field({ label: 'Allowed folder', hint: 'Only folders you add are readable.' });
  const [labelTag] = openTags(m, 'label');
  const [input] = openTags(m, 'input');
  assert.equal(attr(labelTag, 'for'), attr(input, 'id'));
  const describedBy = attr(input, 'aria-describedby');
  assert.match(m, new RegExp(`<p[^>]*id="${escapeRe(describedBy)}"[^>]*>Only folders you add are readable\\.</p>`));
});

test('Field error text is an alert and still linked to the control', () => {
  const m = markup.field({ label: 'Port', error: 'Enter a number between 1 and 65535.' });
  assert.match(m, /<p[^>]*role="alert"[^>]*>Enter a number between 1 and 65535\.<\/p>/);
  const [input] = openTags(m, 'input');
  assert.ok(attr(input, 'aria-describedby'));
});

test('Panel names its region from the heading it renders', () => {
  const m = markup.panel({ title: 'Activity log', eyebrow: 'Local' }, 'rows');
  const [section] = openTags(m, 'section');
  const labelledBy = attr(section, 'aria-labelledby');
  assert.match(m, new RegExp(`<h2 id="${escapeRe(labelledBy)}">Activity log</h2>`));
});

test('Notice uses alert only for danger and a note role otherwise', () => {
  assert.match(markup.notice({ tone: 'danger', title: 'Could not save' }, 'Try again.'), /role="alert"/);
  assert.match(markup.notice({ tone: 'warn', title: 'Not connected' }, 'Later.'), /role="note"/);
  assert.doesNotMatch(markup.notice({ tone: 'warn', title: 'Not connected' }, 'Later.'), /role="alert"/);
});

/* ---------- dialog: labelling, close control and closed state ---------- */

test('open Dialog labels its region with the visible title and describes it', () => {
  const m = markup.dialog({ open: true, title: 'Delete this note?', description: 'This cannot be undone.' });
  const [dialogTag] = openTags(m, 'dialog');
  const titleRef = attr(dialogTag, 'aria-labelledby');
  assert.match(m, new RegExp(`<h2 id="${escapeRe(titleRef)}">Delete this note\\?</h2>`));
  const descRef = attr(dialogTag, 'aria-describedby');
  assert.match(m, new RegExp(`<p[^>]*id="${escapeRe(descRef)}"[^>]*>This cannot be undone\\.</p>`));
  assert.match(m, /<button[^>]*aria-label="Close dialog"/);
});

test('a dismissible=false Dialog disables its close control while busy', () => {
  const m = markup.dialog({ open: true, title: 'Sending', dismissible: false });
  const close = openTags(m, 'button').find((b) => /aria-label="Close dialog"/.test(b));
  assert.ok(close);
  assert.ok(hasFlag(close, 'disabled'));
});

test('a closed Dialog renders no body or card, so its content is not in the accessibility tree', () => {
  const m = markup.dialog({ open: false, title: 'Delete this note?' });
  assert.doesNotMatch(m, /dialog-card/);
  assert.doesNotMatch(m, /Delete this note\?/);
  assert.doesNotMatch(m, /BODY/);
});

/* ---------- avatar and motion studio: named, reduced-motion aware, offline ---------- */

test('Avatar is a named image whose label carries its live state', () => {
  const m = markup.avatar('listening');
  const [el] = openTags(m, 'div');
  assert.equal(attr(el, 'role'), 'img');
  assert.equal(attr(el, 'aria-label'), 'Companion, listening');
  assert.equal(attr(el, 'data-state'), 'listening');
});

test('MotionStudio with reduced motion shows a Still state and disables Play', () => {
  const m = markup.motionStudio(true);
  assert.match(m, />Still</, 'badge says the scene is still');
  const [play] = buttonsNamed(m, 'Play');
  assert.ok(play, 'a Play button is rendered');
  assert.ok(hasFlag(openTags(play, 'button')[0], 'disabled'));
  assert.equal(attr(openTags(play, 'button')[0], 'title'), 'Disabled while reduced motion is on');
});

test('MotionStudio without reduced motion starts playing and leaves the toggle enabled', () => {
  const m = markup.motionStudio(false);
  assert.doesNotMatch(m, />Still</);
  assert.match(m, />Playing</);
  const [pause] = buttonsNamed(m, 'Pause');
  assert.ok(pause, 'the toggle is named Pause while playing');
  assert.equal(attr(openTags(pause, 'button')[0], 'aria-pressed'), undefined);
  assert.ok(!hasFlag(openTags(pause, 'button')[0], 'disabled'));
});

test('MotionStudio play toggle keeps one name for its state', () => {
  const m = markup.motionStudio(false);
  const [toggle] = buttonsNamed(m, 'Pause');
  assert.ok(toggle);
  assert.equal(attr(openTags(toggle, 'button')[0], 'aria-pressed'), undefined, 'a toggle with a changing name should not also carry aria-pressed');
});

/* ---------- offline import graph for the avatar and motion modules ---------- */

const studioEntries = [
  'src/components/MotionStudio.tsx',
  'src/components/AvatarStudio.tsx',
  'src/components/Avatar.tsx',
  'src/components/Companion.tsx',
  'src/ui/avatar-editor.ts',
  'src/ui/motion-presets.ts',
  'src/ui/companion.tsx',
  'src/ui/scenes.ts',
];

test('avatar and motion modules import only local source and the React and icon packages', async () => {
  const inputs = new Set();
  for (const entry of studioEntries) {
    // A remote or unknown specifier fails the bundle outright; the metafile then lists every module that was pulled in.
    const out = await build({
      entryPoints: [path.join(root, entry)],
      bundle: true,
      write: false,
      metafile: true,
      format: 'esm',
      platform: 'browser',
      absWorkingDir: root,
      loader: { '.css': 'empty' },
      jsx: 'automatic',
      logLevel: 'silent',
    });
    for (const key of Object.keys(out.metafile.inputs)) inputs.add(key.replace(/\\/g, '/'));
  }
  assert.ok(inputs.has('src/components/MotionStudio.tsx'), 'the audit covered MotionStudio');
  assert.ok(inputs.has('src/ui/motion-presets.ts'), 'the audit covered motion presets');
  const allowedPackage = /^node_modules\/(react|react-dom|scheduler|@phosphor-icons\/react)\//;
  const unexpected = [...inputs].filter((k) => !k.startsWith('src/') && !allowedPackage.test(k));
  assert.deepEqual(unexpected, [], 'no module outside the allowed local and package set');
});

/* ---------- keyboard map (pure functions behind the mounted shortcut handler) ---------- */

const key = (k, mods = {}) => ({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...mods });

test('Alt plus a digit opens the matching screen, with Alt+0 meaning the tenth screen', () => {
  assert.deepEqual(nav.shortcutAction(key('1', { altKey: true }), false), { kind: 'view', view: 'home' });
  // Positions follow VIEWS order: Alt+3 is the third entry (index 2), which is Companion.
  assert.deepEqual(nav.shortcutAction(key('3', { altKey: true }), false), { kind: 'view', view: nav.VIEWS[2].id });
  assert.equal(nav.VIEWS[2].id, 'companion');
  assert.deepEqual(nav.shortcutAction(key('0', { altKey: true }), false), { kind: 'view', view: nav.VIEWS[9].id });
  assert.equal(nav.VIEWS[9].shortcut, 'Alt+0');
});

test('shortcuts never fire with extra modifiers, with a dialog open, or for non-digits', () => {
  assert.equal(nav.shortcutAction(key('1', { altKey: true, ctrlKey: true }), false), null, 'Ctrl+Alt is AltGr on many layouts');
  assert.equal(nav.shortcutAction(key('1', { altKey: true, shiftKey: true }), false), null);
  assert.equal(nav.shortcutAction(key('1', { altKey: true }), true), null, 'a modal keeps its state');
  assert.equal(nav.shortcutAction(key('k', { altKey: true }), false), null);
  assert.equal(nav.shortcutAction(key('F1'), true), null);
});

test('Ctrl+K opens memory search and F1 opens help, both only without other modifiers', () => {
  assert.deepEqual(nav.shortcutAction(key('k', { ctrlKey: true }), false), { kind: 'search' });
  assert.deepEqual(nav.shortcutAction(key('K', { ctrlKey: true }), false), { kind: 'search' });
  assert.deepEqual(nav.shortcutAction(key('F1'), false), { kind: 'help' });
  assert.equal(nav.shortcutAction(key('F1', { shiftKey: true }), false), null);
});

test('every nav entry has a label and a blurb, and every hash round-trips to a known screen', () => {
  for (const v of nav.VIEWS) {
    assert.ok(v.label.trim(), `${v.id} has a label`);
    assert.ok(v.blurb.trim(), `${v.id} has a blurb`);
  }
  assert.equal(new Set(nav.VIEWS.map((v) => v.id)).size, nav.VIEWS.length, 'ids are unique');
  for (const v of nav.VIEWS) assert.equal(nav.parseHash(nav.hashFor(v.id)).view, v.id);
  assert.equal(nav.parseHash('#/does-not-exist').view, 'home');
});

test('only the first ten screens have a positional Alt+number shortcut', () => {
  const positional = nav.VIEWS.filter((v) => /^Alt\+\d$/.test(v.shortcut ?? ''));
  assert.equal(positional.length, 10);
  assert.equal(nav.VIEWS.length, 23, 'twenty earlier screens plus Memory, Writing and Guided setup');
});

test('Settings correctly describes only the first ten positional shortcuts', async () => {
  const everyScreenHasOne = nav.VIEWS.every((v) => /^Alt\+\d$/.test(v.shortcut ?? ''));
  assert.equal(everyScreenHasOne, false); const settings = await readFile(path.join(src, 'components/Settings.tsx'), 'utf8'); assert.match(settings, /The first ten screens/); assert.doesNotMatch(settings, /Every screen can be reached/);
});

/* ---------- declared colour tokens (computed from src/styles/tokens.css, not rendered pixels) ---------- */

const tokensCss = (await readFile(path.join(src, 'styles/tokens.css'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = {};
for (const m of tokensCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const vars = {};
  for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[d[1]] = d[2].trim();
  blocks[m[1].trim()] = vars;
}
const themes = {
  graphite: blocks[':root'],
  nebula: { ...blocks[':root'], ...blocks[':root[data-theme="nebula"]'] },
  paper: { ...blocks[':root'], ...blocks[':root[data-theme="paper"]'] },
};

const luminance = (hex) => {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg, bg) => {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const pair = (theme, fg, bg) => {
  const t = themes[theme];
  assert.ok(t[fg]?.startsWith('#') && t[bg]?.startsWith('#'), `${theme}: --${fg} and --${bg} are declared as hex`);
  return contrast(t[fg], t[bg]);
};

for (const theme of Object.keys(themes)) {
  test(`${theme}: body text tokens meet 4.5:1 on the page and on panels`, () => {
    for (const [fg, bg] of [
      ['text', 'bg'],
      ['text-2', 'bg'],
      ['muted', 'bg'],
      ['text', 'panel-solid'],
      ['text-2', 'panel-solid'],
      ['muted', 'panel-solid'],
      ['muted', 'raised'],
    ]) {
      assert.ok(pair(theme, fg, bg) >= 4.5, `--${fg} on --${bg} is ${pair(theme, fg, bg).toFixed(2)}`);
    }
  });

  test(`${theme}: accent-ink on accent and the focus ring meet their thresholds`, () => {
    assert.ok(pair(theme, 'accent-ink', 'accent') >= 4.5);
    assert.ok(pair(theme, 'focus', 'bg') >= 3);
  });
}

test('paper: warning amber text meets 4.5:1 on the page', () => {
  assert.ok(pair('paper', 'amber', 'bg') >= 4.5, `paper amber on bg is ${pair('paper', 'amber', 'bg').toFixed(2)}`);
});

for (const theme of Object.keys(themes)) {
  test(`${theme}: text-field borders (--field-line) meet 3:1 against the panel`, () => {
    assert.ok(pair(theme, 'field-line', 'panel-solid') >= 3, `--line on --panel-solid is ${pair(theme, 'field-line', 'panel-solid').toFixed(2)}`);
  });
}
