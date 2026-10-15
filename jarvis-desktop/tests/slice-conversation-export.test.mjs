import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'src/ui/conversation-export.ts');
const bundle = await build({entryPoints:[entry], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const M = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {CONVERSATION_EXPORT_FORMAT, EXPORT_LIMITS, conversationToMarkdown, exportConversations, parseConversationExport, filterConversations, summarizeConversation, mergeImported, exportFileName, chatToConversation, normalizeHistory} = M;

const conv = (o = {}) => ({
  id: 'c1', title: 'Café plans', createdAt: '2024-03-01T10:00:00.000Z',
  messages: [
    {role:'user', content:'Where *should* we meet?\n  - line two', timestamp:'2024-03-01T10:00:00.000Z'},
    {role:'assistant', content:'Try the **café** near <b>work</b>.', timestamp:'2024-03-01T10:00:05.000Z'},
  ],
  ...o,
});
const envelope = (conversations, extra = {}) => JSON.stringify({format:CONVERSATION_EXPORT_FORMAT, version:1, exportedAt:'2024-03-02T00:00:00.000Z', conversations, ...extra});

test('conversation export: constants and limits', () => {
  assert.equal(CONVERSATION_EXPORT_FORMAT, 'desktop-companion-conversations');
  assert.deepEqual({...EXPORT_LIMITS}, {jsonChars:2000000, conversations:500, messagesPerConversation:2000});
  assert.equal(exportFileName(new Date('2024-05-06T23:00:00Z')), 'desktop-companion-conversations-2024-05-06.json');
});

test('markdown: deterministic, heading, verbatim timestamps and text, labelled turns', () => {
  const c = conv();
  const md = conversationToMarkdown(c, {includeMeta:true});
  assert.equal(md, conversationToMarkdown(structuredClone(c), {includeMeta:true}));
  assert.equal(md, [
    '# Café plans', '',
    'Created: 2024-03-01T10:00:00.000Z',
    'Messages: 2', '',
    '**User:** 2024-03-01T10:00:00.000Z', '',
    'Where *should* we meet?\n  - line two', '',
    '**Assistant:** 2024-03-01T10:00:05.000Z', '',
    'Try the **café** near <b>work</b>.', '',
  ].join('\n'));
  const bare = conversationToMarkdown(c, {includeMeta:false});
  assert.ok(bare.startsWith('# Café plans\n\n**User:** 2024-03-01T10:00:00.000Z'));
  assert.doesNotMatch(bare, /Created:/);
});

test('markdown: model/provider lines only when present, never invented', () => {
  const none = conversationToMarkdown(conv(), {includeMeta:true});
  assert.doesNotMatch(none, /Model:|Provider:|model:|provider:/);
  const withMeta = conversationToMarkdown(conv({model:'llama3:8b', provider:'local', messages:[{role:'assistant', content:'hi', timestamp:'2024-03-01T10:00:05.000Z', provider:'cloud'}]}), {includeMeta:true});
  assert.match(withMeta, /^Model: llama3:8b$/m);
  assert.match(withMeta, /^Provider: local$/m);
  assert.match(withMeta, /^_provider: cloud_$/m);
  assert.doesNotMatch(withMeta, /model: /);
  const onlyProvider = conversationToMarkdown(conv({provider:'cloud'}), {includeMeta:true});
  assert.doesNotMatch(onlyProvider, /Model:/);
  // Chat snapshots carry the stored source as provider only; no model is invented.
  const snap = chatToConversation([{id:'m1', role:'user', text:'hello', createdAt:'2024-01-01T00:00:00.000Z', source:'local'}], new Date('2024-01-02T00:00:00Z'), 'x');
  assert.equal(snap.model, undefined);
  assert.equal(snap.messages[0].provider, 'local');
  assert.equal(snap.title, 'hello');
});

test('envelope: unknown keys dropped and round-trip through the parser', () => {
  const c = {...conv({model:'m'}), secret:'drop me', messages:[{...conv().messages[0], extra:1}]};
  const env = exportConversations([c], new Date('2024-03-02T00:00:00.000Z'));
  assert.deepEqual(Object.keys(env), ['format', 'version', 'exportedAt', 'conversations']);
  assert.equal(env.exportedAt, '2024-03-02T00:00:00.000Z');
  assert.equal(env.conversations[0].secret, undefined);
  assert.equal(env.conversations[0].messages[0].extra, undefined);
  const r = parseConversationExport(JSON.stringify(env));
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.conversations, env.conversations);
});

test('parser: every rejection path reports an exact $-path and never throws', () => {
  const errs = (json) => parseConversationExport(json).errors;
  assert.deepEqual(errs(''), ['$: empty input']);
  assert.deepEqual(errs(42), ['$: expected JSON text']);
  assert.match(errs('{nope')[0], /^\$: invalid JSON/);
  assert.deepEqual(errs('[]'), ['$: expected object']);
  assert.deepEqual(errs('{}'), ['$.format: expected "desktop-companion-conversations"', '$.version: expected 1', '$.exportedAt: expected ISO 8601 timestamp', '$.conversations: expected array']);
  assert.deepEqual(errs(JSON.stringify({format:'x', version:2, exportedAt:'yesterday', conversations:[]})), ['$.format: expected "desktop-companion-conversations"', '$.version: expected 1', '$.exportedAt: expected ISO 8601 timestamp']);
  assert.deepEqual(errs(envelope([{id:'', title:5, createdAt:'2024-13-45', messages:{}}])), [
    '$.conversations[0].id: expected non-empty string', '$.conversations[0].title: expected string',
    '$.conversations[0].createdAt: expected ISO 8601 timestamp', '$.conversations[0].messages: expected array']);
  assert.deepEqual(errs(envelope([conv({messages:[{role:'bot', content:3, timestamp:'nope'}, 'x']})])), [
    '$.conversations[0].messages[0].role: expected "user", "assistant" or "system"',
    '$.conversations[0].messages[0].content: expected string',
    '$.conversations[0].messages[0].timestamp: expected ISO 8601 timestamp',
    '$.conversations[0].messages[1]: expected object']);
  assert.deepEqual(errs(envelope([null])), ['$.conversations[0]: expected object']);
  const bad = parseConversationExport(envelope([conv(), conv({id:'c2', title:null})]));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.conversations, [], 'no partial import on any error');
  // Well-formed but empty.
  const empty = parseConversationExport(envelope([]));
  assert.deepEqual({ok:empty.ok, n:empty.conversations.length, e:empty.errors}, {ok:true, n:0, e:[]});
  // System role accepted.
  assert.equal(parseConversationExport(envelope([conv({messages:[{role:'system', content:'', timestamp:'2024-03-01T10:00:00Z'}]})])).ok, true);
});

test('parser: unknown keys warn, duplicates are dropped and counted', () => {
  const r = parseConversationExport(envelope([{...conv(), extra:true}, conv({title:'dup'}), conv({id:'c2', messages:[{...conv().messages[0], mood:'x'}]}), conv({title:'dup again'})], {app:'other'}));
  assert.equal(r.ok, true);
  assert.deepEqual(r.conversations.map((c) => c.id), ['c1', 'c2']);
  assert.equal(r.conversations[0].title, 'Café plans');
  assert.equal(r.droppedDuplicates, 2);
  assert.deepEqual(r.warnings, [
    '$.app: unknown key ignored',
    '$.conversations[0].extra: unknown key ignored',
    '$.conversations[1].id: duplicate id "c1" dropped',
    '$.conversations[2].messages[0].mood: unknown key ignored',
    '$.conversations[3].id: duplicate id "c1" dropped',
  ]);
  assert.equal(r.conversations[0].extra, undefined);
});

test('parser: size caps on characters, conversations and messages', () => {
  const huge = parseConversationExport(' '.repeat(EXPORT_LIMITS.jsonChars + 1));
  assert.deepEqual(huge.errors, [`$: ${EXPORT_LIMITS.jsonChars + 1} characters; limit is 2000000`]);
  const many = Array.from({length:503}, (_, i) => ({id:`c${i}`, title:'t', createdAt:'2024-01-01T00:00:00Z', messages:[]}));
  const r = parseConversationExport(envelope(many));
  assert.equal(r.ok, true);
  assert.equal(r.conversations.length, 500);
  assert.equal(r.droppedOverCap, 3);
  assert.match(r.warnings[0], /^\$\.conversations: 503 conversations; only the first 500 are kept, 3 dropped$/);
  const msgs = Array.from({length:2001}, () => ({role:'user', content:'x', timestamp:'2024-01-01T00:00:00Z'}));
  assert.deepEqual(parseConversationExport(envelope([conv({messages:msgs})])).errors, ['$.conversations[0].messages: 2001 messages; limit is 2000']);
});

test('filterConversations: accent-folded query, half-open window, newest first, bad dates', () => {
  const list = [
    conv({id:'a', title:'Cafe plans', createdAt:'2024-03-01T00:00:00.000Z'}),
    conv({id:'b', title:'Budget', createdAt:'2024-03-02T00:00:00.000Z', messages:[{role:'user', content:'Résumé review', timestamp:'2024-03-02T00:00:00.000Z'}]}),
    conv({id:'c', title:'CAFÉ again', createdAt:'2024-03-03T12:00:00.000Z', messages:[]}),
  ];
  assert.deepEqual(filterConversations(list, {}).map((c) => c.id), ['c', 'b', 'a']);
  assert.deepEqual(filterConversations(list, {query:'  café '}).map((c) => c.id), ['c', 'a']);
  assert.deepEqual(filterConversations(list, {query:'RESUME'}).map((c) => c.id), ['b']);
  assert.deepEqual(filterConversations(list, {query:'meet'}).map((c) => c.id), ['a'], 'matches message content');
  assert.deepEqual(filterConversations(list, {from:'2024-03-02', to:'2024-03-03'}).map((c) => c.id), ['b'], 'since <= createdAt < until');
  assert.deepEqual(filterConversations(list, {from:'2024-03-01T00:00:00.000Z'}).map((c) => c.id), ['c', 'b', 'a']);
  assert.deepEqual(filterConversations(list, {to:'2024-03-01T00:00:00.000Z'}), []);
  assert.deepEqual(filterConversations(list, {from:'', to:''}).length, 3);
  assert.throws(() => filterConversations(list, {from:'yesterday'}), {message:'Invalid "from" date "yesterday": use YYYY-MM-DD or an ISO 8601 timestamp.'});
  assert.throws(() => filterConversations(list, {to:'2024-02-31x'}), /Invalid "to" date/);
  assert.throws(() => filterConversations(list, {from:'2024-03-05', to:'2024-03-01'}), /is after the "to" date/);
  assert.equal(list[0].id, 'a', 'input is not mutated');
});

test('summarizeConversation and mergeImported counts', () => {
  const c = conv({messages:[
    {role:'user', content:'abc', timestamp:'2024-03-01T10:00:05.000Z'},
    {role:'system', content:'note', timestamp:'2024-03-01T09:00:00.000Z'},
    {role:'assistant', content:'de', timestamp:'2024-03-01T11:00:00.000Z'},
    {role:'user', content:'', timestamp:'2024-03-01T10:30:00.000Z'},
  ]});
  assert.deepEqual(summarizeConversation(c), {messages:4, userTurns:2, assistantTurns:1, firstAt:'2024-03-01T09:00:00.000Z', lastAt:'2024-03-01T11:00:00.000Z', chars:9});
  assert.deepEqual(summarizeConversation(conv({messages:[]})), {messages:0, userTurns:0, assistantTurns:0, firstAt:null, lastAt:null, chars:0});
  const m = mergeImported([conv()], [conv({title:'other'}), conv({id:'n'})]);
  assert.equal(m.added, 1);
  assert.equal(m.skippedExisting, 1);
  assert.equal(m.merged[0].title, 'Café plans');
  assert.equal(m.merged[1].imported, true);
  assert.deepEqual(normalizeHistory('junk'), []);
  assert.deepEqual(normalizeHistory([conv(), {id:1}, conv()]).map((c) => c.id), ['c1']);
});

test('conversation export: module has no network, fs or model code; Assistant wires the History panel', () => {
  const src = readFileSync(entry, 'utf8');
  assert.doesNotMatch(src, /\b(fetch|XMLHttpRequest|WebSocket|localStorage|document|window)\b/);
  assert.doesNotMatch(src, /require\(\s*['"](node:)?fs['"]\s*\)|from ['"](node:)?fs['"]/);
  assert.doesNotMatch(src, /^import /m);
  const ui = readFileSync(path.join(root, 'src/components/Assistant.tsx'), 'utf8');
  assert.match(ui, /aria-label="Search conversation history"/);
  assert.match(ui, /navigator\.clipboard\.writeText\(conversationToMarkdown\(/);
  assert.match(ui, /URL\.revokeObjectURL\(url\)/);
  assert.match(ui, /Export all \(JSON\)/);
  assert.match(ui, /conversations match/);
  assert.match(ui, /<ContextControls \/>/);
});
