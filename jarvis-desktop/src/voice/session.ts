import { ClipRecorder, RecordingCancelled, clipQuality, micErrorMessage, type ClipLevel, type ClipResult, type MicConsent } from '../ui/audio';
import { errMsg } from '../ui/util';
import { isNativeConsent } from './consent';

/**
 * One voice session for one surface (the Assistant page, later the companion island). It owns the whole local voice loop:
 * explicit start, listening with the real microphone level, local transcription, read-aloud, and the stop/cancel paths.
 *
 * What it never does: open the microphone without an explicit startListening() call and the in-app consent, send audio
 * anywhere but the surface's own validated `transcribe` IPC (the Windows recognizer on this computer), invent text when
 * recognition returns nothing, or put recognized text anywhere itself. The owner receives the transcript through
 * `onTranscript` and decides where it goes for review.
 *
 * No React and no DOM here, so every path runs in unit tests with a fake recorder and backend.
 */

export type VoicePhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'speaking';

/** What one surface can reach. Every call is that surface's own validated IPC; nothing here talks to a network. */
export interface VoiceBackend {
  transcribe(wav: number[]): Promise<{ text: string; reason?: string; cancelled?: boolean }>;
  speak(text: string): Promise<{ ok: boolean; reason?: string }>;
  /** Ends read-aloud. Absent on an older bridge: the UI then cannot offer Stop and says so. */
  stopSpeaking?: () => Promise<boolean>;
  /** Makes a transcription in flight return no text. Absent: cancelling only discards the result here. */
  cancelTranscribe?: () => Promise<boolean>;
}

/** The part of ClipRecorder the session uses, so tests can inject a fake microphone. */
export interface VoiceRecorder {
  onLevel?: (level: number) => void;
  onLimit?: () => void;
  onDeviceLost?: () => void;
  start(): Promise<void>;
  stop(): Promise<ClipResult>;
  cancel(): void;
}

export type VoiceCapability = { available: boolean; reason?: string };
/** Engine state as the owner knows it (system info for the hub, the companion's status call for the island). */
export type VoiceCaps = { stt: VoiceCapability | null; tts: VoiceCapability | null };

export type VoiceBlockCode = 'no-backend' | 'engine' | 'device' | 'consent';
export type VoiceBlock = { code: VoiceBlockCode; reason: string };

export type VoiceNoteCode =
  | 'cancelled' | 'cancelled-transcription' | 'hidden' | 'consent-off' | 'limit' | 'device-lost'
  | 'listen-blocked' | 'mic-error' | 'clip-error' | 'no-speech' | 'transcribe-failed'
  | 'speak-blocked' | 'speak-busy' | 'speak-failed' | 'speak-stopped' | 'stop-failed';
export type VoiceNote = { tone: 'info' | 'warn' | 'danger'; code: VoiceNoteCode; text: string };

export type Transcript = { n: number; text: string; durationMs: number; quality: ClipLevel; hint: string };

export type SpeakingInfo = { key: string | null; chars: number; truncated: boolean; stoppable: boolean };

export type VoiceSnapshot = {
  phase: VoicePhase;
  /** performance.now() when listening began, for an elapsed/remaining display. */
  listeningSince: number | null;
  consent: boolean;
  speaking: SpeakingInfo | null;
  /** A transcription the person cancelled is still being finished by the speech engine; the next one waits for it. */
  draining: boolean;
  note: VoiceNote | null;
};

export type SpeakOutcome = 'spoken' | 'stopped' | 'failed' | 'blocked';

export type VoiceSessionDeps = {
  backend: VoiceBackend | null;
  consent: MicConsent;
  /** micSupport() of this window: whether it can record at all. */
  support: { supported: boolean; reason?: string };
  /** Latest engine state; read on every start/speak, so the owner can keep it in a ref. */
  caps: () => VoiceCaps;
  createRecorder?: (consent: MicConsent) => VoiceRecorder;
  now?: () => number;
  /** Read-aloud limit per request (the IPC accepts more; long replies are cut at a sentence and the UI says so). */
  maxSpeakChars?: number;
  /** Shown when consent is off. Each surface names its own switch. */
  consentHint?: string;
  onTranscript?: (t: Transcript) => void;
};

export const DEFAULT_MAX_SPEAK_CHARS = 2000;
/** A stop that arrives during a permission prompt shorter than this was a quick tap: stop as soon as the microphone opens. */
export const QUICK_TAP_MS = 1000;
export const LEVEL_HISTORY = 28;
const DEFAULT_CONSENT_HINT = 'Allow the microphone first. Nothing is recorded until you do.';

/** Why listening or read-aloud cannot start now, in the order a person can fix it. Pure, so a server render shows the same reason. */
export function voiceBlocks(o: { hasBackend: boolean; caps: VoiceCaps; support: { supported: boolean; reason?: string }; consent: boolean; consentHint?: string }): { listen: VoiceBlock | null; speak: VoiceBlock | null } {
  const none = 'Voice is not available in this window.';
  const listen: VoiceBlock | null = !o.hasBackend
    ? { code: 'no-backend', reason: none }
    : !o.caps.stt?.available
      ? { code: 'engine', reason: o.caps.stt?.reason || 'Speech recognition has not been checked yet.' }
      : !o.support.supported
        ? { code: 'device', reason: o.support.reason || 'Microphone capture is not available in this window.' }
        : !o.consent
          ? { code: 'consent', reason: o.consentHint || DEFAULT_CONSENT_HINT }
          : null;
  const speak: VoiceBlock | null = !o.hasBackend
    ? { code: 'no-backend', reason: none }
    : !o.caps.tts?.available
      ? { code: 'engine', reason: o.caps.tts?.reason || 'Read aloud has not been checked yet.' }
      : null;
  return { listen, speak };
}

/**
 * Text as it should be heard: Markdown markers, link targets and code blocks are not read out. What is on screen is
 * unchanged; this only shapes what the voice says.
 */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?(?:```|$)/g, '\n(code block not read aloud)\n')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)]+/g, 'a link')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** At most `max` characters, cut after the last sentence (or word) that fits. */
export function clipForSpeech(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  const cut = sentence > max * 0.5 ? sentence + 1 : head.lastIndexOf(' ') > max * 0.5 ? head.lastIndexOf(' ') : max;
  return { text: head.slice(0, cut).trim(), truncated: true };
}

const STOPPED_REASON = /^(Speech was stopped|Superseded by newer speech)$/;

export class VoiceSession {
  onTranscript?: (t: Transcript) => void;
  private d: VoiceSessionDeps;
  private snap: VoiceSnapshot;
  private listeners = new Set<() => void>();
  private levelListeners = new Set<(level: number, history: readonly number[]) => void>();
  private history: number[] = [];
  private rec: VoiceRecorder | null = null;
  /** Bumped by every cancel/stop/release: work started under an older value must not write state. */
  private op = 0;
  private speakGen = 0;
  private pendingStop = false;
  private startAt = 0;
  /** The transcribe() call in flight, kept after a cancel so the next transcription can wait for the engine to be free. */
  private inflight: Promise<unknown> | null = null;
  private count = 0;
  private now: () => number;

  constructor(d: VoiceSessionDeps) {
    this.d = d;
    this.onTranscript = d.onTranscript;
    this.now = d.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.snap = { phase: 'idle', listeningSince: null, consent: d.consent.granted(), speaking: null, draining: false, note: null };
  }

  // ---- store protocol (useSyncExternalStore) ----
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): VoiceSnapshot => this.snap;
  /** The live level is published separately so only a meter re-renders at microphone rate, never the whole page. */
  subscribeLevel(fn: (level: number, history: readonly number[]) => void): () => void {
    this.levelListeners.add(fn);
    return () => this.levelListeners.delete(fn);
  }

  setBackend(backend: VoiceBackend | null): void {
    this.d = { ...this.d, backend };
  }

  blocks(): { listen: VoiceBlock | null; speak: VoiceBlock | null } {
    return voiceBlocks({ hasBackend: this.d.backend !== null, caps: this.d.caps(), support: this.d.support, consent: this.d.consent.granted(), consentHint: this.d.consentHint });
  }

  clearNote(): void {
    if (this.snap.note) this.set({ note: null });
  }

  /**
   * The consent switch. Turning it off cancels any recording or transcription at once. With a native consent (the main
   * process's policy) turning it on waits for the person's answer in the trusted confirmation; resolves to what is in
   * force afterwards.
   */
  async setConsent(on: boolean): Promise<boolean> {
    const c = this.d.consent;
    if (!on) {
      const active = this.snap.phase === 'starting' || this.snap.phase === 'listening' || this.snap.phase === 'transcribing';
      if (isNativeConsent(c)) void c.request(false);
      else c.revoke();
      if (active) this.cancel({ tone: 'info', code: 'consent-off', text: 'Microphone turned off. The recording was discarded and nothing was transcribed.' });
      this.set({ consent: false });
      return false;
    }
    if (isNativeConsent(c)) {
      const ok = await c.request(true);
      const allowed = c.granted();
      this.set({ consent: allowed, note: allowed ? null : { tone: 'info', code: 'consent-off', text: 'The microphone stays off: permission was cancelled or changed.' } });
      return allowed && ok;
    }
    c.grant();
    this.set({ consent: c.granted() });
    return c.granted();
  }

  /** The policy changed elsewhere (another window, the main process). Turning off cancels a recording in progress. */
  syncConsent(allowed?: boolean): void {
    const c = this.d.consent;
    if (allowed !== undefined && isNativeConsent(c)) c.update(allowed);
    const now = c.granted();
    if (!now && (this.snap.phase === 'starting' || this.snap.phase === 'listening' || this.snap.phase === 'transcribing')) {
      this.cancel({ tone: 'info', code: 'consent-off', text: 'The microphone was turned off. The recording was discarded and nothing was transcribed.' });
    }
    this.set({ consent: now });
  }

  // ---- listening ----

  /** Explicit start only. Interrupts read-aloud, so the microphone does not record the app's own voice. */
  async startListening(): Promise<void> {
    if (this.snap.phase === 'starting' || this.snap.phase === 'listening' || this.snap.phase === 'transcribing') return;
    const block = this.blocks().listen;
    if (block) {
      this.set({ note: { tone: 'warn', code: block.code === 'consent' ? 'consent-off' : 'listen-blocked', text: block.reason } });
      return;
    }
    // Synchronous phase change first, so a second press in the same tick sees 'starting' and is ignored.
    if (this.snap.phase === 'speaking') void this.stopSpeaking({ quiet: true });
    const op = ++this.op;
    this.pendingStop = false;
    const r = (this.d.createRecorder ?? ((c) => new ClipRecorder({ consent: c })))(this.d.consent);
    this.rec = r;
    this.history = [];
    r.onLevel = (l) => { if (this.rec === r && op === this.op) this.pushLevel(l); };
    r.onLimit = () => { if (this.rec === r) void this.stopListening({ tone: 'info', code: 'limit', text: 'Reached the recording limit. Transcribing what was recorded.' }); };
    r.onDeviceLost = () => { if (this.rec === r) void this.stopListening({ tone: 'warn', code: 'device-lost', text: 'The microphone was disconnected. Transcribing what was recorded.' }); };
    this.set({ phase: 'starting', note: null, listeningSince: null });
    this.startAt = this.now();
    try {
      await r.start();
    } catch (e) {
      if (op !== this.op || this.rec !== r) return;
      this.rec = null;
      this.set({ phase: 'idle', note: e instanceof RecordingCancelled ? null : { tone: 'warn', code: 'mic-error', text: micErrorMessage(e) } });
      return;
    }
    if (op !== this.op || this.rec !== r || !this.d.consent.granted()) {
      r.cancel();
      return;
    }
    this.set({ phase: 'listening', listeningSince: this.now() });
    // A release during a long permission prompt is not a deliberate stop: keep listening until the next press.
    if (this.pendingStop && this.now() - this.startAt < QUICK_TAP_MS) void this.stopListening();
  }

  /** Stops listening and transcribes on this computer. The transcript goes to onTranscript; nothing is sent anywhere else. */
  async stopListening(why?: VoiceNote): Promise<void> {
    if (this.snap.phase === 'starting') {
      this.pendingStop = true;
      return;
    }
    const r = this.rec;
    if (this.snap.phase !== 'listening' || !r) return;
    const op = this.op;
    const backend = this.d.backend;
    this.set({ phase: 'transcribing', listeningSince: null, note: why ?? null });
    this.pushLevel(0);
    let clip: ClipResult;
    try {
      clip = await r.stop();
    } catch (e) {
      if (op !== this.op || this.rec !== r) return;
      this.rec = null;
      this.set({ phase: 'idle', note: e instanceof RecordingCancelled ? null : { tone: 'warn', code: 'clip-error', text: errMsg(e, 'The recording could not be used.') } });
      return;
    }
    if (op !== this.op || this.rec !== r) return;
    if (!backend || !this.d.consent.granted()) {
      this.rec = null;
      this.set({ phase: 'idle' });
      return;
    }
    // The engine is still finishing a recording the person cancelled: wait for it rather than be refused as busy.
    if (this.inflight) {
      await this.inflight.catch(() => undefined);
      if (op !== this.op || this.rec !== r) return;
    }
    const call = backend.transcribe(clip.wav);
    this.inflight = call;
    void call.then(() => this.settle(call), () => this.settle(call));
    let out: Awaited<typeof call>;
    try {
      out = await call;
    } catch (e) {
      if (op !== this.op || this.rec !== r) return;
      this.rec = null;
      this.set({ phase: 'idle', note: { tone: 'warn', code: 'transcribe-failed', text: errMsg(e, 'Transcription failed.') } });
      return;
    }
    if (op !== this.op || this.rec !== r) return;
    this.rec = null;
    const text = out.text.trim();
    if (!text) {
      this.set({ phase: 'idle', note: out.cancelled ? null : { tone: 'warn', code: 'no-speech', text: out.reason || 'No speech was recognized.' } });
      return;
    }
    const q = clipQuality(clip.peak, clip.durationMs);
    this.set({ phase: 'idle', note: null });
    this.onTranscript?.({ n: ++this.count, text, durationMs: clip.durationMs, quality: q.level, hint: q.message });
  }

  /** Cancels starting, listening or transcribing. Nothing captured so far is transcribed or returned. */
  cancel(note: VoiceNote | null = { tone: 'info', code: 'cancelled', text: 'Recording cancelled. Nothing was transcribed.' }): void {
    const phase = this.snap.phase;
    if (phase !== 'starting' && phase !== 'listening' && phase !== 'transcribing') return;
    this.op++;
    this.rec?.cancel();
    this.rec = null;
    this.pushLevel(0);
    let draining = false;
    if (phase === 'transcribing' && this.inflight) {
      draining = true;
      void this.d.backend?.cancelTranscribe?.().catch(() => undefined);
      if (note?.code === 'cancelled') note = { tone: 'info', code: 'cancelled-transcription', text: 'Transcription cancelled. Its text will be discarded.' };
    }
    this.set({ phase: 'idle', listeningSince: null, note, draining: draining || this.snap.draining });
  }

  /** The window was hidden (minimised to the tray): a recording nobody can see is not kept going. */
  windowHidden(): void {
    if (this.snap.phase === 'starting' || this.snap.phase === 'listening') this.cancel({ tone: 'info', code: 'hidden', text: 'Recording stopped because the window was hidden. Nothing was transcribed.' });
  }

  // ---- read aloud ----

  async speak(raw: string, opts: { key?: string } = {}): Promise<SpeakOutcome> {
    const backend = this.d.backend;
    const block = this.blocks().speak;
    if (!backend || block) {
      this.set({ note: { tone: 'warn', code: 'speak-blocked', text: block?.reason ?? 'Read aloud is not available in this window.' } });
      return 'blocked';
    }
    const phase = this.snap.phase;
    if (phase === 'starting' || phase === 'listening' || phase === 'transcribing') {
      this.set({ note: { tone: 'info', code: 'speak-busy', text: 'Finish or cancel the recording first.' } });
      return 'blocked';
    }
    const { text, truncated } = clipForSpeech(speakableText(raw), this.d.maxSpeakChars ?? DEFAULT_MAX_SPEAK_CHARS);
    if (!text) return 'blocked';
    const gen = ++this.speakGen;
    this.set({ phase: 'speaking', note: null, speaking: { key: opts.key ?? null, chars: text.length, truncated, stoppable: typeof backend.stopSpeaking === 'function' } });
    let r: { ok: boolean; reason?: string };
    try {
      r = await backend.speak(text);
    } catch (e) {
      if (gen !== this.speakGen) return 'stopped';
      this.set({ phase: 'idle', speaking: null, note: { tone: 'warn', code: 'speak-failed', text: errMsg(e, 'Read aloud failed.') } });
      return 'failed';
    }
    // Stopped here, superseded by newer speech, or released: the newer owner of the voice decides what is shown.
    if (gen !== this.speakGen) return 'stopped';
    if (!r.ok && STOPPED_REASON.test(r.reason ?? '')) {
      this.set({ phase: 'idle', speaking: null, note: { tone: 'info', code: 'speak-stopped', text: 'Read aloud was stopped.' } });
      return 'stopped';
    }
    this.set({ phase: 'idle', speaking: null, note: r.ok ? null : { tone: 'warn', code: 'speak-failed', text: r.reason || 'Read aloud is not available.' } });
    return r.ok ? 'spoken' : 'failed';
  }

  async stopSpeaking(o: { quiet?: boolean } = {}): Promise<void> {
    if (this.snap.phase !== 'speaking') return;
    this.speakGen++;
    const stop = this.d.backend?.stopSpeaking;
    this.set({ phase: 'idle', speaking: null, note: null });
    if (!stop) {
      if (!o.quiet) this.set({ note: { tone: 'warn', code: 'stop-failed', text: 'This window cannot stop read-aloud; it ends when the text is finished.' } });
      return;
    }
    try {
      await stop();
    } catch (e) {
      if (!o.quiet) this.set({ note: { tone: 'warn', code: 'stop-failed', text: `Read-aloud may still be playing: ${errMsg(e)}` } });
    }
  }

  /**
   * Leaving the page, closing the bubble or unmounting: stops the microphone, discards any transcription and stops
   * read-aloud. Shows nothing. The session stays usable (React may mount the same owner again).
   */
  release(): void {
    const phase = this.snap.phase;
    this.op++;
    this.rec?.cancel();
    this.rec = null;
    this.pushLevel(0);
    if (phase === 'transcribing' && this.inflight) void this.d.backend?.cancelTranscribe?.().catch(() => undefined);
    if (phase === 'speaking') {
      this.speakGen++;
      void this.d.backend?.stopSpeaking?.().catch(() => undefined);
    }
    this.set({ phase: 'idle', listeningSince: null, speaking: null, note: null, draining: this.inflight !== null && phase === 'transcribing' ? true : this.snap.draining });
  }

  // ---- internals ----

  private settle(call: Promise<unknown>): void {
    if (this.inflight !== call) return;
    this.inflight = null;
    if (this.snap.draining) this.set({ draining: false });
  }

  private pushLevel(raw: number): void {
    const l = Number.isFinite(raw) ? Math.round(Math.min(1, Math.max(0, raw)) * 20) / 20 : 0;
    if (l === 0 && this.snap.phase !== 'listening') this.history = [];
    else {
      this.history.push(l);
      if (this.history.length > LEVEL_HISTORY) this.history.shift();
    }
    for (const fn of this.levelListeners) fn(l, this.history);
  }

  private set(patch: Partial<VoiceSnapshot>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof VoiceSnapshot)[]) if (this.snap[k] !== patch[k]) changed = true;
    if (!changed) return;
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }
}
