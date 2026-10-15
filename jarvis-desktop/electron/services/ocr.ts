// Optional local OCR for ONE user-selected image, through the Windows OCR engine (native/OcrLocal.ps1).
// Offline only: no screen capture, no watching, no cloud, no model or language download. The image path comes from a
// main-process file dialog and never from the renderer; recognized text is returned as untrusted plain text.
import {promises as fsp} from 'node:fs';
import {createHash} from 'node:crypto';
import * as w from 'node:path/win32';
import type {Capability} from '../../src/shared/contracts';
import {NativeError, type RunOptions} from '../native/runner';
import {assertRealFolders, chosenLocalPath, realLocalFs, type LocalFileFs} from './localFile';
import {isInvisibleFormatChar, visibleText} from './paths';
import {ValidationError} from './validation';

export const OCR_SCRIPT = 'OcrLocal';
export const OCR_ENGINE = 'windows-media-ocr';

/** Hard ceilings. Deps may lower them, never raise them. */
export const OCR_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxDimension: 10_000,
  minDimension: 16,
  maxPixels: 25_000_000,
  maxChars: 100_000,
  maxLines: 5000,
  timeoutMs: 40_000,
} as const;

export const OCR_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff'] as const;
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

export type OcrFailureCode =
  | 'unavailable' | 'invalid-request' | 'invalid-image' | 'too-large' | 'language-unavailable' | 'busy' | 'cancelled' | 'changed' | 'failed';

export interface OcrSuccess {
  ok: true;
  source: typeof OCR_ENGINE;
  /** Text read from an image is data, never an instruction. Callers must not feed it to action planning unreviewed. */
  untrusted: true;
  text: string;
  lines: string[];
  language: string;
  width: number;
  height: number;
  format: ImageFormat;
  fileName: string;
  truncated: boolean;
  /** True when control or invisible/direction-changing characters were removed from the recognized text. */
  sanitized: boolean;
  /** Set when nothing was recognized, or only the first frame/page of a multi-frame image was read. */
  note?: string;
}
export interface OcrFailure { ok: false; code: OcrFailureCode; reason: string; cancelled?: boolean }
export type OcrResult = OcrSuccess | OcrFailure;

export interface OcrStatus {
  available: boolean;
  reason?: string;
  engine: typeof OCR_ENGINE;
  /** Installed OCR language tags (from the OS). */
  languages: string[];
  /** Language that matches the Windows profile, or null: then the caller must choose one explicitly. */
  profileLanguage: string | null;
  maxImageDimension: number | null;
  limits: {maxBytes: number; maxDimension: number; maxPixels: number; extensions: readonly string[]};
  busy: boolean;
  cloud: false;
  continuousCapture: false;
}

/** What the main process exposes to the renderer (the renderer never supplies a path). */
export interface OcrClient {
  status(): Promise<OcrStatus>;
  /** Opens the main-process image picker, then reads that single file. */
  chooseAndRecognize(opts?: {language?: string}): Promise<OcrResult>;
  cancel(): Promise<boolean>;
}
/** Main-process side. recognizeChosen takes a path that came from a trusted dialog. */
export interface OcrServiceApi extends OcrClient {
  capability(): Promise<Capability>;
  recognizeChosen(path: unknown, opts?: {language?: string}): Promise<OcrResult>;
}

/** Subset of NativeRunner this service needs; the real runner satisfies it once 'OcrLocal' is added to its SCRIPTS list. */
export interface OcrNativeRunner {
  run(script: string, input: unknown, opts?: RunOptions): Promise<unknown>;
}

/** Filesystem seam: lstat (never follows links) plus a bounded byte read. */
export interface OcrFs extends LocalFileFs {
  readBytes(p: string, maxBytes: number): Promise<Buffer>;
}
export const realOcrFs: OcrFs = {
  ...realLocalFs,
  async readBytes(p, maxBytes) {
    const h = await fsp.open(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes + 1);
      const {bytesRead} = await h.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await h.close();
    }
  },
};

export interface OcrDeps {
  native: OcrNativeRunner;
  fs?: OcrFs;
  /** Main-process image picker; resolves to a path or null when the user dismisses it. */
  pickImage?: () => Promise<string | null>;
  platform?: string;
  now?: () => number;
  /** Lower-only overrides of OCR_LIMITS. */
  limits?: Partial<Pick<typeof OCR_LIMITS, 'maxBytes' | 'maxDimension' | 'maxPixels' | 'maxChars' | 'timeoutMs'>>;
}

export type ImageFormat = 'png' | 'jpeg' | 'bmp' | 'gif' | 'tiff';
export interface ImageInfo { format: ImageFormat; width: number; height: number; frames: 'single' | 'maybe-multiple' }

const fail = (code: OcrFailureCode, reason: string, extra: Partial<OcrFailure> = {}): OcrFailure => ({ok: false, code, reason, ...extra});

/** Reads format and pixel size from the file header alone, so oversized images are refused before any decoder sees them. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u8 = (o: number) => (o < b.length ? b[o] : -1);
  if (b.length >= 24 && u8(0) === 0x89 && u8(1) === 0x50 && u8(2) === 0x4e && u8(3) === 0x47 && u8(4) === 0x0d && u8(5) === 0x0a && u8(6) === 0x1a && u8(7) === 0x0a
    && u8(12) === 0x49 && u8(13) === 0x48 && u8(14) === 0x44 && u8(15) === 0x52) {
    return {format: 'png', width: v.getUint32(16), height: v.getUint32(20), frames: 'single'};
  }
  if (u8(0) === 0xff && u8(1) === 0xd8) {
    let o = 2;
    while (o + 4 <= b.length) {
      if (u8(o) !== 0xff) return null;
      const m = u8(o + 1);
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      const len = v.getUint16(o + 2);
      if (len < 2) return null;
      const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
      if (sof) {
        if (o + 9 > b.length) return null;
        return {format: 'jpeg', height: v.getUint16(o + 5), width: v.getUint16(o + 7), frames: 'single'};
      }
      o += 2 + len;
    }
    return null;
  }
  if (u8(0) === 0x42 && u8(1) === 0x4d && b.length >= 26) {
    const dib = v.getUint32(14, true);
    if (dib === 12) return {format: 'bmp', width: v.getUint16(18, true), height: v.getUint16(20, true), frames: 'single'};
    if (dib >= 40 && b.length >= 26) return {format: 'bmp', width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)), frames: 'single'};
    return null;
  }
  if (b.length >= 10 && u8(0) === 0x47 && u8(1) === 0x49 && u8(2) === 0x46 && u8(3) === 0x38 && (u8(4) === 0x37 || u8(4) === 0x39) && u8(5) === 0x61) {
    return {format: 'gif', width: v.getUint16(6, true), height: v.getUint16(8, true), frames: 'maybe-multiple'};
  }
  const le = u8(0) === 0x49 && u8(1) === 0x49 && u8(2) === 0x2a && u8(3) === 0;
  const be = u8(0) === 0x4d && u8(1) === 0x4d && u8(2) === 0 && u8(3) === 0x2a;
  if ((le || be) && b.length >= 8) {
    const ifd = v.getUint32(4, le);
    if (ifd < 8 || ifd + 2 > b.length) return null;
    const count = v.getUint16(ifd, le);
    let width = 0, height = 0;
    for (let i = 0; i < count && ifd + 2 + (i + 1) * 12 <= b.length; i++) {
      const e = ifd + 2 + i * 12;
      const tag = v.getUint16(e, le), type = v.getUint16(e + 2, le);
      if (tag !== 256 && tag !== 257) continue;
      const val = type === 3 ? v.getUint16(e + 8, le) : type === 4 ? v.getUint32(e + 8, le) : 0;
      if (tag === 256) width = val; else height = val;
    }
    if (!width || !height) return null;
    return {format: 'tiff', width, height, frames: 'maybe-multiple'};
  }
  return null;
}

const EXT_FORMAT: Record<string, ImageFormat> = {'.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.bmp': 'bmp', '.gif': 'gif', '.tif': 'tiff', '.tiff': 'tiff'};

/** Plain text only: control characters (other than newline/tab) and invisible or direction-changing characters are removed. */
export function cleanOcrLine(s: string): {text: string; changed: boolean} {
  let out = '';
  let changed = false;
  for (const ch of s.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    const control = (cp <= 0x1f && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029;
    if (control || isInvisibleFormatChar(cp) || (cp >= 0xd800 && cp <= 0xdfff)) { changed = true; continue; }
    out += ch;
  }
  return {text: out, changed: changed || out !== s};
}

interface Prepared { file: string; bytes: Buffer; sha256: string; info: ImageInfo }

export class Ocr implements OcrServiceApi {
  private fs: OcrFs;
  private platform: string;
  private now: () => number;
  private lim: {maxBytes: number; maxDimension: number; maxPixels: number; maxChars: number; timeoutMs: number};
  private active: AbortController | null = null;
  private picking = false;
  private probeCache: {at: number; value: ProbeValue} | null = null;

  constructor(private d: OcrDeps) {
    this.fs = d.fs ?? realOcrFs;
    this.platform = d.platform ?? process.platform;
    this.now = d.now ?? Date.now;
    const l = d.limits ?? {};
    const lower = (v: number | undefined, max: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : max);
    this.lim = {
      maxBytes: lower(l.maxBytes, OCR_LIMITS.maxBytes), maxDimension: lower(l.maxDimension, OCR_LIMITS.maxDimension),
      maxPixels: lower(l.maxPixels, OCR_LIMITS.maxPixels), maxChars: lower(l.maxChars, OCR_LIMITS.maxChars), timeoutMs: lower(l.timeoutMs, OCR_LIMITS.timeoutMs),
    };
  }

  /** Asks the OS helper which OCR languages exist. Cached for 30 s; force re-queries. Never throws. */
  async probe(force = false): Promise<ProbeValue> {
    if (!force && this.probeCache && this.now() - this.probeCache.at < 30_000) return this.probeCache.value;
    const value = await this.queryProbe();
    this.probeCache = {at: this.now(), value};
    return value;
  }

  private async queryProbe(): Promise<ProbeValue> {
    const down = (reason: string): ProbeValue => ({available: false, reason, languages: [], profileLanguage: null, maxImageDimension: null});
    if (this.platform !== 'win32') return down('Windows OCR is only available on Windows');
    let raw: unknown;
    try {
      raw = await this.d.native.run(OCR_SCRIPT, {op: 'probe'}, {timeoutMs: 20_000});
    } catch (e) {
      return down(nativeReason(e, 'Windows OCR could not be queried'));
    }
    if (!isObj(raw) || raw.ok !== true) return down(isObj(raw) && typeof raw.reason === 'string' ? shortText(raw.reason) : 'Windows OCR could not be queried');
    const languages = Array.isArray(raw.languages) ? [...new Set(raw.languages.filter((l): l is string => typeof l === 'string' && LANGUAGE_TAG.test(l)))].slice(0, 100) : [];
    const profileLanguage = typeof raw.profileLanguage === 'string' && LANGUAGE_TAG.test(raw.profileLanguage) ? raw.profileLanguage : null;
    const dim = typeof raw.maxImageDimension === 'number' && Number.isFinite(raw.maxImageDimension) && raw.maxImageDimension > 0 ? Math.floor(raw.maxImageDimension) : null;
    if (raw.available !== true || !languages.length) {
      return {available: false, reason: typeof raw.reason === 'string' && raw.reason ? shortText(raw.reason) : 'No Windows OCR language pack is installed', languages, profileLanguage, maxImageDimension: dim};
    }
    return {available: true, languages, profileLanguage, maxImageDimension: dim};
  }

  async status(): Promise<OcrStatus> {
    const p = await this.probe();
    const st: OcrStatus = {
      available: p.available, engine: OCR_ENGINE, languages: p.languages, profileLanguage: p.profileLanguage, maxImageDimension: p.maxImageDimension,
      limits: {maxBytes: this.lim.maxBytes, maxDimension: this.lim.maxDimension, maxPixels: this.lim.maxPixels, extensions: OCR_EXTENSIONS},
      busy: this.active !== null, cloud: false, continuousCapture: false,
    };
    if (!p.available) st.reason = p.reason;
    else if (!p.profileLanguage) st.reason = `No OCR language matches your Windows profile languages. Choose one of: ${p.languages.join(', ')}`;
    return st;
  }

  async capability(): Promise<Capability> {
    const s = await this.status();
    const cap: Capability = {id: 'ocr', name: 'Image text recognition (Windows, local)', available: s.available};
    if (s.reason) cap.reason = s.reason;
    return cap;
  }

  cancel(): Promise<boolean> {
    const had = this.active !== null;
    this.active?.abort();
    return Promise.resolve(had);
  }

  async chooseAndRecognize(opts: {language?: string} = {}): Promise<OcrResult> {
    if (!this.d.pickImage) return fail('unavailable', 'No image picker is configured');
    if (this.active || this.picking) return fail('busy', 'Another image is already being read');
    let picked: string | null;
    this.picking = true;
    try { picked = await this.d.pickImage(); } catch { return fail('failed', 'The image picker failed'); } finally { this.picking = false; }
    if (picked === null) return fail('cancelled', 'No image was chosen', {cancelled: true});
    return this.recognizeChosen(picked, opts);
  }

  async recognizeChosen(path: unknown, opts: {language?: string} = {}): Promise<OcrResult> {
    if (this.active) return fail('busy', 'Another image is already being read');
    // Claim the slot synchronously so two quick calls cannot both start a helper.
    const ac = new AbortController();
    this.active = ac;
    try {
      return await this.run(path, opts, ac);
    } finally {
      if (this.active === ac) this.active = null;
    }
  }

  private async run(path: unknown, opts: {language?: string}, ac: AbortController): Promise<OcrResult> {
    const cancelled = () => fail('cancelled', 'Text recognition was cancelled', {cancelled: true});
    let language: string | undefined;
    if (opts.language !== undefined && opts.language !== '') {
      if (typeof opts.language !== 'string' || !LANGUAGE_TAG.test(opts.language)) return fail('invalid-request', 'The OCR language must be a language tag such as "en-US"');
      language = opts.language;
    }
    if (this.platform !== 'win32') return fail('unavailable', 'Windows OCR is only available on Windows');

    let img: Prepared;
    try { img = await this.prepare(path); } catch (e) {
      if (e instanceof OcrRefusal) return e.failure;
      return fail('failed', 'The image could not be read');
    }
    if (ac.signal.aborted) return cancelled();

    const p = await this.probe();
    if (ac.signal.aborted) return cancelled();
    if (!p.available) return fail('unavailable', p.reason ?? 'Windows OCR is unavailable');
    if (language) {
      const match = p.languages.find((l) => l.toLowerCase() === language!.toLowerCase());
      if (!match) return fail('language-unavailable', `OCR language "${language}" is not installed. Installed: ${p.languages.join(', ')}`);
      language = match;
    } else if (!p.profileLanguage) {
      return fail('language-unavailable', `No OCR language matches your Windows profile languages. Choose one of: ${p.languages.join(', ')}`);
    }

    let raw: unknown;
    try {
      raw = await this.d.native.run(OCR_SCRIPT, {
        op: 'recognize', path: img.file, sha256: img.sha256, ...(language ? {language} : {}),
        maxBytes: this.lim.maxBytes, maxDimension: this.lim.maxDimension, maxPixels: this.lim.maxPixels,
      }, {timeoutMs: this.lim.timeoutMs, signal: ac.signal});
    } catch (e) {
      if (ac.signal.aborted || (e instanceof NativeError && e.kind === 'cancelled')) return cancelled();
      return fail(e instanceof NativeError && (e.kind === 'unavailable' || e.kind === 'integrity') ? 'unavailable' : 'failed', nativeReason(e, 'Windows OCR failed'));
    }
    // A late result after cancel is dropped, never returned.
    if (ac.signal.aborted) return cancelled();
    return this.shape(raw, img, language);
  }

  /** Path, link, extension, size, header and fingerprint checks. Nothing is spawned until all of these pass. */
  private async prepare(path: unknown): Promise<Prepared> {
    let file: string;
    try { file = chosenLocalPath(path, 'image'); } catch (e) {
      throw new OcrRefusal(fail('invalid-image', e instanceof ValidationError ? e.message : 'The chosen image location is not valid'));
    }
    const ext = w.extname(file).toLowerCase();
    if (!(OCR_EXTENSIONS as readonly string[]).includes(ext)) throw new OcrRefusal(fail('invalid-image', `Choose an image file (${OCR_EXTENSIONS.join(', ')})`));
    try { await assertRealFolders(w.dirname(file), 'image', this.fs); } catch (e) {
      throw new OcrRefusal(fail('invalid-image', e instanceof ValidationError ? e.message : 'The chosen image folder is not usable'));
    }
    let st;
    try { st = await this.fs.lstat(file); } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw new OcrRefusal(fail('invalid-image', 'The chosen image does not exist'));
      throw e;
    }
    if (st.isSymbolicLink()) throw new OcrRefusal(fail('invalid-image', 'The chosen image goes through a shortcut link or junction, which is not allowed'));
    if (!st.isFile()) throw new OcrRefusal(fail('invalid-image', 'The chosen image is not a file'));
    if (st.size < 1) throw new OcrRefusal(fail('invalid-image', 'The chosen image is empty'));
    if (st.size > this.lim.maxBytes) throw new OcrRefusal(fail('too-large', `The chosen image is larger than ${Math.round(this.lim.maxBytes / 1_000_000)} MB`));
    const bytes = await this.fs.readBytes(file, this.lim.maxBytes);
    if (bytes.length > this.lim.maxBytes || bytes.length !== st.size) throw new OcrRefusal(fail('changed', 'The chosen image changed while it was being read'));
    const info = sniffImage(bytes);
    if (!info) throw new OcrRefusal(fail('invalid-image', 'The file is not a PNG, JPEG, BMP, GIF or TIFF image'));
    if (info.format !== EXT_FORMAT[ext]) throw new OcrRefusal(fail('invalid-image', 'The file contents do not match its extension'));
    const {width, height} = info;
    if (width < OCR_LIMITS.minDimension || height < OCR_LIMITS.minDimension) throw new OcrRefusal(fail('invalid-image', 'The image is too small for text recognition'));
    if (width > this.lim.maxDimension || height > this.lim.maxDimension || width * height > this.lim.maxPixels) {
      throw new OcrRefusal(fail('too-large', `The image is ${width}x${height} pixels; the limit is ${this.lim.maxDimension} per side and ${Math.round(this.lim.maxPixels / 1_000_000)} megapixels`));
    }
    return {file, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), info};
  }

  private shape(raw: unknown, img: Prepared, requested: string | undefined): OcrResult {
    if (!isObj(raw)) return fail('failed', 'Windows OCR returned an unexpected result');
    if (raw.ok !== true) {
      const code = typeof raw.code === 'string' && HELPER_CODES.has(raw.code) ? (raw.code as OcrFailureCode) : 'failed';
      return fail(code, typeof raw.reason === 'string' && raw.reason ? shortText(raw.reason) : 'Windows OCR failed');
    }
    const language = raw.language;
    if (typeof language !== 'string' || !LANGUAGE_TAG.test(language)) return fail('failed', 'Windows OCR returned an unexpected result');
    // No silent fallback: a different language than the one asked for is a failure, not a result.
    if (requested && language.toLowerCase() !== requested.toLowerCase()) return fail('failed', `Windows OCR used "${language}" instead of the requested "${requested}"`);
    if (!Array.isArray(raw.lines) || raw.lines.length > OCR_LIMITS.maxLines || !raw.lines.every((l) => typeof l === 'string')) return fail('failed', 'Windows OCR returned an unexpected result');
    const dim = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : fallback);
    const lines: string[] = [];
    let sanitized = false;
    let truncated = false;
    let total = 0;
    for (const l of raw.lines as string[]) {
      const c = cleanOcrLine(l);
      if (c.changed) sanitized = true;
      const text = c.text.trimEnd();
      if (total + text.length + 1 > this.lim.maxChars) { truncated = true; break; }
      lines.push(text);
      total += text.length + 1;
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const text = lines.join('\n');
    const out: OcrSuccess = {
      ok: true, source: OCR_ENGINE, untrusted: true, text, lines, language,
      width: dim(raw.width, img.info.width), height: dim(raw.height, img.info.height), format: img.info.format,
      fileName: visibleText(w.basename(img.file)).slice(0, 120), truncated, sanitized,
    };
    const notes: string[] = [];
    if (!text.trim()) notes.push('No text was recognized in the image');
    if (img.info.frames === 'maybe-multiple') notes.push('Only the first frame or page of the image is read');
    if (truncated) notes.push('The text was cut off at the size limit');
    if (notes.length) out.note = notes.join('. ');
    return out;
  }
}

export interface ProbeValue {
  available: boolean;
  reason?: string;
  languages: string[];
  profileLanguage: string | null;
  maxImageDimension: number | null;
}

const HELPER_CODES: ReadonlySet<string> = new Set<OcrFailureCode>(['unavailable', 'invalid-request', 'invalid-image', 'too-large', 'language-unavailable', 'changed', 'failed']);

class OcrRefusal extends Error {
  constructor(readonly failure: OcrFailure) { super(failure.reason); }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One line, bounded, control characters shown as markers; helper text is never trusted to be tidy. */
const shortText = (s: string) => visibleText(s).replace(/\s+/g, ' ').trim().slice(0, 200);

function nativeReason(e: unknown, fallback: string): string {
  if (e instanceof NativeError) {
    if (e.kind === 'integrity') return 'The OCR helper is disabled because its integrity check failed';
    if (e.kind === 'unavailable') return 'Windows PowerShell is not available, so local OCR cannot run';
    if (e.kind === 'timeout') return 'Windows OCR timed out';
    return fallback; // exit/bad-output text can carry stderr, which may echo the image path
  }
  return fallback;
}
