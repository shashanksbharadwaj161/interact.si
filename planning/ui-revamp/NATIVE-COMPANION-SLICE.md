# Native companion slice: first milestone (16 Oct 2026)

Branch `claude/compassionate-hawking-m9x36g` (draft PR shashanksbharadwaj161/interact.si#1, not merged). This is gate C of `FUTURE-COMPANION-PLAN.md`: the desktop companion as a real window in the app, with one real Claude path that can see a selected screen region, find saved information with citations, and make one reversible change. The isolated experience prototype (gate B) is unchanged and lives in `jarvis-desktop/prototype/`.

Evidence was produced on Linux under Xvfb. Nothing Windows-specific has been run, so every Windows behaviour below is **unverified until the Windows QA checklist is done**.

## What a person gets

- A small island docked at the bottom-right of the work area, above normal windows, not in the taskbar. It shows when the app starts (not in safe launch or test mode). It appears without taking the keyboard from the app in use.
- **Ctrl+Shift+Space** opens it, with **Ctrl+Alt+Space** as the fallback when the first is taken. The tray menu has "Show / hide the companion island". The hub's own hotkey (Ctrl+Alt+J) is unchanged.
- **Command surface:** type a request and press Enter.
  - Not connected: the input is disabled. It says exactly what is missing (offline mode, a provider other than Anthropic, or no key) and links to Settings › AI.
  - The footer says what will be sent.
- **Select a region:**
  - The island steps aside and the main process takes one picture of the display under the pointer.
  - A full-screen picker shows that frozen picture. Drag, then press Enter or choose "Use area". Other options are "Whole screen" and Cancel/Esc.
  - Only the crop is kept, in memory, behind a random single-use token that expires after 5 minutes. The island shows a preview chip with Remove.
  - The picture is sent only with the next request, then forgotten.
- **Working:**
  - Real progress from the main process: the request is in flight, a tool is running, or the request is waiting for the Windows confirmation.
  - Stop, or Esc, aborts the provider request; anything already confirmed stays done.
- **Answer:**
  - A short reply with chips for the saved items it relied on. Clicking a chip opens that item in the hub.
  - It shows a receipt with **Undo** for anything it changed.
  - It shows a line for anything declined or failed.
- **Errors:** each has its own title, so they are never confused:
  - Not set up yet
  - Stopped
  - Declined by Claude
  - Cut off
  - Stopped after too many steps
  - Claude could not answer
  - Could not reach Claude
- **Edge light:** follows real state only.
  - Hover or focus gives a still soft rim.
  - A request in flight sends one slow trace.
  - Waiting for the confirmation holds a violet rim.
  - An answer gives one lime sweep, then the light goes off.
  - An error holds an amber rim.
  - Idle has no moving light. Under reduced motion the light is static, and in high contrast it is replaced by a system outline.

## The milestone journeys

| Journey | Status | What really happens |
|---|---|---|
| 1. Ask about a selected region | **Working (Linux evidence), Windows unverified** | `desktopCapturer` takes one picture in main → picker → crop at the measured scale (image px ÷ DIP) → scaled to ≤1568 px long edge → PNG image block, sent before the text, in one Anthropic Messages request |
| 2. One reversible action | **Working for tasks** | Tool `create_task`. The Windows confirmation names the exact title and date, with Cancel as the default. The new task is read back from the saved list before it is reported as done. Undo deletes exactly that task, and only from this session's receipts |
| 2b. Type into an open app | **Not done** | Next task, below. The companion has no tool that acts in other apps yet |
| 4. Find saved information with a citation | **Working** | Tool `search_saved` (the hub's real local search) and `read_saved_item`. Answers can cite only ids a tool actually returned. A note citation opens that note in the hub. **Partial:** a task citation opens the Tasks list without selecting the task, because the Tasks view ignores `item` |
| Failures and cancellation | **Working** | Shown in the review: offline, no key, cancel mid-request (provider request aborted), declined confirmation, HTTP 529, dropped connection, region Escape, and region single use |
| 3. Dictation, 5. routines | Not started | Voice, routines and accounts come after this milestone, per the plan |

## Evidence

`planning/ui-revamp/native-companion/` holds 16 screenshots and `review-report.json`. They were produced by `jarvis-desktop/scripts/companion-review.cjs`, which drives the real app: windows, preloads, IPC checks, tool loop, task store and undo.

The driver makes three substitutions, all inside the script and none in the app. The report repeats them in its `scripted` field.

1. **Provider.**
   - Global `fetch` is replaced for `https://api.anthropic.com/v1/messages` only, and returns replies written in the script. **These replies are not Claude.**
   - Every other fetch is refused, so no request left the machine.
   - The report still records what the app sent:
     - method POST;
     - `x-api-key` present and no `authorization` header;
     - `anthropic-version: 2023-06-01`;
     - the tool list;
     - the image block's type and size.
2. **Key protection.** A reversible stand-in for Windows key protection, which is Windows only. The key is a placeholder string.
3. **Confirmation.** The script answers the native dialogs (Continue or Cancel) and records their exact text.
   - The app's rule still applied first: a dialog appears only when its owning window is visible and focused.
   - Going online needed the hub's own confirmation, and that dialog was answered the same way.

**Composited images.** Screenshots 01–05 and 07–16 are composited for review: the island window's own pixels are placed over the hub window's pixels at their real screen positions. Without a compositor, Xvfb cannot show real transparency, so a real Windows screen recording is still required.

Run it on any machine:

```
cd jarvis-desktop
npm ci && npm run build
npx vite preview --port 5173 --strictPort --host 127.0.0.1   # in another terminal
VITE_DEV_SERVER_URL=http://127.0.0.1:5173 npm run companion:review   # add -- --no-sandbox only when running as root on Linux
```

## Security model (what changed and what did not)

- **The hub's IPC table, ARG_SPECS, preload, network guard, offline default and key vault are unchanged.**
  - `tests/full-security-regressions.test.mjs` now asserts:
    - the exact hub channel set;
    - the exact companion channel set, and that no other channels exist;
    - the island's webPreferences: contextIsolation, sandbox, no node integration, devTools off when packaged;
    - the island's own preload; popups denied; navigation to a site or to the hub page refused;
    - no screen capture at startup.
- **The companion page** (`companion.html`, with its own CSP) gets `window.companion` from `electron/companionPreload.ts` and nothing else. Every call checks:
  - the main frame;
  - the exact trusted companion URL;
  - the right window: overlay methods only from the overlay, the rest only from the island;
  - the argument specs (`electron/companionCore.ts`).
- **Layout:** the page sends only a size and an anchor, never a position. Both are clamped, and the window always fits the display's work area.
- **Screen capture** runs in main only, when the person starts a selection.
  - The whole-display picture lives only until they finish or cancel.
  - The renderer gets a preview data URL, never a path.
  - Activity records the selection's size, never its content.
- **Claude** is reached only through the existing guarded fetch. Its existing rules still apply:
  - online mode only;
  - the stored key only;
  - `x-api-key` only;
  - 30 requests per minute.
- **The loop is bounded:**
  - at most 5 model calls and 4 tool calls per step;
  - every tool input is validated before it runs;
  - a reply cut off by `max_tokens` never runs a tool;
  - a refusal stops the request.
- **Text in saved items, tool results and screen images is data, not instructions.** The system prompt says so, and tool results are labelled.
- **A change to saved data** goes through a trusted native confirmation owned by the island, with Cancel as the default. It fails closed when the island is not visible and focused. Test mode never creates the island, so no test-mode auto-approval can reach it.
- **Activity** records that a request went to Anthropic, its step count and its token usage. It never records the content.

## Unverified or not yet built (honest list)

- **Windows material:**
  - Acrylic is off by default. `companionSetMaterial('acrylic')` exists but has no UI.
  - On Windows the material fills the whole window rectangle, including the transparent margin kept for the shadow and edge light, so it may show a rectangle around the rounded island. Verify before exposing it.
  - The default surface is solid smoked glass at 97% opacity. CSS blur cannot blur the desktop behind a transparent window, so it is not used.
- **Focus return:** collapsing calls `blur()` so Windows reactivates the previous window. This is unverified, and a stronger restore may be needed.
- **Placement:** the island is fixed at the bottom-right. Top and right anchors exist in code and preferences but have no UI, and there is no drag yet.
- **Multi-monitor:** the island follows the display it is on, and re-places on display changes. The picker covers only the display under the pointer.
- **DPI:** crop maths is unit-tested at 100/125/150/200%. Real mixed-DPI setups need checking.
- **Capture limits:** protected content (DRM video, secure desktop or UAC prompts) captures black. The island hides 160 ms before capture; check it never appears in the picture.
- **Default model:** the model is the hub's selected Anthropic model, `claude-haiku-4-5` in a fresh profile. Changing it is a Settings decision, not part of this slice.
- **Not built:**
  - a Settings page for the companion (personality, appearance, anchor);
  - voice;
  - typing into other apps;
  - routines;
  - accounts.

## Windows QA checklist (local review)

Run each item on Windows 11 with a real Anthropic key, using ordinary usage only, and record a screen video.

1. `npm ci && npm run build && npm start`. The island appears bottom-right above the taskbar. It is not in the taskbar or Alt+Tab, and the focused app keeps typing focus.
2. Press Ctrl+Shift+Space: the island opens and takes focus. Esc or Ctrl+Shift+Space collapses it, and focus returns to the previous app; type to check. Repeat over a full-screen video and a maximised app.
3. Offline (the default): the input is disabled with "AI requests are off…". Settings › AI link opens the hub. Nothing is sent; check the Activity log.
4. Go online with a key. Ask "What are my notes about?" The answer shows note chips, a chip opens that note, and Activity shows "Companion request sent to Anthropic (N steps)".
5. Select a region over a chart or text. Check:
   - the island is absent from the frozen picture;
   - the selection is exact at **100%, 125%, 150% and 200%** scaling (Settings › Display);
   - "Whole screen" works;
   - Esc cancels and leaves no chip;
   - the answer describes the region.
6. Ask again without a new region. No image is sent; the request size is in Activity.
7. "Remind me to call the bank tomorrow". Check:
   - the Windows confirmation names the title and date, and Enter or Esc means Cancel;
   - Continue adds the task, and the receipt shows Undo;
   - Undo removes it from Tasks;
   - Cancel adds nothing and the answer says so.
8. Ask for a task, then click another app before the confirmation appears, so the island loses focus. The confirmation must fail closed, and the companion must report "Not confirmed. Nothing was saved".
9. Start a long request, then press Stop or Esc. It shows "Stopped" and nothing further runs.
10. Disconnect the network: "Could not reach Claude". Enter an invalid key: "rejected the API key". Neither shows any key text.
11. Two displays with different scaling: move the pointer to the second display and select a region there. Unplug a display while the island is on it; it must re-place itself.
12. Reduced motion (Settings › Accessibility › Visual effects › Animation effects off): there is no moving edge light. High contrast: the island shows a system outline, and text is readable.
13. Idle cost: with the island resting for 5 minutes, Task Manager shows near-zero GPU and CPU for the companion renderer.
14. Optional: in DevTools for the island (dev builds only), call `companion.setMaterial('acrylic')`. Record what Windows shows, especially any rectangle around the island, then set it back to `'none'`.
15. Safe launch (two unclean exits): no island, no shortcut, and the hub still works.

## Exact next task

**Journey 2b: one reversible action in an open app.**

1. Add an agent tool `type_into_focused_app` that wraps the existing ActionService `type-text` preview → execute path.
   - It needs a new tool definition in `electron/services/agent-tools.ts` and a deps hook in `backend.ts`.
   - Run it only after the island has collapsed and focus has returned to the target window.
   - The Windows confirmation must show the target window's title and the exact text, with Cancel as the default.
   - Undo means "select what was typed and delete it", offered only when it can be checked. Otherwise the receipt says it cannot be undone.
2. Call `ActionService.cancelPending` when settings change, as the capability inventory notes.
3. Add a Companion section to Settings: anchor (corner, top or right), shortcut display, personality (the three tones `companionSystemPrompt` already supports) and a material toggle, labelled experimental, once item 14 above is verified.
4. Then add voice (push-to-talk into the same command surface), routines and accounts, then installed-build verification (`npm run package:win`, then rerun this checklist on the installed app).
