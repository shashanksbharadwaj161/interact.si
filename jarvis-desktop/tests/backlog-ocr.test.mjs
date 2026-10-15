// Local OCR adapter tests. Bundles the real TypeScript in memory. The Windows OCR engine, the screen and the user's files are
// never touched: the native runner and the filesystem are injected fakes, images are tiny synthetic headers built here.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backlog-ocr-entry.ts',
    loader: 'ts',
    contents: `
      export * as ocr from './electron/services/ocr.ts';
      export * as runner from './electron/native/runner.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {ocr, runner} = mod;
const {Ocr, sniffImage, cleanOcrLine, OCR_LIMITS} = ocr;

// ---------- synthetic fixtures ----------

const u32 = (n, le = false) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
const u16 = (n, le = false) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
const png = (w, h) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(w), u32(h), Buffer.from([8, 6, 0, 0, 0]), Buffer.alloc(16)]);
const jpeg = (w, h) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16(16), Buffer.alloc(14), Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(h), u16(w), Buffer.alloc(10)]);
const bmp = (w, h) => { const b = Buffer.alloc(54); b.write('BM'); b.writeUInt32LE(40, 14); b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); return b; };
const gif = (w, h) => Buffer.concat([Buffer.from('GIF89a'), u16(w, true), u16(h, true), Buffer.alloc(8)]);
const tiff = (w, h, le = true) => {
  const head = Buffer.concat([Buffer.from(le ? 'II' : 'MM'), le ? Buffer.from([0x2a, 0]) : Buffer.from([0, 0x2a]), u32(8, le)]);
  const entry = (tag, v) => Buffer.concat([u16(tag, le), u16(3, le), u32(1, le), u16(v, le), Buffer.alloc(2)]);
  return Buffer.concat([head, u16(2, le), entry(256, w), entry(257, h), Buffer.alloc(8)]);
};

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** In-memory filesystem. Entries: {kind:'file', bytes} | {kind:'dir'} | {kind:'link'}. Paths are matched case-insensitively. */
function fakeFs(entries) {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  const calls = {lstat: [], readBytes: []};
  const missing = () => Object.assign(new Error('ENOENT'), {code: 'ENOENT'});
  return {
    calls,
    async lstat(p) {
      calls.lstat.push(p);
      const e = map.get(p.toLowerCase());
      if (!e) throw missing();
      return {isSymbolicLink: () => e.kind === 'link', isFile: () => e.kind === 'file', isDirectory: () => e.kind === 'dir', size: e.bytes?.length ?? 0};
    },
    async readBytes(p, max) {
      calls.readBytes.push(p);
      const e = map.get(p.toLowerCase());
      if (!e || e.kind !== 'file') throw missing();
      return e.override ?? e.bytes.subarray(0, max + 1);
    },
    async readFile() { throw new Error('not used'); },
    async createFile() { throw new Error('not used'); },
    async rename() { throw new Error('not used'); },
    async unlink() { throw new Error('not used'); },
  };
}

const PNG_OK = png(800, 600);
const baseFs = (extra = {}) => fakeFs({'C:\\': {kind: 'dir'}, 'C:\\pics': {kind: 'dir'}, 'C:\\pics\\scan.png': {kind: 'file', bytes: PNG_OK}, ...extra});

const PROBE_OK = {ok: true, available: true, languages: ['en-US', 'de-DE'], profileLanguage: 'en-US', maxImageDimension: 10000};

/** Fake native runner: scripted per-op handlers; records every call. */
function fakeNative({probe = PROBE_OK, recognize} = {}) {
  const calls = [];
  return {
    calls,
    async run(script, input, opts = {}) {
      calls.push({script, input, opts});
      if (input.op === 'probe') { if (probe instanceof Error) throw probe; return typeof probe === 'function' ? probe(input, opts) : probe; }
      if (recognize instanceof Error) throw recognize;
      return typeof recognize === 'function' ? recognize(input, opts) : recognize ?? {ok: true, lines: ['Hello', 'world'], language: input.language ?? 'en-US', width: 800, height: 600};
    },
    recognizeCalls: () => calls.filter((c) => c.input.op === 'recognize'),
  };
}

const make = (o = {}) => {
  const native = o.native ?? fakeNative();
  const fs = o.fs ?? baseFs();
  return {native, fs, svc: new Ocr({native, fs, platform: 'win32', ...o.deps})};
};

// ---------- header sniffing ----------

test('sniffImage reads format and size from every supported header', () => {
  assert.deepEqual(sniffImage(png(640, 480)), {format: 'png', width: 640, height: 480, frames: 'single'});
  assert.deepEqual(sniffImage(jpeg(1024, 768)), {format: 'jpeg', width: 1024, height: 768, frames: 'single'});
  assert.deepEqual(sniffImage(bmp(300, 200)), {format: 'bmp', width: 300, height: 200, frames: 'single'});
  assert.deepEqual(sniffImage(gif(120, 90)), {format: 'gif', width: 120, height: 90, frames: 'maybe-multiple'});
  assert.deepEqual(sniffImage(tiff(500, 400, true)), {format: 'tiff', width: 500, height: 400, frames: 'maybe-multiple'});
  assert.deepEqual(sniffImage(tiff(500, 400, false)), {format: 'tiff', width: 500, height: 400, frames: 'maybe-multiple'});
});

test('sniffImage returns null for garbage, truncated or malformed headers and never throws', () => {
  for (const b of [Buffer.alloc(0), Buffer.from('hello world, not an image'), png(10, 10).subarray(0, 20), jpeg(10, 10).subarray(0, 12), Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0, 0]), bmp(5, 5).subarray(0, 20), Buffer.concat([Buffer.from('II*\0'), u32(9999, true)])]) {
    assert.equal(sniffImage(b), null);
  }
  // a JPEG whose segment lengths run past the end terminates instead of looping
  assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({length: 50}, () => Buffer.from([0xff, 0xe1, 0xff, 0xff]))])), null);
});

// ---------- availability ----------

test('status and capability report the probed OS state; no cloud and no continuous capture exist', async () => {
  const {svc, native} = make();
  const st = await svc.status();
  assert.equal(st.available, true);
  assert.deepEqual(st.languages, ['en-US', 'de-DE']);
  assert.equal(st.profileLanguage, 'en-US');
  assert.equal(st.cloud, false);
  assert.equal(st.continuousCapture, false);
  assert.equal(st.engine, 'windows-media-ocr');
  assert.equal(st.busy, false);
  assert.equal(st.reason, undefined);
  assert.equal(st.limits.maxBytes, OCR_LIMITS.maxBytes);
  const cap = await svc.capability();
  assert.deepEqual(cap, {id: 'ocr', name: 'Image text recognition (Windows, local)', available: true});
  assert.equal(native.calls.length, 1, 'probe is cached for 30 s');
  assert.deepEqual(native.calls[0], {script: 'OcrLocal', input: {op: 'probe'}, opts: {timeoutMs: 20000}});
});

test('probe cache expires and force re-queries', async () => {
  let t = 1000;
  const {svc, native} = make({deps: {now: () => t}});
  await svc.probe();
  t += 29_000; await svc.probe();
  assert.equal(native.calls.length, 1);
  t += 2_000; await svc.probe();
  assert.equal(native.calls.length, 2);
  await svc.probe(true);
  assert.equal(native.calls.length, 3);
});

test('unavailable states are explicit and never throw', async () => {
  const {NativeError} = runner;
  const cases = [
    [{deps: {platform: 'linux'}}, /only available on Windows/],
    [{native: fakeNative({probe: new NativeError('Windows PowerShell is not available', 'unavailable')})}, /PowerShell is not available/],
    [{native: fakeNative({probe: new NativeError('Hash mismatch for OcrLocal.ps1', 'integrity')})}, /integrity check failed/],
    [{native: fakeNative({probe: new NativeError('Native helper timed out', 'timeout')})}, /timed out/],
    [{native: fakeNative({probe: new NativeError('Native helper failed (exit 1): C:\\Users\\me\\secret.png', 'exit')})}, /could not be queried$/],
    [{native: fakeNative({probe: {ok: true, available: false, reason: 'The Windows OCR runtime is not available on this system', languages: []}})}, /OCR runtime is not available/],
    [{native: fakeNative({probe: {ok: true, available: true, languages: []}})}, /No Windows OCR language pack/],
    [{native: fakeNative({probe: 'garbage'})}, /could not be queried/],
    [{native: fakeNative({probe: {ok: false, reason: 'boom'}})}, /boom/],
  ];
  for (const [o, re] of cases) {
    const {svc} = make(o);
    const st = await svc.status();
    assert.equal(st.available, false);
    assert.match(st.reason, re);
    assert.doesNotMatch(st.reason, /secret\.png/);
    const cap = await svc.capability();
    assert.equal(cap.available, false);
    const r = await svc.recognizeChosen('C:\\pics\\scan.png');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unavailable');
  }
});

test('probe output is validated: bad tags dropped, duplicates removed, profile language must be well formed', async () => {
  const {svc} = make({native: fakeNative({probe: {ok: true, available: true, languages: ['en-US', 'en-US', 'x', '<script>', 7, 'fr-FR'], profileLanguage: 'not a tag', maxImageDimension: -4}})});
  const st = await svc.status();
  assert.deepEqual(st.languages, ['en-US', 'fr-FR']);
  assert.equal(st.profileLanguage, null);
  assert.equal(st.maxImageDimension, null);
  assert.equal(st.available, true);
  assert.match(st.reason, /Choose one of: en-US, fr-FR/, 'no profile match asks the user to choose');
});

// ---------- recognition ----------

test('recognizes a chosen image: helper gets the validated path, fingerprint and limits; result is untrusted plain text', async () => {
  const {svc, native} = make();
  const r = await svc.recognizeChosen('C:/pics/scan.png');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Hello\nworld');
  assert.deepEqual(r.lines, ['Hello', 'world']);
  assert.equal(r.language, 'en-US');
  assert.equal(r.untrusted, true);
  assert.equal(r.source, 'windows-media-ocr');
  assert.equal(r.format, 'png');
  assert.equal(r.fileName, 'scan.png');
  assert.equal(r.truncated, false);
  assert.equal(r.sanitized, false);
  assert.equal(r.note, undefined);
  assert.equal(JSON.stringify(r).includes('pics'), false, 'the folder path is not echoed back');
  const [call] = native.recognizeCalls();
  assert.equal(call.script, 'OcrLocal');
  assert.deepEqual(call.input, {op: 'recognize', path: 'C:\\pics\\scan.png', sha256: sha(PNG_OK), maxBytes: OCR_LIMITS.maxBytes, maxDimension: 10000, maxPixels: 25_000_000});
  assert.equal(call.opts.timeoutMs, OCR_LIMITS.timeoutMs);
  assert.ok(call.opts.signal instanceof AbortSignal);
});

test('every supported image type passes the pre-checks; extension must match the contents', async () => {
  const files = {'a.png': png(100, 100), 'b.jpg': jpeg(100, 100), 'c.jpeg': jpeg(100, 100), 'd.bmp': bmp(100, 100), 'e.gif': gif(100, 100), 'f.tif': tiff(100, 100), 'g.TIFF': tiff(100, 100)};
  const fs = baseFs(Object.fromEntries(Object.entries(files).map(([n, b]) => [`C:\\pics\\${n}`, {kind: 'file', bytes: b}])));
  const {svc} = make({fs});
  for (const n of Object.keys(files)) assert.equal((await svc.recognizeChosen(`C:\\pics\\${n}`)).ok, true, n);
  const mismatch = baseFs({'C:\\pics\\fake.png': {kind: 'file', bytes: jpeg(100, 100)}, 'C:\\pics\\text.png': {kind: 'file', bytes: Buffer.from('just some text, not an image')}});
  const m = make({fs: mismatch});
  assert.match((await m.svc.recognizeChosen('C:\\pics\\fake.png')).reason, /do not match its extension/);
  assert.match((await m.svc.recognizeChosen('C:\\pics\\text.png')).reason, /not a PNG, JPEG/);
  assert.equal(m.native.calls.length, 0);
});

test('animated or multi-page formats say only the first frame is read; empty results are noted, not faked', async () => {
  const fs = baseFs({'C:\\pics\\anim.gif': {kind: 'file', bytes: gif(100, 100)}});
  const {svc} = make({fs, native: fakeNative({recognize: {ok: true, lines: [], language: 'en-US', width: 100, height: 100}})});
  const r = await svc.recognizeChosen('C:\\pics\\anim.gif');
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
  assert.match(r.note, /No text was recognized/);
  assert.match(r.note, /first frame or page/);
});

test('paths that are not plain local files are refused before any helper runs', async () => {
  const fs = baseFs({
    'C:\\pics\\link.png': {kind: 'link'}, 'C:\\linkdir': {kind: 'link'}, 'C:\\linkdir\\scan.png': {kind: 'file', bytes: PNG_OK},
    'C:\\pics\\folder.png': {kind: 'dir'}, 'C:\\pics\\empty.png': {kind: 'file', bytes: Buffer.alloc(0)},
    'C:\\pics\\notes.txt': {kind: 'file', bytes: PNG_OK}, 'C:\\pics\\run.exe': {kind: 'file', bytes: PNG_OK},
  });
  const {svc, native} = make({fs});
  const bad = [
    ['\\\\server\\share\\scan.png', /not valid/], ['\\\\?\\C:\\pics\\scan.png', /not valid/], ['//server/share/scan.png', /not valid/],
    ['scan.png', /not valid/], ['..\\scan.png', /not valid/], ['C:pics\\scan.png', /not valid/], ['C:\\pics\\..\\pics\\scan.png', /not valid/],
    ['C:\\pics\\scan.png:stream', /not valid/], ['C:\\pics\\scan.png ', /not valid/], ['C:\\pics\\CON.png', /not valid/], ['C:\\pics\\sc\u202eng.png', /not valid/],
    [42, /not valid/], [null, /not valid/], [{}, /not valid/], ['', /not valid/],
    ['C:\\pics\\notes.txt', /Choose an image file/], ['C:\\pics\\run.exe', /Choose an image file/],
    ['C:\\pics\\link.png', /shortcut link or junction/], ['C:\\linkdir\\scan.png', /shortcut link or junction/],
    ['C:\\pics\\folder.png', /not a file/], ['C:\\pics\\empty.png', /empty/], ['C:\\pics\\missing.png', /does not exist/], ['C:\\nodir\\scan.png', /folder does not exist/],
  ];
  for (const [p, re] of bad) {
    const r = await svc.recognizeChosen(p);
    assert.equal(r.ok, false, String(p));
    assert.equal(r.code, 'invalid-image', String(p));
    assert.match(r.reason, re, String(p));
  }
  assert.equal(native.calls.length, 0, 'no probe and no helper for refused paths');
  assert.equal(fs.calls.readBytes.length, 0, 'refused paths are never read');
});

test('size and pixel bounds are enforced from the header, before decoding', async () => {
  const fs = baseFs({
    'C:\\pics\\huge-dim.png': {kind: 'file', bytes: png(20_000, 100)}, 'C:\\pics\\huge-px.png': {kind: 'file', bytes: png(9_000, 9_000)},
    'C:\\pics\\tiny.png': {kind: 'file', bytes: png(8, 8)}, 'C:\\pics\\zero.png': {kind: 'file', bytes: png(0, 500)},
    'C:\\pics\\big.png': {kind: 'file', bytes: Buffer.concat([png(100, 100), Buffer.alloc(OCR_LIMITS.maxBytes)])},
  });
  const {svc, native} = make({fs});
  assert.equal((await svc.recognizeChosen('C:\\pics\\huge-dim.png')).code, 'too-large');
  assert.equal((await svc.recognizeChosen('C:\\pics\\huge-px.png')).code, 'too-large');
  const big = await svc.recognizeChosen('C:\\pics\\big.png');
  assert.equal(big.code, 'too-large');
  assert.match(big.reason, /larger than 10 MB/);
  assert.equal((await svc.recognizeChosen('C:\\pics\\tiny.png')).code, 'invalid-image');
  assert.equal((await svc.recognizeChosen('C:\\pics\\zero.png')).code, 'invalid-image');
  assert.equal(native.calls.length, 0);
});

test('limit overrides can only lower the ceilings', async () => {
  const fs = baseFs({'C:\\pics\\wide.png': {kind: 'file', bytes: png(3000, 100)}});
  const lowered = make({fs, deps: {limits: {maxDimension: 2000}}});
  assert.equal((await lowered.svc.recognizeChosen('C:\\pics\\wide.png')).code, 'too-large');
  assert.equal((await lowered.svc.status()).limits.maxDimension, 2000);
  const raised = make({fs, deps: {limits: {maxDimension: 50_000, maxBytes: 1e12, maxPixels: 1e12}}});
  const st = await raised.svc.status();
  assert.equal(st.limits.maxDimension, OCR_LIMITS.maxDimension);
  assert.equal(st.limits.maxBytes, OCR_LIMITS.maxBytes);
  assert.equal(st.limits.maxPixels, OCR_LIMITS.maxPixels);
});

test('a file that changes between the size check and the read is refused', async () => {
  const fs = baseFs({'C:\\pics\\grow.png': {kind: 'file', bytes: PNG_OK, override: Buffer.concat([PNG_OK, Buffer.from('extra')])}});
  const {svc, native} = make({fs});
  const r = await svc.recognizeChosen('C:\\pics\\grow.png');
  assert.equal(r.code, 'changed');
  assert.equal(native.calls.length, 0);
});

// ---------- languages ----------

test('an explicitly requested language is passed through; uninstalled languages fail without falling back', async () => {
  const {svc, native} = make();
  const ok = await svc.recognizeChosen('C:\\pics\\scan.png', {language: 'DE-de'});
  assert.equal(ok.ok, true);
  assert.equal(ok.language, 'de-DE');
  assert.equal(native.recognizeCalls()[0].input.language, 'de-DE', 'normalized to the installed tag');
  const miss = await svc.recognizeChosen('C:\\pics\\scan.png', {language: 'ja-JP'});
  assert.equal(miss.code, 'language-unavailable');
  assert.match(miss.reason, /ja-JP.*not installed.*en-US, de-DE/);
  assert.equal(native.recognizeCalls().length, 1, 'the helper was not started for the missing language');
  for (const bad of ['en US', "en-US'; calc", '../x', 5, 'e']) {
    const r = await svc.recognizeChosen('C:\\pics\\scan.png', {language: bad});
    assert.equal(r.code, 'invalid-request', String(bad));
  }
});

test('with no profile-matching language the user must pick one; nothing is guessed', async () => {
  const native = fakeNative({probe: {ok: true, available: true, languages: ['fr-FR'], profileLanguage: null, maxImageDimension: 10000}});
  const {svc} = make({native});
  const r = await svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(r.code, 'language-unavailable');
  assert.match(r.reason, /Choose one of: fr-FR/);
  assert.equal(native.recognizeCalls().length, 0);
  const picked = await svc.recognizeChosen('C:\\pics\\scan.png', {language: 'fr-FR'});
  assert.equal(picked.ok, true);
});

test('a helper that answers in another language than requested is a failure, not a result', async () => {
  const {svc} = make({native: fakeNative({recognize: {ok: true, lines: ['Hallo'], language: 'en-US', width: 800, height: 600}})});
  const r = await svc.recognizeChosen('C:\\pics\\scan.png', {language: 'de-DE'});
  assert.equal(r.ok, false);
  assert.match(r.reason, /instead of the requested/);
});

// ---------- result validation ----------

test('recognized text is cleaned: control and invisible characters removed, flagged, trailing blanks dropped', async () => {
  const {svc} = make({native: fakeNative({recognize: {ok: true, language: 'en-US', width: 800, height: 600, lines: ['pay\u202egnp.exe', 'a\u200bb\u0007c', 'tab\there', 'caf\u0065\u0301', '', '  ']}})});
  const r = await svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(r.ok, true);
  assert.equal(r.sanitized, true);
  assert.deepEqual(r.lines, ['paygnp.exe', 'abc', 'tab\there', 'caf\u00e9']);
  assert.equal(/[\u202e\u200b\u0007]/.test(r.text), false);
  assert.deepEqual(cleanOcrLine('plain text'), {text: 'plain text', changed: false});
  assert.equal(cleanOcrLine('x\ud800y').text, 'xy', 'lone surrogates are dropped');
});

test('long output is truncated at the character limit and says so', async () => {
  const lines = Array.from({length: 50}, () => 'x'.repeat(100));
  const {svc} = make({native: fakeNative({recognize: {ok: true, lines, language: 'en-US', width: 800, height: 600}}), deps: {limits: {maxChars: 1000}}});
  const r = await svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 1000);
  assert.match(r.note, /cut off/);
});

test('malformed helper results are failures; helper failure codes map to known codes with bounded reasons', async () => {
  const bads = [null, 'text', [], {ok: true}, {ok: true, lines: 'a', language: 'en-US'}, {ok: true, lines: [1], language: 'en-US'}, {ok: true, lines: ['a'], language: '<b>'},
    {ok: true, lines: Array.from({length: 5001}, () => 'a'), language: 'en-US'}];
  for (const b of bads) {
    const {svc} = make({native: fakeNative({recognize: () => b})});
    const r = await svc.recognizeChosen('C:\\pics\\scan.png');
    assert.equal(r.ok, false, JSON.stringify(b)?.slice(0, 40));
    assert.equal(r.code, 'failed');
  }
  const coded = make({native: fakeNative({recognize: {ok: false, code: 'changed', reason: 'The image changed after it was checked'}})});
  assert.equal((await coded.svc.recognizeChosen('C:\\pics\\scan.png')).code, 'changed');
  const odd = make({native: fakeNative({recognize: {ok: false, code: 'cancelled-by-ghost', reason: 'x\u0000y'.repeat(300)}})});
  const r = await odd.svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(r.code, 'failed', 'unknown helper codes (including "cancelled") collapse to failed');
  assert.ok(r.reason.length <= 200);
  assert.equal(r.reason.includes('\u0000'), false);
});

test('native errors become failures without leaking helper stderr; integrity and missing PowerShell read as unavailable', async () => {
  const {NativeError} = runner;
  const leak = make({native: fakeNative({recognize: new NativeError('Native helper failed (exit 1): Cannot open C:\\Users\\me\\private.png', 'exit')})});
  const r = await leak.svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(r.code, 'failed');
  assert.doesNotMatch(r.reason, /private\.png/);
  const integ = make({native: fakeNative({recognize: new NativeError('hash mismatch', 'integrity')})});
  assert.equal((await integ.svc.recognizeChosen('C:\\pics\\scan.png')).code, 'unavailable');
  const to = make({native: fakeNative({recognize: new NativeError('Native helper timed out', 'timeout')})});
  assert.match((await to.svc.recognizeChosen('C:\\pics\\scan.png')).reason, /timed out/);
  const odd = make({native: fakeNative({recognize: new TypeError('weird')})});
  assert.equal((await odd.svc.recognizeChosen('C:\\pics\\scan.png')).code, 'failed');
});

// ---------- cancellation and concurrency ----------

test('cancel aborts the helper, drops a late result, and frees the slot', async () => {
  let release;
  let seenSignal;
  let first = true;
  const native = fakeNative({
    recognize: (input, opts) => { if (!first) return {ok: true, lines: ['next'], language: 'en-US', width: 800, height: 600}; first = false; seenSignal = opts.signal; return new Promise((res) => { release = () => res({ok: true, lines: ['late'], language: 'en-US', width: 800, height: 600}); }); },
  });
  const {svc} = make({native});
  assert.equal(await svc.cancel(), false, 'nothing to cancel yet');
  const pending = svc.recognizeChosen('C:\\pics\\scan.png');
  while (!release) await new Promise((r) => setImmediate(r));
  assert.equal((await svc.status()).busy, true);
  const busy = await svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(busy.code, 'busy');
  assert.equal(await svc.cancel(), true);
  assert.equal(seenSignal.aborted, true);
  release();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cancelled');
  assert.equal(r.cancelled, true);
  assert.equal((await svc.status()).busy, false);
  const again = await svc.recognizeChosen('C:\\pics\\scan.png');
  assert.equal(again.ok, true, 'the slot is free again');
});

test('a runner cancellation error is reported as cancelled; two simultaneous calls start one helper', async () => {
  const {NativeError} = runner;
  const c = make({native: fakeNative({recognize: new NativeError('Native helper was cancelled', 'cancelled')})});
  assert.equal((await c.svc.recognizeChosen('C:\\pics\\scan.png')).code, 'cancelled');
  const {svc, native} = make();
  const [a, b] = await Promise.all([svc.recognizeChosen('C:\\pics\\scan.png'), svc.recognizeChosen('C:\\pics\\scan.png')]);
  assert.deepEqual([a.ok, b.code].sort(), [true, 'busy'].sort());
  assert.equal(native.recognizeCalls().length, 1);
});

test('cancelling before the helper is reached never starts it', async () => {
  let resolveProbe;
  const native = fakeNative({probe: () => new Promise((res) => { resolveProbe = () => res(PROBE_OK); })});
  const {svc} = make({native});
  const pending = svc.recognizeChosen('C:\\pics\\scan.png');
  while (!resolveProbe) await new Promise((r) => setImmediate(r));
  await svc.cancel();
  resolveProbe();
  assert.equal((await pending).code, 'cancelled');
  assert.equal(native.recognizeCalls().length, 0);
});

// ---------- picker ----------

test('chooseAndRecognize uses the main-process picker; dismissing it is a clean cancel; the renderer never supplies a path', async () => {
  let picks = 0;
  const {svc, native} = make({deps: {pickImage: async () => { picks++; return 'C:\\pics\\scan.png'; }}});
  const r = await svc.chooseAndRecognize({language: 'en-US'});
  assert.equal(r.ok, true);
  assert.equal(picks, 1);
  assert.equal(native.recognizeCalls().length, 1);
  assert.equal(svc.chooseAndRecognize.length <= 1, true, 'the client method accepts options only, no path argument');

  const none = make({deps: {pickImage: async () => null}});
  const d = await none.svc.chooseAndRecognize();
  assert.deepEqual([d.ok, d.code, d.cancelled], [false, 'cancelled', true]);
  assert.equal(none.native.calls.length, 0);

  const boom = make({deps: {pickImage: async () => { throw new Error('C:\\secret\\dir'); }}});
  const e = await boom.svc.chooseAndRecognize();
  assert.equal(e.code, 'failed');
  assert.doesNotMatch(e.reason, /secret/);

  assert.equal((await make().svc.chooseAndRecognize()).code, 'unavailable', 'no picker configured');

  let finish;
  const slow = make({deps: {pickImage: () => new Promise((res) => { finish = () => res(null); })}});
  const first = slow.svc.chooseAndRecognize();
  assert.equal((await slow.svc.chooseAndRecognize()).code, 'busy', 'a second picker is not opened while one is showing');
  finish();
  assert.equal((await first).code, 'cancelled');
});

// ---------- real NativeRunner wiring ----------

test('over the real NativeRunner the adapter degrades to a clear state until OcrLocal is registered, and uses stdin JSON once it is', async () => {
  const spawned = [];
  const execFileImpl = (file, args, _opts, cb) => {
    let stdin = '';
    const child = {stdin: {on() {}, end(s) { stdin = s; setImmediate(() => { spawned.push({file, args, stdin}); cb(null, JSON.stringify(PROBE_OK) + '\n', ''); }); }}, kill() {}};
    return child;
  };
  const r = new runner.NativeRunner({nativeDir: 'C:\\app\\native', execFileImpl, integrity: {manifest: null, required: false}, powershellPath: 'C:\\ps\\powershell.exe'});
  const svc = new Ocr({native: r, platform: 'win32', fs: baseFs()});
  const st = await svc.status();
  if (runner.SCRIPTS.includes('OcrLocal')) {
    assert.equal(st.available, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].args.at(-1), 'C:\\app\\native\\OcrLocal.ps1');
    assert.deepEqual(JSON.parse(spawned[0].stdin), {op: 'probe'});
    assert.equal(spawned[0].args.some((a) => a.includes('scan.png')), false, 'no user input on the command line');
  } else {
    assert.equal(st.available, false);
    assert.equal(spawned.length, 0, 'an unregistered helper is never spawned');
    assert.ok(st.reason);
  }
});

// ---------- the PowerShell helper (static checks; the script is never run here) ----------

const ps1 = readFileSync(path.join(root, 'native', 'OcrLocal.ps1'), 'utf8');

test('OcrLocal.ps1 is offline, capture-free and original: it only decodes the supplied bytes through Windows.Media.Ocr', () => {
  assert.match(ps1, /Windows\.Media\.Ocr\.OcrEngine/);
  assert.match(ps1, /common\.ps1/);
  assert.match(ps1, /ReparsePoint/, 'link and junction components are refused');
  assert.match(ps1, /SHA256/, 'bytes are bound to the fingerprint the app checked');
  for (const banned of [/Invoke-WebRequest|Invoke-RestMethod|WebClient|HttpClient|Net\.Sockets|Start-BitsTransfer|curl\b|wget\b|DownloadFile/i,
    /CopyFromScreen|Graphics\]::FromImage|PrintWindow|BitBlt|Screen\]::|Windows\.Graphics\.Capture|GetDC\b/i,
    /Invoke-Expression|\biex\b|Start-Process|Add-WindowsCapability|Install-Language|DISM|Set-ItemProperty|New-ItemProperty|Set-WinUserLanguageList/i,
    /\$args|\[Environment\]::GetCommandLineArgs/]) {
    assert.doesNotMatch(ps1, banned, String(banned));
  }
  assert.equal(/[^\x00-\x7f]/.test(ps1), false, 'ASCII only, no hidden characters');
});

test('OcrLocal.ps1 parses under Windows PowerShell (parser only; the script is not executed)', {skip: process.platform !== 'win32'}, () => {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(exe)) return;
  const file = path.join(root, 'native', 'OcrLocal.ps1');
  const cmd = '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:OCR_PARSE_TARGET,[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}';
  const res = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], {env: {...process.env, OCR_PARSE_TARGET: file}, encoding: 'utf8', timeout: 30_000, windowsHide: true});
  assert.equal(res.status, 0, res.stdout + res.stderr);
});
