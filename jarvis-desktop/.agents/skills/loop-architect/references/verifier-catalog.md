# Verifier Catalog

> Show me the verifier and I'll tell you whether you can loop it.

The one question that gates every loop is *"what, other than a human, can prove it's
done?"* This catalog is the menu of answers. Each entry names **what it proves**, its
**tier** (see `verifier-patterns.md`), **how to wire it**, and — non-negotiable — its
**blind spot**. A verifier whose blind spot you can't name is a delusion, not a design.

Ordered strongest (most independent) to weakest.

---

## 1. Compiler / type checker
- **Proves:** the code is well-formed and type-consistent. **Tier: T1.**
- **Wire it:** `tsc --noEmit`, `mypy --strict`, `cargo check` as a required gate.
- **Blind spot:** says nothing about behavior. Type-correct code can be totally wrong.

## 2. Full test suite in CI
- **Proves:** the behaviors the tests cover still hold. **Tier: T1** (in CI) / T4 (agent-run, raw output).
- **Wire it:** run in CI on the PR branch; make `tests/` immutable (CODEOWNERS); require the check.
- **Blind spot:** covers only what's tested. Coverage gaps are verification gaps; agent-written tests inherit the agent's blind spots.

## 3. Property-based tests
- **Proves:** an invariant holds across *generated* inputs, not hand-picked examples. **Tier: T1.**
- **Wire it:** Hypothesis / fast-check / QuickCheck. Assert laws: `parse(print(x)) == x`, `sort` is idempotent, no crash on any input in a domain.
- **Blind spot:** only as good as the property and the generator's reach; a wrong property passes confidently. **You can special-case an example; you can't special-case a law** — this is why properties resist hardcoding.

## 4. Metamorphic tests
- **Proves:** a *relation* between outputs holds even when you lack a ground-truth oracle. **Tier: T1.**
- **Wire it:** assert `f(x)` and `f(transform(x))` relate as they must — e.g. translating then back-translating, or that adding an irrelevant filter never *increases* a result set.
- **Blind spot:** proves consistency, not correctness. A uniformly-wrong function can still satisfy every metamorphic relation.

## 5. Differential testing (oracle by comparison)
- **Proves:** the new implementation matches a trusted reference on the same inputs. **Tier: T1.**
- **Wire it:** run the old and new code (or a slow-but-correct reference) on shared inputs; diff outputs. Ideal for refactors, rewrites, optimizations.
- **Blind spot:** shared bugs are invisible (both wrong the same way); only covers the input distribution you feed it.

## 6. Mutation testing (the meter for your tests)
- **Proves:** your *test suite* actually catches bugs — it verifies the verifier. **Tier: T1**, meta-level.
- **Wire it:** Stryker / mutmut / PIT injects faults; a good suite kills them. Track the mutation score as the real quality signal behind "tests pass."
- **Blind spot:** slow and expensive; a high score on a narrow suite is still narrow. Doesn't tell you what behavior is *missing*.

## 7. Held-out suite (the cheating meter)
- **Proves:** the change generalizes beyond what the agent could see. **Tier: T1.**
- **Wire it:** keep a suite the agent never has access to; run it post-merge / in a separate job. **The gap between visible and held-out pass rate is your cheating meter.**
- **Blind spot:** if the held-out set is drawn from the same distribution, it misses the same edge cases. Guard the isolation at the permission layer, or it isn't held out.

## 8. Statistical canary (the most autonomous verifier in production)
- **Proves:** a release is not worse than baseline on live traffic. **Tier: T1** — and notably *not* an LLM.
- **Wire it:** route a slice of traffic to the new version; a **two-sample hypothesis test** on error rate / latency decides promote-or-rollback automatically.
- **Blind spot:** lagging and diluted — it catches regressions that show up in aggregate metrics, and misses slow, rare, or correctness bugs that don't move the numbers. **When you can replace an AI judge with a statistical test, do it.**

## 9. Linters / formatters / snapshot tests
- **Proves:** conformance to mechanical rules and "output didn't change unexpectedly." **Tier: T2** (deterministic but partial).
- **Wire it:** eslint/ruff/gofmt; snapshot/golden-file assertions in CI; config immutable to the agent.
- **Blind spot:** form, not meaning. A perfectly-linted file can be wrong; a snapshot only proves *stability*, not *correctness* (and it's easy to "update the snapshot" to cheat — make snapshots immutable or require review on snapshot changes).

## 10. Golden-trace / behavioral replay
- **Proves:** an end-to-end flow produces the expected sequence of observable effects. **Tier: T1–T2.**
- **Wire it:** record a known-good trace (API calls, emitted events, DB writes); replay inputs; diff the trace. Good for pipelines and agents-as-systems.
- **Blind spot:** brittle to benign change; a trace that's too strict fails on cosmetic diffs, too loose misses real ones.

## 11. Browser / UI end-to-end QA
- **Proves:** the product actually works through the real interface. **Tier: T2** (mechanical assertions) / T5–T6 (aesthetics).
- **Wire it:** Playwright/Cypress assert concrete states (element present, text equals, request succeeded, screenshot within pixel-diff threshold). **Verify through the real interface — green unit tests over a broken product is the most common lie in this field.**
- **Blind spot:** "does it look good / feel right" has no oracle — that half is T6 and must stay report-only.

## 12. Human rubric gate
- **Proves:** nothing mechanically — a human judges against a written rubric. **Tier: T6 for correctness.**
- **Wire it:** use *only* where no machine oracle can exist (taste, tone, strategy). Write the rubric down; keep it report-only; never let it gate an autonomous loop.
- **Blind spot:** it *is* the blind spot — subjective, unrepeatable, and prone to rubber-stamping. If you're reaching for this to gate code, you've skipped finding the real verifier.

---

## Choosing

- **Refactor / rewrite / optimize** → differential testing (#5) — you have a reference by construction.
- **Parser / serializer / data transform** → properties + invariants (#3).
- **"Are my tests any good?"** → mutation testing (#6) before you trust "tests pass."
- **Release safety at scale** → statistical canary (#8), not an LLM judge.
- **Anything user-facing** → browser E2E (#11) for the mechanical half; be honest that taste is T6 (#12).
- **Guarding against cheating** → held-out suite (#7) + properties (#3), enforced at the permission layer.

> If the best verifier you can find for a task is #12 (a human rubric), the honest answer
> is usually **don't loop it** — build a drafter or a report-only assistant instead.
