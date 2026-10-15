# Product Loop Notes — tool-specific cautions

_Last verified: 2026-07-12 — re-check each claim against current docs before relying on it._

**Principles are tool-agnostic. This file is not.** Everything here is a property of a *specific product* at a *specific time* — verify before relying on it, and never generalize a single tool's behavior to "all loops."

**Last reviewed:** 2026-07-12. Re-check product docs before publishing or using these claims in a talk.

> **The core caution:** a *product* loop is not automatically a *verifier* loop. Many tools ship a loop controller — something that decides whether to keep going. That is not the same as something that can independently prove the work is correct.

## Contents

- Claude Code — `/goal`
- Transcript-only evaluators, in general
- Auto-mode / auto-accept
- Context & compaction
- Sub-agents
- Cloud / scheduled runners
- The line to remember

---

## Claude Code — `/goal`

**Last verified:** 2026-07-12 against Anthropic's Claude Code `/goal` documentation.

**What it is:** a session-scoped stop-hook. After each turn, the condition plus the conversation so far are sent to a small, fast evaluator model, which returns **yes/no plus a reason**. "No" feeds the reason back as guidance for the next turn. "Yes" clears the goal.

**The critical constraint — [from Anthropic's own docs](https://code.claude.com/docs/en/goal):** the evaluator **"doesn't run commands or read files independently."** It can only judge what the worker has surfaced in the conversation.

**What this means:**
- `/goal` is a **loop controller**, not a trusted checker. It answers *"should we keep going?"* — not *"is this correct?"*
- The worker decides which commands to run and what to surface. **The worker controls what evidence reaches the judge.**
- **Never make `/goal` your merge gate.** Put the real gate in CI.

**Anthropic's own recommended condition has four parts** — and it maps 1:1 to the loop anatomy in this skill:

| Their guidance | Our anatomy |
|---|---|
| A measurable end state | **Convergence criterion** |
| A stated check — *how the agent must prove it* | **Verifier** |
| Constraints on what shouldn't change on the way | **Constraints / immutables** |
| An optional turn or time cap | **Budget** |

**Write conditions like this:**
✅ *"`pytest tests/auth -q` exits 0, with the full output shown. Do not modify anything under `tests/`."*
❌ *"The auth bug is fixed."*

The first can only be satisfied by real machine output landing in the transcript (**T4**). The second is satisfied by a confident sentence (**T5**).

*(Conditions are capped at ~4,000 characters. Check status with `/goal`; clear with `/goal clear`.)*

---

## Transcript-only evaluators, in general

**Evidence level:** principle. Apply to any product only after checking whether its evaluator has independent tool access.

Any tool where the judge reads the conversation rather than the artifact has the same shape:

- **Both failure directions are real:** rubber-stamping (approves a good story) *and* nitpicking (invents problems → over-engineering).
- **Myopia:** it accepts "tests passed" as printed — without checking that they ran, that they were the right tests, or that they hadn't been weakened.
- **Cascade:** an early miss compounds, burning tokens and time on a wrong foundation.

**Always ask of your tool:** *can the evaluator run a command by itself?* If no → it is **T5**, and you must upgrade it to **T4** (worker runs the check, raw output surfaced) and back it with CI (**T1**).

---

## Auto-mode / auto-accept

**Evidence level:** principle. Product mechanics vary.

Removes per-tool approval prompts. Useful — and it is exactly where **approval fatigue** stops being a metaphor. Pair auto-mode with **hard permission boundaries** (sandbox, denylist, read-only paths), because the human gate you were relying on is now gone.

---

## Context & compaction

- **Auto-compaction may fire at a high default threshold** (for example, Claude Code has been reported/documented around ~95% in some configurations). **Know your tool's current default.**
- **Tuning it is a blunt instrument.** You can adjust a percentage or a token count — you cannot tell it *what matters*. It is not an intelligent process.
- **Context loss is partly unobservable.** Attention degrades unevenly across a long window, and **you cannot inspect what was skipped.** You will not get an error; you will get a confident answer built on something it quietly dropped.
- **Sub-agents reduce context rot. They do not eliminate it.** Treat them as a context firewall (a sub-agent burns its own window and returns a condensed answer with pointers), not as a cure.

**Design implication:** never rely on the model *remembering*. Put durable facts on disk (`STATE.md`), and re-read them at the start of every run.

---

## Sub-agents

**Evidence level:** principle / harness behavior. Product implementations vary.

Use them as a **context firewall**, not as a role-play org chart ("frontend engineer," "backend engineer" — this does not work). The benefit is encapsulation: the parent sees the condensed result, not the exploration noise. They also give you a cost lever — expensive model on the orchestrator, cheap model in the leaves.

**They do not solve verification.** A sub-agent grading its sibling's work still needs tools and an immutable rubric.

---

## Cloud / scheduled runners

**Evidence level:** principle. Cloud providers and hosted-agent products vary.

Running loops in the cloud (scheduled workers, Actions, hosted agents) is what makes "while you sleep" real — a local timer only means *"a few more turns while I'm still around."*

But moving off your laptop **moves the blast radius, it does not shrink it.** Cloud runners often hold CI secrets and write access. Sandbox, scope credentials narrowly, cap spend at the gateway, and never auto-merge.

---

## The line to remember

> **Loops do not fail deterministically. They fail probabilistically.**
> **And probabilistic failure on the critical path is exactly what makes engineering leaders nervous.**

That is the honest reason not to put a loop on production-critical work with a weak verifier — not that it *will* break, but that you cannot say when it won't.
