# Island production shell: integration contract for CompanionApp (18 Oct 2026)

- **Branch:** `claude/compassionate-hawking-m9x36g`.
- **Covers:** the shared island shell, its motion system and the island controller.
- **Not edited:** `CompanionApp.tsx` (owned by Codex). The patch below is for Codex to apply.

## What exists

| Export | File | What it is |
|---|---|---|
| `CompanionIsland` | `src/companion/island/CompanionIsland.tsx` | The whole island, end to end (see below). |
| `IslandShell` | `src/companion/island/IslandShell.tsx` | The glass shell only (see below). |
| `contentRect` | `src/companion/island/IslandShell.tsx` | Content placement inside the bubble box. |
| `islandReducer`, `islandEdge`, `workLine`, `verifiedChanges`, `initialIsland` | `src/companion/island/state.ts` | Pure island state from real events, light rules, and the named operation (no percentages). |
| `useIslandRun`, `islandPetSignals` | `src/companion/island/useIslandRun.ts` | Ask, stop and undo over `window.companion`; signals for the pet adapter. |
| `MOTION`, `EASE`, `createRectAnimator`, `seedRect` | `src/companion/island/motion.ts` | Tokens, easing and the interruptible animator. |
| `useReducedMotion` | `src/companion/island/useReducedMotion.ts` | Live: OS setting or `data-motion="reduced"`. |
| `WorkView`, `ConfirmView`, `ErrorView` (with `kind`, `draft`, `onBack`, `autoFocus`), `Command` (new optional slots) | `src/companion/surfaces.tsx` | Shared surfaces. |
| Styles | `src/styles/companion-bubble.css` (`.cd.isl`, `--isl-*` tokens) | All scoped. `island.css` is not touched. |

### `CompanionIsland`

It owns:
- the run (with early events buffered and late events ignored);
- the command, working, confirmation, answer and error views;
- the context chips for the remembered window and the picked area;
- the voice session and Talk;
- Escape and the tray toggle;
- the native layout requests.

### `IslandShell`

- The glass is text-free and is resized directly, never scaled.
- Content is laid out at its final size, crossfaded, and revealed through a clip that follows the glass.
- Each move starts from the shape as drawn now, and a superseded move cannot complete.
- `onClosed` fires only after the close animation.

### Motion

- **Tokens:** press 100, hover 160, fade 150, expand 380, collapse 240 and morph 300 ms.
- **Easing:** no curve overshoots.
- **Stall watchdog:** if animation frames stop arriving (48 ms without one), timers draw instead. Completion happens exactly once, and moves finish at once while the document is hidden. This is for the transparent, non-activating window on Windows, where `requestAnimationFrame` stops after one callback.

### Agent events (additive)

- A running step can carry `stage: 'verifying'`.
- An error can carry `kind: 'offline' | 'limit' | 'key'`.
- The existing `reason` values are unchanged, so current pages compile.

### Confirmation

`createTrustedConfirm(summary, detail, signal?)`: the companion passes the run's AbortSignal, so Stop closes an open Windows confirmation as Cancel.

## Two ways to integrate

You already wired voice into your `CompanionApp` (commit c775160), so choose one of these.

### A. Full island (recommended)

Use `<CompanionIsland>` and delete your own bubble, run, voice and Escape code. Keep the pet code: placement for the pet, drag, gaze, wheel resize, PetIdentity and the hit test.

```tsx
import {CompanionIsland} from './island/CompanionIsland';
import {PlacementOptions} from './surfaces';
import type {Rect} from './island/motion';

const islandRect = useRef<Rect | null>(null);
// …inside the page, next to the pet:
<CompanionIsland
  api={api}
  options={<PlacementOptions size={status.size} dock={status.dock} appearance={status.appearance}
    onDock={(d) => void api.dock(d)} onResize={(s) => void api.resize(s)} onAppearance={(a) => void api.setAppearance(a)} />}
  onHitRect={(r) => { islandRect.current = r; }}
  onPetSignals={(s) => adapter.signal({...s, dragVx, gaze: gazeIndex === null ? null : gazeIndex * 22.5, reducedMotion}, performance.now())}
/>
// hit test (document mousemove): over = petHit(x - pet.x, y - pet.y) || inside(islandRect.current, x, y)
```

Remove from `CompanionApp`, because the island now does each of these:
- all `api.layout(...)` calls;
- its own Escape handler. If you keep one, ignore events where `e.defaultPrevented` is true; the island calls `preventDefault`.
- run state and its early-event queue;
- region and target state, and the `invoke`, `collapse`, `region` and `target` handling for the bubble.

Keep:
- the placement push for the pet position;
- `{type:'drag'}` and `{type:'gaze'}`;
- calling `api.hit` from your hit test;
- the pet adapter, using `onPetSignals`.

Voice:
- The island creates its own `useVoiceSession` over `companionVoiceBackend`, renders `VoiceBar` and `TalkButton`, and shows an explicit **Allow microphone** chip.
- If you prefer your voice wiring, use path B instead. Two voice sessions in one page would compete for the microphone.

### B. Shell only (keep your views and voice)

Wrap your existing views in the shell, and move the layout calls to its callbacks:

```tsx
<IslandShell open={surface !== 'rest'} view={surface} box={placement?.bubble ?? null} side={placement?.side ?? 'left'}
  edge={edge} edgeKey={doneKey} label="Desktop companion" reducedMotion={useReducedMotion()}
  onContentSize={(size) => { if (surface !== 'rest') void api.layout({bubble: size}); }}
  onClosed={() => void api.layout({bubble: null})}
  onRect={(r) => { islandRect.current = r; }}>
  {/* your current command / working / answer / error view, keyed by surface */}
</IslandShell>
```

The rules:
- `view` must change only when the view changes, not on every progress event.
- Do not call `api.layout({bubble: null})` anywhere else.
- Pass `autoFocus={placement?.bubble != null}` to the surfaces, so the caret moves in once, when the island is visible.

## Your local changes to preserve when merging

- **Fractional-DPI placement** (actual bounds read after `setBounds`, local coordinates rebased). The shell follows whatever `placement.bubble` it gets and never assumes the requested size was granted. It works with your fix as is.
- **Your rAF watchdog** in the pet clock. The island's animator has its own watchdog, so the two do not interact.
- **`reduceMotion` on companion status.** `CompanionIsland` reads it through an optional field on status (no type change, to avoid a conflict), and also follows `data-motion` live.
- **Your voice wiring in `CompanionApp`.** Under path A, keep only one voice session.

## Evidence (Linux container; not the native app)

**`tests/island-shell.test.mjs`: 14 tests, all passing.** They cover:
- motion tokens equal in TypeScript and CSS, with no overshoot;
- the easing solver;
- the animator: frames, exactly-once completion, reversal from the drawn shape, the stalled-frame watchdog, hidden documents, jump;
- seed and content geometry;
- the reducer along the full run: sending, tool, confirmation, checking, answer;
- no done light without a verified change;
- late and old-run events are ignored;
- the tray returns to the right view, and collapse keeps a run going;
- failure kinds;
- Stop closes the confirmation as Cancel, and a Continue that races the Stop does not count.

**`scripts/island-journey.mjs`: 14 of 14 steps pass** (`planning/ui-revamp/island/`: 15 screenshots, `island-journey.webm`, `island-journey.json`). It drives the production `CompanionIsland` in headless Chromium over original light, dark and busy mock desktops, with a **scripted** `window.companion` (labelled on the page). It checks:
- the window grows before the glass moves, and the glass settles exactly on the content;
- the caret lands in the field once;
- the chips can be removed;
- a click on the message field during a morph reaches it;
- the light is `working` while working, `waiting` at the confirmation, and `done` only after a verified change;
- the island offers no approve button;
- the window shrinks only after the last close frame, with exactly one shrink request;
- the shape continues through open, close, and reopen before the close finished;
- typing is labelled "not read back" with no done light;
- Stop is idle, not an error, and keeps the request;
- offline is its own error, with Settings;
- under reduced motion it opens in place;
- 0 console errors and 0 external requests.

**Frame timing** was measured in that headless Chromium only. It says nothing about the owner's laptop or the transparent Windows window:

| Phase | Frames | Mean | p95 | Max |
|---|---|---|---|---|
| Open | about 23 | about 16.6 ms | 17.2 ms | 17.3 ms |
| Morphs | about 111 | about 16.4 ms | 18 ms | 22 ms |
| Close | about 15 | about 16.8 ms | 21 ms | 21 ms |

No timer (watchdog) steps were needed there. This is not a claim of 60 fps on Windows.

**Full suite:** 1,737 tests; 1,722 pass and 15 fail. The 15 are the same Windows-path, junction and DPAPI baseline failures as before, checked by name. Typecheck, renderer, main and prototype builds pass.
