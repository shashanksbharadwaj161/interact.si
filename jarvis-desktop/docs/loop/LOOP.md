# Loop: Desktop Companion iterative implementation

**Owner:** SHASH (operator); Codex configures the controller; one Fable planner coordinates implementation.
**Type:** Bounded feature implementation and repair, followed by evidence-backed integration.
**Rollout level:** Existing user authorization permits unattended reversible repo-local development. This is not independent release acceptance. Loop Architect readiness ceiling is L1 until permission-enforced verifier immutability is added; source changes remain reviewable local drafts. No deployment or production auto-merge.

## Goal

Complete the 140-entry scope in GOAL.md and the source registry through small integrated, tested changes. Optimize for a working end-to-end Windows application, not number of worker sessions. Preserve unfinished items and external acceptance gates honestly.

## Convergence criterion

An iteration converges only when its bounded feature/fix is integrated, its exact behavior tests pass, and no new regressions appear. The full product converges only when all 140 entries have genuine implementation/integration/evidence, the combined build and smoke pass, the fresh installer is verified, and relevant account/hardware/manual gates are accepted by the operator.

**Proof:** From application root run `npm run typecheck`, `npm test`, `npm run build`, `npm run smoke`, and `npm run package:win`; retain exit codes and raw output tied to the source commit. Reconcile all registry entries with actual evidence and docs/acceptance.md. Passing a test count alone never proves this full criterion. Manual-only gates cannot be auto-passed.

## Verifier

See VERIFIER.md. Deterministic tools exist, but current worker-produced evidence is **T4** because workers can edit and select checks. Independent coordinator reruns strengthen confidence; smoke remains partial. No claim of a permission-protected independent oracle.

**Can the agent modify it?** Yes: same-user workers can technically modify tests and docs. Path ownership is a coordination rule, not an OS sandbox. Existing explicit authorization permits source drafting; it does not make the verifier immutable or certify release readiness.

## Progress metric

Per iteration retain feature IDs, failing assertions/type errors before and after, merged files/commit, raw check results and newly verified runtime paths. Main metric is previously missing end-to-end behavior now supported by evidence. Distinguish implemented, integrated, runtime-verified, and externally blocked. Do not turn 5 verified registry flags into a percentage of app completion or increase status solely because a test file was added.

## Constraints

- Scope: this Desktop Companion repository and specifically assigned source worktrees. One integration owner writes shared contracts and merges; workers receive disjoint paths and interface prerequisites.
- Denylist: private Control Room runtime, credential files, personal data, global installs/settings, purchases, production accounts, real desktop input, GitHub push/deploy unless separately authorized.
- Immutables by policy: baseline acceptance assertions, goal scope, gateway spending enforcement and operator stop controls. Actual permission-layer immutability is not established; do not claim otherwise.
- Invariants: offline default, no silent cloud fallback, protected secrets, trusted product action confirmation, original/permissively licensed code, precise capability failures.
- No speculative worker spawning. Fable planner may request at most three disjoint workers through controller tools, not by creating uncontrolled nested runtimes. Only integration owner updates shared source.

## Budget

| Control | Required value |
|---|---|
| Shared lifetime development ceiling | $500 total, preserving all historical charges and uncertain reservations |
| Protected global buffer | $50; inference reservations may not exceed $450 committed/reserved |
| Per-task financial caps | None; use only the shared global guard, never create artificial task budget stops |
| Parallelism | One Fable planner plus at most three workers; four model sessions total |
| No-progress limit | Three consecutive attempts with the same failure fingerprint and no new accepted evidence |
| Time boundaries | Each child assignment is finite; controller must bound hung operations and inspect liveness before any replacement |

The gateway/controller, not prompt text, must enforce the global cap/buffer and fan-out. These are required configuration values, not proof they are already active. No budget file was modified by writing this design. Never reset the ledger, discard uncertain reservations, or treat console credit as proof of unspent development allowance.

## Cadence

Start with current source, latest observations and unresolved errors. Plan the next dependency-ready batch; assign up to three small disjoint tasks. Revisit on child completion/error and bounded controller polling (target 60 seconds), integrate accepted results, independently run focused checks, update state, then choose the next batch. Do not poll by making empty paid model calls. Reuse results and short handoffs instead of replaying huge contexts. Planner completion is a checkpoint, not a reason to abandon queued scope.

## Stop rules

1. **Success:** all full-product convergence evidence exists, including operator acceptance; otherwise record only iteration success and continue eligible backlog.
2. **Exhaustion:** shared $450 usable allowance cannot reserve the next request, provider credits are unavailable, or an operational timeout cannot be recovered. Cancel/revoke child work and preserve evidence. Do not bypass the guard.
3. **No progress:** same failure fingerprint across three attempts without improved evidence, oscillating/reverted fixes, or repeated tool failures. Save the smallest repro and stop that item; continue other independent items if useful and funded.
4. **Escalation:** operator hardware/microphone/DPI/input matrix, OAuth credentials, signing/license decisions, ambiguous requirements, or actions outside authorization. Report exactly what is needed; continue independent development first. Routine coding decisions are not input requests.
5. **Kill switch:** user stop command or external Control Room disable/cancel. Stop controller scheduling and cancel children. Workers must not modify this control. Same-user process isolation is limited; an OS-enforced out-of-reach kill switch is not proven.

## Non-convergence policy

Preserve worktrees and local checkpoints; never discard someone else's changes. Integrate only checked changes. Keep failing output and feature status unresolved, not completed. After context exhaustion start a fresh bounded task from saved evidence; never retry a permanently overlong conversation. Budget policy errors are permanent stops, not retryable network failures. Recover transient network failures with bounded retries, without claiming progress.

## State

Read GOAL.md, VERIFIER.md, registry and latest docs/loop/OBSERVATIONS.md at start. Controller/runtime owns OBSERVATIONS; this design does not overwrite it. Persist task ID, model, feature IDs, owned paths, prerequisites, attempts, failure fingerprint, checks, source commit, result, limitations and next action. Keep a concise current snapshot and retain linked raw output/audit history. Do not put secrets in state.

## Escalation

Notify SHASH only on completion, meaningful failure, exhausted allowance, no-progress exit or a specific unresolved operator decision. Include actionable inputs and preserved work location. Do not repeatedly request permission already granted for repo-local development. A blocked task must say budget/context/hardware/account, not generic Needs input.

## Latency-to-detection

Target controller detection is within 60 seconds plus one bounded in-flight request. This is a design target, not measured proof; record actual detection delay when failures occur. Human notice has no guaranteed latency while the operator is away. No changes reach production automatically.

## Weak spots and promotion

Readiness self-audit: **12/29 evidenced**, conservative; checker immutability, held-out suite, sandboxing, immutable audit and independent kill-switch enforcement are not established. The hard immutability blocker caps skill-rated unattended verification at L1. User-authorized development continues as reviewable drafting, not automatic product certification. Before stronger release autonomy, protect the acceptance suite outside worker write access, rerun it independently and record genuine defect rejections and hardware gates.
