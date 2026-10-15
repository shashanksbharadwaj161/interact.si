// Accessibility helpers and stylesheet: system preferences, reduced motion, forced colors, focus and shortcut mapping.
// Bundles the real TypeScript module in memory and calls it with fake matchMedia, dataset and key-event objects.
// No window, storage, Electron or desktop input is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = await build({
  entryPoints: [path.join(root, 'src/ui/accessibility.ts')],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  logLevel: 'silent',
});
const code = out.outputFiles[0].text;
const a = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const css = await readFile(path.join(root, 'src/styles/accessibility.css'), 'utf8');

/** Fake matchMedia: `matching` lists the queries that match. Each returned list records its listeners. */
function fakeMatchMedia(matching = []) {
  const lists = new Map();
  const matchMedia = (query) => {
    if (!lists.has(query)) {
      const listeners = new Set();
      lists.set(query, {
        matches: matching.includes(query),
        listeners,
        addEventListener: (type, fn) => type === 'change' && listeners.add(fn),
        removeEventListener: (type, fn) => listeners.delete(fn),
      });
    }
    return lists.get(query);
  };
  return { matchMedia, lists };
}

const key = (k, mods = {}) => ({ key: k, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...mods });

test('module is DOM-free: no window, document, storage or React references', () => {
  assert.ok(!/\bdocument\b|\bwindow\b|localStorage|from ['"]react['"]/.test(code));
});

test('readSystemPreferences reads each query and reports no preference when matchMedia is missing or silent', () => {
  const { matchMedia, lists } = fakeMatchMedia([a.MEDIA.forcedColors]);
  assert.deepEqual(a.readSystemPreferences(matchMedia), { reducedMotion: false, forcedColors: true });
  assert.deepEqual([...lists.keys()].sort(), [a.MEDIA.forcedColors, a.MEDIA.reducedMotion].sort());
  assert.deepEqual(a.readSystemPreferences(undefined), { reducedMotion: false, forcedColors: false });
  assert.deepEqual(a.readSystemPreferences(() => undefined), { reducedMotion: false, forcedColors: false });
});

test('MEDIA holds the exact queries the stylesheet and the OS report', () => {
  assert.equal(a.MEDIA.reducedMotion, '(prefers-reduced-motion: reduce)');
  assert.equal(a.MEDIA.forcedColors, '(forced-colors: active)');
});

test('watchSystemPreferences reports a changed preference and removes its listeners on cleanup', () => {
  const { matchMedia, lists } = fakeMatchMedia([]);
  const seen = [];
  const stop = a.watchSystemPreferences(matchMedia, (p) => seen.push(p));
  assert.equal(lists.get(a.MEDIA.reducedMotion).listeners.size, 1);
  assert.equal(lists.get(a.MEDIA.forcedColors).listeners.size, 1);

  lists.get(a.MEDIA.reducedMotion).matches = true;
  for (const fn of lists.get(a.MEDIA.reducedMotion).listeners) fn();
  assert.deepEqual(seen, [{ reducedMotion: true, forcedColors: false }]);

  stop();
  assert.equal(lists.get(a.MEDIA.reducedMotion).listeners.size, 0);
  assert.equal(lists.get(a.MEDIA.forcedColors).listeners.size, 0);
});

test('watchSystemPreferences without matchMedia is a silent no-op', () => {
  const stop = a.watchSystemPreferences(undefined, () => assert.fail('must not be called'));
  assert.equal(typeof stop, 'function');
  stop();
});

test('resolveReducedMotion: either the OS or the in-app setting requests reduction, and only literal true counts', () => {
  assert.equal(a.resolveReducedMotion(false, false), false);
  assert.equal(a.resolveReducedMotion(true, false), true);
  assert.equal(a.resolveReducedMotion(false, true), true);
  assert.equal(a.resolveReducedMotion('yes', 'true'), false);
});

test('normalizeAccessibilityPrefs keeps only a literal true and drops unknown data', () => {
  assert.deepEqual(a.normalizeAccessibilityPrefs(null), a.DEFAULT_ACCESSIBILITY_PREFS);
  assert.deepEqual(a.normalizeAccessibilityPrefs(['reduceMotion']), a.DEFAULT_ACCESSIBILITY_PREFS);
  assert.deepEqual(a.normalizeAccessibilityPrefs({ reduceMotion: 'true' }), { reduceMotion: false });
  assert.deepEqual(a.normalizeAccessibilityPrefs({ reduceMotion: 1, extra: 'dropped' }), { reduceMotion: false });
  assert.deepEqual(a.normalizeAccessibilityPrefs({ reduceMotion: true, extra: 'dropped' }), { reduceMotion: true });
});

test('resolveAccessibilityState combines the OS and in-app reduce-motion settings and forwards forced colors', () => {
  assert.deepEqual(a.resolveAccessibilityState({ reducedMotion: true, forcedColors: false }, { reduceMotion: false }), { reduceMotion: true, forcedColors: false });
  assert.deepEqual(a.resolveAccessibilityState({ reducedMotion: false, forcedColors: true }, { reduceMotion: true }), { reduceMotion: true, forcedColors: true });
  assert.deepEqual(a.resolveAccessibilityState({ reducedMotion: false, forcedColors: false }, { reduceMotion: false }), { reduceMotion: false, forcedColors: false });
});

test('applyAccessibilityAttributes writes data-motion and data-forced-colors for the stylesheet to read', () => {
  const el = { dataset: {} };
  a.applyAccessibilityAttributes(el, { reduceMotion: true, forcedColors: true });
  assert.deepEqual(el.dataset, { motion: 'reduced', forcedColors: 'active' });
  a.applyAccessibilityAttributes(el, { reduceMotion: false, forcedColors: false });
  assert.deepEqual(el.dataset, { motion: 'full', forcedColors: 'none' });
});

test('parseChord accepts aliases and any letter case, and rejects unknown modifiers or a missing key', () => {
  assert.deepEqual(a.parseChord('control+SHIFT+s'), { key: 's', alt: false, ctrl: true, shift: true, meta: false });
  assert.deepEqual(a.parseChord('Win+Alt+1'), { key: '1', alt: true, ctrl: false, shift: false, meta: true });
  assert.equal(a.parseChord('Hyper+1'), null);
  assert.equal(a.parseChord('Alt+'), null);
  assert.equal(a.parseChord(''), null);
});

test('matchesChord requires the exact key and the exact modifier set', () => {
  const ctrlShiftS = key('S', { ctrlKey: true, shiftKey: true });
  assert.equal(a.matchesChord('Ctrl+Shift+s', ctrlShiftS), true);
  assert.equal(a.matchesChord('Ctrl+s', ctrlShiftS), false, 'an extra Shift must not match');
  assert.equal(a.matchesChord('Alt+1', ctrlShiftS), false);
  assert.equal(a.matchesChord('Hyper+s', ctrlShiftS), false, 'an unparsed chord never matches');
  assert.equal(a.matchesChord('Escape', key('Escape')), true);
});

test('VIEW_SHORTCUTS maps positions 1 to 10 once each, with Alt+0 for position 10', () => {
  assert.equal(a.VIEW_SHORTCUTS.length, 10);
  assert.deepEqual(a.VIEW_SHORTCUTS.map((s) => s.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(a.VIEW_SHORTCUTS.map((s) => s.chord)).size, 10);
  assert.equal(a.VIEW_SHORTCUTS[0].chord, 'Alt+1');
  assert.equal(a.VIEW_SHORTCUTS[8].chord, 'Alt+9');
  assert.equal(a.VIEW_SHORTCUTS[9].chord, 'Alt+0');
});

test('viewShortcut returns null outside positions 1 to 10, so Alt+11 is never offered', () => {
  assert.equal(a.viewShortcut(1), 'Alt+1');
  assert.equal(a.viewShortcut(10), 'Alt+0');
  assert.equal(a.viewShortcut(11), null);
  assert.equal(a.viewShortcut(0), null);
  assert.equal(a.viewShortcut(1.5), null);
});

test('viewPositionFromEvent accepts only Alt plus a digit, within the view count', () => {
  assert.equal(a.viewPositionFromEvent(key('3', { altKey: true })), 3);
  assert.equal(a.viewPositionFromEvent(key('0', { altKey: true })), 10);
  assert.equal(a.viewPositionFromEvent(key('3')), null, 'no Alt');
  assert.equal(a.viewPositionFromEvent(key('3', { altKey: true, shiftKey: true })), null, 'extra Shift');
  assert.equal(a.viewPositionFromEvent(key('3', { altKey: true, ctrlKey: true })), null, 'extra Ctrl');
  assert.equal(a.viewPositionFromEvent(key('3', { altKey: true, metaKey: true })), null, 'extra Meta');
  assert.equal(a.viewPositionFromEvent(key('a', { altKey: true })), null, 'not a digit');
  assert.equal(a.viewPositionFromEvent(key('4', { altKey: true }), 3), null, 'beyond the view count');
  assert.equal(a.viewPositionFromEvent(key('0', { altKey: true }), 9), null, 'Alt+0 needs a tenth view');
  assert.equal(a.viewPositionFromEvent(key('9', { altKey: true }), 40), 9, 'the count is capped at ten');
});

test('every shortcut label round-trips to the same view position from a key event', () => {
  for (const { position, chord } of a.VIEW_SHORTCUTS) {
    const digit = chord.slice(-1);
    assert.equal(a.matchesChord(chord, key(digit, { altKey: true })), true, chord);
    assert.equal(a.viewPositionFromEvent(key(digit, { altKey: true })), position, chord);
  }
});

test('stylesheet is valid CSS that esbuild parses without errors or warnings', async () => {
  const result = await transform(css, { loader: 'css', logLevel: 'silent' });
  assert.equal(result.warnings.length, 0, result.warnings.map((w) => w.text).join('; '));
});

test('stylesheet media queries are the strings the TypeScript module exposes', () => {
  assert.ok(css.includes(`@media ${a.MEDIA.reducedMotion}`));
  assert.ok(css.includes(`@media ${a.MEDIA.forcedColors}`));
});

test('stylesheet selects the data-motion value that the module writes for reduced motion', () => {
  const el = { dataset: {} };
  a.applyAccessibilityAttributes(el, { reduceMotion: true, forcedColors: false });
  assert.ok(css.includes(`:root[data-motion='${el.dataset.motion}']`));
});

test('stylesheet never removes focus: no outline none or zero', () => {
  assert.ok(!/outline\s*:\s*(none|0)\b/.test(css));
  assert.match(css, /:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\)/);
});

test('reduced motion only shortens animation, transition and smooth scrolling', () => {
  const importantLines = css.split('\n').filter((line) => line.includes('!important'));
  assert.ok(importantLines.length > 0);
  for (const line of importantLines) {
    assert.match(line, /animation|transition|scroll-behavior/, line.trim());
  }
});

test('forced-colors block uses system color keywords only, never literal colors', () => {
  const start = css.indexOf('@media (forced-colors: active)');
  assert.ok(start >= 0, 'forced-colors block present');
  const block = css.slice(start);
  const systemColors = new Set(['Highlight', 'GrayText', 'ButtonText', 'CanvasText', 'Canvas', 'ButtonFace', 'LinkText', 'HighlightText']);
  const colorValues = [...block.matchAll(/([a-z-]*color)\s*:\s*([^;}]+)[;}]/gi)].map((m) => m[2].trim());
  assert.ok(colorValues.length >= 4, `expected several color declarations, found ${colorValues.length}`);
  for (const value of colorValues) assert.ok(systemColors.has(value), `not a system color: ${value}`);
});
