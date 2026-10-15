> Latest checkpoint: 16 October 2026. User rejected installed usability/functionality. Product unfinished; paid workers stopped. Start with [CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md). Older evidence below is historical.

# Desktop Companion — development checkpoint

Saved 15 October 2026. Product name is temporary. This is an unfinished Windows desktop prototype plus its local agent control room.

## Contents

- jarvis-desktop/: canonical desktop source, tests and documentation. The folder name is historical.
- control-room/: local dashboard, backend, bounded API workers and autonomous loop implementation.
- worker-snapshots/: recovered work. New api-loop snapshots are explicitly unverified drafts, not integrated features.
- planning/: scope and recovery inventory.
- dev-tools/: development references and tools retained from earlier checkpoints.

## Verified this checkpoint

Desktop: 1,266 tests pass; production build passes; offline Electron smoke passes across 23 routes with zero renderer errors or external requests. Control room: 140 tests pass and production build passes. The desktop build has a bundle-size warning.

The feature registry contains 140 entries: 5 verified, 81 partial, 54 planned. Those are checklist classifications, not a reliable overall completion percentage. Passing tests does not establish that every product feature is complete.

The autonomous loop reached round 16 but accepted zero batches into the canonical app. Nineteen worker drafts containing 30 changed files were recovered separately. No paid workers are active and online mode is disabled.

## Remaining work

Audit and integrate useful drafts independently; finish partial/planned capabilities; verify real account integrations and device behavior; validate Windows installation, upgrades and uninstall; complete release hardening and signing. This checkpoint is not a production-ready release.

Credentials, local authentication tokens, private runtime state, dependency directories, generated builds and installers are excluded. Restore provider credentials only through the local protected settings flow. Never reset the local budget ledger to create apparent allowance; do not enable payments or auto-reload.

See RESUME.md and session-summary.json for the current handoff.
