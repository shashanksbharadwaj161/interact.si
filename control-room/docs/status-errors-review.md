# Status error review — Control Room

## Finding

`deriveStatus` in `server/room.mjs` mapped any `idle` or `exited` worker (activity or session status) directly to `review`. A worker that went idle because of a spending-ledger denial, a context-window limit, or a provider/worker error therefore looked ready to inspect, and "Mark complete" was offered for output that may be incomplete.

## Change

- `server/status-errors.mjs` (new): `classifyStop(session, events)` separates three stop kinds from explicit error text only (session error fields and `error`/`budget` task events recorded since the last launch or explicit resume):
  - `budget` → blocked, `awaiting input`; retry text says nothing was reset or raised.
  - `context` → blocked, `awaiting input`; retry text says to create a new task, worktree stays in Orchestrator.
  - `worker-error` → error, `failed`.
  - no evidence → success, `review` (unchanged behavior for clean idle).
  - Stale budget or error events from before an explicit resume are ignored.
- `server/room.mjs`:
  - `deriveStatus(session, events = [])` consults the classifier before returning `review`. The existing signature still works with no events.
  - `poll` records `task.stopReport` (`{outcome, kind, reason, retry}`, reason redacted), logs a readable `Blocked: …` or error event on transition, and clears the report when the worker runs again.
  - Budget and context stops revoke gateway authorization (like failures), so follow-ups cannot keep the route open. The ledger still enforces spending.
  - `resume` refuses budget and context stops with the retry text and does not reset any budget.

## Not changed

- No budget reset, no automatic re-authorization, no change to the spending ledger (`server/budget.mjs`) or gateway (`server/index.mjs`).
- The service was not restarted; root activates after review.

## Tests

`tests/status-errors.test.mjs` (12 tests): classifier outcomes, budget events before resume, `deriveStatus` mapping, and `poll` with a fake adapter for budget, context, worker-error, clean-idle, and recovery paths. Run with `node --test tests/status-errors.test.mjs tests/room.test.mjs`: 16/16 pass.

## Limitations

- Classification relies on the error text the Orchestrator and gateway expose. A context or budget message worded differently will fall back to `review`. The regex list is in `server/status-errors.mjs` and should be extended from real transcripts.
- The gateway returns budget denials as HTTP 502 messages that the room records as `error` events. The classifier treats those as budget stops only when the text matches the budget patterns.
