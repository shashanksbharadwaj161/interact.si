# Verifier — <loop name>

> A loop is a goal plus a thing that can say no. This file is that thing.

## What says no
<compiler / CI test suite / property tests / mutation testing / statistical canary / ...>

## Tier
**T<n>** — see `references/verifier-patterns.md`

| Tier | Meaning | Max autonomy |
|---|---|---|
| T1 | Independent & deterministic (compiler, CI tests, property tests, canary stats) | Unattended |
| T2 | Deterministic but partial (linters, snapshots, smoke tests) | Act with approval |
| T3 | Checker executes and judges — it has its own tools | Draft PR |
| T4 | Worker executes; raw machine output is surfaced | Draft PR |
| T5 | ⚠️ Transcript-only judge reading the worker's summary | Report-only. Never a gate. |
| T6 | Nothing | Not a loop |

## How it runs
- **Command:** <exact command>
- **Where:** <CI / sandbox / agent shell>   ← prefer CI; the agent cannot narrate around it
- **Pass condition:** <exit code / threshold>

## Immutability — the anti-cheat section
- [ ] Test / rubric / CI-config files are **read-only to the agent** — enforced by <mechanism>, not by instructions
- [ ] A **held-out suite** exists that the agent never sees
- [ ] At least one **property/invariant** check it cannot hardcode against
- [ ] The agent cannot edit **its own permissions** or the **stop condition**
- [ ] The agent has an **honest way to quit** ("this is impossible / the tests are wrong")
- [ ] Someone reviews the **trajectory**, not just the final diff

> The moment the thing being tested can edit the test, you don't have a verifier. You have a formality.

## Known blind spots
<Every verifier has one. Naming it is the difference between a design and a delusion.>
> e.g. "A green test suite does not detect a malicious dependency."

## Liveness check
Has the verifier rejected anything in the last 5 runs?  **<yes / no>**
> A checker that never says no is not lenient. It is broken.
