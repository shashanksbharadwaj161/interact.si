# Future desktop companion: design and implementation handoff

> Saved verbatim from the owner's message of 16 October 2026 so the context survives across sessions. The three attached images (a Hitodama homepage capture, a Hitodama workflows capture and a historical reference contact sheet) were public website captures given as observed visual evidence; they are not stored in this repository because they contain third-party branding and imagery.

Prepared 16 October 2026. OWNER AUTHORIZED IMPLEMENTATION NOW. This message releases the previous hold. No new product name selected.

## Design read

A Windows computer-use companion for a design-conscious personal user: expressive futuristic glass, living motion, vaporwave atmosphere and original digital identity. Desktop interaction is primary; expanded workspace is secondary. Design variance 9, motion intensity 8 during interaction, visual density 3 in companion / 5 in workspace. Quiet idle behavior is essential to making dramatic moments effective.

This extends the previously prepared HITODAMA-DEEP-STUDY.md and GLASS-AND-COMPUTER-USE.md. It preserves the original six product layers: desktop companion, computer use, voice/conversation, connected abilities, full workspace, customization studio. Claude API is primary; local model setup is out of the main journey. Future provider adapters may support OpenAI and Gemini.

## Fresh reference evidence and interpretation

All three owner links opened on 16 October in the browser. These are design presentations/collections, not installed applications. Collections change over time. We did not audit every linked shot or verify native behavior from a mockup.

1. https://dribbble.com/shots/27809089-Nivo-Personal-Finance-Dashboard-UI-Design
   - Live browser page and composition inspected; Play was clicked and frames sampled. Full animation timing was not measured. Web text fetch failed, browser worked.
   - Dipa Inhouse describes a finance dashboard; observed dark inset panels, violet atmosphere, fine edges, compact rounded navigation, strong numerical hierarchy, segmented gauge, pixel-like chart and dimensional card presentation.
   - Take: layered material, local pools of light, deliberate tonal separation, consistent border treatment. Apply to companion and workspace surfaces.
   - Do not copy its asset files, card metrics, branding or finance dashboard structure. This reference does not prove native translucent windows.
2. https://dribbble.com/search/cyberpunk
   - Live collection inspected. Visible examples include monochrome military UI, graphic black/white/red layouts and illustrated cyberpunk imagery. Cyberpunk is a broad family, not one component library.
   - Take: distinctive silhouettes, controlled contrast, precision linework and display lettering. Avoid turning the everyday assistant into a military instrument panel or illegible HUD.
3. https://dribbble.com/shots/popular/animation
   - Live collection inspected. Glass finance panels, dimensional product imagery and assistant/character examples appear among unrelated work. Browser and search snapshots returned different ordering; no ranking claims.
   - Relevant discovered detail: https://dribbble.com/shots/27813650-Voice-Assistant-all-state by Lalit for theosm. Its collection preview shows a horizontal luminous form. Detail page opened but main media remained loading at the sampled moment; no claim its full state sequence was watched.
   - https://dribbble.com/shots/27812511-AI-Agent by Fraser Davidson for Cub Studio: metadata/text inspected only; not a completed visual animation audit.
   - Take: define a recognizable identity across states, stage transitions intentionally. Do not treat uploaded motion clips as working UI behavior.

Prior Hitodama study already covers its public website, official demo/setup transcripts and sampled video frames, plus static REA analysis. Its useful model is presence in the desktop and contextual outcomes. Its proprietary native internals remain unknown. Do not rerun REA or copy third-party assets simply to recreate an effect we can author originally.

## One visual system

Working art-direction description: luminous smoked glass with a living digital core. This is not the app name.

### Material stack

1. Real desktop backdrop when supported; native Windows material verified separately.
2. Smoked shell with adjustable tint and opacity; starting design tokens: ink #080B12, raised ink #141B28, primary text #F2F5FA, muted text #B2BDCF.
3. Fine neutral edge and directional reflection; cyan #72E9F2 as interaction accent, violet #A88BFF as atmosphere. Optional magenta in vaporwave theme. Amber/red reserved for corresponding real states.
4. Content zones with higher opacity, sharp text and stable contrast on bright/busy wallpapers.
5. Local light bloom outside surfaces, never over reading text or precise controls.

Tokens are proposed, not contrast-certified. Validate actual composited backgrounds. Neutral gray, silver and near-black carry most area; accent concentration gives the light impact. Shape family: continuous capsule for companion, rounded rectangle for expanded surfaces, modest consistent control radii. Avoid arbitrary clipped corners on every component.

### Effects and where they belong

| Effect | Intended use | Implementation boundary |
|---|---|---|
| Edge lighting | Companion/window perimeter; focused and active controls | One controlled light trace with text/icon state equivalents; no constant rainbow on every button |
| Flow field | Living core, active thought/voice identity, Studio preview | Original particle/vector-field renderer; shared scheduler; real state input; no invented progress |
| Vaporwave perspective grid | Optional immersive Studio/background theme and brief invocation atmosphere | Low contrast, away from reading surfaces; never a compulsory full-desktop overlay |
| ASCII animation | Alternate companion skin and optional creative/technical visualization | Canvas glyph atlas or bounded text rendering; accessible state outside canvas; decorative data clearly decorative |
| Glass/refraction | Island, command surface, result tray, expanded workspace | Mild highlights, readable content; avoid heavy distortion of text |
| Spatial transitions | Island expands into conversation/context/results | Preserve anchor, focus and conversation; interruptible transitions, stable hit targets |

All effects belong to the same palette, spatial scale and state model. Default Flow core; Vapor grid and ASCII are selectable expressions rather than simultaneous competing backgrounds. Owner can increase intensity or disable individual effects.

Typography: retain and assess locally bundled Chakra Petch, Saira and IBM Plex Mono before adding dependencies. Use expressive display face for short identity/headings, readable body for conversation, mono for ASCII and real technical details. Evaluate at 14–16px and Windows scaling. Do not use all-uppercase technical microtext as the main navigation language. One consistent icon family. Original companion geometry, no stock robot head.

## Interaction storyboard

Resting -> invoked -> typing/listening -> context selected -> preparing -> acting or awaiting confirmation -> verifying -> result -> resting.

Error, cancelled, disconnected and permission denied are first-class states. Do not show listening before microphone acquisition or speaking before playback. A thinking animation means a real pending request, not access to hidden reasoning. Completion requires verified outcome; a successful tool invocation alone may not prove it.

Starting motion targets, to tune on device: control response 120–180ms; panel/content transition 180–260ms; island expansion 300–450ms; completion trace 400–650ms. Interrupt/reverse on user input; no deliberate waiting for a flourish. Audio-reactive amplitude uses actual signal when available. Reduced motion retains state through static shape/text/color and instant or short fades.

Companion has one obvious input, voice toggle, context chooser and visible stop while working. Results stay near the current work. Open Workspace preserves the active session. Returning to the island keeps continuity. Invocation shortcut configurable and checked for conflicts. Do not capture or upload the desktop continuously by default.

## Five journeys and evidence of success

1. Ask about a selected region: invoke, select/crop, preview what will be sent, ask, receive grounded answer, dismiss. No stale context reused silently.
2. Act in an open app: state goal, disclose target/action, execute supported operation, verify target/result, expose stop and actual failure. First demo should use a harmless reversible task in a test document.
3. Dictate into a chosen field: acquire mic, show recording state, transcribe, preview or insert as configured, preserve target focus. Speech input/output need separate compatible implementations; Claude text API alone is not a complete voice engine.
4. Find saved information: retrieve a real note/file with source, open it or insert an approved excerpt. No decorative search results.
5. Run a routine: show actual steps, scope and confirmation boundaries, execute, report outcomes and partial failures.

First native milestone: journeys 1, 2 and 4 end to end. Voice and routines follow using the same contracts. This sequencing does not remove promised feature areas.

## Build on existing code

Before edits, fetch/inspect latest Claude branch and preserve its uncommitted prototype work. The previous reviewed revision was b3fe7f6; newer prototype/fixes were reported but not locally verified. Do not rebuild blindly or overwrite either working tree.

Keep verified vault, native security, persistence, useful service contracts, bundled fonts, shared orb renderer and viable appearance settings. Inventory every existing feature as working / partial / demo / missing with file paths and a reproduced user journey. Existing route coverage is not usability evidence.

Known gaps at the earlier reviewed revision: normal large window; empty screen-context collection; text-only cloud messages without a complete native tool execution cycle. Reverify these before changing them. The new companion must expose actual capability states; available in native, preview-only and unavailable are distinct.

Proposed boundaries: native companion window + workspace window; typed session state shared by approved IPC; provider adapter; context broker; action executor and result verifier; independent material/motion components. Keep raw keys in native vault, schemas/allowlists at IPC boundaries, untrusted page/document instructions as data, tool permissions scoped to the current task. No unrestricted shell access from renderer/model. Confirm consequential sends/deletes/purchases and support per-user OAuth connections/revocation.

Native glass research: https://www.electronjs.org/docs/latest/api/base-window documents transparent frameless Windows surfaces and background material APIs. Check the installed Electron version and actual OS support before selection. https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/backdrop-filter describes renderer backdrop filtering; CSS blur alone does not establish real Windows desktop blur. Do not reduce whole-window opacity and fade text with it. Test native backdrop and transparent shapes together, with solid fallback.

## Delivery order and gates

A. Capability audit and code preservation. Produce the above status inventory; select existing reusable paths.
B. Original isolated experience prototype: island, input, context chooser, task/confirmation, result, Studio and workspace transition. Mock actions labelled. Compare light/dark/busy desktops at 1280x720 and compact widths. Show motion as a recording or live preview, not screenshots alone.
C. Native companion slice: secure window, drag/docking, focus restoration, multi-monitor/DPI placement, taskbar/tray behavior, native material/fallback and actual Claude selected-context/action path.
D. Connect existing real features through the companion; preserve deep workspace routes for detailed work. Add voice and user-specific account connections deliberately.
E. Installed build verification: fresh setup, vault persistence, restart, cancellation, invalid key, rate limit, no network, unsupported action, denied permission, screen selection and data deletion. Never mark demo providers or placeholder controls complete.

Performance acceptance is measured, not promised: aim for smooth 60Hz interaction on the test laptop; log frame pacing and resource impact. Cap rendering resolution/particles, avoid React state updates each animation frame, pause hidden/minimized effects, avoid duplicate active canvas loops, provide lower-power/static modes. No fixed claim about CPU/GPU savings without measurement. Test motion/transparency preferences, keyboard-only navigation, contrast, 100/125/150/200% scaling and task completion without navigating a dashboard.

The owner reviews the cohesive prototype before another broad restyle. Engineering may proceed on reusable secure foundations, but do not call visual direction approved solely because screenshots exist. No total-completion percentage without a defined weighted acceptance inventory. Report actual working journeys, limitations and evidence.

## Implementation instruction — authorized now

Read this document and the prior Hitodama deep study and glass clarification. Preserve current prototype work and reusable native foundations. Build an original futuristic Windows companion: desktop presence and real computer-use loop first, expanded hub second. Unify smoked native glass, edge light, a flow-field core, optional vaporwave grid and ASCII skin through one stateful material/motion system. Keep the existing app's useful capabilities and integrate them through contextual journeys. Start with an audited capability inventory and a coherent isolated prototype, then deliver selected-screen Q&A, one reversible app action and real saved-information retrieval in the installed native application. Demonstrate failures/cancellation as well as success. Label simulated states. Use the acceptance gates above, preserve credential/security boundaries, and report evidence honestly. Do not activate paid API loops, extra usage, purchases, automatic merges or unrelated account actions. The owner has now authorized dispatch and implementation. Begin now.

## Current owner request and delivery contract

The owner explicitly asks you to start working NOW on the UI changes AND features/computer use previously discussed. This is a continuation of interact.si, not a new app or wholesale deletion. Do not name the product Jarvis; retain internal paths only where migration would be unnecessary. Preserve your existing uncommitted prototype and fixes. Read this full brief before continuing. Save it as planning/ui-revamp/FUTURE-COMPANION-PLAN.md on your working branch so the context survives. Commit reviewable changes to your branch/PR, not main. No purchases, extra credits, revived paid loops, or permission-setting changes. You may work using current ordinary Claude Code access.

Attached images: reference-hitodama-top.png and reference-hitodama-workflows.png are public website captures, not native app screenshots. reference-contact-sheet.jpg is a historical labelled collection of public references; some captures have loading/fallback content. Use them as observed visual evidence, not executable specs or licensed reusable assets. Read prior planning/ui-revamp/REFERENCE-REVIEW.md for capture limitations. Visit the exact links and inspect rendered visuals where possible; do not invent observations when access fails. The owner wants original quality, not copied branding or borrowed commercial assets.

Additional directly observed Nivo image reference, from the live shot page: https://cdn.dribbble.com/userupload/49315580/file/9436026a5d64fa80ea3e1e369e09bfa9.png?resize=752x&vertical=center . Open this image as well as the Nivo shot URL; do not claim seen if unable to load.

## Product scope to preserve and progressively integrate

- Floating companion/island, contextual conversation and expandable workspace, one shared session and original customizable avatar. States visible through meaningful shape, motion and light.
- Actual selected-screen Q&A and computer use: scoped screen region/window capture, cloud image input where provider supports it, typed tool calls/results, supported native operations, result verification, interrupt/stop, focus restoration. Never confuse a permission toggle with implemented context capture, or a generated instruction with executed action.
- Voice: dictation, voice conversation, speech playback, personality and voice settings. Audit existing implementation and verify provider capabilities before promising live full-duplex voice. Keep typed control usable throughout.
- Existing notes/files/search/memory/clipboard/capsules/workspace/routines/automation features: enumerate actual routes/services and preserve working data. Context-aware recall cites the actual item. Routine execution reports per-step outcomes.
- Account integrations: each user connects their own Spotify, Google/Gmail/Calendar and future accounts; explicit scopes, independent token storage, revocation and connection state. OAuth registrations/redirect URIs/verification may require owner input. A Spotify personal account alone is not a developer registration. Implement adapters and honest setup states; never mark fake connections live. No sending mail or mutating real accounts for testing without explicit scoped approval.
- Claude BYOK primary, secure native key entry/test/delete, provider/model availability checked, truthful token/cost estimates. Optional future OpenAI/Gemini adapters. No local model download/setup in the main journey. Product cloud calls must be intentional and clearly disclosed; basic local utilities remain useful without a key.
- Appearance/studio: full material/lighting/motion controls and original companion/avatar modes, not only the old robot. Voice, personality, visual identity and abilities separately configurable; sensible presets plus live previews.
- Research/creation features discussed earlier (avatar creation, motion/video tooling, usage visibility, Windows customization, browser integration): inventory in backlog against actual existing code. Do not silently drop them, bulk-install every repo, or pretend a reference catalogue implements a feature. Securely integrate only justified licensed components.
- Onboarding/settings/help/error recovery are part of the app. Explain preview-only limitations in browser. First run connects provider, chooses invocation/appearance, then completes a real useful task.

## Reference library and purpose

Primary experience: https://hitodama.in/ ; requirements https://hitodama.in/requirements/ ; privacy https://hitodama.in/legal/privacy/ ; official demos https://www.youtube.com/watch?v=bei_Cc8-CBw and https://www.youtube.com/watch?v=A5DDHzeqnhw . Read HITODAMA-DEEP-STUDY.md for existing REA findings instead of pretending the public website reveals proprietary native internals.

Material/motion: https://dribbble.com/shots/27809089-Nivo-Personal-Finance-Dashboard-UI-Design ; https://dribbble.com/search/cyberpunk ; https://dribbble.com/shots/popular/animation ; https://www.unicorn.studio/ ; https://motion.zajno.com/ ; https://basement.studio/showcase#list ; https://www.supaste.com/ ; https://threeui.com/css/animated-top-dock ; https://threeui.com/buttons/liquid-metal-button ; https://21st.dev/@larsen66/templates/glass-portfolio ; https://21st.dev/@larsen66/templates/aura-svelte-gsap ; https://21st.dev/community/components/s/orb .

Spatial/motion inspiration: https://horizonx.so/explore/orvane-particle-hero ; https://horizonx.so/explore/digital-wave-field-hero ; https://horizonx.so/explore/halovane ; https://horizonx.so/explore/kreivo ; https://horizonx.so/explore/gsap-scroll-motion-lab ; https://horizonx.so/explore/arq-01-carry-the-horizon ; https://horizonx.so/explore/kiln-studio-landing ; https://horizonx.so/explore/immersive-robotics-landing ; https://threeui.com/landing-pages/sublevel-studio-landing-page ; https://scrollzoomreveal.framer.website/ ; https://www.framer.com/marketplace/components/dna-carousel/ ; https://www.navbar.gallery/ . NOVARA was rejected; do not resurrect its direction. Space UI/Skecher/Planes possible matches https://www.spaceui.one/ https://skecher-ui.com/ https://useplanes.com/ were never explicitly confirmed; treat as tentative references.

Source candidates already discussed: https://github.com/morluto/rea (research tool); https://github.com/robinebers/openusage (usage UX inspiration, Swift/macOS not Windows drop-in); https://github.com/smontlouis/bible-strong-avatar-lab (AGPL, no unexamined copying); https://github.com/topics/ai-avatars (catalogue); https://github.com/yihui-dev/awesome-opus5-5-videos (reference index, not generation backend); https://github.com/Meridiona/meridian ; https://github.com/topics/windhawk-mods ; https://github.com/ramensoftware ; https://github.com/zachlatta/freeflow ; https://github.com/AbhishekBarali/SpeakoFlow . Audit licenses, platform fit and actual capabilities before adoption.

Use applicable installed taste/UI/UX/motion/Karpathy skills if actually available. State which were read; do not invent installed skills. Existing design-taste guidance is contextual: this is an interactive desktop product, not a marketing landing page. The user's explicit glass/cyberpunk/vaporwave direction overrides generic style prohibitions.

## Work and validation instructions

Start with a short concrete implementation checklist, then implement; do not stop after another plan. Complete the coherent visual prototype and make it reviewable. Continue independent native service/security work while awaiting visual feedback rather than endlessly restyling routes. Treat the first three working journeys as a milestone, not the entire product. Maintain a remaining-feature inventory with dependencies and acceptance evidence.

Do not ask routine style/implementation questions already settled here. Ask only for true missing credentials/registrations or a consequential unresolved product decision, and continue independent work. No credentials in chat or source. Keep tests meaningful and retain existing protections. Earlier Windows verification at b3fe7f6 was build PASS, native smoke PASS (all23 routes, no external requests), tests 1635/1636 with one CRLF-sensitive source regex failure. These are historical, not current results. Re-run appropriate checks after edits; do not claim Windows-native verification from a Linux cloud session. Provide a clear Windows QA checklist for Codex/local review.

Report exact changed paths, preview command/URL, working interactions, mock/unverified areas, test results and PR/commit. Do not call it 100% complete from route counts or claim an award-winning outcome without user review. Preserve useful existing features and actual application data.

Begin now: acknowledge the updated direction briefly and continue implementation in your existing branch.
