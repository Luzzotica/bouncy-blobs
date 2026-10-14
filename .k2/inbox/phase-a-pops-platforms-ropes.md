---
title: Phase A — pops, platforms, ropes
priority: normal
created: 2026-10-07T05:09:22Z
source: msg-inbox
from: bouncy-blobs-producer
---

# Phase A — pops, platforms, ropes

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now
Goal: `games/bouncy-blobs/GOAL.md` section 17, Phase A only

## Why

Sterling (2026-10-06) wants the whole game to be soft bodies, a cave-climb story, cutscenes, a Rust port, and online play where each device catches up on its own. He also wants ropes that actually hold. We looked: the bounce brain is **already** Rust (`crates/softbody`, wasm in production). This packet fixes the three physics pains **in that crate**. Do not start the story, the menu rebuild, the React-to-Rust rewrite, kids-mode changes, or the online rewrite.

## Done when

All three. Tests in `cargo test` (and the existing JS rope / platform tests that you touch). Rebuild wasm if the game-side swing level needs it. Report: what the cascade actually was, the new stretch ratio, the platform point budget, and the 10-second rope result.

### 1. A stretch pop kills only itself

Today `CRUSH_HULL_SPREAD_RATIO_SQ` is 100, so a hull blows up around 10× its rest radius, while a squash fires near 1/10 of the area (`detect_crushes` in `crates/softbody/src/world.rs`). Sterling wants the stretch limit on a similar scale to the squash, and he still sees one pop take everyone else with it. The rest-pose reset on blow-up is already there so a giant shape does not drag the map. It is not enough.

- A body that stretches too far pops and resets **itself**.
- A second blob and a soft platform touching it (or right beside it) do not get a crush/death, do not lose points, and are still about rest size after 5 seconds.
- Existing crush tests stay green.
- Do not "fix" this by making bodies impossible to pop.

### 2. Soft platforms survive a lot of points

Sterling: add too many points and platforms break. They are hard to work with.

- A long floor with at least 64 hull points holds a blob standing and bouncing for 10 simulated seconds. No explode, no tunnel, no silent failure.
- Keep the expand-inside tunnel tests green (`expand_inside_offset_platform`, `deep_pen_prefers_local`, `deeply_overlapped`).
- If some higher count is still unsafe, make the editor refuse or auto-fix it. Do not ship a count that breaks with no warning. Write down the old failure count and the new safe count.

### 3. Ropes hold

`add_rope_chain` exists. Sterling says ropes still break or stretch too far, including between players and soft bodies. Prior attempts failed. This is the one he cares about most.

- A rope between two soft bodies, and a rope between a player blob and a soft body (or a fixed anchor on one end and the player on the other), under gravity plus a swinging load for 10 simulated seconds.
- Segment length stays within the authored max, plus a small slack you document (start at 10% and justify it if you need more).
- The rope does not delete itself. Neither end pops from the rope's pull alone.
- `rope_chain_obeys_max_segment_length_under_gravity` and the level-loader rope test stay green.
- One small playable swing (a tiny level or the smallest grab that lets a player hang and swing). Not the cave. Not a new move set beyond what the swing needs.

## Out of scope

Story, cutscenes, home-menu soft bodies, kids mode, TestFlight, moving the web app into Rust, replacing lockstep with catch-up netcode.

## Report back

Inbox the producer with tests run, the cascade cause, the new numbers, and how to open the swing.
