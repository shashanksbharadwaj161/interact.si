// Voice session (src/voice): the reusable listen -> transcribe -> review and read-aloud loop shared by the Assistant and
// (later) the companion island, plus the hub's new stop/cancel IPC. A fake recorder and a fake backend stand in for the
// microphone and the Windows speech helper; nothing here opens a microphone, plays audio or runs PowerShell.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'voice-session-entry.ts',
    loader: 'ts',
    contents: `
      export * from './src/voice/session.ts';
      export { hubVoiceBackend } from './src/voice/backends.ts';
      export { createMicConsent, RecordingCancelled } from './src/ui/audio.ts';
      export * as channels from './electron/channels.ts';
      export * as ipcCore from './electron/ipcCore.ts';
      export { createBackend } from './electron/backend.ts';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', external: ['electron'],
});
const m = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);

const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
const CLIP = { wav: [82, 73, 70, 70, 1, 2, 3], durationMs: 1800, peak: 0.4 };
const READY = { stt: { available: true }, tts: { available: true } };

/** A microphone stand-in: start/stop resolve when the test says so, and every call is recorded. */
function fakeRecorder({ startGate = null, clip = CLIP, stopError = null } = {}) {
  const log = [];
  const rec = {
    log,
    cancelled: false,
    async start() { log.push('start'); if (startGate) await startGate; if (rec.cancelled) throw new m.RecordingCancelled(); },
    async stop() { log.push('stop'); if (rec.cancelled) throw new m.RecordingCancelled(); if (stopError) throw stopError; return clip; },
    cancel() { log.push('cancel'); rec.cancelled = true; },
  };
  return rec;
}

function fixture({ caps = READY, consent = true, supported = true, backend = {}, recorder = () => fakeRecorder(), now } = {}) {
  const calls = [];
  const c = m.createMicConsent(null);
  if (consent) c.grant();
  const recs = [];
  const transcripts = [];
  const be = {
    transcribe: async (wav) => { calls.push(['transcribe', wav]); return { text: '  book a table for two  ' }; },
    speak: async (text) => { calls.push(['speak', text]); return { ok: true }; },
    stopSpeaking: async () => { calls.push(['stopSpeaking']); return true; },
    cancelTranscribe: async () => { calls.push(['cancelTranscribe']); return true; },
    ...backend,
  };
  let capsNow = caps;
  const s = new m.VoiceSession({
    backend: be,
    consent: c,
    support: supported ? { supported: true } : { supported: false, reason: 'This window cannot access a microphone.' },
    caps: () => capsNow,
    createRecorder: () => { const r = recorder(); recs.push(r); return r; },
    consentHint: 'Turn on the microphone switch first.',
    onTranscript: (t) => transcripts.push(t),
    ...(now ? { now } : {}),
  });
  return { s, calls, recs, transcripts, consent: c, setCaps: (v) => { capsNow = v; } };
}

/* ------------------------------------------------------------------ availability */

test('blocks name the first thing a person can fix: bridge, engine, device, then consent', () => {
  const b = (o) => m.voiceBlocks({ hasBackend: true, caps: READY, support: { supported: true }, consent: true, ...o });
  assert.equal(b({ hasBackend: false }).listen.code, 'no-backend');
  assert.deepEqual(b({ caps: { stt: { available: false, reason: 'No Windows speech recognizer is installed' }, tts: null } }).listen, { code: 'engine', reason: 'No Windows speech recognizer is installed' });
  assert.match(b({ caps: { stt: null, tts: null } }).listen.reason, /not been checked/, 'an unchecked engine is never reported as ready');
  assert.equal(b({ support: { supported: false, reason: 'This window cannot record audio.' } }).listen.reason, 'This window cannot record audio.');
  assert.equal(b({ consent: false, consentHint: 'Allow it here.' }).listen.reason, 'Allow it here.');
  assert.equal(b({}).listen, null);
  assert.equal(b({ caps: { stt: { available: true }, tts: { available: false, reason: 'No Windows voices are installed' } } }).speak.reason, 'No Windows voices are installed');
});

test('nothing opens the microphone without consent and a working recognizer; the reason is shown instead', async () => {
  for (const f of [fixture({ consent: false }), fixture({ caps: { stt: { available: false, reason: 'Windows speech could not be queried' }, tts: null } }), fixture({ supported: false })]) {
    await f.s.startListening();
    assert.equal(f.recs.length, 0, 'no recorder was created');
    assert.equal(f.s.getSnapshot().phase, 'idle');
    assert.equal(f.s.getSnapshot().note.tone, 'warn');
  }
  const off = fixture({ consent: false });
  await off.s.startListening();
  assert.equal(off.s.getSnapshot().note.text, 'Turn on the microphone switch first.');
});

/* ------------------------------------------------------------------ listen -> transcribe */

test('explicit start, real listening state and level, then local transcription delivered for review', async () => {
  const f = fixture({ now: (() => { let t = 1000; return () => (t += 10); })() });
  const levels = [];
  f.s.subscribeLevel((l, h) => levels.push([l, h.length]));
  const phases = [];
  f.s.subscribe(() => phases.push(f.s.getSnapshot().phase));
  await f.s.startListening();
  const snap = f.s.getSnapshot();
  assert.equal(snap.phase, 'listening');
  assert.equal(typeof snap.listeningSince, 'number');
  f.recs[0].onLevel(0.33);
  f.recs[0].onLevel(Number.NaN);
  assert.deepEqual(levels, [[0.35, 1], [0, 2]], 'quantised real levels with a short history');
  await f.s.stopListening();
  assert.deepEqual(phases.filter((p, i) => p !== phases[i - 1]), ['starting', 'listening', 'transcribing', 'idle']);
  assert.deepEqual(f.calls, [['transcribe', CLIP.wav]], 'the clip goes only to the surface transcribe call');
  assert.equal(f.transcripts.length, 1);
  assert.deepEqual({ ...f.transcripts[0] }, { n: 1, text: 'book a table for two', durationMs: 1800, quality: 'good', hint: '' });
  assert.equal(f.s.getSnapshot().note, null);
  f.recs[0].onLevel(0.9);
  assert.equal(levels.at(-1)[0], 0, 'a finished recorder cannot move the meter');
});

test('an empty recognition is reported with the engine reason, never filled in', async () => {
  const f = fixture({ backend: { transcribe: async () => ({ text: '   ', reason: 'No speech was recognized' }) } });
  await f.s.startListening();
  await f.s.stopListening();
  assert.equal(f.transcripts.length, 0);
  assert.deepEqual(f.s.getSnapshot().note, { tone: 'warn', code: 'no-speech', text: 'No speech was recognized' });
  const quiet = fixture({ recorder: () => fakeRecorder({ clip: { ...CLIP, peak: 0.02 } }) });
  await quiet.s.startListening();
  await quiet.s.stopListening();
  assert.equal(quiet.transcripts[0].quality, 'quiet');
  assert.match(quiet.transcripts[0].hint, /very quiet/);
  const failing = fixture({ backend: { transcribe: async () => { throw new Error("Error invoking remote method 'jarvis:transcribe': Error: recognizer crashed"); } } });
  await failing.s.startListening();
  await failing.s.stopListening();
  assert.deepEqual(failing.s.getSnapshot().note, { tone: 'warn', code: 'transcribe-failed', text: 'recognizer crashed' });
  const short = fixture({ recorder: () => fakeRecorder({ stopError: new Error('That was too short. Hold the button while you speak.') }) });
  await short.s.startListening();
  await short.s.stopListening();
  assert.equal(short.calls.length, 0, 'an unusable clip is not sent to the recognizer');
  assert.equal(short.s.getSnapshot().note.code, 'clip-error');
});

test('cancel while listening closes the microphone and transcribes nothing', async () => {
  const f = fixture();
  await f.s.startListening();
  f.s.cancel();
  assert.deepEqual(f.recs[0].log, ['start', 'cancel']);
  assert.equal(f.s.getSnapshot().phase, 'idle');
  assert.equal(f.s.getSnapshot().note.code, 'cancelled');
  await f.s.stopListening();
  assert.equal(f.calls.length, 0);
});

test('cancel while transcribing discards the text, tells the engine, and the next clip waits for the engine to be free', async () => {
  const first = deferred();
  const order = [];
  let n = 0;
  const f = fixture({ backend: { transcribe: async (wav) => { const i = ++n; order.push(`call ${i}`); if (i === 1) { const r = await first.p; order.push('first settled'); return r; } return { text: 'second words' }; } } });
  await f.s.startListening();
  const stopping = f.s.stopListening();
  await tick();
  assert.equal(f.s.getSnapshot().phase, 'transcribing');
  f.s.cancel();
  assert.equal(f.s.getSnapshot().phase, 'idle');
  assert.equal(f.s.getSnapshot().note.code, 'cancelled-transcription');
  assert.equal(f.s.getSnapshot().draining, true);
  assert.deepEqual(f.calls, [['cancelTranscribe']]);
  // A new recording while Windows is still finishing the cancelled one.
  await f.s.startListening();
  const second = f.s.stopListening();
  await tick();
  assert.deepEqual(order, ['call 1'], 'the second clip is not sent while the engine is busy');
  assert.equal(f.s.getSnapshot().phase, 'transcribing');
  first.resolve({ text: 'late words from the cancelled clip' });
  await stopping;
  await second;
  assert.deepEqual(order, ['call 1', 'first settled', 'call 2']);
  assert.deepEqual(f.transcripts.map((t) => t.text), ['second words'], 'the cancelled clip never produces text');
  assert.equal(f.s.getSnapshot().draining, false);
});

test('a release during a short permission prompt stops; after a long prompt the recording stays on', async () => {
  let t = 0;
  const gate = deferred();
  const quick = fixture({ recorder: () => fakeRecorder({ startGate: gate.p }), now: () => t });
  const starting = quick.s.startListening();
  assert.equal(quick.s.getSnapshot().phase, 'starting');
  await quick.s.stopListening();
  t = 400;
  gate.resolve();
  await starting;
  await tick(); await tick();
  assert.equal(quick.transcripts.length, 1, 'quick tap: stopped and transcribed');
  const slowGate = deferred();
  t = 0;
  const slow = fixture({ recorder: () => fakeRecorder({ startGate: slowGate.p }), now: () => t });
  const s2 = slow.s.startListening();
  await slow.s.stopListening();
  t = 5000;
  slowGate.resolve();
  await s2;
  assert.equal(slow.s.getSnapshot().phase, 'listening', 'a long prompt is not a deliberate stop');
});

test('microphone errors are explained; a cancelled start stays quiet', async () => {
  const denied = fixture({ recorder: () => ({ ...fakeRecorder(), start: async () => { throw new DOMException('denied', 'NotAllowedError'); } }) });
  await denied.s.startListening();
  assert.equal(denied.s.getSnapshot().phase, 'idle');
  assert.match(denied.s.getSnapshot().note.text, /Microphone access was denied/);
  const gate = deferred();
  const f = fixture({ recorder: () => fakeRecorder({ startGate: gate.p }) });
  const starting = f.s.startListening();
  f.s.cancel(null);
  gate.resolve();
  await starting;
  assert.equal(f.s.getSnapshot().phase, 'idle');
  assert.equal(f.s.getSnapshot().note, null);
});

test('turning consent off, hiding the window or reaching the limit end the recording honestly', async () => {
  const f = fixture();
  await f.s.startListening();
  f.s.setConsent(false);
  assert.equal(f.recs[0].cancelled, true);
  assert.equal(f.s.getSnapshot().consent, false);
  assert.equal(f.s.getSnapshot().note.code, 'consent-off');
  assert.equal(f.calls.length, 0);

  const g = fixture();
  await g.s.startListening();
  g.s.windowHidden();
  assert.equal(g.recs[0].cancelled, true);
  assert.equal(g.s.getSnapshot().note.code, 'hidden');

  const gate = deferred();
  const h = fixture({ backend: { transcribe: async () => { await gate.p; return { text: 'limit words' }; } } });
  await h.s.startListening();
  h.recs[0].onLimit();
  await tick();
  assert.equal(h.s.getSnapshot().phase, 'transcribing');
  assert.equal(h.s.getSnapshot().note.code, 'limit');
  h.s.windowHidden();
  assert.equal(h.s.getSnapshot().phase, 'transcribing', 'hiding does not discard a recording already being transcribed');
  gate.resolve();
  await tick(); await tick();
  assert.deepEqual(h.transcripts.map((t) => t.text), ['limit words']);
});

/* ------------------------------------------------------------------ read aloud */

test('read aloud: speakable text, real speaking state, and a stop that ends playback without an error', async () => {
  const playing = deferred();
  const f = fixture({ backend: { speak: async (text) => { f.calls.push(['speak', text]); return playing.p; } } });
  const result = f.s.speak('## Plan\n- **Book** the [venue](https://example.com/v)\n```js\nx()\n```\nCall `Ana`.', { key: 'msg-7' });
  await tick();
  assert.equal(f.s.getSnapshot().phase, 'speaking');
  assert.deepEqual({ ...f.s.getSnapshot().speaking, chars: 0 }, { key: 'msg-7', chars: 0, truncated: false, stoppable: true });
  assert.equal(f.calls[0][1], 'Plan\nBook the venue\n(code block not read aloud)\nCall Ana.');
  await f.s.stopSpeaking();
  assert.equal(f.s.getSnapshot().phase, 'idle');
  assert.deepEqual(f.calls.at(-1), ['stopSpeaking']);
  playing.resolve({ ok: false, reason: 'Speech was stopped' });
  assert.equal(await result, 'stopped');
  assert.equal(f.s.getSnapshot().note, null, 'a stop the person asked for is not an error');
});

test('read aloud is refused with the reason when unavailable or while recording; long text is cut at a sentence', async () => {
  const off = fixture({ caps: { stt: { available: true }, tts: { available: false, reason: 'No Windows voices are installed' } } });
  assert.equal(await off.s.speak('hello'), 'blocked');
  assert.equal(off.s.getSnapshot().note.text, 'No Windows voices are installed');
  assert.equal(off.calls.length, 0);
  const f = fixture();
  await f.s.startListening();
  assert.equal(await f.s.speak('hello'), 'blocked');
  assert.equal(f.s.getSnapshot().note.code, 'speak-busy');
  assert.equal(f.s.getSnapshot().phase, 'listening', 'the recording continues');
  const long = m.clipForSpeech('One sentence here. '.repeat(200), 100);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 100 && long.text.endsWith('.'));
  assert.deepEqual(m.clipForSpeech('short', 100), { text: 'short', truncated: false });
});

test('a stop from elsewhere and a failure are reported; newer speech supersedes older speech silently', async () => {
  const f = fixture({ backend: { speak: async () => ({ ok: false, reason: 'Speech was stopped' }) } });
  assert.equal(await f.s.speak('hello'), 'stopped');
  assert.equal(f.s.getSnapshot().note.code, 'speak-stopped');
  const g = fixture({ backend: { speak: async () => ({ ok: false, reason: 'Selected voice "X" is not installed' }) } });
  assert.equal(await g.s.speak('hello'), 'failed');
  assert.equal(g.s.getSnapshot().note.text, 'Selected voice "X" is not installed');
  const first = deferred();
  let n = 0;
  const h = fixture({ backend: { speak: async () => (++n === 1 ? first.p : { ok: true }) } });
  const a = h.s.speak('first', { key: 'a' });
  await tick();
  const b = h.s.speak('second', { key: 'b' });
  first.resolve({ ok: false, reason: 'Superseded by newer speech' });
  assert.equal(await a, 'stopped');
  assert.equal(await b, 'spoken');
  assert.equal(h.s.getSnapshot().note, null);
  const noStop = fixture({ backend: { stopSpeaking: undefined, speak: () => new Promise(() => {}) } });
  void noStop.s.speak('x');
  await tick();
  assert.equal(noStop.s.getSnapshot().speaking.stoppable, false, 'the UI is told Stop is not possible');
});

test('pressing Talk while reading aloud stops the voice first, so the microphone does not record it', async () => {
  const f = fixture({ backend: { speak: () => new Promise(() => {}) } });
  void f.s.speak('a long answer');
  await tick();
  await f.s.startListening();
  assert.deepEqual(f.calls.map((c) => c[0]), ['stopSpeaking']);
  assert.equal(f.s.getSnapshot().phase, 'listening');
});

test('release (leaving the page, closing the bubble) stops everything quietly and the session stays usable', async () => {
  const gate = deferred();
  const f = fixture({ backend: { transcribe: async () => { await gate.p; return { text: 'too late' }; } } });
  await f.s.startListening();
  const stopping = f.s.stopListening();
  await tick();
  f.s.release();
  assert.deepEqual(f.calls.map((c) => c[0]), ['cancelTranscribe']);
  assert.equal(f.s.getSnapshot().phase, 'idle');
  assert.equal(f.s.getSnapshot().note, null);
  gate.resolve();
  await stopping;
  assert.equal(f.transcripts.length, 0, 'a result arriving after release is dropped');

  const g = fixture({ backend: { speak: () => new Promise(() => {}) } });
  void g.s.speak('hello');
  await tick();
  g.s.release();
  assert.deepEqual(g.calls.map((c) => c[0]), ['stopSpeaking'], 'read-aloud stops on release');
  const h = fixture();
  await h.s.startListening();
  h.s.release();
  assert.equal(h.recs[0].cancelled, true, 'the microphone closes on release');
  await h.s.startListening();
  assert.equal(h.s.getSnapshot().phase, 'listening', 'usable again (React may remount the same owner)');
});

/* ------------------------------------------------------------------ hub bridge and IPC */

test('hub backend maps only what the bridge has', async () => {
  assert.equal(m.hubVoiceBackend({}), null);
  const calls = [];
  const full = m.hubVoiceBackend({ speak: async (t) => (calls.push(['speak', t]), { ok: true }), transcribe: async (w) => (calls.push(['transcribe', w.length]), { text: 'x' }), speechStop: async () => (calls.push(['speechStop']), true), transcribeCancel: async () => (calls.push(['transcribeCancel']), false) });
  await full.speak('hi'); await full.transcribe([1, 2]); await full.stopSpeaking(); await full.cancelTranscribe();
  assert.deepEqual(calls, [['speak', 'hi'], ['transcribe', 2], ['speechStop'], ['transcribeCancel']]);
  const old = m.hubVoiceBackend({ transcribe: async () => ({ text: 'x' }) });
  assert.equal(old.stopSpeaking, undefined);
  assert.equal(old.cancelTranscribe, undefined);
  assert.deepEqual(await old.speak('hi'), { ok: false, reason: 'Read aloud is not available in this window.' });
});

test('speechStop and transcribeCancel are hub methods with no arguments, exposed by the preload', async () => {
  for (const name of ['speechStop', 'transcribeCancel']) {
    assert.ok(m.channels.METHODS.includes(name));
    assert.equal(m.channels.ARITY[name], 0);
    assert.deepEqual(m.ipcCore.ARG_SPECS[name], []);
    assert.equal(m.ipcCore.validateArgs(name, ['x']), 'Wrong number of arguments');
  }
  const preload = readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf8');
  assert.match(preload, /speechStop: \(\) => call\('speechStop'\)/);
  assert.match(preload, /transcribeCancel: \(\) => call\('transcribeCancel'\)/);
});

test('the real backend: speechStop ends the speech in flight and reports whether anything was playing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'desktop-companion-test-voice-'));
  const spoken = [];
  const b = await m.createBackend({
    userData: dir, nativeDir: dir, tmpDir: dir, selfPids: () => [999],
    safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('no'); }, decryptString: () => { throw new Error('no'); } },
    native: {
      listWindows: async () => [], dpapi: async () => ({ ok: true }),
      probeSpeech: async () => ({ voices: ['Voice A'], recognizers: ['en-US'] }),
      speak: (text, voice, signal) => new Promise((resolve) => { spoken.push(text); signal?.addEventListener('abort', () => resolve({ ok: true }), { once: true }); }),
    },
    shell: { spawnApp: async () => {}, openPath: async () => '', openExternal: async () => {} },
    dialogs: { openImport: async () => null, pick: async () => null, saveExport: async () => null },
    confirm: async () => false,
    fetchImpl: async () => { throw new Error('no network in this test'); },
  });
  try {
    assert.equal(await b.speechStop(), false, 'nothing playing yet');
    const playing = b.speak('read this aloud');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(spoken, ['read this aloud']);
    assert.equal(await b.speechStop(), true);
    assert.deepEqual(await playing, { ok: false, reason: 'Speech was stopped' });
    assert.equal(await b.transcribeCancel(), false, 'no transcription to cancel');
  } finally {
    await b.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
