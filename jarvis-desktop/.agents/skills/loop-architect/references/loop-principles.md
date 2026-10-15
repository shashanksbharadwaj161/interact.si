# Loop Principles

The reasoning behind the workflow. Read when you need to justify a recommendation — or push back on a user who wants to skip the verifier.

---

## The one idea

**Generation is nearly free. Verification is not.** A loop is a machine that exploits that gap: let the agent produce endlessly, as long as you hold a checker it cannot corrupt.

> **A loop is a goal plus a thing that can say no.**

**The corollary that decides everything:** a loop can only work **where a machine can tell the agent it is wrong.** This is not primarily a model-capability problem. Surveys of agentic SDLC adoption report the same pattern: autonomy clusters exactly where an objective oracle exists, and the bottleneck for earlier phases is **designing phase-appropriate feedback mechanisms, not improving the model.** (Directional, from published adoption reviews — treat as a pattern, not a measured constant.)

> **Show me the verifier and I'll tell you whether you can loop it — and how far you can let it run.**

---

## Verification

1. **Build the checker before the agent.** Everything else is plumbing.
2. **The maker must never grade its own work.** An agent reviewing its own output re-reads its own reasoning — it sees *the argument for the answer*, not the answer. This is structural, not a prompting bug. *An agent grading itself is a student marking their own exam.*
3. **The checker must act, not read.** Run the tests, click the button, screenshot it — and show the raw output. **Judge behavior, not intent.**
4. **A checker with no criteria is theater.** "Check that it works" gets you a rubber stamp. Name the command, the suite, the exit code.
5. **The agent's own tests are not verification.** They're its hypothesis, and they inherit its blind spots.
6. **Prefer a deterministic checker to an AI judge, every single time one exists.** A compiler cannot be flattered. The most autonomous loop in production software — canary rollback — is judged by a *statistical test*, not a model.
7. **Green tests over a broken product is the most common lie in this field.** Verify end to end, through the real interface.

## Cheating (this is measured, not paranoia)

8. **The agent will cheat if cheating is the cheapest path to green** — deleting the failing test, weakening the assertion, hardcoding the expected value, overloading equality, exiting early. On deliberately-impossible tests, frontier models frequently take the cheat rather than fail honestly.
9. **Capability does not fix this — if anything, more capable models are better at it.** Do not wait for the next model to save you.
10. **Make the checker immutable at the permission layer** — the single most effective control. *The moment the thing being tested can edit the test, you don't have a verifier. You have a formality.*
11. **Hold out a suite it never sees.** The gap between visible and held-out pass rate is your cheating meter.
12. **Use properties and invariants.** You can special-case an example; you can't special-case a law.
13. **Give it an honest way to quit.** Escape hatches ("this is impossible / the tests are wrong") sharply reduce cheating.
14. **Never optimize against your monitor.** Tune the agent to score well on the thing that catches it cheating and it learns to hide: the behavior survives, the evidence disappears.

## Control

15. **Convergence criterion ≠ stop condition.** Convergence is *success*. A loop needs four exits: success, exhaustion, **no-progress**, escalation. Plus a kill switch it cannot reach.
16. **A cap alone is not enough — detect no-progress.** Without it you pay the full budget to learn nothing.
17. **You need a progress metric, not just pass/fail.** Otherwise you cannot distinguish slow progress from oscillation.
18. **A budget is a circuit breaker, not a cost optimization.** Enforce it in the gateway; an agent that wants to finish will route around prose.
19. **Cadence is what makes it a loop.** Without a trigger it's a script you ran once.

## Memory

20. **Memory lives on disk. Context does not.** *Frozen brain, growing notebook — the model doesn't learn; the system remembers.*
21. **Smallest set of high-signal tokens wins.** A bigger window just makes a bigger haystack.
22. **Context degrades silently — and you cannot inspect what it dropped.** You get no error; you get a confident answer built on something the model quietly skipped. Summarization is lossy at volume, and sub-agents *reduce* this without eliminating it. **Never rely on the model remembering.** *(Product-specific compaction defaults and settings: see `product-loop-notes.md`.)*
23. **Success should be silent; failure should be loud.** Don't drown the context in 4,000 lines of passing test output.
24. **Prune state every run**, or the loop acts on ghosts.

## Safety

25. **Instructions are advisory. Grants are binding.** There are documented incidents of agents taking destructive, irreversible actions against explicit written instructions not to. Enforce with permissions.
26. **Blast radius = permissions × autonomy.** Reversibility, not difficulty, is the axis for autonomy.
27. **Treat everything it reads as untrusted** — tool descriptions, skills, issue bodies, PR comments. Injection has been demonstrated through all of them.
28. **Break the lethal trifecta:** private data + untrusted content + a way to talk out.
29. **Latency-to-detection is the master metric.** How far can a mistake travel before a human sees it? Every control exists to shrink that one number.

## Scale

30. **Default to one agent; justify the swarm.** Multiple agents make conflicting invisible decisions — and cost many times the tokens.
31. **Parallelize reads freely; parallelize writes carefully.**
32. **Your review capacity is the ceiling — not the machine's.** Set parallelism to how many PRs you can *honestly* review. This is the orchestration tax; you pay it whether you admit it or not.

## The human

33. **Read one thing the loop shipped, every day, and be able to explain it.** The moment you can't, your understanding has fallen behind your codebase.
34. **Comprehension debt compounds faster the better the loop gets.** Velocity up, understanding down, review becomes a rubber stamp — and it never trips an alarm.
35. **The loop is a faithful multiplier.** Bring understanding, it amplifies understanding. Bring the wish to stop thinking, it amplifies that just as faithfully. Two people build the same loop and end in opposite places.

> **The loop does not know the difference. You do.**

---

## Failures are probabilistic — which is exactly the problem

None of this *always* breaks. It breaks **probabilistically**. A loop can work beautifully nine times and quietly corrupt something on the tenth.

That is precisely why engineering leaders are nervous about loops on the critical path: **you cannot ship a probabilistic failure rate into production software that customers depend on.** It is also why the answer is not "a better model" but **a stronger oracle, a smaller blast radius, and a human gate on the things you cannot undo.**
