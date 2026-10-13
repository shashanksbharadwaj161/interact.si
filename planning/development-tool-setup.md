# Development tool setup

13 October 2026

- Agent Orchestrator 0.13.7 installed per user from its [official GitHub release](https://github.com/OrchestratorInc/agent-orchestrator/releases/tag/v0.13.7). Installer SHA512 matches the publisher's release manifest. Installer exited 0; Windows uninstall registration and installed executable version verified.
- Installed desktop executable: `C:\Users\SHASH\AppData\Local\Programs\agent-orchestrator\agent-orchestrator.exe`.
- Included local CLI: `C:\Users\SHASH\AppData\Local\Programs\agent-orchestrator\resources\daemon\ao.exe`.
- Source checkout retained under this chat's `work/tools/agent-orchestrator` for implementation/documentation reference. No source build was needed.
- The agent-harness URL is a topic catalog, not installable software. Screened its visible projects and top 30 API search results; selected references recorded in the feature catalog. Do not interpret this as an audit or installation of the whole topic.
- Existing Git, Node/npm, and Claude CLI detected. Claude credentials and billing account configuration were not inspected or changed.
- No worker sessions, model downloads, cloud account connections, or paid inference started. Adding our application repository and securely selecting the Anthropic Console key remain build-time setup steps. Installed Orchestrator does not automatically attach this chat or inherit its credentials.
- The Orchestrator development tool is distinct from the finished app's strict offline mode. Its own updater and cloud-capable harnesses must not be mistaken for an offline runtime guarantee.
