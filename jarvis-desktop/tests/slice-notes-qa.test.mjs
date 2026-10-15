import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/notes-qa.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const qa = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {NOTES_QA_LIMITS, suggestNotes, buildNotesQaRequest, parseAnswerReferences, describeDestination, runNotesQa} = qa;

const note = (id, title, body = '', updatedAt = '2026-01-01T00:00:00Z') => ({id, title, body, updatedAt, tags:[]});
const NOTES = [
  note('garden', 'Garden plan', 'Plant tomatoes and basil in April. Tomatoes need full sun.'),
  note('budget', 'Budget', 'Monthly rent and groceries.'),
  note('tomato', 'Tomato varieties', 'Cherry tomatoes, roma tomatoes, heirloom tomatoes.'),
  note('secret', 'Bank PIN', 'private-unchecked-content-1234'),
];

test('notes qa: limits fit the main-process chat input limit', () => {
  assert.ok(Object.isFrozen(NOTES_QA_LIMITS));
  assert.equal(NOTES_QA_LIMITS.maxNotes, 8);
  assert.equal(NOTES_QA_LIMITS.maxCharsPerNote, 6000);
  assert.equal(NOTES_QA_LIMITS.questionChars, 1000);
  assert.ok(NOTES_QA_LIMITS.maxPromptChars <= 16 * 1024);
});

test('notes qa: suggestNotes ranks by local BM25 and ignores empty questions', () => {
  const hits = suggestNotes(NOTES, 'when should I plant tomatoes', 5);
  assert.deepEqual(hits.map((h) => h.id).slice(0, 2), ['garden', 'tomato']);
  assert.ok(!hits.some((h) => h.id === 'budget'));
  assert.ok(hits[0].sharedTerms.includes('plant'));
  assert.deepEqual(suggestNotes(NOTES, '   ', 5), []);
  assert.equal(suggestNotes(NOTES, 'tomatoes', 1).length, 1);
  assert.deepEqual(suggestNotes(null, 'tomatoes'), []);
});

test('notes qa: request numbers notes in order, instructs citations and freezes the result', () => {
  const r = buildNotesQaRequest('When do I plant tomatoes?', [NOTES[2], NOTES[0], NOTES[2]]);
  assert.equal(r.ready, true);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.sources) && Object.isFrozen(r.sources[0]));
  assert.deepEqual(r.sources.map((s) => [s.n, s.id]), [[1, 'tomato'], [2, 'garden']]);
  assert.ok(r.prompt.includes('[1] Title: Tomato varieties'));
  assert.ok(r.prompt.includes('[2] Title: Garden plan'));
  assert.match(r.prompt, /only the numbered notes/);
  assert.match(r.prompt, /like \[2\]/);
  assert.match(r.prompt, /do not contain the answer/);
  assert.ok(r.prompt.endsWith('Question: When do I plant tomatoes?'));
  assert.equal(r.preview, r.prompt);
  assert.equal(r.sentChars, r.prompt.length);
  assert.equal(r.sources[1].chars, NOTES[0].body.length);
  assert.equal(r.sources[1].truncated, false);
});

test('notes qa: caps per note, total and note count with truncation flags and warnings', () => {
  const big = Array.from({length:10}, (_, i) => note(`n${i}`, `Note ${i}`, 'x'.repeat(7000)));
  const r = buildNotesQaRequest('q?', big);
  assert.equal(r.sources.length, 2); // 6000 + 6000 hits the 12000 total
  assert.deepEqual(r.sources.map((s) => s.chars), [6000, 6000]);
  assert.ok(r.sources.every((s) => s.truncated));
  assert.equal(r.noteChars, NOTES_QA_LIMITS.maxTotalChars);
  assert.ok(r.warnings.some((w) => /first 8/.test(w)));
  assert.ok(r.warnings.some((w) => /total was reached/.test(w)));
  assert.ok(r.prompt.length <= NOTES_QA_LIMITS.maxPromptChars);
  const three = buildNotesQaRequest('q?', [note('a', 'A', 'y'.repeat(5000)), note('b', 'B', 'y'.repeat(5000)), note('c', 'C', 'y'.repeat(5000))]);
  assert.deepEqual(three.sources.map((s) => [s.chars, s.truncated]), [[5000, false], [5000, false], [2000, true]]);
  const longQ = buildNotesQaRequest('w'.repeat(1500), [NOTES[0]]);
  assert.equal(longQ.question.length, 1000);
  assert.ok(longQ.warnings.some((w) => /shortened to 1000/.test(w)));
  assert.equal(buildNotesQaRequest('', [NOTES[0]]).ready, false);
  assert.equal(buildNotesQaRequest('q', []).ready, false);
  assert.equal(buildNotesQaRequest('q', []).prompt, '');
});

function streamApi({events = [], cancelOk = true, startError} = {}) {
  const calls = {start: [], chat: [], cancel: []};
  let handler;
  const start = {streamId: 's1', generation: 3, route: 'local'};
  const api = {
    async chat(text) { calls.chat.push(text); return {text: 'should not be used', source: 'local'}; },
    async chatStreamStart(text) { calls.start.push(text); if (startError) throw new Error(startError); return start; },
    async chatStreamCancel(id) {
      calls.cancel.push(id);
      if (cancelOk) queueMicrotask(() => handler({type: 'done', streamId: 's1', generation: 3, outcome: 'cancelled', reply: {text: 'Stopped by you.', source: 'system'}}));
      return cancelOk;
    },
    onChatStream(s, h) {
      handler = h;
      queueMicrotask(() => { for (const e of events) h(e); });
      return () => { handler = () => {}; };
    },
  };
  return {api, calls, emit: (e) => handler(e)};
}
const tag = (o) => ({streamId: 's1', generation: 3, seq: 0, ...o});

test('notes qa: preview equals the text sent, and unchecked notes never appear', async () => {
  const selected = [NOTES[0], NOTES[2]];
  const r = buildNotesQaRequest('When do I plant tomatoes?', selected);
  const sent = [];
  const api = {async chat(text) { sent.push(text); return {text: 'In April [1].', source: 'local'}; }};
  const out = await runNotesQa(api, r);
  assert.deepEqual(sent, [r.preview]);
  assert.equal(out.outcome, 'complete');
  assert.equal(out.text, 'In April [1].');
  assert.ok(!sent[0].includes('private-unchecked-content-1234'));
  assert.ok(!sent[0].includes('Bank PIN'));
  assert.ok(!sent[0].includes('Monthly rent'));
  const s = streamApi({events: [tag({type: 'done', outcome: 'complete', reply: {text: 'ok [2]', source: 'cloud'}})]});
  await runNotesQa(s.api, r);
  assert.deepEqual(s.calls.start, [r.preview]);
  assert.deepEqual(s.calls.chat, []);
});

test('notes qa: parseAnswerReferences maps valid citations and reports unknown ones', () => {
  const r = buildNotesQaRequest('q?', [NOTES[0], NOTES[2]]);
  const p = parseAnswerReferences('  Plant in April [1]. Varieties [2, 1] and [7]; also [2]. ', r.sources);
  assert.equal(p.answer, 'Plant in April [1]. Varieties [2, 1] and [7]; also [2].');
  assert.deepEqual(p.references, [{n: 1, id: 'garden', title: 'Garden plan'}, {n: 2, id: 'tomato', title: 'Tomato varieties'}]);
  assert.deepEqual(p.unknownRefs, [7]);
  assert.deepEqual(parseAnswerReferences('The notes do not contain this.', r.sources).references, []);
  assert.deepEqual(parseAnswerReferences(undefined, r.sources), {answer: '', references: [], unknownRefs: []});
});

test('notes qa: describeDestination requires confirmation only online', () => {
  assert.equal(describeDestination('online').requiresConfirmation, true);
  assert.match(describeDestination('online').label, /Anthropic cloud/);
  assert.equal(describeDestination('offline').requiresConfirmation, false);
  assert.match(describeDestination('offline').label, /Local model/);
});

test('notes qa: stream deltas then done', async () => {
  const r = buildNotesQaRequest('q?', [NOTES[0]]);
  const s = streamApi({events: [
    tag({type: 'status', status: 'streaming'}),
    tag({type: 'delta', text: 'In '}),
    {streamId: 'other', generation: 3, seq: 1, type: 'delta', text: 'IGNORED'},
    tag({type: 'delta', text: 'April [1]'}),
    tag({type: 'done', outcome: 'complete', reply: {text: 'In April [1]', source: 'local'}}),
  ]});
  const deltas = [];
  const out = await runNotesQa(s.api, r, {onDelta: (t) => deltas.push(t)});
  assert.deepEqual(deltas, ['In ', 'April [1]']);
  assert.deepEqual(out, {outcome: 'complete', text: 'In April [1]', source: 'local'});
});

test('notes qa: cancel goes through chatStreamCancel and keeps partial text', async () => {
  const r = buildNotesQaRequest('q?', [NOTES[0]]);
  const s = streamApi({events: [tag({type: 'delta', text: 'partial'})]});
  const ac = new AbortController();
  const p = runNotesQa(s.api, r, {signal: ac.signal, onDelta: () => ac.abort()});
  const out = await p;
  assert.deepEqual(s.calls.cancel, ['s1']);
  assert.equal(out.outcome, 'cancelled');
  assert.equal(out.text, 'partial');
  // cancel reporting nothing to cancel still resolves
  const s2 = streamApi({events: [], cancelOk: false});
  const ac2 = new AbortController();
  const p2 = runNotesQa(s2.api, r, {signal: ac2.signal});
  await new Promise((res) => setTimeout(res, 5));
  ac2.abort();
  assert.equal((await p2).outcome, 'cancelled');
  // already aborted: nothing is sent
  const s3 = streamApi();
  const ac3 = new AbortController(); ac3.abort();
  assert.equal((await runNotesQa(s3.api, r, {signal: ac3.signal})).outcome, 'cancelled');
  assert.deepEqual(s3.calls.start, []);
});

test('notes qa: failures are mapped, not thrown', async () => {
  const r = buildNotesQaRequest('q?', [NOTES[0]]);
  const notReady = buildNotesQaRequest('', [NOTES[0]]);
  const sent = [];
  const api = {async chat(t) { sent.push(t); return {text: 'x', source: 'local'}; }};
  assert.equal((await runNotesQa(api, notReady)).outcome, 'failed');
  assert.deepEqual(sent, []);
  assert.equal((await runNotesQa(null, r)).outcome, 'failed');
  const sys = await runNotesQa({async chat() { return {text: 'Cloud model unavailable: no key. No reply was generated.', source: 'system'}; }}, r);
  assert.equal(sys.outcome, 'failed');
  assert.match(sys.error, /unavailable/);
  const thrown = await runNotesQa({async chat() { throw new Error('boom'); }}, r);
  assert.deepEqual(thrown, {outcome: 'failed', text: '', source: 'none', error: 'boom'});
  const startFail = streamApi({startError: 'busy'});
  const sf = await runNotesQa(startFail.api, r);
  assert.equal(sf.outcome, 'failed');
  assert.equal(sf.error, 'busy');
  assert.deepEqual(startFail.calls.chat, []); // no silent double send
  const lost = await runNotesQa(streamApi({events: [tag({type: 'delta', text: 'half'}), tag({type: 'lost', reason: 'main stopped'})]}).api, r);
  assert.deepEqual(lost, {outcome: 'incomplete', text: 'half', source: 'local', error: 'main stopped'});
  const failedDone = await runNotesQa(streamApi({events: [tag({type: 'done', outcome: 'failed', reply: {text: 'Local model unavailable: down. No reply was generated.', source: 'system'}})]}).api, r);
  assert.equal(failedDone.outcome, 'failed');
});

test('notes qa: chat fallback cancel stops waiting', async () => {
  const r = buildNotesQaRequest('q?', [NOTES[0]]);
  const ac = new AbortController();
  const api = {chat: () => new Promise(() => {})};
  const p = runNotesQa(api, r, {signal: ac.signal});
  ac.abort();
  const out = await p;
  assert.equal(out.outcome, 'cancelled');
  assert.match(out.error, /chat history/);
});

test('notes qa: MemorySearch wires the consent preview and explicit confirm without useCloud', () => {
  const src = readFileSync(path.join(root, 'src/components/MemorySearch.tsx'), 'utf8');
  assert.ok(src.includes('Ask your notes'));
  assert.ok(src.includes('to Anthropic cloud'));
  assert.ok(src.includes('data-confirm-send'));
  assert.ok(src.includes('Ask locally'));
  assert.ok(src.includes('Add your key in Settings'));
  assert.ok(src.includes('cloudKeyStatus()'));
  assert.ok(src.includes('data-consent-preview'));
  assert.ok(src.includes('Assistant chat history'));
  assert.ok(src.includes('runNotesQa('));
  assert.ok(!src.includes('useCloud'));
  const lib = readFileSync(path.join(root, 'src/ui/notes-qa.ts'), 'utf8');
  assert.ok(!lib.includes('useCloud'));
  assert.deepEqual([...lib.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]), ['./local-retrieval']);
});
