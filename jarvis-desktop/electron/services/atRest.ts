// Local encryption at rest for state.json and its backups. Main process only; no Electron import here: Electron's
// safeStorage (DPAPI on Windows, bound to the current user profile) is injected through createSafeStorageCipher.
//
// On-disk envelope (text, so the existing string-based StoreFs and atomic write path are reused unchanged):
//   desktop-companion-encrypted-state v1\n
//   <base64 ciphertext>
// Export documents chosen by the user are NOT wrapped: they stay plaintext JSON by design.
import {LIMITS} from './validation';

export const AT_REST_FORMAT = 'desktop-companion-encrypted-state';
export const AT_REST_VERSION = 1;

/** Bounds derived from the store limits: every note/task at the generic text limit, capped below V8's string ceiling. */
const PLAINTEXT_CHARS = Math.min(2 ** 27, ((LIMITS.notes + LIMITS.tasks) * LIMITS.text) / 4);
export const AT_REST_LIMITS = {
  plaintextChars: PLAINTEXT_CHARS,
  // UTF-8 (<= 3 bytes per char) + cipher overhead, base64 expanded, plus the header line.
  blobChars: Math.ceil((PLAINTEXT_CHARS * 3 + 64 * 1024) / 3) * 4 + 64,
} as const;

/** Injectable at-rest protector. */
export interface AtRestCipher {
  available(): boolean;
  encrypt(plain: string): Buffer | string;
  decrypt(data: Buffer): string;
}

/** The part of Electron's safeStorage used here. */
export interface SafeStorageSource {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export type AtRestErrorKind = 'format' | 'version' | 'size' | 'unavailable' | 'key';

/** Descriptive, user-safe error. Raw library errors are never passed through. */
export class AtRestError extends Error {
  constructor(public readonly kind: AtRestErrorKind, message: string) {
    super(message);
    this.name = 'AtRestError';
  }
}

/** Wraps Electron safeStorage. Any failure inside safeStorage is reported as "unavailable" or a key error, never rethrown raw. */
export function createSafeStorageCipher(ss: SafeStorageSource | null | undefined): AtRestCipher {
  return {
    available: () => {
      try { return !!ss && ss.isEncryptionAvailable() === true; } catch { return false; }
    },
    encrypt: (plain) => {
      if (!ss) throw new AtRestError('unavailable', 'The operating-system protection key is unavailable');
      return ss.encryptString(plain);
    },
    decrypt: (data) => {
      if (!ss) throw new AtRestError('unavailable', 'The operating-system protection key is unavailable');
      return ss.decryptString(data);
    },
  };
}

/**
 * TEST ONLY. Reversible, deterministic and NOT secure (byte XOR with a tagged prefix). A different `key` fails to
 * decrypt, which simulates another user profile. Never used in production code paths.
 */
export function memoryCipher(opts: {available?: boolean; key?: number} = {}): AtRestCipher & {setAvailable(v: boolean): void} {
  let ok = opts.available ?? true;
  const key = (opts.key ?? 0x5a) & 0xff;
  const tag = Buffer.from(`MEMTEST${key.toString(16).padStart(2, '0')}:`, 'latin1');
  return {
    setAvailable: (v: boolean) => { ok = v; },
    available: () => ok,
    encrypt: (plain) => {
      if (!ok) throw new Error('memory cipher unavailable');
      const body = Buffer.from(plain, 'utf8');
      for (let i = 0; i < body.length; i++) body[i] ^= key;
      return Buffer.concat([tag, body]);
    },
    decrypt: (data) => {
      if (!ok) throw new Error('memory cipher unavailable');
      const buf = Buffer.from(data);
      if (buf.length < tag.length || !buf.subarray(0, tag.length).equals(tag)) throw new Error('memory cipher: wrong key');
      const body = Buffer.from(buf.subarray(tag.length));
      for (let i = 0; i < body.length; i++) body[i] ^= key;
      return body.toString('utf8');
    },
  };
}

const HEADER_RE = /^desktop-companion-encrypted-state v(\d{1,6})\r?\n/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Cheap check used on load: does the raw file claim to be an encrypted state envelope (of any version)? */
export function isEncryptedBlob(raw: unknown): boolean {
  return typeof raw === 'string' && raw.startsWith(AT_REST_FORMAT);
}

function cipherReady(cipher: AtRestCipher | null | undefined): cipher is AtRestCipher {
  try { return !!cipher && cipher.available() === true; } catch { return false; }
}

/** Encrypts and wraps plaintext into the versioned envelope. */
export function wrapEncrypted(plain: string, cipher: AtRestCipher | null | undefined): string {
  if (typeof plain !== 'string') throw new AtRestError('format', 'Only text can be encrypted');
  if (plain.length > AT_REST_LIMITS.plaintextChars) throw new AtRestError('size', 'Local data is too large to encrypt');
  if (!cipherReady(cipher)) throw new AtRestError('unavailable', 'The operating-system protection key is unavailable');
  let out: Buffer | string;
  try { out = cipher.encrypt(plain); } catch { throw new AtRestError('unavailable', 'Local data could not be encrypted with the operating-system protection key'); }
  const bytes = typeof out === 'string' ? Buffer.from(out, 'utf8') : Buffer.from(out);
  if (!bytes.length) throw new AtRestError('unavailable', 'Local data could not be encrypted with the operating-system protection key');
  return `${AT_REST_FORMAT} v${AT_REST_VERSION}\n${bytes.toString('base64')}\n`;
}

/** Validates the envelope structure without decrypting. Returns the ciphertext bytes. */
export function parseEncryptedBlob(raw: unknown): Buffer {
  if (typeof raw !== 'string') throw new AtRestError('format', 'Encrypted data must be text');
  if (raw.length > AT_REST_LIMITS.blobChars) throw new AtRestError('size', 'Encrypted data is larger than allowed');
  if (!isEncryptedBlob(raw)) throw new AtRestError('format', 'File is not an encrypted Desktop Companion state file');
  const m = HEADER_RE.exec(raw);
  if (!m) throw new AtRestError('format', 'Encrypted data header is damaged or truncated');
  const version = Number(m[1]);
  if (version !== AT_REST_VERSION) throw new AtRestError('version', `Encrypted data uses format version ${version}; this version of Desktop Companion reads version ${AT_REST_VERSION}`);
  const body = raw.slice(m[0].length).trim();
  if (!body) throw new AtRestError('format', 'Encrypted data is truncated (no ciphertext)');
  if (body.length % 4 !== 0 || !B64_RE.test(body)) throw new AtRestError('format', 'Encrypted data is truncated or not valid base64');
  const bytes = Buffer.from(body, 'base64');
  if (!bytes.length) throw new AtRestError('format', 'Encrypted data is truncated (no ciphertext)');
  return bytes;
}

/** Validates and decrypts an envelope. Every failure is an AtRestError with a descriptive kind and message. */
export function unwrapEncrypted(raw: unknown, cipher: AtRestCipher | null | undefined): string {
  const bytes = parseEncryptedBlob(raw);
  if (!cipherReady(cipher)) throw new AtRestError('unavailable', 'The operating-system protection key is unavailable');
  let plain: unknown;
  try { plain = cipher.decrypt(bytes); } catch { throw new AtRestError('key', 'Encrypted data could not be decrypted with this user profile\'s protection key'); }
  if (typeof plain !== 'string') throw new AtRestError('key', 'Encrypted data could not be decrypted with this user profile\'s protection key');
  if (plain.length > AT_REST_LIMITS.plaintextChars) throw new AtRestError('size', 'Decrypted data is larger than allowed');
  return plain;
}
