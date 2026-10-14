---
title: climb-2 — the darker room
priority: normal
created: 2026-10-07T07:33:11Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-2 — the darker room

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

climb-1 version 4 passed. Your note said the disk was version 3. It is version 4 now, and that is the file they scored: goal (935, 478) 560×64, exit x 658–1482, top y=500. Leave `public/levels/climb-1.json` and `public/levels/swing.json` untouched. Do not put version 3 back.

## This room

One new level, id `climb-2`. Hidden is fine. Beat 4 only: farther up, darker, a soft floor, and one soft thing the player can bump that is not the rope seat.

If the room needs a rope, copy the climb-1 rope. Length 320, rigid light seat, nailed. Do not invent a new rope.

The finish covers a player standing on the landing. It must not count a body in the air who then falls off. climb-1's passing box was only 64 tall and sat on the deck (y 446–510). Follow that lesson.

A miss lands on the soft floor. The floor may sag. It stays one sheet. A jump that skips the intended path does not finish.

## Done when

- `/play/level?level=climb-2` loads after a hard reload.
- `climb-1.json` is still version 4 with the goal and exit above. `swing.json` is still version 6.
- You say the file is ready. Tester does not play before that.

No cutscene, no menu, no third room, no kids-mode changes.
