// Clipboard history search, day grouping, keyboard targets and summary (pure helpers in src/ui/clipboard-history.ts),
// plus render and source checks for the Clipboard panel. No system clipboard, network or native access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints: [path.join(root, 'src/ui/clipboard-history.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent'});
const ch = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {HISTORY_LIMITS, filterEntries, groupByDay, historyKeyboardTarget, summarizeEntries, focusAfterRemoval} = ch;

const NOW = Date.UTC(2026, 3, 10, 12, 0, 0);
const DAY = 86_400_000;
const e = (id, preview, capturedAt, copies = 1) => ({id, preview, capturedAt, copies});

test('filterEntries: empty or whitespace query returns the entries unchanged', () => {
  const list = [e('b', 'Beta', NOW - 5), e('a', 'Alpha', NOW)];
  assert.deepEqual(filterEntries(list, ''), list);
  assert.deepEqual(filterEntries(list, '   \t '), list);
  assert.notEqual(filterEntries(list, ''), list, 'a copy, not the caller array');
  assert.deepEqual(filterEntries([], 'x'), []);
  assert.equal(HISTORY_LIMITS.maxQueryChars > 0, true);
});

test('filterEntries: every word must match (AND), case-insensitively, in any order', () => {
  const list = [e('1', 'Meeting notes for Friday', NOW), e('2', 'Friday lunch order', NOW - 1), e('3', 'notes about lunch', NOW - 2)];
  assert.deepEqual(filterEntries(list, 'friday').map((x) => x.id), ['1', '2']);
  assert.deepEqual(filterEntries(list, '  NOTES   friday ').map((x) => x.id), ['1']);
  assert.deepEqual(filterEntries(list, 'lunch notes').map((x) => x.id), ['3']);
  assert.deepEqual(filterEntries(list, 'friday missing'), []);
});

test('filterEntries: accents are folded on both sides', () => {
  const list = [e('1', 'Café crème at the résumé desk', NOW), e('2', 'cafe plain', NOW - 1), e('3', 'tea', NOW - 2)];
  assert.deepEqual(filterEntries(list, 'cafe').map((x) => x.id), ['1', '2']);
  assert.deepEqual(filterEntries(list, 'CAFÉ').map((x) => x.id), ['1', '2']);
  assert.deepEqual(filterEntries(list, 'resume creme').map((x) => x.id), ['1']);
});

test('filterEntries: results are newest first with id ascending as the tie-break; invalid times last', () => {
  const list = [e('c', 'note', NOW - 10), e('b', 'note', NOW), e('a', 'note', NOW), e('z', 'note', NaN), e('d', 'note', NOW + 5)];
  assert.deepEqual(filterEntries(list, 'note').map((x) => x.id), ['d', 'a', 'b', 'c', 'z']);
  assert.deepEqual(list.map((x) => x.id), ['c', 'b', 'a', 'z', 'd'], 'input is not mutated');
});

test('groupByDay: Today, Yesterday, exact ISO date and Unknown time groups, newest first', () => {
  const list = [
    e('old', 'x', NOW - 3 * DAY),
    e('bad', 'x', NaN),
    e('t2', 'x', NOW - 60_000),
    e('y', 'x', NOW - DAY),
    e('t1', 'x', NOW),
    e('huge', 'x', 1e20),
    e('str', 'x', 'yesterday'),
  ];
  const groups = groupByDay(list, NOW);
  assert.deepEqual(groups.map((g) => g.label), ['Today', 'Yesterday', '2026-04-07', 'Unknown time']);
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', '2026-04-07', 'unknown']);
  assert.deepEqual(groups[0].entries.map((x) => x.id), ['t1', 't2']);
  assert.deepEqual(groups[1].entries.map((x) => x.id), ['y']);
  assert.deepEqual(groups[3].entries.map((x) => x.id).sort(), ['bad', 'huge', 'str']);
  assert.deepEqual(groupByDay([], NOW), []);
  assert.throws(() => groupByDay(list, NaN), /now must be a finite/);
});

test('historyKeyboardTarget: every key branch, no wrap, unhandled key and empty list give null', () => {
  assert.equal(historyKeyboardTarget('ArrowDown', 0, 3), 1);
  assert.equal(historyKeyboardTarget('ArrowDown', 2, 3), 2, 'no wrap at the end');
  assert.equal(historyKeyboardTarget('ArrowUp', 2, 3), 1);
  assert.equal(historyKeyboardTarget('ArrowUp', 0, 3), 0, 'no wrap at the start');
  assert.equal(historyKeyboardTarget('Home', 2, 3), 0);
  assert.equal(historyKeyboardTarget('End', 0, 3), 2);
  assert.equal(historyKeyboardTarget('ArrowDown', 9, 3), 2, 'out-of-range index is clamped');
  assert.equal(historyKeyboardTarget('Enter', 1, 3), null);
  assert.equal(historyKeyboardTarget('a', 1, 3), null);
  assert.equal(historyKeyboardTarget('ArrowDown', 0, 0), null);
  assert.throws(() => historyKeyboardTarget('Home', 0, -1), /count must be a non-negative integer/);
  assert.throws(() => historyKeyboardTarget('Home', 0.5, 2), /index must be an integer/);
});

test('focusAfterRemoval keeps focus on the nearest remaining row', () => {
  assert.equal(focusAfterRemoval(1, 2), 1);
  assert.equal(focusAfterRemoval(2, 2), 1, 'last row removed: focus moves up');
  assert.equal(focusAfterRemoval(0, 0), null);
});

test('summarizeEntries: empty and non-empty lists', () => {
  assert.deepEqual(summarizeEntries([]), {count: 0, oldestAt: null, newestAt: null, totalCopies: 0});
  const s = summarizeEntries([e('a', 'x', NOW, 3), e('b', 'y', NOW - DAY, 2), e('c', 'z', NaN, 1)]);
  assert.deepEqual(s, {count: 3, oldestAt: NOW - DAY, newestAt: NOW, totalCopies: 6});
});

test('descriptive errors for non-array entries and non-string query', () => {
  assert.throws(() => filterEntries(null, 'x'), /filterEntries: entries must be an array/);
  assert.throws(() => filterEntries('abc', 'x'), /entries must be an array.*string/);
  assert.throws(() => filterEntries([], 5), /filterEntries: query must be a string, got number/);
  assert.throws(() => filterEntries([], null), /query must be a string, got null/);
  assert.throws(() => groupByDay({}, NOW), /groupByDay: entries must be an array/);
  assert.throws(() => summarizeEntries(undefined), /summarizeEntries: entries must be an array/);
});

test('Clipboard.tsx wires search, grouping and keyboard helpers and makes no network or clipboard-write calls', () => {
  const src = readFileSync(path.join(root, 'src/components/Clipboard.tsx'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(src, /navigator\.clipboard|writeText/);
  assert.match(src, /aria-label="Search clipboard history"/);
  assert.match(src, /filterEntries\(entries, query\)/);
  assert.match(src, /groupByDay\(/);
  assert.match(src, /historyKeyboardTarget\(ev\.key/);
  assert.match(src, /ev\.key === 'Delete'/);
  assert.match(src, /void remove\(entry\)/);
  assert.match(src, /of \$\{entries\.length\} \$\{entries\.length === 1 \? 'entry' : 'entries'\} match/);
  assert.match(src, /ConfirmDialog/);
});

test('Clipboard panel renders search, result count, day headings and a roving tabindex', async () => {
  const iconNames = new Set();
  for (const f of ['src/components/Clipboard.tsx', 'src/ui/primitives.tsx', 'src/ui/Dialog.tsx']) {
    const text = readFileSync(path.join(root, f), 'utf8');
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@phosphor-icons\/react'/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
        if (name) iconNames.add(name);
      }
    }
  }
  const out = await build({
    stdin: {resolveDir: root, sourcefile: 'clip-history-entry.ts', loader: 'ts', contents: `export { Clipboard } from './src/components/Clipboard.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`},
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    banner: {js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(${JSON.stringify(path.join(root, 'package.json'))});`},
    plugins: [{name: 'icon-stub', setup(b) {
      b.onResolve({filter: /^@phosphor-icons\/react$/}, () => ({path: 'icons', namespace: 'icon-stub'}));
      b.onLoad({filter: /.*/, namespace: 'icon-stub'}, () => ({contents: [...iconNames].map((n) => `export const ${n} = () => null;`).join(';')}));
    }}],
  });
  const {Clipboard, createElement: h, renderToStaticMarkup: render} = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  const now = Date.now();
  const status = {enabled: true, persisted: false, count: 3, maxEntries: 50, retentionMs: DAY, maxChars: 5000};
  const entries = [e('a', 'first', now, 1), e('b', 'second', now - 1000, 2), e('c', 'third', NaN, 1)];
  const client = {status: async () => status, setEnabled: async () => status, list: async () => entries, get: async () => null, remove: async () => true, purge: async () => status};
  const markup = render(h(Clipboard, {client, initial: {status, entries}}));
  assert.match(markup, /aria-label="Search clipboard history"/);
  assert.match(markup, /3 of 3 entries match/);
  assert.match(markup, />Today</);
  assert.match(markup, />Unknown time</);
  assert.equal(markup.match(/tabindex="0"/g)?.length, 1, 'exactly one row is in the tab order');
  assert.equal(markup.match(/tabindex="-1"/g)?.length, 2);
  assert.doesNotMatch(markup, /Copy again/);
});
