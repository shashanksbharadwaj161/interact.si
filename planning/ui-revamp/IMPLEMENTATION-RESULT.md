# UI/UX revamp: implementation result

Branch: `claude/compassionate-hawking-m9x36g` (review branch; not merged into `main`).
Direction followed: `planning/ui-revamp/CYBERPUNK-DIRECTION.md` (origin/main 769ebec). It supersedes the earlier calm "Porcelain/Ink" art direction in `REVAMP-BRIEF.md`; the brief's structural requirements (areas, routes, onboarding, one shared companion renderer, honesty rules) still apply and are kept.

All screenshots and numbers below come from this Linux cloud container. **Nothing here was checked on Windows or in an installed build.** The checks that need Windows are listed at the end.

## What changed

### Visual system (every route)
- **Palette:** obsidian/graphite surfaces, electric cyan energy (`--energy`), ultraviolet depth (`--violet`), and scarce lime/amber signals. Tokens are in `src/styles/tokens.css`.
- **Themes:** Obsidian (dark) is the default; Chrome is the lighter variant; System follows Windows. The choice is a local preference (`appearance.theme`), and changing it makes no network request.
- **Contrast:** text, control and field-border pairs were checked in both themes. The lowest pair is field borders at 3.68:1, which passes the 3:1 non-text rule.
- **Type:** fonts are bundled locally and licensed under the SIL OFL 1.1:
  - Chakra Petch for display, navigation and labels;
  - Saira (variable) for interface and body text (Rajdhani was rejected for its small x-height at 14–15 px);
  - IBM Plex Mono for metadata.
  - License texts ship in `dist/licenses/` (source: `jarvis-desktop/public/licenses/`); see `src/assets/fonts/NOTICE.md`.
- **Geometry:** cut corners use `corner-shape: bevel` with an `@supports` fallback. HUD labels, corner brackets around the core, and a hairline energy edge on focal surfaces are used where they mark something real, never as fake telemetry.
- **Motion:**
  - Spring easings are CSS `linear()` curves sampled from a damped spring.
  - The rail and tab indicators slide (measured with FLIP).
  - Screens animate in, with a scan-line transition graphic.
  - The voice dock expands, the microphone panel opens from it, and panels and the command palette are choreographed.
  - All motion collapses under the reduced-motion setting, in the app or in Windows.

### Shell and information architecture
- Six primary areas (Today, Assistant, Workspace, Memory, Automations, Studio) plus a Settings footer. Every area with more than one screen shows contextual tabs; single-screen areas show a band with the area's name and purpose, so every page starts at the same height.
- All 23 view ids, deep links (`#/view?param=`) and Alt+1…9/0 positional shortcuts are kept, in the same `VIEWS` order. Ctrl+K opens a command palette that searches saved notes, tasks and capsules first, then actions and screens.
- Page titles now match navigation labels (Tasks, Desktop actions, Automations, Connections, Local models, Help & setup, Roadmap). Capsules keeps its name: a half-renamed "Setups" was worse than either name.
- Settings › Advanced holds System status, Local models (legacy), Developer and Roadmap.

### AI: Claude first
- **First run:** the user chooses between "Start locally" and "Connect Claude". The local path saves a real note or task and reads it back from storage before showing success. No Ollama, model download or loopback setup appears in first run or the Assistant.
- **Connect AI flow** (`src/components/AiSetup.tsx`), used from onboarding, the Assistant, Today and Settings › AI:
  1. Save the Anthropic key in the native vault.
  2. Turn on online mode, behind the existing native confirmation, with Cancel as the default.
  3. Choose from the provider's real model list for that key.
  4. Send an explicit test message with a cost disclosure, streamed for real, with Stop and Retry.
  - No model id is invented. A custom id is validated exactly as the backend validates it.
  - The flow says that a Claude.ai or ChatGPT subscription is not an API key.
  - OpenAI and OpenRouter keep their existing paths under "Other providers". Gemini is marked Not available.
- **The model list is the one native addition:** `cloudModels(provider)`.
  - Added to METHODS, ARITY, ARG_SPECS (an enum of provider ids) and preload, plus `parseModelList` in `electron/services/cloud.ts`.
  - It runs only in online mode, as a GET of `{anthropic|openai}/v1/models` through the existing network guard (purpose `provider-check`) with that provider's single credential header.
  - It is refused offline, without a key, and for OpenRouter, with zero requests in each case.
  - The key never appears in results, state or the activity log.
  - Covered by `tests/revamp-claude-models.test.mjs`.
  - The diff in `channels.ts`, `ipcCore.ts` and `preload.ts` is 4 changed lines; original CRLF line endings are preserved.
- **Readiness** (`modelReadiness`):
  - Offline means "AI is not connected", unless a legacy local model really answers its live check; then it is labelled "Legacy local model".
  - Unchecked or failed checks are "unknown", never "ready". Settings the backend would reject are never "ready".
- **Legacy local model:** kept under Settings › AI › Advanced, Settings › Local models and Connections, labelled as legacy, with its own live readiness (`legacyLocalReadiness`). Saved local settings and data are untouched.

### Screens
- **Today:**
  - Hero: HUD clock, greeting, and readouts of real counts that are hidden when everything is zero.
  - One start bar (note, task, or ask). It saves first, then reads the record back and links to it.
  - A readiness row that appears only when chat cannot answer.
  - Continue and Recently saved, from stored records.
  - Up next: overdue, today, this week, later, then undated, with a done checkbox on each.
- **Assistant:**
  - A route chip that opens the route, privacy and capability details.
  - An empty state built around the core.
  - Composer with Chat or Desktop action mode.
  - Expanding voice dock: the microphone consent switch now lives in a panel on the dock, off by default, and the reason Talk is off is always stated.
  - Drawer: History, Read aloud, Context and Actions.
  - Streaming with Stop, which keeps the partial reply.
- **Studio** (Companion): draft, Apply and Revert across every placement; forms Arc core, Lattice, Ribbon, Frost and Classic character; tint presets plus hue; motion Lively, Calm or Still; preview states are labelled as previews.
- **Settings:**
  - AI tab: Connect Claude, connection status, mode, providers and keys, AI readiness, and the legacy local model under Advanced.
  - Theme picker: Obsidian, Chrome or System.
  - Save, confirmation and recovery behaviour is unchanged.
- **Connections** lists Claude first. **Help & setup** gives Claude-first route advice; a legacy model that does not answer is "not available here", not a setup step.
- **Developer:** shows the shared renderer's own counters (backend, adapter, placements, quality, frames, context losses). They are read on open and on Refresh; the page runs no timers, per the existing task-budget contract.
- **Capsules** now hosts the file shelf, which previously sat outside Home's widget loop. Opening an item still goes through preview, then confirmation, then execute.
- **Workspace, Memory, Automations, Connections, Usage, Status, Roadmap, Character editor, Motion studio:** restyled through the shared component vocabulary.
  - Usage summary figures are now readouts.
  - Task rows wrap their controls instead of crushing the title.
  - Light-theme fields use a clear field colour.
  - The native file button is styled.

### One shared companion renderer
- `src/ui/orb-engine.ts` keeps one hidden WebGL1 context and copies each frame into every placement's own 2D canvas: rail presence, Today, Assistant, Studio stage and thumbnails, and onboarding.
- Placement visibility comes from IntersectionObserver, and drawing pauses on `visibilitychange`.
- The pixel ratio is capped at 2, or 1.5 above 280 px.
- Reduced motion, and the "Still" setting, give still frames redrawn only when the state changes.
- There is a Canvas2D fallback and context-loss handling.
- An adaptive quality governor reduces frame rate and resolution on a software GL renderer, or when the average frame interval exceeds 42 ms.
- States come only from real app state: idle, listening, transcribing, working, speaking, needs attention. The waveform ring moves only with the measured microphone level.

### Removed (with reason)
- **Unmounted widget dashboard:** `DashboardWidgets.tsx`, `WidgetPicker.tsx`, `src/ui/widgets.ts`, the old cockpit helpers in `Home.tsx` (status hierarchy, quick actions, activity grouping, capability view, widget layout) and the orphaned `parallel-home.css`.
  - The brief replaces Home's 12-widget dashboard. After the redesign nothing mounted these, so keeping them would have kept dead code alive only to satisfy tests.
  - Their tests were removed with them: `milestone-home-widgets`, `autopilot-widgets`, the dashboard reflow test, two layout parser rows in the security parser table, and three layout tests.
  - Saved layout preferences are left in storage untouched.
  - The scene-drift backdrop rules, still used by Studio and Capsules, moved to `scenes.css`.
- `avatar.css` was replaced by `companion.css` and `scenes.css`. The Instrument fonts were replaced.

## Verification (this container)

| Check | Result | Notes |
| --- | --- | --- |
| `npm run typecheck` (tsc) | Pass | |
| `npm test` | 1636 tests: 1616 pass, 15 fail, 5 skipped | The 15 failures are exactly the tests that also fail on `origin/main` here (16 there; the 16th is a date-sensitive quick-actions test deleted with the dead cockpit code). They need Windows paths, junctions, DPAPI or the Windows-only session file filter. The total fell from 1686 because of the removals above. |
| Renderer build (`vite build`) and main build (`scripts/build-main.mjs`) | Pass | |
| Electron smoke (`scripts/smoke.cjs`) under Xvfb with `--no-sandbox` (the container runs as root), renderer served from a loopback `VITE_DEV_SERVER_URL` | `ELECTRON_SMOKE_PASS` | Defaults to offline, CRUD persistence, window hardening, navigation blocked, all 23 routes render with their own current nav entry, 0 renderer errors, 0 external requests. It cannot load `dist` from `file:` on Linux because the app's file filter accepts only Windows drive paths; that is pre-existing and unchanged. The sweep now covers every view id instead of counting rail links, and treats only the loopback dev origin given in `VITE_DEV_SERVER_URL` as local. Electron under Xvfb blocklists WebGL1, so this run exercised the Canvas2D fallback. |
| Playwright journeys (`scripts/ui-journeys.mjs`, fixture backend, no network) | 7/7 pass | First-run local note; AI not connected; Connect Claude (fixture key, online, two fixture models, streamed test with Stop, then Assistant streaming where Stop keeps the partial reply); Studio Apply reaches the rail and Today and persists after reload; Alt+5 / Alt+2, Ctrl+K search and open, all 23 routes have an h1, Skip link is the first Tab stop; hidden window pauses and reduced motion gives a still frame; Studio frame timing. |
| Visual captures (`scripts/ui-review.mjs`) | 124 JPEGs in `planning/ui-revamp/after/`, plus `capture-report.json` | Onboarding, Today (empty, populated, AI blocked, check failed, browser preview), Assistant (empty, blocked, setup dialog), Studio, Settings › AI (not connected, connected) at 1280×720, 1366×768 and 1440×900 in both themes. Every other route, populated, plus six empty states at 1366×768 in both themes. Report: 0 page errors, 0 external requests, 0 horizontal overflow. |
| Motion evidence | `after/motion-strip-*.jpg` | Twelve frames each from the journey recordings: first run, Connect Claude with streaming, Studio Apply. These are stills from videos, not proof of smoothness on real hardware. |

**Frame timing (software GL in a container, so only relative evidence):**

| Screen | rAF/s | p50 | p95 | p99 | Main thread busy |
| --- | --- | --- | --- | --- | --- |
| Today, live core | 33.3 (45.7 in an earlier run on a quieter machine) | 16.7 ms | 83 ms | — | 1.8% |
| Studio, 340 px stage plus thumbnails | 19.5 (25.5 earlier) | 16.7 ms | 117 ms | 200 ms | 1.7% |
| Studio, reduced motion | — | — | — | — | 1% |

On a GPU the governor should stay at full quality; this has to be confirmed on Windows.

**What is real and what is mocked:**
- The journeys and captures use `tests/fixtures/fixture-bridge.js`, a labelled fake `window.jarvis`. It now also implements routines, local models, connections, usage, clipboard, productivity, calendar and documents with obvious demo data.
- Fixture "models" are `fixture-claude-model`; no real model id is shown as available.
- No real Anthropic request was made from this container, and no key was used. The real network path is covered by the unit tests, using an injected fetch.

## Native Windows checks still to run
1. `npm run smoke` on Windows, from `dist` over `file:` (not the loopback origin).
2. Installer build and `smoke --packaged`.
3. A real Anthropic key:
   - saved through the DPAPI vault;
   - turning online mode on shows the native confirmation, with Cancel as the default;
   - the model list arrives;
   - the test message streams; Stop and Retry work;
   - the key never appears in logs, the activity log or devtools storage.
4. Microphone: consent stays off by default, the Windows permission prompt, push-to-talk, the level ring moves only while recording, cancel.
5. GPU rendering:
   - the governor stays at full quality on a real GPU;
   - frame timing on a laptop iGPU at 1366×768 and 1920×1080 with 125% and 150% scaling;
   - the window-hidden pause and minimize-to-tray behaviour.
6. Windows "Show animations" off gives still frames; High Contrast (forced colors) on every route.
7. Font rendering with ClearType at 100%, 125% and 150%. `corner-shape: bevel` support in the shipped Electron Chromium; the fallback is rounded corners.
8. Upgrade from an earlier build: a legacy Ollama setup is still "Legacy local model", saved notes, tasks, capsules and avatar packs load, and an old Paper theme maps to Chrome.

## Constraints kept
- These are unchanged: contextIsolation, sandbox, no nodeIntegration, the network guard, trusted native confirmations with Cancel as the default, the offline default, BYOK in the native vault, and data and account isolation.
- The only native/preload change is the read-only `cloudModels` method, justified by the owner's model-availability requirement.
- The Control Room, worker loops and historical worker snapshots were not touched or restarted. There were no purchases, credit activations, billing changes, global installs, private runtime reads or real account actions.
- No Playwright browser was downloaded; the preinstalled Chromium was used.

## Skills
- The bundled `artifact-design` skill was read and its principles applied where they fit an app: tokens for both themes, deliberate neutrals, type pairing, and spacing through layout.
- The "taste", "UI/UX" and "Karpathy" skills named in the owner's notes were not available in this environment. They were not installed and are not claimed.

## Known gaps
- The Classic character in the Character editor is the legacy robot pack from earlier versions. It is kept for compatibility as an optional form, and the default companion is the original Arc core.
- Pages that render only in the browser preview without a backend still say "not connected" with a plain notice. In the real app those bridges exist.
- Frame timing and font rendering have not been measured on Windows hardware.
