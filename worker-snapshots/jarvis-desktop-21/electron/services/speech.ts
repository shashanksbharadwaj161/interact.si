// Local speech only: System.Speech synthesis and recognition through the native helper. No cloud STT, no WebSpeech.
import {promises as fsp} from 'node:fs';
import * as nodePath from 'node:path';
import type {Capability, Settings} from '../../src/shared/contracts';
import type {NativeAdapter} from '../native/adapter';
import {NativeError} from '../native/runner';
import {LIMITS, ValidationError, validateAudio} from './validation';

export interface SpeechDeps {
  native: Pick<NativeAdapter, 'speak' | 'transcribe' | 'probeSpeech'>;
  settings: () => Settings;
  tmpDir: string;
  newId: () => string;
  writeFile?: (p: string, data: Buffer) => Promise<void>;
  removeFile?: (p: string) => Promise<void>;
  now?: () => number;
}

export type SpeechProbe = {ok: true; voices: string[]; recognizers: string[]} | {ok: false; reason: string};

export class Speech {
  private current: AbortController | null = null;
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
      p.voices.length ? {id: 'tts', name: 'Text to speech (Windows)', available: true} : {id: 'tts', name: 'Text to speech (Windows)', available: false, reason: 'No Windows voices are installed'},
      p.recognizers.length
        ? {id: 'stt', name: 'Speech recognition (Windows, basic)', available: true, reason: `Local recognizer(s): ${p.recognizers.join(', ')}. Dictation quality is basic.`}
        : {id: 'stt', name: 'Speech recognition (Windows, basic)', available: false, reason: 'No Windows speech recognizer is installed'},
    ];
  }

  cancel(): void {
    this.current?.abort();
    this.current = null;
  }

  async speak(text: unknown): Promise<{ok: boolean; reason?: string}> {
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError('text is required');
    if (text.length > LIMITS.speakChars) throw new ValidationError(`text is too long (max ${LIMITS.speakChars})`);
    this.cancel();
    const ac = new AbortController();
    this.current = ac;
    try {
      return await this.d.native.speak(text, this.d.settings().voice, ac.signal);
    } catch (e) {
      if (e instanceof NativeError && e.kind === 'cancelled') return {ok: false, reason: 'Superseded by newer speech'};
      return {ok: false, reason: (e as Error).message};
    } finally {
      if (this.current === ac) this.current = null;
    }
  }

  async transcribe(audio: unknown): Promise<{text: string; reason?: string}> {
    const wav = validateAudio(audio);
    const p = await this.probe();
    if (!p.ok) return {text: '', reason: p.reason};
    if (!p.recognizers.length) return {text: '', reason: 'No Windows speech recognizer is installed'};
    const file = nodePath.win32.join(this.d.tmpDir, `jarvis-${this.d.newId()}.wav`);
    const write = this.d.writeFile ?? ((f, b) => fsp.writeFile(f, b, {mode: 0o600, flag: 'wx'}));
    const remove = this.d.removeFile ?? ((f) => fsp.rm(f, {force: true}));
    try {
      await write(file, wav);
      const r = await this.d.native.transcribe(file);
      return r.reason ? {text: r.text, reason: r.reason} : {text: r.text};
    } catch (e) {
      return {text: '', reason: (e as Error).message};
    } finally {
      await remove(file).catch(() => undefined);
    }
  }
}
