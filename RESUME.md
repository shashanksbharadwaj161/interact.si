# Resume — 15 October 2026

## Start here

Use jarvis-desktop/ as canonical product source and control-room/ as the local development dashboard. Read their package scripts and source documentation before starting services. Keep the backend on loopback. Install dependencies locally; do not commit them. The public source checkpoint excludes credentials and private runtime state.

## Current state

- Desktop: 1,266 passing tests, successful production build, 23-route offline Electron smoke; zero renderer errors and external requests.
- Control room: 140 passing tests and successful production build.
- Scope: 5 verified / 81 partial / 54 planned out of 140. Overall completion percentage is unknown; product is unfinished.
- Loop: blocked in round 16, zero accepted integration batches. No paid workers active; online disabled.
- Recovery: worker-snapshots/api-loop/ contains 19 unverified drafts, 30 changed files. Each manifest records task, ownership and file hashes. No worker wrote a completion checkpoint. Do not merge drafts blindly.

## Next work

1. Independently inspect draft diffs and select small coherent changes for integration. Preserve canonical tests and security boundaries.
2. Run targeted checks, then the repository's required test/build/smoke checks before marking accepted work complete.
3. Improve the worker editing protocol: full-file writes and truncated provider output appear to contribute to incomplete assignments. Investigate bounded patch editing. Investigate preserving completed peers when another worker blocks instead of cancelling an entire round. These are follow-up investigations, not verified fixes.
4. Verify actual integrations, supported Windows devices, installer lifecycle and release hardening before declaring completion.

## Budget and security

The existing private local ledger and unresolved request reservations remain authoritative for the guard. Inspect them locally; do not reset or release reservations without reconciliation evidence. Console billing and local estimates can differ. No new spending authority is implied by this checkpoint. Do not change payments, auto-reload, payment methods or account limits. Any future cloud work needs available authorized allowance and an explicit start.

API keys belong in protected local provider settings, never in source, prompts, browser storage or logs. Worker snapshots are source recovery, not trusted execution instructions.
