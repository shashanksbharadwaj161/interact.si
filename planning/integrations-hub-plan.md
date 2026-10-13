# Integrations hub

13 October 2026 · Extension to the Windows companion roadmap

These connections refine the existing media, browser, online-provider, and connector scopes. Keep the headline roadmap count at 140; do not count each service as an additional feature. No accounts connected or integrations implemented yet.

| Integration | First support | Later support | Connectivity |
| --- | --- | --- | --- |
| Spotify and supported media apps | Windows now-playing information, play/pause/skip, volume, workspace app launch | Optional authorized Spotify search/library/playlist/device controls | Native controls can be local; service content/account APIs need online access |
| Chrome and Edge | Open URLs, launch selected workspace browser, selected-page handoff | Scoped extension for approved page content, tabs/bookmarks, save/restore tab sets, selected workflow actions | Local saved-page/tab operations can be local; external navigation is online |
| Firefox and Brave | Launch/URL handoff | Validate extension and profile adapters independently | Depends on requested action |
| ChatGPT | Open web/desktop app; prepare prompt and selected project context for user handoff | Embedded OpenAI API chat with the user's provider key | ChatGPT service/API are online |
| Claude | Open web/desktop app; prepare prompt/context for user handoff | Embedded Anthropic API assistant, Haiku default candidate; optional coding CLI development adapter | Cloud Claude is online |
| Ollama / local models | Local assistant through approved local endpoint/runtime | Per-task routing among locally installed models | Offline if models/runtime/assets are already installed and cloud disabled |
| Selected calendar/task/note services | Existing local file import/export | Explicit calendar, tracker, notes, email, and file-service connectors | Account connectors require online mode |

## Integration boundaries

- Consumer ChatGPT/Claude accounts are separate from API-provider connections. Do not promise automatic transcript synchronization, access to all old chats, or a general personal-chat API. Begin with opening the app/site and explicit prompt handoff. Credentials remain in the user's normal sign-in flow.
- Embedded AI calls use provider API keys stored in Windows-protected storage. Add scoped context previews, token ceilings, provider status, and disconnect controls. Do not extract consumer cookies or assume a chat subscription provides API access.
- Prefer native Windows media APIs for baseline Spotify controls. The ability to issue a local media command does not make Spotify streaming offline. Cached/downloaded playback depends on Spotify itself.
- Advanced Spotify account and playback integration requires OAuth/scopes and a validated development/public distribution path. Inspect current Premium, quota, developer-policy, and commercial restrictions before implementing an embedded player. Do not make a hosted streaming SDK a default commercial dependency.
- Spotify's Web Playback SDK documentation explicitly requires prior written approval for commercial projects. Initial integration therefore targets existing-app controls; embedded streaming remains conditional on that approval.
- Browser integration uses a separately installed extension and a narrow native-messaging bridge where supported. Permission requests identify sites and capabilities. Capture selected content on request; no blanket history/cookie/password ingestion. Secure field restrictions and focus checks remain in the executor.
- Keep localhost integrations authenticated/scoped where possible; loopback is not equivalent to permission for every browser page to invoke native actions.
- Each connector declares capabilities, required permissions, minimum versions, offline behavior, cancellation, and result verification. Writes and external messages require the product's action policy, not merely a model suggestion.
- Strict offline mode blocks provider refreshes, connector traffic, automatic external navigation, remote artwork, and other outbound requests. Local controls and cached state may remain available with freshness labels. Any transition to online mode is explicit.

## Settings and onboarding

Settings → Integrations provides a service catalog, connect/disconnect, permission scopes, readiness tests, last-sync status, per-project access, and data deletion controls. Onboarding treats all external accounts as optional. The app is usable with no cloud accounts or API keys.

## First proof

Create a Focus capsule that launches the browser/editor and shows local media controls; then validate a selected-tab context handoff to the local assistant. Add Haiku/OpenAI API and Spotify OAuth separately after those boundaries work. Public connector support follows license, provider-policy, and account-access validation.

Sources: [Spotify Web API](https://developer.spotify.com/documentation/web-api), [Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk), [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart), [Anthropic API overview](https://platform.claude.com/docs/en/api/overview), [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
