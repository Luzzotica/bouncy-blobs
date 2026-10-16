# Level files

Levels are JSON files you can edit and re-run without recompiling.

| What | Where |
|---|---|
| The 10 story chapters | `crates/bb-game/assets/levels/campaign/ch01.json` … `ch10.json` |
| Party maps (plain levels) | `crates/bb-game/assets/levels/party/*.json` |
| Your own levels | anywhere; play them with `BB_LEVEL_FILE=path` |

The chapter files are the **source of truth**. They're compiled into every
build (`include_str!` in `crates/bb-level/src/campaign/mod.rs`), so web, iOS
and Android need no file access; the game, the tests and the playtest bot
all load the same files.

## The edit loop

```sh
# Play chapter 3; a dev build reads the file off disk and reloads it live.
BB_LEVEL=ch03 cargo run -p bb-game
# Any level file (a blueprint, a plain level or a legacy 2.x map).
BB_LEVEL_FILE=/tmp/my-level.json cargo run -p bb-game
```

Save the file and the level reloads in place within a quarter of a second:
Pip stays where it was (or, if that spot is now inside rock, goes to the
nearest checkpoint), and dying respawns at the checkpoint nearest to where
you were. If the file has a mistake, the game keeps the last good version
and shows what's wrong in the top-left corner (and in the log). Watching is
on in debug builds; `BB_WATCH=0` turns it off, `BB_WATCH=1` turns it on in
release. Story mode (`BB_START=story`) also reads chapters off disk in debug
builds, but only when a chapter starts.

Then check it:

```sh
cargo run -p bb-level --example validate                  # all 10 chapters
cargo run -p bb-level --example validate -- ch03          # one chapter
cargo run -p bb-level --example validate -- my-level.json # any file
cargo run -p bb-level --example validate -- --fmt ch03    # also tidy the layout
```

`validate` explains problems in plain words with the line and piece
(`ch03.json:57: piece 42 (ledge): error [seam]: …`). Flags: `--quick` skips
the slower resting-at-respawns check, `--fmt` rewrites blueprint files in the
canonical layout (values unchanged), `--strict` fails on warnings too. Then
run the tests that matter for level data:

```sh
cargo test --release -p bb-level --test campaign --test gadgets --test puzzles
```

## Coordinates and units

* World units are **pixels**, **y points up**. `[x, y]` is a point.
* A chapter's spawn is usually near x = 0, y = 40; floors at y = 0.
* Angles in **pieces** are **degrees** (90 = straight up, 0 = right).
  Raw level data (`prop`, `mover`, `gadget`, `terrain`, `npc`, and plain
  level files) uses **radians**, like the engine.
* Speeds are px/s; accelerations px/s²; times seconds.
* Player scale: Pip is 64 px across (radius 32), rests ~58 px tall, rolls
  58–66 px tall and squishes (stick down) to 40–44 px. A comfortable jump
  rises 190 px; a comfortable running gap is 260 px (`builder::metrics`).
* **Waypoints are feet positions** (on the surface you stand on).
  Checkpoints are given as the surface point too; the respawn is 40 px up.

## A blueprint file

A blueprint is a header plus a list of **pieces** applied in order. Each
piece is an object with exactly one key, its kind:

```json
{
  "blueprint": 1,
  "id": "ch01",
  "name": "Too Bouncy",
  "theme": "hollow",
  "about": ["Free-form notes, one string per line."],
  "bottom": -1200,
  "kill_y": -1000,
  "spawn": [250, 40],
  "intro": "ch01_intro",
  "outro": "ch01_outro",
  "pieces": [
    {"section": "hop lessons"},
    {"ledge": {"x0": 2150, "x1": 2700, "y": 80}},
    {"note": "hop (+80)"},
    {"drops": {"x0": 2300, "x1": 2600, "y": 80, "n": 3}},
    {"wp": ["jump", 2290, 80]},
    {"spikes": {"a": [4000, -20], "b": [4240, -20]}},
    {"checkpoint": [3000, 230]}
  ]
}
```

Header fields:

| Field | Meaning | Default |
|---|---|---|
| `blueprint` | Format marker | 1 |
| `id` | Level id. `ch01`…`ch10` turns on the campaign rules | required |
| `name` | Shown in menus | required |
| `theme` | `hollow` `drip` `fungus` `vines` `stoneworks` `lake` `chimney` `toys` `cave_in` `well` `playroom` `kids` `party` | `hollow` |
| `about` | Notes (list of lines) | `[]` |
| `bottom` | Floors and ledges are solid rock down to this y | -1400 |
| `kill_y` | Anything below this pops (campaign: `bottom + 200`) | required |
| `spawn` | Where Pip starts (centre, not feet) | required |
| `intro` / `outro` | Cutscene ids before / after the level | `""` |
| `pieces` | The level, in build order | required |

Order matters only where a piece reads what came before (`hang` and
`roof_spikes` follow the roofs above them; pedestals of `shroom` / `tramp`
follow the floor under them), and for draw order of overlapping things.

### Layout rules of the file

The canonical layout (`validate --fmt`, and what the tools write) keeps key
order fixed, puts each piece on one line when it fits in 120 columns, wraps
long point lists like a paragraph, and writes whole numbers without `.0`.
Values round-trip exactly. You don't have to keep the layout by hand; any
valid JSON loads.

## Pieces

`[x, y]` is a point; *optional* fields can be left out.

### Notes and the path

| Piece | Example | What it does |
|---|---|---|
| `section` | `{"section": "the crawlspace"}` | A heading. No effect. |
| `note` | `{"note": "why this is here"}` | A comment. No effect. |
| `wp` | `{"wp": ["jump", 2290, 80]}` | Critical-path waypoint (feet position) and how you get there from the previous one: `walk` `jump` `drop` `squeeze` (roll squished under a low ceiling) `dash` (time a gap in a hazard) `push` `spring` (springs, mushrooms, gears, pods) `rope` `wind` (updrafts, balloons) `ride` `swim` `wall` (sticky walls) `prop` (stand on a prop you pushed in). The bot follows these and the audits check them. |

### Ground and rock

Jelly-skinned ground is a rock core with a 26 px wobbly jelly skin on top
(tiles up to 280 px long that overlap 3 px; they never collide with each
other). Its **surface** is the top of the skin: the y you give.

| Piece | Fields | What it builds |
|---|---|---|
| `floor` | list of points, left to right | Jelly-skinned ground following the points, rock down to `bottom` |
| `ledge` | `x0` `x1` `y` | A flat `floor` from x0 to x1 |
| `shelf` | `x0` `x1` `y` `depth` | A floating jelly-topped rock shelf `depth` thick |
| `ground` | `top` (points) `depth`, *`material`* (`ground`), *`wobble`* (0.5) | General jelly-skinned ground, `depth` below its lowest point |
| `roof` | list of points | Cave roof whose underside follows the points (500 px thick); `hang` / `roof_spikes` follow it |
| `ceiling` | `bottom` (points) `height` | A ceiling slab (not a roof: nothing hangs from it) |
| `wall` | `x0` `x1` `y0` `y1` | A rock rectangle |
| `block` | `min` `max`, *`material`* | A rock rectangle of any material (`ground` `stone` `ice` `sticky` `bouncy`) |
| `poly` | `points`, *`material`* | A rock polygon (counter-clockwise) |
| `one_way` | `x0` `x1` `y` `thick` | A board / membrane you jump up through and land on; `y` is its top |
| `ramp` | `a` `b` | A solid wedge from a to b |
| `jelly` | `min` `max` `wobble` | A free wobbly jelly block (0 firm … 1 very wobbly) |
| `terrain` | raw `Terrain` | `{"shape": …, "material": …, "one_way": false}` |
| `entry_cave` | `x_far` `x_face` `y` `top` `theme` | The opening wall with a sealed tunnel at floor height `y`, glowing `theme` (the previous chapter's). Rock spans x_face..x_far up to `top`; builds its own tunnel floor. |
| `exit_cave` | `x_face` `x_far` `y` `top` `theme`, *`daylight`* | The closing wall with the exit tunnel and the goal deep inside. `daylight: true` = sunlight beyond (the finale). |

### Soft things and props

| Piece | Fields | What it builds |
|---|---|---|
| `bridge` | `a` `b` `thick` `stiffness` | Soft bridge pinned at both ends (0 floppy … 1 firm) |
| `slab` | `center` `size` `stiffness` | A floating jelly slab that bobs |
| `lily` | `surface` `width` | A lily pad on water whose surface is at `surface` |
| `crate` | `at` `size` | A pushable box (`size` px square) |
| `ball` | `at` `radius` `color` | A ball (`"#ff6b6b"`; `""` = theme colour) |
| `seesaw` | `id` `pivot` `length` `mass` | A rock wedge with a plank balanced at `pivot` |
| `prop` | raw `Prop` | `{"id", "kind": {"type": "block"/"ball"/"star"/"custom", …}, "center", "size", "angle", "mass", "material", "color", "pinned"}` |

### Moving things

| Piece | Fields | What it builds |
|---|---|---|
| `elevator` | `a` `b` `width` `period`, *`phase`* | A platform ping-ponging between centres a and b (`period` s per cycle; `phase` 0..1) |
| `piston` | `x` `roof` `floor` `phase`, *`spiked`* | A 210 px crusher hanging from a roof at height `roof`, slamming onto the floor at `floor`; `spiked`: teeth underneath |
| `crusher` | `top` `width` `drop` `phase`, *`spiked`* | A crusher by its top and drop |
| `blade` | `center` `size` `speed` | A spinning blade (rad/s) that pops what it touches |
| `drip` | `top` `fall` `radius` `phase` | A spiky goo drop: waits at `top`, falls `fall` px |
| `conveyor` | `at` `length` `speed` | A stone belt whose top-left is `at` |
| `mover` | raw `Mover` | `{"shape", "path" (offsets), "motion": {"type": "loop"/"ping_pong"/"crusher"/"spin"/"lift", …}, "period", "phase", "material", "trigger", "lethal", "spiked"}` |

### Ropes and vines

| Piece | Fields | What it builds |
|---|---|---|
| `vine` | `top` `length`, *`knob`* | A grabbable vine; `knob: true` adds a little root knob of rock to hang from |
| `rope` | `from` `to` `length` `style`, *`knob`* | Ends: `{"type": "world", "at": [x, y]}`, `{"type": "free", "at": …}`, `{"type": "body", "id": "prop id"}`. Style: `vine` `rope` `chain` `slinky` |

### Zones

| Piece | Fields | What it builds |
|---|---|---|
| `water` | `min` `max` | Still water |
| `current` | `min` `max` `flow` | Water with a current (px/s² push) |
| `wind` | `min` `max` `accel` | Wind / updraft. `[0, 1400]` lifts a puffed-up blob, `[0, 2200]`+ lifts anyone |
| `zone` | `min` `max` `kind` | Any zone: `{"type": "goo", "drag": 5}`, `{"type": "kill"}`, `{"type": "gravity", "gravity": [x, y]}`, `{"type": "conveyor", "speed": …}`, `{"type": "wind", "accel": …}`, `{"type": "water", "buoyancy", "drag", "current"}` |

### Springs, mushrooms, hazards

| Piece | Fields | What it builds |
|---|---|---|
| `spring` | `at` `angle` `power` | A spring pad launching along `angle`° at `power` px/s |
| `spikes` | `a` `b` | Spike strip along a→b; teeth point to the left of a→b (left to right = teeth up) |
| `ceiling_spikes` | `x0` `x1` `y` | Teeth hanging down from a ceiling underside at `y` |
| `roof_spikes` | `x0` `x1`, *`gaps`*, *`keep`* | Teeth along the roof underside from x0 to x1, leaving `keep` px clear around each x in `gaps` (vine roots) |
| `mushroom` | `base` `height` `shape` `size` `power`, *`angle`* (90) | A bouncy mushroom: rock stalk `height` tall at `base`, soft cap (`flat` `dome` `ball`) |
| `shroom` | `x` `base` `cap` `power` `shape` | A bouncy mushroom by its **cap top** (x, cap) standing on the floor at `base`; low caps get a rock pedestal that follows the floor |
| `trampoline` | `base` `height` `cap` `power` | A jelly-capped mushroom with a spring pad on top (`cap` = cap width) |
| `tramp` | `x` `base` `cap` `power` | A trampoline by its cap top (with a pedestal if low) |

### Gadgets

| Piece | Fields | What it builds |
|---|---|---|
| `launch_plate` | `center` `radius` `speed` `angle` `clockwise` | A spinning gear that grips and flings you along `angle`° |
| `seed_pod` | `base` `height` `angle` `sweep` `power` | A pod cannon on a stalk; nods `sweep`° either side of `angle`° |
| `balloon` | `at` `duration` | A balloon to tie on |
| `crane` | `home` `drop` `travel` | A claw crane that carries you from `home` to `drop` |
| `gadget` | raw `Gadget` | `{"pos", "kind": {"type": "launch_plate"/"launcher"/"balloon"/"crane", …}}` (radians) |

### Progression, characters and story

| Piece | Fields | What it builds |
|---|---|---|
| `checkpoint` | `[x, y]` | A checkpoint flower on the surface at (x, y); respawn 40 px above |
| `pickup` | `[x, y]` | One glow drop |
| `pickups` | `a` `b` `n` | `n` drops evenly from a to b |
| `pickup_arc` | `a` `b` `h` `n` | `n` drops along a jump arc peaking `h` above |
| `drops` | `x0` `x1` `y` `n` | `n` drops hovering 45 px over the surface at y |
| `npc` | raw `Npc` | `{"id", "pos", "role": "huddle"/"trapped"/"follower"/"wanderer"/"glimmer"/"granny"/"reg", "color", "radius"}` |
| `say` | `x0` `x1` `y` `script` | A story trigger: a band from y-200 to y+600 across x0..x1 (fires once) |
| `story` | `min` `max` `script` | A story trigger over any rectangle |
| `goal` | `min` `max` | The goal rectangle (`exit_cave` places its own) |

Story lines live in `crates/bb-game/src/story/scripts.rs` (`level_lines`
for triggers, `cutscene` for intros / outros); `validate` checks every
trigger has words.

### Decor

| Piece | Fields | What it builds |
|---|---|---|
| `decor` | `kind` `at` `scale` `depth` | One sprite (`crystal` `mushroom` `glowworm` `drip` `sock` `crayon` `block_letters` `lulu`…); depth < 0 behind gameplay, > 0 in front |
| `scatter` | `kind` `x0` `x1` `y` `step` `depth` | Decor every `step` px along x0..x1 at height y |
| `hang` | `kind` `x0` `x1` `step` | Decor hanging from the roof every `step` px |

## Plain level files

A file without `"pieces"` is a plain level (format v3, `crates/bb-level/src/types.rs`):
the expanded data itself, with arrays `terrain`, `jelly`, `platforms`,
`props`, `movers`, `ropes`, `zones`, `springs`, `spikes`, `mushrooms`,
`checkpoints`, `pickups`, `npcs`, `story`, `decor`, `mouths`, `gadgets`,
plus `goal`, `spawn`, `kill_y`, `theme`, `modes`, `gravity`, `intro`,
`outro`. Party maps use it. Shapes are
`{"type": "rect", "center", "size", "angle"}`, `{"type": "poly", "points"}`
or `{"type": "circle", "center", "radius"}`. Plain levels have no critical
path, so the path rules are skipped. Legacy 2.x maps load too (converted on
load).

## Mistakes the loader explains

* Bad JSON: `line 12, column 5: not valid JSON: trailing comma (JSON doesn't allow a comma before ] or })`
* Unknown piece: `line 57, piece 42 (ledg): unknown piece type `ledg`: did you mean `ledge`?`
* Unknown field: `unknown field `x2`: did you mean `x1`? (this piece takes: x0, x1, y)`
* Missing field: `missing field `y``
* Wrong value: `wrong kind of value: found a string "80", expected a number`
* Ignored field in raw data: `unknown field `npc.colour` was ignored (did you mean `color`?)`

## Design rules `validate` and the tests enforce

From `docs/LevelDesign.md`; checked by `bb_level::lint` (geometry) and
`bb_sim::validate` (needs the simulation), which the campaign tests call too.

| Rule | Check | Test |
|---|---|---|
| **Danger is always visible** (rule 1): no spike strip / kill zone more than `MAX_HAZARD_DEPTH` = 260 px below the path (nothing solid between; standing on a pushed prop doesn't count) | `hazard-depth` | `hazards_are_never_deeper_than_the_screen_shows` |
| **No cheese** (rule 5): where the path swings over a spike pit, ≥ 40% of the roof over it has spikes | `no-cheese` | `vine_crossings_have_spiked_ceilings` |
| **Checkpoints after every hard beat** (rule 6): 3–5 checkpoints in path order, ≤ 4800 px of path between respawns; 30–60 drops; ≥ 2 story beats named `chNN_…`; ≥ 8000 px of path; intro/outro `chNN_intro`/`chNN_outro`; a goal | `structure` | `chapters_have_story_structure` |
| **Decor stands on something** (rule 7): crystals, mushrooms, socks, crayons, toy blocks aren't floating or buried | `decor` | `ground_decor_is_grounded` |
| **Bookended by caves** (rule 10): one entry cave glowing the previous chapter's theme, one exit cave glowing the next (ch10: daylight), goal inside the exit tunnel, tunnels open, no "sun" lights | `caves` | `chapters_are_bookended_by_caves` |
| **Nothing buried**: drops (12 px), goal (40), checkpoints (30) and waypoints (feet + 32, 20 px) aren't in rock or jelly | `buried` | `goal_and_pickups_are_not_in_rock` |
| **The path fits the controls**: jumps rise ≤ 190 px and fit the reach for that rise; drops drop; walks have ground underfoot and are ≤ 1.2 steep; landings have ground (assisted moves skipped) | `path` | `critical_paths_respect_jump_metrics` |
| **Respawns are safe**: a blob dropped at the spawn and every checkpoint settles on ground there within 5 s without popping or sliding away | `respawn` | `rest_chNN` |
| **Clean seams**: floors whose ends nearly meet must meet exactly (no few-px gaps, overlaps or steps under 16 px); no two floors over the same stretch; no rock poking into a jelly skin (end walls at the core, 26 px below the surface); no jelly overlapping jelly from another piece; floors meeting flush at the same height are merged into one `floor` (warning) | `seam` | `seams_are_clean` |
| **Every story beat has words** | `story-lines` | `validator_passes_the_campaign`, bb-game `every_campaign_beat_has_words` |
| **The ch01 crawlspace needs a squish**: 51 px tall (rolling and ceiling-crawling get stuck; squished passes) | — | `ch01_crawlspace_needs_a_squish` |

Puzzle and gadget set-pieces have their own tests (`tests/puzzles.rs`,
`tests/gadgets.rs`): push puzzles are solvable and can't be skipped, each
gadget plays the right way and fails the wrong way.

## Code

* Format and expansion: `crates/bb-level/src/blueprint.rs` (`Piece`,
  `Blueprint::expand`), helpers in `builder.rs` (`LevelBuilder`, `metrics`).
* Loading with explanations: `crates/bb-level/src/load.rs`.
* Canonical layout: `crates/bb-level/src/pretty.rs`.
* Rules: `crates/bb-level/src/lint.rs`, `crates/bb-sim/src/validate.rs`.
* The command: `crates/bb-level/examples/validate.rs`.
* Live reload: `crates/bb-game/src/level_files.rs`.
