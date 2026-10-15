import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'src/ui/finetune-dataset.ts');
const bundle = await build({entryPoints:[srcPath], bundle:true, write:false, format:'esm', platform:'neutral', logLevel:'silent'});
const fd = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {DATASET_LIMITS, DATASET_FORMAT, parseTranscript, buildExamples, scanExamples, splitDataset, toJsonl, parseJsonl, datasetStats, buildManifest, fnv1a} = fd;

const ex = (id, ...pairs) => ({id, messages: pairs.flatMap(([u, a]) => [{role:'user', content:u}, {role:'assistant', content:a}])});

test('finetune: limits and format constants', () => {
  assert.deepEqual({...DATASET_LIMITS}, {inputChars:400000, examples:2000, turnChars:8000, minTurnChars:2});
  assert.deepEqual({...DATASET_FORMAT}, {format:'desktop-companion-finetune-dataset', version:1});
});

test('finetune: parses both prefix styles case-insensitively, blank lines separate conversations', () => {
  const r = parseTranscript('User: hello there\nAssistant: hi!\n\nme: what time\nai: noon\nME: thanks\nAi: welcome');
  assert.equal(r.examples.length, 2);
  assert.equal(r.truncated, false);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.examples[0], {id:'ex-1', messages:[{role:'user', content:'hello there'}, {role:'assistant', content:'hi!'}]});
  assert.deepEqual(r.examples[1].messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(r.examples[1].messages[3].content, 'welcome');
});

test('finetune: multi-line turns keep continuation lines', () => {
  const r = parseTranscript('User: line one\nline two\r\nAssistant: answer a\n  answer b');
  assert.equal(r.examples[0].messages[0].content, 'line one\nline two');
  assert.equal(r.examples[0].messages[1].content, 'answer a\n  answer b');
});

test('finetune: skipped lines carry 1-based line numbers and reasons', () => {
  const r = parseTranscript('preamble text\nUser: q\nAssistant: a\nUser: dangling\n\nAssistant: orphan\n\nUser:\nAssistant: x');
  assert.equal(r.examples.length, 1);
  assert.deepEqual(r.skipped, [
    {line:1, reason:'no User:/Assistant: prefix before this line'},
    {line:4, reason:'user turn has no assistant reply'},
    {line:6, reason:'assistant turn before any user turn'},
    {line:6, reason:'conversation has no user/assistant pair'},
    {line:8, reason:'empty turn'},
    {line:9, reason:'assistant turn before any user turn'},
    {line:8, reason:'conversation has no user/assistant pair'},
  ]);
});

test('finetune: descriptive errors for empty, oversize and no recognizable turns', () => {
  assert.throws(() => parseTranscript(''), /empty/i);
  assert.throws(() => parseTranscript('   \n\n'), /empty/i);
  assert.throws(() => parseTranscript('x'.repeat(400001)), /400001 characters; the limit is 400000/);
  assert.throws(() => parseTranscript('just some notes\nwith no prefixes'), /No recognizable turns/);
  assert.throws(() => parseTranscript('Assistant: only replies'), /No recognizable turns formed/);
});

test('finetune: truncation at the example limit is reported', () => {
  const text = Array.from({length:2005}, (_, i) => `User: q${i}\nAssistant: a${i}`).join('\n\n');
  const r = parseTranscript(text);
  assert.equal(r.examples.length, 2000);
  assert.equal(r.truncated, true);
  assert.equal(r.examples[1999].id, 'ex-2000');
});

test('finetune: buildExamples dedupes, truncates long turns and drops short turns with counts', () => {
  const input = [ex('a', ['hello', 'world']), ex('b', [' hello ', 'world']), ex('c', ['x', 'too short']), ex('d', ['long', 'y'.repeat(50)])];
  const r = buildExamples(input, {dedupe:true, maxTurnChars:10});
  assert.deepEqual(r.counts, {input:4, kept:2, duplicates:1, truncatedTurns:1, droppedShort:1, droppedOverLimit:0});
  assert.deepEqual(r.examples.map((e) => e.id), ['a', 'd']);
  assert.equal(r.examples[1].messages[1].content, 'y'.repeat(10));
  const noDedupe = buildExamples(input.slice(0, 2), {dedupe:false});
  assert.equal(noDedupe.counts.kept, 2);
  assert.equal(noDedupe.counts.duplicates, 0);
  assert.throws(() => buildExamples(input, {maxTurnChars:9000}), RangeError);
  assert.throws(() => buildExamples(input, {maxTurnChars:1}), RangeError);
});

test('finetune: scan counts emails, URLs, secrets and long digits with masked samples only', () => {
  const secret = 'sk-ABCDEFGHIJKLMNOP1234';
  const r = scanExamples([ex('e1', [`mail me at jane.doe@example.com or see https://example.org/x`, `key ${secret} and Bearer abcdefghijklmnop`]), ex('e2', ['card 1234567890123456789', 'api_key=supersecretvalue'])]);
  assert.equal(r.emails, 1);
  assert.equal(r.urls, 1);
  assert.equal(r.secrets, 3);
  assert.equal(r.longDigits, 1);
  assert.equal(r.total, 6);
  assert.equal(r.samples.length, 6);
  const joined = JSON.stringify(r.samples);
  for (const raw of ['jane.doe@example.com', secret, 'abcdefghijklmnop', '1234567890123456789', 'supersecretvalue']) assert.ok(!joined.includes(raw), `leaked ${raw}`);
  assert.ok(r.samples.every((s) => s.masked.includes('*')));
  const many = scanExamples([ex('m', [Array.from({length:15}, (_, i) => `u${i}@ex.com`).join(' '), 'ok'])]);
  assert.equal(many.emails, 15);
  assert.equal(many.samples.length, 10);
  assert.equal(scanExamples([ex('c', ['clean text', 'nothing here'])]).total, 0);
});

test('finetune: deterministic split by content hash, seed and validated ratio', () => {
  const data = Array.from({length:40}, (_, i) => ex(`ex-${i}`, [`question ${i}`, `answer ${i}`]));
  const a = splitDataset(data, 0.25, 7);
  const b = splitDataset(data.slice().reverse(), 0.25, 7);
  assert.equal(a.validation.length, 10);
  assert.equal(a.train.length, 30);
  const ids = (s) => s.validation.map((e) => e.id).sort();
  assert.deepEqual(ids(a), ids(b), 'same content gives the same split regardless of order');
  assert.deepEqual(ids(splitDataset(data, 0.25, 7)), ids(a));
  assert.notDeepEqual(ids(splitDataset(data, 0.25, 8)), ids(a), 'a different seed changes the split');
  assert.equal(splitDataset(data, 0, 1).validation.length, 0);
  assert.equal(splitDataset(data.slice(0, 3), 0.1, 1).validation.length, 1);
  for (const bad of [-0.1, 0.51, NaN, Infinity, '0.1']) assert.throws(() => splitDataset(data, bad, 1), RangeError);
  assert.equal(fnv1a(''), '811c9dc5');
  assert.equal(fnv1a('a'), 'e40c292c');
});

test('finetune: JSONL round-trip and exact line-numbered errors', () => {
  const data = [ex('x', ['hi', 'hello'], ['how', 'fine']), ex('y', ['q', 'a\nmultiline "quoted"'])];
  const text = toJsonl(data);
  assert.equal(text.split('\n').length, 3);
  assert.ok(text.endsWith('\n'));
  const back = parseJsonl(text);
  assert.deepEqual(back.map((e) => e.messages), data.map((e) => e.messages));
  assert.equal(toJsonl([]), '');
  const good = JSON.stringify({messages:[{role:'user', content:'a'}, {role:'assistant', content:'b'}]});
  assert.throws(() => parseJsonl(''), /empty/);
  assert.throws(() => parseJsonl(`${good}\n{bad`), /^Error: Line 2: not valid JSON/);
  assert.throws(() => parseJsonl(`${good}\n\n${JSON.stringify({messages:[{role:'system', content:'a'}]})}`), /Line 3: messages\[0\]\.role must be "user" or "assistant"/);
  assert.throws(() => parseJsonl(JSON.stringify({messages:[{role:'user', content:'  '}]})), /Line 1: messages\[0\]\.content must be a non-empty string/);
  assert.throws(() => parseJsonl(JSON.stringify({messages:[{role:'assistant', content:'a'}]})), /Line 1: messages\[0\] must be a user turn/);
  assert.throws(() => parseJsonl(`${good}\n${JSON.stringify({messages:[{role:'user', content:'a'}, {role:'user', content:'b'}]})}`), /Line 2: messages\[1\] must be "assistant"/);
  assert.throws(() => parseJsonl(JSON.stringify({messages:[]})), /Line 1: "messages" must be a non-empty array/);
  assert.throws(() => parseJsonl(JSON.stringify({messages:[{role:'user', content:'a'}]})), /Line 1: the last turn must be an assistant reply/);
  assert.throws(() => parseJsonl('[1]'), /Line 1: expected a JSON object/);
});

test('finetune: stats values with labelled token estimate, and manifest envelope', () => {
  const data = [ex('a', ['abcd', 'efgh']), ex('b', ['12', '3456'], ['x1', 'y1'])];
  const s = datasetStats(data);
  assert.equal(s.examples, 2);
  assert.equal(s.turns, 6);
  assert.equal(s.minChars, 8);
  assert.equal(s.maxChars, 10);
  assert.equal(s.meanChars, 9);
  assert.equal(s.totalChars, 18);
  assert.equal(s.approxTokens, 5);
  assert.match(s.approxTokensLabel, /estimate/);
  assert.deepEqual(datasetStats([]), {examples:0, turns:0, minChars:0, meanChars:0, maxChars:0, totalChars:0, approxTokens:0, approxTokensLabel:s.approxTokensLabel});
  const split = splitDataset(data, 0.5, 1);
  const m = buildManifest(split, '2024-01-01T00:00:00.000Z');
  assert.equal(m.format, 'desktop-companion-finetune-dataset');
  assert.equal(m.version, 1);
  assert.equal(m.createdAt, '2024-01-01T00:00:00.000Z');
  assert.deepEqual(m.counts, {train:1, validation:1, total:2, turns:6});
  assert.match(m.fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(buildManifest(split, 'later').fingerprint, m.fingerprint);
});

test('finetune: module source is self-contained with no network or module loading', () => {
  const src = readFileSync(srcPath, 'utf8');
  assert.doesNotMatch(src, /\bfetch\b/);
  assert.doesNotMatch(src, /XMLHttpRequest/);
  assert.doesNotMatch(src, /\brequire\b/);
  assert.doesNotMatch(src, /\bimport\b/);
  assert.doesNotMatch(src, /\b(document|window|electron|ipcRenderer)\b/i);
});

test('finetune: Models view renders the offline dataset panel after the manifest verifier with the verbatim note', () => {
  const models = readFileSync(path.join(root, 'src/components/Models.tsx'), 'utf8');
  assert.ok(models.includes("'This build builds and checks a dataset file only; no training or upload is started.'"));
  assert.ok(models.includes('Fine-tuning dataset (offline, export only)'));
  const verify = models.indexOf('<ManifestVerifyPanel onlineEnabled');
  const panel = models.indexOf('<FinetuneDatasetPanel />');
  assert.ok(verify > 0 && panel > verify);
  for (const s of ['Download train.jsonl', 'Download validation.jsonl', 'Copy manifest JSON', 'URL.revokeObjectURL', 'navigator.clipboard.writeText', "useState('0.1')"]) assert.ok(models.includes(s), s);
});
