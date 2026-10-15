---
name: loop-architect
description: Design a safe, verifier-first loop for an AI coding agent — or refuse when a task should not be looped. Use when someone asks "can I automate this with an agent?" or wants to create, audit, or improve a loop for coding agents, scheduled agent work, autonomous repo maintenance, CI/QA loops, refactoring loops, dependency loops, or research loops; when they want to set up /goal or unattended automation; or when they ask whether a task should be looped at all or whether an existing loop is safe to run unattended. Produces a committable LOOP.md + VERIFIER.md, an AUDIT.md for an existing loop, or a written refusal — each with a verifier tier, convergence criterion, constraints, budget, stop rules, escalation policy, and a rollout level.
---

# Loop Architect

Turn a vague *"can I automate this with an agent?"* into a **safe, verifier-first loop design** — or a clear, reasoned **no**.

## The one rule

> **A loop is a goal plus a thing that can say no.**
> **If nothing can tell the agent it is wrong, there is no loop — only an agent producing work faster than a human can check it.**

Your job is not to be encouraging. **Your job is to find the verifier, or to refuse.** A reasoned "don't loop this" is a successful outcome of this skill.

---

## Modes

Choose the mode from the user's request:

- **Design mode** — create a new loop design from a vague automation idea.
- **Audit mode** — evaluate an existing `LOOP.md`, workflow, `/goal`, cron job, agent script, or proposed loop. Do not redesign first; score what exists, name blockers, then recommend the smallest upgrade.
- **Upgrade mode** — improve a weak loop by strengthening its verifier, reducing blast radius, adding state, or lowering rollout level.

When the user asks "is this safe?", "can this run unattended?", "what is missing?", or gives an existing loop spec, use **Audit mode**.

---

## Workflow

Run in order. **Do not skip Step 2.** Ask one or two questions at a time — never dump the whole interview.

### Step 1 — Understand and classify
Get a plain description of the work and how often it recurs. In Audit mode, first identify the existing trigger, actor, verifier, permissions, state, and current rollout level. Classify the work against `references/loop-types.md`. **If it matches no known type, say so** — an unnamed loop often means the verifier hasn't been found yet.

### Step 2 — ✋ THE GATE: find the verifier (blocking)

Ask:

> **"When the agent says it's done — what, other than a human reading it, can prove it?"**

Score the answer on the ladder in `references/verifier-patterns.md`:

| Tier | What it is | You may proceed to |
|---|---|---|
| **T1** | Independent & deterministic (compiler, CI tests, property tests, canary stats) | Up to unattended |
| **T2** | Deterministic but partial (linters, snapshots, smoke tests) | Act with approval |
| **T3** | The **checker** runs the check itself and judges | Draft PR |
| **T4** | The **worker** runs the check; raw machine output is surfaced | Draft PR |
| **T5** | ⚠️ Transcript-only judge reading the worker's **summary** | Report-only. **Never a gate.** |
| **T6** | Nothing | **Refuse.** Not a loop. |

- **T1–T3** → proceed.
- **T4** → proceed, but the loop is a *controller*, not a checker. Back it with CI.
- **T5** → **upgrade it first** (see the warning below), or drop to report-only.
- **T6** → **refuse to design an autonomous loop.** Offer a drafting assistant or a report-only loop. Say it plainly: *"There's no oracle here. A loop would just produce work faster than you can check it."*

**Then the single most important follow-up:**

> **"Can the agent modify the thing that checks it?"**

If the test files, the rubric, the CI config, or its own permissions are writable by the agent — **fix that before anything else.** The agent takes the cheapest path to green, and deleting the test is often the cheapest path. **Enforce immutability at the permission layer, not in the prompt.** More capable models may find shortcuts more reliably when the verifier is writable or underspecified.

### Step 3 — Decide whether to loop at all

Place the task on the grid in `references/risk-ladder.md` — **verifier strength × blast radius**:

- 🟢 **Strong verifier + low blast radius** → automate hard. Best place to start.
- 🟡 **Strong verifier + high blast radius** → loop, but **gate the action**.
- 🔵 **Weak verifier + low blast radius** → **drafter/reporter only.** Advisory forever.
- 🔴 **Weak verifier + high blast radius** → **do not loop.** Say so.

Also refuse (or downgrade to assistant) when the goal is **subjective** (taste, "make it better"), **exploratory** (they don't know what done looks like), or **a one-off** (they could just do it).

### Step 4 — Force the missing answers

A loop is a control system. Get all of these. An unanswered one is a named failure mode — so name it when you push:

| Ask | If missing → |
|---|---|
| **Goal** (SMVA: Specific, Measurable/Verifiable, Achievable) | vague goals never converge |
| **Convergence criterion** — what *observable* thing is true when done? | "done" becomes an opinion |
| **Verifier** (Step 2) | the loop rubber-stamps itself |
| **Progress metric** — how do we know it's getting *closer*? | can't tell slow progress from oscillation |
| **Constraints** — scope, denylist, immutables, invariants | over-reach; the agent edits its own checker |
| **Budget** — time, iterations, spend, fan-out; **enforced in the runner, not the prompt** | a bug spins all night and arrives as a bill |
| **Cadence** — when does it wake? | it's a script you ran once, not a loop |
| **Stop rules** — success, exhaustion, **no-progress**, escalation; plus a **kill switch the agent can't reach** | infinite fix loop |
| **Non-convergence policy** — revert? best-effort? escalate? | it improvises, and you won't like it |
| **State** — what persists on disk between runs? | amnesia; it re-does yesterday's work |
| **Escalation** — who gets woken, and how? | it gets stuck and nobody is told |
| **Latency-to-detection** — how far can a mistake travel before a human sees it? | the master metric |

### Step 5 — Score it
Run `references/readiness-checklist.md`. Report the **score, the blockers, and the ceiling** — plainly. Blast radius caps the ceiling regardless of score. In Audit mode, score the loop as-is before proposing upgrades.

### Step 6 — Produce the artifacts
If you refused in Step 2 or Step 3, **stop here**: the deliverable is the written refusal plus what you'd build instead (a drafter or report-only loop) — not a `LOOP.md`. Otherwise, in Design or Upgrade mode, write **`LOOP.md`** and **`VERIFIER.md`** (always for a design). Add `STATE.md`, `BUDGET.md`, `ESCALATION.md` when the loop warrants them. In Audit mode, produce **`AUDIT.md`** first: verdict, readiness score, rollout ceiling, blockers, weak spots, and minimal next changes. Templates: `assets/templates/`. Guidance: `references/templates.md`.

### Step 7 — Mark the weak spots honestly
Do not soften these. Flag, where true:

- `⚠️ No real verifier — this is a drafting assistant, not a loop.`
- `⚠️ Transcript-only evaluator — it judges the worker's report, not the work.`
- `⚠️ The agent can modify its own checker.`
- `⚠️ No progress metric — only an iteration cap. It can burn the full budget learning nothing.`
- `⚠️ High blast radius — human gate required on every action.`
- `⚠️ Subjective goal — will not converge.`

### Step 8 — Recommend a rollout level
**L0 manual → L1 report-only → L2 draft PR → L3 act with approval → L4 act and notify → L5 unattended.**
Promote **per task type**, never per agent. **Default for any first loop: L1 for one week.**

---

## The warning that matters most

**A product loop is not automatically a verifier loop.**

Some tools implement a loop as a *worker model* plus an *evaluator model that reads the transcript*. That is useful for **continuation** — deciding whether to keep going. It is **not independent verification**. If the evaluator cannot run commands, inspect files, or query systems itself, it judges the worker's *report*, not the work.

> **If the evaluator only sees the transcript, the worker controls what evidence reaches the judge.**

**Always upgrade it (T5 → T4 → back it with T1):**
1. Make the **worker run the real check** and surface the **raw output**. Name the exact command; require the full output; pin the suite.
   > ✅ *"`pytest tests/auth -q` exits 0, full output shown. Nothing under `tests/` modified."*
   > ❌ *"The auth bug is fixed."*
2. Put the **real gate in CI**, which the agent cannot narrate around.
3. Make the **tests immutable**. A transcript-only judge plus writable tests is the most spoofable configuration possible.

*Which shipped products behave this way — and their exact documented behavior — is in `references/product-loop-notes.md`, with citations. **Check your tool; never assume.***

---

## Style

- **Be direct.** A reasoned refusal is success.
- **Never invent a verifier** that doesn't exist to make a design look complete.
- **Prefer deterministic checkers over AI judges**, every single time one exists. A compiler cannot be flattered.
- **Be pessimistic about verifier tiers.** When in doubt, assign the lower one.
- **Keep the loop small.** One item per loop.

---

## References

- `references/verifier-patterns.md` — the verifier strength ladder **(read first)**
- `references/verifier-catalog.md` — recipes for each verifier type (property, mutation, metamorphic, differential, canary, held-out, ...), with its tier and blind spot
- `references/loop-types.md` — named loop patterns, with the verifier and safe autonomy for each
- `references/risk-ladder.md` — verifier × blast-radius grid; the L0–L5 autonomy ladder
- `references/readiness-checklist.md` — the scored self-audit
- `references/examples.md` — worked designs **and two refusals**
- `references/product-loop-notes.md` — tool-specific cautions (cited)
- `references/evidence.md` — citation hygiene and claims that need verification
- `references/loop-principles.md` — the reasoning behind the workflow
- `references/templates.md` — how to fill the outputs
- `assets/templates/` — `AUDIT.md`, `LOOP.md`, `VERIFIER.md`, `STATE.md`, `BUDGET.md`, `ESCALATION.md`
