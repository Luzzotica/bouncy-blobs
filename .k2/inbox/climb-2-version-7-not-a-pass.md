---
title: climb-2 version 7 — not a pass
priority: normal
created: 2026-10-07T08:32:20Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-2 version 7 — not a pass

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Version 7 is not a pass. The tester rode version 7 only. Do not edit `climb-1.json`. Do not edit `swing.json`. Do not put version 6 back. Do not put version 7 back.

## What they played

Every load was version 7. That file was: exit x 400–1480, top y=440, height 64. Goal x 420–1216, y 410–474. Rope 320. Nail (500, 90). The seat object in the file is (500, 390). Stills: `agents/bouncy-blobs-tester/climb-pass-2v7/`.

## What still holds

- The seat rests at (500, 410). That is a taut 320 from the nail. The plank top is about y=392.
- Plank stayed flat (222.9 / 35.5). Rope was 320 at rest. Nobody popped.
- The ledge jump missed. Apex about (252, 274). The seat did not move. It did not finish.
- Nobody went under the floor. The sheet stays one piece and still sags.
- The one steady ride did get on the seat. The seat swung about x 511–639.

Keep those.

## What failed

The finish top is y=410. Two rides lit on that edge and were above it a second later. They were still over the deck. The clock stayed on the light.

- Steady: Level Complete at 0:06.116. Lit at (476, 411). One second later at (460, 402).
- Hard: grazed the seat and did not stay on it, so it never pumped. Level Complete at 0:02.716. Lit at (466, 411). One second later at (434, 403). The seat ran out to about x=627.
- Other steady: never stayed on the seat. No Level Complete. Stuck at about (428, 397), over the deck and above the finish, through 0:10.833. The seat sat about (571, 402).

The loose blob is visible on the ledge. The samples never returned a hull for it.

## What is on disk now

The file moved twice before this note went out. Version 8 was not ridden. The file now is version 9. The tester has not been sent to it.

Version 9 exit is center (920, 472), 1120×64, so x 360–1480, top y=440. Goal is center (793, 420), 846×64, so x 370–1216, y 388–452. Version 7’s deck started at x=400 and its finish was y 410–474. Rope 320. Nail (500, 90). Seat object (500, 390). Floor anchors 0–16 are still the top edge only.

In the version 9 box: the version 7 one-second points (459.9, 401.5) and (433.5, 403.1), and the stuck body at about (428, 397), are inside. The version 6 stand at (477, 413) is inside. (683, 399) is also inside. On version 4 that was a body stuck against the deck face. On version 7 it was outside the finish. The ledge skip near (252, 274) is outside.

## Done when

1. Three fresh rides, one of them hard, each light Level Complete while standing on the deck and are still inside the finish a second later.
2. The skip that never gets on the seat still does not finish.
3. Rope stays about 320. Seat stays a flat plank. Nobody pops.
4. A miss is not stuck above the finish and does not hang under the floor.
5. `climb-1.json` stays version 7. `swing.json` stays version 6.

Say when `/play/level?level=climb-2` is the finished file. Tester does not ride version 9 until you name it.
