// Voice link slice: speech playback events drive avatar mouth/pose states. Pure model, utterance event
// wiring against a fake utterance, level meter fallback, rendered Avatar attributes and studio wiring.
// No real audio, speech, microphone, network or Electron is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(root, p), 'utf8');
async function load(rel) {
  const out = await build({ entryPoints: [path.join(root, rel)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
}
const voice = await load('src/ui/avatar-voice.ts');
const audio = await load('src/ui/audio.ts');
const { VOICE_LINK_LIMITS, MOUTH_THRESHOLDS, mouthFromAmplitude, mouthFromBoundary, createVoiceLink, transition } = voice;

test('voice link: frozen limits', () => {
  assert.ok(Object.isFrozen(VOICE_LINK_LIMITS));
  assert.deepEqual({ ...VOICE_LINK_LIMITS }, { sampleWindowMs: 50, minAmplitude: 0, maxAmplitude: 1, maxVisemes: 8 });
  assert.throws(() => { VOICE_LINK_LIMITS.maxVisemes = 99; });
});

test('mouthFromAmplitude: deterministic thresholds and reduced-motion collapse', () => {
  const T = MOUTH_THRESHOLDS;
  assert.equal(mouthFromAmplitude(0), 'closed');
  assert.equal(mouthFromAmplitude(T.narrow - 0.001), 'closed');
  assert.equal(mouthFromAmplitude(T.narrow), 'narrow');
  assert.equal(mouthFromAmplitude(T.open - 0.001), 'narrow');
  assert.equal(mouthFromAmplitude(T.open), 'open');
  assert.equal(mouthFromAmplitude(T.wide - 0.001), 'open');
  assert.equal(mouthFromAmplitude(T.wide), 'wide');
  assert.equal(mouthFromAmplitude(1), 'wide');
  const seen = new Set();
  for (let i = 0; i <= 100; i++) {
    const r = mouthFromAmplitude(i / 100, { reducedMotion: true });
    seen.add(r);
    assert.ok(r === 'closed' || r === 'open', `reduced motion only closed/open, got ${r}`);
  }
  assert.deepEqual([...seen].sort(), ['closed', 'open']);
  assert.equal(mouthFromAmplitude(0.01, { reducedMotion: true }), 'closed');
  assert.equal(mouthFromAmplitude(0.9, { reducedMotion: true }), 'open');
});

test('mouthFromAmplitude rejects out-of-range or non-numeric rms with descriptive errors', () => {
  for (const bad of [-0.01, 1.01, Number.NaN, Infinity, '0.5', null, undefined]) {
    assert.throws(() => mouthFromAmplitude(bad), /rms must be a finite number from 0 to 1/);
  }
});

test('mouthFromBoundary maps the current word dominant vowel', () => {
  const text = 'cat see boot rhythm  ...';
  assert.equal(mouthFromBoundary(0, text), 'open', 'a opens');
  assert.equal(mouthFromBoundary(1, text), 'open', 'mid-word index uses the whole word');
  assert.equal(mouthFromBoundary(4, text), 'wide', 'e spreads wide');
  assert.equal(mouthFromBoundary(8, text), 'narrow', 'o rounds narrow');
  assert.equal(mouthFromBoundary(13, text), 'wide', 'y counts as a spread vowel');
  assert.equal(mouthFromBoundary(3, text), 'wide', 'a space index looks ahead to the next word');
  assert.equal(mouthFromBoundary(20, text), 'closed', 'no word after the index');
  assert.equal(mouthFromBoundary(999, text), 'closed', 'past the end');
  assert.equal(mouthFromBoundary(0, 'hmm'), 'narrow', 'no vowels: narrow');
  assert.equal(mouthFromBoundary(0, 'banana'), 'open');
  assert.equal(mouthFromBoundary(0, 'Über'), 'narrow', 'diacritics are stripped (u, e tie: first wins)');
  assert.equal(mouthFromBoundary(0, 'café'), 'open', 'a and e tie: first wins');
  assert.equal(mouthFromBoundary(0, 'see', { reducedMotion: true }), 'open', 'reduced motion collapses wide to open');
  assert.equal(mouthFromBoundary(0, 'boot', { reducedMotion: true }), 'open');
  assert.throws(() => mouthFromBoundary(-1, text), /charIndex must be a non-negative integer/);
  assert.throws(() => mouthFromBoundary(1.5, text), /charIndex/);
  assert.throws(() => mouthFromBoundary(0, 42), /text must be a string/);
});

test('link transitions start -> boundary/level -> end, frozen and pure', () => {
  const l0 = createVoiceLink({ reducedMotion: false, now: 10 });
  assert.ok(Object.isFrozen(l0));
  assert.deepEqual({ mouth: l0.mouth, pose: l0.pose, speaking: l0.speaking, lastEventAt: l0.lastEventAt }, { mouth: 'closed', pose: 'idle', speaking: false, lastEventAt: 10 });
  const snapshot = JSON.stringify(l0);
  const l1 = transition(l0, { type: 'start', at: 20 });
  assert.ok(Object.isFrozen(l1));
  assert.equal(JSON.stringify(l0), snapshot, 'input not mutated');
  assert.deepEqual([l1.mouth, l1.pose, l1.speaking, l1.lastEventAt], ['closed', 'speaking', true, 20]);
  const l2 = transition(l1, { type: 'level', rms: 0.5, at: 30 });
  assert.deepEqual([l2.mouth, l2.pose, l2.lastEventAt], ['wide', 'speaking', 30]);
  const l3 = transition(l2, { type: 'boundary', charIndex: 0, text: 'boot', at: 40 });
  assert.equal(l3.mouth, 'narrow');
  const l4 = transition(l3, { type: 'level', rms: 0.2 });
  assert.equal(l4.mouth, 'open');
  assert.equal(l4.lastEventAt, 40, 'missing at keeps the previous timestamp');
  const end = transition(l4, { type: 'end', at: 50 });
  assert.deepEqual([end.mouth, end.pose, end.speaking, end.lastEventAt], ['closed', 'idle', false, 50]);
  // Late events after end cannot reopen the mouth.
  assert.equal(transition(end, { type: 'level', rms: 0.9 }), end);
  assert.equal(transition(end, { type: 'boundary', charIndex: 0, text: 'cat' }), end);
  // Determinism: replaying the same events gives the same states.
  const replay = (rm) => [{ type: 'start', at: 1 }, { type: 'level', rms: 0.3, at: 2 }, { type: 'boundary', charIndex: 4, text: 'cat see', at: 3 }, { type: 'pause', at: 4 }, { type: 'resume', at: 5 }, { type: 'end', at: 6 }]
    .reduce((acc, e) => [...acc, transition(acc.at(-1), e)], [createVoiceLink({ reducedMotion: rm, now: 0 })]);
  assert.deepEqual(JSON.stringify(replay(false)), JSON.stringify(replay(false)));
  assert.ok(replay(true).every((l) => l.mouth === 'closed' || l.mouth === 'open'));
});

test('pause/resume, cancel and error reset; out-of-range events are rejected', () => {
  let l = transition(createVoiceLink({ now: 0 }), { type: 'start' });
  l = transition(l, { type: 'level', rms: 0.4 });
  const paused = transition(l, { type: 'pause' });
  assert.deepEqual([paused.mouth, paused.pose, paused.speaking, paused.paused], ['closed', 'thinking', true, true]);
  assert.equal(transition(paused, { type: 'level', rms: 0.9 }), paused, 'levels ignored while paused');
  const resumed = transition(paused, { type: 'resume' });
  assert.deepEqual([resumed.pose, resumed.paused], ['speaking', false]);
  assert.equal(transition(resumed, { type: 'level', rms: 0.9 }).mouth, 'wide');
  for (const type of ['cancel', 'error', 'end']) {
    for (const from of [l, paused, resumed, createVoiceLink()]) {
      const r = transition(from, { type });
      assert.deepEqual([r.mouth, r.pose, r.speaking, r.paused], ['closed', 'idle', false, false], `${type} resets`);
    }
  }
  assert.equal(transition(createVoiceLink(), { type: 'resume' }).pose, 'idle', 'resume without speech is a no-op');
  assert.equal(transition(createVoiceLink(), { type: 'listen' }).pose, 'listening');
  assert.throws(() => transition(l, { type: 'level', rms: 2 }), /rms must be a finite number/);
  assert.throws(() => transition(l, { type: 'boundary', charIndex: -3, text: 'x' }), /charIndex must be a non-negative integer/);
  assert.throws(() => transition(l, { type: 'explode' }), /unknown event type "explode"/);
  assert.throws(() => transition(l, null), /event must be an object/);
});

test('avatar-voice.ts is DOM-free and timer-free', () => {
  const code = src('src/ui/avatar-voice.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/\b(window|document|navigator|setTimeout|setInterval|requestAnimationFrame|Date\.now|Math\.random|fetch|import\s)/.test(code), false);
});

function fakeUtterance(text) {
  const listeners = new Map();
  return {
    text,
    voice: null,
    addEventListener(t, fn) { if (!listeners.has(t)) listeners.set(t, new Set()); listeners.get(t).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    emit(t, e = {}) { for (const fn of [...(listeners.get(t) ?? [])]) fn(e); },
    count() { let n = 0; for (const s of listeners.values()) n += s.size; return n; },
  };
}

test('attachUtteranceEvents dispatches mapped events and dispose removes listeners', () => {
  const u = fakeUtterance('cat see boot');
  const got = [];
  let clock = 100;
  const att = audio.attachUtteranceEvents(u, (e) => got.push(e), { now: () => clock++ });
  assert.equal(att.available, true);
  assert.equal(u.count(), 6, 'start, boundary, pause, resume, end, error');
  u.emit('start');
  u.emit('boundary', { name: 'word', charIndex: 4 });
  u.emit('boundary', { name: 'sentence', charIndex: 0 });
  u.emit('boundary', { name: 'word', charIndex: -1 });
  u.emit('pause');
  u.emit('resume');
  u.emit('end');
  u.emit('error', { error: 'interrupted' });
  u.emit('error', { error: 'synthesis-failed' });
  assert.deepEqual(got, [
    { type: 'start', at: 100 },
    { type: 'boundary', charIndex: 4, text: 'cat see boot', at: 101 },
    { type: 'pause', at: 102 },
    { type: 'resume', at: 103 },
    { type: 'end', at: 104 },
    { type: 'cancel', at: 105 },
    { type: 'error', error: 'synthesis-failed', at: 106 },
  ]);
  // Events feed the pure link end to end.
  let link = createVoiceLink({ now: 0 });
  for (const e of got.slice(0, 2)) link = transition(link, e);
  assert.deepEqual([link.mouth, link.pose], ['wide', 'speaking']);
  att.dispose();
  att.dispose();
  assert.equal(u.count(), 0, 'all listeners removed');
  u.emit('start');
  assert.equal(got.length, 7, 'nothing after dispose');
  const none = audio.attachUtteranceEvents(null, () => assert.fail('never called'));
  assert.equal(none.available, false);
  assert.doesNotThrow(() => none.dispose());
  assert.equal(audio.attachUtteranceEvents({}, () => {}).available, false);
});

test('attachLevelMeter is a no-op when AnalyserNode is absent, and meters rms when present', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'AnalyserNode');
  delete globalThis.AnalyserNode;
  let connected = 0;
  const ctx = { createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData: (b) => b.fill(0.5), disconnect() {} }) };
  const srcNode = { connect: () => { connected++; }, disconnect() {} };
  const r = audio.attachLevelMeter(ctx, srcNode, () => assert.fail('no level without an analyser'));
  assert.equal(r.available, false);
  assert.equal(connected, 0, 'nothing connected');
  assert.doesNotThrow(() => r.dispose());
  assert.equal(audio.attachLevelMeter(null, null, () => {}).available, false);

  const savedSI = globalThis.setInterval;
  const savedCI = globalThis.clearInterval;
  const timers = new Map();
  let id = 0;
  globalThis.AnalyserNode = class {};
  globalThis.setInterval = (fn, ms) => { timers.set(++id, { fn, ms }); return id; };
  globalThis.clearInterval = (i) => timers.delete(i);
  try {
    let disconnected = 0;
    const levels = [];
    const live = audio.attachLevelMeter(ctx, { connect: () => { connected++; }, disconnect: () => { disconnected++; } }, (l) => levels.push(l), { intervalMs: 5 });
    assert.equal(live.available, true);
    assert.equal(connected, 1);
    const [[, t]] = [...timers];
    assert.equal(t.ms, 16, 'interval is clamped');
    t.fn();
    assert.ok(Math.abs(levels[0] - 0.5) < 1e-9, 'rms of constant 0.5 is 0.5');
    live.dispose();
    live.dispose();
    assert.equal(timers.size, 0, 'interval stopped');
    assert.equal(disconnected, 1);
    t.fn();
    assert.equal(levels.length, 1, 'no level after dispose');
    assert.equal(audio.levelFromTimeDomain(new Uint8Array([128, 128]), 'byte'), 0);
    assert.equal(audio.levelFromTimeDomain(new Uint8Array([255, 0]), 'byte') <= 1, true);
    assert.equal(audio.levelFromTimeDomain([]), 0);
  } finally {
    globalThis.setInterval = savedSI;
    globalThis.clearInterval = savedCI;
    if (had) Object.defineProperty(globalThis, 'AnalyserNode', had); else delete globalThis.AnalyserNode;
  }
});

test('speech support and local voice choice never pick a network voice', () => {
  assert.equal(audio.speechSynthesisSupport({}).available, false);
  assert.equal(audio.speechSynthesisSupport().available, false, 'no window in node');
  const ok = audio.speechSynthesisSupport({ speechSynthesis: { speak() {}, cancel() {} }, SpeechSynthesisUtterance: function U() {} });
  assert.equal(ok.available, true);
  assert.deepEqual(audio.pickLocalVoice([]), { ok: true, voice: null });
  assert.deepEqual(audio.pickLocalVoice([{ localService: false, lang: 'en-US' }]), { ok: false, voice: null });
  const local = { localService: true, lang: 'en-GB' };
  assert.equal(audio.pickLocalVoice([{ localService: false, lang: 'en-US', default: true }, local]).voice, local);
});

const ui = await (async () => {
  const out = await build({
    stdin: {
      contents: `import { createElement } from 'react'; import { renderToStaticMarkup } from 'react-dom/server'; import { Avatar } from './src/components/Avatar.tsx'; import { AvatarStudio } from './src/components/AvatarStudio.tsx'; export const avatar = (p) => renderToStaticMarkup(createElement(Avatar, p)); export const studio = (p) => renderToStaticMarkup(createElement(AvatarStudio, p));`,
      resolveDir: root,
      loader: 'js',
    },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', logLevel: 'silent',
    banner: { js: `import { createRequire as __cr } from 'node:module'; const require = __cr(${JSON.stringify(root + '/')});` },
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
})();

test('Avatar renders data-mouth/data-pose with defaults and classes on the mouth and head layers', () => {
  const plain = ui.avatar({});
  assert.match(plain, /data-mouth="closed"/);
  assert.match(plain, /data-pose="idle"/);
  assert.doesNotMatch(plain, /data-voice-link/);
  const linked = ui.avatar({ mouth: 'wide', pose: 'speaking' });
  assert.match(linked, /data-mouth="wide"/);
  assert.match(linked, /data-pose="speaking"/);
  assert.match(linked, /data-voice-link="on"/);
  assert.match(linked, /class="av-mouth av-mouth-wide"/);
  assert.match(linked, /class="av-head av-pose-speaking"/);
  const hostile = ui.avatar({ mouth: 'scream', pose: '"><x' });
  assert.match(hostile, /data-mouth="closed"/);
  assert.match(hostile, /data-pose="idle"/);
  const s = src('src/components/Avatar.tsx');
  assert.match(s, /data-mouth=\{m\}/);
  assert.match(s, /data-pose=\{p\}/);
});

test('AvatarStudio renders the Voice link panel honestly without speech APIs and wires Speak/Stop', () => {
  const html = ui.studio({ reducedMotion: false });
  assert.match(html, /Voice link/);
  assert.match(html, /Voice link unavailable in this environment/);
  assert.match(html, /Speak test line/);
  assert.match(html, />Stop</);
  assert.match(html, /data-testid="voice-link-mouth">closed</);
  assert.match(html, /data-testid="voice-link-pose">idle</);
  assert.doesNotMatch(html, /undefined|NaN|\[object/);
  const code = src('src/components/AvatarStudio.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /import '\.\.\/styles\/avatar-voice\.css'/);
  assert.match(code, /onClick=\{speakTestLine\}/);
  assert.match(code, /onClick=\{stopSpeech\}/);
  assert.match(code, /attachUtteranceEvents\(utterance, onEvent/);
  assert.match(code, /support\.synth\.cancel\(\)/);
  assert.match(code, /stepVoiceLink\(l, \{ type: 'cancel'/);
  assert.match(code, /pickLocalVoice\(/, 'only on-device voices');
  assert.match(code, /mouth=\{voiceLink\.mouth\} pose=\{voiceLink\.pose\}/);
  assert.equal(/getUserMedia|AudioContext|MediaRecorder|\bfetch\(|https?:\/\//.test(code), false, 'no microphone, no network');
  const css = src('src/styles/avatar-voice.css');
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:root\[data-motion="reduced"\]/);
  assert.match(css, /\.av-mouth-wide/);
});
