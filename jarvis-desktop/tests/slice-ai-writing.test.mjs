import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/ai-writing.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {WRITING_AI_LIMITS, WRITING_ACTIONS, buildWritingRequest, describeDestination, cleanWritingReply, runWritingAction} = mod;
const {TARGET_LANGUAGES, TONE_PROFILES} = await (async () => {
  const b = await build({entryPoints:[path.join(root,'src/ui/tone-profiles.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
  return import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
})();

const SEL = 'Hi team,\nthe deploy at https://ci.example.com/run/42 failed after 300ms — see `npm test`.\nThanks';

test('ai-writing: limits and actions are frozen and sane', () => {
  assert.ok(Object.isFrozen(WRITING_AI_LIMITS));
  assert.equal(WRITING_AI_LIMITS.selectionChars, 12000);
  assert.ok(WRITING_AI_LIMITS.promptChars < 16 * 1024);
  assert.ok(WRITING_AI_LIMITS.replyChars > 0 && WRITING_AI_LIMITS.timeoutMs > 0);
  assert.deepEqual(WRITING_ACTIONS.map((a) => a.id), ['rewrite','summarize','translate']);
});

test('buildWritingRequest: rewrite uses tone-profile rules, protected tokens and asks for text only', () => {
  const r = buildWritingRequest({action:'rewrite', text:SEL, toneProfileId:'team-chat'});
  assert.ok(Object.isFrozen(r));
  assert.equal(r.action, 'rewrite');
  assert.equal(r.preview, r.prompt);
  assert.equal(r.sentChars, SEL.length);
  assert.equal(r.promptChars, r.prompt.length);
  assert.ok(r.prompt.includes(`"""\n${SEL}\n"""`));
  for (const rule of TONE_PROFILES.find((p) => p.id === 'team-chat').rules) assert.ok(r.prompt.includes(rule), rule);
  assert.match(r.prompt, /Rewrite the text below for team chat/);
  assert.match(r.prompt, /original language/);
  assert.match(r.prompt, /rewritten text only: no preamble/);
  assert.ok(r.prompt.includes('- https://ci.example.com/run/42'));
  assert.deepEqual([...r.warnings], []);
  assert.deepEqual(buildWritingRequest({action:'rewrite', text:SEL, toneProfileId:'team-chat'}), r);
  // Rewrite without a profile falls back to the first profile.
  assert.equal(buildWritingRequest({action:'rewrite', text:'hello'}).profileId, TONE_PROFILES[0].id);
});

test('buildWritingRequest: summarize asks for a summary only', () => {
  const r = buildWritingRequest({action:'summarize', text:SEL});
  assert.match(r.prompt, /Summarize the text below/);
  assert.match(r.prompt, /summary only/);
  assert.equal(r.profileId, null);
  assert.ok(r.prompt.includes(SEL));
  const de = buildWritingRequest({action:'summarize', text:SEL, targetLanguage:'de'});
  assert.match(de.prompt, /German \(de\)/);
});

test('buildWritingRequest: translate works for every real language and requires one', () => {
  for (const l of TARGET_LANGUAGES) {
    if (l.code === 'keep') {
      assert.throws(() => buildWritingRequest({action:'translate', text:SEL, targetLanguage:'keep'}), /target language/);
      continue;
    }
    const r = buildWritingRequest({action:'translate', text:SEL, targetLanguage:l.code});
    assert.ok(r.prompt.includes(`Translate the text below into ${l.label} (${l.code})`), l.code);
    assert.match(r.prompt, /translation only/);
    assert.equal(r.languageCode, l.code);
  }
  assert.throws(() => buildWritingRequest({action:'translate', text:SEL}), /target language/);
  assert.throws(() => buildWritingRequest({action:'translate', text:SEL, targetLanguage:'xx'}), /Unknown target language "xx"/);
  const withTone = buildWritingRequest({action:'translate', text:SEL, targetLanguage:'hi', toneProfileId:'email'});
  assert.match(withTone.prompt, /adapt it for email/);
});

test('buildWritingRequest: empty, unknown and oversized input', () => {
  assert.throws(() => buildWritingRequest({action:'rewrite', text:'   \n'}), /Nothing is selected/);
  assert.throws(() => buildWritingRequest({action:'shout', text:'x'}), /Unknown writing action/);
  assert.throws(() => buildWritingRequest({action:'rewrite', text:'x', toneProfileId:'fax'}), /Unknown tone profile "fax"/);
  const big = 'word '.repeat(3000); // 15000 chars
  const r = buildWritingRequest({action:'summarize', text:big});
  assert.equal(r.truncated, true);
  assert.equal(r.sentChars, WRITING_AI_LIMITS.selectionChars);
  assert.equal(r.inputChars, big.length);
  assert.ok(r.warnings.some((w) => /only the first 12,000/.test(w)));
  assert.ok(r.prompt.length <= WRITING_AI_LIMITS.promptChars);
  const long = buildWritingRequest({action:'rewrite', text:'y'.repeat(400), toneProfileId:'social-post'});
  assert.ok(long.warnings.some((w) => /Social post allows \(280/.test(w) || /longer than Social post/.test(w)));
  const ctl = buildWritingRequest({action:'rewrite', text:'a\u0007b\r\nc'});
  assert.equal(ctl.original, 'ab\nc');
});

test('describeDestination: only online requires confirmation and names the cloud', () => {
  assert.deepEqual({...describeDestination('offline')}, {mode:'offline', label:'local model', requiresConfirmation:false});
  assert.deepEqual({...describeDestination('online')}, {mode:'online', label:'Anthropic cloud (stored key)', requiresConfirmation:true});
  assert.equal(describeDestination('weird').requiresConfirmation, false);
});

test('cleanWritingReply: strips fences, preambles and quotes; caps length', () => {
  assert.equal(cleanWritingReply('```\nHello there\n```'), 'Hello there');
  assert.equal(cleanWritingReply('```text\nHello there\n```'), 'Hello there');
  assert.equal(cleanWritingReply('Here is the rewritten text:\nHello there'), 'Hello there');
  assert.equal(cleanWritingReply("Sure! Here's the translation: Hola"), 'Hola');
  assert.equal(cleanWritingReply('Here is the summary:\n```\nShort.\n```'), 'Short.');
  assert.equal(cleanWritingReply('"""\nQuoted\n"""'), 'Quoted');
  assert.equal(cleanWritingReply('Here we go again: a normal sentence.'), 'Here we go again: a normal sentence.');
  assert.equal(cleanWritingReply('  plain  '), 'plain');
  assert.equal(cleanWritingReply(null), '');
  assert.equal(cleanWritingReply('z'.repeat(WRITING_AI_LIMITS.replyChars + 50)).length, WRITING_AI_LIMITS.replyChars);
});

function fakeStreamApi({events = [], cancelEvents = null, startError = null} = {}) {
  const calls = {sent: [], cancelled: [], chat: [], unsubscribed: 0};
  let handler = null;
  const api = {
    async chat(text) { calls.chat.push(text); return {text: 'should not be used', source: 'local'}; },
    async chatStreamStart(text) { if (startError) throw startError; calls.sent.push(text); return {streamId: 's1', generation: 1, route: 'local'}; },
    onChatStream(start, h) {
      handler = h;
      queueMicrotask(() => { for (const e of events) handler?.(e); });
      return () => { calls.unsubscribed++; handler = null; };
    },
    async chatStreamCancel(id) { calls.cancelled.push(id); if (cancelEvents) for (const e of cancelEvents) handler?.(e); return true; },
  };
  return {api, calls, emit: (e) => handler?.(e)};
}

test('runWritingAction: stream path sends exactly request.prompt and collects deltas', async () => {
  const req = buildWritingRequest({action:'rewrite', text:SEL, toneProfileId:'email'});
  const {api, calls} = fakeStreamApi({events: [
    {type:'status', status:'streaming'},
    {type:'delta', text:'Here is the rewritten text:\n'},
    {type:'delta', text:'Hello team.'},
    {type:'done', outcome:'complete', reply:{text:'Here is the rewritten text:\nHello team.', source:'local'}},
  ]});
  const deltas = [];
  const r = await runWritingAction(api, req, {onDelta: (d, soFar) => deltas.push([d, soFar])});
  assert.deepEqual(calls.sent, [req.prompt]);
  assert.deepEqual(calls.chat, []);
  assert.deepEqual(deltas.map((d) => d[0]), ['Here is the rewritten text:\n', 'Hello team.']);
  assert.equal(deltas.at(-1)[1], 'Here is the rewritten text:\nHello team.');
  assert.deepEqual(r, {outcome:'complete', text:'Hello team.', source:'local'});
  assert.equal(calls.unsubscribed, 1);
});

test('runWritingAction: cancel calls chatStreamCancel and yields cancelled with partial text', async () => {
  const req = buildWritingRequest({action:'summarize', text:SEL});
  const {api, calls, emit} = fakeStreamApi();
  const ac = new AbortController();
  const p = runWritingAction(api, req, {signal: ac.signal, onDelta: () => ac.abort()});
  await new Promise((r) => setTimeout(r, 5));
  emit({type:'delta', text:'Partial'});
  const r = await p;
  assert.equal(r.outcome, 'cancelled');
  assert.equal(r.text, 'Partial');
  assert.deepEqual(calls.cancelled, ['s1']);
  // Already-aborted signal: nothing is sent.
  const {api: api2, calls: calls2} = fakeStreamApi();
  const done = new AbortController(); done.abort();
  const r2 = await runWritingAction(api2, req, {signal: done.signal});
  assert.equal(r2.outcome, 'cancelled');
  assert.deepEqual(calls2.sent, []);
});

test('runWritingAction: stream outcomes failed / incomplete / truncated / lost map without throwing', async () => {
  const req = buildWritingRequest({action:'rewrite', text:SEL});
  let f = fakeStreamApi({events: [{type:'done', outcome:'failed', reply:{text:'Model not installed', source:'system'}}]});
  assert.deepEqual(await runWritingAction(f.api, req), {outcome:'failed', text:'', source:'system', error:'Model not installed'});
  f = fakeStreamApi({events: [{type:'delta', text:'Half'}, {type:'lost', reason:'timeout'}]});
  const lost = await runWritingAction(f.api, req);
  assert.equal(lost.outcome, 'incomplete');
  assert.equal(lost.text, 'Half');
  assert.match(lost.error, /lost/);
  f = fakeStreamApi({events: [{type:'done', outcome:'truncated', reply:{text:'Long', source:'cloud'}}]});
  assert.deepEqual(await runWritingAction(f.api, req), {outcome:'truncated', text:'Long', source:'cloud'});
  f = fakeStreamApi({startError: new Error('Online mode needs a key')});
  assert.deepEqual(await runWritingAction(f.api, req), {outcome:'failed', text:'', source:'system', error:'Online mode needs a key'});
  // Timeout: stream that never finishes is cancelled and reported incomplete.
  f = fakeStreamApi({events: [{type:'delta', text:'slow'}]});
  const slow = await runWritingAction(f.api, req, {timeoutMs: 20});
  assert.equal(slow.outcome, 'incomplete');
  assert.deepEqual(f.calls.cancelled, ['s1']);
});

test('runWritingAction: falls back to chat() when stream methods are absent', async () => {
  const req = buildWritingRequest({action:'translate', text:SEL, targetLanguage:'fr'});
  const sent = [];
  const api = {async chat(text) { sent.push(text); return {id:'m', role:'assistant', text:'```\nBonjour\n```', createdAt:'', source:'cloud'}; }};
  const r = await runWritingAction(api, req);
  assert.deepEqual(sent, [req.prompt]);
  assert.deepEqual(r, {outcome:'complete', text:'Bonjour', source:'cloud'});
  const sys = await runWritingAction({async chat() { return {text:'Cloud key missing', source:'system'}; }}, req);
  assert.deepEqual(sys, {outcome:'failed', text:'', source:'system', error:'Cloud key missing'});
  const thrown = await runWritingAction({async chat() { throw new Error('IPC down'); }}, req);
  assert.deepEqual(thrown, {outcome:'failed', text:'', source:'system', error:'IPC down'});
  const syncThrow = await runWritingAction({chat() { throw new Error('sync boom'); }}, req);
  assert.equal(syncThrow.outcome, 'failed');
  const empty = await runWritingAction({async chat() { return {text:'   ', source:'local'}; }}, req);
  assert.equal(empty.outcome, 'failed');
  const long = await runWritingAction({async chat() { return {text:'q'.repeat(WRITING_AI_LIMITS.replyChars + 10), source:'local'}; }}, req);
  assert.equal(long.outcome, 'truncated');
  assert.equal(long.text.length, WRITING_AI_LIMITS.replyChars);
  const ac = new AbortController();
  const pending = runWritingAction({chat: () => new Promise(() => {})}, req, {signal: ac.signal});
  ac.abort();
  assert.equal((await pending).outcome, 'cancelled');
  assert.equal((await runWritingAction({async chat() { return {text:'x', source:'local'}; }}, {prompt:''})).outcome, 'failed');
});

test('ai-writing source: pure module and PromptTools wiring with explicit confirmation', () => {
  const src = fs.readFileSync(path.join(root,'src/ui/ai-writing.ts'),'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|window\.|document\.|clipboard/);
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ['./tone-profiles']);
  const ui = fs.readFileSync(path.join(root,'src/components/PromptTools.tsx'),'utf8');
  assert.match(ui, /Send to Anthropic cloud/);
  assert.match(ui, /Run locally/);
  assert.match(ui, /What will be sent/);
  assert.match(ui, /Add your key in Settings/);
  assert.match(ui, /api\.cloudKeyStatus\(\)/);
  assert.match(ui, /runWritingAction\(/);
  assert.match(ui, /new AbortController\(\)/);
  assert.match(ui, /Replace selection/);
  assert.match(ui, /recorded in the Assistant conversation history/);
  assert.doesNotMatch(ui, /useCloud/);
  assert.doesNotMatch(ui, /readText\(|clipboard\.read/);
});
