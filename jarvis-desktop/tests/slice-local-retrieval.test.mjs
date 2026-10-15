import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/local-retrieval.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const lr = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {RETRIEVAL_LIMITS, tokenize, buildIndex, findRelated, query, docsFromState, parseRetrievalKey} = lr;

const doc = (id, title, text = '', over = {}) => ({id, kind:'note', title, text, ...over});

test('local retrieval: limits are fixed', () => {
  assert.deepEqual({...RETRIEVAL_LIMITS}, {maxDocs:5000, maxDocChars:20000, maxResults:20, maxTerms:64});
  assert.ok(Object.isFrozen(RETRIEVAL_LIMITS));
});

test('local retrieval: tokenize folds accents and case, drops stop words and 1-char tokens', () => {
  assert.deepEqual(tokenize('The Crème BRÛLÉE recipe, and a café!'), ['creme', 'brulee', 'recipe', 'cafe']);
  assert.deepEqual(tokenize('x y z of the is'), []);
  assert.deepEqual(tokenize('Naïve naive NAIVE'), ['naive']);
  assert.deepEqual(tokenize('v2 release_notes 2026'), ['v2', 'release', 'notes', '2026']);
  const many = Array.from({length:100}, (_, i) => `word${i}`).join(' ');
  assert.equal(tokenize(many).length, 64);
  assert.deepEqual(tokenize(''), []);
});

test('local retrieval: buildIndex validates input and is frozen', () => {
  assert.throws(() => buildIndex([doc('a', 'x'), doc('a', 'y')]), /Duplicate document id "a"/);
  assert.throws(() => buildIndex([{id:'a', kind:'note', title:5, text:''}]), /title must be a string/);
  assert.throws(() => buildIndex([{id:'a', kind:'note', title:'t', text:null}]), /text must be a string/);
  assert.throws(() => buildIndex([{id:'', kind:'note', title:'t', text:''}]), /has no id/);
  assert.throws(() => buildIndex([{id:'a', kind:'email', title:'t', text:''}]), /unknown kind/);
  const idx = buildIndex([doc('a', 'Garden plan', 'tomatoes basil'), doc('b', 'Budget', 'tomatoes')]);
  assert.ok(Object.isFrozen(idx));
  assert.ok(Object.isFrozen(idx.docs));
  assert.ok(Object.isFrozen(idx.docs[0].weights));
  assert.equal(idx.df.tomatoes, 2);
  assert.equal(idx.df.garden, 1);
  assert.equal(idx.truncatedDocs, 0);
  // title tokens count twice in length
  assert.equal(idx.docs[0].length, 2 * 2 + 2);
});

test('local retrieval: findRelated excludes the source and ranks rare shared terms above common ones', () => {
  const docs = [
    doc('src', 'Kubernetes ingress meeting', 'project notes'),
    doc('rare', 'Ingress controller', 'kubernetes debugging'),
    doc('common1', 'Weekly project', 'meeting notes'),
    doc('common2', 'Project review', 'notes meeting'),
    doc('common3', 'Project kickoff', 'notes'),
    doc('none', 'Groceries', 'milk eggs'),
  ];
  const idx = buildIndex(docs);
  const hits = findRelated(idx, 'src');
  assert.ok(hits.every((h) => h.id !== 'src'));
  assert.ok(hits.every((h) => h.id !== 'none'));
  assert.equal(hits[0].id, 'rare');
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual([...hits[0].sharedTerms].sort(), ['ingress', 'kubernetes']);
  for (const h of hits) {
    assert.equal(h.score, Math.round(h.score * 1e4) / 1e4);
    assert.ok(h.sharedTerms.length <= 8);
  }
  assert.throws(() => findRelated(idx, 'missing'), /No document with id "missing"/);
  assert.throws(() => findRelated(idx, ''), /docId is required/);
  const tasks = buildIndex([...docs, {id:'t1', kind:'task', title:'Kubernetes upgrade', text:''}]);
  assert.deepEqual(findRelated(tasks, 'src', {kinds:['task']}).map((h) => h.id), ['t1']);
});

test('local retrieval: equal scores order by updatedAt desc then id asc', () => {
  const idx = buildIndex([
    doc('src', 'zebra'),
    doc('c', 'zebra', '', {updatedAt:'2026-01-01T00:00:00Z'}),
    doc('b', 'zebra', '', {updatedAt:'2026-03-01T00:00:00Z'}),
    doc('a', 'zebra', '', {updatedAt:'2026-01-01T00:00:00Z'}),
    doc('d', 'zebra'),
  ]);
  const ids = findRelated(idx, 'src').map((h) => h.id);
  assert.deepEqual(ids, ['b', 'a', 'c', 'd']);
  assert.deepEqual(findRelated(idx, 'src').map((h) => h.id), ids, 'repeatable');
  assert.deepEqual(query(idx, 'Zébra').map((h) => h.id), ['b', 'a', 'c', 'd', 'src']);
});

test('local retrieval: limit validation', () => {
  const idx = buildIndex(Array.from({length:30}, (_, i) => doc(`n${i}`, 'shared topic')));
  assert.equal(findRelated(idx, 'n0').length, 10);
  assert.equal(findRelated(idx, 'n0', {limit:20}).length, 20);
  assert.equal(query(idx, 'topic', {limit:3}).length, 3);
  for (const bad of [0, 21, 1.5, -1, '5', Number.NaN]) {
    assert.throws(() => findRelated(idx, 'n0', {limit:bad}), /limit must be/);
    assert.throws(() => query(idx, 'topic', {limit:bad}), /limit must be/);
  }
});

test('local retrieval: over-long text is truncated and counted', () => {
  const long = 'alpha '.repeat(5000) + 'omega';
  const idx = buildIndex([doc('a', 'Long', long), doc('b', 'Short', 'omega alpha')]);
  assert.equal(idx.truncatedDocs, 1);
  assert.equal(idx.df.omega, 1, 'text beyond maxDocChars is not indexed');
  assert.throws(() => buildIndex(Array.from({length:5001}, (_, i) => doc(`d${i}`, 't'))), /Too many documents/);
});

test('local retrieval: docsFromState uses renderer state only and keys by kind', () => {
  const state = {
    notes:[{id:'1', title:'Note', body:'body text', tags:[], updatedAt:'2026-01-01T00:00:00Z'}],
    tasks:[{id:'1', title:'Task', done:false, createdAt:'2026-01-01T00:00:00Z'}],
    capsules:[{id:'c', name:'Cap', description:'desc', updatedAt:'2026-01-01T00:00:00Z'}],
  };
  const docs = docsFromState(state, {checkpoints:[{id:'k', title:'Check', note:'summary', createdAt:'2026-01-01T00:00:00Z'}], capsuleMeta:{c:{goals:[{text:'ship it'}]}}});
  assert.deepEqual(docs.map((d) => d.id), ['note:1', 'task:1', 'capsule:c', 'checkpoint:k']);
  assert.match(docs[2].text, /desc/);
  assert.match(docs[2].text, /ship it/);
  assert.deepEqual(parseRetrievalKey('checkpoint:k'), {kind:'checkpoint', id:'k'});
  assert.equal(parseRetrievalKey('bogus:k'), null);
  buildIndex(docs);
});

test('local retrieval: module makes no network or model calls and UI is wired', () => {
  const mod = readFileSync(path.join(root, 'src/ui/local-retrieval.ts'), 'utf8');
  assert.doesNotMatch(mod, /fetch|XMLHttpRequest|ollama|WebSocket|document\.|window\./i);
  const ui = readFileSync(path.join(root, 'src/components/MemorySearch.tsx'), 'utf8');
  assert.ok(ui.includes('Related items (lexical)'));
  assert.ok(ui.includes('Ranked by shared words on this device (BM25). No embedding model is installed in this build.'));
  assert.ok(ui.includes('Find related'));
  assert.match(ui, /export function describeSource/);
  assert.match(ui, /onClick=\{\(\) => onNavigate\(target\)\}/);
});
