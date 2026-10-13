# Keyboard, focus and reduced-motion audit

Scope: the renderer UI under `src/components`, `src/ui` and `src/styles`. This is a static read of the source. I did not run the app in Electron or a browser, did not use Narrator or any screen reader, and did not send any desktop input. Items marked **verify** need a runtime check before they are treated as confirmed.

Naming: the user-facing name is Desktop Companion (pending final naming). Technical identifiers and paths are unchanged. Two brand strings still say "JARVIS" (see the last section).

Existing overlap: `docs/product-interaction-review.md` already lists some of these as A1, A2, A5, A6 and P1-9. Those entries are cited here where they apply. The findings below add the new code-level evidence and the items that review did not cover.

## Severity

- **High**: a keyboard user loses focus, or an action runs in the wrong place, with no obvious way back.
- **Medium**: the path works but is hard to use, or it fails for assistive technology.
- **Low**: semantics, polish, or a gap that only shows in one configuration.

## Summary

| ID | Sev | Where | Problem |
| --- | --- | --- | --- |
| K1 | High | `src/components/Tasks.tsx:41-82, 219-220` | Starting, stopping or resetting the focus timer removes the focused button. Focus falls to `<body>`. |
| K2 | High | `src/components/Tasks.tsx:133-137, 209-226`; `Home.tsx:91` | Completing a task moves or removes its row. Focus is lost. (Same as A2.) |
| K3 | High | `src/ui/Dialog.tsx:40-62`; `Tasks.tsx:223, 265`; `Notes.tsx:94-104, 165` | After a destructive confirm, focus is restored to an element that has just been deleted. |
| K4 | High | `src/components/App.tsx:166-176, 263` | Alt+1…0 navigates while a modal is open. The open dialog and its unsaved state are discarded. |
| K5 | Medium | `src/ui/primitives.tsx:20`; `Assistant.tsx:314, 248`; `Tasks.tsx:215`; `Notes.tsx:203` | A control is disabled while it has focus, so focus drops to `<body>`. |
| K6 | Medium | `Notes.tsx:191`; `Capsules.tsx:286`; `src/components/shared.tsx:49` | Remove buttons delete themselves and drop focus. |
| K7 | Medium | `src/components/Companion.tsx:56-58` | The scene picker is a `radiogroup` with no arrow-key handling and no roving `tabIndex`. |
| K8 | Medium | `src/ui/store.tsx:67-71`; `src/components/App.tsx:65-75, 268` | Toasts auto-dismiss with no pause, can vanish under focus, and sit last in the tab order. |
| K9 | Medium | `src/ui/Dialog.tsx:53-54, 100-120` | `ConfirmDialog` never describes its body. The consequence text is not read when the dialog opens. |
| K10 | Medium | `src/components/App.tsx:237, 244`; `Developer.tsx:89-99` | Developer's shortcut tooltip reads `Alt+11`, which does not exist. The shortcut list omits Developer and other keys. (Overlaps P1-9.) |
| K11 | Medium | `src/styles/base.css:170-174, 217-244`; `shell.css:144-161` | No forced-colors support. Input focus, active nav and checked states depend on background or box-shadow. (A1.) |
| K12 | Low | `src/styles/responsive.css:18-27` | Under 1000 px, nav labels are `display:none`. Keyboard users see icons only. (A5.) |
| K13 | Low | `src/components/Settings.tsx:153-160`; `src/ui/primitives.tsx:156-165` | Arrow keys work in the tab list and segmented control, but Home and End do not. |
| K14 | Low | `src/ui/primitives.tsx:126-141` | A switch's description is not linked to the switch with `aria-describedby`. |
| K15 | Low | `Notes.tsx:131-137`; `Capsules.tsx:201-204` | The "New note" and "New capsule" rows are focusable buttons with no action. |
| K16 | Low | `src/components/App.tsx:41-45, 273-282` | Reduced motion from the in-app setting is not applied during the boot loading state. |
| K17 | Low | `src/components/App.tsx:155-163`; `src/main.tsx:21` | Dev builds only: StrictMode runs the mount effect twice, so `<main>` takes focus on boot. |
| K18 | Low | `src/styles/views.css:863-864` | The onboarding heading receives programmatic focus with no visible ring. Acceptable for a non-interactive target. **verify** with Narrator. |
| K19 | Low | `src/components/App.tsx:228`; `src/components/Onboarding.tsx:49` | Brand text says "JARVIS", not Desktop Companion. |

## Findings

### K1. Focus timer controls remove the focused button (High)

- `src/components/Tasks.tsx:41` renders the Start block only while the phase is `idle` or `done`. Pressing **Start focus** (`Tasks.tsx:72`) switches the phase to `running`, which unmounts the button. Focus goes to `<body>`.
- **Stop and reset** (`Tasks.tsx:82`) unmounts the running block and remounts Start. Focus is lost again.
- The per-row Play button (`Tasks.tsx:219-220`) is hidden while a session runs. Pressing it removes the button.

Fix: after Start, move focus to Pause (or the timer heading). After reset, move focus to the Start button. Route the row Play button's focus to the row's Edit button or to the timer.

### K2. Completing a task loses focus (High, same as A2)

- `Tasks.tsx:133-137` sets `busyId` and disables the checkbox at `Tasks.tsx:215`. A disabled checkbox loses focus.
- The row also moves to another group's `<ul>` (`Tasks.tsx:201-226`). Because the key is `t.id` inside a different `Panel`, React remounts the row.
- On Home, `Home.tsx:91` drops the row from "Due now" entirely.

Fix as in A2: focus the next row in the same group, or the group heading if the group is empty. Announce the move with a polite status message.

### K3. Focus is restored to a deleted element after a destructive confirm (High)

- `Dialog.tsx:31` records `document.activeElement` as the opener when the dialog opens. `Dialog.tsx:44` and `:60` restore focus to it on close.
- Tasks: the opener is the Trash icon on the row (`Tasks.tsx:223`). Confirming delete (`Tasks.tsx:265`) removes that row, so the restore target is detached and focus goes to `<body>`.
- Notes: the opener is the **Delete** button (`Notes.tsx:165`). `doDelete` (`Notes.tsx:94-104`) sets `draft` to `null`, which removes that button. The same thing happens.

Fix: in `Dialog`, restore focus only if the opener is still connected. Otherwise focus the nearest stable control, such as the list heading or the new-item field. Each caller should be able to pass a fallback target.

### K4. Alt+number navigates behind an open modal (High)

- `App.tsx:166-176` handles Alt+1…0 on `window` with no check for an open `<dialog>`.
- `App.tsx:263` (`<div key={view}>`) unmounts the whole screen. The open confirm (for example `Notes.tsx:222-225`, which guards the discard flow) disappears with it. Notes keeps its draft in component state, so the unsaved draft is probably lost (**verify**).
- This is the keyboard path to the same problem the product review lists for click navigation (P1 "discard guards", `docs/product-interaction-review.md`). Mouse clicks on the sidebar are blocked by the modal, but this shortcut is not.

Fix: ignore the shortcut while `document.querySelector('dialog[open]')` matches, or route it through the same discard guard as `go()`.

**verify** in Electron: open the discard confirm in Notes, press Alt+1, and check whether the draft and dialog survive.

### K5. Controls disabled while focused drop focus (Medium)

- `primitives.tsx:20` sets `disabled={disabled || busy}`. Any `Button` with `busy` set drops focus if it had focus.
- `Dialog.tsx:113`: the **Delete** confirm is `busy` while saving. A keyboard user who tabbed to it and pressed Enter loses focus inside the dialog. **verify** where focus lands inside a modal `<dialog>`.
- `Assistant.tsx:314`: the push-to-talk button is disabled during `transcribing` and while a message is pending. With the keyboard, stopping a recording focuses the button, then disables it. Focus goes to `<body>`. On success `Assistant.tsx:167` refocuses the textarea. On an empty transcript or an error (`Assistant.tsx` catch branch of `stopRec`) nothing refocuses it.
- `Assistant.tsx:248`: "Read aloud" is disabled while speaking, so the focused button is removed mid-action.
- `Tasks.tsx:215`: see K2.
- `Notes.tsx:203`: the tag input is disabled at 12 tags (`MAX_TAGS`, `Notes.tsx:12`). Pressing Enter on the twelfth tag disables the focused input.

Fix: use `aria-disabled` and ignore the click in the handler, so focus stays put. Where the control must be disabled, move focus explicitly to a neighbour when the action ends.

### K6. Remove buttons drop focus (Medium)

- `Notes.tsx:191`: removing a tag chip deletes the focused `chip-x` button.
- `Capsules.tsx:286`: removing a capsule item deletes the focused button.
- `shared.tsx:49`: the Settings allowed-folder and allowed-app lists do the same. These are safety-relevant lists.

Fix: after removal, focus the next item's remove button, or the list's add field if the list is now empty.

### K7. The scene picker is not a keyboard radio group (Medium)

- `Companion.tsx:56-58` renders `role="radio"` buttons inside `role="radiogroup"`, but every button is in the Tab order and no arrow keys are handled.
- The same app's `Segmented` (`primitives.tsx:143-173`) and Settings tabs (`Settings.tsx:153-160`) already use roving `tabIndex` and arrow keys.

Fix: reuse `Segmented`, or copy its roving-tabindex handler. Five scene buttons should be one Tab stop.

### K8. Toasts disappear under focus and sit at the end of the tab order (Medium)

- `store.tsx:67-71` removes each toast after 4.5 s (ok and info) or 9 s (error). There is no pause on focus or hover. Users with slower reading or a screen reader can miss the text. (WCAG 2.2.2 "Pause, Stop, Hide".)
- A toast removed while its dismiss button has focus loses focus to `<body>` (`App.tsx:70`).
- `App.tsx:268` renders `<Toasts/>` after the whole `.stage`. A keyboard user reaches the dismiss button only after tabbing through the page.
- `App.tsx:65-67` puts `role="alert"` or `role="status"` inside a `aria-live="polite"` container. Nested live regions can produce duplicate or inconsistent announcements. **verify** with Narrator.

Fix: pause the timer while a toast is hovered or focused. Keep error toasts until dismissed. Give the region a landmark or a skip link so it can be reached directly.

### K9. Confirm dialogs do not describe their body (Medium)

- `Dialog.tsx:53-54` sets `aria-describedby` only when a `description` prop is passed.
- `ConfirmDialog` (`Dialog.tsx:100-120`) passes no description. Its children carry the consequence text, such as the delete and clear warnings in `Tasks.tsx:265-268`, `Capsules.tsx:391`, `Settings.tsx:316-322`. A screen reader hears only the title.

Fix: give the body an id and pass it to `aria-describedby`, or accept a `description` prop from each `ConfirmDialog` call site.

### K10. Shortcut tooltip and shortcut list are wrong (Medium)

- The `title` at `App.tsx:244` is `` `${v.label} (Alt+${idx === 10 ? 0 : idx})` ``. Developer is the 11th view, so `idx` is 11 and its tooltip reads **Developer (Alt+11)**. No such shortcut exists. The `App.tsx:168` handler ignores it.
- `Developer.tsx:91` lists `VIEWS.slice(0, 10)`, so Developer is left out. It also omits Ctrl+Alt+J (the global hotkey, `docs/product-interaction-review.md` P1-9), Enter and Space for push-to-talk, and Enter for adding a note tag.
- Ctrl+S is listed as "Save note" (`Developer.tsx:97`), but it only works while focus is inside the note editor (`Notes.tsx:172-178`).

Fix: derive the shortcut list and the tooltip from one shared table. Give Developer an explicit shortcut or show "none".

### K11. Forced colors (High Contrast) (Medium, see also A1)

- `grep -rn forced src/styles` finds nothing. There is no `@media (forced-colors: active)` block.
- `base.css:86-90` keeps a global `outline` on `:focus-visible`. That outline survives forced colors, so most controls are fine.
- `base.css:170-174` removes the outline on `.input:focus-visible` and uses `box-shadow` instead. Box-shadow is dropped in forced colors, so focused text inputs become invisible.
- `shell.css:144-161`: the active nav item is shown with `background`, a `::before` bar with `box-shadow`, and an accent-colored icon. Those are all dropped, so the active item has no visible indicator.
- `base.css:217-244`: a checked checkbox uses a background fill. The checkmark is drawn with borders and may survive; **verify**.
- `.seg.on`, `.switch.on` and `.chip.on` show their on state through background only.

Fix: as in A1. Add a `forced-colors` block that gives the input focus state an `outline`, and gives `on` and `active` states a border or outline in `Highlight` or `ButtonText`.

### K12. Compact sidebar hides labels (Low, see A5)

- `responsive.css:18-27` sets `display:none` on `.nav-item span`, `.nav-label` and `.brand-text`. Each nav link keeps its name only from `title`, which is not shown on focus.
- Fix as in A5: show a tooltip on `:focus-visible`.

### K13. Home and End keys missing in arrow-key controls (Low)

- `Settings.tsx:153-160` handles ArrowLeft and ArrowRight only.
- `primitives.tsx:156-165` handles arrows in `Segmented` but not Home or End.
- The ARIA Authoring Practices tab and radio patterns expect Home and End.

### K14. Switch description is not linked (Low)

- `primitives.tsx:126-141` renders the switch description as a `<p class="field-hint">` (`:134`) with no id. The switch is not given `aria-describedby`. Screen readers do not announce the explanation, which for example is the reduced-motion description in `Companion.tsx:48-50` and `Settings.tsx:185`.

### K15. No-op focusable rows (Low)

- `Notes.tsx:131-137` and `Capsules.tsx:201-204` render the draft row ("New note", "New capsule") as a `<button>` with `aria-current` and no action. Capsules sets `onClick={() => undefined}` explicitly.
- These are extra Tab stops that do nothing when activated. Render them as a plain `<li>` or `<div>` with `aria-current`.

### K16. Boot loading ignores the in-app reduce-motion setting (Low)

- `App.tsx:41-45`: `useThemeSync` reads `settings?.reduceMotion`. Until settings load, only the OS preference applies.
- `App.tsx:273-282` shows "Loading saved data…" with a spinner (`shell.css:403`) during that window, so a user who turned reduce-motion on in the app sees the spinner animate briefly.
- The steady-state reduced-motion coverage is good (see below).

Fix: persist the in-app reduce-motion flag in `localStorage` (as other UI prefs are) and read it before settings load.

### K17. Dev-only focus steal on boot (Low)

- `App.tsx:155-163` uses `first.current` to skip the first focus. `main.tsx:21` wraps the app in `StrictMode`. In development, React runs mount effects twice, and the ref survives, so `<main>` takes focus on the first render.
- Production builds are not affected. **verify** in `npm run dev`.

### K18. Onboarding heading focus has no ring (Low)

- `views.css:863-864` removes the outline on `.onboard-main h1:focus-visible`. The heading is focused programmatically (`Onboarding.tsx:27`) so that each step change is announced. That is a reasonable choice for a non-interactive target. **verify** with Narrator that the step is announced.

### K19. Brand text (Low, for the naming task)

- `App.tsx:228` and `Onboarding.tsx:49` show "JARVIS" in the brand block. The user-facing name is Desktop Companion. Left as is here, because the task is not to rename.

## Checked and working

- **Skip link**: `App.tsx:218`, styled in `shell.css:17-35`. It is hidden until focused and moves focus to `<main>`.
- **Focus on view change**: `App.tsx:156-163` focuses `<main>` after a view change, which lets Tab start from the new content. (K17 is the dev-only issue.)
- **Native modal dialogs**: `Dialog.tsx:27-38` uses `showModal()`, so the page behind is inert and Escape closes the dialog. `ConfirmDialog` autofocuses **Cancel** (`Dialog.tsx:110`), so a stray Enter cancels rather than deletes. `Computer.tsx:301` does the same for the approve dialog, and the high-risk approve button is not focused by default.
- **Arrow keys in tabs and segmented controls**: `Settings.tsx:141-165`, `primitives.tsx:143-173`, with roving `tabIndex`.
- **Push-to-talk keyboard model**: `Assistant.tsx:321-336`. Space and Enter start and stop, Esc cancels, and key repeat is ignored (`!e.repeat`).
- **Labelled icon buttons**: `primitives.tsx:27-33` gives `aria-label` and `title`. Toast and tag removal controls have labels too.
- **Live regions for results**: `Assistant.tsx:229-230` (`role="log"`), `Assistant.tsx:365`, `Capsules.tsx:338`, `App.tsx:65`.
- **Reduced motion, steady state**: `avatar.css:580-603` disables `animation`, `transition` and `scroll-behavior` both for `:root[data-motion="reduced"]` and for `prefers-reduced-motion: reduce`. `App.tsx:27-45` merges the OS preference and the in-app setting. Dialog and toast entrance animations are covered by the same selector.
- **Focus ring**: `base.css:82-90` removes the default outline and adds a 2 px `--focus` ring on `:focus-visible` for every element. Mouse clicks do not show it.

## Needs a runtime check

- K3, K4, K5 and K8 are based on the code paths above. They need a manual pass in the Electron app with the keyboard only.
- **Push-to-talk double toggle (`Assistant.tsx:334-336`)**: `onClick` calls `press()` when `e.detail === 0`, which is a keyboard-synthesized click. The keydown handler calls `preventDefault` for Space and Enter, which should suppress it, but this is not verified. If it is not suppressed, one press starts and immediately stops a recording.
- **Narrator**: confirm the dialog body (K9), toast announcements (K8) and the heading focus on onboarding steps (K18).
- **High Contrast**: run Windows High Contrast on the Tasks, Notes and Settings screens and check the focus and on-states (K11).

## Limitations of this audit

- Static reading only. No browser run, no Electron run, no screen reader, no High Contrast, and no keyboard input was sent to the app or the desktop.
- I did not audit the Electron main process, the global hotkey, or the native helpers.
- I did not check contrast, zoom or 125–200 % scaling. The responsive breakpoints were read only for the nav labels.
- Line numbers refer to the checked-in source at commit `2fc88a8` and may drift.

## Changed files

- `docs/keyboard-audit.md` (new). No other files were changed.
