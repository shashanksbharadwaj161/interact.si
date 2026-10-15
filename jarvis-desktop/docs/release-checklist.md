# Release checklist — Desktop Companion (first personal release)

Status: refreshed 14 October 2026 against `b0f5c1b` (autopilot baseline `c161e67`), and re-checked at `590aa55` by the acceptance pass ([milestone acceptance](milestone-acceptance.md) has the baseline record and the ordered manual checklist). The previous revision was against `2fc88a8`, and several §0 gates in it were already out of date. This is not a sign-off: no §5 native check has been run, and no installer has been built or inspected.

Line numbers in §0 to §5 are as at `b0f5c1b` unless a line says `590aa55`.

Use this on a clean Windows 11 x64 machine with the packaged build (`npm run package:win`), not `npm start` or `npm run dev`, because the dev build accepts a dev-server origin (NSR-11).

Naming: user-facing text says **Desktop Companion**. Technical identifiers stay for compatibility (`window.jarvis`, `jarvis:*` channels, `jarvis-export`, `jarvis-<uuid>.wav`, the DPAPI entropy string in `native/dpapi.ps1`).

Item IDs (A1, C5, G7, …) match `docs/acceptance.md`. Finding IDs (NSR-01 …) match `docs/native-security-review.md`. Each check is pass/fail. Record the result, the build hash and the tester in the sign-off table at the end. "Code present" below means the code was read or grepped at `b0f5c1b`; it is not a test result.

## Validation commands (repo-local, reproducible)

Run from the repository root in PowerShell. Nothing here installs globally or calls a paid API. The only network use is the npm registry during `npm ci`.

```powershell
npm ci --ignore-scripts      # project-local node_modules; skips Electron's binary download
npm run typecheck
npm run build                # typecheck, vite build, dist-electron/main.cjs
npm test                     # node --test tests/*.test.mjs
```

Result at `b0f5c1b` (14 Oct, earlier refresh): `npm ci --ignore-scripts` exit 0 with the lockfile unchanged; `typecheck` exit 0; `build` exit 0; `npm test` 124 of 124 pass.

Result at `590aa55` (14 Oct, acceptance pass): `npm ci --ignore-scripts` exit 0; `typecheck` exit 0; `build` exit 0; `npm test` 579 tests: 575 pass, 0 fail, 4 todo. `git status` prints `Filename too long` for the nested `app-builder-lib` `fs-extra` path (see §1). The earlier 124-test count is superseded.

Release candidate: use `npm ci` **with** scripts, because Electron's postinstall downloads the runtime. A `--ignore-scripts` install has no Electron binary, so the smoke test and packaging cannot run from it.

Static checks (run after the build, from the repository root):

```powershell
# A2: outbound request APIs in the Electron main process. Expect no lines, or only calls through the injected guarded fetch (`deps.fetch`, `this.d.fetch`).
Select-String -Path electron\*.ts, electron\services\*.ts -Pattern '\bfetch\(|net\.request|https?\.request'

# X8: whole-word "Jarvis" in code, UI and HTML. Expect only electron\main.ts:20 and :22 (the legacy data-folder name, not shown to users).
$files = Get-ChildItem src, electron -Recurse -File -Include *.ts, *.tsx, *.html; $files += Get-Item index.html
$files | Select-String -Pattern '\bJarvis\b' -CaseSensitive
```

Result at `b0f5c1b`: A2 returns 0 lines. X8 returns 3 lines: the two legacy-folder lines, plus `electron\services\actions.ts:97`, which is a user-visible denial reason ("…until Jarvis is restarted normally"). X8 fails until that string is reworded.

Result at `590aa55`: A2 returns 2 lines, `electron\services\integrations.ts:218` (`deps.fetch`) and `electron\services\models.ts:312` (`this.d.fetch`). Both go through the injected guarded fetch that `electron\backend.ts` passes in as `guardedFetch` (lines 209, 240, 252), so they are not direct egress; the static pattern cannot tell them apart. Accept only these two lines. X8 no longer returns `actions.ts`: the denial text now names Desktop Companion, and `index.html` has no match. The remaining X8 matches are comments and the legacy data-folder name (`electron\main.ts:24, 27`, `electron\services\lifecycle.ts:74, 80`), which are not user-visible.

Smoke test (`scripts/smoke.cjs`): not part of `npm test`. Run it by hand from a packaged-like build with `JARVIS_TEST_MODE=1`. It needs the Electron binary, so it is not run in this refresh.

## 0. Gate before any manual check

Do not start the §5 manual checks until these are true on the candidate commit. Status is as read at `b0f5c1b`.

- [ ] **Trusted confirmation is wired.** Code present: `electron/main.ts:55-60` builds `trustedConfirm` with `createTrustedConfirm` (`electron/ipcCore.ts:104`, Cancel as default, `dialog.showMessageBox` on the focused app window, the renderer never supplies the answer). `electron/main.ts:232` passes `confirm` to `createBackend`. At `590aa55` the builder is at `electron/main.ts:62-67` (`createTrustedConfirm`, `dialog.showMessageBox`); the `confirm` constant is at line 67. Still open until §5 N1 passes: a launch or capsule restore shows the native dialog.
- [ ] **Automated suites pass.** Met at `b0f5c1b` and again at `590aa55` for `typecheck`, `build` and `npm test` (579 tests, 575 pass, 0 fail, 4 todo). Left unchecked because the gate applies to the candidate commit, and the Electron smoke test is not in `npm test` and has not been run.
- [ ] **Reminders are wired or not claimed.** Code present: `electron/main.ts:187-202` (`startReminders`) shows a `Notification` for due tasks, off in test mode and safe launch. The I2 wording may stay only after a due task shows a notification on a real Windows session.
- [ ] **Mic permission wording matches the code.** Open. `electron/main.ts:156-160` grants `media` audio to the app page whenever it asks; it is not limited to push-to-talk. At `590aa55` the grant is at `electron/main.ts:175-179`: audio-only media for the app URL, still not tied to push-to-talk. Either gate the grant on push-to-talk (native/main owner) or reword B4 to say the app page is granted microphone audio. Decision needed before sign-off.
- [ ] **No user-visible "Jarvis" text.** Closed in source at `590aa55`: the denial reason that read "…until Jarvis is restarted normally" now reads "…until Desktop Companion is restarted normally" (`electron/services/actions.ts:121`), and the X8 scan has no user-visible match (see Validation commands). Left unchecked until the packaged build is scanned in §1.

## 1. Build and installer (A1, M1, M4)

- [ ] Clean clone on Windows 11 x64. `npm ci` **with** scripts, using only the project's own `node_modules`. No global installs. At `b0f5c1b` the `--ignore-scripts` install and a later `git status` printed `Filename too long` for `node_modules/app-builder-lib/node_modules/@electron/get/node_modules/fs-extra/lib/`. Record whether the clean install and `package:win` hit the same error. If they do, use a shorter clone path first. Enabling Windows long-path support is a machine-wide setting, so the owner decides it, not the release run.
- [ ] `npm run package:win` creates `release\Desktop Companion Setup <version>.exe` (NSIS, x64). Record the file size and SHA-256. Not run in this refresh: electron-builder fetches the Electron runtime and signing helpers from outside the repository, and that download is outside the authorized scope for this worker.
- [ ] `package.json` `build.nsis` still sets `oneClick: false`, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut: true`. `perMachine` is not set, so the installer should run per user without an administrator prompt. If UAC appears, stop and record it.
- [ ] The installer lets the user pick a folder, and it creates Start menu and desktop shortcuts named **Desktop Companion**.
- [ ] The packaged archive contains only the paths listed in `build.files`: `dist/**`, `dist-electron/**`, `native/**`, `package.json`. No `tests/`, `scripts/`, `docs/`, `.env` or key files. List the archive with the `@electron/asar` package already in `node_modules`: `npx asar list "release\win-unpacked\resources\app.asar"` (adjust the path to the unpacked output folder).
- [ ] After install, `resources\app.asar.unpacked\native\*.ps1` exists (`asarUnpack: native/**`). The native runner depends on it.
- [ ] No window title, tray tooltip, dialog text, shortcut or installer text says "Jarvis" (X8). Identifiers such as `window.jarvis` may remain. See the X8 scan above; one user-visible string is open at `b0f5c1b`.
- [ ] The build is unsigned (`signAndEditExecutable: false`). The release notes say so, and say that Windows SmartScreen may warn (M4). Signing is gate G8, so it is not a release check.
- [ ] Third-party notices: `docs/THIRD-PARTY-NOTICES.md` is the inventory. It records declared licence fields only. It does not claim licence review or installer verification.

## 2. Install, first run, upgrade, uninstall (M1–M3, B5)

- [ ] Install per user into a folder other than the default. Start the app from the Start menu, then from the desktop shortcut.
- [ ] First run opens onboarding. A fresh profile reports `mode: offline` and `onboarded: false` (C1).
- [ ] Launch a second time. The existing window is focused and no second window opens (B5).
- [ ] Install a second build over the first. Settings, notes, tasks and capsules are still there.
- [ ] Uninstall from Windows Settings > Apps. Program files and shortcuts are removed. The user-data folder (`%APPDATA%\Desktop Companion`) is kept.
- [ ] The release notes or help text say where user data is kept and how to delete it (M3). The in-app help page is not built yet (X9), so the release note must carry this text until it is.

## 3. Offline default and network denial (A2, C2–C6, E2)

- [ ] Disconnect the network, or have the tester block outbound traffic for the app with Windows Firewall. Run first run, a local Ollama chat, voice, capsule restore and backup export/import. No network error dialog appears (C5).
- [ ] Ollama absent: chat shows an honest "Local model unavailable" reply with `source: system`. The app does not crash and does not fall back to the cloud (E2, M2).
- [ ] Online mode with no key: a cloud request is denied and logged as `Activity{kind:'network'}` (C4).
- [ ] Use a loopback mock server for any cloud-path check. Do not use a real Anthropic key in release checks, and do not make any paid API call.
- [ ] Loopback endpoint validation: saving a non-loopback `localEndpoint` is rejected while offline (C3). Code present: `electron/services/validation.ts:89-90`. Import that tries to set a remote endpoint is refused (see §4).
- [ ] Ten minutes of use with the app idle and in active use: no established non-loopback connection belongs to Desktop Companion or its child processes. PowerShell check (run it while the app is open):

  ```powershell
  $ids = (Get-Process -Name 'Desktop Companion' -ErrorAction SilentlyContinue).Id
  Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -in $ids -and $_.RemoteAddress -notin '127.0.0.1', '::1' }
  ```

  The output must be empty (C6). The spellchecker dictionary download must not start: `ses.setSpellCheckerEnabled(false)` is in `electron/main.ts:150`, so confirm no request appears during start.
- [ ] Static egress scan (A2): see Validation commands. Expect no hits. Result at `b0f5c1b`: 0 hits.

## 4. Privacy and secrets (A3, K1–K5, J5)

- [ ] Key storage is DPAPI through `native/dpapi.ps1`, not Electron `safeStorage` (decision D2). The K1 and K2 wording must say so. Confirm the entropy string in `native/dpapi.ps1` is unchanged (`jarvis-desktop/cloud-key/v1` at `native/dpapi.ps1:6`), or stored keys become unreadable.
- [ ] Enter a marker value such as `RELEASE-CHECK-MARKER-0001` (20–300 printable characters, so it passes `validateCloudKey`) as the cloud key in a test profile. It is not key-shaped, so it does not trip the `sk-ant-` scan (A3). Search the user-data folder, logs and any exported file for that marker. Nothing is found in plain text (K3). Remove the test profile afterwards.
- [ ] `cloudKeyStatus` reports only `configured`. No IPC method returns the key (K1).
- [ ] An export file contains no `cloud-key` value (J5).
- [ ] Import of a crafted `jarvis-export` file that adds an approved app, an allowed root, or sets `mode: online` or a remote `localEndpoint` does not change those settings without the trusted confirmation. After import the mode is `offline` (NSR-01). Code present: `electron/services/store.ts:9` and `electron/backend.ts:106-111, 228`. Use a fixture in a temporary folder, not a personal file.
- [ ] Activity entries for executed, declined and denied actions show the outcome but not typed dictation text (G10).
- [ ] `window.open` and navigation to external URLs from the renderer are blocked (B3). Code present: `electron/main.ts:126-128`. Permission requests other than microphone audio are denied (B4). Code present: `electron/main.ts:156-161`; see the mic-wording gate in §0.
- [ ] Renderer has no Node or Electron imports. `window.jarvis` is the only bridge (A4). Code present: no `from 'electron'` import under `src/`. `electron/main.ts` keeps `contextIsolation`, `sandbox`, `webSecurity` true and `nodeIntegration` false (B1). Code present: `electron/main.ts:116-122`.

## 5. Native capabilities and action approval — manual matrix

Run these only with no other input in progress. They move and type into real windows. Use a temporary Notepad, not a document with personal content. Record each result as pass, fail or skipped (with reason).

"Code at `b0f5c1b`" describes what was read. A status of **absent** is a release blocker until it is implemented and checked.

| ID | Check (fixture) | Pass when | Code at `b0f5c1b` | Result |
|---|---|---|---|---|
| N1 | Every executed action shows the main-process dialog (NSR-02). Renderer call with `approved: true` but no dialog | Dialog has Cancel as default and shows the full target and resolved path or exact text. Cancel runs nothing. The renderer call without a dialog does not execute (unit test for `executeAction` or DevTools in the packaged build) | Present: `electron/services/actions.ts:260-262`, `electron/ipcCore.ts:104-116` | |
| N2 | `type-text` into temporary Notepad (NSR-07) | Dialog shows the full text, not "Type N characters". Line breaks show as `⏎`. The summary is clipped at 200 characters, so the detail must carry the rest | Partly present: `actions.ts:156` (summary clipped at 200), `actions.ts:193-206` (line break refused for terminals and Run). Full text in dialog detail: confirm | |
| N3 | `type-text` focus (NSR-07, NSR-08) | Preview allows a background target. Execution focuses the exact approved window first. If focus fails, nothing is typed | Comment present: `actions.ts:159, 270`. Behaviour not confirmed in this refresh | |
| N4 | Target a terminal, or a window that changed after preview | Refused or re-confirmed (NSR-07, NSR-08) | Present for capsules: `electron/services/capsules.ts`, `backend.ts:337`. Typed actions: confirm | |
| N5 | `launch` of an app not in `approvedApps`, and a file outside `allowedRoots` (G2) | Refused before any process starts | Present: `actions.ts:58-59, 203-205`, `paths.ts` (`resolveInsideRoots`) | |
| N6 | Remove an app from `approvedApps` after preview (G4) | Run is blocked | Not confirmed in this refresh | |
| N7 | Executable and code-running types inside an allowed root: `.chm`, `.iso`, `.msix`, `.library-ms`, `.settingcontent-ms`, `.wsc`, `.sct`, `.inf` (NSR-05). Document and media files still open | Refused with a reason. Documents and media open | **Absent.** No denylist for these types anywhere under `electron/`. The `launch-path` plan goes straight to `shell.openPath` (`actions.ts:303`). **Release blocker** | |
| N8 | Paths: UNC (`\\host\share\…`), WebDAV (`\\host@SSL\…`), device (`//./pipe/x`, `\\.\pipe\x`) and drive-relative paths (NSR-03, NSR-04). Use a probe that does not touch a network share | Refused before any file-system call | Present: `electron/services/paths.ts:42-44` (slashes normalised before the checks) | |
| N9 | `open-url`: `http(s)` and `mailto` only (G2). `mailto:` with `attach=` (NSR-06) | Refused, or the rebuilt URL drops it | Present: `actions.ts:44-76` (only `subject`, `body`, `cc`, `bcc` kept) | |
| N10 | Elevated or self (Desktop Companion) window (G8) | Refused with a reason. Password-field detection is not implemented: state that as a limitation, do not claim it | Present: `actions.ts:197` (elevated), self PIDs via `selfPids` | |
| N11 | Rate limit (G9): 31st action within 60 s is refused. Safe launch refuses every action | Refused with a reason | 60-second window present: `actions.ts:188-197`. The 30-action threshold is not confirmed in this refresh | |
| N12 | Capsule restore (NSR-01, H4) | One confirmation lists every item with resolved target and any window move. Cancel opens nothing | Present: `electron/services/capsules.ts:49` (single confirmation over all targets) | |
| N13 | Native helpers receive input on stdin, never as command-line arguments (F2, G11). After a `speak` call, check for a leftover PowerShell child | `Get-CimInstance Win32_Process` shows no PowerShell child of the app | Present: `electron/native/runner.ts:1, 41, 118-122` (JSON on stdin, `-File` script) | |
| N14 | `list-windows`, `focus` and `move-window` on temporary Notepad (G5, G6) | Window is found with process and rect. Focus takes effect. A move is clamped to the visible screen | Helpers present: `native/list-windows.ps1`, `focus-window.ps1`, `move-window.ps1` | |
| N15 | `speak` with an installed voice (F1). Unknown voice name | Audio plays. Unknown voice returns a reason. No fake voice output | `native/speak.ps1` present; run needed | |
| N16 | `transcribe` of a clear English WAV, and a silent WAV (F3, F6) | Clear WAV returns text. Silent WAV returns `text: ''` with a reason. Temporary `jarvis-<uuid>.wav` is deleted. Labelled "Basic (Windows Speech)" with no accuracy claim | `native/transcribe.ps1` present; run needed | |
| N17 | Push-to-talk (F4, F5) | Microphone is active only while held. A visible indicator is shown. Transcript appears in an editable preview. Dictation is inserted only through an approved `type-text` preview | Mic gate open (§0). Run needed | |
| N18 | Unavailable capabilities: OCR, vision, screen capture, click injection, agents, avatars (N1, N3, G2 for `click`) | Each shows "Not implemented" or "Experimental" with a reason, not simulated output | `native/click.ps1` is present but must stay unavailable in the UI; check the UI label | |

Re-checked at `590aa55` (static reads only, no desktop input): N7 is still absent. No file under `electron\` mentions `.chm`, `.iso`, `.msix`, `.library-ms`, `.settingcontent-ms`, `.wsc`, `.sct` or `.inf`, and the `launch-path` plan still calls `shell.openPath` (`electron\services\actions.ts:395`). The N1 trusted dialog is wired (see §0) but has not been run. The N-rows are unchanged otherwise, and none of them has a recorded pass.

Blocking rows for this release: N1, N7 (absent), and any failure in N2, N5 or N8. Do not sign off with N7 open.

## 6. Footprint and startup (M5, M6)

- [ ] Tray idle for five minutes, measured separately from Ollama: average CPU ≤ 0.5%, working set ≤ 250 MB, no PowerShell child process.

  ```powershell
  Get-Process -Name 'Desktop Companion' | Measure-Object WorkingSet64 -Sum
  ```

- [ ] Cold start to an interactive dashboard takes ≤ 3 s on the reference laptop (M6).

## 7. Known limitations for the release note

State these in the release note, not only in the checklist:

- The build is unsigned, so Windows SmartScreen may warn (M4).
- No local model runtime or model weights are bundled. Ollama must be installed separately, and its absence is reported in the app.
- Voice recognition is basic Windows speech. No accuracy is claimed.
- No screen capture, OCR, vision, click injection, avatars or agents are in this release (N3).
- Window geometry capture and reminders are only claimed if §0 and §5 are complete.
- Uninstall keeps user data by default (M3).
- Password-field detection is not implemented (N10).
- Third-party licence review is not complete; see `docs/THIRD-PARTY-NOTICES.md`.

## 8. Sign-off record

| Date | Tester | Commit | Installer SHA-256 | Result (pass / fail / skipped, with item IDs) | Notes |
|---|---|---|---|---|---|
| | | | | | |

Rules for evidence:

- Use temporary fixtures in a folder named for this release check, such as `%TEMP%\desktop-companion-release-check`, and delete them afterwards. Note that this folder is only for fixture files. Test-mode user-data folders must match the guard in `electron/main.ts:17-25` (`jarvis-smoke-`, `jarvis-test-` or `desktop-companion-test-` directly under the OS temp directory).
- Do not attach screenshots or files that contain personal data. Do not attach logs that contain a key-shaped string.
- A skipped item is recorded as skipped, with the reason, and it blocks the release if it is a gate in §0 or a blocking row in §5.
