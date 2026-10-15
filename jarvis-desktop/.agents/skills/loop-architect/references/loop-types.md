# Loop Types

Named patterns. Classify the user's task here first — it tells you the verifier, the blast radius, and the safe autonomy level before you design anything.

## Contents

- Strong-verifier loops — start here
- Strong verifier, high blast radius — gate the action
- Weak verifier, low blast radius — drafter only
- Do not loop

**If the task doesn't match one of these, that is a signal.** Say so: unnamed loops usually mean the verifier hasn't been found yet.

---

## 🟢 Strong-verifier loops — start here

### Flaky-test loop
**Goal:** classify a failing test as flake / real bug / env issue; quarantine or fix.
**Verifier:** repeated runs (T1) — deterministic reproduction, mutation testing.
**Blast radius:** low. **Autonomy:** L3–L4.
**Watch:** never "fix" a flake by adding retries or deleting the test. That is the loop cheating.

### Test-generation loop
**Goal:** raise coverage on a module.
**Verifier:** the test must **compile, pass, and kill a mutant** (T1). Discard everything else.
**Blast radius:** low (a bad test costs CI time, not users).
**Autonomy:** highest of any loop type — **but only because the filter chain discards everything unverifiable.** This is the template for every other loop.
**Watch:** tautological tests that lock in a bug, making the real fix look like a regression.

### Refactor / codemod loop
**Goal:** mechanical transform across many files (rename, API migration, framework bump).
**Verifier:** compiler + existing test suite (T1).
**Blast radius:** huge by file count, but **shardable** → effective blast radius = one shard.
**Autonomy:** L4–L5 **per shard**, auto-commit on green. A decade-old, deployed practice.
**Watch:** shard it. One giant PR is unreviewable and unmergeable.

### Tech-debt / lint-debt loop
**Goal:** burn down warnings, dead config, deprecated calls.
**Verifier:** linter + tests (T1–T2).
**Blast radius:** low. **Autonomy:** L3–L4.
**Watch:** **dead-code *deletion* is different** — its verifier is circular (nothing fails when you delete something only reached on a rare path). Deletion is **propose-only**. It fails silently, in prod, weeks later.

### Dependency-update loop
**Goal:** keep dependencies current.
**Verifier:** build + full test suite (T1) — **but mechanically blind to malware.**
**Blast radius:** high and systematically underestimated (transitive deps + install scripts + CI secrets).
**Autonomy:** **draft PR + cooldown period + provenance check.** Never auto-merge, and *never* into CI workflow files.

### CI-sweeper loop
**Goal:** watch CI, triage failures, draft fixes.
**Verifier:** CI itself (T1).
**Blast radius:** medium. **Autonomy:** L2–L3. Token cost is high — cap the fan-out.

### Repair loop (bug fix from a ticket)
**Goal:** fix the reported bug.
**Verifier:** the failing test, run in CI (T1). **Requires a reproducing test first.**
**Blast radius:** high, contained by the PR gate. **Autonomy:** L2–L3 — a human merges.
**Watch:** if there's no reproducing test, the first loop should *write one* — and that test must then be locked.

---

## 🟡 Strong verifier, high blast radius — gate the action

### Canary / rollback loop
**Goal:** promote or roll back a release.
**Verifier:** **statistical** — a two-sample hypothesis test on live metrics (T1). *Not an LLM.*
**Blast radius:** the highest in software. **Autonomy:** genuinely unattended — **for the statistical judge.**
**Rule:** an LLM may *summarize* the decision. It must not *make* it.

### Architecture-fitness loop
**Goal:** enforce layering, dependency rules, IaC policy, performance budgets.
**Verifier:** structural/policy tests (T1) — **written by humans, immutable to the agent.**
**Blast radius:** high but *loud* for covered rules; high and *silent* for everything uncovered.
**Autonomy:** unattended **inside a human-owned rule envelope.** The agent grinds until the rules pass — and can never edit the rules.

### Security-patch loop
**Goal:** fix a reported vulnerability.
**Verifier:** **strong with a proof-of-concept exploit** (does the PoC still fire?); **weak without one.**
**Blast radius:** medium–high. **Autonomy:** supervised — every patch human-reviewed.
**Watch:** plausible-looking patches vastly outnumber correct ones.

---

## 🔵 Weak verifier, low blast radius — drafter only, forever

### Docs-sync loop
**Goal:** keep docs/changelogs aligned with code.
**Verifier:** link checks and build only (T2). Correctness of prose: none.
**Autonomy:** L2 — draft PR, human merges. Harmless and genuinely useful.

### Issue-triage loop
**Goal:** label, cluster, and prioritize incoming issues.
**Verifier:** none for correctness (T6) — but being wrong is cheap and visible.
**Autonomy:** L1–L2. Report and propose. Never auto-close.

### Code-review loop
**Goal:** comment on PRs.
**Verifier:** weak (T5). AI review comments can create human-noise risk even when they are technically plausible.
**Evidence:** claims about acceptance/action rates need citations before use in public talks or docs.
**Blast radius:** low on code, **high on humans** (noise → the team ignores the bot → they miss the real one).
**Autonomy:** **advisory only.** It must not be able to block or approve a merge. Anything that *gates* should gate on the deterministic engine's output, never the model's opinion.

### Research / exploration loop
**Goal:** investigate, summarize, find prior art.
**Verifier:** none — but it's **read-only**, so it's safe.
**Autonomy:** unattended for *reading*, never for *writing*. Parallelize freely; reads don't collide.

### Data-cleaning proposal loop
**Goal:** find likely bad rows, duplicates, schema drift, or normalization candidates.
**Verifier:** deterministic checks for format/schema/ranges (T1–T2); semantic correctness is weak.
**Autonomy:** L1–L2. Propose patches or review queues; do not overwrite source data unattended.
**Watch:** a clean-looking dataset can still be wrong. Keep raw data immutable and make transformations replayable.

### Content QA loop
**Goal:** check docs, support content, or knowledge-base pages for broken links, stale references, missing metadata, and style-rule violations.
**Verifier:** link checker, build, lint rules, freshness checks (T1–T2); factual correctness remains weak.
**Autonomy:** L2. Draft PRs and flag uncertain claims for human review.
**Watch:** do not let the loop silently "fix" facts it cannot verify.

---

## 🔴 Do not loop

### Production-incident "self-healing" loop
**Verifier:** none for correctness. The system is already degraded, the safety margin is already spent, and there may be no rollback. Public incident-response benchmarks remain an active area; cite the exact benchmark before using a numeric score.
**Autonomy:** **READ-ONLY.** Investigate, correlate, rank hypotheses, build the timeline, draft the postmortem. **Write actions only via pre-authorized, narrow, reversible runbooks.**

### Requirements-authoring loop
**Verifier:** none for correctness. And the blast radius is the **largest and most silent in the whole SDLC** — a wrong requirement flows into design → code → tests, **and the tests pass**, because they were generated from the same wrong requirement.
**Autonomy:** assisted only. A human owns the requirement.

### "Make the UI better" / any taste loop
**Verifier:** none. Subjective goals do not converge — the loop will oscillate forever and bill you for it.
**Response:** refuse. Offer a variant-generator that produces options for a human to pick from. That's a generator, not a loop.

### Exploratory build
If they don't know what "done" looks like, they won't know what to do when it says it's done. **Do the exploration first, then loop.**
