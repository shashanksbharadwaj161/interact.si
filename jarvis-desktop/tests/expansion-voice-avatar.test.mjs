// Expansion: the real recorder level feeds the shared companion amplitude and the Avatar Studio host meter
// only during an explicit, user-initiated recording. Covers in-app consent, track cleanup, cancellation,
// time/size bounds, disabled states and the "simulated" label when no source is attached.
// Everything runs against fake browser APIs and server-side rendering: no microphone, audio playback,
// network, Electron or desktop input is ever touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = ['ArrowClockwise', 'CaretLeft', 'Broom', 'ChatCircleDots', 'Lightning', 'MagnifyingGlass', 'Microphone', 'PaperPlaneRight', 'ShieldCheck', 'SpeakerHigh', 'Stop',
  'ArrowCounterClockwise', 'Copy', 'DownloadSimple', 'FloppyDisk', 'Pause', 'Play', 'Plus', 'Trash', 'UploadSimple', 'Info', 'Warning', 'WarningCircle',
  'Check', 'CaretDown', 'X', 'CircleNotch', 'MagnifyingGlassPlus', 'Eye', 'EyeSlash', 'CaretRight', 'ArrowSquareOut', 'Question'];

/** A fake store so the Assistant renders without the Electron bridge. Capability flags are injectable. */
const STORE_STUB = `
  export let fake = globalThis.__fakeStore;
  export function useReady() { return globalThis.__fakeStore(); }
  export function useOptionalStore() { return null; }
  export function useStore() { return globalThis.__fakeStore(); }
`;

const out = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'expansion-voice-avatar-entry.tsx',
    loader: 'tsx',
    contents: `
      export * as audio from './src/ui/audio.ts';
      export * as companion from './src/ui/companion.tsx';
      export { AvatarStudio } from './src/components/AvatarStudio.tsx';
      export { Assistant } from './src/components/Assistant.tsx';
      export { createElement, useEffect } from 'react';
      export { renderToStaticMarkup } from 'react-dom/server';
    `,
  },
  bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
  loader: { '.css': 'empty' },
  banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(pathToFileURL(path.join(root, 'package.json')).href)});` },
  plugins: [{
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^@phosphor-icons\/react$/ }, () => ({ path: 'icons', namespace: 'stub' }));
      b.onResolve({ filter: /\/ui\/store$/ }, () => ({ path: 'store', namespace: 'stub' }));
      b.onLoad({ filter: /^icons$/, namespace: 'stub' }, () => ({ contents: ICONS.map((n) => `export const ${n} = () => null;`).join('\n'), loader: 'js' }));
      b.onLoad({ filter: /^store$/, namespace: 'stub' }, () => ({ contents: STORE_STUB, loader: 'js' }));
    },
  }],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
const { audio, companion, AvatarStudio, Assistant, createElement: h, useEffect, renderToStaticMarkup } = mod;
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------ fake browser ------------------------------ */

function installBrowser({ sample = 128, getUserMedia, decodeAudioData } = {}) {
  const state = { getUserMediaCalls: 0, streams: [], recorders: [], frames: [], contexts: [], sample };
  const clock = { now: 1000 };
  const timers = new Map();
  let nextTimer = 1;
  const makeStream = () => {
    const track = { kind: 'audio', stopped: false, onended: null, stop() { this.stopped = true; } };
    const s = { track, getTracks: () => [track], getAudioTracks: () => [track] };
    state.streams.push(s);
    return s;
  };
  class FakeRecorder {
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.mimeType = 'audio/webm'; this.ondataavailable = null; this.onstop = null; state.recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }
  class FakeCtx {
    constructor() { this.closed = false; state.contexts.push(this); }
    createAnalyser() { return { fftSize: 512, getByteTimeDomainData: (buf) => buf.fill(state.sample) }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; return Promise.resolve(); }
    decodeAudioData() { return decodeAudioData ? decodeAudioData() : Promise.resolve({ duration: 1 }); }
  }
  class FakeOffline {
    constructor(_c, frames) { this.frames = frames; this.destination = {}; }
    createBufferSource() { return { connect() {}, start() {} }; }
    startRendering() { const a = new Float32Array(this.frames).fill(0.5); return Promise.resolve({ getChannelData: () => a }); }
  }
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  const saved = {};
  const keys = ['navigator', 'MediaRecorder', 'AudioContext', 'OfflineAudioContext', 'window', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'];
  for (const k of keys) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  set('navigator', { mediaDevices: { getUserMedia: getUserMedia ?? (async () => { state.getUserMediaCalls++; return makeStream(); }) } });
  set('MediaRecorder', FakeRecorder);
  set('AudioContext', FakeCtx);
  set('OfflineAudioContext', FakeOffline);
  set('requestAnimationFrame', (fn) => { state.frames.push(fn); return state.frames.length; });
  set('cancelAnimationFrame', (id) => { state.frames[id - 1] = null; });
  set('performance', { now: () => clock.now });
  set('window', {
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, at: clock.now + ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  return {
    state, clock,
    /** Runs the pending animation frame once (the analyser tick). */
    frame() { const fn = state.frames.pop(); state.frames.length = 0; if (fn) fn(); },
    advance(ms) { clock.now += ms; for (const [id, t] of [...timers]) if (t.at <= clock.now) { timers.delete(id); t.fn(); } },
    pendingTimers: () => timers.size,
    restore() { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } },
  };
}
async function withBrowser(opts, fn) {
  const env = installBrowser(opts);
  try { await fn(env); } finally { env.restore(); }
}

/* ------------------------------ recorder level lifecycle ------------------------------ */

test('bindLevel forwards the real analyser level only while the recorder is the live one, and clamps it', async () => {
  await withBrowser({ sample: 160 }, async (env) => {
    const consent = audio.createMicConsent();
    consent.grant();
    const rec = new audio.ClipRecorder({ consent });
    let owner = rec;
    const seen = [];
    audio.bindLevel(rec, () => owner, (l) => seen.push(l));
    await rec.start();
    assert.equal(rec.state, 'recording');
    assert.ok(seen.length >= 1 && seen[0] > 0 && seen[0] <= 1, `first analyser tick produced a level (${seen[0]})`);
    const expected = Math.min(1, Math.sqrt(((160 - 128) / 128) ** 2) * 4);
    assert.ok(Math.abs(seen[0] - expected) < 1e-9, 'level is the RMS of the time-domain data, scaled and clamped');
    env.frame();
    assert.equal(seen.length, 2, 'each animation frame forwards one level');
    owner = null; // the view dropped this recorder (cancel/replace): a late frame must not move the avatar
    env.frame();
    assert.equal(seen.length, 2, 'levels from a recorder the view no longer owns are dropped');
    rec.cancel();
    assert.equal(env.state.streams[0].track.stopped, true, 'cancel releases the track');
  });
  // Clamping of hostile values is independent of the browser fakes.
  const r2 = new audio.ClipRecorder();
  const got = [];
  audio.bindLevel(r2, () => r2, (l) => got.push(l));
  r2.onLevel(2); r2.onLevel(-1); r2.onLevel(Number.NaN); r2.onLevel(0.25);
  assert.deepEqual(got, [1, 0, 0, 0.25]);
});

test('without in-app consent the microphone is never opened; revoking consent is honoured on the next start', async () => {
  await withBrowser({}, async (env) => {
    const consent = audio.createMicConsent();
    const rec = new audio.ClipRecorder({ consent });
    const levels = [];
    audio.bindLevel(rec, () => rec, (l) => levels.push(l));
    await assert.rejects(rec.start(), audio.MicConsentError);
    assert.equal(env.state.getUserMediaCalls, 0, 'getUserMedia was not called');
    assert.equal(levels.length, 0, 'no level was reported');
    assert.equal(rec.state, 'idle');
    consent.grant();
    await rec.start();
    assert.equal(env.state.getUserMediaCalls, 1);
    rec.cancel();
    consent.revoke();
    await assert.rejects(rec.start(), audio.MicConsentError);
    assert.equal(env.state.getUserMediaCalls, 1, 'revoked consent blocks the next start');
  });
});

test('cancel during the permission prompt discards the stream, stops its track and reports a zero level', async () => {
  let resolveStream;
  await withBrowser({ getUserMedia: () => new Promise((r) => { resolveStream = r; }) }, async (env) => {
    const rec = new audio.ClipRecorder();
    const levels = [];
    audio.bindLevel(rec, () => rec, (l) => levels.push(l));
    const p = rec.start();
    await tick();
    assert.equal(rec.state, 'starting');
    rec.cancel();
    assert.equal(rec.state, 'idle');
    const track = { kind: 'audio', stopped: false, onended: null, stop() { this.stopped = true; } };
    resolveStream({ getTracks: () => [track], getAudioTracks: () => [track] });
    await assert.rejects(p, audio.RecordingCancelled);
    assert.equal(track.stopped, true, 'the late stream is released immediately');
    assert.deepEqual(levels, [0], 'cancel reports level 0 and nothing else');
    assert.equal(env.state.frames.filter(Boolean).length, 0, 'no analyser frame is left scheduled');
  });
});

test('the time limit halts capture on its own, the size cap halts it too, and both release the track and audio context', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    let limitCalls = 0;
    rec.onLimit = () => { limitCalls++; };
    await rec.start();
    env.advance(audio.MAX_CLIP_MS);
    assert.equal(limitCalls, 1, 'the owner is told at the limit');
    assert.equal(env.state.streams[0].track.stopped, false, 'a short grace period lets the owner stop cleanly');
    env.advance(audio.LIMIT_GRACE_MS);
    assert.equal(env.state.streams[0].track.stopped, true, 'after the grace period the recorder halts itself');
    assert.equal(env.state.recorders[0].state, 'inactive');
    rec.cancel();
    assert.equal(env.pendingTimers(), 0, 'no timer survives cancel');

    const big = new audio.ClipRecorder();
    await big.start();
    const r = env.state.recorders[1];
    r.ondataavailable({ data: { size: audio.MAX_RECORDED_BYTES + 1 } });
    assert.equal(env.state.streams[1].track.stopped, true, 'exceeding the byte cap stops the microphone');
    assert.equal(r.state, 'inactive');
    big.cancel();
    assert.equal(big.state, 'idle');
  });
});

test('a vanished input device halts capture and notifies the owner once', async () => {
  await withBrowser({}, async (env) => {
    const rec = new audio.ClipRecorder();
    let lost = 0;
    rec.onDeviceLost = () => { lost++; };
    await rec.start();
    const track = env.state.streams[0].track;
    track.onended();
    track.onended();
    assert.equal(lost, 1);
    assert.equal(track.stopped, true);
    assert.equal(env.state.recorders[0].state, 'inactive');
    rec.cancel();
    assert.equal(track.onended, null, 'release detaches the handler');
  });
});

test('remainingMs and defaultConsentStorage are bounded and SSR-safe', () => {
  assert.equal(audio.remainingMs(0), audio.MAX_CLIP_MS);
  assert.equal(audio.remainingMs(audio.MAX_CLIP_MS + 5000), 0, 'never negative');
  assert.equal(audio.remainingMs(-10), audio.MAX_CLIP_MS);
  assert.equal(audio.remainingMs(Number.NaN), audio.MAX_CLIP_MS);
  assert.equal(audio.defaultConsentStorage(), null, 'no window: consent stays in memory');
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { get localStorage() { throw new Error('blocked'); } }, configurable: true, writable: true });
  try {
    assert.equal(audio.defaultConsentStorage(), null, 'blocked storage is tolerated');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'window', saved); else delete globalThis.window;
  }
});

test('capture halt closes the analyser and late frames cannot report stale amplitude; recorder can restart', async () => {
  await withBrowser({ sample: 160 }, async (env) => {
    const rec = new audio.ClipRecorder();
    const seen = [];
    rec.onLevel = (l) => seen.push(l);
    await rec.start();
    const lateFrame = env.state.frames.find(Boolean);
    env.advance(audio.MAX_CLIP_MS);
    env.advance(audio.LIMIT_GRACE_MS);
    assert.equal(env.state.contexts[0].closed, true);
    assert.equal(seen.at(-1), 0);
    const count = seen.length;
    lateFrame();
    assert.equal(seen.length, count);
    rec.cancel();
    await rec.start();
    assert.ok(seen.at(-1) > 0, 'restarting creates a new live analyser');
    rec.cancel();
  });
});

test('cancellation during audio decoding rejects the stale clip instead of returning it', async () => {
  let finishDecode;
  await withBrowser({ decodeAudioData: () => new Promise((resolve) => { finishDecode = resolve; }) }, async (env) => {
    const rec = new audio.ClipRecorder();
    await rec.start();
    env.state.recorders[0].ondataavailable({ data: new Blob(['fixture audio']) });
    env.advance(500);
    const pending = rec.stop();
    const rejected = assert.rejects(pending, audio.RecordingCancelled);
    await tick();
    assert.equal(typeof finishDecode, 'function');
    rec.cancel();
    finishDecode({ duration: 1 });
    await rejected;
    assert.ok(env.state.contexts.every((c) => c.closed));
  });
});

/* ------------------------------ companion context ------------------------------ */

test('hostVoiceLevel attaches a quiet microphone as 0 and detaches to null; quantizeLevel is bounded', () => {
  const { hostVoiceLevel, quantizeLevel } = companion;
  assert.equal(hostVoiceLevel({ level: 0, source: 'none' }), null, 'no source: the avatar falls back to its labelled simulation');
  assert.equal(hostVoiceLevel({ level: 0.4, source: 'none' }), null, 'a stale level without a source is ignored');
  assert.equal(hostVoiceLevel({ level: 0, source: 'microphone' }), 0, 'a silent open microphone still counts as attached');
  assert.equal(hostVoiceLevel({ level: 0.42, source: 'microphone' }), 0.4);
  assert.equal(quantizeLevel(0.123), 0.1);
  assert.equal(quantizeLevel(7), 1);
  assert.equal(quantizeLevel(-1), 0);
  assert.equal(quantizeLevel(Number.NaN), 0);
});

test('CompanionProvider starts idle with no source, and setSource("none") resets the level', () => {
  let got;
  function Probe() { got = companion.useCompanion(); return null; }
  renderToStaticMarkup(h(companion.CompanionProvider, null, h(Probe)));
  assert.equal(got.state, 'idle');
  assert.equal(got.level, 0);
  assert.equal(got.source, 'none', 'nothing attaches a source on load');
  assert.equal(companion.hostVoiceLevel(got), null);
  for (const k of ['set', 'setLevel', 'setSource']) assert.equal(typeof got[k], 'function', k);
  assert.throws(() => renderToStaticMarkup(h(Probe)), /outside provider/);
});

/* ------------------------------ Avatar Studio host amplitude ------------------------------ */

const studio = (props) => renderToStaticMarkup(h(AvatarStudio, { reducedMotion: false, ...props }));

test('with no source the studio labels the slider as a simulation and never claims a microphone', () => {
  const html = studio({ voiceLevel: null });
  assert.match(html, /No audio source is attached, so the slider below only simulates a level/);
  assert.match(html, /Simulated level \(preview only\)/);
  assert.doesNotMatch(html, /Host voice|Assistant microphone voice/);
  assert.doesNotMatch(html, /<meter/, 'no amplitude meter without a source');
  assert.match(html, /never opens the microphone/);
  assert.doesNotMatch(html, /<input[^>]*type="range"[^>]*disabled/, 'the simulation slider is usable');
});

test('an attached host amplitude disables the simulation and is labelled by its source even while quiet', () => {
  const quiet = studio({ voiceLevel: 0, voiceSourceLabel: 'Assistant microphone' });
  assert.match(quiet, /Assistant microphone voice · quiet/, 'quiet microphone still shows as attached');
  assert.match(quiet, /Assistant microphone amplitude/);
  assert.match(quiet, /<meter[^>]*value="0"/);
  assert.match(quiet, /Disabled while a host amplitude is attached/);
  assert.doesNotMatch(quiet, /No audio source is attached/);
  assert.doesNotMatch(quiet, /Simulated voice/);

  const loud = studio({ voiceLevel: 0.6 });
  assert.match(loud, /Host voice<\/span>/, 'default label');
  assert.match(loud, /<meter[^>]*value="0.6"/);
  assert.match(loud, /60%/);
  assert.match(loud, /Voice: Host amplitude attached/);

  const hostile = studio({ voiceLevel: 9 });
  assert.match(hostile, /<meter[^>]*value="1"/, 'clamped to 1');
});

test('reduced motion keeps the still notice and still applies the injected level without animating', () => {
  const html = studio({ voiceLevel: 0.3, reducedMotion: true });
  assert.match(html, /Reduced motion is on/);
  assert.match(html, /Reduced motion: timelines hold their nearest keyframe/);
  assert.match(html, /Voice: Host amplitude attached/);
  assert.match(html, /<meter[^>]*value="0.3"/);
  assert.match(html, />Still</);
});

/* ------------------------------ Assistant push-to-talk ------------------------------ */

function fakeStore({ stt = true, consentStored = false } = {}) {
  const cap = (id, available, reason) => ({ id, available, reason });
  const data = new Map(consentStored ? [['desktop-companion.mic-consent.v1', '1']] : []);
  const localStorage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  globalThis.__fakeStore = () => ({
    api: { getApiInfo: async () => ({ features: [] }), transcribe: async () => { throw new Error('must not run'); } },
    state: { chat: [] },
    settings: { mode: 'offline', localModel: 'm', localEndpoint: 'http://127.0.0.1:1', voice: '' },
    cloudConfigured: false, run: async () => undefined, toast: () => undefined, reload: async () => undefined,
    system: { capabilities: [cap('local-llm', true), cap('tts', false, 'Not checked'), cap('stt', stt, stt ? undefined : 'Windows speech is unavailable here'), cap('intent-planner', true)] },
    systemLoading: false, systemError: null, refreshSystem: async () => undefined,
  });
  return { localStorage, data };
}

function withWindow(extra, fn) {
  const saved = { window: Object.getOwnPropertyDescriptor(globalThis, 'window'), navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  Object.defineProperty(globalThis, 'window', { value: { localStorage: extra.localStorage, addEventListener() {}, removeEventListener() {} }, configurable: true, writable: true });
  if ('navigator' in extra) Object.defineProperty(globalThis, 'navigator', { value: extra.navigator, configurable: true, writable: true });
  try { return fn(); } finally {
    for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
  }
}
const renderAssistant = () => renderToStaticMarkup(h(companion.CompanionProvider, null, h(Assistant)));
const micNavigator = { mediaDevices: { getUserMedia: () => { throw new Error('the microphone must never open on render'); } } };

test('on load the Assistant renders with consent off, the talk button disabled and no microphone access', () => {
  const { localStorage } = fakeStore({ stt: true });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  Object.defineProperty(globalThis, 'MediaRecorder', { value: class {}, configurable: true, writable: true });
  try {
    const html = withWindow({ localStorage, navigator: micNavigator }, renderAssistant);
    assert.match(html, /Allow the microphone in Desktop Companion/);
    assert.match(html, /Off: the talk button stays disabled and this window never opens the microphone/);
    assert.match(html, /<button[^>]*class="ptt"[^>]*disabled/, 'push-to-talk is disabled without in-app consent');
    assert.match(html, /Turn on &quot;Allow the microphone&quot; in the Push to talk panel first/);
    assert.doesNotMatch(html, /autoplay/i);
    assert.doesNotMatch(html, /Recording: \d+ s left/, 'no recording is in progress on load');
    assert.doesNotMatch(html, /Microphone unavailable/);
    assert.match(html, /aria-pressed="false"/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'MediaRecorder', saved); else delete globalThis.MediaRecorder;
  }
});

test('stored in-app consent enables the talk button, but a window without capture keeps it off with a reason', () => {
  const { localStorage } = fakeStore({ stt: true, consentStored: true });
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  Object.defineProperty(globalThis, 'MediaRecorder', { value: class {}, configurable: true, writable: true });
  try {
    const html = withWindow({ localStorage, navigator: micNavigator }, renderAssistant);
    assert.match(html, /On: the microphone opens only while you hold or tap the talk button/);
    assert.doesNotMatch(html, /<button[^>]*class="ptt"[^>]*disabled/, 'consent plus capability enables push-to-talk');
    assert.match(html, /Hold to record, or tap once to start/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'MediaRecorder', saved); else delete globalThis.MediaRecorder;
  }
  const noMic = withWindow({ localStorage, navigator: {} }, renderAssistant);
  assert.match(noMic, /Microphone unavailable/);
  assert.match(noMic, /This window cannot access a microphone/);
  assert.match(noMic, /<button[^>]*class="ptt"[^>]*disabled/);
  assert.match(noMic, /<input[^>]*type="checkbox"[^>]*disabled|<button[^>]*role="switch"[^>]*disabled/, 'the consent switch is disabled when capture is impossible');
});

test('speech recognition being unavailable disables the button regardless of consent', () => {
  const { localStorage } = fakeStore({ stt: false, consentStored: true });
  const html = withWindow({ localStorage, navigator: micNavigator }, renderAssistant);
  assert.match(html, /Speech recognition unavailable/);
  assert.match(html, /Windows speech is unavailable here/);
  assert.match(html, /<button[^>]*class="ptt"[^>]*disabled/);
});

