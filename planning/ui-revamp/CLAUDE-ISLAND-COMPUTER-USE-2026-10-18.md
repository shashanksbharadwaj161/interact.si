# Implementation assignment: an expressive Windows companion

18 October 2026. Owner's latest instruction. This supplements the existing revamp brief and replaces the idea that neon styling on a dashboard is sufficient. Implement the native experience, not another proposal. Coordinate with Codex's local character/effects work. The application name remains **Desktop Companion**, pending the owner's decision.

## The desired result

The computer should feel alive: an original animated pet and a compact, smoked-glass island that understand deliberately selected context, accept speech or text, perform supported actions in the current app and show what actually happened. The full workspace is available for long work and settings; ordinary use should not require navigating a dashboard. Personality, motion, sound and material must feel like one product.

The owner specifically requests futuristic glassmorphism, vaporwave grids, flow fields, ASCII motion, luminous button and perimeter edges, unusual but readable typography, an animated character and fluid island transformations. They rejected the previous generic dark panels, clipped-corner controls, static orb/image and pages full of feature buttons. A working feature hidden on another route is not an adequate interaction design.

## Research and visual references

Open the actual references when browser tooling is available. If it is not, say which were not viewed; don't fabricate a visual audit. The Dribbble pages are design presentations, not proof of implemented software, licensed source or functionality.

1. https://hitodama.in/ and https://hitodama.in/#island — the important reference is the product's small presence over the existing desktop and utilities revealed around it. Its public scene cycles through music, plans, clipboard, apps and wallpapers. Its public page demonstrates circle-to-ask, dictation, scheduled search and routines. Reuse the interaction principle, not its branding, art, copy or proprietary implementation. The public site is cream/editorial, which is not our requested palette.
2. https://dribbble.com/shots/27809089-Nivo-Personal-Finance-Dashboard-UI-Design — Dipa Inhouse's Nivo. Codex opened the live page and played its 21.17-second video. Observed: near-black violet surfaces, quiet thin boundaries, a foreground autopilot sheet separated from the dimmed workspace, carefully weighted type and restrained violet light. Borrow depth, hierarchy and control detail. Do not turn our product back into a finance dashboard or copy its charts.
3. Nivo image links exposed by that page, useful visual grounding:
   - https://cdn.dribbble.com/userupload/49315580/file/9436026a5d64fa80ea3e1e369e09bfa9.png?resize=752x&vertical=center
   - https://cdn.dribbble.com/userupload/49315577/file/2419951e7f3a3690c3c3439520cebc1d.png?resize=752x&vertical=center
   - https://cdn.dribbble.com/userupload/49315578/file/773b58953d9dba3efcd5157ef4f07ec0.png?resize=752x&vertical=center
   These are reference images, not assets to redistribute in our app.
4. https://dribbble.com/shots/popular/animation — Codex opened the current gallery. It contains varied work, not a single prescribed design. Study continuity of shape, layered transitions and microinteraction timing. Avoid a disconnected collection of copied effects.
5. https://dribbble.com/search/cyberpunk — Codex viewed the current gallery: technical dark compositions, strong graphic type, deliberate asymmetry and contrasting focal accents. It also contains busy game/HUD illustrations; don't copy that density into everyday controls. Cyberpunk is a direction, not permission to make labels unreadable.
6. Existing research in this repository: HITODAMA-DEEP-STUDY.md, GLASS-AND-COMPUTER-USE.md, FUTURE-COMPANION-PLAN.md, PET-RENDERER-PLAN.md, COMPANION-STATUS.md and VOICE.md. Their dates matter: audit claims against current source before reusing them. The old capability inventory predates your native agent/vision/voice work and must not be presented as current.

Primary engineering references, checked by Codex today:
- Electron BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window
- Electron custom/transparent windows: https://www.electronjs.org/docs/latest/tutorial/custom-window-styles
- Anthropic computer-use client tools: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- Microsoft UI Automation: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview
- Control patterns: https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview

Electron's installed typings and exact supported API/model versions remain authoritative for this checkout. Do not guess model names or invent a working native-control SDK. Anthropic tool calls still need a local executor; an API key alone does not control Windows.

## Coordination and actual state

Your latest published commits are dc49206, c362e65 and 0319b42: voice session, companion voice IPC/shared VoiceBar, and Escape stopping read-aloud. Codex read your report. Keep those changes. Distinguish Linux/fake-device tests from real Windows speech and real cloud verification.

Codex's local branch is `codex/character-companion`, based on your branch through a92d4cd. Its current unpushed work includes:
- A real First Light v2 character atlas, replacing the static concept image: 1536 x 2288 RGBA, 73 required cells, nine actions plus sixteen look directions, generated from one canonical cream/indigo folded-ear creature. Bundled create-pet v0.1.6 extraction/composition/validation scripts were actually run locally. The exact encoded-byte atlas and quality gates pass. Jump lift 38px, landing delta 0. Four subtle intermediate gaze directions carry explicit warnings. Art is in-review, not owner-approved. This is a first animation pass, not a claim of final cinematic quality.
- Shared CompanionPet and native PetIdentity wiring; the existing scheduler/adapter/alpha hit-testing remain the foundation. No hidden reasoning or fabricated activity drives the pet.
- App-wide Flow field / Vapor grid / Signal (ASCII) / Quiet, glass opacity and perimeter-light controls in onboarding, the rail and Character Studio. These are real working visual preferences, not AI task progress.
- CharacterStudio with nine actual animation previews, sixteen-direction preview, replay and reduced motion.
- Local native placement fix: after setBounds(), read actual Windows bounds, keep them inside the work area and rebase local pet/bubble coordinates so global feet don't shift. Windows at fractional DPI may round dimensions by 1–3 DIP. Native placement checks now pass 22/22 on the owner's machine. Do not replace this with old exact-requested-bounds assumptions when your branch is integrated.

You cannot see Codex's unpushed code in your cloud checkout. Do not claim you reviewed it or overwrite it. Don't regenerate the character, install pet packs, mark art approved or add another orb. Work on the assigned functionality and shared island surfaces; provide an integration contract for Codex's CompanionApp.

### File ownership for this assignment

You may change `src/companion/surfaces.tsx`, `src/styles/companion-bubble.css`, your `src/voice/**`, new island transition/utility components and hooks, relevant `electron/services/**`, native helpers, narrow companion IPC/backend wiring, corresponding contracts/tests/scripts and new dated reports. Keep existing APIs compatible where practical. Changes to companionWindow for new native capabilities are allowed but keep the fractional-DPI note above for integration.

Do not edit Codex-owned `src/companion/CompanionApp.tsx`, `PetIdentity.tsx`, `src/components/{App,Onboarding,Settings,Companion,CompanionPet,CharacterStudio,ExperienceEffects,CompanionField}.tsx`, `src/styles/{tokens,island,pet,character-studio,experience-effects}.css` or the generated art pack. Export components/hooks and show the exact minimal integration diff Codex should apply. Changes to shared surfaces are encouraged; they are already used in the native app and board. No main merge, credential reads, billing changes, paid API loops, global installs or additional agents. Keep the existing PR/review branch workflow from your session.

## Deliverable A — living island and motion system

Implement a reusable production island shell and state transitions, using actual event props and the existing shared surfaces. Preserve the character as the visual anchor beside/above the island. States:

1. **Rest:** small pet/island; no mic, screenshot or cloud request. Does not steal focus. Mouse can reach the desktop through transparent gaps. Click or shortcut invokes; explicit drag moves it. Keyboard alternatives for placement remain.
2. **Invoked:** compact command capsule expands from its real anchor; caret receives focus once. Current target window and selected context are visible, removable chips. Primary action is obvious: type, Talk, select screen region. Utility access is a labelled button with a keyboard alternative, not an undiscoverable wheel gesture alone.
3. **Listening/transcribing:** actual VoiceSession phase and actual input meter, elapsed duration and Cancel. No fake waveform when the mic is idle; review transcript before sending. Stop closes the real track. Voice access should be one discoverable preference with an explicit native policy; renderer localStorage is not permission authority.
4. **Thinking/acting:** show the real named operation and step events. Distinguish sending, model waiting, tool execution, awaiting native confirmation and result verification. Cancel remains visible and operable. Do not show invented progress percentages or chain of thought.
5. **Confirmation:** a concise in-island summary plus the existing trusted native confirmation, bound to the exact operation/target. The decorative UI cannot approve its own request.
6. **Answer/receipt:** a short readable answer, sources/context, verified changes and Undo only where supported. Say “typed, not read back” when that is the actual guarantee. Do not turn any fulfilled model request into a success celebration if no change was verified.
7. **Error/recovery:** plain explanation, preserved draft/context if safe, Retry and Cancel/back. No endless spinner. Offline/unavailable/provider limits must be distinct.
8. **Collapse:** return continuously to the same anchor; keep the shell mounted until the leave animation ends, then shrink native bounds and release focus. Avoid clipping the exit by immediately resizing the OS window. Reduced-motion path can settle immediately.

Motion contract:
- One coherent set of timing/easing/material tokens. Suggested starting points, to tune visually: press 90–120ms, control hover 140–180ms, content crossfade 120–180ms, island expand 320–420ms, collapse 220–280ms. Avoid spring wobble that shakes text.
- Preserve geometric continuity on rapid open/close/state changes. An interrupted transition starts from the current visual position. No forced full React remount for every token or progress event. No repeated autofocus or focus loss.
- Animate the shell and reveal inner content separately; text remains crisp, not stretched with a scaled panel. Measure content before requesting native bounds, reserve space during transitions and keep pet feet stable.
- Border light traces the island during actual work, settles after a verified change, and stops on cancel/error. Rest can have very quiet ambient light. Hover/focus lighting follows the control; decorative layers are pointer-events:none.
- Native transparent acrylic/mica support is tested separately from CSS blur. Check supported Windows build, high contrast, reduced transparency and solid smoked fallback. A requested material is not proof of successful desktop blur.
- Pause hidden/minimized motion. Respect reduced motion and OS preferences. Avoid full-window expensive blur/backdrop filters multiplying each other.

Add a review journey using the **same production shell**, over original light/dark/busy mock desktops. Label scripted states as previews. Show rest → command → context → work → confirmation → result → collapse and interruption/reversal. This board is evidence, not a substitute for native integration.

## Deliverable B — useful computer capabilities, end to end

Audit the current implementation first, then extend it. Your current agent-tools expose saved search/read, create_task and selected-app typing; do not assume arbitrary click/scroll/browser control already exists. Keep a dated table: implemented+tested, partial, demonstration, missing. Cite entry points and actual test environment.

Prioritize these complete journeys:

**1. Ask about a selected screen region.** Shortcut → explicit region selection → visible crop preview/removal → ask → Claude image input → grounded answer → discard context. Cancellation, expiry, single-use tokens, DPI mapping and monitor bounds must remain correct. Never capture at startup or attach the whole display silently. Content from screenshots is untrusted data, not tool authorization. Extend to a chosen window only if this same explicit flow is preserved.

**2. Work in the current app.** Preserve the HWND/PID/process target captured before the companion takes focus. Draft text, preview exact action, obtain trusted confirmation, focus/revalidate the same target, execute, then verify what can actually be verified. User focus changes, window reuse, elevated apps, password fields, hidden/minimized surfaces and partial native input must fail safely and report accurately. Cancellation must prevent later queued input, not just hide the UI.

After typing is solid, add a bounded Windows semantic-control slice for one supported test app: inspect a selected window's accessible controls; identify a specific available control; invoke/set value/scroll using supported UI Automation patterns; re-observe and report the resulting state. Prefer semantic controls over guessed pixel coordinates. If visual coordinate fallback is implemented, validate screenshot-to-physical-pixel mapping and exact window/occlusion/foreground immediately before the action. Keep a bounded tool inventory and validated schemas; no generic shell/PowerShell command runner supplied by Claude. Sensitive or unsupported surfaces stop with a reason. Never claim arbitrary-app reliability based on one fixture.

**3. Speak → review → insert.** Use your real voice session. Record deliberately, stop/cancel, transcribe through the supported configured backend, review/edit text, then insert through the same approved-target path. Do not invent cloud speech for Claude: Anthropic text/vision access is not automatically speech recognition or speech generation. Keep supported Windows voice with explicit availability; add an external speech provider only as a separately configured integration, without silent fallback or new API spend here.

**4. Retrieve and transform saved information.** Ask naturally, search actual allowed saved notes/tasks/capsules, cite returned IDs, open the source, draft an answer/document, then save or create a task only after the existing confirmation. No fake memory or claims to have searched unapproved folders. Connect existing file-search services only within user-approved roots and bounded results.

**5. Run a routine with a receipt.** Reuse the existing routine engine/policy rather than creating an unguarded parallel executor. Preview its actual steps/targets, approve through the existing native policy, run, cancel, show per-step results/partial failures and Undo where implemented. Show an honest unavailable state if a step needs missing setup. Do not silently enable unattended schedules.

Extend the utility tray with the smallest complete existing capabilities: today's tasks, recent notes, saved routines, clipboard when the person has explicitly enabled it, approved app launch and connection shortcuts. Each tile must open useful data or perform a supported workflow. Music/Spotify/calendar/email should show a configured connector's real state; otherwise show Connect with an honest setup explanation, not sample account data. Each person signs into their own account; a developer app registration and OAuth implementation are separate from having a consumer account. Don't imply a chat subscription provides API access.

## Deliverable C — coherent experience and quality gate

- Keep Claude as primary BYOK; existing OpenAI/Gemini support only where truly implemented. Keys remain in native credential protection, never prompts, browser storage, screenshots or logs. Default utilities remain local; cloud context goes only after an explicit task send.
- Keep the current distinctive self-hosted typography where practical; use expressive display type and readable sentence-case body labels. Don't replace everything with Inter, uppercase tracking and random sci-fi symbols. No unreadable tiny type or glowing paragraph text.
- Codex owns atmosphere presets and the pet. Your island should match smoked indigo glass, pale cyan/violet light and warm character contrast. Avoid a separate unrelated design system.
- Add keyboard reachability, clear focus, Escape/cancel, labels for icon controls, target removal, meaningful disabled reasons and error recovery. Pointer effects cannot intercept clicks.
- Validate at 1280x720 and a larger laptop viewport. The first useful controls and companion must fit without an empty full-height hero. Keep the workspace secondary and reduce route clutter.
- Measure interaction responsiveness and frame behavior; target smooth shell motion on the owner's laptop, but do not report measured 60fps from screenshots. Record test setup and observed frame data. No whole-image bobbing as a substitute for actual character poses. Codex's initial 192x208-cell atlas is a review pass; a future higher-resolution rig/baked animation may be needed for large character previews. Do not smear frames together to claim higher-quality animation.

## Execution and evidence

Start with a brief source audit, then implement and test the next complete slice immediately. Continue through these deliverables within the session; don't stop after another aesthetic plan. Make reviewable commits, retaining the session's established PR workflow, without merging main. For each milestone report:
1. Concrete changed behavior and relevant paths.
2. Screenshot/video from the actual built components, with scripted preview vs native operation clearly identified.
3. Tests run and exact failures, distinguishing baseline from newly introduced failures by name.
4. Integration exports and a minimal CompanionApp patch for Codex; do not edit that owned file.
5. Remaining gaps and environment-dependent checks. Do not mark untested Windows/live-provider/OAuth/signing work complete.

Acceptance: the same companion performs selected-screen explanation, selected-app reviewed typing and saved-information retrieval without requiring dashboard navigation; the voice and routine journeys follow with truthful capabilities. The island expands/collapses without clipping, focus theft or shifting the pet; every action is cancellable and every reported success has corresponding evidence. Run typecheck, production build, targeted lifecycle/security/race tests, existing smoke and native placement check. Use stubs/fake audio only when clearly labelled; no payments or live API spend for these tests.

Finish with a short status based on completed journeys, not a fabricated overall percentage. The result should feel carefully authored and delightful because motion, character, material and reliable action are designed together.
