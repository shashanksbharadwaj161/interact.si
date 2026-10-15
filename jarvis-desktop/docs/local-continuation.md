# Local continuation — no extra Anthropic spend

14 October 2026. The Control Room input indicator represented task-budget/context blocks, not pending user approvals. AO metadata reported no pending approval or user-input activities; development workers already used bypass-permissions.

Changes verified:
- UI separates blocked budget/context tasks from actual Needs your input. Four focused tests and dashboard build pass; live browser verified Needs your input = 0.
- Gateway sends permanent budget denials as HTTP 402, context/schema errors 400 and policy denials 403. Unknown transport/provider failures remain 502. This prevents Claude SDK retrying permanent budget stops as temporary server failures. Control Room suite: 40 pass.
- Stalled cloud workers stopped; source worktrees and all spending reservations retained. $300 ceiling and $30 reserve unchanged. Local Codex helpers continue without additional Anthropic requests.
- Model-pack validation/import rejects ancestor and nested junctions before content access and rechecks before streaming. 54 targeted model/security tests and typecheck pass.
- OAuth fragment secret redaction fixed; connector + model-path targeted checks: 32 pass.

In progress: local completion of motion timeline controls, seven UX review fixes, combined app validation and rebuilt unsigned personal installer. Existing installer predates these changes. Native microphone/input, OAuth accounts and signing remain separate user/runtime gates; no false acceptance claimed.
