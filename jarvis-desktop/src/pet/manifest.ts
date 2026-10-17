/**
 * Pet pack manifest (`desktop-companion/pet-pack@1`, PET-RENDERER-PLAN.md section 2). Parsing is strict: unknown
 * keys are rejected at every level, the atlas must be a plain file inside the pack folder, and approval needs a
 * named approver and date. The result is a fresh frozen object, never the parsed input. A pack is approved for
 * the product only by its recorded review status, never because it exists.
 */
import { PET_ATLAS } from './contract';

export const PET_PACK_FORMAT = 'desktop-companion/pet-pack@1';

export type PetReviewStatus = 'concept' | 'in-review' | 'approved';
export type PetRendering = 'smooth' | 'pixelated';

export type PetManifest = Readonly<{
  format: typeof PET_PACK_FORMAT;
  id: string;
  name: string;
  description: string;
  spriteVersion: 2;
  atlas: string;
  atlasSha256: string;
  rendering: PetRendering;
  /** Ground-contact point inside a cell, in cell pixels. */
  anchor: Readonly<{ x: number; y: number }>;
  review: Readonly<{ status: PetReviewStatus; approvedBy?: string; approvedOn?: string; notes?: string }>;
  /** Where the art pipeline recorded its own QA gates. Required once a pack is approved. */
  qa?: Readonly<{ tool: string; atlasValidation: string; petQuality: string }>;
  source: string;
  license: string;
}>;

export type ManifestResult = { ok: true; manifest: PetManifest } | { ok: false; errors: string[] };

const REVIEW_STATUSES: readonly PetReviewStatus[] = ['concept', 'in-review', 'approved'];
const RENDERINGS: readonly PetRendering[] = ['smooth', 'pixelated'];
const TOP_KEYS = ['format', 'id', 'name', 'description', 'spriteVersion', 'atlas', 'atlasSha256', 'rendering', 'anchor', 'review', 'qa', 'source', 'license'];
const OPTIONAL_TOP = new Set(['qa']);
const ANCHOR_KEYS = ['x', 'y'];
const REVIEW_KEYS = ['status', 'approvedBy', 'approvedOn', 'notes'];
const QA_KEYS = ['tool', 'atlasValidation', 'petQuality'];

const ID_RE = /^[a-z0-9-]{1,40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ATLAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.(?:webp|png)$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type Obj = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Obj => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const isCalendarDate = (v: string): boolean => {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

/** A relative path inside the pack folder: plain segments separated by '/', no '.', '..', drive or backslash. */
const isPackRelativePath = (v: string): boolean => v.length <= 200 && v.split('/').every((s) => PATH_SEGMENT_RE.test(s) && !s.includes('..'));

export function parsePetManifest(input: unknown): ManifestResult {
  const errors: string[] = [];
  if (!isPlainObject(input)) return { ok: false, errors: ['The manifest must be a JSON object.'] };

  const keys = (o: Obj, allowed: readonly string[], at: string, optional: ReadonlySet<string> = new Set()): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}${k} is not a known field.`);
    for (const k of allowed) if (!optional.has(k) && !Object.prototype.hasOwnProperty.call(o, k)) errors.push(`${at}${k} is required.`);
  };
  const str = (v: unknown, field: string): string => {
    if (typeof v === 'string') return v;
    if (v !== undefined) errors.push(`${field} must be a string.`);
    return '';
  };
  const text = (v: unknown, field: string, min: number, max: number, multiline = false): string => {
    if (typeof v !== 'string') return str(v, field);
    if (v.length < min || v.length > max) errors.push(min > 0 ? `${field} must be ${min}-${max} characters.` : `${field} must be at most ${max} characters.`);
    else if (!multiline && CONTROL_RE.test(v)) errors.push(`${field} must not contain control characters.`);
    return v;
  };
  const matching = (v: unknown, field: string, re: RegExp, message: string): string => {
    if (typeof v !== 'string') return str(v, field);
    if (!re.test(v)) errors.push(message);
    return v;
  };
  const object = (v: unknown, field: string): Obj | null => {
    if (v === undefined) return null;
    if (!isPlainObject(v)) {
      errors.push(`${field} must be an object.`);
      return null;
    }
    return v;
  };

  keys(input, TOP_KEYS, '', OPTIONAL_TOP);

  if (input.format !== undefined && input.format !== PET_PACK_FORMAT) errors.push(`format must be "${PET_PACK_FORMAT}".`);
  if (input.spriteVersion !== undefined && input.spriteVersion !== PET_ATLAS.spriteVersion) errors.push(`spriteVersion must be ${PET_ATLAS.spriteVersion}.`);

  const id = matching(input.id, 'id', ID_RE, 'id must be 1-40 characters of a-z, 0-9 and "-".');
  const name = text(input.name, 'name', 1, 40);
  const description = text(input.description, 'description', 0, 200, true);
  const atlas = str(input.atlas, 'atlas');
  if (typeof input.atlas === 'string') {
    if (/[/\\]/.test(atlas)) errors.push('atlas must be a plain file name in the pack folder, without path separators.');
    else if (!/\.(?:webp|png)$/.test(atlas)) errors.push('atlas must be a .webp or .png file.');
    else if (!ATLAS_RE.test(atlas) || atlas.includes('..')) errors.push('atlas must be a plain file name of letters, digits, ".", "_" or "-", not starting with ".", at most 64 characters before the extension.');
  }
  const atlasSha256 = matching(input.atlasSha256, 'atlasSha256', SHA256_RE, 'atlasSha256 must be 64 lower-case hex characters.');

  if (input.rendering !== undefined && !RENDERINGS.includes(input.rendering as PetRendering)) errors.push('rendering must be "smooth" or "pixelated".');

  let anchorX = 0;
  let anchorY = 0;
  const anchor = object(input.anchor, 'anchor');
  if (anchor) {
    keys(anchor, ANCHOR_KEYS, 'anchor.');
    const inside = (v: unknown, size: number, field: string): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        if (v !== undefined) errors.push(`${field} must be a number.`);
        return 0;
      }
      if (v < 0 || v >= size) errors.push(`${field} must lie inside the ${PET_ATLAS.cellWidth}x${PET_ATLAS.cellHeight} cell (0 to ${size - 1}).`);
      return v;
    };
    anchorX = inside(anchor.x, PET_ATLAS.cellWidth, 'anchor.x');
    anchorY = inside(anchor.y, PET_ATLAS.cellHeight, 'anchor.y');
  }

  let review: PetManifest['review'] = { status: 'concept' };
  const rv = object(input.review, 'review');
  if (rv) {
    keys(rv, REVIEW_KEYS, 'review.', new Set(['approvedBy', 'approvedOn', 'notes']));
    const status = rv.status as PetReviewStatus;
    if (rv.status !== undefined && !REVIEW_STATUSES.includes(status)) errors.push('review.status must be "concept", "in-review" or "approved".');
    const approvedBy = rv.approvedBy === undefined ? undefined : text(rv.approvedBy, 'review.approvedBy', 1, 80);
    const approvedOn = rv.approvedOn === undefined ? undefined : str(rv.approvedOn, 'review.approvedOn');
    if (typeof rv.approvedOn === 'string' && !isCalendarDate(rv.approvedOn)) errors.push('review.approvedOn must be a calendar date written YYYY-MM-DD.');
    const notes = rv.notes === undefined ? undefined : text(rv.notes, 'review.notes', 0, 1000, true);
    if (status === 'approved') {
      if (rv.approvedBy === undefined) errors.push('review.approvedBy is required when review.status is "approved".');
      if (rv.approvedOn === undefined) errors.push('review.approvedOn is required when review.status is "approved".');
      if (input.qa === undefined) errors.push('qa is required when review.status is "approved".');
    }
    review = {
      status,
      ...(approvedBy !== undefined ? { approvedBy } : {}),
      ...(approvedOn !== undefined ? { approvedOn } : {}),
      ...(notes !== undefined ? { notes } : {}),
    };
  }

  let qa: PetManifest['qa'];
  const q = object(input.qa, 'qa');
  if (q) {
    keys(q, QA_KEYS, 'qa.');
    const tool = text(q.tool, 'qa.tool', 1, 200);
    const reportPath = (v: unknown, field: string): string => {
      const s = text(v, field, 1, 200);
      if (typeof v === 'string' && !isPackRelativePath(s)) errors.push(`${field} must be a relative path inside the pack folder.`);
      return s;
    };
    qa = Object.freeze({ tool, atlasValidation: reportPath(q.atlasValidation, 'qa.atlasValidation'), petQuality: reportPath(q.petQuality, 'qa.petQuality') });
  }

  const source = text(input.source, 'source', 1, 500, true);
  const license = text(input.license, 'license', 1, 200);

  if (errors.length) return { ok: false, errors };
  const manifest: PetManifest = Object.freeze({
    format: PET_PACK_FORMAT,
    id,
    name,
    description,
    spriteVersion: 2,
    atlas,
    atlasSha256,
    rendering: input.rendering as PetRendering,
    anchor: Object.freeze({ x: anchorX, y: anchorY }),
    review: Object.freeze(review),
    ...(qa ? { qa } : {}),
    source,
    license,
  });
  return { ok: true, manifest };
}

/** True only for a pack whose recorded review says the owner approved it, with who and when. */
export function isApprovedForProduct(manifest: PetManifest | null | undefined): boolean {
  const r = manifest?.review;
  return !!r && r.status === 'approved' && typeof r.approvedBy === 'string' && r.approvedBy.length > 0 && typeof r.approvedOn === 'string' && isCalendarDate(r.approvedOn);
}
