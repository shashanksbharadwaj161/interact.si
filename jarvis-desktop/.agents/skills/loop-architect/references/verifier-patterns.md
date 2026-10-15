# The Verifier Strength Ladder

**The verifier is the loop.** Everything else is plumbing. Score the user's verifier here before designing anything.

**Rule: always use the strongest tier available.** If a deterministic checker exists, use it — never substitute an AI judge for something a compiler could have answered.

The ladder is ordered by **independence**: how much of the evidence is produced by something *other than the agent being judged*.

## Contents

- T1 — Independent & deterministic
- T2 — Deterministic but partial
- T3 — Checker executes, model judges
- T4 — Worker executes, raw output judged
- T5 — Transcript-only judge
- T6 — None
- The two questions that decide everything
- Anti-cheat checklist
- Liveness check

| Tier | Name | Who produces the evidence | Max autonomy |
|---|---|---|---|
| **T1** | Independent & deterministic | A machine, outside the agent | Unattended |
| **T2** | Deterministic but partial | A machine, but blind to whole classes of failure | Act with approval |
| **T3** | Checker executes, model judges | The **checker** runs it itself | Draft PR |
| **T4** | Worker executes, raw output judged | The **worker** runs it; raw output is surfaced | Draft PR |
| **T5** | ⚠️ Transcript-only judge | The **worker's summary** | Report-only. Never a gate. |
| **T6** | None | Nobody | **Not a loop** |

---

## T1 — Independent & deterministic (strongest)

The check runs *outside* the agent, produces a machine result, and **cannot be talked out of it.**

| Verifier | Good for | Notes |
|---|---|---|
| **Compiler / type checker** | Refactors, migrations, API changes | Cannot be flattered. The cheapest strong verifier that exists. |
| **Tests running in CI** | Bug fixes, features with coverage | *In CI* — not "the agent says they passed." |
| **Build succeeds** | Dependency bumps, config changes | Weak on semantics, strong on breakage. |
| **Property / invariant tests** | Parsers, serializers, data transforms | `parse(print(x)) == x`. **You can special-case an example; you cannot special-case a law.** The best anti-cheat verifier. |
| **Mutation testing** | Test-generation loops | Proves the test would actually *catch* a bug. |
| **Held-out suite** | Any coding loop | The agent never sees it. The gap between visible and held-out pass rate **is your cheating meter.** |
| **Statistical canary** (two-sample test on live metrics) | Release / rollout | The most autonomous verifier in production software — because it's a hypothesis test, not an opinion. |
| **Policy-as-code / structural tests** (layering, dependency rules, IaC policy, perf budgets) | Architecture, infra | Mechanically enforces design constraints. **The agent must not be able to edit the rule files.** |

**Unlocks:** up to unattended — subject to blast radius.

---

## T2 — Deterministic but partial

Real signal, but blind to whole classes of failure. Trustworthy about what it covers; **silent about the rest.**

- **Linters / formatters** — style, not correctness.
- **Snapshot tests** — catch *change*, not *wrongness*. Will happily lock in a bug.
- **Coverage thresholds** — measure execution, not assertion quality.
- **Smoke tests / health checks** — catch catastrophe, not subtlety.
- **SAST / dependency scanners** — find known patterns; blind to novel logic bugs and to malicious packages that pass every mechanical check.

**Unlocks:** act-with-approval. Good as *a* gate; never as the *only* gate.
**Always record the blind spot** in `VERIFIER.md`.

---

## T3 — Checker executes, model judges

The **checker itself** has tools. It runs the command, opens the page, queries the database — then a model interprets what *it* observed.

- **AI judge with real tool access** — it can run bash, read files, query the DB independently.
- **Browser run-through** — the checker drives the UI, screenshots it, compares against the goal.
- **Golden traces** — compare an execution trace against a known-good one.

The defining property: **the checker acts; it does not merely read.** This is the strongest option when no deterministic oracle exists (UI, end-to-end behavior, prose quality).

**Unlocks:** draft PR / act-with-approval.

---

## T4 — Worker executes, raw output judged

**The practical middle ground — and the correct upgrade path out of T5.**

The evaluator still has no tools, but the **worker** runs the real check (`pytest -q`, `tsc`, the build) and the **raw, unedited output** is surfaced for the judge to read. The judge is now reading *a machine's output* rather than *the agent's prose about it*.

- **Better than T5:** the evidence is machine-generated, not narrated.
- **Weaker than T1–T3:** the worker still chooses *which* command to run and *what* to surface. It can run a subset, the wrong suite, or a suite it just weakened.

**To make it work:** name the **exact command** in the condition, require the **full output**, and **pin the suite**. Then back it with CI, which the agent cannot narrate around.

> ✅ *"`pytest tests/auth -q` exits 0, with full output shown. Nothing under `tests/` is modified."*
> ❌ *"The auth bug is fixed."*

**Unlocks:** draft PR / act-with-approval. Acceptable as a turn-level controller; **not** as a merge gate.

---

## T5 — Transcript-only judge ⚠️ NOT INDEPENDENT VERIFICATION

A model that reads the conversation and decides whether the goal was met — **with no tools of its own** — judging the worker's *report*.

> **If the evaluator only sees the transcript, the worker controls what evidence reaches the judge.**

**Why this is weak, not merely imperfect:**

- It judges **the account of the work, not the work.**
- The worker chooses **which commands to run and what to surface.**
- Failure runs in **both directions**:
  - **Confirmation bias / rubber-stamping** — approves because the story sounds complete.
  - **Nitpicking / over-strictness** — invents problems, driving over-engineering, defensive code, and tests for impossible cases.
  - **Myopia** — accepts "tests passed" as printed, without checking they *ran*, that they were the *right* tests, or that they hadn't been weakened.
- An early miss **cascades**, burning tokens and time on a foundation that was already wrong.

**Survival kit (do all three):**
1. **Upgrade to T4** — make the worker run the check and surface raw output.
2. **Put the real gate in CI**, where the agent cannot narrate around it.
3. **Make the tests immutable.** A transcript-only judge plus writable tests is the most spoofable configuration possible.

**Unlocks:** report-only or draft-PR. **Never unattended. Never a merge gate.**

*For which shipped products behave this way, see `product-loop-notes.md` — that is where tool-specific claims live, with citations.*

---

## T6 — None

*"A human will review it."* / *"We'll see if it looks right."*

**This is not a loop.** It is an agent producing work faster than a human can check it — which is the exact job the loop was supposed to remove.

**Response:** refuse to design an autonomous loop. Offer a drafting assistant, or a report-only loop whose output is a *proposal*, not an action.

---

## The two questions that decide everything

**1. "When it says done — what, other than a human, can prove it?"**
No answer → **T6** → don't loop.

**2. "Can the agent modify the thing that checks it?"**
If yes, you don't have a verifier — you have a formality. **Fix this before anything else, at the permission layer, not in the prompt.**

> **The moment the thing being tested can edit the test, you don't have a verifier. You have a formality.**

---

## Anti-cheat checklist (apply to every design)

The agent will take the cheapest path to green. Deleting the failing test is often the cheapest path — and more capable models may find these shortcuts more reliably when the verifier is writable or underspecified. Design accordingly.

- [ ] Test / rubric / CI-config files are **read-only to the agent** — enforced by permissions, not instructions
- [ ] A **held-out suite** exists that the agent never sees
- [ ] At least one **property/invariant** check it cannot hardcode against
- [ ] The checker **runs** the check itself, or the check runs in **CI**
- [ ] The agent **cannot edit its own permissions** or the stop condition
- [ ] The agent has an **honest way to quit** ("this is impossible / the tests are wrong") — escape hatches sharply reduce cheating
- [ ] Someone reviews the **trajectory**, not just the final diff — some cheats are invisible in the finished code
- [ ] **Never tune the agent against the cheat-detector.** It learns to hide: the behavior survives, the evidence disappears.

## Liveness check

> **Has your verifier rejected anything in the last five runs?**
> A checker that never says no is not lenient. **It is broken.**
