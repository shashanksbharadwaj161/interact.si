# Repository review and distinctive product direction

13 October 2026 · Extension to the Windows companion build plan

## Recommendation

Build a Windows companion organized around **resumable projects**. Each project holds its goal, relevant files and URLs, supported application state, visual scene, recent evidence, and next actions. The animated desktop makes those projects tangible; the assistant helps recover and continue them.

The signature interaction is: **“Resume yesterday's website work.”** The app shows a recap with source references, previews the windows and visual scene it can restore, resumes the supported workspace, and offers the next useful action. On finishing, it drafts a progress update from verified activity.

This is a differentiation hypothesis, not a verified world-first claim. The individual ingredients already exist. A broad search cannot prove that nobody offers their combination. The commercial advantage must come from how well the complete interaction works, original design, dependable adapters, and a clear audience.

## Research scope

Reviewed all three supplied links. Queried GitHub's public API to inventory 13 Ramen Software organization repositories and 30 repositories currently tagged `windhawk-mods` (the topic page showed 29, illustrating index drift). Inspected Meridian's README, architecture, privacy documentation, repository tree, and MCP tool definitions. Verified its current LICENSE at commit `06af902eee21931e30eeda3809ff2d6080de1a5b`.

Screened topic repositories through metadata and available documentation, with deeper reads of the strongest candidates. Downloaded 27 root READMEs; the three remaining repositories had no root README, so their root source listings were checked. Inspected headers and declared targets in 15 relevant official mod sources from an inventory of 738 official `.wh.cpp` files. This is not an audit of every mod implementation.

No downloaded code, installer, script, or mod was executed. Compatibility, advertised performance, and behavioral correctness remain untested. Preserve this distinction when selecting features.

## Features worth including

| Feature | Reference | Inclusion decision |
| --- | --- | --- |
| Work timeline and daily recap | [Meridian](https://github.com/Meridiona/meridian) | Build an independent, optional project-memory module |
| Session-to-task association | [Meridian architecture](https://github.com/Meridiona/meridian/blob/06af902eee21931e30eeda3809ff2d6080de1a5b/ARCHITECTURE.md) | Associate evidence with a project; allow correction and uncertainty |
| Evidence-backed progress drafts | Meridian | Draft locally and require review before external posting |
| Read-only memory tools for agents | Meridian MCP source | Offer scoped queries over our own project data |
| Morphing island, media, file shelf, timers | [HyperLand](https://github.com/Tanmay-Tiwaricyber/HyperLand) | Useful baseline; use original assets and a different visual identity |
| Widget packages and live preview | [HTWind](https://github.com/sametcn99/HTWind) | Build declarative widgets first; keep arbitrary scripting out of the initial host |
| Coordinated shell styling | [Ramen styling guides](https://github.com/ramensoftware/windows-11-taskbar-styling-guide) | Curated, versioned presets through an optional adapter |
| Backup review and selective restore | [Windhawk Backup Manager](https://github.com/osmanonurkoc/Windhawk-Backup-Manager) | Include change previews and recovery; prefer supported CLI operations over registry copying |
| Window wobble and elastic movement | [Wobbly Windows](https://github.com/lalimatyus/Wobbly-Windows) | Optional experimental effect after compatibility testing |
| Desktop-switch indicators | [Workspace Indicator](https://github.com/TheDisillusion/Virtual-Desktop-Workspace-Indicator-for-Windhawk) | Extend into project names, palette changes, and state-aware transitions |
| Fast application search | [Spotlight Launcher](https://github.com/DavidRaveloU/Spotlight-Launcher-Windhawk) | Add projects, routines, documents, and actions to our command palette |
| Active-monitor controls | [Action Center adapter](https://github.com/ereinaimer/windhawk-action-center-active-display) | Make our overlays follow the selected monitor; deeper shell hooks stay optional |
| Desktop companions | [WH Mods Hub](https://github.com/ciizerr/wh-mods) | Create an original companion tied to assistant status and project progress |
| Accessibility-based text extraction | [Textify, listed by Ramen](https://ramensoftware.com/) | Add copy/explain/translate with OCR fallback through our own implementation |
| UI element inspection | [UWPSpy, listed by Ramen](https://ramensoftware.com/) | Useful development reference for styling tools; not a required consumer dependency |

Meridian's public materials establish journaling, timeline reconstruction, summaries, and draft updates; they do not establish general restoration of past application state. That restoration is our proposed extension and requires separate adapters.

## The distinctive features to build ourselves

### 1. Project capsules

A capsule combines workspace references, a visual scene, task memory, and approved actions in one object. A coding capsule could contain an editor project, documentation tabs, a timer, notes, taskbar settings, and the last session's recap.

Support explicit Save, Resume, Compare, and Archive operations. On a different laptop, map applications, paths, monitors, and supported presets instead of assuming exact hardware parity. Sharing exports the selected configuration; private history and credentials are excluded by default.

This becomes the product's organizing principle and first prototype target.

### 2. A timeline you can act on

Search “the checkout bug I investigated yesterday,” inspect the matching evidence, then choose Resume. Show which files or links still exist, what moved, and what cannot be restored. The interface can animate the chosen session expanding into a workspace.

A screenshot is evidence, not a recoverable process snapshot. Start with app launch arguments, file references, URLs, window geometry, and supported app integrations. Unsaved buffers, authenticated sessions, terminal execution state, and arbitrary application internals cannot be restored universally.

### 3. A desktop that reflects the current task

Switching a capsule changes selected widgets, layout, palette, taskbar preset, and audio scene. Progress can appear as a restrained constellation, ring, or animated path. Each visible milestone links to a task or an observed result.

Use explicit workspace modes and signals the user permits. Avoid inferring emotions or claiming to measure productivity from mouse activity. Do not move windows or interrupt fullscreen work merely because a model guessed the user's intent.

### 4. Drag objects into actions

Drop a screenshot, file, URL, or selection onto the island. The app offers a compact menu based on the object and capsule: explain this error, attach to this task, summarize this document, compare these images, or open with the correct project tool.

Start with two or three reliable file types. Every proposed action names its destination and indicates whether content will go to a cloud provider. Animation provides spatial continuity from object to action to result.

### 5. A constrained visual scene composer

Ask for “midnight blue, soft motion, compact taskbar, two coding windows, music controls on the right.” Convert that description into a validated scene specification using supported controls. Preview the result and list the actual settings before applying.

Treat the preview as illustrative where real shell rendering cannot be simulated accurately. Generate theme configuration and allowed widget layouts first. Arbitrary generated C++ mods and PowerShell are not part of this first feature.

### 6. Explainable routines with recoverable changes

Turn “open my project, arrange the windows, and start a timer” into editable steps. Record what each step actually did. Offer undo for changes with a known inverse, such as theme settings, window layout, and newly created timers.

Sending a message, making a purchase, or overwriting external state cannot be promised reversible. Show partial completion honestly and prevent duplicate retries. A “watch once, make a routine” feature is later research, restricted to supported interfaces.

### 7. An optional visual team of agents

Show long tasks as small animated worker cards around the project, with assigned roles, real progress, cost, and cancellation. Use animation to explain actual work rather than invent activity. Start with a single runtime agent and bounded delegation later.

This is distinct from the Claude workers used to develop the application. Customer inference uses customer credentials or a separately designed paid service; it never uses the user's development key.

## What already exists nearby

| Product/reference | Documented overlap | Implication |
| --- | --- | --- |
| [Screenpipe](https://screenpipe.com/about) | Local screen memory, search, timeline, and agent access | A searchable activity history alone is not original |
| [PowerToys Workspaces](https://learn.microsoft.com/en-us/windows/powertoys/workspaces) | Capture, launch, and arrange application workspaces | Window restoration alone is not original |
| [Deskloom](https://bitinggoatsoft.win/products/deskloom/) | Reusable scenes combining desktop appearance and layout | Coordinated visual themes alone are not original |
| [DeskHorizon](https://deskhorizon.com/) | Spatial workspace, AI agent terminals, voice, profiles, and companions | An animated AI workspace alone is not original |
| HyperLand and HTWind | Rich islands and desktop widgets | Glass and motion are design ingredients, not sufficient differentiation |

These are public feature descriptions, not hands-on tests or evidence of feature absence. The unresolved question is whether another product already executes the complete project-memory → supported restoration → constrained scene → verified actions workflow well. Validate that with focused comparison demos before making marketing claims.

## Licensing and implementation decisions

- **Meridian:** the pinned current LICENSE is PolyForm Strict 1.0.0. Its terms restrict modification, redistribution, and commercial purposes. The README says earlier versions were MIT, while a web-cached raw LICENSE still showed MIT. The live, pinned file resolves the current-version discrepancy. Do not fork current Meridian into this planned commercial product. If old MIT code is considered, verify the exact historical commit and dependency/asset licenses first; otherwise implement independently or obtain a separate license. [Pinned LICENSE](https://github.com/Meridiona/meridian/blob/06af902eee21931e30eeda3809ff2d6080de1a5b/LICENSE).
- **Windhawk engine:** retain the optional external integration approach from the original plan. Its GPL obligations need evaluation for the actual distribution design.
- **Official mod collection:** the README says submissions without a declared license are MIT, but mods can specify another license. Check each selected file and third-party material; there is no universal MIT assumption for topic repositories. [Submission policy](https://github.com/ramensoftware/windhawk-mods).
- **HyperLand:** README claims MIT, but metadata alone did not resolve a complete licensing trail. Check source notices and referenced assets before copying anything.
- **HTWind and Wobbly Windows:** GPL projects. Use them as references or explicitly licensed optional integrations rather than copying their code into a proprietary core by default.
- **Missing license:** record as unresolved. Public visibility is not a reuse grant. A permissive root license still does not automatically settle artwork or embedded dependency rights.

Keep the existing native host proposal provisional. These references show several feasible UI approaches; they do not prove which host best handles our mixed-DPI overlays, animation, capture, and commercial installer. Test the native overlay before committing to a large UI implementation. Add a separate optional activity worker so continuous memory capture can be disabled without losing the assistant.

For project memory, begin with user-saved checkpoints and low-volume app/file events. Continuous screen/audio capture is an opt-in later mode with exclusions, retention, local encryption, and measurable resource budgets. Rich motion and continuous capture must have separate performance tiers; the original idle target cannot assume recording has zero cost.

## Suggested first demo

Build one complete interaction rather than a large collection of disconnected widgets:

1. Create a Website capsule with an editor, two URLs, project folder, timer, and visual preset.
2. Save an explicit checkpoint with a short note and selected screen evidence.
3. Switch to a Reading capsule with a different layout and restrained visual transition.
4. Ask to resume yesterday's website work.
5. Present the recap and restoration preview, then restore supported state.
6. Drop an error screenshot onto the island and get an explanation in that project's context.
7. Draft a session summary with evidence links and offer restoration of the previous visual settings.

Success requires correct focus, mixed-DPI layout, verified results, readable animation, graceful missing-app handling, offline local tools, and no private history in exported scene packs. This demo can establish whether the proposed combination is valuable before the $500 development budget is spread across optional effects.

## Repository inventory: all Ramen Software organization projects

Organization metadata was screened for all 13. Deeper inspection focused on the engine, official collection, styling workflow, and resource themes.

| Repository | Product relevance |
| --- | --- |
| [windhawk](https://github.com/ramensoftware/windhawk) | Optional customization engine |
| [windhawk-mods](https://github.com/ramensoftware/windhawk-mods) | Curated feature candidates; inspect individual licenses |
| [windhawk-translate](https://github.com/ramensoftware/windhawk-translate) | Localization reference |
| [windhawk-symbol-helper](https://github.com/ramensoftware/windhawk-symbol-helper) | Mod development tooling, not a consumer feature |
| [windhawk-dependencies](https://github.com/ramensoftware/windhawk-dependencies) | Installer/dependency reference |
| [windows-11-taskbar-styling-guide](https://github.com/ramensoftware/windows-11-taskbar-styling-guide) | Taskbar preset and editor reference |
| [windows-11-start-menu-styling-guide](https://github.com/ramensoftware/windows-11-start-menu-styling-guide) | Start menu preset reference |
| [windhawk-mod-symbol-cache](https://github.com/ramensoftware/windhawk-mod-symbol-cache) | Compatibility infrastructure, not a UI feature |
| [windows-11-notification-center-styling-guide](https://github.com/ramensoftware/windows-11-notification-center-styling-guide) | Notification panel preset reference |
| [r11-resource-redirect](https://github.com/ramensoftware/r11-resource-redirect) | Optional resource-pack reference; audit assets |
| [windows-11-file-explorer-styling-guide](https://github.com/ramensoftware/windows-11-file-explorer-styling-guide) | Explorer preset reference |
| [resource-redirect-themes](https://github.com/ramensoftware/resource-redirect-themes) | Optional icon/resource theming |
| [windows-11-settings-styling-guide](https://github.com/ramensoftware/windows-11-settings-styling-guide) | Settings appearance reference |

The author's broader website also lists Textify, UWPSpy, 7+ Taskbar Tweaker/Numberer, winapiexec, assembler tooling, and RAR Unlocker. Prioritize text extraction and UI inspection concepts. Legacy taskbar behavior is a compatibility reference; unrestricted WinAPI invocation, executable patching, and archive-lock utilities are outside the product's initial scope.

## Repository inventory: all topic results

These are inclusion decisions after screening, not endorsements. Documentation claims require runtime validation; reuse requires a per-version license audit.

| Repository | Decision |
| --- | --- |
| [Windhawk-Backup-Manager](https://github.com/osmanonurkoc/Windhawk-Backup-Manager) | Include selective backup/recovery concepts |
| [quotes-id](https://github.com/wafarifki/quotes-id) | Optional informative clock; avoid copying external feeds blindly |
| [Internet-Download-Manager-Engine](https://github.com/animatlittlechild8/Internet-Download-Manager-Engine) | Defer; download acceleration is outside the core scope |
| [Windows-11-Productive-Rice-Configs](https://github.com/Somrat10369/Windows-11-Productive-Rice-Configs) | Reference for optional workspace integrations |
| [HTWind](https://github.com/sametcn99/HTWind) | Include widget/package/editor concepts |
| [kai9987kai/windhawk](https://github.com/kai9987kai/windhawk) | Prefer upstream engine rather than this fork |
| [Wobbly-Windows](https://github.com/lalimatyus/Wobbly-Windows) | Experimental optional animation; DWM hook and ARM64 limits |
| [ciizerr/wh-mods](https://github.com/ciizerr/wh-mods) | Companion reference; inspect asset rights |
| [magnifier-headless](https://github.com/bcrtvkcs/magnifier-headless-windhawk-mod) | Optional accessibility workflow; preserve discoverable controls |
| [Explorer utility window hider](https://github.com/bcrtvkcs/explorer-tab-utility-window-hider-windhawk-mod) | Defer; narrow external-tool workaround |
| [pivotlink-browser-router](https://github.com/gauthumj/pivotlink-browser-router) | Explore project-aware URL routing; no root README |
| [Rainmeter always bottom](https://github.com/bcrtvkcs/keep-rainmeter-always-bottom-windhawk-mod) | Optional integration if Rainmeter support is chosen |
| [Chrome PiP switcher hider](https://github.com/bcrtvkcs/chrome-pip-alt-tab-window-hider-windhawk-mod) | Optional window-switching preference |
| [Windows 11 Action Center on Windows 10](https://github.com/larsyoo/Windows-11-Style-Action-Center-Windhawk) | Defer until Windows 10 tier exists |
| [explorer-status-metadata](https://github.com/VitalSkib/explorer-status-metadata) | Optional file-inspection enhancements |
| [NVIDIA dialog hider](https://github.com/bcrtvkcs/nvidia-control-panel-missing-dialog-hider-windhawk-mod) | Exclude from default; hides a device-specific warning |
| [transparent-windhawk-styles](https://github.com/michalges/transparent-windhawk-styles) | Visual cohesion reference; license unresolved |
| [IDM completed-download cleanup](https://github.com/bcrtvkcs/idm-clear-completed-downloads-windhawk-mod) | Defer; app-specific utility |
| [global-hotkey-mute](https://github.com/Eliasilyz/global-hotkey-mute) | Include mic-status and mute controls through native APIs |
| [folder thumbnail-cache block](https://github.com/wolfgangxxiii/windhawk-block-folder-thumbnail-cache) | Optional Explorer appearance preference |
| [pip-to-uv](https://github.com/Athari/windhawk-python-pip-to-uv) | Developer-only later; changes command behavior; no root README |
| [TetraTheta collection](https://github.com/TetraTheta/windhawk-mod-collection) | Inspect hotkey suppression/column-width options later; no root README |
| [pongo collection](https://github.com/pongo/my-windhawk-mods) | Per-instance icons and notification-flash controls |
| [Action Center active display](https://github.com/ereinaimer/windhawk-action-center-active-display) | Optional active-monitor integration |
| [Search active display](https://github.com/ereinaimer/windhawk-search-active-display) | Optional active-monitor integration |
| [HyperLand](https://github.com/Tanmay-Tiwaricyber/HyperLand) | Island baseline and existing-feature comparison |
| [Spotlight Launcher](https://github.com/DavidRaveloU/Spotlight-Launcher-Windhawk) | Launcher behavior and indexing reference |
| [taskbar-count-badges](https://github.com/digart11/taskbar-count-badges) | Optional information density improvement |
| [Workspace Indicator](https://github.com/TheDisillusion/Virtual-Desktop-Workspace-Indicator-for-Windhawk) | Project transition reference |
| [explorer-visual-tweaks-dark](https://github.com/VitalSkib/explorer-visual-tweaks-dark) | Optional advanced Explorer preset |

## Next planning decision

Use the project capsule as the core data model and the resume flow as the first acceptance test. Keep the first release's animated island, command palette, local tools, and optional shell adapter from the earlier plan. Move continuous recording, DWM physics, unrestricted scripting, and a public marketplace into later opt-in modules.
