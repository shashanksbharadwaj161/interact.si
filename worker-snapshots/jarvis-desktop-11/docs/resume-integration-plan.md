# Resume integration plan — Desktop Companion (first personal release)

14 October 2026. Scope: the integrated tree at commit `c9c3f8a` (frontend + native backend + Electron shell). This document is the dependency-ordered plan for taking that tree to the first personal release defined in `docs/acceptance.md`, with the gaps found by reading every source file against `src/shared/contracts.ts`, `docs/architecture.md`, and `docs/product-roadmap.md`.

Naming: the app has no final name. User-facing text should say **Desktop Companion**. Technical identifiers stay as they are for compatibility: `window.jarvis`, `jarvis:*` IPC channels, `JarvisAPI`, `jarvis-export` file format, the `jarvis-<uuid>.wav` temp name that `native/transcribe.ps1` enforces, and the `userData` folder name derived from `package.json` `productName` (see decision D1).

Item codes below (A1, C2, G7, …) refer to `docs/acceptance.md`. Roadmap numbers (11, 43, 81, …) refer to `docs/product-roadmap.md`. Gates G1–G8 refer to `docs/architecture.md` §10.

## 1. Verified baseline

Evidence recorded by root on 13–14 October on the build machine (Windows 11 x64, Node 22.15.1, Windows PowerShell 5.1):

| Check | Result | Covers |
|---|---|---|
| `npm run typecheck`, `vite build`, `scripts/build-main.mjs` | pass | A1 (build half) |
| `npm test` (`tests/ui.test.mjs`) | 10/10 pass | renderer helpers, roadmap integrity, preview bridge |
| `scripts/smoke.cjs` under Electron, temp `userData`, `JARVIS_TEST_MODE=1` | pass: offline default, note/task/capsule CRUD persisted, empty-capsule restore, key status, capability report | C1, J1 (happy path), B1 (window options exist) |
| Live local model through Ollama (`docs/local-ai-benchmark.json`, `qwen3.5:2b`): "7 + 5" → "12" | pass | E1 (manual), partial G2 |
| `npm run package:win` → NSIS x64 installer in `release/` | installer produced | M1 (artifact exists; install/uninstall behaviour not yet checked) |

Independently re-checked in this worktree on 14 October with `npm ci --ignore-scripts` (no Electron binary): typecheck clean, 10/10 tests, renderer bundle 462 kB JS / 44 kB CSS, `dist-electron/main.cjs` and `preload.cjs` built.

What this baseline does **not** show: any backend unit test, any native-script test, network denial under a firewall, install/uninstall behaviour, idle footprint, or a single keyboard-only or screen-reader pass. Those are the work below.

## 2. What exists today (per layer, honest)

**Contract** (`src/shared/contracts.ts`): 23 methods + `onActivity`. Unchanged since seed. Known gaps listed in architecture §4 still stand (no streaming, no cancel, no model list/unload, no capability flags, no load status, no app version/data path).

**Electron main** (`electron/main.ts`, 212 lines): single instance, tray, `Ctrl+Alt+J` hotkey, hardened session (`webRequest` allow-list, spellchecker off, mic-only permission handler), `will-navigate` block, `setWindowOpenHandler` deny-all, render-crash reload-then-safe-page, `LaunchGuard` two-strike safe launch, daily retention timer, backup on quit.

**Backend** (`electron/backend.ts` + `services/*`, 2,100 lines, no Electron imports): atomic store with backups/rotation/recovery/retention/import/export; validation of every IPC payload; `netGuard` as the single egress path; Ollama/Anthropic chat with honest `source:'system'` failures and no fallback; DPAPI key vault through `native/dpapi.ps1`; preview → approve → execute action service with single-use 60 s previews, re-validation, rate limit, self-window and elevation blocks; capsule restore with window matching; capability probes cached 30 s.

**Native** (`native/*.ps1`, 378 lines): one `common.ps1` with original P/Invoke (`EnumWindows`, `SetWindowPos`, `SendInput` unicode, token elevation check, DWM cloaking filter), plus nine small scripts. JSON on stdin, one JSON line on stdout, `-File` execution from `app.asar.unpacked/native`.

**Renderer** (`src/*`, ~4,900 lines): onboarding wizard, Home, Assistant (chat, push-to-talk, read-aloud), Companion, Capsules, Notes, Tasks + focus timer, Computer (action preview/approval), System status, Settings (4 tabs), Feature Lab (140-scope honest status), Developer. Browser preview bridge when `window.jarvis` is absent.

**Tests**: `tests/ui.test.mjs` only. Zero tests for `electron/`. `scripts/smoke.cjs` is not wired into `npm test`.

## 3. Critical gaps (ranked by what they block)

| # | Gap | Evidence | Blocks | Fix owner (path) |
|---|---|---|---|---|
| X1 | **No backend tests.** 31 acceptance items are marked `[U]`; none has a test. The backend was built for injection (`BackendEnv` test seams, `StoreFs`, `NativeAdapter`, `FsLike`, `fetchImpl`) but nothing exercises them. | `tests/` contains one file; `electron/backend.ts:33-40` seams unused | every `[U]` item; any refactor | `tests/**` (new owner) |
| X2 | **`type-text` and `click` cannot be used from the app.** Policy requires the target window to be foreground at preview time, but the Desktop Companion window is foreground while the user clicks "Preview". With no target, the foreground window is the app itself and is refused as a self window. With a title target, the refusal is "not in the foreground; run a focus action first", and running focus then returning to the app re-creates the same state. | `electron/services/policy.ts:142-145`, `actions.ts:121,146,152`, `native/type-text.ps1:9-11` | 23 (dictation insertion), G7, F5, roadmap 81 for text | `electron/services/actions.ts`, `policy.ts`, `native/type-text.ps1`, `native/click.ps1` |
| X3 | **Reminders (52, I2) do not exist.** No `Notification`, no due-time timer anywhere in `electron/` or `src/`. `Task.due` is stored and bucketed only. | grep `Notification` → no hits | I2, D6 (notification preference), roadmap 52 | `electron/main.ts` (+ a small `services/reminders.ts`) |
| X4 | **Recovery, read-only and safe-launch states are invisible to the user.** Main writes `Activity{kind:'recovery'}` and the store sets `readOnly`, but no screen shows a banner; in read-only mode every write fails with a toast and no explanation. | `electron/main.ts:179-180`, `store.ts:109-112,158`; grep `recovery` in `src/components` → none | J2, J6, J7 (user-visible half), D7 | `src/components/App.tsx`, `Home.tsx` |
| X5 | **Window geometry can be restored but never captured.** `Capsule.windows` is only shown read-only; nothing in the UI calls `list-windows` to save rects. | `src/components/Capsules.tsx:328-330`; `docs/ui-guide.md` limitation | 43, H5 | `src/components/Capsules.tsx` |
| X6 | **External links are dead in Electron.** The Developer page renders `<a target="_blank">` for Control Room; `setWindowOpenHandler` denies everything. Architecture says `shell.openExternal` only via approved actions. | `src/components/Developer.tsx:68`, `electron/main.ts:98` | B3 consistency, Developer page usefulness | decision D3 |
| X7 | **UI accepts endpoints the backend always rejects.** Settings and Onboarding allow `https://` and remote hosts with a warning; `validateLocalEndpoint` rejects anything that is not `http://` loopback, in both modes. | `electron/services/validation.ts:81-93`, `src/components/Settings.tsx:60-62`, `Onboarding.tsx:21-23` | C3 UX, D1 | `src/components/Settings.tsx`, `Onboarding.tsx` |
| X8 | **Naming.** User-facing "Jarvis" appears in 17 places across `electron/main.ts`, `services/actions.ts`, `policy.ts`, `store.ts`, `src/components/App.tsx`, `Onboarding.tsx`, `Settings.tsx`, `Developer.tsx`, `src/ui/focus.tsx`, and `index.html` `<title>`. `package.json` `productName` is root-owned. | grep `Jarvis` | release naming, D1 | each file's owner; `package.json` root (decision D1) |
| X9 | **Settings search (6, D4), help/diagnostics page (10, D7), focus-session history (53, I3) are not built.** D7 and I3 also need contract additions (§7). | `docs/ui-guide.md` limitations; `src/ui/focus.tsx:31-34` | D4, D7, I3 | `src/components/Settings.tsx`, `Developer.tsx`; contract owner |
| X10 | **Mic permission is granted whenever the page asks, not only while push-to-talk is held.** Acceptable for a personal release, but B4 as written will fail. | `electron/main.ts:132-137` | B4 | `electron/main.ts` or reword B4 (decision D4) |
| X11 | **Static-scan rule A2 would false-positive today.** `services/chat.ts` and `system.ts` receive the guarded function as a parameter named `fetch`, so a naive `fetch(` scan hits them. | `chat.ts:46,63,128`; `system.ts:29` | A2 test | rename parameter to `guardedFetch` in `chat.ts`, `system.ts` (backend owner), then strict scan |
| X12 | **Secrets use `native/dpapi.ps1`, not Electron `safeStorage`.** Same DPAPI scope, but every key reveal spawns PowerShell (one per cloud chat) and K1/K2 wording references `safeStorage`. Works; needs a decision, not a rewrite. | `electron/services/secrets.ts` | K1, K2 wording | decision D2 |

Smaller findings to fold into the phases: `before-quit` prevents default and only exits after `dispose()` resolves, so a hung backup blocks quit (`main.ts:200-207`); `LaunchGuard.end()` is skipped when `backend` is null at quit, so a failed boot counts as an unclean exit (`main.ts:202`); `chat` user messages carry `source:'cloud'|'local'` which the UI never labels (fine, note only); default `localModel` is `llama3.2:3b` but the only benchmarked model is `qwen3.5:2b` (`validation.ts:29`, `docs/local-ai-benchmark.json`).

## 4. Dependency-ordered plan

Each phase lists what it depends on, who edits what, the exact tests it must add, and its exit gate. Nothing in a later phase starts until the exit gate of the phase it depends on is green and recorded by root.

### P0 — Test harness and static gates (depends on: nothing)

Owner paths: `tests/**`, `package.json` `test` script (root).

1. Add `tests/_bundle.mjs`: bundles a TypeScript entry with esbuild in memory (same technique as `tests/ui.test.mjs:21-56`), `platform:'node'`, `external:['electron']`, returns the module. Used by every backend test.
2. Add `tests/static.test.mjs`:
   - **A2** `electron/ egress only through netGuard`: read every file under `electron/`; assert no `node:http`, `node:https`, `undici`, `electron` `net.` import or `net.request`, `autoUpdater`, `crashReporter`; assert the bare identifier `fetch(` appears only in `services/netGuard.ts` (requires X11 rename first; until then assert the parameter form `fetch: GuardedFetch` on the hit files).
   - **A3** `no key-shaped strings`: scan `src/`, `electron/`, `native/`, `tests/`, `docs/`, `scripts/` for `/sk-ant-[A-Za-z0-9_-]{10,}/`; expect none.
   - **A4** `renderer has no Node or Electron imports`: scan `src/` for `from 'electron'`, `from 'node:`, `require(`; expect none.
   - **B1** `BrowserWindow hardening`: regex over `electron/main.ts` for `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, `setWindowOpenHandler`, `setSpellCheckerEnabled(false)`.
3. Add `tests/ipc.test.mjs` for `electron/ipcCore.ts`:
   - **B2** rejects non-app sender URL, rejects sub-frame sender, rejects unknown method, rejects arity overflow, redacts `C:\Users\<name>` from error text, bounds error length to 400.
   - `isTrustedUrl` accepts the packaged `file://…/dist/index.html` case-insensitively and the dev origin only when provided.
4. Wire `npm test` to `node --test tests/*.test.mjs` (already) and add `npm run smoke` = `electron scripts/smoke.cjs` (root edits `package.json`).

Exit gate: `npm test` ≥ 20 tests green; A2/A3/A4/B1/B2 ticked in `docs/acceptance.md` by root.

### P1 — Backend unit coverage of existing code (depends on: P0)

Owner paths: `tests/**`; bug fixes go back to the backend owner.

Build one `tests/_backend.mjs` fixture: in-memory `StoreFs`, `FsLike` with a fake tree, a scripted `NativeAdapter` (returns fixed `WindowInfo[]`, records calls, never touches the desktop), fake `fetchImpl`, fixed `now`/`newId`, a `Dialogs` stub. `createBackend` from `electron/backend.ts` accepts all of these today.

| Test file | Cases (acceptance id → assertion) |
|---|---|
| `tests/store.test.mjs` | **J1** write fails after tmp, before rename → `state.json` unchanged, in-memory state rolled back, `mutate` rejects. **J2** corrupt `state.json` → quarantined as `state.corrupt-*.json`, newest valid `backups/state-*.json` loaded, `Activity{kind:'recovery'}` present. **J3** with 25 backups across 10 days, `rotate()` keeps newest 10 + one per day for 7 days; `pre-import-*` keeps 5. **J4** retention drops chat/activity older than `retainDays`, never notes/tasks/capsules. **J5** `exportDocument()` → `importDocument()` in a fresh store yields deep-equal `AppState`; export contains no `cloud-key`; invalid JSON, wrong `format`, newer `schemaVersion`, and bad entity all throw and change nothing; a `pre-import-*` backup exists after success. **J7** `schemaVersion: 2` → `readOnly`, `warning`, `mutate` throws. **C1** fresh store → `mode:'offline'`, `onboarded:false`. |
| `tests/validation.test.mjs` | `mergeSettings` rejects unknown keys, bad enums, `retainDays` 0/3651, drive-root `allowedRoots`, non-`.exe` approved apps; normalizes case-duplicates. `buildTask({due:''})` clears the date (UI relies on it, `docs/ui-guide.md`). `validateAudio` accepts RIFF bytes and Int16 arrays, rejects > 480,000 samples, non-PCM. `validateActionRequest` rejects unknown fields, control chars, `text` > 2,000. |
| `tests/netGuard.test.mjs` | **C2** offline: `http://127.0.0.1:11434` allowed for `ollama`; `https://api.anthropic.com`, `http://192.168.1.5`, `http://example.com`, `http://127.0.0.1.evil.com` denied with reasons; audit callback called for denials. **C4** online + no key → cloud denied; online + key → exact origin allowed only for `cloud-chat`; `https://api.anthropic.com.evil` denied; credentials in URL denied. `redirect:'error'` passed to `fetchImpl`. |
| `tests/chat.test.mjs` | **C7/E2** offline, `fetchImpl` throws `ECONNREFUSED` → reply `source:'system'`, text starts "Local model unavailable", no cloud call, both messages persisted. 404 → "is not installed". Online + key, `fetchImpl` 500 → `source:'system'` "Cloud model unavailable", no Ollama call. **K5** online + key → request to `<override origin>/v1/messages` with `x-api-key` header exactly once, `anthropic-version` set, body has `model`/`max_tokens`/`messages`; reply `source:'cloud'`. `buildHistory` merges adjacent roles, drops leading assistant, respects 8,000-char budget, skips `system` messages. `probeLocalModel` → unavailable reasons for not running / HTTP error / model missing (`name` vs `name:latest`). |
| `tests/secrets.test.mjs` | **K1** `setCloudKey` writes only what the fake `dpapi('protect')` returned; `cloudKeyStatus` returns `{configured}` only; no method on the `Backend` object returns the plaintext (enumerate `JarvisAPI` methods and assert none resolves to the key). **K2** `dpapi` throws → `setCloudKey` rejects with reason, no file written. **K4** `deleteCloudKey` removes the file; status false. Key length/charset validation. |
| `tests/actions.test.mjs` | **G1** `previewAction` makes no native call except `listWindows`; `executeAction` with unknown id, expired id (advance `now` 61 s), reused id → throws; `approved:false` → `{executed:false}` and a "Declined" activity. **G2** `launch` allowed only for `approvedApps` entry or file in `allowedRoots`; `open-url` allows `http`, `https`, `mailto` and rejects `file:`, `javascript:`, credentials. `click` behaviour per decision D5 (today it is allowed when foreground; the plan expects `allowed:false` "Experimental — not enabled" until G4). **G3** `..`, mixed case, symlinked root resolved through `FsLike.realpath`, ADS `file.txt:stream`, device path `\\?\` → rejected. **G4** approve `launch notepad.exe`, remove it from `approvedApps`, execute → refused "Policy changed". **G9** 31st execution in 60 s → rate limited; `safeLaunch()` true → every preview `allowed:false`. **G10** activity for executed/denied/declined has no typed text. Self-PID window → refused; `elevated:1` and `-1` → refused. |
| `tests/runner.test.mjs` | **G11** fake `execFileImpl`: `buildArgs` is exactly `['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',<path>]` and user input never appears in argv; timeout (`killed:true`) → `NativeError('timeout')`; `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` → `'output-too-large'`; `ENOENT` → `'unavailable'`; last stdout line parsed, non-JSON rejected; concurrency 2 queues the third call; `killAll()` kills tracked children; input > 256 KB rejected; `app.asar` → `app.asar.unpacked` mapping. |
| `tests/speech.test.mjs` | **F2** `speak` text passed to the adapter as a value (never argv, covered by runner test), > 4,000 chars rejected before any native call; second `speak` aborts the first (`cancelled`). **F3 (unit half)** `transcribe` writes `jarvis-<id>.wav` into `tmpDir`, calls adapter with that path, deletes the file in `finally` even when the adapter throws; no recognizer → `{text:'', reason}` without writing a file. Capabilities: no voices → `tts` unavailable with reason. |
| `tests/capsules.test.mjs` | **H4** missing file, unapproved app, outside-root folder, `javascript:` URL → each in `failed[]` with reason, `openItem` never reaches `shell`. Valid items → `opened[]` in order. Windows: matched by process then title, moved via adapter; unmatched after `windowWaitMs` → `failed` "No matching window appeared in time"; self/elevated → failed with policy reason. Restore activity summary counts. |
| `tests/lifecycle.test.mjs` | **J6 (unit half)** `.running` present twice → `safe:true`; clean `end()` resets the counter. |
| `tests/system.test.mjs` | capability list contains `local-llm`, `tts`, `stt`, `ui-automation`, `cloud`, `secure-storage`, `ocr`, `vision`; `ocr`/`vision` always unavailable with "Not implemented"; cache invalidated by `saveSettings`; non-win32 platform → `ui-automation` unavailable "Requires Windows". |

Exit gate: ≥ 90 backend tests green; every `[U]` item in sections C, G, J, K and F2/H4/J6-unit ticked; bugs found are fixed by the backend owner and re-tested.

### P2 — Electron runtime verification (depends on: P0; parallel with P1)

Owner paths: `scripts/smoke.cjs`, `tests/smoke.test.mjs` (gated), `electron/main.ts` for fixes.

1. Full `npm ci` (with scripts, downloads the Electron binary once) on the build machine — A1 first half.
2. Extend `scripts/smoke.cjs` (still `JARVIS_TEST_MODE=1`, temp `userData`, no desktop input):
   - **B1** assert `win.webContents.getLastWebPreferences()` has `contextIsolation`, `sandbox`, `webSecurity` true and `nodeIntegration` false.
   - **B3** `executeJavaScript('window.open("https://example.com")')` returns `null`; `location.href = "https://example.com"` leaves `webContents.getURL()` on `dist/index.html`.
   - **B4** `navigator.permissions.query({name:'camera'})` not granted; `getUserMedia({video:true})` rejects.
   - **C6 (app-level)** register `session.defaultSession.webRequest.onBeforeRequest` counter before load; after the full smoke, assert zero non-`file:` requests.
   - **E2** with no Ollama (point `localEndpoint` at an unused loopback port) `chat('hi')` → `source:'system'`.
   - **J2** write a corrupt `state.json` into the temp `userData` before launch → first `getState()` returns defaults, activity has `kind:'recovery'`.
3. `tests/smoke.test.mjs`: skips unless `JARVIS_ELECTRON_TESTS=1`; spawns `npx electron scripts/smoke.cjs` and asserts `ELECTRON_SMOKE_PASS`.
4. Fix: `before-quit` wraps `dispose()` in a 5 s timeout, then `app.exit(0)`; call `guard.end()` even when `backend` is null (both in `electron/main.ts`).

Exit gate: `JARVIS_ELECTRON_TESTS=1 npm test` green on the build machine; B1–B5, C1, E2, J2 ticked.

### P3 — First-release functional gaps without contract change (depends on: P1 for backend items, P0 for UI items)

Each item names its owner path and the test that proves it.

| Item | Change | Test |
|---|---|---|
| **X2 foreground deadlock** | In `policy.ts` `checkWindowPolicy`, for `type-text`/`click` require the window to be *focusable* (exists, not minimized, not elevated, not self) instead of *foreground*. In `actions.ts` `perform('type-text')` first calls `native.focusWindow`, waits up to 1.5 s for `listWindows()` to report `foreground:true` for that `hwnd`, then calls `typeText`; on failure returns `{executed:false, reason:'Could not bring the window to the front'}`. `native/type-text.ps1` keeps its own foreground re-check (unchanged). The preview summary becomes `Focus "…" then type N characters`. With no target, refuse: "Choose a window from List windows (hwnd:…)". | `tests/actions.test.mjs`: preview `type-text` with target while a self-PID window is foreground → `allowed:true`; execute → adapter call order is `focusWindow`, `listWindows`, `typeText`; `focusWindow` returns `focused:false` → no `typeText` call. G7 integration test (P4) remains the end-to-end proof. |
| **X3 reminders** | New `electron/services/reminders.ts` (no Electron import): given `tasks` and `now`, returns the next due open task and the delay; main keeps one `setTimeout` (unref'd) to the next due item, re-armed on every `saveTask`/`deleteTask`/import/`getState` change through `store.onActivity` or an explicit hook in `backend.ts`. Main shows `new Notification({title: task.title, body: 'Due now'})` and writes `Activity{kind:'reminder'}`. Fired reminders tracked in memory per `task.id + due` to avoid repeats. No `setInterval`. | `tests/reminders.test.mjs`: picks the earliest open due task, ignores done/undated, delay clamps to ≥ 0 and ≤ 2^31−1, does not re-fire the same `id+due`. I2 manual check: tray-hidden, fires within ±60 s. |
| **X4 recovery/read-only/safe-launch banner** | `src/components/App.tsx` `Gate`/`Shell`: show a dismissible `Notice` when `state.activity` contains a `kind:'recovery'` entry newer than page load, with the entry's summary; keep it until dismissed. Read-only: the store's `warning` is already emitted as `recovery`; the banner text must say writes are disabled. Safe launch: banner names the restart action; "restore backup" is the existing Import flow (contract has no restore-from-backup). | Component test is out of scope (no DOM runner); covered by `scripts/smoke.cjs` J2 (banner source data) and manual J6. |
| **X5 capture window positions** | `Capsules.tsx`: button "Capture open windows…" → `previewAction({type:'list-windows'})` → `executeAction(id,true)` → table of windows (title, process, rect) with checkboxes → save selected into `capsule.windows` via `saveCapsule`. Self-window and `protected:true` rows disabled. | Preview bridge: `list-windows` returns `allowed:false`, so the button shows the reason. H5 manual/integration in P4. |
| **X7 endpoint validation** | `Settings.tsx`, `Onboarding.tsx`: block Save/Next when the endpoint is not `http://` loopback; the hint says why (matches backend). | `tests/ui.test.mjs`: `parseHttpUrl` + `isLoopbackHost` already tested; add a `validEndpoint()` helper test. |
| **X8 naming** | Replace user-visible "Jarvis"/"JARVIS" with "Desktop Companion" in: `electron/main.ts` (title, tray tooltip, tray menu, safe page, error box, dialog filter names), `services/actions.ts:88`, `policy.ts:139`, `store.ts:111,261` (keep `format:'jarvis-export'`), `src/components/App.tsx:228`, `Onboarding.tsx:49,70,129,133,146`, `Settings.tsx:272,276`, `Developer.tsx:20`, `src/ui/focus.tsx:64`, `index.html` `<title>`. Do **not** touch IPC names, `window.jarvis`, `jarvis-export`, `jarvis-<uuid>.wav`, or the entropy string in `native/dpapi.ps1` (changing it would make stored keys undecryptable). | `tests/static.test.mjs`: assert no `/\bJarvis\b/` in `src/components`, `src/ui`, `index.html`, and in string literals of `electron/main.ts`; allow identifiers (`JarvisAPI`, `jarvis:`). |
| **X9 settings search** | `Settings.tsx`: a filter input above the tabs that matches each field's label/description and auto-switches to the tab holding the first hit. | `tests/ui.test.mjs`: a pure `matchSettings(query, index)` helper. D4 manual. |
| **X6/X10/X12** | Per decisions D2–D4 (§8). | — |
| Default model | `validation.ts:29` default `localModel` → the benchmarked `qwen3.5:2b`, or keep `llama3.2:3b` and add it to the benchmark. Either way `docs/local-ai-benchmark.json` must cover the shipped default. | G2 evidence file updated. |

Exit gate: P1 suite still green plus the new tests; D1–D4 (UI), E2–E4 (honest state), H1–H2, I1, I4 manual-ticked by root in the Electron build.

### P4 — Native integration tests, opt-in (depends on: P3 X2)

Owner path: `tests/native.test.mjs`, gated by `JARVIS_NATIVE_TESTS=1`. Never run in CI or by workers; root or the human runs it on the reference machine with no other work in progress, because it moves and types into a real Notepad window.

Fixture: spawn `notepad.exe`, wait for its window in `list-windows`, run the cases, kill the process in `after`.

- **G5** `list-windows` returns the Notepad window with `process:'notepad.exe'`, non-empty title, positive rect, `elevated:0`.
- **G6** `focus` → `focused:true` and `foreground:true` on re-list; `move-window` to `(100,100,800,600)` → re-listed rect within ±8 px; `move-window` to `(-5000,-5000,…)` → `clamped:true` and rect inside the virtual screen.
- **G7** `type-text` "héllo wörld — 日本語\nline2" → Notepad text (read back via UI Automation `ValuePattern` on the edit control in the test, not through the app) equals the input; `typed` equals character count.
- **G8** against an elevated window (tester starts an elevated `notepad.exe` manually when prompted; skipped otherwise) → `allowed:false` "elevated or protected".
- **F1** `speak('test')` with an installed voice → `{ok:true}`; voice `'No Such Voice'` → `{ok:false, reason}` mentioning the name.
- **F3** `transcribe` of `tests/fixtures/clear-english-16k.wav` (a short original recording committed by the test owner) → non-empty text; a 1 s silent WAV → `{text:'', reason:'No speech was recognized'}`; the temp file is gone afterwards.
- **H3/H5** capsule with a file inside a temp `allowedRoot`, a folder, a `https://` URL, `notepad.exe` in `approvedApps`, plus a saved Notepad rect → `opened` has four entries and the window rect; a missing file and `calc.exe` (unapproved) → in `failed`.
- **G11 (process half)** after the suite, `tasklist /FI "IMAGENAME eq powershell.exe"` shows no children of the test process.

Exit gate: all cases pass at 100% DPI and at 150% DPI (Windows display scaling changed by the tester, then re-run); results pasted into `docs/acceptance.md` with date and machine.

### P5 — Offline denial and installer gates (depends on: P2, P3; P4 for the voice/action parts of C5)

Manual procedures, recorded by root. No code except fixes found.

**C5/C6 network denial**
1. Build the installer (`npm run package:win`), install per-user on a clean Windows 11 x64 VM or the reference laptop with a fresh `%APPDATA%`.
2. Tester adds a Windows Firewall outbound block rule for the installed `.exe` (or disconnects the machine). The app never changes firewall settings.
3. Run: first-run wizard, chat with Ollama on loopback, read-aloud, push-to-talk, capsule restore of a local file, export/import. Expect no network error dialogs; expect honest `source:'system'` replies only when Ollama is stopped.
4. During 10 minutes of use, `netstat -b -n` (elevated prompt) filtered to the app's PIDs shows only `127.0.0.1`/`::1` connections. Record the output.
5. Switch to online mode without a key, send a chat → `source:'system'` "No cloud API key is configured"; still no external connection in `netstat`.

**M1–M6 installer and footprint**
- M1: installer offers directory choice, installs without UAC, creates Start menu and desktop shortcuts.
- M2: with the machine offline, install and first run work; Ollama absent → capability "Ollama is not running at http://127.0.0.1:11434", no crash.
- M3: uninstall removes program files and shortcuts; `%APPDATA%\<productName>` remains; the help page (D7, after contract item C7.5) says so.
- M4: SmartScreen warning text captured in `docs/acceptance.md` as expected behaviour (G8 signing is later).
- M5: hide to tray, wait 5 min, Task Manager: average CPU ≤ 0.5%, working set of all app processes ≤ 250 MB, zero `powershell.exe` children. Ollama measured separately.
- M6: cold start to interactive Home ≤ 3 s on the reference laptop (stopwatch, three runs, median).

Exit gate: C5, C6, M1–M6 ticked with recorded numbers.

### P6 — Contract-dependent items (depends on: contract owner decision; can run alongside P3–P5)

These are the architecture §4 gaps plus three found here. Proposed signatures so the contract owner can accept or reject each; no worker adds undeclared channels (N4).

| Need | Proposed addition to `JarvisAPI` | Unblocks |
|---|---|---|
| Streaming + cancel (21, E4) | `onChatDelta(handler:(d:{id:string;text:string;done:boolean})=>void):()=>void; cancelChat():Promise<void>` | E4 "cancel", true streaming |
| Unload local model (E5) | `unloadLocalModel():Promise<{ok:boolean;reason?:string}>` → Ollama `keep_alive:0` | E5, M5 memory |
| Local model list (14, 17) | `listLocalModels():Promise<{names:string[];reason?:string}>` | E3 guidance, model picker |
| Voice list | `listVoices():Promise<string[]>` | Settings voice dropdown, F1 UX |
| Focus session record (53, I3) | `recordFocusSession(s:{startedAt:string;endedAt:string;taskId?:string}):Promise<AppState>` writing `Activity{kind:'focus'}` | I3 |
| Diagnostics (10, D7, M3) | extend `SystemInfo` with `appVersion:string; dataDir:string; safeLaunch:boolean; readOnly:boolean` | D7, X4 cleanly |
| Restore from backup (J6) | `listBackups():Promise<{name:string;at:string}[]>; restoreBackup(name:string):Promise<AppState>` | J6 "restore backup" option |
| Experimental flags (G4, D5) | `Settings.experimental:{click:boolean}` | honest `click` gating |

Until accepted, each feature stays visibly "pending contract" in Feature Lab (`src/ui/roadmap.ts` notes) and the acceptance item is marked *gated*.

## 5. Phase dependency graph

```
P0 harness ──► P1 backend tests ──► P3 (backend items X2, reminders) ──► P4 native (opt-in) ──► P5 offline + installer
   │                                   ▲
   └──► P2 Electron smoke ─────────────┘        P6 contract items run alongside P3–P5 once the owner decides
   └──► P3 UI items (X4, X5, X7, X8, X9) may start immediately after P0
```

Critical path: P0 → P1 → P3-X2 → P4 → P5. Everything on it is backend or native work plus the opt-in desktop run; UI items are off the critical path and can be absorbed in parallel.

## 6. Acceptance coverage after this plan

| Section | Now | After P0–P5 | Needs P6 (contract) |
|---|---|---|---|
| A build/hygiene | A1 partial (root) | A1–A5 (A5 by manual lockfile licence review) | — |
| B security | B1 partial | B1–B5 | — |
| C offline | C1 (smoke) | C1–C7 | — |
| D onboarding/app | D1–D3 by inspection only | D1–D6 | D7 (version/data dir) |
| E local AI | E1 (root, live) | E1–E3; E4 without cancel | E4 cancel, E5 |
| F voice | — | F1–F6 (F4–F6 manual) | — |
| G actions | — | G1–G11 (G8 partial, elevated case tester-dependent) | click flag for G2 "Experimental" wording |
| H capsules | H1–H2 by inspection | H1–H5 | — |
| I productivity | I1, I4 by inspection | I1, I2, I4 | I3 |
| J persistence | J1 happy path (smoke) | J1–J5, J7; J6 partial | J6 restore option |
| K key storage | — | K1–K5 | — |
| L visuals | L1 by inspection | L1, L2 (manual) | L3 stays gated on G1 |
| M installer | M1 artifact exists | M1–M6 | — |
| N honest status | N1–N3 by inspection | N1–N4 re-verified after X8 | — |

## 7. Offline and install gates (exact commands)

Run from the worktree root in PowerShell. None of these call any service other than the npm registry (dependency install) and, once, electron-builder's tool cache.

```
npm ci                                   # A1: with scripts; downloads the pinned Electron binary once
npm run typecheck
npm test                                 # P0/P1 suites, pure Node, no desktop input
$env:JARVIS_ELECTRON_TESTS='1'; npm test # P2: Electron smoke in a temp userData
npm run build
npm run package:win                      # M1 artifact → release\*.exe
$env:JARVIS_NATIVE_TESTS='1'; node --test tests/native.test.mjs   # P4: root/human only, moves a real Notepad window
```

Firewall block for C5 is applied by the tester through Windows Defender Firewall with Advanced Security → Outbound Rules → New Rule → Program → the installed exe → Block. Remove it after the test.

## 8. Decisions for root

- **D1 Product name and data folder.** Changing `package.json` `productName` to "Desktop Companion" also renames `%APPDATA%\Jarvis Desktop` to `%APPDATA%\Desktop Companion`, so an existing personal profile would appear empty after update. Options: keep `productName` until a one-time folder migration exists in `electron/main.ts` (copy-on-first-run if the old folder exists and the new one does not), or accept the reset for the personal release. Recommendation: rename now with the migration, because the installer name and window title are the most visible "Jarvis" strings.
- **D2 Key storage.** Keep `native/dpapi.ps1` (already written, testable with the runner fixture, same CurrentUser DPAPI scope) and reword K1/K2 to "DPAPI (via the native helper)", or switch to Electron `safeStorage` in `secrets.ts` (removes a PowerShell spawn per cloud chat; requires an Electron-only code path and a smoke test instead of a unit test). Recommendation: keep DPAPI script for the first release; note it in architecture §1.
- **D3 External links.** Either remove the Control Room `<a target="_blank">` from `Developer.tsx` and route it through the existing `open-url` action (consistent with architecture §6.1 and B3), or allow `setWindowOpenHandler` to call `shell.openExternal` for `http://127.0.0.1`/`localhost` only. Recommendation: route through `open-url`; it keeps "every external open is an approved action" true.
- **D4 Mic permission scope (B4).** Keep the current "audio only, app origin only" handler and reword B4, or add a main-side `pttActive` flag set through a new IPC call (contract change). Recommendation: reword B4 for the personal release; the renderer already stops the track on release and the capability is audio-only.
- **D5 `click` tier.** Architecture §7.2 and acceptance G2 say `click` is `allowed:false` until G4; the backend allows it today when the window is foreground (`actions.ts:149-156`, `native/click.ps1`). Either gate it (`allowed:false`, "Experimental — not enabled") until a `Settings.experimental.click` flag exists, or promote it to first release with the G4 fixture matrix. Recommendation: gate it; keep the script.

## 9. Limitations of this plan

- No source was edited; every gap is backed by a file and line reference but none of the proposed fixes has been prototyped.
- The Electron smoke, live Ollama run, and installer generation are root's recorded evidence; this worktree could not run them (`npm ci --ignore-scripts` only, no Electron binary).
- The X2 deadlock was established by reading `policy.ts` and `actions.ts`; the P4 G7 case is the end-to-end confirmation.
- Accessibility (D5), contrast (L1), and animation pause rules (L2) have no automated check proposed here; they stay manual.
- `docs/integrations-hub-plan.md` and the three research documents linked from the roadmap are not in the repository; nothing here depends on them.
