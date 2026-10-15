# Third-party notices and licence inventory — Desktop Companion

Status: **inventory only**, prepared 14 October 2026 at baseline `b0f5c1b`. This is not a licence review, not a complete notice file, and not evidence about the installer. Acceptance item A5 (`docs/acceptance.md`) stays open.

Product name in user-facing text is **Desktop Companion**, which is temporary. Technical identifiers (`jarvis-desktop`, `in.local.jarvis.desktop`) are kept for compatibility.

## What was read, and what was not

Read:

- `package-lock.json` (lockfile v3): the locked package set, 380 entries.
- Each installed `package.json` under the repository's own `node_modules` (from `npm ci --ignore-scripts`): its `name`, `version` and the declared `license` field.
- Whether a licence-type file (`LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENCE*`, `NOTICE*`) exists in the package directory. Only the file's presence was checked.
- The built renderer bundle and the Electron main and preload bundles, for retained licence comments (`@license`, `/*!`).

Not read, and not claimed:

- The text of any licence file. Nothing was copied from one.
- The Electron runtime. `npm ci --ignore-scripts` skipped its binary download, and the download comes from outside the repository. Its bundled notices (Chromium and others) are not captured.
- The installer. `npm run package:win` was not run, so no installer contents or SHA-256 exist to inspect.
- Helper binaries that electron-builder fetches at packaging time.
- Any registry metadata. The lockfile records no licences.

"Declared" below means the `license` field in the installed `package.json`. It is a claim by the package author, not a reviewed conclusion.

## Inventory summary

| Set | Count | Notes |
|---|---|---|
| Locked packages | 380 | Lockfile v3. The source and integrity checks are from `docs/dependency-audit.md`, not re-run in this pass. |
| Production (`dev` flag not set) | 4 | `react`, `react-dom`, `scheduler`, `@phosphor-icons/react`. Bundled into the renderer. |
| Development, installed on win32-x64 | 327 | Build and packaging tooling. |
| Development, platform-specific, not installed on win32-x64 | 49 | `@esbuild/*`, `@rollup/*` and `fsevents` binaries for other OS and CPU values. |

4 + 327 + 49 = 380.

Declared licences for the 331 installed packages (4 production + 327 development):

| Declared licence | Packages |
|---|---|
| MIT | 258 |
| ISC | 36 |
| BSD-3-Clause | 10 |
| BlueOak-1.0.0 | 8 |
| Apache-2.0 | 7 |
| BSD-2-Clause | 6 |
| `WTFPL OR ISC`, `WTFPL`, `Python-2.0`, `0BSD`, `(WTFPL OR MIT)`, `(MIT OR CC0-1.0)` | 1 each (6 total) |

Less common identifiers, listed for review: `argparse@2.0.1` (Python-2.0); `chownr@3.0.0`, `isexe@3.1.5`, `isexe@4.0.0`, `minimatch@10.2.6`, `minipass@7.1.3`, `sax@1.6.1`, `tar@7.5.22`, `yallist@5.0.0` (BlueOak-1.0.0); `sanitize-filename@1.6.4` (WTFPL OR ISC); `truncate-utf8-bytes@1.0.2` (WTFPL); `utf8-byte-length@1.0.5` (WTFPL OR MIT); `tslib@2.8.1` (0BSD); `type-fest@0.13.1` (MIT OR CC0-1.0).

## Shipped set (what the installer would contain)

`build.files` in `package.json` ships `dist/**`, `dist-electron/**`, `native/**` and `package.json`, and Electron is the runtime.

| Package | Version | Scope | Declared | Licence-type file | Status |
|---|---|---|---|---|---|
| `react` | 19.2.0 | prod | MIT | present | Declared only. Text not read. |
| `react-dom` | 19.2.0 | prod | MIT | present | Declared only. Text not read. |
| `scheduler` | 0.27.0 | prod | MIT | present | Declared only. Text not read. |
| `@phosphor-icons/react` | 2.1.10 | prod | MIT | present | Code licence declared only. Icon artwork terms not checked (U3). |
| `electron` | 44.7.0 | dev, runtime in installer | MIT | present (package) | **Unresolved.** Runtime and its third-party notices not captured (U4). |

Bundled output: the renderer bundle (`dist/assets/*.js`), `dist-electron/main.cjs` and `preload.cjs` contain **no** `@license` or `/*!` comments (counted at `b0f5c1b`). Whether the MIT notice for the bundled React and icon packages must ship in a separate file is an owner or counsel decision (U2).

## Build and packaging tools (not in `build.files`)

| Package | Version | Declared | Licence-type file | Note |
|---|---|---|---|---|
| `electron-builder` | 26.15.3 | MIT | present | Packaging tool. Its output is the installer. |
| `app-builder-lib` | 26.15.3 | MIT | none | Licence file absent (U7). |
| `dmg-builder` | 26.15.3 | MIT | none | Licence file absent (U7). Not used for the NSIS target. |
| `@electron/asar` | 3.4.1 | MIT | present | Used for archive listing. |
| `electron-winstaller` | 5.4.0 | MIT | present | Has an install script. Not used by the NSIS target, but the lockfile does not prove that (U5). |
| `@electron/windows-sign` | 1.2.2 | BSD-2-Clause | present | Optional. Signing is gate G8. |
| `postject` | 1.0.0-alpha.6 | MIT | present | Optional. |
| `vite` | 7.3.7 | MIT | present | Build tool. |
| `rollup` | 4.59.0 | MIT | present | Build tool. |
| `esbuild` | 0.28.2 | MIT | present | Build tool. Has an install script. |
| `typescript` | 5.9.3 | Apache-2.0 | present | Build tool. |

Helper binaries that electron-builder downloads at packaging time (NSIS, winCodeSign and similar) are not in the npm tree and are not listed here (U5).

## Installed packages with no licence-type file (23)

Each has a declared licence in `package.json`, but no `LICENSE*`/`NOTICE*` file is in the package directory. Check the package's own repository or README before any release:

`@electron-internal/extract-zip@1.0.5` (BSD-2-Clause), `@esbuild/win32-x64@0.28.2` (MIT), `@rollup/rollup-win32-x64-gnu@4.59.0` (MIT), `@rollup/rollup-win32-x64-msvc@4.59.0` (MIT), `app-builder-lib@26.15.3` (MIT), `chromium-pickle-js@0.2.0` (MIT), `compare-version@0.1.2` (MIT), `cross-dirname@0.1.0` (MIT), `dmg-builder@26.15.3` (MIT), `emoji-regex@8.0.0` (MIT), `err-code@2.0.3` (MIT), `filelist@1.0.6` (Apache-2.0), `isarray@1.0.0` (MIT), `jake@10.9.4` (Apache-2.0), `keyv@4.5.4` (MIT), `lazy-val@1.0.5` (MIT), `node-api-version@0.2.1` (MIT), `read-binary-file-arch@1.0.6` (MIT), `temp-file@3.4.0` (MIT), `tiny-async-pool@1.3.0` (MIT), `tmp-promise@3.0.3` (MIT), `truncate-utf8-bytes@1.0.2` (WTFPL), `utf8-byte-length@1.0.5` (WTFPL OR MIT).

## Install scripts and maintenance flags

- Install scripts in the lockfile: `esbuild@0.28.2`, `electron-winstaller@5.4.0` (both installed, not executed in this worktree), and `fsevents@2.3.3` (darwin only, not installed on win32).
- Deprecated or unmaintained packages, from `docs/dependency-audit.md`: `glob@7.2.3`, `inflight@1.0.6`, `rimraf@2.6.3`, `boolean@3.2.0` (optional). These are maintenance and security flags, not licence findings. Do not change versions without root approval.

## Open items (unresolved)

| ID | Gap | Who decides or checks |
|---|---|---|
| U1 | The project declares no licence. There is no root `LICENSE` file and no `license` field in `package.json`. | Owner chooses a licence. Root owns `package.json`. |
| U2 | Licence texts for the four production packages have only their presence checked. Whether MIT notices must ship with the installer, given that the bundles keep no licence comments, is not decided. | Owner, and counsel if needed. |
| U3 | `@phosphor-icons/react` icon artwork may have terms separate from the code licence. Not checked. | Check the package's icon licence text. |
| U4 | Electron 44.7.0 runtime notices (Chromium and other components) are not captured. The binary is not in this worktree. | Run a candidate `npm ci` with scripts, then inspect the downloaded Electron release and the installed `resources` folder. |
| U5 | Whether any dev-only or install-script package (`electron-winstaller`, `@electron/windows-sign`, `postject`) reaches the NSIS output is not shown by the lockfile. | Check the packaged archive (see the checklist, §1). |
| U6 | Packaged installer contents, file size and SHA-256 are not produced. No notice in the installer has been inspected. | Run `npm run package:win` on the release candidate and record the result in `docs/release-checklist.md` §8. |
| U7 | 23 installed packages have no licence-type file (listed above). | Read each package's repository or README. |
| U8 | Helper binaries fetched by electron-builder at packaging time are not listed. | List them during U6. |
| U9 | Deprecated packages (`glob`, `inflight`, `rimraf`, `boolean`) remain in the build graph. | Root decides on version changes. |
| U10 | Non-npm third-party material: none tracked in git (see `docs/dependency-audit.md`). Roadmap items G3 (local ASR) and G5 (Windows mods) would add their own licence gates. | Re-check when such material is added. |

## Regenerating the inventory

Run from the repository root in PowerShell. Use `npm ci --ignore-scripts` for an inventory-only run. This installs into the gitignored `node_modules/` only.

```powershell
npm ci --ignore-scripts
New-Item -ItemType Directory -Force "$env:TEMP\jarvis-release-inventory" | Out-Null
# Save the script below as "$env:TEMP\jarvis-release-inventory\licence-inventory.mjs", outside the repository.
node "$env:TEMP\jarvis-release-inventory\licence-inventory.mjs" > "$env:TEMP\jarvis-release-inventory\licence-inventory.tsv"
(Get-Content "$env:TEMP\jarvis-release-inventory\licence-inventory.tsv").Count   # 381 lines: header plus 380 rows
```

Script (Node built-ins only, no new dependency):

```js
// Reads package-lock.json for the locked package set, then each installed package.json.
// Reports the declared licence field and whether a licence-type file is present. It does not read or copy licence text.
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const rows = [];
const LICENCE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt', 'NOTICE', 'NOTICE.md'];

for (const [key, meta] of Object.entries(lock.packages)) {
  if (key === '') continue; // root project
  const dir = key; // lock keys are paths such as node_modules/@scope/name
  const pj = join(dir, 'package.json');
  const installed = existsSync(pj);
  let name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  let version = meta.version ?? '';
  let licence = 'MISSING';
  let licenceFiles = 'none';
  if (installed) {
    const j = JSON.parse(readFileSync(pj, 'utf8'));
    name = j.name ?? name;
    version = j.version ?? version;
    if (typeof j.license === 'string') licence = j.license;
    else if (j.license && typeof j.license === 'object' && j.license.type) licence = j.license.type;
    else if (Array.isArray(j.licenses) && j.licenses.length) licence = j.licenses.map((l) => l.type ?? String(l)).join(' OR ');
    const found = LICENCE_FILES.filter((f) => existsSync(join(dir, f)));
    licenceFiles = found.length ? found.join(',') : 'none';
  }
  rows.push([name, version, meta.dev ? 'dev' : 'prod', meta.optional ? 'optional' : '', meta.hasInstallScript ? 'install-script' : '',
    installed ? 'installed' : 'NOT-INSTALLED', licence, licenceFiles].join('\t'));
}

rows.sort();
console.log(['name', 'version', 'scope', 'optional', 'installScript', 'state', 'declaredLicence', 'licenceFiles'].join('\t'));
console.log(rows.join('\n'));
```

Expected counts: 380 rows; 4 `prod`; 327 `dev` and `installed`; 49 `NOT-INSTALLED` (all `dev`, platform-specific); 23 installed packages with `licenceFiles` = `none`.

Reference copy: the full 380-row table produced at `b0f5c1b` is kept outside the repository, in the session artifacts folder `jarvis-desktop-46/licence-inventory.tsv`. Regenerate it rather than trusting a copy.

## Notice text (to be added after U1 and U2)

No notice text is included yet. Do not add licence texts to this file until each one has been read from the installed package. Keep the declared-licence table and the notice text separate, so that a reader can tell which is which.
