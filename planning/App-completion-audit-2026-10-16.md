# App implementation audit — 16 October 2026

**60.4% weighted implementation coverage; not fully released or complete.** All 140 requirements retained. Baseline full audit plus evidence-based review of accepted changes through round40.

| Classification | Count | Credit |
|---|---:|---:|
| working | 48 | 100% |
| unverified | 22 | 75% |
| partial | 34 | 50% |
| preview | 12 | 25% |
| missing | 24 | 0% |

Calculation: 84.5/140 weighted points. Decimal reflects the rubric, not exact engineering progress. Latest independently verified software suite: **1686 passed**, plus build and offline smoke. Live provider/account and hardware acceptance are separate.

New accepted capabilities include named profiles, dedicated file shelf, correctable memory associations, dictation cleanup, document explanation, calendar export, battery state, interruptible animations, primary-state encryption and reminder-resume fixes. Encryption remains partial: productivity sidecar and renderer preferences are still plaintext.

OpenAI and OpenRouter now have actual guarded generation adapters and separate protected keys alongside Anthropic. Full tests/build/offline smoke passed; live provider acceptance is still unverified.

## Remaining release blockers

- Installed-product autonomous worker execution
- Real OAuth account connections and provider registrations
- Local vision, embeddings and verified model/runtime installation
- Applied Windows customization
- Remaining plaintext productivity/preferences storage
- Clean-machine installer lifecycle, signing/update rollback and hardware acceptance

## All requirements

| ID | Feature | Classification | Remaining gap / qualification |
|---|---|---|---|
| 1 | First-run setup wizard | working | Wizard implemented; no clean-machine acceptance claimed. |
| 2 | Hardware and dependency checks | working | Checks are implemented; dependency installation is a different feature. |
| 3 | Offline/online mode selection | working | Online requires explicit user mode/key/start. |
| 4 | Permission setup and review | working | Software permission flow tested; OS-specific approval acceptance is separate. |
| 5 | Main application dashboard | working | Functional dashboard, not a final visual-design acceptance. |
| 6 | Searchable settings | working | Search indexes section metadata, not arbitrary field contents. |
| 7 | Personal profiles and preferences | working | Named/switchable personal profiles close the previous named gap. Profiles are preference presets, not separate authentication identities. |
| 8 | Keyboard and accessibility controls | working | Controls implemented; no claim of full screen-reader certification. |
| 9 | Tray, startup, notification preferences | partial | Complete login-startup/notification preference integration and Windows acceptance not established |
| 10 | Help, tutorials, diagnostic status | working | Help/tour/status now exist, unlike stale registry limitation. |
| 11 | Local text reasoning | unverified | G2 reference-laptop latency/throughput and 8/16GB sizing acceptance |
| 12 | Local speech recognition | partial | No newly installed/bundled verified neural ASR engine pack or G3 WER/license acceptance. |
| 13 | Local speech playback | unverified | Audible playback acceptance on target Windows hardware |
| 14 | Local model-pack setup and offline import | unverified | Real GGUF pack import/runtime acceptance and hardware sizing |
| 15 | Local vision model support | missing | No local image-input pipeline or registered vision adapter; G2 open |
| 16 | Local embeddings and retrieval | partial | Local embedding generation/vector retrieval absent; G2 open |
| 17 | Model switching and version pinning | partial | No version/digest pinning workflow; G2 sizing unrecorded |
| 18 | CPU/GPU and memory budgets | partial | Measured/enforced OS CPU/GPU/RAM limits and reference-laptop G2 validation |
| 19 | Model download verification and removal | unverified | Actual model download/removal and G2 reference-hardware acceptance |
| 20 | Personal model fine-tuning experiments | partial | Training execution, adapter loading and resulting-model evaluation absent |
| 21 | Text chat with streaming | working | Unchanged working streaming chat; new callers do not constitute an additional complete feature. |
| 22 | Push-to-talk conversation | unverified | Physical microphone and recognition conversation acceptance |
| 23 | Clean dictation with insertion preview | partial | Cross-application insertion workflow is not implemented/verified by this slice.; Neural speech accuracy/G3 acceptance remains unrecorded; deterministic rules can alter legitimate spoken words, disclosed in source. |
| 24 | Selected screen-region questions | missing | Screen-region selection/capture and visual question routing; G6 open |
| 25 | OCR and otherwise unselectable text extraction | unverified | Real Windows image OCR and G6 acceptance; screen capture absent |
| 26 | Translation and app-specific writing tone | working | Manual destination profile choice; real configured model route used, cloud accepted response not verified. round29delta: rewrite/summarize/translate now have focused guarded AI request runner, preview and result insertion; provider tests use fixtures. |
| 27 | Approved document explanations | working | Unchanged working approved text/Markdown explanations; stronger direct generation workflow. PDF/Word support not claimed. |
| 28 | Error diagnosis with proposed actions | partial | Diagnosis remains a bounded rule-based checker; no general model-backed diagnostic reasoning.; Real native Windows fixture-matrix execution remains unverified. |
| 29 | Explicit screen/app context controls | preview | No actual screen/app context capture/source bridge; G6 open |
| 30 | Conversation history and export | working | Now separate history/export UI; stale whole-state-only limitation superseded. |
| 31 | Explicit project checkpoints | working | Explicitly saved project checkpoints, no automatic capture claimed. |
| 32 | Searchable project notes and references | working | Local stored project notes/references searchable. round29delta: notes-grounded AI Q&A added alongside functional project search; note selection and destination preview explicit; cloud-provider response not independently accepted. |
| 33 | Opt-in application session timeline | partial | Still no live OS application-session reporting/capture source. |
| 34 | Evidence-backed daily recaps | working | Evidence-only local daily recap now reachable. |
| 35 | Draft worklog and standup updates | working | Deterministic draft from real records, no invented automatic observations. |
| 36 | Correctable task/session association | working | Mounted correction workflow closes gap for existing recorded timeline/focus sessions. Automatic OS session capture remains feature33 gap, not required to correct an existing session record. |
| 37 | Memory edit, forget, retention controls | working | Record editing/deletion plus scope forgetting and retention implemented. |
| 38 | Coding-session adapters | partial | Live IDE/coding-tool session adapters absent |
| 39 | Continuous screen history | missing | Continuous screen recording/history pipeline and G6 consent/retention acceptance |
| 40 | Meeting/system-audio capture and summaries | missing | Meeting/system-audio loopback capture and summary session workflow; G3/G6 acceptance |
| 41 | Project capsules with goals and references | working | Named goals/references now present; stale registry contradicted. |
| 42 | Launch apps, files, and URLs together | unverified | Real multi-item launch acceptance across Windows apps/files/URLs |
| 43 | Save and restore supported window geometry | unverified | Real geometry save/restore/DPI/multi-monitor matrix acceptance |
| 44 | Project-specific visual scene | partial | No established project-resume scene application pipeline |
| 45 | Resume recap with source references | working | Evidence recap derived from saved project data; no automatic external context. |
| 46 | Cross-project search | working | App-owned records only; not unrestricted disk indexing. |
| 47 | Browser-profile and tab adapters | partial | Live browser-profile/tab-reading/restoration adapter absent |
| 48 | Portable capsule export with path mapping | unverified | Packaged file-picker/export/import round trip on target Windows |
| 49 | Deep app-state restoration adapters | missing | Deep app-specific document/cursor/editor/tab state restoration adapters |
| 50 | Spatial project map with historical branches | partial | Historical branching graph/branch creation or restoration absent |
| 51 | Tasks and checklists | working | Functional flat checklist; nested subtasks are not part of this feature name. |
| 52 | Reminders and timers | unverified | Real Windows notification/timer delivery across sleep/restart not established by current source audit |
| 53 | Focus sessions with history | working | Provider comment says it does not record history itself; mounted Tasks observer does record it. |
| 54 | Quick notes and snippets | working | Actual saved notes/snippets and insertion workflow. |
| 55 | File shelf with references | working | Dedicated shelf add/edit/list closes old gap. Native opening is separately gated under feature81. |
| 56 | Optional clipboard history | unverified | Real desktop clipboard sampling/privacy lifecycle not independently exercised in this audit |
| 57 | Application launcher and recent items | partial | No dedicated application launcher/catalog with recent launched applications; shelf kinds are file/folder/url and explicit app kind is rejected. |
| 58 | Media and per-app volume controls | missing | Media transport integration; Windows per-app audio session enumeration and volume modification |
| 59 | Calendar view and local calendar import | working | Unchanged working local calendar import/view; export adds useful real behavior, not online calendar OAuth. |
| 60 | System, battery, and device widgets | partial | Broader device widgets beyond existing capability summaries remain absent.; No native battery percentage measurement or real-device fixture acceptance added. |
| 61 | Movable expanding desktop island | missing | Transparent frameless always-on-top island; Drag/expand/collapse, monitor/DPI and fullscreen-app behavior |
| 62 | Original color, typography, material themes | working | Original application themes are implemented; taste quality is not measured as completion. |
| 63 | Interruptible status and panel animations | partial | Panel transitions themselves are not wired to this machine.; Desktop-island status/panel animation acceptance remains absent. |
| 64 | Reduced motion, battery, fullscreen controls | partial | External fullscreen-app detection/suppression still absent.; Host fallback is shown on Status, but root motion policy in App.tsx is not wired to host battery; Electron without navigator.getBattery still misses actual host-driven motion suppression. |
| 65 | Companion with assistant-state animations | working | In-app companion is connected to actual assistant states, separate from missing desktop island. |
| 66 | Audio-reactive waveforms and effects | working | Actual microphone-driven meter/effects; manual simulated poses are labelled separately. |
| 67 | Animated project/scene transitions | partial | App.tsx scene-layer is keyed by scene (line730), remounting SceneBackdrop on global scene change and discarding previous machine state.; No distinct project-to-project scene transition workflow is wired; capsules store scene, app-wide scene is independent preference. |
| 68 | Widget layout editor and live preview | working | Functional saved layout changes reflected immediately in Home. |
| 69 | Live wallpaper/shader scenes | partial | Windows desktop wallpaper attachment/lifecycle; Desktop shader wallpaper runtime/performance acceptance |
| 70 | Physics-driven desktop and window effects | missing | Desktop/window physics simulation and native effect application |
| 71 | Curated optional mod catalog | preview | Actual curated identified mods with verified links/licenses/releases |
| 72 | Mod version and compatibility checks | preview | Installed/version detection; Real release/build compatibility metadata and tested entries |
| 73 | Taskbar and Start menu presets | preview | Reading actual Windows settings; Applying and reverting taskbar/Start presets |
| 74 | Explorer and notification presets | preview | Reading actual Windows settings; Applying and reverting Explorer/notification presets |
| 75 | Save and restore customization settings | preview | Snapshot of actual Windows customization; Restore/apply adapter |
| 76 | Advanced window borders, corners, transparency | missing | Native window styling implementation and reversal |
| 77 | Dock/genie/wobble animation packs | missing | Dock engine; Genie/wobble native animation packs |
| 78 | Resource and icon redirection packs | missing | Resource/icon redirection implementation and reversible pack installer |
| 79 | Virtual-desktop behavior modifications | missing | Windows virtual-desktop APIs and behavior modification/reversal |
| 80 | AI-composed validated scene specifications | unverified | Live-model generated scene response and real provider failure/recovery acceptance not established by mocked tests |
| 81 | Approved app-launch action tools | unverified | Native action behavior on real Windows app fixture matrix not independently verified. |
| 82 | Durable scheduled routines | unverified | Packaged Windows long-running scheduling/native confirmation acceptance |
| 83 | Visual editable workflow steps | working | Real visual list editor persisted to routine backend; not a node-graph requirement. |
| 84 | Conditions, bounded retries, duplicate prevention | working | Named engine behavior implemented and exercised with injected action adapters. |
| 85 | Execution results and partial-failure history | working | Actual routine execution records; separate manual agent logs are not credited here. |
| 86 | Cancellation and pause-all controls | working | Cancellation is cooperative between steps, not interruption of an already-issued OS input primitive. |
| 87 | Undo for explicitly reversible steps | unverified | Real window movement/restore acceptance on Windows |
| 88 | Selected file/browser action adapters | partial | Browser content/tab automation adapter; Rich selected file operations beyond approved opening/references |
| 89 | Watch-once routine recording | missing | Consent-based action recorder; Recorded action interpretation and editable replay |
| 90 | Cross-app semantic drag-to-action workflows | missing | Cross-app drag semantic interpretation; Approved executable workflow adapter |
| 91 | Task board and worker status | partial | Live execution-linked worker status in installed app |
| 92 | Isolated project workspaces | missing | Product project/worktree isolation and execution workspace lifecycle |
| 93 | Model/worker role selection | partial | Role/model selection connected to actual spawned app workers |
| 94 | Persistent resumable agent sessions | preview | Actual agent execution transcript/state continuation; Resume connection to worker runtime |
| 95 | Scoped tools and context policies | partial | Actual agent-worker tool scope enforcement in product; Full collected-context capture/share pipeline |
| 96 | Agent logs and result inspection | preview | Real worker event ingestion and execution results linked to agents |
| 97 | Budgets and bounded task execution | preview | Actual worker token/cost accounting; Enforced runtime cancellation/spend limits for product agent execution |
| 98 | Local specialist multi-agent execution | missing | Installed product specialist worker runtime and coordination; Local model-backed concurrent execution |
| 99 | Animated worker/crew visualization | missing | Worker-linked animated crew scene/visualization |
| 100 | Suggested reusable skills from past runs | partial | Suggestions derived from real executed agent runs; Reusable skill execution connected to worker engine |
| 101 | Anthropic BYOK provider | unverified | Installed application live BYOK generation acceptance not recorded; development-worker API success is separate |
| 102 | Additional optional AI providers | unverified | Explicitly approved real OpenAI/OpenRouter key, generation, cancellation and usage acceptance has not been recorded; tests use fake transport and fake key protection.; Real Electron/Windows protected-key and restart acceptance for additional providers remains unrecorded. |
| 103 | Web research with cited sources | missing | Search provider; Research retrieval and source citation flow |
| 104 | Calendar account connectors | missing | Registered OAuth client; Authorization callback/token exchange; Calendar-account synchronization |
| 105 | Issue-tracker draft export and approved posting | partial | Authenticated tracker posting adapter; Posting approval and posted-result confirmation |
| 106 | Weather/news feed widgets | preview | Weather display widget; News retrieval source and widget |
| 107 | Optional model/update downloads | preview | Download execution; Verified installation and signed update distribution |
| 108 | Per-provider data previews and usage history | working | Scope is local previews and history, not authoritative provider billing. |
| 109 | Encrypted cross-device sync | partial | Automatic device synchronization transport; Conflict resolution and remote device state |
| 110 | Community scene/widget marketplace | missing | Community catalog; Package trust/review; Publish/install flows |
| 111 | Windows installer and uninstaller | unverified | Clean-machine install/uninstall lifecycle validation |
| 112 | Bundled runtime and offline installation option | partial | Offline AI runtime/model-weight installation bundle |
| 113 | Local encrypted sensitive-data storage | partial | ProductivityStore still writes productivity.json as plaintext JSON at store.ts:801, including timeline/focus/reference data.; Renderer preferences remain localStorage plaintext and now include file shelf paths/notes/tags; not all sensitive content is protected.; First-write unavailable protector still falls back to plaintext, so encryption is not mandatory/fail-closed before initial migration.; Real Windows DPAPI/user-profile migration acceptance is not supplied by injected-cipher tests. |
| 114 | Export/import and backup recovery | working | Unchanged working local export/import/recovery; calendar export is not a new independent completion point. |
| 115 | Crash recovery and safe launch | unverified | Real packaged crash/restart acceptance exercise |
| 116 | Network-denial/offline verification | working | Behavioral offline verification exists; not a universal external packet-capture certification. |
| 117 | Signed updates with rollback | preview | Signed update delivery/install execution; Actual rollback execution and lifecycle acceptance |
| 118 | Validated x64/ARM64 compatibility tiers | partial | ARM64 build and runtime acceptance; Broader Windows hardware compatibility acceptance |
| 119 | Commercial licensing without mandatory cloud check-in | partial | Publisher-owned issuance/trusted-key distribution; Integrated entitlement enforcement and commercial purchase/license lifecycle |
| 120 | Enterprise policy and managed deployment | missing | Managed policy source/enforcement; Enterprise deployment tooling |
| 121 | Unified usage dashboard | working | Functional local dashboard; provider balances correctly show unknown without adapter. |
| 122 | Supported provider quota/balance adapters | missing | Actual provider quota/balance fetch adapters and refresh path |
| 123 | Reset countdown and stale-data indicators | partial | Real provider observation ingestion making countdown live |
| 124 | Local token and estimated cost ledger | working | Estimates explicitly labelled; no invoice claim. |
| 125 | Project/worker cost attribution | partial | Actual request context project/worker tagging; Installed-app worker execution cost collection |
| 126 | Budget pace and threshold alerts | working | Local ledger-based alerts; accuracy depends on entered price table and known usage. |
| 127 | Local inference performance history | unverified | Real installed local-model timing acceptance run |
| 128 | Usage report export | working | Real local report export implementation. |
| 129 | 2D avatar geometry editor | working | Narrow 2D feature fulfilled; 3D/portrait work belongs to different IDs. |
| 130 | Expression authoring library | working | Actual editable saved library, not static expression thumbnails only. |
| 131 | Avatar animation timeline editor | working | Functional 2D expression timelines with contact sheets. |
| 132 | Portable avatar pack import/export | working | Portable JSON packs; no claim of 3D/avatar model asset compatibility. |
| 133 | 3D avatar/model customization | missing | 3D avatar asset import; Rig/material/model customization and export |
| 134 | Voice-driven avatar mouth/pose states | partial | TTS audio-driven mouth/pose path; Real microphone/avatar acceptance |
| 135 | Realistic portrait animation adapter | missing | Portrait model/assets; Animation inference adapter and rendering pipeline |
| 136 | Avatar quality/hardware profile manager | partial | Hardware-aware recommendation/detection; Measured hardware/profile acceptance |
| 137 | Procedural motion scene editor | working | Registry claim no timeline is stale: current editor contains timeline and keyframes. |
| 138 | Original scene/template library | working | Original local template library exists; community sharing is separate feature110. |
| 139 | AI-to-validated-scene generation | unverified | Real installed-app AI provider or local-model scene generation acceptance |
| 140 | Local animation/clip export | unverified | Actual encoded WebM file save/playback acceptance in packaged Windows runtime |

Companion JSON preserves source/test evidence and notes for every requirement.
