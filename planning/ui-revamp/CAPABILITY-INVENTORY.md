# Capability inventory (code-verified, 16 Oct 2026)

Scope: what `jarvis-desktop/` can do today, read from source at the working tree on branch `claude/compassionate-hawking-m9x36g` (HEAD `ebfb1a5`; `prototype/` and CSS were being edited concurrently and are out of scope). Purpose: choose reusable paths for the companion "computer use" loop described in `FUTURE-COMPANION-PLAN.md` (journeys 1, 2, 4) and `HITODAMA-DEEP-STUDY.md` ("Actual gaps").

> **Update, same day, after the native companion slice:** the following rows are now out of date. The companion window, its scoped IPC, selected-region capture, a Claude tool-use loop with image input, and companion tools for search, read and task creation (with trusted confirmation, read-back verification and undo) now exist. See `NATIVE-COMPANION-SLICE.md` for what is working, what is unverified on Windows, and what is still missing. The rows below describe the tree before that slice.

Status meanings:
- **Working**: renderer → IPC (`electron/channels.ts` METHODS, `electron/ipcCore.ts` ARG_SPECS, `electron/preload.ts`) → backend/native → result exists end to end in code.
- **Partial**: a real path exists but a stated part of the capability is absent.
- **Demo/preview-only**: UI, planning data or pure helpers with no executing backend.
- **Missing**: no implementation found.

"Windows-only, unverified here" = depends on `jarvis-desktop/native/*.ps1` (Windows PowerShell 5.1, Win32/WinRT) or a Windows API. This audit ran on Linux, so none of those paths were executed.

Common protections referenced below:
- **Trusted confirm**: `createTrustedConfirm` (`electron/ipcCore.ts`) wired in `electron/main.ts` as `confirm`. It is a native `dialog.showMessageBox` owned by `mainWindow`, buttons `Cancel`/`Continue`, `defaultId: 0`, `cancelId: 0`. It fails closed when the main window is not visible, focused, loaded and trusted, when another dialog is open, or when the dialog errors.
- **Dispatch gate**: `dispatch()` (`ipcCore.ts`) rejects senders that are not the main frame of the exact packaged `dist/index.html` (or the loopback dev origin). It then checks arity and `ARG_SPECS`, and redacts errors (`safeErrorMessage`, `redactSecrets`).
- **Safe launch**: `LaunchGuard` (`services/lifecycle.ts`). After two unclean exits, actions, window reads, OCR, clipboard and tray/hotkey are disabled.

---

## 1. Windows, shell and window chrome

| Capability | Status | Implementation | IPC | Platform | Protection | How a user reaches it today |
|---|---|---|---|---|---|---|
| Main window | Working | `main.ts:createWindow`. Size 1180×780, minimum 720×520, `show:false` then `ready-to-show`, `backgroundColor '#16181d'`, default OS frame. No `frame:false`, `transparent`, `alwaysOnTop`, `backgroundMaterial`, `skipTaskbar` or `focusable:false` | n/a | All | `contextIsolation`, `sandbox`, no node integration, navigation, window-open and webview guards | Launch the app |
| Compact, transparent or always-on-top companion window | **Missing** | `BrowserWindow` is constructed only in `createWindow` | — | — | — | Not reachable. The sidebar orb (`CompanionOrb`) is inside the main window only |
| Native material (Mica/Acrylic) | **Missing** (not used) | `setBackgroundMaterial`, `backgroundMaterial`, `setVibrancy` and `desktopCapturer` do not appear in `electron/` or `src/` | — | — | — | — |
| Tray | Working | `main.ts:createTray`. Menu: "Show / hide", "Quit". Click toggles. Closing the window hides it to the tray | n/a | All (tray icon behaviour unverified here) | Off in TEST_MODE and safe launch | Tray icon |
| Global shortcut | Working | `HOTKEYS = ['CommandOrControl+Alt+J', 'CommandOrControl+Alt+Shift+J']` via `native/startup.ts:registerHotkey`, `debounced(toggleWindow, 300)`. A conflict is written to Activity | n/a | All | Off in TEST_MODE and safe launch | Ctrl+Alt+J shows/focuses or hides the **main** window |
| Start hidden / start in tray | Working | `startHidden()` (`--hidden`, `--start-in-tray`) or `settings.startInTray` | `saveSettings` | All | — | Settings |
| Single instance, crash recovery | Working | `requestSingleInstanceLock`. `render-process-gone` reloads once, then shows `safePage`. `LaunchGuard` safe launch | n/a | All | — | Automatic |
| Window listing (other apps) | Working | `native/list-windows.ps1` → `native/adapter.ts:listWindows`, which filters own PIDs. Returns title, process, PID, rect, minimized/maximized/foreground and an elevation flag | `capsuleListWindows`, or `previewAction({type:'list-windows'})` + `executeAction` | Windows-only, unverified here | Read-only, no approval needed (`requiresApproval:false`). Disabled in safe launch | Desktop actions → "List windows" |

Installed Electron is **44.7.0** (`node_modules/electron/package.json`). Its `electron.d.ts` says:
- `setBackgroundMaterial(material: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed')`: "This method sets the browser window's system-drawn background material, including behind the non-client area. … This method is only supported on Windows 11 22H2 and up. @platform win32" (line 3273 onward).
- Constructor option `backgroundMaterial?: ('auto' | 'none' | 'mica' | 'acrylic' | 'tabbed')`: "Set the window's system-drawn background material, including behind the non-client area … @platform win32" (line 3866 onward).
- `transparent?: boolean`: "Makes the window transparent. Default is `false`. On Windows, does not work unless the window is frameless." (line 4075).
- `vibrancy` and `setVibrancy`: "@platform darwin". These are macOS only and irrelevant for Windows.
- `desktopCapturer` is declared under `namespace Main` (main process only). `getSources({types: Array<'screen'|'window'>, thumbnailSize?, fetchWindowIcons?})`.

Native helpers call `SetProcessDpiAwarenessContext(-4)` (per-monitor v2, `native/common.ps1:InitDpi`). Their coordinates are physical pixels, while Electron `screen` and window bounds use DIP. A capture overlay would need explicit mapping between the two. Nothing does this mapping today.

## 2. Screen context

| Capability | Status | Implementation | IPC | Platform | Protection | How a user reaches it |
|---|---|---|---|---|---|---|
| Screenshot, region or window capture | **Missing** | No `desktopCapturer`, `capturePage` or `getDisplayMedia` in app code. `API_FEATURES` in `backend.ts` says `region-capture: available:false` ("Screen region capture is not implemented"). `hardenSession` permission handler allows only audio-only `media`, so video and display capture are denied | — | — | — | — |
| Image understanding (vision) | **Missing** | `API_FEATURES` `vision: available:false`. Cloud messages are text only (section 3) | — | — | — | — |
| OCR of one user-chosen image file | Working | `services/ocr.ts:Ocr` (`recognizeChosen`, `prepare` checks path, extension, magic bytes, size, symlinks and SHA-256) → `native/OcrLocal.ps1` (Windows.Media.Ocr). `backend.ts:ocrRecognize` opens the main-process file dialog. UI: `Computer.tsx` `ImageTextPanel` via `bridges.ts:ocrBridge` | `ocrStatus`, `ocrRecognize`, `ocrCancel` | Windows-only, unverified here | Path comes only from the main-process dialog. Output is marked `untrusted:true`. Offline. Disabled in safe launch | Desktop actions → image text panel → choose an image |
| Assistant context controls (screen/app/clipboard) | Demo/preview-only | `Assistant.tsx:ContextControls` with `NO_CONTEXT_ITEMS: ContextItem[] = []` ("No screen, app or clipboard capture exists in this build"). The policy is stored in localStorage (`ui/context-policy.ts`, `usePref`) | none | — | Defaults Off | Assistant → Context drawer. Saves preferences only; nothing is attached |
| What is attached to a chat request | Text only | `chat.ts:buildHistory` sends prior non-system chat turns (bounded by `HISTORY_CHARS` = 8000 characters) plus the new user text, as `{role, content: string}`. No system prompt, no window title, no clipboard, no image | `chat`, `chatStreamStart` (max `LIMITS.chat` = 16 KiB characters) | All | Online mode needs a trusted confirm when turned on (`saveSettings`) | Assistant composer |

## 3. Cloud provider (`electron/services/cloud.ts`, `chat.ts`, `netGuard.ts`)

| Capability | Status | Evidence |
|---|---|---|
| Anthropic streaming chat | Working (network unverified here) | `streamCloudChat`: POST `/v1/messages`, body `{model, max_tokens: CLOUD_MAX_TOKENS (1024), messages, stream:true}`, `anthropic-version: 2023-06-01`. `AnthropicStreamValidator` enforces SSE event order. Driven by `backend.ts:runChatStream` through `ChatStreamHub` (`ipcCore.ts`). Tests: `substantial-streaming.test.mjs`, `slice-cloud-providers.test.mjs` (fake transport) |
| OpenAI / OpenRouter streaming chat | Working (network unverified here) | `streamOpenAiCompatibleChat` → `/v1/chat/completions` or `/api/v1/chat/completions`, `stream_options.include_usage`. Same limits |
| One-shot (non-streaming) chat | Working | `chat.ts:sendChat` / `cloudChat` / `compatChat` via IPC `chat` |
| Message content type | String only | `CloudStreamRequest.messages: {role:'user'\|'assistant'; content: string}[]`. No content blocks |
| Image input | **Missing** | No `image` blocks and no base64 media. The IPC string cap (16 KiB) would not fit an image anyway |
| Tool definitions / `tool_use` / `tool_result` | **Missing** | No `tools` in request bodies. `content_block_delta` deltas other than `text_delta` are ignored (`return ''`). No `stop_reason` handling |
| System prompt / persona | **Missing** | Request bodies contain only model, max_tokens, messages and stream |
| Cancel | Working | `chatStreamCancel(streamId)` → `ChatStreamHub.cancel` aborts the upstream request. Leaving online mode aborts cloud streams (`abortRoute('cloud','offline')`). Abandoned streams abort after 45 s. Partial text is saved and marked |
| Model list | Working (Anthropic, OpenAI) / not offered (OpenRouter) | `backend.ts:cloudModels` → GET `/v1/models` via `provider-check`, `parseModelList`. Default models are in `src/shared/contracts.ts:CLOUD_PROVIDERS`: `claude-haiku-4-5`, `gpt-4o-mini`, `openai/gpt-4o-mini`. Test: `revamp-claude-models.test.mjs` |
| Usage metering | Working when the provider reports token counts | `runChatStream` calls `usage.recordEvent` only with both counts present. **The `API_FEATURES` text "Chat replies are not metered yet" is stale** |
| Egress control | Working | `netGuard.ts:createGuardedFetch` allows exactly one origin and path per provider (`CLOUD_PATHS`, `COMPAT_CHAT_ROUTES`, `PROVIDER_CHECKS`), only in online mode with a key, max 30 cloud requests per minute, no redirects, and audits to Activity |
| Default route | Offline | `validation.ts` default `mode: 'offline'`. Claude needs online mode (trusted confirm) plus a stored key |

IPC involved: `chat`, `chatStreamStart`, `chatStreamRead`, `chatStreamCancel`, `clearChat`, `setCloudKey`, `cloudKeyStatus`, `deleteCloudKey`, `cloudProviderStatus`, `setProviderKey`, `clearProviderKey`, `cloudModels`.

## 4. Desktop actions (`electron/services/actions.ts`, `policy.ts`, `intent.ts`)

Flow: `previewAction(request)` → `ActionService.preview` evaluates live policy and window data, then stores a single-use entry for 60 s (`PREVIEW_TTL_MS`). `executeAction(previewId, approved)` → `ActionService.execute` runs:
1. registry lookup (single use);
2. decline-cooldown and rate checks (30 per minute);
3. trusted confirm (full `detail()` text, hidden characters made visible);
4. a generation check;
5. `revalidate` (same hwnd/PID/process, same file signature);
6. for `type-text`/`click`: `focusWindow`, then foreground and identity are re-checked;
7. `perform`.

The result is `{executed, reason?, …}` and every outcome goes to the Activity log. The renderer's `approved:true` is only a request; the native dialog decides.

| Action type | Status | Native path | Notes |
|---|---|---|---|
| `list-windows` | Working | `list-windows.ps1` | No confirmation |
| `open-url` | Working | `shell.openExternal` (`main.ts:shellAdapter`) | http, https and mailto only (`policy.ts:validateOpenUrl`). No credentials in URLs |
| `launch` | Working | `shell.spawnApp` (approved exe, `shell:false`) or `shell.openPath` (file in allowed folder) | Needs `settings.approvedApps` / `allowedRoots`. Exe is resolved and bound by size and mtime |
| `open-path`, `reveal-folder` | Working | `shell.openPath` | Must resolve inside `allowedRoots`. Executables and scripts refused. `main.ts` injects no `showItemInFolder`, so reveal opens the containing folder |
| `focus` | Working (Windows-only, unverified here) | `focus-window.ps1` | Not own windows, not elevated |
| `move-window` | Working (Windows-only, unverified here) | `move-window.ps1` (clamped to screens) | Used by capsule restore and routines (undoable) |
| `type-text` | Working (Windows-only, unverified here) | `type-text.ps1`: Unicode `SendInput`, approved hwnd/PID must be foreground, refuses elevated targets and password fields (UIAutomation `IsPassword`), max 2000 characters, stops if focus leaves | Line breaks refused for terminals, Explorer, Run and Start (`checkWindowPolicy`). Not offered by the planner without a named window |
| `click` | Working (Windows-only, unverified here) | `click.ps1`: point must be inside the window and not covered by another process (`PointBelongsTo`) | Not in `PLANNED_TYPES`. Reachable only from Desktop actions → window row → Click |
| Rule planner | Working | `intent.ts:planIntent`. One command, verb first, no chaining (`CHAIN_RE`). Unknown input is blocked. A window snapshot pins a target to `hwnd:` or produces a clarification | IPC `planIntent(command, {useLocalModel?})`. Optional assist uses **Ollama only**, never cloud (`backend.ts:modelPlan`) |
| Renderer planner helpers | Working | `Assistant.tsx:planCommand`, `previewCommand`, `decideCommand`, `CommandFlow`; `Computer.tsx` form | Assistant "command" mode, or the Desktop actions page |
| Approved apps / allowed folders | Working | `settings.approvedApps`, `settings.allowedRoots`. `backend.ts:saveSettings` lists each widening and requires a trusted confirm | `saveSettings`, `pickPath` |

Protection gaps found in code (factual, not yet fixed):
- `ActionService.cancelPending()` exists and is tested (`autopilot-security.test.mjs:598`), but nothing in production calls it. Its own comment says to call it when settings change. `saveSettings` does not.
- `minPreviewAgeMs` is not passed in `backend.ts`, so the "approved too quickly" guard is off (0) in production. The trusted dialog remains the actual gate.
- `createTrustedConfirm` takes `getWindow: () => mainWindow` and requires that window to be **visible and focused**. A flow started from any other window, or while the main window is hidden in the tray, gets `false` (fail closed). This is the main blocker for confirmations started from a companion surface.

## 5. Voice

| Capability | Status | Implementation | IPC | Platform | Protection | How a user reaches it |
|---|---|---|---|---|---|---|
| Mic recording (push-to-talk clip) | Working | `src/ui/audio.ts:ClipRecorder` (`getUserMedia` + `MediaRecorder`, decoded to 16 kHz mono WAV, max 30 s, `LIMITS.audioSamples` 480 000) | — | All (Electron renderer) | In-app consent `createMicConsent` (off by default, never granted on load) plus the session permission handler (audio only, app page only). Test: `parallel-security.test.mjs` "microphone: without in-app consent…" | Assistant → Talk (after enabling the microphone in its panel) |
| Speech to text | Partial (basic) | `services/speech.ts:Speech.transcribe` writes a temp WAV → `native/transcribe.ps1` (System.Speech `DictationGrammar`, local, no network). The Whisper-CLI adapter (`createWhisperCliEngine`, `buildLocalEngines`) exists but is **not wired**: `backend.ts` builds `Speech` without `engines` | `transcribe(wavBytes as number[])` | Windows-only, unverified here | Audio gate (min 300 ms, peak) and a 60 s timeout. The native helper cannot be aborted | Release Talk; the transcript goes into the composer for review |
| Dictation cleanup | Working | `ui/dictation-cleanup.ts:cleanTranscriptOffline` (deterministic). Optional "Clean with AI" through the normal chat route (`runDictationCleanup`) | `chat` / `chatStreamStart` | All | Exact prompt shown; sent only on click | Assistant → after a transcript → Clean up dictation |
| Text to speech | Working (basic) | `Speech.speak` → `native/speak.ps1` (System.Speech, default device, selectable installed voice) | `speak(text ≤ 4000)` | Windows-only, unverified here | Local only | Assistant → speak reply / auto-speak |
| Stop speech | Partial | `Speech.cancel()` exists, but no IPC method exposes it. A new `speak` call supersedes the old one; dispose cancels | — | — | — | No dedicated Stop control reaches the backend |
| Insert dictated text into another app | Partial | No dictation→target path. The only route is the generic `type-text` action (preview + trusted confirm + foreground checks, max 2000 characters) | `previewAction` / `executeAction` | Windows-only | Trusted confirm per insertion | Desktop actions → Type, with text pasted manually |
| Live or full-duplex voice, cloud STT/TTS | **Missing** | — | — | — | — | — |

## 6. Saved information

| Capability | Status | Implementation | IPC | Protection | How a user reaches it |
|---|---|---|---|---|---|
| Notes | Working | `backend.ts:saveNote/deleteNote`, `validation.ts:buildNote`, `Store` | `saveNote`, `deleteNote`, `getState` | Encrypted at rest when safeStorage is available (`atRest.ts`) | Workspace → Notes; Today quick capture |
| Tasks + reminders | Working | `saveTask/deleteTask`. `Reminders` (main) fires `Notification`s and re-arms after save, delete and import (`withReminderRearm`) | `saveTask`, `deleteTask` | No confirmation (local data) | Workspace → Tasks; Today |
| Capsules (open a set of files/apps/links; restore window positions) | Working (Windows-only parts unverified here) | `services/capsules.ts:restoreCapsule` (`prepareItem` per item, **one** trusted confirm for the set), `previewRestore` (dry run), `captureGeometry`, packs | `saveCapsule`, `deleteCapsule`, `restoreCapsule`, `capsulePreviewRestore`, `capsuleListWindows`, `capsuleCaptureGeometry`, `capsuleExportPack`, `capsuleReadPack`, `capsuleParsePack` | Trusted confirm; 3 s restore throttle; imported packs carry no permissions | Workspace → Capsules |
| Search | Working (renderer-side) | `services/search.ts:searchState` is pure. The renderer imports it directly (`MemorySearch.tsx`, `CommandPalette.tsx`, `Notes.tsx`) over `getState` and productivity data. A backend copy is exposed as IPC `search` (notes, tasks, capsules, optional chat), but renderer components do not call it | `search`, `getState`, `productivityGet` | Read-only | Ctrl+K palette; Memory → Search |
| Lexical retrieval (BM25) | Working (renderer-side) | `ui/local-retrieval.ts:buildIndex/query/findRelated` (no embeddings) | none (pure) | — | Memory → Search "related items" |
| Notes Q&A with citations | Working | `ui/notes-qa.ts:buildNotesQaRequest`, `runNotesQa`, `parseAnswerReferences` (`[n]` → note ids). Sends via `chatStreamStart` | `chatStreamStart`, `chatStreamRead`, `chatStreamCancel` | User ticks the notes; exact prompt shown | Memory → Search → ask about selected notes. The prompt is stored in the global chat history and prior chat turns are included (`buildHistory`) |
| Memory workbench / productivity sidecar | Working | `services/store.ts:ProductivityStore` (goals, checkpoints, file shelf, focus, opt-in app timeline, reminder snoozes) | `productivityGet`, `productivityApply`, `productivityForgetHistory`, `productivitySignals` | Trusted confirm for forget and for timeline/title opt-in. **The sidecar file is plaintext** (no cipher passed) | Memory → Memory |
| Clipboard history | Working | `services/clipboard.ts:ClipboardHistory`. Reader in `main.ts` (`clipboard.readText`, skips content with the `ExcludeClipboardContentFromMonitorProcessing` format), polled every 1.5 s, memory only, heuristic secret skip | `clipboardStatus`, `clipboardSetEnabled`, `clipboardList`, `clipboardGet`, `clipboardRemove`, `clipboardPurge` | Trusted confirm to turn on; off in TEST_MODE and safe launch. `getApiInfo` reports it available when the reader is injected | Workspace → Clipboard |
| Calendar | Working (local `.ics` only) | `services/calendar.ts:parseIcs/toIcs/mergeEvents`. Calendar sidecar. Recurring and non-UTC events are skipped and counted | `calendarList`, `calendarImportText`, `calendarImportFile`, `calendarExport`, `calendarClear` | Paths come only from main dialogs | Workspace → Calendar |
| Approved documents | Working (.txt/.md, ≤100 KB) | `services/approvedDocuments.ts:ApprovedDocuments` (dialog → token-held preview → save as note) | `documentsChoose`, `documentsSave`, `documentsDiscard` | Renderer never sees the path | Workspace → Writing |
| File shelf | Working | `FileShelf.tsx` → `pickPath`, then `open-path`/`reveal-folder` actions | `pickPath`, `previewAction`, `executeAction` | Allowed folders plus trusted confirm | Workspace → Capsules (file shelf panel, `Capsules.tsx` imports `FileShelf`) |
| Routines | Working (desktop steps Windows-only) | `services/routines.ts:RoutineEngine`. Each step goes through `ActionService.preview/execute` (its own confirm). Schedules need a start confirm. Per-step results, retries, cancel, undo of reversible moves. Engine methods `importPreview`, `retry`, `recover`, `exportRoutine` are **not** in IPC, so those buttons are hidden | `routinesList`, `routinesSave`, `routinesRemove`, `routinesStart`, `routinesCancel`, `routinesPauseAll`, `routinesResumeAll`, `routinesUndo`, `routinesPlanText`, `routinesPlanModel` | Trusted confirm per step and per scheduled start. Test: `autopilot-routines.test.mjs` | Automations |
| Usage ledger | Working | `services/usage.ts:createUsageLedger` (local estimates, prices, budget, CSV/JSON export) | `usageReport`, `usageExport`, `usageSetPrices`, `usageSetBudget` | — | Settings → Usage |
| Integrations | Partial | `services/integrations.ts:createIntegrationService` plus `ui/integration-catalog.ts`. Real actions are only **connection checks** (GET Anthropic/OpenAI `/v1/models`, GitHub `/user`, Open-Meteo forecast) and key storage. Spotify, browser and ChatGPT/Claude websites are `handoff` (open a URL via `open-url`). `spotify-api` and `calendar` are `setup-required`. OAuth PKCE helpers (`buildAuthorizeUrl` etc.) are "Groundwork … nothing is wired to IPC". No account data is read or written | `integrationsList`, `integrationsPreview`, `integrationsCheck`, `integrationsSetKey`, `integrationsRemoveKey`, `integrationsSetEnabled`, `integrationsUsage`, `integrationsClearUsage` | Online mode plus trusted confirm for checks; keys write-only | Settings → Connections |
| Key vault | Working (Windows-only fallback unverified here) | `services/secrets.ts:Secrets` uses Electron `safeStorage` first, then the DPAPI helper (`native/dpapi.ps1`). One file per provider (`cloud-key.bin`, `openai-key.bin`, `openrouter-key.bin`). Integration keys use `createDpapiKeyVault` (DPAPI helper; the Anthropic slot aliases `Secrets`) | key methods above | Keys never returned; errors redacted | Settings → AI / Connections |
| State encryption at rest | Working for `state.json` and backups only | `atRest.ts:createSafeStorageCipher` → `Store`. Sidecars (`productivity`, `routines`, `usage-ledger`, `calendar`, `integrations`, `model-profile`) use `services/sidecar.ts` with **no encryption** | — | — | Automatic |
| Export/import | Working | `exportData`, `importData` (import keeps current permissions and forces offline) | `exportData`, `importData` | Trusted dialogs; pre-import backup | Settings → Data |

## 7. Companion and appearance

| Capability | Status | Implementation | Notes |
|---|---|---|---|
| Shared orb renderer | Working (main window only) | `src/ui/orb-engine.ts` (one hidden WebGL context draws every registered placement canvas; Canvas2D fallback; DPR and fps caps; pauses when hidden), `orb-shader.ts`, `components/CompanionOrb.tsx` | Placements: shell, Today, Assistant, Studio, onboarding. Not used outside the main window |
| Appearance model | Working | `src/ui/appearance.ts` (`CompanionAppearance`, `stateTargets`, forms, tint presets), `appearance-context.tsx`. Stored in **localStorage** (`ui/prefs.ts`, key prefix `jarvis.ui.`) except `settings.reduceMotion` (backend) | A second window on the same origin could read the same localStorage. Cross-window live sync does not exist |
| Companion state machine | Working | `src/ui/companion.tsx` (`useCompanion`: idle/thinking/transcribing/alert…) | Driven by Assistant events |
| Studio | Working | `components/Companion.tsx` (form, tint, motion, preview states) | Studio → Companion |
| Character editor | Working (offline) | `components/AvatarStudio.tsx`, `ui/avatar-editor.ts` (vector pack, expressions, timelines, localStorage) | Studio → Character editor |
| Motion studio / Scene 3D | Working (offline) | `components/MotionStudio.tsx`, `ui/motion-presets.ts`, `components/Scene3D.tsx`, `ui/scene3d.ts`. Exports through `will-download` → native Save dialog | Studio → Motion |
| Windows taskbar/Start customization | Demo/preview-only, unreachable | `components/Customization.tsx`, `ui/taskbar-presets.ts` ("preview and reversibility planning only … applied:false"). `Customization.tsx` is not imported by any route | — |

## 8. Security boundaries

| Boundary | Status | Implementation |
|---|---|---|
| Renderer isolation | Working | `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`, no workers/subframes node, `devTools` off when packaged. Preload exposes only `window.jarvis` (every METHOD) and read-only `window.jarvisHost` |
| Sender trust | Working | `dispatch()` accepts the main frame of the exact `dist/index.html` only. A second HTML page (for example `companion.html`) would be **rejected** until `RouterOptions`/`isTrustedUrl` are extended. Loading the same `index.html` in a second window would expose the **entire** METHOD table to that window |
| IPC argument validation | Working | `ARG_SPECS` + `validateArgs` (type and size), `ARITY`; services re-validate semantics |
| Session request filter | Working | `main.ts:hardenSession` → `isAllowedRequestUrl`. Renderer may load only dist `file:` URLs (empty host), `data:`, `blob:`, `devtools:`, and the loopback dev origin in development. CSP in `index.html` (`connect-src 'self'`) |
| Permissions | Working | Audio-only `media` for the app page. Everything else (video, display capture, notifications, clipboard-read, geolocation) is denied |
| Main-process egress | Working | `netGuard.ts` is the documented single egress path. Integrations and models receive the guarded fetch by injection |
| Native helper integrity | Working | `native/integrity.ts` checks SHA-256 against a build manifest (required when packaged). `runner.ts` uses `execFile` without a shell, JSON on stdin, bounded stdout, and hides stderr for sensitive scripts |
| TEST_MODE auto-approval | Working, scoped | `JARVIS_TEST_MODE=1` is honoured only if `isTestFixtureDir(userData, os.tmpdir())` (direct child of tmp with prefix `jarvis-smoke-`, `jarvis-test-` or `desktop-companion-test-`); otherwise `app.exit(1)`. In TEST_MODE, `confirm` returns true; dialogs return null; no tray, hotkey, reminders, clipboard reader or downloads; the window is not shown |

## Test evidence (Linux, this session)

`node --test tests/*.test.mjs`: 1636 tests, 1616 pass, 15 fail, 5 skipped. Every failure observed is in a file-path test that assumes Windows drive paths:
- `backend-approval` #9: `chosenLocalPath` "The chosen import file location is not valid"
- `full-security-regressions` #2: the POSIX `appUrl` fails the drive-letter check in `isAllowedFileRequest`
- `autopilot-models` #24–31 (model pack folders)
- `milestone-data-api` #10 and #12
- `final-integration-*` calendar junction and bridge tests
- `autopilot-api` #20 (usage export)
- `autopilot-native` #13 (launch guard)

These are not judged as product regressions. Windows results are **Unknown** (not run here). Tests use fake native adapters, so none of the PowerShell helpers or real providers were exercised.

---

## Reusable paths for the first native milestone

### Journey 1: ask about a selected screen region

| Step | Reuse | Missing piece (proposed location) |
|---|---|---|
| Invoke from a companion surface | `registerHotkey`, `debounced`, `createTray`, `hardenSession`, the window guards in `main.ts` | Companion `BrowserWindow` (frameless, `transparent` or `backgroundMaterial:'acrylic'` with a solid fallback, `alwaysOnTop`, `skipTaskbar`, `focusable` handling): new `electron/companionWindow.ts`. Separate page (`companion.html`) with its own small METHOD subset and preload (`electron/companionPreload.ts`, `channels.ts` `COMPANION_METHODS`), and `isTrustedUrl`/`RouterOptions` extended to that exact file |
| Select region (overlay) | Electron `screen` (not used yet); helper DPI context (`common.ps1:InitDpi`) | Full-screen transparent overlay window per display plus DIP↔physical mapping: `electron/services/capture.ts` (pure geometry, unit-testable) and an overlay page |
| Capture pixels | — | `desktopCapturer.getSources({types:['screen'], thumbnailSize})` in main (not exposed to the renderer), crop to the region: `electron/services/capture.ts`. Store the image in main and hand the renderer only a token, mirroring `ApprovedDocuments` |
| Preview, redact, confirm what is sent | `ApprovedDocuments` token pattern; `createTrustedConfirm`; `ui/context-policy.ts:decideContextShare`/`buildContextPreview` (replace `NO_CONTEXT_ITEMS` with real items) | Preview UI in the companion; per-send consent bound to a capture token: new IPC `captureRegion`, `captureDiscard`, `chatStreamStartWithContext` |
| Optional local text fallback | `Ocr.recognizeChosen(path)` accepts a main-written temp PNG (path, magic-byte and size checks already apply) → `OcrLocal.ps1` | Call site in `capture.ts` (Windows-only) |
| Send image to Claude | `streamCloudChat`, `AnthropicStreamValidator`, `ChatStreamHub`, `netGuard` route `/v1/messages` (unchanged origin/path) | `CloudStreamRequest.messages` must accept content blocks (`text` + `image` base64) in `services/cloud.ts`; `buildHistory` variant that does not reuse stale image context (`services/chat.ts`); an IPC size path that does not go through the 16 KiB string arg (image stays in main, referenced by token); a provider capability flag for image input (OpenAI/OpenRouter adapters text-only until done) |
| Answer in the island | `chatStreamRead` events; `useCompanion` states | Companion answer view; result retained in history |

### Journey 2: one harmless reversible action

Recommended first target: **create a task** (no native input, no Windows dependency, undo = `deleteTask`). Then **type text into a test document** (`type-text`).

| Step | Reuse | Missing piece |
|---|---|---|
| Goal → tool call | `intent.ts:checkPlannedRequest`/`parseModelPlan` (strict JSON → `ActionRequest`) as validators for model output | Anthropic `tools` definitions + `tool_use` parsing + `tool_result` turn in `services/cloud.ts` (validator currently drops non-text deltas); a typed tool registry `electron/services/tools.ts` mapping `create_task` → `buildTask`/`saveTask`, `type_text` → `ActionService.preview`, `search_saved` → `searchState`; per-turn loop and cancel in `backend.ts` (reuse `ChatStreamHub` abort signal) |
| Disclose target and action | `ActionService.preview` summary + `detail()`; `CommandFlow` UI | Compact receipt component in the companion |
| Confirm | `createTrustedConfirm` (Cancel default) | Must work when the main window is hidden: `getWindow` returns the companion window (and `isTrusted` accepts its URL), or the dialog is shown unparented. Today it fails closed unless `mainWindow` is visible and focused. Wire `ActionService.cancelPending()` into `saveSettings`; consider setting `minPreviewAgeMs` (`RECOMMENDED_MIN_PREVIEW_AGE_MS`) |
| Execute + verify | `ActionService.execute` → `revalidate` → `focusWindow` → `type-text.ps1` (foreground, password-field and elevation checks; returns `typed` count); `saveTask` returns the new state | Post-action verification for typing (for example a UIAutomation read-back) does not exist; only the typed count is reported |
| Focus restoration | `native.focusWindow` (exact hwnd/PID) | Restore the previously foreground window after the companion collapses; the companion must not take focus on resting (`focusable`/`showInactive`) |
| Undo / recovery | Routine undo for reversible moves (`RoutineEngine.undo`); `deleteTask` | Undo entry for a companion-created task; typed text has no undo (rely on target app) |

### Journey 4: find saved information and cite it

| Step | Reuse | Missing piece |
|---|---|---|
| Retrieve | `searchState` (backend IPC `search`, or pure import), `local-retrieval.ts:buildIndex/query` (BM25), `ExternalDoc` for calendar/clipboard | Expose BM25 retrieval in main (currently renderer-only) so a tool call can use it: `electron/services/tools.ts` `search_saved` |
| Answer with citation | `notes-qa.ts:buildNotesQaRequest`, `parseAnswerReferences` (`[n]` → item id), `chatStreamStart` | A request path that does not mix the global chat history into grounded answers (`buildHistory` always prepends prior turns); citations for tasks, capsules and checkpoints, not only notes |
| Open the cited item | Route params (`initialItem` in `Capsules.tsx`, `navResult`), `open-path` action for shelf files | Companion → workspace deep link (IPC or shared state between windows) |
| Insert an approved excerpt | `type-text` action (≤2000 characters, trusted confirm) | Excerpt picker plus insertion receipt |

### Unknowns

- Actual behaviour on Windows 10/11 of every PowerShell helper, `safeStorage`, `Notification`, tray, global shortcut and `setBackgroundMaterial`. Unknown because Windows was not available in this session.
- Whether `transparent:true` and `backgroundMaterial` can be combined on the target laptop's Windows build. Unknown: the docs above do not state it, and it was not tested.
- Real provider responses (Anthropic image and tool use with the stored key). Unknown: no network or key calls were made, as instructed.
