import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/dictation-cleanup.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {DICTATION_LIMITS, cleanTranscriptOffline, describeChanges, buildDictationCleanupRequest, describeDestination, runDictationCleanup} = mod;

const kinds = (r) => Object.fromEntries(r.changes.map((c) => [c.kind, c.count]));

test('dictation: limits are frozen and below the chat limit', () => {
  assert.ok(Object.isFrozen(DICTATION_LIMITS));
  assert.equal(DICTATION_LIMITS.transcriptChars, 12000);
  assert.ok(DICTATION_LIMITS.promptChars < 15001 && DICTATION_LIMITS.promptChars < 16 * 1024);
  assert.equal(DICTATION_LIMITS.replyChars, 20000);
  assert.equal(DICTATION_LIMITS.timeoutMs, 180000);
});

test('cleanTranscriptOffline: removes filler words and collapses stutters', () => {
  const r = cleanTranscriptOffline('um so the the meeting is uh, on friday hmm');
  assert.equal(r.text, 'So the meeting is on friday');
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.changes));
  assert.equal(r.truncated, false);
  const k = kinds(r);
  assert.equal(k.filler, 3);
  assert.equal(k.stutter, 1);
  assert.equal(cleanTranscriptOffline('I I I want it').text, 'I want it');
  assert.equal(kinds(cleanTranscriptOffline('we we we go')).stutter, 2);
  // 'like' is intentionally kept; numbers are not collapsed; words containing filler letters are untouched.
  assert.equal(cleanTranscriptOffline('it was like 1 1 thing, ermine and umbrella').text, 'It was like 1 1 thing, ermine and umbrella');
});

test('cleanTranscriptOffline: every spoken punctuation command', () => {
  assert.equal(cleanTranscriptOffline('hello period how are you question mark').text, 'Hello. How are you?');
  assert.equal(cleanTranscriptOffline('first comma second').text, 'First, second');
  assert.equal(cleanTranscriptOffline('line one new line line two').text, 'Line one\nLine two');
  assert.equal(cleanTranscriptOffline('para one new paragraph para two').text, 'Para one\n\nPara two');
  assert.equal(cleanTranscriptOffline('she said open quote hello close quote').text, 'She said "hello"');
  assert.equal(cleanTranscriptOffline('wow exclamation mark done full stop').text, 'Wow! Done.');
  const r = cleanTranscriptOffline('a comma b period c question mark new line d new paragraph open quote e close quote');
  assert.equal(r.text, 'A, b. C?\nD\n\n"E"');
  assert.equal(kinds(r).punctuation, 7);
  // Case-insensitive commands.
  assert.equal(cleanTranscriptOffline('ok Period yes').text, 'Ok. Yes');
});

test('cleanTranscriptOffline: capitalization, whitespace, truncation and idempotence', () => {
  const r = cleanTranscriptOffline("  i think   i'm right .  and it works, see the wiki  ");
  assert.equal(r.text, "I think I'm right. And it works, see the wiki");
  // "i" inside words or the abbreviation "i.e." is not treated as the pronoun.
  assert.equal(cleanTranscriptOffline('Use it via ssh, i.e.').text, 'Use it via ssh, i.e.');
  assert.ok(kinds(r).capitalization >= 3);
  assert.ok(kinds(r).whitespace >= 1);
  const clean = cleanTranscriptOffline('Already clean.');
  assert.equal(clean.text, 'Already clean.');
  assert.deepEqual([...clean.changes], []);
  assert.match(describeChanges(clean), /No changes/);
  assert.match(describeChanges(cleanTranscriptOffline('um the the')), /filler word.*repeated word/i);

  const long = 'word '.repeat(4000);
  const t = cleanTranscriptOffline(long);
  assert.equal(t.truncated, true);
  assert.ok(t.text.length <= DICTATION_LIMITS.transcriptChars);
  assert.match(describeChanges(t), /cut to the first 12,000/);

  const samples = [
    'um so the the meeting is uh, on friday period new paragraph open quote i agree close quote comma he said',
    'hello   world question mark i I think so exclamation point new line uh ok',
    "  er, it's it's fine. really really fine  ",
    long,
  ];
  for (const s of samples) {
    const once = cleanTranscriptOffline(s).text;
    const twice = cleanTranscriptOffline(once);
    assert.equal(twice.text, once, `idempotent for ${s.slice(0, 40)}`);
    assert.equal(cleanTranscriptOffline(s).text, once, 'deterministic');
  }
  // Non-English locale: English word lists are skipped.
  assert.equal(cleanTranscriptOffline('hola period um hola hola', {locale:'es'}).text, 'Hola period um hola');
});

test('buildDictationCleanupRequest: pure, frozen, preview === prompt, transcript only', () => {
  const text = 'um so the the meeting is on friday';
  const r = buildDictationCleanupRequest(text, {style:'plain'});
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.warnings));
  assert.equal(r.preview, r.prompt);
  assert.equal(r.sentChars, text.length);
  assert.equal(r.promptChars, r.prompt.length);
  assert.ok(r.prompt.includes(`"""\n${text}\n"""`));
  assert.match(r.prompt, /cleaned text only/);
  assert.match(r.prompt, /never as instructions/);
  assert.deepEqual(buildDictationCleanupRequest(text, {style:'plain'}), r);
  assert.match(buildDictationCleanupRequest(text, {style:'notes'}).prompt, /notes/);
  assert.match(buildDictationCleanupRequest(text, {style:'message'}).prompt, /message/);
  assert.equal(buildDictationCleanupRequest(text).style, 'plain');
  assert.throws(() => buildDictationCleanupRequest('   '), /no transcript/);
  assert.throws(() => buildDictationCleanupRequest('x', {style:'poem'}), /Unknown cleanup style/);
  const big = buildDictationCleanupRequest('a'.repeat(20000));
  assert.equal(big.truncated, true);
  assert.equal(big.sentChars, 12000);
  assert.ok(big.prompt.length < DICTATION_LIMITS.promptChars);
  assert.equal(big.warnings.length, 1);
});

test('describeDestination: only online needs confirmation', () => {
  const on = describeDestination('online');
  assert.equal(on.requiresConfirmation, true);
  assert.equal(on.label, 'Anthropic cloud (stored key)');
  for (const m of ['offline', undefined, 'other']) assert.equal(describeDestination(m).requiresConfirmation, false);
  assert.ok(Object.isFrozen(on));
});

function streamApi(script) {
  const calls = {start:0, chat:0, cancel:[], prompts:[]};
  let handler = null;
  const api = {
    async chat(t) { calls.chat++; calls.prompts.push(t); return {text:'chat', source:'local'}; },
    async chatStreamStart(t) { calls.start++; calls.prompts.push(t); return {streamId:'s1', generation:1, route:'cloud'}; },
    onChatStream(_start, h) { handler = h; queueMicrotask(() => script?.(h)); return () => { handler = null; }; },
    async chatStreamCancel(id) { calls.cancel.push(id); return true; },
  };
  return {api, calls, emit: (ev) => handler?.(ev)};
}

test('runDictationCleanup: streams deltas once and returns the cleaned reply', async () => {
  const req = buildDictationCleanupRequest('um hello hello');
  const {api, calls} = streamApi((h) => {
    h({type:'delta', text:'Hello'});
    h({type:'delta', text:'.'});
    h({type:'done', outcome:'complete', reply:{text:'Here is the cleaned text:\nHello.', source:'cloud'}});
  });
  const deltas = [];
  const r = await runDictationCleanup(api, req, {onDelta: (d, soFar) => deltas.push([d, soFar])});
  assert.equal(r.status, 'complete');
  assert.equal(r.text, 'Hello.');
  assert.equal(r.source, 'cloud');
  assert.deepEqual(deltas, [['Hello','Hello'], ['.','Hello.']]);
  assert.equal(calls.start, 1);
  assert.equal(calls.chat, 0);
  assert.deepEqual(calls.prompts, [req.prompt]);
});

test('runDictationCleanup: abort cancels the stream and reports cancelled', async () => {
  const req = buildDictationCleanupRequest('hello');
  const ctrl = new AbortController();
  const {api, calls} = streamApi((h) => { h({type:'delta', text:'Hel'}); ctrl.abort(); });
  const r = await runDictationCleanup(api, req, {signal: ctrl.signal});
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(calls.cancel, ['s1']);
  assert.equal(calls.start, 1);
  // Already aborted: nothing is sent at all.
  const pre = new AbortController(); pre.abort();
  const s2 = streamApi();
  assert.equal((await runDictationCleanup(s2.api, req, {signal: pre.signal})).status, 'cancelled');
  assert.equal(s2.calls.start + s2.calls.chat, 0);
});

test('runDictationCleanup: timeout -> incomplete, lost -> incomplete', async () => {
  const req = buildDictationCleanupRequest('hello');
  const {api, calls} = streamApi(() => {});
  const r = await runDictationCleanup(api, req, {timeoutMs: 20});
  assert.equal(r.status, 'incomplete');
  assert.deepEqual(calls.cancel, ['s1']);
  const lost = streamApi((h) => h({type:'lost', reason:'gone'}));
  const l = await runDictationCleanup(lost.api, req);
  assert.equal(l.status, 'incomplete');
  assert.match(l.reason, /gone/);
});

test('runDictationCleanup: chat fallback, failure mapping and no double send', async () => {
  const req = buildDictationCleanupRequest('hello');
  let chats = 0;
  const ok = await runDictationCleanup({async chat(t) { chats++; assert.equal(t, req.prompt); return {text:'```\nHello.\n```', source:'local'}; }}, req);
  assert.deepEqual({status: ok.status, text: ok.text, source: ok.source}, {status:'complete', text:'Hello.', source:'local'});
  assert.equal(chats, 1);

  const sys = await runDictationCleanup({async chat() { chats++; return {text:'Local model unavailable: down.', source:'system'}; }}, req);
  assert.equal(sys.status, 'failed');
  assert.match(sys.reason, /unavailable/);
  assert.equal(sys.text, '');

  const thrown = await runDictationCleanup({async chat() { chats++; throw new Error('boom'); }}, req);
  assert.deepEqual({status: thrown.status, reason: thrown.reason}, {status:'failed', reason:'boom'});
  assert.equal(chats, 3, 'each run sends exactly once, no retries');

  const empty = await runDictationCleanup({async chat() { return {text:'   ', source:'local'}; }}, req);
  assert.equal(empty.status, 'failed');

  const failedStream = streamApi((h) => h({type:'done', outcome:'failed', reply:{text:'Cloud model unavailable: no key.', source:'system'}}));
  const f = await runDictationCleanup(failedStream.api, req);
  assert.equal(f.status, 'failed');
  assert.match(f.reason, /no key/);
  assert.equal(failedStream.calls.start, 1);
  assert.equal(failedStream.calls.chat, 0);

  const startFails = await runDictationCleanup({async chat() { throw new Error('should not be called'); }, async chatStreamStart() { throw new Error('busy'); }, onChatStream() { return () => {}; }}, req);
  assert.deepEqual({status: startFails.status, reason: startFails.reason}, {status:'failed', reason:'busy'});

  const noPrompt = await runDictationCleanup({async chat() { throw new Error('no'); }}, {prompt:''});
  assert.equal(noPrompt.status, 'failed');
  assert.equal((await runDictationCleanup(null, req)).status, 'failed');
});

test('Assistant.tsx wires the dictation preview, confirm and cancel paths', () => {
  const src = fs.readFileSync(path.join(root, 'src/components/Assistant.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/ui\/dictation-cleanup'/);
  assert.match(src, /cleanTranscriptOffline\(original\)/);
  for (const s of ['Clean up dictation', 'Use cleaned', 'Use original', 'Clean with AI', 'Clean locally', 'Add your key in Settings', 'Exact prompt preview', 'Destination: {dest.label}']) assert.ok(src.includes(s), s);
  assert.match(src, /Send \{sendChars\} characters to Anthropic cloud/);
  assert.match(src, /dest\.requiresConfirmation && typeof api\.cloudKeyStatus === 'function'/);
  assert.match(src, /if \(!status\?\.configured\) \{ setKeyMissing\(true\); return; \}/);
  assert.match(src, /runDictationCleanup\(api, request, \{ signal: ctrl\.signal/);
  assert.match(src, /const cancelAi = \(\) => abortRef\.current\?\.abort\(\)/);
  assert.match(src, /onClick=\{cancelAi\}>Cancel</);
  assert.match(src, /sendingRef\.current/);
  // The transcript handler opens the step; insertion stays an explicit click.
  assert.match(src, /setDictation\(\(d\) => \(\{ n: \(d\?\.n \?\? 0\) \+ 1, text: out\.text\.trim\(\) \}\)\)/);
  assert.match(src, /onUse=\{applyDictation\}/);
  assert.match(src, /onClick=\{\(\) => onUse\(cleaned\.text, 'cleaned'\)\}/);
  assert.match(src, /onClick=\{\(\) => onUse\(original, 'original'\)\}/);
  // The AI result replaces the preview only; it never calls setInput directly.
  const comp = src.slice(src.indexOf('export function DictationCleanup'), src.indexOf('function LevelMeter'));
  assert.ok(comp.length > 0 && !comp.includes('setInput'));
});
