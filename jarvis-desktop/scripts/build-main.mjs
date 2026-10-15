import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(root, 'native');

// Helper integrity manifest (NSR-13): SHA-256 of every native/*.ps1, embedded into the main bundle as __NATIVE_MANIFEST__ so the
// runner can refuse a helper that was changed after the build. Same format as electron/native/integrity.ts (version 1, sha256).
const files = {};
for (const name of readdirSync(nativeDir).filter((f) => f.toLowerCase().endsWith('.ps1')).sort()) {
  files[name] = createHash('sha256').update(readFileSync(path.join(nativeDir, name))).digest('hex');
}
if (!files['common.ps1']) throw new Error('native/common.ps1 is missing; refusing to build without the shared helper module');
const manifest = {version: 1, algorithm: 'sha256', files};

mkdirSync(path.join(root, 'dist-electron'), {recursive: true});
writeFileSync(path.join(root, 'dist-electron', 'native-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

await build({entryPoints: ['electron/main.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist-electron/main.cjs', external: ['electron'], target: 'node22', define: {__NATIVE_MANIFEST__: JSON.stringify(manifest)}});
await build({entryPoints: ['electron/preload.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist-electron/preload.cjs', external: ['electron'], target: 'node22'});
