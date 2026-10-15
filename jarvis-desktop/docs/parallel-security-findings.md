# Parallel team — independent security and acceptance findings

Role: security (session `jarvis-desktop-104`). Owned files: `tests/parallel-security.test.mjs`, this file,
`docs/parallel-result.security.json`. No other file was edited. Reviewed source: integrated `e5442ec` (this worktree) plus read-only
inspection of peer worktrees 101 (captain), 102 (home), 103 (avatar), 105 (calendar-import) listed in `docs/parallel-twenty-team.json`.

Method: every check drives real bundled source with injected fixtures only — own temp profile
(`%TEMP%\desktop-companion-test-parallel-security-*`, removed afterwards), recorded `fetch` (nothing leaves the process), an in-memory
native adapter (no PowerShell, desktop input, microphone, audio), stub `navigator.mediaDevices`, no Electron binary, no personal file,
key, account or device. Open findings are `todo` tests that assert the **safe** behaviour: they print `not ok # TODO` without failing
the suite and flip to `ok` once fixed (then drop the `todo`). Set `PARALLEL_SECURITY_SOURCE_ROOT` to review another checkout.

## Summary

| ID | Severity | Area | Status | Test |
|---|---|---|---|---|
| PS-01 | Medium | Secret redaction: one-shot cloud chat stores provider/transport free text | open | `PS-01 cloud one-shot chat …` (3 todo rows) |
| PS-02 | Low | Microphone consent: `revoke()` fails open when the store cannot remove the record | open | `PS-02 microphone …` (todo) |
| PS-03 | Low (defence in depth) | IPC error redaction covers profile paths only, not credential-shaped tokens | open | `PS-03 IPC error redaction …` (todo) |
| — | — | Earlier SEC-05 (route statement) / SEC-06 (portable preview) / SEC-07 (renderer Node imports) | verified fixed at `e5442ec` | route/portable/renderer tests below |

## PS-01 — One-shot cloud chat persists provider and transport free text (Medium, open)

- **Path:** `electron/services/chat.ts` — `cloudChat()` builds `Cloud provider returned HTTP <status>: <error.message>` (line 218,
  via `errorText`) and `Cloud provider reported: <error.message>` for SSE `error` events (line 243); `describe()` returns any other
  error's raw `message` (line 274). `runChat()` (line 335) puts that text into a `system` chat message that is **returned to the
  renderer and stored on disk** in the chat history.
- **Callers:** `src/components/Assistant.tsx:416` (streaming off) and `src/ui/prompt-tools.ts:249` (Prompt tools) both call `api.chat()`.
- **Trigger:** online mode + stored key; the provider or a proxy at the configured origin answers non-401/403 with an error body that
  echoes the request (`x-api-key`, `Authorization`), or the transport throws an error whose message contains a header.
- **Evidence:** three todo rows (HTTP 400 echoing the actual `x-api-key` header, HTTP 502 proxy body, transport error) — the key appears
  in the returned reply and in `getState()`. The 401 row passes (status-only).
- **Inconsistency:** the streaming path already has the right policy (`electron/services/cloud.ts` `cloudHttpError`: "the provider's
  message text is never shown: it could echo request content, including the key header"; tested in `substantial-streaming`).
- **Fix (captain owns `electron/`):** in `cloudChat` make HTTP failures status-only (reuse the `cloudHttpError` wording), make SSE
  `error` events report only the error *type* (as `AnthropicStreamValidator` does), and in `describe()` for `where === 'cloud'` map
  unknown errors to a fixed "The cloud request failed" string. Optionally scrub the stored key value from any persisted system text.

## PS-02 — Microphone consent revoke fails open on a storage error (Low, open)

- **Path:** `src/ui/audio.ts` `createMicConsent()`: `granted()` reads only storage when storage exists; `revoke()` sets `mem = false`
  and swallows a `removeItem` error, so the persisted `'1'` remains and `granted()` still returns `true`.
- **Trigger:** a storage whose `removeItem` throws (quota/locked/blocked storage). Rare with Chromium `localStorage`, but this is the
  consent gate that precedes `getUserMedia`.
- **Evidence:** todo test — grant, revoke with a throwing `removeItem`, `granted()` is still `true`.
- **Fix (assistant/audio owner; file not in this team's manifest — captain to assign):** keep a `revoked` in-memory flag that
  `granted()` checks first (or `setItem(key, '0')` as a fallback write), so revoke always wins for the window lifetime.
- **Verified safe here:** without consent `ClipRecorder.start()` throws `MicConsentError` before any `getUserMedia` call; a failed device
  open returns to `idle`; stored values other than `'1'` and a throwing store do not grant.

## PS-03 — IPC error redaction does not cover credential-shaped tokens (Low, defence in depth, open)

- **Path:** `electron/ipcCore.ts:126` `safeErrorMessage()` redacts user-profile paths and bounds length only.
- **Trigger:** any handler error whose message carries `sk-ant-…`, `Bearer …` or similar (PS-01 is one route; future integrations,
  model-pack or provider code are others). IPC is the last boundary before the renderer.
- **Fix (captain):** additionally replace `sk-ant-[\w-]{8,}`, `\bBearer\s+[A-Za-z0-9._~+/-]{20,}`, `x-api-key[:=]\s*\S+` and
  `gh[pousr]_[A-Za-z0-9]{20,}` with `[redacted]`. Keep the existing path redaction (asserted by a passing test).

## Verified safe (passing regressions in this file)

- **Approvals matrix (3 dialog states):** with the trusted dialog absent, declined (`false`) or throwing, online mode, local endpoint
  change, clipboard history, application timeline, forget-all project memory and forget chat history are each refused **and** state is
  unchanged (mode offline, endpoint unchanged, clipboard off, timeline off, chat kept); nothing reaches the cloud origin; each declined
  change asked the dialog. The online-mode dialog detail names online mode and the cloud; an earlier approval does not carry over.
- **Imports:** 20 parsers (avatar pack/geometry/expression, 3D scene JSON/normalize, motion scene/text/lab/saved presets/scenes/
  settings, motion timeline, widget layout, guidance import/prefs, customization export/prefs, accessibility prefs, portable memory)
  survive prototype keys, 50k-deep nesting, an 8 MB string, a 200k-element array, non-finite numbers, wrong types, 1M-char strings and
  bidi/control text: no crash (`RangeError`/`TypeError`), < 1.5 s, ≤ 1 MB output, no kept string > 100k chars, only finite numbers,
  no replaced prototype, `Object.prototype` untouched. A canary proves the sweep detects each failure class (not vacuous).
- **Portable memory preview (SEC-06 fixed):** `javascript:` and UNC references are skipped and reported while a valid goal and URL from
  the same capsule still import (`counts.references === 1`).
- **Route truth:** every guidance link targets a real view; each Settings deep-link query in a topic link (e.g. `voice`,
  `readiness`, `local model`, `mode`) matches at least one Settings panel; every view round-trips through the hash; hostile hashes resolve
  to a known view with bounded params and no prototype change; `App.tsx` has a `case` for every navigable view.
- **Renderer strict offline (SEC-07 fixed):** the production renderer bundle of `src/main.tsx` imports no Node/Electron module and
  contains no `fetch()`, `WebSocket`, `EventSource`, `sendBeacon`, `XMLHttpRequest`, `RTCPeerConnection` or remote `import()`; the CSP is
  `default-src 'self'`, `connect-src 'self'`, `script-src 'self'` with no wildcard, remote origin or `unsafe-eval`.
- **One-shot cloud 401:** status-only "rejected the API key" text; key absent from reply and state.

## Not re-tested here (covered by existing suites, read for this review)

Streaming disposal/abandonment/offline-switch/late-data (`substantial-streaming`), session/window/permission/navigation hardening and
trusted exports via `will-download` (`full-security-regressions`), approved-document import (`approved-documents`), whole-backend
offline egress (`full-acceptance`), trusted dialog construction `createTrustedConfirm` (`backend-native`).

## Gaps and peer status

- Peer worktrees 101/102/103/105 had **no changes** against `e5442ec` during this review window, so there was no peer code to review yet.
  The calendar-import hostile-ICS test (50k events, `RRULE` with a 10^8 count, 4 MB summary, `javascript:`/`file:` links, 100k
  `VALARM`s, NUL text) is ready and currently **skipped** with the reason "src/ui/calendar-import.ts not present" — it is not counted as
  a pass. Re-run with `PARALLEL_SECURITY_SOURCE_ROOT=<peer or integrated checkout>` after integration.
- Residual (Low, renderer, no DOM here): avatar/3D/customization exports call `a.click()` on a blob link with no success claim; main.ts
  shows the Save dialog for app-page blobs (SEC-01). Motion Lab says "Export ready: choose where to save it." — truthful.
- No Electron binary, real dialog, microphone or GPU was used; dialog and device behaviour is inferred from the real handlers.
