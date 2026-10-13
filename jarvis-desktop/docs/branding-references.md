# Branding references — Desktop Companion

Status: working naming audit (read-only; no source edits). The app has no final name. Visible text uses **Desktop Companion** (the product) and **the assistant** (the AI persona). Technical identifiers keep their current names for compatibility.

Scope of this audit: the checkpoint on branch `ao/jarvis-desktop-27/root` (HEAD `2fc88a8`). Line numbers below match that tree. Re-check them before editing, because other workers may move lines.

Method: case-insensitive search for `jarvis` across `src/`, `electron/` (including `electron/services/`), `index.html`, `package.json`, `README.md`, `scripts/`, `native/`, `tests/` and `docs/`. Each hit was then classified as user-visible text, a technical identifier, or a code comment. No source files were edited.

## 1. Already correct (no change needed)

| Location | Text | Note |
| --- | --- | --- |
| `package.json` `productName` | `Desktop Companion` | Also drives the electron-builder installer product name. |
| `index.html` `<title>` | `Desktop Companion` | Already correct. The plan (X8) lists it as a Jarvis string; that is stale. |
| `README.md` line 1 | `Desktop Companion — working name` | Correct. |

## 2. User-visible text to replace

These strings reach the user through the renderer, native dialogs, the tray, the window chrome, or a visible file name. Owner column follows the owners named in `docs/product-interaction-review.md` (P0-8) and `docs/resume-integration-plan.md` (X8).

### 2a. Renderer (owner: UI)

| # | File:line | Current text | Proposed text |
| --- | --- | --- | --- |
| R1 | `src/components/App.tsx:228` | `<strong>JARVIS</strong>` (sidebar brand mark) | `Desktop Companion`. A short mark needs a decision from the product owner; do not invent one. |
| R2 | `src/components/Onboarding.tsx:49` | `<strong>JARVIS</strong>` | Same as R1. |
| R3 | `src/components/Onboarding.tsx:70` | `Choose how Jarvis may think` | `Choose how the assistant may think` |
| R4 | `src/components/Onboarding.tsx:129` | `Folders Jarvis may be asked to work inside. …` | `Folders the assistant may be asked to work inside. …` |
| R5 | `src/components/Onboarding.tsx:133` | `Applications Jarvis may launch for you …` | `Applications the assistant may launch for you …` |
| R6 | `src/components/Onboarding.tsx:146` | `Jarvis does not bundle a model. …` | `Desktop Companion does not bundle a model. …` |
| R7 | `src/components/Settings.tsx:272` | `Folders Jarvis may work inside when asked. …` | `Folders the assistant may work inside when asked. …` |
| R8 | `src/components/Settings.tsx:276` | `Applications Jarvis may launch. …` | `Applications the assistant may launch. …` |

Count: 8 renderer strings across 2 files (`App.tsx` 1, `Onboarding.tsx` 5, `Settings.tsx` 2).

### 2b. Electron shell and main process (owner: Electron shell)

| # | File:line | Current text | Proposed text |
| --- | --- | --- | --- |
| E1 | `electron/main.ts:38` | Save-dialog filter name `Jarvis export (JSON)` | `Desktop Companion export (JSON)` |
| E2 | `electron/main.ts:44` | Open-dialog filter name `Jarvis export (JSON)` | `Desktop Companion export (JSON)` |
| E3 | `electron/main.ts:81` | Startup error page heading `<h2>Jarvis Desktop</h2>` | `Desktop Companion` |
| E4 | `electron/main.ts:87` | `BrowserWindow` `title: 'Jarvis Desktop'` | `Desktop Companion` |
| E5 | `electron/main.ts:143` | Tray tooltip `Jarvis Desktop` | `Desktop Companion` |
| E6 | `electron/main.ts:145` | Tray menu item `Show / hide Jarvis` | `Show / hide Desktop Companion` |
| E7 | `electron/main.ts:209` | Error box title `Jarvis Desktop could not start` | `Desktop Companion could not start` |

Notes:
- E4: the page `<title>` in `index.html` already reads `Desktop Companion`. Whether the page title overrides the explicit `title` option at runtime was not checked in a running app. Changing E4 makes both sources agree either way.
- E3 is the fallback page loaded when the interface stops unexpectedly twice (`main.ts:104`). E7 is the error box shown when startup fails. Both are visible text.

### 2c. Visible file name (owner: BE, with Electron shell)

| # | File:line | Current | Proposed |
| --- | --- | --- | --- |
| F1 | `electron/backend.ts:202` | Default export file name `jarvis-export-<stamp>.json`, shown in the save dialog | `desktop-companion-export-<stamp>.json` |

The export `format` id (`jarvis-export`) is a file-content identifier and must stay (see section 3). Only the default file name changes. Import validates the `format` id and the document content (`electron/backend.ts:224-226`), not the file name, so existing exports still import. The open dialog filter (E2) only filters by extension.

### 2d. Backend messages shown in the UI (owner: BE)

| # | File:line | Current text | Proposed text |
| --- | --- | --- | --- |
| B1 | `electron/services/actions.ts:97` | `Safe launch is active: actions are disabled until Jarvis is restarted normally` (deny reason, shown in the action preview as "Reason", `Computer.tsx:235`) | `… until Desktop Companion is restarted normally` |

Note: the product review (P0-8) cites `actions.ts:88`, `policy.ts:139` and `store.ts:62,111` for messages. In this checkpoint, only `actions.ts:97` contains `Jarvis`. `policy.ts` and `store.ts` contain no `Jarvis` text. Those citations are stale, and the owners should not change lines based on them.

### 2e. Documentation (owner: Docs)

| File:line | Current | Proposed |
| --- | --- | --- |
| `docs/ui-guide.md:1` | Title `Jarvis Desktop — UI guide` | `Desktop Companion — UI guide` |
| `docs/implementation-status.md:3` | `Working name: Jarvis Desktop.` | Update the line to the current status, for example `Working name: Desktop Companion.` |
| `docs/architecture.md:1` | Title `Architecture — Jarvis Desktop (seeded Electron + React)` | `Architecture — Desktop Companion (seeded Electron + React)` |
| `docs/architecture.md:99` and `:307` | `%APPDATA%\Jarvis Desktop` | Stale against `productName` (section 4). Correct only after the data-folder decision. |
| `docs/architecture.md:204` | `the Jarvis window itself` | `the Desktop Companion window itself` |
| `docs/acceptance.md:65` | `… or the Jarvis window are blocked …` | `… or the Desktop Companion window are blocked …` |

Docs are not user-facing product text, but they are the spec. Fix them in the same change as the code, so the spec and the product agree.

Count of user-visible strings: 8 renderer + 7 Electron + 1 file name + 1 backend message = **17**. That matches the number in `docs/resume-integration-plan.md` X8, but the list of files in X8 is not the same as the current list (see section 5).

## 3. Technical identifiers to keep

These are not user-facing text. Renaming them breaks compatibility, stored data, the native contract, or the build. Keep them as they are.

| Identifier | Where | Why it stays |
| --- | --- | --- |
| `window.jarvis`, `JarvisAPI`, `declare global … jarvis` | `src/shared/contracts.ts`, `electron/preload.ts:39`, `src/main.tsx`, `src/preview.ts` | Shared contract and preload bridge. |
| IPC channel prefix `jarvis:` and `jarvis:activity` | `electron/channels.ts:23-24` | Channel names in the contract and handlers. |
| `format: 'jarvis-export'` | `electron/services/store.ts:289,300`, `electron/backend.ts:226`, `:224` | File-format id inside existing exports. |
| Temp audio name `jarvis-<id>.wav` | `electron/services/speech.ts:85`, `native/transcribe.ps1:7` (regex `^jarvis-[0-9a-f-]+\.wav$`) | The native helper rejects other names. Must match. |
| `JARVIS_TEST_MODE`, `JARVIS_NATIVE_TESTS` | `electron/main.ts:14`, `scripts/smoke.cjs`, `docs/acceptance.md:5` | Env vars used by tests and scripts. |
| localStorage keys `jarvis.ui.` and `jarvis.preview.state.v1` | `src/ui/prefs.ts:7`, `src/preview.ts:13`, `tests/ui.test.mjs:187` | Existing user preferences and preview data would be lost. |
| Test fixture dir prefixes `jarvis-smoke-`, `jarvis-test-` | `electron/ipcCore.ts:60`, `scripts/smoke.cjs:3` | Test-mode guard only allows these prefixes. `desktop-companion-test-` is already accepted there. Keep all three. |
| `in.local.jarvis.desktop` | `package.json` `build.appId`, `electron/main.ts:163` (`setAppUserModelId`) | Windows app identity. Changing it changes taskbar grouping, notification identity and the installer's uninstall key. Keep it unless the release owner decides otherwise. |
| `package.json` `name: "jarvis-desktop"` | `package.json:2` | Internal package name. Not shown to users. |
| Native helper names: `Jarvis.Win32`, `Read-JarvisInput`, `Write-JarvisResult`, `Add-JarvisWin32`, `Test-JarvisTarget`, and the `namespace Jarvis` block | `native/*.ps1` | Internal PowerShell identifiers. Also contain code comments such as `Shared helpers for Jarvis native scripts` in `native/common.ps1:1`. Comments are not visible, so they can stay. |
| Code comments and type names mentioning Jarvis | `electron/backend.ts`, `electron/ipc.ts`, `electron/preload.ts`, `src/ui/audio.ts`, `src/preview.ts` | Not visible. Rename only in a later cleanup. |
| Historical wording in the review documents | `docs/product-interaction-review.md`, `docs/native-security-review.md`, `docs/resume-integration-plan.md` | Quotes of the old name in findings are intentional. |

## 4. Decisions for root

1. **The data-folder migration risk is already live.** `package.json` `productName` is `Desktop Companion`. Electron derives `app.getPath('userData')` from the product name, so the profile folder is now expected to be `%APPDATA%\Desktop Companion`, not `%APPDATA%\Jarvis Desktop`. No migration code was found in `electron/` (searched `migrat`, `userData`, `setName`, `getName`), and `docs/architecture.md:99` still documents `Jarvis Desktop`. This is an inference from Electron's documented behavior. It was not checked on the build machine. Root should confirm it there, then choose either a one-time copy-on-first-run migration or a pinned `userData` path. The plan's D1 is still open, and this audit shows the risk is current, not future.
2. **Export default file name (F1).** Recommend changing it to `desktop-companion-export-<stamp>.json`. It is visible but has no compatibility impact, because the format id is separate.
3. **App identity (`appId`, `setAppUserModelId`).** Recommend keeping `in.local.jarvis.desktop` for this release. It is invisible to users except through taskbar grouping and the uninstall entry. Changing it is a release decision.
4. **Short brand mark (R1, R2).** The product review asks for "Desktop Companion" everywhere, but a sidebar mark in capitals is a design choice. Root or design should decide between the full name and an approved short mark.

## 5. Corrections to the existing review documents

These are not edits made in this audit. Owners of the listed documents should update them.

- `docs/product-interaction-review.md` P0-8 cites `actions.ts:88`, `policy.ts:139`, `store.ts:62,111` for messages. In this checkpoint, the only backend message is `actions.ts:97`. `policy.ts` and `store.ts` have no `Jarvis` text. P0-8 also cites `Onboarding.tsx:49,70,129,133,146` and `Settings.tsx:272,276`; those lines are correct.
- `docs/resume-integration-plan.md` X8 says `index.html` `<title>` and `package.json productName` still need changing. Both are already correct. The file list in X8 (`policy.ts`, `store.ts`, `src/ui/focus.tsx`, `Developer.tsx`) does not match the current hits: `focus.tsx` and `Developer.tsx` contain no `Jarvis` text in this checkpoint.

## 6. Test that should guard this (not added here)

The product review asks for a visible-text scanner. It is not written yet, and this audit does not write it, because the assigned path is this document only. A proposal for the owner of `tests/`:

- Scan the renderer files in section 2a, the Electron files in section 2b, and the file name in 2c.
- Fail on `/\bjarvis\b/i`.
- Allow the identifiers in section 3 through an explicit list, so every exception is visible in review.
- Limitation: a regex over TypeScript cannot tell visible strings from identifiers reliably. The allowlist has to stay explicit. A second option is to render each screen in the test and check its text, but that needs the UI test harness to cover the strings in question.

## 7. Validation of this document

- Every `file:line` above was re-read from the worktree with `sed -n` and matched to the expected text. Line numbers that differ from the review documents are listed in section 5.
- The total count (17 user-visible strings) was checked against the search results in section 2.
- No code, test, package or contract file was changed. Nothing was run that changes the app. No tests were run, because no code changed; there is no test in this document's scope to run.

## 8. Limitations

- The runtime title behavior of the BrowserWindow (E4) and the userData folder (section 4.1) were not observed in a running Electron app. They are inferences from the code and Electron's documented behavior.
- Only the checkpoint branch was checked. Other workers' uncommitted edits were not visible.
- Visible strings produced at runtime by the model or by user data (for example, a chat reply that says "Jarvis") cannot be found by a static search. Those are outside this audit.
