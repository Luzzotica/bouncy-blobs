---
title: climb-1 version 2 FAIL — the ride does not land
priority: normal
created: 2026-10-07T07:21:03Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-1 version 2 FAIL — the ride does not land

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Tester played file version 2 after a hard reload. Goal was still (950, 370), 500×100. Exit still starts at x=700. Phase B stays this room. Do not touch `swing.json`. No second room. No kids-mode changes.

## What passed — do not regress

- The seat stayed a flat plank (length 222.9, bend 35.5).
- The rope stayed 320.
- Nobody popped. Deaths 0.
- A miss stays on the soft floor. The floor stays one sheet (length about 1501) and sags. That sag is fine.
- A jump that never got on the seat did not finish. It peaked around y=380, knocked the seat to about x=603, and landed on the floor. The overhead wall was not what stopped it.

## What failed

The scored rides never got on the exit.

- Steady: mounted, ran off around (663, 436), fell to the soft floor.
- Hard: a real ride, seat about x=514–545, fell off around (676, 483).
- Rough: a real ride, seat about x=492–544, stuck under the left end of the exit around (672, 438) from then through 0:10.916. The center stayed outside the finish. No Level Complete.

The exit starts at x=700 with its top at y=402. Those bodies were short of it and below it. On Swing the seat traveled to about x=728. Here it barely left x=500.

One other rough ride did light Level Complete, at 0:03.883, centroid (707, 373), seat at (554, 475). About 200ms later the body was off that lip and the level stayed finished. That is a clip of the corner, not a landing. The goal starts at x=700 and y=320, so air over the lip counts.

Stills: `agents/bouncy-blobs-tester/climb-pass-v2/`
`a3-end.png` is the blob stuck under the lip at 0:10.916. `a1-floor.png` is the miss on the soft floor. `first-run/rough-goal.png` is the clip that counted.

## Done when

1. Three rides, one hard, each land on top of the exit and stay there. Level Complete comes from that landing. Running off at x=663, falling at (676, 483), or sticking under the lip at (672, 438) is still a fail.
2. A body that only clips the left lip and then falls off must not finish. The (707, 373) then gone case is a fail.
3. A jump that never rides the seat must not finish.
4. Rope stays 320. Seat stays a flat plank. Nobody pops. The soft floor still catches a miss and stays one sheet.
5. `swing.json` stays version 6.

Reply when `/play/level?level=climb-1` is the new file. Tester does not replay until you say so.
