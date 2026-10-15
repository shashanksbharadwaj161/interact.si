// Voice foundation tests: capture lifecycle/consent/bounds (audio.ts) and local-engine health, quality gate,
// audio bounds, timeouts and the strict Whisper-style adapter contract (speech.ts).
// The real TypeScript is bundled in memory. No microphone, process, network or file outside memory is ever touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'backlog-voice-entry.ts',
    loader: 'ts',
    contents: `
      export * as speech from './electron/services/speech.ts';
      export * as audio from './src/ui/audio.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const {speech, audio} = mod;
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- helpers ----------

/** 16-bit mono PCM WAV with a constant-amplitude square wave of the given length. */
function makeWav({ms = 1000, amp = 8000, rate = 16000, bits = 16} = {}) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1'); b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(bits, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, 44 + i * 2);
  return [...b];
}

function speechFixture(over = {}) {
  const log = {transcribe: [], written: [], removed: []};
  const native = {
    probeSpeech: async () => ({voices: ['Anna'], recognizers: ['en-US']}),
    speak: async () => ({ok: true}),
    transcribe: async (p) => { log.transcribe.push(p); return over.transcribe ? over.transcribe(p) : {text: 'basic words'}; },
    ...(over.native ?? {}),
  };
  let n = 0;
  const sp = new speech.Speech({
    native, settings: () => ({voice: ''}), tmpDir: 'C:\\tmp', newId: () => `v${++n}`, engines: over.engines,
    writeFile: async (p, d) => { log.written.push([p, d.length]); }, removeFile: async (p) => { log.removed.push(p); },
    audioGate: over.audioGate, transcribeTimeoutMs: over.transcribeTimeoutMs,
  });
  return {sp, log};
}

// ---------- service-side audio bounds ----------

test('inspectWav measures duration and peak and refuses non-PCM16 or empty audio', () => {
  const info = speech.inspectWav(Buffer.from(makeWav({ms: 500, amp: 16384})));
  assert.equal(info.ok, true);
  assert.equal(info.durationMs, 500);
  assert.ok(Math.abs(info.peak - 0.5) < 0.001);
  assert.equal(speech.inspectWav(Buffer.from('not a wav at all')).ok, false);
  assert.match(speech.inspectWav(Buffer.from(makeWav({bits: 8}))).reason, /16-bit PCM/);
  const headerOnly = Buffer.from(makeWav({ms: 0}));
  assert.equal(speech.inspectWav(headerOnly).durationMs, 0);
  const lying = Buffer.from(makeWav({ms: 100}));
  lying.writeUInt32LE(0xffffffff, 40); // streaming-style size: only the bytes that exist are counted
  assert.equal(speech.inspectWav(lying).durationMs, 100);
});

test('audioGate rejects short and silent clips before any recognizer or temp file is used', async () => {
  const {sp, log} = speechFixture({audioGate: true});
  const short = await sp.transcribe(makeWav({ms: 100}));
  assert.match(short.reason, /too short/);
  const silent = await sp.transcribe(makeWav({ms: 1000, amp: 10}));
  assert.match(silent.reason, /No sound was picked up/);
  assert.equal(log.written.length + log.transcribe.length, 0, 'nothing was written or recognized');
  assert.deepEqual(await sp.transcribe(makeWav({ms: 1000})), {text: 'basic words'});
  const tuned = speechFixture({audioGate: {minMs: 2000}});
  assert.match((await tuned.sp.transcribe(makeWav({ms: 1000}))).reason, /too short/);
});

test('without audioGate behaviour is unchanged (clips are not second-guessed)', async () => {
  const {sp} = speechFixture();
  assert.deepEqual(await sp.transcribe(makeWav({ms: 1000, amp: 5})), {text: 'basic words'});
});

// ---------- timeouts and cancellation ----------

test('a recognizer that never answers is stopped at the wall-clock limit and its temp file removed once it settles', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const {sp, log} = speechFixture({transcribeTimeoutMs: 30, transcribe: async () => { await gate; return {text: 'late'}; }});
  const r = await sp.transcribe(makeWav());
  assert.deepEqual(r, {text: '', reason: 'Transcription timed out after 0 seconds'});
  assert.equal((await sp.status()).transcribing, false, 'the slot is free again');
  assert.equal(log.removed.length, 0, 'file is kept while the helper may still read it');
  release();
  await tick(); await tick();
  assert.deepEqual(log.removed, log.transcribe);
});

test('extra engines receive an abort signal and cancelTranscribe returns immediately', async () => {
  let seen;
  const eng = {id: 'slow', name: 'Slow local', probe: async () => ({available: true}), transcribe: (w, {signal}) => { seen = signal; return new Promise(() => undefined); }};
  const {sp} = speechFixture({engines: {stt: [eng]}});
  const p = sp.transcribe(makeWav(), {engine: 'slow'});
  await tick(); await tick();
  assert.equal(sp.cancelTranscribe(), true);
  assert.deepEqual(await p, {text: '', cancelled: true, reason: 'Transcription was cancelled'});
  assert.equal(seen.aborted, true);
});

// ---------- engine health and the neural quality gate ----------

test('with no extra engine the quality gate says neural is not configured and Windows is the only choice', async () => {
  const {sp} = speechFixture();
  const h = await sp.health();
  assert.deepEqual([h.stt.engine, h.stt.quality, h.tts.engine, h.cloud], ['windows', 'basic', 'windows', false]);
  assert.equal(h.qualityGate.neuralStt, false);
  assert.match(h.qualityGate.reason, /No local neural speech model is configured/);
  assert.equal((await sp.status()).stt.quality, 'basic');
});

test('health picks only engines that actually probe available; neural wins when present, else Windows, else none', async () => {
  const neural = (available, reason) => ({id: 'wh', name: 'Local Whisper', quality: 'neural', probe: async () => ({available, reason}), transcribe: async () => ({text: 'neural words'})});
  const ok = speechFixture({engines: {stt: [neural(true)]}});
  const h = await ok.sp.health();
  assert.deepEqual([h.stt.engine, h.stt.quality, h.qualityGate.neuralStt], ['wh', 'neural', true]);
  assert.deepEqual(await ok.sp.transcribe(makeWav(), {engine: 'auto'}), {text: 'neural words'});
  assert.equal(ok.log.transcribe.length, 0);

  const missing = speechFixture({engines: {stt: [neural(false, 'model file not found')]}});
  const hm = await missing.sp.health();
  assert.equal(hm.stt.engine, 'windows', 'an unavailable neural engine is never selected');
  assert.match(hm.qualityGate.reason, /Local Whisper: model file not found/);
  assert.deepEqual(await missing.sp.transcribe(makeWav(), {engine: 'auto'}), {text: 'basic words'});

  const none = speechFixture({native: {probeSpeech: async () => ({voices: [], recognizers: []})}, engines: {stt: [neural(false, 'gone')]}});
  const hn = await none.sp.health();
  assert.equal(hn.stt.engine, null);
  assert.equal(hn.tts.engine, null);
  assert.match(hn.stt.reason, /No Windows speech recognizer is installed/);
  assert.match((await none.sp.transcribe(makeWav(), {engine: 'auto'})).reason, /No Windows speech recognizer/);
  assert.equal(none.log.written.length, 0);
});

test('a probe that throws makes the engine unavailable instead of crashing health', async () => {
  const boom = {id: 'boom', name: 'Boom', quality: 'neural', probe: async () => { throw new Error('kaput'); }, transcribe: async () => ({text: 'x'})};
  const {sp} = speechFixture({engines: {stt: [boom]}});
  const s = await sp.status();
  assert.equal(s.extraEngines[0].available, false);
  assert.match(s.extraEngines[0].reason, /kaput/);
  assert.equal((await sp.health()).stt.engine, 'windows');
});

// ---------- strict local engine contract ----------

const EXE = 'C:\\Tools\\whisper\\main.exe';
const MODEL = 'C:\\Tools\\whisper\\ggml-base.bin';

test('checkLocalPath accepts plain drive paths and refuses UNC, device, relative, traversal, streams, metacharacters and temp', () => {
  assert.equal(speech.checkLocalPath(EXE, 'exe', ['.exe']).ok, true);
  for (const bad of ['\\\\host\\share\\a.exe', '\\\\?\\C:\\a.exe', 'a.exe', 'C:a.exe', 'C:\\x\\..\\a.exe', 'C:\\x\\.\\a.exe', 'C:/x/a.exe', 'C:\\x\\a.exe:evil', 'C:\\x\\a&calc.exe', 'C:\\x\\%PATH%\\a.exe', 'C:\\x\\a.exe\u0000', 'C:\\x\\a.bat', 'C:\\x\\a.EXE ', 42, null]) {
    assert.equal(speech.checkLocalPath(bad, 'exe', ['.exe']).ok, false, String(bad));
  }
  assert.match(speech.checkLocalPath('C:\\Tmp\\Work\\a.exe', 'exe', ['.exe'], ['c:\\tmp']).reason, /temporary folder/);
  assert.equal(speech.checkLocalPath('C:\\Tmpx\\a.exe', 'exe', ['.exe'], ['C:\\Tmp']).ok, true, 'prefix lookalikes are not the temp folder');
});

test('parseLocalSpeechConfig validates every field and returns reasons for rejected entries', () => {
  assert.deepEqual(speech.parseLocalSpeechConfig(undefined), {stt: [], problems: []});
  assert.deepEqual(speech.parseLocalSpeechConfig({}), {stt: [], problems: []});
  const good = speech.parseLocalSpeechConfig({stt: [{kind: 'whisper-cli', executable: EXE, model: MODEL, language: 'en', threads: 4}]}, 'C:\\tmp');
  assert.deepEqual(good.problems, []);
  assert.deepEqual([good.stt[0].id, good.stt[0].language, good.stt[0].threads, good.stt[0].timeoutMs], ['whisper-cli-1', 'en', 4, 55000]);
  const one = (entry) => speech.parseLocalSpeechConfig({stt: [entry]});
  const base = {kind: 'whisper-cli', executable: EXE, model: MODEL};
  const cases = [
    [{...base, kind: 'cloud'}, /kind/],
    [{...base, id: 'windows'}, /reserved/],
    [{...base, id: 'auto'}, /reserved/],
    [{...base, id: 'Bad Id'}, /id must be/],
    [{...base, executable: '\\\\evil\\x.exe'}, /drive letter/],
    [{...base, model: 'C:\\m.txt'}, /\.bin or \.gguf or \.onnx/],
    [{...base, language: 'en; calc'}, /language/],
    [{...base, threads: 99}, /threads/],
    [{...base, timeoutMs: 1}, /timeoutMs/],
    [{...base, sha256: 'ABC'}, /sha256/],
    ['junk', /must be an object/],
  ];
  for (const [entry, re] of cases) {
    const r = one(entry);
    assert.deepEqual(r.stt, [], JSON.stringify(entry));
    assert.match(r.problems[0], re, JSON.stringify(entry));
  }
  const dup = speech.parseLocalSpeechConfig({stt: [{...base, id: 'one'}, {...base, id: 'one'}]});
  assert.deepEqual([dup.stt.length, /duplicated/.test(dup.problems[0])], [1, true]);
  const many = speech.parseLocalSpeechConfig({stt: Array.from({length: 6}, (_, i) => ({...base, id: 'e' + i}))});
  assert.equal(many.stt.length, 4);
  assert.match(many.problems[0], /Only the first 4/);
  assert.equal(speech.parseLocalSpeechConfig({stt: 'x'}).problems.length, 1);
  assert.match(speech.parseLocalSpeechConfig({stt: [{kind: 'whisper-cli', executable: 'C:\\tmp\\w.exe', model: MODEL}]}, 'C:\\tmp').problems[0], /temporary folder/);
});

function adapterFixture({exec, files, config = {}} = {}) {
  const calls = {exec: [], written: [], removed: []};
  const fileTable = files ?? {[EXE]: {size: 5_000_000, head: [0x4d, 0x5a]}, [MODEL]: {size: 140_000_000, head: [0, 0]}};
  const deps = {
    tmpDir: 'C:\\tmp', newId: () => 'w1',
    stat: async (p) => { const f = fileTable[p]; if (!f) throw new Error('ENOENT'); return {isFile: true, size: f.size}; },
    readHead: async (p) => Buffer.from(fileTable[p].head),
    readFile: async (p) => Buffer.from(fileTable[p].bytes ?? 'exe-bytes'),
    writeFile: async (p, d) => { calls.written.push([p, d.length]); },
    removeFile: async (p) => { calls.removed.push(p); },
    exec: exec === null ? undefined : (exec ?? (async (file, args, o) => { calls.exec.push({file, args, o}); return {code: 0, stdout: '[00:00:00.000 --> 00:00:02.000]  hello   there\n[BLANK_AUDIO]\n', stderr: '', timedOut: false}; })),
  };
  const built = speech.buildLocalEngines({stt: [{kind: 'whisper-cli', executable: EXE, model: MODEL, language: 'en', ...config}]}, deps);
  return {engine: built.engines.stt[0], problems: built.problems, calls, deps};
}

test('whisper adapter runs the exact argv without a shell, cleans output, and removes the temp wav', async () => {
  const {engine, calls} = adapterFixture();
  assert.deepEqual(await engine.probe(), {available: true});
  assert.equal(engine.quality, 'neural');
  const r = await engine.transcribe(Buffer.from(makeWav()), {signal: new AbortController().signal});
  assert.deepEqual(r, {text: 'hello there'});
  assert.equal(calls.exec[0].file, EXE);
  assert.deepEqual(calls.exec[0].args, ['-m', MODEL, '-f', 'C:\\tmp\\jarvis-w1.wav', '-nt', '-np', '-l', 'en']);
  assert.deepEqual(calls.removed, ['C:\\tmp\\jarvis-w1.wav']);
  assert.ok(calls.exec[0].o.maxOutputBytes > 0 && calls.exec[0].o.timeoutMs > 0);
});

test('whisper adapter failure modes are honest: bad exit, timeout, empty output, runner throw all remove the file', async () => {
  const sig = () => new AbortController().signal;
  const run = async (res) => { const f = adapterFixture({exec: async () => res}); const r = await f.engine.transcribe(Buffer.from(makeWav()), {signal: sig()}); return {r, removed: f.calls.removed.length}; };
  assert.match((await run({code: 3, stdout: '', stderr: 'secret path', timedOut: false})).r.reason, /exited with code 3/);
  assert.doesNotMatch((await run({code: 3, stdout: '', stderr: 'secret path', timedOut: false})).r.reason, /secret/);
  assert.match((await run({code: null, stdout: '', stderr: '', timedOut: true})).r.reason, /timed out/);
  const empty = await run({code: 0, stdout: '[BLANK_AUDIO]\n', stderr: '', timedOut: false});
  assert.deepEqual(empty.r, {text: '', reason: 'No speech was recognized'});
  assert.equal(empty.removed, 1);
  const thrown = adapterFixture({exec: async () => { throw new Error('spawn EACCES'); }});
  assert.match((await thrown.engine.transcribe(Buffer.from(makeWav()), {signal: sig()})).reason, /failed: spawn EACCES/);
  assert.equal(thrown.calls.removed.length, 1);
  const ac = new AbortController();
  const aborted = adapterFixture({exec: async () => { ac.abort(); return {code: 0, stdout: 'x', stderr: '', timedOut: false}; }});
  assert.match((await aborted.engine.transcribe(Buffer.from(makeWav()), {signal: ac.signal})).reason, /cancelled/);
});

test('whisper adapter is unavailable, never installed, when anything it needs is missing or wrong', async () => {
  assert.match((await adapterFixture({files: {}}).engine.probe()).reason, /could not be read/);
  assert.match((await adapterFixture({files: {[EXE]: {size: 10, head: [0x4d, 0x5a]}, [MODEL]: {size: 5, head: []}}}).engine.probe()).reason, /executable was not found/);
  assert.match((await adapterFixture({files: {[EXE]: {size: 9000, head: [0x7f, 0x45]}, [MODEL]: {size: 5, head: []}}}).engine.probe()).reason, /not a Windows executable/);
  assert.match((await adapterFixture({files: {[EXE]: {size: 9000, head: [0x4d, 0x5a]}, [MODEL]: {size: 0, head: []}}}).engine.probe()).reason, /model file/);
  const noRunner = adapterFixture({exec: null});
  assert.match((await noRunner.engine.probe()).reason, /process runner/);
  assert.match((await noRunner.engine.transcribe(Buffer.from(makeWav()), {signal: new AbortController().signal})).reason, /process runner/);
  assert.equal(noRunner.calls.written.length, 0);
});

test('sha256 pin is enforced against the executable bytes', async () => {
  const bytes = 'trusted-exe-bytes';
  const files = {[EXE]: {size: 5000, head: [0x4d, 0x5a], bytes}, [MODEL]: {size: 5, head: []}};
  const good = adapterFixture({files, config: {sha256: createHash('sha256').update(bytes).digest('hex')}});
  assert.deepEqual(await good.engine.probe(), {available: true});
  const bad = adapterFixture({files, config: {sha256: 'a'.repeat(64)}});
  assert.match((await bad.engine.probe()).reason, /pinned SHA-256/);
});

test('buildLocalEngines with no config creates no engines, so nothing can be reported installed', async () => {
  const built = speech.buildLocalEngines(undefined, {tmpDir: 'C:\\tmp', newId: () => 'x'});
  assert.deepEqual(built, {engines: {stt: []}, problems: []});
  const {sp} = speechFixture({engines: built.engines});
  assert.deepEqual((await sp.status()).extraEngines, []);
  const h = await speechFixture({engines: {stt: [adapterFixture({files: {}}).engine]}}).sp.health();
  assert.equal(h.stt.engine, 'windows');
  assert.equal(h.qualityGate.neuralStt, false);
});

// ---------- capture: consent, lifecycle and bounds (all browser APIs are fakes) ----------

function installBrowser({getUserMedia} = {}) {
  const clock = {now: 0};
  const timers = new Map();
  let nextTimer = 1;
  const state = {streams: [], recorders: [], ctxClosed: 0, getUserMediaCalls: 0, decodeSeconds: 1, amp: 0.4};
  const makeStream = () => {
    const track = {stopped: false, onended: null, stop() { this.stopped = true; }};
    const stream = {track, getTracks: () => [track], getAudioTracks: () => [track]};
    state.streams.push(stream);
    return stream;
  };
  class FakeRecorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; state.recorders.push(this); }
    start() { this.state = 'recording'; }
    emit(size) { this.ondataavailable?.({data: new Blob([new Uint8Array(size)])}); }
    stop() { if (this.state === 'inactive') return; this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }
  class FakeCtx {
    createAnalyser() { return {fftSize: 0, getByteTimeDomainData: (b) => b.fill(128)}; }
    createMediaStreamSource() { return {connect() {}}; }
    decodeAudioData() { return Promise.resolve({duration: state.decodeSeconds}); }
    close() { state.ctxClosed++; return Promise.resolve(); }
  }
  class FakeOffline {
    constructor(ch, frames) { this.frames = frames; this.destination = {}; }
    createBufferSource() { return {connect() {}, start() {}}; }
    startRendering() { const a = new Float32Array(this.frames).fill(state.amp); return Promise.resolve({getChannelData: () => a}); }
  }
  const set = (k, v) => Object.defineProperty(globalThis, k, {value: v, configurable: true, writable: true});
  const saved = {};
  for (const k of ['navigator', 'MediaRecorder', 'AudioContext', 'OfflineAudioContext', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  set('navigator', {mediaDevices: {getUserMedia: getUserMedia ?? (async () => { state.getUserMediaCalls++; return makeStream(); })}});
  set('MediaRecorder', FakeRecorder);
  set('AudioContext', FakeCtx);
  set('OfflineAudioContext', FakeOffline);
  set('requestAnimationFrame', () => 1);
  set('cancelAnimationFrame', () => undefined);
  set('performance', {now: () => clock.now});
  set('window', {
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, {fn, at: clock.now + ms}); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return {
    state, clock, makeStream,
    advance(ms) {
      clock.now += ms;
      for (const [id, t] of [...timers]) if (t.at <= clock.now) { timers.delete(id); t.fn(); }
    },
    restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } },
  };
}

async function withBrowser(opts, fn) {
  const env = installBrowser(opts);
  try { await fn(env); } finally { env.restore(); }
}

test('consent store is explicit, revocable, in-memory without storage, and tolerant of broken storage', () => {
  const c = audio.createMicConsent();
  assert.equal(c.granted(), false);
  c.grant(); assert.equal(c.granted(), true);
  c.revoke(); assert.equal(c.granted(), false);
  const data = new Map();
  const store = {getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k)};
  const a = audio.createMicConsent(store);
  a.grant();
  assert.equal(audio.createMicConsent(store).granted(), true, 'persisted across instances');
  a.revoke();
  assert.equal(audio.createMicConsent(store).granted(), false);
  const broken = {getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }};
  const b = audio.createMicConsent(broken);
  b.grant(); assert.equal(b.granted(), true, 'granted in this window only');
  assert.equal(audio.createMicConsent(broken).granted(), false, 'unreadable storage never counts as consent for a new window');
});

test('without consent the microphone is never requested', async () => {
  await withBrowser({}, async (env) => {
    const consent = audio.createMicConsent();
    const rec = new audio.ClipRecorder({consent});
    await assert.rejects(rec.start(), audio.MicConsentError);
    assert.equal(env.state.getUserMediaCalls, 0);
    assert.equal(rec.state, 'idle');
    consent.grant();
    await rec.start();
    assert.equal(env.state.getUserMediaCalls, 1);
    assert.equal(rec.state, 'recording');
    rec.cancel();
  });
});

test('a second start while one is running is refused and does not open another stream', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    await rec.start();
    await assert.rejects(rec.start(), /already running/);
    assert.equal(env.state.getUserMediaCalls, 1);
    rec.cancel();
    assert.equal(env.state.streams[0].track.stopped, true, 'cancel releases the microphone');
    assert.equal(rec.state, 'idle');
    await rec.start();
    assert.equal(env.state.getUserMediaCalls, 2, 'usable again after cancel');
    rec.cancel();
  });
});

test('cancel during the permission prompt releases the stream that arrives late and start() reports cancellation', async () => {
  let resolveGum;
  await withBrowser({getUserMedia: () => new Promise((r) => { resolveGum = r; })}, async (env) => {
    const rec = new audio.ClipRecorder();
    const starting = rec.start();
    assert.equal(rec.state, 'starting');
    rec.cancel();
    const late = env.makeStream();
    resolveGum(late);
    await assert.rejects(starting, audio.RecordingCancelled);
    assert.equal(late.track.stopped, true, 'a microphone nobody waits for is closed immediately');
    assert.equal(rec.active, false);
    assert.equal(rec.state, 'idle');
  });
});

test('a denied or failed getUserMedia leaves the recorder idle and retryable', async () => {
  let fail = true;
  await withBrowser({getUserMedia: async () => { if (fail) throw new Error('nope'); return {getTracks: () => [], getAudioTracks: () => []}; }}, async () => {
    const rec = new audio.ClipRecorder();
    await assert.rejects(rec.start(), /nope/);
    assert.equal(rec.state, 'idle');
    fail = false;
    await rec.start();
    assert.equal(rec.state, 'recording');
    rec.cancel();
  });
});

test('stop() returns a bounded 16 kHz WAV and releases the microphone', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    await rec.start();
    env.state.recorders[0].emit(500);
    env.advance(1000);
    const clip = await rec.stop();
    assert.ok(Math.abs(clip.durationMs - 1000) < 1);
    assert.equal(clip.wav.length, 44 + 16000 * 2, 'one second of mono PCM16 plus header');
    assert.equal(env.state.streams[0].track.stopped, true);
    assert.equal(rec.state, 'idle');
    await assert.rejects(rec.stop(), /not running/);
  });
});

test('too-short and silent recordings are rejected with a plain message', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    await rec.start();
    env.state.recorders[0].emit(10);
    env.advance(100);
    await assert.rejects(rec.stop(), /too short/);
    await rec.start();
    env.state.recorders[1].emit(10);
    env.state.amp = 0;
    env.advance(1000);
    await assert.rejects(rec.stop(), /No sound was picked up/);
    assert.equal(rec.state, 'idle');
  });
});

test('hitting the maximum length calls onLimit, then capture halts by itself and stop() still returns the capped clip', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    let limit = 0;
    rec.onLimit = () => { limit++; };
    await rec.start();
    env.state.recorders[0].emit(100);
    env.advance(audio.MAX_CLIP_MS);
    assert.equal(limit, 1);
    assert.equal(env.state.recorders[0].state, 'recording', 'the owner gets a grace period first');
    env.advance(audio.LIMIT_GRACE_MS);
    assert.equal(env.state.recorders[0].state, 'inactive', 'recorder halts even if nobody called stop()');
    assert.equal(env.state.streams[0].track.stopped, true);
    env.state.decodeSeconds = 33;
    const clip = await rec.stop();
    assert.equal(clip.durationMs, audio.MAX_CLIP_MS);
    assert.equal(clip.wav.length, 44 + audio.MAX_SAMPLES * 2, 'never longer than the main-process limit');
  });
});

test('excessive recorded bytes halt capture', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    await rec.start();
    env.state.recorders[0].emit(audio.MAX_RECORDED_BYTES + 1);
    assert.equal(env.state.recorders[0].state, 'inactive');
    assert.equal(env.state.streams[0].track.stopped, true);
    rec.cancel();
  });
});

test('device loss mid-recording halts capture and notifies the owner once', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    let lost = 0;
    rec.onDeviceLost = () => { lost++; };
    await rec.start();
    env.state.streams[0].track.onended();
    env.state.streams[0].track.onended?.();
    assert.equal(lost, 1);
    assert.equal(env.state.recorders[0].state, 'inactive');
    rec.cancel();
    assert.equal(rec.state, 'idle');
  });
});

test('cancel while stop() is waiting discards the clip and does not disturb a newer recording', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    await rec.start();
    env.state.recorders[0].emit(100);
    env.advance(1000);
    const stopping = rec.stop();
    rec.cancel();
    await assert.rejects(stopping, audio.RecordingCancelled);
    await rec.start();
    assert.equal(rec.state, 'recording');
    rec.cancel();
  });
});

test('prepareClip enforces silence, length and the sample cap without any recorder', () => {
  const tone = (n, a = 0.5) => new Float32Array(n).fill(a);
  assert.throws(() => audio.prepareClip(new Float32Array(16000), 1000), /No sound/);
  assert.throws(() => audio.prepareClip(tone(16000), 100), /too short/);
  const padded = new Float32Array(48000); padded.fill(0.5, 16000, 16000 + 8000); // half a second of sound inside 3 s of silence
  assert.ok(audio.prepareClip(padded, 3000).wav.length < 44 + 2 * 16000 * 1.2, 'silence around the speech is trimmed');
  const huge = audio.prepareClip(tone(16000 * 40), 40_000);
  assert.equal(huge.durationMs, audio.MAX_CLIP_MS);
  assert.equal(huge.wav.length, 44 + audio.MAX_SAMPLES * 2);
});
