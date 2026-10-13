# Architecture — Jarvis Desktop (seeded Electron + React)

Status: implementation-ready design for the first personal release. Nothing below is implemented yet. Source of truth for the IPC surface is `src/shared/contracts.ts`; for scope, `docs/product-roadmap.md`. Acceptance criteria live in `docs/acceptance.md`.

## 1. Fixed decisions and constraints

| Decision | Value | Source |
|---|---|---|
| Host | Electron 44.7.0, React 19.2, TypeScript 5.9, Vite 7.3 renderer, esbuild main/preload | `package.json`, `scripts/build-main.mjs` |
| Target | Windows 11/10 x64, NSIS installer (`npm run package:win`) | `package.json` `build` |
| Default mode | `offline`. No outbound network from the app unless the user switches to `online` | README, roadmap |
| Local text AI | Ollama on loopback (`Settings.localEndpoint`, default `http://127.0.0.1:11434`) | task |
| Local voice | Windows `System.Speech` (synthesis + recognition) via bounded PowerShell 5.1 | task, README |
| Desktop control | Windows UI Automation + Win32 via PowerShell, always preview → approve → execute | contracts `previewAction`/`executeAction` |
| Secrets | Electron `safeStorage` (DPAPI, per Windows user) | task |
| Cloud | Optional, user-supplied Anthropic key (`Settings.cloudModel`, default a Haiku model) only in `online` mode | roadmap 101 |

The roadmap says the host framework is "decided after renderer/overlay tests". The repo is already seeded with Electron, so Electron is the working host. The overlay benchmark (§10, gate G1) decides whether the desktop island stays in Electron. Keep renderer code free of Electron imports so it can move.

Environment observed on the build machine (13 Oct 2026): Node 22.15.1 (no unflagged TypeScript stripping), Windows PowerShell 5.1.26100, `System.Speech` present with 2 voices and 1 recognizer. `node_modules` is not installed in this worktree.

## 2. Process model

```
┌──────────────── Main process (Node, privileged) ───────────────┐
│ lifecycle · single-instance lock · tray · windows               │
│ ipc/router ── validates sender + payload ──► services/*         │
│ services: store, backup, secrets, netGuard, ollama, cloud,      │
│           speech, actions, capsules, system, activity           │
│ native/powershell runner ──spawn on demand──► powershell.exe    │
└────────────▲───────────────────────────────────────────────────┘
             │ ipcRenderer.invoke / webContents.send('activity')
┌────────────┴─────────── Preload (sandboxed) ───────────────────┐
│ contextBridge.exposeInMainWorld('jarvis', JarvisAPI)            │
└────────────▲───────────────────────────────────────────────────┘
┌────────────┴─────────── Renderer (React, no Node) ─────────────┐
│ main window (dashboard, chat, capsules, notes, tasks, settings) │
│ island window (lazy-created, gate G1)                           │
└────────────────────────────────────────────────────────────────┘
```

At idle there are no child processes: PowerShell workers are spawned per request and exit (§8). Ollama is a separate user-installed process. The app reports its memory separately and never counts it as app memory.

## 3. Source layout (proposed; owners assigned by orchestrator)

```
electron/main.ts            app lifecycle, BrowserWindow factory, tray, security hooks
electron/preload.ts         JarvisAPI bridge only (no logic)
electron/ipc.ts             channel table: one handler per JarvisAPI method
electron/services/store.ts      AppState load/save, atomic write, migrations, retention
electron/services/backup.ts     rolling backups, export/import, corruption recovery
electron/services/secrets.ts    safeStorage-wrapped cloud key
electron/services/netGuard.ts   the ONLY egress path (guardedFetch) + session request filter
electron/services/ollama.ts     local chat + model listing via guardedFetch
electron/services/cloud.ts      Anthropic Messages client via guardedFetch (online only)
electron/services/speech.ts     speak/transcribe through native runner
electron/services/actions.ts    policy, preview registry, execution
electron/services/capsules.ts   restore orchestration (items + window geometry)
electron/services/system.ts     SystemInfo + capability probes
electron/services/activity.ts   append-only activity log + push to renderer
electron/native/runner.ts       bounded PowerShell spawn
native/*.ps1                    speak, transcribe, list-windows, focus, move-window, type-text, click
src/main.tsx, src/App.tsx, src/views/*, src/ui/*   renderer
tests/*.test.mjs            node --test (see §11)
```

`tsconfig.json` already includes `src` and `electron`. `index.html` already sets a strict CSP (`default-src 'self'`, `connect-src 'self'`). The renderer never calls the network itself, including Ollama: every request goes through IPC to main.

## 4. IPC contract mapping

All channels use `ipcMain.handle('jarvis:<method>')`. The preload maps `window.jarvis.<method>` to `ipcRenderer.invoke`. `onActivity` subscribes to `jarvis:activity` and returns an unsubscribe function.

Router rules, which apply to every handler:
1. Reject if `event.senderFrame.url` is not the packaged `file://…/dist/index.html` (or the Vite dev URL when `!app.isPackaged`).
2. Validate payload shape and size in main, never trusting renderer types. Strings ≤ 64 KB, `chat` text ≤ 16 KB, `transcribe` audio ≤ 30 s at 16 kHz (480,000 samples), arrays ≤ 1,000 items.
3. Return typed results. Throw only `Error` objects with user-safe messages. Never include secrets, full file contents, or stack traces with user paths in errors sent to the renderer.

| Method | Service | Notes |
|---|---|---|
| `getState`, `save*`, `delete*`, `clearChat` | store | Each mutation writes atomically and returns the full `AppState`. `save*` with no `id` creates (`crypto.randomUUID()`) and sets `createdAt`/`updatedAt` in main |
| `saveSettings` | store + netGuard | Validates enum fields. In `offline`, `localEndpoint` must be a loopback http URL. `allowedRoots` are normalized absolute paths. `retainDays` is 1–3650 |
| `getSystemInfo` | system | `os.platform/arch/totalmem/cpus` plus `capabilities[]` (§9) |
| `chat` | ollama / cloud | Routing in §6. Persists the user and assistant `ChatMessage` with honest `source` |
| `setCloudKey`, `cloudKeyStatus`, `deleteCloudKey` | secrets | The key never travels main → renderer |
| `previewAction`, `executeAction` | actions | §7 |
| `restoreCapsule` | capsules | §7.4 |
| `speak`, `transcribe` | speech | §6.3 |
| `exportData`, `importData`, `pickPath` | backup / dialog | Native dialogs only. The renderer never supplies a raw write path |

### Contract gaps (for the contract owner; do not work around silently)
- **Streaming chat (roadmap 21):** `chat()` returns one final `ChatMessage`. Streaming needs e.g. `onChatDelta(handler)` plus a cancel method. Until then the UI shows a "thinking" state and the feature is "non-streaming".
- **Action/experiment flags:** `Settings` has no per-capability enable switch (for example, experimental `click`). Until one is added, experimental actions report `allowed:false` with a reason.
- **Network audit:** no API exposes the egress log. It is surfaced through `Activity` entries (`kind:'network'`).
- **Ollama model list/import:** no method exists. Exposed for now only as `Capability.reason` text. Roadmap 14/17 need new methods.
- **Schema version:** kept in the on-disk envelope (§5), not in `AppState`.

## 5. Persistence, backups, recovery

Location: `app.getPath('userData')` (`%APPDATA%\Jarvis Desktop`).

```
state.json                {schemaVersion:1, savedAt, state: AppState}
backups/state-YYYYMMDD-HHmmss.json   rolling, newest 10 + 1 per day for 7 days
backups/pre-import-*.json            taken before every import
secrets/cloud-key.bin     safeStorage ciphertext (never exported, never backed up)
logs/app.log              rotated 1 MB × 3, redacted (no message text, no keys)
.lock / .running          safe-launch marker (§5.3)
```

### 5.1 Write path
- Writes are serialized through one async queue.
- Each write goes to `state.json.tmp`, flushes with `fsync`, then renames over `state.json`. A rename on the same volume is atomic enough on NTFS for this purpose.
- A backup snapshot is taken at most every 10 minutes on change, and on clean quit.
- Retention runs at startup and daily: chat and activity entries older than `retainDays` are dropped. Notes, tasks, and capsules are never auto-deleted.

### 5.2 Load path
1. Parse `state.json` and validate the schema.
2. On failure, move the bad file to `state.corrupt-<ts>.json`, load the newest valid backup, and add an `Activity` entry `kind:'recovery'`. Tell the user on the dashboard.
3. If no backup is valid, start with defaults (`onboarded:false`, `mode:'offline'`).
4. Run migrations by `schemaVersion`. A newer-than-known version opens read-only with a warning.

### 5.3 Crash recovery and safe launch (115)
- `.running` is written at start and removed on clean quit.
- If it is present at start twice in a row, the app enters safe launch: no island, no scheduled routines, no auto-restore, and a banner offering "open normally / restore backup / export diagnostics".
- Renderer crashes (`render-process-gone`) reload once, then show the safe page.

### 5.4 Export / import (114)
- **Export:** Save dialog, then JSON `{format:'jarvis-export', schemaVersion, exportedAt, state}`. It excludes secrets and the `localEndpoint` override is kept. Returns the `path`, or `null` on cancel.
- **Import:** Open dialog, then validate the format, version, and every entity. Take a `pre-import` backup and replace the state (merge is a later expansion). Invalid files are rejected with no change. Imported `allowedRoots`/`approvedApps` are kept, but every capsule target is re-validated at restore time, so importing never grants execution.

## 6. AI and voice

### 6.1 Network guard (strict offline, 116)
`netGuard.guardedFetch(url, init, purpose)` is the only function that may perform HTTP from main. Lint and test rule: no other `fetch`, `net.request`, `http(s).request` in `electron/`.

| Mode | Allowed destinations |
|---|---|
| offline | `http://127.0.0.1:*`, `http://[::1]:*`, `http://localhost:*` (resolved to loopback only) |
| online | offline set + `https://api.anthropic.com` (exact origin), only for purpose `cloud-chat` and only with a key |

Additional hardening in `main.ts`:
- `session.defaultSession.webRequest.onBeforeRequest` cancels any renderer request whose scheme is not `file:`/`devtools:` (dev: also the Vite origin).
- Spellchecker dictionary download is disabled with `setSpellCheckerEnabled(false)`, because it would fetch from a Google CDN.
- No `autoUpdater`, and `crashReporter` uploads are off.
- `shell.openExternal` is only reachable through approved actions (§7).
- Every allowed and denied egress attempt is logged as `Activity{kind:'network'}` with origin and purpose only.

Honest limit: this verifies the app's own egress paths. It is not an OS firewall. The acceptance test uses an offline machine or a Windows Firewall outbound block that the tester applies manually. The app never changes firewall settings.

### 6.2 Chat routing (11, 21, 101)
```
chat(text):
  if mode==='online' && cloudKeyStatus && cloudModel → cloud.send (source:'cloud')
  else → ollama.send (source:'local')
  local unavailable → assistant message source:'system', text explains why (no fabricated reply)
```
- There is no silent cloud fallback. An Ollama failure in online mode does not route to cloud unless the user picked cloud.
- **Ollama:** `POST {localEndpoint}/api/chat`, `{model: settings.localModel, messages: last N turns within ~8k chars, stream:false, keep_alive:'5m'}`. Timeout is 120 s, with cancel on window close.
- **Ollama probe:** `GET /api/tags` with a 1.5 s timeout. This drives `Capability{id:'local-llm'}`: unavailable reasons are "Ollama not running", "model X not installed", or "endpoint not loopback".
- **Cloud:** Anthropic Messages API with headers `x-api-key` and `anthropic-version`. The key is decrypted in main per request and never logged. The request body is shown to the user once before first send (roadmap 108 preview). Tests use a mock server; development never calls the live API (AGENTS.md).

### 6.3 Speech (12, 13, 22)
- **Speak:** Run `native/speak.ps1` with `System.Speech.Synthesis.SpeechSynthesizer`.
  - Text is passed on stdin as JSON (never on the command line) and capped at 4,000 chars.
  - `Settings.voice` is checked against `GetInstalledVoices()`. An unknown voice returns `{ok:false, reason}`.
  - A new `speak` cancels the previous one by killing that process.
- **Transcribe:** The renderer captures the mic only while push-to-talk is held. It uses `getUserMedia`; the permission handler allows `media` (audio only) for the app origin and denies everything else. Audio is resampled to 16 kHz mono Int16 and sent as `number[]`.
  - Main writes a temp WAV to `os.tmpdir()/jarvis-<uuid>.wav`. `transcribe.ps1` runs `SpeechRecognitionEngine` with `DictationGrammar`, `SetInputToWaveFile`, and `Recognize()`, then the WAV is deleted in `finally`.
  - Result: `{text}`, or `{text:'', reason}` when no recognizer is installed, nothing is recognized, or the language is unsupported.
- **Honest quality gate:** `System.Speech` dictation is basic, English-centric, and accent-sensitive. Label it "Basic (Windows Speech)". A higher-quality local ASR (Whisper-class model pack) is an Expansion item behind gate G3.
- **Dictation insertion (23):** The transcript goes to an editable preview. Insertion is a `type-text` action through §7, never automatic.

## 7. Actions and UI Automation

### 7.1 Flow
```
renderer previewAction(req) → main policy.evaluate(req, settings, mode)
  → registry.put({id, req, decision, expiresAt: now+60s})  → ActionPreview
user clicks Approve/Deny → executeAction(id, approved)
  → registry.take(id) (single use; expired/unknown → error)
  → approved && decision.allowed ? execute : {executed:false}
  → Activity{kind:'action', summary, details: outcome}
```
- Previews are generated only from validated inputs. The `summary` names the exact target, for example: `Type 42 characters into "Untitled - Notepad" (notepad.exe)`.
- Execution re-checks policy, so a settings change between preview and execute is honoured.

### 7.2 Policy per `ActionRequest.type`

| Type | Release tier | Allowed when | Mechanism |
|---|---|---|---|
| `list-windows` | First | always (read-only; `requiresApproval:false`) | UIA `RootElement` children: title, process name, pid, rect. No window contents |
| `launch` | First (81) | `target` resolves (case-insensitive) to an entry in `approvedApps`, or a file inside `allowedRoots` | `spawn(exe, [], {detached:true, shell:false})` / `shell.openPath` |
| `open-url` | First | `http(s)`/`mailto` only. In offline mode the preview says "opens in your default browser, which uses the network" | `shell.openExternal` |
| `focus` | First | target window exists and is not elevated | UIA `SetFocus` + `SetForegroundWindow` fallback |
| `move-window` | First (43) | same as focus; rect is clamped to the visible virtual screen | Win32 `SetWindowPos` (DPI-aware: per-monitor v2 coordinates) |
| `type-text` | First, limited | foreground target window named in preview, text ≤ 2,000 chars, approval every time | UIA `ValuePattern.SetValue` on the focused element, else `SendInput` unicode keystrokes. Never `SendKeys` |
| `click` | Experimental (G4) | `allowed:false` until a settings flag exists and G4 passes | `SendInput` mouse at screen coords |

Every type except `list-windows` has `requiresApproval:true`. Approval is never remembered across previews in the first release.

Hard blocks, which return `allowed:false` with a reason:
- elevated or UIPI-protected windows (Windows blocks this anyway), the secure desktop, and UAC prompts;
- password fields (`IsPassword`);
- the Jarvis window itself;
- any action in safe launch mode;
- more than 30 actions per minute.

### 7.3 Native runner
`runner.run(scriptName, inputJson, {timeoutMs})`:
- Spawns `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`.
- The script text, read by main from the packaged `native/` (inside asar, readable by Electron `fs`), is written to stdin, followed by a JSON input line. This avoids asar-unpacking and command-line injection. `-ExecutionPolicy Bypass` applies to this process only and changes no machine setting.
- Caps: timeout 15 s (speech 60 s), stdout 1 MB, one stdout JSON result line, stderr kept only for redacted diagnostics.
- Concurrency 2. The child is killed on timeout and on app quit.
- Win32 P/Invoke uses `Add-Type` with small original C# signatures (`SetWindowPos`, `SendInput`, `GetWindowThreadProcessId`).

Alternative if stdin loading proves fragile: `asarUnpack: ["native/**"]` with `-File`. That needs a `package.json` edit by its owner.

### 7.4 Capsule restore (41–43)
- The contract has no restore-preview call, so the renderer must show the capsule's item and window list with per-item status and an explicit "Restore" button before calling `restoreCapsule(id)`.
- Main processes items in order, re-validating each one with the §7.2 rules for `launch`/`open-url`. File and folder targets must exist and sit inside `allowedRoots` (realpath, case-insensitive prefix, no `..` or symlink escape).
- Unapproved, missing, or blocked targets go to `failed[]` with a reason and are never executed.
- Windows are matched after launch with up to 10 s of polling: `process` equal (case-insensitive), then the title contains the saved title, else the first window of that process. Each match is moved with `move-window` semantics.
- Results are `{opened, failed}`. "Supported" geometry means a top-level, non-elevated, restorable window on a currently connected monitor. Anything else is reported, not faked.
- Saving geometry uses `list-windows` and is user-selected per window.

## 8. Resource budget (low idle)

Idle means the main window is hidden to tray, the island is collapsed or absent, and no request is in flight.
- No `setInterval` polling in the renderer while hidden. The main process may run only scheduled-routine and reminder timers (one `setTimeout` to the next due item, not a tick).
- `backgroundThrottling: true`. CSS and JS animations pause on `visibilitychange`/`blur`, under `reduceMotion`, and on battery saver (`powerMonitor`).
- The island window is created lazily on first use and destroyed after 10 min collapsed (if G1 shows that recreating it is fast).
- Zero PowerShell children at idle. The Ollama model is unloaded by `keep_alive` expiry, and a "Unload model now" control sends `keep_alive:0`.
- **Targets**, measured by `tests/perf` script plus Task Manager:
  - average CPU ≤ 0.5% over 5 min idle;
  - total app working set ≤ 250 MB (Electron baseline is roughly 120–200 MB);
  - 0 wakeups from app-owned timers per minute beyond due items.

## 9. Capabilities (honest status)

`getSystemInfo().capabilities` is recomputed on demand and cached for 30 s.

| id | available when | reason examples |
|---|---|---|
| `local-llm` | Ollama tags reachable on loopback and `localModel` installed | "Ollama not running at 127.0.0.1:11434" |
| `tts` | ≥1 installed voice | "No Windows voices installed" |
| `stt` | ≥1 installed recognizer | "No Windows speech recognizer for en-US" |
| `ui-automation` | runner works and `list-windows` succeeds | "PowerShell unavailable" |
| `cloud` | mode online and key configured | "Offline mode" / "No API key" |
| `secure-storage` | `safeStorage.isEncryptionAvailable()` | "DPAPI unavailable — cloud key disabled" |
| `click`, `ocr`, `vision`, `island`, … | per gate | "Experimental — not enabled" |

The renderer shows unavailable features as disabled with the reason. There are no placeholder outputs, no simulated voice, and no fake activity.

## 10. Feasibility and experimental gates

A roadmap item tagged Experimental, or an Expansion item marked here, ships only behind its gate. A gate is a written benchmark or licence result recorded in `docs/` by its owner.

| Gate | Question | Pass criteria | Blocks |
|---|---|---|---|
| G1 Overlay | Transparent, frameless, always-on-top Electron island on Win11 at 100/150/200% DPI, multi-monitor, fullscreen-app detection | Expand/collapse ≤ 150 ms, no focus stealing, idle delta ≤ 40 MB | 61, 63, 65–67 |
| G2 Local model sizing | Which Ollama models run on 8/16 GB RAM, no GPU | First token ≤ 5 s, ≥ 5 tok/s on reference laptop | 11 defaults, 15, 16, 18 |
| G3 Local ASR upgrade | Permissively licensed Whisper-class runtime, bundled or imported offline | WER better than System.Speech on test set; licence MIT/Apache/BSD | 12 quality, 23, 40 |
| G4 Input injection | Reliable `click`/`type-text` across Win32/UWP/Chromium apps | ≥ 95% on fixture matrix, never into elevated or password targets | 88–90 |
| G5 Windows mods | Licence and safety of each third-party mod (Windhawk-style mods are often GPL) | Catalog links/launches external tools only; no bundled GPL code; reversible | 71–80 |
| G6 Screen capture | `desktopCapturer` region capture + local OCR (Windows.Media.Ocr via WinRT) | Opt-in per capture, nothing stored by default | 24, 25, 29, 39 |
| G7 Avatars/motion | Renderer cost of 2D/3D avatar and motion scenes | Within §8 budget when idle; off by default | 129–140, 69, 70 |
| G8 Signing | Code-signing certificate and update channel | Signed NSIS + verified update + rollback | 117, public beta |

## 11. Roadmap coverage

Tiers: **F** = first personal release (this architecture), **E** = expansion (designed hook, later), **X** = experimental (gate required).

| Group | First release in this design | Expansion hooks | Experimental / gated |
|---|---|---|---|
| Application & onboarding (1–10) | Wizard sets `onboarded`, mode (offline preselected), permissions review of `allowedRoots`/`approvedApps`, hardware checks from capabilities, dashboard, searchable settings (client-side filter), tray + `startInTray`, keyboard nav and focus rings, diagnostics page. Profiles (7) = single local profile | Multi-profile | — |
| Local AI & voice (11–20) | 11 Ollama, 12/13 System.Speech, 14 detect Ollama and guide offline model import via the Ollama CLI (the app does not install Ollama) | 15–19 need contract methods + G2 | 20 fine-tuning: not planned |
| Assistant & screen tools (21–30) | 21 non-streaming until the contract gap closes, 22 PTT, 23 preview-then-insert | 25–30 (OCR, translation, history export reuse §5.4) | 24 behind G6 |
| Memory & journal (31–40) | 31 checkpoints = notes tagged `checkpoint` linked to a capsule, 32 note search | 33–38 via `Activity` (opt-in) | 39, 40 behind G6/G3 |
| Projects & workspaces (41–50) | 41–43 (§7.4) | 44–48 | 49, 50 |
| Everyday productivity (51–60) | 51 tasks, 52 reminders via `Task.due` + `Notification`, 53 focus sessions (recorded in `Activity`) | 54–60 | — |
| Visuals & motion (61–70) | 62 three themes, 64 reduced motion/battery; 61 and 63 only after G1 passes, else an in-window panel | 65–68 | 69, 70 (G7) |
| Windows customization (71–80) | 71/72 only as a read-only catalog of external tools with version notes; no system modification in first release | 73–75 | 76–80 (G5) |
| Routines & automation (81–90) | 81 approved launches, 82 schedules stored with the next-due timer, run through §7 with a per-run approval option | 83–87 | 88–90 (G4) |
| Agents & developer tools (91–100) | none | 91–97 | 98–100 |
| Optional online (101–110) | none in first release; 101 implemented behind online mode is the first Expansion | 101–108 | 109, 110 |
| Installation & ownership (111–120) | 111 NSIS, 112 Electron runtime bundled and offline installer (Ollama/models separate), 113 safeStorage, 114, 115, 116 | 117 (G8), 118 ARM64 (`--arm64` build + test), 119 | 120 |
| Usage dashboard (121–128) | none | local ledger from `Activity` + Ollama `eval_count` | — |
| Avatar studio (129–136), Motion studio (137–140) | none | — | all (G7) |

Missing references: `docs/integrations-hub-plan.md` and the three research documents linked from the roadmap are not in this repository. Their content is not assumed here.

## 12. Security baseline (all windows)

- `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`.
- No `remote` module.
- `setWindowOpenHandler(() => ({action:'deny'}))`, and `will-navigate` is prevented unless the target is the app URL.
- `setPermissionRequestHandler`: allow only `media` audio from the app origin while PTT is active; deny the rest.
- Single instance via `requestSingleInstanceLock`.
- The cloud key is accepted only through `setCloudKey`, trimmed, length-checked, and encrypted immediately. It never touches `state.json`, exports, logs, `Activity`, or prompts. If `safeStorage` is unavailable, `setCloudKey` fails with a reason (no plaintext fallback).
- Logs never contain chat text, typed text, transcripts, or keys.

## 13. Build, packaging, test

- **Build:** `npm run build`, which runs `tsc --noEmit`, then `vite build` to `dist/`, then esbuild to `dist-electron/main.cjs` and `preload.cjs`. The Vite config must set `base:'./'` for `file://` loading (owner of `vite.config`).
- **Package:** `npm run package:win` builds an NSIS x64 installer in `release/`.
  - `oneClick:false` allows choosing the directory. Per-user install is the default (no admin).
  - The uninstaller keeps `%APPDATA%\Jarvis Desktop` unless the user deletes it; this is documented in the help page.
  - The build is unsigned (`signAndEditExecutable:false`), so SmartScreen will warn. That is acceptable for the personal release; G8 covers signing.
- **Tests:** `npm test` runs `node --test tests/*.test.mjs`.
  - Node 22.15 cannot import `.ts`, so tests load pure modules through a helper that bundles them with esbuild (already a devDependency) into `.runtime/test/` (gitignored), then imports them.
  - Keep policy, validation, store, netGuard, routing, and the preview registry free of `electron` imports, with Electron APIs injected, so they are unit-testable.
  - Native scripts get opt-in integration tests (`JARVIS_NATIVE_TESTS=1`) that only touch a test-spawned Notepad window.
- **Repo note:** `.gitignore` does not list `dist-electron/`. That is the config owner's call.
