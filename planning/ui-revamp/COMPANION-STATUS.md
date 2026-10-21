# Desktop companion: exact status (17 Oct 2026)

This covers branch `claude/compassionate-hawking-m9x36g` in the Linux cloud session.

- **What "tested" means here:** Node unit tests, a Linux/Xvfb Electron smoke run, and browser captures.
- **What has not been run:** nothing on Windows, and nothing against live Claude (the provider tests use scripted replies).
- **Codex:** it is building the character-led `CompanionApp.tsx`, `Onboarding.tsx`, `tokens.css` and a concept-art component on its own branch, `codex/character-companion`.

## Working (code plus automated tests, Linux)

| Capability | Where | Evidence |
|---|---|---|
| Companion window security | `electron/companionCore.ts`, `companionWindow.ts`, `companionPreload.ts` | `tests/companion-core.test.mjs` (12); `tests/full-security-regressions.test.mjs` checks:<br>• the exact hub and companion channel sets;<br>• a sandboxed island;<br>• no capture at startup. |
| Pet placement in the real window | `companionWindow.ts` | `scripts/companion-native-check.cjs` (`npm run companion:native-check`) drives the real main process under Xvfb through `window.companion`. 22 checks pass (`native-companion/native-placement-check.json`):<br>• rest and bubble bounds;<br>• the bubble side;<br>• all five docks inside the work area;<br>• resize presets and grow;<br>• placement events match the real bounds;<br>• out-of-spec arguments are refused.<br><br>Dragging is not covered: main reads the real OS cursor. |
| Pet placement geometry | `companionCore.ts` | Unit tests cover:<br>• ground point and docking, with odd widths kept inside the work area;<br>• a bubble beside the pet that never covers it;<br>• 16-bucket gaze;<br>• resize presets;<br>• page asks for a size only, never a position. |
| Claude tool loop | `electron/services/agent.ts`, `cloud.ts` | `tests/companion-agent.test.mjs` covers:<br>• bounded steps;<br>• turns replayed unchanged;<br>• cancel;<br>• refusal and truncation;<br>• transport and overload errors;<br>• only the guarded `/v1/messages` POST with `x-api-key`. |
| Find saved information with citations (journey 4) | `agent-tools.ts` `search_saved`, `read_saved_item` | Same file. Answers cite only items a tool returned. |
| Selected screen region (journey 1) | `companionWindow.ts`, `RegionOverlay.tsx` | Crop maths at 100/125/150/200% is unit-tested. The earlier Xvfb review captured the overlay. |
| Create a task (journey 2) | `agent-tools.ts` `create_task` | Trusted confirmation, read-back verification, undo. Decline and fail-closed say "Not confirmed". |
| **Type into the app the person was using (journey 2b)** | `agent-tools.ts` `type_into_app`; `backend.ts` `typeIntoTarget`, `foregroundTarget`; `companionWindow.ts`; `ActionService.execute(…, {confirm})` | Four tests with a fake desktop. The flow:<br>1. Preview.<br>2. The companion's trusted confirmation shows the window, process, PID and full text.<br>3. Focus returns to exactly that window and it is re-checked.<br>4. The text is typed.<br><br>What is refused:<br>• Cancel, a window that changed owner, an elevated window, or failed focus types nothing.<br>• A remembered window is never this app, an elevated, minimized or background window.<br>• The window title is quoted to Claude as data.<br><br>How it is reported:<br>• The result is "typed, not read back", with no undo.<br><br>After the adversarial review (one more test):<br>• the preview is bound to the remembered PID and process, so a reused window handle is refused before any dialog;<br>• typing that stops part-way reports "Typing stopped after N of M characters";<br>• the step waits only while the dialog is open;<br>• a policy refusal is not logged as declined;<br>• removing the window or closing the bubble stops an in-flight request from typing. |
| Pet core | `src/pet/contract.ts`, `manifest.ts`, `atlas-check.ts`, `clock.ts`, `adapter.ts` | `tests/pet-core.test.mjs` (31). After the review:<br>• a verified-change jump that happens mid-run waits until work ends, then plays in full, with review after it;<br>• a failure does not replay after a drag;<br>• no gaze while carried;<br>• reason texts claim only what the error code means. |
| Pet renderer plumbing | `src/pet/registry.ts`, `loader.ts`, `PetSprite.tsx`, `PetSlot.tsx`, `MissingArt.tsx`, `styles/pet.css` | `tests/pet-renderer.test.mjs` (6) covers:<br>• registry pairing;<br>• the approval gate and its reasons;<br>• data-URL bytes against `atlasSha256`;<br>• the load check on real decoded pixels, with a real jump lift;<br>• no pack installed;<br>• no drawing in the missing-art code.<br><br>The board capture shows the renderer playing the **test pattern** through every adapter state. |
| **Voice for the island (native side)** | `companionCore.ts` (5 methods, `mediaPermissionAllowed`); `companionWindow.ts`; `companionPreload.ts`; `backend.ts` `CompanionVoice`; `speech.ts` owner tags; `main.ts` permission | `tests/companion-voice.test.mjs` (6) covers:<br>• island-only methods;<br>• bounds equal to the hub's;<br>• audio-only permission for the hub page or the island itself;<br>• each surface stops only its own speech;<br>• the real backend reports engines honestly.<br><br>`companion-native-check` (31/31, real Electron under Xvfb):<br>• voice answers honestly with no Windows engines;<br>• bad arguments are refused;<br>• the real session handler grants microphone audio to the island and the hub and refuses the camera. |
| **Voice in the Assistant (hub)** | `src/voice/session.ts`, `useVoiceSession.ts`, `VoiceMeter.tsx`, `backends.ts`; `Assistant.tsx`; `styles/voice.css`; hub IPC `speechStop`, `transcribeCancel` | `tests/voice-session.test.mjs` (17) and `scripts/voice-journey.mjs` (13 steps, fake microphone, scripted fixture speech). See `VOICE.md`:<br>• explicit start;<br>• real listening, transcribing and speaking states;<br>• stop and cancel that reach the backend;<br>• release on navigation;<br>• honest unavailable reasons.<br><br>Windows recognition and playback are not run here. |
| Bubble surfaces (candidate direction) | `src/companion/surfaces.tsx`, `src/styles/companion-bubble.css` (scoped `.cd`) | Rendered on the direction board. **Not wired** into the current `CompanionApp.tsx`; Codex owns that integration. |

## Partial

- **Typing:**
  - Plain text only, at most 2000 characters. It cannot press shortcuts, click or read the app.
  - Line breaks into terminals, Explorer, Run or Start search are refused by the existing window policy.
  - The remembered window is captured when the bubble opens and forgotten when it closes.
- **The page must opt in to typing.** `companionAsk(text, token, withTarget)` sends the remembered window only when the page passes `true`. The current island page never does, so typing is unreachable until the new `CompanionApp` shows the "Typing goes to …" chip and passes it.
- **Task citations** open the Tasks list but do not select the task.
- **The default model** is `claude-haiku-4-5`, taken from the hub's settings.

## Not built

- **Character art:**
  - No canonical base is approved.
  - No strips, cardinals or look rows exist, and no atlas.
  - The product shows "Character art not installed".
  - The create-pet bundled scripts are not available here. See `PET-ART-HANDOFF.md` for the exact files.
- **Listening and speaking in the companion page:**
  - The island has its own voice IPC, microphone permission and ready components (below, and the board scenes).
  - **`CompanionApp.tsx` is not wired yet.** That integration is Codex's.
  - Pet art for listening and speaking does not exist, and no lip sync is simulated.
- **Settings and hub:**
  - There is no Settings page for the companion's personality, anchor or material.
  - Hub routes have not been restyled. That waits for owner approval of `DIRECTION-BOARD.md`.
- **Later scope:** routines, accounts and integrations for the companion.

## Unverified until run on Windows, or with a real key

- **Window behaviour (Windows only):**
  - Click-through outside the pet and bubble. `setIgnoreMouseEvents` with forward exists only on Windows and macOS; on Linux the window stays clickable.
  - Non-activating rest (`setFocusable(false)`).
  - Main-side drag, docking and resize on real displays.
  - Gaze polling cost.
  - Focus return on collapse.
- **Typing (Windows only):**
  - Whether `foregroundTarget()` (the native `list-windows` helper) runs fast enough on opening the bubble. The wait is capped at 700 ms.
  - Whether `SendInput` typing lands in the right control after the confirmation dialog closes.
- **Display:** acrylic material, transparent-window composition and mixed-DPI region capture.
- **Live Claude:** every request so far used scripted replies. Run the checklist in `NATIVE-COMPANION-SLICE.md` with a real key, using ordinary usage only.

### Windows checks for typing (add to the QA checklist)

1. Open Notepad and type something. Press Ctrl+Shift+Space. The bubble shows "Typing goes to notepad" with the window title.
2. Ask "write a two-line thank-you note here". Check:
   - the Windows confirmation names Notepad, its PID and the exact two lines, and Enter or Esc means Cancel;
   - Continue types into Notepad at the cursor;
   - the answer shows "Typed N characters… Not read back" with no undo.
3. Repeat and press Cancel: nothing is typed. Repeat, close Notepad before confirming: nothing is typed and the reason is shown.
4. Run the same request with an elevated app such as Task Manager in front: it is refused before any confirmation.
5. Remove the "Typing goes to" chip before asking: Claude has no typing tool and says so.

## Integration for CompanionApp.tsx (for Codex)

1. **Imports:**
   - `PetSlot` from `../pet/PetSlot`, `createPetAdapter` from `../pet/adapter`, and `Bubble`, `Command`, `Working`, `AnswerView`, `ErrorView` and `PlacementOptions` from `./surfaces`;
   - the stylesheet `../styles/companion-bubble.css`.
2. **Adapter:**
   - Create it once with `createPetAdapter(performance.now())`.
   - On every state change, call `adapter.signal({...}, performance.now())` with:
     - `surface`;
     - `requestInFlight: pending !== null || steps.some(s => s.phase === 'running')`;
     - `awaitingPerson: steps.some(s => s.phase === 'awaiting-confirm')`;
     - `failure: surface === 'error' ? failure.reason : null`;
     - `dragVx`, from the `{type:'drag', vx}` push;
     - `gaze: gazeIndex === null ? null : gazeIndex * 22.5`, from the `{type:'gaze', index}` push;
     - `reducedMotion`.
   - Events:
     - `invoked` on the `{type:'invoke'}` push;
     - `verified-change` when a tool event has `phase: 'done'`, `verified: true` and an `undo`;
     - `answer-shown` on an answer.
   - Re-render when `view.until` passes.
3. **Gaze:** call `api.gaze(true)` only while the surface is `rest` or `command`, motion is not reduced, and the look is `pet`. Otherwise call `api.gaze(false)`.
4. **Placement:**
   - Position the pet at `placement.pet` and the `Bubble` at `placement.bubble` with `side`, both from the `{type:'placement'}` push.
   - Measure the bubble with `measuring`, then call `api.layout({bubble: {width, height}})`. On close, wait for the leave animation, then call `api.layout({bubble: null})`.
5. **Hit testing:**
   - On document `mousemove`, take `over = hitRef.current?.(x - pet.x, y - pet.y) || insideBubble`.
   - Call `api.hit(over)` only when the value changes, and `api.hit(false)` on `mouseleave`.
6. **Drag:** pointerdown on the pet calls `api.drag('start')` and pointerup calls `api.drag('end')`. A press without movement opens the bubble in main. Ctrl+wheel over the pet calls `api.resize(deltaY < 0 ? 'grow' : 'shrink')`.
7. **Typing target:**
   - Keep `target` from `status.target` and the `{type:'target'}` push.
   - Pass `target` and `onClearTarget={() => api.clearTarget()}` to `Command`.
   - Ask with `api.ask(text, token, Boolean(target))`.
8. **Identity:** `PetSlot mode="product"` shows only approved packs. Codex's concept art belongs on the review board or the first-run proposal, labelled as concept art, not as the animated product pet.

## Voice for the companion (for Codex)

The island reaches the same local Windows speech as the hub through its own island-only methods.

- **Methods** (`window.companion`):

  | Method | Returns |
  |---|---|
  | `voiceStatus()` | `{stt, tts, voice, speaking, transcribing, cloud: false}` |
  | `transcribe(wav)` | the recognized text |
  | `transcribeCancel()` | whether a transcription was cancelled |
  | `speak(text)` | `{ok, reason?}` |
  | `speechStop()` | whether speech was stopped |

- **Each surface stops only its own audio:** the hub's Stop never ends the island's speech, and the reverse holds too.
- **Main stops the island's speech and transcription** when the bubble closes, the island window closes, or on dispose.
- **Microphone permission** is granted for audio only, to the island's own webContents; the selection overlay is refused.

### Wiring for `CompanionApp.tsx`

1. **Imports:**
   - from `../voice/useVoiceSession`: `useVoiceSession`;
   - from `../voice/companion`: `useCompanionVoiceCaps`;
   - from `../voice/backends`: `companionVoiceBackend`;
   - from `../voice/VoiceBar`: `VoiceBar` and `TalkButton`;
   - the stylesheet `../styles/voice.css` (scoped to `.vx-*`, so it does not change the bubble).
2. **Session:**

   ```tsx
   const api = companionApi();
   const backend = useMemo(() => companionVoiceBackend(api), [api]);
   const { caps, status, refresh } = useCompanionVoiceCaps(api);
   const { voice, snap, blocks } = useVoiceSession({
     backend, caps,
     consentHint: 'Allow the microphone in the companion first. Nothing is recorded until you do.',
     onTranscript: (t) => setText((prev) => (prev ? `${prev} ${t.text}` : t.text)),
   });
   ```

   - Call `refresh()` on every `{type: 'invoke'}`.
   - The transcript goes into the command field for review; never call `ask()` from `onTranscript`.
3. **Consent:**
   - Show a switch, bound to `snap.consent`, that calls `voice.setConsent(on)`.
   - The default consent object reads the same storage key as the hub.
   - Whether the two pages share that storage in the packaged `file://` build is **not verified**.
   - If the island needs its own switch, pass `consent: createMicConsent(...)` with its own storage.
   - Turning it off cancels at once.
4. **Inside the bubble:**
   - Render `<VoiceBar voice={voice} snap={snap} voiceName={status?.voice || 'Windows default voice'} compact />` above the command field.
   - Render `<TalkButton voice={voice} snap={snap} block={blocks.listen} />` beside Ask. It is disabled while blocked, and its tooltip gives `blocks.listen.reason`; also show that reason as text when the person presses Talk.
   - For an answer, offer read-aloud with `voice.speak(answer.text, {key: runId})`. While `snap.speaking?.key === runId`, the control becomes `voice.stopSpeaking()`.
5. **Lifecycle:**
   - Call `voice.release()` when the bubble closes (before `api.layout({bubble: null})`) and on collapse. Main stops speech on bubble close too, as a backstop.
   - Unmounting releases on its own.
   - Esc while `snap.phase !== 'idle'`: if speaking, call `voice.stopSpeaking()`; otherwise call `voice.cancel()`.
6. **Pet adapter:**
   - Treat `snap.phase` `listening`, `transcribing` and `speaking` as the companion's `waiting` or `running` signals only once art for them exists. Until then keep the current states.
   - The real level is `voice.subscribeLevel((level) => …)`, emitted only while listening. Never drive the pet from a simulated level.
7. **Check on Windows:** the five steps in `VOICE.md` › Windows checks, repeated in the island.

