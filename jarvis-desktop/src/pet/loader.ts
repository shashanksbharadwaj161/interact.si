/**
 * Loads a pet pack for drawing (PET-RENDERER-PLAN.md section 6). Order: manifest already parsed by the registry ->
 * atlas bytes from the bundled data URL -> SHA-256 against the manifest -> decode to an ImageBitmap -> the in-app load
 * check over the decoded pixels once (only per-frame bounds and coarse hit masks are kept). Packs are cached by id
 * with reference counts; the last release closes the bitmap.
 *
 * Product mode uses only packs whose review status is "approved". Review mode may show concept or in-review packs,
 * and callers must label them with their status. Without a usable pack the result says why ("missing" or "invalid").
 */
import { checkAtlasPixels, type FrameBounds } from './atlas-check';
import { PET_ATLAS } from './contract';
import { isApprovedForProduct, type PetManifest } from './manifest';
import { listPetPacks, type PackEntry } from './registry';

export type FrameInfo = Readonly<{ bounds: FrameBounds | null; mask: Uint8Array }>;
export type ReadyPet = Readonly<{ status: 'ready'; manifest: PetManifest; bitmap: ImageBitmap; frames: ReadonlyMap<string, FrameInfo>; warnings: readonly string[] }>;
export type PetLoad = ReadyPet | Readonly<{ status: 'invalid'; id: string; errors: readonly string[] }> | Readonly<{ status: 'missing'; reason: string }>;
export type LoadMode = 'product' | 'review';

export const NO_ART_REASON = 'No approved character art is installed yet. The concept directions are waiting for review.';

/** Splits a base64 data URL into its media type and bytes. */
export function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
  if (!m) throw new Error('The atlas is not an inline base64 image.');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Decodes and checks an atlas. Exported for the review board, which loads an explicitly labelled fixture. */
export async function loadAtlas(manifest: PetManifest, dataUrl: string): Promise<PetLoad> {
  const fail = (errors: string[]): PetLoad => Object.freeze({ status: 'invalid', id: manifest.id, errors: Object.freeze(errors) });
  let bytes: Uint8Array;
  let mime: string;
  try {
    ({ bytes, mime } = decodeDataUrl(dataUrl));
  } catch (e) {
    return fail([e instanceof Error ? e.message : 'The atlas could not be read.']);
  }
  const wantMime = manifest.atlas.endsWith('.png') ? 'image/png' : 'image/webp';
  if (mime !== wantMime) return fail([`The atlas is ${mime}, but the manifest names a ${wantMime} file.`]);
  if ((await sha256Hex(bytes)) !== manifest.atlasSha256) return fail(['The atlas bytes do not match atlasSha256 in pet.json.']);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    return fail(['The atlas image could not be decoded.']);
  }
  if (bitmap.width !== PET_ATLAS.width || bitmap.height !== PET_ATLAS.height) {
    bitmap.close();
    return fail([`The atlas is ${bitmap.width}×${bitmap.height}; a v2 atlas is ${PET_ATLAS.width}×${PET_ATLAS.height}.`]);
  }
  const canvas = new OffscreenCanvas(PET_ATLAS.width, PET_ATLAS.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return fail(['The atlas could not be inspected (no 2D canvas).']);
  }
  ctx.drawImage(bitmap, 0, 0);
  const check = checkAtlasPixels(ctx.getImageData(0, 0, PET_ATLAS.width, PET_ATLAS.height).data, PET_ATLAS.width, PET_ATLAS.height);
  // Release the pixel copy now; only bounds and masks are kept.
  canvas.width = 1;
  canvas.height = 1;
  if (!check.ok) {
    bitmap.close();
    return fail(check.errors.map((e) => (e.row !== undefined ? `Row ${e.row}, frame ${e.col}: ${e.issue}` : e.issue)));
  }
  const frames = new Map<string, FrameInfo>();
  for (const [key, f] of check.frames) frames.set(key, Object.freeze({ bounds: f.bounds, mask: f.mask }));
  return Object.freeze({ status: 'ready', manifest, bitmap, frames, warnings: Object.freeze(check.warnings.map((w) => `Row ${w.row}, frame ${w.col}: ${w.issue}`)) });
}

/** Which bundled pack a mode may use, or why none. Pure over the registry entries. */
export function choosePack(packs: readonly PackEntry[], mode: LoadMode, id?: string): { entry: PackEntry } | { missing: string } | { invalid: { id: string; errors: readonly string[] } } {
  const candidates = id ? packs.filter((p) => p.folder === id) : packs;
  if (!candidates.length) return { missing: id ? `The character pack "${id}" is not installed.` : NO_ART_REASON };
  const broken = candidates.find((p) => !p.manifest || p.errors.length);
  const usable = candidates.filter((p) => p.manifest && !p.errors.length && (mode === 'review' || isApprovedForProduct(p.manifest)));
  if (usable.length) return { entry: usable[0] };
  if (broken) return { invalid: { id: broken.folder, errors: broken.errors } };
  const statuses = [...new Set(candidates.map((p) => p.manifest?.review.status))].join(', ');
  return { missing: `Character art is installed but not approved yet (${statuses}). It appears after the owner approves it.` };
}

type CacheEntry = { refs: number; promise: Promise<PetLoad> };
const cache = new Map<string, CacheEntry>();

/** Loads (or reuses) a pack. Every acquire that returns a ready pack must be paired with releasePetPack(id). */
export async function acquirePetPack(mode: LoadMode, id?: string, packs: readonly PackEntry[] = listPetPacks()): Promise<PetLoad> {
  const chosen = choosePack(packs, mode, id);
  if ('missing' in chosen) return Object.freeze({ status: 'missing', reason: chosen.missing });
  if ('invalid' in chosen) return Object.freeze({ status: 'invalid', id: chosen.invalid.id, errors: chosen.invalid.errors });
  const { entry } = chosen;
  const key = entry.folder;
  let c = cache.get(key);
  if (!c) {
    const promise = entry.loadAtlas!().then((url) => loadAtlas(entry.manifest!, url)).catch((e: unknown): PetLoad => Object.freeze({ status: 'invalid', id: key, errors: [e instanceof Error ? e.message : 'The atlas could not be loaded.'] }));
    c = { refs: 0, promise };
    cache.set(key, c);
  }
  c.refs++;
  const load = await c.promise;
  if (load.status !== 'ready') {
    // Failed loads are not kept, so a fixed pack can be retried.
    if (--c.refs <= 0) cache.delete(key);
  }
  return load;
}

export function releasePetPack(id: string): void {
  const c = cache.get(id);
  if (!c) return;
  if (--c.refs > 0) return;
  cache.delete(id);
  void c.promise.then((load) => {
    if (load.status === 'ready') load.bitmap.close();
  });
}
