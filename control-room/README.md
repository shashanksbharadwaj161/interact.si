# Local Agent Control Room

Local React dashboard for external Claude Code workers, backed by the installed Agent Orchestrator CLI. No paid inference starts at application startup. Demo workers are explicitly simulated.

## Run

```powershell
cd "C:\Users\SHASH\Documents\Codex\2026-10-13\windhawk-https-share-google-irsvmyv19hhv6tnkv\outputs\control-room"
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317** in Codex's browser panel. Node 22.12+ recommended. Windows required for protected key storage; demo can run elsewhere.

For a hidden background service, run `./Start-ControlRoom.ps1`. Stop with `./Stop-ControlRoom.ps1`; it revokes provider access and stops the dedicated daemon.

## Connect Claude

1. Providers → enter your Anthropic Console API key → Save protected key. Do not put the key in chat.
2. Enable online development → Test connection. This lists accessible models without inference. Model aliases are resolved by Claude Code; no assumption that every model name exists.
3. Register an existing Git repository root with at least one commit. The daemon uses its own private registry, leaving your existing AO setup alone.
4. New task → Real Claude worker → select project/model → explicit instructions → Start paid worker.
5. Inspect activity, conversation and files; cancel any time. Mark reviewed never merges or commits.

Start with one worker. Providers allows two after verification. A real paid end-to-end task needs your key and has not been verified without it.

Workers start from the repository's **current committed branch**. Uncommitted changes are not copied into their worktrees. Commit the intended starting state first. Detached HEAD projects are rejected; select a branch.

## Credential design

Windows DPAPI encrypts the key for the current Windows user. `.controlroom` has an ACL restricted to that user. API keys never enter browser storage, task persistence, AO config, CLI arguments or prompts. A scoped local gateway capability is supplied in the selected worker's project environment. The gateway injects the real key only into upstream Anthropic requests. Capabilities are revoked on cancellation and unavailable after restart. This is account-level protection, not isolation from malware running as you.

No gateway capability or real key is exposed in dashboard APIs. Browser API checks loopback Host, same origin, session cookie and mutation token. MCP uses the protected local connection token. Provider traffic is disabled on each restart. No remote dashboard, telemetry or automatic cloud escalation.

## MCP connection to Codex

The dashboard must be running. Register its stdio bridge:

```powershell
codex mcp add local-agent-control-room -- node "C:\Users\SHASH\Documents\Codex\2026-10-13\windhawk-https-share-google-irsvmyv19hhv6tnkv\outputs\control-room\server\mcp.mjs"
```

Reload the Codex chat/app if tools do not appear. Tools: `spawn`, `status`, `results`, `cancel`, `followup`. Real spawning and follow-ups incur charges and require direct user authorization. `spawn` defaults to demo. The bridge does not reconfigure Codex's own models.

## Limits

- Estimated costs use optional per-task rates you enter, including cache rates. Missing relevant rates display **Unpriced**. No balance or $500 credit amount is inferred from API usage.
- Budget threshold blocks subsequent requests after an estimate reaches the budget; an in-flight request can overshoot. Interrupted requests may be billed without complete usage. Check Console billing.
- Resume works only when AO supports it and the same dashboard process still has the grant. After restart, create a fresh task from saved instructions; prior worktrees remain in AO. Online mode is always reset off.
- Worktree actions require Git/Claude Code installed. Supported tool approvals appear in Activity with the provider's explicit decision buttons. Specialized provider questionnaires are displayed as reported activities; their structured answer UI is not implemented yet. Cancel or provide a revised task if blocked on one.
- OpenRouter/local inference adapters and automatic integration/merging are not implemented. Raw provider reasoning is not requested or displayed.

## Verify

`npm test` checks demo lifecycle, local API authentication/CSRF, concurrency, gateway accounting, credential redaction, cancellation, DPAPI, restart safety and MCP discovery. `npm run build` includes TypeScript checking. `node tests/browser.mjs` uses installed Edge headlessly for browser smoke checks. `node tests/live-orchestrator.mjs` runs the real AO/Claude harness in an isolated fixture with synthetic upstream responses: no paid inference. It verifies worktree launch, conversation, SSE token accounting and cancellation. `node tests/orchestrator.mjs` checks the dashboard's live daemon connection without spawning workers.

Local state is ignored by Git. Back up source and task records separately; never copy decrypted keys. Runtime state and MCP token live under `.controlroom/`.
