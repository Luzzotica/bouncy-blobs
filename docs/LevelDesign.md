# Level design rules

The rules every story chapter (`crates/bb-level/src/campaign/chNN.rs`) follows.
Where a rule can be checked mechanically, a test checks it
(`crates/bb-level/tests/campaign.rs`, `crates/bb-level/tests/puzzles.rs`).

## 1. Danger is always visible

A hazard you can't see is a cheap death. **No spike strip or kill zone sits
more than `metrics::MAX_HAZARD_DEPTH` = 260 px below the player's line**: the
ledge you approach from, and the line you jump, swing, ride or float along.

Where the number comes from (the camera, `bb-game/src/camera.rs`):

| | px |
|---|---|
| Minimum visible height at zoom 1 (`VIEW_H`) | 860, so 430 below centre |
| View centre above the blob's centroid (`CAM_LIFT`) | 80 |
| Blob centroid above its feet (`PLAYER_R`) | 32 |
| Margin at the bottom of the screen (HUD, vignette; a tooth must clear it) | 58 |
| **Deepest hazard below your feet** | 430 - 112 - 58 = **260** |

Standing on a ledge, the bottom of the screen is 318 px below your feet; a
spike floor 260 down sits comfortably in view, teeth and all. Pits are still
deep enough to matter (260 > the 190 px jump). If a gap needs to *look* deep,
make it wide, not deep.

Test: `hazards_are_never_deeper_than_the_screen_shows` samples the critical
path every 20 px and measures the drop to any floor hazard directly beneath
(nothing solid in between). Standing on a pushed prop doesn't count (the prop
is what's under you).

## 2. One new toy per chapter

Introduce it safely, develop it, twist it, then combine it with earlier toys.

## 3. Squishy-object puzzles

Push, stack, squash, wedge, ride, weigh down, plug, float. Current set:

| Chapter | Puzzle | Verb |
|---|---|---|
| ch02 | Huge jelly ball into a spiky trench, roll across | push (intro) |
| ch08 | Big bouncy ball into the V pit (existing); then a pair of balls into a 1000 px gap | push, develop |
| ch08 | See-saw over the ball pit (existing) | weigh down |
| ch09 | Boulder into the collapse hole so the Huddle can cross | push, remix |

Measured facts to design around (from the sim, not the metrics table):

* **Walls are climbable.** A blob mashing jump against any wall (rock, stone,
  even ice) gets up 650+ px. Height gates ("stack a crate to reach the
  ledge") don't work; gate with *gaps* and *hazards* instead.
* **A running swell-jump reaches about 750-800 px** on the flat, far beyond
  `metrics::GAP` (the *comfortable* gap). A gap the player must bridge with
  a prop needs to be **at least ~900 px** wide.
* **Soft blocks ride up over a pushing blob** (the blob wedges under the
  bottom edge). Use **balls** for anything you push; they roll.

Test: `push_puzzles_are_solvable` pushes each prop in and crosses;
`push_puzzles_cannot_be_skipped` removes the props and requires the running
jump to fail.

## 4. Every section asks for a blob verb in a new context

Roll, swell-jump, squash, cling/climb, float, swim, grab.

## 5. No cheese

A section gated by a mechanic can't be skipped by crawling along the
ceiling or climbing a wall. Wherever a vine, slinky or rope crosses a spike
pit, the roof above it carries ceiling spikes (`Ch::roof_spikes`, leaving the
vine roots clear), or the ceiling is out of reach.

Test: `vine_crossings_have_spiked_ceilings`.

## 6. Checkpoints after every hard beat

A retry costs under ~30 s (`chapters_have_story_structure` caps the path
between respawns at 4800 px).

## 7. Readability

One colour per mechanic per level; hazards always read as hazards (red-tipped
teeth, spiked undersides on falling rocks). Decor stands on something:
`ground_decor_is_grounded` fails on floating crystals, mushrooms or toys. No
big round "sun" lights; the light at the end of a level is its exit cave.

## 8. Rhythm

Tension, rest, vista. Pickups trace the intended line and hint at secrets.

## 9. Two routes where possible

A safe one and a skilful / faster one.

## 10. One set-piece per level, bookended by caves

Every chapter starts beside a **sealed entry cave** (a rock-fall plugs the
way back; it glows with the *previous* chapter's colour) and ends by walking
into an **exit cave** (it glows with the *next* chapter's colour; the goal is
deep inside so you see yourself walk in). ch01's entry is the Back Drip
(Hollow purple); ch10's exit opens onto daylight.

Authoring: `Ch::entry_cave(x_far, x_face, floor_y, top, prev_theme)` and
`Ch::exit_cave(x_face, x_far, floor_y, top, next_theme)` build the rock with
the tunnel cut into it and add a `CaveMouth` to `Level::mouths`;
`bb-game/src/mouths.rs` paints the light. Test:
`chapters_are_bookended_by_caves`; `camera::tests::exit_cave_keeps_the_blob_framed`.

## 11. Momentum moments are verified

Slopes into jumps (ch01's kicker) are checked by tests, not hoped for.

## Hazards on movers

`Mover::spiked` (builder: `.spiked()` after adding the mover) puts teeth on a
crusher's / falling rock's underside: touching its bottom face pops you, even
while it hangs. ch05 has spiked pistons among plain ones; ch09's "jagged"
rubble is spiked.
