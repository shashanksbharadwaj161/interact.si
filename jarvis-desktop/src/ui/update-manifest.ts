/**
 * Offline signed-update manifest verification and rollback ledger (goal 117).
 * Pure and DOM-free: parses, canonicalizes, verifies ECDSA P-256 signatures with globalThis.crypto.subtle and plans.
 * It never downloads, installs or rolls back anything; every plan is descriptive only.
 */

export const UPDATE_MANIFEST_FORMAT = 'desktop-companion-update';
export const UPDATE_MANIFEST_VERSION = 1;
export const UPDATE_LIMITS = Object.freeze({ jsonChars: 200000, releases: 50, notesChars: 4000, ledgerEntries: 20 });
export const SIGNATURE_ALG = 'ECDSA-P256-SHA256';
export const NO_DOWNLOAD_NOTE = 'No download is started. This is a plan only; nothing is downloaded or installed.';
export const NO_ROLLBACK_NOTE = 'Nothing has been rolled back. Each step must be done manually after confirmation.';

export type UpdateChannel = 'stable' | 'beta';

export interface UpdateInstaller { fileName: string; sizeBytes: number; sha256: string }
export interface UpdateRelease { version: string; publishedAt: string; installer: UpdateInstaller; notes: string; minPreviousVersion?: string }
export interface UpdateSignature { alg: typeof SIGNATURE_ALG; keyId: string; value: string }
export interface UpdateManifest {
  format: typeof UPDATE_MANIFEST_FORMAT;
  version: typeof UPDATE_MANIFEST_VERSION;
  product: string;
  channel: UpdateChannel;
  releases: UpdateRelease[];
  signature: UpdateSignature;
}

export type UpdateParseResult =
  | { ok: true; manifest: UpdateManifest; errors: []; warnings: string[] }
  | { ok: false; manifest: null; errors: string[]; warnings: string[] };

export interface TrustedKey { keyId: string; publicKeyJwk: Record<string, unknown> }
export type SignatureReason = 'ok' | 'untrusted-key' | 'bad-signature' | 'bad-key' | 'crypto-unavailable';
export interface SignatureResult { ok: boolean; reason: SignatureReason; keyId: string | null }

export type UpdatePlanStatus = 'signature-invalid' | 'up-to-date' | 'update-available' | 'downgrade-blocked' | 'min-version-unmet';
export interface UpdatePlan {
  status: UpdatePlanStatus;
  release: UpdateRelease | null;
  installerSha256: string | null;
  message: string;
  note: typeof NO_DOWNLOAD_NOTE;
}

export interface InstallEntry { version: string; installedAt: string; installerSha256: string; source: 'manual' }
export interface RollbackStep { order: number; text: string; requiresConfirmation: true }
export interface RollbackPlan { possible: boolean; target: InstallEntry | null; steps: RollbackStep[]; applied: false; reason: string }

const ROOT_KEYS = ['format', 'version', 'product', 'channel', 'releases', 'signature'];
const RELEASE_KEYS = ['version', 'publishedAt', 'installer', 'notes', 'minPreviousVersion'];
const INSTALLER_KEYS = ['fileName', 'sizeBytes', 'sha256'];
const SIGNATURE_KEYS = ['alg', 'keyId', 'value'];
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown, max = 200): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

export function isSemver(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 128 && SEMVER_RE.test(v);
}

export function isIsoTimestamp(v: unknown): v is string {
  return typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
}

export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && HEX64_RE.test(v);
}

function warnUnknown(obj: Record<string, unknown>, allowed: string[], path: string, warnings: string[]): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) warnings.push(`${path}.${k}: unknown key dropped`);
}

/** Strict standard base64 decode. Returns null for anything malformed; never throws. */
export function decodeBase64(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !B64_RE.test(value)) return null;
  const clean = value.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buf = 0;
  let bits = 0;
  let o = 0;
  for (const ch of clean) {
    const idx = B64_CHARS.indexOf(ch);
    if (idx < 0) return null;
    buf = (buf << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out;
}

/** Parses and validates an update manifest JSON string. Errors use exact $-paths; unknown keys are dropped with warnings. */
export function parseUpdateManifest(json: unknown): UpdateParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): UpdateParseResult => ({ ok: false, manifest: null, errors, warnings });
  if (typeof json !== 'string') {
    errors.push('$: must be a JSON string');
    return fail();
  }
  if (json.length > UPDATE_LIMITS.jsonChars) {
    errors.push(`$: exceeds ${UPDATE_LIMITS.jsonChars} characters`);
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
  if (raw.format !== UPDATE_MANIFEST_FORMAT) errors.push(`$.format: must be "${UPDATE_MANIFEST_FORMAT}"`);
  if (raw.version !== UPDATE_MANIFEST_VERSION) errors.push(`$.version: must be ${UPDATE_MANIFEST_VERSION}`);
  if (!nonEmpty(raw.product)) errors.push('$.product: must be a non-empty string');
  if (raw.channel !== 'stable' && raw.channel !== 'beta') errors.push('$.channel: must be "stable" or "beta"');

  const releases: UpdateRelease[] = [];
  if (!Array.isArray(raw.releases) || raw.releases.length < 1 || raw.releases.length > UPDATE_LIMITS.releases) {
    errors.push(`$.releases: must be an array of 1 to ${UPDATE_LIMITS.releases} releases`);
  } else {
    const seen = new Set<string>();
    raw.releases.forEach((r: unknown, i: number) => {
      const p = `$.releases[${i}]`;
      if (!isObj(r)) {
        errors.push(`${p}: must be an object`);
        return;
      }
      warnUnknown(r, RELEASE_KEYS, p, warnings);
      let valid = true;
      const bad = (msg: string) => {
        errors.push(msg);
        valid = false;
      };
      if (!isSemver(r.version)) bad(`${p}.version: must be strict semver`);
      else if (seen.has(r.version)) bad(`${p}.version: duplicate release version ${r.version}`);
      else seen.add(r.version);
      if (!isIsoTimestamp(r.publishedAt)) bad(`${p}.publishedAt: must be an ISO 8601 timestamp`);
      const inst = r.installer;
      if (!isObj(inst)) bad(`${p}.installer: must be an object`);
      else {
        warnUnknown(inst, INSTALLER_KEYS, `${p}.installer`, warnings);
        if (!nonEmpty(inst.fileName, 255) || /[\\/]/.test(inst.fileName) || inst.fileName === '.' || inst.fileName === '..') bad(`${p}.installer.fileName: must be a non-empty file name without path separators`);
        if (typeof inst.sizeBytes !== 'number' || !Number.isSafeInteger(inst.sizeBytes) || inst.sizeBytes <= 0) bad(`${p}.installer.sizeBytes: must be a positive integer`);
        if (!isSha256Hex(inst.sha256)) bad(`${p}.installer.sha256: must be 64 hex characters`);
      }
      if (typeof r.notes !== 'string' || r.notes.length > UPDATE_LIMITS.notesChars) bad(`${p}.notes: must be a string of at most ${UPDATE_LIMITS.notesChars} characters`);
      if (r.minPreviousVersion !== undefined && !isSemver(r.minPreviousVersion)) bad(`${p}.minPreviousVersion: must be strict semver`);
      if (valid && isObj(inst)) {
        const rel: UpdateRelease = {
          version: r.version as string,
          publishedAt: r.publishedAt as string,
          installer: { fileName: inst.fileName as string, sizeBytes: inst.sizeBytes as number, sha256: inst.sha256 as string },
          notes: r.notes as string,
        };
        if (r.minPreviousVersion !== undefined) rel.minPreviousVersion = r.minPreviousVersion as string;
        releases.push(rel);
      }
    });
  }

  const sig = raw.signature;
  if (!isObj(sig)) errors.push('$.signature: must be an object');
  else {
    warnUnknown(sig, SIGNATURE_KEYS, '$.signature', warnings);
    if (sig.alg !== SIGNATURE_ALG) errors.push(`$.signature.alg: must be "${SIGNATURE_ALG}"`);
    if (!nonEmpty(sig.keyId)) errors.push('$.signature.keyId: must be a non-empty string');
    if (typeof sig.value !== 'string' || !sig.value || sig.value.length > 4096 || !B64_RE.test(sig.value)) errors.push('$.signature.value: must be base64');
  }
  if (errors.length > 0 || !isObj(sig)) return fail();
  return {
    ok: true,
    errors: [],
    warnings,
    manifest: {
      format: UPDATE_MANIFEST_FORMAT,
      version: UPDATE_MANIFEST_VERSION,
      product: raw.product as string,
      channel: raw.channel as UpdateChannel,
      releases,
      signature: { alg: SIGNATURE_ALG, keyId: sig.keyId as string, value: sig.value as string },
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

/** Deterministic key-sorted JSON of the manifest payload. A top-level `signature` key is always excluded. */
export function canonicalizePayload(manifestWithoutSignature: unknown): string {
  if (!isObj(manifestWithoutSignature)) return canonical(manifestWithoutSignature);
  const { signature: _ignored, ...rest } = manifestWithoutSignature;
  return canonical(rest);
}

/** Validates a trusted-key list: array of {keyId, publicKeyJwk}. Returns the valid keys and $-path errors. */
export function normalizeTrustedKeys(raw: unknown): { keys: TrustedKey[]; errors: string[] } {
  const errors: string[] = [];
  const keys: TrustedKey[] = [];
  if (!Array.isArray(raw)) return { keys, errors: ['$: must be an array of {keyId, publicKeyJwk}'] };
  raw.slice(0, 20).forEach((k: unknown, i: number) => {
    if (!isObj(k)) return void errors.push(`$[${i}]: must be an object`);
    if (!nonEmpty(k.keyId)) return void errors.push(`$[${i}].keyId: must be a non-empty string`);
    if (!isObj(k.publicKeyJwk)) return void errors.push(`$[${i}].publicKeyJwk: must be an object`);
    if ('d' in k.publicKeyJwk) return void errors.push(`$[${i}].publicKeyJwk: must be a public key (private "d" present)`);
    keys.push({ keyId: k.keyId, publicKeyJwk: { ...k.publicKeyJwk } });
  });
  if (raw.length > 20) errors.push('$: at most 20 trusted keys');
  return { keys, errors };
}

type Subtle = {
  importKey: (...args: unknown[]) => Promise<unknown>;
  verify: (...args: unknown[]) => Promise<boolean>;
  digest: (...args: unknown[]) => Promise<ArrayBuffer>;
};

function getSubtle(): Subtle | null {
  try {
    const c = (globalThis as { crypto?: { subtle?: unknown } }).crypto;
    const s = c?.subtle as Subtle | undefined;
    return s && typeof s.importKey === 'function' && typeof s.verify === 'function' && typeof s.digest === 'function' ? s : null;
  } catch {
    return null;
  }
}

/** Verifies the ECDSA P-256 / SHA-256 signature over the UTF-8 canonical payload. Never throws. */
export async function verifyManifestSignature(manifest: UpdateManifest, trustedKeys: unknown): Promise<SignatureResult> {
  const keyId = isObj(manifest) && isObj(manifest.signature) && typeof manifest.signature.keyId === 'string' ? manifest.signature.keyId : null;
  try {
    const subtle = getSubtle();
    if (!subtle) return { ok: false, reason: 'crypto-unavailable', keyId };
    if (!keyId || manifest.signature.alg !== SIGNATURE_ALG) return { ok: false, reason: 'bad-signature', keyId };
    const { keys } = normalizeTrustedKeys(trustedKeys);
    const trusted = keys.find((k) => k.keyId === keyId);
    if (!trusted) return { ok: false, reason: 'untrusted-key', keyId };
    const sigBytes = decodeBase64(manifest.signature.value);
    if (!sigBytes) return { ok: false, reason: 'bad-signature', keyId };
    let key: unknown;
    try {
      key = await subtle.importKey('jwk', trusted.publicKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      return { ok: false, reason: 'bad-key', keyId };
    }
    const data = new TextEncoder().encode(canonicalizePayload(manifest));
    let ok = false;
    try {
      ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, data);
    } catch {
      ok = false;
    }
    return ok ? { ok: true, reason: 'ok', keyId } : { ok: false, reason: 'bad-signature', keyId };
  } catch {
    return { ok: false, reason: 'bad-signature', keyId };
  }
}

function parseSemver(v: string): { nums: [number, number, number]; pre: string[] } | null {
  if (!isSemver(v)) return null;
  const m = SEMVER_RE.exec(v)!;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Strict semver comparison (-1, 0, 1) with prerelease ordering; build metadata ignored. Returns null if either is invalid. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function plan(status: UpdatePlanStatus, release: UpdateRelease | null, message: string): UpdatePlan {
  return { status, release, installerSha256: release ? release.installer.sha256 : null, message, note: NO_DOWNLOAD_NOTE };
}

/** Plans (never performs) an update. The stable channel ignores prerelease versions when a final release exists. */
export function planUpdate(manifest: UpdateManifest, installedVersion: string, signatureResult: SignatureResult | null | undefined): UpdatePlan {
  if (!signatureResult || signatureResult.ok !== true || signatureResult.reason !== 'ok') {
    return plan('signature-invalid', null, `Signature not verified (${signatureResult?.reason ?? 'missing'}); no release is offered.`);
  }
  let candidates = manifest.releases.filter((r) => isSemver(r.version));
  if (manifest.channel === 'stable') {
    const finals = candidates.filter((r) => !r.version.split('+')[0].includes('-'));
    if (finals.length > 0) candidates = finals;
  }
  if (candidates.length === 0) return plan('signature-invalid', null, 'The manifest has no usable releases.');
  const latest = candidates.reduce((best, r) => (compareVersions(r.version, best.version) === 1 ? r : best));
  if (!isSemver(installedVersion)) {
    return plan('min-version-unmet', latest, 'The installed version is not strict semver, so the minimum previous version cannot be confirmed.');
  }
  const cmp = compareVersions(latest.version, installedVersion);
  if (cmp === 0) return plan('up-to-date', latest, `Installed version ${installedVersion} is the newest release in this manifest.`);
  if (cmp === -1) return plan('downgrade-blocked', latest, `The newest release ${latest.version} is older than installed ${installedVersion}; downgrades are blocked.`);
  if (latest.minPreviousVersion && compareVersions(installedVersion, latest.minPreviousVersion) === -1) {
    return plan('min-version-unmet', latest, `Release ${latest.version} requires at least ${latest.minPreviousVersion} installed first; installed is ${installedVersion}.`);
  }
  return plan('update-available', latest, `Release ${latest.version} is newer than installed ${installedVersion}.`);
}

function validEntry(e: unknown): InstallEntry | null {
  if (!isObj(e)) return null;
  if (!isSemver(e.version) || !isIsoTimestamp(e.installedAt) || !isSha256Hex(e.installerSha256) || e.source !== 'manual') return null;
  return { version: e.version, installedAt: e.installedAt, installerSha256: e.installerSha256.toLowerCase(), source: 'manual' };
}

function sortCap(entries: InstallEntry[]): InstallEntry[] {
  return entries
    .map((e, i) => ({ e, i, t: Date.parse(e.installedAt) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.e)
    .slice(0, UPDATE_LIMITS.ledgerEntries);
}

/** Keeps only valid manual entries, newest first, capped at UPDATE_LIMITS.ledgerEntries. */
export function normalizeInstallLedger(raw: unknown): InstallEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: InstallEntry[] = [];
  for (const e of raw.slice(0, 200)) {
    const v = validEntry(e);
    if (v) out.push(v);
  }
  return sortCap(out);
}

/** Records a manually reported install. Validates input; returns the new ledger (newest 20) or errors. */
export function recordInstall(ledger: unknown, entry: unknown): { ok: boolean; ledger: InstallEntry[]; errors: string[] } {
  const current = normalizeInstallLedger(ledger);
  const errors: string[] = [];
  const e = isObj(entry) ? entry : {};
  if (!isSemver(e.version)) errors.push('version: must be strict semver');
  if (!isIsoTimestamp(e.installedAt)) errors.push('installedAt: must be an ISO 8601 timestamp');
  if (!isSha256Hex(e.installerSha256)) errors.push('installerSha256: must be 64 hex characters');
  if (e.source !== 'manual') errors.push('source: must be "manual"');
  const v = validEntry(e);
  if (errors.length > 0 || !v) return { ok: false, ledger: current, errors };
  return { ok: true, ledger: sortCap([v, ...current]), errors: [] };
}

/** Plans (never applies) a rollback to the newest recorded version older than the current one. */
export function planRollback(ledger: unknown, currentVersion: string): RollbackPlan {
  const entries = normalizeInstallLedger(ledger);
  if (!isSemver(currentVersion)) return { possible: false, target: null, steps: [], applied: false, reason: 'The current version is not strict semver.' };
  const target = entries.find((e) => compareVersions(e.version, currentVersion) === -1) ?? null;
  if (!target) return { possible: false, target: null, steps: [], applied: false, reason: `No recorded version older than ${currentVersion}.` };
  const texts = [
    `Confirm you want to roll back from ${currentVersion} to ${target.version}.`,
    `Obtain the ${target.version} installer yourself and check its SHA-256 equals ${target.installerSha256}.`,
    `Back up your data folder before changing the installed version.`,
    `Run the verified ${target.version} installer manually.`,
    `Record ${target.version} here as the installed version once it finishes.`,
  ];
  return {
    possible: true,
    target,
    steps: texts.map((text, i) => ({ order: i + 1, text, requiresConfirmation: true as const })),
    applied: false,
    reason: `Rollback target is ${target.version}, recorded at ${target.installedAt}. ${NO_ROLLBACK_NOTE}`,
  };
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Computes SHA-256 of bytes with crypto.subtle.digest and compares with expectedHex (case-insensitive). Never throws. */
export async function verifyDigestHex(expectedHex: string, bytes: Uint8Array): Promise<{ ok: boolean; actualHex: string | null; reason: 'ok' | 'mismatch' | 'bad-expected' | 'bad-input' | 'crypto-unavailable' }> {
  if (!isSha256Hex(expectedHex)) return { ok: false, actualHex: null, reason: 'bad-expected' };
  if (!(bytes instanceof Uint8Array)) return { ok: false, actualHex: null, reason: 'bad-input' };
  const subtle = getSubtle();
  if (!subtle) return { ok: false, actualHex: null, reason: 'crypto-unavailable' };
  try {
    const actualHex = toHex(await subtle.digest('SHA-256', new Uint8Array(bytes)));
    const ok = actualHex === expectedHex.toLowerCase();
    return { ok, actualHex, reason: ok ? 'ok' : 'mismatch' };
  } catch {
    return { ok: false, actualHex: null, reason: 'crypto-unavailable' };
  }
}
