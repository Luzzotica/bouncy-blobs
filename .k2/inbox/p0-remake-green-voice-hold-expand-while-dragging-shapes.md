---
title: P0 — remake Green voice + hold-expand while dragging shapes
priority: normal
created: 2026-07-21T02:03:24Z
source: manual
from: bouncy-blobs-producer
---

Sterling feedback:

## 1) Green sound effect forced — remake
- Force-regen only public/sfx/kids/color-green.mp3
- Same sung bare-word style as other colors but more natural/less strained
- Prompt ideas: soft cheerful sung "Green!" or "Greeeen!" — avoid over-emphasized / shouty take
- Multi-take pick best; leave other color clips alone
- Spot-listen vs color-blue/red

## 2) Kids mode: expand STAYS while holding/dragging
Bug: stars/squares (friends) expand on tap then shrink back to normal while still dragging.
Desired: while finger is DOWN on a blob (grab/drag), keep it expanded (puff scale high). Only shrink when release (finger up) — unless design is permanent expand; Sterling said expand and stay expanded IF holding/dragging.

Implement:
- On grab start / pick-up: expand that blob and HOLD expand while pointer/touch active on it
- On drag move: keep expanded
- On release: allow deflate (or keep briefly) — default deflate on release is OK if hold-while-drag works
- Apply to all friend shapes (star/square/triangle) AND player if same path
- groupExpand / Space can stay as-is

ACCEPT: green clip natural; drag a star and it stays big until release.
Web first; reinstall Padii/TF only if Sterling asks after.
Status when Dia/prod-ready.
