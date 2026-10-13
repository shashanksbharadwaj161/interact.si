# Acceptance checklist — first personal release

Each item is pass/fail and names how it is verified:
- **[U]** automated unit test (`npm test`)
- **[I]** opt-in native integration test (`JARVIS_NATIVE_TESTS=1`)
- **[M]** manual check on a clean Windows 11 x64 machine

Section numbers refer to `docs/architecture.md`; item numbers refer to `docs/product-roadmap.md`. An item marked *gated* passes when it honestly reports "unavailable/experimental". Shipping it as working requires its gate (architecture §10).

## A. Build and repo hygiene
- [ ] A1 [M] `npm ci`, `npm run typecheck`, `npm run build`, and `npm test` succeed on Windows with no global installs.
- [ ] A2 [U] No `fetch`, `net.request`, `http.request`, or `https.request` in `electron/` outside `services/netGuard.ts` (static scan test).
- [ ] A3 [U] No source, test fixture, or log contains an API-key-shaped string (`sk-ant-` scan).
- [ ] A4 [M] The renderer bundle has no Node or Electron imports. `window.jarvis` is the only bridge.
- [ ] A5 [M] No restricted, GPL, or AGPL code copied. Dependencies have permissive licences (`npx license-checker` or a manual review of the lockfile).

## B. Security baseline (§12)
- [ ] B1 [U/M] Every BrowserWindow has `contextIsolation`, `sandbox`, and `webSecurity` set to true and `nodeIntegration` set to false.
- [ ] B2 [U] The IPC router rejects calls from a non-app sender URL and payloads over the size limits.
- [ ] B3 [M] `window.open` and navigation to external URLs from the renderer are blocked.
- [ ] B4 [M] Permission requests other than mic audio are denied. Mic access is granted only while push-to-talk is active.
- [ ] B5 [M] A second launch focuses the existing instance.

## C. Offline default and network denial (3, 116, §6.1)
- [ ] C1 [U] Fresh state has `mode:'offline'` and `onboarded:false`.
- [ ] C2 [U] In offline mode, `guardedFetch` allows only loopback hosts. `api.anthropic.com`, LAN IPs, and DNS names that resolve to non-loopback addresses are denied and logged as `Activity{kind:'network'}`.
- [ ] C3 [U] `saveSettings` rejects a non-loopback `localEndpoint` while offline.
- [ ] C4 [U] In online mode with no key, cloud requests are denied. With a key, only the exact Anthropic origin is allowed.
- [ ] C5 [M] With Windows Firewall blocking outbound traffic for the app (applied by the tester) or the machine disconnected, the full first-run, chat (Ollama), voice, capsule, and backup flows work with no error dialogs about network access.
- [ ] C6 [M] A resource monitor or `netstat -b` during 10 min of offline use shows no non-loopback connections from Jarvis processes. The spellchecker dictionary download is disabled.
- [ ] C7 [U] An Ollama failure never falls back to cloud. A cloud failure never falls back silently.

## D. Onboarding and application (1–10)
- [ ] D1 [M] The first-run wizard covers mode (offline preselected), permissions (`allowedRoots`, `approvedApps`), hardware and dependency checks, and theme. Completing it sets `onboarded:true`.
- [ ] D2 [M] The hardware check shows real `SystemInfo` values (RAM, CPU, arch) and each capability with an honest reason.
- [ ] D3 [M] The dashboard shows capsules, tasks, recent activity, and capability status.
- [ ] D4 [M] Settings search filters by label and description. Every setting in `Settings` is editable and persisted.
- [ ] D5 [M] All primary flows can be operated by keyboard only, with visible focus, and the screen reader announces controls (Narrator spot check).
- [ ] D6 [M] Tray icon: show, hide, and quit. `startInTray` starts hidden. Notification preferences are respected.
- [ ] D7 [M] The help and diagnostics page lists versions, the data folder, capability reasons, and safe-launch status, and can export a redacted diagnostic bundle.

## E. Local AI (11, 14, 21, §6.2)
- [ ] E1 [I/M] With Ollama running and `localModel` installed, `chat` returns an assistant message with `source:'local'` produced by Ollama.
- [ ] E2 [U/M] With Ollama stopped, `chat` returns a `source:'system'` message explaining why. No fabricated reply. Capability `local-llm` is unavailable with that reason.
- [ ] E3 [M] Model guidance explains how to install Ollama and import a model offline (GGUF + Modelfile through the Ollama CLI). The app installs nothing globally.
- [ ] E4 [M] Chat shows a non-streaming "thinking" state with cancel. True streaming is listed as pending the contract change.
- [ ] E5 [M] "Unload model" frees Ollama memory (`keep_alive:0`).

## F. Voice (12, 13, 22, 23, §6.3)
- [ ] F1 [I] `speak` with an installed voice returns `{ok:true}` and audio plays. An unknown voice returns `{ok:false, reason}`.
- [ ] F2 [U] Speak text is passed on stdin, never as a command-line argument. Text over 4,000 chars is rejected or truncated as specified.
- [ ] F3 [I] `transcribe` on a fixture WAV of clear English speech returns non-empty text. Silence returns `{text:'', reason}`. The temp WAV is deleted afterwards.
- [ ] F4 [M] Push-to-talk: the mic is active only while held, a visible indicator is shown, and the transcript appears in an editable preview.
- [ ] F5 [M] Dictation insertion happens only through an approved `type-text` preview.
- [ ] F6 [M] The UI labels recognition "Basic (Windows Speech)". No claim of higher accuracy.

## G. Actions and UI Automation (81, §7)
- [ ] G1 [U] `previewAction` never executes anything. `executeAction` with an unknown, expired (>60 s), or reused id fails. With `approved:false`, nothing executes.
- [ ] G2 [U] Policy: `launch` is allowed only for `approvedApps` or files in `allowedRoots`. `open-url` is allowed only for `http(s)`/`mailto`. `click` returns `allowed:false` ("Experimental — not enabled").
- [ ] G3 [U] Path checks resolve `..`, case differences, and symlinks, and reject anything outside `allowedRoots`.
- [ ] G4 [U] Policy is re-evaluated at execute time. Removing an app from `approvedApps` after preview blocks execution.
- [ ] G5 [I] `list-windows` returns a test-spawned Notepad window with title, process, and rect.
- [ ] G6 [I] `focus` and `move-window` on that Notepad window take effect, and the rect is clamped to visible screens.
- [ ] G7 [I] `type-text` into Notepad inserts the exact Unicode text, including non-ASCII.
- [ ] G8 [M] Actions targeting an elevated window, a password field, or the Jarvis window are blocked with a reason.
- [ ] G9 [U] The rate limit (30 actions per minute) is enforced. Actions are refused in safe launch.
- [ ] G10 [M] Every executed or denied action appears in Activity with an outcome. Typed text content is not logged.
- [ ] G11 [U] The native runner kills a child on timeout and caps stdout. No PowerShell processes remain after a call completes.

## H. Capsules (41–43, §7.4)
- [ ] H1 [M] Capsule create, edit, and delete persist. Items can be added through the `pickPath` dialog.
- [ ] H2 [M] Restore shows a preview of the item and window list before running.
- [ ] H3 [I] Restore opens valid file, folder, URL, and approved-app items and returns them in `opened`.
- [ ] H4 [U/I] Missing, unapproved, or outside-root targets are returned in `failed` with a reason and are never opened.
- [ ] H5 [I] Saved Notepad geometry is restored within ±8 px at 100% and 150% DPI. Windows that are not supported are reported as failed, not faked.

## I. Productivity, notes, memory (31, 32, 51–53)
- [ ] I1 [M] Tasks: create, complete, set a due date, delete.
- [ ] I2 [M] A reminder notification fires at `due` (±60 s) while hidden in the tray, without polling timers.
- [ ] I3 [M] Focus session start and stop is recorded in Activity.
- [ ] I4 [M] Notes are searchable by title, body, and tag. A checkpoint note links to a capsule.

## J. Persistence, backups, recovery (113–115, §5)
- [ ] J1 [U] Writes are atomic. A simulated crash between writing the tmp file and the rename leaves the previous valid `state.json`.
- [ ] J2 [U] A corrupt `state.json` is quarantined, the newest valid backup loads, and a recovery Activity entry is recorded.
- [ ] J3 [U] Backup rotation keeps the newest 10 plus 1 per day for 7 days.
- [ ] J4 [U] Retention prunes chat and activity older than `retainDays`. Notes, tasks, and capsules are untouched.
- [ ] J5 [U/M] Export, then import into a fresh profile, gives identical `AppState`. The export contains no key. Invalid imports change nothing. A pre-import backup exists.
- [ ] J6 [M] Two unclean exits trigger safe launch with restore and export options.
- [ ] J7 [U] A newer `schemaVersion` opens read-only with a warning.

## K. Protected key storage (101 prep, 113, §12)
- [ ] K1 [U] `setCloudKey` stores only `safeStorage` ciphertext. `cloudKeyStatus` returns `{configured}` only. No API returns the key.
- [ ] K2 [U] When `safeStorage` is unavailable, `setCloudKey` fails with a reason and no plaintext is written.
- [ ] K3 [M] A search of `userData`, logs, and exports for the key string finds nothing in plaintext.
- [ ] K4 [U] `deleteCloudKey` removes the file. Status becomes `configured:false`.
- [ ] K5 [U] Cloud chat (mock server) sends the key only in the `x-api-key` header to the allowed origin. Messages are tagged `source:'cloud'`.

## L. Visuals (61–64)
- [ ] L1 [M] The graphite, nebula, and paper themes apply instantly and persist. Text contrast is ≥ 4.5:1.
- [ ] L2 [M] With `reduceMotion` or Windows "animation effects off", non-essential animation is disabled. Animations pause when hidden, on battery saver, or when a fullscreen app is in the foreground.
- [ ] L3 *gated G1* [M] The desktop island ships only if the G1 benchmark passes. Otherwise the capability reports unavailable and the panel lives in the main window.

## M. Installer and footprint (111, 112, §8, §13)
- [ ] M1 [M] `npm run package:win` produces an NSIS x64 installer that installs per-user without admin, lets the user choose a directory, and creates Start menu and desktop shortcuts.
- [ ] M2 [M] Install and first run work fully offline. The Electron runtime is bundled. Ollama absence is reported, not fatal.
- [ ] M3 [M] Uninstall removes the program files and shortcuts. User data is kept unless deleted, and the help page says so.
- [ ] M4 [M] The unsigned build's SmartScreen warning is documented (signing is gate G8).
- [ ] M5 [M] Idle in tray for 5 min: average CPU ≤ 0.5%, total app working set ≤ 250 MB, zero PowerShell child processes. Ollama is measured separately.
- [ ] M6 [M] Cold start to an interactive dashboard takes ≤ 3 s on the reference laptop.

## N. Honest-status gates (everything outside the first release)
- [ ] N1 [M] Every Expansion or Experimental feature visible in the UI is disabled with a reason. Nothing shows simulated output: no fake voice, avatar, activity, model response, or computer control.
- [ ] N2 [M] Windows customization (71, 72) is only a catalog of external tools with version notes. The app changes no system settings. GPL mods are never bundled (G5).
- [ ] N3 [M] Screen capture and OCR (24, 25), click injection (88–90), continuous history and meeting capture (39, 40), avatars and motion (129–140), sync and marketplace (109, 110), and agents (91–100) are absent or marked experimental until their gate document exists.
- [ ] N4 Contract gaps listed in architecture §4 are tracked by the contract owner. No worker works around them with undeclared IPC channels.
