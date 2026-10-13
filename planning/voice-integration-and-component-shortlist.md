# Voice integration and remaining components

13 October 2026 · Planning update

## Decisions

- SpeakoFlow is the strongest Windows voice reference among the supplied repositories. Use selected components/patterns after dependency and model audits; do not bolt its entire application onto our host.
- FreeFlow is a macOS application. Use its interaction patterns as reference; native Windows integration needs separate implementation.
- Keep strict offline default. Optional customer-owned Haiku API key enables enhanced cloud assistance. Offline users still have local AI, dictation, and desktop tools.
- Existing 120 feature scopes remain the planning count. Voice details below refine those scopes rather than adding a second overlapping feature count.

## Findings

| Reference | Findings | Decision |
| --- | --- | --- |
| [SpeakoFlow](https://github.com/AbhishekBarali/SpeakoFlow) | Windows/macOS/Linux, MIT application license; local dictation, optional AI cleanup, conversations, screen context, meeting tools | Primary voice reference; Windows prototype needed |
| [FreeFlow](https://github.com/zachlatta/freeflow) | macOS, MIT; context-aware cleanup, vocabulary, spoken edits, configurable provider endpoints | Borrow UX patterns, not assume Windows portability |
| [wispr-flow topic](https://github.com/topics/wispr-flow) | Mix of native apps, cloud services, wrappers, and platform-specific tools | Discovery only; screened page and top 20 API results |
| [wisperflow topic](https://github.com/topics/wisperflow) | Smaller, mixed collection with varied licenses/platforms | Screened page and 10 API results; no blanket installation |
| [AkuchiS/Yap](https://github.com/AkuchiS/Yap) | Windows support, offline Whisper dictation, optional cleanup; MIT | Smaller alternative/reference for transcription workflow |
| [X-Whisper](https://github.com/X-Studio-Labs/X-Whisper) | Local transcription and island overlay for Windows/macOS | Additional UI/transcription reference |

SpeakoFlow review included README, privacy document, Cargo dependencies, source tree, LLM client, and secret store at commit `38fe354af626b7f2105f3a4f2cbe1a2c36266150`. FreeFlow README and metadata were reviewed. No application was installed or executed in this voice review; performance and compatibility remain untested.

## Voice specification

Select the strongest implementations for: hold/toggle recording, microphone selection/test, visible waveform, speech segmentation, streaming transcription, vocabulary/replacements, cleaned/literal dictation, spoken selection edits, copy/insert/replace preview, cancellation/retry, conversation interruption, and recording history with retention.

Meeting capture is a later opt-in module. Speaker diarization does not establish a person's identity. Application insertion must check the target field again before writing and refuse secure/password fields where detectable.

## Haiku architecture

```text
Microphone → local transcription → text
                                ↓
                      local model OR Haiku API
                                ↓
                  validated actions / answer text
                                ↓
                         local speech playback
```

[Anthropic's model catalog](https://platform.claude.com/docs/en/models/overview) lists Haiku 5.5 with text/image input, text output, and tool use. This supports cleanup, translation, summaries, question answering, selected-image questions, and structured action proposals. It does not supply the separate speech recognition/playback engines in this architecture. Evaluate Haiku on representative tasks before choosing it for every action; the tool executor owns validation and result verification.

Settings → AI Providers → Anthropic: key entry, connection test, model selection, scopes, usage estimate, token/retry ceilings, and remove-key control. Store credentials in Windows Credential Manager or user-bound DPAPI. If protected storage fails, use a session-only key or refuse persistence; no plaintext fallback. Provider keys remain out of logs, exports, scene packs, and installer binaries.

Cloud mode sends selected text and explicitly permitted images/context directly to Anthropic. Keeping microphone transcription and playback local avoids needing separate cloud speech keys. Adding an API key does not automatically grant access to all screen history or files. Strict offline blocks provider calls and outbound tools; never silently switch modes on model failure. User-owned Anthropic usage is billed to the user's provider account, independently of any app purchase.

## Remaining repository search targets

| Priority | Component | Candidate/search target | Acceptance criteria |
| --- | --- | --- | --- |
| First | Local speech engine | [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Windows CPU path, optional GPU, acceptable latency, distributable model weights |
| First | Speech detection/playback | [Silero VAD](https://github.com/snakers4/silero-vad), sherpa-onnx-compatible voices | Local operation, interruption, supported languages; inspect each voice license |
| First | Local reasoning runtime | [LLamaSharp](https://github.com/SciSharp/LLamaSharp) for .NET, existing llama.cpp option | Fits selected host; runs with internet disabled; bounded RAM/VRAM |
| First | Windows automation | [FlaUI](https://github.com/FlaUI/FlaUI), native UI Automation | Stable targeting, focus checks, timeout/cancel, verified results |
| First | Packaging/update | [Velopack](https://github.com/velopack/velopack) | Host compatibility, clean uninstall, optional update checks, recoverable updates |
| Next | Animation/companion | [Rive runtime](https://github.com/rive-app/rive-runtime), or native composition | Native-host integration prototype, original assets, battery/reduced-motion behavior |
| Next | Local document search | SQLite FTS first; [Tantivy](https://github.com/quickwit-oss/tantivy) if needed | Folder scopes, incremental indexing, deletion/retention, bounded storage |
| Next | Workspace restoration | Existing PowerToys reference; look for documented Windows window/browser adapters | Restores supported references/layouts without claiming universal process restoration |
| Later | Visual workflows | Look for maintained local workflow graph editor + durable scheduler | Separate editor from executor; persistent jobs, duplicate prevention, explicit permissions |
| Later | Wallpaper engine | Look for Windows video/shader wallpaper host | Low idle impact, game/battery pause, independently licensed assets/code |

Prefer libraries over complete competing applications. Repository openness alone is insufficient: exact version license, dependencies, model weights, assets, native integration, and maintenance determine whether we can ship it. Native Windows APIs already cover credential storage, media controls, task scheduling, and parts of screen capture; those do not require another full app.

## Work still needed beyond repos

Choose initial languages, minimum hardware tier, original branding/UI, and first-release boundaries. Build integration contracts and a Windows feasibility prototype. Create model packs and a dependency/license manifest. Validate dictation accuracy, correction preservation, focus safety, offline traffic, mixed DPI, microphone hotplug, and installer recovery. Commercial preparation later needs signing, release hosting, pricing, and support design.

Recommended next benchmark: local transcription → optional Haiku cleanup → preview/insert into Notepad and a browser field, plus local speech reply and interruption. This proves the voice path before broad component imports.
