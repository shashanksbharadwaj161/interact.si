# Development verification — 2026-10-14

This is an in-progress companion, without a final product name. The 140-feature roadmap remains open.

- Combined frontend/native source passes TypeScript and production builds.
- 10 frontend behavior tests passed (navigation, preview CRUD limitations, WAV encoding, roadmap inventory and helpers).
- Real Electron smoke passed in temporary user data: offline default, note/task/capsule CRUD, empty capsule restore, cloud key absent; actual Windows TTS and en-US basic recognizer detected.
- Real Electron local AI smoke passed against dedicated loopback Ollama at `127.0.0.1:11435`, model `qwen3.5:2b`: arithmetic response `12`, source `local`, no cloud key configured; cold operation ~26.9 seconds.
- NSIS x64 development installer builds (~115 MB). Unsigned; installation/uninstallation and packaged native behavior still require verification. Local model runtime/weights are not bundled.
- Control Room redesigned with task filters, current activity, assigned/latest API models, pending approvals, stale-state warnings and reserved budget. Frontend build passes.
- Gateway compatibility fixed for CLI forced-tool auxiliary calls, client context-edit fields and per-message output fields unsupported by token counting. Main Fable/Opus calls now report successful usage.
- $300 persistent development ledger remains in the original protected local runtime; uncertain reservations retained, no reset. Billing remains authoritative.

Pending: agent security findings, backend negative tests, keyboard/browser QA, model setup UX, scoped native action tests, package execution, signing decisions, commercial dependency checks, and the remaining roadmap. A successful test above does not establish those pending features.
