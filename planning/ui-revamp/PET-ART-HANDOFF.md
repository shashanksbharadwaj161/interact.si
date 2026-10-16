# Pet art: availability, missing pieces and handoff to Codex

16 Oct 2026, from the Claude Code session on branch `claude/compassionate-hawking-m9x36g`.

## (a) What this session can and cannot do: checked, not assumed

| Need | Status here | How it was checked |
|---|---|---|
| Image generation (`$imagegen` or any image model) | **Not available** | `ToolSearch` for image-generation tools returned none. Installed skills (`~/.claude/skills`) include no image generator. No MCP server in this session generates images. |
| Third-party image plugins | **Not used** | The plugin directory lists some (for example Clipwave/ManyMotions, CellCog, Klin), none enabled. Each needs a separate external account and possibly billing, and sends the art direction to a third party. That is the owner's decision; nothing was installed. |
| create-pet bundled scripts | **Missing** | `find /` found none of `prepare_pet_run.py`, `validate_pet_quality.py` or `compose_atlas.py`. Only `SKILL.md`, `sprite-sheet-contract.md` and `animation-rows.md` were supplied; they are kept unchanged in `pet-skill-reference/`. |
| `references/upload-session.md` | Not supplied | Not needed: no ChatGPT upload happens in our app |
| ChatGPT Library, Pets MCP (`validate_pet_spritesheet`, `prepare_pet_upload`, `create_pet`, `select_pet`, `list_pets`) | **Not applicable** | These are host-specific and do not exist in our app. Our equivalent is the repository plus the in-app load check (`PET-RENDERER-PLAN.md` §3). It is never reported as the skill's validation. |
| Python 3.13 + Pillow 12.3, ImageMagick, ffmpeg | Available | `python3 -c "import PIL"`, `which convert ffmpeg`. Used only for deterministic work: the test pattern, contact sheets and previews of real art. |
| Peer agent (Codex) reachable from this session | No | `ListAgents`: no reachable sessions. This document is the handoff. |

**Consequence:**
- **No character art exists yet.** No concept is approved.
- **The app shows an explicit missing-art state.** No drawn stand-in is used.
- **The three concept directions are briefs.** They are written as prompts for an image model, in `PET-CONCEPTS.md`.

## (b) What we need from Codex, in this order

### Step 1: canonical bases only, for owner review

Do **not** start animation production yet. The skill says to get owner approval of the canonical character before spending on full animation.

For each of Directions A, B and C in `PET-CONCEPTS.md`:

1. Run its **base prompt** as a prompt-only `$imagegen` job. Use the chroma key named in that direction.
2. Generate 2–3 variants and keep all of them. Pick the one that best matches the brief's silhouette, palette, face and 64 px read.
3. Save into `planning/ui-revamp/pet-art/<direction>/base/`:
   - each raw output, unedited;
   - `prompt.txt`, the exact prompt sent;
   - `job.json`: tool, model, size, seed if any, date and chroma key;
   - `read-test.png`: the chosen base after chroma removal, shown at 64, 96 and 128 px. Show it on our smoked glass `#0B0F18`, on white and on a busy wallpaper. The wallpaper must be original or a photo you have rights to.
4. Do not edit the character by hand or with code. Deterministic chroma removal and resizing for the read test are fine.
5. Commit to a branch for review and tell the owner. The owner chooses one direction, or asks for changes, before step 2.

### Step 2: after the owner picks a direction, full v2 production

Follow `pet-skill-reference/create-pet-SKILL.md` and `sprite-sheet-contract.md` exactly, with the **bundled scripts**. Do not use replacements. This needs the create-pet skill's `scripts/` directory. If Codex has it, use it there. If the owner wants the pipeline reproducible in this repository, add the bundle as-is with its licence under `tools/create-pet/`. The scripts we need are:

```
scripts/prepare_pet_run.py
scripts/extract_strip_frames.py
scripts/inspect_frames.py
scripts/compose_atlas.py
scripts/make_contact_sheet.py
scripts/render_animation_previews.py
scripts/extract_cardinal_anchors.py
scripts/compose_cardinal_anchor_strip.py
scripts/assemble_extended_atlas.py
scripts/despill_chroma_edges.py
scripts/validate_atlas.py
scripts/make_direction_qa_sheet.py
scripts/measure_direction_continuity.py
scripts/validate_pet_quality.py
scripts/make_direction_blind_qa_sheet.py
scripts/combine_direction_blind_verdicts.py
scripts/validate_direction_blind_verdicts.py
```

The job order is the skill's:

1. Approved base.
2. `idle` and `running-right` first. They are the identity and gait checks.
3. The remaining seven strips. Each is generated separately and grounded on the base and a layout guide.
4. Rows 0–8 assembled and reviewed.
5. The cardinal strip: 000 up, 090 screen-right, 180 down, 270 screen-left.
6. Look row 9, registered.
7. Look row 10.
8. Despill once.
9. `validate_atlas.py --require-v2`.
10. Contact sheet, direction QA sheet, continuity, and `direction-semantics.json`.
11. `validate_pet_quality.py`.
12. A blind direction review, if reviewers are available.

**Motion evidence:** the per-state GIFs, the all-state GIF and MP4, the idle → jump → idle loop at native cell bounds, the ordered look loop, and four labelled stills.

### Step 3: deliver into our app

```
jarvis-desktop/assets/pets/<id>/pet.json          # desktop-companion/pet-pack@1, see PET-RENDERER-PLAN.md §2
jarvis-desktop/assets/pets/<id>/spritesheet.webp  # the exact validated bytes (or .png)
planning/ui-revamp/pet-art/<id>/                  # source art, rows, frames, QA reports, previews (all of it)
```

- **`pet.json` fields:**
  - `atlasSha256` is the SHA-256 of the exact validated file.
  - `qa` points at the saved `validation-extended.json` and `pet-quality.json`.
  - `review.status` is `"in-review"` until the owner has seen the motion previews and approved them. Then set `"approved"` with `approvedBy` and `approvedOn`.
- **How the app treats it:**
  - The app refuses to show a non-approved pack in the product companion.
  - The app's own load check (§3) still runs, and a structural failure keeps the pack out.
  - Re-run the skill's validation after any visual change. The bytes must not change after validation.

## (c) Separate later art requests (not in the nine-row contract)

- **Listening and speaking:** short loops, for example 6 frames each, grounded on the approved base. They are delivered as a separate extension atlas, never squeezed into the v2 sheet. Until this exists the app shows voice state only through the bubble's real microphone status, the level meter and the edge light.
- **Optional:** a small "carrying" pose for future drag-and-drop file actions. This is only after the core product works.
