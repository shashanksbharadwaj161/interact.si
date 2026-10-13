# Integrations status

14 October 2026. Working name: Desktop Companion (temporary, no final name). Technical identifiers (`jarvis-desktop`, `window.jarvis`, `Jarvis` in older docs) are kept for compatibility.

This page maps the integrations named in `docs/product-roadmap.md` line 3 (Spotify, browser, ChatGPT, Claude, local models) to what the code does today. It is a status record, not a plan of record. Nothing here is a working integration unless the "Present" column says so, and every "Present" claim names the code that does it.

The roadmap line links to `integrations-hub-plan.md`, which is not in the repository. This page is the current inventory until root decides whether to restore that document or re-point the link.

## Status terms

- **Present**: code exists in this build. Whether it works end to end still depends on the local components or the user's own key, as noted.
- **Partial**: some of the request exists; the rest does not.
- **Planned**: roadmap scope exists (Feature Lab shows it as `planned`), no code.
- **Not in roadmap**: no scope or acceptance item covers it. Adding one is a root decision.

Offline default: the app makes no network request in offline mode. Only a loopback Ollama endpoint is reachable. The only path to a non-loopback origin is `https://api.anthropic.com`, and only in online mode with a stored key (`electron/services/netGuard.ts:23-37`).

## Summary

| Requested | Status | Works offline? | Roadmap scope | What is missing |
|---|---|---|---|---|
| Local model (Ollama) | Present | Yes (default path) | 11 (ui), 14 planned | Model install is manual; no model pack is bundled |
| Claude (Anthropic API, user's key) | Present, untested by behavior tests | No. Cloud is off in offline mode | 101 (ui) | Behavior tests for chat and egress; see below |
| Browser: open a link | Present (handoff only) | Yes as a handoff, with a warning that the browser uses the network | Part of 81 (ui); `open-url` action | None for handoff; page content is never read |
| Browser: tabs, profiles, page content | Not present | n/a | 47 planned, 88 planned | Everything beyond handing off a URL |
| ChatGPT / OpenAI | Not present | No | 102 planned (no provider named) | Adapter, origin allow-list entry, key slot, scope naming |
| Spotify | Not present | n/a | None names Spotify (58 planned is the nearest, media volume) | Scope decision, OAuth/account flow, adapter |

## Local model (Ollama): Present

- Chat routes to a loopback Ollama endpoint, default `http://127.0.0.1:11434` (`electron/services/validation.ts:21`, `electron/services/chat.ts:53-66`). Only `http:` loopback addresses are allowed for purpose `ollama` (`electron/services/netGuard.ts:33-34`).
- There is no fallback. A failure becomes a `source:'system'` message, and nothing is sent elsewhere (`electron/services/chat.ts:105-131`).
- A probe lists installed models through `GET /api/tags` (`electron/services/chat.ts:136-145`).
- Verification evidence: `docs/current-verification.md` records a real Electron smoke against a dedicated loopback Ollama on `127.0.0.1:11435` with model `qwen3.5:2b`. That is a development check, not a user-facing install.
- Limits: Ollama itself, the model weights, and any model download are outside the app. The app never downloads models (`electron/services/chat.ts:50`). Roadmap 14 (local model-pack setup and offline import) and 15-19 are planned.

## Claude / Anthropic (user's API key): Present, behavior not yet tested

- Transport: `cloudChat` posts to `https://api.anthropic.com/v1/messages` with `x-api-key` and `anthropic-version: 2023-06-01`, using `max_tokens: 1024` and the stored model name (`electron/services/chat.ts:12`, `70-80`).
- Key storage: the key is protected with Windows DPAPI through `native/dpapi.ps1` and `electron/services/secrets.ts`. The status call returns only `{configured}`. The key is decrypted per request (`electron/services/chat.ts:119-121`).
- Model name: user-entered in Settings, default `claude-haiku-4-5` (`electron/services/validation.ts:31`, `src/components/Settings.tsx:238`). The UI gates on it, but `sendChat` does not check that it is non-empty.
- Egress: in online mode with a key, only the exact origin `https://api.anthropic.com` is allowed, and only for purpose `cloud-chat`. Credentials in URLs and lookalike hosts are rejected (`electron/services/netGuard.ts:23-37`). Redirects are refused by the `fetch` call (`redirect: 'error'`, `netGuard.ts`).
- Routing: online mode sends to the cloud and never falls back to local. Missing key or failed request returns a system message (`electron/services/chat.ts:110-129`). `docs/product-interaction-review.md` P0-4 reported a silent local fallback. The current `sendChat` does not show one; this should be re-checked once a behavior test exists.
- Offline: cloud requests are blocked (`netGuard` returns "Offline mode: cloud requests are blocked").
- Not tested by behavior: `tests/backend-core.test.mjs` imports `chat` and `netGuard` but asserts nothing about them. The planned `tests/netGuard.test.mjs` and `tests/chat.test.mjs` (`docs/resume-integration-plan.md:89`, `:90`) are not in the repo. Acceptance items C2, C4, C7, K5 are unchecked (`docs/acceptance.md`).
- Scope: roadmap 101 (Anthropic BYOK provider) is `ui`. Roadmap 108 (per-provider data previews and usage history) is planned. Note that the roadmap says "customer-owned Haiku API key" at line 7; the code and UI treat the model as a user-entered name, so the wording should be "customer-owned Anthropic API key".
- Not the same thing: the development Control Room gateway used for building this app is not a product integration. `src/components/Developer.tsx` states the app does not start, embed, or send data to Control Room.

## Browser: Present for handing off a link only

- The `open-url` action accepts `http`, `https`, and `mailto` only. It asks for approval and opens the address with `shell.openExternal` (`electron/services/actions.ts:102-107`, `297`; `docs/architecture.md:193`).
- In offline mode the preview says the link "opens in your default browser, which uses the network" (`electron/services/actions.ts:106`). That browser traffic is outside the app's egress guard. It is not a request the app makes.
- The Computer screen states the page is not read or controlled (`src/components/Computer.tsx:14`).
- Generic window actions exist and can target a browser window: list windows, focus, move/resize, type text, and click. They are not browser-aware. They do not know about tabs or pages, and typed text and clicks go to whatever window the target resolves to. Type-text and click are high risk and need approval.
- Not present: tab listing, profile access, history, cookies, DOM or page reading. Roadmap 47 (browser-profile and tab adapters) and 88 (selected file/browser action adapters) are planned.
- The "Browser preview" in the UI is the renderer-only development bridge (`src/preview.ts`). It is not a browser integration.

## ChatGPT / OpenAI: Not present

- There is no OpenAI code path. In online mode, `netGuard` denies any origin other than the Anthropic origin with "Destination is not on the allow list" (`electron/services/netGuard.ts:36`). A ChatGPT adapter needs a new purpose, a new exact origin, a key slot, and a netGuard test change.
- Roadmap 102 ("Additional optional AI providers") is the nearest scope and is planned. No scope names ChatGPT or OpenAI.
- Handing a chatgpt.com link to the default browser is possible today through `open-url`, under the same handoff rules. That is not a ChatGPT integration.
- Blocker for root: decide whether ChatGPT is a named sub-item of 102 or a separate scope. Provider terms and key handling need review before any adapter is written.

## Spotify: Not present

- No code, no adapter, no references in `src`, `electron`, `native`, or `tests`. Only roadmap line 3 mentions it. `docs/product-interaction-review.md:159` notes that no scope or acceptance item covers Spotify.
- Roadmap 58 (media and per-app volume controls) is planned and does not name Spotify.
- Launching the Spotify app would require it on the approved apps list, and generic window control could then focus it or send keystrokes. That is not an integration and should not be presented as one.
- A Spotify Web API integration would be online-only and needs an OAuth client registered to an owner-controlled account. No account access was used here.
- Blocker for root: add a scope or mark Spotify not in roadmap. Spotify's API terms and the account-owner decision apply before any adapter.

## Blockers and decisions for root

1. Restore or re-point `integrations-hub-plan.md` (roadmap line 3, line 200).
2. Decide whether ChatGPT and Spotify become named scopes.
3. Add behavior tests for `netGuard` and `chat` before marking Claude as verified (acceptance C2, C4, C7, K5).
4. Re-check the product-interaction-review P0-4 finding against the current `sendChat`.

## Validation

- `npm test` baseline on this checkout: 30 tests, 28 pass, 2 fail. Both failures are in `tests/backend-core.test.mjs`: "normalizeAbsolutePath rejects UNC, WebDAV, device, forward-slash variants, ADS, reserved names" and "resolveInsideRoots makes no filesystem call for hostile or out-of-scope targets". I ran the suite twice by mistake (the second run was a duplicate, started in the background, and has finished). I did not investigate the causes, and I did not change any tests or core code. Root or the core worker owns these failures.
- Paths and line references in this document were checked against the checkout after writing. The "missing" items are intentional: `integrations-hub-plan.md`, `tests/netGuard.test.mjs`, and `tests/chat.test.mjs` are referenced as absent or planned.
- This change touches only `docs/integrations-status.md`. Nothing is committed.
- This document only changes `docs/integrations-status.md`. Every code path cited above was read in the checked-in source at this commit.
