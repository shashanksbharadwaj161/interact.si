# Local companion review — 18 October 2026

Review branch: `codex/character-companion`. Local checkpoints: a36d100 (art/effects/native recovery), beb76c0 (merge Claude's published voice work through 0319b42). No push, main merge, payment change or live provider request was made.

## What changed

- Real generated First Light pet animation, shared across onboarding, hub and native companion: nine actions, sixteen directional looks, explicit animation-preview label. The ChatGPT create-pet artwork workflow and its bundled scripts were used; the app has no dependency on ChatGPT Pets account lifecycle tools.
- Character Studio previews all states, replays one-shots and allows manual gaze with reduced motion. Actual animation clock, validated atlas bytes, transparent hit masks, shared bitmap cache and hidden-page pause are retained.
- Flow streams with traveling highlights, animated perspective grid, a changing ASCII wave surface, Quiet mode, glass opacity and perimeter lighting. Controls are available at onboarding, in the rail, Settings and Character Studio.
- Native Windows fractional-DPI placement rebases against actual OS bounds. A shown transparent/non-activating window could stop delivering rAF while its timers and visibility stayed live; a bounded 64ms, exactly-once frame fallback now prevents a frozen pet. Hidden windows restore native throttling and pause the shared clock. This is not a 60fps performance claim.
- Saved reduced motion reaches the separate companion document through its narrow status. No full app data is exposed by that status.
- Merged Claude's reusable voice session/backend and hub Assistant changes. Wired Talk, explicit microphone consent, transcript review, real phase bar, Escape/Stop/Cancel and optional answer read-aloud into the existing floating companion. Sending never happens automatically after transcription. No new listening/speaking art is falsely claimed.
- Added an actual local character favicon. The Windows Edge voice test exposed an implicit missing-favicon request; the resource was fixed rather than ignoring the console error.

## Checks and what they prove

| Check | Result | Scope |
|---|---|---|
| Typecheck + production build | Pass | Current source. Lazy sprite chunk is about 3.46 MB of inline data; Vite reports a chunk-size advisory. |
| Focused regressions | 160 pass | Pet contract/clock/loader, native-rAF recovery, onboarding, shell, home, companion core/agent/security, voice session and companion voice. No live provider. |
| Windows native placement/permission check | 31/31 pass | Actual Electron/main/preload, current 1536×816 work area, geometry, voice methods/argument validation and fake-device audio permissions; camera denied. Does not prove mixed-monitor behavior or acrylic appearance. |
| Windows native pet check | 8/8 pass, 0 external requests | Actual atlas draw, explicit draft label, wave cells 3:0/1/2/3 after scripted invocation, reduced-motion propagation/still pose, mic-consent UI, hidden pause. No real microphone or external app input. |
| Electron smoke | 23 routes, 0 renderer errors, 0 external requests | Hardened app in isolated offline profile; mount/navigation/basic persistence checks. Not proof every feature is complete. |
| Voice UI journey | 13/13 pass | Installed Edge in an isolated headless test profile on Windows, generated microphone, real capture/WAV/track cleanup, scripted transcript/speech bridge. No real recognizer, live Claude or real user audio. |
| Manual browser review | Pass | All nine animation row mappings, all sixteen gaze cells, four atmosphere modes, changing ASCII, reduced-motion freeze, lighting/opacity, persistence after reload, note edit/save; console clean. Browser preview explicitly labels native/cloud unavailability. |
| Atlas/quality pipeline | Both pass | Exact encoded bytes, 73 required cells, 38px jump/0px landing delta. 19 review warnings remain in the report; art is in-review, not owner-approved. |

Detailed evidence:
- `pet-art/first-light-motion-2026-10-18/README.md`, QA JSON, contact/direction sheets, all-state GIF/MP4 and native-cell idle/jump preview.
- `pet-art/first-light-motion-2026-10-18/qa/browser-verification.json`.
- `native-companion/native-placement-check.json` is the current Windows result. Historical Linux voice and pre-voice Windows results are retained separately, not relabelled.
- `voice-windows-renderer/voice-journey.json` records the actual Windows test environment. Earlier Claude Linux captures remain under `voice/`.

## Claude assignment and ongoing work

The full `CLAUDE-ISLAND-COMPUTER-USE-2026-10-18.md` was sent in the existing Claude Code session. It includes the owner's product direction, actual Dribbble/Hitodama observations, Nivo image URLs, five complete journeys, transition state/timing/material contracts, native execution/security boundaries, file ownership and evidence requirements.

Claude initially launched an extra audit workflow despite the no-additional-agents instruction. Codex corrected this immediately after observing it. Claude confirmed the workflow stopped and continued implementation directly, retaining the two completed reports. Latest observed work: production IslandShell/CompanionIsland, interruptible rectangle motion with a watchdog, real-event state/run controller, cancellation of pending confirmations and a shared-component review journey; fourteen island tests reported passing in its cloud checkout. These are **Claude's reported in-progress changes**, not locally integrated or Windows-verified changes.

Codex's local companion already preserves shared surfaces, pixel hit testing and the selected typing target. Findings about Claude's older CompanionApp must not be mistaken for the current local branch.

## Still open

The larger computer-use/UIA/routine/utility-tray assignment is ongoing in Claude. It is not completed merely because the prompt was sent. Its next reviewed commits need integration and actual Windows journey checks. Live Claude vision/tool behavior, real dictation quality, real app input/focus, protected surfaces, mixed displays and desktop acrylic composition are not claimed verified by this pass. OAuth registrations and per-user integrations also require their own complete implementation/testing.

The art is a real first animation pass, not the final high-resolution continuous character rig. Current v2 cells are 192×208 with their contract pose timings. Review the motion and iterate specific states/directions before recording approval.

Preview: http://127.0.0.1:5181/#/companion (local source preview). This does not replace the previously installed executable.
