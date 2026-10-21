# Pet packs

One folder per character pack: `assets/pets/<id>/pet.json` (format `desktop-companion/pet-pack@1`, see
`planning/ui-revamp/PET-RENDERER-PLAN.md` §2) and the atlas file it names (`spritesheet.webp` or `.png`, v2:
1536×2288, 8×11 cells of 192×208, 73 frames).

- The folder name must equal the manifest `id`.
- The loader's product mode requires `review.status: "approved"` with owner approval metadata and QA report paths.
  Review mode permits a clearly labelled draft. The current review build explicitly selects the validated First Light
  animation in review mode in the hub, onboarding and floating companion; this does not grant owner approval or allow
  arbitrary concept packs into product mode.
- `atlasSha256` must be the SHA-256 of the exact atlas bytes; the app refuses a mismatch, and
  `tests/pet-renderer.test.mjs` checks every pack here.
- Never install test patterns or hand-made placeholders as character packs. Invalid/missing atlases show the real
  load error, not a simulated animated character.

First Light contains an original generated v2 atlas, exact-byte QA reports and provenance. It remains **in review**.
See `planning/ui-revamp/pet-art/first-light-motion-2026-10-18/README.md` for generated source/preview records.
