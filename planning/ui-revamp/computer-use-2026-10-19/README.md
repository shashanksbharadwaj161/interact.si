# Computer-use integration — 19 October 2026

Owner request: Claude publishes its work and stops; Codex implements this session itself. No new agents, paid API workers, billing changes or live provider calls.

## Synchronization

Claude published `7c3e03cc2d6702ab67051ea09560da6357715e0a` on `claude/compassionate-hawking-m9x36g` and reported a clean tree/stopped. Codex fetched and merged it as `0a09f3e` into `codex/character-companion`, preserving the existing character, atmosphere, typography and island work. `claude-push-handoff.png` records the handoff. Claude's checkpoint had unfinished UI wiring and test failures; it was not treated as complete.

## Implemented by Codex

- The actual native companion offers **Type into <app>** for a remembered app and reviewed nonempty text. The composer works offline; Ask remains disabled until Claude is configured. Exact leading/trailing whitespace is preserved for direct input. Recording/transcription blocks submission until text can be reviewed.
- Direct insertion uses the same backend, single-use action preview, trusted Windows confirmation, exact HWND/PID/process revalidation and native input path as model-requested typing. Its receipt says **On this computer · no AI request** and **not read back**. It never claims the target app saved or sent the text.
- Stop propagates to the native runner; cancellation/target removal is checked after confirmation and after focus restoration. If a helper stops without an accepted-character receipt, the result says the count is unknown and asks the person to check the app before retrying. Explicit native pre-input refusals report zero; a missing focused accessibility element now fails closed.
- The floating companion now uses main-process microphone permission, not browser storage. It follows policy pushes and cancels recording on revocation. A newer Off choice beats an older pending Allow confirmation, in both the backend and renderer consent object.
- Selected screen bytes actively expire after five minutes, even while idle, and only one crop is retained. Expiry also removes the renderer thumbnail. Regions are single-use; closing, cancellation, replacement, disposal and a lock event clear them. A pending screenshot cannot resurrect a cancelled picker or race a second capture.
- Closing invalidates pending run promises and stops voice/input. A Windows lock event aborts the run, forgets the target/context and collapses the companion. The closing animation releases retained React content after finishing, including screen-preview references.

## Verification and boundaries

| Check | Result | What it proves |
|---|---|---|
| Full Windows Node suite | 1,755/1,755 pass; zero skipped/cancelled | Backend/tool, security, lifecycle and renderer contracts with controlled dependencies. No external app input or live AI. |
| Production typecheck/build | Pass | Current renderer/main compile; helper integrity manifest regenerated. Existing large sprite-chunk advisory retained. |
| Final focused checks | 37/37 pass | Final offline composer keyboard/submission guard, direct insertion/cancellation, voice permission and screen-context tests. This followed the full-suite run. |
| Native placement/permission | 33/33 pass | Real Electron/main/preload on Windows, generated test media, native microphone denial while off in both windows, camera denial, geometry and IPC. No real microphone grant automated. |
| Native pet/island | 17/17 pass; zero external requests | Actual sprite playback, offline text review, missing-target insert refusal through real IPC, expiry/replacement UI, close/reopen, reduced motion, hidden pause and a scripted lock event. Does not lock Windows or type into another app. |
| Electron smoke | 23 routes; zero renderer errors/external requests | Real hardened app with isolated offline profile; navigation/basic persistence. |
| Island browser journey | 14/14 pass; no external requests/errors | Shared production glass shell over a labelled scripted bridge, not actual Windows actions. Details in `island-renderer/island-journey.json`. |

The native control helper returned an inconsistent target capture and then reported that its cursor overlay was no longer active. Codex stopped native input attempts and closed only the two review processes it had launched. **Manual typing into a real external window was not verified.** The successful direct-input tests use a fake native adapter; the actual native IPC test intentionally has no target and proves refusal before input.

The isolated native profile contains no API key. No real microphone recording, provider request, external account, personal document or OS settings change was used. The previously installed executable is unchanged; this is a rebuilt source/review branch, not a new installed release.

## Remaining computer-use work

Real external-app insertion/focus recovery and real microphone recognition still need a controlled Windows journey. The companion does not yet expose general semantic UI Automation inspection/click/scroll/navigation tools, a continuous screen-aware action loop, or verified completion of arbitrary tasks across apps. Existing region/Claude-vision and model tool-loop code still needs live-provider validation. Utility tray/routine integration and account connectors remain separate work. These are open gates, not features declared complete by the test count.

Manual review launchers: `scripts/computer-use-review.cjs` starts the built app in a fresh offline profile with normal native confirmations; `scripts/input-test-pad.cjs` creates a disposable local text target. They never auto-approve or reach an account. For future native evidence, pass `--out=../planning/ui-revamp/<dated-folder>` to the two native check scripts so historical evidence is preserved.
