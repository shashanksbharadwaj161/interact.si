# Parallel twenty-team integration: captain record

Status: **checkpoint**, not final. Eight of twenty specialist modules are integrated and committed in the original repository. Home and Avatar are being finished locally by root helpers. Nine roles never launched. The installer has not been rebuilt at this checkpoint.

## Baseline (e5442ec)

The captain worktree ran `npm ci --ignore-scripts`, `tsc --noEmit` (pass) and the full suite (**1078 / 1078**, with 0 fail, skipped or todo).

## Integrated in the original repository (local commits, no push)

| Commit | Content |
|---|---|
| d3e6987 | Tasks (110), Notes + memory search sources (109), security review tests/findings (104); captain `redactSecrets` in `safeErrorMessage` (PS-03); central glue tests |
| 8d54b53 | Integrations local-model check (106; captain wires `localModel` in `backend.ts`), Assistant (107), Settings (108) |
| 114f4b3 | Motion studio / 3D scene (111) |
| 3f1c861 | Calendar import review (105) mounted by the captain: `Calendar.tsx` takes an injected `Review`, and `App.tsx` lazy-loads `CalendarImport` as its own chunk. Only the confirmed, normalized selection (no RRULE) reaches `calendarImportText`. The basic preview remains for read/size errors and file-dialog import. Also the launch recovery proposal. |
| (this checkpoint) | PS-01 / PS-02 privacy fixes; security todo markers removed after the tests passed |

Each peer was reviewed only on its own manifest paths: added lines were scanned for network, storage, eval, Electron and Node imports, and the result marker had to show `done: true` with checks. Its own test file was run in the integrated tree.

## Security findings (security peer 104)

- **PS-01 (Medium) fixed:** `electron/services/chat.ts`. One-shot cloud chat errors are status-only (with a fixed hint per status code). An SSE error keeps only its machine `type`. Any other cloud error (transport, TLS, proxy) is stored as a fixed sentence. Provider and proxy bodies are cancelled, never read into the reply or the stored chat.
- **PS-02 (Low) fixed:** `src/ui/audio.ts`. `revoke()` sets an in-window revoked flag that `granted()` checks first. If `removeItem` throws, it overwrites the record with `'0'`.
- **PS-03 (Low) fixed:** `electron/ipcCore.ts`. `redactSecrets()` removes `sk-…`, `Bearer …`, `x-api-key`/`api_key`/`authorization` values and `gh*_` tokens before path redaction and the length bound. Ordinary messages like "Authorization failed" are left intact.
- The five PS tests passed against the fixes **before** their `todo` markers were removed from `tests/parallel-security.test.mjs`. The peer's findings document is left as written. This record supersedes its "open" status.

## Not integrated

- **Home (102), Avatar (103):** checkpointed read-only (Home 19/22 own tests, Avatar 11/11) with no result marker at review time. Root's local helpers are finishing them. They are integrated only after `done: true` markers appear. Known follow-up for Avatar: the `tests/expansion-voice-avatar.test.mjs` icon stub needs `ArrowClockwise` and `CaretLeft` exports (captain fixture fix at integration time).
- **Never launched (9):** workbench, guide, usage, customization, routines, models, status, developer, release-check. Causes were model-catalog discovery timeouts, an ACP initialize timeout and a worktree provision timeout. See `parallel-launch-recovery.md`.

## Validation at this checkpoint

See `parallel-result.captain.json` for exact commands and counts. A production `npm run build` passed after batch 3 (one existing >500 kB chunk warning). The offline Electron route fixture and the unsigned installer rebuild with hash and footprint are **still pending**: they were deferred because of measured RAM headroom (638–827 MB free) while peers ran.

## Gates kept separate

- Tested source: unit and contract tests above.
- Real Windows offline fixture: pending at this checkpoint.
- Unsigned installer and archive audit: pending at this checkpoint. The current `release/` installer predates this source.
- Account and hardware gates (cloud provider, microphone, signing, real desktop control): not exercised.
