# Handoff for Claude — 16 October 2026

## Newest instruction: UI revamp authorized
The user has now authorized Codex and browser Claude Code to redesign the product together. Read `planning/ui-revamp/REVAMP-BRIEF.md` for the current complete assignment and acceptance gates. This supersedes the stopped-development instruction only for this scoped Claude Code task. Historical paid API worker loops remain stopped; no payment changes or additional usage-credit purchases are authorized. User rejection below still applies until the redesigned installed experience is accepted.

## User verdict takes priority
The user installed the Windows build and reports that it is extremely difficult to use, the UI/UX is poor, and nothing worked for them. The product is NOT accepted, finished, or ready for commercial release. The exact failing interaction paths have not yet been reproduced. Treat source coverage scores and automated test counts as implementation evidence only, never as proof of a useful or usable app. Do not repeat the previous completion claims.

## Where to work
- jarvis-desktop/: latest canonical Windows Electron/React/TypeScript product source, including independently accepted local recovery.
- control-room/: separate loopback development dashboard/worker runtime. It is not the installed product's agent runtime.
- worker-snapshots/: preserved historical/unintegrated worker source; may be stale or superseded. Compare against canonical, never merge blindly.
- planning/: audit, scope inventory and build evidence. All 140 original requirements remain; not all are implemented.
- Product name is temporary Desktop Companion. Do not brand it Jarvis; historical technical directory identifiers remain.

## First priority
Reproduce the installed user experience and fix complete user journeys before adding more screens. Start with onboarding, navigation, discoverability, settings, error messages and real feature execution. Use design/UX skills where available. Check each control against its actual backend. Remove misleading affordances or label unavailable functionality honestly; do not replace requested behavior with mock panels or prompt previews. The user wants a coherent desktop companion with optional AI/computer-use, motion/customization, voice, avatars and account integrations.

## Runtime/build
Use Node/npm compatible with the committed lockfile. In jarvis-desktop run npm ci, npm test, npm run build, npm run smoke. npm run dev launches Electron; npm run package:win builds the Windows x64 NSIS installer. npm start launches the already-built product. Check package scripts before execution.
Latest source gate: 1,686 tests, build, and 23-route offline smoke passed. Latest unsigned x64 installer also passed packaged smoke with zero renderer errors/external requests. These checks did not validate clean-machine install/uninstall, all real hardware interactions, live OAuth, or live product BYOK usage. Do not mistake large test count for usability.

## Recent accepted code
Named profiles, file shelf, correctable memory associations, document explanation, dictation cleanup, calendar export, battery status/interruptible motion, primary-state/backups encryption, reminder sleep/resume fixes, and actual selected Anthropic/OpenAI/OpenRouter generation adapters. Additional provider methods now use authoritative IPC METHODS/ARITY/ARG_SPECS and trusted dispatch.
Encryption is incomplete: productivity sidecar/preferences still plaintext. Root host-battery motion and keyed scene transition gaps are documented in the audit. Many Windows customization/installed-agent/OAuth/vision/avatar requirements remain incomplete or absent.

## Account and privacy requirements
Each user must connect their OWN Gmail, calendar, Spotify and other supported accounts through provider authorization, with scoped permissions, protected tokens and disconnect/delete access. Developer app registration is separate from end-user accounts; it has not been supplied. Never use shared owner credentials. Product stays offline by default; cloud is optional BYOK with selected-data disclosure and explicit consent.

## Stopped state and money
Development loop and all paid worker authorization were stopped at user request. Do not resume paid workers, inference, payments, auto-reload or purchases automatically. Keys, grants, connection tokens and private budget/runtime state are intentionally NOT in Git. Private local history remains on the original machine; source checkpoint does not transfer spending authority. Failed paid-worker history is retained even where source was subsequently completed locally and independently accepted.

## Verification provenance
jarvis-desktop/docs/loop/PROGRESS.json records accepted slices, not full feature acceptance. planning/App-completion-audit-2026-10-16.* contains an equal-weight implementation-coverage estimate (60.4% at that audit), not production readiness. User rejection supersedes any implication of acceptance. Previous scope flags/percentages are stale. Preserve real security checks; do not change tests to conceal failures. Two date-sensitive test fixtures were corrected by freezing their existing fixture clock, with all assertions preserved.

## What is excluded
No API keys, private runtime ledger, dependencies, generated bundles, installed model weights or installer binaries. Rebuild from source. Do not request secrets in chat. Establish a new plan with the user in Claude before further spending.
