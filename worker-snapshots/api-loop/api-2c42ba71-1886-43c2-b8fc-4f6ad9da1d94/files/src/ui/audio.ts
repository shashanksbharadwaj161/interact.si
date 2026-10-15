/** Microphone capture → 16 kHz mono 16-bit PCM WAV bytes, as expected by JarvisAPI.transcribe. */

import { VOICE_LINK_LIMITS, type VoiceLinkEvent } from './avatar-voice';

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

/** Hard ceilings so a stuck or hostile capture can never grow without bound. */
export const MAX_SAMPLES = (TARGET_SAMPLE_RATE * MAX_CLIP_MS) / 1000;
export const MAX_RECORDED_BYTES = 8 * 1024 * 1024;
/** After MAX_CLIP_MS the owner gets this long to stop; then capture is halted by the recorder itself. */
export const LIMIT_GRACE_MS = 2000;

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

/** Thrown when start() was cancelled (or the recorder was cancelled) before the microphone was ready. */
export class RecordingCancelled extends Error {
  constructor() {
    super('Recording was cancelled.');
    this.name = 'RecordingCancelled';
  }
}

/** Thrown when the microphone was not explicitly allowed by the user inside this app. */
export class MicConsentError extends Error {
  constructor() {
    super('Microphone use has not been allowed yet. Turn on voice input first.');
    this.name = 'MicConsentError';
  }
}

/** Minimal storage shape (localStorage fits). Optional, so consent defaults to in-memory only. */
export interface ConsentStorage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface MicConsent {
  granted(): boolean;
  grant(): void;
  revoke(): void;
}

const CONSENT_KEY = 'desktop-companion.mic-consent.v1';

/**
 * In-app, explicit microphone consent, separate from the OS permission. Nothing grants it implicitly:
 * the UI must call grant() from a deliberate user action. Without storage it lasts for the window only.
 */
export function createMicConsent(storage?: ConsentStorage | null): MicConsent {
  let mem = false;
  /** Set by revoke() in this window; wins over storage so a store that cannot delete the record still fails closed (PS-02). */
  let revoked = false;
  const read = (): boolean => {
    if (revoked) return false;
    if (!storage) return mem;
    try {
      return storage.getItem(CONSENT_KEY) === '1';
    } catch {
      return mem;
    }
  };
  return {
    granted: read,
    grant() {
      mem = true;
      revoked = false;
      try {
        storage?.setItem(CONSENT_KEY, '1');
      } catch {
        /* in-memory consent still applies */
      }
    },
    revoke() {
      mem = false;
      revoked = true;
      try {
        storage?.removeItem(CONSENT_KEY);
      } catch {
        // Overwrite instead, so a later window does not read the old grant either.
        try { storage?.setItem(CONSENT_KEY, '0'); } catch { /* in-window revoke still applies */ }
      }
    },
  };
}

/**
 * Turns decoded 16 kHz mono samples into a bounded clip: rejects too-short/silent audio, trims silence, enforces the sample cap.
 * Pure, so every bound is testable without a microphone.
 */
export function prepareClip(samples: Float32Array, durationMs: number): ClipResult {
  const capped = Math.min(durationMs, MAX_CLIP_MS);
  const peak = peakOf(samples);
  const q = clipQuality(peak, capped);
  if (!q.usable) throw new Error(q.message);
  let out = trimSilence(samples, TARGET_SAMPLE_RATE);
  if (out.length > MAX_SAMPLES) out = out.slice(0, MAX_SAMPLES);
  if ((out.length / TARGET_SAMPLE_RATE) * 1000 < MIN_CLIP_MS) throw new Error('That was too short. Hold the button while you speak.');
  return { wav: Array.from(encodeWav(out, TARGET_SAMPLE_RATE)), durationMs: capped, peak };
}

export class ClipRecorder {
  onLevel?: (level: number) => void;
  /** The maximum length was reached. The owner should call stop(); capture halts on its own shortly after regardless. */
  onLimit?: () => void;
  /** The input device vanished or stopped mid-recording. What was captured so far can still be stopped or discarded. */
  onDeviceLost?: () => void;
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private ctx: AudioContext | null = null;
  private raf = 0;
  private limitTimer = 0;
  private graceTimer = 0;
  private startedAt = 0;
  private endedAt = 0;
  private halted = false;
  private stopped: Promise<void> | null = null;
  private generation = 0;
  private current: RecorderState = 'idle';

  /** `consent`, when supplied, is checked before the microphone is requested. Without it behaviour is unchanged. */
  constructor(private opts: { consent?: MicConsent } = {}) {}

  get state(): RecorderState {
    return this.current;
  }

  get active(): boolean {
    return this.rec !== null;
  }

  async start(deviceId?: string): Promise<void> {
    if (this.current !== 'idle') throw new Error('Recording is already running.');
    if (this.opts.consent && !this.opts.consent.granted()) throw new MicConsentError();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Microphone capture is not available in this window.');
    }
    const gen = ++this.generation;
    this.current = 'starting';
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
    } catch (e) {
      if (this.generation === gen) this.current = 'idle';
      throw e;
    }
    // cancel() ran while the permission prompt or device open was pending: never keep a microphone nobody is waiting for.
    if (this.generation !== gen) {
      stream.getTracks().forEach((t) => t.stop());
      throw new RecordingCancelled();
    }
    this.stream = stream;
    this.halted = false;
    try {
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (this.generation !== gen || this.halted || !this.ctx) return;
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
      this.bytes = 0;
      this.endedAt = 0;
      this.halted = false;
      const rec = new MediaRecorder(stream);
      this.stopped = new Promise<void>((resolve) => {
        rec.onstop = () => resolve();
      });
      rec.ondataavailable = (e) => {
        if (!e.data.size || this.rec !== rec) return;
        this.chunks.push(e.data);
        this.bytes += e.data.size;
        if (this.bytes > MAX_RECORDED_BYTES) this.halt();
      };
      stream.getAudioTracks().forEach((t) => {
        t.onended = () => {
          if (this.rec !== rec || this.halted) return;
          this.halt();
          this.onDeviceLost?.();
        };
      });
      this.rec = rec;
      rec.start(250);
      this.startedAt = performance.now();
      this.current = 'recording';
      this.limitTimer = window.setTimeout(() => {
        this.onLimit?.();
        if (this.rec === rec && !this.halted) this.graceTimer = window.setTimeout(() => this.halt(), LIMIT_GRACE_MS);
      }, MAX_CLIP_MS);
    } catch (e) {
      this.release();
      throw e;
    }
  }

  /** Stops capturing but keeps the recorded chunks so stop() can still return what exists. */
  private halt(): void {
    if (!this.halted) this.endedAt = performance.now();
    this.halted = true;
    cancelAnimationFrame(this.raf);
    this.onLevel?.(0);
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    window.clearTimeout(this.limitTimer);
    window.clearTimeout(this.graceTimer);
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  async stop(): Promise<ClipResult> {
    const rec = this.rec;
    if (!rec || this.current !== 'recording') throw new Error('Recording was not running.');
    this.current = 'stopping';
    const gen = this.generation;
    this.halt();
    const durationMs = Math.min(this.endedAt - this.startedAt, MAX_CLIP_MS);
    await this.stopped;
    // cancel() during the wait wins: no clip is produced for a recording the user discarded, and a newer recording is left alone.
    if (this.generation !== gen) throw new RecordingCancelled();
    const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
    this.release();
    if (durationMs < MIN_CLIP_MS || blob.size === 0) throw new Error('That was too short. Hold the button while you speak.');
    let samples: Float32Array;
    try {
      samples = await toMono16k(blob);
    } catch {
      if (this.generation !== gen) throw new RecordingCancelled();
      throw new Error('The recording could not be decoded in this window.');
    }
    if (this.generation !== gen) throw new RecordingCancelled();
    return prepareClip(samples, durationMs);
  }

  /** Discards everything, including a start() still waiting on the permission prompt. Safe to call at any time. */
  cancel(): void {
    this.generation++;
    const rec = this.rec;
    if (rec) {
      rec.ondataavailable = null;
      if (rec.state !== 'inactive') rec.stop();
    }
    this.release();
  }

  private release(): void {
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.limitTimer);
    window.clearTimeout(this.graceTimer);
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    if (this.ctx) void this.ctx.close();
    this.stream = null;
    this.ctx = null;
    this.rec = null;
    this.stopped = null;
    this.chunks = [];
    this.bytes = 0;
    this.current = 'idle';
    this.onLevel?.(0);
  }
}

// ---- Capability checks that never open the microphone ----

export interface MicEnv {
  mediaDevices?: { getUserMedia?: unknown; enumerateDevices?: () => Promise<{ kind: string; deviceId: string; label: string }[]> };
  permissions?: { query: (d: { name: string }) => Promise<{ state: string }> };
  hasMediaRecorder?: boolean;
}

function liveEnv(): MicEnv {
  return {
    mediaDevices: typeof navigator !== 'undefined' ? (navigator.mediaDevices as unknown as MicEnv['mediaDevices']) : undefined,
    permissions: typeof navigator !== 'undefined' ? (navigator.permissions as unknown as MicEnv['permissions']) : undefined,
    hasMediaRecorder: typeof MediaRecorder !== 'undefined',
  };
}

/** Whether this window can record at all. Does not touch the microphone. */
export function micSupport(env: MicEnv = liveEnv()): { supported: boolean; reason?: string } {
  if (!env.mediaDevices?.getUserMedia) return { supported: false, reason: 'This window cannot access a microphone.' };
  if (!env.hasMediaRecorder) return { supported: false, reason: 'This window cannot record audio.' };
  return { supported: true };
}

/** Reads the permission state without prompting and without opening the microphone. */
export async function micPermission(env: MicEnv = liveEnv()): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    const s = (await env.permissions?.query({ name: 'microphone' }))?.state;
    return s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Lists input devices. Labels stay empty until microphone permission was granted once; this never prompts. */
export async function listMicrophones(env: MicEnv = liveEnv()): Promise<{ id: string; label: string }[]> {
  try {
    const all = (await env.mediaDevices?.enumerateDevices?.()) ?? [];
    return all.filter((d) => d.kind === 'audioinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
  } catch {
    return [];
  }
}

export type ClipLevel = 'silent' | 'quiet' | 'good' | 'clipped';

/** Judges a finished clip so the UI can say why recognition may fail, instead of sending silence to the recognizer. */
export function clipQuality(peak: number, durationMs: number): { level: ClipLevel; usable: boolean; message: string } {
  if (durationMs < MIN_CLIP_MS) return { level: 'silent', usable: false, message: 'That was too short. Hold the button while you speak.' };
  if (peak < 0.01) return { level: 'silent', usable: false, message: 'No sound was picked up. Check the microphone and try again.' };
  if (peak < 0.05) return { level: 'quiet', usable: true, message: 'The recording is very quiet. Move closer to the microphone if the text is wrong.' };
  if (peak >= 0.99) return { level: 'clipped', usable: true, message: 'The recording is distorted. Speak a little further from the microphone.' };
  return { level: 'good', usable: true, message: '' };
}

/** Removes leading and trailing silence (keeping a short pad) so the recognizer gets less to chew on. Returns the input when nothing is loud enough. */
export function trimSilence(samples: Float32Array, sampleRate: number, threshold = 0.01, padMs = 150): Float32Array {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return samples;
  const pad = Math.round((padMs / 1000) * sampleRate);
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad + 1));
}

export function micErrorMessage(e: unknown): string {
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow it in Windows privacy settings and try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found.';
  if (name === 'NotReadableError') return 'The microphone is in use by another application.';
  return e instanceof Error && e.message ? e.message : 'Recording failed.';
}

// ---- Speech playback to avatar voice link (output only; never opens the microphone) ----

export type VoiceAttachment = { available: boolean; reason?: string; dispose: () => void };

const NOOP = (): void => undefined;

/** RMS of time-domain samples, clamped to 0..1. Accepts float samples (-1..1) or bytes centred on 128. */
export function levelFromTimeDomain(samples: ArrayLike<number>, kind: 'float' | 'byte' = 'float'): number {
  const n = samples.length;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = kind === 'byte' ? (samples[i] - 128) / 128 : samples[i];
    if (Number.isFinite(d)) sum += d * d;
  }
  const r = Math.sqrt(sum / n);
  return Number.isFinite(r) ? Math.min(VOICE_LINK_LIMITS.maxAmplitude, Math.max(VOICE_LINK_LIMITS.minAmplitude, r)) : 0;
}

type MeterAnalyser = {
  fftSize: number;
  getFloatTimeDomainData?: (b: Float32Array) => void;
  getByteTimeDomainData?: (b: Uint8Array) => void;
  disconnect?: () => void;
};
type MeterContext = { createAnalyser?: () => MeterAnalyser };
type MeterSource = { connect?: (n: unknown) => unknown; disconnect?: (n?: unknown) => void };

/**
 * Taps a playback source node with an AnalyserNode and reports its RMS (0..1) every intervalMs.
 * The analyser is not connected to the destination, so it adds no sound. Returns {available:false}
 * and a no-op dispose when the Web Audio analyser or timers are missing. dispose() is idempotent,
 * stops the interval and disconnects the analyser; no level is reported after it.
 */
export function attachLevelMeter(audioContext: unknown, sourceNode: unknown, onLevel: (rms: number) => void, opts: { intervalMs?: number } = {}): VoiceAttachment {
  const ctx = audioContext as MeterContext | null | undefined;
  const src = sourceNode as MeterSource | null | undefined;
  const g = globalThis as { AnalyserNode?: unknown; setInterval?: unknown; clearInterval?: unknown };
  if (typeof g.AnalyserNode === 'undefined' || !ctx || typeof ctx.createAnalyser !== 'function' || !src || typeof src.connect !== 'function') {
    return { available: false, reason: 'Audio level analysis is not available in this environment.', dispose: NOOP };
  }
  if (typeof g.setInterval !== 'function' || typeof g.clearInterval !== 'function') {
    return { available: false, reason: 'Timers are not available in this environment.', dispose: NOOP };
  }
  const raw = Number(opts.intervalMs ?? VOICE_LINK_LIMITS.sampleWindowMs);
  const intervalMs = Number.isFinite(raw) ? Math.min(1000, Math.max(16, Math.round(raw))) : VOICE_LINK_LIMITS.sampleWindowMs;
  let analyser: MeterAnalyser;
  try {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
  } catch {
    return { available: false, reason: 'The audio source could not be analysed.', dispose: NOOP };
  }
  const useFloat = typeof analyser.getFloatTimeDomainData === 'function';
  const size = Number.isInteger(analyser.fftSize) && analyser.fftSize > 0 ? analyser.fftSize : 1024;
  const fbuf = new Float32Array(useFloat ? size : 0);
  const bbuf = new Uint8Array(useFloat ? 0 : size);
  let live = true;
  const timer = setInterval(() => {
    if (!live) return;
    if (useFloat && analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(fbuf);
      onLevel(levelFromTimeDomain(fbuf, 'float'));
    } else if (analyser.getByteTimeDomainData) {
      analyser.getByteTimeDomainData(bbuf);
      onLevel(levelFromTimeDomain(bbuf, 'byte'));
    }
  }, intervalMs);
  return {
    available: true,
    dispose() {
      if (!live) return;
      live = false;
      clearInterval(timer);
      try { src.disconnect?.(analyser); } catch { /* already disconnected */ }
      try { analyser.disconnect?.(); } catch { /* already disconnected */ }
    },
  };
}

type UtteranceLike = {
  text?: string;
  addEventListener?: (type: string, fn: (e: unknown) => void) => void;
  removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
};

const UTTERANCE_EVENTS = ['start', 'boundary', 'pause', 'resume', 'end', 'error'] as const;

/**
 * Wires a SpeechSynthesisUtterance's playback events to voice link events. Word boundaries carry the
 * utterance text and charIndex; sentence boundaries and malformed indexes are dropped. Errors caused by
 * cancel ("interrupted"/"canceled") are reported as cancel. dispose() removes every listener.
 */
export function attachUtteranceEvents(utterance: unknown, onEvent: (event: VoiceLinkEvent) => void, opts: { now?: () => number } = {}): VoiceAttachment {
  const u = utterance as UtteranceLike | null | undefined;
  if (!u || typeof u.addEventListener !== 'function' || typeof u.removeEventListener !== 'function') {
    return { available: false, reason: 'Speech playback events are not available in this environment.', dispose: NOOP };
  }
  const add = u.addEventListener.bind(u);
  const remove = u.removeEventListener.bind(u);
  let live = true;
  const stamp = (): { at?: number } => {
    const t = opts.now?.();
    return typeof t === 'number' && Number.isFinite(t) ? { at: t } : {};
  };
  const handlers = UTTERANCE_EVENTS.map((type) => {
    const fn = (raw: unknown) => {
      if (!live) return;
      const e = (raw ?? {}) as { charIndex?: unknown; name?: unknown; error?: unknown };
      if (type === 'boundary') {
        if (e.name === 'sentence') return;
        const ci = e.charIndex;
        if (typeof ci !== 'number' || !Number.isInteger(ci) || ci < 0) return;
        onEvent({ type: 'boundary', charIndex: ci, text: typeof u.text === 'string' ? u.text : '', ...stamp() });
        return;
      }
      if (type === 'error') {
        const code = typeof e.error === 'string' ? e.error : '';
        onEvent(code === 'interrupted' || code === 'canceled' ? { type: 'cancel', ...stamp() } : { type: 'error', ...(code ? { error: code } : {}), ...stamp() });
        return;
      }
      onEvent({ type, ...stamp() });
    };
    add(type, fn);
    return [type, fn] as const;
  });
  return {
    available: true,
    dispose() {
      if (!live) return;
      live = false;
      for (const [type, fn] of handlers) remove(type, fn);
    },
  };
}

type VoiceLike = { localService?: boolean; lang?: string; default?: boolean };
export type SpeechSynth = { speak(u: unknown): void; cancel(): void; getVoices?: () => VoiceLike[] };
export type SpeechSupport =
  | { available: true; synth: SpeechSynth; Utterance: new (text: string) => unknown }
  | { available: false; reason: string };

/** Whether this window can play speech locally via speechSynthesis. Never prompts and never plays anything. */
export function speechSynthesisSupport(env?: { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown }): SpeechSupport {
  let e = env;
  if (!e) {
    try {
      e = typeof window !== 'undefined' ? (window as unknown as { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown }) : undefined;
    } catch {
      e = undefined;
    }
  }
  const synth = e?.speechSynthesis as { speak?: unknown; cancel?: unknown } | undefined;
  const Utter = e?.SpeechSynthesisUtterance;
  if (!synth || typeof synth.speak !== 'function' || typeof synth.cancel !== 'function' || typeof Utter !== 'function') {
    return { available: false, reason: 'Speech playback is not supported in this window.' };
  }
  return { available: true, synth: synth as unknown as SpeechSynth, Utterance: Utter as new (text: string) => unknown };
}

/**
 * Chooses an on-device voice. An empty list means the system default voice is used (on-device on Windows).
 * When voices are listed but none is on-device, returns ok:false so nothing is sent to a network voice.
 */
export function pickLocalVoice<V extends VoiceLike>(voices: readonly V[] | null | undefined): { ok: boolean; voice: V | null } {
  const list = Array.isArray(voices) ? voices : [];
  if (list.length === 0) return { ok: true, voice: null };
  const local = list.filter((v) => v && v.localService === true);
  if (local.length === 0) return { ok: false, voice: null };
  return { ok: true, voice: local.find((v) => v.default) ?? local.find((v) => typeof v.lang === 'string' && v.lang.toLowerCase().startsWith('en')) ?? local[0] };
}

// ---- Consent storage and level forwarding for views ----

/** localStorage when this window has one; null (in-memory consent only) during SSR or when storage is blocked. */
export function defaultConsentStorage(): ConsentStorage | null {
  try {
    const s = typeof window !== 'undefined' ? window.localStorage : undefined;
    return s && typeof s.getItem === 'function' ? s : null;
  } catch {
    return null;
  }
}

/** Milliseconds left before the recorder stops on its own; clamps so a meter never shows a negative count. */
export function remainingMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return MAX_CLIP_MS;
  return Math.max(0, MAX_CLIP_MS - elapsedMs);
}

/**
 * Builds the recorder's onLevel handler for a view. Levels are only forwarded while `owner()` still points at
 * this recorder, so a late animation frame from a cancelled or replaced recorder can never move the avatar.
 */
export function bindLevel(rec: ClipRecorder, owner: () => ClipRecorder | null, forward: (level: number) => void): void {
  rec.onLevel = (l) => {
    if (owner() !== rec) return;
    forward(Number.isFinite(l) ? Math.min(1, Math.max(0, l)) : 0);
  };
}
