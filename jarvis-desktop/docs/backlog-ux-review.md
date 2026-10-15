# UX backlog review

Read-only audit of the mounted UI in this worktree (HEAD `84578df`). Only this document, `tests/backlog-ux-review.test.mjs` and `docs/backlog-result.ux-review.json` were written. No source file was changed. Fixes are listed as paths for the captain to route to each owner.

Run: `node --test tests/backlog-ux-review.test.mjs` → 26 pass, 0 fail, 7 `todo` (known defects, see below).

## What was checked and how

| Area | Method | Evidence type |
| --- | --- | --- |
| Mounted views and routes | `VIEWS` (20 entries) compared with the `switch` in `App()` and the shell render | Static reading |
| Keyboard map | `shortcutAction` (nav.tsx) exercised with key objects; `window` keydown handler read | Unit behaviour (pure function) |
| Labels, roles, relationships | Real primitives and `MotionStudio`, `Avatar` rendered with `react-dom/server` (bundled in memory) | SSR markup |
| Disabled and busy states | `Button`, `Dialog`, `MotionStudio` markup; `disabled={` lines triaged | SSR markup plus grep triage |
| Reduced motion | OS preference, in-app setting, battery source traced through `useReducedMotion` (App.tsx); CSS rules read | Static reading plus SSR for the studio |
| Focus visibility | Global and component `:focus-visible` rules read with specificity | Static cascade reading (not run) |
| Contrast | Declared hex values in `src/styles/tokens.css` for all three themes, WCAG ratios computed | Computed from declared values, not rendered pixels |
| Offline imports | esbuild metafile of the avatar and motion modules (8 entry points) | Import graph |

## Findings

Severity is a judgement about user impact. "Todo" means a regression test in the new file asserts the correct behaviour and currently fails; the run reports it as TODO and does not fail. "Static" means the finding comes from reading the code and has not been reproduced in a browser or screen reader.

### Verified by test (todo until fixed)

**UX-01. Settings claims every screen has an Alt+number shortcut. Only 10 of 20 do.** Medium. Evidence: test "Settings states that every screen has an Alt+number shortcut".
- Copy: `src/components/Settings.tsx:538` ("Every screen can be reached with Alt plus a number").
- Map: `src/ui/nav.tsx` `positionalShortcut` returns null for index ≥ 10, so Developer, Motion, Avatar, Routines, Clipboard, Calendar, Models, Integrations and Usage have no Alt chord. They remain reachable through the nav links and `#/route` hashes.
- Fix (choose one): change the copy to "The first ten screens have Alt+1…9 and Alt+0", or give the remaining screens a different chord in nav.tsx (single digits are the limit of the current scheme). The copy change is the smaller one. Owner: shell (jarvis-desktop-31).

**UX-02. Paper theme: warning amber text is below 4.5:1.** Medium. Evidence: test "paper: warning amber text meets 4.5:1 on the page".
- `--amber` is `#a86a0a` in paper: 3.85:1 on `--bg` and 4.44:1 on `--panel-solid`. Used as text by `.badge-warn` (components.css:263), `.mode-pill.online` (shell.css:220), `.msg-user .msg-who` (views.css:296).
- Fix: `src/styles/tokens.css`, paper block: set `--amber: #946000`, the existing paper `--warn`. Measured 4.63:1 on `--bg`, 5.34:1 on `#ffffff` (panel), 4.89:1 on `--raised`. Owner: unowned in the manifest; captain decides.

**UX-03. Text-field border `--line` is about 1.2–1.4:1 against the panel.** Medium. WCAG 1.4.11 asks for 3:1 on a control's boundary when the boundary is needed to identify it. Evidence: three todo tests (graphite, nebula, paper).
- The shared text-input rule is `src/styles/base.css:142-150` (`.input, select.input, textarea.input`, border `var(--line)`). Measured: 1.25 (graphite), 1.24 (nebula), 1.42 (paper) against `--panel-solid`.
- This is a design decision. Fix: add a field-border token that reaches 3:1 on `--panel-solid` and `--sunken`, then use it in base.css:142-150. `--line-strong` is not enough (it measures 1.69–1.90:1 on the panels). Owner: unowned; captain decides.

**UX-04. Play/Pause toggles change their name and also set `aria-pressed`.** Low to medium. Evidence: todo test "MotionStudio play toggle keeps one name for its state".
- Mounted: `src/components/MotionStudio.tsx:592` (`{playing ? 'Pause' : 'Play'}` with `aria-pressed={playing}`).
- Unmounted, same pattern: `src/components/AvatarStudio.tsx:462-472` (see UX-13).
- The APG toggle pattern keeps one constant name and uses `aria-pressed` for state. A changing name plus `aria-pressed` can be announced as "Pause, pressed", which reads as a conflicting state. Fix: either a constant name such as "Playback" with `aria-pressed`, or a plain button whose text changes and no `aria-pressed`. Owner: visual (jarvis-desktop-32). The visual worker is still running, so route through the captain.

**UX-05. Segmented leaves its group unreachable when `value` matches no option.** Low (latent). Evidence: todo test "Segmented keeps one radio tabbable when the value is not one of its options".
- `src/ui/primitives.tsx:173` gives `tabIndex={0}` only to the option whose value matches; with no match, every radio has `tabIndex=-1` and Tab skips the group. The arrow handler (lines 177-186) also reads the index from `value` rather than the focused button.
- No current consumer was verified to pass a stale value, so this is latent. Fix: when no option matches, make the first option tabbable. Owner: unowned (shared primitive); captain decides.

### Static findings (not run in a browser or screen reader)

**UX-06. Focus indicator disappears in Windows High Contrast for five control types.** Medium. Static cascade reading.
- Base and component rules set `outline: none` and show focus only through `box-shadow` or `border-color`: `src/styles/base.css:170-172` (`.input:focus-visible`), `src/styles/avatar-studio.css:97-102` (`.avs-slider`), `avatar-studio.css:148-151` (`.avs-item`), `src/styles/motion-studio.css:99-104` (`.motion-slider`), `motion-studio.css:147-150` (`.motion-preset`).
- The global forced-colors rule in `src/styles/accessibility.css:42-45` is `:focus-visible { outline-color: Highlight }` at specificity (0,1,0). It cannot restore an outline whose style is `none` set at (0,2,0), and forced colors removes `box-shadow`, which was the only other indicator.
- Fix, in `src/styles/accessibility.css` inside the `@media (forced-colors: active)` block: add `.input:focus-visible, .avs-slider:focus-visible, .avs-item:focus-visible, .motion-slider:focus-visible, .motion-preset:focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }`. Equal specificity and later in the cascade (main.tsx imports accessibility.css last), so it wins. Owner: accessibility (jarvis-desktop-44) for the CSS file.
- Verify in Windows High Contrast before relying on it. This was not run here.

**UX-07. Settings tabs point `aria-controls` at panels that do not exist.** Low to medium. Static.
- `src/components/Settings.tsx:346` sets `aria-controls={`panel-${t.id}`}` on every tab. Only the active tab's panel is rendered, with `id={`panel-${tab}`}` at line 365, so the four inactive tabs reference missing ids.
- Fix: set `aria-controls` only on the selected tab, or render the inactive tabpanels hidden. Owner: shell (jarvis-desktop-31).
- Settings needs a store to render, so this is not covered by the SSR test.

**UX-08. Onboarding step heading has no visible focus.** Low. Static.
- Focus moves to the heading on each step (`src/components/Onboarding.tsx:161`), and `src/styles/views.css:863-865` (`.onboard-main h1:focus-visible { outline: none }`) removes the indicator. Keyboard users get no visual cue.
- Fix: replace the rule with a visible focus style, for example `outline: 2px solid var(--focus); outline-offset: 4px;`. Owner: shell (jarvis-desktop-31).

**UX-09. Notes tag input commits on Enter during IME composition.** Low (affects IME users). Static.
- `src/components/Notes.tsx:236-240` handles `Enter` without checking `isComposing`. The chat composer does check it (`src/components/Assistant.tsx:590`).
- Fix: `if (e.key === 'Enter' && !e.nativeEvent.isComposing)`. Owner: productivity (jarvis-desktop-48).

**UX-10. Error toasts announce twice.** Low. Static, not tested with assistive technology.
- `src/components/App.tsx:144` puts toasts in a `aria-live="polite"` container, and `App.tsx:146` gives error toasts `role="alert"`. Both can announce the same message.
- Fix: keep `role="alert"` on error toasts and remove `aria-live` from the container, or the reverse. Owner: shell (jarvis-desktop-31).

**UX-11. Avatar disabled button has no reason on the control.** Low. Static.
- `src/components/App.tsx:617` `<Button disabled>Edit avatar</Button>`. The reason is in the Notice above it (App.tsx:611-613), not on or next to the control. Fix: add `title` or `aria-describedby`. Owner: shell (jarvis-desktop-31).

**UX-12. Accessibility helpers are tested but not used by the mounted app.** Low (drift risk). Static.
- Unused by any consumer outside their module and tests: `applyAccessibilityAttributes`, `watchSystemPreferences`, `resolveAccessibilityState`, `readSystemPreferences`, `viewPositionFromEvent`, `viewShortcut`, `matchesChord`, `parseChord` (`src/ui/accessibility.ts`).
- The app sets `data-motion` directly (`App.tsx:106`, `Onboarding.tsx:292`) and computes reduced motion in `useReducedMotion` (`App.tsx:83-98`). The stale comment at `src/styles/accessibility.css:4` says the module provides it.
- Fix: either route App through the module, or delete the unused exports and correct the comment. Owner: accessibility (jarvis-desktop-44) with shell (jarvis-desktop-31).

**UX-13. AvatarStudio is not mounted; the `avatar` route shows a stub.** Integration item, not a defect in HEAD.
- `src/components/AvatarStudio.tsx` (817 lines) is imported nowhere. `App.tsx:606-622` (`AvatarView`) renders `Avatar` and a disabled "Edit avatar" button, and says editing is not connected. That message is accurate for HEAD.
- When the captain mounts the studio: pass `reducedMotion` from the Shell's `motion.reduced` (AvatarView does not receive it today; AvatarStudio.tsx:178 and 287-288 depend on it). Then re-run this test file. Owner: visual (jarvis-desktop-32) for the component, captain for the mount.

## What was checked and found sound

- **Mounted views:** 20 nav entries, 20 switch branches. Unknown hashes fall back to Home (`parseHash`).
- **Nav:** `<nav aria-label="Primary">`, `aria-current="page"` on the active link, and `aria-keyshortcuts` mapped from the shortcut label. Every entry has a label and a blurb.
- **Skip link and focus:** skip link present; main takes focus on route change; `#main` is `tabIndex=-1`.
- **Keyboard map:** Alt+digit, Ctrl+K, F1 behave as documented; Ctrl+Alt (AltGr) and Shift variants are ignored; all shortcuts are blocked while a `dialog[open]` exists.
- **Dialog:** native `<dialog>` with `showModal`; Escape goes through `onCancel`; the close control is disabled when not dismissible; focus is restored to the opener; a closed dialog renders no body. The labelled-by and described-by ids resolve in markup.
- **Primitives:** `Switch` is `role="switch"` with `aria-checked` and labelled by its visible label; `Field` links label, hint and error by id, with errors as `role="alert"`; `Panel` labels its region from its heading; `IconButton` always has `aria-label` and `title`; `Button` busy sets `disabled` and `aria-busy`; `Notice` uses `role="alert"` only for danger.
- **Live regions:** timers use `aria-live="off"` to avoid chatter (`Tasks.tsx:34`); loading uses `role="status"`.
- **Reduced motion:** OS preference is live-tracked (`App.tsx:87-93`), in-app setting and battery source are combined with setting precedence (`App.tsx:94-97`), `data-motion` is written to the root (`App.tsx:106`), and the CSS rules cover animations, transitions and scroll behaviour. MotionStudio sets playback off when reduced motion is on (`MotionStudio.tsx:379`) and its disabled Play carries a reason (`title`), verified in markup.
- **Text contrast:** body, secondary, muted, accent-ink, danger, ok, warn and focus tokens clear their thresholds in graphite and nebula; all except amber clear them in paper (UX-02).
- **Avatar:** `role="img"` with label `Companion, <state>`.
- **Offline imports:** the avatar and motion modules (`MotionStudio`, `AvatarStudio`, `Avatar`, `Companion`, `avatar-editor`, `motion-presets`, `companion`, `scenes`) import only `src/` modules and `react`, `react-dom`, `scheduler` and `@phosphor-icons/react`. No network specifier was found. The only `http://` string is an SVG namespace in `avatar-editor.ts`.
- **Animation loops:** both studio rAF loops cancel on unmount and on visibility change; the companion hold timer is cleared on every state change.

## Triage that was not verified one by one

`grep` finds 94 `disabled={` lines without a `title=` on the same line. Many carry their reason in nearby text (for example Models and Integrations). They were not audited individually and no finding is claimed from the count alone.

## Limitations

- No browser, DOM, screen reader or Windows High Contrast run. Static findings (UX-06 to UX-13) need one.
- Contrast uses declared token values. It does not measure translucent panels, scene backdrops or text over imagery.
- The visual worker (jarvis-desktop-32) is still running. The avatar and motion audit covers HEAD in this worktree only. When the captain merges it, re-run `node --test tests/backlog-ux-review.test.mjs`; the offline import test and the MotionStudio tests cover the changed modules. Reading the visual worktree was not done, as the assignment reserves that for the captain.
- Local dependencies were installed with `npm ci --ignore-scripts` (Electron's binary download skipped). `node_modules` is ignored by git. No global installs, package.json changes or network access were used.
- The test file depends on these interfaces: `src/ui/primitives.tsx` (Switch, Segmented, Button, IconButton, Field, Panel, Notice), `src/ui/Dialog.tsx` (Dialog), `src/components/MotionStudio.tsx` (`reducedMotion` prop), `src/components/Avatar.tsx` (`state` prop), `src/ui/nav.tsx` (VIEWS, shortcutAction, parseHash, hashFor), `src/styles/tokens.css` (declared tokens). A change to any of these will fail the probe bundle, which is intended.
