# Verifier — Desktop Companion iterative implementation

## What says no

TypeScript compiler, behavioral tests, renderer/Electron build, offline Electron smoke, installer build and actual Windows acceptance. A Fable planner's approval or a worker summary is not a verifier. The complete 140-entry inventory and manual acceptance cannot be replaced by the number of passing tests.

## Tier and current baseline

**T4** for worker-executed commands with retained raw output; independent coordinator checks are stronger but do not make writable tests immutable. Smoke is partial. Operator observes hardware/UI/account gates. Current coordinator report is **1266 passing source tests**; fresh combined build and 23-route offline smoke pass; fresh x64 installer build passes; install/uninstall lifecycle and hardware/account acceptance remain unverified, so this is not a release pass.

## Exact checks

Run from the application repository root, not a stale worker worktree:

1. `npm run typecheck` — exit 0; no ignored TypeScript failures.
2. `npm test` — full suite exit 0, record totals/skips/TODOs and full output. Review changed assertions; do not weaken acceptance to obtain green.
3. `npm run build` — exit 0 with current renderer and Electron artifacts.
4. `npm run smoke` — exit 0 using actual Electron and isolated temporary profile; inspect assertions for offline persistence, IPC and zero external requests. Missing Electron binary/runtime is a blocker, not a pass.
5. `npm run package:win` — exit 0 and new installer artifact with source commit, timestamp, size and SHA256. A pre-existing installer is not evidence for current source.
6. `python .agents/skills/loop-architect/tools/loopcheck.py spec docs/loop` — validates document anatomy only, never app behavior.
7. Reconcile each registry ID with implementation, integration, actual evidence and limitation. Audit docs/acceptance.md and registry G1–G8 (or newly defined gates) without checking unobserved items.

Record source commit, command, environment, exit code, unedited output location and time. An independent controller should launch exact commands and inspect the actual artifacts; do not accept only prose claims. Run focused checks after small changes; run combined verification at integration boundaries, without gratuitous repeated full builds.

## Immutability / anti-cheat

- **Not enforced:** workers share the same user and can technically edit tests, configuration and docs. Assignment restrictions do not provide filesystem immutability.
- No held-out inaccessible suite is established. No claim of malicious-worker isolation.
- Existing explicit user authorization covers reversible source development; successful tests do not authorize production release or waive product-side confirmations.
- Integration review must inspect test deletions, skipped assertions, fixtures changed to match bugs, disabled privacy checks, altered scripts and generated evidence claims.
- A stronger independent gate requires acceptance checks outside worker write permissions plus coordinator/CI execution. This remains an explicit follow-up, not a condition falsely marked already achieved.
- Workers can honestly report impossible/blocked tasks without pretending completion. Keep genuine failures and external acceptance pending.

## Known blind spots

Passing tests do not demonstrate pleasing motion, accessibility with Narrator, reliable microphone/voice across hardware, screen/DPI/multi-monitor behavior, reliable Windows injection across applications, model throughput on every laptop, OAuth flows without accounts, signed installer trust or license clearance. Static UI assertions do not prove a mounted working screen. Link launch does not prove provider integration. A successful installer build does not prove clean install, upgrade, uninstall or signing. Full 140-feature acceptance requires those separate observations.

## Liveness check

For each integration cycle record whether the verifier rejected a real candidate in the last five runs, with failing command and raw output. If none, record **not demonstrated**; do not invent a rejection or assume a checker that never says no is healthy. The earlier source checks caught actual test/type failures, but this design does not independently attest which belong to the latest five runs. Failure fingerprints and three-attempt no-progress detection must use actual errors, not model opinion.

## Product acceptance and stop evidence

Only mark verified what the recorded check observes. For blocked hardware/account/signing steps, save exact operator instructions and expected result; continue unrelated work. The controller terminates on genuine full success, global-budget exhaustion, repeated no-progress or operator stop, with explicit unresolved scope. Never convert a partial/experimental capability into a completed one to terminate the loop.

