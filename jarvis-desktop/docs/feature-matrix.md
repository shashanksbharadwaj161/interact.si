# Feature matrix — Desktop Companion

Desktop Companion is the temporary user-facing name. The technical name `jarvis-desktop` and existing identifiers stay unchanged.

Source: [product roadmap](product-roadmap.md) (140 numbered scopes, 13 October 2026). Machine-readable copy: `src/shared/feature-registry.json` (version 5, the authority for status, integration, owner, evidence and planned reason). Gate definitions: [architecture §10](architecture.md#10-feasibility-and-experimental-gates). Coverage method and module evidence: [autopilot coverage](autopilot-coverage.md).

**Status (14 October 2026, coverage refresh 5): 5 verified, 81 partial, 54 planned, of 140 scopes.** Some implementation: 86/140 (61.4%). Fully verified scopes: 5/140 (3.6%). Neither measures the fraction of total development effort completed.

The registry is now version 5. This refresh adds selected-image OCR (scope 25) as partial, retaining screen-capture and real Windows recognition gaps. Six avatar scopes now record mounted controls; explicit recording forwards real amplitude to an inline avatar preview. No verified promotions. See `docs/receipt-result.ocr.json`, `docs/receipt-result.voice.json` and `docs/local-ui-completion.md`. The following paragraph describes refresh 4.

The previous baseline (continuation pass) was 5 verified, 66 partial and 69 planned. This refresh checks the module markers and the code in this worktree, not the markers alone. It moves 14 scopes from planned to partial and 21 partial scopes from module-tested to integrated, because their backend, IPC, preload or mounted screen is present in source. No scope was added to verified. Module-tested code is still partial. A scope becomes verified only when every part is reachable through the app and covered by a passing test or a recorded run.

## Status and integration vocabulary

| Status | Meaning |
|---|---|
| planned | No behavior in the repository beyond placeholders and unavailable-capability notices. |
| partial | Some behavior exists in the repository (module-tested or integrated), but part of the scope is missing, untested on its real path, not wired into the app, or gated. |
| verified | Every part of the scope is implemented, reachable through the app, and covered by a passing `npm test` or a recorded run in an existing doc. No open gap contradicts it. Module-only code never qualifies. |

Integration level (separate from status):

| Integration | Meaning | Count |
|---|---|---|
| none | No behavior in the repository for this scope. | 54 |
| module-tested | Code and passing tests exist, but no part is reachable through the app (not in backend, IPC, preload or a mounted screen). | 4 |
| integrated | At least one part is reachable through the app (backend, IPC, preload or a mounted screen). Module-only parts are named in the limitation. | 79 |
| runtime-verified | A run recorded in an existing doc exercised the reachable behavior on Windows. Recorded runs predate this refresh and were not repeated. | 3 |

Evidence types: `test` (a named test in `tests/` whose exact title appears as `ok` in the TAP run of `npm test`), `smoke` (a run recorded in `docs/current-verification.md`), `doc` (a repository file that describes the behavior). Module-only scopes: 34, 71, 72, 75.

## Counts

| Tier | Count | Status mix |
|---|---|---|
| First | 40 | 4 verified, 33 partial, 3 planned |
| Expansion | 68 | 1 verified, 40 partial, 27 planned |
| Experimental | 32 | 0 verified, 8 partial, 24 planned |

- 46 scopes list at least one gate.
- Experimental scopes without a gate defined in architecture §10: 20, 49, 50, 98, 99, 100, 109, 110, 120. Each needs a written gate before any work (planned reason `gate-undefined`).
- All 8 gates (G1–G8) are `not-recorded`. Architecture §10 requires each gate to be a written benchmark or licence result in `docs/`. No such document exists, so no gate-dependent scope is verified.
- Planned scopes by reason: experimental-gate (16): 15, 16, 24, 29, 39, 40, 61, 69, 70, 89, 90, 117, 133, 135, 139, 140; gate-undefined (9): 20, 49, 50, 98, 99, 100, 109, 110, 120; active-backlog (13): 26, 27, 28, 35, 38, 47, 91, 92, 93, 94, 95, 96, 97; hardware-gate (2): 58, 118; licence-gate (10): 73, 74, 76, 77, 78, 79, 80, 107, 112, 119; account-gate (4): 103, 104, 106, 122.

## Gates

| Gate | Question | Pass criteria | Scopes | Status |
|---|---|---|---|---|
| G1 Overlay | Transparent, frameless, always-on-top Electron island on Win11 at 100/150/200% DPI, multi-monitor, fullscreen-app detection | Expand/collapse ≤ 150 ms, no focus stealing, idle delta ≤ 40 MB | 61, 63, 65, 66, 67 | not-recorded |
| G2 Local model sizing | Which Ollama models run on 8/16 GB RAM, no GPU | First token ≤ 5 s, ≥ 5 tok/s on reference laptop | 11, 15, 16, 17, 18, 19 | not-recorded |
| G3 Local ASR upgrade | Permissively licensed Whisper-class runtime, bundled or imported offline | WER better than System.Speech on test set; licence MIT/Apache/BSD | 12, 23, 40 | not-recorded |
| G4 Input injection | Reliable click/type-text across Win32/UWP/Chromium apps | ≥ 95% on fixture matrix, never into elevated or password targets | 88, 89, 90 | not-recorded |
| G5 Windows mods | Licence and safety of each third-party mod (Windhawk-style mods are often GPL) | Catalog links/launches external tools only; no bundled GPL code; reversible | 71, 72, 73, 74, 75, 76, 77, 78, 79, 80 | not-recorded |
| G6 Screen capture | desktopCapturer region capture + local OCR (Windows.Media.Ocr via WinRT) | Opt-in per capture, nothing stored by default | 24, 25, 29, 39, 40 | not-recorded |
| G7 Avatars/motion | Renderer cost of 2D/3D avatar and motion scenes | Within architecture §8 budget when idle; off by default | 69, 70, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140 | not-recorded |
| G8 Signing | Code-signing certificate and update channel | Signed NSIS + verified update + rollback | 117 | not-recorded |

Gate status vocabulary: not-recorded, passed, failed.

## Conflicts and gaps for root review

- **Corrected: the roadmap claim.** The product roadmap previously said "No application features implemented yet." That was false for this worktree. Shell, onboarding, assistant, routines, models, integrations, usage, productivity and dashboard widgets have code, tests and mounted screens. The roadmap now states the real counts, and the statuses above are the source of truth.
- **Combined tree at `84578df`.** `npm run typecheck` (`tsc --noEmit`) exits 0. `npm test` runs 720 tests: 720 pass, 0 fail, 0 todo. The earlier figure of 579 tests is stale. Module and guard tests use injected fakes; they do not establish the Electron, speech or live-model paths. Not run: packaging, Electron smoke, `npm run build`, any live provider or local model call.
- **Evidence references.** The registry has 146 `test` references. 28 of them were truncated prefixes of longer test titles and are now the full titles. All 146 now match an exact `test(...)` title in their file and an `ok` line in the TAP run of `npm test`.
- **Stale module markers.** `docs/continuation-result.productivity.json` says productivity is not wired into main or preload. Source now creates `ProductivityStore` in `electron/backend.ts`, exposes `productivityGet` and `productivityApply` through the preload bridge, and the Capsules, Tasks, Notes and Memory search screens read it. The marker is kept as history.
- **Mounted placeholders contradict wiring.** `src/components/App.tsx` still shows "not connected" notices for Usage, Clipboard history, Calendar and Avatar. Calendar and Clipboard IPC exist in backend and preload. Shell or captain must check each notice against its bridge before any release claim.
- **Module-only components not mounted.** `Calendar.tsx`, `Clipboard.tsx`, `AvatarStudio.tsx` and `Customization.tsx` are not imported by `App.tsx`. `ACCESSIBILITY_STYLESHEET` is not imported by the shell entry, so the accessibility module is not applied. Scopes 59, 56, 129–136, 71 and 75 stay partial until the captain mounts them.
- **Shell milestone interface requests.** `docs/milestone-result.calendar.json` and `docs/milestone-result.clipboard.json` say "not mounted" and "no calendar IPC channel exists". The second statement is stale for calendar: `calendarList`, `calendarImportText` and `calendarImportFile` exist in backend and preload.
- **Streaming and cancel.** Chat streaming and cancel are not on the JarvisAPI bridge (see `docs/milestone-result.assistant.json`). Scope 21 stays partial for that reason.
- **Missing linked documents.** The product roadmap linked four files that are not in this repository: `integrations-hub-plan.md`, `repository-review-and-product-direction.md`, `voice-integration-and-component-shortlist.md` and `motion-avatars-usage-and-design-plan.md`. The roadmap now names them as absent instead of linking them.
- **Module-only scopes.** 34, 71, 72, 75, 129, 130, 131, 132, 134, 136 have tested code that no reachable path reaches.
- **Verified records for captain review.** Scope 116 is verified on guard-level tests only; no packaged network-denial run is recorded. Scopes 2, 3 and 51 are verified on test evidence plus the pre-continuation smoke in `docs/current-verification.md`. Those smoke runs were not repeated.
- **Scope 23 gate.** Architecture §10 lists G3 as blocking, but §11 plans System.Speech dictation for first release. The registry follows §10.
- **Scope 40 gates.** §10 lists G3, §11 lists G6. The registry lists both.
- **Gate documents.** No G1–G8 result document exists in `docs/`. `docs/acceptance.md` has no passed items. Manual acceptance is not claimed.

## Scopes

Columns: **#** scope · **Tier** · **Status** · **Integration** · **Owner** (module area, see `moduleOwnership` in the registry) · **Gates** · **Evidence** (types cited) · **Limitation**. For planned scopes the limitation column gives the backlog reason and gate.

### Application & onboarding

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 1 | First-run setup wizard | First | partial | integrated | ui-shell | — | test | Wizard steps and the draft-model check exist; no recorded end-to-end run of the full wizard flow. |
| 2 | Hardware and dependency checks | First | verified | runtime-verified | native | — | test, smoke | Checks only; no dependency installer. Recorded smoke predates this continuation; re-run after integration. |
| 3 | Offline/online mode selection | First | verified | runtime-verified | main-api | — | test, smoke | Online mode needs a user-provided key; no automatic fallback. Recorded smoke predates this continuation; re-run after integration. |
| 4 | Permission setup and review | First | partial | integrated | ui-shell | — | test | Backend permission gating and permission-change descriptions are tested; the review UI is not. |
| 5 | Main application dashboard | First | partial | integrated | ui-shell | — | doc | Home screen with widget arrangement exists; no visual or runtime check recorded for the shell changes. |
| 6 | Searchable settings | First | partial | integrated | ui-shell | — | test | Searches section titles, tab names and keywords, not every field label; no runtime check recorded. |
| 7 | Personal profiles and preferences | First | partial | integrated | ui-shell | — | doc, test | Display name and preferences exist; no personal profiles. |
| 8 | Keyboard and accessibility controls | First | partial | integrated | ui-shell | — | doc, test | Shell shortcuts are tested; the accessibility module is not imported by App.tsx; no keyboard-only or screen-reader run recorded. |
| 9 | Tray, startup, notification preferences | First | partial | integrated | native | — | doc, test | Tray, hotkey and login-item helpers exist; no Settings control for login item or notifications; no Windows notifications. |
| 10 | Help, tutorials, diagnostic status | First | partial | integrated | ui-shell | — | doc, test | Help dialog and diagnostic status exist; no tutorials. |

### Local AI & voice

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 11 | Local text reasoning | First | partial | integrated | main-api | G2 | test, smoke | Gate G2 not recorded; no default-model sizing. |
| 12 | Local speech recognition | First | partial | integrated | native | G3 | test, doc | Basic recognizer only; manual acceptance not run. |
| 13 | Local speech playback | First | partial | integrated | native | — | test, doc | Audible playback not recorded. |
| 14 | Local model-pack setup and offline import | First | partial | integrated | main-api | — | test | Model-pack validation, folder import and the mounted Models page run through the backend. No recorded run with a real GGUF pack exists and G2 sizing is not recorded. |
| 15 | Local vision model support | Expansion | planned | none | main-api | G2 | — | **Backlog reason:** experimental-gate (G2). Local vision model needs the G2 sizing run on 8/16 GB machines first. |
| 16 | Local embeddings and retrieval | Expansion | planned | none | main-api | G2 | — | **Backlog reason:** experimental-gate (G2). Local embeddings need the G2 sizing run first. |
| 17 | Model switching and version pinning | Expansion | partial | integrated | main-api | G2 | doc, test | Switching by model name in Settings works; the select flow is module-tested only; no version pinning. Gate G2 open. |
| 18 | CPU/GPU and memory budgets | Expansion | partial | integrated | main-api | G2 | test | The resource profile is selectable on the mounted Models page through the backend. Budgets are enforced as profiles, not measured on a reference laptop (G2 not recorded). |
| 19 | Model download verification and removal | Expansion | partial | integrated | main-api | G2 | test | Pack checksum and size validation and pack removal are reachable through the backend. Live model pulls need a local Ollama; no recorded download run exists. |
| 20 | Personal model fine-tuning experiments | Experimental | planned | none | main-api | — | — | **Backlog reason:** gate-undefined. Experimental with no gate in architecture section 10; a written gate is required before work. |

### Assistant & screen tools

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 21 | Text chat with streaming | First | partial | integrated | main-api | — | test, doc | Streaming lives in the chat service, but the backend still uses non-streaming chat, so the UI gets no tokens or Stop button. Two cancellation tests fail in the combined tree (tests/autopilot-models.test.mjs). |
| 22 | Push-to-talk conversation | First | partial | integrated | ui-shell | — | doc, test | Manual microphone checks not run. |
| 23 | Clean dictation with insertion preview | First | partial | integrated | native | G3 | doc | Raw transcript only; no clean-up. Gate G3 open. |
| 24 | Selected screen-region questions | First | planned | none | native | G6 | — | **Backlog reason:** experimental-gate (G6). Region capture needs the G6 screen-capture gate; nothing is captured by default. |
| 25 | OCR and otherwise unselectable text extraction | Expansion | planned | none | native | G6 | — | **Backlog reason:** experimental-gate (G6). OCR depends on the G6 capture gate (Windows.Media.Ocr). |
| 26 | Translation and app-specific writing tone | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Writing tone and translation need model output that is not verified; buildable next on the assistant path. |
| 27 | Approved document explanations | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Approved-document explanations need an approved-document source and model output; backlog. |
| 28 | Error diagnosis with proposed actions | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Error diagnosis with proposed actions is backlog; any action must still use the confirmation path. |
| 29 | Explicit screen/app context controls | Expansion | planned | none | main-api | G6 | — | **Backlog reason:** experimental-gate (G6). Explicit screen and app context needs the G6 capture gate. |
| 30 | Conversation history and export | Expansion | partial | integrated | main-api | — | doc, test | Chat is one thread; export is whole-state JSON only. |

### Memory & journal

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 31 | Explicit project checkpoints | First | partial | integrated | main-api | — | test | Checkpoints are saved per capsule in the productivity store, reachable through backend IPC and shown on the mounted Capsules screen. Checkpoints are explicit only; nothing is captured automatically. |
| 32 | Searchable project notes and references | First | partial | integrated | ui-shell | — | test, smoke | Notes are not linked to projects. |
| 33 | Opt-in application session timeline | Expansion | partial | integrated | native | — | test | The timeline is opt-in and stored through backend productivity operations. No source reports application sessions, so it stays empty; no screen offers timeline entries. |
| 34 | Evidence-backed daily recaps | Expansion | partial | module-tested | main-api | — | test | buildDailyRecap in the search module lists only recorded evidence for a local day, each line with its source. No screen or backend call uses it, so it is not reachable. No drafted summary text. |
| 35 | Draft worklog and standup updates | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Worklog and standup drafts depend on evidence-backed recaps (34), which are not reachable yet. |
| 36 | Correctable task/session association | Expansion | partial | integrated | main-api | — | test | Session associations and word-based suggestions are stored through backend productivity operations. No screen offers an add or edit control, and no session timeline data exists to associate. |
| 37 | Memory edit, forget, retention controls | Expansion | partial | integrated | main-api | — | doc | applyRetention has no test; no per-memory forget control. |
| 38 | Coding-session adapters | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Coding-session adapters are backlog; no adapter exists. |
| 39 | Continuous screen history | Experimental | planned | none | native | G6 | — | **Backlog reason:** experimental-gate (G6). Continuous screen history needs the G6 gate and a retention design. |
| 40 | Meeting/system-audio capture and summaries | Experimental | planned | none | native | G3, G6 | — | **Backlog reason:** experimental-gate (G3,G6). Meeting and system-audio capture needs the G3 ASR gate and the G6 capture gate. |

### Projects & workspaces

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 41 | Project capsules with goals and references | First | partial | integrated | ui-shell | — | smoke, test | No goals or references yet (src/ui/roadmap.ts note). |
| 42 | Launch apps, files, and URLs together | First | partial | integrated | native | — | test, smoke | Successful launch on Windows not recorded. |
| 43 | Save and restore supported window geometry | First | partial | integrated | native | — | test, doc | Restore only when window data exists; UI does not capture geometry. |
| 44 | Project-specific visual scene | Expansion | partial | integrated | ui-shell | — | doc | Scene choice only; no project-specific visual logic. |
| 45 | Resume recap with source references | Expansion | partial | integrated | main-api | — | test | The resume recap on the mounted Capsules screen is built from saved goals, checkpoints, focus time, linked notes and tasks, and the last restore, each with its source. No export and no recorded run with real project data. |
| 46 | Cross-project search | Expansion | verified | integrated | main-api | — | test | Searches in-app data only; chat excluded by default. |
| 47 | Browser-profile and tab adapters | Expansion | planned | none | native | — | — | **Backlog reason:** active-backlog. Browser-profile and tab adapters are backlog; each browser needs its own adapter work. |
| 48 | Portable capsule export with path mapping | Expansion | partial | integrated | main-api | — | test | Capsule packs export with a project-root token and import through backend IPC with user path mappings. Unmapped paths are reported. No recorded run through the packaged app. |
| 49 | Deep app-state restoration adapters | Experimental | planned | none | native | — | — | **Backlog reason:** gate-undefined. Experimental with no gate in architecture section 10; a written gate is required before work. |
| 50 | Spatial project map with historical branches | Experimental | planned | none | ui-shell | — | — | **Backlog reason:** gate-undefined. Experimental with no gate in architecture section 10; a written gate is required before work. |

### Everyday productivity

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 51 | Tasks and checklists | First | verified | runtime-verified | ui-shell | — | smoke, test | Flat checklist; no nested sub-items. Recorded smoke predates this continuation; re-run after integration. |
| 52 | Reminders and timers | First | partial | integrated | native | — | test, doc | Due-task reminders tested; the focus timer has no test. |
| 53 | Focus sessions with history | First | partial | integrated | ui-shell | — | doc | Timer runs; no session history. |
| 54 | Quick notes and snippets | Expansion | partial | integrated | ui-shell | — | doc | Quick notes only. |
| 55 | File shelf with references | Expansion | partial | integrated | native | — | test | Shelf and recent-item references are stored and bounded through backend productivity operations. No add or edit control exists and no screen shows the shelf. |
| 56 | Optional clipboard history | Expansion | partial | integrated | native | — | test | The mounted Clipboard history page reads status and entries through backend IPC. It is off by default, needs the native confirmation and keeps memory only. No copy-back and no full-text view. |
| 57 | Application launcher and recent items | Expansion | partial | integrated | native | — | test | Launch of approved apps only; no recent items. |
| 58 | Media and per-app volume controls | Expansion | planned | none | native | — | — | **Backlog reason:** hardware-gate. Per-app volume needs Windows audio-session APIs verified on real audio hardware; no such run exists. |
| 59 | Calendar view and local calendar import | Expansion | partial | integrated | main-api | — | test | Backend IPC and preload expose .ics list, import and clear, so the calendar is integrated at the bridge. The mounted Calendar page is still a stub that says it is not connected; Calendar.tsx is not mounted. No recurrence expansion and no account connectors. |
| 60 | System, battery, and device widgets | Expansion | partial | integrated | native | — | test | RAM and CPU only; GPU, temperature and battery are reported unavailable; battery and device widgets are not built; the widget picker module is not mounted. |

### Visuals & motion

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 61 | Movable expanding desktop island | First | planned | none | native | G1 | — | **Backlog reason:** experimental-gate (G1). Overlay needs the G1 gate: transparent window on Win11 at 100/150/200% DPI and multi-monitor. |
| 62 | Original color, typography, material themes | First | partial | integrated | ui-shell | — | doc | Color themes only; no material themes. |
| 63 | Interruptible status and panel animations | First | partial | integrated | ui-shell | G1 | doc | In-window only. Gate G1 open. |
| 64 | Reduced motion, battery, fullscreen controls | First | partial | integrated | ui-shell | — | doc, test | Reduce motion (app and Windows), a battery rule where navigator.getBattery exists, and a manual fullscreen toggle; automatic fullscreen detection needs Gate G1. |
| 65 | Companion with assistant-state animations | Expansion | partial | integrated | ui-shell | G1 | doc | In-window only. Gate G1 open. |
| 66 | Audio-reactive waveforms and effects | Expansion | partial | integrated | ui-shell | G1 | doc | Level meter only, no waveform effects. Gate G1 open. |
| 67 | Animated project/scene transitions | Expansion | partial | integrated | ui-shell | G1 | doc | Whole-scene cross-fade in CSS (opacity only, removed under reduced motion); no per-capsule transition; no runtime check recorded. Gate G1 open. |
| 68 | Widget layout editor and live preview | Expansion | partial | integrated | ui-shell | — | test | Arrange mode reorders, hides and resets widgets on the live dashboard; no free drag or resize; the widget picker module is not mounted. |
| 69 | Live wallpaper/shader scenes | Experimental | planned | none | ui-shell | G7 | — | **Backlog reason:** experimental-gate (G7). Live wallpaper and shader scenes need the G7 renderer-cost gate. |
| 70 | Physics-driven desktop and window effects | Experimental | planned | none | native | G7 | — | **Backlog reason:** experimental-gate (G7). Physics-driven desktop effects need the G7 renderer-cost gate and an overlay path. |

### Windows customization

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 71 | Curated optional mod catalog | First | partial | module-tested | native | G5 | test | The catalog data and Customization component exist, but Customization.tsx is not mounted, so no screen shows it. Every profile is an original description with licence unverified (G5); nothing is verified or tested on Windows. |
| 72 | Mod version and compatibility checks | First | partial | module-tested | native | G5 | test | Module-only: not wired to IPC or a mounted screen. Check logic only: no profile can return compatible because none is tested, and SystemInfo has no Windows build number yet. Gate G5 open. |
| 73 | Taskbar and Start menu presets | Expansion | planned | none | native | G5 | — | **Backlog reason:** licence-gate (G5). Taskbar presets: only preview data exists; every effect is unsupported until G5 is recorded. |
| 74 | Explorer and notification presets | Expansion | planned | none | native | G5 | — | **Backlog reason:** licence-gate (G5). Explorer and notification presets: preview data only; every effect is unsupported until G5 is recorded. |
| 75 | Save and restore customization settings | Expansion | partial | module-tested | native | G5 | test | Module-only: not wired to IPC or a mounted screen. Save (UI-only preference) and JSON export work in the module; restore is not built and its control is disabled; nothing is applied to Windows. Gate G5 open. |
| 76 | Advanced window borders, corners, transparency | Experimental | planned | none | native | G5 | — | **Backlog reason:** licence-gate (G5). Window border and transparency changes need G5 (licence and safety of each mod). |
| 77 | Dock/genie/wobble animation packs | Experimental | planned | none | native | G5 | — | **Backlog reason:** licence-gate (G5). Dock and animation packs need G5 (licence and safety of each mod). |
| 78 | Resource and icon redirection packs | Experimental | planned | none | native | G5 | — | **Backlog reason:** licence-gate (G5). Resource and icon redirection needs G5 and a reversal design. |
| 79 | Virtual-desktop behavior modifications | Experimental | planned | none | native | G5 | — | **Backlog reason:** licence-gate (G5). Virtual-desktop modifications need G5 and a reversal design. |
| 80 | AI-composed validated scene specifications | Experimental | planned | none | main-api | G5 | — | **Backlog reason:** licence-gate (G5). AI-composed scene specifications need G5 and the validated scene path (139). |

### Routines & automation

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 81 | Approved app-launch action tools | First | partial | integrated | native | — | test | Preview and approval tested with native stubs; real launch not recorded. |
| 82 | Durable scheduled routines | First | partial | integrated | main-api | — | test | The routine engine persists and starts routines through backend IPC and the mounted Routines page. Runs go through preview and native confirmation. No Windows scheduler run is recorded. |
| 83 | Visual editable workflow steps | Expansion | partial | integrated | ui-shell | — | test | Steps are edited on the mounted Routines page through the backend. No visual graph editor is built; the editor is a step list. |
| 84 | Conditions, bounded retries, duplicate prevention | Expansion | partial | integrated | main-api | — | test | Conditions, bounded retries and one-run-per-routine duplicate prevention are reachable through the backend and tested in the engine. No recorded run on Windows. |
| 85 | Execution results and partial-failure history | Expansion | partial | integrated | main-api | — | test | Run results and the bounded run history are kept by the engine and reachable through the backend. A restart marks in-flight runs interrupted and never auto-resumes them. |
| 86 | Cancellation and pause-all controls | Expansion | partial | integrated | main-api | — | test | Cancel, pause-all and resume are reachable through backend IPC and tested in the engine. No recorded Windows run. |
| 87 | Undo for explicitly reversible steps | Expansion | partial | integrated | main-api | — | test | The engine keeps undo records for explicitly reversible steps, but the mounted Routines page has no undo control and undo is not exercised end to end. Only the engine and API are reachable. |
| 88 | Selected file/browser action adapters | Expansion | partial | integrated | native | G4 | test | Open-URL and mailto only. Gate G4 open for typing and clicks. |
| 89 | Watch-once routine recording | Experimental | planned | none | native | G4 | — | **Backlog reason:** experimental-gate (G4). Watch-once recording needs the G4 input-injection gate (95% fixture matrix). |
| 90 | Cross-app semantic drag-to-action workflows | Experimental | planned | none | native | G4 | — | **Backlog reason:** experimental-gate (G4). Cross-app semantic drag needs the G4 input-injection gate. |

### Agents & developer tools

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 91 | Task board and worker status | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent scope; held by acceptance N3 until an agent gate document exists. |
| 92 | Isolated project workspaces | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent scope; held by acceptance N3 until an agent gate document exists. |
| 93 | Model/worker role selection | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent scope; held by acceptance N3 until an agent gate document exists. |
| 94 | Persistent resumable agent sessions | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent scope; held by acceptance N3 until an agent gate document exists. |
| 95 | Scoped tools and context policies | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent scope; held by acceptance N3 until an agent gate document exists. |
| 96 | Agent logs and result inspection | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent scope; held by acceptance N3 until an agent gate document exists. |
| 97 | Budgets and bounded task execution | Expansion | planned | none | main-api | — | — | **Backlog reason:** active-backlog. Agent budgets are backlog; usage budgets (126) exist but no agent runs are reported. |
| 98 | Local specialist multi-agent execution | Experimental | planned | none | main-api | — | — | **Backlog reason:** gate-undefined. Experimental with no gate in architecture section 10; a written gate is required before work. |
| 99 | Animated worker/crew visualization | Experimental | planned | none | ui-shell | — | — | **Backlog reason:** gate-undefined. Experimental with no gate in architecture section 10; a written gate is required before work. |
| 100 | Suggested reusable skills from past runs | Experimental | planned | none | main-api | — | — | **Backlog reason:** gate-undefined. Experimental with no gate in architecture section 10; a written gate is required before work. |

### Optional online integrations

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 101 | Anthropic BYOK provider | Expansion | partial | integrated | main-api | — | test | Chat uses the existing cloud path; the Anthropic connection check is module-tested and its IPC is not implemented in backend.ts. Fake-fetch tests only; no live provider call recorded. |
| 102 | Additional optional AI providers | Expansion | partial | integrated | main-api | — | test | The mounted Integrations page and backend cover the optional providers (Spotify, browser, ChatGPT, Claude, local model entries). Keys stay in DPAPI storage, nothing is sent outside online mode, and no live provider call is recorded. |
| 103 | Web research with cited sources | Expansion | planned | none | main-api | — | — | **Backlog reason:** account-gate. Cited web research needs a user-provided search or model provider key and online mode. |
| 104 | Calendar account connectors | Expansion | planned | none | main-api | — | — | **Backlog reason:** account-gate. Calendar account connectors need a user calendar account; only local .ics import exists (59). |
| 105 | Issue-tracker draft export and approved posting | Expansion | partial | integrated | main-api | — | test | Issue draft formatting (formatIssueDraft) is used by the mounted Integrations page. Approved posting is not built, so drafts are local text only. |
| 106 | Weather/news feed widgets | Expansion | planned | none | ui-shell | — | — | **Backlog reason:** account-gate. Weather and news feeds need a provider account and online mode. |
| 107 | Optional model/update downloads | Expansion | planned | none | main-api | — | — | **Backlog reason:** licence-gate. Optional downloads need source licence and integrity checks; no download source is approved. |
| 108 | Per-provider data previews and usage history | Expansion | partial | integrated | main-api | — | test | Per-provider data previews (integrationsPreview) and bounded usage history are reachable through backend IPC and the Integrations page. No live provider call is recorded. |
| 109 | Encrypted cross-device sync | Experimental | planned | none | main-api | — | — | **Backlog reason:** gate-undefined. Cross-device sync needs an account and encryption design; experimental with no gate. |
| 110 | Community scene/widget marketplace | Experimental | planned | none | ui-shell | — | — | **Backlog reason:** gate-undefined. A community marketplace needs licence, review and account decisions; experimental with no gate. |

### Installation & ownership

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 111 | Windows installer and uninstaller | First | partial | integrated | native | — | smoke | Install and uninstall not verified; unsigned. |
| 112 | Bundled runtime and offline installation option | First | planned | none | native | — | — | **Backlog reason:** licence-gate. Bundling a runtime needs a licence review and an offline packaging run; no packaged build exists. |
| 113 | Local encrypted sensitive-data storage | First | partial | integrated | main-api | — | test, doc | Cloud key and integration slots use safeStorage or DPAPI with a fallback; state.json and persisted clipboard history are plain JSON. |
| 114 | Export/import and backup recovery | First | partial | integrated | main-api | — | test | Import tested; export and backup recovery have no recorded run. |
| 115 | Crash recovery and safe launch | First | partial | integrated | native | — | test, doc | Recovery path not recorded in a run; acceptance J2 unchecked. |
| 116 | Network-denial/offline verification | First | verified | integrated | main-api | — | test | Guard-level tests; packaged network-denial run not recorded. |
| 117 | Signed updates with rollback | Expansion | planned | none | native | G8 | — | **Backlog reason:** experimental-gate (G8). Signed updates need the G8 code-signing certificate and update channel. |
| 118 | Validated x64/ARM64 compatibility tiers | Expansion | planned | none | native | — | — | **Backlog reason:** hardware-gate. ARM64 and x64 tiers need validated devices; none are available for testing here. |
| 119 | Commercial licensing without mandatory cloud check-in | Expansion | planned | none | main-api | — | — | **Backlog reason:** licence-gate. Commercial licensing needs a licence decision; no licence design exists. |
| 120 | Enterprise policy and managed deployment | Experimental | planned | none | main-api | — | — | **Backlog reason:** gate-undefined. Enterprise policy needs an account model and a gate; experimental with no gate. |

### Usage dashboard

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 121 | Unified usage dashboard | Expansion | partial | integrated | main-api | — | test | The mounted Usage page (UsagePanel) reads the usage ledger through backend IPC. Spend is an estimate from user-entered prices, not provider billing. |
| 122 | Supported provider quota/balance adapters | Expansion | planned | none | main-api | — | — | **Backlog reason:** account-gate. Provider quota and balance adapters need provider accounts and keys; none are tested. |
| 123 | Reset countdown and stale-data indicators | Expansion | partial | integrated | main-api | — | test | The reset countdown and stale-data indicators are reachable on the Usage page. Provider quota data is not fetched because scope 122 is not built. |
| 124 | Local token and estimated cost ledger | Expansion | partial | integrated | main-api | — | test | The local token and estimated cost ledger is reachable through usageReport and persisted. Costs are estimates from user prices, not provider billing. |
| 125 | Project/worker cost attribution | Expansion | partial | integrated | main-api | — | test | Project and worker attribution is in the ledger report. No worker runs exist yet (agent scopes 91-100 are not built), so attribution holds only what other code records. |
| 126 | Budget pace and threshold alerts | Expansion | partial | integrated | main-api | — | test | Budget and threshold settings are reachable through usageSetBudget and checked locally. Alerts are only as accurate as the ledger. |
| 127 | Local inference performance history | Expansion | partial | integrated | main-api | — | test | Local inference performance history is reachable through usage.performance() and filled by requests made through the local runtime. No Windows measurement is recorded. |
| 128 | Usage report export | Expansion | partial | integrated | main-api | — | test | Usage report export (CSV or JSON, bounded, with a truncated flag) is reachable through usageExport on the Usage page. |

### Avatar studio

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 129 | 2D avatar geometry editor | Experimental | partial | module-tested | ui-shell | G7 | test | The 2D geometry editor module exists and is tested, but AvatarStudio.tsx is not mounted; the Avatar page still says editing is not connected. Shapes are original 2D vectors only. |
| 130 | Expression authoring library | Experimental | partial | module-tested | ui-shell | G7 | test | Expression data is validated and capped on import in the avatar module, but no expression authoring UI is mounted (AvatarStudio.tsx is not mounted). |
| 131 | Avatar animation timeline editor | Experimental | partial | module-tested | ui-shell | G7 | test | Animation timeline data is validated and capped on import in the avatar module. No timeline editor is mounted. |
| 132 | Portable avatar pack import/export | Experimental | partial | module-tested | ui-shell | G7 | test | Avatar pack validation and bounded import and export are tested in the module. Import and export are not reachable from the app because AvatarStudio.tsx is not mounted. |
| 133 | 3D avatar/model customization | Experimental | planned | none | ui-shell | G7 | — | **Backlog reason:** experimental-gate (G7). 3D avatar customization needs the G7 renderer-cost gate and a 3D asset licence; shown as unavailable. |
| 134 | Voice-driven avatar mouth/pose states | Experimental | partial | module-tested | ui-shell | G7 | test | The mouth and pose states react only to a host-injected amplitude, bounded to 0..1. The studio never opens a microphone and nothing connects it to audio input. Not mounted. |
| 135 | Realistic portrait animation adapter | Experimental | planned | none | ui-shell | G7 | — | **Backlog reason:** experimental-gate (G7). Portrait animation needs the G7 gate and a licensed model; shown as unavailable. |
| 136 | Avatar quality/hardware profile manager | Experimental | partial | module-tested | ui-shell | G7 | test | Quality profiles are manual presets that bound frame rate and pixel ratio. There is no automatic hardware detection, and the profiles are not mounted (AvatarStudio.tsx is not mounted). |

### Motion studio

| # | Scope | Tier | Status | Integration | Owner | Gates | Evidence | Limitation |
|---|---|---|---|---|---|---|---|---|
| 137 | Procedural motion scene editor | Experimental | partial | integrated | ui-shell | G7 | doc | Preview and save only; no timeline. Gate G7 open. |
| 138 | Original scene/template library | Experimental | partial | integrated | ui-shell | G7 | test | Built-in presets only. Gate G7 open. |
| 139 | AI-to-validated-scene generation | Experimental | planned | none | ui-shell | G7 | — | **Backlog reason:** experimental-gate (G7). AI-to-scene generation needs the G7 gate and a model path; no generated output exists. |
| 140 | Local animation/clip export | Experimental | planned | none | ui-shell | G7 | — | **Backlog reason:** experimental-gate (G7). Clip export needs the G7 gate and a renderer export path; only JSON scene export exists. |
