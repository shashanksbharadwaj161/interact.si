// Accessibility milestone: Switch naming in rendered markup, forced-colors and reduced-motion rules in the stylesheet,
// and the stylesheet import the shell entry must keep.
// Static checks only. The Switch is rendered with react-dom/server (bundled in memory with esbuild, nothing written to disk),
// and the stylesheet is read as text. No DOM, no focus, no clicks and no screen reader is driven, so these tests make no
// claim about what assistive technology announces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(root, 'src/ui');

// react-dom/server's CommonJS build requires Node built-ins, so the in-memory bundle gets a real require (as in the shell runtime test).
const requireBanner = `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});`;

/** Bundles a TypeScript entry in memory and imports the result as an ES module. */
async function loadBundle(entry) {
  const out = await build({ ...entry, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', banner: { js: requireBanner } });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}

// Probe entry: renders an array of Switch props into one static page. Bundled from stdin, so no file is written.
const { renderSwitches } = await loadBundle({
  stdin: {
    contents: `import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Switch } from './primitives';
export const renderSwitches = (list) => renderToStaticMarkup(createElement('div', null, list.map((p, i) => createElement(Switch, { key: i, ...p }))));
`,
    resolveDir: uiDir,
    sourcefile: 'switch-probe.tsx',
    loader: 'tsx',
  },
  jsx: 'automatic',
});

const a = await loadBundle({ entryPoints: [path.join(uiDir, 'accessibility.ts')] });
const css = await readFile(path.join(root, 'src/styles/accessibility.css'), 'utf8');
const mainSource = await readFile(path.join(root, 'src/main.tsx'), 'utf8');

/* ---------- helpers for the rendered markup ---------- */

const decode = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const textOf = (inner) => decode(inner.replace(/<[^>]*>/g, '')).trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function attrsOf(text) {
  const attrs = {};
  for (const m of text.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[m[1]] = m[2] ?? '';
  return attrs;
}

/** Every switch button in the markup, with its attributes and inner HTML. */
function switches(html) {
  return [...html.matchAll(/<button\b([^>]*\brole="switch"[^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: attrsOf(m[1]), inner: m[2] }));
}

/** The text of the element with this id, or null when no element has it. */
function textById(html, id) {
  const m = new RegExp(`<(\\w+)\\b[^>]*\\bid="${escapeRe(id)}"[^>]*>([\\s\\S]*?)<\\/\\1>`).exec(html);
  return m ? textOf(m[2]) : null;
}

/**
 * Accessible name as the markup states it: aria-labelledby first (each id's text joined by spaces), then aria-label,
 * then a <label for> pointing at the control. Returns '' when none resolves. This reads the markup; it is not a browser computation.
 */
function nameOfSwitch(html, s) {
  if (s.attrs['aria-labelledby']) {
    return s.attrs['aria-labelledby']
      .split(/\s+/)
      .map((id) => textById(html, id) ?? '')
      .join(' ')
      .trim();
  }
  if (s.attrs['aria-label']) return decode(s.attrs['aria-label']);
  const labelFor = new RegExp(`<label\\b[^>]*\\bfor="${escapeRe(s.attrs.id ?? '')}"[^>]*>([\\s\\S]*?)<\\/label>`).exec(html);
  return labelFor ? textOf(labelFor[1]) : '';
}

/* ---------- helpers for the stylesheet ---------- */

/** The body of the block whose "{" follows index, balancing nested braces. */
function blockAt(text, index) {
  const open = text.indexOf('{', index);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block at ${index}`);
}

/** Innermost rules in a piece of CSS: whitespace-collapsed selector and a property map (last declaration wins). */
function rulesIn(text) {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].replace(/\s+/g, ' ').trim(),
    declarations: Object.fromEntries(
      m[2]
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
    ),
  }));
}

const forcedStart = css.indexOf('@media (forced-colors: active)');
const reducedStart = css.indexOf('@media (prefers-reduced-motion: reduce)');
const forcedRules = forcedStart >= 0 ? rulesIn(blockAt(css, forcedStart)) : [];

const SYSTEM_COLORS = new Set(['Highlight', 'HighlightText', 'GrayText', 'ButtonText', 'ButtonFace', 'Canvas', 'CanvasText', 'LinkText', 'VisitedText', 'Field', 'FieldText', 'Mark', 'MarkText', 'AccentColor', 'AccentColorText']);
const NON_COLOR_KEYWORDS = new Set(['solid', 'none', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset', 'hidden', 'thin', 'medium', 'thick', 'auto']);
const COLOR_PROPERTIES = new Set(['color', 'background', 'background-color', 'border', 'border-color', 'outline', 'outline-color']);

/* ---------- Switch markup (rendered with react-dom/server) ---------- */

test('an enabled and a disabled switch are each named by aria-labelledby that resolves to their visible label', () => {
  const html = renderSwitches([
    { checked: false, onChange: () => {}, label: 'Reduce motion', description: 'Turns off animation.', disabled: true },
    { checked: true, onChange: () => {}, label: 'Enabled' },
  ]);
  const [disabled, enabled] = switches(html);
  assert.equal(nameOfSwitch(html, disabled), 'Reduce motion', 'disabled switch keeps its name');
  assert.equal(nameOfSwitch(html, enabled), 'Enabled');
  assert.equal(disabled.attrs.disabled, '', 'disabled attribute is present on the disabled switch');
  assert.equal(enabled.attrs.disabled, undefined, 'enabled switch is not disabled');
});

test('a disabled switch is named by aria-labelledby alone, not by a second aria-label copy', () => {
  const html = renderSwitches([{ checked: false, onChange: () => {}, label: 'Start in the system tray', disabled: true }]);
  const [s] = switches(html);
  assert.ok(s.attrs['aria-labelledby'], 'aria-labelledby set');
  assert.equal(s.attrs['aria-label'], undefined);
  assert.equal(textById(html, s.attrs['aria-labelledby']), 'Start in the system tray');
});

test('the description is linked with aria-describedby and the link resolves to the description text', () => {
  const html = renderSwitches([{ checked: false, onChange: () => {}, label: 'Quiet success messages', description: 'Hides the small saved messages.', disabled: true }]);
  const [s] = switches(html);
  assert.ok(s.attrs['aria-describedby'], 'aria-describedby set');
  assert.equal(textById(html, s.attrs['aria-describedby']), 'Hides the small saved messages.');
});

test('a switch without a description has no aria-describedby', () => {
  const html = renderSwitches([{ checked: true, onChange: () => {}, label: 'Enabled' }]);
  assert.equal(switches(html)[0].attrs['aria-describedby'], undefined);
});

test('ids stay unique across a page of switches, and each name resolves to its own label', () => {
  const html = renderSwitches([
    { checked: false, onChange: () => {}, label: 'Reduce motion', description: 'One.', disabled: true },
    { checked: false, onChange: () => {}, label: 'Enabled', description: 'Two.' },
    { checked: true, onChange: () => {}, label: 'Undoable' },
  ]);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
  assert.deepEqual(
    switches(html).map((s) => nameOfSwitch(html, s)),
    ['Reduce motion', 'Enabled', 'Undoable'],
  );
});

test('the knob is decorative and hidden from assistive technology, so it adds no name', () => {
  const [s] = switches(renderSwitches([{ checked: true, onChange: () => {}, label: 'Enabled' }]));
  assert.match(s.inner, /<span class="switch-knob" aria-hidden="true"><\/span>/);
  assert.equal(textOf(s.inner), '');
});

test('checked state is exposed as aria-checked, the attribute the forced-colors rules select', () => {
  const [on, off] = switches(
    renderSwitches([
      { checked: true, onChange: () => {}, label: 'On' },
      { checked: false, onChange: () => {}, label: 'Off' },
    ]),
  );
  assert.equal(on.attrs['aria-checked'], 'true');
  assert.equal(off.attrs['aria-checked'], 'false');
  assert.ok(css.includes(`[aria-checked='true']`), 'stylesheet selects aria-checked true');
});

test('a label containing an apostrophe still resolves to the same text', () => {
  const html = renderSwitches([{ checked: false, onChange: () => {}, label: "Don't show again", disabled: true }]);
  assert.equal(nameOfSwitch(html, switches(html)[0]), "Don't show again");
});

/* ---------- Stylesheet: focus ---------- */

test('focus outline covers switches with the focus token and never removes focus', () => {
  const focusRule = /:where\(([^)]*)\):focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\)/.exec(css);
  assert.ok(focusRule, 'focus rule present');
  assert.ok(focusRule[1].includes("[role='switch']"), 'switch role included');
  assert.ok(focusRule[1].includes('button'), 'button included');
  assert.doesNotMatch(css, /outline\s*:\s*(none|0)\b/);
});

/* ---------- Stylesheet: forced colors ---------- */

test('forced-colors block exists and every colour, border and background value is a system colour keyword', () => {
  assert.ok(forcedStart >= 0, 'forced-colors media block present');
  assert.ok(forcedRules.length >= 6, `expected several rules, found ${forcedRules.length}`);
  for (const rule of forcedRules) {
    for (const [property, value] of Object.entries(rule.declarations)) {
      if (!COLOR_PROPERTIES.has(property)) continue;
      const words = value.split(/\s+/).filter((w) => /^[A-Za-z]+$/.test(w) && !NON_COLOR_KEYWORDS.has(w));
      for (const word of words) assert.ok(SYSTEM_COLORS.has(word), `${rule.selector} ${property}: ${word} is not a system colour`);
    }
  }
});

test('forced-colors gives the switch track a system-colour border and the knob a system-colour fill', () => {
  const track = forcedRules.find((r) => r.selector === '.switch');
  assert.ok(track, '.switch rule in forced colors');
  assert.equal(track.declarations.border, '1px solid ButtonText');
  const knob = forcedRules.find((r) => r.selector === '.switch .switch-knob, .switch.on .switch-knob');
  assert.ok(knob, 'knob rule covers both off and on states');
  assert.equal(knob.declarations.background, 'ButtonText');
});

test('forced-colors marks a disabled switch knob GrayText', () => {
  const disabledKnob = forcedRules.find((r) => r.selector === '.switch:disabled .switch-knob');
  assert.ok(disabledKnob, 'disabled knob rule present');
  assert.equal(disabledKnob.declarations.background, 'GrayText');
});

test('forced-colors state rules come after the base switch rule, so checked and disabled states win the cascade', () => {
  const at = (pred) => forcedRules.findIndex(pred);
  const base = at((r) => r.selector === '.switch');
  const onKnob = at((r) => r.selector.includes('.switch.on .switch-knob'));
  const checked = at((r) => r.selector.includes("[aria-checked='true']"));
  const disabled = at((r) => r.selector === ':disabled, [aria-disabled=\'true\']');
  const disabledKnob = at((r) => r.selector === '.switch:disabled .switch-knob');
  assert.ok(base >= 0 && checked > base, 'checked rule follows the base switch rule');
  assert.ok(onKnob > base, 'on-state knob rule follows the base switch rule');
  assert.ok(disabled > base && disabledKnob > onKnob, 'disabled rules follow the on-state knob rule');
});

test('forced-colors keeps the checked and disabled rules that the switch relies on', () => {
  assert.ok(forcedRules.some((r) => r.selector.includes("[aria-checked='true']") && r.declarations['border-color'] === 'Highlight'));
  assert.ok(forcedRules.some((r) => r.selector.includes(':disabled') && r.declarations.color === 'GrayText'));
});

/* ---------- Stylesheet: reduced motion ---------- */

test('reduced motion from the OS query shortens animation, transition and smooth scrolling without removing them', () => {
  assert.ok(reducedStart >= 0, 'prefers-reduced-motion block present');
  const [rule] = rulesIn(blockAt(css, reducedStart));
  assert.equal(rule.declarations['animation-duration'], '0.01ms !important');
  assert.equal(rule.declarations['transition-duration'], '0.01ms !important');
  assert.equal(rule.declarations['scroll-behavior'], 'auto !important');
  assert.equal(rule.declarations['animation-iteration-count'], '1 !important');
});

test('reduced motion from the in-app setting uses the same rules, selected by the data-motion value the module writes', () => {
  const el = { dataset: {} };
  a.applyAccessibilityAttributes(el, { reduceMotion: true, forcedColors: false });
  const rule = rulesIn(css).find((r) => r.selector.startsWith(`:root[data-motion='${el.dataset.motion}']`));
  assert.ok(rule, 'app setting rule present');
  assert.equal(rule.declarations['transition-duration'], '0.01ms !important');
  assert.equal(rule.declarations['scroll-behavior'], 'auto !important');
});

test('the reduced-motion rules target every element, so the switch knob transition is covered too', () => {
  const [rule] = rulesIn(blockAt(css, reducedStart));
  assert.ok(rule.selector.split(', ').includes('*'), rule.selector);
});

/* ---------- Shell import requirement ---------- */

test('the published stylesheet path points at a real file', () => {
  assert.equal(a.ACCESSIBILITY_STYLESHEET, './styles/accessibility.css');
  assert.ok(existsSync(path.join(root, 'src', a.ACCESSIBILITY_STYLESHEET.replace(/^\.\//, ''))));
});

test('the shell entry imports the accessibility stylesheet after every component stylesheet', () => {
  const imports = [...mainSource.matchAll(/^import\s+'(\.\/styles\/[^']+\.css)';/gm)].map((m) => m[1]);
  assert.ok(imports.includes(a.ACCESSIBILITY_STYLESHEET), 'src/main.tsx imports the accessibility stylesheet');
  const own = imports.indexOf(a.ACCESSIBILITY_STYLESHEET);
  for (const other of imports.filter((i) => i !== a.ACCESSIBILITY_STYLESHEET)) {
    assert.ok(imports.indexOf(other) < own, `${other} must load before the accessibility stylesheet`);
  }
});

test('the stylesheet parses with no warnings', async () => {
  const result = await transform(css, { loader: 'css', logLevel: 'silent' });
  assert.equal(result.warnings.length, 0, result.warnings.map((w) => w.text).join('; '));
});
