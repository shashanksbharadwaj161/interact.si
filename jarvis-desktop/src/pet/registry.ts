/**
 * Bundled pet packs (assets/pets/<id>/pet.json + atlas). Manifests are read at build time; each atlas is a lazy chunk
 * holding its bytes as an inline data URL, so the page decodes real bytes (SHA-256 check, untainted canvas) without
 * fetch or file:// image loading, and only when a pack is actually shown. Nothing here draws anything.
 */
import { parsePetManifest, type PetManifest } from './manifest';

export type PackEntry = Readonly<{
  /** Folder name; must equal the manifest id. */
  folder: string;
  manifest: PetManifest | null;
  errors: readonly string[];
  /** Resolves to the atlas as a data URL; null when the named atlas file is missing. */
  loadAtlas: (() => Promise<string>) | null;
}>;

const folderOf = (key: string): string | null => /\/assets\/pets\/([^/]+)\//.exec(key)?.[1] ?? null;

/** Pure: pairs manifests with atlas loaders by folder. Exported for tests. */
export function packsFrom(manifests: Record<string, unknown>, atlases: Record<string, unknown>): PackEntry[] {
  const out: PackEntry[] = [];
  for (const [key, raw] of Object.entries(manifests)) {
    const folder = folderOf(key);
    if (!folder) continue;
    const parsed = parsePetManifest(raw);
    if (!parsed.ok) {
      out.push(Object.freeze({ folder, manifest: null, errors: parsed.errors, loadAtlas: null }));
      continue;
    }
    const m = parsed.manifest;
    const errors: string[] = [];
    if (m.id !== folder) errors.push(`The folder "${folder}" must be named after the pack id "${m.id}".`);
    const atlasKey = Object.keys(atlases).find((k) => folderOf(k) === folder && k.endsWith(`/${m.atlas}`));
    const loader = atlasKey ? (atlases[atlasKey] as () => Promise<string>) : null;
    if (!loader) errors.push(`The atlas file "${m.atlas}" is missing from assets/pets/${folder}/.`);
    out.push(Object.freeze({ folder, manifest: m, errors, loadAtlas: errors.length ? null : loader }));
  }
  return out.sort((a, b) => a.folder.localeCompare(b.folder));
}

let cached: PackEntry[] | null = null;

export function listPetPacks(): PackEntry[] {
  if (cached) return cached;
  const manifests = import.meta.glob('../../assets/pets/*/pet.json', { eager: true, import: 'default' });
  const atlases = import.meta.glob(['../../assets/pets/*/*.webp', '../../assets/pets/*/*.png'], { query: '?inline', import: 'default' });
  cached = packsFrom(manifests, atlases);
  return cached;
}
