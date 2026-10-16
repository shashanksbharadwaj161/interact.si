# Desktop Companion — source UX audit, 16 October 2026

Read-only audit of canonical `outputs/jarvis-desktop`. This is source evidence and a redesign brief, not a fresh installed-app interaction audit. User's installed-app feedback is the principal acceptance failure: difficult to use, unattractive, features not working. Passing build/unit tests does not rebut that feedback.

## Concrete current failures

1. **23 equally promoted navigation entries.** `src/ui/nav.tsx` defines all23; `App.tsx` renders every group/view directly in the primary sidebar. “Cockpit / Work / System” combines user actions, infrastructure, previews, developer tools, and roadmap. At width<1000, `styles/responsive.css` hides all nav labels; <720, the same23icons become a horizontally scrolling bottom strip. Group order is interleaved by append-only shortcut history, not workflow. A user cannot tell where to start.
2. **Home is an inventory, not a useful start.** `Home.tsx:27` has12widgets; `DEFAULT_LAYOUT` hides none. It additionally renders `DashboardWidgets` and `FileShelf` outside this12widget loop. Counts, capability states, warnings, activity, quick actions, recent content, and avatar compete. The primary subtitle is “What is saved on this computer right now.” User asked for an assistant that does useful things, not an engineering dashboard.
3. **Onboarding demands setup before demonstrating value.** `Onboarding.tsx` has4steps: mode/look, permissions, hardware/model, review. It exposes loopback endpoint/model-name fields and “ollama pull” instructions; local AI is not bundled. `finish` permits onboarded=true while readiness is blocked, as long as settings strings validate. New user can finish and land on an assistant that cannot answer. No single completed first-success task establishes value. Live provider status is not fully modeled by this legacy onboarding: it calls legacy `setCloudKey`, model readiness checks legacy cloud configuration, while newer Settings has per-provider routes.
4. **Assistant is a diagnostics workspace.** `Assistant.tsx:1200–1540` combines chat, desktop commands, history/import/export, contextual sources, push-to-talk, read-aloud, planner controls, model-route status, avatar preview/editor and multiple warnings. Route/model/endpoint/key/readiness badges plus explanatory paragraphs immediately precede composer. Desktop command vs model chat is technically honest but forces users to understand implementation before using it. At narrower widths the entire secondary stack falls below chat. Settings action should be in context when blocked; a string saying open Settings is insufficient.
5. **Two avatar systems undermine visible customization.** `Avatar.tsx` is a hardcoded CSS robot: antenna, visor, eyes, mouth, neck, shoulders, halos/rings/sparks. Shell/Assistant/Companion use it. `AvatarStudio.tsx` reads `avatar.pack`, draws a separate canvas via `ui/avatar-editor.ts`, and supports SVG/PNG/JSON exports. Editing that pack does not parameterize `Avatar.tsx`; shell identity can remain unchanged after studio work. Assistant can expand a complete second AvatarStudio beneath the CSS robot, increasing confusion. No bundled GLB/GLTF/VRM/art-directed image/font assets were found by targeted file search. Do not claim realistic3D/lip-sync from this renderer.
6. **Product contains implementation/roadmap vocabulary.** AvatarStudio shows “Scope129”, “Scope136 · manual”, “Honest gates”, “Not in this build”. Companion headline emphasizes CSS shapes/no assets. FeatureLab is top-level navigation. Developer details need to remain available, but these are not consumer-facing explanations of value.
7. **Settings behaves inconsistently.** `Settings.tsx` has5tabs and20indexed sections. Appearance/motion apply immediately, startup/voice/model settings require Save; the blurb explains the inconsistency. Cloud/provider, local model, readiness, mode, source permissions, license offline signature tooling, encrypted-transfer bundles compete with basic preferences. A clear dirty-state/footer and predictable save model are needed; advanced signing/license trust management belongs under Developer/Advanced.
8. **Visual system repeats generic panels.** `tokens.css` uses system Segoe typography,13.5px base (`base.css`), uppercase micro-labels, small10–11px mono labels, gray borders,blueaccent; `shell.css` adds rotating dashed logo, glows and a backdrop. Hundreds of `Panel/Notice/Badge` instances produce equal-weight rectangles. Changing accent to purple, adding glass to every card, or adding particles behind the same layout will not solve hierarchy.
9. **Capability gates are honest but disconnected from recovery.** All the real privacy/capability protections should survive; the problem is surfacing them as repeated warning walls and disabled controls. User needs a capability row with one next action: connect provider, choose a file/folder, test microphone, inspect supported actions, or continue with an available local task.

## Proposed information architecture — keep routes and existing links working

Use6primary destinations plus Settings footer; contextual subnavigation and command palette retain all23routes. Do not delete backend features to simplify the UI.

| Primary destination | Existing route IDs kept/redirected | User purpose |
|---|---|---|
| Today | `home` | One useful action, continue last work, up to3relevant items; minimal personalized state |
| Assistant | `assistant`, `computer` | One chat/voice entry, attach/context controls on demand; explicit review before desktop actions |
| Workspace | `notes`, `writing`, `tasks`, `calendar`, `capsules`, `clipboard` | Saved work, consistent list/detail patterns; rename Capsules to Workspaces in display copy if tests/deep links preserve underlying ID |
| Memory | `search`, `memory` | Search first; sources/projects/shelf in tabs; opt-in history distinct from current source selection |
| Studio | `companion`, `avatar`, `motion` | One art-directed companion, appearance presets, scenes and deeper editing |
| Automations | `routines` | Triggers, steps, dry-run/review, last result; distinguish manually run from scheduled |
| Settings/footer | `settings`, `integrations`, `models`, `usage`, `guide`, `status`, `developer`, `lab` | Connected accounts; AI providers; usage; setup help; diagnostics and roadmap tucked under Advanced |

Retain `ViewId`, `hashFor/parseHash`, deep-link query params and first10keyboard shortcuts initially; changing visible labels/grouping need not break state/routes. Ctrl+K should become command/search surface with clear mode or support both without silently dropping memory search.

## First-success workflows

**Offline fresh install:** welcome with2choices “Start locally” and “Connect AI”; locally means notes/tasks/search/basic actions available without model. Show one feature selected by user (capture note / add task / search saved work). Complete it and show a clear saved result. Optional AI setup can follow. Do not advertise offline chat as ready with no local model.

**BYOK:** provider picker Anthropic/OpenAI/OpenRouter → masked key save through existing protected bridge → model selection/default with advanced custom field → optional explicitly confirmed connection test (real call, clearly potential token spend) → first streamed message with cancel and saved reply → return to working assistant. No key in browserstorage/repo/screenshots and no silent mode switch. Product keys are separate from development keys.

**Computer action:** user request → proposed action card with exact target + effect → retained trusted Windows confirmation → result or concrete actionable failure. No broad “autopilot” button that removes security boundaries. Initially expose verified actions in a capability menu, not imaginary general computer control.

**Connected accounts:** one account row/provider, user-owned OAuth credentials, scoped grants, status, reconnect/disconnect/delete data. App registration is not equivalent to user sign-in. Nonimplemented services should be in an optional catalogue with “setup required”, not presented as connected or working.

**Avatar:** choose3–4excellent presets, preview on the exact shared live renderer, select/apply and see change instantly in Assistant/shell. Advanced editor is secondary. A polished orb default is a viable immediate art direction; no cheap robot doodle. State animation follows real app events, simulated previews labeled only inside Studio. Mouth amplitude is not phoneme lip sync. Licensing/provenance required for any imported artwork/model.

## Original visual direction constraints

Premium consumer desktop assistant with a quiet working surface and one expressive companion. Use restrained neutral/paper/ink surfaces with a single warm/cool accent family; custom orb as focal point, not decorative globes everywhere. Spacious18–24px rhythm, readable14–16px task text, coherent display typography bundled locally with license, compact optional rail plus clear labels. Realistic contrast, solid-fill/reduced-transparency fallback, Windows highcontrast, reducedmotion and battery-aware motion. Pointer hover should be local, natural and brief; idle orb should stop/simplify when hidden. Do not copy website hero/scroll hijacking into everyday forms or chat.

“Award-winning” is a direction, not a testable completion claim. Require comparative screenshots and task success before calling the redesign delivered.

## Implementation seams and ownership

First tranche owns `components/App.tsx`, `ui/nav.tsx`, `components/Onboarding.tsx`, `components/Home.tsx`, `components/Assistant.tsx`, `components/Avatar.tsx`, `components/Companion.tsx`, `components/AvatarStudio.tsx`, `components/Settings.tsx`, `ui/primitives.tsx`, shell/tokens/base/components/views/responsive/avatar CSS. Incremental route pages follow shared patterns; no giant CSS override appended over all old styles.

Shared avatar renderer should consume validated `ui/avatar-editor.ts` pack or a new typed preset abstraction with compatibility adapter. `ui/companion.tsx` remains source of real recording/thinking/speaking/error state; `hostVoiceLevel` only uses actual audio measurements. Persistence migration must retain packs, scenes and preferences.

Preserve `shared/contracts.ts`, `window.jarvis` preload IPC surface, `ui/store.tsx`, optional bridge capability checks in `ui/bridges.ts`, state schemas/data recovery, per-provider key storage, stream/event/cancellation contracts, desktop action preview/expiry/native-confirmation flow. Keep contextIsolation/sandbox/noNodeIntegration and offline network guard. No credentials/account settings/private ControlRoom runtime access is needed for a redesign.

## Dependencies / skill availability

Existing runtime dependencies: React19.2, ReactDOM19.2, Phosphor2.1.7. Electron44.7/Vite7.3/TypeScript5.9/esbuild are build/runtime tooling. No existing Motion/GSAP/Three/R3F component stack. Prefer CSS/Canvas/WebGL for one well-defined orb or add one justified permissive maintained dependency in a coordinated change, not multiple competing systems.

Read `C:/Users/SHASH/.codex/skills/design-taste-frontend/SKILL.md`: audit-first, infer brief, avoid generic purple/glass/card defaults, localfonts, consistent iconfamily, interaction/performance guidance applies. It explicitly says “Not dashboards, not data tables, not multi-step product UI”; use its aesthetic principles contextually, not as authority to convert app into landingpage or require Next/Tailwind replacement. Targeted installed skill filename inventory found no separate Karpathy or UI/UX skill; only taste and storefront in user skill directory. Repo `.agents/skills/loop-architect` exists; not a UI skill. Do not claim missing skills applied or install them without reviewing scope.

## Tests that would have caught this delivery failure

Existing `scripts/smoke.cjs` is useful security/route-mount smoke: tempuserData, bridgeCRUD, hardening, zero external requests, route text>20chars/current link. It explicitly completes onboarding through `window.jarvis.saveSettings` and navigates routes by changing hash, not real onboarding/click interactions. Optional screenshots are captured but not automatically evaluated for usable layout. It proves neither first-run success nor AI/provider setup nor task discoverability.

Add focused renderer/Electron journey acceptance: fresh install creates first note via UI without provider; BYOK provider saved status/model route coherent; blocked model has direct recover action; chat stream/cancel/retry;3desktop actions with native confirmation stub in harness; editingavatar visibly updates same renderer; each key route reachable with keyboard; theme/motion/highcontrast preferences persist. Mock providers offline by harness, separately document real opt-in provider checks. Capture at1280x800,1440x900 and Windows125/150%scale, plus actual installed Windows review. Assert no overlap/truncation/scrolltrap, visible focus and keyboard return. Small number of real usability journeys is more meaningful than another hundred pure utility tests.

Delivery gate: user can perform first-success flow unguided in<2minutes; no default errorwall; no unsupported features disguised as operational; screen-by-screen visual inspection and before/after evidence; install-level smoke after packaging. Report failed workflows explicitly, not one aggregate completion percentage.
