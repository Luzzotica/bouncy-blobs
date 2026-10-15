# Capture mode

Clean, repeatable gameplay footage for trailers and social clips
(`crates/bb-game/src/capture.rs`, helpers in `scripts/capture.sh`).

## Clean screen

`BB_CAPTURE=1` hides every screen-space UI element: the glow-drop counter,
letterbox bars, "hold to skip", fades, toasts, the Kids portrait gate.
Mid-level story lines and tips are not spawned. Gameplay is unchanged.
It works with `BB_LEVEL=chNN`, `BB_START=story|kids` and the title screen.
`BB_CAPTURE_UI=1` keeps the UI if a shot needs it.

## Variables

| Variable | Meaning |
|---|---|
| `BB_CAPTURE=1` | capture mode on (clean screen) |
| `BB_CAPTURE_SIZE=WxH` | frame size, e.g. `1080x1920` (portrait) or `1920x1080`. Portrait shows the landscape view's world *height* as its width (860 world px wide, 1529 tall), so it fills the frame with no bars. |
| `BB_CAPTURE_OUT=clip.mp4` | headless render to this file (no window), then exit |
| `BB_CAPTURE_FRAMES=n` | frames to record (default 300) |
| `BB_CAPTURE_SPEED=s` | sim time per frame = s/60 s; `0.25` is 4× slow motion |
| `BB_CAPTURE_START=t` | pre-roll t sim ticks (1/60 s, at 1×) before frame 1 |
| `BB_CAPTURE_CAM=` | `follow` (default), `tight` (close follow, zoom 0.45), `static:x,y`, `reveal:x,y` (start on Pip, ease to x,y), `followx:y` (follow Pip sideways at a fixed height) |
| `BB_CAPTURE_ZOOM=z` | 1 = normal view, smaller = closer |
| `BB_CAPTURE_PULL=z0,z1` | zoom eases z0 → z1 over the clip (smoothstep) |
| `BB_CAPTURE_LIFT=px` | follow modes: view centre this far above Pip at zoom 1 (default 200 portrait, 40 landscape) |
| `BB_CAPTURE_TRACK=k` | follow stiffness × k (e.g. 20 keeps a fast fall locked in frame) |
| `BB_CAPTURE_AT=x,y` | put Pip at world x,y when the level loads |
| `BB_CAPTURE_NO_PICKUPS=1` | clear the level's glow-drop amoebas at load (as if already eaten) |
| `BB_CAPTURE_CRF=q` | x264 quality (default 16) |
| `BB_PRESS=...` | scripted keys (existing): `key@f`, `key@a-b`, `key@a-` (hold from a on), `key@every:P:H[:from[:to]]` (hold H ticks every P). In a headless capture these are **sim ticks**, so a script is the same at any speed. |
| `BB_TAP=target@f[-g];...` | scripted touches: `x,y` (world), `chip:green` (Kids colour chip), `blob:n` (player slot n). Finger up at g (default f+6). |

## Headless video render

```
CARGO_TARGET_DIR=... cargo build -p bb-game
scripts/capture.sh render /tmp/p1.mp4 \
  BB_LEVEL=ch03 BB_CAPTURE_SIZE=1080x1920 BB_CAPTURE_FRAMES=420 \
  BB_CAPTURE_START=150 BB_CAPTURE_AT=5600,820 BB_CAPTURE_NO_PICKUPS=1 \
  BB_PRESS='right@1-,space@every:45:14'
```

How it works:

* No window is created (`platform::headless()`); the main camera renders
  into an offscreen image of `BB_CAPTURE_SIZE`.
* Time is driven manually (`TimeUpdateStrategy::ManualDuration`): first a
  warm-up with the clock stopped (≥30 updates and 2 s wall time, so assets
  are loaded), then `BB_CAPTURE_START` ticks of pre-roll at 1×, then exactly
  `BB_CAPTURE_FRAMES` recorded frames. Each recorded frame advances the sim
  by `SPEED/60` s (frame boundaries land exactly on 60 Hz ticks, so 0.25×
  steps the sim once every 4 frames, never drifting). The wall clock plays
  no part: a slow machine renders the same clip, just slower.
* Slow motion stays smooth: between sim steps every body's outline is drawn
  interpolated between its previous and current step, and restored exactly
  before the next step (the sim never sees it).
* Every frame is read back from the GPU and streamed raw into
  `ffmpeg -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -r 60`
  through stdin (no PNG dumps).
* Audio playback is muted (nothing comes out of the speakers), but every
  sound the game starts is logged to `clip.mp4.audio.tsv` (asset path,
  start/end in clip seconds, gain, speed, loop).

### Sound

* `scripts/capture.sh music clip.mp4 cave|bright` writes `clip.wav`: the
  biome's music loop trimmed to the clip. This is a **music stem**, not the
  game's live audio. Cave biomes (Drip, Fungus, Lake...) use
  `theme-cave.mp3`; bright ones (Well, Toys, Playroom, Kids) `theme.mp3`
  (`audio.rs theme_music`).
* `scripts/capture.sh mix clip.mp4 [--with-music] [--only voice/]` rebuilds
  the soundtrack from the audio log: the game's own clip files placed at the
  frame the game started them, at the game's gain, muxed into the mp4 as
  AAC (and written to `clip.wav`). This is an offline reconstruction from the
  game's event log, not a recording of the speakers. Synthesised sounds
  (story blubs, Kids twinkle notes) have no file and are not included.

## Windowed capture (real time, with live game audio)

For footage with the real game audio, run the game in a window sized for
the shot and screen-record it (for Sterling to run; the agents never open a
window):

```
BB_CAPTURE=1 BB_CAPTURE_SIZE=540x960 BB_LEVEL=ch03 \
  CARGO_TARGET_DIR=... cargo run -p bb-game
```

* `BB_CAPTURE_SIZE` sets the window's size in logical points; the framing
  only depends on the aspect, so `540x960` on a Retina display is a
  1080×1920-pixel window that fits on screen (a literal `1080x1920` window
  is taller than most displays).
* Everything except `BB_CAPTURE_OUT`/`FRAMES`/`SPEED`/`START` works live: the
  clean screen, `BB_CAPTURE_CAM`, `ZOOM`, `AT`, `NO_PICKUPS`, `BB_PRESS`
  (frame numbers are display frames there). Play with the keyboard or a pad.
* Record with OBS at 60 fps: a macOS Screen Capture source set to the game
  window (it can capture that app's audio on macOS 13+), canvas and output
  1080×1920. QuickTime's screen recording works for picture but doesn't
  record system audio without a loopback device such as BlackHole.
