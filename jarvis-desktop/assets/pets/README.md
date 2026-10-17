# Pet packs

One folder per character pack: `assets/pets/<id>/pet.json` (format `desktop-companion/pet-pack@1`, see
`planning/ui-revamp/PET-RENDERER-PLAN.md` §2) and the atlas file it names (`spritesheet.webp` or `.png`, v2:
1536×2288, 8×11 cells of 192×208, 73 frames).

- The folder name must equal the manifest `id`.
- The product companion shows a pack only when `review.status` is `"approved"` (with `approvedBy`, `approvedOn` and
  the `qa` report paths from the create-pet pipeline). `concept` and `in-review` packs appear only on the review board,
  labelled with their status.
- `atlasSha256` must be the SHA-256 of the exact atlas bytes; the app refuses a mismatch, and
  `tests/pet-renderer.test.mjs` checks every pack here.
- Never put concept art, generated test patterns or hand-made placeholders here. Until a real approved atlas exists
  the companion shows "Character art not installed".

This folder is empty on purpose: no character atlas has been produced or approved yet (see `PET-ART-HANDOFF.md`).
