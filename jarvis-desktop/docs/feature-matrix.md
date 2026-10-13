# Feature matrix — Desktop Companion

Desktop Companion is the temporary user-facing name. The technical name `jarvis-desktop` and existing identifiers stay unchanged.

Source: [product roadmap](product-roadmap.md) (140 numbered scopes, 13 October 2026). Machine-readable copy: `src/shared/feature-registry.json`. Gate definitions: [architecture §10](architecture.md#10-feasibility-and-experimental-gates).

**Status: every scope is `planned`. No scope is implemented.** Nothing in this matrix is inferred as built. A `planned` entry means the scope is on the roadmap; it does not mean code exists.

## Counts

| Tier | Count | Meaning |
|---|---|---|
| First | 40 | First personal release |
| Expansion | 68 | Later release; designed hook only |
| Experimental | 32 | Ships only behind a gate |

- 46 scopes list at least one gate.
- 9 Experimental scopes have no gate defined in architecture §10 (20, 49, 50, 98, 99, 100, 109, 110, 120). Each needs a written gate before any work.
- All 8 gates (G1–G8) are `not-recorded`. Architecture §10 requires each gate to be a written benchmark or licence result in `docs/`. No such document exists yet.

## Gates

| Gate | Question | Pass criteria | Scopes |
|---|---|---|---|
| G1 Overlay | Transparent, frameless, always-on-top island on Win11 at 100/150/200% DPI, multi-monitor, fullscreen detection | Expand/collapse ≤ 150 ms, no focus stealing, idle delta ≤ 40 MB | 61, 63, 65, 66, 67 |
| G2 Local model sizing | Which Ollama models run on 8/16 GB RAM, no GPU | First token ≤ 5 s, ≥ 5 tok/s on reference laptop | 11, 15–19 |
| G3 Local ASR upgrade | Permissively licensed Whisper-class runtime, bundled or imported offline | WER better than System.Speech on test set; MIT/Apache/BSD licence | 12, 23, 40 |
| G4 Input injection | Reliable click/type-text across Win32/UWP/Chromium apps | ≥ 95% on fixture matrix; never into elevated or password targets | 88–90 |
| G5 Windows mods | Licence and safety of each third-party mod | Catalog links or launches external tools only; no bundled GPL code; reversible | 71–80 |
| G6 Screen capture | `desktopCapturer` region capture and local OCR | Opt-in per capture; nothing stored by default | 24, 25, 29, 39, 40 |
| G7 Avatars/motion | Renderer cost of 2D/3D avatar and motion scenes | Within architecture §8 budget when idle; off by default | 69, 70, 129–140 |
| G8 Signing | Code-signing certificate and update channel | Signed NSIS, verified update, rollback | 117 (and public beta) |

## Conflicts and gaps for root review

- **Scope 23 gate.** Architecture §10 lists G3 as blocking, but §11 plans System.Speech dictation for first release. The registry follows §10. Root should confirm which path ships.
- **Scope 40 gates.** §10 lists G3, §11 lists G6. The registry lists both.
- **Experimental without gates.** Scopes 20, 49, 50, 98, 99, 100, 109, 110 and 120 have no gate. Acceptance N3 keeps agents (91–100) absent or experimental until a gate document exists.
- **Missing references.** `integrations-hub-plan.md` and the three research documents linked from the roadmap are not in this repository. Scopes 101–110 are marked `requires: online mode` from the roadmap text, not from a document.
- **UI status mismatch.** `src/ui/roadmap.ts` marks 21 scopes as `ui` (an interface exists): 1, 2, 3, 4, 5, 9, 11, 13, 21, 22, 32, 41, 42, 51, 54, 62, 64, 65, 81, 101, 114. This matrix keeps all of them `planned`, as the roadmap says no features are implemented. Root should decide whether the UI label means "interface only" and how to show it here.

## Scopes

Columns: **#** scope number · **Tier** · **Status** · **Gates** · **Notes**.

### Application & onboarding

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 1 | First-run setup wizard | First | planned | — | |
| 2 | Hardware and dependency checks | First | planned | — | |
| 3 | Offline/online mode selection | First | planned | — | |
| 4 | Permission setup and review | First | planned | — | |
| 5 | Main application dashboard | First | planned | — | |
| 6 | Searchable settings | First | planned | — | |
| 7 | Personal profiles and preferences | First | planned | — | |
| 8 | Keyboard and accessibility controls | First | planned | — | |
| 9 | Tray, startup, notification preferences | First | planned | — | |
| 10 | Help, tutorials, diagnostic status | First | planned | — | |

### Local AI & voice

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 11 | Local text reasoning | First | planned | G2 | G2 sets the default model choice and sizing. |
| 12 | Local speech recognition | First | planned | G3 | G3 gates the ASR upgrade; the System.Speech baseline is first release. |
| 13 | Local speech playback | First | planned | — | |
| 14 | Local model-pack setup and offline import | First | planned | — | |
| 15 | Local vision model support | Expansion | planned | G2 | |
| 16 | Local embeddings and retrieval | Expansion | planned | G2 | |
| 17 | Model switching and version pinning | Expansion | planned | G2 | |
| 18 | CPU/GPU and memory budgets | Expansion | planned | G2 | |
| 19 | Model download verification and removal | Expansion | planned | G2 | |
| 20 | Personal model fine-tuning experiments | Experimental | planned | — | No gate defined. Needs a written gate before any work. |

### Assistant & screen tools

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 21 | Text chat with streaming | First | planned | — | Contract has no streaming method; first release ships non-streaming. |
| 22 | Push-to-talk conversation | First | planned | — | |
| 23 | Clean dictation with insertion preview | First | planned | G3 | §10 lists G3; §11 plans System.Speech first. Confirm which path ships. |
| 24 | Selected screen-region questions | First | planned | G6 | |
| 25 | OCR and otherwise unselectable text extraction | Expansion | planned | G6 | |
| 26 | Translation and app-specific writing tone | Expansion | planned | — | |
| 27 | Approved document explanations | Expansion | planned | — | |
| 28 | Error diagnosis with proposed actions | Expansion | planned | — | |
| 29 | Explicit screen/app context controls | Expansion | planned | G6 | |
| 30 | Conversation history and export | Expansion | planned | — | |

### Memory & journal

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 31 | Explicit project checkpoints | First | planned | — | |
| 32 | Searchable project notes and references | First | planned | — | |
| 33 | Opt-in application session timeline | Expansion | planned | — | |
| 34 | Evidence-backed daily recaps | Expansion | planned | — | |
| 35 | Draft worklog and standup updates | Expansion | planned | — | |
| 36 | Correctable task/session association | Expansion | planned | — | |
| 37 | Memory edit, forget, retention controls | Expansion | planned | — | |
| 38 | Coding-session adapters | Expansion | planned | — | |
| 39 | Continuous screen history | Experimental | planned | G6 | |
| 40 | Meeting/system-audio capture and summaries | Experimental | planned | G3, G6 | §10 lists G3, §11 lists G6. Both apply until the owner confirms. |

### Projects & workspaces

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 41 | Project capsules with goals and references | First | planned | — | |
| 42 | Launch apps, files, and URLs together | First | planned | — | |
| 43 | Save and restore supported window geometry | First | planned | — | |
| 44 | Project-specific visual scene | Expansion | planned | — | |
| 45 | Resume recap with source references | Expansion | planned | — | |
| 46 | Cross-project search | Expansion | planned | — | |
| 47 | Browser-profile and tab adapters | Expansion | planned | — | |
| 48 | Portable capsule export with path mapping | Expansion | planned | — | |
| 49 | Deep app-state restoration adapters | Experimental | planned | — | No gate defined. Needs a written gate before any work. |
| 50 | Spatial project map with historical branches | Experimental | planned | — | No gate defined. Needs a written gate before any work. |

### Everyday productivity

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 51 | Tasks and checklists | First | planned | — | |
| 52 | Reminders and timers | First | planned | — | |
| 53 | Focus sessions with history | First | planned | — | |
| 54 | Quick notes and snippets | Expansion | planned | — | |
| 55 | File shelf with references | Expansion | planned | — | |
| 56 | Optional clipboard history | Expansion | planned | — | |
| 57 | Application launcher and recent items | Expansion | planned | — | |
| 58 | Media and per-app volume controls | Expansion | planned | — | |
| 59 | Calendar view and local calendar import | Expansion | planned | — | |
| 60 | System, battery, and device widgets | Expansion | planned | — | |

### Visuals & motion

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 61 | Movable expanding desktop island | First | planned | G1 | If G1 fails, the panel stays in the main window. |
| 62 | Original color, typography, material themes | First | planned | — | |
| 63 | Interruptible status and panel animations | First | planned | G1 | |
| 64 | Reduced motion, battery, fullscreen controls | First | planned | — | |
| 65 | Companion with assistant-state animations | Expansion | planned | G1 | |
| 66 | Audio-reactive waveforms and effects | Expansion | planned | G1 | |
| 67 | Animated project/scene transitions | Expansion | planned | G1 | |
| 68 | Widget layout editor and live preview | Expansion | planned | — | |
| 69 | Live wallpaper/shader scenes | Experimental | planned | G7 | |
| 70 | Physics-driven desktop and window effects | Experimental | planned | G7 | |

### Windows customization

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 71 | Curated optional mod catalog | First | planned | G5 | First release is a read-only catalog of external tools only. |
| 72 | Mod version and compatibility checks | First | planned | G5 | |
| 73 | Taskbar and Start menu presets | Expansion | planned | G5 | |
| 74 | Explorer and notification presets | Expansion | planned | G5 | |
| 75 | Save and restore customization settings | Expansion | planned | G5 | |
| 76 | Advanced window borders, corners, transparency | Experimental | planned | G5 | |
| 77 | Dock/genie/wobble animation packs | Experimental | planned | G5 | |
| 78 | Resource and icon redirection packs | Experimental | planned | G5 | |
| 79 | Virtual-desktop behavior modifications | Experimental | planned | G5 | |
| 80 | AI-composed validated scene specifications | Experimental | planned | G5 | |

### Routines & automation

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 81 | Approved app-launch action tools | First | planned | — | |
| 82 | Durable scheduled routines | First | planned | — | |
| 83 | Visual editable workflow steps | Expansion | planned | — | |
| 84 | Conditions, bounded retries, duplicate prevention | Expansion | planned | — | |
| 85 | Execution results and partial-failure history | Expansion | planned | — | |
| 86 | Cancellation and pause-all controls | Expansion | planned | — | |
| 87 | Undo for explicitly reversible steps | Expansion | planned | — | |
| 88 | Selected file/browser action adapters | Expansion | planned | G4 | |
| 89 | Watch-once routine recording | Experimental | planned | G4 | |
| 90 | Cross-app semantic drag-to-action workflows | Experimental | planned | G4 | |

### Agents & developer tools

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 91 | Task board and worker status | Expansion | planned | — | Acceptance N3 keeps agents absent or experimental until a gate document exists. |
| 92 | Isolated project workspaces | Expansion | planned | — | Same as 91. |
| 93 | Model/worker role selection | Expansion | planned | — | Same as 91. |
| 94 | Persistent resumable agent sessions | Expansion | planned | — | Same as 91. |
| 95 | Scoped tools and context policies | Expansion | planned | — | Same as 91. |
| 96 | Agent logs and result inspection | Expansion | planned | — | Same as 91. |
| 97 | Budgets and bounded task execution | Expansion | planned | — | Same as 91. |
| 98 | Local specialist multi-agent execution | Experimental | planned | — | No gate defined. Same as 91. |
| 99 | Animated worker/crew visualization | Experimental | planned | — | No gate defined. Same as 91. |
| 100 | Suggested reusable skills from past runs | Experimental | planned | — | No gate defined. Same as 91. |

### Optional online integrations

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 101 | Anthropic BYOK provider | Expansion | planned | — | Requires online mode and a customer-owned key. |
| 102 | Additional optional AI providers | Expansion | planned | — | Requires online mode. |
| 103 | Web research with cited sources | Expansion | planned | — | Requires online mode. |
| 104 | Calendar account connectors | Expansion | planned | — | Requires online mode. |
| 105 | Issue-tracker draft export and approved posting | Expansion | planned | — | Requires online mode. |
| 106 | Weather/news feed widgets | Expansion | planned | — | Requires online mode. |
| 107 | Optional model/update downloads | Expansion | planned | — | Requires online mode. |
| 108 | Per-provider data previews and usage history | Expansion | planned | — | Requires online mode. |
| 109 | Encrypted cross-device sync | Experimental | planned | — | Requires online mode. No gate defined. |
| 110 | Community scene/widget marketplace | Experimental | planned | — | Requires online mode. No gate defined. |

### Installation & ownership

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 111 | Windows installer and uninstaller | First | planned | — | |
| 112 | Bundled runtime and offline installation option | First | planned | — | Ollama and model packs install separately from the app. |
| 113 | Local encrypted sensitive-data storage | First | planned | — | |
| 114 | Export/import and backup recovery | First | planned | — | |
| 115 | Crash recovery and safe launch | First | planned | — | |
| 116 | Network-denial/offline verification | First | planned | — | |
| 117 | Signed updates with rollback | Expansion | planned | G8 | |
| 118 | Validated x64/ARM64 compatibility tiers | Expansion | planned | — | |
| 119 | Commercial licensing without mandatory cloud check-in | Expansion | planned | — | |
| 120 | Enterprise policy and managed deployment | Experimental | planned | — | No gate defined. Needs a written gate before any work. |

### Usage dashboard

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 121 | Unified usage dashboard | Expansion | planned | — | |
| 122 | Supported provider quota/balance adapters | Expansion | planned | — | |
| 123 | Reset countdown and stale-data indicators | Expansion | planned | — | |
| 124 | Local token and estimated cost ledger | Expansion | planned | — | |
| 125 | Project/worker cost attribution | Expansion | planned | — | |
| 126 | Budget pace and threshold alerts | Expansion | planned | — | |
| 127 | Local inference performance history | Expansion | planned | — | |
| 128 | Usage report export | Expansion | planned | — | |

### Avatar studio

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 129 | 2D avatar geometry editor | Experimental | planned | G7 | |
| 130 | Expression authoring library | Experimental | planned | G7 | |
| 131 | Avatar animation timeline editor | Experimental | planned | G7 | |
| 132 | Portable avatar pack import/export | Experimental | planned | G7 | |
| 133 | 3D avatar/model customization | Experimental | planned | G7 | |
| 134 | Voice-driven avatar mouth/pose states | Experimental | planned | G7 | |
| 135 | Realistic portrait animation adapter | Experimental | planned | G7 | |
| 136 | Avatar quality/hardware profile manager | Experimental | planned | G7 | |

### Motion studio

| # | Scope | Tier | Status | Gates | Notes |
|---|---|---|---|---|---|
| 137 | Procedural motion scene editor | Experimental | planned | G7 | |
| 138 | Original scene/template library | Experimental | planned | G7 | |
| 139 | AI-to-validated-scene generation | Experimental | planned | G7 | |
| 140 | Local animation/clip export | Experimental | planned | G7 | |
