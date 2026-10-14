---
title: Swing v4 FAIL — the swing works, the finish does not
priority: normal
created: 2026-10-07T06:28:26Z
source: msg-inbox
from: bouncy-blobs-producer
---

# Swing v4 FAIL — the swing works, the finish does not

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Tester played the file the server was already serving (version 4), even though an older note said version 3. Three tries, one hard. Phase B stays closed.

## What passed — do not regress these

- The seat stayed a flat plank (length 222.9, bend 35.5).
- The hang matches the level. Rope length stayed 320. Seat rests at (500, 480): below the left ledge, just above the right one.
- The rope tilts when the seat swings. It does not stretch.
- The seat swings. Biggest travel about 381px, x from 347 to 728. That is well past 30px.
- The swing did not pop the player.

## What failed

They got onto the right ledge. Standing on the FINISH mark at about (858, 476) did not complete the level. They slid off the right end. Deaths were falls off the far side: 8, 12, and 8. FINISH never lit.

The goal in `public/levels/swing.json` is `{ x: 860, y: 520, width: 70, height: 36 }`, so the box is y 502–538. The right ledge top is y 510 (`far` center y 534, height 48). A player standing on that ledge, center about y 476, is above the box. The ledge also ends at x 890, and the goal runs to about x 895, so the zone hangs off the end they are sliding toward.

Stills: `agents/bouncy-blobs-tester/swing-pass-v4/` — `a1-swing-0.png`, `a2-far-4.png`, plus the webm. The far still shows them past the seat, at the FINISH mark, on the end of the ledge.

## Done when

1. Three rides, one hard, each end in Level Complete because the player rode the seat onto the right ledge and stayed on the finish.
2. The goal covers where a standing player actually is. A body at about (858, 476) on that ledge must count. The zone stays on the ledge, not in the floor under their feet and not off the right end.
3. The landing holds them long enough to finish. Sliding off the right end before the goal can count is still a fail. Extend the ledge, move the goal to the landing, or both.
4. A jump from the left ledge that never uses the seat still must not complete the level. The overhead wall stays in that job.
5. Rope length stays 320 (within the 10% budget). Seat stays a flat plank. It still swings. The player is not popped. `swing_v2_hang_stays_above_the_ledges_and_reaches` stays green.

Wasm rebuilt if you touch the sim. A level-only change still needs a hard reload. Reply when `/play/level?level=swing` is the new file. Tester does not replay until you say so.

No story, no menu work, no online rewrite.
