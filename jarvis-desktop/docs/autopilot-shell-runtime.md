# Shell runtime contracts

Owner: shell QA (continuation, 14 October 2026). Test file: `tests/autopilot-shell-runtime.test.mjs`.

This module checks the shell as it renders, not as its source reads. The real `App`, router and views are bundled in memory with esbuild and rendered with `react-dom/server` against a fixture store. The shell source is not changed. The static checks in `tests/autopilot-shell.test.mjs` stay as they are.

## What the tests exercise

- **Routes.** Each of the 13 navigable views renders inside `<main>` with its own heading and is the only nav item marked `aria-current="page"`. The empty hash and unknown view names fall back to Home.
- **Shortcuts.** Every shortcut shown in the nav (`aria-keyshortcuts`, tooltip) is fed back through `shortcutAction`, so the label a user reads opens the view it names.
- **Deep links.** Every route parameter the shell emits survives `hashFor` and `parseHash` for every view. `#/settings?q=…` prefills the Settings search.
- **Gate.** Loading, load failure and not-yet-onboarded states each show the right screen and no navigation.
- **Banners.** The failed-capability-check banner, the safe-launch recovery banner and the preview banner appear on every route when their state is set.
- **Capability states.** Three states: `unchecked` (no system check yet), `unavailable` (every capability false, each with a reason) and `available` (all but secure storage). Each route must report what it knows: no "Available" before a check, reasons visible when a capability is unavailable, one status badge per capability, Computer's Preview disabled with a visible reason while desktop control is unavailable.
- **Accessible names.** In every state on every route, every button has an accessible name, every disabled button has one, and every input, select and textarea has a label or `aria-label`. The audits assert minimum counts so they cannot pass on empty output.

Result on this tree: 20 pass, 0 fail, 5 todo. The todo tests are expected failures that pin real wire-up gaps (below). Node reports them as todo, so they do not fail the run.

## Seams and limits of the harness

- **Store seam.** `AppProvider` loads state in `useEffect`, and effects do not run under server rendering. The test therefore exports the store context from the bundled copy of `src/ui/store.tsx` (an esbuild `onLoad` hook appends one export line). The file on disk is not modified.
- **No DOM.** The lockfile has no DOM library (no jsdom, happy-dom or testing-library), and `package.json` is not ours to change. Clicks, keyboard focus, `useEffect` behaviour, hash changes after navigation, and the Computer preview and approval flow are not exercised. They need a DOM runner or the Electron smoke script, which is a captain decision.
- **Fixture api.** The fixture `api` has no methods. A route that calls the bridge during render throws and fails its test.
- **Capabilities are fixtures.** The states use the capability IDs the shell reads (`local-llm`, `cloud`, `tts`, `stt`, `ui-automation`, `secure-storage`). They are not produced by the real system service.

## Route inventory (as rendered)

| Route | Nav group | Shortcut | Heading | Component |
|---|---|---|---|---|
| `home` | Cockpit | Alt+1 | Greeting (`Good …`) | `Home` |
| `assistant` | Cockpit | Alt+2 | Assistant | `Assistant` |
| `companion` | Cockpit | Alt+3 | Companion | `Companion` |
| `capsules` | Work | Alt+4 | Capsules | `Capsules` |
| `notes` | Work | Alt+5 | Notes | `Notes` |
| `tasks` | Work | Alt+6 | Tasks & focus | `Tasks` |
| `computer` | Work | Alt+7 | Computer | `Computer` |
| `status` | System | Alt+8 | System status | `Status` |
| `settings` | System | Alt+9 | Settings | `Settings` (`initialQuery` from `q`) |
| `lab` | System | Alt+0 | Feature Lab | `FeatureLab` |
| `developer` | System | none | Developer | `Developer` |
| `search` | Work | Ctrl+K | Memory search | `MemorySearch` in `SearchView` |
| `motion` | Cockpit | none | Motion studio | `MotionStudio` in `MotionView` |

## Disabled controls and their reasons (initial render)

Controls that the capability state gates:

- **Assistant.** "Hold to talk" is disabled when speech recognition is not ready. Its `title` describes the gesture, so the reason comes from the "Speech recognition unavailable" notice beside it. "Read aloud" and "Speak" are disabled without a ready voice, and the reason is in a visible "Read aloud unavailable" notice. "Send" is disabled while the chat route is not configured, and the "Ollama (local) unavailable" notice above it explains why. Unchecked shows "Capability has not been checked."
- **Computer.** "Preview action" is disabled while desktop control (`ui-automation`) is unavailable. A visible "Desktop control unavailable" notice shows the capability's reason. It is enabled once the capability is available.
- **Home.** Lists unavailable capabilities with their reasons (the local model notice shows `local-llm`'s reason).
- **Status.** One badge per capability: "Available" or "Unavailable", with the reason beneath each unavailable one.

Controls disabled for form state, not capability, in every state: capsule and note "Save" (not dirty), settings "Save name" (unchanged), developer "Remember address" (unchanged or invalid), assistant "Clear conversation" and "Speak" (empty input or chat), capsule "Restore capsule…" (no saved items).

## Wire-up paths for the captain

These are real gaps found by the runtime checks. This worker did not change shell code.

1. **Item deep links are dropped (5 todo tests cover notes and capsules).** `Home.tsx:193` and `:214` and `App.tsx:382` (memory search results) call `go(view, { item: id })`. `App.tsx` `Shell` renders `<Capsules />` (line 453), `<Notes />` (456) and `<Tasks />` (459) with no props, so `loc.params.item` is ignored and the first record stays selected. Rendered check: `#/notes?item=n_2` still shows "First note". The search subtitle ("Choosing a result opens the screen that holds it") is true for the screen but not the record. Fix path: pass `loc.params.item` into Notes and Capsules (the components already own selection state) and decide what Tasks does, since Tasks has no selection model.
2. **Routines and Integrations have no route (todo tests).** `src/components/Routines.tsx` and `src/components/Integrations.tsx` have headings and full UI but no importer, no `ViewId` in `src/ui/nav.tsx` and no switch case. `#/routines` and `#/integrations` fall back to Home. Both need a props decision: Routines takes `api` or `initialView`, and Integrations takes `bridge`.
3. **Other components with no importer.** `Models.tsx` (exports `Models`, `ModelsView`; used only inside itself), `Customization.tsx`, `UsagePanel.tsx`, `WidgetPicker.tsx` and `AvatarStudio.tsx` are not imported anywhere, so they are unreachable. Home has no widget picker, so the widget arrangement UI in `WidgetPicker.tsx` is not reachable either. These are not covered by a todo test because they have no page heading of their own (`Models`, `UsagePanel`, `Customization`) or are sub-panels (`WidgetPicker`, `AvatarStudio`); captain can add route tests once each is placed.
4. **Assistant doubles the full stop.** `Assistant.tsx:417` builds `Ollama (local) unavailable: ${routeReason}. Check System status…`. Any capability reason that ends in a full stop renders as "checked.. Check". Covered by a todo test (the fixture reason is "Offline model is not installed.").
5. **External link in Developer (not tested, decision pending).** `Developer.tsx:68` renders `<a target="_blank">` for the Control Room address. `docs/resume-integration-plan.md` D3 is still open. Not covered by these tests.

## Validation

- `node --test tests/autopilot-shell-runtime.test.mjs`: 25 tests, 20 pass, 0 fail, 5 todo (exit 0).
- `npm test` (all `tests/*.test.mjs`): 502 tests, 495 pass, 2 fail, 5 todo. The 2 failures are `tests/autopilot-models.test.mjs` lines 124 and 203 (streaming cancellation). `docs/continuation-baseline.md` already records them under the Models owner; they are not caused by this module. The shell runtime file passes inside the full run.
- `git status`: only `tests/autopilot-shell-runtime.test.mjs` and this document are new. Nothing is committed.

## Limitations

- No click, keyboard or focus simulation (see the DOM limit above). Interaction contracts covered here are the pure handlers they call: `shortcutAction`, `hashFor`, `parseHash`.
- Server rendering only. Effects, hash-change listeners, the battery and reduced-motion hooks, and the Toasts timers are not run.
- Capability states come from fixtures, not from the real system service. The tests check how the shell presents those states; they do not check that the service reports them correctly.
- Mutation checks (breaking a route or a label on purpose and confirming a test fails) were not run. Sensitivity rests on the minimum-count assertions and on the rendered output being compared against exact values.
- Developer, Computer approval and the Electron window handler are outside this module.
- Node 22 with `npm ci --ignore-scripts` (Electron binary not installed). Not run on Electron.
