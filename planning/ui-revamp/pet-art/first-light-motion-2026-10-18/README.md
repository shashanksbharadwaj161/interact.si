# First Light: animation review, 18 October 2026

Original generated cream/indigo creature, one folded ear, brush tail, mint side marking. This is a **review pass**, not owner-approved final art. No character implementation or asset was copied from an avatar repository. ChatGPT's installed create-pet v0.1.6 artwork workflow was adapted for this desktop app; no ChatGPT Pets record or Library account was created or changed.

## Exact shipped artifact

- `final/spritesheet-extended.png`, also installed at `jarvis-desktop/assets/pets/first-light/spritesheet.png`.
- PNG RGBA, 1536 × 2288, eight columns/eleven rows, 192 × 208 cells, 73 required frames; 2,593,570 encoded bytes.
- SHA-256 `b481a82dac79a9c95bed1d61e782ccdd521a5939dcd69824b3d222fe6bf2aae9`.
- Nine real generated animation strips and sixteen physical look poses; actual jump lift 38px and landing delta 0. Not a CSS transformation of the concept image.
- `imagegen-jobs.json` records jobs and references; `prompts/` contains the prepared prompts and mechanics. All thirteen jobs completed. The base reused the existing inspected canonical character. The failed-state source was regenerated after the first strip touched adjacent poses.

## Processing and review

Used the installed skill's bundled preparation, component extraction, frame inspection, cardinal extraction, atlas composition, extended-row registration, one final chroma-despill pass, exact-byte validation, continuity measurement, contact/direction sheets, per-state GIF renderer and final quality gate. The script versions live in the installed skill; generated processing reports and prompts are retained here.

`final/validation-extended.json` and `qa/pet-quality.json` both pass for the exact bytes above. Standard-row component checks pass. No mandatory structural error was waived. The quality report retains **19 warnings**: four subtle intermediate-direction semantics plus continuity/alpha-hole heuristics, all visible in the report. The baseline-adjacent one/two-row alpha gaps and recorded direction changes were reviewed on the contact sheet; do not describe this as flawless final animation. No independent blind reviewers were used, because the current repository assignment prohibits additional agents.

Raw source strips, extracted frames and intermediate atlases remain on this laptop in this same run directory, ignored by Git to avoid duplicating large intermediate assets. Final art, reference guides, prompts, QA and final previews are retained in the review branch. Nothing was deleted.

## Motion evidence

- `final-previews/all-states.gif` and `all-states.mp4`: all nine states, using only known cells from the exact encoded atlas. MP4 is a timing-preserving copy, not generated/interpolated extra poses.
- Per-state GIFs, `idle-jump-idle.gif` at native cell bounds, `look-loop.gif`, four labelled-by-filename stills, and `qa/final-contact.png` / `qa/directions.png`.
- `qa/studio-flow.png`: real local browser UI. The banner correctly identifies unavailable native/cloud features in browser preview.
- `qa/native-playback.json` and `native-companion.png`: real Windows Electron, isolated offline profile, scripted invocation. Seven checks pass: validated character rendered, draft label, multiple actual wave columns, saved reduced motion reaching the separate companion document, still key pose, hidden-page throttling/visibility, zero external requests. No microphone, provider call or external-app input was used.

## Runtime fixes exposed by the native test

The browser preview alone missed a real floating-window freeze: timers and page visibility remained live, while requestAnimationFrame stopped delivering. The shared clock now races rAF against one 64ms fallback, with exactly-once completion. It still schedules only the next pose change and pauses when hidden. Visible native windows avoid background throttling; hiding restores it. This is tested recovery, not a measured 60fps claim. The base v2 art itself changes at its contract's roughly 7–10 poses/second; a higher-resolution continuous rig or denser baked animation remains a separate art-quality improvement.

Companion status now returns only the saved reduced-motion boolean needed by the floating document, not the full application state. A visible-only status refresh applies changes from the hub. The raw Windows cursor stays in main and is reduced to the existing sixteen gaze buckets.

## Next art iteration

Judge the actual animated preview before choosing a new design or recording owner approval. Improve the specific source states/directions identified by feedback; rebuild previews and validate the changed encoded bytes. For large cinematic previews, design a consistent higher-resolution animation format or rig rather than stretching this 192 × 208-cell contract, adding CSS bobbing or blurring unrelated poses together.
