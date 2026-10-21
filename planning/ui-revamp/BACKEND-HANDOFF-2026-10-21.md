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

## Next increments (this branch)

- P2: semantic UI Automation slice.
- P3: saved work and routines.
- P4: provider connection test.
- P5: voice hardening.
- P6: OAuth seams and registration checklists.
- P7: release health.
- The requirement map: `planning/ui-revamp/REQUIREMENT-GAP-MAP-2026-10-21.json`.

Each increment will add its exact contract here before it is pushed.
