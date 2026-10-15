# Current personal-build verification — 14 October 2026

Paid work renewed by explicit user instruction: $300 total ceiling/$30 buffer. Two new Fable/Opus vertical slices are assigned in `substantial-build-plan.md` and `substantial-team.json`; they are pending and not yet part of the baseline/installer below.

Current continuation: 955 tests pass. Initial renderer is 47.1% smaller through local route loading; actual ASAR is 1.41 MB after unused dependency removal. Packaged-code Electron smoke passes all 20 routes, zero errors/external requests. See `route-loading.md` and `package-footprint.md`. Paid access remains disabled at the $150 stop point. Scope coverage remains 5 verified/81 partial/54 planned.

Latest update: [local recovery verification](local-recovery-verification.md) supersedes the counts and budget below: 954 tests passed, selected-image OCR and consented voice/avatar preview integrated, 5 verified/81 partial/54 planned. Paid workers stopped; persisted spending ceiling lowered to $150 after console already showed $159.57. Historical baseline follows.

Latest work completed locally after cloud worker task reservations stopped further inference. No additional Anthropic tasks or budget increases for this completion pass.

## Confirmed

- Combined suite: **929 tests pass, zero failures, zero TODOs**.
- Typecheck and renderer/main/preload build pass.
- Real Electron, temporary user data: offline default, notes/tasks/capsules CRUD, no configured cloud key, native helper integrity manifest (11 helpers), hardened preferences and blocked unwanted navigation.
- All **20 routes** mounted without renderer errors. **Zero external requests** observed. Measured smoke working set approximately 442 MB on this laptop.
- Windows basic speech recognition/TTS, DPAPI and native OCR engine availability detected. No actual microphone session, desktop input or OCR recognition of a user image was run.
- Motion studio has bounded deterministic timeline/frame transport, keyframe/easing editing, presets and local SVG/contact-sheet/CSS/JSON export controls. Avatar editor has original vector poses/timelines/import review and clearly labelled simulated amplitude when no host audio is attached.
- UX review fixes cover shortcut copy, paper warning text, input borders, stale segmented selection, playback semantics and forced-colors focus. Behaviour/static tests passed; no screen-reader/High Contrast runtime claim.
- Model packs reject ancestor/nested filesystem links before content I/O and recheck before streaming. OAuth fragment secrets redact before logging.

## Control Room

Budget/context blocks are separate from actual input questions. Live browser verified Needs your input = 0. Permanent budget denials return HTTP 402, schema/context 400 and policy 403, so the SDK does not endlessly retry them as temporary 502 errors. Control Room tests: 40 pass. Previous request reservations retained; $300 ceiling and $30 safety reserve unchanged. Interrupted cloud source preserved in worktrees.

## Limits and remaining work

This is an unsigned x64 personal build, not completion of all 140 roadmap scopes. Registry currently records 5 verified, 80 partial and 55 planned; it predates this final verification and needs per-scope evidence review before raising statuses.

Local model weights/runtime are not bundled; Ollama was intentionally stopped during the smoke. Optional provider APIs require the user's keys/online mode. Spotify OAuth, browser extension automation, signing, real input/microphone tests, full screen capture/vision, advanced 3D/portrait avatars and frame-exact commercial video encoders remain gated or unfinished. No account or hardware gates were silently marked complete.

Interactive motion exports and High Contrast need manual runtime checks. NSIS install/uninstall and upgrade recovery have not been tested. Build has Vite's existing >500 kB renderer chunk warning; route code splitting remains a performance improvement.

NSIS x64 packaging passed: `release/Desktop Companion Setup 0.1.0.exe` (115,030,475 bytes). Authenticode status is `NotSigned`. SHA-256 and source checkpoint are recorded in `docs/installer-verification.json`; installation/uninstallation remain untested. No GitHub push was performed.
