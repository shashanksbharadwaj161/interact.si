# Milestone acceptance — Desktop Companion

Date: 14 October 2026. Commit checked: `590aa55` (branch `ao/jarvis-desktop-66/root`). Working name: Desktop Companion (temporary). Technical identifiers such as `jarvis-desktop`, `window.jarvis` and `jarvis:*` channels are unchanged.

This is an evidence audit, not a sign-off. It records what was built, what was run, and what still needs a person on real Windows hardware. No scope status was promoted. Promotion rules are in §4.

## 1. Baseline

Run from the repository root with repo-local tools only. No global install, no paid API call, no live cloud or provider call.

| Check | Command | Result at `590aa55` |
|---|---|---|
| Dependencies | `npm ci --ignore-scripts` | exit 0. `git status` warns `Filename too long` for `node_modules/app-builder-lib/node_modules/@electron/get/node_modules/fs-extra/lib/`. The Electron binary is not installed under `--ignore-scripts`. |
| Typecheck | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 (vite, then `build-main`). Vite warns that the JS chunk is 614 kB. This is a size warning, not a failure. |
| Tests | `npm test` | 579 tests: **575 pass, 0 fail, 4 todo**, exit 0, about 29 s |
| Registry shape | one-off audit (§2) | 140 scopes, ids 1–140 unique, 0 issues |
| Matrix | one-off comparison (§2) | 140 of 140 rows match the registry |

Earlier records are superseded: the `b0f5c1b` refresh recorded 124 of 124 tests passing, and the continuation pass recorded `typecheck` and `npm test` (477 tests, 475 passing, 2 failing) as failing. At `590aa55` those failures are gone.

Passing tests show that the modules work against injected fakes and fixtures. They do not show Electron, Windows speech, microphone, DPAPI, live Ollama, or any cloud call.

## 2. Evidence audit (what was checked)

The registry is `src/shared/feature-registry.json` (version 3). It is the authority for status, integration, owner and evidence. The audit was read-only and used one-off scripts kept outside the repository at `%TEMP%\jarvis-acceptance-audit\`. They are not part of `npm test`, so a reviewer repeats them from this description.

- **Shape.** 140 entries, ids 1–140, no duplicates. Every status is in `statusVocabulary`. Every integration level is in `integrationVocabulary`. `planned` entries have no evidence. Every other entry has at least one evidence item.
- **Test references.** All 103 `test` evidence refs name a file under `tests/` and a title that appears in that file. Each title was matched to a passing TAP line in the `npm test` output at `590aa55`: 103 matched, 0 failing, 0 todo.
- **Doc references.** Every file path named in a `doc` ref exists. The `smoke` refs point to `docs/current-verification.md`, which exists.
- **Verified rule.** Every verified entry has integration `integrated` or `runtime-verified`, which matches the definition.
- **Gates.** 46 scopes list at least one gate. Gate blocks match `gates[G].blocks` in the registry. Experimental scopes with no gate: 20, 49, 50, 98, 99, 100, 109, 110, 120. All eight gates (G1–G8) are `not-recorded`, and no gate document exists in `docs/`.
- **Matrix.** `docs/feature-matrix.md` has 140 rows. Every field in each row (scope, tier, status, integration, owner, gates, evidence types, limitation) matches the registry. Tier and status counts match: First 4/31/5, Expansion 1/33/34, Experimental 0/2/30 (verified/partial/planned).

Corrections made to docs in this pass: the feature matrix's "Conflicts" section still described the earlier failing tree, and the release checklist's validation and X8 results were from `b0f5c1b`. Both were updated. The registry was not changed, because no evidence supported a status change.

## 3. Separate levels: status, integration, runtime

Status (`planned`, `partial`, `verified`) describes the scope. Integration (`none`, `module-tested`, `integrated`, `runtime-verified`) describes whether any part is reachable through the app. Runtime means a recorded run on Windows.

| Level | Count | Meaning and scopes |
|---|---|---|
| none | 69 | No behavior in the repository (all `planned`). |
| module-tested | 23 | Code and tests exist, nothing reachable through the app. Scopes 14, 18, 19, 56, 59, 72, 75, 82, 83, 84, 85, 86, 87, 102, 105, 108, 121, 123, 124, 125, 126, 127, 128. All are `partial`. |
| integrated | 45 | At least one part reachable. Includes verified scopes 46 and 116. |
| runtime-verified | 3 | Scopes 2, 3 and 51. Each cites a smoke run in `docs/current-verification.md` that predates the continuation. |

Status counts: 5 verified (2, 3, 46, 51, 116), 66 partial, 69 planned. The "71 implemented" figure in the brief is the 71 non-planned scopes (66 partial plus 5 verified), not 140 verified.

Module results are not the same as integration. There are 22 result files, and every one records `done: true` for its own module:

- `docs/autopilot-result.*.json` (15): accessibility, api, calendar, clipboard, integrations, models, mods, native, release, roadmap, routines, security, shell, usage, widgets.
- `docs/continuation-result.*.json` (7): api, coverage, integrations, models, productivity, routines, shell-qa.

Wiring, checked at `590aa55` by name only (the app was not run):

- `electron/backend.ts` and `electron/preload.ts` name routines, integrations, the usage ledger and clipboard history.
- `src/components/Routines.tsx`, `Integrations.tsx` and `UsagePanel.tsx` are not imported by any other source file, so no screen mounts them.
- Productivity is not in `backend.ts` or `preload.ts`, so `window.jarvis.productivity` does not exist.
- `electron/main.ts` does not reference the clipboard reader or a usage-export save dialog. Per the continuation API result, clipboard history and usage export therefore report not connected in the packaged app. This was not re-run.
- The models result says chat is still non-streaming in the backend.

Each result file's limitations list the remaining gaps. The captain must confirm each one before any `module-tested` scope moves up.

## 4. Verified records and promotion rule

Current verified records (5) are unchanged:

| Scope | Name | Integration | Evidence and limit for captain review |
|---|---|---|---|
| 2 | Hardware and dependency checks | runtime-verified | Tests plus pre-continuation smoke. Limit: checks only, no dependency installer. Re-run smoke after integration. |
| 3 | Offline/online mode selection | runtime-verified | Tests plus pre-continuation smoke. Re-run smoke after integration. |
| 46 | Cross-project search | integrated | Two tests. Limit: in-app data only. |
| 51 | Tasks and checklists | runtime-verified | Tests plus pre-continuation smoke. Flat checklist only. |
| 116 | Network-denial/offline verification | integrated | Guard-level tests. The packaged network-denial run is not recorded. |

Captain review items: scope 116 is verified on guard tests only, and the registry definition requires "no open gap contradicts it". The packaged run is the gap. Scopes 2, 3 and 51 rely on smoke that predates the continuation. Either re-run and record, or downgrade to `partial`. This pass made no change.

Promotion rule for any new `verified` record (a scope may move only when all of these hold):

1. Integration is `integrated` or `runtime-verified`, with the wiring in `backend.ts`, IPC, preload or a mounted screen named in the limitation.
2. The scope has at least one passing `tests/` title, and the title is in the `npm test` TAP output for the candidate commit.
3. Every manual item in §5 that the scope depends on is recorded as pass in the sign-off table in `docs/release-checklist.md` §8.
4. No open gap in the limitation text contradicts the scope. Gate-blocked scopes stay below verified unless their gate is recorded `passed`.
5. The captain records the evidence in the registry, the matrix and this document together.

## 5. Manual acceptance checklist

Each item has one result: pass, fail, or skipped with a reason. Record results in `docs/release-checklist.md` §8. Use a clean Windows 11 x64 profile, a temporary fixture folder such as `%TEMP%\desktop-companion-release-check`, and no personal files. Test-mode user-data folders must match the guard in `electron/main.ts`. Do not run anything that makes a paid or cloud call. Do not use a real Anthropic key. Use loopback mock servers.

### M-A. Automated baseline (any Windows machine, repo-local)

| ID | Steps | Pass when |
|---|---|---|
| MA-1 | `npm ci --ignore-scripts`, then `git status` | Exit 0, lockfile unchanged. `Filename too long` is recorded, not hidden. |
| MA-2 | `npm run typecheck` | Exit 0 |
| MA-3 | `npm run build` | Exit 0 |
| MA-4 | `npm test` | 579 tests, 0 fail. The count of pass and todo is recorded with the commit. |
| MA-5 | Static egress scan from the release checklist (Validation commands, A2) | Only the two guarded calls at `integrations.ts:218` and `models.ts:312`. Any other line blocks the release. |
| MA-6 | X8 scan from the release checklist | No user-visible "Jarvis". Comment and legacy-folder lines only. |

### M-B. Packaged install (needs `npm ci` **with** scripts, so the Electron binary is present)

| ID | Steps | Pass when |
|---|---|---|
| MB-1 | `npm ci` with scripts in a short clone path | Completes. If it fails on the long path, record the failure and use a shorter path. Do not change the machine-wide long-path setting. |
| MB-2 | `npm run package:win` | `release\Desktop Companion Setup 0.1.0.exe` is created. Record size and SHA-256. Not yet run. |
| MB-3 | Run the installer | Per-user install, no UAC prompt. If UAC appears, stop and record it. |
| MB-4 | `npx asar list` on the unpacked `app.asar` | Only `dist/`, `dist-electron/`, `native/` and `package.json`. No `tests/`, `scripts/`, `docs/` or key files. |
| MB-5 | Check the install folder | `resources\app.asar.unpacked\native\*.ps1` exists. |
| MB-6 | First run from the Start menu | Opens onboarding. Fresh profile shows `mode: offline`, `onboarded: false`. |
| MB-7 | Launch a second time | The existing window is focused. No second window. |
| MB-8 | Install a newer build over the old one | Notes, tasks, capsules and settings are still there. |
| MB-9 | Uninstall from Windows Settings > Apps | Program files and shortcuts are removed. `%APPDATA%\Desktop Companion` is kept. |
| MB-10 | Electron smoke: `JARVIS_TEST_MODE=1` and `scripts/smoke.cjs` on the packaged-like build | Offline default, note/task/capsule CRUD, empty capsule restore, cloud key absent. The 14 October smoke in `docs/current-verification.md` predates this commit and must be repeated. |

### M-C. Offline default, network and privacy (release §3–§4)

| ID | Steps | Pass when |
|---|---|---|
| MC-1 | Fresh profile, no network | `mode: offline`. No network error dialog during first run, local chat, voice, capsule restore or backup export/import. |
| MC-2 | Ollama not running, then chat | Reply "Local model unavailable" with `source: system`. No crash. No cloud fallback. |
| MC-3 | Online mode with no key, then send a message | Denied. Activity entry `kind: network`. |
| MC-4 | Save a non-loopback `localEndpoint` while offline | Rejected. |
| MC-5 | Use the app for 10 minutes, then run the PowerShell check in release §3 | No established non-loopback connection from the app. |
| MC-6 | Enter marker `RELEASE-CHECK-MARKER-0001` as the cloud key in a test profile, then search the user-data folder, logs and any export | Marker not found in plain text. Remove the test profile afterwards. |
| MC-7 | Inspect the IPC response for the key status, and an export file | Only `configured` is returned. No `cloud-key` value in an export. |
| MC-8 | Import a crafted `jarvis-export` fixture that adds an approved app, an allowed root, `mode: online` or a remote endpoint | Settings unchanged without the trusted dialog. Mode is `offline`. |
| MC-9 | Renderer attempts `window.open` and external navigation; request a permission other than microphone audio | Blocked. Denied. |

### M-D. Native actions and trusted confirmation (release §5 — blocking rows marked)

Run only with no other input in progress, in temporary Notepad, with no personal content. These move and type into real windows.

| ID | Steps | Pass when |
|---|---|---|
| MD-1 **(blocking)** | Trigger an action from a launch or capsule restore | Native dialog appears with Cancel as default and full detail. Cancel runs nothing. Renderer `approved: true` without a dialog does not execute. |
| MD-2 | `type-text` into Notepad with a long and multi-line text | Dialog shows the full text (line breaks as `⏎`). The summary clips at 200 characters, the detail carries the rest. |
| MD-3 | `type-text` with a background Notepad as the target | Preview allows the background target. Execution focuses the exact approved window first. If focus fails, nothing is typed. |
| MD-4 | Change the target window after preview | Refused or re-confirmed. |
| MD-5 | `launch` of an app not in `approvedApps`, and a file outside `allowedRoots` | Refused before any process starts. |
| MD-6 | Remove an app from `approvedApps` after preview | Run blocked. |
| MD-7 **(blocking, absent)** | Launch a `.chm`, `.iso`, `.msix`, `.library-ms`, `.settingcontent-ms`, `.wsc`, `.sct` or `.inf` file inside an allowed root | Refused with a reason. At `590aa55` no denylist exists, so this check cannot pass until it is added. Record as fail. |
| MD-8 | UNC, WebDAV (`\\host@SSL\…`), device and drive-relative paths | Refused before any file-system call. Use a probe that does not touch a network share. |
| MD-9 | `open-url` with `javascript:`, `file:`, and `mailto:` with `attach=` | Only `http(s)` and `mailto` open. `attach=` is refused or dropped from the rebuilt URL. |
| MD-10 | Target an elevated window or Desktop Companion itself | Refused with a reason. Password-field detection is not implemented and must not be claimed. |
| MD-11 | 31 actions within 60 seconds; safe launch | 31st refused. Safe launch refuses all actions. |
| MD-12 | Capsule restore with a window move | One confirmation lists every item. Cancel opens nothing. |
| MD-13 | `speak` followed by `Get-CimInstance Win32_Process` | No leftover PowerShell child. Input is on stdin, not in arguments. |
| MD-14 | `list-windows`, `focus`, `move-window` on Notepad | Window found with process and rect. Focus takes effect. Move clamped to visible screen. |
| MD-15 | Ask for OCR, vision, screen capture, click injection, agents or avatars | Each shows "Not implemented" or "Experimental" with a reason. No simulated output. |

### M-E. Speech and microphone (hardware dependent; user-run only)

| ID | Steps | Pass when |
|---|---|---|
| ME-1 | Decide the microphone grant wording (release §0) before this check | Decision recorded. Code and text agree. |
| ME-2 | `speak` with an installed voice, then an unknown voice name | Audio plays. Unknown voice returns a reason. No fake audio. |
| ME-3 | `transcribe` of a clear English WAV, then a silent WAV | Clear returns text. Silent returns `text: ''` with a reason. `jarvis-<uuid>.wav` is deleted. Labelled "Basic (Windows Speech)". |
| ME-4 | Push-to-talk with a real microphone | Mic active only while held. Visible indicator. Transcript in an editable preview. Text inserted only through an approved `type-text` preview. |

### M-F. Footprint (reference laptop; skipped if not available)

| ID | Steps | Pass when |
|---|---|---|
| MF-1 | Tray idle 5 minutes, separate from Ollama, `Get-Process -Name 'Desktop Companion'` | Average CPU ≤ 0.5%, working set ≤ 250 MB, no PowerShell child. |
| MF-2 | Cold start to the dashboard | ≤ 3 s on the reference laptop. |

### M-G. Re-runs for verified records (captain)

| ID | Steps | Pass when |
|---|---|---|
| MG-1 | Re-run the smoke for scopes 2, 3 and 51 on the candidate commit (MB-10) | Recorded in `docs/current-verification.md` with the commit. |
| MG-2 | Packaged network-denial run for scope 116: block outbound traffic for the packaged app with Windows Firewall, then run first run, chat, voice, capsule restore, backup export and import | No network error dialog. Record in the registry limitation. |

## 6. Unresolved gaps (not claimed)

**OAuth and accounts.** No OAuth flow exists in `src/`, `electron/` or `tests/` (search for OAuth, redirect URI, PKCE and client secret). Calendar and Spotify playback are `setup-required` in `src/ui/integration-catalog.ts`, because each needs an OAuth client registered by the app owner and a provider decision. Claude, ChatGPT and Spotify items are browser handoffs, not account connections. No account was contacted. Manual OAuth testing cannot be run until a client exists; it is not a skipped check.

**Hardware.** No hardware-dependent gate has been recorded:

- G1 Overlay: 100, 150 and 200% DPI, multi-monitor, fullscreen detection. Not run.
- G2 Local model sizing: 8 and 16 GB RAM, no GPU, first token and tokens per second on a reference laptop. Not run. The recorded `qwen3.5:2b` run at 26.9 s cold is not a gate result.
- G3 Local ASR: no permissively licensed Whisper-class runtime is bundled. Current speech is Windows System.Speech only.
- G4 Input injection: ≥ 95% on a fixture matrix. Not run.
- G6 Screen capture and OCR: not implemented.
- Reference laptop for MF-1 and MF-2: not available to this pass.

**Signing.** The build is unsigned (`signAndEditExecutable: false`). No code-signing certificate, signed update channel or rollback exists (G8, scope 117). Windows SmartScreen will warn. The release notes must say so.

**Packaging.** The Electron binary is absent under `--ignore-scripts`. `package:win` has not been run. The packaged archive has not been listed. The `Filename too long` path in `node_modules` must be handled before a clean clone can build (MB-1).

**Known code gaps that block manual items.** MD-7 (executable-type denylist, absent). ME-1 (microphone grant at `electron/main.ts:175-179` is not gated on push-to-talk). MD-1 (trusted dialog is wired in source, but the native dialog has not been observed).

**Licences.** Declared licence fields in `docs/THIRD-PARTY-NOTICES.md` are not a licence review. The project licence is not declared (release U1). Acceptance item A5 stays open.

**Scopes without gates.** Experimental scopes 20, 49, 50, 98, 99, 100, 109, 110 and 120 have no gate in architecture §10. Each needs a written gate before work.

**Not in this release.** Screen capture, OCR, vision, click injection, avatars and agents (release §7). Scope 61 (desktop island) and scope 66 (audio-reactive effects) are not built in the shell module, per its result file. Chat is not streamed in the backend. Local model runtime and weights are not bundled.

**Not run by this pass.** Electron, packaged install, real speech, microphone, desktop input, live Ollama, live cloud or any provider call, and any live window or browser check. UI evidence is limited to static markup and unit tests.

## 7. Sign-off

This document does not sign anything off. Captain sign-off requires the `docs/release-checklist.md` §8 sign-off table, with the commit, installer SHA-256 and the pass or fail result for each MA, MB, MC, MD, ME, MF and MG item that the candidate needs.
