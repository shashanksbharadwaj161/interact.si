// Fetches candidate typefaces for the visual-direction board from the npm registry (Fontsource packages), without adding
// dependencies: `npm pack` downloads each tarball into a temporary folder, and only the requested latin woff2 weights and
// the package's own licence file are copied into prototype/fonts/<id>/. Writes prototype/fonts/fonts.json with the exact
// package, version, licence field (as published) and sha256 of every copied file, so licensing can be checked, not assumed.
// The board is prototype-only; nothing here ships in the app until a direction is approved.
//
// Usage: node scripts/fetch-font-candidates.mjs @fontsource/bricolage-grotesque:400,700 @fontsource-variable/figtree
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'prototype', 'fonts');
const specs = process.argv.slice(2);
if (!specs.length) throw new Error('Name at least one package, e.g. @fontsource/figtree:400,600');
fs.mkdirSync(outRoot, {recursive: true});
const manifestFile = path.join(outRoot, 'fonts.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const spec of specs) {
  // `pkg:400,600` picks static weights; for a variable package `pkg:standard` (or full, opsz, wght...) picks that axes file.
  const [pkg, weightList] = spec.split(/:(?=[\d,]+$|[a-z]+$)/);
  const variable = pkg.startsWith('@fontsource-variable/');
  const axes = weightList && /^[a-z]+$/.test(weightList) ? weightList : 'wght';
  const weights = weightList && /^[\d,]+$/.test(weightList) ? weightList.split(',') : [];
  const info = JSON.parse(execFileSync('npm', ['view', pkg, 'name', 'version', 'license', '--json'], {encoding: 'utf8'}));
  if (!/^(OFL-1\.1|Apache-2\.0)$/.test(info.license)) throw new Error(`${pkg}: licence "${info.license}" is not OFL-1.1 or Apache-2.0`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'font-pack-'));
  try {
    const tarball = execFileSync('npm', ['pack', `${pkg}@${info.version}`, '--silent'], {cwd: tmp, encoding: 'utf8'}).trim().split('\n').pop();
    execFileSync('tar', ['-xzf', tarball], {cwd: tmp});
    const pkgDir = path.join(tmp, 'package');
    const files = fs.readdirSync(path.join(pkgDir, 'files'));
    const wanted = files.filter((f) => f.endsWith('.woff2') && /-latin-/.test(f) && !/-latin-ext-/.test(f) && (variable ? f.endsWith(`-${axes}-normal.woff2`) : weights.some((w) => f.endsWith(`-latin-${w}-normal.woff2`))));
    if (!wanted.length) throw new Error(`${pkg}: no matching latin woff2 files (have: ${files.slice(0, 6).join(', ')} …)`);
    const id = pkg.split('/')[1];
    const dir = path.join(outRoot, id);
    fs.mkdirSync(dir, {recursive: true});
    const copied = [];
    for (const f of wanted) {
      fs.copyFileSync(path.join(pkgDir, 'files', f), path.join(dir, f));
      copied.push({file: `${id}/${f}`, sha256: sha(path.join(dir, f))});
    }
    const licence = fs.readdirSync(pkgDir).find((f) => /^(LICEN[SC]E|OFL)/i.test(f));
    if (!licence) throw new Error(`${pkg}: the package has no licence file`);
    fs.copyFileSync(path.join(pkgDir, licence), path.join(dir, 'LICENSE.txt'));
    const meta = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    manifest[id] = {package: pkg, version: info.version, license: info.license, family: meta.description?.match(/^Self-host the (.+?) font/)?.[1] ?? id, variable, weights: variable ? `variable (${axes} axes file)` : weights, files: copied, licenseFile: `${id}/LICENSE.txt`, licenseSha256: sha(path.join(dir, 'LICENSE.txt'))};
    console.log(`${pkg}@${info.version} ${info.license}: ${copied.map((c) => path.basename(c.file)).join(', ')}`);
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true});
  }
}
fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
