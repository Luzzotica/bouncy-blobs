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

## Gadgets

JellyCar-style machines (`Level::gadgets`, run by `bb-sim/src/gadgets.rs`,
drawn by `bb-game/src/gadgets_view.rs`). Each is one chapter's new toy, laid
out intro → develop → twist (rule 2), with a checkpoint before the hard
part. Path moves: flings and pods are `Move::Spring`, claw rides
`Move::Ride`, balloon flights `Move::Wind`.

| Gadget | Builder | How it plays | Chapter |
|---|---|---|---|
| Spinning launch plate (stone gear) | `launch_plate(centre, radius, speed, angle_deg, clockwise)` | Touch it: it grips you to its rim, spins up (~1 s) and lets go at the point where its rim moves along `angle`, at `speed` px/s (= the rim speed you rode at). Swelling within `bounce_window` of the release (or just after) adds `bounce_boost` (×1.4 speed, about twice the height). | ch05: up onto a ledge over safe floor → across a 950 px spike pit → the last gear only reaches the floating shelf with the swell boost |
| Seed pod (launcher) | `seed_pod(base, height, angle_deg, sweep_deg, power)` | Roll/fly within 66 px of its mouth and it swallows you (held still). Its barrel nods `sweep` either side of `angle` (glowing seeds show the throw). Press to fire (after 0.3 s) or it fires itself after 2.5 s, at `power` px/s (world-gravity units, like springs). Pods catch you in flight too. | ch04: lob onto a branch → a nodding pod over a 1000 px bramble gulf (fire when it points high) → fire into a pod hanging mid-gulf, which nods too |
| Balloon | `balloon(pos, duration)` | Touch it to tie it on. Lift = 0.62 g deflated (you sink, ≤ 300 px/s) to 1.34 g fully puffed (you rise, ≤ `rise` 380 px/s); sideways ≤ 540 px/s. Lasts `duration` s (blinks near the end), pops on spikes, blades, spiked movers and kill zones (then you fall), floats back 2 s later. A roof stops the balloon, so you can't crawl a ceiling with one. | ch07: float up onto a shelf over safe floor → drift across a 1000 px gulf (puff to climb, let go to sink) → a needle flue with spiked roof, spiked floor and a fang: fly high and it pops |
| Claw crane | `crane(home, drop, travel)` | Stand under the claw (±64 px, up to 230 below): it reaches down, grabs, lifts, carries you to `drop` in `travel` s, pauses, opens, and goes home. | ch08: a ride over a spike gulf → a drop over an 80 px prize chute beside the toy-box lid: at rest size (64 px) you fall through; swollen (128 px) you wedge across and roll onto the lid |

Design numbers: a gear centred 192 px above a floor hangs so a rolling blob
touches its underside (its ride circle never dips into the floor). Gaps a
gadget gates are 900+ px (unjumpable), and the roof over them is 700+ px up
or spiked (`gadget_crossings_have_no_ceiling_shortcut`). Tests:
`bb-sim/tests/gadgets.rs` (mechanics) and `bb-level/tests/gadgets.rs` (each
set-piece played in its chapter, including the wrong way failing).
