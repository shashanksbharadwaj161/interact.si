/**
 * Offline-verifiable license file (goal 119, software half).
 * Pure and DOM-free with no imports: parses, canonicalizes, verifies ECDSA P-256 / SHA-256 signatures with a
 * WebCrypto SubtleCrypto (passed in or globalThis.crypto.subtle) and evaluates validity against a supplied clock.
 *
 * No network call is ever made: there is no activation server, no cloud check-in and no telemetry.
 * No machine binding exists: the license is not tied to hardware, an account or this computer.
 * Nothing here gates existing functionality; featureEnabled only reports what a verified license states.
 */

export const LICENSE_FORMAT = 'desktop-companion-license';
export const LICENSE_VERSION = 1;
export const LICENSE_LIMITS = Object.freeze({ jsonChars: 20000, name: 120, features: 50 });
export const LICENSE_PREF_KEY = 'license.file';
export const LICENSE_TRUSTED_KEYS_PREF_KEY = 'license.trustedKeys';
export const LICENSE_EDITIONS = ['personal', 'pro'] as const;
export const EXPIRING_SOON_DAYS = 30;
export const LICENSE_OFFLINE_NOTE = 'This build verifies a pasted license offline only. No activation server, no telemetry and no purchase flow exist yet.';

export type LicenseEdition = (typeof LICENSE_EDITIONS)[number];

export interface License {
  format: typeof LICENSE_FORMAT;
  version: typeof LICENSE_VERSION;
  licenseId: string;
  licensee: { name: string };
  product: string;
  edition: LicenseEdition;
  issuedAt: string;
  expiresAt: string | null;
  features: string[];
  keyId: string;
  signature: string;
}

export type LicenseParseResult =
  | { ok: true; license: License; errors: []; warnings: string[] }
  | { ok: false; license: null; errors: string[]; warnings: string[] };

export interface LicenseTrustedKey { keyId: string; publicKeyJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string } & Record<string, unknown> }
export type LicenseSignatureReason = 'ok' | 'untrusted-key' | 'bad-signature' | 'bad-key' | 'crypto-unavailable';
export interface LicenseVerifyResult { ok: boolean; reason: LicenseSignatureReason; keyId: string | null }

export type LicenseStatus = 'valid' | 'expiring-soon' | 'in-grace' | 'expired' | 'invalid' | 'not-yet-valid';
export interface LicenseEvaluation {
  status: LicenseStatus;
  /** Whole days until expiry (negative once expired); null for a perpetual license or when the license is invalid. */
  daysRemaining: number | null;
  explanation: string;
  features: string[];
}

const ROOT_KEYS = ['format', 'version', 'licenseId', 'licensee', 'product', 'edition', 'issuedAt', 'expiresAt', 'features', 'keyId', 'signature'];
const LICENSEE_KEYS = ['name'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DAY_MS = 86_400_000;
const FEATURE_MAX = 64;
const ID_MAX = 200;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown, max = ID_MAX): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function isIso(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

function warnUnknown(obj: Record<string, unknown>, allowed: string[], path: string, warnings: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) warnings.push(`${path}.${k}: unknown key dropped`);
}

/** Strict standard base64 decode. Returns null for anything malformed; never throws. */
function decodeBase64(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !B64_RE.test(value)) return null;
  const clean = value.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const idx = B64_CHARS.indexOf(ch);
    if (idx < 0) return null;
    buf = ((buf << 6) | idx) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

/** Parses and validates a license JSON string. Errors use exact $-paths; unknown keys are dropped with warnings. */
export function parseLicense(json: unknown): LicenseParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): LicenseParseResult => ({ ok: false, license: null, errors, warnings });
  if (typeof json !== 'string') {
    errors.push('$: must be a JSON string');
    return fail();
  }
  if (json.length > LICENSE_LIMITS.jsonChars) {
    errors.push(`$: exceeds ${LICENSE_LIMITS.jsonChars} characters`);
    return fail();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    errors.push('$: invalid JSON');
    return fail();
  }
  if (!isObj(raw)) {
    errors.push('$: must be an object');
    return fail();
  }
  warnUnknown(raw, ROOT_KEYS, '$', warnings);
  if (raw.format !== LICENSE_FORMAT) errors.push(`$.format: must be "${LICENSE_FORMAT}"`);
  if (raw.version !== LICENSE_VERSION) errors.push(`$.version: must be ${LICENSE_VERSION}`);
  if (!nonEmpty(raw.licenseId)) errors.push(`$.licenseId: must be a non-empty string of at most ${ID_MAX} characters`);
  const licensee = raw.licensee;
  if (!isObj(licensee)) errors.push('$.licensee: must be an object');
  else {
    warnUnknown(licensee, LICENSEE_KEYS, '$.licensee', warnings);
    if (!nonEmpty(licensee.name, LICENSE_LIMITS.name)) errors.push(`$.licensee.name: must be a non-empty string of at most ${LICENSE_LIMITS.name} characters`);
  }
  if (!nonEmpty(raw.product)) errors.push(`$.product: must be a non-empty string of at most ${ID_MAX} characters`);
  if (!(LICENSE_EDITIONS as readonly unknown[]).includes(raw.edition)) errors.push('$.edition: must be "personal" or "pro"');
  if (!isIso(raw.issuedAt)) errors.push('$.issuedAt: must be an ISO 8601 timestamp');
  if (raw.expiresAt !== null && !isIso(raw.expiresAt)) errors.push('$.expiresAt: must be an ISO 8601 timestamp or null for a perpetual license');
  else if (isIso(raw.expiresAt) && isIso(raw.issuedAt) && Date.parse(raw.expiresAt) <= Date.parse(raw.issuedAt)) errors.push('$.expiresAt: must be later than issuedAt');
  if (!Array.isArray(raw.features) || raw.features.length > LICENSE_LIMITS.features) {
    errors.push(`$.features: must be an array of at most ${LICENSE_LIMITS.features} strings`);
  } else {
    const seen = new Set<string>();
    raw.features.forEach((f: unknown, i: number) => {
      if (!nonEmpty(f, FEATURE_MAX)) errors.push(`$.features[${i}]: must be a non-empty string of at most ${FEATURE_MAX} characters`);
      else if (seen.has(f)) errors.push(`$.features[${i}]: duplicate feature ${f}`);
      else seen.add(f);
    });
  }
  if (!nonEmpty(raw.keyId)) errors.push(`$.keyId: must be a non-empty string of at most ${ID_MAX} characters`);
  if (decodeBase64(raw.signature) === null) errors.push('$.signature: must be base64');
  if (errors.length > 0 || !isObj(licensee)) return fail();
  return {
    ok: true,
    errors: [],
    warnings,
    license: {
      format: LICENSE_FORMAT,
      version: LICENSE_VERSION,
      licenseId: raw.licenseId as string,
      licensee: { name: licensee.name as string },
      product: raw.product as string,
      edition: raw.edition as LicenseEdition,
      issuedAt: raw.issuedAt as string,
      expiresAt: (raw.expiresAt as string | null) ?? null,
      features: [...(raw.features as string[])],
      keyId: raw.keyId as string,
      signature: raw.signature as string,
    },
  };
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  if (isObj(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return 'null';
}

/** Deterministic key-sorted JSON of the license payload. The top-level `signature` key is always excluded. */
export function canonicalizePayload(license: unknown): string {
  if (!isObj(license)) return canonical(license);
  const { signature: _ignored, ...rest } = license;
  return canonical(rest);
}

/**
 * Validates trusted keys: an array (or JSON string of an array) of {keyId, publicKeyJwk}. Only EC P-256 public JWKs are
 * accepted; a JWK carrying the private "d" member is rejected. Returns the valid keys and $-path errors.
 */
export function normalizeTrustedKeys(raw: unknown): { keys: LicenseTrustedKey[]; errors: string[] } {
  let input = raw;
  if (typeof raw === 'string') {
    if (raw.length > LICENSE_LIMITS.jsonChars) return { keys: [], errors: [`$: exceeds ${LICENSE_LIMITS.jsonChars} characters`] };
    try {
      input = JSON.parse(raw);
    } catch {
      return { keys: [], errors: ['$: invalid JSON'] };
    }
  }
  const errors: string[] = [];
  const keys: LicenseTrustedKey[] = [];
  if (!Array.isArray(input)) return { keys, errors: ['$: must be an array of {keyId, publicKeyJwk}'] };
  input.slice(0, 20).forEach((k: unknown, i: number) => {
    if (!isObj(k)) return void errors.push(`$[${i}]: must be an object`);
    if (!nonEmpty(k.keyId)) return void errors.push(`$[${i}].keyId: must be a non-empty string`);
    const jwk = k.publicKeyJwk;
    if (!isObj(jwk)) return void errors.push(`$[${i}].publicKeyJwk: must be an object`);
    if ('d' in jwk) return void errors.push(`$[${i}].publicKeyJwk: must be a public key (private "d" present)`);
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return void errors.push(`$[${i}].publicKeyJwk: must be an EC P-256 key`);
    if (!nonEmpty(jwk.x, 256) || !nonEmpty(jwk.y, 256)) return void errors.push(`$[${i}].publicKeyJwk: x and y must be non-empty strings`);
    keys.push({ keyId: k.keyId, publicKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } });
  });
  if (input.length > 20) errors.push('$: at most 20 trusted keys');
  return { keys, errors };
}

type Subtle = {
  importKey: (...args: never[]) => Promise<unknown>;
  verify: (...args: never[]) => Promise<boolean>;
};

function pickSubtle(candidate: unknown): Subtle | null {
  try {
    const s = (candidate ?? (globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) as Subtle | undefined;
    return s && typeof s.importKey === 'function' && typeof s.verify === 'function' ? s : null;
  } catch {
    return null;
  }
}

/** Verifies the ECDSA P-256 / SHA-256 signature over the UTF-8 canonical payload. Never throws; makes no network call. */
export async function verifyLicenseSignature(license: License, trustedKeys: unknown, cryptoSubtle?: unknown): Promise<LicenseVerifyResult> {
  const keyId = isObj(license) && typeof license.keyId === 'string' ? license.keyId : null;
  try {
    const subtle = pickSubtle(cryptoSubtle);
    if (!subtle) return { ok: false, reason: 'crypto-unavailable', keyId };
    if (!keyId) return { ok: false, reason: 'bad-signature', keyId };
    const { keys } = normalizeTrustedKeys(trustedKeys);
    const trusted = keys.find((k) => k.keyId === keyId);
    if (!trusted) return { ok: false, reason: 'untrusted-key', keyId };
    const sigBytes = decodeBase64(license.signature);
    if (!sigBytes) return { ok: false, reason: 'bad-signature', keyId };
    const s = subtle as unknown as { importKey: (...a: unknown[]) => Promise<unknown>; verify: (...a: unknown[]) => Promise<boolean> };
    let key: unknown;
    try {
      key = await s.importKey('jwk', trusted.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      return { ok: false, reason: 'bad-key', keyId };
    }
    const data = new TextEncoder().encode(canonicalizePayload(license));
    let ok = false;
    try {
      ok = (await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, data)) === true;
    } catch {
      ok = false;
    }
    return ok ? { ok: true, reason: 'ok', keyId } : { ok: false, reason: 'bad-signature', keyId };
  } catch {
    return { ok: false, reason: 'bad-signature', keyId };
  }
}

function toMs(now: unknown): number {
  let ms = NaN;
  if (now instanceof Date) ms = now.getTime();
  else if (typeof now === 'number') ms = now;
  else if (typeof now === 'string' && isIso(now)) ms = Date.parse(now);
  if (!Number.isFinite(ms)) throw new Error('evaluateLicense: now must be a valid Date, a finite millisecond timestamp or an ISO 8601 string');
  return ms;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Evaluates a parsed license against a verification result and a supplied clock. Purely local: the clock is the only
 * input besides the license, so a changed system clock changes the answer; there is no server to compare against.
 */
export function evaluateLicense(license: License, verifyResult: LicenseVerifyResult | null | undefined, now: unknown, graceDays = 14): LicenseEvaluation {
  const nowMs = toMs(now);
  if (typeof graceDays !== 'number' || !Number.isInteger(graceDays) || graceDays < 0 || graceDays > 365) {
    throw new Error('evaluateLicense: graceDays must be a whole number from 0 to 365');
  }
  if (!verifyResult || verifyResult.ok !== true || verifyResult.reason !== 'ok' || !isObj(license)) {
    return { status: 'invalid', daysRemaining: null, explanation: `The license signature was not verified (${verifyResult?.reason ?? 'missing'}), so no feature is enabled.`, features: [] };
  }
  const features = Array.isArray(license.features) ? [...license.features] : [];
  const issued = Date.parse(license.issuedAt);
  const expires = license.expiresAt === null ? null : Date.parse(license.expiresAt);
  const msLeft = expires === null ? null : expires - nowMs;
  const daysRemaining = msLeft === null ? null : msLeft >= 0 ? Math.ceil(msLeft / DAY_MS) : -Math.ceil(-msLeft / DAY_MS);
  if (nowMs < issued) {
    return { status: 'not-yet-valid', daysRemaining, explanation: `The license starts on ${license.issuedAt}, which is after the current date on this computer.`, features };
  }
  if (msLeft === null) {
    return { status: 'valid', daysRemaining: null, explanation: 'The license is valid and perpetual; it does not expire.', features };
  }
  if (msLeft >= 0) {
    const d = daysRemaining as number;
    if (d <= EXPIRING_SOON_DAYS) return { status: 'expiring-soon', daysRemaining: d, explanation: `The license is valid but expires on ${license.expiresAt}, in ${plural(d, 'day')}.`, features };
    return { status: 'valid', daysRemaining: d, explanation: `The license is valid until ${license.expiresAt} (${plural(d, 'day')} left).`, features };
  }
  const graceLeftMs = graceDays * DAY_MS + msLeft;
  if (graceLeftMs >= 0) {
    const g = Math.ceil(graceLeftMs / DAY_MS);
    return { status: 'in-grace', daysRemaining, explanation: `The license expired on ${license.expiresAt}. Features stay on during a ${graceDays}-day grace period (${plural(g, 'day')} left).`, features };
  }
  return { status: 'expired', daysRemaining, explanation: `The license expired on ${license.expiresAt} and the ${graceDays}-day grace period has ended.`, features };
}

const ENABLED: readonly LicenseStatus[] = ['valid', 'expiring-soon', 'in-grace'];

/** True only when the evaluation is valid, expiring-soon or in-grace and the license lists the feature. */
export function featureEnabled(evaluation: LicenseEvaluation | null | undefined, featureId: string): boolean {
  if (!evaluation || !ENABLED.includes(evaluation.status) || typeof featureId !== 'string') return false;
  return Array.isArray(evaluation.features) && evaluation.features.includes(featureId);
}

/** Read-only summary rows. Values are shown verbatim from the license. */
export function describeLicense(license: License): { label: string; value: string }[] {
  return [
    { label: 'License ID', value: license.licenseId },
    { label: 'Licensee', value: license.licensee.name },
    { label: 'Product', value: license.product },
    { label: 'Edition', value: license.edition },
    { label: 'Issued', value: license.issuedAt },
    { label: 'Expires', value: license.expiresAt ?? 'Never (perpetual)' },
    { label: 'Features', value: license.features.length ? license.features.join(', ') : 'None listed' },
    { label: 'Signing key', value: license.keyId },
  ];
}
