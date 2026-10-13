# Resume handoff

User requested explicit pause; do not start paid agents until user resumes. All external tasks cancelled and online provider access disabled. Internal supervision stopped.

Budget: $300 total, $10 safety reserve. Current committed/reserved ledger: $11.9483; available after safety: $278.0517. These include uncertain failed/interrupted reservations, not authoritative billing. Preserve original local spending.json; do not reset spending on resume.

## Next steps
1. Review combined frontend/native sources; backend was interrupted before tests and handoff. Run npm ci, typecheck, tests, build, Electron smoke in isolated userdata, then Windows installer. No complete app claimed.
2. Finish Haiku feature registry and release checklist (task cancelled before file generation); retain all 140 planned features and mark implemented only with evidence.
3. Activate latest Control Room hardening by restarting service: ownership mutex, input validation, terminal-state poll race, 204 approval responses. Tests passed before pause.
4. Diagnose auxiliary Claude API 400 retries: gateway currently forces parent model/adaptive high onto every request, including small/forced-tool requests. Fix compatibility, preserve conservative budget reservations. Claude CLI updated to 2.1.296, required for Opus 5.5.
5. Secure backend review: IPC validation, cloud opt-in, DPAPI, native action approvals and scope, no hidden reasoning or fabricated progress.
6. Local runtime installed only in original workspace work/tools/ollama, official v0.40.3 checksum verified. Dedicated endpoint 127.0.0.1:11435, qwen3.5:2b downloaded, cloud disabled. Actual benchmark ~19–25 tokens/sec, cold load ~15s, VRAM ~1.9GB. Runtime/weights not in GitHub. App endpoint defaults may still be 11434; configure/test.
7. Browser UI visual QA, actual offline chat test, voice capability checks, tray/startup, packaging/signing limitations. Expand remaining roadmap after core passes.

## Local source and recovery
Original outputs/control-room/.controlroom retains DPAPI credential, ledger, task state and worker worktrees; never publish it. Original outputs/jarvis-desktop Git history retained. GitHub checkpoint includes all authored source snapshots without dependencies or private runtime. Development helpers reference original outputs layout; adapt paths for cloned monorepo before use. Do not auto-resume cancelled sessions or enable online.

Models authorized on resume: claude-opus-5-5 high, claude-sonnet-5-5 high, claude-haiku-5-5. Max two external workers concurrently. User wants concise reports, offline-by-default Windows app, personal first/commercial later.
