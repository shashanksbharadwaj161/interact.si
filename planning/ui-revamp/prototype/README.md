# Companion experience prototype

An isolated, clearly labelled design study of the desktop companion's form. It sits outside the production renderer build and is the material for the owner's review before any broad restyle.

## Run it

```
cd jarvis-desktop
npm run prototype          # dev server on http://127.0.0.1:4329/prototype/index.html
npm run prototype:build    # static build into dist-prototype/ (prototype/ and a copy of the hub)
node scripts/prototype-review.mjs --out=../planning/ui-revamp/prototype   # these captures
```

Use **Play the journey** for a guided 12-step run, or the state list to jump between states. Keyboard: Ctrl+Space opens and closes the island; Esc returns focus to the mock app you were typing in.

## What it shows

- **The island.** One element docked to a screen edge: bottom-right, top centre or right edge. It changes size from rest into each surface and back, so it keeps its place and mass. The core never remounts.
- **The surfaces:**
  - command, with context: draw a region, or select the Sheet chart from the keyboard;
  - listening preview;
  - a plan to confirm, with Cancel focused by default;
  - a receipt with Undo;
  - a compact answer that says what it is based on;
  - utilities: tasks, focus timer, clipboard, launcher, media;
  - customisation: appearance, personality, voice, abilities, placement;
  - the full hub.
- **Failure states.** "Email this draft" is refused because Gmail is not connected. "Put Terminal next to the Sheet" runs, but the check afterwards reports that the window is not where it was meant to go, and offers "Put it back".
- **Material.** Smoked glass with more opaque content zones for reading. Glass controls get a local edge highlight on hover and focus.
- **Perimeter edge light, driven by state:**
  - none at idle;
  - a soft edge on hover or focus;
  - a level-following edge while listening;
  - one orbiting trace while a step runs;
  - one completion sweep;
  - a steady amber edge on error.
  - It can be set to On, Subtle or Off.
- **Expressions.** Flow core (default), an original particle flow field with an ASCII skin drawn from the same field; Arc core, the app's shared WebGL renderer. An optional vapor grid appears behind the open island.
- **Desktops.** Dark, light and busy mock desktops test readability.
- **Motion.** Full or reduced. Reduced keeps every state legible through static edges and text.

## What is real and what is not

| Real | Scripted or mock |
| --- | --- |
| The Arc core is the app's shared renderer and saved appearance; the flow core takes the saved inner light | Every answer, plan, transcript and the listening level (marked "Scripted") |
| Open full hub loads the real hub on its browser preview bridge (demo data) | The desktop, its windows and the region, which is a rectangle on a mock, never a capture |
| Focus returns to the mock app you were typing in; Ctrl+Space and Esc work | No model, microphone, screen capture or network request (the capture report records zero external requests) |
| The focus timer counts; voice samples use this browser's voices only when you press the button | Always-on-top, focus with other apps, Windows desktop blur, multiple displays and DPI: these need the native build |

`backdrop-filter` here blurs only the mock desktop this page draws. It does not show how the real Windows desktop looks behind an Electron window. That needs the native material (`backgroundMaterial: 'acrylic' | 'mica'`, documented for Windows 11 22H2+ in the installed Electron 44.7.0) and its own test, with a solid fallback.

## Performance notes (prototype)

- One scheduler draws every flow-core canvas. It stops when nothing is active, pauses while the page is hidden, and runs at 12 fps at rest and 60 fps only during an active state. Under reduced motion it draws a single still frame.
- The core's glass shell is static CSS.
- The listening level updates React about 15 times a second, not every frame.
- The perimeter trace animates one CSS custom property, and only in the working state.

None of this has been measured on Windows hardware.

## Files

- `jarvis-desktop/prototype/`: `index.html`, `main.tsx`, `Prototype.tsx`, `flow.ts`, `script.ts` (every scripted line, in plain sight), `prototype.css`.
- `jarvis-desktop/vite.prototype.config.mjs` builds into `dist-prototype/` (git-ignored); `scripts/prototype-review.mjs` produces the captures in this folder.
- Captures:
  - `01`…`08` are the states, on the dark desktop at 1280×720 and 1440×900;
  - resting, invoked, answer and customise also on the light and busy desktops;
  - `edge-*` shows hover, working, done and error;
  - `journey-1280x720.webm` is the guided journey, recorded in headless Chromium with software rendering, so its timing is not representative.
