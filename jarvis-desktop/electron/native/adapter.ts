// Typed facade over the PowerShell scripts. Services depend on this interface so tests can mock it
// and never touch the real desktop.
import type {NativeRunner} from './runner';

export interface WindowInfo {
  hwnd: number; title: string; pid: number; process: string;
  x: number; y: number; width: number; height: number;
  minimized: boolean; maximized: boolean; foreground: boolean;
  /** 1 elevated, 0 not elevated, -1 unknown/protected */
  elevated: number;
}
export interface WindowRef { hwnd: number; pid: number }
export interface Rect { x: number; y: number; width: number; height: number }

export interface NativeAdapter {
  listWindows(): Promise<WindowInfo[]>;
  focusWindow(w: WindowRef): Promise<{focused: boolean}>;
  moveWindow(w: WindowRef, rect: Rect): Promise<Rect & {clamped: boolean}>;
  typeText(w: WindowRef, text: string): Promise<{typed: number}>;
  click(w: WindowRef, x: number, y: number): Promise<void>;
  probeSpeech(): Promise<{voices: string[]; recognizers: string[]}>;
  speak(text: string, voice: string, signal?: AbortSignal): Promise<{ok: boolean; reason?: string}>;
  transcribe(wavPath: string): Promise<{text: string; reason?: string}>;
  dpapi(op: 'probe' | 'protect' | 'unprotect', data?: string): Promise<{ok: boolean; data?: string}>;
}

type Res = {ok: boolean; error?: string; reason?: string} & Record<string, unknown>;

/** Keyboard input that stopped after some characters were already sent; `typed` says how many. */
export class InputStoppedError extends Error {
  constructor(message: string, readonly typed: number) {
    super(message);
    this.name = 'InputStoppedError';
  }
}

function need(r: Res): Res {
  if (!r.ok) throw new Error(String(r.error ?? r.reason ?? 'Native helper failed'));
  return r;
}

export function createNativeAdapter(runner: NativeRunner): NativeAdapter {
  return {
    async listWindows() {
      const r = need(await runner.run<Res>('list-windows', {}, {timeoutMs: 20_000}));
      return (r.windows as WindowInfo[] | undefined ?? []).map((w) => ({
        hwnd: Number(w.hwnd), title: String(w.title), pid: Number(w.pid), process: String(w.process),
        x: Number(w.x), y: Number(w.y), width: Number(w.width), height: Number(w.height),
        minimized: !!w.minimized, maximized: !!w.maximized, foreground: !!w.foreground, elevated: Number(w.elevated),
      }));
    },
    async focusWindow(w) {
      const r = need(await runner.run<Res>('focus-window', w));
      return {focused: !!r.focused};
    },
    async moveWindow(w, rect) {
      const r = need(await runner.run<Res>('move-window', {...w, ...rect}));
      return {x: Number(r.x), y: Number(r.y), width: Number(r.width), height: Number(r.height), clamped: !!r.clamped};
    },
    async typeText(w, text) {
      const r = await runner.run<Res>('type-text', {...w, text}, {timeoutMs: 30_000});
      // Typing that stopped part-way (focus left the window) reports how much was already typed.
      if (!r.ok && typeof r.typed === 'number' && r.typed > 0) throw new InputStoppedError(String(r.error ?? 'Typing stopped'), r.typed);
      return {typed: Number(need(r).typed ?? 0)};
    },
    async click(w, x, y) {
      need(await runner.run<Res>('click', {...w, x, y}));
    },
    async probeSpeech() {
      const r = need(await runner.run<Res>('probe-speech', {}, {timeoutMs: 20_000}));
      return {voices: (r.voices as string[] | undefined) ?? [], recognizers: (r.recognizers as string[] | undefined) ?? []};
    },
    async speak(text, voice, signal) {
      const r = await runner.run<Res>('speak', {text, voice}, {timeoutMs: 60_000, signal});
      return r.ok ? {ok: true} : {ok: false, reason: String(r.reason ?? r.error ?? 'Speech failed')};
    },
    async transcribe(wavPath) {
      const r = await runner.run<Res>('transcribe', {wavPath}, {timeoutMs: 60_000});
      if (!r.ok) throw new Error(String(r.reason ?? r.error ?? 'Transcription failed'));
      return {text: String(r.text ?? ''), reason: r.reason ? String(r.reason) : undefined};
    },
    async dpapi(op, data) {
      const r = await runner.run<Res>('dpapi', {op, data}, {timeoutMs: 20_000});
      return {ok: !!r.ok, data: typeof r.data === 'string' ? r.data : undefined};
    },
  };
}
