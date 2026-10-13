# Windows desktop companion — product and build plan

Planning draft · 13 October 2026

Design/module update: [Motion, avatars, usage, and design plan](motion-avatars-usage-and-design-plan.md) records the user's supplied historical references, likely Space UI/Skecher UI/Planes matches, all avatar modes, a Windows usage panel, Motion Studio, and REA development tooling. Combined roadmap: 140 planned scopes. Framework remains provisional pending native/React renderer feasibility tests.

Voice update: [Voice integration and component shortlist](voice-integration-and-component-shortlist.md) selects SpeakoFlow as the primary Windows reference and defines local speech plus optional Haiku BYOK assistance. Source review only; no voice components are integrated yet.

Confirmed follow-up: finished application is strict offline by default, with optional online mode. Development may use online services and Claude Console credits. [Feature catalog and offline architecture](feature-catalog-and-offline-architecture.md) supersedes any cloud-required interpretation below and defines 120 curated feature scopes. Agent Orchestrator 0.13.7 is installed for development; no paid agents have started. Model setup must support local import and the complete application must work without an API key.

Research update: [Repository review and distinctive product direction](repository-review-and-product-direction.md) adds Meridian, the Windhawk topic ecosystem, all Ramen Software organization repositories, and a focused scan of nearby products. The proposed signature feature is now a resumable project capsule combining task memory, supported workspace restoration, a visual scene, and verified actions. This extends the plan; it does not establish a world-first claim or change the unspent development budget.

## Product direction

Build a full Windows desktop companion combining AI assistance, useful desktop tools, rich animation, and optional deep customization. Start with a polished personal edition, use it daily, then prepare a public beta and a paid commercial edition. The name and branding remain open.

The user has $500 in Anthropic Console credits for development. That is a development inference budget, not a promise that it covers the entire commercial launch, code signing, hosting, paid assets, speech services, or ongoing customer usage. No credentials have been requested or used and no paid workers have been started.

## What was inspected

The Google share link resolves to [Windhawk's official site](https://windhawk.net/). Its homepage and mod catalog were inspected in Chrome, along with its official repository, license, release notes, and CLI source. Hitodama's homepage, visual presentation, example interactions, FAQ, requirements, and published privacy information were reviewed. The supplied attachment is OpenRouter Ori Harness documentation; its documentation index and current harness page were also fetched.

This is an inspection of public product materials and implementation documentation. Neither application was installed or exercised locally. Hitodama's purchased installer, private implementation, real latency, and reliability remain untested. Marketing animations demonstrate intended behavior; they do not establish runtime quality. An end-to-end runtime comparison would require accessible installers and, for Hitodama, a valid license and provider key.

| Reference | Verified emphasis | Implication for this app |
| --- | --- | --- |
| [Windhawk](https://windhawk.net/mods) | Source-based mods for taskbar, Start menu, Explorer, application behavior, and animation | Add a curated customization layer with compatibility checks and recovery |
| [Hitodama](https://hitodama.in/) | Voice interaction, screen-region questions, cleaned dictation, scheduling, and an island with desktop tools | Make the everyday assistant and compact desktop surface excellent |
| [Hitodama requirements](https://hitodama.in/requirements/) | Windows 10/11; cloud AI requires connectivity and a Google key; some local tools work without AI | Preserve useful offline tools and make provider requirements explicit |
| [Hitodama privacy](https://hitodama.in/legal/privacy/) | Local memory and encrypted keys; voice and selected context are sent to its AI provider | Provide editable local memory and clear controls over cloud context |
| [Windhawk releases](https://github.com/ramensoftware/windhawk/releases) | Stable 1.7.3 and 2.0 alpha releases; the new CLI supports mod management and settings | Prototype a versioned adapter; do not assume alpha behavior is stable |

Proposed features below are our product choices. They are not claims that the references lack them.

## The experience

Three surfaces share the same design system:

1. **Desktop island:** a small movable overlay for listening, responses, media, timers, and quick actions. It expands only when useful, supports keyboard interaction, and avoids stealing focus.
2. **Command palette:** one shortcut for asking questions, launching apps, opening files, searching, and triggering workspaces or routines.
3. **Control center:** a full window for conversations, workflows, personalization, providers, memory, permissions, and diagnostics.

An optional animated companion can display listening, thinking, speaking, success, error, and idle states. Users can switch it off or choose the island alone. Build an original visual identity and original assets.

Initial design direction: dark translucent surfaces, restrained luminous accents, precise typography, spring-like transitions, and strong focus states. Include light and high-contrast themes. Keep text legible even when blur is unavailable.

## Feature roadmap

| Area | First personal release | Expanded personal edition | Commercial evolution |
| --- | --- | --- | --- |
| Assistant | Text chat, push-to-talk, interrupt/cancel, streaming responses | Voice personalities, multilingual interaction, optional wake word | Provider onboarding and support diagnostics |
| Dictation | Transcribe, clean up, preview, insert into supported fields | App-specific tone, vocabulary, translation | Compatibility coverage and onboarding tutorials |
| Screen context | Select a region, explain it, copy extracted text | Compare captures, summarize approved documents, explain errors | App exclusions and enterprise controls |
| Desktop actions | Launch apps, open URLs, adjust supported controls | Window arrangement, approved file operations, browser workflows | Published compatibility matrix |
| Workspaces | Save apps, URLs, window layouts, and timers | Voice-triggered scenes and per-monitor layouts | Shareable workspace packs |
| Productivity | Tasks, reminders, notes, focus timer | Calendar connectors, snippets, clipboard tools, research with citations | Integration management and optional sync |
| Routines | Local time-based routines and execution history | Visual workflow builder, conditions, retries, event triggers | Curated workflow library |
| Personalization | Island position, size, themes, motion settings | Optional Windhawk presets, wallpaper scenes, custom widgets | Theme-pack ecosystem with review controls |
| Motion | Island expansion, waveforms, animated status, transitions | Companion skins, particles, reactive backgrounds, coordinated scene changes | Artist-authored packs and asset licensing |
| Memory | Inspect, edit, forget, export | Opt-in project memory and local knowledge retrieval | Encrypted optional sync |
| Reliability | Action results, pause-all shortcut, local logs | Crash recovery, plugin isolation, compatibility diagnosis | Signed releases, updater recovery, support tooling |

Potential signature features:

- **“Set up my coding workspace.”** Open the editor, project folder, browser tabs, and music; arrange windows; start a focus timer; apply an approved visual scene.
- **“Explain this error.”** Select a screen region, receive an explanation, then choose a proposed fix with an action preview.
- **“Make my desktop look like this.”** Use an image to suggest a theme, wallpaper, and compatible preset. Generated suggestions must map to validated settings before application.
- **Theme studio:** edit colors, typography, spacing, blur, island shape, widget layout, and motion with a preview and a restore button.
- **Routine recorder:** capture a user-selected sequence, convert it into editable steps, and replay against supported app controls.
- **Personal knowledge search:** search explicitly selected folders locally; cloud summarization is a separate opt-in action.
- **Scene transitions:** coordinate wallpaper, overlay palette, app layout, and widgets for Work, Gaming, Reading, and Chill.

Live wallpapers, universal macro recording, arbitrary app automation, and a public plugin marketplace are substantial separate projects. Schedule them after the core assistant proves reliable.

## Technical direction

Recommended starting point: **C# with WinUI 3 and Windows App SDK**, SQLite for local state, and native Windows integrations. WinUI is a candidate pending the overlay prototype; if transparent windows, focus handling, or mixed-DPI behavior are troublesome, use a WPF overlay host behind the same interfaces. Decide after testing one small vertical slice, before producing many screens.

Microsoft documents the [Windows App SDK](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/) and [XAML/composition motion options](https://learn.microsoft.com/en-us/windows/apps/develop/motion/xaml-animation). These support the proposed native UI direction; the exact animation and overlay implementation still needs validation.

Architecture:

```text
Island / palette / control center
                |
          Application core
        /        |          \
Local tools   AI gateway   Routine scheduler
     |           |               |
Windows APIs  Providers       Durable job store
     |
Optional versioned customization adapter
     |
Separately installed Windhawk
```

- Run desktop interaction in the signed-in user's session. A Windows service is not the desktop automation host.
- Prefer app APIs and Windows UI Automation over screen coordinates. Add browser integration only for selected browsers, with scoped access. Vision-based clicking is a controlled fallback.
- Give tools schemas, timeouts, cancellation, observable results, and explicit capability scopes. Do not let model output become unrestricted terminal input.
- Separate model planning from execution. Validate each action locally; verify its result before reporting success.
- Store keys using Windows credential protection / user-bound DPAPI. This protects storage, not against a compromised user session. Keep keys out of UI logs, source control, exports, and installer binaries.
- Store tasks, settings, and inspectable memory locally. Treat clipboard history and indexing as optional features with retention controls.
- Make speech pluggable: transcription → Claude reasoning/tool use → speech output. Anthropic's listed models accept text/images and produce text; speech requires a separate local or cloud component. Start with local speech options and measure accuracy and latency before choosing a paid service.
- Treat retrieved pages, documents, and screenshots as data. They cannot grant permission or change execution rules.

### Deep customization

Start with the app's own overlays, themes, wallpaper changes, and window layouts. Prototype an optional adapter to Windhawk's 2.0 CLI for curated mods. Detect version and capabilities, pin tested mod versions where practical, save prior settings, and verify each change.

Maintain a small compatibility registry keyed by OS build, architecture, mod, and version. Unknown compatibility must be labeled untested. After an OS update, pause affected mods until checked. Provide a recovery launch mode that skips optional integrations.

[Windhawk's license](https://github.com/ramensoftware/windhawk/blob/main/LICENSE) is GPL-3.0-or-later. Plan original application code and an external integration first. Review actual integration and redistribution obligations before commercial distribution; a separate process alone does not settle licensing questions. Audit individual mods, dependencies, and artwork too.

## Motion and performance

Use a consistent motion language: quick responses to input, slower expansion for spatial changes, subtle breathing only when appropriate, and distinct states for recording and execution. Keep animations interruptible.

Provide reduced motion, transparency fallback, battery saver behavior, fullscreen/game suppression, and a maximum animation quality setting. Stop rendering when hidden; cap background effects; avoid collecting continuous screen context merely to animate.

Initial engineering targets, to measure rather than advertise:

- Smooth interactive motion at 60 fps on the nominated reference laptop.
- Idle CPU averaging below 1% during a defined measurement window with live wallpapers disabled.
- No persistent GPU-heavy loop when the overlay is hidden.
- Separate latency measurements for recording, transcription, model response, tools, and speech playback.
- Track memory by component before setting a release threshold.

## Installation and compatibility

Target Windows 11 x64 first. Add a native ARM64 build and a defined Windows 10 compatibility tier after dependencies and test machines are available. Publish precise minimum builds after the prototype. “Any Windows laptop” means a documented support matrix, not old 32-bit machines, every Windows version, or locked-down corporate devices.

Distribute a normal EXE installer with bundled dependencies and an uninstall path. Offer a ZIP for personal testing where practical. Microsoft documents [self-contained deployment](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/deploy-overview), including separate architecture binaries. A portable app still needs writable settings storage and cannot bypass machine policies.

Normal assistant use should run without administrator rights. Elevation is limited to selected integrations that require it. Secure desktops, UAC prompts, protected games, and unavailable accessibility controls remain boundaries. Some machines will allow the assistant while blocking shell customization.

Reminders can resume after the app restarts. Background routines require the app or a user-session worker to be running. Task Scheduler may relaunch approved routines; a powered-off computer cannot execute them. Sleep wake-up depends on hardware and Windows policy. Define skip/run-on-resume behavior for missed jobs and prevent duplicate execution.

Before public release: sign binaries, verify updater signatures, test interrupted updates and rollback, validate installer/uninstaller behavior, and check antivirus results. Code signing does not guarantee immediate SmartScreen reputation.

## Development agents and $500 credits

Codex handles the brief, architecture, task contracts, integration, review, and release checks in this chat. External Claude workers run locally through Claude Code or Anthropic's Agent SDK and use the Anthropic Console account directly. They are separate processes, not Claude models selected through this chat's built-in subagent tool.

Anthropic's [current model catalog](https://platform.claude.com/docs/en/models/overview) lists the requested IDs: `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`. Check account access through the Models API before starting workers. The [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) supplies a tool-using agent runtime; raw API responses alone do not implement a coding agent.

Suggested roles:

| Role | Worker | Responsibility |
| --- | --- | --- |
| Orchestrator | Codex | Own decisions, contracts, integration, and acceptance |
| Architecture/review | Opus 5.5 | Difficult Windows integration, failure analysis, independent review |
| Implementation | Sonnet 5.5 | Bounded UI, persistence, provider, and tool modules |
| Support work | Haiku 5.5 | Documentation, issue classification, fixtures, repetitive checks |

Start with two independent implementation tasks. Increase to three workers only when interfaces are stable and the pilot shows useful results. Multiple Opus workers are available as a later choice, not the default spending pattern.

Each worker receives one task, acceptance criteria, permitted tools, and its own Git worktree. Give files one owner; combine changes through reviewed commits. Workers return a diff, checks, and unresolved limitations. They cannot approve their own release.

Credentials: use an environment variable supplied locally or a Windows-protected secret store. Do not paste the key into chat. Never print it to check configuration. Give credentials only to the runner that needs them, redact output, and keep development credentials out of the finished product.

Proposed allocation, **not authorization to spend**:

| Work | Credit ceiling |
| --- | ---: |
| Agent runner and small pilot | $10 |
| Native UI/overlay and integration prototypes | $40 |
| Core personal release | $110 |
| Automation and workflows | $80 |
| Customization and animation packs | $70 |
| Review and installer hardening | $40 |
| Reserve for failures and unexpected work | $150 |
| Total | $500 |

Before paid work, configure provider spending controls, run-level token ceilings, bounded retries, and per-task accounting. Reserve the maximum estimated cost before dispatching parallel calls; reconcile actual usage afterward. Estimates must account for output, thinking, cache behavior, and failed runs. Credits may expire or have restrictions; verify those in the Console.

Your pasted [Ori Harness documentation](https://openrouter.ai/docs/guides/ori/harness) says Ori traffic is billed through OpenRouter. It does not establish that Anthropic Console credits can pay that bill. Use direct Anthropic access for this project; revisit OpenRouter only for a specific routing need.

## Build sequence and exit criteria

### 1. Feasibility and design

Produce three visual directions and one native overlay prototype. Test transparency, click-through areas, keyboard focus, mixed DPI, fullscreen behavior, audio capture, and a minimal provider request. Inspect the Windhawk CLI in a disposable test environment.

Exit: choose the host framework with evidence, confirm provider access, and document supported scenarios. Then start the capped agent pilot.

### 2. First installable vertical slice

Deliver an installer that opens an animated island, accepts a protected provider key, takes a text or push-to-talk request, answers a selected screen-region question, launches a chosen app, starts a timer, and records verified tool results. Include cancellation and an offline launcher.

Exit: install and exercise it on a clean machine without development tools. Test lost connectivity, invalid credentials, microphone denial, changing focus, and recovery after a crash.

### 3. Complete personal assistant

Add cleaned dictation, tasks, reminders, editable memory, workspaces, local history, media controls, theme studio, and polished settings. Use it daily and record failures as prioritized issues.

Exit: a repeatable scenario suite passes; data migrations and backup/restore work; routine restart behavior is defined and tested.

### 4. Advanced desktop edition

Add the optional Windhawk adapter, curated preset packs, workflow builder, companion animation, richer scenes, and selected browser/file integrations. Add one integration at a time and verify recovery.

Exit: themes restore prior state; failed multi-step actions report partial completion; incompatible mods are skipped; the core app works with integrations disabled.

### 5. Distribution and paid edition

Expand hardware coverage, create signed installer/update channels, establish support diagnostics, audit dependency licenses, and choose a commercial model. Begin with customer-owned API keys; evaluate managed AI later with explicit pricing and usage economics. Customers never receive your development key.

Exit: fresh install/update/uninstall, secret handling, permission boundaries, accessibility, performance, and licensing checks pass. Use an actual beta before making reliability claims.

No fixed delivery date is proposed yet. Estimate milestone effort after the native overlay, speech, automation, and customization prototypes reveal the real constraints.

## Validation scenarios

- Dictate into supported apps without inserting into a different field when focus changes.
- Select a region on a secondary monitor at a different DPI; preview exactly what leaves the PC.
- Launch a workspace twice without duplicating unwanted windows or timers.
- Restart around a routine's scheduled time without executing it twice.
- Interrupt AI output and a running tool; show the true final state.
- Lose internet during an action; keep local controls available.
- Import a theme without importing credentials; restore previous settings after failure.
- Upgrade Windows or a mod; pause untested integrations without losing the assistant.
- Deny a permission and still complete onboarding with available features.
- Install on a clean x64 machine; later repeat on native ARM64 hardware and the nominated Windows 10 tier.

## Immediate next deliverable

Create an original UI concept for the island, expanded control center, theme studio, and one workspace flow, alongside a native overlay feasibility prototype. This establishes both the visual ambition and the Windows foundation before broad parallel implementation.
