# Latest owner direction: the computer's soul

16 October 2026, after the first revamp handoff. **This supersedes the Porcelain/Ink art direction and the offline/local-model-first AI onboarding in REVAMP-BRIEF.md.** Keep the useful navigation, data, shared-avatar, workflow verification and native-security work. Do not restart the design from an empty repository or discard working feature logic.

## Design read

An original cinematic cyberpunk Windows companion that feels like a living machine intelligence. The owner explicitly requests extreme visual character, very smooth motion graphics, interactive components and distinctive typography across the entire app. This is not a calm productivity dashboard. DESIGN_VARIANCE 9, MOTION_INTENSITY 8, VISUAL_DENSITY 5. The numbers guide design judgment, not measured quality scores.

### One coherent futuristic language

- Obsidian/graphite architectural surfaces, electric cyan as the primary energy, ultraviolet depth, scarce acid-lime/amber signals. Example starting tokens: background #080B10, surface #101720, elevated #17212D, text #E6F4F7, muted #A1B3BF, energy #63E8FF, secondary #A998FF. Validate actual contrast. Glow is light around an object, not a blur applied to reading text.
- Technical geometry with controlled cut corners, disciplined panel framing, asymmetric focal composition and precise separators. Use a few identifiable motifs repeatedly so shell, dialogs, fields, lists, charts, provider setup and avatar studio belong to one world. Avoid random neon borders around every rectangle and fake terminal output.
- The companion is a signature refractive/plasma core, with convincing internal structure, depth, surface lighting and a strong silhouette even at small sizes. Give presets an original consistent art direction. Do not replace the old robot with a flat gradient disc and call it finished.
- Distinctive locally bundled licensed type. Evaluate Oxanium or Chakra Petch for display/navigation, Rajdhani or another expressive readable interface face for body, IBM Plex Mono for sparse real metadata. Choose a coherent family pairing, verify license and bundle it. Avoid default Inter/Geist/Segoe presentation. Keep body readable at laptop resolution and Windows scaling; futuristic cannot mean illegible.
- A complete theme: onboarding, Today, Assistant, Workspace, Memory, Automations, Studio, account connections, Settings, tooltips, dialogs, focus, empty/loading/error states and browser-preview notice. Do not leave secondary pages in the rejected Porcelain look. A lighter accessible variant may use the same geometry/type/energy; the principal experience is dark cyberpunk, not system-driven cream.

### Motion and interaction system

Use a consistent sense of mass, depth and continuity: fluid active navigation, a responsive command surface, an expanding voice dock, material core state changes, contextual panel choreography, direct-manipulation Studio previews and meaningful transition graphics. Buttons respond to hover/press/focus; selection and save states are perceptible. Menus retain stable hit targets. Avoid generic equal cards with identical entrance animations.

Suggested rhythm: immediate control response with 100–160ms settling; panel/modal choreography 180–300ms; bounded scene/companion transitions up to 400ms without blocking input. Use one coordinated animation approach, compositor-friendly transforms and isolated shader/canvas rendering. Do not bolt on several competing libraries. Cancel superseded transitions; clean up frames/listeners.

Orb/audio/particle behavior follows real idle/listening/transcribing/working/speaking/error events. A simulation is allowed only in labelled Studio preview controls. No fake activity, invented token counts or hidden reasoning. No forced startup cinematic, text scramble on every label, cursor takeover, scroll hijacking or unavoidable flashing. The app can be extraordinary and still let the user read, type, copy and focus normally.

Maintain reduced motion, visible accessible state labels, static/low-power fallback, hidden-window pause, bounded DPR/particle density and readable contrast. Benchmark the actual frame consistency and idle cost on available hardware; never claim extreme smoothness from a screenshot. Aim for stable display-rate animation on supported hardware and report measured limits honestly.

## Claude API first; no local-model product requirement

The owner now explicitly wants API-powered AI. **Claude/Anthropic is primary for this release.** OpenAI and Gemini are optional subsequent provider paths; preserve existing OpenAI/OpenRouter capability where it already works. No need to install, download or promote Ollama/local model weights. Remove local model endpoint/name/download setup from the normal first-run and Assistant path. Retain old data/preferences compatibly rather than destructively deleting existing users' configuration.

AI onboarding: choose Anthropic by default → masked BYOK field backed by existing native protected vault → supported model selection → explicit connection/test action with possible usage disclosed → real streaming conversation, cancel/retry and clear errors. Model IDs must come from verified supported configuration/provider availability, not guessed marketing names. The development key is not automatically the product's key. Never fetch it from Control Room or paste a secret into source/chat.

Files/settings remain local. AI requests use cloud APIs and the UI must say so. The prior offline-only AI requirement is superseded; data minimization, selected-context disclosure, secure key storage and native action consent are not. With no key or no connection, ordinary local notes/tasks can remain available, but do not imply offline chat works. No automatic network requests merely from opening the app or changing a theme.

Every AI feature shown as working must invoke the real selected provider through the protected service and have sensible loading/error/cancel behavior. Do not label a generated prompt preview as completed AI work. Voice transcription and image/video/voice generation may require separate capabilities: don't imply a Claude text key supplies every modality. ChatGPT consumer login/subscription is not an OpenAI API credential. Each integration remains per-user and truthful about its actual connection type.

## Immediate execution

1. Preserve existing successful shell, grouping, shared-avatar and workflow refactors.
2. Rework tokens, typography, primitives, orb/materials and the shell/Today/Assistant/Studio into this art direction before propagating it further. Capture and inspect actual screenshots and a motion interaction sequence, with empty/populated/blocked states.
3. Apply the coherent system to every remaining page; remove Ollama-first onboarding and the assistant's local-model recovery copy from normal flows.
4. Complete journey checks and native security regression checks from the original brief. Keep a reviewable branch and evidence-based result document. No automatic merge.

Use the references already reviewed: Hitodama for presence/workflow clarity, Space UI for stateful companion interaction, Glass Portfolio for material study, Unicorn for isolated shader craft, Zajno for continuity, and Planes/Skecher for component inspiration. Create original code; licensing/source restrictions remain in force.

The owner change does not authorize restarting the old paid API loops, purchasing assets, changing billing, activating extra usage credits, reading credentials/private runtime or bypassing trusted action confirmations. Work in the existing Claude Code session.
