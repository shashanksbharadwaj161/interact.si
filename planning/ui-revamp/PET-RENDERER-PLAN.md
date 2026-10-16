# Pet renderer, manifest and desktop overlay: plan and interfaces

This plan puts an original animated character in the app as its primary identity, following `PET-DIRECTION.md` and the production contract in `pet-skill-reference/`.

This document is the contract the implementation follows.

- **Character art:** made only by an image-generation tool and approved by the owner. The app never draws, invents or substitutes the character.
- **What the app does:**
  - load an approved atlas;
  - check it structurally;
  - pick frames from real activity;
  - draw them.
- **Without an approved atlas**, it shows an explicit missing-art state. It never shows a stand-in creature.

## 1. Atlas contract (fixed, from `pet-skill-reference/animation-rows.md`)

- v2 only. The atlas is 1536×2288, with 8 columns × 11 rows of 192×208 cells.
- Frames sit from the leftmost cell of each row. There are 73 required frames, and the 15 unused cells must be fully transparent.

| Row | State | Frames | Durations (ms) |
|---|---|---:|---|
| 0 | idle | 6 | 280, 110, 110, 140, 140, 320 |
| 1 | running-right | 8 | 120 × 7, 220 |
| 2 | running-left | 8 | 120 × 7, 220 |
| 3 | waving | 4 | 140 × 3, 280 |
| 4 | jumping | 5 | 140 × 4, 280 |
| 5 | failed | 8 | 140 × 7, 240 |
| 6 | waiting | 6 | 150 × 5, 260 |
| 7 | running (active work) | 6 | 120 × 5, 220 |
| 8 | review | 6 | 150 × 5, 280 |
| 9 | look 000 … 157.5 | 8 | held while gazing |
| 10 | look 180 … 337.5 | 8 | held while gazing |

- **Look directions:** look index `i` (0–15) sits at row `9 + floor(i / 8)`, column `i % 8`. Its angle is `i × 22.5°` clockwise from up.
- **Neutral:** inside the pointer deadzone the pet plays the normal idle animation.
- **Code:** `src/pet/contract.ts` holds these constants. Nothing else hard-codes geometry.

## 2. Pet pack and manifest (`desktop-companion/pet-pack@1`)

A pack is a folder: `assets/pets/<id>/pet.json` plus the atlas file it names (`.webp` or `.png`). Packs are bundled at build time through `import.meta.glob`. A folder in user data can come later.

```json
{
  "format": "desktop-companion/pet-pack@1",
  "id": "direction-a",
  "name": "Working name",
  "description": "One sentence.",
  "spriteVersion": 2,
  "atlas": "spritesheet.webp",
  "atlasSha256": "64 hex chars of the exact atlas bytes",
  "rendering": "smooth",
  "anchor": { "x": 96, "y": 196 },
  "review": { "status": "concept", "approvedBy": "owner", "approvedOn": "2026-10-20", "notes": "" },
  "qa": { "tool": "create-pet bundled scripts (version)", "atlasValidation": "qa/validation-extended.json", "petQuality": "qa/pet-quality.json" },
  "source": "Generated with … from brief planning/ui-revamp/PET-CONCEPTS.md Direction A",
  "license": "Original artwork owned by the project"
}
```

**Field rules:**
- `rendering` is `smooth` or `pixelated`.
- `anchor` is the ground-contact point inside a cell, in cell pixels.
- `review.status` is `concept`, `in-review` or `approved`.
- `review.approvedBy` and `review.approvedOn` are required only when the status is `approved`.

**Parsing (`parsePetManifest`) is strict:**
- it rejects unknown keys;
- `id` must match `[a-z0-9-]{1,40}`;
- `name` is 1–40 characters and `description` at most 200;
- `atlas` must be a plain file name in the pack folder (`.webp` or `.png`, no path separators);
- `atlasSha256` is 64 lower-case hex characters;
- `anchor` must lie inside the cell.

**Approval gate:** the product companion uses only packs with `review.status === 'approved'`. The review board and tests can show `concept` and `in-review` packs, and always labels them with their status. A pack is never treated as approved because it exists.

**Integrity:** the loader checks the atlas bytes against `atlasSha256` before decoding. A mismatch makes the pack invalid.

## 3. In-app load check (`src/pet/atlas-check.ts`)

This is a pure function over decoded RGBA pixels. It checks only what the app needs before it will draw a pack:

- dimensions are exactly 1536×2288;
- each of the 73 required cells has at least 200 pixels with alpha ≥ 16;
- each of the 15 unused cells is fully transparent;
- warnings for a pose touching its cell edge (possible clipping or bleed);
- per-frame alpha bounds and a coarse 24×26 hit mask (8×8 px blocks, alpha ≥ 64), used for click-through hit testing.

**This is not the create-pet skill's validation.** The bundled `validate_atlas.py` and `validate_pet_quality.py` gates, and the semantic direction QA, run in the art pipeline and are recorded under `qa` in the manifest. The app never reports its own check as theirs.

## 4. Animation clock (`src/pet/clock.ts`)

- **One shared scheduler for every pet on the page.**
  - Each sprite registers a subscription that returns its next frame-change time.
  - The scheduler sets one `setTimeout` for the earliest change, then draws in one `requestAnimationFrame`. Nothing runs between frame changes.
  - At most 10 frame changes a second for the standard rows.
- **Pausing:**
  - when `document.visibilityState === 'hidden'`;
  - for a sprite whose canvas is not intersecting;
  - when the companion window is hidden.
- **Reduced motion:** no subscriptions. Each state shows one still key frame, idle frame 0 by default (§5).
- **Calm idle:** after one full idle loop the pet holds frame 0 for a random 2–5 s before the next loop. Randomness comes from an injected source, so tests are deterministic. This keeps idle redraws to about 1–3 a second.
- **Animator:** `Animator.play(sequence, {loop, onDone})` computes the current frame from elapsed time, with no per-frame state drift. It is pure given `now`.

## 5. State adapter (`src/pet/adapter.ts`, pure)

The adapter turns real companion signals into what the pet shows. It never invents activity: every state can be traced to an event from the main process or a person's input.

```ts
type PetSignals = {
  surface: 'rest' | 'command' | 'working' | 'answer' | 'error';
  requestInFlight: boolean;        // status 'sending'/'thinking' or a tool 'running'
  awaitingPerson: boolean;         // a tool step in 'awaiting-confirm'
  failure: null | 'setup' | 'refused' | 'truncated' | 'steps' | 'provider' | 'network' | 'cancelled';
  dragVx: number | null;           // px/s while the person drags the pet; null when not dragging
  gaze: number | null;             // degrees clockwise from up, from the local cursor; null in the deadzone or when stale
  reducedMotion: boolean;
};
type PetEvent = { kind: 'invoked' } | { kind: 'verified-change' } | { kind: 'answer-shown' };
type PetView =
  | { kind: 'state'; state: PetState; loop: boolean; still: boolean; reason: string }
  | { kind: 'look'; index: number; reason: string };
```

**Priority, highest first:**

1. Being dragged with `|dragVx| ≥ 60` → `running-right` or `running-left`, looped. This is physical movement the person causes.
2. `failure` set and not `cancelled` → `failed`, played once and then held on the last frame while the error shows.
   - Cancel is the person's own choice and shows idle.
   - A declined confirmation is not a failure.
3. `awaitingPerson` → `waiting`, looped. A confirmation is really open.
4. `requestInFlight`, or a surface of `working` → `running` (active work), looped.
5. One-shot events, played once:
   - `verified-change` → `jumping`. It fires only when a tool reported `verified: true`.
   - `invoked` → `waving`. It fires when the person opens the companion.
6. Surface `answer` after `answer-shown` → `review`, played twice, then falls through.
7. `gaze` not null, not reduced motion, surface `rest` or `command` → `look` at index `round(gaze / 22.5) mod 16`.
8. Otherwise → `idle`, using calm idle.

**Reduced-motion key frames:** idle 0, waiting 2, running 2, failed 7, review 2, waving 2, jumping 0 (no jump), running-left 0 and running-right 0.

**Listening and speaking:** `listening` and `speaking` are not in the v2 contract. The adapter does not map them to any row. Until a pack declares separate listening/speaking art (a future manifest extension with its own atlas), voice state is shown only by:
- the bubble's real microphone status;
- the measured level meter;
- the edge light.

The pet keeps its contract state. No lip sync is simulated.

## 6. Renderer and missing-art state

- **`src/pet/loader.ts`:**
  - looks a pack up in the bundled registry;
  - fetches the atlas bytes and checks the SHA-256 (with `crypto.subtle`);
  - decodes with `createImageBitmap(blob)`;
  - runs the load check once through an `OffscreenCanvas` and keeps only the per-frame masks, not the pixel buffer;
  - caches by id with reference counts. Release calls `bitmap.close()` at zero.
  - Results are `{status: 'ready', pack, bitmap, check}`, `{status: 'invalid', errors}` or `{status: 'missing', reason}`.
- **`src/pet/PetSprite.tsx`:**
  - one `<canvas>` sized to the display height `size` (64–128 CSS px) and width `size × 192/208`, scaled for the device pixel ratio (capped at 2);
  - it draws only when the frame changes;
  - `rendering` sets `imageSmoothingEnabled`;
  - unmount unsubscribes from the clock and releases the pack;
  - the canvas is `aria-hidden`, and the accessible status text, taken from `PetView.reason`, lives outside it.
- **`src/pet/PetSlot.tsx`:** the one place the companion's identity is drawn. It shows exactly one of:
  - the approved pack;
  - the legacy orb, only when the person chose the legacy appearance;
  - **MissingArt**, a calm glass slot reading "Character art not installed" with the reason, for example "No approved pet pack yet. Three concept directions are waiting for review." There is no creature, face or silhouette, and no procedural stand-in.
- **Hit testing:** `hitTest(view, x, y)` uses the current frame's coarse mask, so clicks on transparent pixels around the pet pass through to the desktop (§7). With MissingArt, the slot's rectangle is the hit area.

## 7. Desktop overlay (native)

The island window becomes the pet window: the pet plus a bubble beside it. It keeps everything from 545dc41:
- its own IPC table and preload;
- exact sender trust;
- per-window checks;
- a region capture token;
- a trusted confirm owned by this window;
- no window in test mode or safe launch.

**Placement (`electron/companionCore.ts`, pure, tested):**
- **Placement point:** the pet is placed by its ground point `P`, the feet, in global DIP coordinates. The pet box is `w = round(size × 192/208)` by `h = size`, with its bottom centre at `P`.
- **Size:** `size` ∈ [64, 128], with presets S 64, M 96 and L 128.
- **Bubble side:**
  - The bubble goes on the side of the pet facing the centre of the work area, with its bottom 30% of the pet height above the pet's feet.
  - If the bubble plus the pet are wider than the work area, the bubble goes above the pet.
  - The bubble is clamped inside the work area without moving the pet.
- **Window bounds:** the union of the pet and bubble rectangles plus the 18 px margin, clamped to the work area. The page receives window-relative rectangles for the pet and the bubble and positions them absolutely, so the bubble follows the pet wherever it is.
- **Docking:**
  - When a drag ends with the pet box within 40 px of a work-area edge, the pet snaps to that edge, 12 px inset.
  - Bottom docking puts the feet on the edge.
  - The dock edge is remembered.
- **Start position:** bottom-right of the primary work area. The saved position, with its display id, is restored and clamped into the work area of the nearest display. It is clamped again on display changes.

**Dragging and its security:**
- The page sends only `companionDrag('start' | 'end')`.
- Main reads the cursor itself with `screen.getCursorScreenPoint()` at 60 Hz while dragging, moves the window, and pushes the horizontal velocity at ≤ 15 Hz for the running rows.
- Main ends a drag after 20 s with no `end`.
- The page never sends coordinates.

**Keyboard alternative:**
- The bubble's menu has: Move to bottom-left, bottom-right, left, right or top; Size S, M or L.
- Ctrl+wheel over the pet resizes in 8 px steps.
- The size and the dock are remembered.

**Click-through:**
- At rest on Windows the window is `setIgnoreMouseEvents(true, {forward: true})`.
- The page hit-tests forwarded mouse moves against the pet mask and the bubble rectangle, and sends `companionHit(boolean)` only when the answer changes. Main then toggles click-through.
- Transparent margins never block the desktop.
- `forward` exists only on Windows and macOS. On Linux the window stays clickable, and that is documented.

**No focus stealing:**
- At rest the window is `setFocusable(false)`, so dragging or hovering never activates it.
- Opening the command surface (shortcut, or a click on the pet that is not a drag) calls `setFocusable(true)` and `focus()`.
- Collapsing calls `blur()` and then `setFocusable(false)`.

**Local gaze:**
- The page turns gaze on with `companionGaze(true)` only when it is at rest or in command and not in reduced motion.
- Main then polls the cursor at 10 Hz and computes the angle from the pet's head point, at 35% of the box height from the top.
- Main pushes `{type: 'gaze', angle | null}` only when the 22.5° bucket or the deadzone changes. The deadzone is inside the pet box.
- After 8 s with no cursor movement, gaze becomes null.
- Polling stops when the window is hidden, the screen locks, or the page turns gaze off.
- Cursor positions stay inside the app: they never reach a model, the activity log or disk.

**New companion IPC methods (argument-checked like the rest):**
- `companionLayout({bubble: {width, height} | null})`, which returns the computed placement;
- `companionDrag(start | end)`;
- `companionHit(boolean)`;
- `companionResize(S | M | L | grow | shrink)`;
- `companionDock(bottom-left | bottom-right | left | right | top)`;
- `companionGaze(boolean)`;
- `companionSetAppearance(pet | legacy-orb)`.

The security regression test keeps asserting the exact companion channel set.

## 8. What needs art, and from whom

- **Concept art:** the canonical base for each of the three directions, then the owner picks one. This needs `$imagegen`, which is not available in this Claude Code session; prepared prompts are in `PET-CONCEPTS.md`.
- **Full production:** 9 strips, 4 cardinals and 2 look rows, assembled with the create-pet bundled scripts. These files are not in this repository or session:
  - `prepare_pet_run.py`
  - `extract_strip_frames.py`
  - `inspect_frames.py`
  - `compose_atlas.py`
  - `make_contact_sheet.py`
  - `render_animation_previews.py`
  - `extract_cardinal_anchors.py`
  - `compose_cardinal_anchor_strip.py`
  - `assemble_extended_atlas.py`
  - `despill_chroma_edges.py`
  - `validate_atlas.py`
  - `make_direction_qa_sheet.py`
  - `measure_direction_continuity.py`
  - `validate_pet_quality.py`
  - `make_direction_blind_qa_sheet.py`
  - `combine_direction_blind_verdicts.py`
  - `validate_direction_blind_verdicts.py`
- **Listening and speaking art:** a later, separate request.
