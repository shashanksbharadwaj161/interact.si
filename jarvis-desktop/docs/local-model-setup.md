# Local model setup (Ollama)

Desktop Companion chats with a model that you run yourself through [Ollama](https://ollama.com). The app does not install Ollama, does not bundle a model, and never downloads a model. This guide describes the behavior of the current source (`electron/services/chat.ts`, `validation.ts`, `netGuard.ts`, `system.ts`). It is not a test report: the only recorded local-model runs are listed under [Evidence](#evidence).

## Settings the app uses

| Setting | Default | Notes |
| --- | --- | --- |
| `mode` | `offline` | Offline keeps chat on this computer. See [Offline and online](#offline-and-online). |
| `localEndpoint` | `http://127.0.0.1:11434` | Ollama's default address. Saved as origin only: a path such as `/x` is dropped. |
| `localModel` | `llama3.2:3b` | A default name only. Nothing in this repo verifies that it is installed or works on your machine. |

Fixed values in the chat path (`electron/services/chat.ts`):

- Chat request timeout: 120 s. Capability probe timeout: 1.5 s.
- Conversation sent to the model: the newest turns within about 8,000 characters. System messages are never sent.
- Reply length kept: up to 60,000 characters.
- `keep_alive`: `2m` on each chat request (`LOCAL_KEEP_ALIVE`, line 14). Ollama unloads the model about two minutes after the last reply.
- The app sends no `options`, so Ollama's default context size applies.

### Endpoint rules

- Only `http://` is accepted. `https://`, credentials in the URL, and non-loopback hosts are refused when you save (`validation.ts`, `validateLocalEndpoint`). Loopback means `127.0.0.1`, `localhost` or `::1`.
- Changing the endpoint asks for native confirmation: "Change desktop permissions or AI connection?". If the confirmation is declined or unavailable, the save fails (`electron/backend.ts`, `saveSettings`).
- The network guard allows only loopback `http://` requests for the `ollama` purpose, and every attempt is audited (`netGuard.ts`).

## Set up Ollama and a model

Do these steps yourself, outside Desktop Companion.

1. Install Ollama from its website and start it. Ollama normally listens on `127.0.0.1:11434`.
2. Check that the server answers. In PowerShell:

   ```powershell
   curl.exe http://127.0.0.1:11434/api/tags
   ```

   A reply with a `models` list means the server is up. An error means it is not running or is on another port.
3. Get a model, one of two ways:
   - **Online pull (needs internet, done by you in Ollama, not by the app):** `ollama pull <model>`.
   - **Offline import from a GGUF file:** put the `.gguf` file and a `Modelfile` in one folder. The `Modelfile` contains one line, `FROM ./your-model.gguf` (the path is relative to the `Modelfile`). Then run `ollama create <name> -f Modelfile`. `ollama create` reads the local file; it does not need internet.
4. Confirm the name. `ollama list` shows the names, and the `models[].name` values from `/api/tags` are what the app compares against. A name with no tag is compared with `<name>:latest`. For example, `my-model` matches `my-model:latest`, but `llama3.2` does not match `llama3.2:3b`.
5. In Desktop Companion, open Settings, set **Endpoint** to `http://127.0.0.1:11434` and **Model name** to the exact name, then save. Keep **Offline** selected.
6. Send a short message. A reply with the source "local" means the model answered. If not, read the message: see [Messages you may see](#messages-you-may-see).

### Reproducing the recorded smoke run

`scripts/local-ai-smoke.cjs` expects a dedicated Ollama on `127.0.0.1:11435` with `qwen3.5:2b`. It writes settings to a temporary profile and asks one arithmetic question. The port is set through Ollama's `OLLAMA_HOST` variable (for example `$env:OLLAMA_HOST="127.0.0.1:11435"` before `ollama serve`). This setup was not re-run for this guide.

## Messages you may see

These strings come from the source. A chat failure in offline mode is stored as a `source: 'system'` message: "Local model unavailable: … No reply was generated and nothing was sent elsewhere." No fabricated reply is ever shown.

| Situation | Text (after "Local model unavailable: " for chat) |
| --- | --- |
| Ollama not reachable | `Ollama is not running at <endpoint>. Start Ollama, then try again` |
| Model not installed (chat, HTTP 404) | `Model "<model>" is not installed in Ollama. Install it once with "ollama pull <model>" (that download needs internet; Desktop Companion never downloads models) or choose an installed model in Settings` |
| Model not installed (capability probe) | `Ollama is running but model "<model>" is not installed. Install it once with "ollama pull <model>"` |
| Other HTTP error | `Ollama returned HTTP <code>` (plus a short detail when Ollama gives one) |
| No answer within 120 s | `Ollama did not answer in time` |
| Empty reply | `Ollama returned an empty reply` |
| Probe got a non-OK HTTP status | Capability reason `Ollama returned HTTP <code>` |

Things to know when reading them:

- "Not running" is the default for any connection failure. This includes a wrong port, a slow response to the 1.5 s probe, and a non-Ollama server on that port. Check the port first.
- The model-not-installed text is cut to 300 characters when shown in chat. A very long model name can cut off the end of the hint.

## Offline and online

Both modes use the same message list, and each user and assistant message records which route produced it (`source`).

| | Offline (default) | Online (optional) |
| --- | --- | --- |
| Chat goes to | `localEndpoint` (Ollama) | `https://api.anthropic.com` with the saved cloud model |
| Needs | Ollama running with the model installed | `mode` set to online, a key saved in the app, and the user's confirmation to enable it |
| Network allowed by the guard | Loopback `http://` for Ollama only | The exact Anthropic origin for chat only |
| On failure | System message. No cloud fallback. | System message. No local fallback. |
| Ollama probe | Runs; drives the `local-llm` capability | Still runs and still reports `local-llm`, but chat does not use Ollama |

Online mode sends conversation content to the cloud provider. Enabling it asks for native confirmation. Without a stored key, online chat fails with "No cloud API key is configured…" and does not switch to Ollama.

## Capability status and memory

- The capability report (`local-llm`) is cached for 30 seconds, keyed by mode, endpoint and model (`system.ts`, lines 57–58). Saving a settings change clears the cache. "Check again" on Status calls `getSystemInfo` and does not clear it. After you install a model, either wait up to 30 seconds or change and save a setting, then check again.
- Memory: the app sends `keep_alive: "2m"`. To free memory sooner, quit Ollama. The "Unload model now" control that the acceptance list calls E5 (`keep_alive: 0`) **does not exist yet** in the source.

## Known gaps (from source, not yet fixed)

These are recorded for the root review. This guide does not change the code.

1. **Copy says the app does not probe Ollama.** `src/components/Settings.tsx:233` says "The app does not probe the endpoint", and `src/components/Onboarding.tsx:146` says the connection is not tested. The backend does probe Ollama when capabilities are read (`system.ts`, `chat.ts` `probeLocalModel`), and Status shows the result. `src/components/Status.tsx:46` also says reachability is only known after a message.
2. **Readiness ignores the probe.** `src/components/Home.tsx:31` and `Assistant.tsx:72` treat the local model as ready when a model name and endpoint are set. A "ready" state can appear while Ollama is stopped.
3. **Architecture doc is out of date.** `docs/architecture.md` gives `keep_alive: '5m'` and an "Unload model now" control. The source has `2m` and no control.
4. **No model list, pull or import in the app.** `docs/architecture.md` notes these methods do not exist. Setup relies on the user and on Ollama.
5. **No automated test pins these messages.** No file under `tests/` references `probeLocalModel`, `missingModelHelp` or `keep_alive`.
6. **Remote endpoint warning is misleading.** Settings warns about a remote host, but the save itself is refused by `validateLocalEndpoint` with "localEndpoint must be a loopback address".
7. **`localhost` untested.** The source accepts `localhost`, but this guide has not tested how it resolves on Windows. Ollama listens on `127.0.0.1` by default, so prefer `127.0.0.1` unless you have checked.

## Evidence

Only these runs are recorded in the repo:

- `docs/current-verification.md` (2026-10-14): the real Electron smoke run against a dedicated loopback Ollama on `127.0.0.1:11435` with `qwen3.5:2b` returned `12` with source `local`. No cloud key was configured. The cold run took about 26.9 seconds.
- `docs/local-ai-benchmark.json` (2026-10-13): Ollama v0.40.3, `qwen3.5:2b`, context 2048, two prompts. "Reply with exactly READY." took 16.0 s, including 15.5 s to load the model, at 19.2 tokens/s. "What is 7 + 5?" answered `12` in 0.57 s at 24.6 tokens/s. The file does not record the hardware. It is not a quality, safety or general performance measure.

No other model, machine, or speed is verified. In particular, `llama3.2:3b` (the default name) has no recorded run.
