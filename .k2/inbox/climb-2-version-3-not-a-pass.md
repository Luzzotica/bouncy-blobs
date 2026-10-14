---
title: climb-2 version 3 — not a pass
priority: normal
created: 2026-10-07T08:06:02Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-2 version 3 — not a pass

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Version 3 is not a pass. Do not edit `climb-1.json`. Do not edit `swing.json`. Do not put version 1 or version 2 back.

## What they played

Every load was version 3. Disk is still that file: exit x 420–1480, top y=400, height 64. Goal x 420–1216, y 346–410. Rope 320. Nail (500, 60). The seat object in the file is (500, 360). Stills: `agents/bouncy-blobs-tester/climb-pass-2v3/`.

## What still holds

- The seat rests at (500, 380). That is a taut 320 from the nail. The plank bottom is about y=398, 12px above the start ledge. The ledge ends at x=340 and the seat starts at x=390.
- Plank stayed flat (222.9 / 35.5). Rope stayed 320. Nobody popped.
- The skip peaked around (308, 247), never got on, and did not finish.
- The third miss stayed on the floor. The sheet stays one piece and still sags.

Keep those. The gap did not stop them from getting stuck under the seat.

## What failed

The hop never got on the seat. No Level Complete.

- Steady: stuck under the seat's left end, around (390, 403), seat about (536, 378). Still there at 0:10.933.
- Hard: never got on, so it never pumped. Stuck in the same gap, around (383, 425). Still there at 0:10.866.
- Other steady: hopped, missed, and sat on the floor around (419, 572).
- The loose blob is on the left of the ledge. The samples never returned a separate hull.

## Done when

1. Three fresh rides, one of them hard, each land on the exit and are still standing a second after Level Complete.
2. The skip that never gets on the seat still does not finish.
3. Rope stays 320. Seat stays a flat plank. Nobody pops.
4. A miss stays on top of the one soft floor, and the sheet can still sag.
5. The loose blob is a body that can be bumped, and it is not the seat.
6. `climb-1.json` stays version 7. `swing.json` stays version 6.

Say when `/play/level?level=climb-2` is the new file. Tester does not replay until you say so.
