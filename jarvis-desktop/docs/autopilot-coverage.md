# Autopilot coverage — Desktop Companion roadmap

Scope: how the 140 roadmap scopes are assigned to module owners, how their status and integration level are set, which completed module markers and source wiring support each setting, what each planned scope is waiting for, and which experimental gates are still open. Machine-readable source: `src/shared/feature-registry.json` (version 4). Human matrix: [feature matrix](feature-matrix.md). Coverage refresh 4 of 14 October 2026, worktree commit `84578df` plus this refresh's uncommitted changes.

## Method

- Denominator: 140 roadmap scopes. Every scope has one owner area and 0 are unassigned.
- Status is set from three inputs: completed module markers (`docs/autopilot-result.*.json`, `docs/milestone-result.*.json`, `docs/continuation-result.*.json`), the source wiring in this worktree (backend service, `electron/ipcCore.ts` validation, `electron/preload.ts`, and whether a screen is imported by `src/components/App.tsx`), and the recorded runs in existing docs.
- Markers alone do not set status. Where a marker's claim and the source disagree, the source wins and the marker is noted as stale in the matrix.
- Every `test` evidence reference must match an exact `test(...)` title in its file and an `ok` line in the TAP output of `npm test`. Every `smoke` and `doc` reference must name an existing file. Result: 146 test references, all exact and all `ok`; 0 problems.
- Integration level is separate from status. `module-tested` means code and passing tests exist but nothing is reachable through backend, IPC, preload or a mounted screen. `integrated` means at least one part is reachable. `runtime-verified` means a recorded run in an existing doc covers the reachable behavior.
- Module-only work stays `partial`. Only `verified` needs every part reachable and covered. This refresh adds no verified scope.
- Planned scopes now carry a `plannedReason` (category, gate, note) in the registry: `active-backlog`, `experimental-gate`, `gate-undefined`, `hardware-gate`, `licence-gate` or `account-gate`.

## Module ownership coverage

| Owner area | Responsibility | Scopes |
|---|---|---|
| main-api | Shared contracts, backend services, IPC, store, chat, capsules, search and policy. | 61 |
| native | Electron main process, PowerShell helpers, speech, window and input helpers, DPAPI, packaging, tray and hotkey. | 40 |
| ui-shell | Navigation, dashboard, onboarding and settings screens, motion and avatar screens. | 39 |

Coverage check: 140 scopes, 0 unassigned. Owner assignments are unchanged in this refresh.

## Status summary

| Status | Count | Scopes |
|---|---|---|
| verified | 5 | 2, 3, 46, 51, 116 |
| partial | 80 | 1, 4–14, 17–19, 21–23, 30–34, 36, 37, 41–45, 48, 52–57, 59, 60, 62–68, 71, 72, 75, 81–88, 101, 102, 105, 108, 111, 113–115, 121, 123–132, 134, 136, 137, 138 |
| planned | 55 | 15, 16, 20, 24–29, 35, 38–40, 47, 49, 50, 58, 61, 69, 70, 73, 74, 76–80, 89–100, 103, 104, 106, 107, 109, 110, 112, 117, 118, 119, 120, 122, 133, 135, 139, 140 |

Baselines:

- Continuation pass (previous coverage): 5 verified, 66 partial, 69 planned.
- This refresh: 5 verified, 80 partial, 55 planned. It moves 14 scopes from planned to partial (31, 33, 34, 36, 45, 48, 55, 71, 129–132, 134, 136). No partial scope moved back, and no scope moved to verified.

Integration levels: integrated 72, module-tested 10 (34, 71, 72, 75, 129, 130, 131, 132, 134, 136), runtime-verified 3 (2, 3, 51). Planned scopes are all `none`.

Changes in integration level, from module-tested to integrated, after checking the source (21 scopes): 14, 18, 19, 56, 59, 82–87, 102, 105, 108, 121, 123–128. Each is reachable through the backend and preload, and the page is imported by `App.tsx`. For 59 and 56 the mounted page is still a "not connected" stub or placeholder. The reachable part is the backend bridge, so the level is `integrated`, but the status stays partial and the limitation says so.

## Completed module evidence

Markers read for this refresh. Names in brackets are the file names used in `docs/`.

| Role | Marker file | Scopes it supports | What the source shows now |
|---|---|---|---|
| shell | `autopilot-result.shell.json`, `milestone-result.shell.json` | 1–10, 62–65, 67, 68 | Routes for Routines, Clipboard, Calendar, Models, Integrations, Usage and Avatar are in `VIEWS` and mounted. |
| api | `autopilot-result.api.json`, `continuation-result.api.json` | Contract v2, IPC validation; supports 3, 46, 81 | `electron/ipcCore.ts` validates every method. |
| integrations | `autopilot-result.integrations.json`, `continuation-result.integrations.json` | 101, 102, 105, 108 | `integrationsList`, `integrationsPreview` and related methods are in backend and preload. `Integrations.tsx` uses `formatIssueDraft`. |
| routines | `autopilot-result.routines.json`, `continuation-result.routines.json` | 82–87 | `routinesList` and related methods are in backend and preload. `Routines` is imported by `App.tsx`. The marker's "backend IPC missing" note is stale. |
| models | `autopilot-result.models.json`, `continuation-result.models.json` | 12–14, 17–19, 21, 22 | `modelsOverview` and related methods are in backend and preload. `Models` is imported. 15, 16, 20 unsupported. |
| native | `autopilot-result.native.json` | 9, 52, 115 | Native helpers and the helper integrity manifest. |
| security | `autopilot-result.security.json` | 4, 60, 81, 88, 113 | Policy and DPAPI checks. Commit `689a774` added the link-safe chosen-file path and title consent. |
| widgets | `autopilot-result.widgets.json`, `milestone-result.widgets.json` | 60, 68 | `DashboardWidgets` and `WidgetPicker` are rendered from `Home.tsx`. |
| usage | `autopilot-result.usage.json` | 121–128 | `usageReport`, `usageExport` and `usageSetBudget` are in backend and preload. `UsagePanel` is imported. |
| clipboard | `autopilot-result.clipboard.json`, `milestone-result.clipboard.json` | 56 | Backend and preload are wired. `App.tsx` has a `ClipboardView`. The milestone's `Clipboard.tsx` is not imported. |
| calendar | `autopilot-result.calendar.json`, `milestone-result.calendar.json` | 59 | Backend and preload expose `calendarList`, `calendarImportText`, `calendarImportFile`. `App.tsx` has a `CalendarView` stub. `Calendar.tsx` is not imported. |
| mods | `autopilot-result.mods.json` | 71, 72, 75 | `Customization.tsx` and `mod-catalog.ts` exist. `Customization.tsx` is not imported. Preset effects are `supported: false`. |
| accessibility | `autopilot-result.accessibility.json`, `milestone-result.a11y.json` | 8, 64 | `ACCESSIBILITY_STYLESHEET` is not imported by the shell entry. |
| visual | `milestone-result.visual.json` | 129–132, 134, 136–138 | `AvatarStudio.tsx` is not imported. `MotionStudio` is imported and renders scene templates from `motion-presets.ts`. |
| productivity | `continuation-result.productivity.json` | 31–34, 36, 37, 45, 48, 53–55 | Marker says "not wired". Stale: `ProductivityStore` is created in backend, `productivityGet` and `productivityApply` are in preload, and Capsules, Tasks, Notes and Memory search read it through the store. |
| assistant | `milestone-result.assistant.json` | 21, 22, 23 | Typed system notes and preview expiry. Chat streaming and cancel are not on the bridge (`chatStart`, `chatCancel` absent from `src`, `electron`). |
| coverage (previous) | `continuation-result.coverage.json` | Baseline counts | Superseded by this refresh. |
| release | `autopilot-result.release.json`, `milestone-result.acceptance.json` | No scope status change | Release checks. |
| roadmap | `autopilot-result.roadmap.json` | Registry v2 | Superseded by version 4. |

Markers that do not exist: `autopilot-result.visual.json` and `autopilot-result.productivity.json` use the milestone and continuation names above instead.

## Combined-tree verification

Run on this worktree at `84578df` plus the uncommitted refresh, after `npm ci --ignore-scripts` (local dependencies only):

- `npx tsc --noEmit`: exit 0.
- `npm test` (`node --test tests/*.test.mjs`): 720 tests, 720 pass, 0 fail, 0 todo. The earlier figures (477 tests with 2 failures, and 579 with 4 todo) are stale.
- Not run: `npm run build`, packaging, Electron smoke, any real speech, microphone, desktop input, live cloud call or local model call.

## Next gate checks

These are the next checks for each gate. Each one is bounded to a single record file. None has been run, and none is recorded as passed.

| Gate | Next check (bounded) | Pass criteria | Record file | Blocked by |
|---|---|---|---|---|
| G1 Overlay | On Win11 at 100%, 150% and 200% DPI on two monitors, time expand and collapse of the island, count foreground changes over 10 toggles, and measure idle memory over 10 minutes. | Expand/collapse ≤ 150 ms; no focus steal; idle delta ≤ 40 MB. | `docs/gate-g1-overlay.md` | Multi-DPI hardware. |
| G2 Local model sizing | Run each candidate Ollama model on the 8 GB and 16 GB reference laptops with a fixed 5-prompt set; record first token and tokens per second. | First token ≤ 5 s; ≥ 5 tok/s. | `docs/gate-g2-model-sizing.md` | Reference hardware and a local Ollama install. |
| G3 Local ASR upgrade | Compare one permissively licensed Whisper-class runtime with System.Speech on a fixed test set (WER), and check the licence file. | WER better than System.Speech; MIT, Apache or BSD licence. | `docs/gate-g3-asr.md` | Test audio set and licence review. |
| G4 Input injection | Run the click and type-text fixture matrix over Win32, UWP and Chromium apps, with elevated and password targets excluded. | ≥ 95% on the matrix; zero injections into elevated or password targets. | `docs/gate-g4-input.md` | Fixture apps and a safe test desktop. |
| G5 Windows mods | Review licence and safety for each catalog profile, and write reversal steps for each supported effect. | Catalog links or launches only; no bundled GPL code; each effect reversible. | `docs/gate-g5-mods.md` | Licence review and version pinning. No profile is verified yet. |
| G6 Screen capture | Test region capture with `desktopCapturer` and OCR with Windows.Media.Ocr; confirm per-capture opt-in and that nothing is stored by default. | Opt-in per capture; nothing stored by default. | `docs/gate-g6-capture.md` | Real screen and WinRT OCR on Windows. |
| G7 Avatars/motion | Measure renderer cost of the avatar and motion scenes while idle, with the studio off by default. | Within the architecture §8 idle budget; off by default. | `docs/gate-g7-motion.md` | A Windows device run. Not measured here. |
| G8 Signing | Build a signed NSIS installer, verify an update, and test rollback. | Signed NSIS; verified update; rollback works. | `docs/gate-g8-signing.md` | Code-signing certificate and update channel (account). |

Experimental scopes without a gate: 20, 49, 50, 98, 99, 100, 109, 110, 120. Each needs a written gate before work starts. The registry records them as `gate-undefined`.

## Planned scopes and their reasons

Every planned scope has a reason in the registry (`plannedReason`) and in the feature matrix. Counts: experimental-gate 17, licence-gate 10, active-backlog 13, gate-undefined 9, account-gate 4, hardware-gate 2. The reason and gate for each are in the matrix's Scopes tables.

## Stale or conflicting statements corrected here

- The product roadmap said "No application features implemented yet." It now states the real counts and the features that exist.
- Four roadmap links pointed at documents that are not in this repository. They are now named as absent.
- The matrix and this doc previously said the combined tree had 579 tests and 4 todo. The current count is 720 pass, 0 todo.
- The registry's `test` references included 28 truncated titles. All are now exact.

## Limits of this audit

- No Electron build, packaged install, real speech, real microphone, real launch, real desktop input or live cloud call was run for this refresh.
- Gate documents do not exist; every gate is `not-recorded`.
- `docs/acceptance.md` has no passed items. Evidence that depends on unrecorded manual checks is cited as a limitation, not as verification.
- The registry has no automated test enforcing its shape or its evidence references. The evidence check was a one-off script run from the temp folder; `npm test` does not run it.
- Markers were read at the time of this refresh. The refresh did not poll for new markers. Re-run it when a new marker lands, and check each changed claim against source again.
- Scope 21 stays partial: chat streaming and cancel are not on the bridge.
- Scopes 2, 3 and 51 are verified partly on a smoke recorded before the continuation (`docs/current-verification.md`). Those runs were not repeated.
- Scope 116 is verified on guard-level tests only. No packaged network-denial run is recorded.
