# Parallel launch recovery proposal (captain, 15 October 2026)

Scope: read-only review of `outputs/control-room/server/adapter.mjs` and `server/index.mjs` only. No Control Room runtime edit, restart, private runtime, credential or budget access. Nothing here has been applied.

## What failed

Nine of twenty specialists did not launch: seven with model discovery timeout / stale catalog, `status` with ACP initialize timeout, `models` with worktree provision timeout. No queued retries remain.

## Root cause in `adapter.mjs` `Orchestrator.spawn()`

1. Every launch calls `POST agents/claude-code/models/refresh?projectId=…&revalidate=true` through `api()`, which aborts after 20 s and has **no catch**. A stale/slow catalog therefore throws before `ao spawn` runs, even though the launch already pins the model (`--model task.model`) and the project config already pins `ANTHROPIC_DEFAULT_*_MODEL` ids. The catalog is not needed to choose the model.
2. The refresh is per-spawn with `revalidate=true`, so a twenty-worker batch makes twenty revalidating discovery calls that contend with each other and with the gateway. Once the temporary discovery proxy closed, every later refresh hit the same failure.
3. `set-config` rewrites the project env (including the gateway URL) on every spawn. That is correct for per-session gateways but means a refresh failing after `set-config` leaves the project config pointing at the last attempted gateway. This is harmless for already-running sessions (they hold their own env) but is worth recording.
4. ACP initialize and worktree provisioning happen inside the single `ao spawn` CLI call (120 s timeout). Under the measured 638 MB RAM / 575 MB virtual-memory headroom, these are resource timeouts, not catalog problems; retrying immediately would fail the same way.

## Proposed change (not applied)

```js
// adapter.mjs: wrap only the catalog refresh; everything else unchanged.
const PINNED = new Set(Object.values(config.env).filter((v) => /^claude-[a-z]+-\d/.test(v)));
const key = task.projectId + '|' + gateway;
let catalogStale = false;
if (!(this.refreshedAt?.get(key) > Date.now() - 10 * 60_000)) {
  try { await this.api(`agents/claude-code/models/refresh?projectId=${encodeURIComponent(task.projectId)}`, {method: 'POST', body: '{}'});
        (this.refreshedAt ??= new Map()).set(key, Date.now()); }
  catch (e) { if (!PINNED.has(task.model)) throw new Error(`Model catalog unavailable and ${task.model} is not pinned`); catalogStale = true; }
}
// …spawn as before; return {id, catalogStale} and let the room log "launched with stale catalog".
```

- Best effort only for **pinned** model ids. An unpinned id still fails closed, with no guessed model.
- One refresh per project and gateway within ten minutes, without `revalidate=true` on every spawn. Revalidation stays available as an explicit operator action.
- Resource gate before `ao spawn`: defer (stay queued, not failed) while `os.freemem()` is below a configured floor (suggest 1.5 GB). Classify `ACP initialize timeout` and `worktree provision timeout` as **retryable-deferred**, with at most one automatic retry after the gate passes.
- Idempotency: before any retry, look up an existing session by `--name` (`ao session ls --json`) so that a slow-but-successful first spawn is never duplicated.

## Verification performed

A throwaway script in a namespaced temporary directory imported the real `adapter.mjs` `Orchestrator` class and replaced only `cli`/`api` with in-memory stubs. No daemon, network, gateway or credentials were used:

| Probe | Result |
|---|---|
| Current code, refresh throws `TimeoutError` | launch rejected, **0** `ao spawn` calls |
| Proposed wrapper, stale catalog + pinned `claude-haiku-5-5` | spawned, `catalogStale=true` |
| Proposed wrapper, stale catalog + unpinned id | refused: "not pinned" |
| Proposed wrapper, healthy catalog, two spawns same project+gateway | **1** refresh call |

These were 4/4 assertion probes. The resource gate and idempotent retry are design proposals only and were not exercised.

## Not proposed

Any increase in concurrency, budget or capacity; new workers; changing the per-session gateway or budget reservation logic in `index.mjs`; or reading or writing private runtime, credential or settings files. Applying the patch is a root decision followed by a Control Room restart that root owns.
