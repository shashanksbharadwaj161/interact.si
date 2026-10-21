# Local companion review — 18 October 2026

Review branch: `codex/character-companion`. Local checkpoints: a36d100 (art/effects/native recovery), beb76c0 (merge Claude's published voice work through 0319b42), 0b358de (merge Claude's published island work through 31dcb60). Codex has not pushed this local branch, merged main, changed payments or made a live provider request. Claude published its own review checkpoints.

## What changed

- Real generated First Light pet animation, shared across onboarding, hub and native companion: nine actions, sixteen directional looks, explicit animation-preview label. The ChatGPT create-pet artwork workflow and its bundled scripts were used; the app has no dependency on ChatGPT Pets account lifecycle tools.
- Character Studio previews all states, replays one-shots and allows manual gaze with reduced motion. Actual animation clock, validated atlas bytes, transparent hit masks, shared bitmap cache and hidden-page pause are retained.
- Flow streams with traveling highlights, animated perspective grid, a changing ASCII wave surface, Quiet mode, glass opacity and perimeter lighting. Controls are available at onboarding, in the rail, Settings and Character Studio.
- Native Windows fractional-DPI placement rebases against actual OS bounds. A shown transparent/non-activating window could stop delivering rAF while its timers and visibility stayed live; a bounded 64ms, exactly-once frame fallback now prevents a frozen pet. Hidden windows restore native throttling and pause the shared clock. This is not a 60fps performance claim.
- Saved reduced motion reaches the separate companion document through its narrow status. No full app data is exposed by that status.
- Merged Claude's reusable voice session/backend and hub Assistant changes. Wired Talk, explicit microphone consent, transcript review, real phase bar, Escape/Stop/Cancel and optional answer read-aloud into the existing floating companion. Sending never happens automatically after transcription. No new listening/speaking art is falsely claimed.
- Added an actual local character favicon. The Windows Edge voice test exposed an implicit missing-favicon request; the resource was fixed rather than ignoring the console error.
- Integrated the shared production IslandShell into the existing native controller (Path B). One voice session, run controller, remembered input target and pixel hit test remain. The native window grows before opening and shrinks only after closing; rapid reversals start from the current drawn rectangle. Content is translated/clipped, never stretched. Closing discards selected screen context. Verified read-only searches do not trigger change celebrations.
- The interactive island review now uses the actual animated character and offers explicit scene/example/reduced-motion controls. Actions and confirmations in this review are labelled scripted. Fixed a real nested-page fallback-image 404 by bundling a rebased asset URL; page-health checks include failed resource URLs.
- The full rerun caught a follow-on SSR regression: data-module test imports cannot resolve a relative URL against `import.meta.url`. The asset resolver now uses the rebased URL only for HTTP/file module bases and preserves a relative placeholder for SSR/data-module reviews. The onboarding regression was reproduced by name and passed again after the fix; no failing assertion was weakened.

## Checks and what they prove

| Check | Result | Scope |
|---|---|---|
| Typecheck + production build | Pass | Current source. Lazy sprite chunk is about 3.46 MB of inline data; Vite reports a chunk-size advisory. |
| Focused regressions | 160 pass | Pet contract/clock/loader, native-rAF recovery, onboarding, shell, home, companion core/agent/security, voice session and companion voice. No live provider. |
| Full Windows regression suite | 1,739/1,739 pass | Final integrated source including the corrected asset resolver. No skipped/cancelled tests. 111,975ms, concurrency two; no live provider. |
| Windows native placement/permission check | 31/31 pass | Actual Electron/main/preload, current 1536×816 work area, geometry, voice methods/argument validation and fake-device audio permissions; camera denied. Does not prove mixed-monitor behavior or acrylic appearance. |
| Windows native pet/island check | 12/12 pass, 0 external requests | Actual atlas draw, draft label, multiple generated wave columns, mic-consent UI, native island open/close/reopen ordering, context cleanup, reduced-motion propagation/still pose and hidden pause. No real microphone, screen capture or external app input. |
| Windows island UI journey | 14/14 pass, 0 external requests/errors | Installed Edge, real shared shell/surfaces/character, scripted bridge. Tests grow-before-open, focus, context chips, hit testing during a morph, confirmation, verified/unverified receipts, close-before-shrink, interruption reversal, cancellation, offline recovery and reduced motion. Headless timing is not native composition performance. |
| Electron smoke | 23 routes, 0 renderer errors, 0 external requests | Hardened app in isolated offline profile; mount/navigation/basic persistence checks. Not proof every feature is complete. |
| Voice UI journey | 13/13 pass | Installed Edge in an isolated headless test profile on Windows, generated microphone, real capture/WAV/track cleanup, scripted transcript/speech bridge. No real recognizer, live Claude or real user audio. |
| Manual browser review | Pass | All nine animation row mappings, all sixteen gaze cells, four atmosphere modes, changing ASCII, reduced-motion freeze, lighting/opacity, persistence after reload, note edit/save; console clean. Browser preview explicitly labels native/cloud unavailability. |
| Atlas/quality pipeline | Both pass | Exact encoded bytes, 73 required cells, 38px jump/0px landing delta. 19 review warnings remain in the report; art is in-review, not owner-approved. |

Detailed evidence:
- `pet-art/first-light-motion-2026-10-18/README.md`, QA JSON, contact/direction sheets, all-state GIF/MP4 and native-cell idle/jump preview.
- `pet-art/first-light-motion-2026-10-18/qa/browser-verification.json`.
- `native-companion/native-placement-check.json` is the current Windows result. Historical Linux voice and pre-voice Windows results are retained separately, not relabelled.
- `voice-windows-renderer/voice-journey.json` records the actual Windows test environment. Earlier Claude Linux captures remain under `voice/`.
- `island-windows-renderer/island-journey.json`, its screenshots and WebM record the Windows browser journey. `manual-preview.png` and the character run's `qa/studio-vapor.png` show the actual interactive local pages.

The final wider Windows suite passed **1,739/1,739** after the island integration and asset resolver correction (the prior pre-island result was 1,725/1,725). Production typecheck/build and prototype build also pass. These automated checks do not replace the installed-app/live-provider journey gates below.

## Claude assignment and ongoing work

The full `CLAUDE-ISLAND-COMPUTER-USE-2026-10-18.md` was sent in the existing Claude Code session. It includes the owner's product direction, actual Dribbble/Hitodama observations, Nivo image URLs, five complete journeys, transition state/timing/material contracts, native execution/security boundaries, file ownership and evidence requirements.

Claude initially launched an extra audit workflow despite the no-additional-agents instruction. Codex corrected this immediately after observing it. Claude confirmed the workflow stopped and continued directly. Its published 31dcb60 island shell, motion system, controller and cancellation changes have now been reviewed/integrated locally. The existing native controller uses the shell-only integration so the working voice and pet adapters are preserved.

Latest browser observation: Claude reached 100% of its session limit while implementing main-process microphone permission and reviewed transcript insertion into the remembered window. The page shows auto-continue enabled. These newer edits are not a published/integrated completion. No extra usage/payment activation was made. Its remaining assignment includes direct reviewed insertion, context hardening, saved notes, utility tray/routines, UIA and honest material reporting. A queued assignment is not an active worker while the session limit is blocking it.

Codex's local companion already preserves shared surfaces, pixel hit testing and the selected typing target. Findings about Claude's older CompanionApp must not be mistaken for the current local branch.

## Still open

| Core journey | Current local status | What remains to call it an installed-app success |
|---|---|---|
| Select screen content → explain | Region picker/crop/token and Claude vision/tool-loop code exist; geometry and mocked-provider cases tested | Real chosen-screen interaction and live provider answer on Windows; context disclosure/cancellation review |
| Draft → type in the current app | Bound target, trusted confirmation, native input and accurate partial/unverified receipts exist; controller/helper guards tested | Controlled external-app typing/focus/revalidation journey on Windows; broader semantic UIA is not yet a companion tool |
| Speak → review → insert | Shared voice input/phase/cancel/stop and draft review now integrated; 13 generated-audio UI checks pass | Real microphone/Windows recognizer quality and reviewed insertion into a supported external app |
| Ask about saved information | Saved search/read tools and citation handling exist; actual notes editing/persistence plus mocked agent-tool cases tested | Live Claude grounding against those tools and owner usability review |
| Invoke a saved routine | Existing hub routine engine is retained | A companion agent tool/tray integration with preview, approval, cancellation and receipt; currently assigned to Claude |

These statuses distinguish implemented code and automated checks from a complete real-user journey. They are not an aggregate completion percentage.

The larger computer-use/UIA/routine/utility-tray assignment is ongoing in Claude. It is not completed merely because the prompt was sent. Its next reviewed commits need integration and actual Windows journey checks. Live Claude vision/tool behavior, real dictation quality, real app input/focus, protected surfaces, mixed displays and desktop acrylic composition are not claimed verified by this pass. OAuth registrations and per-user integrations also require their own complete implementation/testing.

The art is a real first animation pass, not the final high-resolution continuous character rig. Current v2 cells are 192×208 with their contract pose timings. Review the motion and iterate specific states/directions before recording approval.

Previews: http://127.0.0.1:5181/#/companion (real hub UI/animation/appearance controls) and http://127.0.0.1:5181/prototype/island.html (interactive shared island with explicitly scripted task events). Neither replaces the previously installed executable.
