import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/document-explain.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {EXPLAIN_LIMITS, EXPLAIN_AI_LIMITS, EXPLAIN_DEPTHS, buildExplainRequest, describeDestination, cleanExplainReply, runDocumentExplain} = mod;

const NOTE = 'Lease terms.\nRent is $900 due on the 1st.\n\nThe deposit is refundable within 30 days.';

test('explain AI: limits are frozen, under the chat cap, and EXPLAIN_LIMITS is unchanged', () => {
  assert.ok(Object.isFrozen(EXPLAIN_AI_LIMITS));
  assert.equal(EXPLAIN_AI_LIMITS.documentChars, 12000);
  assert.ok(EXPLAIN_AI_LIMITS.promptChars < 15001 && EXPLAIN_AI_LIMITS.promptChars < 16 * 1024);
  assert.equal(EXPLAIN_AI_LIMITS.replyChars, 20000);
  assert.equal(EXPLAIN_AI_LIMITS.timeoutMs, 180000);
  assert.deepEqual({...EXPLAIN_LIMITS}, {documentChars:120000, chunkChars:12000, maxChunks:10, titleChars:120});
  assert.deepEqual(EXPLAIN_DEPTHS.map((d) => d.id), ['summary','detailed','plain-language']);
});

test('buildExplainRequest: frozen, preview === prompt, whole note when nothing selected', () => {
  const r = buildExplainRequest(NOTE, {depth:'summary', noteTitle:'Lease'});
  assert.ok(Object.isFrozen(r));
  assert.ok(Object.isFrozen(r.warnings));
  assert.equal(r.preview, r.prompt);
  assert.equal(r.source, 'text');
  assert.equal(r.truncated, false);
  assert.equal(r.sentChars, NOTE.length);
  assert.ok(r.prompt.includes(`"""\n${NOTE}\n"""`));
  assert.match(r.prompt, /plain text only/i);
  assert.match(r.prompt, /numbered sections/);
  assert.match(r.prompt, /quote the exact words/);
  assert.match(r.prompt, /"Lease", whole note/);
  assert.ok(!r.prompt.includes('Question from the user'));
  assert.deepEqual(buildExplainRequest(NOTE, {depth:'summary', noteTitle:'Lease'}), r);
  const q = buildExplainRequest(NOTE, {depth:'detailed', question:'When is rent due?'});
  assert.ok(q.prompt.includes('Question from the user: When is rent due?'));
  assert.ok(q.prompt.includes(EXPLAIN_DEPTHS.find((d) => d.id === 'detailed').instruction));
  assert.throws(() => buildExplainRequest(NOTE, {depth:'poem'}), /Unknown explanation depth/);
  assert.throws(() => buildExplainRequest('   \n', {depth:'summary'}), /nothing to explain/);
});

test('buildExplainRequest: selection is preferred over the full text and is the only text sent', () => {
  const r = buildExplainRequest(NOTE, {depth:'plain-language', selection:'The deposit is refundable within 30 days.'});
  assert.equal(r.source, 'selection');
  assert.equal(r.sentChars, 'The deposit is refundable within 30 days.'.length);
  assert.ok(r.prompt.includes('selected passage'));
  assert.ok(!r.prompt.includes('Rent is $900'));
  // Whitespace-only selection falls back to the note body.
  assert.equal(buildExplainRequest(NOTE, {depth:'summary', selection:'   '}).source, 'text');
});

test('buildExplainRequest: truncation warning, prompt cap and control-character stripping', () => {
  const big = 'word '.repeat(3000);
  const r = buildExplainRequest(big, {depth:'summary', question:'?'.repeat(800), noteTitle:'t'.repeat(400)});
  assert.equal(r.truncated, true);
  assert.equal(r.sentChars, EXPLAIN_AI_LIMITS.documentChars);
  assert.ok(r.warnings.some((w) => /only the first 12,000/.test(w)));
  assert.ok(r.warnings.some((w) => /question was cut/.test(w)));
  assert.ok(r.prompt.length <= EXPLAIN_AI_LIMITS.promptChars);
  const c = buildExplainRequest('a\u0007b\r\nc\u001b', {depth:'summary', noteTitle:'x\u0000y\nz', question:'why\u0008?'});
  assert.ok(c.prompt.includes('"""\nab\nc\n"""'));
  assert.ok(c.prompt.includes('"x y z"'));
  assert.ok(c.prompt.includes('Question from the user: why ?'));
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(c.prompt, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test('describeDestination: only online requires confirmation and names the cloud', () => {
  assert.deepEqual({...describeDestination('online')}, {mode:'online', label:'Anthropic cloud (stored key)', requiresConfirmation:true});
  assert.deepEqual({...describeDestination('offline')}, {mode:'offline', label:'local model', requiresConfirmation:false});
  assert.equal(describeDestination(undefined).requiresConfirmation, false);
  assert.equal(describeDestination('ONLINE').requiresConfirmation, false);
});

test('cleanExplainReply: strips code fences and preambles, caps length', () => {
  assert.equal(cleanExplainReply('```\n1. "Rent" is monthly.\n```'), '1. "Rent" is monthly.');
  assert.equal(cleanExplainReply('Here is an explanation of the text:\n1. One.\n2. Two.'), '1. One.\n2. Two.');
  assert.equal(cleanExplainReply("Sure! Here's the explanation:\n```text\n1. A\n```"), '1. A');
  assert.equal(cleanExplainReply('Here we go: a normal sentence.'), 'Here we go: a normal sentence.');
  assert.equal(cleanExplainReply(null), '');
  assert.equal(cleanExplainReply('z'.repeat(EXPLAIN_AI_LIMITS.replyChars + 99)).length, EXPLAIN_AI_LIMITS.replyChars);
});

function fakeStreamApi({events = [], startError = null} = {}) {
  const calls = {sent: [], cancelled: [], chat: [], unsubscribed: 0};
  let handler = null;
  const api = {
    async chat(text) { calls.chat.push(text); return {text:'unused', source:'local'}; },
    async chatStreamStart(text) { calls.sent.push(text); if (startError) throw startError; return {streamId:'e1', generation:1, route:'cloud'}; },
    onChatStream(start, h) { handler = h; queueMicrotask(() => { for (const e of events) handler?.(e); }); return () => { calls.unsubscribed++; handler = null; }; },
    async chatStreamCancel(id) { calls.cancelled.push(id); return true; },
  };
  return {api, calls, emit: (e) => handler?.(e)};
}

test('runDocumentExplain: stream deltas, exact prompt, single send, cleaned reply', async () => {
  const req = buildExplainRequest(NOTE, {depth:'summary'});
  const {api, calls} = fakeStreamApi({events: [
    {type:'status'},
    {type:'delta', text:'Here is the explanation:\n'},
    {type:'delta', text:'1. "Rent is $900" means monthly rent.'},
    {type:'done', outcome:'complete', reply:{text:'Here is the explanation:\n1. "Rent is $900" means monthly rent.', source:'cloud'}},
  ]});
  const deltas = [];
  const r = await runDocumentExplain(api, req, {onDelta: (d, soFar) => deltas.push([d, soFar])});
  assert.deepEqual(calls.sent, [req.prompt]);
  assert.deepEqual(calls.chat, []);
  assert.equal(deltas.length, 2);
  assert.equal(deltas.at(-1)[1], 'Here is the explanation:\n1. "Rent is $900" means monthly rent.');
  assert.deepEqual(r, {status:'complete', text:'1. "Rent is $900" means monthly rent.', source:'cloud'});
  assert.equal(calls.unsubscribed, 1);
});

test('runDocumentExplain: cancel calls chatStreamCancel and returns cancelled; pre-aborted sends nothing', async () => {
  const req = buildExplainRequest(NOTE, {depth:'detailed'});
  const {api, calls, emit} = fakeStreamApi();
  const ac = new AbortController();
  const p = runDocumentExplain(api, req, {signal: ac.signal, onDelta: () => ac.abort()});
  await new Promise((r) => setTimeout(r, 5));
  emit({type:'delta', text:'1. Partial'});
  const r = await p;
  assert.equal(r.status, 'cancelled');
  assert.equal(r.text, '1. Partial');
  assert.deepEqual(calls.cancelled, ['e1']);
  const f = fakeStreamApi();
  const done = new AbortController(); done.abort();
  assert.equal((await runDocumentExplain(f.api, req, {signal: done.signal})).status, 'cancelled');
  assert.deepEqual(f.calls.sent, []);
  assert.deepEqual(f.calls.chat, []);
});

test('runDocumentExplain: timeout -> incomplete; failures map to {status:failed, reason} without retry', async () => {
  const req = buildExplainRequest(NOTE, {depth:'summary'});
  let f = fakeStreamApi({events: [{type:'delta', text:'slow'}]});
  const slow = await runDocumentExplain(f.api, req, {timeoutMs: 20});
  assert.equal(slow.status, 'incomplete');
  assert.deepEqual(f.calls.cancelled, ['e1']);
  f = fakeStreamApi({events: [{type:'done', outcome:'failed', reply:{text:'Model not installed', source:'system'}}]});
  assert.deepEqual(await runDocumentExplain(f.api, req), {status:'failed', text:'', source:'system', reason:'Model not installed'});
  f = fakeStreamApi({events: [{type:'delta', text:'Half'}, {type:'lost', reason:'crash'}]});
  const lost = await runDocumentExplain(f.api, req);
  assert.equal(lost.status, 'incomplete');
  assert.equal(lost.text, 'Half');
  assert.match(lost.reason, /lost/);
  // Stream start failure: reported once, no retry and no fallback to chat() (no double send).
  f = fakeStreamApi({startError: new Error('Online mode needs a key')});
  assert.deepEqual(await runDocumentExplain(f.api, req), {status:'failed', text:'', source:'system', reason:'Online mode needs a key'});
  assert.equal(f.calls.sent.length, 1);
  assert.deepEqual(f.calls.chat, []);
});

test('runDocumentExplain: falls back to chat() once and maps system/thrown replies', async () => {
  const req = buildExplainRequest(NOTE, {depth:'plain-language'});
  const sent = [];
  const r = await runDocumentExplain({async chat(t) { sent.push(t); return {text:'```\n1. Simple.\n```', source:'local'}; }}, req);
  assert.deepEqual(sent, [req.prompt]);
  assert.deepEqual(r, {status:'complete', text:'1. Simple.', source:'local'});
  assert.deepEqual(await runDocumentExplain({async chat() { return {text:'Cloud key missing', source:'system'}; }}, req), {status:'failed', text:'', source:'system', reason:'Cloud key missing'});
  let n = 0;
  const thrown = await runDocumentExplain({async chat() { n++; throw new Error('IPC down'); }}, req);
  assert.deepEqual(thrown, {status:'failed', text:'', source:'system', reason:'IPC down'});
  assert.equal(n, 1);
  assert.equal((await runDocumentExplain({chat() { throw new Error('sync'); }}, req)).status, 'failed');
  assert.equal((await runDocumentExplain({async chat() { return {text:'  ', source:'cloud'}; }}, req)).status, 'failed');
  const long = await runDocumentExplain({async chat() { return {text:'q'.repeat(EXPLAIN_AI_LIMITS.replyChars + 5), source:'local'}; }}, req);
  assert.equal(long.status, 'truncated');
  assert.equal(long.text.length, EXPLAIN_AI_LIMITS.replyChars);
  const ac = new AbortController();
  const pending = runDocumentExplain({chat: () => new Promise(() => {})}, req, {signal: ac.signal});
  ac.abort();
  assert.equal((await pending).status, 'cancelled');
  const to = await runDocumentExplain({chat: () => new Promise(() => {})}, req, {timeoutMs: 10});
  assert.equal(to.status, 'incomplete');
  assert.equal((await runDocumentExplain({async chat() { return {text:'x', source:'local'}; }}, {prompt:''})).status, 'failed');
});

test('document explain AI source: module stays pure; PromptTools has preview, confirm, cancel and key gate', () => {
  const src = fs.readFileSync(path.join(root,'src/ui/document-explain.ts'),'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.|clipboard/);
  assert.doesNotMatch(src, /^import /m);
  const ui = fs.readFileSync(path.join(root,'src/components/PromptTools.tsx'),'utf8');
  const start = ui.indexOf('data-document-explain-ai');
  assert.ok(start > ui.indexOf('Explain an approved document'));
  assert.ok(start < ui.indexOf('title="Diagnose error"'));
  const panel = ui.slice(start, ui.indexOf('title="Diagnose error"'));
  assert.match(panel, /Explain with AI/);
  assert.match(panel, /What will be sent/);
  assert.match(panel, /exRequest\.value\.preview/);
  assert.match(panel, /readOnly/);
  assert.match(panel, /Send \$\{[^}]+\} characters to Anthropic cloud/);
  assert.match(panel, /Explain locally/);
  assert.match(panel, /onClick=\{exCancel\}>Cancel/);
  assert.match(panel, /Add your key in Settings/);
  assert.match(panel, /Insert into editor/);
  assert.match(panel, /onInsert\(exResult\.text, 'append'\)/);
  assert.match(panel, /Explanation failed/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
  assert.match(ui, /api\.cloudKeyStatus\(\)/);
  assert.match(ui, /runDocumentExplain\(/);
  assert.match(ui, /buildExplainRequest\(input\.text, \{[^}]*selection: input\.selection/);
  assert.match(ui, /if \(!status\.configured\) \{ setExKeyMissing\(true\); return; \}/);
  assert.doesNotMatch(ui, /readText\(|clipboard\.read/);
});
