# Release checklist — Desktop Companion (first personal release)

Status: prepared 14 October 2026 against checkpoint `2fc88a8`. Use this on a clean Windows 11 x64 machine with the packaged build (`npm run package:win`), not `npm start` or `npm run dev`, because the dev build accepts a dev-server origin (NSR-11).

Naming: user-facing text says **Desktop Companion**. Technical identifiers stay for compatibility (`window.jarvis`, `jarvis:*` channels, `jarvis-export`, `jarvis-<uuid>.wav`, the DPAPI entropy string in `native/dpapi.ps1`).

Item IDs (A1, C5, G7, …) match `docs/acceptance.md`. Finding IDs (NSR-01 …) match `docs/native-security-review.md`. Each check is pass/fail. Record the result, the build hash and the tester in the sign-off table at the end.

## 0. Gate before any manual check

Do not start the manual checks until these are true on the candidate commit. They are open at checkpoint `2fc88a8`:

- [ ] **Trusted confirmation is wired.** `electron/ipcCore.ts` builds the `BackendEnv.confirm` dialog, but `electron/main.ts` does not yet pass it to `createBackend`. Until it is passed, every sensitive action and import fails closed with "Native confirmation declined or unavailable". Confirm that a launch or capsule restore shows a native dialog (see §5).
- [ ] **Automated suites pass.** `npm run typecheck`, `npm run build` and `npm test` pass. The Electron smoke test (`scripts/smoke.cjs`) is not yet part of `npm test`; run it by hand with `JARVIS_TEST_MODE=1` and a temporary user-data folder.
- [ ] **Reminders are either wired or not claimed.** `electron/services/reminders.ts` exists, but `electron/main.ts` does not yet show a `Notification`. If reminders are not wired, the release notes must not say tasks remind the user (I2).
- [ ] **Mic permission wording matches the code.** `electron/main.ts` grants microphone access whenever a page asks, not only while push-to-talk is held (X10, decision D4). Either fix it or reword B4 before sign-off.

## 1. Build and installer (A1, M1, M4)

- [ ] Clean clone on Windows 11 x64. `npm ci` with scripts, using only the project's own `node_modules`. No global installs.
- [ ] `npm run package:win` creates `release\Desktop Companion Setup <version>.exe` (NSIS, x64). Record the file size and SHA-256.
- [ ] `package.json` `build.nsis` still sets `oneClick: false`, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut: true`. `perMachine` is not set, so the installer should run per user without an administrator prompt. If UAC appears, stop and record it.
- [ ] The installer lets the user pick a folder, and it creates Start menu and desktop shortcuts named **Desktop Companion**.
- [ ] The packaged archive contains only the paths listed in `build.files`: `dist/**`, `dist-electron/**`, `native/**`, `package.json`. No `tests/`, `scripts/`, `docs/`, `.env` or key files. List the archive with the `@electron/asar` package already in `node_modules`.
- [ ] After install, `resources\app.asar.unpacked\native\*.ps1` exists (`asarUnpack: native/**`). The native runner depends on it.
- [ ] No window title, tray tooltip, dialog text, shortcut or installer text says "Jarvis" (X8). Identifiers such as `window.jarvis` may remain.
- [ ] The build is unsigned (`signAndEditExecutable: false`). The release notes say so, and say that Windows SmartScreen may warn (M4). Signing is gate G8, so it is not a release check.

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
- [ ] Loopback endpoint validation: saving a non-loopback `localEndpoint` is rejected while offline (C3). Import that tries to set a remote endpoint is refused (see §4).
- [ ] Ten minutes of use with the app idle and in active use: no established non-loopback connection belongs to Desktop Companion or its child processes. PowerShell check (run it while the app is open):

  ```powershell
  $ids = (Get-Process -Name 'Desktop Companion' -ErrorAction SilentlyContinue).Id
  Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -in $ids -and $_.RemoteAddress -notin '127.0.0.1', '::1' }
  ```

  The output must be empty (C6). The spellchecker dictionary download must not start: `ses.setSpellCheckerEnabled(false)` is in `electron/main.ts`, so confirm no request appears during start.
- [ ] Static egress scan (A2): no `fetch(`, `net.request`, `http.request` or `https.request` in `electron/` outside `electron/services/netGuard.ts`. Run `Select-String -Path electron\*.ts, electron\services\*.ts -Pattern '\bfetch\(|net\.request|https?\.request'` and expect no hits outside `netGuard.ts`.

## 4. Privacy and secrets (A3, K1–K5, J5)

- [ ] Key storage is DPAPI through `native/dpapi.ps1`, not Electron `safeStorage` (decision D2). The K1 and K2 wording must say so. Confirm the entropy string in `native/dpapi.ps1` is unchanged, or stored keys become unreadable.
- [ ] Enter a marker value such as `RELEASE-CHECK-MARKER-0001` (20–300 printable characters, so it passes `validateCloudKey`) as the cloud key in a test profile. It is not key-shaped, so it does not trip the `sk-ant-` scan (A3). Search the user-data folder, logs and any exported file for that marker. Nothing is found in plain text (K3). Remove the test profile afterwards.
- [ ] `cloudKeyStatus` reports only `configured`. No IPC method returns the key (K1).
- [ ] An export file contains no `cloud-key` value (J5).
- [ ] Import of a crafted `jarvis-export` file that adds an approved app, an allowed root, or sets `mode: online` or a remote `localEndpoint` does not change those settings without the trusted confirmation. After import the mode is `offline` (NSR-01). Use a fixture in a temporary folder, not a personal file.
- [ ] Activity entries for executed, declined and denied actions show the outcome but not typed dictation text (G10).
- [ ] `window.open` and navigation to external URLs from the renderer are blocked (B3). Permission requests other than microphone audio are denied (B4).
- [ ] Renderer has no Node or Electron imports. `window.jarvis` is the only bridge (A4). `electron/main.ts` keeps `contextIsolation`, `sandbox`, `webSecurity` true and `nodeIntegration` false (B1).

## 5. Native capabilities and action approval (G1–G11, F1–F6, H3–H5)

Run the native checks only with no other input in progress. They move and type into real windows. Use a temporary Notepad, not a document with personal content.

- [ ] Every executed action shows the native dialog from the main process. Its default button is Cancel, and it shows the full target, resolved path or exact text (NSR-02). Cancel means nothing runs.
- [ ] A renderer call with `approved: true` but no dialog does not execute (NSR-02). Check with DevTools in the packaged build, or with the unit test for `executeAction`.
- [ ] `type-text`: the dialog shows the full text, not just "Type N characters" (NSR-07). The preview allows a background target. Execution focuses the exact approved window first. If the focus fails, nothing is typed.
- [ ] Target a terminal window or a window that changed after preview: the action is refused or re-confirmed (NSR-07, NSR-08).
- [ ] `launch` is allowed only for `approvedApps` or files inside `allowedRoots` (G2). Removing an app from `approvedApps` after preview blocks the run (G4).
- [ ] Paths: UNC (`\\host\share\…`), WebDAV (`\\host@SSL\…`), device (`//./pipe/x`, `\\.\pipe\x`) and drive-relative paths are refused before any file-system call (NSR-03, NSR-04). Verify with a probe that does not touch a network share.
- [ ] Executable and code-running types outside `approvedApps` are refused: `.chm`, `.iso`, `.msix`, `.library-ms`, `.settingcontent-ms`, `.wsc`, `.sct`, `.inf` (NSR-05). Document and media files inside an allowed root still open.
- [ ] `open-url`: `http(s)` and `mailto` only (G2). A `mailto:` with `attach=` or any parameter other than `subject`, `body`, `cc`, `bcc` is refused, or the rebuilt URL drops it (NSR-06).
- [ ] Elevated or self (Desktop Companion) windows are refused with a reason (G8). Password-field detection is not implemented; state that as a limitation and do not claim it.
- [ ] Rate limit: a 31st action within 60 s is refused (G9). Safe launch refuses every action (G9).
- [ ] Capsule restore shows one confirmation that lists every item, its resolved target and any window move. Cancel opens nothing (NSR-01, H4).
- [ ] Native helpers receive input on stdin, never as command-line arguments (F2, G11). After a `speak` call, `Get-CimInstance Win32_Process` shows no PowerShell child of the app left behind.
- [ ] `list-windows`, `focus` and `move-window` on a temporary Notepad window: window found with process and rect (G5); focus takes effect; a move is clamped to the visible screen (G6).
- [ ] `speak` with an installed voice plays audio (F1). An unknown voice name returns a reason. The app shows no fake voice output.
- [ ] `transcribe` of a clear English WAV returns text. A silent WAV returns `text: ''` with a reason. The temporary `jarvis-<uuid>.wav` is deleted afterwards (F3). Recognition is labelled "Basic (Windows Speech)" with no accuracy claim (F6).
- [ ] Push-to-talk: the microphone is active only while held, a visible indicator is shown, and the transcript appears in an editable preview (F4). Dictation is inserted only through an approved `type-text` preview (F5).
- [ ] Unavailable capabilities (OCR, vision, screen capture, click injection, agents, avatars) show "Not implemented" or "Experimental" with a reason, not simulated output (N1, N3, G2 for `click`).

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
- Window geometry capture and reminders are only claimed if §0 is complete.
- Uninstall keeps user data by default (M3).

## 8. Sign-off record

| Date | Tester | Commit | Installer SHA-256 | Result (pass / fail / skipped, with item IDs) | Notes |
|---|---|---|---|---|---|
| | | | | | |

Rules for evidence:

- Use temporary fixtures in a folder named for this release check, such as `%TEMP%\desktop-companion-release-check`, and delete them afterwards.
- Do not attach screenshots or files that contain personal data. Do not attach logs that contain a key-shaped string.
- A skipped item is recorded as skipped, with the reason, and it blocks the release if it is a gate in §0.
