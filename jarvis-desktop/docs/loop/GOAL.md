# Product goal and complete feature scope

Owner: SHASH. Snapshot: 15 October 2026. Working name: **Desktop Companion**; choose permanent branding later, never introduce Jarvis branding in the UI. Existing technical identifiers remain compatible.

Build an original installable Windows desktop companion with a complete settings/onboarding/help/recovery experience, rich motion/avatar studios, voice, local AI, optional cloud AI, trusted computer use and integrations. Strict offline default; user explicitly enables online features and supplies credentials. Development itself may use the authorized Anthropic service. Commercial distribution comes after personal validation and license/security review.

## Current evidence, not a completion claim

Latest source check reported by coordinator: **1266 tests passing**. This document does not independently re-run or certify that result. Fresh combined build and Electron smoke now pass: 23 routes, zero renderer errors and zero external requests. Fresh Windows x64 installer build also passed; install/uninstall lifecycle and hardware/account acceptance remain unverified. The source registry currently records 5 verified, 81 partial and 54 planned entries (140 total). Counts are status metadata, not a percentage of production completion. Recheck evidence after every merge; never mark unavailable hardware/account-dependent functionality as implemented or completed merely because it has a placeholder.

## End-to-end requested outcomes

- Install, launch, onboard, work offline, restart, restore/export data, diagnose problems and uninstall cleanly on Windows. State supported architecture/OS and minimum hardware accurately; do not promise every laptop without testing.
- Local chat, voice capture/transcription/speech and optional explicit online providers, with honest model/capability statuses, cancellation and no silent cloud fallback.
- Notes, tasks, calendar, clipboard, searchable memory, routines, workspaces/capsules, widgets and quick commands with working persistence and keyboard paths.
- Expressive original interface, motion graphics, responsive interactions, reduced motion/performance settings, avatar creation/customization/animation and offline asset handling. Motion Lab references are inspiration; importing code/assets requires compatible licensing.
- Trusted, auditable preview/confirm/execute computer actions, exact approved targets, bounded file/app access and safe recovery. Development autopilot does not remove product-side action confirmations.
- Optional browser/Spotify/provider integrations, exposing actual capability boundaries and account setup. A web link is not OAuth or API integration. Protected API keys, privacy controls and usage/budget visibility.
- Windows customization experiments and curated mod discovery subject to actual implementation, licensing and reversibility. Do not copy incompatible third-party code.
- Agent Control Room remains separate development tooling: real model/task/activity reporting, task controls and accurate stop reasons; no invented activity, hidden reasoning or progress percentages.

## Scope authority

`src/shared/feature-registry.json` entries 1–140 are the complete feature inventory. `docs/product-roadmap.md`, `docs/architecture.md`, and `docs/acceptance.md` define behavior and acceptance. This snapshot preserves every item; the planner may sequence it but must not silently delete/relabel backlog items to claim success. Every entry needs implemented paths, integration status, tests, runtime evidence or an explicit remaining external gate.

| ID | Feature | Category | Recorded state | Integration |
|---|---|---|---|---|
| 1 | First-run setup wizard | Application & onboarding | partial | integrated |
| 2 | Hardware and dependency checks | Application & onboarding | verified | runtime-verified |
| 3 | Offline/online mode selection | Application & onboarding | verified | runtime-verified |
| 4 | Permission setup and review | Application & onboarding | partial | integrated |
| 5 | Main application dashboard | Application & onboarding | partial | integrated |
| 6 | Searchable settings | Application & onboarding | partial | integrated |
| 7 | Personal profiles and preferences | Application & onboarding | partial | integrated |
| 8 | Keyboard and accessibility controls | Application & onboarding | partial | integrated |
| 9 | Tray, startup, notification preferences | Application & onboarding | partial | integrated |
| 10 | Help, tutorials, diagnostic status | Application & onboarding | partial | integrated |
| 11 | Local text reasoning | Local AI & voice | partial | integrated |
| 12 | Local speech recognition | Local AI & voice | partial | integrated |
| 13 | Local speech playback | Local AI & voice | partial | integrated |
| 14 | Local model-pack setup and offline import | Local AI & voice | partial | integrated |
| 15 | Local vision model support | Local AI & voice | planned | none |
| 16 | Local embeddings and retrieval | Local AI & voice | planned | none |
| 17 | Model switching and version pinning | Local AI & voice | partial | integrated |
| 18 | CPU/GPU and memory budgets | Local AI & voice | partial | integrated |
| 19 | Model download verification and removal | Local AI & voice | partial | integrated |
| 20 | Personal model fine-tuning experiments | Local AI & voice | planned | none |
| 21 | Text chat with streaming | Assistant & screen tools | partial | integrated |
| 22 | Push-to-talk conversation | Assistant & screen tools | partial | integrated |
| 23 | Clean dictation with insertion preview | Assistant & screen tools | partial | integrated |
| 24 | Selected screen-region questions | Assistant & screen tools | planned | none |
| 25 | OCR and otherwise unselectable text extraction | Assistant & screen tools | partial | integrated |
| 26 | Translation and app-specific writing tone | Assistant & screen tools | planned | none |
| 27 | Approved document explanations | Assistant & screen tools | planned | none |
| 28 | Error diagnosis with proposed actions | Assistant & screen tools | planned | none |
| 29 | Explicit screen/app context controls | Assistant & screen tools | planned | none |
| 30 | Conversation history and export | Assistant & screen tools | partial | integrated |
| 31 | Explicit project checkpoints | Memory & journal | partial | integrated |
| 32 | Searchable project notes and references | Memory & journal | partial | integrated |
| 33 | Opt-in application session timeline | Memory & journal | partial | integrated |
| 34 | Evidence-backed daily recaps | Memory & journal | partial | module-tested |
| 35 | Draft worklog and standup updates | Memory & journal | planned | none |
| 36 | Correctable task/session association | Memory & journal | partial | integrated |
| 37 | Memory edit, forget, retention controls | Memory & journal | partial | integrated |
| 38 | Coding-session adapters | Memory & journal | planned | none |
| 39 | Continuous screen history | Memory & journal | planned | none |
| 40 | Meeting/system-audio capture and summaries | Memory & journal | planned | none |
| 41 | Project capsules with goals and references | Projects & workspaces | partial | integrated |
| 42 | Launch apps, files, and URLs together | Projects & workspaces | partial | integrated |
| 43 | Save and restore supported window geometry | Projects & workspaces | partial | integrated |
| 44 | Project-specific visual scene | Projects & workspaces | partial | integrated |
| 45 | Resume recap with source references | Projects & workspaces | partial | integrated |
| 46 | Cross-project search | Projects & workspaces | verified | integrated |
| 47 | Browser-profile and tab adapters | Projects & workspaces | planned | none |
| 48 | Portable capsule export with path mapping | Projects & workspaces | partial | integrated |
| 49 | Deep app-state restoration adapters | Projects & workspaces | planned | none |
| 50 | Spatial project map with historical branches | Projects & workspaces | planned | none |
| 51 | Tasks and checklists | Everyday productivity | verified | runtime-verified |
| 52 | Reminders and timers | Everyday productivity | partial | integrated |
| 53 | Focus sessions with history | Everyday productivity | partial | integrated |
| 54 | Quick notes and snippets | Everyday productivity | partial | integrated |
| 55 | File shelf with references | Everyday productivity | partial | integrated |
| 56 | Optional clipboard history | Everyday productivity | partial | integrated |
| 57 | Application launcher and recent items | Everyday productivity | partial | integrated |
| 58 | Media and per-app volume controls | Everyday productivity | planned | none |
| 59 | Calendar view and local calendar import | Everyday productivity | partial | integrated |
| 60 | System, battery, and device widgets | Everyday productivity | partial | integrated |
| 61 | Movable expanding desktop island | Visuals & motion | planned | none |
| 62 | Original color, typography, material themes | Visuals & motion | partial | integrated |
| 63 | Interruptible status and panel animations | Visuals & motion | partial | integrated |
| 64 | Reduced motion, battery, fullscreen controls | Visuals & motion | partial | integrated |
| 65 | Companion with assistant-state animations | Visuals & motion | partial | integrated |
| 66 | Audio-reactive waveforms and effects | Visuals & motion | partial | integrated |
| 67 | Animated project/scene transitions | Visuals & motion | partial | integrated |
| 68 | Widget layout editor and live preview | Visuals & motion | partial | integrated |
| 69 | Live wallpaper/shader scenes | Visuals & motion | planned | none |
| 70 | Physics-driven desktop and window effects | Visuals & motion | planned | none |
| 71 | Curated optional mod catalog | Windows customization | partial | module-tested |
| 72 | Mod version and compatibility checks | Windows customization | partial | module-tested |
| 73 | Taskbar and Start menu presets | Windows customization | planned | none |
| 74 | Explorer and notification presets | Windows customization | planned | none |
| 75 | Save and restore customization settings | Windows customization | partial | module-tested |
| 76 | Advanced window borders, corners, transparency | Windows customization | planned | none |
| 77 | Dock/genie/wobble animation packs | Windows customization | planned | none |
| 78 | Resource and icon redirection packs | Windows customization | planned | none |
| 79 | Virtual-desktop behavior modifications | Windows customization | planned | none |
| 80 | AI-composed validated scene specifications | Windows customization | planned | none |
| 81 | Approved app-launch action tools | Routines & automation | partial | integrated |
| 82 | Durable scheduled routines | Routines & automation | partial | integrated |
| 83 | Visual editable workflow steps | Routines & automation | partial | integrated |
| 84 | Conditions, bounded retries, duplicate prevention | Routines & automation | partial | integrated |
| 85 | Execution results and partial-failure history | Routines & automation | partial | integrated |
| 86 | Cancellation and pause-all controls | Routines & automation | partial | integrated |
| 87 | Undo for explicitly reversible steps | Routines & automation | partial | integrated |
| 88 | Selected file/browser action adapters | Routines & automation | partial | integrated |
| 89 | Watch-once routine recording | Routines & automation | planned | none |
| 90 | Cross-app semantic drag-to-action workflows | Routines & automation | planned | none |
| 91 | Task board and worker status | Agents & developer tools | planned | none |
| 92 | Isolated project workspaces | Agents & developer tools | planned | none |
| 93 | Model/worker role selection | Agents & developer tools | planned | none |
| 94 | Persistent resumable agent sessions | Agents & developer tools | planned | none |
| 95 | Scoped tools and context policies | Agents & developer tools | planned | none |
| 96 | Agent logs and result inspection | Agents & developer tools | planned | none |
| 97 | Budgets and bounded task execution | Agents & developer tools | planned | none |
| 98 | Local specialist multi-agent execution | Agents & developer tools | planned | none |
| 99 | Animated worker/crew visualization | Agents & developer tools | planned | none |
| 100 | Suggested reusable skills from past runs | Agents & developer tools | planned | none |
| 101 | Anthropic BYOK provider | Optional online integrations | partial | integrated |
| 102 | Additional optional AI providers | Optional online integrations | partial | integrated |
| 103 | Web research with cited sources | Optional online integrations | planned | none |
| 104 | Calendar account connectors | Optional online integrations | planned | none |
| 105 | Issue-tracker draft export and approved posting | Optional online integrations | partial | integrated |
| 106 | Weather/news feed widgets | Optional online integrations | planned | none |
| 107 | Optional model/update downloads | Optional online integrations | planned | none |
| 108 | Per-provider data previews and usage history | Optional online integrations | partial | integrated |
| 109 | Encrypted cross-device sync | Optional online integrations | planned | none |
| 110 | Community scene/widget marketplace | Optional online integrations | planned | none |
| 111 | Windows installer and uninstaller | Installation & ownership | partial | integrated |
| 112 | Bundled runtime and offline installation option | Installation & ownership | planned | none |
| 113 | Local encrypted sensitive-data storage | Installation & ownership | partial | integrated |
| 114 | Export/import and backup recovery | Installation & ownership | partial | integrated |
| 115 | Crash recovery and safe launch | Installation & ownership | partial | integrated |
| 116 | Network-denial/offline verification | Installation & ownership | verified | integrated |
| 117 | Signed updates with rollback | Installation & ownership | planned | none |
| 118 | Validated x64/ARM64 compatibility tiers | Installation & ownership | planned | none |
| 119 | Commercial licensing without mandatory cloud check-in | Installation & ownership | planned | none |
| 120 | Enterprise policy and managed deployment | Installation & ownership | planned | none |
| 121 | Unified usage dashboard | Usage dashboard | partial | integrated |
| 122 | Supported provider quota/balance adapters | Usage dashboard | planned | none |
| 123 | Reset countdown and stale-data indicators | Usage dashboard | partial | integrated |
| 124 | Local token and estimated cost ledger | Usage dashboard | partial | integrated |
| 125 | Project/worker cost attribution | Usage dashboard | partial | integrated |
| 126 | Budget pace and threshold alerts | Usage dashboard | partial | integrated |
| 127 | Local inference performance history | Usage dashboard | partial | integrated |
| 128 | Usage report export | Usage dashboard | partial | integrated |
| 129 | 2D avatar geometry editor | Avatar studio | partial | integrated |
| 130 | Expression authoring library | Avatar studio | partial | integrated |
| 131 | Avatar animation timeline editor | Avatar studio | partial | integrated |
| 132 | Portable avatar pack import/export | Avatar studio | partial | integrated |
| 133 | 3D avatar/model customization | Avatar studio | planned | none |
| 134 | Voice-driven avatar mouth/pose states | Avatar studio | partial | integrated |
| 135 | Realistic portrait animation adapter | Avatar studio | planned | none |
| 136 | Avatar quality/hardware profile manager | Avatar studio | partial | integrated |
| 137 | Procedural motion scene editor | Motion studio | partial | integrated |
| 138 | Original scene/template library | Motion studio | partial | integrated |
| 139 | AI-to-validated-scene generation | Motion studio | planned | none |
| 140 | Local animation/clip export | Motion studio | planned | none |

## Experimental gates

All registry gate pass criteria must retain their evidence and limitations. Operator hardware/account/signing steps may be deferred with a precise handoff; that is a partial product outcome, not full completion.

- **G1: Overlay** — Transparent, frameless, always-on-top Electron island on Win11 at 100/150/200% DPI, multi-monitor, fullscreen-app detection Recorded state: not-recorded; dependent feature IDs: 61, 63, 65, 66, 67. Exact acceptance threshold remains authoritative in the registry.
- **G2: Local model sizing** — Which Ollama models run on 8/16 GB RAM, no GPU Recorded state: not-recorded; dependent feature IDs: 11, 15, 16, 17, 18, 19. Exact acceptance threshold remains authoritative in the registry.
- **G3: Local ASR upgrade** — Permissively licensed Whisper-class runtime, bundled or imported offline Recorded state: not-recorded; dependent feature IDs: 12, 23, 40. Exact acceptance threshold remains authoritative in the registry.
- **G4: Input injection** — Reliable click/type-text across Win32/UWP/Chromium apps Recorded state: not-recorded; dependent feature IDs: 88, 89, 90. Exact acceptance threshold remains authoritative in the registry.
- **G5: Windows mods** — Licence and safety of each third-party mod (Windhawk-style mods are often GPL) Recorded state: not-recorded; dependent feature IDs: 71, 72, 73, 74, 75, 76, 77, 78, 79, 80. Exact acceptance threshold remains authoritative in the registry.
- **G6: Screen capture** — desktopCapturer region capture + local OCR (Windows.Media.Ocr via WinRT) Recorded state: not-recorded; dependent feature IDs: 24, 25, 29, 39, 40. Exact acceptance threshold remains authoritative in the registry.
- **G7: Avatars/motion** — Renderer cost of 2D/3D avatar and motion scenes Recorded state: not-recorded; dependent feature IDs: 69, 70, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140. Exact acceptance threshold remains authoritative in the registry.
- **G8: Signing** — Code-signing certificate and update channel Recorded state: not-recorded; dependent feature IDs: 117. Exact acceptance threshold remains authoritative in the registry.

