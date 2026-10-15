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
const {m} = await load('src/ui/file-shelf.ts');
const {SHELF_PREF_KEY, SHELF_LIMITS, emptyShelf, normalizeShelf, addShelfItem, updateShelfItem, removeShelfItem, recordOpened, recentItems, filterShelf, groupByKind, checkTarget, guessKind} = m;

const T0 = '2025-01-01T00:00:00.000Z';
const add = (shelf, input, now = T0) => addShelfItem(shelf, input, now);

test('constants match the contract', () => {
  assert.equal(SHELF_PREF_KEY, 'fileShelf.v1');
  assert.equal(SHELF_LIMITS.items, 200);
  assert.equal(SHELF_LIMITS.label, 80);
  assert.equal(SHELF_LIMITS.note, 500);
  assert.equal(SHELF_LIMITS.recent, 20);
  assert.deepEqual(emptyShelf(), {version:1, items:[]});
});

test('addShelfItem defaults the label to the basename and dedupes Windows paths case-insensitively', () => {
  const a = add(emptyShelf(), {kind:'file', target:'C:\\Work\\Report.docx'});
  assert.equal(a.duplicate, false);
  assert.equal(a.item.label, 'Report.docx');
  assert.equal(a.item.openCount, 0);
  assert.equal(a.item.addedAt, T0);
  assert.equal(a.item.lastOpenedAt, undefined);
  const b = add(a.shelf, {kind:'file', target:'c:/work/REPORT.DOCX'});
  assert.equal(b.duplicate, true);
  assert.equal(b.item.id, a.item.id);
  assert.equal(b.shelf.items.length, 1);
  const f = add(a.shelf, {kind:'folder', target:'D:\\Projects\\Site\\'});
  assert.equal(f.item.label, 'Site');
  assert.equal(f.shelf.items.length, 2);
  const labelled = add(emptyShelf(), {kind:'file', target:'C:\\a\\b.txt', label:'  My   file '});
  assert.equal(labelled.item.label, 'My file');
  const u = add(emptyShelf(), {kind:'url', target:'https://example.com/docs/'});
  assert.equal(u.item.label, 'example.com › docs');
  assert.equal(add(u.shelf, {kind:'url', target:'https://EXAMPLE.com/docs/'}).duplicate, true);
});

test('url scheme rejection gives reasons', () => {
  assert.throws(() => add(emptyShelf(), {kind:'url', target:'javascript:alert(1)'}), /javascript: links run script/);
  assert.throws(() => add(emptyShelf(), {kind:'url', target:'data:text/html,hi'}), /data: links embed content/);
  assert.throws(() => add(emptyShelf(), {kind:'url', target:'file:///C:/x.txt'}), /file: links are not accepted/);
  assert.throws(() => add(emptyShelf(), {kind:'url', target:'ftp://host/x'}), /Only http:\/\/ and https:\/\/ links can be added \(got ftp:\)/);
  assert.throws(() => add(emptyShelf(), {kind:'file', target:'JavaScript:void(0)'}), /javascript: links run script/);
  assert.throws(() => add(emptyShelf(), {kind:'file', target:'   '}), /target is empty/);
  assert.throws(() => add(emptyShelf(), {kind:'app', target:'x'}), /Unknown shelf item kind/);
  assert.throws(() => add(emptyShelf(), {kind:'file', target:'C:\\a\nb'}), /control characters/);
  assert.deepEqual(checkTarget('url', 'http://example.com'), {ok:true, target:'http://example.com/'});
  assert.equal(checkTarget('url', 'data:x').ok, false);
  assert.equal(guessKind('https://x.org'), 'url');
  assert.equal(guessKind('C:\\x'), 'file');
});

test('limits: label, note, item count', () => {
  assert.throws(() => add(emptyShelf(), {kind:'file', target:'C:\\a.txt', label:'x'.repeat(81)}), /longer than 80 characters/);
  assert.throws(() => add(emptyShelf(), {kind:'file', target:'C:\\a.txt', note:'x'.repeat(501)}), /longer than 500 characters/);
  let shelf = emptyShelf();
  for (let i = 0; i < 200; i++) shelf = add(shelf, {kind:'file', target:`C:\\f\\${i}.txt`}).shelf;
  assert.equal(shelf.items.length, 200);
  assert.throws(() => add(shelf, {kind:'file', target:'C:\\f\\extra.txt'}), /shelf is full \(200 items\)/);
  // A duplicate is still reported on a full shelf rather than throwing.
  assert.equal(add(shelf, {kind:'file', target:'C:\\F\\0.TXT'}).duplicate, true);
});

test('updateShelfItem and removeShelfItem', () => {
  const a = add(emptyShelf(), {kind:'file', target:'C:\\docs\\plan.md'});
  const u = updateShelfItem(a.shelf, a.item.id, {label:'Plan', note:'quarterly', tags:['#Work', 'work', 'Q 1']});
  assert.deepEqual(u.items[0].label, 'Plan');
  assert.equal(u.items[0].note, 'quarterly');
  assert.deepEqual(u.items[0].tags, ['work', 'q-1']);
  const reset = updateShelfItem(u, a.item.id, {label:'  '});
  assert.equal(reset.items[0].label, 'plan.md');
  assert.equal(reset.items[0].note, 'quarterly');
  assert.throws(() => updateShelfItem(u, a.item.id, {note:'x'.repeat(501)}), /500 characters/);
  assert.throws(() => updateShelfItem(u, 'missing', {label:'x'}), /No shelf item with id "missing"/);
  assert.equal(a.shelf.items[0].label, 'plan.md', 'input shelf is not mutated');
  const r = removeShelfItem(u, a.item.id);
  assert.equal(r.items.length, 0);
  assert.throws(() => removeShelfItem(r, a.item.id), /No shelf item/);
});

test('recordOpened bumps count and recentItems orders by lastOpenedAt desc then label', () => {
  let s = emptyShelf();
  const ids = {};
  for (const [name, t] of [['beta', 'C:\\b'], ['Alpha', 'C:\\a'], ['gamma', 'C:\\g'], ['never', 'C:\\n']]) {
    const r = add(s, {kind:'folder', target:t, label:name});
    s = r.shelf;
    ids[name] = r.item.id;
  }
  s = recordOpened(s, ids.beta, '2025-02-01T00:00:00.000Z');
  s = recordOpened(s, ids.Alpha, '2025-03-01T00:00:00.000Z');
  s = recordOpened(s, ids.gamma, '2025-03-01T00:00:00.000Z');
  s = recordOpened(s, ids.beta, '2025-01-15T00:00:00.000Z');
  const beta = s.items.find((i) => i.id === ids.beta);
  assert.equal(beta.openCount, 2);
  assert.equal(beta.lastOpenedAt, '2025-01-15T00:00:00.000Z');
  assert.deepEqual(recentItems(s, 10).map((i) => i.label), ['Alpha', 'gamma', 'beta']);
  assert.deepEqual(recentItems(s, 1).map((i) => i.label), ['Alpha']);
  assert.throws(() => recordOpened(s, 'nope', T0), /No shelf item/);
  assert.throws(() => recordOpened(s, ids.beta, 'not a date'), /Invalid "now"/);
  let many = emptyShelf();
  for (let i = 0; i < 25; i++) {
    const r = add(many, {kind:'file', target:`C:\\m\\${i}`});
    many = recordOpened(r.shelf, r.item.id, Date.parse(T0) + i * 1000);
  }
  assert.equal(recentItems(many, 100).length, 20);
});

test('filterShelf folds case and accents over label, target and tags; groupByKind orders groups', () => {
  let s = emptyShelf();
  s = add(s, {kind:'file', target:'C:\\docs\\Résumé.pdf'}).shelf;
  s = add(s, {kind:'folder', target:'C:\\Photos', tags:['Família']}).shelf;
  s = add(s, {kind:'url', target:'https://news.example.org/'}).shelf;
  assert.deepEqual(filterShelf(s, 'RESUME').map((i) => i.label), ['Résumé.pdf']);
  assert.deepEqual(filterShelf(s, 'familia').map((i) => i.label), ['Photos']);
  assert.deepEqual(filterShelf(s, 'news.EXAMPLE').map((i) => i.kind), ['url']);
  assert.deepEqual(filterShelf(s, 'c:\\docs').map((i) => i.label), ['Résumé.pdf']);
  assert.equal(filterShelf(s, '   ').length, 3);
  assert.deepEqual(filterShelf(s, 'zzz'), []);
  assert.deepEqual(groupByKind(filterShelf(s, '')).map((g) => [g.kind, g.items.length]), [['folder', 1], ['file', 1], ['url', 1]]);
  assert.deepEqual(groupByKind([]), []);
});

test('normalizeShelf drops malformed, unsafe and duplicate entries', () => {
  const good = {id:'a', kind:'file', target:'C:\\x.txt', label:'X', note:'', tags:['t'], addedAt:T0, openCount:3, lastOpenedAt:T0};
  const s = normalizeShelf({version:1, items:[
    good,
    {...good, id:'a', target:'C:\\other.txt'},
    {...good, id:'b', target:'c:\\X.TXT'},
    {...good, id:'c', kind:'url', target:'javascript:alert(1)'},
    {...good, id:'d', kind:'app'},
    {...good, id:'e', addedAt:'nope'},
    {...good, id:'f', target:42},
    'string',
    null,
    {...good, id:'g', target:'C:\\y.txt', label:undefined, tags:'bad', openCount:-1, lastOpenedAt:'bad'},
  ]});
  assert.deepEqual(s.items.map((i) => i.id), ['a', 'g']);
  assert.equal(s.items[0].openCount, 3);
  const g = s.items[1];
  assert.equal(g.label, 'y.txt');
  assert.deepEqual(g.tags, []);
  assert.equal(g.openCount, 0);
  assert.equal(g.lastOpenedAt, undefined);
  assert.deepEqual(normalizeShelf(null), {version:1, items:[]});
  assert.deepEqual(normalizeShelf('garbage'), {version:1, items:[]});
  assert.equal(normalizeShelf([good]).items.length, 1);
});

test('file-shelf source is pure and offline', async () => {
  const src = await readFile(path.join(root, 'src/ui/file-shelf.ts'), 'utf8');
  assert.equal(/\bfetch\s*\(|XMLHttpRequest|from\s+['"](node:)?fs|\bdocument\b|\bwindow\b|localStorage/.test(src), false);
});

test('Home wires the file shelf through preview then confirmed execute', async () => {
  const src = await readFile(path.join(root, 'src/components/Home.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/ui\/file-shelf'/);
  assert.match(src, /shelfModel\.SHELF_PREF_KEY/);
  for (const s of ['File shelf', 'Recently opened', 'api.pickPath(kind)', 'Confirm', 'Cancel', 'recentItems', 'groupByKind', 'filterShelf', 'recordOpened', "e.key === 'Escape'", "e.key === 'Enter'", "type: 'launch'"]) assert.ok(src.includes(s), s);
  const previewAt = src.indexOf('api.previewAction(shelfRequest(item))');
  const executeAt = src.indexOf('api.executeAction(p.id, true)');
  assert.ok(previewAt > 0 && executeAt > previewAt, 'previewAction is called before executeAction');
  assert.match(src, /if \(!pending \|\| !pending\.preview\.allowed/);
  // recordOpened only after the backend confirms the action ran.
  assert.ok(src.indexOf("outcome.kind === 'ran'") < src.indexOf('shelfModel.recordOpened(shelf, item.id)'));
  const css = await readFile(path.join(root, 'src/styles/views.css'), 'utf8');
  assert.ok(css.includes('.file-shelf'));
});
