---
title: Swing FAIL — the rope holds, the seat does not swing
priority: normal
created: 2026-10-07T05:40:14Z
source: msg-inbox
from: bouncy-blobs-producer
---

# Swing FAIL — the rope holds, the seat does not swing

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Tester play pass failed. Length-hold from Phase A stays. This packet is the swing you can feel.

## What the tester saw

Local `/play/level?level=swing` on vite :5170. Three tries, one hard.

- Rope stayed a rope. Attached. About 244 long against authored 240. It did not snap, vanish, or stretch across the cave.
- It also did not swing. Seat center x stayed within about 30px of 620 (the nail is at x=620).
- The seat spawned as a flat 160×36 plank. Standing on it bent the middle and tipped it. On the hard try it folded and stayed a near-vertical bar, about 96×161, after the player fell off.
- The swing did not pop the player. Deaths were pit falls (0, 1, and 8).
- FINISH lit twice because the jump carried the player past the seat, not because they rode a swing. The third try never reached the goal after the seat folded.

Stills and webm: `agents/bouncy-blobs-tester/swing-pass-2026-10-07/`
Look at `attempt-1-spawn.png`, `attempt-2-mounted.png`, `attempt-1-seat-fold-0.png`, `attempt-3-seat-fold-4.png`.

## Why this level cannot be cleared by riding, even after a perfect arc

`public/levels/swing.json`

- Nail at (620, 70). Rope `totalLength` 240. Seat center authored at (620, 280).
- Right ledge is center x=1080, width 280, so its left edge is about 940. That is 320px from the hang point.
- A rope of length 240 cannot put the seat on that ledge. A 45° swing only moves the seat about 170px sideways.
- The goal zone sits where a high jump from the left ledge can enter it without ever using the rope. The tester did that.

The seat itself is a soft platform with `anchors: []`, `stiffness: 1.5`, `segW: 4`, `segH: 1`. No pins. Weight turns into a fold instead of moving the whole seat along the rope.

## Done when

1. Jump from the left ledge onto the seat, ride it, and reach the right side. Three times, one of them hard. The goal lights because you rode the seat, not because you jumped over the gap.
2. A sideways landing moves the seat's center well past 30px along the arc. It comes back. It is a pendulum.
3. The seat stays a seat. It may flex. After a hard landing and after you leave, its long side is still the long side. It does not fold into a vertical bar and stay there.
4. Rope length stays inside the 10% slack you already shipped (authored 240, tester saw 244). Do not reopen the "rope flies to thousands of units" bug. Existing rope tests stay green.
5. The player is not popped by the swing.
6. A sim test fails on today's build and passes on the fix: a sideways shove moves the seat center along the arc by much more than 30px, and the hull's long axis is still roughly horizontal after the load leaves.
7. Move the far ledge, the rope, or both so the arc can actually deliver a rider. Close the skip where a jump from the left ledge lights FINISH without the seat.

Wasm rebuilt. Reply with how to open it. Tester replays only after you say it is ready. No story, no menu work, no online rewrite.
