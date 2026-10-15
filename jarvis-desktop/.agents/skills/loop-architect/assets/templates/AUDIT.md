# Loop Audit: <name>

**Audited object:** <LOOP.md / /goal / cron worker / agent script / workflow>
**Current rollout level:** <L0-L5, if known>
**Recommended ceiling:** <L0-L5>
**Verdict:** <safe as-is / safe with gates / draft-only / report-only / do not loop>

## Summary
<One paragraph: what the loop tries to do, whether it should be looped, and the single biggest risk.>

## Readiness score
**Score:** <__/29> — see `references/readiness-checklist.md`

**Hard blockers:**
- <none / blocker>

**Ceiling reason:**
<What caps autonomy: verifier tier, blast radius, missing state, writable checker, no progress metric, etc.>

## Verifier assessment
- **Claimed verifier:** <what the loop currently relies on>
- **Actual tier:** <T1-T6>
- **Can the agent modify it?** <yes/no/unknown>
- **Blind spot:** <what this verifier cannot prove>

## Control assessment
- **Goal:** <clear / vague>
- **Convergence criterion:** <machine-checkable / subjective / missing>
- **Progress metric:** <present / missing>
- **Budget:** <present / missing / prompt-only>
- **Stop rules:** <success / exhaustion / no-progress / escalation / kill switch>
- **State:** <disk-backed / transcript-only / missing>
- **Escalation:** <named human + trigger / vague / missing>

## Blast radius
<What can this loop reach when wrong: files, branches, prod systems, data, money, secrets, customers.>

## Weak spots
- ⚠️ <honest weakness>

## Minimal upgrades
1. <smallest change that removes the top blocker>
2. <next highest-leverage control>
3. <promotion evidence required>

## Decision
<Proceed at L__, downgrade to L__, or refuse autonomous looping.>
