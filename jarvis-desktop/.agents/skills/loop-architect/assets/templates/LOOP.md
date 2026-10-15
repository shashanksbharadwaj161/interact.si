# Loop: <name>

**Owner:** <a human name — every loop has one>
**Type:** <see references/loop-types.md>
**Rollout level:** <L0–L5 — see references/risk-ladder.md>

## Goal (SMVA)
<Specific · Measurable/Verifiable · Achievable — one sentence.>

## Convergence criterion — what "done" means
Given <state>, when the loop runs, then <observable, machine-checkable outcome> is true.

**Proof:** <the exact command / suite / metric that demonstrates it>
> e.g. `pytest tests/auth -q` exits 0, with full output shown.

## Non-goals — what this loop must NEVER do
- <never modify tests>
- <never touch src/payments/>
- <never merge to main>

## Verifier
See VERIFIER.md.
- **Tier:** <T1 / T2 / T3 / T4 / T5 / T6>
- **Can the agent modify it?** **NO** — enforced by <permissions / branch protection / CODEOWNERS>

## Progress metric
<What should improve monotonically — failing-test count, error count, coverage.>
> Without this you cannot tell slow progress from oscillation.

## Constraints
- **Scope:** <repos / branches / paths>
- **Denylist:** <auth, payments, secrets, infra, prod>
- **Immutables:** <tests, CI config, this file, its own permissions>
- **Invariants:** <properties that must always hold>

## Budget
| Cap | Value |
|---|---|
| Per-run timeout | <30 min> |
| Max iterations per item | <3> |
| Daily spend | <$20> |
| Max parallel agents | <set to how many PRs you can honestly review> |

## Cadence
<cron / event trigger / manual>

## Stop rules
1. **Success** — convergence criterion met
2. **Exhaustion** — budget or iteration cap hit
3. **No progress** — same failure 3x → stop
4. **Escalation** — ambiguity, irreversibility, denylisted path
5. **Kill switch** — <where it lives; must be out of the agent's reach>

## Non-convergence policy
<revert / best-effort WITH caveats stated / escalate with full context>

## State
- **File:** `./state/<name>.md` — read at start, written at end, pruned every run
- **Schema:** finding | source | priority | status | attempts | last_seen

## Escalation
See ESCALATION.md.

## Latency-to-detection
Worst case, a mistake becomes visible to a human within: <___>

## Weak spots
- ⚠️ <be honest — list them>

## Promotion criteria
Promote to L<n+1> when: <evidence, not vibes — e.g. "the verifier has rejected >=1 real defect and produced 0 false passes across 20 runs">
