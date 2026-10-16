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
| `cast` | up to 8: `[{"id": "pip", "kind": "blob", "color": "pink", "spawn": [x, y], "can_die": true}, {"id": "star1", "kind": "blob", "shape": "star", "color": "yellow", "spawn": [x, y]}]`. Pip is player 1, the others are players 2..; each has their own inputs. Use `[{"from_stage": true}]` for stages whose actors come with them (end card, title, Kids Mode). Cast members can go in chapters, inline levels, `spikeloop` and `transparent`. |
| `inputs` | `{"t": 0.0, "who": "pip", "do": "hold", "key": "right"}`, `{"do": "release", "key": "right"}`, `{"do": "jump", "hold": 0.25}`, `{"do": "squish", "hold": 0.4}`. `t` is video seconds from frame 1; negative means during the pre-roll. Inputs go into each cast member's input slot, the same path a keyboard, pad or phone uses. |
| `pre_roll` | seconds of game time before frame 1, so frame 1 is already moving |
| `replay` | a recorded input file that drives Pip (below); `allow_old_stage` is the reason to accept one recorded on a different build of the stage |
| `events` | `{"t": 2.0, "do": "respawn", "who": "pip", "at": [x, y]}`: from then on, that cast member's next life starts there (needs `capture_only` `respawn_point`) |
| `vary` | seeded take variation (below) |
| `camera` | the timeline below, rendered for every size |
| `length` | `{"seconds": 11}` or `{"until": "event:pop", "count": 7, "plus": 1.5}` |
| `capture_only` | `[{"what": …, "value": …, "why": …}]` (list below) |
| `show` | `"glimmer"`, `"pickups"` |
| `check` | `band_x` (default 0.25–0.75), `band_y` (default 0–1), `objects` (`"pip"`, `"word:POP!"`), `min_subject_width` (warn on 9:16, default 0.12), `frame1_moving` |
| `outputs` | `{"kind": "video", "size": "1080x1920", "fps": 60}`, `{"kind": "still", "size": "2048x2048", "transparent": true, "at": 1.5 or "event:pop#3"}`. Optional per-output `band_x` (overrides `check.band_x`) and `view: [w, h]` (minimum world view for this output only; 0 = unconstrained). |
| `audio` | `{"music_stem": true, "sfx_families": ["pop", "land", "ui"], "mix": true}` |

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
- A camera key uses one or the other. Each output size frames itself to `subject_width`. A minimum view is opt-in per output (`outputs[].view: [w, h]`, 0 = unconstrained), never global, so a 9:16 shot's floor never shrinks the subject in its 16:9 twin.

### capture_only: the changes a shot may make

| `what` | `value` | effect |
|---|---|---|
| `stage` | null | uses a capture-only stage |
| `respawn_delay` | seconds | pop → next life (game: 1.1 s) |
| `respawn_point` | null | allows `respawn` events |
| `droplet_life` | seconds | pop droplets melt sooner (game: ~42 s) |
| `spikeloop_slope` | number | spikeloop's strip is a tent, so droplets slide off |
| `can_die` | false | `cast` Pip with `"can_die": false` |

## Replays: recorded human input

**Recording.** Sterling plays normally with `BB_RECORD_INPUT=/path/run.json`, for example `BB_RECORD_INPUT=~/run.json BB_LEVEL=ch03 cargo run -p bb-game`, or in story mode.
- The file holds player 1's input on every sim tick, from the moment the level loads, stored as changes only.
- It also records the level id, a hash of the level as built, Pip's start position and the build commit.
- It is saved every second and on quit. A new level starts a new recording; the file keeps the latest level played.

**Replaying.** In a scene file, set `"replay": "recordings/run.json"` (relative to the scene file).
- It drives Pip tick for tick through the same input slot, so the real simulation reproduces the run.
- Pip starts where the recording started, unless his cast entry has a `spawn`.
- Pip can't also have `inputs`; other cast members can.

**Rules.**
- The scene's stage must be the recording's level, or `validate` fails.
- If the level was built differently when it was recorded (the level hash differs), the render is refused with a plain message. Re-record on the current build, or set `"allow_old_stage": "<reason>"`; NOTES then print the reason.
- The example `replay.json` uses `recordings/bounce-chain-ch03.json`. It stops working, correctly, once Fungus Caverns changes; re-record it then.

## Spawn check

`validate` fails, naming the ids and positions, when:
- two cast spawns are closer than a blob's width (64 px), so they would start inside each other;
- a spawn is inside rock or jelly, or within a blob radius (32 px) of it, in the stage as this build builds it (chapters, inline levels, `spikeloop`, `transparent`).

## Names this game has (validate rejects anything else)

| list | names |
|---|---|
| event names (`length.until`, stills `event:<name>#n`, `events.json`) | `pop`, `death`, `land`, `jump`, `respawn`, `spawn` |
| scene events (`events[].do`) | `respawn` |
| selectors (`check.objects`, camera `who`) | any cast `id`, and `word:POP!` |
| SFX families (`audio.sfx_families`) | `pop`, `land`, `ui` (no splash sound exists; everything else is in the mix only) |
| cast | `kind: "blob"` with a shipped colour (pink, orange, yellow, green, blue, purple, magenta, teal, sky, lime, rose, lavender), or a Kids Mode shape friend: `"shape": "star" | "square" | "triangle"` with a Kids colour (red, orange, yellow, green, teal, blue, purple, pink, white) |
| inputs (`inputs[].do`) | `hold` / `release` with `key` left, right, up, down, jump; `jump` (`hold`: seconds held); `squish` (holds down, `hold` default 0.3 s) |

## Takes: `vary`

`"vary": {"respawn_x": 35, "input_jitter": 0.03}`.

- `respawn_x` shifts each new life's x by up to ±35 world units.
- `input_jitter` shifts each input's time by up to ±0.03 s.
- Both are seeded, so the same seed always gives the same values.
- With no `vary`, every seed is the same performance.
- NOTES print the values each seed actually used.

## Outputs (for each seed)

- `<scene>-<seed>-<WxH>.mp4`: H.264, 60 fps, with the mix as AAC.
- `<scene>-<seed>-<WxH>-<at>.png`: stills. These are RGBA with straight alpha when `transparent`.
- `<scene>-<seed>.music.wav`, `<scene>-<seed>.sfx-<family>.wav`, `<scene>-<seed>.mix.wav`.
- `<scene>-<seed>.events.json`: every pop, death, landing, jump, respawn and spawn, each with `frame`, `t`, `x`, `y` and `who` (the cast id).
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

- Staged moves.
- Themes other than the stage's own.
- Named characters in the cast.
- The `ui` timeline.
- Multi-client scenes.
