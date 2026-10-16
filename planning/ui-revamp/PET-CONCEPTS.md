# Pet concepts: three original directions for owner review

**Status: briefs only. No concept art exists yet, and nothing here is approved.** This session has no image-generation tool; see `PET-ART-HANDOFF.md`. The owner chooses a direction after seeing generated canonical bases. Species and names stay open until then. The code names below are not names.

All three are made for this app: a desktop computer-use companion that stands on the Windows desktop beside a smoked-glass bubble. Claude answers there and acts with confirmation.

- **Pikachu and Tom & Jerry are references for appeal only:** big readable acting, a recognisable silhouette, physical comedy and warmth. No shape, marking or colour scheme is taken from them or from any other existing character.
- **Forbidden as the pet:**
  - a ball with eyes, or an orb with ears;
  - a stock robot head or a CSS blob;
  - a ghost, wisp or spirit flame;
  - a cursor, paperclip or file icon;
  - Anthropic's or Claude's mark.

## Shared production rules for every direction

These come from `pet-skill-reference/sprite-sheet-contract.md`.

- **Silhouette and size:**
  - One whole-body silhouette in a 192×208 cell, about 170–185 px tall.
  - Feet or base on a baseline about 12 px above the cell bottom, centred, with nothing clipped.
  - It must read at 64, 96 and 128 px tall.
- **No effects:** no text, logos, shadows, ground planes, glow, halos, sparkles, speed lines or floating symbols. Effects are allowed only when they are physically attached, opaque and extractable.
- **Order of work:**
  1. The canonical base is the only prompt-only job. Every later strip is generated with the approved base attached as a reference, plus an invisible layout guide.
  2. Nine standard strips: idle 6, running-right 8, running-left 8, waving 4, jumping 5, failed 8, waiting 6, running (active work) 6, review 6.
  3. Then a four-pose cardinal strip: 000 up, 090 screen-right, 180 down, 270 screen-left.
  4. Then two coherent eight-pose look rows: 000→157.5 and 180→337.5, clockwise.
- **Jump:** must really leave the baseline, at the same body size, and land on the same baseline.
- **Running-left:** mirrored from running-right only where the asymmetry notes allow it.
- **Gaze:** uses the character's real construction: eyeballs that rotate and a head that turns with follow-through. It never rotates the whole sprite or slides a replacement pupil.
- **Listening and speaking:** need separate later art. They are not in the nine rows.

---

## Direction A: dog-eared bookkeeper creature (playful small creature)

**One line.** A pocket-sized, pear-shaped creature with one ear folded over like the corner of a bookmarked page. Curious, quick and a little smug when it remembers something for you.

**Silhouette.**
- An upright pear: a narrow head flowing into a round belly, with short sturdy legs and small mitten hands.
- Two tall ears. The LEFT ear (viewer's left) stands upright and pointed. The RIGHT ear folds over halfway down at a crisp diagonal, like a dog-eared page.
- A long tail curls up behind one side and ends in a soft brush tuft.
- In solid black at 64 px it reads as a pear with one sharp ear, one bent ear and an S-curve tail. No other character has that outline.

**Proportions.**
- The head is about 40% of the height and the body about 45%; the legs are short (15%).
- Overall height:width is about 1.35:1 without the tail. The tail adds width on one side.
- Ground contact is two rounded feet.

**Face.**
- Two large, glossy, slightly oval eyes, set wide, with white sclera, a deep indigo iris and a single highlight. The eyeballs rotate physically under soft eyelids, which can half-close (smug), widen (surprise) or squint (focus).
- A small rounded coral nose. The mouth is a thin flexible line that can open into a wide grin or a small "o".
- A tiny brow ridge marking above each eye carries worry and pride.

**Palette.** It works on dark smoked glass because of the cream and coral, and on white because of the indigo outline and ink.

| Hex | Role |
|---|---|
| `#F4E9D8` | warm paper-cream body |
| `#2C2F6B` | indigo ink: ear tips, tail tuft, inner-ear lines and a thin outline |
| `#FF8A6B` | coral: nose, inner ears, hand pads |
| `#7FD6C9` | soft mint: one small ink-splash marking on the right hip |
| `#1A1A2A` | eye iris and pupil |

**Material and style.**
- Matte soft-vinyl designer toy (preset `3d-toy`): smooth satin surfaces, gentle subsurface warmth, crisp silhouette.
- Rounded but defined forms, with a thin darker contour on the shadow side for small-size readability.

**Identity feature.** The dog-eared right ear, folded at a diagonal like a bookmarked page corner, plus the ink-dipped brush tail. In motion the folded ear is the character's "remembering" gesture: it flips up when the pet finds something.

**Asymmetry and mirroring.**
- The folded ear (viewer's right) and the hip splash make the design asymmetric.
- **Do not mirror running-left:** a mirror would move the folded ear to the other side. Generate running-left normally, facing left, with the folded ear still on the character's own left side, so it sits on the far side when walking left.

**Personality.** Bookish, eager and fast. It loves finding things ("I kept that for you"). It is a bit proud, quick to be sheepish when wrong, and never mean.

**Motion behaviour.**
- A springy, slightly bouncy trot with short quick steps, and the tail as a counterweight.
- The upright ear twitches. The folded ear flops one beat behind head turns.
- Idle tic: the tail tuft curls and uncurls, with an occasional slow blink.

**Acting per state.**
- **idle:** gentle breathing, a belly rise, one slow blink, the tail tuft curling, the upright ear twitching once.
- **running-right / -left:** a quick trot with arms pumping a little, the tail streaming behind and the folded ear bouncing. The body leans into the direction of travel, with visible alternating feet.
- **waving:** the near hand raises to shoulder height and waggles twice, while the folded ear lifts a little with delight.
- **jumping:** a crouch with the ears compressed, then a launch with the body stretched and the tail straight down. At the peak it tucks with the ears flared, then descends, lands on the same feet and settles with a small squash.
- **failed:** the ears droop, the folded ear drops fully over, and the shoulders slump. It looks at its empty hands, and one small attached tear clings to the lower lid. The tail curls around its feet by the last frame.
- **waiting:** it leans forward on its toes, holds both hands clasped at the chest, raises its eyebrows and wags the tail tip slowly. It looks up at the viewer: "your call?".
- **running (active work):** it stands planted and its hands make quick "riffling through pages" motions at chest height. Its eyes dart side to side, its tongue tip pokes out in concentration and the tail flicks. There is no walking.
- **review:** it leans in with its head tilted and one eye narrowed, a hand on its chin, then does two slow nods with an approving small smile.

**Look mechanics.**
- Feet and belly stay anchored.
- The eyes lead, the head follows by about 60% of the eye angle, and the ears lag one beat and swing with the turn. The folded ear flips forward when looking down.
- **000 up:** pupils at the top of the eyes, chin up and the throat visible.
- **090 screen-right:** pupils at the right edge, head turned right in three-quarter view, the upright ear crossing behind the head.
- **180 down:** pupils at the bottom, head bowed, the top of the head and both ears tipped forward.
- **270 screen-left:** the mirror landmarks, but with the folded ear keeping its own side.

**Listening and speaking, later.**
- **Listening:** the upright ear rotates toward the bubble and the folded ear lifts halfway, with a still, attentive posture.
- **Speaking:** mouth shapes for open, mid and closed, with small hand gestures.
- Both need a separate 6-frame extension each.

**Read at 64 / 96 / 128 px.**
- At 64 px the ear asymmetry, the tail S-curve, the cream body against indigo accents and the two big eyes survive. The nose and the hip splash are lost.
- At 96 px the facial expression reads.
- At 128 px the eyelid acting and the hand pads read.

**Originality notes.**
- **Closest risks:**
  - long-eared cartoon rabbits;
  - Eevee-like fox shapes (large ears plus a fluffy tail);
  - Cinnamoroll (long ears);
  - Scottish-fold cat mascots (folded ears).
- **How it differs:**
  - only one ear is folded, at a page-corner diagonal;
  - the body is a pear-shaped biped with mitten hands, not a quadruped;
  - the tail is a brush tuft with ink-dip colouring;
  - the palette is cream, indigo and coral, not brown, white or blue;
  - there are no cheek markings and no lightning or flame motifs.

**Product fit.** It is a memory-and-notes companion: the dog-ear is literally "I bookmarked that". It is warm enough for daily presence, and its quick, physical acting suits search, find and cite.

**Risks.**
- The folded ear must stay consistent across 73 frames and 16 looks; strengthen it in every row prompt.
- The tail can clip at the cell edge; keep it curled close in running frames.

### Canonical base prompt (prompt-only job, chroma `#FF00FF`)

```
Full-body character sprite of an original small creature for a desktop companion app, front three-quarter view facing slightly to the viewer's left, standing in a calm neutral idle pose, entire body visible with generous empty margin on all sides, centred. Upright pear-shaped body: narrow head flowing into a round belly, short sturdy legs with two rounded feet, small mitten-like hands at its sides. Two tall ears: the viewer's left ear stands upright and pointed; the viewer's right ear folds over halfway at a crisp diagonal like the dog-eared corner of a book page. A long tail curls up behind one side in an S-curve ending in a soft brush tuft dipped in indigo. Large glossy slightly oval eyes set wide, white sclera, deep indigo irises, one small highlight each, soft eyelids, tiny coral button nose, thin friendly closed-mouth smile. Colours: warm paper-cream body (#F4E9D8), indigo ink accents on ear tips, inner-ear lines, tail tuft and a thin contour (#2C2F6B), coral nose, inner ears and hand pads (#FF8A6B), one small mint ink-splash mark on its right hip (#7FD6C9). Matte soft-vinyl designer-toy rendering, smooth satin surfaces, soft top-left lighting, crisp clean silhouette edges. Flat solid pure magenta background (#FF00FF) filling the whole image, no shadow, no ground, no floor line, no text, no border, no other objects, single character only.
```

**Avoid:**
- extra limbs, wings, a cape, clothes or props;
- cheek patches, lightning or flame motifs;
- a cast shadow;
- a gradient background;
- a turnaround or multiple views;
- a cropped tail or ears.

---

## Direction B: fan-crest wind-up automaton (mischievous tiny automaton)

**One line.** A hand-made enamel-and-brass wind-up toy with a folding paper-fan crest that snaps open when it gets an idea. It is a gleeful little tinkerer that always wants to press the button.

**Silhouette.**
- A rounded-triangular "acorn" body: wide at the base, narrowing to the head. It is not a box and not a sphere.
- Two thin jointed legs with flat round feet, and two jointed arms with three-fingered hands.
- A semicircular pleated fan crest stands on top of the head and can fold flat or open wide.
- A wind-up key sticks out of its back on one side.
- In solid black at 64 px it reads as an acorn on stilts with a fan on top and a key on the side.

**Proportions.**
- Body plus head is one continuous shell, about 55% of the height. The crest adds 20% when open and 8% when folded. The legs are 25%.
- Height:width is about 1.4:1 with the crest open.
- It stands on two flat round feet, slightly apart.

**Face.**
- On the front of the shell, two large round eyes behind clear glass domes, like little watch crystals. Each eyeball is a white enamel ball with a black-and-amber iris that rotates freely inside the dome: perfect, physically meaningful gaze.
- Two tiny hinged brass eyelid shutters for blinking, squinting and mischief.
- A small hinged jaw-plate mouth that clacks open for a grin.

**Palette.** On dark glass the cream eyes and brass carry it; on white the teal shell and rust crest carry it.

| Hex | Role |
|---|---|
| `#1F7A78` | deep teal enamel shell |
| `#E3B04B` | warm brass: joints, rivets, key, eye rims |
| `#D9573B` | rust-red pleats on the fan crest, with cream `#F3E6C8` alternate pleats |
| `#F3E6C8` | cream eyeballs and belly plate |
| `#2B2321` | dark iris and joint shadows |

**Material and style.** A glossy painted-tin wind-up toy (preset `3d-toy`): enamel shine with small chips at the edges, brass that catches top-left light, and visible but simple rivets. The details are large enough to survive 64 px.

**Identity feature.** The folding fan crest. It opens with excitement and ideas, flattens with failure, and half-opens while waiting. The back key turns visibly during active work.

**Asymmetry and mirroring.**
- The key sits on the character's left side of the back.
- There is a single chipped-enamel spot on the right shoulder.
- **Generate running-left normally.** A mirror would swap the key side and the chip.

**Personality.** Mischievous, inventive, delighted by buttons and gadgets, and very proud of finished work. It is impatient but kind, and it never rushes you through a confirmation.

**Motion behaviour.**
- A clockwork waddle: quick stiff-legged steps with a slight side-to-side rock, the key ticking round and the crest pleats rippling.
- Idle tic: the crest opens a little and refolds, with a tiny eyelid-shutter blink.

**Acting per state.**
- **idle:** a subtle rocking on its feet, a slow shutter blink, the crest pleats breathing open and shut by a few degrees, and the key turning a quarter.
- **running-right / -left:** a stiff-legged clockwork waddle toward the direction of travel. The body rocks and the arms swing in opposition. The crest leans back slightly and the key spins. The cadence alternates.
- **waving:** one arm raises and the three-fingered hand flicks back and forth twice, while the crest pops fully open.
- **jumping:** it crouches with its knees compressing like springs, then springs up with its legs straight and the crest snapping fully open. At the peak its arms are up, then it descends and lands with a spring-bounce settle on the same feet.
- **failed:** the crest folds down flat and droops to one side, the shutters close halfway and the jaw falls open. One small attached puff of grey smoke comes from the key slot. The key stops turning and the shoulders sag.
- **waiting:** it stands still with both hands held out palms-up, the crest half-open and quivering, and its eyes looking up at the viewer with eyebrows-shutters raised.
- **running (active work):** it stays planted, its hands tinker rapidly in front of its chest as if adjusting tiny gears, the key spins fast, its eyes are focused and slightly crossed, and the crest pleats flutter. There are no steps.
- **review:** it leans forward with one hand at its jaw-plate, its eyes rolling in their domes as if scanning, the crest slowly opening in approval, and a satisfied clack.

**Look mechanics.**
- The feet and lower shell are anchored. The eyeballs rotate inside their glass domes and lead the movement.
- The upper shell twists up to about 25° toward the gaze. The crest leans with the turn and its pleats lag.
- **000 up:** irises at the top of both domes, the shell tilted back and the crest leaning back.
- **090 screen-right:** irises at the right edge, the shell twisted right so the key shows more, and the crest edge-on.
- **180 down:** irises at the bottom and the shell bowed forward, showing the crest's face.
- **270 screen-left:** irises at the left and the shell twisted left.

**Listening and speaking, later.**
- **Listening:** the crest fans toward the bubble like an ear trumpet.
- **Speaking:** the jaw-plate clacks open and shut in three positions.
- Both are separate extension loops.

**Read at 64 / 96 / 128 px.**
- At 64 px the acorn shell, the fan crest, the key nub, the teal against rust and the two cream eyes read. The rivets and chips are lost.
- At 96 px the glass domes read.
- At 128 px the eyelid shutters and the pleat stripes read.

**Originality notes.**
- **Closest risks:**
  - generic wind-up tin robots;
  - cockatoo-crested birds;
  - the Ratchet & Clank robot (big eyes);
  - Wall-E (binocular eyes).
- **How it differs:**
  - the body is an acorn-shaped enamel shell, not a box or humanoid;
  - there is no screen face and no antenna;
  - the eyes are watch-crystal domes with free eyeballs, not binocular lenses on a neck;
  - the folding pleated fan crest and the back key are its signature;
  - the palette is teal, brass and rust.

**Product fit.** It suits an app that actually does things on the computer: a tinkerer that turns its key while working and opens its crest when an action is verified. The tin-toy craft avoids the generic "AI robot" look.

**Risks.**
- The crest's open and folded states must stay consistent.
- The thin legs are fragile at 64 px, so keep them thick enough.
- The smoke puff must be attached at the key slot.

### Canonical base prompt (prompt-only job, chroma `#FF00FF`)

```
Full-body character sprite of an original tiny wind-up automaton toy for a desktop companion app, front three-quarter view, standing in a calm neutral idle pose, whole body visible with generous empty margin, centred. Its body is one rounded-triangular acorn-shaped shell, wide at the bottom and narrowing to the head, painted glossy deep teal enamel (#1F7A78) with a cream belly plate (#F3E6C8) and a few large brass rivets. Two large round eyes on the front of the shell, each a cream enamel eyeball with a dark iris ringed in amber, sitting inside a clear glass dome with a brass rim like a watch crystal; tiny brass eyelid shutters; small hinged brass jaw-plate mouth closed in a cheeky smile. On top of the head a semicircular pleated folding-fan crest, half open, alternating rust-red (#D9573B) and cream pleats. Thin jointed brass legs with flat round feet, slightly apart; jointed arms with three-fingered brass hands relaxed at its sides. A brass wind-up key sticks out from the back on the character's left side; a single small chipped-enamel spot on its right shoulder. Glossy painted-tin toy rendering, soft top-left light, clean crisp edges. Flat solid pure magenta background (#FF00FF) everywhere, no shadow, no ground, no text, no border, single character only.
```

**Avoid:**
- a TV or screen face, antennae or a box head;
- a humanoid robot torso or wheels;
- glowing eyes, glow or sparks;
- a cast shadow;
- multiple views;
- a cropped crest.

---

## Direction C: dusk-felt mothling (soft fantastical animal)

**One line.** A chubby, upright felt-plush moth with feathery antennae, one of them bent, a fluffy apricot collar and tiny two-tone wings. Gentle and dreamy, but it turns toward every light: it notices when the interface lights up.

**Silhouette.**
- A soft upright bean body: wide hips, a fluffy collar ruff at the neck and a round head.
- Two large feathery antennae sweep up and out. The RIGHT one (viewer's right) has a soft kink partway up.
- Two small rounded felt wings sit behind the shoulders. Four stubby mitten limbs: two arms and two legs.
- In solid black at 64 px it reads as a bean with a ruff, two big plumes on top (one kinked) and two little wing lobes.

**Proportions.**
- The head is 35% and the body 50%, with the antennae adding 30% above the head.
- Height:width is about 1.3:1 with the antennae.
- Two short legs with soft round feet.

**Face.**
- Two large dark glossy eyes, deep plum-black, each with two highlights and visible soft felt eyelids. The eyeball surface rotates: the highlights stay put while the dark iris area shifts. This is legible because each eye has a thin cream rim of sclera at its edge.
- No nose. A small soft mouth that can smile, pout or form an "o".
- The antennae work like eyebrows: up for curiosity and drooped for sadness.

**Palette.** On dark glass the apricot collar and lavender wings pop; on white the plum body anchors it. There is no green, so the chroma key is green.

| Hex | Role |
|---|---|
| `#5B3A6E` | dusk-plum felt body |
| `#F6B47C` | apricot collar ruff and antenna plumes |
| `#C9B8F0` | lavender upper wing |
| `#FFE6C7` | cream lower-wing edge and eye rims |
| `#2A1830` | eyes |

**Material and style.** A felt-and-plush stuffed toy (preset `plush`): a visible soft fuzz texture, a slightly stitched seam down the belly, and a fluffy collar with clumped tufts. Large shapes keep it readable at 64 px.

**Identity feature.**
- The kinked right antenna and the fluffy apricot collar.
- The **light-seeking** behaviour: it turns toward whatever lights up. The app uses this only through real gaze and state rows; the edge light itself stays interface state.

**Asymmetry and mirroring.** The kinked antenna is on the character's left side (viewer's right). **Generate running-left normally**, because a mirror would move the kink.

**Personality.** Gentle, dreamy, attentive and a little shy. It is quietly delighted when helpful, apologetic when something fails, and it never startles you.

**Motion behaviour.**
- A soft waddle-hop: small steps with a little float on each. The wings flutter twice per step but never lift it. The antennae bob with weight.
- Idle tic: an antenna plume preen and a slow sleepy blink.

**Acting per state.**
- **idle:** a slow breathing puff of the collar, the antennae swaying slightly out of phase, a slow blink and the wings settling.
- **running-right / -left:** a soft waddle-hop toward the direction of travel. The wings flutter, the antennae stream back and the feet alternate.
- **waving:** one mitten arm waves overhead, and the kinked antenna does a little wave too.
- **jumping:** it crouches with the collar squashed, then hops up with the wings flared open and the antennae straight up. It drifts at the peak with its arms out, then floats down and lands softly on the same spot with a collar bounce.
- **failed:** the antennae droop forward over the eyes, the wings fold flat and the collar sags. Its eyes go glossy, with one attached felt-thread tear, and it hugs itself.
- **waiting:** it holds its mittens together in front, tilts its head, perks its antennae fully up toward the viewer, gives tiny hopeful wing flutters and looks up at the viewer.
- **running (active work):** it stays planted with its eyes half-lidded in concentration. The antennae sweep slowly side to side like scanning, its mittens tap together rhythmically and its wings vibrate a little. There are no steps.
- **review:** it leans in, one antenna curls forward to point at the work and its eyes narrow, then it straightens with a satisfied smile and the collar puffs.

**Look mechanics.**
- The feet and lower body are anchored. The dark iris areas shift on the eye surface and lead.
- The head turns up to about 50%. The antennae follow, then overshoot slightly. The collar tufts lag.
- **000 up:** the iris areas at the top with the cream rim visible below, the head tipped back and the antennae streaming back.
- **090 screen-right:** iris to the right rim, head three-quarter right, the far antenna partly hidden.
- **180 down:** iris at the bottom, head bowed, and the antennae tipped forward toward the viewer.
- **270 screen-left:** the mirror of 090, with the kink keeping its side.

**Listening and speaking, later.**
- **Listening:** both antennae swing toward the bubble and the plumes spread.
- **Speaking:** small mouth shapes with a collar puff on each emphasis.
- Both are separate extension loops.

**Read at 64 / 96 / 128 px.**
- At 64 px the bean-and-ruff shape, the two plumes (one kinked), the plum against apricot and the two big eyes read. The felt texture and the seam are lost.
- At 96 px the eye rims read.
- At 128 px the fuzz and the wing two-tone read.

**Originality notes.**
- **Closest risks:**
  - Pokemon moths (Frosmoth, Venomoth, Cutiefly);
  - plush moth fan art;
  - Mothra chibi.
- **How it differs:**
  - it is a chubby upright bipedal plush, not a flying insect;
  - its wings are tiny and decorative;
  - its palette is warm dusk plum and apricot, not white, icy or purple-and-pink;
  - it has a fluffy collar ruff, mitten limbs and one kinked antenna.

  This is still the highest-risk direction for "looks like a Pokemon", so originality must be judged on the generated art.

**Product fit.** It is the softest presence for all-day desktop company: calm idle and quiet acting. Its light-seeking trait ties the character to the smoked-glass interface without plastering effects on it.

**Risks.**
- Feathery antennae can lose definition at 64 px, so keep the plumes broad.
- The eyes are dark without a clear sclera, so the cream rims are essential for readable gaze.

### Canonical base prompt (prompt-only job, chroma `#00FF00`)

```
Full-body character sprite of an original soft fantastical creature for a desktop companion app, a chubby upright plush moth-like being, front three-quarter view, standing in a calm neutral idle pose, whole body visible with generous empty margin, centred. Soft bean-shaped body of dusk-plum felt (#5B3A6E) with a subtle stitched seam down the belly, a big fluffy apricot collar ruff around the neck (#F6B47C), round head, two large feathery antennae plumes in apricot sweeping up and outward, the viewer's right antenna with a soft kink partway up. Two small rounded felt wings behind the shoulders, lavender (#C9B8F0) with cream edges (#FFE6C7). Two stubby mitten arms resting on its belly and two short legs with soft round feet. Two large dark glossy eyes (#2A1830) with a thin cream rim around each and two small highlights, soft felt eyelids, no nose, small gentle smile. Felt and plush stuffed-toy rendering with visible soft fuzz texture, soft top-left light, clean silhouette edges. Flat solid pure green background (#00FF00) everywhere, no shadow, no ground, no text, no border, single character only.
```

**Avoid:**
- large insect wings or flying;
- six legs or segmented insect anatomy;
- white or icy colours;
- glow, glitter or a halo;
- a cast shadow;
- multiple views;
- cropped antennae.

---

## How the owner reviews (gate before any animation work)

For each direction, Codex returns 2–3 canonical base variants and a read test at 64, 96 and 128 px on smoked glass, white and a busy wallpaper (see `PET-ART-HANDOFF.md` step 1). The owner then:

1. picks one direction, or asks for a revision;
2. names it, or leaves it unnamed;
3. confirms the asymmetry and identity feature to lock.

Only then do the strips, the cardinals and the look rows begin. Until then the app shows "Character art not installed", and nothing else stands in for the character.
