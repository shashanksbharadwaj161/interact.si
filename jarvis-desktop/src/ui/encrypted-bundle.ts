/**
 * Passphrase-encrypted transfer bundle (goal 109, offline half of cross-device sync).
 * Pure and DOM-free: uses only globalThis.crypto.subtle (PBKDF2-SHA-256 -> AES-GCM-256) plus the standard
 * TextEncoder/TextDecoder globals. There is no sync service: the user moves the bundle file between machines.
 * The envelope header (format, version, createdAt, label, kdf parameters, iv) is bound as AES-GCM additional data,
 * so editing it is detected. kdf.check is a short key-check value (SHA-256 of a domain tag and the derived key,
 * truncated to 16 bytes) that lets decryptBundle tell a wrong passphrase apart from a tampered bundle.
 */

export const BUNDLE_FORMAT = 'desktop-companion-encrypted-bundle';
export const BUNDLE_VERSION = 1;
export const BUNDLE_LIMITS = Object.freeze({ plaintextChars: 4_000_000, passphraseMin: 12, pbkdf2Iterations: 310000 });
export const BUNDLE_LABEL_MAX = 120;
export const BUNDLE_ITERATIONS_MAX = 5_000_000;
/** UTF-8 uses at most 3 bytes per UTF-16 code unit; AES-GCM adds a 16-byte tag. */
export const BUNDLE_CIPHERTEXT_B64_MAX = Math.ceil((BUNDLE_LIMITS.plaintextChars * 3 + 16) / 3) * 4;
export const BUNDLE_JSON_MAX = BUNDLE_CIPHERTEXT_B64_MAX + 8192;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const CHECK_BYTES = 16;
const TAG_BYTES = 16;
const CHECK_TAG = 'desktop-companion-bundle-key-check-v1';

export interface BundleEnvelope {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  createdAt: string;
  label: string | null;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string; check?: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ciphertext: string;
}

export type BundleParseResult =
  | { ok: true; envelope: BundleEnvelope; errors: []; warnings: string[] }
  | { ok: false; envelope: null; errors: string[]; warnings: string[] };

export type DecryptReason = 'bad-passphrase' | 'corrupt' | 'crypto-unavailable';
export type DecryptResult = { ok: true; plaintext: string } | { ok: false; reason: DecryptReason };

export interface EncryptOptions { now?: Date | number | string; label?: string | null }

const ROOT_KEYS = ['format', 'version', 'createdAt', 'label', 'kdf', 'cipher', 'ciphertext'];
const KDF_KEYS = ['name', 'hash', 'iterations', 'salt', 'check'];
const CIPHER_KEYS = ['name', 'iv'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i++) B64_INDEX[B64_CHARS[i]] = i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function subtle(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && c.subtle && typeof c.getRandomValues === 'function' ? c.subtle : null;
}

/** Standard padded base64 encoding. */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    chunk += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + (i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64_CHARS[n & 63] : '=');
    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

/** Strict standard base64 decode: padded, canonical (unused bits zero), no whitespace. Returns null when malformed. */
export function decodeBase64(value: unknown, maxChars = BUNDLE_CIPHERTEXT_B64_MAX): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars || value.length % 4 !== 0 || !B64_RE.test(value)) return null;
  const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = B64_INDEX[value[i]];
    const b = B64_INDEX[value[i + 1]];
    const c = value[i + 2] === '=' ? 0 : B64_INDEX[value[i + 2]];
    const d = value[i + 3] === '=' ? 0 : B64_INDEX[value[i + 3]];
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
    if (i + 4 === value.length) {
      // Canonical form: bits dropped by the padding must be zero.
      if (pad === 2 && (b & 15) !== 0) return null;
      if (pad === 1 && (c & 3) !== 0) return null;
    }
  }
  return out;
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function toBuf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function additionalData(e: Pick<BundleEnvelope, 'format' | 'version' | 'createdAt' | 'label'> & { iterations: number; salt: string; iv: string }): Uint8Array<ArrayBuffer> {
  return toBuf(new TextEncoder().encode(JSON.stringify([e.format, e.version, e.createdAt, e.label, 'PBKDF2', 'SHA-256', e.iterations, e.salt, 'AES-GCM', e.iv])));
}

async function deriveKey(s: SubtleCrypto, passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<{ key: CryptoKey; check: Uint8Array<ArrayBuffer> }> {
  const base = await s.importKey('raw', toBuf(new TextEncoder().encode(passphrase)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  const key = await s.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const tag = new TextEncoder().encode(CHECK_TAG);
  const material = new Uint8Array(tag.length + bits.length);
  material.set(tag);
  material.set(bits, tag.length);
  const digest = new Uint8Array(await s.digest('SHA-256', material));
  bits.fill(0);
  material.fill(0);
  return { key, check: toBuf(digest.slice(0, CHECK_BYTES)) };
}

function resolveNow(now: EncryptOptions['now']): string {
  if (now === undefined) return new Date().toISOString();
  const d = now instanceof Date ? new Date(now.getTime()) : typeof now === 'number' || typeof now === 'string' ? new Date(now) : null;
  if (!d || Number.isNaN(d.getTime()) || (typeof now === 'string' && !isIso(now))) throw new Error('encryptBundle: now must be a valid Date, millisecond timestamp or ISO timestamp.');
  return d.toISOString();
}

function resolveLabel(label: EncryptOptions['label']): string | null {
  if (label === undefined || label === null) return null;
  if (typeof label !== 'string') throw new Error('encryptBundle: label must be a string.');
  const clean = label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (clean.length > BUNDLE_LABEL_MAX) throw new Error(`encryptBundle: label must be at most ${BUNDLE_LABEL_MAX} characters.`);
  return clean || null;
}

/** Encrypts plaintext with a passphrase. Throws descriptive Errors for bad input; never contacts a network. */
export async function encryptBundle(plaintext: string, passphrase: string, opts: EncryptOptions = {}): Promise<BundleEnvelope> {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new Error('encryptBundle: plaintext is empty; there is nothing to encrypt.');
  if (plaintext.length > BUNDLE_LIMITS.plaintextChars) throw new Error(`encryptBundle: plaintext is ${plaintext.length} characters; the limit is ${BUNDLE_LIMITS.plaintextChars}.`);
  if (typeof passphrase !== 'string' || passphrase.length < BUNDLE_LIMITS.passphraseMin) throw new Error(`encryptBundle: passphrase must be at least ${BUNDLE_LIMITS.passphraseMin} characters.`);
  const createdAt = resolveNow(opts?.now);
  const label = resolveLabel(opts?.label);
  const s = subtle();
  if (!s) throw new Error('encryptBundle: Web Crypto (crypto.subtle) is not available here.');
  const salt = toBuf(globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  const iv = toBuf(globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES)));
  const iterations = BUNDLE_LIMITS.pbkdf2Iterations;
  const saltB64 = encodeBase64(salt);
  const ivB64 = encodeBase64(iv);
  const { key, check } = await deriveKey(s, passphrase, salt, iterations);
  const aad = additionalData({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, createdAt, label, iterations, salt: saltB64, iv: ivB64 });
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, toBuf(new TextEncoder().encode(plaintext))));
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt,
    label,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: saltB64, check: encodeBase64(check) },
    cipher: { name: 'AES-GCM', iv: ivB64 },
    ciphertext: encodeBase64(ct),
  };
}

export function serializeBundle(envelope: BundleEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

function warnUnknown(obj: Record<string, unknown>, allowed: string[], path: string, warnings: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) warnings.push(`${path}.${k}: unknown key ignored`);
}

function checkB64(v: unknown, path: string, bytes: number | null, errors: string[], maxChars = 64): void {
  if (typeof v !== 'string') return void errors.push(`${path}: expected a base64 string`);
  if (v.length > maxChars) return void errors.push(`${path}: longer than ${maxChars} characters`);
  const d = decodeBase64(v, maxChars);
  if (!d) return void errors.push(`${path}: not strict base64`);
  if (bytes !== null && d.length !== bytes) errors.push(`${path}: expected ${bytes} bytes, got ${d.length}`);
}

/** Validates an already-parsed value. Errors use exact $-paths; unknown keys produce warnings. */
export function validateBundle(value: unknown): BundleParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(value)) return { ok: false, envelope: null, errors: ['$: expected a JSON object'], warnings };
  warnUnknown(value, ROOT_KEYS, '$', warnings);
  if (value.format !== BUNDLE_FORMAT) errors.push(`$.format: expected "${BUNDLE_FORMAT}"`);
  if (value.version !== BUNDLE_VERSION) errors.push(`$.version: expected ${BUNDLE_VERSION}`);
  if (!isIso(value.createdAt)) errors.push('$.createdAt: expected an ISO timestamp');
  if (!(value.label === undefined || value.label === null || (typeof value.label === 'string' && value.label.length <= BUNDLE_LABEL_MAX))) errors.push(`$.label: expected null or a string of at most ${BUNDLE_LABEL_MAX} characters`);
  const kdf = value.kdf;
  if (!isObj(kdf)) errors.push('$.kdf: expected an object');
  else {
    warnUnknown(kdf, KDF_KEYS, '$.kdf', warnings);
    if (kdf.name !== 'PBKDF2') errors.push('$.kdf.name: expected "PBKDF2"');
    if (kdf.hash !== 'SHA-256') errors.push('$.kdf.hash: expected "SHA-256"');
    if (typeof kdf.iterations !== 'number' || !Number.isSafeInteger(kdf.iterations)) errors.push('$.kdf.iterations: expected an integer');
    else if (kdf.iterations < BUNDLE_LIMITS.pbkdf2Iterations) errors.push(`$.kdf.iterations: ${kdf.iterations} is below the minimum of ${BUNDLE_LIMITS.pbkdf2Iterations}`);
    else if (kdf.iterations > BUNDLE_ITERATIONS_MAX) errors.push(`$.kdf.iterations: ${kdf.iterations} is above the maximum of ${BUNDLE_ITERATIONS_MAX}`);
    checkB64(kdf.salt, '$.kdf.salt', SALT_BYTES, errors);
    if (kdf.check !== undefined) checkB64(kdf.check, '$.kdf.check', CHECK_BYTES, errors);
  }
  const cipher = value.cipher;
  if (!isObj(cipher)) errors.push('$.cipher: expected an object');
  else {
    warnUnknown(cipher, CIPHER_KEYS, '$.cipher', warnings);
    if (cipher.name !== 'AES-GCM') errors.push('$.cipher.name: expected "AES-GCM"');
    checkB64(cipher.iv, '$.cipher.iv', IV_BYTES, errors);
  }
  if (typeof value.ciphertext !== 'string') errors.push('$.ciphertext: expected a base64 string');
  else if (value.ciphertext.length > BUNDLE_CIPHERTEXT_B64_MAX) errors.push(`$.ciphertext: longer than ${BUNDLE_CIPHERTEXT_B64_MAX} characters`);
  else {
    const d = decodeBase64(value.ciphertext);
    if (!d) errors.push('$.ciphertext: not strict base64');
    else if (d.length <= TAG_BYTES) errors.push(`$.ciphertext: too short (${d.length} bytes) to hold data and the ${TAG_BYTES}-byte tag`);
  }
  if (errors.length) return { ok: false, envelope: null, errors, warnings };
  const k = kdf as Record<string, unknown>;
  const c = cipher as Record<string, unknown>;
  const envelope: BundleEnvelope = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: value.createdAt as string,
    label: typeof value.label === 'string' ? value.label : null,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: k.iterations as number, salt: k.salt as string, ...(typeof k.check === 'string' ? { check: k.check } : {}) },
    cipher: { name: 'AES-GCM', iv: c.iv as string },
    ciphertext: value.ciphertext as string,
  };
  return { ok: true, envelope, errors: [], warnings };
}

/** Parses bundle JSON text. Never throws. */
export function parseBundle(json: unknown): BundleParseResult {
  if (typeof json !== 'string') return { ok: false, envelope: null, errors: ['$: expected JSON text'], warnings: [] };
  if (json.length > BUNDLE_JSON_MAX) return { ok: false, envelope: null, errors: [`$: bundle is ${json.length} characters; the limit is ${BUNDLE_JSON_MAX}`], warnings: [] };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, envelope: null, errors: ['$: not valid JSON'], warnings: [] };
  }
  return validateBundle(value);
}

/** Decrypts a bundle. Never throws: wrong passphrases give 'bad-passphrase', damaged or edited bundles give 'corrupt'. */
export async function decryptBundle(envelope: unknown, passphrase: string): Promise<DecryptResult> {
  const parsed = typeof envelope === 'string' ? parseBundle(envelope) : validateBundle(envelope);
  if (!parsed.ok) return { ok: false, reason: 'corrupt' };
  const s = subtle();
  if (!s) return { ok: false, reason: 'crypto-unavailable' };
  if (typeof passphrase !== 'string' || passphrase.length === 0) return { ok: false, reason: 'bad-passphrase' };
  const e = parsed.envelope;
  try {
    const salt = decodeBase64(e.kdf.salt, 64)!;
    const iv = decodeBase64(e.cipher.iv, 64)!;
    const ct = decodeBase64(e.ciphertext)!;
    const { key, check } = await deriveKey(s, passphrase, salt, e.kdf.iterations);
    if (e.kdf.check !== undefined) {
      const want = decodeBase64(e.kdf.check, 64)!;
      let diff = 0;
      for (let i = 0; i < CHECK_BYTES; i++) diff |= want[i] ^ check[i];
      if (diff !== 0) return { ok: false, reason: 'bad-passphrase' };
    }
    let plain: ArrayBuffer;
    try {
      plain = await s.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData({ format: e.format, version: e.version, createdAt: e.createdAt, label: e.label, iterations: e.kdf.iterations, salt: e.kdf.salt, iv: e.cipher.iv }), tagLength: 128 }, key, ct);
    } catch {
      // With a matching key check the passphrase is right, so a failed tag means the bundle was altered.
      return { ok: false, reason: e.kdf.check !== undefined ? 'corrupt' : 'bad-passphrase' };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
    if (text.length === 0 || text.length > BUNDLE_LIMITS.plaintextChars) return { ok: false, reason: 'corrupt' };
    return { ok: true, plaintext: text };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

/** Counts of top-level array keys when plaintext is a JSON object (e.g. notes, tasks); null when it is not a JSON object. */
export function summarizePlaintext(plaintext: unknown): Record<string, number> | null {
  if (typeof plaintext !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (!isObj(value)) return null;
  const out: Record<string, number> = {};
  for (const k of Object.keys(value).sort()) {
    const v = value[k];
    if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}
