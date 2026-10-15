/**
 * Offline verification of optional model/update download manifests (feature 107).
 * Pure and DOM-free: this module never touches the network. It parses, validates and plans; it never downloads.
 */

export const DOWNLOAD_MANIFEST_FORMAT = 'desktop-companion-download-manifest';
export const DOWNLOAD_MANIFEST_VERSION = 1;
export const DOWNLOAD_MANIFEST_MAX_CHARS = 200_000;
export const DOWNLOAD_MANIFEST_MAX_ITEMS = 100;
export const DOWNLOAD_MANIFEST_MAX_SIZE_BYTES = 50 * 1024 ** 3;

export type DownloadKind = 'model' | 'update';

export interface DownloadItem {
  id: string;
  kind: DownloadKind;
  name: string;
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  license: string;
  minAppVersion?: string;
}

export interface DownloadManifest {
  format: typeof DOWNLOAD_MANIFEST_FORMAT;
  version: typeof DOWNLOAD_MANIFEST_VERSION;
  items: DownloadItem[];
}

export interface ManifestError { path: string; message: string }

export type ParseResult =
  | { ok: true; manifest: DownloadManifest; warnings: string[] }
  | { ok: false; errors: ManifestError[] };

export type PlanStatus = 'blocked-offline' | 'blocked-host' | 'ready-to-request' | 'invalid';
export interface PlanEntry { id: string; status: PlanStatus; reason: string }

const ROOT_KEYS = ['format', 'version', 'items'];
const ITEM_KEYS = ['id', 'kind', 'name', 'version', 'url', 'sha256', 'sizeBytes', 'license', 'minAppVersion'];
const SHA256_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SEMVER_RE = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalizes an allowed-hosts list: trimmed, lowercased, valid hostnames only, de-duplicated. No wildcards. */
export function normalizeAllowedHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) return [];
  const out: string[] = [];
  for (const h of hosts) {
    if (typeof h !== 'string') continue;
    const v = h.trim().toLowerCase();
    if (v && v.length <= 253 && HOST_RE.test(v) && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 50);
}

/** Splits a comma-separated hosts input into a normalized list. */
export function parseHostsInput(text: string): string[] {
  return normalizeAllowedHosts(String(text ?? '').split(','));
}

type UrlCheck = { ok: true; host: string } | { ok: false; message: string };

function checkUrlShape(url: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: 'invalid-url: must be an absolute URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, message: `non-https: protocol "${u.protocol}" is not allowed` };
  if (u.username || u.password) return { ok: false, message: 'credentials-in-url: URLs must not contain credentials' };
  if (!u.hostname) return { ok: false, message: 'invalid-url: missing host' };
  return { ok: true, host: u.hostname.toLowerCase() };
}

function validateItem(raw: unknown, i: number, warnings: string[] | null): { errors: ManifestError[]; item?: DownloadItem; host?: string } {
  const base = `items[${i}]`;
  const errors: ManifestError[] = [];
  const err = (field: string, message: string) => errors.push({ path: `${base}.${field}`, message });
  if (!isPlainObject(raw)) return { errors: [{ path: base, message: 'must be an object' }] };
  if (warnings) for (const k of Object.keys(raw)) if (!ITEM_KEYS.includes(k)) warnings.push(`unknown key "${k.slice(0, 40)}" dropped at ${base}`);

  const { id, kind, name, version, url, sha256, sizeBytes, license, minAppVersion } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) err('id', 'must be 1-64 characters: letters, digits, ".", "_", ":" or "-", starting with a letter or digit');
  if (kind !== 'model' && kind !== 'update') err('kind', 'must be "model" or "update"');
  if (typeof name !== 'string' || !name.trim() || name.length > 200) err('name', 'must be a non-empty string of at most 200 characters');
  if (typeof version !== 'string' || !version.trim() || version.length > 64) err('version', 'must be a non-empty string of at most 64 characters');
  let host: string | undefined;
  if (typeof url !== 'string' || !url || url.length > 2048) err('url', 'must be a non-empty string of at most 2048 characters');
  else {
    const c = checkUrlShape(url);
    if (c.ok) host = c.host;
    else err('url', c.message);
  }
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) err('sha256', 'must be 64 lowercase hexadecimal characters');
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > DOWNLOAD_MANIFEST_MAX_SIZE_BYTES) err('sizeBytes', 'must be a positive integer of at most 50 GiB');
  if (typeof license !== 'string' || !license.trim() || license.length > 200) err('license', 'must be a non-empty string of at most 200 characters');
  if (minAppVersion !== undefined && (typeof minAppVersion !== 'string' || !SEMVER_RE.test(minAppVersion))) err('minAppVersion', 'must look like x.y.z');
  if (errors.length) return { errors, host };
  const item: DownloadItem = {
    id: id as string, kind: kind as DownloadKind, name: (name as string).trim(), version: (version as string).trim(),
    url: url as string, sha256: sha256 as string, sizeBytes: sizeBytes as number, license: (license as string).trim(),
  };
  if (minAppVersion !== undefined) item.minAppVersion = minAppVersion as string;
  return { errors, item, host };
}

/**
 * Parses and validates a manifest (JSON text or an already-parsed value). Every item URL must be https and its host
 * must be in `allowedHosts`; the default empty list rejects every URL with "host-not-allowed".
 */
export function parseDownloadManifest(json: unknown, allowedHosts: readonly string[] = []): ParseResult {
  let text: string | undefined;
  if (typeof json === 'string') text = json;
  else {
    try { text = JSON.stringify(json); } catch { return { ok: false, errors: [{ path: '$', message: 'value cannot be serialized as JSON' }] }; }
  }
  if (text !== undefined && text.length > DOWNLOAD_MANIFEST_MAX_CHARS) {
    return { ok: false, errors: [{ path: '$', message: `oversize: manifest is longer than ${DOWNLOAD_MANIFEST_MAX_CHARS} characters` }] };
  }
  let data: unknown = json;
  if (typeof json === 'string') {
    try { data = JSON.parse(json); } catch { return { ok: false, errors: [{ path: '$', message: 'invalid JSON' }] }; }
  }
  if (!isPlainObject(data)) return { ok: false, errors: [{ path: '$', message: 'must be a JSON object' }] };

  const hosts = normalizeAllowedHosts([...allowedHosts]);
  const errors: ManifestError[] = [];
  const warnings: string[] = [];
  for (const k of Object.keys(data)) if (!ROOT_KEYS.includes(k)) warnings.push(`unknown key "${k.slice(0, 40)}" dropped at $`);
  if (data.format !== DOWNLOAD_MANIFEST_FORMAT) errors.push({ path: 'format', message: `must be "${DOWNLOAD_MANIFEST_FORMAT}"` });
  if (data.version !== DOWNLOAD_MANIFEST_VERSION) errors.push({ path: 'version', message: `must be ${DOWNLOAD_MANIFEST_VERSION}` });

  const items: DownloadItem[] = [];
  const raw = data.items;
  if (!Array.isArray(raw)) errors.push({ path: 'items', message: 'must be an array' });
  else if (raw.length < 1) errors.push({ path: 'items', message: 'must contain at least 1 item' });
  else if (raw.length > DOWNLOAD_MANIFEST_MAX_ITEMS) errors.push({ path: 'items', message: `must contain at most ${DOWNLOAD_MANIFEST_MAX_ITEMS} items` });
  else {
    const seen = new Map<string, number>();
    raw.forEach((r, i) => {
      const v = validateItem(r, i, warnings);
      errors.push(...v.errors);
      if (v.host !== undefined && !hosts.includes(v.host)) errors.push({ path: `items[${i}].url`, message: `host-not-allowed: "${v.host}" is not in the allowed hosts list` });
      const id = isPlainObject(r) && typeof r.id === 'string' ? r.id : undefined;
      if (id !== undefined) {
        const first = seen.get(id);
        if (first !== undefined) errors.push({ path: `items[${i}].id`, message: `duplicate id "${id.slice(0, 64)}" (first at items[${first}])` });
        else seen.set(id, i);
      }
      if (v.item) items.push(v.item);
    });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: { format: DOWNLOAD_MANIFEST_FORMAT, version: DOWNLOAD_MANIFEST_VERSION, items }, warnings };
}

/** Strict comparison of two SHA-256 digests; both must be 64 lowercase hex characters (uppercase is rejected). */
export function verifyDigest(expectedSha256: unknown, actualSha256: unknown): { match: boolean; reason: string } {
  if (typeof expectedSha256 !== 'string' || !SHA256_RE.test(expectedSha256)) return { match: false, reason: 'invalid-expected' };
  if (typeof actualSha256 !== 'string' || !SHA256_RE.test(actualSha256)) return { match: false, reason: 'invalid-actual' };
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= expectedSha256.charCodeAt(i) ^ actualSha256.charCodeAt(i);
  return diff === 0 ? { match: true, reason: 'match' } : { match: false, reason: 'mismatch' };
}

/**
 * Plans what would happen for each item. Nothing is ever fetched: "ready-to-request" only means the explicit online
 * opt-in is on and the host is allowed; this build still does not start any download.
 */
export function planDownload(manifest: DownloadManifest, opts: { onlineEnabled: boolean; allowedHosts: readonly string[] }): PlanEntry[] {
  const hosts = normalizeAllowedHosts([...(opts?.allowedHosts ?? [])]);
  const list: unknown[] = Array.isArray(manifest?.items) ? manifest.items.slice(0, DOWNLOAD_MANIFEST_MAX_ITEMS) : [];
  return list.map((raw, i) => {
    const v = validateItem(raw, i, null);
    const id = isPlainObject(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 64) : `items[${i}]`;
    if (!v.item) return { id, status: 'invalid', reason: v.errors.map((e) => `${e.path}: ${e.message}`).join('; ') };
    if (opts?.onlineEnabled !== true) return { id, status: 'blocked-offline', reason: 'Online downloads are not enabled; nothing will be requested.' };
    if (!v.host || !hosts.includes(v.host)) return { id, status: 'blocked-host', reason: `Host "${v.host ?? ''}" is not in the allowed hosts list.` };
    return { id, status: 'ready-to-request', reason: `Allowed host; ${formatBytes(v.item.sizeBytes)} would be verified against its SHA-256. This build does not start downloads.` };
  });
}

/** Local byte formatter (kept here so this module has no UI imports). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
