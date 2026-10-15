# Escalation — <loop name>

## Always escalate — never act
- Irreversible actions: deletes, deploys, migrations, IAM changes
- Anything that spends money
- Anything touching secrets, PII, or customer data
- Denylisted paths
- The agent requesting a permission change

> Escalate on **irreversibility and blast radius** — not on tool name.
> "It used bash" is not a reason. "It is about to delete something" is.

## Escalate after
- 3 failed attempts on the same item (the no-progress rule)
- Budget exhausted
- Goal ambiguous or signals conflict

## How
- **Who:** <a named human>
- **Where:** <a channel that is actually read>
- **Include:** what it tried, what failed, the raw output, its best hypothesis
- **Alert if:** an escalated item sits unread > 24h

## Do NOT notify
- On every run
- On findings that need no decision

> Design against approval fatigue. A gate everyone clicks through is a ritual, not a control.
> Gate few things — and gate the ones that matter.
