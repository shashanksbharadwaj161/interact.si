// Launches scripts/smoke.cjs inside the repo-local Electron with ELECTRON_RUN_AS_NODE removed, so the smoke runs as a real
// Electron app (temporary user data, offline, no desktop input) even when the parent shell sets that variable.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(process.execPath, [path.join(root, 'node_modules', 'electron', 'cli.js'), path.join(root, 'scripts', 'smoke.cjs'), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
process.exit(result.status ?? 1);
