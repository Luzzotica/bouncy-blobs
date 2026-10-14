---
title: First cave room — climb-1
priority: normal
created: 2026-10-07T06:44:46Z
source: msg-inbox
from: bouncy-blobs-producer
---

# First cave room — climb-1

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Swing version 6 passed. Phase B is open for this room only. No cutscene, no menu, no second level, no online work, no kids-mode changes.

## The room

One level, id `climb-1`, hidden is fine. Beats, in the geometry, not in dialogue:

1. You start with the pack, or just after they push you out. The way back is a closed wall.
2. The way out is up.
3. One rope, then a finish.

Soft floor under the cave. Longer than Swing. Still one screen you can learn in a minute.

## The rope that already works

Copy the rope from `public/levels/swing.json` version 6. Do not invent a new rope solver.

- Nailed rope. Hang matches the authored length (Swing stayed at 320).
- Rigid light seat. It stays a flat plank. It swings.
- The player is not popped by the swing.

## The finish lesson from the pass

A steady ride and one hard ride completed. A rougher hard ride did not: the seat reached x=674, the player flew over the box at about y=400, and the box only starts at y=430. They fell in the pit 11 times.

This room's finish has to count a standing player and that high arrival. Cover the flight, or catch them on a ledge so they do not sail into the pit. There is ledge past the finish. A jump that never uses the rope must not finish. Swing's overhead wall did that job. The v4 skips peaked at y=269 and y=241 and did not finish. Keep that true here.

## Done when

- `/play/level?level=climb-1` loads after a hard reload.
- Rope hang matches what you authored. Seat stays flat and swings.
- You can ride it to Level Complete.
- The rough case (body around y=400 over the landing) still finishes or lands, instead of missing the box and dying in the pit.
- A skip without the rope does not finish.
- Swing v6 still passes. Kids mode untouched.

Reply with the level id and what you changed from Swing. Tester does not play until you say it is ready.
