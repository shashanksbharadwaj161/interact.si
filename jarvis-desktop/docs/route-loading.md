# Local route loading

14 October 2026. Production renderer now opens 17 secondary screens through React lazy imports. Initial Home, onboarding, the shell, Settings and shared Memory Search stay available without another module. Settings exports preference hooks used by the shell; Home imports Memory Search. Those dependencies remain static rather than creating an import cycle or an artificial split.

All chunks are build-generated files under `dist/assets`, referenced relative to the app's local entry. There are no remote imports, new dependencies or automatic API requests. Electron's file-based offline allowlist remains intact.

While a screen loads, its main region announces “Opening [screen]” through a status region and `aria-busy`; navigation remains available. A screen import/render failure is caught inside its route boundary. The notice offers existing sidebar navigation and an explicit app reload, with a warning that reload may discard unsaved edits. Changing routes creates a fresh boundary. No automatic reload loop.

## Build evidence

Before: one initial JavaScript file, **867,387 bytes**. After: initial JavaScript **458,830 bytes**, about **47.1% smaller**. Motion Studio is a deferred **73.44 kB** chunk; Avatar Studio **47.78 kB**. This reduces initial parsing/loading work; it does not claim a measured startup-time improvement or reduce the total feature code.

Computer imports existing command helpers from Assistant, and Assistant imports its optional inline Avatar Studio preview. Opening Computer/Assistant therefore loads their shared dependencies; these existing relationships were preserved without duplicating helpers or moving files owned by other modules. No speculative prefetch of every screen.

## Validation

- `npm run build`: typecheck, Vite renderer and Electron main/preload build passed.
- Shell route/capability/accessibility suites: **48/48 passed**, including a cold route's actual loading status and retained current navigation. Streaming SSR waits for actual lazy imports before existing content assertions; assertions were not replaced with loading-only checks.
- Real Electron temporary-data smoke: **20 routes**, **0 renderer errors**, **0 external requests**; offline default, hardened window, navigation restrictions and 11 native helper integrity entries passed. Observed smoke working set: **437 MB**, not an idle benchmark.
- Separate hidden Electron fixture intentionally throws inside the real `RouteBoundary`: caught-error notice, reload warning/control and retained navigation passed; navigating afterward rendered its fixture Home. Fixture used sandbox/context isolation, no Node integration, local file requests only, temporary user data and no real desktop/microphone actions. Evidence: `work/route-boundary-probe.log` in the session workspace.

Remaining acceptance: keyboard/screen-reader behavior during an artificially slow load, packaged installer cold-cache loading on a second laptop, and a controlled startup timing benchmark. The installer must be rebuilt to include these source changes.
