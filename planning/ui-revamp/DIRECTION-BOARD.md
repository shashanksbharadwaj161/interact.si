# Direction board: character-led companion (candidate, for owner review)

**Status:** this is a candidate direction and nothing is approved.

- **Character art:** none exists on this branch. This session has no image tool, and Codex's concept art for Direction A is on Codex's own branch.
- **Live view:** the board is `jarvis-desktop/prototype/board.html`. Build it with `npm run prototype:build`, then `npx vite preview --config vite.prototype.config.mjs` and open `http://127.0.0.1:4329/prototype/board.html`.
- **Recorded evidence:** in `planning/ui-revamp/direction-board/`, captured with `node scripts/board-review.mjs`:
  - stills at 1280×720 and 760 px;
  - the renderer in every signal state;
  - a motion recording (`board-renderer-motion.webm`);
  - `capture-report.json`: 0 page errors, 0 console errors, 0 external requests and 0 horizontal overflow.

## What the board shows (all production components unless marked)

1. **The character: three original directions.** These are the briefs from `PET-CONCEPTS.md`, with palette swatches and the space the character takes at 64, 96 and 128 px. Each art slot is the app's own missing-art state, never a drawn stand-in.
2. **Renderer and motion driven by real signals.**
   - The app's sprite renderer (`src/pet/PetSprite.tsx`) and state adapter (`src/pet/adapter.ts`) play the engineering **test pattern**, which is flat labelled rectangles reading "TEST PATTERN … not character art".
   - The buttons feed the adapter the same signals the desktop window produces:
     - open (one wave);
     - request in flight, which shows the active-work row;
     - confirmation open, which shows waiting;
     - a verified change (one jump with a real lift);
     - answer shown (review twice);
     - provider error (failed, held on the last frame);
     - cancelled, which shows idle because cancelling is not a failure;
     - drag left or right (directional rows);
     - reduced motion, which shows still key frames with no gaze.
   - The pointer sweeps the 16 look cells, computed locally.
   - Approved art drops into the same component with no code change.
3. **Typography rendered at app sizes.** Three OFL pairings each show:
   - the first-run line at 30 px;
   - a bubble title at 17.5 px;
   - body text at 14.5 px;
   - metadata at 12.5 px;
   - controls;
   - the proof string `Il1| O0o rn m 5S 8B — "Task #1I0l" ĀčĘłŐ`.

   Packages, versions and licences are printed from `prototype/fonts/fonts.json`.
4. **Glass, controls and edge light.**
   - Controls are pills with neutral hairlines. Hover or focus lights the control's own edge.
   - The bubble's perimeter light has five states, each tied to a real event:
     - idle: no light;
     - request in flight: one slow trace;
     - confirmation open: a held violet rim;
     - answer arrived: one sweep, then off;
     - error: a held amber rim.
5. **Surfaces.** All use sample content, labelled.
   - Resting: the character only.
   - Invoked command: placement options, plus the remembered "typing goes to" window with Remove.
   - Listening: **a proposal only; voice is not built.**
   - Working, waiting for the Windows confirmation.
   - Answer with citations: a checked change with Undo, and a typed change marked "no undo".
   - Error.
6. **First run: a proposal for `Onboarding.tsx`, which Codex owns.**
   - A compact scene: the character slot with a bubble saying "Hi! I live on your desktop now."
   - One useful offline action: "Tell me one thing to remember" saves a real note. The character reacts only after the note is read back.
   - "Connect Claude" keeps the existing vault and confirmation flow.
   - It replaces the giant heading, the two dashboard cards and the chrome sphere.

## What changed from the rejected screenshots

| Rejected | Now |
|---|---|
| Chrome sphere as identity and onboarding hero | An original animated character, from an approved atlas only. The orb is an optional "Legacy orb" look. |
| Clipped-corner panels | A rounded speech bubble with a tail that points at the character |
| Cyan outlines everywhere | Neutral hairlines. Cyan and violet appear only as state light (edge trace, focus). |
| Uppercase letter-spaced labels and tiny tech lettering | Sentence case. Bricolage Grotesque for titles; Figtree body at 14–14.5 px, with 12.5 px the smallest meta text. |
| Flat near-black panels | Smoked glass with depth: a lifted top, an inner highlight and a layered shadow. It is near-opaque because a transparent Electron window has nothing to blur. |

## Recommendation and open choices

- **Typography.** I recommend Bricolage Grotesque with Figtree. The bubble in this branch already uses them (OFL; licence texts are in `public/licenses/`). The alternatives are Fraunces (soft) with Atkinson Hyperlegible Next, or Unbounded with Onest.
- **Hub routes are not restyled yet.** That waits for owner approval of this direction, as the brief requires.
- **Before full animation production, the owner picks a character direction** from real generated canonical art (Codex has started on Direction A).
- **Native window composition is unverified.** The board is browser rendering. The transparent window, acrylic and click-through need the Windows checks in `COMPANION-STATUS.md`.
