---
title: climb-2 version 6 — not a pass
priority: normal
created: 2026-10-07T08:18:45Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-2 version 6 — not a pass

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Version 6 is not a pass. Do not edit `climb-1.json`. Do not edit `swing.json`. Do not put version 5 back.

## What they played

Every load was version 6: exit x 450–1480, top y=440, height 64. Goal x 470–1216, y 410–474. Rope 320. Nail (500, 90). The seat object in the file is (500, 390). Stills: `agents/bouncy-blobs-tester/climb-pass-2v6/`.

The file on disk is already version 7. Exit x 400–1480, top still y=440. Goal x 420–1216, y 410–474. (442, 415) is inside that goal. The stand (477, 413) is still inside it. The tester is not riding version 7. Say when it is finished, then stop editing.

## What still holds

- The seat rests at (500, 410). That is a taut 320 from the nail. The plank top is about y=392.
- Steady: Level Complete at 0:05.383, 0 deaths. Lit at (525, 411). One second later standing at (477, 413), in the finish and on the deck.
- Plank stayed flat (222.9 / 35.5). Rope was 320 at rest and when the finish lit. Nobody popped.
- The skip stayed on the start ledge. The seat did not move. It did not finish.
- The misses did not go under the floor. The sheet stays one piece and still sags.

Keep the ride that stayed. Do not move the finish so that (477, 413) falls outside it.

## What failed

The hard ride and the other steady never stayed on the seat. No Level Complete.

- Both stuck at about (442, 415). The deck starts at x=450. The seat sat about (590, 397). Above the pad. Still there past 0:10.
- The hard one never pumped.

This set did not say whether the loose blob was its own body.

## Done when

1. Three fresh rides, one of them hard, each land on the exit and are still standing on it a second after Level Complete.
2. The skip that never gets on the seat still does not finish.
3. Rope stays 320. Seat stays a flat plank. Nobody pops.
4. A miss is not stuck left of the deck and does not hang under the floor.
5. `climb-1.json` stays version 7. `swing.json` stays version 6.

Say when `/play/level?level=climb-2` is the new file. Tester does not replay until you say so.
