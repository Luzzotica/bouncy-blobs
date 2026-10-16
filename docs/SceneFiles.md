# Scene files: one JSON file in, every video and still out

This is the Bouncy Blobs runner for content's scene spec (`content/team/SCENE-SPEC.md`, v0 + v0.1). Content writes the files. Engineering owns the runner and this document. Runnable examples, one per shot type, are in `scenes/examples/`:

- `spike-loop.json`
- `bounce-chain.json`
- `chapter-pan.json`
- `transparent-pose.json`
- `end-card.json`

```
bb-scene validate scenes/examples/spike-loop.json   # plain-word problems, nothing rendered
bb-scene preview  scenes/examples/spike-loop.json   # low-res pass of the whole timeline + the check (~10–20 s)
bb-scene render   scenes/examples/spike-loop.json   # check first, then the final files
   [--seed N] [--out DIR] [--bin path/to/bouncy-blobs]
```

`bb-scene` is a binary of the `bb-game` crate (`cargo build -p bb-game`).

## What the runner guarantees

- **Real game, current build.** `"build": "current"` means the head of `origin/game-polish`. The runner refuses to render if that commit doesn't include `origin/port-capture`, because the capture code there would be stale.
  - It renders with a game built from exactly that commit. If needed it builds it once from a `git archive` export, without touching anyone's worktree, and caches it in `~/.cache/bb-scene/<commit>/`.
  - A `--bin` is only used if it reports the same commit (`BB_PRINT_BUILD=1`).
  - An older commit needs `"allow_old_build": "<reason>"`.
  - NOTES records the exact hash.
- **Real simulation.** Pip moves only through player inputs (`hold`, `release`, `jump`) fed into the real game. Spawn positions are setup.
  - There are no puppeted moves. `staged` exists, but this runner has nothing to stage yet.
- **Declared changes only.** Every way a shot changes the game must be an entry in `capture_only` (see below), with a `why`. That entry is also the only way to make the change, so an undeclared change can't happen.
  - Capture-only stages (`spikeloop`, `transparent`, `endcard`, `logo`, posing stages, inline levels) must be declared as `{"what": "stage"}`.
- **Shipping look only.** Chapter stages are limited to the finished chapters: `the-drip`, `fungus-caverns`, `puddle-lake` and `the-old-well` (or `ch02`, `ch03`, `ch06`, `ch10`).
  - Any other chapter needs `"override": "<reason>"` in `stage`.
  - Built-ins are `title-cave` and `kids`, plus the capture-only stages above.
- **Deterministic.** The same file, build and seed give the same frames.
  - Every output size is rendered from the same script. NOTES says whether their event logs match frame for frame (they always have so far).
  - Takes come from `seeds`: each seed is one take.
- **Clean frame.** HUD, debug, clock, letterbox, speech and tip bubbles are always off.
  - Glimmer is hidden unless `"show": ["glimmer"]`.
  - Glow drops are cleared so Pip never eats a colour, unless `"show": ["pickups"]`. NOTES says so.
- **Audio is offline.** Renders are muted. The music stem, the SFX stems by family and the mix are rebuilt from the game's own sound log, in step with the frames.

## File reference

| field | meaning |
|---|---|
| `scene` | id, used in file names |
| `game` | `"bouncy-blobs"` |
| `build` | `"current"` or a commit (`allow_old_build` + reason for older) |
| `seeds` | `[1, 2]`: one take per seed |
| `stage` | `{"kind": "chapter", "id": "puddle-lake"}`, `{"kind": "builtin", "id": "spikeloop"}`, or `{"kind": "inline", "level": {…the game's level JSON…}}`. Optional `region: [x0, y0, x1, y1]` is the default framing; `theme` must be null; `override` is the reason for an unfinished chapter. |
| `cast` | `[{"id": "pip", "kind": "blob", "color": "pink", "spawn": [x, y], "can_die": true}]`. Colours are Pip's shipped palette: pink, orange, yellow, green, blue, purple, magenta, teal, sky, lime, rose, lavender. Use `[{"from_stage": true}]` for stages whose actors come with them (end card, title, Kids Mode). |
| `inputs` | `{"t": 0.0, "who": "pip", "do": "hold", "key": "right"}`, `{"do": "release", "key": "right"}`, `{"do": "jump", "hold": 0.25}`. `t` is video seconds from frame 1; negative means during the pre-roll. |
| `pre_roll` | seconds of game time before frame 1, so frame 1 is already moving (BB addition) |
| `events` | `{"t": 2.0, "do": "respawn", "at": [x, y]}`: from then on, Pip's next life starts there (needs `capture_only` `respawn_point`) |
| `camera` | the timeline below, rendered for every size |
| `length` | `{"seconds": 11}` or `{"until": "event:pop", "count": 7, "plus": 1.5}` |
| `capture_only` | `[{"what": …, "value": …, "why": …}]` (list below) |
| `show` | `"glimmer"`, `"pickups"` |
| `check` | `band_x` (default 0.25–0.75), `band_y` (default 0–1), `objects` (`"pip"`, `"word:POP!"`), `min_subject_width` (warn on 9:16, default 0.12), `frame1_moving` |
| `outputs` | `{"kind": "video", "size": "1080x1920", "fps": 60}`, `{"kind": "still", "size": "2048x2048", "transparent": true, "at": 1.5 or "event:pop#3"}`. Optional per-output `band_x` (BB addition). |
| `audio` | `{"music_stem": true, "sfx_families": ["pop", "land", "splash", "ui"], "mix": true}` (also `bounce`, `other`) |

### Camera timeline

Each key takes over at `t`. With `by` (seconds) and `ease` (`ease` or `linear`), it blends from where the camera was. Without `by` it cuts.

| `do` | what it does |
|---|---|
| `frame` | Static. Looks at `at`, or at Pip where he is when the key starts (plus `offset`). |
| `follow` | Tracks Pip. `lag` is seconds to catch up (0 = locked). `lead` is look-ahead in seconds of velocity (a number, or `[x, y]`). `deadzone` is `[w, h]` in world px, and `offset` is `[x, y]`. |
| `hold` | Stays where it is. |
| `pan` | Moves to `at` over `by`. |
| `zoom` | Changes the size over `by`. |
| `shake` | Shakes by `amount` (world px), decaying over `by` (default 0.6 s). |
| `timescale` | Capture-side slow motion, `rate` (0.25 = 4×) until `until`. The simulation stays exact, and it isn't a game change. |

How much a key shows:

- `"subject_width": 0.18`: Pip is 18% of the frame width in every output. A 9:16 and a 16:9 twin each frame to their own width, so the twin's Pip isn't tiny.
- `"view": [w, h]`: at least this much world in both directions; the longer side of each output's aspect grows to fit.
- Both together: `subject_width` sets the width and `view[1]` is a height floor (`"view": [0, 420]`). A wide frame still shows a whole drop, and Pip comes out smaller there.

### capture_only: the changes a shot may make

| `what` | `value` | effect |
|---|---|---|
| `stage` | null | uses a capture-only stage |
| `respawn_delay` | seconds | pop → next life (game: 1.1 s) |
| `respawn_point` | null | allows `respawn` events |
| `droplet_life` | seconds | pop droplets melt sooner (game: ~42 s) |
| `spikeloop_slope` | number | spikeloop's strip is a tent, so droplets slide off |
| `can_die` | false | `cast` Pip with `"can_die": false` |

## Outputs (for each seed)

- `<scene>-<seed>-<WxH>.mp4`: H.264, 60 fps, with the mix as AAC.
- `<scene>-<seed>-<WxH>-<at>.png`: stills. These are RGBA with straight alpha when `transparent`.
- `<scene>-<seed>.music.wav`, `<scene>-<seed>.sfx-<family>.wav`, `<scene>-<seed>.mix.wav`.
- `<scene>-<seed>.events.json`: pops, landings, splashes, respawns, mushrooms, springs, bounces, checkpoints and pickups, each with `frame`, `t`, `x` and `y`.
- `<scene>-<seed>.contact.jpg`: a contact sheet.
- `NOTES.md` (appended), which records:
  - the build and how it was resolved, the seed, and the scene file's sha256
  - the stage and any override
  - `capture_only` and `staged`
  - the check results with per-pop positions, and whether the sizes match

## The check

Before any final file, the runner renders every size at low resolution and checks every frame:

- **Pip:** the box around his outline must stay inside the band.
- **The POP! word:** the box around its letters must stay inside the band too.
- **Frame 1:** Pip must be fully in frame and moving.
- **Size:** it warns when Pip is narrower than `min_subject_width` on a 9:16 output.

A failed check stops the render, names the frames and boxes, and prints a per-pop table. The full-size render is checked again before it is kept.

## Not supported yet

- Replay files.
- Cast members other than Pip.
- Staged moves.
- Themes other than the stage's own.
- Selectors other than `pip` and `word:POP!`.
- The `ui` timeline.
- Multi-client scenes.
