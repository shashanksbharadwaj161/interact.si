// Local clip export (roadmap 140): spec validation, deterministic sampler, cancellation, capability probe and
// JSON round trip. The module is bundled in memory and exercised without any DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function load(file) {
  const o = await build({ entryPoints: [path.join(root, file)], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(o.outputFiles[0].text).toString('base64')}`);
}

const c = await load('src/ui/motion-clip.ts');
const presets = await load('src/ui/motion-presets.ts');
const clipSrc = await readFile(path.join(root, 'src/ui/motion-clip.ts'), 'utf8');

const halo = presets.LAB_PRESETS.find((p) => p.id === 'builtin:lab-halo').lab;
const settings = (over = {}) => ({ sceneId: 'aurora', presetId: 'builtin:lab-halo', durationMs: 2000, fps: 24, width: 640, height: 360, reducedMotion: false, lab: halo, ...over });
const immediate = () => Promise.resolve();

test('clip module stays offline: no network, IPC, storage, clock or React', () => {
  assert.doesNotMatch(clipSrc, /\bfetch\(|XMLHttpRequest|WebSocket|ipcRenderer|from ['"]electron|localStorage|https?:\/\//);
  assert.doesNotMatch(clipSrc, /Math\.random|Date\.now|performance\.now/);
  assert.doesNotMatch(clipSrc, /from ['"]react['"]/);
});

test('buildClipSpec produces a valid spec with keyframes sampled from the scene model', () => {
  const spec = c.buildClipSpec(settings());
  assert.equal(spec.version, 1);
  assert.equal(spec.type, 'motion-clip');
  assert.equal(c.clipTotalFrames(spec), 48);
  assert.deepEqual(spec.keyframes.map((k) => k.frame), [0, 12, 24, 36, 47]);
  assert.equal(spec.keyframes[0].layers.length, halo.scene.layers.length);
  assert.equal(spec.keyframes[1].timeMs, 500);
  for (const k of spec.keyframes) {
    assert.ok(k.layers.every((l) => l.phase >= 0 && l.phase < Math.PI * 2 + 1e-9));
    assert.ok(k.scene.glow >= 0 && k.scene.glow <= 1);
  }
  assert.notDeepEqual(spec.keyframes[0].scene, spec.keyframes[2].scene, 'backdrop moves over time');
  assert.equal(c.validateClipSettings(settings()), null);
});

test('validation rejects malformed specs, disallowed fps, durations over 60 s and unknown ids', () => {
  const good = JSON.parse(c.serializeClip(c.buildClipSpec(settings())));
  const bad = [
    ['{nope', /not valid JSON/],
    ['[]', /JSON object/],
    [JSON.stringify(null), /JSON object/],
    [{ ...good, type: 'motion-lab' }, /not a motion clip/],
    [{ ...good, version: 2 }, /Unsupported clip version/],
    [{ ...good, fps: 25 }, /Frame rate 25 is not allowed/],
    [{ ...good, fps: '30' }, /Frame rate/],
    [{ ...good, fps: 120 }, /Frame rate/],
    [{ ...good, durationMs: 60_001 }, /over 60 s/],
    [{ ...good, durationMs: 50 }, /at least/],
    [{ ...good, durationMs: 1000.5 }, /whole number/],
    [{ ...good, sceneId: 'mars' }, /Unknown scene id/],
    [{ ...good, sceneId: undefined }, /Unknown scene id/],
    [{ ...good, presetId: 'builtin:nope' }, /Unknown preset id/],
    [{ ...good, width: 4000 }, /Width/],
    [{ ...good, height: 10 }, /Height/],
    [{ ...good, reducedMotion: 'yes' }, /reducedMotion/],
    [{ ...good, lab: undefined }, /composition/],
    [{ ...good, lab: { ...good.lab, scene: { version: 1, layers: [{ kind: 'script' }] } } }, /Composition/],
    [{ ...good, keyframes: 'x' }, /Keyframes must be a list/],
    [{ ...good, keyframes: [] }, /no keyframes/],
    [{ ...good, keyframes: [{ ...good.keyframes[0], frame: 9999 }] }, /outside the clip/],
    [{ ...good, keyframes: [good.keyframes[1], good.keyframes[0]] }, /out of order/],
    [{ ...good, keyframes: [{ ...good.keyframes[0], scene: { driftX: 'a' } }] }, /scene values/],
    [{ ...good, keyframes: [{ ...good.keyframes[0], layers: [{ id: 'l-1', kind: 'cube' }] }] }, /malformed layer/],
    ['x'.repeat(c.MAX_CLIP_BYTES + 1), /larger than/],
  ];
  for (const [input, re] of bad) {
    const r = c.parseClip(input);
    assert.equal(r.ok, false, `${typeof input === 'string' ? input.slice(0, 20) : JSON.stringify(input).slice(0, 80)}`);
    assert.match(r.error, re);
  }
  assert.throws(() => c.buildClipSpec(settings({ fps: 15 })), /Frame rate/);
  assert.throws(() => c.buildClipSpec(settings({ durationMs: 90_000 })), /over 60 s/);
  assert.throws(() => c.buildClipSpec(settings({ sceneId: 'nowhere' })), /Unknown scene id/);
  for (const fps of [12, 24, 30, 60]) assert.equal(c.validateClipSettings(settings({ fps })), null, `fps ${fps}`);
  assert.equal(c.validateClipSettings(settings({ durationMs: 60_000 })), null, 'exactly 60 s is allowed');
});

test('sampler is deterministic and produces duration × fps frames at t = n / fps', async () => {
  for (const [fps, durationMs, expected] of [[12, 1000, 12], [24, 2500, 60], [30, 2000, 60], [60, 500, 30], [30, 100, 3]]) {
    const spec = c.buildClipSpec(settings({ fps, durationMs }));
    const progress = [];
    const a = await c.sampleClipFrames(spec, { yieldFn: immediate, batchSize: 7, onProgress: (p) => progress.push(p) });
    const b = await c.sampleClipFrames(spec, { yieldFn: immediate, batchSize: 50 });
    assert.equal(a.status, 'complete');
    assert.equal(a.total, expected, `${fps} fps × ${durationMs} ms`);
    assert.equal(a.frames.length, expected);
    assert.deepEqual(a.frames, b.frames, 'batch size does not change results');
    assert.deepEqual(a.frames.map((f) => f.frame), Array.from({ length: expected }, (_, i) => i));
    a.frames.forEach((f, n) => assert.ok(Math.abs(f.timeMs - (n * 1000) / fps) < 1e-3));
    // Progress is real: monotonic frame counts ending at the total, never a percentage guess.
    assert.deepEqual(progress.at(-1), { done: expected, total: expected });
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].done > progress[i - 1].done);
    // Random access equals the sequential run.
    const mid = Math.floor(expected / 2);
    assert.deepEqual(c.sampleFrame(spec, mid), a.frames[mid]);
  }
  const lab = c.buildClipSpec(settings({ fps: 30, durationMs: 1000 }));
  const labFrames = (await c.sampleClipFrames(lab, { yieldFn: immediate })).frames.map((f) => f.labFrame);
  assert.equal(labFrames[15], 15, 'clip fps 30 maps onto the 30 fps Lab timeline frame for frame');
  const slow = c.buildClipSpec(settings({ fps: 12, durationMs: 1000 }));
  assert.equal(c.sampleFrame(slow, 6).labFrame, 15, '12 fps frame 6 is half a second in');
});

test('cancellation stops mid-run and reports the frames actually done', async () => {
  const spec = c.buildClipSpec(settings({ fps: 60, durationMs: 10_000 }));
  const handle = c.createAbortToken();
  const seen = [];
  const r = await c.sampleClipFrames(spec, {
    signal: handle.token,
    batchSize: 10,
    yieldFn: immediate,
    onProgress: (p) => seen.push(p),
    onFrame: (f) => {
      if (f.frame === 41) handle.abort();
    },
  });
  assert.equal(r.status, 'cancelled');
  assert.equal(r.total, 600);
  assert.equal(r.done, 42);
  assert.equal(r.frames.length, 42);
  assert.deepEqual(seen.at(-1), { done: 42, total: 600 });
  assert.equal(handle.token.aborted, true);
  const pre = c.createAbortToken();
  pre.abort();
  const none = await c.sampleClipFrames(spec, { signal: pre.token, yieldFn: immediate });
  assert.equal(none.status, 'cancelled');
  assert.equal(none.done, 0);
  // An AbortSignal works as a token too.
  const ac = new AbortController();
  ac.abort();
  assert.equal((await c.sampleClipFrames(spec, { signal: ac.signal, yieldFn: immediate })).status, 'cancelled');
});

test('capability probe is honest without DOM APIs and detects WebM only when every piece is present', () => {
  const bare = c.probeClipCapabilities({});
  assert.deepEqual([bare.canvas, bare.canvasCapture, bare.mediaRecorder, bare.webm], ['unsupported', 'unsupported', 'unsupported', 'unsupported']);
  assert.equal(bare.summary, 'JSON clip only');
  assert.deepEqual(bare.formats, ['json']);
  assert.equal(bare.webmMime, null);
  assert.ok(bare.reasons.length >= 2);
  const node = c.probeClipCapabilities();
  assert.equal(node.summary, 'JSON clip only', 'Node has no DOM canvas');

  function Canvas() {}
  Canvas.prototype.captureStream = function captureStream() {};
  function Recorder() {}
  Recorder.isTypeSupported = (m) => m === 'video/webm;codecs=vp8';
  const doc = { createElement: () => ({}) };
  const full = c.probeClipCapabilities({ document: doc, HTMLCanvasElement: Canvas, MediaRecorder: Recorder });
  assert.equal(full.webm, 'supported');
  assert.equal(full.webmMime, 'video/webm;codecs=vp8');
  assert.deepEqual(full.formats, ['json', 'webm']);

  function NoCapture() {}
  const noCap = c.probeClipCapabilities({ document: doc, HTMLCanvasElement: NoCapture, MediaRecorder: Recorder });
  assert.equal(noCap.canvas, 'supported');
  assert.equal(noCap.canvasCapture, 'unsupported');
  assert.equal(noCap.summary, 'JSON clip only');
  function NoWebm() {}
  NoWebm.isTypeSupported = () => false;
  assert.equal(c.probeClipCapabilities({ document: doc, HTMLCanvasElement: Canvas, MediaRecorder: NoWebm }).webm, 'unsupported');
  function Throws() {}
  Throws.isTypeSupported = () => {
    throw new Error('boom');
  };
  assert.equal(c.probeClipCapabilities({ document: doc, HTMLCanvasElement: Canvas, MediaRecorder: Throws }).summary, 'JSON clip only');
});

test('JSON round trip is lossless and byte-stable; tampered keyframes are re-sampled with an issue', async () => {
  for (const p of presets.LAB_PRESETS) {
    const spec = c.buildClipSpec(settings({ lab: p.lab, presetId: p.id, sceneId: 'deep-space', fps: 30, durationMs: 3000, reducedMotion: true }));
    const text = c.serializeClip(spec);
    const back = c.parseClip(text);
    assert.equal(back.ok, true, p.id);
    assert.deepEqual(back.spec, spec, p.id);
    assert.equal(back.issues.length, 0, `${p.id}: ${back.issues}`);
    assert.equal(c.serializeClip(back.spec), text, 'byte-stable');
    assert.equal(back.spec.reducedMotion, true);
  }
  const custom = c.buildClipSpec(settings({ presetId: 'custom', lab: presets.labFromScene(presets.SCENE_TEMPLATES[0]) }));
  assert.equal(c.parseClip(c.serializeClip(custom)).ok, true);
  const doc = JSON.parse(c.serializeClip(c.buildClipSpec(settings())));
  doc.keyframes[0].layers[0].opacity = 3;
  const fixed = c.parseClip(doc);
  assert.equal(fixed.ok, true);
  assert.ok(fixed.issues.some((i) => /re-sampled/.test(i)));
  assert.notEqual(fixed.spec.keyframes[0].layers[0].opacity, 3);
  const blob = c.clipJsonBlob(custom);
  assert.equal(blob.type, 'application/json');
  assert.equal(await blob.text(), c.serializeClip(custom));
});

test('file names are sanitized and local save reports when it cannot run', () => {
  assert.equal(c.sanitizeClipFileName('../../etc/Pass Wd', 'webm'), 'etc-pass-wd.webm');
  assert.equal(c.sanitizeClipFileName('Halo bloom.clip.json', 'clip.json'), 'halo-bloom.clip.json');
  assert.equal(c.sanitizeClipFileName('CON', 'webm'), 'clip-con.webm');
  assert.equal(c.sanitizeClipFileName('\u0000\u0007', 'clip.json'), 'motion-clip.clip.json');
  assert.equal(c.sanitizeClipFileName(undefined, 'webm'), 'motion-clip.webm');
  assert.ok(c.sanitizeClipFileName('x'.repeat(500), 'webm').length <= 66);
  assert.equal(c.saveBlobLocally(new Blob(['{}']), 'a.clip.json', {}), false);
  const clicks = [];
  const anchor = {
    click() {
      clicks.push(this.download);
    },
    remove() {},
  };
  const revoked = [];
  const ok = c.saveBlobLocally(new Blob(['{}']), 'My clip/../x.clip.json', {
    document: { createElement: () => anchor, body: { appendChild() {} } },
    URL: { createObjectURL: () => 'blob:local-1', revokeObjectURL: (u) => revoked.push(u) },
  });
  assert.equal(ok, true);
  assert.deepEqual(clicks, ['my-clip-x.clip.json']);
  assert.deepEqual(revoked, ['blob:local-1']);
  assert.equal(c.formatBytes(2048), '2.0 KB');
});

test('WebM recorder refuses honestly without support and records paced frames with a stand-in recorder', async () => {
  const spec = c.buildClipSpec(settings({ fps: 12, durationMs: 1000 }));
  const none = await c.recordClipWebm(spec, () => {}, { env: {} });
  assert.equal(none.ok, false);
  assert.match(none.reason, /JSON clip only/);

  const drawn = [];
  let requested = 0;
  const track = {
    stop() {
      track.stopped = true;
    },
    requestFrame() {
      requested++;
    },
  };
  function Canvas() {}
  Canvas.prototype.captureStream = () => {};
  class Recorder {
    static isTypeSupported(m) {
      return m === 'video/webm';
    }
    constructor(stream, opts) {
      this.state = 'inactive';
      this.opts = opts;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['webm-bytes']) });
      this.onstop?.();
    }
  }
  const env = { document: { createElement: () => ({ getContext: () => ({}), captureStream: () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) }) }, HTMLCanvasElement: Canvas, MediaRecorder: Recorder };
  const ok = await c.recordClipWebm(spec, (_ctx, snap) => drawn.push(snap.frame), { env, pace: immediate });
  assert.equal(ok.ok, true);
  assert.equal(ok.frames, 12);
  assert.equal(ok.mime, 'video/webm');
  assert.equal(requested, 12);
  assert.deepEqual(drawn, Array.from({ length: 12 }, (_, i) => i));
  assert.equal(track.stopped, true);

  const handle = c.createAbortToken();
  const cancelled = await c.recordClipWebm(spec, (_ctx, snap) => {
    if (snap.frame === 4) handle.abort();
  }, { env, pace: immediate, signal: handle.token });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.frames, 5);
});

test('Motion Studio wires the Export clip panel through the validated module', async () => {
  const src = await readFile(path.join(root, 'src/components/MotionStudio.tsx'), 'utf8');
  assert.match(src, /from '\.\.\/ui\/motion-clip'/);
  assert.match(src, /title="Export clip"/);
  assert.match(src, /parseClip\(/);
  assert.match(src, /probeClipCapabilities\(/);
  assert.match(src, /createAbortToken\(/);
  assert.match(src, /clipFileSeq\.current/);
  assert.doesNotMatch(src, /ipcRenderer|window\.api|https?:\/\//);
});
