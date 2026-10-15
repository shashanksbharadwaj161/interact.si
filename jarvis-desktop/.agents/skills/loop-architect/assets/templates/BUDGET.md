# Budget — <loop name>

> A budget is a circuit breaker, not a cost optimization.
> A loop without caps has handed its spending authority to its own bugs.

## Caps
| Cap | Value | Enforced by | Notes |
|---|---|---|---|
| Per-run timeout | <30 min> | runner / CI timeout | not the prompt |
| Daily spend | <$20> | API gateway | not the prompt |
| Max iterations per item | <3> | loop code | pairs with the no-progress rule |
| Max parallel agents | <3> | loop code | = how many PRs you can honestly review |
| Max auto-PRs per day | <5> | loop code | protects reviewer bandwidth |

> Enforce caps in the gateway or the runner — **never in the prompt.**
> An agent that wants to finish will route around prose.

## Kill switch
- **How to stop it right now:** <command / toggle — must NOT be agent-writable>
- **How to revoke its credentials in one step:** <mechanism>
- **Owner on call:** <name>

## Run log (append-only)
| date | runs | items found | actions taken | escalations | spend |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

## Review
- [ ] Caps were set **before** the first unattended run — not after the first surprising bill
- [ ] Spend is visible to someone who will notice it
- [ ] A runaway loop trips a cap before it trips a human
