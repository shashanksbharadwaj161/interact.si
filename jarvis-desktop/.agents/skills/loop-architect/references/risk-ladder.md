# Risk & Autonomy

## 1. The decision grid — should this be looped at all?

**Verifier strength × blast radius.** Place the task here before designing anything.

|  | **Low blast radius** (cheap to be wrong) | **High blast radius** (expensive/irreversible) |
|---|---|---|
| **Strong verifier** (T1–T2) | 🟢 **AUTOMATE HARD**<br>test generation, codemods, lint debt, flaky tests<br>*Start every loop program here.* | 🟡 **GATE THE ACTION**<br>dependency bumps, architecture fitness, canary rollout<br>*The verifier is good; the consequences are not.* |
| **Weak verifier** (T5–T6) | 🔵 **DRAFTER ONLY**<br>code-review comments, changelogs, issue triage<br>*Advisory. Forever.* | 🔴 **DO NOT LOOP**<br>incident write-actions, requirements correctness, anything touching money or PII without a check |

**The axis that matters for autonomy is reversibility — not difficulty.** A hard task that's easy to undo is safer to loop than an easy task that isn't.

---

## 2. The autonomy ladder

**Never start at the top. Promote per *task type*, never per agent.**

| Level | What it does | Promote to this when |
|---|---|---|
| **L0 — Manual** | You prompt it each time | — |
| **L1 — Report only** | Finds work, writes state. **Takes no action.** | Goal, verifier, state, and cadence exist |
| **L2 — Draft** | Opens a draft PR / proposes a change | + maker-checker split, scope + denylist |
| **L3 — Act with approval** | Executes after a human says yes | + escalation path, budget caps |
| **L4 — Act and notify** | Executes, tells you after | + strong verifier (T1), low blast radius, proven at L3 |
| **L5 — Unattended** | Runs while you sleep | + everything, incl. immutable checker, kill switch, no-progress detector |

> **Default recommendation for any first loop: L1 for one week.** You will learn more from what it *wrongly flags* than from anything it fixes.

**Gate promotion on evidence, not vibes.** Before promoting, ask: *has the verifier actually rejected anything in the last five runs?* A checker that never says no is not lenient — it is broken.

---

## 3. What may run unattended, and what may not

**Safe to run unattended (given a Tier-1 verifier):** lint fixes, dependency bumps behind a cooldown, doc updates, flaky-test quarantine, mechanical codemods per shard, test generation that survives a mutation filter.

**Keep behind a human gate indefinitely:** database migrations, deploys, IAM/permission changes, deletions, anything that spends money, anything touching PII or customer data, and **merges to main**.

**Never automate at all:** the agent editing its own permissions, the CI config, the test files, or the stop condition. If the stop signal lives anywhere the agent can write, it is not a stop signal.

---

## 4. Blast-radius controls

Every one of these exists to shrink a single number: **how far can a mistake travel before a human sees it?** *(latency-to-detection — the master metric)*

- **Isolation** — one worktree per agent; agents never work on main.
- **Least privilege** — a narrow, short-lived identity of its own. Never your credentials. If it can spend money, cap it.
- **Sandbox** — filesystem **and** network. Either alone is worthless.
- **Break the lethal trifecta** — private data + untrusted content + a way to talk out. Any two are survivable; all three, and leakage is a matter of when.
- **Denylist** — auth, payments, secrets, infra, prod. Enforced by permissions, **not by asking nicely**. *Instructions are advisory; grants are binding.*
- **Caps** — per-run timeout, daily budget, max retries, max fan-out. Enforced in the gateway, never in the prompt.
- **Kill switch** — out of band, where the agent cannot reach it. Plus instant credential revocation.
- **Receipts** — an immutable log of every tool call, argument, and result. You cannot debug a process nobody watched.

---

## 5. Escalation

**Escalate on irreversibility and blast radius — not on tool name.** ("It used bash" is not a reason. "It's about to delete something" is.)

**Trigger escalation when:**
- The no-progress detector fires (same failure 3×).
- The action is irreversible or touches a denylisted path.
- The goal is ambiguous.
- The budget is exhausted.

**Design against approval fatigue.** People approve the overwhelming majority of prompts they are shown. **A gate everyone clicks through is a ritual, not a control.** Gate *few* things — and gate the ones that matter.

**And make sure knocking wakes someone.** Notify **only** when a human decision is required. Ping on every run and the team mutes the bot — and then misses the one that mattered.
