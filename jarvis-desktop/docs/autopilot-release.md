# Autopilot release module — report

Role: `release`. Baseline `b0f5c1b` (autopilot baseline `c161e67`). Prepared 14 October 2026.

Scope: release checklist, third-party licence inventory, reproducible validation commands and the native manual matrix. No application code was changed. The module does not claim that the release is ready. Its gates are listed below.

## Files changed (uncommitted, for captain review)

| File | Change |
|---|---|
| `docs/release-checklist.md` | Refreshed against `b0f5c1b`. Adds validation commands, corrects stale §0 gates, adds the §5 native matrix with code state. Keeps all item IDs. |
| `docs/THIRD-PARTY-NOTICES.md` | New. Inventory of declared licence fields for the 380 locked packages, with unresolved items U1–U10 and an embedded, verified regeneration script. |
| `docs/autopilot-release.md` | New. This report. |
| `docs/autopilot-result.release.json` | New. Structured result for captain. |

Outside the repository:

- `jarvis-desktop-46/licence-inventory.tsv` in the session artifacts folder: 380 rows, the reviewable deliverable for the inventory.
- Scratch files in `%TEMP%\jarvis-release-46` (script, logs). Not part of the workspace.

Gitignored repo-local outputs created by this run: `node_modules/` (from `npm ci --ignore-scripts`), `dist/`, `dist-electron/` (from `npm run build`). Nothing global was installed.

## Validation run in this pass

| Check | Command | Result |
|---|---|---|
| Install (project-local) | `npm ci --ignore-scripts` | exit 0; lockfile unchanged |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0; vite transformed 4604 modules; `dist/` and `dist-electron/` written |
| Tests | `npm test` | 124 of 124 pass |
| Egress scan (A2) | `Select-String` for `fetch(`, `net.request`, `https?.request` in `electron/` | 0 hits |
| Name scan (X8) | recursive whole-word `Jarvis` in `src/`, `electron/`, `index.html` (58 files) | 3 hits: `electron/main.ts:20,22` (legacy folder, internal) and `electron/services/actions.ts:97` (**user-visible**) |
| Renderer Electron imports | grep `from 'electron'` under `src/` | 0 |
| Inventory | documented script run on the extracted block of `THIRD-PARTY-NOTICES.md` | identical to the saved TSV (381 lines including header) |
| Lockfile integrity | `git status` after install | clean |

Not run in this pass, with reasons:

- Electron smoke test (`scripts/smoke.cjs`): the Electron binary is absent because `--ignore-scripts` skipped its download. Its download comes from outside the repository, which is outside this worker's authorized scope.
- `npm run package:win` and `npx asar list`: need the Electron runtime and electron-builder helper downloads.
- Native checks (§5 N1–N18): they need a real Windows desktop, and this worker must not touch the user's desktop.
- `npm audit`: needs network access to advisory services, which is outside scope.
- Reading any licence text: not done. Declared licence fields and file presence only.

## Corrections to the 14 October checklist

The previous checklist was written at `2fc88a8`. These parts are now corrected:

- §0 trusted confirmation: no longer "not passed". `electron/main.ts:232` passes `confirm`, and it uses the Cancel-default dialog in `electron/ipcCore.ts`. A native manual check (N1) is still needed.
- §0 reminders: no longer "not wired". `electron/main.ts:187-202` shows notifications. The I2 claim still needs a real check.
- §0 microphone wording: still open, unchanged in substance.
- New §0 gate: the user-visible "Jarvis" string at `electron/services/actions.ts:97`.
- New §5 row N7: executable and code-running file types are **absent** from the code. The previous text described them as refused.
- §4 and §1 now cite the code locations read at `b0f5c1b`.

## Blockers and decisions for captain

These are not for the release worker to decide. Each has an owner:

1. **Release blocker, N7 (NSR-05):** no denylist for `.chm`, `.iso`, `.msix`, `.library-ms`, `.settingcontent-ms`, `.wsc`, `.sct`, `.inf`. `launch` of a local path reaches `shell.openPath` (`electron/services/actions.ts:303`). Owner: native/main or backend, depending on where the policy belongs.
2. **X8 wording:** reword `electron/services/actions.ts:97`. Owner: backend.
3. **Microphone permission (§0):** either gate `electron/main.ts:156-160` on push-to-talk, or reword B4. Decision needed from the owner.
4. **Project licence (U1):** the root declares none, and there is no `LICENSE`. Owner decision; root owns `package.json`.
5. **Candidate build (§1):** `npm ci` with scripts, then `npm run package:win`, on a Windows 11 x64 release machine. Record the installer SHA-256. The "Filename too long" warning from the install needs checking there.
6. **Notice texts (U2–U4):** read the four shipped packages' licence files, the phosphor icon artwork terms, and the Electron runtime notices from the downloaded release. Only then add notice text.
7. **Signing (G8):** not a release check, but the release note must say the build is unsigned.

Native matrix blocking rows: N1, N7, and any failure in N2, N5 or N8.

## Interfaces for captain wiring

No code interfaces. The release module exposes documents and commands:

- Release gates: `docs/release-checklist.md` §0 (gates) and §5 (blocking rows).
- Validation: the "Validation commands" section of the same file. Commands are PowerShell, repo-local, and copy-pasteable from the repository root.
- Inventory: `docs/THIRD-PARTY-NOTICES.md`, including the regeneration script and expected counts (380 rows; 4 production; 327 installed development; 49 platform-specific not installed; 23 installed without a licence-type file).

## Limitations

- No installer, SHA-256 or installed-app behaviour has been produced or inspected.
- The Electron runtime and its notices are not in this worktree.
- No native behaviour was tested on a real desktop. The §5 matrix is a manual procedure, not a result.
- Licence fields are declared values from `package.json`, not reviewed conclusions. Acceptance A5 stays open.
- No cloud API, paid service or real key was used. The only network access was the npm registry during `npm ci`.
