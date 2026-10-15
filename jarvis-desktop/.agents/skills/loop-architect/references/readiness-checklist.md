# Loop Readiness Checklist

Score the design before it runs. **Report the score and the ceiling it implies — don't soften it.**

Each item is 1 point. **A ✋ item is a hard blocker: if it fails, the loop cannot be promoted past L1, whatever the total.**

---

## 1. Verifier (the section that decides everything)

- [ ] ✋ **There is a checker that can fail the work without a human in the room.** *(No → T6 → this is not a loop.)*
- [ ] ✋ **The agent cannot modify the checker** — tests, rubric, CI config — enforced by **permissions**, not instructions.
- [ ] The verifier is **T1–T3** (independent, or it runs the check itself).
- [ ] The verifier **acts** rather than reads — it runs the command and shows raw output.
- [ ] A **held-out** check exists that the agent never sees.
- [ ] The verifier's **blind spot is written down**.
- [ ] The verifier **has rejected something** in the last 5 runs. *(Never rejected ≠ lenient. It means broken.)*

## 2. Goal & convergence

- [ ] The goal is **SMVA** — specific, measurable/verifiable, achievable.
- [ ] ✋ **The convergence criterion is observable and machine-checkable** — the *proof* is written, not the intent.
- [ ] A **progress metric** exists. *(Otherwise you cannot tell slow progress from oscillation.)*
- [ ] **Non-goals** are listed — at least three.

## 3. Constraints & safety

- [ ] Scope is bounded — named repos, branches, paths.
- [ ] A **denylist** exists (auth, payments, secrets, infra, prod) and is **enforced by permissions**.
- [ ] The agent **cannot edit its own permissions** or the stop condition.
- [ ] It runs with a **narrow, short-lived identity** — not a human's credentials.
- [ ] Filesystem **and** network are sandboxed.
- [ ] It **never auto-merges** to a protected branch.

## 4. Control

- [ ] All **four exits** exist: success, exhaustion, **no-progress**, escalation.
- [ ] A **no-progress detector** fires (same failure ×3) — not just an iteration cap.
- [ ] **Caps** are set: timeout, daily spend, max retries, max fan-out — **enforced in the gateway/runner, not the prompt**.
- [ ] A **kill switch** exists **where the agent cannot reach it**.
- [ ] A **non-convergence policy** is written (revert / best-effort with caveats / escalate).

## 5. Memory & cadence

- [ ] **State lives on disk**; it is read at start, written at end, **pruned every run**.
- [ ] A **cadence** exists. *(No trigger = a script you ran once, not a loop.)*

## 6. Humans

- [ ] **Escalation triggers** are explicit, and escalations reach a **named human** who will see them.
- [ ] It notifies **only when a decision is required** *(else the team mutes the bot)*.
- [ ] Every tool call is **logged** as an immutable audit trail.
- [ ] Someone can state the **latency-to-detection**: how far a mistake travels before a human sees it.
- [ ] The loop has an **owner**.

---

## Scoring

| Score | Verdict | Max rollout |
|---|---|---|
| **Any ✋ failed** | **Not ready.** Fix the blocker first. | **L1 — report only** |
| 0–12 | Not a loop yet — an agent with a schedule | L1 |
| 13–18 | Viable, but supervised | **L2 — draft PR** |
| 19–23 | Sound design | **L3 — act with approval** |
| 24–26 | Strong | **L4 — act and notify** |
| **27–29 + T1 verifier + low blast radius** | Ready for unattended | **L5** |

**Two overrides, applied after scoring:**

1. **Blast radius caps the ceiling regardless of score.** A perfect score on something irreversible still does not earn L5. *Reversibility, not difficulty, is the axis.*
2. **A T5 verifier caps you at L1–L2**, no matter what else is true. A transcript-only judge is not a gate.

---

## Report it like this

> **Loop Readiness: 21/29 — L3 (act with approval)**
>
> **Blockers:** none.
> **Weak spots:** no held-out suite (−1); no progress metric (−1); blind spot undocumented (−1).
> **Ceiling:** capped at L3 by blast radius (touches `src/billing/`) — not by score.
> **To reach L4:** add a held-out suite and a progress metric, then run 20 clean iterations at L3 with at least one true verifier rejection.
