# How to fill the templates

**The templates themselves live in `assets/templates/`. This file is guidance, not a second copy.**

| File | Produce it when | Purpose |
|---|---|---|
| `AUDIT.md` | Auditing an existing loop | The verdict, blockers, readiness score, and minimal upgrades. |
| `LOOP.md` | Design or upgrade mode | The design. The artifact to commit before a loop runs. |
| `VERIFIER.md` | Design or upgrade mode | The thing that can say no — and proof the agent can't reach it. |
| `STATE.md` | The loop runs more than once | Memory on disk. |
| `BUDGET.md` | The loop runs unattended or fans out | Circuit breakers and the kill switch. |
| `ESCALATION.md` | The loop can act (L3+) | Who gets woken, and when. |

---

## AUDIT.md — the current-state verdict

Fill this before redesigning an existing loop. Users need to know whether the loop they already have is safe, not just what a perfect one would look like.

**Score the current loop as-is.** Do not give credit for controls you plan to add.

**Name the rollout ceiling.** The ceiling is the highest safe autonomy level right now. Missing hard blockers, high blast radius, and weak verifier tiers cap the ceiling even when the prose sounds mature.

**Minimal upgrades beat ideal rewrites.** End with the smallest changes that remove the top blocker: make tests read-only, move the gate to CI, add a no-progress detector, lower rollout from L4 to L2, or add a named escalation owner.

---

## LOOP.md — the design

**The two fields people get wrong:**

**Convergence criterion.** Must be *observable* and *machine-checkable*. Write the **proof**, not the intent.
> ✅ `pytest tests/auth -q` exits 0, with full output shown.
> ❌ "The auth bug is fixed." ← satisfied by a confident sentence.

Use **SMVA**: Specific · Measurable/Verifiable · Achievable.

**Progress metric.** *The field everyone omits.* Pass/fail cannot distinguish **slow progress** from **oscillation**. Name something that should improve monotonically — failing-test count, error count, unresolved findings. Without it your only exit is the budget cap, and you will pay it in full to learn nothing.

**Non-goals are not optional.** An empty non-goals list means the loop will eventually do something you never sanctioned. Minimum three: never modify tests, never touch `<sensitive path>`, never merge.

**Weak spots must be honest.** If there is no real verifier, write it down. A LOOP.md that hides its weakness is worse than none, because it manufactures confidence.

---

## VERIFIER.md — the thing that can say no

Fill **the tier** and **the immutability section** first. Everything else is commentary.

Tier comes from `verifier-patterns.md` (T1 strongest → T6 = none). **Be pessimistic.** If the "verifier" is an AI reading the agent's summary, it is **T5** — no matter how good the model is.

**Record the blind spot.** Every verifier has one, and naming it is the difference between a design and a delusion.
> *"A green test suite does not detect a malicious dependency."*

**The liveness check is not decorative.** If the verifier has never rejected anything, it is not lenient — it is broken, and the loop has been rubber-stamping itself.

---

## STATE.md — memory on disk

> **Memory lives on disk. Context does not.**

Three rules, each one a failure mode if skipped:

- **Read it at the start of every run** — skip this and the loop has amnesia; it re-does yesterday's work.
- **Write it at the end of every run** — skip this and nothing compounds.
- **Prune it every run** — skip this and you get *state rot*: the loop acts on ghosts (merged PRs, closed tickets, dead branches).

**Verified facts** stops the loop re-deriving the same conclusion forever. **Lessons** is where the loop pays down intent debt — promote each lesson into the skill or checklist so the next run doesn't relearn it.

---

## BUDGET.md — circuit breakers

**A budget is a circuit breaker, not a cost optimization.** A loop without caps has handed its spending authority to its own bugs.

**Enforce caps in the gateway or the runner — never in the prompt.** An agent that wants to finish will route around prose.

Set **max parallel agents to how many PRs you can honestly review**, not how many the machine can run. That is the real ceiling.

The **kill switch must live where the agent cannot reach it**, and you should be able to revoke its credentials in one step.

---

## ESCALATION.md — the human door

**Escalate on irreversibility and blast radius — not on tool name.** "It used bash" is not a reason. "It is about to delete something" is.

**Design against approval fatigue.** People approve the overwhelming majority of prompts they're shown. A gate everyone clicks through is a ritual, not a control — so gate *few* things, and gate the ones that matter.

**Notify only when a human decision is required.** Ping on every run and the team mutes the bot, then misses the one that mattered.

**Make sure knocking wakes someone.** An escalation that only writes to a file nobody reads is not an escalation.
