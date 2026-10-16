# Full product UI/UX revamp

16 October 2026. Latest user instruction supersedes the old stopped-development handoff for this specific work. Implement in `jarvis-desktop/` in this repository, using Claude Code's existing session. Keep the paid API Control Room and historical loops stopped. No purchases, payment changes, API worker launches, or additional usage-credit activation. Do not edit the old worker snapshots.

## The problem and the requested result

The user installed the app and rejected its usability and visual quality. Passing 1,686 tests did not establish a usable application. This is a full product redesign, not a color change, landing page, orb pasted over the old dashboard, or new set of feature placeholders. The user wants a premium Windows companion: clear daily workflows, exceptional materials/typography, original avatars and expressive motion. Hitodama is the strongest experience reference. Space UI, Skecher UI, Planes, Unicorn, Zajno and the supplied galleries inform selected interactions. Their brands, source, media and marketing claims are not ours to copy.

Temporary visible name: **Desktop Companion**. Do not name it Jarvis or invent a permanent brand. Historical identifiers and directory names remain for compatibility.

Success means a first-time user can complete useful local work without learning provider endpoints, security plumbing or our feature inventory. Optional AI setup must lead to an actual working conversation or one specific recovery step. An avatar selected in Studio must be the avatar shown everywhere. No invented progress, fake activity, unsupported integration claims or hidden reasoning displays.

## Audit findings to fix

1. `src/ui/nav.tsx` promotes all 23 routes to the primary sidebar. On smaller windows it becomes a strip of unexplained icons. Group by user purpose while keeping existing route IDs, deep links and shortcuts.
2. `Home.tsx` has 12 default widgets plus additional dashboard/shelf content. Empty statistics dominate the first view. Replace this with one useful start and a small amount of relevant saved work.
3. `Onboarding.tsx` accepts a model name without a successful readiness check and can finish into an unusable Assistant. A local-tools path must work with no AI model installed.
4. `Assistant.tsx` puts diagnostics, configuration, history and multiple tool panels around the composer. Conversation and the immediate next action need to dominate.
5. `Avatar.tsx` renders a hardcoded CSS robot. `AvatarStudio.tsx` edits a different canvas pack. The studio output is not the companion visible in the shell. Fix the data/rendering connection; remove the robot aesthetic.
6. Settings mixes immediate application and explicit Save. Use consistent behavior with clear dirty state. Developer diagnostics, signing tools, roadmap scope numbers and endpoint plumbing should not dominate consumer workflows.
7. Generic nested panels, tiny uppercase labels, monospace metadata and glows give everything equal visual importance. Rewrite the structure and reusable components instead of appending more CSS overrides.
8. Current smoke checks bypass onboarding and prove route mounting, not successful user journeys. Preserve security coverage, add a few meaningful interaction checks and inspect actual screenshots.

See `PRODUCT-AUDIT.md` for detailed source evidence. Codex inspected browser previews of onboarding, Home and Assistant; those previews cannot verify Electron, native actions, live voice or keys. The user's installed-app verdict remains the acceptance signal.

## Art direction: a calm instrument with a living presence

Create an original **Porcelain / Ink** visual system: soft neutral light surfaces and deep warm-charcoal dark surfaces, crisp text, one controlled blue accent, and an unusually well-rendered companion. System theme is the default; provide explicit light and dark choices. Keep the daily work surface calm while Studio and the compact companion carry expressive effects.

Design dials: visual character 7/10; motion 3/10 during work, 6/10 in the companion/Studio; default density 3/10, detail tools 6/10. These are design intentions, not measured performance scores.

- Use readable 14–16px body text, clear 18–24px headings and generous but purposeful spacing. A local licensed display face may distinguish a welcome/Studio heading; do not apply enormous website headlines to forms. Segoe Variable/system fallback is acceptable for working text. Bundle any new font and its license, no runtime font CDN.
- Suggested starting tokens: light background `#F5F4EF`, surface `#FFFFFF`, ink `#20221F`, muted `#666B65`, accent `#3459D1`; dark background `#131513`, surface `#1B1E1B`, text `#F2F3ED`, muted `#A8AEA5`, accent `#9BB4FF`. Validate actual contrast and adjust tokens together.
- Use 4/8px spacing scale; roughly 8px controls, 14–18px containers, pills reserved for concise state/navigation. Borders only where they establish grouping. Prefer spacing and separators over nested cards.
- Keep the installed Phosphor icon family. Navigation labels remain visible in normal desktop use. No cheap robot face, orbiting dashed logos, decorative telemetry, ubiquitous purple haze, giant status dashboards, or glass on every surface.
- Reserve refractive/material effects for one orb and possibly a compact floating voice control. Text surfaces stay opaque/readable. No copied Hitodama flame, identity, pricing, images or website copy.
- Motion tokens: hover/focus 120–160ms, disclosure/dialog 180–240ms, route transitions 180–280ms. Bounded springs may animate the active navigation indicator/voice pill. Never delay input, move hit targets during selection, hijack scrolling or gate normal work behind an intro.
- Reduced motion produces immediate/simple transitions and a static companion. Provide a visible motion toggle, solid transparency fallback, Windows high-contrast support, strong focus and AA contrast. Canvas must not be the sole carrier of status.

## Navigation: six primary places, Settings in the footer

Keep underlying `ViewId`, hash parsing, query parameters, source records and the existing first-ten positional shortcuts compatible. A route can move into a contextual section without disappearing. Use a stable labeled rail with contextual secondary tabs/list and command/search access for infrequent tools. Do not create two conflicting Ctrl+K shortcuts; preserve memory search and extend it deliberately if needed.

| Primary area | Existing routes retained | Default user job |
|---|---|---|
| Today | `home` | Start something useful or resume current work |
| Assistant | `assistant`, `computer` | Ask, speak, attach context, review supported actions |
| Workspace | `notes`, `writing`, `tasks`, `calendar`, `capsules`, `clipboard` | Work with saved content using consistent list/detail patterns |
| Memory | `search`, `memory` | Search, manage selected sources and opt-in history |
| Automations | `routines` | Build/review/run routines and inspect real results |
| Studio | `companion`, `avatar`, `motion` | Choose companion and customize appearance/motion |
| Settings/footer | `settings`, `integrations`, `models`, `usage`, `guide`, `status`, `developer`, `lab` | Accounts, AI, preferences, help; diagnostics under Advanced |

All 23 routes must remain reachable and visually coherent. A navigable advanced page is preferable to deleting functionality. Connections needs an obvious entry from Assistant and Settings; it is not buried behind a developer label.

## Screen-level requirements

### First run

One welcoming scene with the original companion and two clear paths: **Start locally** and **Connect AI**. Start locally must require neither an endpoint nor a model download. Guide the user into creating a note or task; show the actual saved result. Request microphone, files, clipboard history and computer-control access only when relevant. Do not preselect broad capture permissions.

AI setup: provider choice, protected key entry through existing IPC, model selection with an Advanced custom field, explicit optional test with potential usage explained, then the Assistant. No silent request while onboarding loads. A missing local model or failed provider leaves a direct recovery action and a working local-tools path. Do not call AI ready because a string was saved. Retain existing settings/data through migration.

### Today

Use one warm greeting, a focused command/start area and at most three meaningful sections: continue work, upcoming tasks, recent saved items. No empty counter grid or all capabilities report. Present useful empty-state actions. The companion should feel present without consuming the entire work area. Layout remains useful at 1280×720.

### Assistant

Conversation and composer are the main surface. Empty state has a tasteful orb, a brief invitation and a few actions reflecting capabilities that actually exist. Put model/provider/online state in a compact control; show expanded diagnostics on demand or when blocked. History becomes a drawer/secondary list. Attachments/context appear in a clear tray; user sees what will be sent online. Voice uses a compact expanding control with a visible Stop/Cancel. Stream, cancel, retry, error and disconnected states are distinct and usable. No nested full Studio inside chat.

Supported computer actions use a readable proposal with exact target/effect and the existing trusted native confirmation. Capability menus describe supported actions rather than pretending arbitrary desktop operation is implemented. Preserve cancel-default behavior, expiry and approved HWND/PID enforcement.

### Workspace and Memory

Unify notes/writing/tasks/calendar/workspaces/clipboard with a consistent list/detail layout, useful empty states, search/filter, selection, save feedback, destructive confirmation/undo where supported and keyboard navigation. A local .ics calendar is labelled as local import; it is not a Google account connection. Renaming Capsules in visible copy is allowed but keep storage/route compatibility. Opt-in memory/history is separate from selected current context.

### Automations

Readable trigger → steps → result structure, clear dry-run/review/run, cancellation and actual last result. Distinguish manual routines from schedules supported by the real backend. Do not add an unrestricted autopilot switch or imply unsupported automation.

### Studio and shared avatar

Replace the hardcoded robot with a **single typed companion appearance model and shared renderer** used by shell, Assistant, Companion and Studio preview. Preserve/import existing packs through a compatibility adapter; do not erase personal work. Selecting/applying an appearance updates all placements, persists and survives relaunch. Large Studio preview must use the exact same rendering implementation as small placements.

Start with three or four polished original presets, for example refractive porcelain orb, smoked-glass orb, and a restrained ribbon/particle form. Quality matters more than a page of random shapes. Provide a fully static option and an avatar-hidden option. Curated 2D/3D/human/animal/import categories can be secondary where actually supported; do not claim photoreal avatars, VRM or phoneme lip sync from procedural circles. Keep working advanced tools reachable and label unsupported formats plainly.

The signature orb needs convincing depth, controlled light, a coherent silhouette, anti-aliasing and a strong small-size appearance. Use an isolated Canvas/WebGL component or one justified permissive dependency. Not a flat CSS gradient circle with a glow. Handle context loss, reduced motion, low-power mode and static fallback. Cap DPR/particles, pause when hidden, stop unused animation frames/listeners, avoid React re-rendering the entire app per frame, and measure renderer idle CPU/GPU. No network assets.

State mapping comes from real companion events: idle, listening, transcribing, working, speaking, error. Audio intensity only from real captured/output measurements; no fake listening wave. Preview states may be manually auditioned in Studio and explicitly labelled preview. Accessible text/status and stop controls remain outside canvas.

### Connections, usage and Settings

Each user signs into their own supported accounts with scoped grants. Show connected identity, reconnect/disconnect, permission scope and setup-required state. A website launch, local import or missing OAuth app registration must not appear as a working authenticated integration. Preserve credential protection. No new credentials needed for this visual work; use labelled test fixtures in QA.

Usage can borrow OpenUsage's clarity: compact provider rows, time windows, reported vs estimated values and unavailable states. Do not invent billing totals or read provider session tokens. Settings has consistent save feedback, clear Appearance/AI/Accounts/Privacy/Data/Advanced organization, and searchable settings if practical. License/signing/developer details belong in Advanced.

## Implementation sequence and ownership

Use a single coherent implementation branch. Avoid parallel rewrites of App, Assistant and shared styles. Finish and verify each slice, then continue through the full migration; a first slice is not final delivery.

1. Read this brief, the audit and source. Record concise UI architecture and route mapping. Establish tokens, primitives, shell and navigation. Build the shared companion model/renderer.
2. Complete the representative vertical slice: first run → Today → Assistant, plus Studio selection affecting the live companion. Capture light/dark screenshots at laptop size. Critique and repair before multiplying the pattern.
3. Migrate all remaining routes, Settings and connected-account states. Fix small broken UI-to-existing-backend wiring encountered on the verified journeys. Do not add mock integrations or enlarge scope into unrelated backend rewrites.
4. Run appropriate checks and actual interaction/visual acceptance. Build the Windows package when the environment supports it. Document Windows-only checks that need Codex/local machine rather than claiming they passed in Linux/browser preview.
5. Commit the reviewable branch and provide a PR/diff if supported. Do not merge main automatically. Report changed screens, screenshots, journeys passed/failed and exact remaining blockers. No numeric completion claim from test counts or source coverage.

Assigned paths: all of `jarvis-desktop/src/components/`, `src/ui/` (preserve bridge semantics), `src/styles/`, original local UI assets/fonts and license notices, narrowly needed tests/scripts/docs, `package.json` and lockfile only for justified UI/test dependencies. This assignment supersedes old per-worker path restrictions for this UI task. Native/preload/shared contract/security changes require a concrete demonstrated blocker and minimal reviewed fix; prefer leaving those surfaces untouched. Root `planning/ui-revamp/` may receive verification notes. Do not edit control-room or worker-snapshots.

Keep React/TypeScript/Electron/Vite. No Next/Svelte/framework rewrite. One icon family and one design system. Prefer semantic native controls; use accessible primitives only when they solve a real need. Review dependency compatibility/license before adding. Do not bulk-install reference repositories or every skill. Work repo-locally. No user personal data/private agent state/keys access.

## Security and behavior contracts to preserve

- Offline by default. No telemetry, runtime remote fonts/assets, silent provider fallback or AI call without explicit user action and selected-data disclosure.
- Protected per-provider keys stay in the native vault, never browser storage, prompts, logs, screenshots or repository.
- IPC authoritative METHODS/ARITY/ARG_SPECS, source validation, contextIsolation, sandbox, no nodeIntegration and network guard remain intact.
- Real native action previews, trusted confirmation, cancel default and narrow execution permissions survive the redesign.
- Preserve saved notes/tasks/capsules/history/avatar packs/settings, backup/recovery and migrations. No fake success toast before actual persistence completes.
- No organization-wide account sharing. No payments/auto-reload, browser security weakening or production user actions during testing.

## Acceptance and evidence

Passing unit tests is necessary where relevant, but does not answer whether this product works for a person. Keep existing security/behavior checks; don't weaken assertions to fit a new screenshot. Update brittle route-layout tests only while preserving their original behavior contract.

Verify these journeys through the visible UI, using isolated test data:

1. Fresh install, no model/key: Start locally → create note/task → reopen saved result. No default error wall; first success achievable without guidance in roughly two minutes (measure, do not assume).
2. Missing model/provider: a single clear setup/recovery action; ordinary local work remains usable. An opt-in provider test is reported separately from mocked/offline tests.
3. Conversation with a fixture backend: stream → cancel → retry/error recovery; current selected model/context is honest. Separately verify real BYOK only with explicit existing product authorization and never expose keys.
4. Choose Studio appearance → shell/Assistant/Companion all change → relaunch retains it. Old pack remains recoverable.
5. Keyboard traversal/navigation/dialog focus and Escape; all 23 deep links reachable; search doesn't silently break.
6. Theme/system/reduced-motion settings persist; light/dark, empty/populated/loading/error states are inspected. No text obscured by orb, no horizontal overflow, no hover-only essential controls.
7. Native action approve/cancel harness preserves trusted confirmation, correct target and cancel safety. Browser preview explicitly states native capabilities unavailable.
8. Export/import and existing data work after migration; denial/disconnect/offline have actionable recovery. No external requests in offline smoke.

Capture representative views at 1280×720, 1366×768 and 1440×900; test Windows 125%, 150% and 200% scaling locally where available. Measure hidden/idle companion CPU/GPU behavior and clean up render loops. Document hardware/environment. Screenshots prove composition, not motion or native feature execution: record interaction results separately.

Required checks from the committed scripts: `npm ci`, `npm test`, `npm run build`, `npm run smoke`; inspect scripts before execution. If Electron/Windows packaging is unsupported in Claude's environment, run feasible gates, provide a precise handoff and do not fabricate installer verification. Existing UI snapshots should be compared by a person, not accepted merely because files exist.

Deliver `planning/ui-revamp/IMPLEMENTATION-RESULT.md` with actual branch/commit, routes migrated, real/mocked/not-run checks, before/after evidence paths, known blockers and next exact local verification command. User acceptance is still required before claiming the app finished.

## Skills and reference use

Codex read the installed `design-taste-frontend` skill and used its audit-first, typography, spacing, original-material, coherent-component and anti-template principles. That skill explicitly targets websites rather than multi-step product UI; its landing-page mechanics do not override desktop task usability. No separate installed Karpathy/UIUX skill was found in the targeted skill inventory. Do not claim to have used missing skills. In Claude, inspect relevant actually available skills; otherwise follow this original brief. Use explicit assumptions, a small clear implementation, targeted changes and verifiable outcomes.

Read `REFERENCE-REVIEW.md`: exact sources, observed evidence and restrictions. Codex opened all explicitly listed design pages in the browser; many are catalogues/embedded previews, not fully verified demos. Historical 83 HorizonX entries are recorded references, not 83 fresh interaction audits. The previous Folded Signal assets belong to another website project and are not this app's chosen brand. NOVARA remains rejected.

Do not copy paid template source. Avatar Lab is AGPL-3.0-only; treat as workflow inspiration for a future proprietary product unless licensing is deliberately resolved. OpenUsage is Swift/macOS, not an installable Windows dependency. REA is investigation tooling, not a UI toolkit. The video repository is an index of examples/prompts, not a video-generation engine. Topic pages are not installable packages. Design patterns may inspire original code; media/source rights must be checked independently.
