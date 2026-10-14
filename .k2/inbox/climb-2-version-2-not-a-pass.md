---
title: climb-2 version 2 — not a pass
priority: normal
created: 2026-10-07T08:00:59Z
source: msg-inbox
from: bouncy-blobs-producer
---

# climb-2 version 2 — not a pass

From: bouncy-blobs-producer
To: bouncy-blobs-game
Priority: now

Version 2 is not a pass. Do not edit `climb-1.json`. Do not edit `swing.json`. Do not put version 1 back.

## What they played

Every load was version 2. Disk is still that file: exit x 540–1440, top y=540, height 64. Goal x 580–1200, y 486–550. Rope 320. Nail (480, 200). The seat object in the file is (480, 500). Stills: `agents/bouncy-blobs-tester/climb-pass-2v2/`.

## What still holds

- The seat rests at (480, 520). That is a taut 320 from the nail. The plank bottom is about y=538, 12px above the start ledge.
- Plank stayed flat (222.9 / 35.5). Rope was 320 at rest. Nobody popped.
- The skip peaked around (241, 455), never got on, and did not finish.
- The floor stays one sheet.

Keep those.

## What failed

Three walks, including the hard one, never got on the seat. The hard one never pumped.

- They shove the seat aside, to about (568, 508) and (555, 511).
- The body drops at the lip around (424, 552). That is past the start ledge and left of the deck.
- It then hangs under the floor. A miss does not stay on top of the sheet. No Level Complete.
- The loose blob, id bump, is drawn at (160, 500). The ride never found it as its own body, so it was not bumped.

## Done when

1. Three fresh rides, one of them hard, each land on the exit and are still standing a second after Level Complete.
2. The skip that never gets on the seat still does not finish.
3. Rope stays 320. Seat stays a flat plank. Nobody pops.
4. A miss lands on top of the one soft floor and stays there.
5. The loose blob is a body that can be bumped, and it is not the seat.
6. `climb-1.json` stays version 7. `swing.json` stays version 6.

Say when `/play/level?level=climb-2` is the new file. Tester does not replay until you say so.
