# Integrated baseline check — 14 October 2026

Baseline commit 590aa55, checked by root after captain stopped. These checks predate milestone-team work.

- `npm run typecheck`: pass.
- `npm test`: 579 tests, 575 pass, 0 fail, 4 todo (deep-link selection and unmounted routes). TODOs are unfinished work.
- `npm run build`: pass; renderer bundle has Vite's >500 kB chunk warning.
- `node node_modules/electron/cli.js scripts/smoke.cjs` with ELECTRON_RUN_AS_NODE removed in the child shell: pass on this laptop, temporary test data, offline default, notes/tasks/capsules CRUD, key absent, hardened webPreferences, navigation blocked, helper integrity manifest (10 files), zero external requests, measured working set about 344 MB.
- Windows TTS/basic local recognition and protected credential storage were detected. No microphone session, real input injection, local model response, OCR or vision verified in this run. Ollama intentionally stopped during worker pool; OCR/vision report unavailable.
- Control Room status changes passed 25 tests before buffer change. New buffer and status focused checks: 13 pass. Restart activated $30 reserve, retaining all prior spending entries and unresolved reservations.

Next milestone captain must rerun combined checks after merging new screen/data adapters; do not present this baseline as final installer acceptance.
