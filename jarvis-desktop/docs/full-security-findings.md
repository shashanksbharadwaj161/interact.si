# Full handoff — independent security and acceptance findings

Role: acceptance (session `jarvis-desktop-100`). Owned files: `tests/full-acceptance.test.mjs`, `tests/full-security-regressions.test.mjs`,
`docs/full-result.acceptance.json`, this file. No source file outside these was edited.

Method: every check drives real exported or bundled source. `electron/main.ts` is bundled with a recording Electron stub and run
in a child Node process with its own temporary profile (`%TEMP%\desktop-companion-acceptance-*`, removed afterwards);
`node:child_process` is stubbed so nothing can spawn. No Electron binary, window, microphone, desktop input, network, account or
personal file is used. Open findings are `todo` tests that assert the **safe** behaviour: they report `not ok # TODO` without
failing the suite and flip to `ok` once fixed (then drop the `todo` option).

Status legend: **open** (reproduced, unfixed), **fixed** (test now passes), **gap** (could not be verified here; reason given).

## Summary

| ID | Severity | Area | Status | Test |
|---|---|---|---|---|
| SEC-01 | Medium | 3D / Motion studio exports vs. session policy | fixed (captain, jarvis-desktop-98) | `full-security-regressions` › SEC-01 (fixed) + downloads tests |
| SEC-02 | Low | Navigation guard parity for secondary web contents | fixed (captain) | › SEC-02 (fixed) |
| SEC-03 | Low | Key storage: safeStorage implemented but never wired | fixed (captain) | › SEC-03 (fixed) |
| SEC-04 | Low | Error redaction misses URL / forward-slash / escaped profile paths | fixed (captain) | › SEC-04 (fixed) |
| SEC-05 | Medium | Writing workspace: assistant route statement contradicts the backend route | open (workspace source) | `full-acceptance` › route statement matches the backend (2 todo rows) |
| SEC-06 | Low | Portable memory import: preview counts records the store will refuse; one bad reference sinks a capsule's valid goals | open (workspace source) | `full-acceptance` › SEC-06 |
| SEC-07 | High (build) | Renderer bundle pulls Node-only `electron/services/store.ts` once the workbench is mounted | open (jarvis-desktop-98 integration; fix by 97) | `full-acceptance` › renderer entry bundles for the browser |

## SEC-01 — Studio exports report success while the session cancels every download (Medium, fixed)

- **Trigger:** packaged app → 3D studio → *Export PNG frame* / *Export contact sheet* / *Export scene JSON*, or Motion studio exports
  (scene JSON, PNG, WebM, SVG frame/contact sheet, CSS tracks, lab JSON).
- **Path:** `electron/main.ts` `hardenSession()` — `ses.on('will-download', (e) => e.preventDefault())` cancels all downloads.
  `src/components/Scene3D.tsx` `downloadBlob()` (anchor `download` + blob URL) then sets *"Exported a W×H PNG frame at t s."*
  regardless; same helper in `src/components/MotionStudio.tsx`.
- **Evidence:** test *SEC-01 precondition* emits `will-download` for an app-page `blob:` item against the real main.ts handler: it is
  cancelled. Electron documents `preventDefault()` on `will-download` as cancelling the download.
- **Impact:** untruthful capability. Users believe a frame/scene was saved; nothing is written. The brief requires "truthful exports".
- **Suggested fix (captain owns main/backend/bridges; Fable owns the 3D files):** keep the cancel-all default and add one narrow
  exception, or replace anchor downloads:
  1. *Preferred:* a main-process `saveExportFile(kind, suggestedName, bytes)` IPC: trusted `showSaveDialog` owned by the main window,
     extension allow-list per kind (`png|svg|json|webm|css`), byte cap (e.g. 32 MB), write via `writeChosenFile` (link-safe), resolve
     `{saved: path-basename} | {cancelled}`; the studios set the "Exported …" note only after it resolves.
  2. *Or:* in `will-download`, allow only when `webContents === mainWindow.webContents`, `item.getURL()` starts with `blob:` and the app
     page is trusted; call `item.setSaveDialogOptions(...)`, cap `getTotalBytes()`, report `done`/`cancelled` back to the renderer.
- **Flip condition:** the SEC-01 todo test asserts the app-page blob download is not cancelled; if option 1 is chosen instead, replace
  it with a test of the new IPC (cancel ⇒ no "Exported" note; success ⇒ file written once).

## SEC-02 — Secondary web contents lack the `will-redirect` guard (Low, fixed)

- **Path:** `electron/main.ts` `app.on('web-contents-created', …)` registers window-open, `will-navigate` and `will-attach-webview`
  guards but not `will-redirect` (the main window has all four).
- **Impact:** low today (only one window exists and the session request filter cancels non-dist/non-dev requests), but the defence in
  depth is incomplete for any future auxiliary web contents.
- **Fix:** add `wc.on('will-redirect', (e, url) => { if (!appUrlOk(url)) e.preventDefault(); })` there.

## SEC-03 — Electron safeStorage is implemented in `secrets.ts` but never wired (Low, fixed)

- **Path:** `electron/backend.ts` `new Secrets(native, env.userData)` (no `safeStorage`), `BackendEnv` has no field for it and
  `electron/main.ts` never imports `safeStorage`. `docs/architecture.md` (Secrets row, `secure-storage` capability) states safeStorage.
- **Evidence:** test *SEC-03* stores a key through the real IPC route with a working stub `safeStorage`: it is never consulted and the
  DPAPI PowerShell helper is attempted instead (blocked in the harness, so the vault correctly fails closed).
- **Impact:** every key set/reveal (each cloud stream start) spawns PowerShell; packaged builds depend on the helper manifest for the
  key; documentation is inaccurate. Not a plaintext leak: the fail-closed behaviour is verified by the companion test.
- **Fix:** add `safeStorage?: SafeStorageLike` to `BackendEnv`, pass Electron's `safeStorage` from main.ts, construct
  `new Secrets(native, env.userData, nodeSecretsFs, env.safeStorage)`. Legacy DPAPI blobs stay readable (already unit tested).

## SEC-04 — Error redaction misses common profile-path forms (Low, fixed)

- **Path:** `electron/ipcCore.ts` `safeErrorMessage()` replaces only `X:\Users\<name>` with single backslashes.
- **Trigger:** errors carrying `file:///C:/Users/<name>/…`, `C:/Users/<name>/…` or JSON-escaped `C:\\Users\\<name>\\…` reach the
  renderer and Activity (`uncaughtException` handler) unredacted.
- **Fix:** match `[A-Za-z]:(\\\\|\\|/)Users(\\\\|\\|/)[^\\/\s"']+` (and the `file:///` prefix) case-insensitively.

## SEC-05 — PromptTools tells the user where a Send goes, and is wrong in two cases (Medium, open)

- **Path:** `src/ui/prompt-tools.ts` `describeRoute()` (workspace); `src/components/PromptTools.tsx` shows it and enables *Send to
  assistant* whether or not the key status is known. Real routing: `electron/backend.ts` `chatStreamStart` (online ⇒ cloud,
  offline ⇒ local) and `electron/services/chat.ts` `resolveChatRoute` (online without key ⇒ refused, never local).
- **Trigger A (online, no key):** the window says *"Online mode without a cloud key: the local model answers; nothing leaves the
  computer."* The backend refuses (*No cloud API key is configured*); no local answer is produced. Untruthful, no leak.
- **Trigger B (online, key stored, `cloudConfigured === null`):** `src/ui/store.tsx` starts `cloudConfigured` as `null` and leaves it
  `null` when `cloudKeyStatus` fails. The window then says *"… nothing leaves the computer."* while the backend sends the prompt (with
  the selected note text) to the cloud provider. The privacy statement is false exactly when it matters.
- **Evidence:** the truth-table test drives the real backend (recorded fetch) for each case and compares with `describeRoute`; rows A
  and B fail as described, the other three pass. Reproduced against worktrees `jarvis-desktop-97` and `jarvis-desktop-98`.
- **Fix:** make `describeRoute` mirror `resolveChatRoute`: online + key ⇒ cloud; online + no key ⇒ *"Send is refused: add a key in
  Settings or switch to offline mode"* (and disable Send); online + unknown ⇒ *"may be sent to your cloud model"* and disable Send until
  the status is known. Better: the backend reports the route decision (one source of truth) instead of the renderer re-deriving it.

## SEC-06 — Portable memory preview overstates; one hostile reference sinks valid goals (Low, open)

- **Path:** `electron/services/store.ts` `parsePortable()` (workspace) counts and plans references/shelf items without the store's own
  target validation (`pTarget` → `normalizeAbsolutePath` / `validateOpenUrl`). `capsule.setMeta` replaces the whole list, so one
  refused target fails the entire op.
- **Trigger:** paste an export whose capsule has one UNC reference (`\host\share\x.lnk`), a `javascript:` URL, or a shelf item with a
  relative path or `file:` URL, next to valid goals.
- **Impact:** safety holds (the store refuses every hostile target — asserted), but the preview reports records that never land, and
  the capsule's valid goals/references are lost with the bad one.
- **Fix:** export `validateReferenceTarget(kind, target)` from store.ts (wrapping `pTarget`), call it in `parsePortable`, skip and report
  refused targets, count only accepted records.

## Fix verification (captain, jarvis-desktop-98, 15 October)

SEC-01..04 tests were turned from `todo` into hard regressions and pass with `ACCEPTANCE_SOURCE_ROOT` = jarvis-desktop-98; they fail
(as intended) against sources from before the fix (base `3f63718`, jarvis-desktop-97). Verified behaviour:

- SEC-01: `will-download` for an app-page `blob:`/`data:` export reaches `setSaveDialogOptions` with the sanitized file name under
  Documents (no silent save path); remote/file URLs, blobs from a foreign web contents or with no web contents are cancelled without a
  dialog; test mode (`JARVIS_TEST_MODE=1` + fixture-prefixed temp profile) cancels every download, including studio exports.
  *Residual (Low, renderer, not tested here — no DOM):* the studios set "Exported …" right after the click, before the user picks a
  location or cancels the Save dialog. Suggest wording such as "Export ready — choose where to save it" unless main reports `done`.
- SEC-02: secondary web contents cancel `will-redirect` away from the app.
- SEC-03: the key is stored through Electron `safeStorage` via the real IPC route with zero child processes.
- SEC-04: `file:///C:/Users/x`, `C:/Users/x`, JSON-escaped and `\?\` forms are redacted.

## SEC-07 — Renderer imports Node-only store code after workbench integration (High for the build, open)

- **Trigger:** jarvis-desktop-98 mounts `MemoryWorkbench`; the renderer import chain reaches `electron/services/store.ts`, which imports
  `node:fs`, `node:path`, `node:crypto` (also `paths.ts`, `policy.ts` → `node:path`). `vite build` fails; in a sandboxed renderer these
  imports cannot work at all.
- **Evidence:** the renderer-bundle test (browser platform, Node built-ins recorded) passes for base, 97 and 99 and fails for 98 with
  exactly these imports.
- **Fix (workspace 97, being done):** move `parsePortable`/`exportPortable`/types the renderer needs into a Node-free module (or behind a
  productivity bridge method) so `src/` never imports `store.ts`.

## Verified safe (passing regressions)

- Packaged window: context isolation, sandbox, no node integration in frames/workers, web security, no insecure content, devtools off,
  application menu removed, no child process at boot, exactly one IPC handler per channel-table method.
- Navigation: window-open denied; remote, other-file and UNC navigation and redirects cancelled; webviews refused.
- Session filter (offline egress from the renderer): Anthropic, the Ollama port (also in development), a LAN dev server, other files,
  UNC and encoded traversal out of `dist` cancelled; only `dist`, `data:`, `blob:` and the loopback dev origin pass.
- Permissions: only audio-only media for the app page; video, mixed, remote, notifications, clipboard and geolocation refused.
- IPC: remote, other-file and sub-frame senders refused before any handler; arity enforced; fresh profile is offline.
- Cloud key via real IPC: never in state, never plaintext on disk, never in the error; fails closed without a protector.
- Offline egress (whole backend, key stored): chat, streamed chat, model listing/overview, API/system info, intent planning, search,
  routine model planning and every listed integration check reach nothing but the loopback model; no credential header on loopback.
- LAN/public/https/credentialed local-model endpoints refused; enabling online mode needs the trusted confirmation (declined ⇒ stays
  offline). The backend never falls back between cloud and local on its own.
- Portable import: `__proto__`/`constructor` keys, wrong types, oversized text, newer or string versions and future times are refused,
  clamped or ignored; `Object.prototype` is untouched.
- 3D renderer: no GPU allocation across 120 frames of quality/object/size changes; dispose releases every object after context loss and
  is idempotent. Hostile scene JSON is clamped to the published limits, unknown fields dropped, fallback SVG stays finite, padding
  counts toward the byte cap.

## Gaps (not verifiable here)

- Real Electron runtime behaviour (download cancellation, permission prompts, GPU) is inferred from the real handlers plus Electron's
  documented semantics; no Electron binary was run (`npm ci --ignore-scripts`).
