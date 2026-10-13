# Jarvis Desktop — UI guide

React 19 + TypeScript renderer. Native CSS only, system fonts, no external resources (compatible with the CSP in `index.html`). All data goes through `window.jarvis` (`src/shared/contracts.ts`); the UI holds no business state of its own beyond view drafts.

## Layout of the source

| Path | Role |
| --- | --- |
| `src/main.tsx` | Mounts the app. Installs the preview bridge only when `window.jarvis` is missing. |
| `src/preview.ts` | Browser-only preview bridge (see below). |
| `src/ui/store.tsx` | Loads state, system info and cloud-key status. `mutate()` runs a write, applies the returned `AppState`, then re-reads `getState()`. `run()` does the same for non-state writes. Toasts, bounded error text, live `onActivity` merge. |
| `src/ui/focus.tsx` | Focus timer (absolute end time in localStorage; survives view changes and reloads). |
| `src/ui/companion.tsx` | Avatar state driven by real activity (recording, waiting, speaking, error). |
| `src/ui/audio.ts` | Microphone capture → decode → 16 kHz mono 16-bit PCM WAV bytes for `transcribe`. |
| `src/ui/Dialog.tsx`, `primitives.tsx` | Native `<dialog>` modals (focus trap, Esc, focus restore), buttons, fields, switch, segmented control. |
| `src/ui/roadmap.ts` | Honest status of all 140 roadmap scopes for Feature Lab. |
| `src/components/*` | One file per screen, plus `Avatar`, `SceneBackdrop`, `shared`. |
| `src/styles/*` | `tokens` (themes) → `base` → `shell` → `components` → `views` → `avatar` (avatar, scenes, reduced motion) → `responsive`. |
| `tests/ui.test.mjs` | Node tests for the pure logic and the preview bridge. |

## Screens

- **Onboarding** (when `settings.onboarded` is false): mode and theme, permissions (allowed folders, approved apps), hardware and local model, review. Nothing is granted by default. Saved with one `saveSettings` call.
- **Home**: counts, due/overdue tasks, recent capsules and notes, last chat line, capability summary, activity. All from saved state and `getSystemInfo`.
- **Assistant**: chat (`chat`), push-to-talk (`transcribe`; transcript goes into the message box, never auto-sent), read-aloud (`speak`, optional auto-read), clear conversation. Errors are shown inline with "No other model was tried". No scripted replies.
- **Companion**: procedural CSS avatar, pose preview, five CSS scenes, animation toggle (`reduceMotion`).
- **Capsules**: create/edit/delete; items of kind file/folder/app/url (`pickPath`, URL validation); reorder; restore behind a confirm dialog, then per-item opened/failed outcome.
- **Notes**: search text and tags, tag filter, editor with tags, Ctrl+S.
- **Tasks & focus**: due dates grouped overdue/today/upcoming/none/done, edit, delete, clear completed, focus timer.
- **Computer**: choose an action, `previewAction`, read the scope explanation and backend verdict, then an approval dialog before `executeAction(id, true)`; Reject calls `executeAction(id, false)`. Editing the form after a preview marks it stale and disables approval.
- **System status**: `getSystemInfo` capabilities with reasons, configured routes (explicitly "settings, not probes").
- **Settings**: appearance (immediate), mode, local endpoint/model, cloud model, protected key save/status/delete, allowed folders, approved apps, retention, export/import, clear chat. One sticky Save bar for non-immediate fields; switching to online asks for confirmation.
- **Feature Lab**: roadmap status groups (Interface built / Planned / Research) plus the live capability report.
- **Developer**: Control Room link, diagnostics copy (no paths, notes or keys), shortcuts, activity log.

## Rules the UI follows

- No cloud fallback: the Assistant and Settings state which single route is active and surface its errors.
- The cloud key is only ever held in a password input until submitted, then cleared. It is not put in React state elsewhere, localStorage or logs. Only `configured` status is shown.
- localStorage (`jarvis.ui.*`) holds display preferences only: chosen scene, auto-speak, focus timer, Control Room address.
- The Control Room address must be `localhost`/`127.0.0.1`/`::1`, and opens only through a normal `<a target="_blank" rel="noopener noreferrer">` the user clicks. The app does not start, embed or call Control Room. Electron's main process must route external `target="_blank"` links to the default browser (not owned here).
- Clearing a task's due date sends `due: ''` (an `undefined` field would be dropped over IPC). The UI treats `''` and any non-date as undated; backend handling of `''` is assumed.
- Motion: `data-motion="reduced"` is set when `settings.reduceMotion` is on or the OS prefers reduced motion; all animation and transitions are then disabled.
- Keyboard: skip link, Alt+1…0 switch screens, modals trap focus and restore it, push-to-talk works with Space/Enter (hold, or tap to latch) and Esc cancels, tabs/segmented controls use arrow keys.
- Layout: sidebar collapses to icons under 1000 px and to a bottom dock under 720 px; split views and grids stack.

## Browser preview bridge

Opening the built page outside Electron (no `window.jarvis`) installs `createPreviewBridge()` and shows a "Browser preview" banner on every screen. It is for layout review only:

- Works: settings, capsule/note/task CRUD, chat clearing, activity events for those demo writes (labelled `[preview]`), kept in `localStorage` key `jarvis.preview.state.v1`. "Add demo records" adds clearly `[Demo]`-titled records; "Reset demo data" clears them.
- Unavailable (return an honest reason or throw): chat, speak, transcribe, previewAction/executeAction (always `allowed: false`), restoreCapsule (every item reported failed), pickPath (null), export/import, cloud key save. System info reports only demo storage as available; RAM comes from `navigator.deviceMemory` or shows as unknown.

## Checks run

- `npx tsc --noEmit` — passes.
- `npx vite build --outDir dist` — passes (JS ≈ 462 kB, CSS ≈ 44 kB). No Vite config exists in this branch; root owns the `base: './'` config for Electron packaging.
- `node --test tests/*.test.mjs` — 10 tests pass: error text bounding, loopback/http endpoint checks, due-date buckets, tag/clock helpers, WAV header and sample clamping, silence peak detection, deterministic star fields, roadmap integrity (140 unique scopes; every "interface built" item has a dependency note; unbuilt scopes not marked built), hash navigation, and the preview bridge (CRUD, persistence, activity subscription, and that every native/AI/voice/key path is unavailable).

## Limitations (not verified or not built)

- **No visual or interaction verification was done in a browser or in Electron.** Layout, contrast, dialog focus behaviour, the avatar and scene rendering, and responsive breakpoints are untested by eye; expect CSS polish fixes. Root is expected to review these.
- Not run against the real Electron backend. Behaviour that depends on it is assumed from the contract: that `chat` persists both messages, that `saveCapsule`/`saveNote`/`saveTask` merge partial objects, that `saveTask({due: ''})` clears the date, and that `executeAction(id, false)` records a rejection.
- Microphone capture uses `MediaRecorder` + `decodeAudioData` + `OfflineAudioContext` (works under the current CSP). It needs Electron to grant microphone permission; it is untested with real hardware. Clips are capped at 30 s and sent as a `number[]`, which is heavy over IPC.
- Text-to-speech has no stop control and no voice list (contract has neither). The avatar mouth is not audio-driven.
- Chat has no streaming. The model endpoint is not probed (the CSP blocks `fetch` to it and the contract has no health call); reachability shows only after a message is sent.
- The focus timer keeps no history and does not raise a system notification. Tasks have no sub-items (contract has no field).
- Capsule window geometry is shown read-only; the UI cannot capture it.
- Settings has no free-text settings search. There are no component-level (DOM) tests; only pure logic and the preview bridge are tested.
- Control Room has no known default port, so the user enters the address.
- `npm install --ignore-scripts --no-package-lock` was used to get dependencies locally (no lockfile written, Electron binary not downloaded).
