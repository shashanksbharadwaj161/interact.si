/** Microphone capture → 16 kHz mono 16-bit PCM WAV bytes, as expected by JarvisAPI.transcribe. */

export const TARGET_SAMPLE_RATE = 16000;
export const MAX_CLIP_MS = 30000;
export const MIN_CLIP_MS = 300;

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export function peakOf(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > p) p = a;
  }
  return p;
}

async function toMono16k(blob: Blob): Promise<Float32Array> {
  const decodeCtx = new AudioContext();
  try {
    const decoded = await decodeCtx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
    const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    void decodeCtx.close();
  }
}

export type ClipResult = { wav: number[]; durationMs: number; peak: number };

export class ClipRecorder {
  onLevel?: (level: number) => void;
  onLimit?: () => void;
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private raf = 0;
  private limitTimer = 0;
  private startedAt = 0;

  get active(): boolean {
    return this.rec !== null;
  }

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Microphone capture is not available in this window.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    try {
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(this.stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i] - 128) / 128;
          sum += d * d;
        }
        this.onLevel?.(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
      this.chunks = [];
      this.rec = new MediaRecorder(this.stream);
      this.rec.ondataavailable = (e) => {
        if (e.data.size) this.chunks.push(e.data);
      };
      this.rec.start(250);
      this.startedAt = performance.now();
      this.limitTimer = window.setTimeout(() => this.onLimit?.(), MAX_CLIP_MS);
    } catch (e) {
      this.release();
      throw e;
    }
  }

  async stop(): Promise<ClipResult> {
    const rec = this.rec;
    if (!rec) throw new Error('Recording was not running.');
    const durationMs = performance.now() - this.startedAt;
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
    });
    if (rec.state !== 'inactive') rec.stop();
    await done;
    const mime = rec.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: mime });
    this.release();
    if (durationMs < MIN_CLIP_MS || blob.size === 0) throw new Error('That was too short. Hold the button while you speak.');
    let samples: Float32Array;
    try {
      samples = await toMono16k(blob);
    } catch {
      throw new Error('The recording could not be decoded in this window.');
    }
    const peak = peakOf(samples);
    if (peak < 0.01) throw new Error('No sound was picked up. Check the microphone and try again.');
    return { wav: Array.from(encodeWav(samples, TARGET_SAMPLE_RATE)), durationMs, peak };
  }

  cancel(): void {
    if (this.rec && this.rec.state !== 'inactive') {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.release();
  }

  private release(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.limitTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) void this.ctx.close();
    this.stream = null;
    this.ctx = null;
    this.rec = null;
    this.onLevel?.(0);
  }
}

export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow it in Windows privacy settings and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by another application.';
  return e instanceof Error && e.message ? e.message : 'Recording failed.';
}
