# Worked Examples

Four designs and two refusals. Study the refusals — they are the point.

## Contents

- Example 1 — Flaky-test loop
- Example 2 — Dependency-update loop
- Example 3 — `/goal`-driven refactor
- Example 4 — Content QA loop
- Refusal 1 — "Make the UI better"
- Refusal 2 — "Auto-fix production incidents"

---

## ✅ Example 1 — Flaky-test loop (a strong loop)

**User asks:** *"Can an agent triage our flaky tests overnight? We have about 40."*

**The gate.** *"When it says a test is flaky, what proves it?"* → *"Run it 20 times; if it passes and fails without a code change, it's a flake."*
**Verifier: T1.** Deterministic, independent, and repeatable. Proceed.

**Can the agent edit the checker?** The test files — yes, currently. **Fix first:** make `tests/` read-only to the agent.

```markdown
# Loop: flaky-test-triage
Owner: @priya   Type: Flaky-test loop   Rollout: L3 (act with approval)

## Goal (SMVA)
Classify every failing test in CI as flake / real bug / env issue, and quarantine the flakes.

## Convergence criterion
Every test in `state/flaky.md` has a classification backed by a 20-run result.
Proof: `scripts/rerun.sh <test> 20` output attached to each entry.

## Non-goals
- NEVER modify a test's assertions
- NEVER delete a test
- NEVER "fix" a flake by adding a retry

## Verifier
20x repeated execution in CI — T1. Agent cannot modify `tests/` (CODEOWNERS).
Blind spot: a test that is flaky only under production load.

## Progress metric
Count of unclassified failing tests. Must decrease each run.

## Stop rules
success · budget exhausted · same test unresolved 3x → escalate · kill switch

## Weak spots
⚠️ Quarantining a flake hides a real intermittent bug. Quarantine expires after 14 days
   and auto-reopens as a P2 ticket.

## Rollout
L3. Promote to L4 when the verifier has correctly rejected >=1 misclassification in 20 runs.
```

---

## ✅ Example 2 — Dependency-update loop (strong verifier, high blast radius → gate it)

**The gate.** *"What proves the bump is safe?"* → *"Build + full test suite in CI."* **T1.** Proceed.

**But name the blind spot:** a green suite **does not detect a malicious package.** Do not make supply-chain trust depend on test pass/fail alone.

**Design decision:** the verifier is strong, the blast radius is high → 🟡 **gate the action.**

```markdown
# Loop: dependency-update
Owner: @sam   Type: Dependency-update loop   Rollout: L2 (draft PR only)

## Convergence criterion
All deps within one minor of latest AND `npm test` + `npm run build` exit 0 in CI.

## Non-goals
- NEVER auto-merge
- NEVER touch `.github/workflows/**`   ← CI secrets live here
- NEVER bump a major version

## Verifier
CI build + full suite — T1. Agent cannot modify CI config (branch protection).
⚠️ Blind spot: mechanically blind to malicious packages.

## Extra gates (because of the blind spot)
- 7-day release cooldown before any bump is eligible
- Provenance / publisher check
- Human merges. Always.

## Weak spots
⚠️ A green test suite is not a safety proof for supply chain. The cooldown is doing
   more work here than the verifier is.
```

---

## ✅ Example 3 — `/goal`-driven refactor (upgrading a weak evaluator)

**User asks:** *"I'll just use `/goal` to run a big refactor until it's done."*

**The gate.** *"What decides it's done?"* → *"The `/goal` evaluator."*
**Verifier: T5.** ⚠️ That evaluator reads the transcript; it does not run commands. **This is a loop controller, not a checker.**

**Don't refuse — upgrade it.**

```markdown
## Verifier — upgraded from T5 to T4, then backed by T1

/goal condition (T4 — worker runs it, raw output surfaced):
  "`npm run typecheck` and `npm test -- --run` both exit 0, with full output shown.
   No file under `tests/` or `*.config.*` is modified.
   Stop after 15 turns."

Real gate (T1): CI on the PR. The agent cannot narrate around CI.

## Why
/goal decides "keep going?" — CI decides "is it correct?"
Never let the transcript judge be the merge gate.
```

---

## ✅ Example 4 — Content QA loop (useful, but not a truth machine)

**User asks:** *"Can an agent keep our docs and knowledge base clean every week?"*

**The gate.** *"What proves an edit is correct?"* → *"Links pass, docs build, frontmatter matches schema, stale pages are flagged if they reference APIs removed from the OpenAPI spec."*
**Verifier: T2.** Deterministic but partial. Proceed as a draft loop, not an unattended truth editor.

```markdown
# Loop: content-qa
Owner: @maya   Type: Content QA loop   Rollout: L2 (draft PR)

## Goal (SMVA)
Find broken links, invalid frontmatter, stale API references, and missing owner metadata in docs.

## Convergence criterion
`npm run docs:check` exits 0 and every stale-reference finding is either linked to a draft PR or marked "needs human fact check."

## Verifier
Docs build + link checker + OpenAPI reference check — T2.
Blind spot: factual correctness of prose and product positioning.

## Non-goals
- NEVER invent facts or rewrite product claims without a source
- NEVER publish directly
- NEVER delete pages without owner approval

## Progress metric
Open docs findings count. Must decrease each run.

## Weak spots
⚠️ The checker can prove format and references, not truth.
   → uncertain claims are escalated to the page owner.
```

---

## 🔴 Refusal 1 — "Make the UI better"

**User asks:** *"Can I loop an agent to improve our UI until it looks good?"*

**The gate.** *"What proves it looks good?"* → *"...I'd know it when I see it."*
**Verifier: T6.** None.

**Refuse — and say why plainly:**

> There's no oracle here. "Looks good" is not a condition a machine can evaluate, so the loop has nothing to converge *to*. It will oscillate — changing things, re-changing them — and bill you for every turn. Subjective goals do not converge.
>
> **What I'd build instead:** a *generator*, not a loop. Have the agent produce 5 variants against a written design spec, screenshot each, and stop. You pick. That's one turn, bounded cost, and a human does the only judgment that exists.
>
> **What would change my answer:** an objective proxy — Lighthouse scores, contrast ratios, a design-token conformance check, a visual-regression suite. Give me any of those and we have a T1/T2 verifier and a real loop.

---

## 🔴 Refusal 2 — "Auto-fix production incidents"

**User asks:** *"Can it detect an incident and fix prod automatically?"*

**The gate.** *"What proves the fix worked?"* → *"The alert clears."*
That sounds like a verifier. **It isn't.** The alert clearing proves the *symptom* stopped — not that the cause was fixed, and not that nothing else broke. Restarting a service clears the alert too.

**Verifier: T6 for correctness.** **Blast radius: maximal** — the system is already degraded, the safety margin is already spent, and there may be no rollback. Treat any incident-response benchmark number as tool- and benchmark-specific; cite it before using it publicly.

**Grid position: 🔴 weak verifier + high blast radius → DO NOT LOOP.**

> I won't design this as an autonomous loop. An agent acting unsupervised on a system that is *already broken*, with no way to prove it helped, is the worst configuration in this entire skill.
>
> **What I'd build instead — a read-only incident loop (L1):** it correlates alerts, pulls the relevant logs and recent deploys, builds a timeline, ranks hypotheses, and drafts the postmortem. It wakes a human with all of that in hand. This is genuinely valuable and completely safe, because it **cannot act**.
>
> **The one exception:** pre-authorized, narrow, *reversible* runbooks ("restart service X if health check Y fails, max once per hour, then escalate"). That is not the agent deciding — that is you deciding in advance, and the agent executing.

---

## The pattern in all six

Every one turned on the same question, asked first:

> **"When it says it's done — what, other than a human, can prove it?"**

Strong answer → design the loop.
Weak answer → **upgrade the verifier before designing anything.**
No answer → **refuse**, and offer the assistant instead.
