// Version/digest pins for local model files. Pure and DOM-free: no network, no filesystem. The main process hashes the
// file (electron/services/models.ts) and this module only decides what the observed digest and size mean for a pin.
// Every helper returns new arrays/objects; inputs are never mutated.

export const PIN_LIMITS = Object.freeze({maxPins: 64, digestHexLength: 64, labelMin: 1, labelMax: 80, modelIdMax: 200});

export type PinSource = 'local-file' | 'manifest';
export type PinStatus = 'match' | 'size-mismatch' | 'digest-mismatch' | 'unpinned';

export interface ModelPin {
  /** Ollama model name, for example "llama3.2:3b". */
  modelId: string;
  label: string;
  /** Lowercase SHA-256 hex of the pinned file. */
  digest: string;
  sizeBytes: number;
  /** ISO timestamp of when the pin was recorded. */
  pinnedAt: string;
  source: PinSource;
}

export interface ObservedFile {digest: string; sizeBytes: number}
export interface PinComparison {status: PinStatus; detail: string}

const SOURCES: readonly PinSource[] = ['local-file', 'manifest'];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws a descriptive Error unless v is a 64-character SHA-256 hex digest. Returns it lowercased. */
export function validateDigest(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-fA-F]+$/.test(v) || v.length !== PIN_LIMITS.digestHexLength) {
    throw new Error(`Digest must be a ${PIN_LIMITS.digestHexLength}-character SHA-256 hex string`);
  }
  return v.toLowerCase();
}

export function validatePinLabel(v: unknown): string {
  const t = typeof v === 'string' ? v.trim() : '';
  if (t.length < PIN_LIMITS.labelMin || t.length > PIN_LIMITS.labelMax || CONTROL_RE.test(t)) {
    throw new Error(`Pin label must be ${PIN_LIMITS.labelMin}-${PIN_LIMITS.labelMax} characters without control characters`);
  }
  return t;
}

export function validatePinModelId(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > PIN_LIMITS.modelIdMax || !MODEL_ID_RE.test(v)) throw new Error('Pin model id is invalid');
  return v;
}

/** Builds a validated pin, throwing a descriptive Error for any invalid field. */
export function createPin(input: {modelId: unknown; label: unknown; digest: unknown; sizeBytes: unknown; pinnedAt: unknown; source?: unknown}): ModelPin {
  const modelId = validatePinModelId(input.modelId);
  const label = validatePinLabel(input.label);
  const digest = validateDigest(input.digest);
  if (typeof input.sizeBytes !== 'number' || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('Pin size must be a whole number of bytes');
  if (typeof input.pinnedAt !== 'string' || input.pinnedAt.length > 40 || !Number.isFinite(Date.parse(input.pinnedAt))) throw new Error('Pin time must be an ISO timestamp');
  const source = input.source === undefined ? 'local-file' : input.source;
  if (!SOURCES.includes(source as PinSource)) throw new Error('Pin source must be local-file or manifest');
  return {modelId, label, digest, sizeBytes: input.sizeBytes, pinnedAt: new Date(Date.parse(input.pinnedAt)).toISOString(), source: source as PinSource};
}

/** Keeps only well-formed pins (first entry wins for a duplicate model id), at most PIN_LIMITS.maxPins. */
export function normalizePins(raw: unknown): ModelPin[] {
  if (!Array.isArray(raw)) return [];
  const out: ModelPin[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= PIN_LIMITS.maxPins) break;
    if (!isRecord(entry)) continue;
    let pin: ModelPin;
    try { pin = createPin(entry as Parameters<typeof createPin>[0]); } catch { continue; }
    const key = pin.modelId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pin);
  }
  return out;
}

export function findPin(pins: readonly ModelPin[], modelId: string): ModelPin | null {
  const key = String(modelId).toLowerCase();
  return pins.find((p) => p.modelId.toLowerCase() === key) ?? null;
}

/** Returns a new list with pin added or replacing the pin for the same model id. Throws when the list is full. */
export function upsertPin(pins: readonly ModelPin[], pin: ModelPin): ModelPin[] {
  const valid = createPin(pin);
  const key = valid.modelId.toLowerCase();
  const idx = pins.findIndex((p) => p.modelId.toLowerCase() === key);
  if (idx >= 0) return pins.map((p, i) => (i === idx ? valid : {...p}));
  if (pins.length >= PIN_LIMITS.maxPins) throw new Error(`At most ${PIN_LIMITS.maxPins} model pins can be kept; remove one first`);
  return [...pins.map((p) => ({...p})), valid];
}

/** Returns a new list without the pin for modelId (case-insensitive). */
export function removePin(pins: readonly ModelPin[], modelId: string): ModelPin[] {
  const key = String(modelId).toLowerCase();
  return pins.filter((p) => p.modelId.toLowerCase() !== key).map((p) => ({...p}));
}

export const digestPrefix = (digest: string, n = 12): string => digest.slice(0, n);

/** Compares a pin with what is on disk now. Size is checked first because it is cheap and unambiguous. */
export function comparePin(pin: ModelPin | null | undefined, observed: ObservedFile): PinComparison {
  if (!pin) return {status: 'unpinned', detail: 'This model has no version pin, so its file is not checked.'};
  const digest = validateDigest(observed.digest);
  const size = observed.sizeBytes;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new Error('Observed size must be a whole number of bytes');
  if (size !== pin.sizeBytes) {
    return {status: 'size-mismatch', detail: `The file size changed: pinned ${pin.sizeBytes} bytes, now ${size} bytes (sha256 ${digestPrefix(digest)}…). The file on disk is not the pinned version.`};
  }
  if (digest !== pin.digest) {
    return {status: 'digest-mismatch', detail: `The file contents changed: pinned sha256 ${digestPrefix(pin.digest)}…, now ${digestPrefix(digest)}… (same size, ${size} bytes). The file on disk is not the pinned version.`};
  }
  return {status: 'match', detail: `Matches the pinned sha256 ${digestPrefix(pin.digest)}… (${size} bytes).`};
}

export function isPinMismatch(status: PinStatus): boolean {
  return status === 'size-mismatch' || status === 'digest-mismatch';
}

/** Short UI text for a status. */
export function describePinStatus(status: PinStatus): string {
  switch (status) {
    case 'match': return 'Matches the pinned version';
    case 'size-mismatch': return 'File size differs from the pinned version';
    case 'digest-mismatch': return 'File contents differ from the pinned version';
    case 'unpinned': return 'Not pinned';
  }
}
