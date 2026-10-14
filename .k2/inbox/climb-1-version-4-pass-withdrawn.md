---
title: climb-1 version 4 — pass withdrawn
priority: normal
created: 2026-10-07T07:39:27Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-1 version 4 — pass withdrawn

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Stop climb-2. The fresh set on version 4 failed. Do not edit `swing.json`. Do not put version 3 back.

## What they played

Every scored load was version 4. Goal (935, 478) 560×64. Exit from x=658, top y=500.

## What still holds

- One steady ride landed and stayed. Level Complete at 0:03.399, 0 deaths, lit at (715, 450). One second later standing at (891, 460). The seat had swung to about x=588.
- Plank stayed flat (222.9 / 35.5). Rope stayed 320. Nobody popped.
- The skip peaked around (451, 373), missed the seat, landed on the floor. No finish.
- The floor stays one sheet and sags.

Keep those.

## What failed

Two of three rides fell off the seat and never reached the deck.

- Hard: did not stay on the seat. Sat on the floor around (976, 755). No Level Complete.
- Other steady: got on, seat swung to about x=620, then fell and sat around (850, 750). No Level Complete.

The deck starts at x=658. Those seats stopped short of it. The player dropped onto the floor under the finish. Stills: `agents/bouncy-blobs-tester/climb-pass-v4b/`. `a2-floor.png` is the blob on the sagging floor with the seat still back by the rope.

The earlier three-for-three set in `climb-pass-v4/` is withdrawn. This room is not passed.

## What is on disk now

`climb-1.json` is version 5. The exit deck starts at x=560 and the top is still y=500 (center 1020, 532, size 920×64). The goal is center (908, 478), size 616×64, so x 600–1216 and y 446–510. The rope is still 320. The seat and the sagging floor are unchanged. `swing.json` is still version 6.

`climb-2.json` is on disk. That room is closed. Do not send the tester there. Do not keep building it.

If version 5 is your finished answer to the two short swings, stop editing and say so. If it is still in progress, finish it, then say so. Do not flip the file while they might load it. Tester does not ride until you say three rides, one of them hard, should land and stay.

## Done when

1. Three fresh rides on the file you name, one of them hard, each land on the exit and are still standing a second after Level Complete.
2. The skip that never gets on the seat still does not finish.
3. Rope stays 320. Seat stays a flat plank. Nobody pops. A miss still lands on the one soft floor.
4. `swing.json` stays version 6. climb-2 stays unplayed.
