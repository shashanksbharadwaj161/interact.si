# Backend handoff (Claude Code → Codex), 21 October 2026

- **Branch:** `claude/compassionate-hawking-m9x36g`
- **Base:** b3c9e0b, fast-forwarded with no merge.
- **Scope:** only `jarvis-desktop/electron/**`, backend tests and this document. No `src/**`, `package.json` or `AGENTS.md` file was edited.
- **Compatibility:** every change below is additive or opt-in, so pages that do not use it behave exactly as before.

## Checkpoint 1: screen-aware Claude journey (backend half)

### Exact contract changes

All of these live in `electron/**`. For each, what the renderer needs to do:

1. **`AgentEvent` status (`electron/services/agent.ts`).**
   - Before: `{type: 'status'; phase: 'sending' | 'thinking'}`.
   - Now: `{type: 'status'; phase: 'sending' | 'thinking'; retry?: number}`.
   - `retry: 1` means the step failed temporarily (no connection, HTTP 429/503/529, overloaded) and is being sent once more. There is never a second retry.
   - **No new event types were added to `AgentEvent`.**
   - Renderer: nothing is required. Optionally show "Trying again" when `retry` is set.

2. **New push: streamed reply text, opt-in only.**
   - Shape: `{type: 'run-text'; run: string; step: number; text: string}`.
     - `run` holds the run id; the key is deliberately not `runId`, so the existing `'runId' in e` branches never see it.
     - `step` is the model step (1 to 5).
     - Text streamed in a step that then asks for tools is narration, not the answer.
     - The final answer still arrives as the usual `{runId, event: {type: 'answer'}}`.
   - The push is sent **only** when the page passes `streamText = true` as the fourth argument to ask (item 3). Current pages never pass it, so they never receive it.
   - Renderer to opt in:
     - append `text` for the current run;
     - clear it on `answer` or `error`;
     - ignore it when `run` is not the current run id.

3. **`companionAsk` takes a fourth argument.**
   - IPC shape: `companionAsk(text: string, token?: string, withTarget?: boolean, streamText?: boolean)`.
   - Preload: `window.companion.ask(text, token?, withTarget?, streamText?)`.
   - Proposed `src/companion/api.ts` type: `ask(text: string, token?: string, withTarget?: boolean, streamText?: boolean): Promise<{runId: string}>`.

4. **New method `companionOutbound`.**
   - IPC: `companionOutbound(text: string, token?: string, withTarget?: boolean)`.
   - Preload: `window.companion.outbound(text, token?, withTarget?)`.
   - Behaviour:
     - It returns exactly what an ask with the same arguments would send, and sends nothing.
     - It reads the selected area **without using it up** (`ScreenContext.peek`). An expired token gives `{ready: false, reason: 'The selected region expired. Select it again.'}`.
     - It is built by the same function as the request (`firstUserContent` plus `companionPlan`), and a test checks that the preview text blocks equal the sent ones.
   - Proposed `src/companion/api.ts` type (mirrors `CompanionOutbound` in `electron/backend.ts`):

   ```ts
   export type CompanionOutbound =
     | {ready: false; reason: string}
     | {
       ready: true;
       provider: 'anthropic';
       host: string;                       // 'api.anthropic.com'
       model: string;
       blocks: {kind: 'context' | 'request'; text: string}[];   // verbatim, in send order (the image goes first when present)
       image: {width: number; height: number; bytes: number; mediaType: 'image/png' | 'image/jpeg'} | null;
       imageSupport: 'supported' | 'unsupported' | 'unknown';    // from the provider's model list, only if checked in Settings
       target: {process: string; title: string} | null;
       tools: string[];
       maxSteps: number;                    // 5
       maxOutputTokensPerStep: number;      // 16000
       notSent: string[];
     };
   outbound(text: string, token?: string, withTarget?: boolean): Promise<CompanionOutbound>;
   ```

5. **`region` push: two added fields.**
   - Shape: `{type: 'region'; token; preview; width; height; sourceScale; bytes: number; mediaType: 'image/png' | 'image/jpeg'}`.
   - Proposed type: add `bytes?: number; mediaType?: 'image/png' | 'image/jpeg'` to `RegionEvent`.

### Behaviour changes in main

- **Transport.**
  - The companion now sends each step as a **streamed** Messages request (`streamAnthropicMessage` in `cloud.ts`), through the same guarded `cloud-chat` route with a single `x-api-key` header.
  - Content blocks are rebuilt exactly (text, `tool_use` JSON input, thinking with its signature) and validated by `parseAnthropicMessage` before any tool runs.
  - Incomplete tool JSON is a protocol error and nothing runs.
  - Stop ends the stream with `StreamAborted`; nothing is sent after Stop.
- **Retry.**
  - At most one automatic retry per step, and only for temporary failures.
  - Never after text has streamed for that step, and never for a rejected key or an HTTP 400.
  - Stop during the wait ends the run as `cancelled`.
  - No tool has run in a failed step, so a retry cannot repeat an action.
  - Activity reads `(N steps, M retried)`.
- **Image encoding and checks.**
  - **Encoding bound:** PNG while it is at most 3.7 MB, otherwise JPEG at quality 88, 75, then 60. If none fits, the picker answers "Select a smaller area" and nothing is kept.
  - **Image capability:** taken from the provider's own `/v1/models` capabilities (`image_input.supported`), cached in memory when the person checks models in Settings. If it says unsupported, the image is never sent; unknown is allowed and labelled `unknown`.
- **Picker cancel fix.**
  - Before: Stop, lock or close during the 160 ms step-aside or the capture left the pet hidden until the next shortcut press.
  - Now: the island comes back at rest (`showInactive`), and the late picker still never opens.
- The thumbnail stays in memory only: it is a data URL made from the same crop, and nothing is written to disk. The full-display image is dropped on submit, cancel, lock or close. There is no full-screen capture without the explicit picker.

### Tests

| File | Covers |
|---|---|
| `tests/companion-screen.test.mjs` (15 tests, new) | Stream rebuild, chunk boundaries, header rule, incomplete, malformed or in-stream errors, status-only HTTP errors, Stop mid-stream and before sending, retry rules, encoding bound, block order and JPEG type, `peek` vs `take` vs expiry vs replacement, capability parsing, preview equals sent, unsupported model refusal, retry through the guarded transport |
| `tests/companion-agent.test.mjs` | Fakes now answer `stream: true` with SSE generated from the same messages (21 of 21 pass) |
| Full suite on Linux | 1774 tests: 1759 pass, 15 fail. The 15 are the same Windows path, junction, DPAPI and session-filter baseline, checked by name. |

### Not verified here (Windows or live checks for Codex)

- A real `desktopCapturer` crop at 125%, 150% and 200%, and on a second monitor.
- JPEG fallback on a photo-heavy area.
- The pet reappearing after lock during the step-aside.
- A live Claude image answer.
- Streamed text on the real island (after the opt-in is wired).

## Checkpoint 2: semantic UI Automation for the attached app (backend)

### Contract changes

- **No new IPC methods or push types.** The renderer does not need any change to use this.
- **Two new agent tools.** Their tool events use the existing `AgentEvent` `tool` shape (`tool` is the tool name).
  - Both are offered to Claude only when the person kept the remembered window attached (`withTarget`) and the native adapter has the UIA helpers.
  - **`inspect_app`** (label "Looking at <app>'s controls")
    - Read-only. No confirmation.
    - Result: snapshot id, plus elements `{ref: 'e7', role, name, automationId?, parent?, enabled, offscreen, actions[], state?, refused?}`.
  - **`act_in_app`** (label "Using <app>")
    - Input: `{snapshot, ref, action}` only.
    - Action is one of `invoke | toggle | expand | collapse | select | focus | scroll_into_view | scroll_up | scroll_down`.
    - Phases: `running`, then `awaiting-confirm` while the native dialog is open, then `done`, `declined` or `failed`.
    - `verified` is true only when a fresh read-back shows the expected state.
    - Invoke and scroll always report `verified: false` with "Not independently verified".
    - There is no `undo` handle. Nothing here is reversible by the app.
- Suggested renderer copy:
  - "Done · checked" when `verified` is true.
  - "Done · not checked" when it is false.
  - No done light without `verified` (the island reducer already follows this rule).

### Safety, as implemented (`electron/services/uia.ts`)

- **Snapshot.** Each snapshot is bounded:
  - same process id only;
  - at most 150 elements and depth 12, helper walk at most 8 s;
  - labels at most 120 characters, with control and direction-override characters removed;
  - values at most 200 characters, and never read for password fields.
- **Refused elements.** These offer no actions: password fields, disabled elements, unlabelled elements, and an element whose role and label match another one when neither has an automation id.
- **Refs.** A ref is valid only in the current snapshot.
  - A snapshot expires after 60 s and goes stale after any action; Stop clears it.
  - A snapshot for a different hwnd or pid is refused.
  - Claude cannot pass coordinates, runtime ids, indexes or extra keys; validation rejects them.
- **Confirmation.** The native confirmation names the app, process id, window title, element role, label and id, and the effect.
- **Checks after Continue.** These run after the person presses Continue and again just before the helper runs:
  - the window list is read again: same hwnd, same pid and process name, `elevated === 0`, not minimized;
  - the window is still attached and the bubble is open;
  - Stop was not pressed;
  - the snapshot has not expired.
- **Helper (`native/uia-act.ps1`).** It finds the element again by runtime id, with these refusals:
  - zero matches or more than one: refused;
  - type, name or automation id differ from the snapshot: refused;
  - password, disabled or another process: refused.
  - It then runs exactly one UIA pattern call and reads the element back.
- **Helpers in general.**
  - There is no `SendInput`, click or keystroke path, and no shell or script evaluation (a test greps for these).
  - The helpers are integrity-checked with `uia-common.ps1` (`SCRIPT_HELPERS` in `runner.ts`).
  - The existing `type_into_app` protections are unchanged.

### Tests

- `tests/companion-uia.test.mjs`: 11 tests on a fake desktop, with one full backend journey through the guarded streamed transport.
- Full suite on Linux: 1785 tests; 1770 pass and 15 fail. The 15 are the same baseline failures as before.
- `npm run build` passes, and the helper manifest lists all three UIA files.

### Must be checked on Windows

These helpers have **never run**; they are written for Windows PowerShell 5.1 UIAutomationClient.

- Calculator: inspect, press a digit, toggle "Keep on top", confirm the read-back.
- Notepad menus: expand and collapse.
- A UWP or Chromium app, to see how much of its tree is reachable.
- An `Invoke` that opens a modal dialog. It can block the helper; the 20 s timeout ends it and the action reads as not done, which needs to be confirmed in practice.
- An elevated window and a password field (both should be refused).
- Runtime-id stability across the inspect → act gap.

### P2 review fixes (b1c7eab)

- **Uncertain effect.** If the UIA helper fails, times out or is stopped *after* it received the action, the receipt is now `{performed: 'uncertain', summary: 'Unknown whether it happened. Check <app> before trying again', reason, note}`, not "not done".
  - The `act_in_app` event is `phase: 'failed'` and `verified: false`, and the tool result says `performed: 'unknown'` with "do not retry automatically".
  - The snapshot goes stale, so Claude must inspect again before any further action.
- **Toggle verification.** A toggle is verified only when both the before-state and the after-state are known (`On`, `Off` or `Indeterminate`) and they differ.
- **Duplicates.** Elements that share role, label **and** automation id are refused as ambiguous, including when the id is present.
- **Scroll.** The `ScrollVertical` calls are unchanged; they are in the .NET `ScrollPattern` API.

## Checkpoint 3: saved work and routines in the companion (backend)

### Contract changes

1. **`UndoHandle`** (`electron/services/agent.ts`).
   - Before: `{kind: 'task'; id; label}`.
   - Now: `{kind: 'task' | 'note' | 'task-done'; id; label; target?; stamp?}`.
   - A created task keeps `id` equal to the task id, as before.
   - New kinds use opaque ids: `note:<noteId>` and `done:<taskId>`.
   - The page still calls `companionUndo(id)`. Main now remembers the whole handle per id (`Map`), uses it at most once, and calls `backend.companion.undo(handle)`.
   - **Renderer: no change needed.** If code switches on `undo.kind`, add the two new kinds.
2. **Five new agent tools.** They use the existing `tool` event shape.

   | Tool | Label | What it does | Confirmation | Read-back and undo |
   |---|---|---|---|---|
   | `save_note` | "Saving a note" | Saves a note | Full title, tags and text | Verified; undo deletes the note only if it is unchanged |
   | `complete_task` | "Completing a task" | Marks a task done | Yes; the task is re-read after the dialog | Verified; undo reopens it only if it is still done |
   | `list_routines` | "Looking at your routines" | Lists routines | None | Read-only |
   | `preview_routine` | "Checking a routine (dry run)" | Previews every action step through `ActionService.preview` and discards each one | None | Nothing runs |
   | `run_routine` | "Running a routine" | Runs a routine | One island confirmation listing every step; each desktop step still raises its own confirmation | Stop cancels through `RoutineEngine.cancel`; result `verified: false` with per-step statuses |

   - Duplicates: within one request, an identical change (same note text, same task, same routine) is never repeated. The second call returns the first receipt with "(already handled; not repeated)" and no undo.

### Not done or limits

- The companion does not create or edit routines; that stays in the hub editor.
- Schedules are reported as "only while the app is open". There is no OS scheduler.
- Search of approved documents from the companion is not added. `search_saved` covers notes, tasks and capsules only.
- Engine limit: an already-open step confirmation from a running routine is not dismissed by Stop. The run stops before the next step.

### Tests

- `tests/companion-work.test.mjs`: 8 tests, covering the real store and real `RoutineEngine` through the scripted streamed loop.
- Full suite on Linux: 1796 tests; 1781 pass and 15 fail (the same baseline).

## Checkpoint 4: provider readiness and the bounded live-test budget

### Live-test budget (owner request: $2 maximum)

- **Code:** `electron/services/liveBudget.ts`, wired in `electron/backend.ts` and `electron/main.ts`.
- **Operator guide:** `planning/ui-revamp/LIVE-TEST-BUDGET.md`. It gives the exact environment variable (`DESKTOP_COMPANION_LIVE_TEST`, a JSON object with no secrets), the fields and the reservation formula.
- **Coverage:** enforced on every provider request (island, hub chat, connection test), with:
  - an output cap written into the body;
  - at most `maxSteps` island steps;
  - no automatic retry;
  - bounded text and at most one image;
  - a request count limit;
  - a worst-case dollar reservation saved before sending.
- **Misconfigured value:** every provider request is blocked.
- **No variable:** behaviour is unchanged.

### Connection test (backend done; IPC proposal for Codex)

- **Backend.** `backend.providerConnectionTest(provider)` and `backend.providerConnectionTestCancel()` are implemented and tested.
  - The test is one streamed request, "Reply with the single word OK.", with 8 output tokens.
  - It is cancellable and never runs on load.
  - It is not written to the chat history.
  - Errors are status-only.
- **Not exposed to the hub yet.** That needs the shared contract in `src/shared/contracts.ts`, which belongs to Codex.
- **Proposed minimal change**, to be applied by Codex or approved for me to apply:

```ts
// src/shared/contracts.ts
export type ProviderTestResult = {
  provider: string; ok: boolean; model?: string; latencyMs?: number; reply?: string;
  usage?: {inputTokens: number; outputTokens: number} | null;
  estimatedCostUsd?: number | null;   // null when no price is set in Usage
  costNote: string;                    // "Estimated from the price table in Usage. Not a provider invoice."
  reason?: string; cancelled?: boolean; testedAt: string;
};
// FullJarvisAPI gains:
providerConnectionTest(provider: CloudProvider): Promise<ProviderTestResult>;
providerConnectionTestCancel(): Promise<boolean>;
```

Electron side (mine, once the type exists):
- `METHODS` gets `'providerConnectionTest', 'providerConnectionTestCancel'`.
- `ARITY` gets 1 and 0.
- `ARG_SPECS.providerConnectionTest = [{kind: 'enum', values: CLOUD_PROVIDER_IDS}]`.
- The preload gets the two calls.

UI copy (Codex): "Saved key · not tested" until a test passes. Then show "Tested <time> · <model> · <in>/<out> tokens · est. $x".

### Model metadata

- Anthropic image capability now comes from `/v1/models` (checkpoint 1).
- Model ids still come only from the provider list, or from a typed id under Advanced.

### Tests

- `tests/live-budget.test.mjs`: 10 tests. They cover config strictness, the cap rewrite, thinking removal, reservation before sending, persistence across restarts, the request and size limits, a ledger save failure, the image allowance, blocking on misconfiguration, island steps and no retry, the hub chat cap, the connection test path, and offline, keyless, 401, cancel and estimate labelling.

## Next increments (this branch)

- P5: voice hardening.
- P6: OAuth seams and registration checklists.
- P7: release health.
- The requirement map: `planning/ui-revamp/REQUIREMENT-GAP-MAP-2026-10-21.json`.

Each increment will add its exact contract here before it is pushed.
