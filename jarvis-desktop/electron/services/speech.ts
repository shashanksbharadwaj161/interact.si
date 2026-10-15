// Local speech only: System.Speech synthesis and recognition through the native helper. No cloud STT, no WebSpeech.
import {createHash} from 'node:crypto';
import {promises as fsp} from 'node:fs';
import * as nodePath from 'node:path';
import type {Capability, Settings} from '../../src/shared/contracts';
import type {NativeAdapter} from '../native/adapter';
import {NativeError} from '../native/runner';
import {LIMITS, ValidationError, validateAudio} from './validation';

/**
 * Adapter contracts for additional LOCAL engines (for example a neural TTS or Whisper-style STT executable).
 * None is bundled. An engine is only reported when it is injected AND its own probe says it is available;
 * choosing an engine that is missing or unavailable fails honestly and never falls back to another engine.
 */
export interface LocalSpeechEngine {
  id: string;
  name: string;
  /** Self-declared quality tier. Anything not 'neural' is treated as basic. Only engines that genuinely pass probe() are ever selected. */
  quality?: 'basic' | 'neural';
  probe(): Promise<{available: boolean; reason?: string}>;
}
export interface LocalTtsEngine extends LocalSpeechEngine {
  speak(text: string, opts: {voice: string; signal: AbortSignal}): Promise<{ok: boolean; reason?: string}>;
}
export interface LocalSttEngine extends LocalSpeechEngine {
  transcribe(wav: Buffer, opts: {signal: AbortSignal}): Promise<{text: string; reason?: string}>;
}

export const WINDOWS_ENGINE = 'windows';
/** Pass as `engine` to use the best engine that is actually available, as chosen by selectEngine(). */
export const AUTO_ENGINE = 'auto';

export interface SpeechStatus {
  tts: {available: boolean; engine: string; voices: string[]; selectedVoice: string | null; selectedVoiceInstalled: boolean | null; reason?: string};
  stt: {available: boolean; engine: string; recognizers: string[]; quality: 'basic'; reason?: string};
  /** Neural dictation is gated on a probed local engine; without one the UI must say quality is basic. */
  qualityGate: {neuralStt: boolean; reason?: string};
  extraEngines: {id: string; name: string; kind: 'tts' | 'stt'; quality: 'basic' | 'neural'; available: boolean; reason?: string}[];
  speaking: boolean;
  transcribing: boolean;
  /** Always false: there is no cloud speech path. */
  cloud: false;
}

export interface SpeechDeps {
  native: Pick<NativeAdapter, 'speak' | 'transcribe' | 'probeSpeech'>;
  /** Optional extra local engines. The built-in Windows engine id is 'windows'. */
  engines?: {tts?: LocalTtsEngine[]; stt?: LocalSttEngine[]};
  settings: () => Settings;
  tmpDir: string;
  newId: () => string;
  writeFile?: (p: string, data: Buffer) => Promise<void>;
  removeFile?: (p: string) => Promise<void>;
  now?: () => number;
  /**
   * Service-side audio bounds checked before any recognizer or temp file is touched. Off unless supplied
   * (`true` uses the defaults), because the renderer already trims and checks clips; enable it for defence in depth.
   */
  audioGate?: boolean | AudioGate;
  /** Hard wall-clock limit for one transcription. Default 60 s. */
  transcribeTimeoutMs?: number;
}

export interface AudioGate {
  minMs?: number;
  maxMs?: number;
  /** Peak amplitude below this fraction of full scale counts as silence. */
  minPeak?: number;
}

export const DEFAULT_AUDIO_GATE: Required<AudioGate> = {minMs: 300, maxMs: 30_000, minPeak: 0.01};
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 60_000;

export type WavInfo = {ok: true; sampleRate: number; channels: number; durationMs: number; peak: number} | {ok: false; reason: string};

/** Reads a PCM16 WAV buffer (chunk-walking, tolerant of streaming sizes) and measures length and peak level. Pure. */
export function inspectWav(buf: Buffer): WavInfo {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return {ok: false, reason: 'Audio is not a WAV file'};
  let off = 12;
  let fmt: {channels: number; rate: number; bits: number} | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14)};
    } else if (id === 'data') {
      if (!fmt) return {ok: false, reason: 'WAV header is incomplete'};
      if (fmt.bits !== 16 || fmt.channels < 1 || fmt.rate < 8000) return {ok: false, reason: 'Only 16-bit PCM audio at 8 kHz or higher is supported'};
      const bytes = Math.min(size, buf.length - body) & ~1;
      let peak = 0;
      for (let i = 0; i < bytes; i += 2) {
        const a = Math.abs(buf.readInt16LE(body + i));
        if (a > peak) peak = a;
      }
      return {ok: true, sampleRate: fmt.rate, channels: fmt.channels, durationMs: Math.round((bytes / 2 / fmt.channels / fmt.rate) * 1000), peak: Math.min(1, peak / 32768)};
    }
    off = body + size + (size & 1);
  }
  return {ok: false, reason: 'WAV contains no audio data'};
}

/** Why a clip should not reach a recognizer, or null when it is acceptable. */
export function audioGateReason(wav: Buffer, gate: AudioGate = {}): string | null {
  const g = {...DEFAULT_AUDIO_GATE, ...gate};
  const info = inspectWav(wav);
  if (!info.ok) return info.reason;
  if (info.durationMs < g.minMs) return 'The recording is too short to recognize. Hold the button while you speak';
  if (info.durationMs > g.maxMs) return `The recording is longer than ${Math.round(g.maxMs / 1000)} seconds`;
  if (info.peak < g.minPeak) return 'No sound was picked up in the recording';
  return null;
}

export type SpeechProbe = {ok: true; voices: string[]; recognizers: string[]} | {ok: false; reason: string};

export class Speech {
  private current: AbortController | null = null;
  private transcribing: AbortController | null = null;
  private probeCache: {at: number; value: SpeechProbe} | null = null;
  private now: () => number;

  constructor(private d: SpeechDeps) {
    this.now = d.now ?? Date.now;
  }

  async probe(force = false): Promise<SpeechProbe> {
    if (!force && this.probeCache && this.now() - this.probeCache.at < 30_000) return this.probeCache.value;
    let value: SpeechProbe;
    try {
      const r = await this.d.native.probeSpeech();
      value = {ok: true, voices: r.voices, recognizers: r.recognizers};
    } catch (e) {
      value = {ok: false, reason: `Windows speech could not be queried: ${(e as Error).message}`};
    }
    this.probeCache = {at: this.now(), value};
    return value;
  }

  async capabilities(): Promise<Capability[]> {
    const p = await this.probe();
    if (!p.ok) {
      return [
        {id: 'tts', name: 'Text to speech (Windows)', available: false, reason: p.reason},
        {id: 'stt', name: 'Speech recognition (Windows, basic)', available: false, reason: p.reason},
      ];
    }
    return [
      !p.voices.length ? {id: 'tts', name: 'Text to speech (Windows)', available: false, reason: 'No Windows voices are installed'}
        : this.d.settings().voice && !p.voices.includes(this.d.settings().voice) ? {id: 'tts', name: 'Text to speech (Windows)', available: false, reason: `Selected voice "${this.d.settings().voice}" is not installed. Choose an installed voice or clear the setting`}
        : {id: 'tts', name: 'Text to speech (Windows)', available: true},
      p.recognizers.length
        ? {id: 'stt', name: 'Speech recognition (Windows, basic)', available: true, reason: `Local recognizer(s): ${p.recognizers.join(', ')}. Dictation quality is basic.`}
        : {id: 'stt', name: 'Speech recognition (Windows, basic)', available: false, reason: 'No Windows speech recognizer is installed'},
    ];
  }

  private async probeEngine(e: LocalSpeechEngine): Promise<{available: boolean; reason?: string}> {
    try {
      const r = await e.probe();
      return r.available ? {available: true} : {available: false, reason: r.reason ?? 'The engine reported it is unavailable'};
    } catch (err) { return {available: false, reason: `Engine probe failed: ${(err as Error).message}`}; }
  }

  /** Structured state for the UI: what exists, what is selected, and whether the selection can work. Local only; no cloud engine exists. */
  async status(): Promise<SpeechStatus> {
    const p = await this.probe();
    const voice = this.d.settings().voice;
    const tts: SpeechStatus['tts'] = {available: false, engine: WINDOWS_ENGINE, voices: [], selectedVoice: voice || null, selectedVoiceInstalled: null};
    const stt: SpeechStatus['stt'] = {available: false, engine: WINDOWS_ENGINE, recognizers: [], quality: 'basic'};
    if (!p.ok) {
      tts.reason = p.reason;
      stt.reason = p.reason;
    } else {
      tts.voices = p.voices;
      tts.available = p.voices.length > 0;
      if (!tts.available) tts.reason = 'No Windows voices are installed';
      else if (voice) {
        tts.selectedVoiceInstalled = p.voices.includes(voice);
        if (!tts.selectedVoiceInstalled) {
          tts.available = false;
          tts.reason = `Selected voice "${voice}" is not installed. Choose an installed voice or clear the setting to use the Windows default`;
        }
      }
      stt.recognizers = p.recognizers;
      stt.available = p.recognizers.length > 0;
      if (!stt.available) stt.reason = 'No Windows speech recognizer is installed';
    }
    const extraEngines: SpeechStatus['extraEngines'] = [];
    for (const e of this.d.engines?.tts ?? []) extraEngines.push({id: e.id, name: e.name, kind: 'tts', quality: e.quality ?? 'basic', ...(await this.probeEngine(e))});
    for (const e of this.d.engines?.stt ?? []) extraEngines.push({id: e.id, name: e.name, kind: 'stt', quality: e.quality ?? 'basic', ...(await this.probeEngine(e))});
    const neural = extraEngines.filter((e) => e.kind === 'stt' && e.quality === 'neural');
    const qualityGate: SpeechStatus['qualityGate'] = neural.some((e) => e.available)
      ? {neuralStt: true}
      : {neuralStt: false, reason: neural.length
        ? `The configured local neural model is unavailable: ${neural.map((e) => `${e.name}: ${e.reason}`).join('; ')}. Dictation quality is basic`
        : 'No local neural speech model is configured, so dictation uses the basic Windows recognizer. Configure a local Whisper-style executable and model to raise quality'};
    return {tts, stt, qualityGate, extraEngines, speaking: this.current !== null, transcribing: this.transcribing !== null, cloud: false};
  }

  /**
   * Which local engine would actually be used right now. Only engines that exist AND probe as available are candidates;
   * null means none can work, with the reason. Nothing is ever reported as installed that was not probed.
   * STT preference: available neural engine, then the Windows recognizer, then any other available local engine.
   */
  async selectEngine(kind: 'stt' | 'tts'): Promise<{engine: string | null; name: string | null; quality: 'basic' | 'neural' | null; reason?: string}> {
    const st = await this.status();
    const extras = st.extraEngines.filter((e) => e.kind === kind);
    const windows = kind === 'stt' ? st.stt : st.tts;
    const win = windows.available ? {engine: WINDOWS_ENGINE, name: 'Windows speech', quality: 'basic' as const} : null;
    const asChoice = (e: (typeof extras)[number] | undefined) => (e && e.available ? {engine: e.id, name: e.name, quality: e.quality} : null);
    const neural = kind === 'stt' ? asChoice(extras.find((e) => e.quality === 'neural' && e.available)) : null;
    const chosen = neural ?? win ?? asChoice(extras.find((e) => e.available));
    if (chosen) return chosen;
    const reasons = [windows.reason, ...extras.map((e) => (e.reason ? `${e.name}: ${e.reason}` : ''))].filter(Boolean);
    return {engine: null, name: null, quality: null, reason: reasons.join('; ') || 'No local speech engine is available'};
  }

  /** One-call summary for the voice UI: chosen engines, the neural quality gate, and that nothing is cloud. */
  async health(): Promise<{stt: Awaited<ReturnType<Speech['selectEngine']>>; tts: Awaited<ReturnType<Speech['selectEngine']>>; qualityGate: SpeechStatus['qualityGate']; speaking: boolean; transcribing: boolean; cloud: false}> {
    const [stt, tts, st] = await Promise.all([this.selectEngine('stt'), this.selectEngine('tts'), this.status()]);
    return {stt, tts, qualityGate: st.qualityGate, speaking: st.speaking, transcribing: st.transcribing, cloud: false};
  }

  cancel(): boolean {
    const had = this.current !== null;
    this.current?.abort();
    this.current = null;
    return had;
  }

  /** Stops an in-flight transcription from returning text. The native helper may keep running until its own timeout. */
  cancelTranscribe(): boolean {
    const had = this.transcribing !== null;
    this.transcribing?.abort();
    return had;
  }

  async speak(text: unknown, opts: {engine?: string} = {}): Promise<{ok: boolean; reason?: string}> {
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError('text is required');
    if (text.length > LIMITS.speakChars) throw new ValidationError(`text is too long (max ${LIMITS.speakChars})`);
    let engineId = opts.engine ?? WINDOWS_ENGINE;
    if (engineId === AUTO_ENGINE) {
      const sel = await this.selectEngine('tts');
      if (!sel.engine) return {ok: false, reason: sel.reason ?? 'No local speech engine is available'};
      engineId = sel.engine;
    }
    const voice = this.d.settings().voice;
    const extra = engineId === WINDOWS_ENGINE ? null : (this.d.engines?.tts ?? []).find((e) => e.id === engineId) ?? null;
    if (engineId !== WINDOWS_ENGINE) {
      if (!extra) return {ok: false, reason: `Speech engine "${engineId.slice(0, 40)}" is not available`};
      const pr = await this.probeEngine(extra);
      if (!pr.available) return {ok: false, reason: `${extra.name} is unavailable: ${pr.reason}`};
    } else {
      const p = await this.probe();
      if (p.ok && !p.voices.length) return {ok: false, reason: 'No Windows voices are installed'};
      if (p.ok && voice && !p.voices.includes(voice)) return {ok: false, reason: `Selected voice "${voice}" is not installed. Choose an installed voice or clear the setting to use the Windows default`};
    }
    this.cancel();
    const ac = new AbortController();
    this.current = ac;
    try {
      const r = extra ? await extra.speak(text, {voice, signal: ac.signal}) : await this.d.native.speak(text, voice, ac.signal);
      return ac.signal.aborted ? {ok: false, reason: 'Speech was stopped'} : r;
    } catch (e) {
      if ((e instanceof NativeError && e.kind === 'cancelled') || ac.signal.aborted) return {ok: false, reason: 'Superseded by newer speech'};
      return {ok: false, reason: (e as Error).message};
    } finally {
      if (this.current === ac) this.current = null;
    }
  }

  async transcribe(audio: unknown, opts: {engine?: string} = {}): Promise<{text: string; reason?: string; cancelled?: boolean}> {
    const wav = validateAudio(audio);
    const gate = this.d.audioGate;
    if (gate) {
      const why = audioGateReason(wav, gate === true ? {} : gate);
      if (why) return {text: '', reason: why};
    }
    if (this.transcribing) return {text: '', reason: 'Another transcription is already running'};
    let engineId = opts.engine ?? WINDOWS_ENGINE;
    if (engineId === AUTO_ENGINE) {
      const sel = await this.selectEngine('stt');
      if (!sel.engine) return {text: '', reason: sel.reason ?? 'No local speech engine is available'};
      engineId = sel.engine;
    }
    const extra = engineId === WINDOWS_ENGINE ? null : (this.d.engines?.stt ?? []).find((e) => e.id === engineId) ?? null;
    if (engineId !== WINDOWS_ENGINE) {
      if (!extra) return {text: '', reason: `Speech engine "${engineId.slice(0, 40)}" is not available`};
      const pr = await this.probeEngine(extra);
      if (!pr.available) return {text: '', reason: `${extra.name} is unavailable: ${pr.reason}`};
    } else {
      const p = await this.probe();
      if (!p.ok) return {text: '', reason: p.reason};
      if (!p.recognizers.length) return {text: '', reason: 'No Windows speech recognizer is installed'};
    }
    // Re-check: probing is async and another call may have started meanwhile.
    if (this.transcribing) return {text: '', reason: 'Another transcription is already running'};
    const ac = new AbortController();
    this.transcribing = ac;
    const timeoutMs = this.d.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS;
    let timedOut = false;
    let onTimeout: (v: typeof ABORTED) => void = () => undefined;
    const timeout = new Promise<typeof ABORTED>((resolve) => { onTimeout = resolve; });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); onTimeout(ABORTED); }, timeoutMs);
    const aborted = new Promise<typeof ABORTED>((resolve) => ac.signal.addEventListener('abort', () => resolve(ABORTED), {once: true}));
    const stopped = () => (timedOut
      ? {text: '', reason: `Transcription timed out after ${Math.round(timeoutMs / 1000)} seconds`}
      : {text: '', cancelled: true, reason: 'Transcription was cancelled'});
    const pack = (r: {text: string; reason?: string}) => (r.reason ? {text: r.text, reason: r.reason} : {text: r.text});
    try {
      if (extra) {
        const work = extra.transcribe(wav, {signal: ac.signal});
        work.catch(() => undefined);
        const r = await Promise.race([work, aborted]);
        return r === ABORTED || ac.signal.aborted ? stopped() : pack(r);
      }
      const file = nodePath.win32.join(this.d.tmpDir, `jarvis-${this.d.newId()}.wav`);
      const write = this.d.writeFile ?? ((f, b) => fsp.writeFile(f, b, {mode: 0o600, flag: 'wx'}));
      const remove = this.d.removeFile ?? ((f) => fsp.rm(f, {force: true}));
      try {
        await write(file, wav);
      } catch (e) {
        await remove(file).catch(() => undefined);
        throw e;
      }
      // The native helper cannot be aborted, so a user cancel waits for it (it has its own timeout) and then reports cancelled.
      // Only the wall-clock limit stops waiting early, and the temp file is deleted once the helper has really settled.
      const work = Promise.resolve().then(() => this.d.native.transcribe(file)).finally(() => remove(file).catch(() => undefined));
      work.catch(() => undefined);
      const r = await Promise.race([work, timeout]);
      return r === ABORTED || ac.signal.aborted ? stopped() : pack(r);
    } catch (e) {
      return ac.signal.aborted ? stopped() : {text: '', reason: (e as Error).message};
    } finally {
      clearTimeout(timer);
      if (this.transcribing === ac) this.transcribing = null;
    }
  }
}

const ABORTED = Symbol('aborted');

// ---------------------------------------------------------------------------------------------
// Optional local Whisper-style STT adapter. Original code; it only *runs a user-provided local executable*.
// Nothing here is bundled or downloaded, no shell is used, and with no configuration no engine exists.
// ---------------------------------------------------------------------------------------------

export interface ExecResult {code: number | null; stdout: string; stderr: string; timedOut: boolean}
/** Host-provided process runner (argv array, never a shell). Without one, configured engines report unavailable. */
export type ExecRunner = (file: string, args: string[], opts: {timeoutMs: number; signal: AbortSignal; maxOutputBytes: number}) => Promise<ExecResult>;

export interface WhisperCliConfig {
  id: string;
  name: string;
  /** Absolute local path to a .exe on a drive letter. UNC, device, relative and traversal paths are rejected. */
  executable: string;
  /** Absolute local path to the model file (.bin, .gguf or .onnx). */
  model: string;
  /** 'auto' or a 2-3 letter language code. */
  language?: string;
  threads?: number;
  timeoutMs: number;
  /** Optional lowercase SHA-256 pin of the executable; a mismatch makes the engine unavailable. */
  sha256?: string;
}

export interface LocalEngineDeps {
  exec?: ExecRunner;
  stat?: (p: string) => Promise<{isFile: boolean; size: number}>;
  readHead?: (p: string, n: number) => Promise<Buffer>;
  readFile?: (p: string) => Promise<Buffer>;
  tmpDir: string;
  newId: () => string;
  writeFile?: (p: string, data: Buffer) => Promise<void>;
  removeFile?: (p: string) => Promise<void>;
}

const DEFAULT_ADAPTER_TIMEOUT_MS = 55_000;
const MAX_ADAPTER_OUTPUT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_CHARS = 8000;
const RESERVED_IDS = new Set([WINDOWS_ENGINE, AUTO_ENGINE]);
const MODEL_EXTS = ['.bin', '.gguf', '.onnx'] as const;

/** Strict contract for a configured local path. Returns the path or the reason it is refused. */
export function checkLocalPath(raw: unknown, label: string, exts: readonly string[], forbiddenRoots: readonly string[] = []): {ok: true; path: string} | {ok: false; reason: string} {
  if (typeof raw !== 'string' || raw.length < 4 || raw.length > 260) return {ok: false, reason: `${label} must be an absolute local path`};
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f"<>|*?%^&;`$]/.test(raw)) return {ok: false, reason: `${label} contains characters that are not allowed`};
  if (!/^[A-Za-z]:\\/.test(raw)) return {ok: false, reason: `${label} must start with a drive letter like C:\\ (network, device and relative paths are refused)`};
  if (raw.slice(2).includes(':')) return {ok: false, reason: `${label} contains a stream or device marker`};
  if (nodePath.win32.normalize(raw) !== raw || raw.split('\\').some((seg) => seg === '..' || seg === '.')) return {ok: false, reason: `${label} must be a normalized path without . or .. segments`};
  const ext = nodePath.win32.extname(raw).toLowerCase();
  if (!exts.includes(ext)) return {ok: false, reason: `${label} must end in ${exts.join(' or ')}`};
  const lower = raw.toLowerCase();
  for (const root of forbiddenRoots) {
    const r = root.toLowerCase().replace(/\\+$/, '');
    if (r && (lower === r || lower.startsWith(`${r}\\`))) return {ok: false, reason: `${label} may not be inside the temporary folder`};
  }
  return {ok: true, path: raw};
}

/**
 * Validates untrusted configuration into engine configs. Invalid entries are dropped with a reason; nothing is probed or run here.
 * Shape: {stt: [{kind: 'whisper-cli', id?, name?, executable, model, language?, threads?, timeoutMs?, sha256?}]}.
 */
export function parseLocalSpeechConfig(raw: unknown, tmpDir = ''): {stt: WhisperCliConfig[]; problems: string[]} {
  const stt: WhisperCliConfig[] = [];
  const problems: string[] = [];
  const list = raw && typeof raw === 'object' ? (raw as {stt?: unknown}).stt : undefined;
  if (list === undefined) return {stt, problems};
  if (!Array.isArray(list)) return {stt, problems: ['stt must be a list of engines']};
  const forbidden = tmpDir ? [tmpDir] : [];
  list.slice(0, 4).forEach((e, i) => {
    const at = `stt[${i}]`;
    if (!e || typeof e !== 'object') { problems.push(`${at} must be an object`); return; }
    const c = e as Record<string, unknown>;
    if (c.kind !== 'whisper-cli') { problems.push(`${at}.kind must be "whisper-cli"`); return; }
    const id = c.id === undefined ? `whisper-cli-${i + 1}` : c.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || RESERVED_IDS.has(id)) { problems.push(`${at}.id must be 1-32 lowercase letters, digits or dashes and not reserved`); return; }
    if (stt.some((x) => x.id === id)) { problems.push(`${at}.id "${id}" is duplicated`); return; }
    const exe = checkLocalPath(c.executable, `${at}.executable`, ['.exe'], forbidden);
    if (!exe.ok) { problems.push(exe.reason); return; }
    const model = checkLocalPath(c.model, `${at}.model`, MODEL_EXTS, forbidden);
    if (!model.ok) { problems.push(model.reason); return; }
    if (c.language !== undefined && (typeof c.language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(c.language))) { problems.push(`${at}.language must be "auto" or a 2-3 letter code`); return; }
    if (c.threads !== undefined && (!Number.isInteger(c.threads) || (c.threads as number) < 1 || (c.threads as number) > 16)) { problems.push(`${at}.threads must be 1-16`); return; }
    if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || (c.timeoutMs as number) < 5_000 || (c.timeoutMs as number) > 300_000)) { problems.push(`${at}.timeoutMs must be 5000-300000`); return; }
    if (c.sha256 !== undefined && (typeof c.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(c.sha256))) { problems.push(`${at}.sha256 must be 64 lowercase hex characters`); return; }
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 60) : 'Local Whisper-style recognizer';
    stt.push({id, name, executable: exe.path, model: model.path, language: c.language as string | undefined, threads: c.threads as number | undefined, timeoutMs: (c.timeoutMs as number | undefined) ?? DEFAULT_ADAPTER_TIMEOUT_MS, sha256: c.sha256 as string | undefined});
  });
  if (list.length > 4) problems.push('Only the first 4 engines are used');
  return {stt, problems};
}

/** Reduces whisper-style stdout to plain text: drops timestamp prefixes and bracketed markers, collapses whitespace, caps length. */
export function cleanTranscript(out: string): string {
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\[\d{1,2}:\d{2}[:.\d]*\s*-->\s*[\d:.]+\]\s*/, '').trim())
    .filter((l) => l && !/^\[[A-Z_ ]+\]$/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * Engine for a whisper.cpp-compatible command line: `<exe> -m <model> -f <wav> -nt -np [-l <lang>] [-t <n>]`, transcript on stdout.
 * probe() only inspects files (never executes): the executable must be a real PE file, the model a non-empty file,
 * the SHA-256 pin (if any) must match, and the host must have supplied a process runner. Quality is declared 'neural'
 * because the model is user-provided; the app does not verify what the model actually is.
 */
export function createWhisperCliEngine(cfg: WhisperCliConfig, d: LocalEngineDeps): LocalSttEngine {
  const stat = d.stat ?? (async (p) => { const st = await fsp.stat(p); return {isFile: st.isFile(), size: st.size}; });
  const readHead = d.readHead ?? (async (p, n) => { const h = await fsp.open(p, 'r'); try { const b = Buffer.alloc(n); const {bytesRead} = await h.read(b, 0, n, 0); return b.subarray(0, bytesRead); } finally { await h.close(); } });
  const readFile = d.readFile ?? ((p) => fsp.readFile(p));
  let pinned: boolean | null = null;
  const forbidden = d.tmpDir ? [d.tmpDir] : [];
  const contract = (): string | null => {
    const exe = checkLocalPath(cfg.executable, 'executable', ['.exe'], forbidden);
    if (!exe.ok) return exe.reason;
    const model = checkLocalPath(cfg.model, 'model', MODEL_EXTS, forbidden);
    return model.ok ? null : model.reason;
  };
  return {
    id: cfg.id,
    name: cfg.name,
    quality: 'neural',
    async probe() {
      const bad = contract();
      if (bad) return {available: false, reason: bad};
      if (!d.exec) return {available: false, reason: 'The app was not given a process runner for local engines'};
      try {
        const exe = await stat(cfg.executable);
        if (!exe.isFile || exe.size < 1024) return {available: false, reason: 'The recognizer executable was not found'};
        const head = await readHead(cfg.executable, 2);
        if (head.length < 2 || head[0] !== 0x4d || head[1] !== 0x5a) return {available: false, reason: 'The recognizer file is not a Windows executable'};
        const model = await stat(cfg.model);
        if (!model.isFile || model.size < 1) return {available: false, reason: 'The model file was not found or is empty'};
        if (cfg.sha256) {
          if (pinned === null) pinned = createHash('sha256').update(await readFile(cfg.executable)).digest('hex') === cfg.sha256;
          if (!pinned) return {available: false, reason: 'The recognizer executable does not match its pinned SHA-256'};
        }
        return {available: true};
      } catch {
        return {available: false, reason: 'The recognizer executable or model could not be read'};
      }
    },
    async transcribe(wav, {signal}) {
      const bad = contract();
      if (bad) return {text: '', reason: bad};
      if (!d.exec) return {text: '', reason: 'The app was not given a process runner for local engines'};
      const file = nodePath.win32.join(d.tmpDir, `jarvis-${d.newId()}.wav`);
      const write = d.writeFile ?? ((f, b) => fsp.writeFile(f, b, {mode: 0o600, flag: 'wx'}));
      const remove = d.removeFile ?? ((f) => fsp.rm(f, {force: true}));
      const args = ['-m', cfg.model, '-f', file, '-nt', '-np', ...(cfg.language ? ['-l', cfg.language] : []), ...(cfg.threads ? ['-t', String(cfg.threads)] : [])];
      try {
        await write(file, wav);
        const r = await d.exec(cfg.executable, args, {timeoutMs: cfg.timeoutMs, signal, maxOutputBytes: MAX_ADAPTER_OUTPUT_BYTES});
        if (signal.aborted) return {text: '', reason: 'Transcription was cancelled'};
        if (r.timedOut) return {text: '', reason: `${cfg.name} timed out after ${Math.round(cfg.timeoutMs / 1000)} seconds`};
        if (r.code !== 0) return {text: '', reason: `${cfg.name} exited with code ${r.code ?? 'unknown'}`};
        const text = cleanTranscript(r.stdout);
        return text ? {text} : {text: '', reason: 'No speech was recognized'};
      } catch (e) {
        return {text: '', reason: `${cfg.name} failed: ${(e as Error).message.slice(0, 200)}`};
      } finally {
        await remove(file).catch(() => undefined);
      }
    },
  };
}

/** Config → engines. The host passes `engines` into SpeechDeps; `problems` should be shown to the user, not swallowed. */
export function buildLocalEngines(raw: unknown, d: LocalEngineDeps): {engines: {stt: LocalSttEngine[]}; problems: string[]} {
  const parsed = parseLocalSpeechConfig(raw, d.tmpDir);
  return {engines: {stt: parsed.stt.map((c) => createWhisperCliEngine(c, d))}, problems: parsed.problems};
}
