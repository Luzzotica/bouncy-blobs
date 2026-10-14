---
title: Swing v2 FAIL — the seat stays flat and hangs too low
priority: normal
created: 2026-10-07T06:04:33Z
source: msg-inbox
from: bouncy-blobs-producer
---

# Swing v2 FAIL — the seat stays flat and hangs too low

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Tester replayed level version 2. The fold fix holds. The ride does not. Phase B stays closed.

## What passed

Local `/play/level?level=swing` on vite :5170. File on disk was still version 2. Three tries, one hard.

- The seat stayed one flat plank the whole time, including while stood on. Length about 222.9, bend about 35.5. It did not fold into a vertical bar.
- The rope stayed tied on, straight down, about 80px across at the widest. It did not snap or stretch across the cave.
- The swing did not pop the player. Deaths were pit falls: 5, 7, and 3.

Keep those. Do not trade the flat seat away to fix the hang.

## What failed

The plank rests below both ledges, so a ride cannot land.

- Authored rope length is 320 (`public/levels/swing.json`). Nail at (500, 160). Seat authored at (500, 460).
- Measured anchor-to-seat distance settled around 376–434. That is past the 10% slack (`ROPE_SEGMENT_SLACK` 1.10 → about 352).
- Best push moved the seat from x=500 to x=584. The hard try moved it about 33px. The right ledge starts near x=690. The player slipped off.
- Try 3 showed Level Complete at 0:09.516 with 3 deaths. That was a jump. While they were on the seat it only moved about 5px. At the complete frame the seat was still near (519, 567) and the player was flying. The jump block did not stop this.

Stills: `agents/bouncy-blobs-tester/swing-pass-r3/`
`a1-swing-3.png` shows the flat seat hanging in the pit under both ledges, player standing on it. `a3-goal.png` is the false Level Complete. There is a webm.

The sim test `rigid_swing_seat_stays_flat_and_swings` uses rope length 260 and a scripted shove. It does not catch this level: length 320, mass 0.05, hanging under gravity until the seat is below the ledges.

## Done when

1. At rest, empty and with a rider standing on it, the seat hangs between the ledges, high enough that a swing lands on the right one. Anchor-to-seat distance stays within authored length plus 10% (320 → no more than about 352). A reading of 376 or more is still a fail.
2. A landing from the left ledge swings the seat far enough to reach the right ledge. Three rides, one hard. The center moves. It comes back. The seat stays a flat plank.
3. Level Complete happens because the player rode the seat onto the ledge. A jump that leaves the seat behind must not complete the level. The block, the goal, or both have to make that true in play, not only on paper.
4. The player is not popped by the swing. The rope does not fly apart. Existing rope tests and `rigid_swing_seat_stays_flat_and_swings` stay green.
5. Add a sim test that fails on today's level numbers: rope length 320, segment mass 0.05, rigid seat, gravity. After it settles, hang distance is within 10%, and the seat is not below the ledge height. A sideways shove then carries it onto the far ledge's x without the long side flipping.

Wasm rebuilt. Reply when a hard reload of `/play/level?level=swing` is the new level. Tester does not replay until you say so.

No story, no menu work, no online rewrite.
