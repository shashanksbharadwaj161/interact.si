# Product and interaction review — Desktop Companion

14 October 2026. Reviewer scope: renderer (`src/`), the 140-scope roadmap (`docs/product-roadmap.md`, `src/ui/roadmap.ts`), and the UI-facing docs (`README.md`, `docs/ui-guide.md`, `docs/acceptance.md`, `docs/implementation-status.md`). I read the backend (`electron/`) only to check whether what the UI says matches what the backend does. This document changes no source.

## Method and limits

- This is a static review of the source. I did not run the app in Electron or in a browser, so layout, contrast over animated scenes, screen-reader output and dialog focus were not observed. Findings marked *(verify)* need a runtime check.
- "Broken flow" means that the code, as written, gives a wrong result, a dead end or a misleading state for a normal user path. Each one cites a file and line.
- "Unsupported claim" means user-facing text, roadmap status or docs that say more than the code does, or something different from what it does.
- Fix owners: **UI** (renderer), **BE** (backend/Electron), **C** (shared contract, root-owned), **Docs**.

## Summary

The renderer is careful and largely honest. Every screen has empty states, destructive actions ask for confirmation, the cloud key never enters React state, and there are no scripted replies. Most problems come from the UI and backend drifting apart while being built in parallel:

1. **Action results are misread.** The Computer screen reports *Executed* for actions the backend refused, and the List windows table never renders (P0-1, P0-2).
2. **Model readiness comes from configuration, not the probe.** The backend already probes Ollama, but the UI says it doesn't and shows "ready" based on default settings (P0-3).
3. **Mode claims contradict the backend.** Online mode with no key quietly uses the local model, while three screens say there is no fallback (P0-4).
4. **Validation disagrees.** The UI accepts endpoints the backend rejects, so onboarding can fail at the last step with a raw error (P0-5).
5. **Capability state never gates controls.** Push to talk, Speak and Computer stay enabled when the backend reports them unavailable.
6. **The working name leaks into the UI.** "JARVIS" and "Jarvis" appear in the sidebar, onboarding, settings and Electron chrome, although the product label is Desktop Companion.
7. **Feature Lab mixes "has a screen" with "works"**, and the roadmap doc is stale ("No application features implemented yet").
8. **Windows accessibility gaps:** no forced-colors (High Contrast) support, focus lost when a task moves between groups, noisy live regions, and labels hidden in the compact sidebar.

The interaction direction proposed at the end is one pattern used everywhere: **Capability → Preview → Approve → Outcome.** Every control reads backend capability state, and every outcome is parsed rather than assumed.

## Prioritized fix list

### P0: broken flows and claims that mislead users about safety or results

**P0-1. Refused or failed actions are shown as "Executed".** Owner: UI.
- Evidence: `src/components/Computer.tsx:136-137` treats any resolved `executeAction` as `{kind:'ran'}`. The backend resolves rather than throws for refusals and failures, returning `{executed:false, reason}` for "Not approved", denied, rate-limited, stale preview, policy changed, and native errors (`electron/services/actions.ts:217-242`). The Outcome panel then says "Executed" and prints `{"executed": false, "reason": …}` as JSON.
- Fix: parse the result. `executed:true` → *Done*. `executed:false` → *Not run* with the reason as a warning Notice. A thrown error → *Failed*. When the user clicks Reject, show "You rejected this action" whatever the payload says. Ask the contract owner to type `executeAction` as `Promise<{executed:boolean; reason?:string} & Record<string,unknown>>` instead of `unknown`.

**P0-2. The List windows result never renders as a table.** Owner: UI.
- Evidence: `ResultView` only builds a table when `Array.isArray(value)` (`Computer.tsx:69`). The backend returns `{executed:true, windows:[…]}` (`actions.ts:250`), so users always see raw JSON, including `hwnd` and `pid`.
- Fix: read `value.windows`. Show the title, process, size and a "Protected" badge from `protected`. Add a one-click "Focus" or "Move" that pre-fills the form with `hwnd:<id>`, which the backend already accepts (`actions.ts:201`).

**P0-3. Model readiness is guessed from settings and ignores the backend's real probe.** Owner: UI and Docs.
- Evidence: the backend probes Ollama on `getSystemInfo` and reports `local-llm` with reasons such as "Ollama is not running" or "model … is not installed" (`electron/services/chat.ts:128-143`, `electron/services/system.ts:29`). The UI ignores this:
  - Home and Assistant compute "ready" as "model name and endpoint are non-empty" (`Home.tsx:31`, `Assistant.tsx:72`).
  - The defaults `http://127.0.0.1:11434` and `llama3.2:3b` (`electron/services/validation.ts:21,29`) make that check true on a fresh machine with no Ollama installed.
  - As a result, Home shows no warning, and the Assistant empty state promises "Replies are generated by that model" (`Assistant.tsx:234`).
- Unsupported claims this creates: "The app does not probe the endpoint. Send a chat message to test it." (`Settings.tsx:233`), "The app does not test the connection here" (`Onboarding.tsx:146`), "Whether it is reachable is only known when you send a message" (`Status.tsx:46`), and the same statement in `docs/ui-guide.md` (Limitations).
- Fix: add a `useCapability(id)` helper in the store. Drive the Home warning, the Assistant empty state, the sidebar status and the Status "routes" panel from `local-llm`/`cloud` with their reasons. Add a "Check again" button that calls `refreshSystem()`. Replace the "does not probe" copy with "Checked just now: …". Name the dependency honestly as "Ollama (local)", because the backend speaks only the Ollama API (`chat.ts:47`).

**P0-4. Three screens say there is no fallback, but online mode with no key quietly uses the local model.** Owner: BE decision, then UI copy.
- Evidence: `useCloud = mode==='online' && keyConfigured`, otherwise the route is `local` (`chat.ts:103-104`). The UI states the opposite: "There is no fallback to a local model" (`Assistant.tsx:236`), "Chat will not fall back to a local model" (`Home.tsx:74`), and "it never falls back to the local model" (`Settings.tsx:212`). Acceptance C4 also expects "cloud requests are denied" in this case.
- Fix: preferred, the backend returns a `source:'system'` message "Online mode has no API key; nothing was sent" and makes no local call. Either way, the UI copy must match the backend's actual behaviour. Decision D2.

**P0-5. The UI accepts endpoints the backend rejects, so onboarding can fail on its last step.** Owner: UI.
- Evidence: the backend requires `http:` on a loopback host with no credentials and no empty value (`validation.ts:82-91`). The UI:
  - accepts `https://` and empty values (`Onboarding.tsx:22`, `Settings.tsx:61`);
  - allows remote hosts with only a warning that "Prompts sent in offline mode would leave this machine" (`Onboarding.tsx:155`, `Settings.tsx:228-232`), which is false because the backend refuses them;
  - lets the user click Next past step 3. *Finish setup* then fails with a raw toast ("localEndpoint must be a loopback address…") on the Review step, with no pointer back to the field.
- Fix: share one `validateLocalEndpoint` rule (loopback, http, non-empty) between the UI and the backend. Block Next with an inline error. Remove the "would leave this machine" warning. If *Finish* fails, jump to the step that owns the field and focus it.

**P0-6. The Type text flow cannot work as presented, and approval can hide the text.** Owner: UI.
- Evidence:
  - The UI labels the window as "Window (optional)" and says text "goes to whichever window has focus" (`Computer.tsx:18,191`). The backend *requires* a target window for `type-text` and `click` and focuses it itself (`actions.ts:121`). Left empty, the preview is always "Blocked".
  - The approval dialog shows `safeJson(prev.action, 800)` (`Computer.tsx:316`), but text can be up to 2,000 characters (`Computer.tsx:46`). A user can therefore approve keystrokes they could not see. This is NSR-07 on the UI side.
- Fix: make the window required, pick it from the List windows result, and show the resolved window (title, process) taken from the preview summary. In the approval dialog, show the full text in a scrollable read-only box with a character count, and never truncate it. Warn when the target is a terminal or shell (NSR-07).

**P0-7. The Click action is offered with a full form, contradicting the acceptance spec.** Owner: decision D1.
- Evidence: acceptance G2 says `click` returns `allowed:false` ("Experimental — not enabled"). The backend allows it inside the target window (`actions.ts:149-155`), and the UI offers it as a normal action (`Computer.tsx:19`).
- Fix: either gate it in the backend and show it in the UI as *Experimental, off* with the reason, or update G2 and the roadmap (scope 88 is Expansion, 89/90 Experimental). The current state is shipping a gated feature by accident.

**P0-8. The working name appears in user-facing text.** Owner: UI, BE, Docs.
- Renderer: "JARVIS" brand (`App.tsx:228`, `Onboarding.tsx:49`), "Choose how Jarvis may think" (`Onboarding.tsx:70`), and "Jarvis may…" (`Onboarding.tsx:129,133,146`, `Settings.tsx:272,276`).
- Electron (user-visible): window title and tray tooltip "Jarvis Desktop" (`electron/main.ts:87,143`), the tray menu item "Show / hide Jarvis" (`main.ts:145`), the startup error dialog and page (`main.ts:81,209`), "Jarvis export (JSON)" in file dialogs (`main.ts:38,44`), and messages that reach the UI (`actions.ts:88`, `policy.ts:139`, `store.ts:62,111`).
- Docs: `docs/ui-guide.md` title, `docs/implementation-status.md` ("Working name: Jarvis Desktop").
- Fix: use "Desktop Companion" in all visible strings. Keep `window.jarvis`, `jarvis.ui.*` keys, `JARVIS_*` env vars and the export `format` id for compatibility. Add a test that scans `src/components` and the visible strings in `electron/` for `/\bjarvis\b/i`, excluding technical identifiers.

### P1: trust, state visibility and flow gaps

**P1-1. Model failures look like ordinary replies.** Owner: UI.
- Evidence: the backend turns every route failure into a `source:'system'` assistant message (`chat.ts:119-122`). As a result:
  - the Assistant's red "not answered" Notice (`Assistant.tsx:275-279`) appears only for IPC errors;
  - the failure renders as an "Assistant" bubble with a muted "System" badge;
  - the companion returns to *idle* instead of *alert* (`Assistant.tsx:109`);
  - with auto-read on, the error text is spoken aloud (`Assistant.tsx:110`).
- Fix: render `source:'system'` messages as an inline error card ("Local model unavailable: Ollama is not running") with **Open System status** and **Check again** actions. Set the companion to `alert`, never auto-speak system messages, and call `refreshSystem()` after a system reply.

**P1-2. Controls ignore capability state.** Owner: UI.
- Evidence: Push to talk (`Assistant.tsx:314`), Speak and auto-read (`Assistant.tsx:375-382`) and every Computer action stay enabled when `stt`, `tts` or `ui-automation` is unavailable (`electron/services/speech.ts:47-55`, `system.ts:35-39`). The user discovers this only after recording 30 s or filling in a form.
- Fix: bind each control to a capability id (mapping in the interaction direction below). When unavailable, keep the control visible but disabled, show the backend reason next to it, and link to the fix. Add "Basic (Windows Speech)" to the push-to-talk panel (acceptance F6).

**P1-3. Unsaved edits are lost silently when navigating.** Owner: UI.
- Evidence: the discard guards in Capsules and Notes only cover switching items inside the screen (`Capsules.tsx:77-81`, `Notes.tsx:51-55`). Sidebar links, Alt+number shortcuts and Home buttons call `go()` unconditionally (`App.tsx:55-58,166-176`). The Settings save bar (`Settings.tsx:305-311`) disappears with its draft when you leave Settings.
- Fix: add a shell-level `useUnsavedGuard(dirty)` registry. `go()` consults it and shows the existing Discard dialog. Also handle `beforeunload` for the browser preview.

**P1-4. Safe launch and read-only data are invisible.** Owner: C, then UI.
- Evidence: the backend can enter safe launch (`actions.ts:88`, `system.ts:36`) and can open newer-schema data read-only (`store.ts:111`). The UI has no banner. Users meet these states only as scattered "Safe launch is active" refusals or failed saves.
- Fix: add a contract field, either `SystemInfo.safeLaunch` / `readOnly` or capability rows `safe-launch` and `data-readonly`. Show a persistent shell banner with the cause and the allowed next steps (export, restart normally). Acceptance D7 and J6/J7 depend on this.

**P1-5. Capsule restore confirmation does not say what will be refused.** Owner: C and UI.
- Evidence: the confirm dialog lists raw targets only (`Capsules.tsx:395-406`). App items "may also be limited by your approved apps list" (`Capsules.tsx:320`), and saved window positions "is up to the backend" (`Capsules.tsx:329`). Acceptance H2 requires a preview of items and windows. NSR-01 shows that an import followed by a restore launches with no per-item preview.
- Fix: add a `previewRestore(id)` contract call that returns each item's verdict (will open / blocked + reason) and each window's plan. Show the verdicts in the dialog and allow restoring only the allowed subset. Until that exists, label the dialog "Items are checked when they open; blocked items are reported afterwards."

**P1-6. The capsule scene is never applied.** Owner: UI.
- Evidence: the editor's hint says "Visual backdrop tied to this capsule" (`Capsules.tsx:249`), but the shell always uses the global `scene` preference (`App.tsx:153`). Restoring a capsule does not switch the scene. Roadmap 44 (project-specific visual scene) is Expansion and correctly not claimed, but the hint implies it works.
- Fix: either apply `capsule.scene` after a successful restore (and say so), or change the hint to "Shown in this capsule's card; applying it on restore is planned (roadmap 44)".

**P1-7. The onboarding online path ends in a dead end.** Owner: UI.
- Evidence: choosing Online in step 1 says "no key is requested here" (`Onboarding.tsx:90-92`). Setup finishes in online mode with no key, so chat cannot work, and given P0-4 it actually runs locally. There is no confirmation, unlike Settings (`Settings.tsx:79`).
- Fix: when Online is chosen, add an inline key step that uses the same protected `setCloudKey` path, or save the mode as offline and show "Finish online setup in Settings → Mode & models" on Home. Show the same online confirmation copy in both places.

**P1-8. Home's shortcuts go to a screen, not to the task.** Owner: UI.
- Evidence: "New note" only navigates to Notes (`Home.tsx:44`). Recent capsules are inert rows (`Home.tsx:106-116`), with no open or restore action.
- Fix: open Notes with a new draft focused (for example `#/notes?new` or a shared intent). Make capsule rows open the capsule and add a **Restore…** button that goes through the same preview dialog. Home should be a "resume work" surface, which matches the differentiation goal in the roadmap.

**P1-9. Some keyboard paths are undiscoverable.** Owner: UI.
- Evidence: the 11 views are bound to Alt+1…0, so Developer has no shortcut (`App.tsx:168-169`, `Developer.tsx:91`). The global hotkey Ctrl+Alt+J (`electron/main.ts:16,187`) is not listed anywhere in the UI. The compact sidebar hides the mode indicator below 1000 px (`src/styles/responsive.css:23-28`), although mode is the main privacy signal.
- Fix: reduce the number of nav items (see the proposed information architecture below). List the global hotkey and its "already in use" state in Settings → General and Developer. Keep a compact Offline/Online pill visible at every width.

**P1-10. The focus timer and reminders under-deliver on the roadmap.** Owner: C, UI, BE.
- Evidence: focus sessions are not recorded, so acceptance I3 fails ("Finished sessions are not saved anywhere yet", `Tasks.tsx:87`). Completion is only an in-window toast (`src/ui/focus.tsx:56-61`), so nothing fires when the app is hidden in the tray. Task due dates have no reminder (acceptance I2).
- Fix: none is needed for honesty; the copy is already accurate. To ship scopes 52 and 53, add a contract call for focus events (or an Activity write) and a main-process notification.

### P2: correctness polish

- **Notes:** Ctrl+S does nothing when the only change is a typed, uncommitted tag. `save()` returns early when `!dirty` (`Notes.tsx:70`), but the Save button is enabled for this case (`Notes.tsx:166`). Fold the pending tag into the dirty check.
- **Tasks:** Clear completed deletes items one by one and stops at the first failure, leaving the dialog open with some items removed and no count (`Tasks.tsx:164-174`). Report "Deleted N of M", or ask the contract owner for a bulk delete.
- **Capsules and Notes:** new records are found after saving by diffing ids, and for capsules also by matching the name (`Capsules.tsx:134-140`, `Notes.tsx:82-89`). This breaks when two saves race. Ask the contract owner to have `save*` return `{state, id}`.
- **Restore outcome lists:** keyed by `target` (`Capsules.tsx:343,355`), which collides when a file and an app share a path. Key by index plus kind.
- **Settings:** the voice name is free text (`Settings.tsx:191`), but the backend already enumerates installed voices (`speech.ts:52`). Expose a voice list through the contract and use a select.
- **Computer:** List windows does not require approval (`requiresApproval:false`, `actions.ts:92`), yet the UI still forces the dialog. A read-only action could run straight from the preview, with the dialog kept for anything that changes state.
- **Computer:** changing the action type drops the preview without calling `executeAction(id,false)` (`Computer.tsx:171`). The preview expires harmlessly, but no "Declined" activity entry is written. Decide whether abandoning a preview counts as declining it.
- **Developer:** Copy diagnostics includes capability `reason` strings verbatim (`Developer.tsx:32`). These can contain the endpoint address or raw PowerShell error text (`system.ts:39`), which may include file paths, yet the toast promises "no paths" (`Developer.tsx:36`). Redact the reasons, or soften the promise.
- **Assistant:** the empty-state icon is a speaker (`Assistant.tsx:232`). Use a chat icon.
- **Sidebar:** shows the raw state id "Companion: idle" (`App.tsx:144`). Use the label from `AVATAR_STATES`.

## Accessibility findings

Target: Windows 11 with keyboard, Narrator, High Contrast (forced colors), and 125–200% scaling.

| # | Severity | Finding | Evidence | Fix |
|---|---|---|---|---|
| A1 | High | No forced-colors support. Input focus is `outline:none` plus a `box-shadow`, and box-shadow is removed in High Contrast, so focused inputs are invisible. Switches, segmented controls, badges and the active nav item show state through background color only. | `src/styles/base.css:170-174`. There is no `@media (forced-colors: active)` anywhere in `src/styles`. | Keep a transparent `outline` on `.input:focus-visible` (it turns visible in forced colors). Add a forced-colors block that gives `.switch.on`, `.seg.on`, `.nav-item.active` and badges `border`/`outline` with system colors (`Highlight`, `ButtonText`). |
| A2 | High | Completing a task destroys the focused control. The row moves to another group's `<ul>`, so React remounts it and keyboard focus falls to `<body>`. On Home the row disappears entirely. | `Tasks.tsx:210-215`, `Home.tsx:91` | After the toggle, focus the next row in the same group, or the group heading if it is empty. Announce "Moved to Completed" through a polite status region. |
| A3 | Medium | Noisy or duplicated live regions. The note list is `aria-live`, so every search keystroke re-announces the list. Toasts put `role="alert"` or `role="status"` inside an `aria-live` container, so they are announced twice. Field errors use `role="alert"` and fire while typing (the endpoint field errors on its first character). | `Notes.tsx:131`, `App.tsx:65-67`, `src/ui/primitives.tsx:43`, `Onboarding.tsx:22` | Remove `aria-live` from lists and announce one "N notes match" status instead. Use a single live container without per-toast roles, except for errors. Validate on blur or submit; once an error has shown, update it on change without `role="alert"`. |
| A4 | Medium | Several `role="img"` avatars with changing labels (sidebar plus page copy). Their state changes are not announced. Each is also an extra graphic stop for screen-reader users. | `src/components/Avatar.tsx:20`, `App.tsx:134`, `Home.tsx:143`, `Assistant.tsx:354` | Mark decorative copies `aria-hidden`. Expose the state once as text ("Companion: listening") in a polite status region. |
| A5 | Medium | The compact sidebar (under 1000 px) hides labels with `display:none`. The accessible name falls back to the `title`, but sighted keyboard users get icons with no visible label on focus. The bottom dock under 720 px scrolls 11 unlabeled icons sideways. | `responsive.css:23-28,78-125` | Show a tooltip on `:focus-visible`. Reduce the nav item count (see the information architecture below). Keep labels visible under the icons in the bottom dock. |
| A6 | Medium | Push-to-talk encodes its state twice. `aria-pressed` toggles while `aria-label` also changes ("Recording — release to stop"). Hold gestures are hard for switch and Narrator users. | `Assistant.tsx:311-313` | Use a fixed label "Push to talk" with `aria-pressed`, plus a separate status line ("Recording 0:07"). Make tap-to-start / tap-to-stop the documented primary mode and hold an optional shortcut. |
| A7 | Low | Orphan labels. `Field label="Theme"` wraps a radiogroup that ignores the generated id. Switch descriptions are not linked to the switch. | `Onboarding.tsx:94`, `Settings.tsx:171`, `primitives.tsx:126-140` | Use `aria-labelledby` on the radiogroup. Add `aria-describedby` for switch descriptions. |
| A8 | Low | The settings tabs' `aria-controls` point to panels that are not rendered. There is no Home/End key support. | `Settings.tsx:149,167` | Render all panels and hide the inactive ones, or drop `aria-controls`. Add Home/End. |
| A9 | Low | Every `Panel` with a title is a `<section aria-labelledby>`, which makes it a region landmark. Pages have 6–12 landmarks, which dilutes landmark navigation. | `primitives.tsx:61-64` | Default to `div` plus a heading. Opt in to `section` only for page-level regions. |
| A10 | Verify | Contrast of translucent panels (`rgba(…,0.88)`) over animated scenes, and of the 10.5 px uppercase eyebrow text. | `src/styles/tokens.css:14`, `base.css:112-118` | Measure in all three themes over the brightest scene frame. Raise the panel opacity or the eyebrow size if a measurement falls below 4.5:1. |
| A11 | Verify | A mouse-down on the dialog backdrop closes it, so a text selection dragged from inside to outside may dismiss the dialog. | `src/ui/Dialog.tsx:63-65` | Close only when both mousedown and mouseup land on the backdrop. |
| A12 | Gap | Animation does not pause when the window is hidden, on battery saver, or when a full-screen app is in front (acceptance L2). | `avatar.css` animations; no visibility or battery handling | Set `data-motion="paused"` on `document.visibilitychange`. Battery and full-screen detection need main-process signals. |

The renderer already does several things right: a skip link, focus moving to `<main>` on view change, native `<dialog>` with focus return, arrow keys in segmented controls and tabs, labelled icon buttons, honoring reduced-motion from both the setting and the OS, and `<time datetime>`. Keep these.

## Roadmap (140 scopes) alignment

### Document problems in `docs/product-roadmap.md`

- Line 5 says "No application features implemented yet". That is stale: onboarding, chat, capsules, notes, tasks, actions, secrets, backups and safe launch all exist in code.
- Lines 3 and 200 link to four documents that are not in the repo: `integrations-hub-plan.md`, `repository-review-and-product-direction.md`, `voice-integration-and-component-shortlist.md`, `motion-avatars-usage-and-design-plan.md`. Line 3 also promises Spotify, browser, ChatGPT and Claude integrations that no scope or acceptance item covers.
- Line 7 mixes development budget ("$500 Claude credit budget") into the product roadmap, and `docs/implementation-status.md` states a different figure ($300). Budget figures belong in internal status only, not in the product roadmap.
- "Optional customer-owned Haiku API key" (line 7) ties the product to one model. The UI and contract treat the cloud model as a user-entered name (default `claude-haiku-4-5`, `validation.ts:31`). Say "customer-owned Anthropic API key".
- Item 25's name differs from Feature Lab ("OCR and otherwise unselectable text extraction" vs "OCR and unselectable text extraction"). The other 139 names and tiers match (checked by script).

### Feature Lab's status model conflates "has a screen" with "works"

`src/ui/roadmap.ts` marks a scope `ui` if and only if it has a hand-written note. Everything else becomes `planned`, with the blurb "Nothing has been built yet" (`roadmap.ts:85`). As a result it both under-claims and over-claims.

| Scope | Feature Lab says | Code says | Suggested status |
|---|---|---|---|
| 8 Keyboard and accessibility controls | Planned, "nothing built" | Skip link, Alt+number, dialog focus, reduced motion | Partial |
| 9 Tray, startup, notifications | Interface built (tray preference) | Tray exists (`main.ts:140-145`); no login-item registration; no notifications | Partial. Also, the onboarding text "when Windows starts this app" implies auto-start, which does not exist |
| 10 Help, tutorials, diagnostics | Planned | Developer diagnostics copy and activity log; no help, versions or data folder (acceptance D7) | Partial |
| 12 Local speech recognition | Planned | Windows recognizer via `transcribe` (`speech.ts`) | Partial (basic) |
| 22 Push-to-talk conversation | Interface built | Dictation into the message box; no spoken conversation loop | Partial; the actual behaviour is closer to scope 23's first half |
| 30 Conversation history and export | Planned | History persists and is included in full-data export | Partial |
| 37 Memory edit, forget, retention | Planned | `retainDays` pruning and clear chat (`store.ts:205-216`) | Partial |
| 43 Save and restore window geometry | Planned | Restore implemented (`capsules.ts:46-65`), but nothing in the UI can capture geometry, so `windows` is only ever populated by import | Partial (restore only), not user-reachable |
| 53 Focus sessions with history | Planned | Timer exists; no history | Partial |
| 101 Anthropic BYOK provider | Interface built | Backend cloud transport exists; see P0-4 | Working once P0-4 is fixed and K5 passes |
| 113 Encrypted sensitive-data storage | Planned | DPAPI key storage (`secrets.ts`) | Working (backend), pending K1–K4 |
| 114 Export/import and backup recovery | Interface built | Plus rotation and quarantine in `store.ts` | Partial; no recovery UI |
| 115 Crash recovery and safe launch | Planned | Implemented in `main.ts`/`store.ts`; not shown in the UI (P1-4) | Partial |
| 116 Network-denial verification | Planned | `netGuard.ts` enforces it; acceptance C5/C6 manual checks pending | Partial |

Proposed model, used by both the doc and Feature Lab:

- **Working:** cites at least one passing acceptance id or test.
- **Partial:** says what is missing.
- **Interface only:** a screen exists but has no working engine.
- **Planned**
- **Research:** Experimental scopes.

Keep one data file (for example `src/ui/roadmap.ts`, or a JSON file that root owns) as the single source and generate the markdown table from it, so the two cannot drift again. The existing roadmap integrity test (`tests/ui.test.mjs`) can then assert that every Working or Partial item has an `evidence` field.

### First-tier scopes that are still missing or blocked

From the 40 First scopes, these have no user-reachable implementation and should be visible as such in Feature Lab and the release checklist: 6 searchable settings (D4), 7 profiles, 14 model-pack setup/offline import guidance (E3), 23 dictation insertion into other apps (F5, which depends on P0-6), 24 screen-region questions, 31 project checkpoints (I4), 52 reminders (I2), 61 desktop island (gated L3), 63 interruptible status animations, 71/72 mod catalog, 82 scheduled routines, 111/112 installer (M1–M2). Acceptance items that the current UI contradicts or cannot meet: C4 (P0-4), E4 (no chat cancel; needs a contract change), F6 (label), G2 (P0-7), H2 (P1-5), I3, L2 (A12).

## Coherent interaction direction

The product promise is *a local-first companion that only does what it says it can, and only what you approved.* The UI already has the parts. What is missing is one consistent model across screens.

### 1. A single status spine

A compact status strip stays visible at every width, in the sidebar footer on wide windows and the top bar on narrow ones. It shows:

- **Mode:** Offline / Online.
- **Active route plus probe result:** "Local model · ready", "Ollama not running", or "Cloud · key missing".
- **Voice:** in / out available.
- **Exceptional states:** safe launch, read-only data, browser preview.

Each chip opens System status at the matching row. This replaces the four separate, slightly different readiness computations in Home, Assistant, the sidebar and Status.

### 2. Capability-gated controls

Every control that depends on an engine binds to a backend capability id. When the capability is unavailable, the control stays visible but disabled. It shows the backend reason inline plus one link to the fix.

| Control | Capability id(s) | Fix link |
|---|---|---|
| Send (offline) | `local-llm` | Settings → Mode & models, Check again |
| Send (online) | `cloud` (and the key status) | Settings → Mode & models → API key |
| Push to talk | `stt` | System status (Windows speech) |
| Speak, auto-read | `tts` | Settings → Voice |
| Computer actions, capsule window restore | `ui-automation` | System status |
| Save key | `secure-storage` | System status |
| OCR, vision, screen questions (future) | `ocr`, `vision` | Feature Lab entry |

Do not hide unavailable features. A visible disabled control with its reason is the honest version of a feature that does not work yet. This is also how Expansion and Experimental items should appear (acceptance N1).

### 3. One action grammar: Preview → Approve → Outcome

Use the same three-part component for every effect outside the app: Computer actions, capsule restore, import, dictation insertion (23/F5), and future routines (82–87).

- **Preview:** the backend states what will happen, per item, with allowed or blocked and a reason. The user sees exactly what will run, including the full text for typing and the resolved window and process.
- **Approve:** one dialog that names the risk tier. High-risk actions use a danger button and never autofocus Approve.
- **Outcome:** parsed into *Done*, *Not run (reason)* or *Failed (error)*, with a per-item breakdown and a link to the Activity entry.

The backend must re-check the policy at execute time, which it already does. This grammar also gives NSR-02 a natural home: a main-process confirmation can mirror the same Preview payload.

### 4. Plain language

- Name the product "Desktop Companion" and the assistant "the assistant". Never use "Jarvis" in visible text.
- Replace "the backend" in visible copy (about 30 places in `src/components`) with what the user can act on: "this app", "Windows speech", "Ollama on this computer", "your saved settings".
- Match each claim to the code path: "checked just now", "not checked", "will be checked when it runs". Never write "no fallback" unless the backend guarantees it.

### 5. A proposed information architecture (11 → 8 primary items)

| Group | Item (Alt+n) | Contents |
|---|---|---|
| Today | Home (1) | Resume surface: status spine detail, due tasks, recent capsules with Restore…, last conversation, recent activity |
| Today | Assistant (2) | Chat, voice in/out, route, and companion state (the Companion pose and scene pickers move to Settings → Appearance) |
| Work | Capsules (3) | Unchanged, plus a restore preview with verdicts |
| Work | Notes (4) | Unchanged, plus checkpoint notes linked to a capsule (31) when built |
| Work | Tasks & focus (5) | Unchanged |
| Work | Actions (6) | The Computer screen renamed, so the label says what it does; the window list becomes the starting point |
| System | Status (7) | Capabilities, routes, safe launch, versions, data folder, help (10), plus a **Roadmap** tab (the current Feature Lab) |
| System | Settings (8) | General, Appearance (theme, motion, avatar, scene), Mode & models, Access, Data, Advanced (the current Developer content and the Control Room link) |

This frees Alt+1…8, gives every item a reachable shortcut, and shortens the compact sidebar and bottom dock. It also stops Feature Lab and Developer competing for top-level space with daily features.

### 6. Shell-level safety nets

- An unsaved-changes guard on every navigation path (P1-3).
- Toasts only for confirmations. Errors that need action stay inline next to the control that caused them.
- After any state-changing toggle, move focus to a predictable target (A2).

## Decisions needed from root

- **D1. Click action:** keep it enabled behind approval, or gate it as Experimental per acceptance G2? Recommendation: gate it until NSR-02 lands.
- **D2. Online mode with no key:** block with a system message, or keep the silent local route? Recommendation: block, to match acceptance C4 and the UI copy.
- **D3. Local endpoint rule:** confirm "http, loopback only" as the single rule. The UI then drops its https and remote-host allowances.
- **D4. Feature Lab audience:** user-facing in the first release, or developer-only under Status → Roadmap?
- **D5. Companion screen:** merge into Settings → Appearance and the Assistant side panel, or keep it as its own screen?
- **D6. Contract additions** (the contract owner decides; no worker should add undeclared IPC):
  - a typed `executeAction` result;
  - `previewRestore(id)`;
  - chat cancel or streaming (E4);
  - `save*` returning the new id;
  - a voice list;
  - `safeLaunch` / `readOnly` flags;
  - focus-session events;
  - bulk task delete.

## Tests to add with the fixes

- **Computer:** outcome parsing for `executed:true`, `executed:false` and a thrown error. The window table renders from `{windows:[…]}`. The approval dialog shows the full text for 2,000-character input.
- **Capability gating:** with `stt`/`tts`/`local-llm` unavailable in the preview bridge, the matching controls are disabled and show the reason.
- **Endpoint parity:** one shared validator; the UI rejects exactly what `validateLocalEndpoint` rejects, and Next is blocked on step 3.
- **Online without key:** the Assistant shows a blocked state, and nothing is sent to any route (once D2 is decided).
- **Focus management:** toggling a task keeps focus inside the task list.
- **Name scan:** no `\bjarvis\b` in visible renderer or Electron strings outside the allowed technical identifiers.
- **Roadmap integrity:** the doc and Feature Lab come from one source; Working and Partial items carry evidence; the item 25 name matches.

These need DOM-level tests (for example `@testing-library/react` with `jsdom`, both permissively licensed). Adding them changes `package.json`, which root owns.
