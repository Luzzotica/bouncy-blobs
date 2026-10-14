---
title: climb-2 version 2 is not a pass
priority: normal
created: 2026-10-07T07:59:47Z
source: msg-inbox
from: bouncy-blobs-tester
---

# Play — Climb 2 — file version 2

Date: 2026-10-07
Where: local vite `http://127.0.0.1:5170/play/level?level=climb-2`. Every load in this set was version 2. Goal x=890 y=518 size 620×64 (box x 580–1200, y 486–550). Exit deck x 540–1440, top y=540, 64 thick. Disk mtime 01:41:39 was still version 2 after the rides. Climb-1 was not ridden. Swing was not ridden. Not kids mode.

## Verdict

Not a pass. Three walks never got on the seat. The body shoves the seat aside, drops at the lip, and ends under the floor. Level Complete did not light.

## Where the seat rests

The file centers the seat at (480, 500). It rests at (480, 520). That is a taut 320 from the nail at (480, 200). The plank is 36 thick, so its bottom is about y=538, 12px above the start ledge (top y=550).

## Rides

| Try | Result |
| --- | --- |
| 1 steady | No Level Complete. Walked into the seat and shoved it to about (568, 508). Dropped off the lip around (424, 552). Ended under the floor. 0 deaths. Stills: `a1-floor.png` at 0:07.716, `a1-end.png` at 0:10.933. |
| 2 hard | No Level Complete. Never got on, so it never pumped. Same shove, seat about (555, 511), then under the floor. 0 deaths. Still: `a2-end.png` at 0:10.849. |
| 3 steady | No Level Complete. Same walk, same drop, under the floor. 0 deaths. Still: `a3-end.png` at 0:10.866. |

Plank stayed flat (length 222.9, bend 35.5). Rope was 320 at rest. Nobody popped.

## Loose blob

The blob id bump is authored at (160, 500), on the spawn. The samples never returned a separate hull, so it was not bumped as its own body on the way to the rope.

## Skip

One jump off the start ledge. Apex about y=455, farthest x about 241. Back on the start ledge at (188.8, 505.3). The seat swung about x 354–643 and the body did not get on. No Level Complete. 0 deaths. Still: `skip-end.png` at 0:06.950.

## Floor

The sheet stays one piece (length 1401). It sags and waves (bend up to about 193). A miss does not stay on top of it. The body hangs underneath.

## Stills

`a1-floor.png`, `a1-end.png`, `a2-end.png`, `a3-end.png`, `skip-end.png`. Climb-1 was not replayed. Swing was not replayed. Kids mode was not retested.
