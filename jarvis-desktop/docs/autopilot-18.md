# Delegated build team

18 workers: 3 Fable 5.1, 3 Opus 5.5, 4 Sonnet 5.5, 8 Haiku 5.5; high effort, unattended development permissions. Shared $300 lifetime development cap with $10 safety reserve; existing spending retained. The app remains offline by default, without a final name.

Each assigned module has one writer. Main API owner handles shared contracts/backend/IPC; native owner handles main process/helpers. UI shell owner handles navigation, dashboard and settings. Integration captain alone merges tested modules into original source and runs combined validation/packaging. Module owners publish small interface descriptions in their result JSON so captain can wire them accurately. No invented integrations, progress, billing, model replies or unsupported hardware claims.

Use the complete 140-scope roadmap for coverage. Implement supported behavior and evidence; experimental gates stay visible when hardware, licenses, credentials or dependencies are unavailable. The roadmap is not considered finished merely because a screen or component exists.

Result signal: docs/autopilot-result.<role>.json containing role, files, checks, limitations, interfaces, dependencies, done. Captain polls existing AO session metadata through CLI and reads only the assigned source worktrees from the manifest. User monitors Control Room; Codex does not continue supervising. No automatic GitHub publication.

Check installed relevant skills, using only explicit SKILL.md sources. The frontend taste skill explicitly excludes dashboards/product flows: use its applicable accessibility/dependency/motion principles without treating its landing-page layout as an app template. Do not load unrelated skills or plugin/account secrets. The computer-use skill does not authorize workers to manipulate the user's actual desktop during tests; use injected mocks.
