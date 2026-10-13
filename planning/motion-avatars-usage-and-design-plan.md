# Motion, avatars, usage, and design references

13 October 2026 · Planning extension

## Confirmed intent

Use the supplied references throughout planning and implementation. Include all three avatar directions: stylized 2D companions, customizable 3D characters, and realistic talking portraits. Keep the finished app offline by default with explicit optional online features; development can use cloud APIs.

No new software was installed during this review. No paid calls, component purchases, or asset imports occurred. Repository review establishes candidates, not completed integration or runtime quality.

## Reference decisions

| Reference | Verified role | Planned use |
| --- | --- | --- |
| [Awesome Opus 5.5 Videos](https://github.com/yihui-dev/awesome-opus5-5-videos) | Animation examples and prompts for code-based scenes | Motion Studio: original procedural scenes, configurable templates, previews, export |
| [OpenUsage](https://github.com/robinebers/openusage) | Native Swift/macOS subscription and usage tracker; MIT | Implement a Windows usage panel with selected provider adapters |
| [Avatar Lab](https://github.com/smontlouis/bible-strong-avatar-lab) | Browser-based procedural 2D avatar authoring, expression/animation editing, exports; AGPL-3.0 | Avatar Studio reference; integration/license design required |
| [AI avatars topic](https://github.com/topics/ai-avatars) | Mixed avatar projects and frameworks | Discovery only; screened visible entries and top 20 API results |
| [REA](https://github.com/morluto/rea) | Local MCP/CLI analysis of applications and binaries; MIT | Development analysis tooling; not a required consumer runtime |

OpenUsage, Avatar Lab, and REA current licenses were checked at commits `05c7a87805d7f0d76cb5048fbe4c4caa4d2de784`, `79fe9ba06e4874b11394b8e8a3f2c493c9d197ba`, and `b69d20a300dba57783a810146f25dacb69f9b8a4`, respectively. Dependencies, model weights, media, and trademarks still require per-artifact review. AGPL allows commercial distribution under its conditions; it is not a permissive drop-in license for an assumed proprietary combined product.

REA can inform investigations of compatible app behavior, public/source-accessible components, and our own diagnostics. Its native Windows Ghidra support is described as experimental; analysis backends have separate requirements. Do not treat inferred behavior as exact recovered source or import third-party implementation solely because a tool can inspect it.

## Design reference inventory

Read the supplied local historical inventory: 20 principal references and 83 recorded HorizonX entries, with overlap between those lists. It preserves review/asset history, not proof of current licensing or a fresh audit of every site. Retain the user's NOVARA rejection. Existing ShaOn branding and old website assets do not automatically determine this app's identity.

Checked current public pages for Unicorn Studio, Zajno Motion, Navbar Gallery, and the following likely matches for the user's short names:

- [Space UI](https://www.spaceui.one/docs): animated primitives, morphing controls, voice/agent interaction examples, creative tooling.
- [Skecher UI](https://skecher-ui.com/): React motion components, docks, AI orb/composer, spring interactions.
- [Planes](https://planes.ashishgogula.in/components): animated React controls and media/AI interactions; the catalog contains free and Pro items.

These are strong matching candidates found by web search, not explicit user confirmation of each exact URL. The other historical reference links are retained as supplied rather than newly runtime-tested.

Adapt motion into application interactions: capsule-to-project expansion, island-to-voice-panel morph, continuous spatial transitions, readable status changes, tactile controls, and optional atmospheric backgrounds. Keep settings, error recovery, keyboard focus, and long-form text practical. Do not combine every reference's visual language into one interface.

React/Canvas/WebGL components cannot be directly pasted into WinUI XAML. The native host is still provisional. Compare a native UI prototype against a Windows host with a locally bundled React renderer; isolate native tools behind a narrow broker either way. Bundle fonts, assets, models, and scripts locally; no required CDN or embedded remote website in offline mode.

## Usage dashboard

Own API calls produce a local token/cost ledger using response usage and versioned pricing estimates. These estimates are not invoices or authoritative provider balances. Subscription quotas, reset times, account credit balances, and usage from other applications need supported provider-specific integrations; unavailable data is shown as unavailable, not zero.

Offline mode displays local inference/task history, model resource statistics, and cached values clearly labeled with their age. Provider refreshes, pricing updates, and account integrations require online mode. Do not inherit OpenUsage's credential-discovery or anonymous reporting behavior automatically; connect accounts explicitly and keep user secrets out of reports.

## Avatar modes

1. **Stylized 2D:** editable shape, palette, expressions, blink, listening/thinking/speaking states. Original lightweight companion can ship before a complete authoring studio.
2. **Customizable 3D:** model import, body/outfit controls where supported, poses, expressions, speech-driven mouth states. [three-vrm](https://github.com/pixiv/three-vrm) is a renderer candidate; avatar model rights are separate.
3. **Realistic portraits:** image/video-driven animation and lip sync need separate generation/inference engines. [LivePortrait](https://github.com/KlingAIResearch/LivePortrait) is a research candidate; its full model/dependency terms must be checked. Do not assume [Wav2Lip](https://github.com/Rudrabha/Wav2Lip) checkpoints permit the intended commercial use.

Haiku can help choose styles, write dialogue, plan scenes, and emit validated parameters. It does not itself render character geometry, synthesize speech, or generate portrait-animation frames. Keep those engines separate. Local realistic animation on this laptop's 4 GB VRAM needs a specific benchmark before realtime claims; offer simplified/offline render alternatives.

## Motion Studio

Create original code-driven motion, not a claim of a bundled photorealistic video foundation model. Begin with parameterized built-in templates and a validated scene schema. Provide local preview, playback control, battery-aware rendering, and an export workflow after choosing the actual renderer/encoder.

Optional AI converts natural language into allowed scene parameters. Arbitrary generated JavaScript must not inherit filesystem, network, terminal, or credential access. Source example prompts and linked videos have their own ownership; the collection's MIT license does not automatically license every linked creator's media.

## Additional feature scopes

This extension adds 20 enumerated scopes to the earlier 120-scope catalog: 8 expansion scopes and 12 experimental scopes. Combined planning count: **140 scopes — 40 foundations, 68 expansion, 32 experimental**. These are planned capabilities at a chosen granularity, not promises that all can ship within the $500 development budget.

| ID | Scope | Phase |
| --- | --- | --- |
| 121 | Unified usage dashboard | Expansion |
| 122 | Supported provider quota/balance adapters | Expansion |
| 123 | Reset countdown and stale-data indicators | Expansion |
| 124 | Local token and estimated cost ledger | Expansion |
| 125 | Project/worker cost attribution | Expansion |
| 126 | Budget pace and threshold alerts | Expansion |
| 127 | Local inference performance history | Expansion |
| 128 | Usage report export | Expansion |
| 129 | 2D avatar geometry editor | Experimental |
| 130 | Expression authoring library | Experimental |
| 131 | Avatar animation timeline editor | Experimental |
| 132 | Portable avatar pack import/export | Experimental |
| 133 | 3D avatar/model customization | Experimental |
| 134 | Voice-driven avatar mouth/pose states | Experimental |
| 135 | Realistic portrait animation adapter | Experimental |
| 136 | Avatar quality/hardware profile manager | Experimental |
| 137 | Procedural motion scene editor | Experimental |
| 138 | Original scene/template library | Experimental |
| 139 | AI-to-validated-scene generation | Experimental |
| 140 | Local animation/clip export | Experimental |

## What remains

Enough reference projects are available to begin feasibility work. Remaining decisions: app name/identity, initial voice languages, first-release boundaries, and the exact host framework after overlay/renderer prototypes. Production work includes licensed original assets, model-pack preparation, integration contracts, hardware tests, offline traffic checks, installer/signing strategy, and a release/support process.

Next useful deliverable: three coherent UI concepts using the same capsule/voice/settings flow, then benchmark one native overlay and one local animated renderer. Avoid expanding dependencies before proving those boundaries.
