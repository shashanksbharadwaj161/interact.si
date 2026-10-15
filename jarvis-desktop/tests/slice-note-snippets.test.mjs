import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function load(entry) {
  const bundle = await build({entryPoints:[path.join(root, entry)], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  const code = bundle.outputFiles[0].text;
  return {code, m: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)};
}
const {m} = await load('src/ui/note-snippets.ts');
const {SNIPPET_TAG, SNIPPET_LIMITS, listSnippets, filterSnippets, insertAtCursor, snippetKeyboardTarget, notesToMarkdown, notesToJson, parseNotesExport} = m;

const note = (id, title, body, tags, updatedAt = '2025-01-01T00:00:00.000Z') => ({id, title, body, tags, updatedAt});
const notes = [
  note('n3', 'Zeta', 'last one', ['snippet']),
  note('n1', 'Alpha', 'Café au lait recipe', ['snippet', 'food']),
  note('n2', 'Alpha', 'second alpha', ['snippet']),
  note('n4', 'Plain', 'not a snippet', ['work']),
];

test('constants match the contract', () => {
  assert.equal(SNIPPET_TAG, 'snippet');
  assert.deepEqual({...SNIPPET_LIMITS}, {maxSnippets:200, maxInsertChars:20000, maxQueryChars:200});
});

test('listSnippets keeps only #snippet notes sorted by title then id, and caps with a truncated flag', () => {
  const r = listSnippets(notes);
  assert.deepEqual(r.snippets.map((n) => n.id), ['n1', 'n2', 'n3']);
  assert.equal(r.truncated, false);
  const many = Array.from({length:205}, (_, i) => note(`id${String(i).padStart(3, '0')}`, `T${String(204 - i).padStart(3, '0')}`, '', ['snippet']));
  const capped = listSnippets(many);
  assert.equal(capped.snippets.length, 200);
  assert.equal(capped.truncated, true);
  assert.equal(capped.snippets[0].title, 'T000');
  assert.deepEqual(listSnippets([]), {snippets:[], truncated:false});
});

test('filterSnippets folds accents and case on title and body with deterministic order', () => {
  const {snippets} = listSnippets(notes);
  assert.deepEqual(filterSnippets(snippets, 'CAFE').map((n) => n.id), ['n1']);
  assert.deepEqual(filterSnippets(snippets, 'café').map((n) => n.id), ['n1']);
  assert.deepEqual(filterSnippets(snippets, 'alpha').map((n) => n.id), ['n1', 'n2']);
  assert.deepEqual(filterSnippets(snippets, '   ').map((n) => n.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(filterSnippets(snippets, 'nothing-here'), []);
  // Title matches first, then body matches.
  const mixed = [note('a', 'Body has it', 'zzz', ['snippet']), note('b', 'zzz title', 'x', ['snippet'])];
  assert.deepEqual(filterSnippets(mixed, 'zzz').map((n) => n.id), ['b', 'a']);
  assert.deepEqual(filterSnippets(snippets, 'alpha'), filterSnippets(snippets, 'alpha'));
});

test('insertAtCursor replaces the selection and places the cursor after the insert', () => {
  assert.deepEqual(insertAtCursor('hello world', 6, 11, 'there'), {body:'hello there', cursor:11, truncated:false});
  assert.deepEqual(insertAtCursor('ab', 1, 1, 'XY'), {body:'aXYb', cursor:3, truncated:false});
  assert.deepEqual(insertAtCursor('', 0, 0, 'snip'), {body:'snip', cursor:4, truncated:false});
});

test('insertAtCursor never exceeds maxChars and flags truncation', () => {
  const r = insertAtCursor('abcdef', 3, 3, '0123456789', 10);
  assert.equal(r.body, 'abc0123def');
  assert.equal(r.body.length, 10);
  assert.equal(r.cursor, 7);
  assert.equal(r.truncated, true);
  const big = insertAtCursor('x'.repeat(19990), 0, 0, 'y'.repeat(50));
  assert.equal(big.body.length, SNIPPET_LIMITS.maxInsertChars);
  assert.equal(big.truncated, true);
  // Replacing a selection frees room.
  assert.deepEqual(insertAtCursor('abcdefghij', 2, 8, 'XYZ', 10), {body:'abXYZij', cursor:5, truncated:false});
  // Surrogate pairs are not split.
  const emoji = insertAtCursor('abcd', 4, 4, '😀😀', 7);
  assert.equal(emoji.body, 'abcd😀');
  assert.equal(emoji.truncated, true);
});

test('insertAtCursor throws descriptive errors for bad input', () => {
  assert.throws(() => insertAtCursor('abc', -1, 1, 'x'), /selectionStart must be a non-negative integer/);
  assert.throws(() => insertAtCursor('abc', 0, 9, 'x'), /outside the body \(length 3\)/);
  assert.throws(() => insertAtCursor('abc', 2, 1, 'x'), /after selectionEnd/);
  assert.throws(() => insertAtCursor(42, 0, 0, 'x'), /body must be a string/);
  assert.throws(() => insertAtCursor('abc', 0, 0, null), /snippetBody must be a string/);
  assert.throws(() => insertAtCursor('abc', 0.5, 1, 'x'), /selectionStart/);
});

test('snippetKeyboardTarget moves within bounds without wrapping', () => {
  assert.equal(snippetKeyboardTarget('ArrowDown', 0, 3), 1);
  assert.equal(snippetKeyboardTarget('ArrowDown', 2, 3), 2);
  assert.equal(snippetKeyboardTarget('ArrowUp', 0, 3), 0);
  assert.equal(snippetKeyboardTarget('ArrowUp', 2, 3), 1);
  assert.equal(snippetKeyboardTarget('Home', 2, 3), 0);
  assert.equal(snippetKeyboardTarget('End', 0, 3), 2);
  assert.equal(snippetKeyboardTarget('Enter', 0, 3), null);
  assert.equal(snippetKeyboardTarget('a', 1, 3), null);
  assert.equal(snippetKeyboardTarget('ArrowDown', 0, 0), null);
  assert.equal(snippetKeyboardTarget('ArrowDown', -1, 3), 0);
});

test('notesToMarkdown is deterministic, sorted by updatedAt desc then id, with verbatim bodies', () => {
  const list = [
    note('b', 'Older', 'line1\n  ## not a heading\n\ttab', ['x'], '2025-01-01T00:00:00.000Z'),
    note('a', 'Newer', 'new body', [], '2025-02-01T00:00:00.000Z'),
    note('c', '', 'tie', ['y', 'z'], '2025-01-01T00:00:00.000Z'),
  ];
  const md = notesToMarkdown(list, {now:'2025-03-01T10:00:00.000Z'});
  assert.equal(md, notesToMarkdown([...list].reverse(), {now:'2025-03-01T10:00:00.000Z'}));
  assert.ok(md.startsWith('# Desktop Companion notes\n\nExported 2025-03-01T10:00:00.000Z. 3 notes.\n'));
  const headings = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, ['## Newer', '## Older', '## Untitled']);
  assert.ok(md.includes('\nline1\n  ## not a heading\n\ttab\n'), 'body verbatim');
  assert.ok(md.includes('Tags: #y #z\nUpdated: 2025-01-01T00:00:00.000Z'));
  assert.ok(md.includes('## Newer\n\nTags: none\nUpdated: 2025-02-01T00:00:00.000Z\n\nnew body\n'));
});

test('notesToJson drops unknown keys and round-trips through parseNotesExport without ids', () => {
  const list = [
    {...note('n1', 'One', 'body 1', ['snippet'], '2025-01-02T00:00:00.000Z'), secret:'drop me', createdAt:'x'},
    note('n2', 'Two', 'body\n2', [], '2025-01-03T00:00:00.000Z'),
  ];
  const json = notesToJson(list, {now:'2025-03-01T00:00:00.000Z'});
  const env = JSON.parse(json);
  assert.equal(env.format, 'desktop-companion-notes');
  assert.equal(env.version, 1);
  assert.equal(env.exportedAt, '2025-03-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(env.notes[0]).sort(), ['body', 'id', 'tags', 'title', 'updatedAt']);
  assert.equal(json.includes('drop me'), false);
  assert.deepEqual(env.notes.map((n) => n.id), ['n2', 'n1']);
  const parsed = parseNotesExport(json);
  assert.equal(parsed.dropped, 0);
  assert.deepEqual(parsed.notes, [{title:'Two', body:'body\n2', tags:[]}, {title:'One', body:'body 1', tags:['snippet']}]);
  assert.ok(parsed.notes.every((n) => !('id' in n)));
});

test('parseNotesExport rejects bad envelopes with exact $-paths and drops bad notes', () => {
  const env = (over) => JSON.stringify({format:'desktop-companion-notes', version:1, exportedAt:'2025-01-01', notes:[], ...over});
  assert.throws(() => parseNotesExport('{oops'), {message:'$: not valid JSON'});
  assert.throws(() => parseNotesExport('[]'), {message:'$: expected an object'});
  assert.throws(() => parseNotesExport(env({format:'other'})), {message:'$.format: expected "desktop-companion-notes"'});
  assert.throws(() => parseNotesExport(env({version:2})), {message:'$.version: expected 1'});
  assert.throws(() => parseNotesExport(env({exportedAt:5})), {message:'$.exportedAt: expected a string'});
  assert.throws(() => parseNotesExport(env({notes:{}})), {message:'$.notes: expected an array'});
  assert.throws(() => parseNotesExport(' '.repeat(2_000_001)), /larger than 2000000 characters/);
  assert.throws(() => parseNotesExport(42), /^Error: \$/);
  const r = parseNotesExport(env({notes:[
    {title:'ok', body:'fine', tags:['#Tag One', 'tag-one']},
    'nope',
    {title:1, body:''},
    {title:'t', body:5},
    {title:'t', body:'b', tags:'x'},
    {title:'t', body:'b', tags:['a', 3]},
    {title:'t', body:'x'.repeat(20001)},
  ]}));
  assert.deepEqual(r.notes, [{title:'ok', body:'fine', tags:['tag-one']}]);
  assert.equal(r.dropped, 6);
  assert.deepEqual(r.errors, [
    '$.notes[1]: expected an object',
    '$.notes[2].title: expected a string',
    '$.notes[3].body: expected a string',
    '$.notes[4].tags: expected an array',
    '$.notes[5].tags[1]: expected a string',
    '$.notes[6].body: longer than 20000 characters',
  ]);
});

test('note-snippets source is offline: no fetch, XMLHttpRequest or fs access', async () => {
  const src = await readFile(path.join(root, 'src/ui/note-snippets.ts'), 'utf8');
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|require\(\s*['"](node:)?fs['"]\s*\)|from\s+['"](node:)?fs/.test(src), false);
  assert.equal(/\bdocument\b|\bwindow\b/.test(src), false);
});

test('Notes page wires snippets, export and import through the pure module', async () => {
  const src = await readFile(path.join(root, 'src/components/Notes.tsx'), 'utf8');
  for (const s of ['Insert snippet', 'Search snippets', 'Mark as snippet', 'Download Markdown (filtered list)', 'Download JSON (all notes)', 'Import JSON', 'any note tagged #snippet appears here', 'URL.revokeObjectURL', 'snippetKeyboardTarget', 'insertAtCursor', 'parseNotesExport', 'api.saveNote({ title: n.title, body: n.body, tags: n.tags })']) {
    assert.ok(src.toLowerCase().includes(s.toLowerCase()), s);
  }
});
