# Hitodama: product-experience study and correction

16 October 2026. The user rejected the cyberpunk review build too and requested deeper study of Hitodama, its videos and REA analysis. The earlier visual briefs did not sufficiently address the product's form factor. Preserve useful code from PR #1, but do not treat that PR as user-accepted design.

## Investigation and evidence

Opened the live homepage, individual feature sections, Requirements and Privacy in the browser. Inspected the six feature-preview controls and the island/customization scenes. Located the creator's Videos and Shorts tabs rather than treating unrelated search results as product demos. Reviewed both official videos' available timecoded transcripts and sampled playback frames; this is not an uninterrupted real-time watch of every frame, nor a hands-on installed Hitodama test.

Primary sources:

- [Homepage and demonstrations](https://hitodama.in/)
- [Official setup, 4:17](https://www.youtube.com/watch?v=bei_Cc8-CBw), published 7 October 2026.
- [Official desktop demonstration, 1:59](https://www.youtube.com/watch?v=A5DDHzeqnhw), published 11 October 2026; also listed as a Short on the creator's channel.
- [Requirements](https://hitodama.in/requirements/)
- [Privacy](https://hitodama.in/legal/privacy/), displayed update 14 October 2026.
- [REA](https://github.com/morluto/rea), installed local npm version 6.4.0.

Search/text fetch failed for some pages that loaded normally in the browser. This report relies on the browser observations for those pages. No purchases, account sign-ins, proprietary application download or installation, API-key use or paid model requests were performed. Competitor source/assets are not included in this repository.

## What the public product demonstrates

### Desktop presence and coherent interaction

The homepage's product scenes present a small companion/island over the existing Windows desktop. Feedback appears near the current task rather than requiring a full workspace change. The island reveals utilities such as music, plans, clipboard, applications and wallpapers. Screen-region questions, dictation and scheduled actions are demonstrated as short journeys. A customization scene connects the companion to four labelled choices: voice, personality, appearance and abilities. These are rendered marketing scenes, not independent proof of native implementation.

The visual attraction is not simply a blue glow: a persistent recognizable presence, fluid changes of size/state, a relationship with the desktop behind it, readable contextual feedback and a coherent personality. The website itself uses warm light surfaces and editorial typography; a literal copy of its landing page would not produce the desktop experience.

### Official desktop video: what is actually shown

Timecoded transcript and sampled frames show a voice-led browser journey: opening Google Earth (roughly 0:11–0:17), typing into a selected search field (0:21–0:30), discussing the visible location and bird (0:35–0:58), changing location (around 1:12), and opening Netflix (1:48–1:56). The small companion stays associated with the ongoing desktop activity. The example personality is deliberately cheeky; our default personality need not copy that tone.

This demonstrates the creator's intended experience. It does not prove unattended reliability, unedited latency, general-purpose vision accuracy, OAuth access to those services, or access to their private APIs. Opening Netflix is not a Netflix account integration.

### Setup video

The setup guide shows obtaining a Gemini key and entering it into the app, then describes an optional Tavily key for research. Relevant sections: API acquisition around 1:45, paste/save around 2:18–2:20, research provider around 2:23–3:07. This supports a short guided first-success flow rather than forcing users to navigate a model-management dashboard. Do not inherit its free-service claims: our primary provider is Anthropic, with its own billing and capabilities. No creator key or account detail is copied into this research.

### Published operational boundaries

Requirements describes a Windows 10/11, internet-connected, voice-first app with Gemini Live for understanding/speech and native local tool execution. Some utilities remain useful without AI. It explicitly acknowledges protected Windows surfaces, browser accessibility limitations, and risky tools being disabled initially. These are publisher statements, not our installed-app findings.

Privacy describes protected local keys and local memory/history/settings, while speech, conversation context, selected screenshots and research material can reach its model provider. It lists editable memory, optional clipboard/app activity/usage records, optional weather, research services and licence checks. This is useful evidence for feature discovery and data-flow design, not permission to reproduce its telemetry/licensing strategy or automatically upload the user's desktop. Keep our explicit context selection and native action protections.

## REA: actually executed, scoped evidence

Codex read REA's installed reverse-engineer-anything skill and JavaScript application guide, then invoked its existing local CLI for static analysis. No extra global installation or REA browser automation was used.

Input: four freshly fetched same-origin scripts whose exact URLs were observed in the live page DOM, plus the retained public homepage bundle from the 15 October capture. The retained bundle is historical, not falsely labelled a fresh download. Total: five files, 282,331 text bytes.

- Evidence ID: `ev_157b2f98213192618721446f646dc211efc259f197550b8d879d28c7a41755a9`.
- Artifact SHA-256: `6bd08786f94d25b5c8a1597b5e93ba7ff52a1b6c91549aa9d3c771f75b66aa3a`.
- REA reports 83 recovered modules, 177 findings, five parsed JavaScript files, zero parse failures.
- Semantic graph is explicitly partial: its 100,000-node ceiling was reached. Missing/dynamic relationships remain unknown.
- Raw local evidence: `work/hitodama-deep/rea-evidence.json`; acquisition provenance/digests: `work/hitodama-deep/acquisition.json`. Raw third-party code/evidence stays out of Git.

DOM observations show Canvas-based scene renderers, including hero/island, lasso, dictation and loadout. Static inspection of the retained bundle corroborates named scene modules, animation-frame loops, intersection observers and reduced-motion branches. It establishes implementation techniques in the public website, not the paid Windows application's architecture. We cannot infer its native tool executor, authentication, model orchestration or OAuth implementation from this capture. REA did not run competitor JavaScript, recover private source or inspect a proprietary binary.

## Actual gaps in our current PR

Source checked at PR #1 commit `b3fe7f6`, separately from competitor research:

1. `jarvis-desktop/electron/main.ts:createWindow` creates a standard 1180×780 main window (minimum 720×520). There is no implemented compact transparent desktop companion window in this entry point. A sidebar orb is not equivalent to desktop presence.
2. `src/components/Assistant.tsx` explicitly uses an empty captured-context list and describes its screen/app/clipboard controls as settings only. It does not actually attach screen context there.
3. `electron/services/cloud.ts` sends messages with string content. The current Anthropic request shown there has text messages, streaming and a token limit, not a complete screenshot/tool-use execution loop.
4. Voice is currently clip-based/basic Windows recognition with a cleanup step. That is distinct from the seamless voice interaction being demonstrated.
5. Studio improves one shared visual renderer, but the default product journey is still a full-window organizer. More HUD borders and more page transitions will not close these functional gaps.

These findings explain the mismatch; they are not an aggregate completion percentage.

## Corrected target: an ambient desktop companion with a full hub

Retain the requested original cyberpunk character and Claude-primary API direction. Change the primary interaction surface. The full hub remains for substantial work, preferences and history; it is no longer the only way to use the companion.

### Surface/state storyboard

| State | What the person sees | Interaction and proof |
|---|---|---|
| Resting presence | Small original core/island on a chosen display edge | Reposition, hide, recall by shortcut; no focus theft or microphone activity |
| Invoked | Island expands into a compact command/voice surface | Type or deliberately start talking; focus is predictable; Escape returns to previous app |
| Listening/transcribing | Clear real microphone status and immediate Stop | Measured waveform; no animation implies capture when none occurs |
| Thinking/acting | Compact progress event and interrupt control | Actual tool events, selected target/context and real failure recovery |
| Answering | Short contextual answer with optional larger view | Text always available; optional speech can be interrupted; result remains recoverable |
| Quick utilities | An expanding local utility drawer | Tasks, clipboard, launcher and actual media controls; each backed by its real bridge |
| Appearance/personality | A focused companion configuration scene | Live renderer shared with the island; voice/persona/appearance/ability settings clearly separated |
| Full workspace | Existing organizer, history, account settings and Studio | Explicit expand/open action; saved routes/data remain intact |

Use original silhouettes and interaction choreography. Do not copy Hitodama's mascot, exact loadout artwork, source or sound. Cyberpunk can be a sophisticated compact object and responsive material, without covering every screen in labels and panels. Motion should preserve perceived position and mass as the island expands and collapses, with reduced-motion/static and low-power alternatives.

### AI capabilities with a real native execution layer

Claude remains the reasoning, conversation and planning provider. Implement a small typed tool registry around existing trusted native operations; validate each tool input, return actual results, handle cancellation, retain narrow target checks and action confirmation. Anthropic's [tool execution guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls) and [computer/browser guidance](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-combinations) describe model requests as distinct from the client-side execution the app must supply. Prefer an existing narrow operation over arbitrary screen clicks.

Build screen questions as explicit capture → inspect/redact/confirm selected region → supported image input → contextual answer. Start with one-shot region capture, not unbounded screen streaming. A real overlay, DPI/multiple-monitor coordinate mapping and a provider-compatible image path are necessary; changing a permission toggle is not implementation.

Speech needs a deliberately selected input/output pipeline. Verify the actual supported provider/API before promising one-key live speech. Claude-first does not justify pretending a text-generation adapter provides speech transcription, speech output or every image/video modality. Preserve useful OS speech fallback without asking users to download local model weights. Stop/cancel/focus correctness matter as much as voice quality.

Keep user-account OAuth distinct from websites being opened. Spotify media controls, Gmail reading/sending, calendar sync and browser control each need their own implemented and scoped adapters. The user owns each connection. Show genuine capabilities; let missing ones be discoverable without being presented as connected.

### Improvements to earn the “better” claim

Treat these as proposed differentiation, not claims nobody else offers them: context that is inspectable before sending; a compact receipt of what actions happened and recovery options; per-workspace personality/voice/appearance profiles; clean handoff between voice, selected screen context and saved work; user-visible provider/usage controls; optional focus/gaming hide mode; multi-monitor/DPI reliability; keyboard parity and reduced motion. Keep arbitrary computer control opt-in and existing trusted prompts intact.

## Next work order

1. **Experience prototype first:** build a clearly labelled browser design study of the island's resting, expanded, listening-preview, answer, utilities and customization states. Desktop background is a neutral original mock workspace. No fake AI calls, capture permissions or invented live usage. Demonstrate the intended product form before another all-route restyle. Keep it isolated from the production app.
2. **Real Windows vertical slice:** introduce a hardened companion window with scoped IPC, same appearance model and real shared state. Add safe placement, focus/drag/close/recovery, shortcut, taskbar/tray behavior, multiple displays/DPI and hide controls. Do not expose the full native bridge to every overlay by default. Required native changes are now part of this targeted experience work.
3. **One complete useful loop:** deliberate voice/text command → Claude → one existing native action or saved-work query → result in the island → interrupt/recovery. Verify using fixture data, then an explicitly initiated real provider check. No test-mode autoapproval in production.
4. **Screen question and dictation loops:** implement and verify explicit region context and target-safe text insertion, preserving original text/clipboard/focus and consent. Add quality and latency evidence.
5. **Expand capabilities progressively:** real research, routines, memory, media and account adapters. Preserve the full hub for advanced work. Do not rebuild every page again before this primary loop works.

Acceptance evidence must include a real Windows screen recording showing another application remains in use while the companion expands, receives input, performs one permitted action and collapses without stealing focus. Check 125/150/200% DPI, two displays, Escape/cancel, failed network/key, no-key access and hidden CPU/GPU behavior. Browser screenshots cannot prove this.

The current PR is a useful code base for fonts/tokens, shared orb, route grouping and onboarding. It is not approved as the final visual/product experience. No need to discard those working improvements or restart expensive agent loops. No payments, new usage-credit activation or asset purchases are authorized by this research task.
