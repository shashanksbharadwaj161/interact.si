import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({entryPoints:[path.join(root,'src/ui/document-explain.ts')], bundle:true, write:false, format:'esm', platform:'node', logLevel:'silent'});
const mod = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const {EXPLAIN_LIMITS, EXPLAIN_MODES, fingerprintText, scanSensitive, chunkDocument, approveDocument, isApprovalCurrent, buildExplainPrompt} = mod;

const NOW = Date.UTC(2024, 0, 2, 3, 4, 5);
const DOC = 'First paragraph about the lease.\nIt runs for 12 months.\n\nSecond paragraph: rent is due on the 1st.\n\nThird paragraph.';

test('document explain: limits and modes are as specified and frozen', () => {
  assert.deepEqual({...EXPLAIN_LIMITS}, {documentChars:120000, chunkChars:12000, maxChunks:10, titleChars:120});
  assert.ok(Object.isFrozen(EXPLAIN_MODES));
  assert.deepEqual(EXPLAIN_MODES.map((m) => m.id), ['summary','key-points','plain-language','questions-to-ask','glossary']);
  for (const m of EXPLAIN_MODES) {
    assert.ok(Object.isFrozen(m), m.id);
    assert.ok(m.label.trim() && m.instruction.trim().length > 20, m.id);
  }
});

test('fingerprint: deterministic FNV-1a with length, and changes on any edit', () => {
  assert.equal(fingerprintText(''), 'fnv1a-811c9dc5-0');
  assert.equal(fingerprintText('a'), 'fnv1a-e40c292c-1');
  assert.equal(fingerprintText('foobar'), 'fnv1a-bf9cf968-6');
  assert.equal(fingerprintText(DOC), fingerprintText(DOC));
  assert.match(fingerprintText(DOC), /^fnv1a-[0-9a-f]{8}-\d+$/);
  assert.ok(fingerprintText(DOC).endsWith(`-${DOC.length}`));
  assert.notEqual(fingerprintText(DOC), fingerprintText(DOC.replace('12', '13')));
  assert.notEqual(fingerprintText(DOC), fingerprintText(DOC + ' '));
});

test('chunkDocument: short text is one chunk; offsets tile the text exactly', () => {
  const chunks = chunkDocument(DOC);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], {index:0, start:0, end:DOC.length, text:DOC});
});

test('chunkDocument: splits on paragraph boundaries, respects chunkChars and maxChunks', () => {
  const para = (ch) => ch.repeat(5000);
  const text = [para('a'), para('b'), para('c'), para('d')].join('\n\n');
  const chunks = chunkDocument(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.map((c) => c.text).join(''), text);
  for (const [i, c] of chunks.entries()) {
    assert.equal(c.index, i);
    assert.ok(c.text.length <= EXPLAIN_LIMITS.chunkChars);
    assert.equal(text.slice(c.start, c.end), c.text);
  }
  assert.ok(chunks[0].text.startsWith('a') && chunks[0].text.trimEnd().endsWith('b'));
  assert.ok(chunks[1].text.startsWith('c'));
  assert.equal(chunks[0].end, chunks[1].start);
  // A single oversize paragraph is hard-split under the cap.
  const long = 'word '.repeat(5000);
  const longChunks = chunkDocument(long);
  assert.ok(longChunks.length >= 3);
  assert.equal(longChunks.map((c) => c.text).join(''), long);
  for (const c of longChunks) assert.ok(c.text.length <= EXPLAIN_LIMITS.chunkChars);
  // Paragraphs just over half a chunk each force one part per paragraph: 11 parts > maxChunks.
  const tooMany = Array.from({length: 11}, () => 'x'.repeat(6100)).join('\n\n');
  assert.ok(tooMany.length <= EXPLAIN_LIMITS.documentChars);
  assert.throws(() => chunkDocument(tooMany), /at most 10 parts/);
});

test('chunkDocument: empty and oversize text throw descriptive errors', () => {
  assert.throws(() => chunkDocument(''), /empty/);
  assert.throws(() => chunkDocument('  \n\n\t '), /empty/);
  assert.throws(() => chunkDocument('y'.repeat(120001)), /limit is 120000/);
  assert.throws(() => chunkDocument(42), /must be a string/);
  assert.equal(chunkDocument('z'.repeat(120000).replace(/z{12000}/g, (m) => m.slice(0, 11998) + '\n\n')).length, 10);
});

test('scanSensitive: counts emails, URLs, secrets and long numbers with masked samples', () => {
  const secretKey = 'sk-abcdefghijklmnop1234';
  const text = `Mail jane.doe@example.com or bob@test.org. See https://example.com/a?b=1 now.
Authorization: Bearer abcdefghijklmnopqrstu
api_key=SuperSecretValue99 and ${secretKey}
Card 4111111111111111 and short 12345.`;
  const s = scanSensitive(text);
  assert.deepEqual(s.counts, {email:2, url:1, secret:3, longNumber:1});
  assert.equal(s.total, 7);
  assert.equal(s.samples.length, 7);
  const joined = JSON.stringify(s.samples);
  for (const raw of ['jane.doe@example.com', 'abcdefghijklmnopqrstu', 'SuperSecretValue99', secretKey, '4111111111111111', 'https://example.com/a?b=1']) {
    assert.ok(!joined.includes(raw), `sample leaks ${raw}`);
  }
  for (const sample of s.samples) assert.match(sample.masked, /•{3,}/);
  assert.ok(s.samples.some((x) => x.kind === 'secret' && x.masked.startsWith('Bearer ')));
  const many = Array.from({length: 15}, (_, i) => `user${i}@example.com`).join(' ');
  const m = scanSensitive(many);
  assert.equal(m.counts.email, 15);
  assert.equal(m.samples.length, 10);
  assert.deepEqual(scanSensitive('Nothing to see here.'), {counts:{email:0, url:0, secret:0, longNumber:0}, total:0, samples:[]});
});

test('approveDocument: returns the approval record and validates input', () => {
  const a = approveDocument({title: '  Lease  ', text: DOC, now: NOW});
  assert.equal(a.title, 'Lease');
  assert.equal(a.fingerprint, fingerprintText(DOC));
  assert.equal(a.chars, DOC.length);
  assert.equal(a.chunkCount, 1);
  assert.equal(a.approvedAt, '2024-01-02T03:04:05.000Z');
  assert.deepEqual(a.sensitive, scanSensitive(DOC));
  assert.deepEqual(approveDocument({title:'Lease', text:DOC, now:new Date(NOW)}), a);
  assert.throws(() => approveDocument({title:'   ', text:DOC, now:NOW}), /title is required/);
  assert.throws(() => approveDocument({title:'t'.repeat(121), text:DOC, now:NOW}), /at most 120/);
  assert.throws(() => approveDocument({title:'a\u0007b', text:DOC, now:NOW}), /control characters/);
  assert.throws(() => approveDocument({title:'Lease', text:'   ', now:NOW}), /empty/);
  assert.throws(() => approveDocument({title:'Lease', text:'q'.repeat(120001), now:NOW}), /limit is 120000/);
  assert.throws(() => approveDocument({title:'Lease', text:DOC, now:NaN}), /Invalid approval time/);
  assert.throws(() => approveDocument({title:'Lease', text:DOC, now:-1}), /Invalid approval time/);
  assert.throws(() => approveDocument({title:'Lease', text:DOC, now:'yesterday'}), /Invalid approval time/);
});

test('isApprovalCurrent: true for the approved text, false after any edit or without approval', () => {
  const a = approveDocument({title:'Lease', text:DOC, now:NOW});
  assert.equal(isApprovalCurrent(a, DOC), true);
  assert.equal(isApprovalCurrent(a, DOC + '!'), false);
  assert.equal(isApprovalCurrent(a, DOC.replace('lease', 'Lease')), false);
  assert.equal(isApprovalCurrent({...a, chars: a.chars + 1}, DOC), false);
  assert.equal(isApprovalCurrent(null, DOC), false);
  assert.equal(isApprovalCurrent(a, undefined), false);
});

test('buildExplainPrompt: includes instruction, part label, verbatim chunk and citation rules', () => {
  const text = ['A'.repeat(7000), 'B'.repeat(7000), `${'C'.repeat(7000)}\nClause C: the deposit is $500.`].join('\n\n');
  const a = approveDocument({title:'Lease', text, now:NOW});
  assert.equal(a.chunkCount, 3);
  const chunks = chunkDocument(text);
  const p = buildExplainPrompt({approval:a, text, chunk:2, mode:'glossary', question:'What is the deposit?'});
  assert.equal(typeof p, 'string');
  assert.ok(p.includes(EXPLAIN_MODES.find((m) => m.id === 'glossary').instruction));
  assert.ok(p.includes('Document: Lease (part 3 of 3)'));
  assert.ok(p.includes(chunks[2].text));
  assert.ok(p.includes('Question from the user: What is the deposit?'));
  assert.match(p, /Cite the part number/);
  assert.match(p, /not in the text/);
  assert.ok(!p.includes('A'.repeat(50)));
  const noQ = buildExplainPrompt({approval:a, text, chunk:0, mode:'summary'});
  assert.ok(!noQ.includes('Question from the user'));
  assert.ok(noQ.includes('Document: Lease (part 1 of 3)'));
  assert.equal(buildExplainPrompt({approval:a, text, chunk:0, mode:'summary'}), noQ);
});

test('buildExplainPrompt: every throw path', () => {
  const a = approveDocument({title:'Lease', text:DOC, now:NOW});
  assert.throws(() => buildExplainPrompt({approval:a, text:DOC + 'x', chunk:0, mode:'summary'}), /changed after approval/);
  assert.throws(() => buildExplainPrompt({approval:null, text:DOC, chunk:0, mode:'summary'}), /not approved/);
  assert.throws(() => buildExplainPrompt({approval:a, text:DOC, chunk:0, mode:'poem'}), /Unknown explain mode "poem"/);
  assert.throws(() => buildExplainPrompt({approval:a, text:DOC, chunk:1, mode:'summary'}), /out of range/);
  assert.throws(() => buildExplainPrompt({approval:a, text:DOC, chunk:-1, mode:'summary'}), /out of range/);
  assert.throws(() => buildExplainPrompt({approval:a, text:DOC, chunk:0.5, mode:'summary'}), /out of range/);
  assert.throws(() => buildExplainPrompt({approval:a, text:DOC, chunk:0, mode:'summary', question:'?'.repeat(501)}), /at most 500/);
});

test('document explain source: no network or file access; UI wires approval to the existing sender', () => {
  const src = fs.readFileSync(path.join(root,'src/ui/document-explain.ts'),'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bimport\b[^;]*['"](?:node:)?fs['"]|require\(|window\.|document\./);
  assert.doesNotMatch(src, /^import /m);
  const ui = fs.readFileSync(path.join(root,'src/components/PromptTools.tsx'),'utf8');
  assert.match(ui, /Explain an approved document/);
  assert.match(ui, /Only text you paste and approve here is sent; this build does not open files or read other windows\./);
  assert.match(ui, /Scan and approve/);
  assert.match(ui, /buildExplainPrompt\(/);
  assert.match(ui, /isApprovalCurrent\(docApproval, docText\)/);
  assert.match(ui, /disabled=\{!docCurrent \|\| !docPrompt\.ok/);
  assert.match(ui, /Send part \{docChunk \+ 1\}/);
  assert.ok(ui.indexOf('Tone and translation') < ui.indexOf('Explain an approved document'));
  assert.ok(ui.indexOf('Explain an approved document') < ui.indexOf('title="Diagnose error"'));
  assert.equal((ui.match(/createDraftSender\(api, \{ streaming: streamingOn \}\)/g) ?? []).length, 3);
  assert.doesNotMatch(ui, /\bfetch\s*\(|XMLHttpRequest/);
});
