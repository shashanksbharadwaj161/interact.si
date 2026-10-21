# Bounded live-provider testing (owner-authorized, $10 maximum in total)

> **Updated 21 Oct 2026:** the owner raised the total to **$10**, replacing $2. Use **one** `budgetId` for all live testing, with `"maxReservedUsd":10`. The ceiling is enforced per budget id, so a second id would start its own ledger. This app does not track a total across ids.

This setting applies in the main process to **every** request that leaves the computer for a model provider: island steps, hub chat (streamed or not), and the connection test. It does not depend on prompting the model to be brief.

- Without it, the app behaves as before.
- It contains **no secret**. The API key is entered as usual in Settings › AI (stored protected) and is never read, printed or needed by this mechanism.

## Turning it on (isolated Windows review launcher)

Set one environment variable for the review process only, then start the app from the same shell:

```powershell
$env:DESKTOP_COMPANION_LIVE_TEST = '{"budgetId":"review-2026-10-21","model":"claude-haiku-4-5","maxOutputTokens":256,"maxSteps":3,"maxBodyChars":60000,"maxRequests":40,"maxReservedUsd":10,"inputPerMillionUsd":<IN>,"outputPerMillionUsd":<OUT>}'
npm start   # or the review launcher; the variable is read once at start-up
Remove-Item Env:DESKTOP_COMPANION_LIVE_TEST   # afterwards
```

**`model`** must be one of the models listed in `MODEL_PRICE_FLOOR` in `electron/services/liveBudget.ts`. Any request for another model is refused, so select the same model in Settings › AI.

**`<IN>` and `<OUT>`** are USD per million tokens. They must be **at least** the floor for that model, or the configuration is rejected.
- The floors come from Anthropic's model documentation as bundled with the claude-api reference (October 2026). For Claude Haiku 5.5, the higher long-prompt card is used.
- Floors per model:

  | Model | Input floor | Output floor |
  |---|---|---|
  | `claude-haiku-4-5` | $1 | $5 |
  | `claude-haiku-5-5` | $0.50 | $2.50 |
  | `claude-sonnet-4-6` | $3 | $15 |
  | `claude-sonnet-5` and `claude-sonnet-5-5` | $2 | $10 |
  | `claude-opus-5-5` | $4 | $20 |
  | `claude-opus-5` and `claude-opus-4-8` | $5 | $25 |
  | `claude-fable-5` and `claude-fable-5-1` | $10 | $50 |

- Check the provider's pricing page before the run, and enter higher numbers if prices changed. A model that is not listed cannot be used: it is never silently under-priced.

### The fields

All fields are required; an unknown key is an error.

| Field | Range | Effect |
|---|---|---|
| `budgetId` | `[a-z0-9-]{1,40}` | Names the ledger file `<userData>/live-test-budget-<budgetId>.json`. The same id keeps counting across restarts; a new id starts a new file. |
| `model` | Listed model id | The only model that may be called. |
| `maxOutputTokens` | 1–1024 | Written into `max_tokens` / `max_completion_tokens` of every request. Lower values asked by the caller are kept (the connection test uses 8). `thinking` is removed. |
| `maxSteps` | 1–5 | Most model calls in one island request. |
| `maxBodyChars` | 200–4,000,000 | Most characters of request **text**: system, tools, history and context. Image data is excluded. Raw bodies over 8 MB are always refused. |
| `maxRequests` | 1–500 | Most provider requests for this `budgetId`, in total. |
| `maxReservedUsd` | 0.01–20 | Ceiling on the **reserved** estimated cost for this `budgetId`. |
| `inputPerMillionUsd`, `outputPerMillionUsd` | 0.01–1000 | Prices used for the reservation. |

### What happens on each request

1. The text is measured, and at most 1 image is allowed.
2. The output cap is applied.
3. **Worst-case reservation** = input bound × input price + the full output cap × output price, divided by 1,000,000.
   - Input bound = UTF-8 bytes of the request text + 2048 overhead + 4800 per image.
   - It is an upper bound: a token covers at least one byte. 4800 exceeds the documented 4784-token maximum per image.
4. If the request count or the reserved total would go over its limit, the request is refused with a message and **nothing is sent**.
5. Otherwise the new totals are written atomically to the ledger file, and only then is the request sent. If saving fails, nothing is sent.
6. Reservations are never refunded. The real spend is therefore at or below the reserved total, provided the prices entered are not lower than the real ones.

### Also active while the budget is on

- **No automatic retries.** The island's one retry of a temporary failure is turned off.
- **Model listing** (`GET /v1/models`) is not charged. It is not a model call.
- **Ledger fails closed.** If the ledger file cannot be read, is damaged, or belongs to another budget id, every provider request is refused. The same happens when it holds non-integer or negative request counts, or a non-finite or negative dollar total. Only a file that does not exist yet starts at zero. Delete the file deliberately to start over.
- **Misconfigured value.** If the variable is set but invalid (bad JSON, missing price, out of range):
  - every provider request is refused ("Live-test mode is misconfigured …");
  - Activity records the rejection;
  - the app never falls back to unbounded calls.
- **Activity at start-up** records the active limits. It never records the key.

## Reading the result

- **Ledger:** `<userData>/live-test-budget-<budgetId>.json` holds `{budgetId, requests, reservedUsd}`, with no content and no key.
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

For example, with `claude-haiku-4-5` at $1/$5, `maxOutputTokens` 256 and about 6,000 bytes of request text, each request reserves about (8,048 × $1 + 256 × $5) ÷ 1,000,000 ≈ $0.0093. Check `live-test-budget.json` after each step.
