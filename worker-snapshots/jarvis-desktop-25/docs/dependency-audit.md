# Dependency audit: Desktop Companion

Scope: `package.json` and `package-lock.json` at commit `2fc88a8`. Date: 14 October 2026. Owner: dependency audit worker (findings for root to review and integrate).

Product name in user-facing text is **Desktop Companion**, which is temporary. Technical identifiers (`jarvis-desktop`, `in.local.jarvis.desktop`) are kept for compatibility.

**Status: licence compliance is NOT verified.** This audit read the lockfile only. No licence was confirmed for any package, and no licence conclusion is drawn here. Acceptance item A5 (`docs/acceptance.md`) stays open.

## 1. What the lockfile shows

Checked with a read-only Node script over `package-lock.json`. No install, no network.

| Fact | Result |
|---|---|
| Lockfile version | 3 |
| Installed packages (excluding root) | 380 |
| Packages with a `license` field in the lock | 0 of 380 (the lock format does not record licences) |
| Root `package.json` `license` field | Absent. `"private": true`. No `LICENSE` file is tracked in the repository. |
| Package sources | All 380 resolve to `registry.npmjs.org`. All have `integrity` hashes. No git, file, or tarball sources. |
| Production closure (`dev` flag not set) | 4 packages: `react@19.2.0`, `react-dom@19.2.0`, `scheduler@0.27.0`, `@phosphor-icons/react@2.1.10` |
| Development-only packages | 376 (build and packaging tooling, including Electron and electron-builder) |
| Packages restricted to one OS/CPU | 52 (`@esbuild/*`, `@rollup/*`, `fsevents`) |
| Packages with install scripts | 3: `esbuild`, `electron-winstaller`, `fsevents` (darwin only) |
| Deprecated packages in the lock | 4: `boolean@3.2.0` (optional), `glob@7.2.3`, `inflight@1.0.6`, `rimraf@2.6.3` |
| Non-code files tracked in git | None. 92 tracked files: code, config, docs, PowerShell helpers. No fonts, images, icons, sounds, or model files. |

Shipping scope comes from `package.json` `build.files`: `dist/**`, `dist-electron/**`, `native/**`, `package.json`, packaged with Electron into an NSIS installer. The Electron runtime is therefore part of what is distributed even though it is listed under `devDependencies`.

## 2. Licence verification needs

Every row is **Unresolved**. Each row says what must be checked before a commercial release, not what the answer is.

| # | Component | Why it matters for distribution | Verification needed |
|---|---|---|---|
| 1 | Root project (`jarvis-desktop`) | No licence declared. This is an owner decision, not a lookup. | Owner chooses a licence and adds `LICENSE` and the `license` field. Root owns `package.json`. |
| 2 | `react`, `react-dom`, `scheduler` (19.2.0 / 19.2.0 / 0.27.0) | Bundled into the renderer by Vite. | Read each package's licence file and `package.json` `license` field from the installed copy. Confirm the bundled `dist/` keeps any required notice. |
| 3 | `@phosphor-icons/react` 2.1.10 | Bundled into the renderer. | Check the package licence. Check separately whether the icon artwork has its own terms, since icon sets are often licensed apart from code. |
| 4 | Electron 44.7.0 | Packaged into the installer as the runtime. It bundles Chromium and other third-party components, each with notices. `@electron/get` fetches the binary, so the artifact to inspect is the downloaded release. | Inspect the licence and third-party notice files in the downloaded Electron release. Confirm which of them must ship with the installer. |
| 5 | `electron-builder` 26.15.3 and its runtime dependencies (`app-builder-lib`, `builder-util`, `dmg-builder`, and others) | A build tool. Its output is the installer. It may download helper binaries at packaging time (the resume plan notes the electron-builder tool cache). | List the helper binaries a packaging run fetches. Confirm the licence for each, and whether any of them is included in the release artifact. |
| 6 | Windows installer and signing helpers: `electron-winstaller` (install script), `electron-builder-squirrel-windows`, `@electron/windows-sign`, `postject`, `temp`, `cross-dirname` | Dev or optional. `package.json` sets `signAndEditExecutable: false`. The Squirrel path is probably unused with NSIS, but the lock does not show that. | Confirm whether any of these reach the NSIS output. If they do, check their licences. |
| 7 | `esbuild` 0.28.2 and `@esbuild/*`; `rollup` 4.59.0 and `@rollup/*`; `vite` 7.3.7; `typescript` 5.9.3 | Build tools. Bundlers can keep licence comments (`/*! */`, `@license`) in their output. | Check the built `dist/` and `dist-electron/` for retained third-party notices. Check licences of the platform packages used on the build machine (`win32-x64`). |
| 8 | The remaining ~370 development-only transitive packages | Not in the `build.files` shipping set. Still needed for a complete record and for any SBOM. | Collect licence data for all 380 packages (see section 4). |
| 9 | Deprecated or unmaintained packages: `glob@7.2.3` (reached through `@electron/asar` and `rimraf`), `rimraf@2.6.3`, `inflight@1.0.6`, `boolean@3.2.0` | Not a licence issue as such. These are maintenance and security flags in the build graph. | Check whether a newer version can be used through the existing parent packages. Do not change versions without root approval. |
| 10 | Install scripts (`esbuild`, `electron-winstaller`, `fsevents`) | Not a licence issue. They run during `npm ci` unless `--ignore-scripts` is used. | Review the scripts as part of the security review. This audit did not read them. |
| 11 | Non-npm third-party material | None tracked (see section 1). | Re-check this whenever a font, icon set, sound, ASR model, or mod is added. Roadmap items G3 (local ASR) and G5 (Windows mods) need their own licence gate under `docs/architecture.md` section 10 ("Feasibility and experimental gates"). |

## 3. Not verified in this audit

- No `node_modules` exists in this worktree, so no installed `package.json` licence field or `LICENSE` file was read. Licence values were not extracted for any package.
- No registry metadata was queried. The lockfile holds no licence data, and registry metadata is not an authoritative licence source anyway. Licence text in the installed packages is the source to check.
- `npm audit` was not run. It needs network access, and security advisories are outside this licence review.
- The Electron release and electron-builder helper downloads were not inspected.
- Nothing was installed, built, or executed. No files other than this one were changed.
- This is an engineering inventory, not legal advice. The final licence position for a commercial release needs the owner's decision and, if required, counsel's review.

## 4. Repeatable check for root

Once root authorises a repo-local install, run these in PowerShell from the worktree root:

```powershell
npm ci --ignore-scripts
node licence-list.mjs > licence-list.txt
```

`licence-list.mjs` should be saved in a separate scratch directory, not in the repository. It uses only Node built-ins and does not add a dependency:

```js
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const out = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (name.startsWith("@")) { walk(p); continue; }
    const pj = join(p, "package.json");
    if (existsSync(pj)) {
      const j = JSON.parse(readFileSync(pj, "utf8"));
      const lic = typeof j.license === "object" ? j.license?.type : j.license;
      const file = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"].some((f) => existsSync(join(p, f)));
      out.push(`${j.name}@${j.version}\t${lic ?? "MISSING"}\tlicenseFile=${file}`);
    }
    if (existsSync(join(p, "node_modules"))) walk(join(p, "node_modules"));
  }
};
walk("node_modules");
console.log(out.sort().join("\n"));
```

Run it from the worktree root, so `node_modules` resolves relative to the current directory. Rows with `MISSING` or `licenseFile=false` are the items that still need manual reading. Any licence text that cannot be classified stays Unresolved.

Expected output: 380 rows, one per locked package. The review should check the 4 production rows first, then the Electron and electron-builder rows, then the rest.

## 5. Open items for root

1. Choose the project licence and add it to `package.json` and a root `LICENSE` (row 1).
2. Authorise a repo-local `npm ci --ignore-scripts` so section 4 can run. This is an install into the gitignored `node_modules/`, not a global install.
3. Decide the process for capturing Electron and electron-builder notice files for the installer (rows 4 and 5).
4. Keep acceptance item A5 open until section 4 produces a complete, reviewed table.
