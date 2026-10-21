# Dynamic island and app audit — 19 October 2026

Reviewed the current source build on Windows, using disposable offline profiles. The installed application was not replaced. No development credential, personal app data, real microphone recording or paid model request was used.

## Findings repaired

1. **Source app was not attached.** The old foreground lookup discarded results after 700 ms, while Windows PowerShell cold start took longer on this laptop. The lookup now allows up to six seconds before the island takes focus. Close, lock, explicit target removal and disposal invalidate pending results; repeated invocation cannot focus early. Timeout/failure still leaves no target. This remains a cold-start delay, not instant capture.
2. **Ask looked available during voice capture.** The click handler already refused it, but the button is now visibly disabled during recording/transcription as well.
3. **Stale screen warning.** Attaching a fresh area now clears the previous area's expiry warning.
4. Review tooling now creates its evidence directory before saving native screenshots, accepts a separate manual-review output directory, and reports frame timings even when a reversal check fails.

## What was actually verified

| Capability | Evidence and limits |
| --- | --- |
| Global invocation from another app | Real Windows keyboard shortcut opened the actual production island. |
| Reviewed external typing, offline | Separate disposable Electron document → invoke → exact text review in native dialog → Continue → all 34 characters visibly present in that document. Screenshot: `manual/typed-target.jpg`. No model call or simulated input adapter. |
| Action result | Actual island reported `On this computer · no AI request` and `Typed 34 characters… Not read back`; no invented save/undo. The audit independently read the disposable document afterward. |
| Keyboard dismissal | Escape returned the real island to rest. |
| Docking, sizes, bounds and IPC validation | Native placement checks on Windows. Includes microphone/camera default denial; does not prove real pointer dragging, click-through or acrylic composition. |
| Pet and native shell | Native playback checks verify multiple wave poses, real atlas rendering, opening, close-before-shrink, reopening, selected-area expiry/cleanup, reduced motion and hidden-window pause. Screen tokens and lock events in these checks are synthetic; no actual OS lock or desktop screenshot capture. |
| Intermediate work, confirmation, receipts and error views | Browser journey using the shared production shell with a **scripted backend**. Its utility tray/controller is not the actual native CompanionApp controller. |
| Local hub basics | Real Electron smoke creates/persists a note, task and empty capsule; 23 routes render, no renderer errors or external requests. This is not functional validation of every feature on those routes. |

## Animation qualification

The first browser run passed 13/14 checks: rapid reversal exceeded the 60 ms frame threshold while other checks were running. The follow-up passed 14/14; reversal mean 16.49 ms, p95 17.4 ms, maximum 18.5 ms. Keep both reports. These measurements describe headless Edge rendering on this laptop, not a universal performance guarantee or Windows composition benchmark. The pet remains labelled **Animation preview**, with discrete sprite poses rather than a continuously rigged character.

The first native pet run stopped because its screenshot output directory did not exist. That review-script defect was fixed; a separate recheck completed. It was not a product animation failure.

## Still not verified / incomplete

- Live Claude responses, billed tool loops and AI analysis of an actual selected screen region were not exercised.
- Actual microphone recording/transcription and native Windows acrylic appearance were not exercised.
- Arbitrary cross-application semantic inspection, click/scroll/navigation and result readback remain incomplete. Reviewed text insertion is a narrower capability.
- Gmail, Spotify and other account integrations are not certified by this audit; rendering their pages is not evidence that login/provider operations work.
- Real mouse drag/click-through, multi-monitor transitions and a freshly installed package still need interactive acceptance checks. Automated bounds tests cover common DPI geometry, not every physical monitor setup.
- Native Follow up was attempted once through the desktop helper without a confirmed state change; it is not counted as a successful manual check. Scripted controller tests cover it separately.

See `verification.json` for final checks and the adjacent first-run/recheck reports for reproducible evidence. No percentage of the whole application is inferred from test counts.
