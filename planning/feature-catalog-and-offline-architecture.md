# Feature catalog and offline architecture

13 October 2026 | Planning inventory; no feature is implemented yet.

Extension: [Motion, avatars, usage, and design plan](motion-avatars-usage-and-design-plan.md) adds scopes 121–140. Combined roadmap now contains 140 scopes: 40 foundations, 68 expansion, 32 experimental. The 120 scopes below remain the original base inventory.

120 curated feature scopes: 40 first-release foundations, 60 expansion candidates, 20 experimental/later scopes. This is our deduplicated planning count, not an exhaustive count of every feature in every repository. First-release scope is provisional; prototype results determine effort and cuts. Some scopes include multiple controls. Source labels identify inspiration, not permission to copy code or proof of implementation quality.

## Confirmed architecture

- Finished app: strict offline by default; online mode optional. Development: online tools and Claude API permitted.
- Offline mode: on-device language model, speech recognition, speech output, OCR, embeddings, encrypted local state, native tools. No Claude key required. Models installed/imported beforehand.
- Local API means a loopback endpoint or in-process call on the laptop. Anthropic API means cloud inference: selected prompts, images, and tool results leave the device.
- Cloud calls, feeds, telemetry, automatic updates, remote assets, license check-ins, connectors, web research, and sync are disabled in strict offline mode. No silent cloud fallback. Explicit outbound-tool execution requires online mode.
- Enforce network policy in the execution broker and child-process environment; test with network disabled and observed outbound traffic. A setting label alone is insufficient.
- Local-model reference options: [Ollama](https://docs.ollama.com/faq) with cloud disabled, or [llama.cpp](https://github.com/ggml-org/llama.cpp). Select actual models after Windows/hardware/vision/tool-use benchmarks and license checks.
- This laptop: about 15.4 GB usable RAM, RTX 3050 Laptop GPU with 4 GB VRAM. Start with small quantized models and sequential tasks. Larger contexts/vision can spill into RAM; latency and model quality need measurement. Local models are not promised to equal Claude Opus.
- Default customer product: no account required for offline use. Full settings/onboarding exist even with no API credentials. Commercial activation design must preserve offline operation.

## UI direction

Original desktop island + command palette + full control center. Project capsules organize work, memory, theme, and actions. Settings cover General, Appearance, Motion, Models, Voice, Context, Memory, Workspaces, Automations, Integrations, Privacy, Storage, Diagnostics, Updates. Onboarding tests hardware, imports/selects a local model pack, previews permissions and motion, creates the first capsule, and demonstrates pause/recovery. Start with three visual concepts before committing to the skin.

## Application & onboarding

Reference: Original product requirements; Hitodama; Orchestrator.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 1 | First-run setup wizard | First |
| 2 | Hardware and dependency checks | First |
| 3 | Offline/online mode selection | First |
| 4 | Permission setup and review | First |
| 5 | Main application dashboard | First |
| 6 | Searchable settings | First |
| 7 | Personal profiles and preferences | First |
| 8 | Keyboard and accessibility controls | First |
| 9 | Tray, startup, notification preferences | First |
| 10 | Help, tutorials, diagnostic status | First |

## Local AI & voice

Reference: Ollama; llama.cpp; AnythingLLM; original.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 11 | Local text reasoning | First |
| 12 | Local speech recognition | First |
| 13 | Local speech playback | First |
| 14 | Local model-pack setup and offline import | First |
| 15 | Local vision model support | Expansion |
| 16 | Local embeddings and retrieval | Expansion |
| 17 | Model switching and version pinning | Expansion |
| 18 | CPU/GPU and memory budgets | Expansion |
| 19 | Model download verification and removal | Expansion |
| 20 | Personal model fine-tuning experiments | Experimental |

## Assistant & screen tools

Reference: Hitodama; Textify; original.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 21 | Text chat with streaming | First |
| 22 | Push-to-talk conversation | First |
| 23 | Clean dictation with insertion preview | First |
| 24 | Selected screen-region questions | First |
| 25 | OCR and otherwise unselectable text extraction | Expansion |
| 26 | Translation and app-specific writing tone | Expansion |
| 27 | Approved document explanations | Expansion |
| 28 | Error diagnosis with proposed actions | Expansion |
| 29 | Explicit screen/app context controls | Expansion |
| 30 | Conversation history and export | Expansion |

## Memory & journal

Reference: Meridian; Screenpipe; original independent implementation.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 31 | Explicit project checkpoints | First |
| 32 | Searchable project notes and references | First |
| 33 | Opt-in application session timeline | Expansion |
| 34 | Evidence-backed daily recaps | Expansion |
| 35 | Draft worklog and standup updates | Expansion |
| 36 | Correctable task/session association | Expansion |
| 37 | Memory edit, forget, retention controls | Expansion |
| 38 | Coding-session adapters | Expansion |
| 39 | Continuous screen history | Experimental |
| 40 | Meeting/system-audio capture and summaries | Experimental |

## Projects & workspaces

Reference: PowerToys; Meridian extension; project capsule proposal.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 41 | Project capsules with goals and references | First |
| 42 | Launch apps, files, and URLs together | First |
| 43 | Save and restore supported window geometry | First |
| 44 | Project-specific visual scene | Expansion |
| 45 | Resume recap with source references | Expansion |
| 46 | Cross-project search | Expansion |
| 47 | Browser-profile and tab adapters | Expansion |
| 48 | Portable capsule export with path mapping | Expansion |
| 49 | Deep app-state restoration adapters | Experimental |
| 50 | Spatial project map with historical branches | Experimental |

## Everyday productivity

Reference: Hitodama; HyperLand; HTWind; native APIs.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 51 | Tasks and checklists | First |
| 52 | Reminders and timers | First |
| 53 | Focus sessions with history | First |
| 54 | Quick notes and snippets | Expansion |
| 55 | File shelf with references | Expansion |
| 56 | Optional clipboard history | Expansion |
| 57 | Application launcher and recent items | Expansion |
| 58 | Media and per-app volume controls | Expansion |
| 59 | Calendar view and local calendar import | Expansion |
| 60 | System, battery, and device widgets | Expansion |

## Visuals & motion

Reference: HyperLand; HTWind; Windhawk motion mods; original design.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 61 | Movable expanding desktop island | First |
| 62 | Original color, typography, material themes | First |
| 63 | Interruptible status and panel animations | First |
| 64 | Reduced motion, battery, fullscreen controls | First |
| 65 | Companion with assistant-state animations | Expansion |
| 66 | Audio-reactive waveforms and effects | Expansion |
| 67 | Animated project/scene transitions | Expansion |
| 68 | Widget layout editor and live preview | Expansion |
| 69 | Live wallpaper/shader scenes | Experimental |
| 70 | Physics-driven desktop and window effects | Experimental |

## Windows customization

Reference: Ramen styling guides and official mod sources.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 71 | Curated optional mod catalog | First |
| 72 | Mod version and compatibility checks | First |
| 73 | Taskbar and Start menu presets | Expansion |
| 74 | Explorer and notification presets | Expansion |
| 75 | Save and restore customization settings | Expansion |
| 76 | Advanced window borders, corners, transparency | Experimental |
| 77 | Dock/genie/wobble animation packs | Experimental |
| 78 | Resource and icon redirection packs | Experimental |
| 79 | Virtual-desktop behavior modifications | Experimental |
| 80 | AI-composed validated scene specifications | Experimental |

## Routines & automation

Reference: Hitodama; Orchestrator/harness patterns; original.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 81 | Approved app-launch action tools | First |
| 82 | Durable scheduled routines | First |
| 83 | Visual editable workflow steps | Expansion |
| 84 | Conditions, bounded retries, duplicate prevention | Expansion |
| 85 | Execution results and partial-failure history | Expansion |
| 86 | Cancellation and pause-all controls | Expansion |
| 87 | Undo for explicitly reversible steps | Expansion |
| 88 | Selected file/browser action adapters | Expansion |
| 89 | Watch-once routine recording | Experimental |
| 90 | Cross-app semantic drag-to-action workflows | Experimental |

## Agents & developer tools

Reference: Agent Orchestrator; HarnessRouter; Orkas; harness topic.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 91 | Task board and worker status | Expansion |
| 92 | Isolated project workspaces | Expansion |
| 93 | Model/worker role selection | Expansion |
| 94 | Persistent resumable agent sessions | Expansion |
| 95 | Scoped tools and context policies | Expansion |
| 96 | Agent logs and result inspection | Expansion |
| 97 | Budgets and bounded task execution | Expansion |
| 98 | Local specialist multi-agent execution | Experimental |
| 99 | Animated worker/crew visualization | Experimental |
| 100 | Suggested reusable skills from past runs | Experimental |

## Optional online integrations

Reference: Hitodama; Meridian integrations; harness references.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 101 | Anthropic BYOK provider | Expansion |
| 102 | Additional optional AI providers | Expansion |
| 103 | Web research with cited sources | Expansion |
| 104 | Calendar account connectors | Expansion |
| 105 | Issue-tracker draft export and approved posting | Expansion |
| 106 | Weather/news feed widgets | Expansion |
| 107 | Optional model/update downloads | Expansion |
| 108 | Per-provider data previews and usage history | Expansion |
| 109 | Encrypted cross-device sync | Experimental |
| 110 | Community scene/widget marketplace | Experimental |

## Installation & ownership

Reference: Windows deployment plan; Backup Manager; production requirements.

| ID | Feature scope | Phase |
| --- | --- | --- |
| 111 | Windows installer and uninstaller | First |
| 112 | Bundled runtime and offline installation option | First |
| 113 | Local encrypted sensitive-data storage | First |
| 114 | Export/import and backup recovery | First |
| 115 | Crash recovery and safe launch | First |
| 116 | Network-denial/offline verification | First |
| 117 | Signed updates with rollback | Expansion |
| 118 | Validated x64/ARM64 compatibility tiers | Expansion |
| 119 | Commercial licensing without mandatory cloud check-in | Expansion |
| 120 | Enterprise policy and managed deployment | Experimental |

## Harness selection

[Agent-harness topic](https://github.com/topics/agent-harness) is a discovery catalog, not a package; do not install its 1,500+ projects. Screened the visible page and top 30 metadata results; deeper documentation review of Orchestrator, AnythingLLM, HarnessRouter, Orkas, and Starnet. No claim of auditing the whole topic.

| Reference | Use |
| --- | --- |
| [Agent Orchestrator](https://github.com/OrchestratorInc/agent-orchestrator) | Development supervisor: tasks, isolated workspaces, session state, review visibility. Separate from shipped application. |
| [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) | Local knowledge/RAG and model-setup reference. |
| [HarnessRouter](https://github.com/HarnessRouter/harnessrouter) | Sessions, streams, cancellation, structured errors. Docker-heavy; defer as dependency. |
| [Orkas](https://github.com/Orkas-AI/Orkas) | Commander/worker UI and scoped delegation reference. |
| [Starnet](https://github.com/androoAGI/starnet) | Existing visual-agent-crew reference; animated agents alone are not unique. |

## Release choices

Good additions: offline model/voice setup; full application shell; explicit project checkpoints; resume flow; polished island; practical media/tasks; curated customization; recovery. Later: continuous recording, DWM hooks, live shaders, multi-agent crews, routine recording, marketplace. Online research and account connectors require online mode. Unrestricted shell bridges, blanket copying of repos, and universal state restoration are not initial product promises.

The existing $500 Claude development budget remains a proposed ceiling, not a guarantee that it funds this entire roadmap. No paid agents have started. Choose the first end-to-end capsule demo before assigning broad implementation work.

