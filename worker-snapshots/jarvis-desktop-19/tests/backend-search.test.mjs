// Search service tests: ranking, folding, limits, sanitizing, chat opt-in, and the MemorySearch markup.
// Bundles the real TypeScript in memory; nothing touches the filesystem or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = ['ChatCircleDots', 'CheckSquare', 'Cube', 'MagnifyingGlass', 'Note', 'CircleNotch', 'Info', 'Warning', 'WarningCircle'];
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backend-search-entry.ts',
    loader: 'tsx',
    contents: `
      export * as search from './electron/services/search.ts';
      export { MemorySearch } from './src/components/MemorySearch.tsx';
      export { createElement } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  // react-dom/server's CommonJS build requires Node built-ins; give the in-memory module a real require.
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(path.join(root, 'package.json'))});` },
  plugins: [
    {
      name: 'icon-stub',
      setup(b) {
        b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'icon-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'icon-stub' }, () => ({ contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n') }));
      },
    },
  ],
  logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { search, MemorySearch, createElement, renderToStaticMarkup } = mod;
const { searchState, parseQuery, foldText, sanitizeText, groupResults, SEARCH_LIMITS } = search;

const T = '2026-10-01T00:00:00.000Z';
function state(over = {}) {
  return {
    settings: {},
    notes: [
      { id: 'n-budget', title: 'Quarterly budget', body: 'Review vendor invoices before Friday.', tags: ['finance'], updatedAt: T },
      { id: 'n-recipe', title: 'Crème Brûlée', body: 'Custard, sugar, vanilla. Torch the top.', tags: ['cooking'], updatedAt: T },
      { id: 'n-mention', title: 'Meeting notes', body: 'We talked about the budget for a minute and then about lunch.', tags: [], updatedAt: T },
      { id: 'n-tag', title: 'Receipts', body: 'Scanned copies.', tags: ['budget'], updatedAt: T },
    ],
    tasks: [
      { id: 't-budget', title: 'Send budget draft', done: false, due: '2026-10-20', createdAt: T },
      { id: 't-done', title: 'Water plants', done: true, createdAt: T },
    ],
    capsules: [
      { id: 'c-work', name: 'Deep work', description: 'Editor and docs for the budget model.', scene: 'nebula', createdAt: T, updatedAt: T, items: [{ kind: 'app', target: 'C:\\Tools\\sheet.exe', label: 'Spreadsheet' }] },
    ],
    chat: [{ id: 'm-1', role: 'user', text: 'Remind me about the budget review', createdAt: T, source: 'local' }],
    activity: [],
    ...over,
  };
}

test('ranks title exact > tag > title prefix/task > body mentions, deterministically', () => {
  const r = searchState(state(), 'budget');
  assert.deepEqual(
    r.map((x) => `${x.category}:${x.id}`),
    ['note:n-budget', 'task:t-budget', 'note:n-tag', 'note:n-mention', 'capsule:c-work'],
  );
  assert.equal(r[0].relevance, 1);
  assert.ok(r.every((x, i) => i === 0 || r[i - 1].relevance >= x.relevance), 'sorted by relevance');
  assert.ok(r.every((x) => x.relevance > 0 && x.relevance <= 1));
  // Identical input gives identical output, including order of ties.
  assert.deepEqual(searchState(state(), 'budget'), r);
  // Shuffling input order does not change output order.
  const s = state();
  s.notes.reverse();
  s.tasks.reverse();
  assert.deepEqual(searchState(s, 'budget'), r);
});

test('results carry typed fields and snippets around the match', () => {
  const [mention] = searchState(state(), 'lunch');
  assert.deepEqual(Object.keys(mention).sort(), ['category', 'id', 'relevance', 'snippet', 'title']);
  assert.equal(mention.category, 'note');
  assert.equal(mention.title, 'Meeting notes');
  assert.match(mention.snippet, /lunch/);
  const [task] = searchState(state(), 'send');
  assert.equal(task.snippet, 'Open · due 2026-10-20');
  // Long bodies are windowed around the first match and bounded.
  const long = `${'filler words here '.repeat(60)}the needle sits here ${'tail text '.repeat(60)}`;
  const [hit] = searchState(state({ notes: [{ id: 'n-long', title: 'Long', body: long, tags: [], updatedAt: T }] }), 'needle');
  assert.match(hit.snippet, /^….*needle.*…$/);
  assert.ok(hit.snippet.length <= SEARCH_LIMITS.snippetChars);
});

test('all terms must match; multi-word phrase in title outranks scattered words', () => {
  const s = state({
    notes: [
      { id: 'a', title: 'Garden plan', body: 'spring planting', tags: [], updatedAt: T },
      { id: 'b', title: 'Plan the garden', body: '', tags: [], updatedAt: T },
      { id: 'c', title: 'Garden', body: 'nothing else', tags: [], updatedAt: T },
    ],
    tasks: [], capsules: [],
  });
  const r = searchState(s, 'garden plan');
  assert.deepEqual(r.map((x) => x.id), ['a', 'b']);
  assert.ok(r[0].relevance > r[1].relevance);
});

test('case and accent folding in both directions, including special letters', () => {
  assert.equal(foldText('Crème BRÛLÉE'), 'creme brulee');
  assert.equal(foldText('Straße Øresund İstanbul'), 'strasse oresund istanbul');
  assert.equal(searchState(state(), 'creme brulee')[0].id, 'n-recipe');
  assert.equal(searchState(state(), 'CRÈME')[0].id, 'n-recipe');
  const s = state({ notes: [{ id: 'n-de', title: 'Strasse', body: '', tags: [], updatedAt: T }], tasks: [], capsules: [] });
  assert.equal(searchState(s, 'straße')[0].id, 'n-de');
  // Full-width and compatibility forms fold too.
  assert.equal(searchState(state(), 'ＢＵＤＧＥＴ')[0].id, 'n-budget');
  // Snippet keeps the original accented text even though matching was folded.
  const [hit] = searchState(state(), 'vanilla');
  assert.match(hit.snippet, /vanilla/);
  assert.equal(hit.title, 'Crème Brûlée');
});

test('empty, whitespace, punctuation-only and non-string queries return nothing', () => {
  for (const q of ['', '   ', '!!! ---', '\u0000\u202e', undefined, null, 42, {}]) assert.deepEqual(searchState(state(), q), [], String(q));
  assert.deepEqual(searchState(state(), 'zzzz-not-present'), []);
  assert.deepEqual(searchState({ settings: {}, notes: [], tasks: [], capsules: [], chat: [], activity: [] }, 'budget'), []);
  assert.deepEqual(searchState(null, 'budget'), []);
});

test('chat is excluded by default and included only on explicit opt-in', () => {
  assert.ok(!searchState(state(), 'remind').length);
  assert.ok(!searchState(state(), 'budget').some((r) => r.category === 'chat'));
  assert.ok(!searchState(state(), 'remind', { includeChat: 'yes' }).length);
  const [m] = searchState(state(), 'remind', { includeChat: true });
  assert.deepEqual([m.category, m.id, m.title], ['chat', 'm-1', 'You']);
});

test('query, term and result limits are enforced', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `n${String(i).padStart(2, '0')}`, title: `Alpha ${i}`, body: '', tags: [], updatedAt: T }));
  const s = state({ notes: many, tasks: [], capsules: [] });
  assert.equal(searchState(s, 'alpha').length, SEARCH_LIMITS.defaultResults);
  assert.equal(searchState(s, 'alpha', { limit: 5 }).length, 5);
  assert.equal(searchState(s, 'alpha', { limit: 10_000 }).length, SEARCH_LIMITS.maxResults);
  assert.equal(searchState(s, 'alpha', { limit: 0 }).length, 1);
  assert.equal(searchState(s, 'alpha', { limit: NaN }).length, SEARCH_LIMITS.defaultResults);
  // Equal scores tie-break on title then id, so the first five are stable.
  assert.deepEqual(searchState(s, 'alpha', { limit: 3 }).map((r) => r.id), ['n00', 'n01', 'n10']);
  // Terms are deduplicated, capped in count and length; text past queryChars is ignored.
  assert.deepEqual(parseQuery('Budget budget BUDGET'), ['budget']);
  assert.equal(parseQuery(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')).length, SEARCH_LIMITS.terms);
  assert.equal(parseQuery('x'.repeat(500))[0].length, SEARCH_LIMITS.termChars);
  assert.deepEqual(parseQuery(`${'y'.repeat(SEARCH_LIMITS.queryChars)} budget`), ['y'.repeat(SEARCH_LIMITS.termChars)]);
  // Only itemsPerCategory entries are scanned.
  const huge = Array.from({ length: SEARCH_LIMITS.itemsPerCategory + 5 }, (_, i) => ({ id: `h${i}`, title: i >= SEARCH_LIMITS.itemsPerCategory ? 'Overflow' : 'x', body: '', tags: [], updatedAt: T }));
  assert.deepEqual(searchState(state({ notes: huge }), 'overflow'), []);
});

test('control and bidi characters are removed from queries, titles and snippets; bad records skipped', () => {
  assert.equal(sanitizeText('a\u0000b\u202ec\u200b d\r\n\te'), 'a b c d e');
  const s = state({
    notes: [
      { id: 'n-ctl', title: 'Evil\u202eTitle\u0007', body: 'line one\u0000\nsecret\u2066 word', tags: [], updatedAt: T },
      { id: '../escape', title: 'Evil bad id', body: '', tags: [], updatedAt: T },
      null,
      'string',
    ],
    tasks: [{ id: 't-x', title: 42, done: false, createdAt: T }],
    capsules: 'not-an-array',
  });
  const r = searchState(s, 'evil\u0000');
  assert.deepEqual(r.map((x) => x.id), ['n-ctl']);
  assert.equal(r[0].title, 'Evil Title');
  const [b] = searchState(s, 'secret');
  assert.equal(b.snippet, 'line one secret word');
  for (const x of [...r, b]) assert.doesNotMatch(x.title + x.snippet, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
});

test('capsule items are searchable by label and, more weakly, by target', () => {
  const [byLabel] = searchState(state(), 'spreadsheet');
  const [byTarget] = searchState(state(), 'sheet.exe');
  assert.equal(byLabel.id, 'c-work');
  assert.equal(byTarget.id, 'c-work');
  assert.ok(byLabel.relevance > byTarget.relevance);
});

test('groupResults keeps fixed category order and rank order within groups', () => {
  const g = groupResults(searchState(state(), 'budget', { includeChat: true }));
  assert.deepEqual(g.map((x) => x.category), ['note', 'task', 'capsule', 'chat']);
  assert.deepEqual(g[0].results.map((r) => r.id), ['n-budget', 'n-tag', 'n-mention']);
  assert.equal(g[3].label, 'Chat history');
  assert.deepEqual(groupResults([]), []);
});

test('searchState does not mutate the state it reads', () => {
  const s = state();
  const before = JSON.stringify(s);
  searchState(s, 'budget', { includeChat: true });
  assert.equal(JSON.stringify(s), before);
});

test('MemorySearch renders labelled field, privacy copy, chat switch off, and an empty prompt', () => {
  const html = renderToStaticMarkup(createElement(MemorySearch, { state: state(), onNavigate: () => {} }));
  assert.match(html, /role="search"/);
  assert.match(html, /<label for="([^"]+)">Search notes, tasks and capsules<\/label><input[^>]*id="\1"[^>]*type="search"/);
  assert.match(html, /Nothing is sent to a model or the internet, and files on disk are not scanned/);
  assert.match(html, /role="switch" aria-checked="false"/);
  assert.match(html, /Search what you have saved/);
  assert.match(html, new RegExp(`maxLength="${SEARCH_LIMITS.queryChars}"`));
});

test('MemorySearch groups results under headings and shows a no-match state', () => {
  const html = renderToStaticMarkup(createElement(MemorySearch, { state: state(), onNavigate: () => {}, initialQuery: 'budget' }));
  const headings = [...html.matchAll(/<h3 id="[^"]+" class="eyebrow">([A-Za-z ]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(headings, ['Notes', 'Tasks', 'Capsules']);
  assert.equal((html.match(/<button[^>]*data-result/g) ?? []).length, 5);
  assert.match(html, /5 results\./);
  assert.doesNotMatch(html, /Remind me/, 'chat stays hidden by default');
  const none = renderToStaticMarkup(createElement(MemorySearch, { state: state(), onNavigate: () => {}, initialQuery: 'qqqq' }));
  assert.match(none, /No matches/);
  assert.match(none, /include chat history/);
});
