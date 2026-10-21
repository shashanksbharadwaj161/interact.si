# Desktop companion: status on 18 Oct 2026 (island slice)

This covers branch `claude/compassionate-hawking-m9x36g` in the Linux cloud session.

- **Tested here:** Node unit tests, headless Chromium journeys over built pages, and Electron under Xvfb.
- **Not run here:** nothing on Windows, and nothing against a live provider.
- **Codex's unpushed local work** (c775160: the First Light pack, effects, native fixes and voice wiring in `CompanionApp`) was **not seen** from this checkout and is not reviewed here.

## How this audit was done

- **Two subsystem reports finished** before the owner asked to stop delegating: the island renderer and the native window. Their findings are folded in below.
- **The remaining readers were cancelled** (agent loop, helpers, data services, routines, tests, docs claims, references). Those areas are marked "not re-audited" where it matters.
- **References:**
  - **Viewed directly:** the three Nivo images (cdn.dribbble.com). Near-black violet glass, thin luminous boundaries, a foreground sheet over a dimmed workspace, pill controls, restrained violet light.
  - **Read as text only:** Hitodama's page. Island over the desktop, utilities around it, circle to ask, dictation, routines.
  - **Not viewed:** the Dribbble shot, cyberpunk and animation pages (they returned an empty 202 to this container), and the live Hitodama visuals.

## Capability table (journeys)

| Journey / capability | Status | Entry points | Test environment |
|---|---|---|---|
| **Island shell and motion** (rest, command, working, confirm, answer, error, collapse, morphs, reversal) | **Implemented and tested** | `src/companion/island/*`, `surfaces.tsx`, `companion-bubble.css` | `tests/island-shell.test.mjs` (14); `scripts/island-journey.mjs` (14/14, headless Chromium, scripted `window.companion`). Not yet rendered by `CompanionApp` (Codex integrates; see `ISLAND-INTEGRATION.md`). |
| **Named operation states** (sending, waiting for Claude, named tool, waiting for confirmation, checking, done) | Implemented and tested | `state.ts` `workLine`; additive `stage: 'verifying'` in `electron/services/agent.ts`; `create_task` reports its read-back | Unit tests plus the journey. |
| **Distinct failures** (offline, limit, key, network, provider) | Implemented and tested | `classifyFailure` in `agent.ts`; `ErrorView` | Unit tests plus the journey. |
| **Stop closes the trusted confirmation as Cancel** | Implemented and unit tested | `createTrustedConfirm(…, signal)` in `ipcCore.ts`; `companionWindow.ts` passes the run signal | Unit test with a fake message box. The real Windows dialog has not been run. |
| **1. Ask about a selected screen region** | **Partial** | Region overlay, token and crop exist (`companionWindow.ts`, `companionCore.ts`); the island shows the chip and removes it; collapse discards it | The crop maths is unit-tested. Native-report gaps remain open: no in-flight guard on `regionBegin`, lazy TTL sweep, regions not cleared on bubble close natively. Windows multi-DPI capture is unverified. |
| **2. Typing into the current app** | **Partial** | `type_into_app` with preview, trusted confirmation, re-check, focus and type (earlier slice); the island passes `withTarget` and shows the window chip | Fake-desktop tests from the earlier slice; no Windows run. **UI Automation semantic control is missing.** |
| **3. Speak, review, insert** | **Partial** | Voice session, island Talk and VoiceBar, transcript placed into the field for review | Hub journey with a fake microphone (earlier slice). **The native voice policy is missing**: the island consent still uses renderer storage. **A direct reviewed insert into the target window (without Claude) is missing.** |
| **4. Retrieve and transform saved information** | **Partial** | `search_saved`, `read_saved_item` and `create_task` with citations and undo (earlier slices) | Fake-provider tests (earlier). **`save_note` after confirmation is missing**; file search within approved roots has not been re-audited. |
| **5. Run a routine with a receipt** | **Missing in the island** | The routine engine exists in the hub (not re-audited this session) | None for the companion. |
| **Utility tray** (tasks, notes, routines, clipboard if enabled, approved apps, connections) | **Missing** | `CompanionIsland` has a `tray` render prop; the reducer handles the tray view | Reducer unit test only. |
| **Native material honesty** (acrylic reported as applied when the call merely did not throw) | **Open gap** | `companionWindow.ts` `applyMaterial` | No `nativeTheme` high-contrast or reduced-transparency handling yet. |
| **Pet and click-through in the shipped page** | Owned by Codex | Audit at 0319b42: the old page never called `hit()` and ignored placement and target | Codex reports 31/31 real Windows placement and permission checks on c775160 (not verifiable here). |

## Changed in this slice

New files:
- `src/companion/island/motion.ts`
- `IslandShell.tsx`
- `state.ts`
- `useIslandRun.ts`
- `CompanionIsland.tsx`
- `useReducedMotion.ts`
- `prototype/island.{html,tsx,css}`
- `scripts/island-journey.mjs`
- `tests/island-shell.test.mjs`

Edits:
- `src/companion/surfaces.tsx`: `WorkView`, `ConfirmView`, the `ErrorView` kinds, kept draft, Back and focus, the `Command` slots, and the "Checking" step word.
- `src/styles/companion-bubble.css`: the `.cd.isl` shell, `--isl-*` tokens, and the confirmation and draft blocks.
- `electron/services/agent.ts`: `classifyFailure`, `kind`, `stage`.
- `electron/services/agent-tools.ts`: `create_task` reports saving and checking.
- `electron/ipcCore.ts`: the confirmation `signal`.
- `electron/companionWindow.ts`: passes the run signal to the confirmation.
- `vite.prototype.config.mjs`: the island page.

## Next, in order

1. **Native voice policy.** A `voiceInput` setting in main, off by default. Turning it on needs a trusted confirmation; turning it off does not. The session permission handler refuses audio while it is off. Hub and island consent read it; renderer storage stops being the authority.
2. **Speak, review, insert without Claude.** After the transcript is reviewed, "Type this into <window>" uses the same `typeIntoTarget` path: preview, trusted confirmation, re-check, type. The result reads "typed, not read back".
3. **Region hardening.** An in-flight guard, a TTL sweep timer, and clearing on bubble close in main, with tests.
4. **Saved info.** A `save_note` tool with trusted confirmation, read-back and undo; open the cited source.
5. **Utility tray** over a bounded `companionTray()` summary:
   - today's and overdue tasks, recent notes and routines;
   - clipboard only when the person has enabled it and it is connected;
   - approved apps through the existing preview and native confirmation;
   - connections with their real state, or Connect with an honest setup explanation.
6. **Routine with receipt.** Through the existing engine and its policy: preview, run, cancel, per-step results, undo where implemented.
7. **UI Automation slice.** For one supported app (Calculator): inspect, invoke or set a value, re-observe. There is no generic command runner.
8. **Material honesty.** `nativeTheme` high contrast and reduced transparency; report "requested" rather than "applied".

## Unverified until run on Windows or with a real key

- Every native behaviour: transparent-window composition, click-through, focus hand-back, the confirmation dialog closing on Stop, and acrylic.
- Speech recognition and playback.
- Live Claude.
- Frame timing in the real window.
