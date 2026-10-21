# Bounded live-provider testing (owner-authorized, $2 maximum)

This setting applies in the main process to **every** request that leaves the computer for a model provider: island steps, hub chat (streamed or not), and the connection test. It does not depend on prompting the model to be brief.

- Without it, the app behaves as before.
- It contains **no secret**. The API key is entered as usual in Settings › AI (stored protected) and is never read, printed or needed by this mechanism.

## Turning it on (isolated Windows review launcher)

Set one environment variable for the review process only, then start the app from the same shell:

```powershell
$env:DESKTOP_COMPANION_LIVE_TEST = '{"budgetId":"review-2026-10-21","maxOutputTokens":256,"maxSteps":3,"maxBodyChars":60000,"maxRequests":40,"maxReservedUsd":2,"inputPerMillionUsd":<IN>,"outputPerMillionUsd":<OUT>}'
npm start   # or the review launcher; the variable is read once at start-up
Remove-Item Env:DESKTOP_COMPANION_LIVE_TEST   # afterwards
```

`<IN>` and `<OUT>` are the provider's current published USD prices per million input and output tokens for the model selected in Settings. Enter numbers **at or above** the real prices: the ceiling is only as accurate as these numbers. The app does not look prices up.

### The fields

All fields are required; an unknown key is an error.

| Field | Range | Effect |
|---|---|---|
| `budgetId` | `[A-Za-z0-9_-]{1,40}` | Names the ledger. The same id keeps counting across restarts; a new id starts at zero. |
| `maxOutputTokens` | 1–1024 | Written into `max_tokens` / `max_completion_tokens` of every request. Lower values asked by the caller are kept (the connection test uses 8). `thinking` is removed. |
| `maxSteps` | 1–5 | Most model calls in one island request. |
| `maxBodyChars` | 200–4,000,000 | Most characters of request **text**: system, tools, history and context. Image data is excluded. Raw bodies over 8 MB are always refused. |
| `maxRequests` | 1–500 | Most provider requests for this `budgetId`, in total. |
| `maxReservedUsd` | 0.01–20 | Ceiling on the **reserved** estimated cost for this `budgetId`. |
| `inputPerMillionUsd`, `outputPerMillionUsd` | 0.01–1000 | Prices used for the reservation. |

### What happens on each request

1. The text is measured, and at most 1 image is allowed.
2. The output cap is applied.
3. **Worst-case reservation** = (text characters ÷ 3 + 3300 per image) × input price + the full output cap × output price, divided by 1,000,000.
4. If the request count or the reserved total would go over its limit, the request is refused with a message and **nothing is sent**.
5. Otherwise the new totals are saved to `<userData>/live-test-budget.json`, and only then is the request sent. If saving fails, nothing is sent.
6. Reservations are never refunded. The real spend is therefore at or below the reserved total, provided the prices entered are not lower than the real ones.

### Also active while the budget is on

- **No automatic retries.** The island's one retry of a temporary failure is turned off.
- **Model listing** (`GET /v1/models`) is not charged. It is not a model call.
- **Misconfigured value.** If the variable is set but invalid (bad JSON, missing price, out of range):
  - every provider request is refused ("Live-test mode is misconfigured …");
  - Activity records the rejection;
  - the app never falls back to unbounded calls.
- **Activity at start-up** records the active limits. It never records the key.

## Reading the result

- **Ledger:** `<userData>/live-test-budget.json` holds `{budgetId, requests, reservedUsd}`, with no content and no key.
- **Actual usage:** the token counts the provider reported are in Usage, and in the connection test result (`usage`).
- **Cost labels:**
  - Usage costs are estimates from the price table.
  - The test's `estimatedCostUsd` is `null` unless a price is set in Usage.

## Suggested review sequence

Each step is one user action, so the number of requests is known in advance.

1. **Connection test** (Settings › AI, once wired; see the handoff doc):
   - 1 request, 8 output tokens;
   - expect `ok: true`, `reply` "OK", and real `usage`.
2. **Island text question:** 1 to 3 requests.
3. **Island question with a picked screen area:**
   - 1 to 3 requests, plus the image allowance;
   - check `companionOutbound` first: it costs nothing.
4. **Island save_note or create_task** with Continue, then Undo: 2 requests.
5. **Island inspect_app and act_in_app** on Calculator: 3 requests (the step cap).

With `maxOutputTokens` 256 and about 6,000 characters of text, each request reserves under a cent at mid-tier prices. Check `live-test-budget.json` after each step.
