// Small JSON sidecar files next to the main store (routines, usage ledger, integration preferences, model profile).
// Captain integration glue: bounded reads, atomic writes, no Electron imports. Corrupt or oversized files read as null.
import {promises as fsp} from 'node:fs';
import path from 'node:path';

export interface SidecarFs {
  readFile(file: string): Promise<string | null>;
  writeFile(file: string, data: string): Promise<void>;
}

export interface JsonSidecar {
  readonly file: string;
  load(): Promise<unknown>;
  save(data: unknown): Promise<void>;
}

export const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

const nodeFs: SidecarFs = {
  async readFile(file) {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_SIDECAR_BYTES) return null;
      return await fsp.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  },
  async writeFile(file, data) {
    await fsp.mkdir(path.dirname(file), {recursive: true});
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await fsp.open(tmp, 'w');
    try { await handle.writeFile(data, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(tmp, file);
  },
};

/** One JSON document per name under `dir`. Writes are serialized per sidecar so a slow save cannot be overtaken. */
export function createJsonSidecar(dir: string, name: string, fs: SidecarFs = nodeFs): JsonSidecar {
  if (!NAME_RE.test(name)) throw new Error(`Sidecar name "${name}" is not valid`);
  const file = path.join(dir, `${name}.json`);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    file,
    async load() {
      const raw = await fs.readFile(file);
      if (raw === null || raw.length > MAX_SIDECAR_BYTES) return null;
      try { return JSON.parse(raw) as unknown; } catch { return null; }
    },
    save(data) {
      const text = JSON.stringify(data);
      if (typeof text !== 'string') return Promise.reject(new Error('Sidecar data is not serialisable'));
      if (text.length > MAX_SIDECAR_BYTES) return Promise.reject(new Error('Sidecar data is too large'));
      const next = queue.catch(() => undefined).then(() => fs.writeFile(file, text));
      queue = next;
      return next;
    },
  };
}
