# Revamp reference catalog — checked 2026-10-16

Evidence level: every exact URL below was opened with web fetch. These are **text/catalog inspections**, not rendered screenshots or frame-by-frame motion verification. No purchase, installation, code download, asset copying or account changes occurred. Parent owns browser inspection. A successful catalog fetch does not prove its embedded demo rendered or performed well.

## Design URLs

| Exact reference | Fetch / evidence | Product adaptation | Avoid / constraints |
|---|---|---|---|
| [KILN](https://horizonx.so/explore/kiln-studio-landing) | Catalog fetched. Describes layered floating cards, curved section edges, 3D project stack, full-screen menu; HTML/GSAP/Lenis. | Strong typographic hierarchy, orderly depth for appearance-preset previews, well-choreographed first run. | A daily desktop task should not require a scroll narrative. Premium source requires licensed access. |
| [sublevel.studio](https://threeui.com/landing-pages/sublevel-studio-landing-page) | Catalog fetched; live embed text reports loading fallback. Black/white modular project cells, utility dock, diagnostics and terminal finish described. | Tactile material contrast; compact navigation; diagnostics as a secondary utility. | Avoid faux terminals, obscure labels and OS cosplay obscuring actions. Embed itself unverified. |
| [Glass Portfolio](https://21st.dev/@larsen66/templates/glass-portfolio) | Catalog fetched. WebGL glass spheres, animated menu and galleries described; preview link available. | One intentional refractive orb for assistant presence; restrained frosted navigation. | Paid download; no backend. Refraction must not reduce text contrast. No evidence of product task flows. |
| [Animated Top Dock](https://threeui.com/css/animated-top-dock) | Catalog fetched; embed loading fallback. Sable spring capsule, command-bar, pixel strip and vertical glass variants described. | Five clearly labelled destinations; bounded hover response and obvious current location. | Do not let menu widths jump targets or hide navigation until hovered. Static keyboard/touch equivalent. |
| [DNA Carousel](https://www.framer.com/marketplace/components/dna-carousel/) | Marketplace fetched. Helix gallery, keyboard/drag/swipe, snapping and reduced motion documented. Limited marketplace license. | Optional visual browsing for themes/avatars, with selected item name and Apply action. | Keep a normal list/grid alternative. Framer component is not automatically React/Electron ready or unrestricted source. |
| [Scroll Zoom Reveal](https://scrollzoomreveal.framer.website/) | Site fetched; minimal showreel text and background image link. Animation itself not verified. | Brief onboarding or optional showcase reveal. | Do not put long scrubbed transitions in recurring settings/task workflows. |
| [Liquid Metal Button](https://threeui.com/buttons/liquid-metal-button) | Catalog fetched; embed loading fallback. Raw WebGL2 pill/orb/play controls with pointer bloom and ripples described. | One signature assistant activation control; ordinary readable buttons elsewhere. | No perpetual shader animation on every button; ensure accessible text, focus and non-WebGL fallback. |
| [AURA](https://21st.dev/@larsen66/templates/aura-svelte-gsap) | Catalog fetched. Svelte5/GSAP agency page; upstream MIT repo linked, rehosted download paid. | Measured section pacing and confident typography. | Existing app is React; use principles rather than introduce a Svelte shell. Test local fonts/media and attribution if source reused. |
| [Orvane particle hero](https://horizonx.so/explore/orvane-particle-hero) | Catalog fetched. Raw WebGL2/TypeScript particle bust, pointer displacement; pre-baked point buffer; reduced motion/hidden-tab pause/fallback documented. | Optional premium avatar presentation and explicit idle/listening/responding states. | Do not default to a 150k-particle always-on renderer. Third-party head scan attribution distinct from template license. |
| [Digital Wave Field](https://horizonx.so/explore/digital-wave-field-hero) | Catalog fetched. Three.js pointer-reactive grid and instrument framing described. | Subtle assistant audio-response field or optional workspace background. | Input response must communicate a real state, not imply nonexistent audio/listening. Keep behind content, capped density. |
| [ARQ-01](https://horizonx.so/explore/arq-01-carry-the-horizon) | Catalog fetched. 289-frame canvas product sequence, progressive loading and reduced motion described. | Cinematic first-run or product demo, polished transitions between scenes. | Heavy image sequences are unsuitable as the app shell; avoid loading cost and scroll hijacking. |
| [Immersive Robotics](https://horizonx.so/explore/immersive-robotics-landing) | Catalog fetched. React/GSAP, canvas assembly sequence and technical annotations described. | Precise spacing, mechanical clarity and explanatory setup illustrations. | Avoid fake telemetry, gratuitous diagrams and large motion between task steps. |
| [Halovane](https://horizonx.so/explore/halovane) | Catalog fetched. Three.js WebGPU/TSL with WebGL2 fallback, particle pose morphs, local GLB import, controls described. | An optional avatar studio with live preview, a small curated set of polished forms and quality/motion settings. | Avoid assuming arbitrary GLB is production-safe or well-framed; validate size/types and preserve licenses. Complex 3D belongs behind a choice. |
| [Kreivo](https://horizonx.so/explore/kreivo) | Catalog fetched. Music-layer canvas, palettes, shader waves, pills described. **License copy conflicts:** top says personal, lower section says commercial. | Cohesive palette presets, interactive audio visualizer, direct manipulation in creative tools. | Resolve actual license before reuse; do not infer Spotify playback rights, AI backend or real integration from template copy. |
| [GSAP Scroll Motion Lab](https://horizonx.so/explore/gsap-scroll-motion-lab) | Catalog fetched. Configurable section/text/scroll presets and reduced-motion support described. | Use an internal motion-audition page to compare timings before applying a consistent motion system. | Template package requires licensed access. Do not ship every experiment or apply scrolling text effects to forms/tables. |
| [NOVARA](https://horizonx.so/explore/novara-creative-studio) | Catalog fetched; dark studio/ink-film/oversized type described. | **Excluded: user rejected this direction.** | Do not select as visual basis or reinterpret rejection as permission. |

## Repository inspections

### [awesome-opus5-5-videos](https://github.com/yihui-dev/awesome-opus5-5-videos)

README and repository listing fetched. MIT repository containing animation prompts and video metadata: HTML, Canvas, SVG and Three.js examples, rather than a video-generation engine. Useful as a motion-reference/prompt library. It does not supply an installed video creation feature. Individual referenced media and creator posts retain their own rights; do not bundle them simply because the index is MIT. Runtime compatibility depends on each generated implementation. Prioritize lightweight local code-native motion and controlled export.

### [OpenUsage](https://github.com/robinebers/openusage)

README/license fetched. MIT **native Swift macOS menu-bar application**, requires macOS15+, not a Windows package. Shows provider quota windows, credits and estimated local spend. Useful UI patterns: compact provider rows, pinned metrics, distinct time windows, explicit estimates and missing-data states. Windows app needs its own adapters and rendering. Never substitute approximate local usage for authoritative billing or silently reuse another app's session credentials.

### [Bible Strong Avatar Lab](https://github.com/smontlouis/bible-strong-avatar-lab)

README and [package metadata](https://raw.githubusercontent.com/smontlouis/bible-strong-avatar-lab/main/package.json) fetched. Browser-local procedural SVG avatar authoring: shapes, expressions, reusable animations, JSON portability; React19/Vite and workspace avatar packages. **AGPL-3.0-only**, not a permissive drop-in for an intended proprietary commercial product. Treat as an interaction/workflow reference unless the project deliberately accepts its license obligations or receives another license. Its source package also lists Vercel analytics dependencies, so do not transplant a whole app into an offline-default product. SVG approach itself is practical for low-resource Windows rendering. No automatic AI voice/vision/photoreal avatar backend is implied.

### [GitHub ai-avatars topic](https://github.com/topics/ai-avatars)

Attempted twice. Fetch ended **HTTP429 Too Many Requests**. Not reviewed; no claim that every listed repository was inspected or usable. A topic page is an index, not a dependency or common license.

### [REA](https://github.com/morluto/rea)

README/license and [package metadata](https://raw.githubusercontent.com/morluto/rea/main/package.json) fetched. MIT-authored Node CLI/MCP investigation toolkit for app/native/JavaScript/Electron behavior. Current metadata includes Windows x64 native support and specific Node engine ranges; support depends on selected capability and tools. Useful for evidence-backed analysis of our own Electron boundaries and behavior, not a UI kit or ready app feature. Static JavaScript analysis can work without a native disassembler. Native tools have separate licenses. REA does not grant rights to copy competitors' source, assets or private internals. No installation or invocation performed by this audit.

## Recommended synthesis for the Claude brief

1. Start with a usable desktop information architecture: Home/Assistant, Library, Automations, Connections, Appearance; settings and diagnostic tools secondary.
2. One signature object: physically convincing glass/metal orb that maps to real assistant state. A calm SVG/canvas fallback and a fully disabled option are mandatory.
3. Typography, spacing, restrained palette and contrast create the premium baseline. A shader cannot repair confusing hierarchy or a dense wall of cards.
4. Give avatar selection its own polished studio: curated 2D/3D/abstract options, clear preview, labelled customization and Apply/Reset. Remove the current placeholder aesthetic rather than add glow around it.
5. Use short component and scene transitions; avoid importing marketing-site scroll choreography into daily work. No blocking intros; reduced motion and keyboard flow work everywhere.
6. Every feature's main action must work. Product status must distinguish connected, unavailable, setup-required and preview states without developer jargon spilling across the UI.
7. Verify on the installed Electron build at laptop resolution and Windows scaling. Measure idle CPU/GPU, hidden-window behavior, animation/frame consistency and interaction latency. Screenshots and interaction recordings are separate evidence; neither unit test counts nor catalog prose proves visual quality.
